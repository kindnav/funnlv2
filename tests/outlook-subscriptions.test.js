// THE CHANGE-NOTIFICATION SUBSCRIPTION - decided, created, renewed and recorded under the
// worker's lease.
//
// Two layers are executed:
//   1. the module (supabase/functions/shared/outlookSubscriptions.js) with an injected fetch
//      that answers as Microsoft Graph documents: 201 with a subscription object, 200 on
//      PATCH, 409 for a duplicate, 404 for a subscription Microsoft already removed;
//   2. the REAL worker handler (handleOutlookImportWorker) over the real run, with the
//      round store and ports the two-sided tests use, so the step is proven where it lives:
//      after the context load, before the import, fenced on the run id, never fatal.
//
// Microsoft's behaviour is SIMULATED by these fixtures; this is not live-provider evidence.
// NO REAL IDENTIFIER, ADDRESS, TOKEN OR KEY APPEARS IN THIS FILE.
//
// Run with: node tests/outlook-subscriptions.test.js

import assert from 'node:assert'
import { webcrypto } from 'node:crypto'
import {
  SUBSCRIPTION_RESOURCE, SUBSCRIPTION_CHANGE_TYPE, SUBSCRIPTION_LIFETIME_MS, SUBSCRIPTION_MAX_LIFETIME_MS,
  SUBSCRIPTION_RENEW_BEFORE_MS, SUBSCRIPTION_OUTCOMES, SUBSCRIPTION_CODES,
  generateClientState, hashClientState, planSubscriptionAction, expirationFrom,
  buildCreateSubscriptionRequest, buildRenewSubscriptionRequest, buildDeleteSubscriptionRequest,
  buildListSubscriptionsRequest, readSubscriptionResponse, readMatchingSubscriptions,
  executeSubscriptionRequest, maintainSubscription, summarizeSubscriptionStep, isUsableNotificationUrl,
} from '../supabase/functions/shared/outlookSubscriptions.js'
import { GRAPH_BASE } from '../supabase/functions/shared/outlookGraphTransport.js'
import { handleOutlookImportWorker } from '../supabase/functions/outlook-import-worker/handler.js'
import { importKeyFromBase64, encryptToken } from '../supabase/functions/shared/googleTokenCrypto.js'
import {
  REQUIRED_CONTENT_CONSENT_VERSION, REQUIRED_BACKGROUND_CONSENT_VERSION, backgroundOperationAllowed,
} from '../supabase/functions/shared/outlookContentConsent.js'
import { makeRoundStore } from './harness/outlookRoundStore.js'

let passed = 0
let failed = 0
async function test (name, fn) {
  try { await fn(); console.log('  OK   ' + name); passed += 1 } catch (e) {
    console.error('  FAIL ' + name); console.error('       ' + (e && e.message ? e.message : String(e))); failed += 1
  }
}

const subtle = webcrypto.subtle
const NOW = Date.parse('2026-10-08T12:00:00Z')
const URL_N = 'https://project.supabase.test/functions/v1/outlook-notifications'
const TOKEN = 'fixture-access-token-not-a-secret'
const SUBS = `${GRAPH_BASE}/subscriptions`
const okRes = (status, body) => ({ status, headers: { get: () => null }, json: async () => body })
const fixedBytes = (n) => new Uint8Array(n).fill(7)

/** A Graph that answers the subscription endpoints as documented, recording every call. */
function makeGraph ({ create = 'created', renew = 'ok', list = [] } = {}) {
  const calls = []
  let n = 0
  const fetchImpl = async (url, init) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : null
    calls.push({ url, method, body, auth: init?.headers?.Authorization, redirect: init?.redirect })
    if (url === SUBS && method === 'POST') {
      n += 1
      if (create === 'conflict_once' && n === 1) return okRes(409, { error: { code: 'ExtensionError' } })
      if (create === 'bad_request') return okRes(400, { error: { code: 'InvalidRequest' } })
      if (create === 'throw') throw new Error('offline')
      return okRes(201, { id: 'sub-' + n, resource: body.resource, changeType: body.changeType, clientState: body.clientState,
        notificationUrl: body.notificationUrl, expirationDateTime: body.expirationDateTime })
    }
    if (url === SUBS && method === 'GET') return okRes(200, { value: list })
    if (url.startsWith(SUBS + '/') && method === 'PATCH') {
      if (renew === 'not_found') return okRes(404, { error: { code: 'ResourceNotFound' } })
      if (renew === 'unauthorized') return okRes(401, { error: { code: 'InvalidAuthenticationToken' } })
      return okRes(200, { id: decodeURIComponent(url.slice(SUBS.length + 1)), expirationDateTime: body.expirationDateTime })
    }
    if (url.startsWith(SUBS + '/') && method === 'DELETE') return okRes(204, null)
    throw new Error('unexpected Graph request ' + method + ' ' + url)
  }
  return { fetchImpl, calls }
}

console.log('')
console.log('1. the plan: when to create, renew, or leave alone')
await test('constants are the documented ones: me/messages, created, three days under the 10,080-minute ceiling', () => {
  assert.strictEqual(SUBSCRIPTION_RESOURCE, 'me/messages')
  assert.strictEqual(SUBSCRIPTION_CHANGE_TYPE, 'created')
  assert.strictEqual(SUBSCRIPTION_LIFETIME_MS, 3 * 24 * 3600 * 1000)
  assert.strictEqual(SUBSCRIPTION_MAX_LIFETIME_MS, 10080 * 60 * 1000)
  assert.ok(SUBSCRIPTION_LIFETIME_MS < SUBSCRIPTION_MAX_LIFETIME_MS)
  assert.ok(SUBSCRIPTION_RENEW_BEFORE_MS < SUBSCRIPTION_LIFETIME_MS)
  assert.strictEqual(expirationFrom(NOW), new Date(NOW + SUBSCRIPTION_LIFETIME_MS).toISOString())
  assert.strictEqual(expirationFrom(NOW, 100 * 24 * 3600 * 1000), new Date(NOW + SUBSCRIPTION_MAX_LIFETIME_MS).toISOString(), 'clamped to the ceiling')
})
await test('no row -> create; live -> none; expiring within a day -> renew; expired -> create; removed/failed -> create; reauthorize -> renew', () => {
  const live = { subscription_id: 'sub-1', status: 'active', expires_at: new Date(NOW + 2 * 24 * 3600 * 1000).toISOString(), client_state_hash: 'a'.repeat(64) }
  assert.deepStrictEqual(planSubscriptionAction({ row: null, nowMs: NOW, notificationUrl: URL_N }), { action: 'create', reason: 'none_recorded' })
  assert.deepStrictEqual(planSubscriptionAction({ row: live, nowMs: NOW, notificationUrl: URL_N }), { action: 'none', reason: 'live' })
  assert.deepStrictEqual(planSubscriptionAction({ row: { ...live, expires_at: new Date(NOW + 3600 * 1000).toISOString() }, nowMs: NOW, notificationUrl: URL_N }), { action: 'renew', reason: 'expiring' })
  assert.deepStrictEqual(planSubscriptionAction({ row: { ...live, expires_at: new Date(NOW - 1).toISOString() }, nowMs: NOW, notificationUrl: URL_N }), { action: 'create', reason: 'expired' })
  assert.deepStrictEqual(planSubscriptionAction({ row: { ...live, status: 'removed' }, nowMs: NOW, notificationUrl: URL_N }), { action: 'create', reason: 'removed' })
  assert.deepStrictEqual(planSubscriptionAction({ row: { ...live, status: 'failed', subscription_id: null }, nowMs: NOW, notificationUrl: URL_N }), { action: 'create', reason: 'none_recorded' })
  assert.deepStrictEqual(planSubscriptionAction({ row: { ...live, status: 'reauthorize' }, nowMs: NOW, notificationUrl: URL_N }), { action: 'renew', reason: 'reauthorization_required' })
  assert.deepStrictEqual(planSubscriptionAction({ row: live, nowMs: NOW, notificationUrl: null }), { action: 'none', reason: 'no_url' })
  assert.deepStrictEqual(planSubscriptionAction({ row: live, nowMs: NOW, notificationUrl: 'http://plain.test/x' }), { action: 'none', reason: 'no_url' })
})
await test('the notification URL must be https, on one host, without credentials or a fragment', () => {
  assert.strictEqual(isUsableNotificationUrl(URL_N), true)
  assert.strictEqual(isUsableNotificationUrl('https://user:pw@x.test/n'), false)
  assert.strictEqual(isUsableNotificationUrl('https://x.test/n#frag'), false)
  assert.strictEqual(isUsableNotificationUrl('http://x.test/n'), false)
  assert.strictEqual(isUsableNotificationUrl(''), false)
})

console.log('')
console.log('2. the requests, exactly as documented')
await test('create: POST /subscriptions with changeType, notificationUrl, lifecycleNotificationUrl, resource, expiry and clientState', () => {
  const r = buildCreateSubscriptionRequest({ notificationUrl: URL_N, lifecycleNotificationUrl: URL_N, clientState: 'cs', expirationIso: expirationFrom(NOW) })
  assert.strictEqual(r.method, 'POST')
  assert.strictEqual(r.url, SUBS)
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['changeType', 'clientState', 'expirationDateTime', 'lifecycleNotificationUrl', 'notificationUrl', 'resource'])
  assert.strictEqual(r.body.resource, 'me/messages')
  assert.strictEqual(r.body.changeType, 'created')
  assert.ok(!('includeResourceData' in r.body), 'basic notifications only: no resource data is ever requested')
  assert.throws(() => buildCreateSubscriptionRequest({ notificationUrl: 'http://x', clientState: 'cs', expirationIso: expirationFrom(NOW) }), /invalid_notification_url/)
})
await test('renew: PATCH /subscriptions/{id} with only expirationDateTime; delete: DELETE; list: GET', () => {
  const r = buildRenewSubscriptionRequest({ subscriptionId: 'sub 1', expirationIso: expirationFrom(NOW) })
  assert.strictEqual(r.method, 'PATCH')
  assert.strictEqual(r.url, SUBS + '/sub%201')
  assert.deepStrictEqual(Object.keys(r.body), ['expirationDateTime'])
  assert.deepStrictEqual(buildDeleteSubscriptionRequest({ subscriptionId: 'sub-1' }), { method: 'DELETE', url: SUBS + '/sub-1', body: null })
  assert.deepStrictEqual(buildListSubscriptionsRequest(), { method: 'GET', url: SUBS, body: null })
  assert.throws(() => buildRenewSubscriptionRequest({ subscriptionId: 'a/b', expirationIso: expirationFrom(NOW) }), /invalid_subscription_id/)
})
await test('the response reader keeps id and expiry only; the listing reader keeps only OUR subscriptions', () => {
  assert.deepStrictEqual(readSubscriptionResponse({ id: 'sub-1', expirationDateTime: '2026-10-11T00:00:00Z', clientState: 'x', applicationId: 'y' }),
    { ok: true, id: 'sub-1', expirationIso: '2026-10-11T00:00:00.000Z' })
  assert.deepStrictEqual(readSubscriptionResponse({ id: 'sub-1' }), { ok: false, code: 'malformed' })
  assert.deepStrictEqual(readSubscriptionResponse(null), { ok: false, code: 'malformed' })
  const ids = readMatchingSubscriptions({ value: [
    { id: 'ours', resource: 'me/messages', notificationUrl: URL_N },
    { id: 'ours-2', resource: '/me/messages', notificationUrl: URL_N },
    { id: 'other-url', resource: 'me/messages', notificationUrl: 'https://elsewhere.test/n' },
    { id: 'other-resource', resource: 'me/events', notificationUrl: URL_N },
  ] }, { notificationUrl: URL_N })
  assert.deepStrictEqual(ids, ['ours', 'ours-2'])
})
await test('the clientState is 43 url-safe characters from 32 random bytes; the hash is what gets stored', async () => {
  const cs = generateClientState(fixedBytes)
  assert.strictEqual(cs.length, 43)
  assert.match(cs, /^[A-Za-z0-9_-]+$/)
  assert.match(await hashClientState(cs, subtle), /^[0-9a-f]{64}$/)
  const real = generateClientState()
  assert.notStrictEqual(real, generateClientState(), 'two real states differ')
})
await test('the executor: bounded, no redirects, Graph origin only, controlled codes for every status', async () => {
  const seen = []
  const run = (status) => executeSubscriptionRequest({
    request: buildListSubscriptionsRequest(), accessToken: TOKEN,
    fetchImpl: async (url, init) => { seen.push(init); return okRes(status, { value: [] }) },
  })
  assert.deepStrictEqual(await run(200), { ok: true, json: { value: [] } })
  assert.strictEqual(seen[0].redirect, 'manual')
  assert.strictEqual(seen[0].headers.Authorization, 'Bearer ' + TOKEN)
  for (const [status, code] of [[400, 'bad_request'], [401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found'], [409, 'conflict'], [429, 'throttled'], [503, 'throttled'], [500, 'provider_error']]) {
    assert.deepStrictEqual(await run(status), { ok: false, code })
  }
  assert.deepStrictEqual(await executeSubscriptionRequest({ request: buildListSubscriptionsRequest(), accessToken: TOKEN, fetchImpl: async () => { throw new Error('x') } }), { ok: false, code: 'transport_error' })
  assert.deepStrictEqual(await executeSubscriptionRequest({ request: buildListSubscriptionsRequest(), accessToken: TOKEN, fetchImpl: async () => okRes(200, {}), budgetAllows: () => false }), { ok: false, code: 'budget_exhausted' })
  await assert.rejects(() => executeSubscriptionRequest({ request: { method: 'GET', url: 'https://evil.test/subscriptions', body: null }, accessToken: TOKEN, fetchImpl: async () => okRes(200, {}) }), /forbidden_request_url/)
  assert.ok(SUBSCRIPTION_CODES.includes('conflict') && SUBSCRIPTION_OUTCOMES.includes('recreated'))
})

console.log('')
console.log('3. maintainSubscription: the decisions, with a simulated Graph')
const persistRecorder = () => { const states = []; return { states, persist: async (s) => { states.push(s); return true } } }
await test('no row -> created: one POST, the stored state is active with the HASH, never the clientState', async () => {
  const g = makeGraph()
  const { states, persist } = persistRecorder()
  const r = await maintainSubscription({ row: null, accessToken: TOKEN, deps: { fetchImpl: g.fetchImpl }, now: () => NOW, notificationUrl: URL_N, persist, randomBytes: fixedBytes, subtle })
  assert.strictEqual(r.action, 'create'); assert.strictEqual(r.outcome, 'created'); assert.strictEqual(r.code, null)
  assert.strictEqual(g.calls.length, 1)
  assert.strictEqual(g.calls[0].body.notificationUrl, URL_N)
  assert.strictEqual(g.calls[0].body.lifecycleNotificationUrl, URL_N)
  assert.strictEqual(states.length, 1)
  assert.strictEqual(states[0].status, 'active')
  assert.strictEqual(states[0].subscriptionId, 'sub-1')
  assert.strictEqual(states[0].clientStateHash, await hashClientState(g.calls[0].body.clientState, subtle))
  assert.ok(!JSON.stringify(states[0]).includes(g.calls[0].body.clientState), 'the clientState value is not persisted')
  assert.strictEqual(r.expiresAt, new Date(NOW + SUBSCRIPTION_LIFETIME_MS).toISOString())
})
await test('a live row -> unchanged, zero requests', async () => {
  const g = makeGraph()
  const row = { subscription_id: 'sub-9', status: 'active', expires_at: new Date(NOW + 2 * 24 * 3600 * 1000).toISOString(), client_state_hash: 'a'.repeat(64) }
  const r = await maintainSubscription({ row, accessToken: TOKEN, deps: { fetchImpl: g.fetchImpl }, now: () => NOW, notificationUrl: URL_N, persist: async () => true })
  assert.deepStrictEqual(r, { action: 'none', outcome: 'unchanged', code: null, expiresAt: row.expires_at })
  assert.strictEqual(g.calls.length, 0)
})
await test('expiring -> renewed by ONE PATCH; the same id and hash are kept, the expiry moves', async () => {
  const g = makeGraph()
  const { states, persist } = persistRecorder()
  const row = { subscription_id: 'sub-9', status: 'active', expires_at: new Date(NOW + 3600 * 1000).toISOString(), client_state_hash: 'b'.repeat(64) }
  const r = await maintainSubscription({ row, accessToken: TOKEN, deps: { fetchImpl: g.fetchImpl }, now: () => NOW, notificationUrl: URL_N, persist })
  assert.strictEqual(r.outcome, 'renewed')
  assert.strictEqual(g.calls.length, 1); assert.strictEqual(g.calls[0].method, 'PATCH'); assert.strictEqual(g.calls[0].url, SUBS + '/sub-9')
  assert.strictEqual(states[0].subscriptionId, 'sub-9'); assert.strictEqual(states[0].clientStateHash, 'b'.repeat(64))
  assert.strictEqual(states[0].expiresAt, new Date(NOW + SUBSCRIPTION_LIFETIME_MS).toISOString())
})
await test('reauthorizationRequired -> the same PATCH, which reauthorizes AND renews in one request', async () => {
  const g = makeGraph()
  const { states, persist } = persistRecorder()
  const row = { subscription_id: 'sub-9', status: 'reauthorize', expires_at: new Date(NOW + 2 * 24 * 3600 * 1000).toISOString(), client_state_hash: 'b'.repeat(64) }
  const r = await maintainSubscription({ row, accessToken: TOKEN, deps: { fetchImpl: g.fetchImpl }, now: () => NOW, notificationUrl: URL_N, persist })
  assert.strictEqual(r.outcome, 'renewed'); assert.strictEqual(g.calls.length, 1); assert.strictEqual(g.calls[0].method, 'PATCH')
  assert.strictEqual(states[0].status, 'active')
})
await test('renewal finds it gone (404) -> recreated: a fresh POST with a NEW clientState', async () => {
  const g = makeGraph({ renew: 'not_found' })
  const { states, persist } = persistRecorder()
  const row = { subscription_id: 'sub-9', status: 'active', expires_at: new Date(NOW + 3600 * 1000).toISOString(), client_state_hash: 'b'.repeat(64) }
  const r = await maintainSubscription({ row, accessToken: TOKEN, deps: { fetchImpl: g.fetchImpl }, now: () => NOW, notificationUrl: URL_N, persist, randomBytes: fixedBytes, subtle })
  assert.strictEqual(r.outcome, 'recreated'); assert.strictEqual(r.action, 'renew')
  assert.deepStrictEqual(g.calls.map((c) => c.method), ['PATCH', 'POST'])
  assert.strictEqual(states[0].subscriptionId, 'sub-1')
  assert.notStrictEqual(states[0].clientStateHash, 'b'.repeat(64))
})
await test('a renewal refused for another reason -> renew_failed with the code, the old identity kept, the row recorded', async () => {
  const g = makeGraph({ renew: 'unauthorized' })
  const { states, persist } = persistRecorder()
  const row = { subscription_id: 'sub-9', status: 'reauthorize', expires_at: new Date(NOW + 3600 * 1000).toISOString(), client_state_hash: 'b'.repeat(64) }
  const r = await maintainSubscription({ row, accessToken: TOKEN, deps: { fetchImpl: g.fetchImpl }, now: () => NOW, notificationUrl: URL_N, persist })
  assert.strictEqual(r.outcome, 'renew_failed'); assert.strictEqual(r.code, 'unauthorized')
  assert.strictEqual(states[0].status, 'reauthorize'); assert.strictEqual(states[0].errorCode, 'unauthorized'); assert.strictEqual(states[0].subscriptionId, 'sub-9')
})
await test('409 duplicate (a reconnected mailbox): list, delete OUR stale ones only, create again', async () => {
  const g = makeGraph({ create: 'conflict_once', list: [
    { id: 'stale-ours', resource: 'me/messages', notificationUrl: URL_N },
    { id: 'someone-elses', resource: 'me/messages', notificationUrl: 'https://elsewhere.test/n' },
  ] })
  const { states, persist } = persistRecorder()
  const r = await maintainSubscription({ row: { status: 'removed', subscription_id: 'old', expires_at: null, client_state_hash: 'c'.repeat(64) }, accessToken: TOKEN, deps: { fetchImpl: g.fetchImpl }, now: () => NOW, notificationUrl: URL_N, persist, randomBytes: fixedBytes, subtle })
  assert.strictEqual(r.outcome, 'created')
  assert.deepStrictEqual(g.calls.map((c) => c.method + ' ' + c.url.slice(SUBS.length)), ['POST ', 'GET ', 'DELETE /stale-ours', 'POST '])
  assert.strictEqual(states[0].status, 'active'); assert.strictEqual(states[0].subscriptionId, 'sub-2')
})
await test('Graph refuses the creation (400: endpoint validation failed) -> create_failed, recorded as failed with the code', async () => {
  const g = makeGraph({ create: 'bad_request' })
  const { states, persist } = persistRecorder()
  const r = await maintainSubscription({ row: null, accessToken: TOKEN, deps: { fetchImpl: g.fetchImpl }, now: () => NOW, notificationUrl: URL_N, persist, randomBytes: fixedBytes, subtle })
  assert.deepStrictEqual(r, { action: 'create', outcome: 'create_failed', code: 'bad_request', expiresAt: null })
  assert.strictEqual(states[0].status, 'failed'); assert.strictEqual(states[0].subscriptionId, null); assert.strictEqual(states[0].errorCode, 'bad_request')
})
await test('a transport failure is create_failed/transport_error; no notification URL is skipped_no_url with zero requests; no budget is skipped_budget', async () => {
  const g = makeGraph({ create: 'throw' })
  const r = await maintainSubscription({ row: null, accessToken: TOKEN, deps: { fetchImpl: g.fetchImpl }, now: () => NOW, notificationUrl: URL_N, persist: async () => true, randomBytes: fixedBytes, subtle })
  assert.strictEqual(r.outcome, 'create_failed'); assert.strictEqual(r.code, 'transport_error')
  const g2 = makeGraph()
  const r2 = await maintainSubscription({ row: null, accessToken: TOKEN, deps: { fetchImpl: g2.fetchImpl }, now: () => NOW, notificationUrl: null, persist: async () => true })
  assert.deepStrictEqual(r2, { action: 'none', outcome: 'skipped_no_url', code: null, expiresAt: null }); assert.strictEqual(g2.calls.length, 0)
  const r3 = await maintainSubscription({ row: null, accessToken: TOKEN, deps: { fetchImpl: g2.fetchImpl }, now: () => NOW, notificationUrl: URL_N, persist: async () => true, budgetAllows: () => false })
  assert.strictEqual(r3.outcome, 'skipped_budget'); assert.strictEqual(g2.calls.length, 0)
})
await test('a database that refuses the record -> record_failed, so the report never claims a subscription the row does not show', async () => {
  const g = makeGraph()
  const r = await maintainSubscription({ row: null, accessToken: TOKEN, deps: { fetchImpl: g.fetchImpl }, now: () => NOW, notificationUrl: URL_N, persist: async () => false, randomBytes: fixedBytes, subtle })
  assert.strictEqual(r.outcome, 'record_failed')
  assert.deepStrictEqual(summarizeSubscriptionStep({ action: 'create', outcome: 'weird', code: 'nope', expiresAt: 'garbage' }), { action: 'create', outcome: 'unchanged', code: null, expires_at: null })
})

console.log('')
console.log('4. through the REAL worker handler: the step runs under the lease, before the import, never fatally')
const KEY_B64 = Buffer.alloc(32, 9).toString('base64')
const SECRET = 't'.repeat(40)
const CONN = '11111111-1111-1111-1111-111111111111'
const PILOT = '22222222-2222-2222-2222-222222222222'
const ME = 'pilot@outlook.test'
const workerReq = () => ({ method: 'POST', headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer ' + SECRET : null) } })
const env = (over = {}) => ({
  integrationEnabled: 'true', workerEnabled: 'true', workerSecret: SECRET, clientId: 'c', clientSecret: 'cs', tokenKeyB64: KEY_B64,
  fingerprintKey: { current: { keyBytes: new Uint8Array(32).fill(1), keyVersion: 1 } }, keyVersion: 1, pilotUserId: PILOT,
  scope: 'openid profile email offline_access Mail.Read User.Read', anthropicApiKey: 'sk-ant-fixture-not-a-real-key',
  notificationUrl: URL_N, ...over,
})

/** Ports: the round store for round state, an in-memory subscription row, a reservation that may carry a wake-up. */
async function makePorts ({ subscriptionRow = null, wakeRequestedAt = null } = {}) {
  const key = await importKeyFromBase64(KEY_B64, subtle)
  const sealed = await encryptToken(TOKEN, key, { subtle })
  const expires = new Date(Date.now() + 3600000).toISOString()
  const store = makeRoundStore()
  const state = { row: subscriptionRow, recorded: [], releases: [] }
  const select = async (path) => {
    if (path.startsWith('microsoft_connections?')) {
      return { data: [{ user_id: PILOT, ms_email: ME, scopes: ['Mail.Read', 'User.Read'], token_expires_at: expires, consent_policy_version: REQUIRED_CONTENT_CONSENT_VERSION }], error: null }
    }
    if (path.startsWith('contacts?')) return { data: [], error: null }
    if (path.startsWith('outlook_sync_state?')) return { data: [], error: null }
    if (path.startsWith('microsoft_tokens?')) {
      return { data: [{ access_token_ciphertext: sealed.ciphertext, access_token_nonce: sealed.nonce, refresh_token_ciphertext: sealed.ciphertext, refresh_token_nonce: sealed.nonce, key_version: 1, token_expires_at: expires }], error: null }
    }
    if (path.startsWith('outlook_subscriptions?')) return { data: state.row ? [state.row] : [], error: null }
    throw new Error('unexpected select: ' + path)
  }
  const rpc = async (name, args) => {
    if (name === 'reserve_due_outlook_connection') {
      return { data: { result: 'reserved', connection_id: CONN, user_id: PILOT, run_id: 'run-1', wake_requested_at: wakeRequestedAt }, error: null }
    }
    if (name === 'renew_outlook_sync_lease') return { data: true, error: null }
    if (name === 'record_outlook_subscription_state') {
      state.recorded.push(args)
      assert.strictEqual(args.p_connection_id, CONN); assert.strictEqual(args.p_run_id, 'run-1')
      state.row = { subscription_id: args.p_subscription_id, status: args.p_status, expires_at: args.p_expires_at, client_state_hash: args.p_client_state_hash }
      return { data: { result: 'recorded' }, error: null }
    }
    if (name === 'release_outlook_sync_lease') {
      state.releases.push({ status: args.p_status, complete: args.p_run_complete })
      if (args.p_run_complete === true) store.commitRelease()
      return { data: true, error: null }
    }
    const s = await store.handle(name, args)
    if (s !== null) return s
    throw new Error('unexpected rpc: ' + name)
  }
  return { select, rpc, state }
}

/** Graph: empty delta pages for both folders, plus the subscription endpoints. */
function makeWorkerGraph (opts) {
  const g = makeGraph(opts)
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith(SUBS)) return g.fetchImpl(url, init)
    const folder = String(url).includes('/mailFolders/inbox/') ? 'inbox' : 'sentitems'
    return okRes(200, { value: [], '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=R1` })
  }
  return { fetchImpl, calls: g.calls }
}

async function invoke (ports, fetchImpl, over, runOver = {}) {
  const res = await handleOutlookImportWorker(workerReq(), env(over), { tokenUrl: 'https://login.invalid/token', select: ports.select, rpc: ports.rpc, graphFetchImpl: fetchImpl, now: () => NOW, subtle, ...runOver })
  return { status: res.status, run: (await res.json()).run }
}

await test('first run: the subscription is CREATED under the lease and recorded through the fenced RPC; the import still commits', async () => {
  const ports = await makePorts()
  const graph = makeWorkerGraph()
  const { status, run } = await invoke(ports, graph.fetchImpl)
  assert.strictEqual(status, 200)
  assert.strictEqual(run.outcome, 'committed', JSON.stringify(run))
  assert.deepStrictEqual(run.subscription, { action: 'create', outcome: 'created', code: null, expires_at: new Date(NOW + SUBSCRIPTION_LIFETIME_MS).toISOString() })
  assert.strictEqual(run.wake_age_seconds, null, 'due on the routine interval, not by a wake-up')
  const posts = graph.calls.filter((c) => c.method === 'POST' && c.url === SUBS)
  assert.strictEqual(posts.length, 1)
  assert.strictEqual(posts[0].body.notificationUrl, URL_N)
  assert.strictEqual(posts[0].auth, 'Bearer ' + TOKEN, 'the run context token is the one used')
  assert.strictEqual(ports.state.recorded.length, 1)
  assert.strictEqual(ports.state.recorded[0].p_status, 'active')
  assert.strictEqual(ports.state.recorded[0].p_client_state_hash, await hashClientState(posts[0].body.clientState, subtle))
  assert.ok(!JSON.stringify(run).includes(posts[0].body.clientState), 'the clientState never appears in the report')
  assert.ok(!JSON.stringify(run).includes('sub-1'), 'nor does the subscription id')
})
await test('second run with a live subscription: unchanged, no subscription request; a wake-up is reported as its age', async () => {
  const live = { subscription_id: 'sub-7', status: 'active', expires_at: new Date(NOW + 2 * 24 * 3600 * 1000).toISOString(), client_state_hash: 'a'.repeat(64) }
  const ports = await makePorts({ subscriptionRow: live, wakeRequestedAt: new Date(NOW - 42_000).toISOString() })
  const graph = makeWorkerGraph()
  const { run } = await invoke(ports, graph.fetchImpl)
  assert.strictEqual(run.outcome, 'committed')
  assert.strictEqual(run.subscription.outcome, 'unchanged')
  assert.strictEqual(graph.calls.length, 0)
  assert.strictEqual(run.wake_age_seconds, 42, 'the latency from the signal to the run start is measurable')
})
await test('an expiring subscription is RENEWED by the run; a removed one (lifecycle) is RECREATED', async () => {
  const expiring = { subscription_id: 'sub-7', status: 'active', expires_at: new Date(NOW + 3600 * 1000).toISOString(), client_state_hash: 'a'.repeat(64) }
  let ports = await makePorts({ subscriptionRow: expiring })
  let graph = makeWorkerGraph()
  let { run } = await invoke(ports, graph.fetchImpl)
  assert.strictEqual(run.subscription.outcome, 'renewed')
  assert.deepStrictEqual(graph.calls.map((c) => c.method), ['PATCH'])
  const removed = { ...expiring, status: 'removed' }
  ports = await makePorts({ subscriptionRow: removed })
  graph = makeWorkerGraph()
  ;({ run } = await invoke(ports, graph.fetchImpl))
  assert.strictEqual(run.subscription.outcome, 'created')
  assert.strictEqual(ports.state.row.status, 'active')
  assert.strictEqual(ports.state.row.subscription_id, 'sub-1')
})
await test('Graph refusing the subscription does NOT fail the import: committed, with create_failed reported and recorded', async () => {
  const ports = await makePorts()
  const graph = makeWorkerGraph({ create: 'bad_request' })
  const { status, run } = await invoke(ports, graph.fetchImpl)
  assert.strictEqual(status, 200)
  assert.strictEqual(run.outcome, 'committed')
  assert.deepStrictEqual(run.subscription, { action: 'create', outcome: 'create_failed', code: 'bad_request', expires_at: null })
  assert.strictEqual(ports.state.recorded[0].p_status, 'failed')
  assert.strictEqual(ports.state.recorded[0].p_error_code, 'bad_request')
})
await test('without a notification URL the step is skipped and reported; nothing is requested or recorded', async () => {
  const ports = await makePorts()
  const graph = makeWorkerGraph()
  const { run } = await invoke(ports, graph.fetchImpl, { notificationUrl: null })
  assert.strictEqual(run.outcome, 'committed')
  assert.strictEqual(run.subscription.outcome, 'skipped_no_url')
  assert.strictEqual(graph.calls.length, 0)
  assert.strictEqual(ports.state.recorded.length, 0)
})

console.log('')
console.log('5. the background-operation consent gate: open while unset, closed to stale consent once set')
await test('the pure gate: null required = open; a set version must match the recorded one exactly', () => {
  assert.strictEqual(REQUIRED_BACKGROUND_CONSENT_VERSION, null, 'unset until the wording is published and re-consented')
  assert.deepStrictEqual(backgroundOperationAllowed('anything', null), { ok: true, reason: 'gate_open' })
  const v = 'ol-disc-' + 'f'.repeat(32)
  assert.deepStrictEqual(backgroundOperationAllowed(v, v), { ok: true, reason: 'consented' })
  assert.deepStrictEqual(backgroundOperationAllowed(REQUIRED_CONTENT_CONSENT_VERSION, v), { ok: false, reason: 'background_consent_missing' })
  assert.deepStrictEqual(backgroundOperationAllowed(null, v), { ok: false, reason: 'background_consent_missing' })
  assert.deepStrictEqual(backgroundOperationAllowed(v, 'not-a-version'), { ok: false, reason: 'background_consent_missing' }, 'a malformed requirement fails closed')
})
await test('once set, a connection consented under an older disclosure is released untouched: no read, no subscription request, consent_missing', async () => {
  const { runOutlookImport } = await import('../supabase/functions/shared/outlookImportRun.js')
  const { makeRunContextLoader, makeCursorEncryptor, makeCursorDecryptor } = await import('../supabase/functions/shared/outlookRunContext.js')
  const ports = await makePorts()
  const graph = makeWorkerGraph()
  const run = (required) => runOutlookImport({
    rpc: ports.rpc, select: ports.select, pilotUserId: PILOT, requestEntryMs: NOW,
    encryptCursor: makeCursorEncryptor({ tokenKeyB64: KEY_B64, keyVersion: 1, subtle }),
    decryptCursor: makeCursorDecryptor({ tokenKeyB64: KEY_B64, subtle }),
    loadRunContext: makeRunContextLoader({ select: ports.select, rpc: ports.rpc, config: { clientId: 'c', clientSecret: 'cs', tokenUrl: 'https://login.invalid/token', tokenKeyB64: KEY_B64, keyVersion: 1, keyRing: env().fingerprintKey, scope: env().scope }, deps: { subtle, now: () => NOW } }),
    subscriptions: { notificationUrl: URL_N }, deps: { fetchImpl: graph.fetchImpl, now: () => NOW },
    requiredBackgroundConsent: required,
  })
  const closed = await run('ol-disc-' + 'f'.repeat(32))   // the connection recorded REQUIRED_CONTENT_CONSENT_VERSION
  assert.strictEqual(closed.outcome, 'consent_missing', JSON.stringify(closed))
  assert.strictEqual(closed.reason, 'background_consent_missing')
  assert.strictEqual(graph.calls.length, 0, 'no subscription request')
  assert.strictEqual(ports.state.recorded.length, 0, 'nothing recorded')
  assert.deepStrictEqual(ports.state.releases, [{ status: 'idle', complete: false }], 'released untouched, with the backoff')
  const open = await run(REQUIRED_CONTENT_CONSENT_VERSION)   // the same version the row recorded
  assert.strictEqual(open.outcome, 'committed', JSON.stringify(open))
  assert.strictEqual(graph.calls.filter((c) => c.method === 'POST').length, 1, 'the subscription is created once consent matches')
})

console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exit(1)
