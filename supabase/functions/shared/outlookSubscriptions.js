// MICROSOFT GRAPH CHANGE-NOTIFICATION SUBSCRIPTIONS for a connected Outlook mailbox.
//
// WHAT A SUBSCRIPTION IS FOR, AND WHAT IT IS NOT. A subscription makes Microsoft POST a
// small signal to Funnl's notification endpoint when a message is created in the mailbox.
// Funnl treats that signal as a WAKE-UP and nothing more: it records that the connection
// should be checked, and the existing delta pipeline - cursors, lease, consent gates,
// two-sided qualification, screening, minimization - establishes what actually changed.
// No message content, address or subject is read from a notification, and the message id
// Microsoft includes in a basic notification is not retained.
//
// WHAT MICROSOFT DOCUMENTS (learn.microsoft.com, change-notifications-overview,
// change-notifications-delivery-webhooks, change-notifications-lifecycle-events,
// api/subscription-post-subscriptions; read 2026-10-08):
//   * supported message resources: `/me/messages` and `/me/mailFolders('inbox')/messages`.
//     There is NO documented Sent Items-specific path, so ONE subscription on `me/messages`
//     is the wake-up for both folders the import reads.
//   * delegated personal Microsoft accounts: supported for message subscriptions with
//     Mail.ReadBasic or Mail.Read - the grant the connection already holds.
//   * maximum expiration for Outlook messages: 10,080 minutes (under seven days); apps
//     must renew before expiry or create anew.
//   * creation validates the notificationUrl: Microsoft POSTs `?validationToken=` and the
//     endpoint must answer 200 text/plain with the decoded token within 10 seconds.
//   * clientState is "required ... should remain secret and known only to your application
//     and the Microsoft Graph service"; every notification must be checked against it.
//   * duplicate subscriptions (same changeType + resource) answer 409 Conflict.
//   * lifecycle notifications: reauthorizationRequired (PATCH with a new expiry both
//     reauthorizes and renews), subscriptionRemoved (create anew, then sync by delta),
//     missed (full resync by delta).
//   * average notification latency for messages: under 1 minute; maximum 3 minutes.
//
// SECURITY. The clientState is 32 random bytes; the database keeps ONLY its SHA-256, so a
// read of the table cannot forge a notification. Every Graph request here is bounded in
// time and body size, refuses to follow a redirect, and reports controlled codes only -
// never a provider message, a token or a URL.
//
// NOTHING HERE RUNS WITHOUT A LEASE. The worker calls maintainSubscription inside its
// reserved run, so creation and renewal are serialized per connection by the same lock
// that serializes the import, and the recorded state is fenced on the run id.

import { GRAPH_BASE } from './outlookGraphTransport.js'
import { readJsonBounded, MAX_PROVIDER_BODY_BYTES } from './boundedJson.js'

export const SUBSCRIPTION_RESOURCE = 'me/messages'
export const SUBSCRIPTION_CHANGE_TYPE = 'created'
/** Requested lifetime: three days. The documented ceiling for messages is 10,080 minutes. */
export const SUBSCRIPTION_LIFETIME_MS = 3 * 24 * 60 * 60 * 1000
export const SUBSCRIPTION_MAX_LIFETIME_MS = 10_080 * 60 * 1000
/** Renew once less than this remains, so a daily miss still leaves a margin. */
export const SUBSCRIPTION_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000
export const SUBSCRIPTION_REQUEST_TIMEOUT_MS = 15_000
export const MAX_SUBSCRIPTION_ID_CHARS = 128
export const MAX_CLIENT_STATE_CHARS = 128   // Graph's documented ceiling for clientState
export const CLIENT_STATE_BYTES = 32

export const SUBSCRIPTION_STATUSES = Object.freeze(['active', 'reauthorize', 'removed', 'failed'])
export const SUBSCRIPTION_ACTIONS = Object.freeze(['none', 'create', 'renew'])
/** Every outcome maintainSubscription can report. Controlled; safe to log. */
export const SUBSCRIPTION_OUTCOMES = Object.freeze([
  'unchanged',          // a live subscription with enough lifetime left
  'created',            // a new subscription was registered
  'renewed',            // PATCH extended (and reauthorized) the existing one
  'recreated',          // a renewal found it gone, so a new one was registered
  'skipped_no_url',     // no notification URL configured: nothing to subscribe with
  'skipped_budget',     // not enough invocation budget to make a bounded request
  'create_failed',      // Graph refused or did not answer; the code says which
  'renew_failed',
  'record_failed',      // Graph succeeded but the database did not take the row
])
/** Controlled transport codes for a subscription request. */
export const SUBSCRIPTION_CODES = Object.freeze([
  'ok', 'bad_request', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'throttled',
  'provider_error', 'transport_error', 'malformed', 'budget_exhausted',
])

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

function printable (s, max) {
  if (typeof s !== 'string' || s.length === 0 || s.length > max) return false
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if (c < 32 || c === 127) return false
  }
  return true
}

/** base64url without padding, built without any string escape. */
function base64url (bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const b64 = (typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64'))
  return b64.split('+').join('-').split('/').join('_').split('=').join('')
}

/**
 * A fresh clientState: 32 random bytes, base64url (43 characters, under Graph's 128).
 * @param {(n:number)=>Uint8Array} [randomBytes]  injectable for tests
 */
export function generateClientState (randomBytes) {
  const bytes = typeof randomBytes === 'function'
    ? randomBytes(CLIENT_STATE_BYTES)
    : globalThis.crypto.getRandomValues(new Uint8Array(CLIENT_STATE_BYTES))
  if (!(bytes instanceof Uint8Array) || bytes.length !== CLIENT_STATE_BYTES) throw new Error('client_state_entropy')
  return base64url(bytes)
}

/** SHA-256 hex of the clientState - the ONLY form the database ever holds. */
export async function hashClientState (clientState, subtle = globalThis.crypto?.subtle) {
  if (!printable(clientState, MAX_CLIENT_STATE_CHARS)) throw new Error('invalid_client_state')
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(clientState))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Does this look like a clientState hash the database could hold? */
export function isClientStateHash (s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)
}

/** Graph subscription ids are GUID-like; anything printable and short is accepted, nothing else. */
export function isUsableSubscriptionId (s) {
  return printable(s, MAX_SUBSCRIPTION_ID_CHARS) && !s.includes('/') && !s.includes('?') && !s.includes('#')
}

/** An https URL on a single host, no credentials, no fragment - the only kind Graph should be told about. */
export function isUsableNotificationUrl (raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false
  let u
  try { u = new URL(raw) } catch { return false }
  return u.protocol === 'https:' && u.username === '' && u.password === '' && u.hash === ''
}

/**
 * Decide what, if anything, to do about a connection's subscription.
 *
 * @param {object} p
 * @param {object|null} p.row   the stored outlook_subscriptions row (or null)
 * @param {number} p.nowMs
 * @param {string|null} p.notificationUrl
 * @returns {{action:'none'|'create'|'renew', reason:string}}
 */
export function planSubscriptionAction ({ row, nowMs, notificationUrl }) {
  if (!isUsableNotificationUrl(notificationUrl)) return { action: 'none', reason: 'no_url' }
  if (!isPlainObject(row) || !isUsableSubscriptionId(row.subscription_id)) return { action: 'create', reason: 'none_recorded' }
  if (row.status === 'removed' || row.status === 'failed') return { action: 'create', reason: row.status }
  const exp = Date.parse(row.expires_at ?? '')
  if (!Number.isFinite(exp)) return { action: 'create', reason: 'expiry_unreadable' }
  if (exp <= nowMs) return { action: 'create', reason: 'expired' }
  if (row.status === 'reauthorize') return { action: 'renew', reason: 'reauthorization_required' }
  if (exp - nowMs <= SUBSCRIPTION_RENEW_BEFORE_MS) return { action: 'renew', reason: 'expiring' }
  return { action: 'none', reason: 'live' }
}

/** ISO expiry `lifetimeMs` from now, clamped to the documented ceiling. */
export function expirationFrom (nowMs, lifetimeMs = SUBSCRIPTION_LIFETIME_MS) {
  const life = Math.min(Math.max(60_000, lifetimeMs), SUBSCRIPTION_MAX_LIFETIME_MS)
  return new Date(nowMs + life).toISOString()
}

const SUBSCRIPTIONS_URL = `${GRAPH_BASE}/subscriptions`

export function buildCreateSubscriptionRequest ({ notificationUrl, lifecycleNotificationUrl, clientState, expirationIso }) {
  if (!isUsableNotificationUrl(notificationUrl)) throw new Error('invalid_notification_url')
  if (lifecycleNotificationUrl != null && !isUsableNotificationUrl(lifecycleNotificationUrl)) throw new Error('invalid_lifecycle_url')
  if (!printable(clientState, MAX_CLIENT_STATE_CHARS)) throw new Error('invalid_client_state')
  if (typeof expirationIso !== 'string' || Number.isNaN(Date.parse(expirationIso))) throw new Error('invalid_expiration')
  const body = {
    changeType: SUBSCRIPTION_CHANGE_TYPE,
    notificationUrl,
    resource: SUBSCRIPTION_RESOURCE,
    expirationDateTime: expirationIso,
    clientState,
  }
  if (lifecycleNotificationUrl != null) body.lifecycleNotificationUrl = lifecycleNotificationUrl
  return { method: 'POST', url: SUBSCRIPTIONS_URL, body }
}

export function buildRenewSubscriptionRequest ({ subscriptionId, expirationIso }) {
  if (!isUsableSubscriptionId(subscriptionId)) throw new Error('invalid_subscription_id')
  if (typeof expirationIso !== 'string' || Number.isNaN(Date.parse(expirationIso))) throw new Error('invalid_expiration')
  return { method: 'PATCH', url: `${SUBSCRIPTIONS_URL}/${encodeURIComponent(subscriptionId)}`, body: { expirationDateTime: expirationIso } }
}

export function buildDeleteSubscriptionRequest ({ subscriptionId }) {
  if (!isUsableSubscriptionId(subscriptionId)) throw new Error('invalid_subscription_id')
  return { method: 'DELETE', url: `${SUBSCRIPTIONS_URL}/${encodeURIComponent(subscriptionId)}`, body: null }
}

/** The app's own subscriptions for the signed-in user - used only to clear a 409 duplicate. */
export function buildListSubscriptionsRequest () {
  return { method: 'GET', url: SUBSCRIPTIONS_URL, body: null }
}

/**
 * Pull the two fields a subscription object must carry. Everything else is discarded.
 * @returns {{ok:true,id:string,expirationIso:string}|{ok:false,code:'malformed'}}
 */
export function readSubscriptionResponse (json) {
  if (!isPlainObject(json)) return { ok: false, code: 'malformed' }
  const id = json.id
  const exp = json.expirationDateTime
  if (!isUsableSubscriptionId(id)) return { ok: false, code: 'malformed' }
  if (typeof exp !== 'string' || exp.length > 64 || Number.isNaN(Date.parse(exp))) return { ok: false, code: 'malformed' }
  return { ok: true, id, expirationIso: new Date(exp).toISOString() }
}

/**
 * Read a subscriptions listing: only the ids whose resource and notificationUrl match
 * ours are returned; nothing else is kept.
 */
export function readMatchingSubscriptions (json, { notificationUrl }) {
  if (!isPlainObject(json) || !Array.isArray(json.value)) return []
  const out = []
  for (const s of json.value.slice(0, 100)) {
    if (!isPlainObject(s) || !isUsableSubscriptionId(s.id)) continue
    const res = typeof s.resource === 'string' ? s.resource.toLowerCase().replace(/^\/+/, '') : ''
    if (res !== SUBSCRIPTION_RESOURCE) continue
    if (s.notificationUrl !== notificationUrl) continue
    out.push(s.id)
  }
  return out
}

function codeForStatus (status) {
  if (status === 200 || status === 201 || status === 204) return 'ok'
  if (status === 400) return 'bad_request'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429 || status === 503 || status === 504) return 'throttled'
  return 'provider_error'
}

/**
 * Execute ONE subscription request. Returns `{ok:true, json}` or `{ok:false, code}`;
 * the provider body, headers, URL and the token never appear in the result.
 */
export async function executeSubscriptionRequest ({ request, accessToken, fetchImpl, budgetAllows, timeoutMs }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch_not_injected')
  if (typeof accessToken !== 'string' || accessToken.length === 0) throw new Error('missing_access_token')
  if (!isPlainObject(request) || typeof request.url !== 'string' || !request.url.startsWith(SUBSCRIPTIONS_URL)) {
    throw new Error('forbidden_request_url')
  }
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) throw new Error('invalid_request_method')
  const limitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : SUBSCRIPTION_REQUEST_TIMEOUT_MS
  const affordable = typeof budgetAllows === 'function' ? budgetAllows : () => true
  if (!affordable(limitMs)) return { ok: false, code: 'budget_exhausted' }

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => { try { controller.abort() } catch { /* gone */ } }, limitMs) : null
  try {
    let res
    try {
      res = await fetchImpl(request.url, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          ...(request.body !== null && request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: request.body !== null && request.body !== undefined ? JSON.stringify(request.body) : undefined,
        redirect: 'manual',
        signal: controller ? controller.signal : undefined,
      })
    } catch {
      return { ok: false, code: 'transport_error' }
    }
    if (!res || typeof res.status !== 'number') return { ok: false, code: 'transport_error' }
    const code = codeForStatus(res.status)
    if (code !== 'ok') return { ok: false, code }
    if (res.status === 204) return { ok: true, json: {} }
    const read = await readJsonBounded(res, MAX_PROVIDER_BODY_BYTES)
    if (!read.ok) return { ok: false, code: 'malformed' }
    return { ok: true, json: read.value }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * Make the mailbox's subscription match what the run needs: present, authorized, and not
 * about to expire. ONE decision, at most a handful of bounded requests, every outcome a
 * controlled code. The caller persists the result through `persist`, which it has bound
 * to the connection and the run id so the database can fence it on the lease.
 *
 * @param {object} p
 * @param {object|null} p.row               the stored row, or null
 * @param {string} p.accessToken
 * @param {{fetchImpl:Function}} p.deps
 * @param {(marginMs:number)=>boolean} [p.budgetAllows]
 * @param {()=>number} [p.now]
 * @param {string|null} p.notificationUrl
 * @param {string|null} [p.lifecycleNotificationUrl]  defaults to notificationUrl
 * @param {(state:object)=>Promise<boolean>} p.persist   records {status, subscriptionId, resource,
 *        changeType, clientStateHash, expiresAt, errorCode}; resolves true when stored
 * @param {(n:number)=>Uint8Array} [p.randomBytes]
 * @param {SubtleCrypto} [p.subtle]
 * @returns {Promise<{action:string, outcome:string, code:string|null, expiresAt:string|null}>}
 */
export async function maintainSubscription (p) {
  const {
    row, accessToken, deps, budgetAllows, notificationUrl, persist, randomBytes, subtle,
  } = p || {}
  const now = typeof p?.now === 'function' ? p.now : Date.now
  const lifecycleUrl = p?.lifecycleNotificationUrl ?? notificationUrl
  const nowMs = now()
  const plan = planSubscriptionAction({ row, nowMs, notificationUrl })
  if (plan.action === 'none') {
    return { action: 'none', outcome: plan.reason === 'no_url' ? 'skipped_no_url' : 'unchanged', code: null, expiresAt: row?.expires_at ?? null }
  }
  const affordable = typeof budgetAllows === 'function' ? budgetAllows : () => true
  // Creation may take up to four requests (create, list, delete, create again); renewal one.
  if (!affordable(SUBSCRIPTION_REQUEST_TIMEOUT_MS * (plan.action === 'create' ? 4 : 1))) {
    return { action: plan.action, outcome: 'skipped_budget', code: 'budget_exhausted', expiresAt: row?.expires_at ?? null }
  }
  const exec = (request) => executeSubscriptionRequest({
    request, accessToken, fetchImpl: deps?.fetchImpl, budgetAllows: affordable,
  })
  const store = async (state) => {
    try { return (await persist(state)) === true } catch { return false }
  }

  if (plan.action === 'renew') {
    const expirationIso = expirationFrom(nowMs)
    const res = await exec(buildRenewSubscriptionRequest({ subscriptionId: row.subscription_id, expirationIso }))
    if (res.ok) {
      const read = readSubscriptionResponse(res.json)
      const expiresAt = read.ok ? read.expirationIso : expirationIso
      const stored = await store({
        status: 'active', subscriptionId: row.subscription_id, resource: SUBSCRIPTION_RESOURCE,
        changeType: SUBSCRIPTION_CHANGE_TYPE, clientStateHash: row.client_state_hash, expiresAt, errorCode: null,
      })
      return { action: 'renew', outcome: stored ? 'renewed' : 'record_failed', code: null, expiresAt }
    }
    if (res.code !== 'not_found') {
      await store({ status: row.status === 'reauthorize' ? 'reauthorize' : 'active', subscriptionId: row.subscription_id,
        resource: SUBSCRIPTION_RESOURCE, changeType: SUBSCRIPTION_CHANGE_TYPE, clientStateHash: row.client_state_hash,
        expiresAt: row.expires_at ?? null, errorCode: res.code })
      return { action: 'renew', outcome: 'renew_failed', code: res.code, expiresAt: row.expires_at ?? null }
    }
    // Gone at Microsoft: fall through to a fresh creation, reported as recreated.
    const created = await createFresh({ exec, store, nowMs, notificationUrl, lifecycleUrl, randomBytes, subtle })
    return { ...created, action: 'renew', outcome: created.outcome === 'created' ? 'recreated' : created.outcome }
  }

  return createFresh({ exec, store, nowMs, notificationUrl, lifecycleUrl, randomBytes, subtle })
}

async function createFresh ({ exec, store, nowMs, notificationUrl, lifecycleUrl, randomBytes, subtle }) {
  const clientState = generateClientState(randomBytes)
  const clientStateHash = await hashClientState(clientState, subtle)
  const expirationIso = expirationFrom(nowMs)
  const req = buildCreateSubscriptionRequest({ notificationUrl, lifecycleNotificationUrl: lifecycleUrl, clientState, expirationIso })
  let res = await exec(req)
  if (!res.ok && res.code === 'conflict') {
    // A duplicate exists at Microsoft - typically the previous subscription of a mailbox
    // that disconnected and reconnected within its lifetime. Its clientState is unknown
    // to this database, so it cannot be adopted: list, delete the ones that are ours by
    // resource and URL, and create again. Bounded to one pass.
    const list = await exec(buildListSubscriptionsRequest())
    if (list.ok) {
      for (const id of readMatchingSubscriptions(list.json, { notificationUrl })) {
        await exec(buildDeleteSubscriptionRequest({ subscriptionId: id }))
      }
      res = await exec(req)
    }
  }
  if (!res.ok) {
    await store({ status: 'failed', subscriptionId: null, resource: SUBSCRIPTION_RESOURCE,
      changeType: SUBSCRIPTION_CHANGE_TYPE, clientStateHash: null, expiresAt: null, errorCode: res.code })
    return { action: 'create', outcome: 'create_failed', code: res.code, expiresAt: null }
  }
  const read = readSubscriptionResponse(res.json)
  if (!read.ok) {
    await store({ status: 'failed', subscriptionId: null, resource: SUBSCRIPTION_RESOURCE,
      changeType: SUBSCRIPTION_CHANGE_TYPE, clientStateHash: null, expiresAt: null, errorCode: 'malformed' })
    return { action: 'create', outcome: 'create_failed', code: 'malformed', expiresAt: null }
  }
  const stored = await store({
    status: 'active', subscriptionId: read.id, resource: SUBSCRIPTION_RESOURCE,
    changeType: SUBSCRIPTION_CHANGE_TYPE, clientStateHash, expiresAt: read.expirationIso, errorCode: null,
  })
  return { action: 'create', outcome: stored ? 'created' : 'record_failed', code: null, expiresAt: read.expirationIso }
}

/** Counts and controlled codes only - what a run may report about its subscription step. */
export function summarizeSubscriptionStep (r) {
  if (!isPlainObject(r)) return null
  return {
    action: SUBSCRIPTION_ACTIONS.includes(r.action) ? r.action : 'none',
    outcome: SUBSCRIPTION_OUTCOMES.includes(r.outcome) ? r.outcome : 'unchanged',
    code: SUBSCRIPTION_CODES.includes(r.code) ? r.code : null,
    expires_at: typeof r.expiresAt === 'string' && !Number.isNaN(Date.parse(r.expiresAt)) ? r.expiresAt : null,
  }
}
