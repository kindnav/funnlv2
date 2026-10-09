// outlook-notifications — the endpoint Microsoft Graph POSTs to when a subscribed mailbox
// changes, and the one it validates when a subscription is created.
//
// WHAT THIS ENDPOINT DOES WITH A NOTIFICATION: records a durable WAKE-UP for the connection
// the subscription belongs to, after the database has matched the subscription id and the
// SHA-256 of the clientState Microsoft sent back. Then it answers within Microsoft's
// 3-second window, and - off the response path - asks the import worker to run now. The
// worker's own reservation lease makes that safe: a second kick while a run is in progress
// answers none_due and does nothing, and a wake-up that arrives during a run stays pending
// for the next one. The notification itself is never trusted to say WHAT changed; the delta
// read decides that.
//
// WHAT IT NEVER DOES: read a message, a resource id, an address or a subject (the parser
// does not even look at `resourceData`); start a run itself; accept a notification whose
// clientState hash does not match; create, delete or renew a subscription (the worker does,
// under its lease); log a token, a body, or a provider message.
//
// DURABLE ACKNOWLEDGEMENT. Microsoft treats any 2xx as delivered and never resends it;
// a non-2xx is retried with backoff for up to four hours. So the answer has to mean what
// it says:
//   202  every item in the batch reached a DEFINITIVE answer in the database - accepted
//        (wake-up recorded), or refused for a reason a retry cannot change: unknown
//        subscription, wrong clientState, disconnected or inactive account. Refusals are
//        acknowledged and dropped, counted in the body - no retry storm, no wake-up.
//   503  the batch could NOT be durably recorded for a TRANSIENT reason: the database port
//        failed, answered an unknown shape, or did not answer inside the ingress budget.
//        Microsoft retries; redelivery of an already-recorded item is harmless (the wake-up
//        is a timestamp and a count, not a queue). Nothing is kicked on this path.
//   400  the body is not a notification collection at all.
//   405  not a POST (a GET with ?validationToken= is still answered).
//   503  not_enabled - dormant, like every Outlook function.
//
// THE INGRESS BUDGET. Reproduced through this handler before it existed: one RPC per item
// through a port that allows 15 seconds per call means a batch of a dozen could take three
// minutes to answer - and Microsoft marks an endpoint "slow" after 3 seconds, "drop" after
// 10, and begins discarding notifications it cannot recover. So the WHOLE path - reading the
// body and persisting the batch - is raced against INGRESS_BUDGET_MS measured from entry,
// and the batch is ONE database call (record_outlook_change_notification_batch), not one
// per item. Past the budget the answer is 503 and Microsoft redelivers; the raced call may
// still land, which is safe for the same reason redelivery is.

import { readJsonBounded, MAX_PROVIDER_BODY_BYTES } from '../shared/boundedJson.js'
import {
  readValidationToken, parseNotificationBatch, coalesceNotifications, hashClientState,
  summarizeNotificationOutcomes, NOTIFICATION_OUTCOMES,
} from '../shared/outlookChangeNotifications.js'

export const NOTIFICATION_CODES = Object.freeze(['not_enabled', 'method_not_allowed', 'malformed', 'persistence_failed'])
/** The one database function this endpoint may call: the whole batch in one round trip. */
export const NOTIFICATION_RPC = 'record_outlook_change_notification_batch'
/** Under Microsoft's 3-second delivery window, with room for the response to travel. */
export const INGRESS_BUDGET_MS = 2_500
/** The kick is bounded like every outbound request here. */
export const KICK_TIMEOUT_MS = 5_000
/** Answers a retry cannot change. Everything else about an item is transient. */
export const DEFINITIVE_OUTCOMES = Object.freeze(['accepted', 'unknown_subscription', 'client_state_mismatch', 'connection_inactive'])

function json (status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

/** Fail-safe: anything but the exact string is off. */
export function flagEnabled (raw) {
  return raw === 'true'
}

/**
 * Build the worker kick: one POST with the shared worker secret, result ignored. The
 * worker reads no body, so none is sent; only the status is awaited so the timer can be
 * cleared, and nothing of the response is read.
 */
export function makeWorkerKick ({ workerUrl, workerSecret, fetchImpl = globalThis.fetch }) {
  if (typeof workerUrl !== 'string' || !workerUrl.startsWith('https://')) return null
  if (typeof workerSecret !== 'string' || workerSecret.length === 0) return null
  return async function kick () {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort() } catch { /* gone */ } }, KICK_TIMEOUT_MS) : null
    try {
      await fetchImpl(workerUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${workerSecret}` },
        redirect: 'error',
        signal: ctrl ? ctrl.signal : undefined,
      })
    } catch {
      // Best effort only. The scheduled tick is the guaranteed path.
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
}

/**
 * Race a promise against what is left of the ingress budget. Resolves `{ timedOut: true }`
 * when the budget runs out first; the underlying work is not cancelled (a landed write is
 * harmless and a Microsoft redelivery is idempotent).
 */
async function withinBudget (promise, remainingMs) {
  if (!(remainingMs > 0)) return { timedOut: true }
  let timer = null
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false, value }), (error) => ({ timedOut: false, error })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), remainingMs) }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * The per-item answers from the batch RPC, or null when the shape is not what the database
 * promises (that is a transient failure: answer 503 and let Microsoft redeliver).
 */
export function readBatchResults (data, expected) {
  const list = data && typeof data === 'object' && Array.isArray(data.results) ? data.results : null
  if (list === null || list.length !== expected) return null
  const out = []
  for (const r of list) {
    const code = r && typeof r === 'object' ? r.result : null
    if (!DEFINITIVE_OUTCOMES.includes(code)) return null
    out.push(code)
  }
  return out
}

/**
 * @param {Request} req
 * @param {{integrationEnabled?:string|null}} env
 * @param {{rpc:Function, kick?:Function|null, waitUntil?:Function, subtle?:SubtleCrypto,
 *          now?:Function, ingressBudgetMs?:number}} deps
 */
export async function handleOutlookNotifications (req, env, deps) {
  const e = env || {}
  const d = deps || {}
  const now = typeof d.now === 'function' ? d.now : Date.now
  const entryMs = now()
  const budgetMs = Number.isFinite(d.ingressBudgetMs) && d.ingressBudgetMs > 0 ? d.ingressBudgetMs : INGRESS_BUDGET_MS
  const remaining = () => budgetMs - (now() - entryMs)

  // 1. DORMANCY, before anything else - a disabled endpoint answers nothing about itself.
  if (!flagEnabled(e.integrationEnabled)) return json(503, { error: 'not_enabled' })

  // 2. THE VALIDATION HANDSHAKE. Microsoft POSTs; GET is tolerated for the same check.
  const token = readValidationToken(req?.url)
  if (token !== null && (req?.method === 'POST' || req?.method === 'GET')) {
    return new Response(token, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    })
  }

  if (req?.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  if (typeof d.rpc !== 'function') return json(503, { error: 'not_enabled' })

  // 3. THE BATCH, bounded in size and in time, parsed to the minimum.
  const read = await withinBudget(readJsonBounded(req, MAX_PROVIDER_BODY_BYTES), remaining())
  if (read.timedOut || read.error) return json(503, { error: 'persistence_failed', retryable: true, stage: 'body' })
  if (!read.value.ok) return json(400, { error: 'malformed' })
  const batch = parseNotificationBatch(read.value.value)
  if (!batch.ok) return json(400, { error: 'malformed' })
  const items = coalesceNotifications(batch.items)
  if (items.length === 0) {
    return json(202, { received: 0, dropped: batch.dropped, outcomes: {}, kicked: false })
  }

  // 4. ONE database call for the whole batch; the database matches each hash.
  let payload
  try {
    payload = []
    for (const item of items) {
      payload.push({
        subscription_id: item.subscriptionId,
        client_state_hash: await hashClientState(item.clientState, d.subtle),
        kind: item.kind,
      })
    }
  } catch {
    return json(400, { error: 'malformed' })
  }
  const persisted = await withinBudget(
    Promise.resolve().then(() => d.rpc(NOTIFICATION_RPC, { p_items: payload })), remaining())
  if (persisted.timedOut) return json(503, { error: 'persistence_failed', retryable: true, stage: 'timeout' })
  if (persisted.error || persisted.value?.error) return json(503, { error: 'persistence_failed', retryable: true, stage: 'rpc' })
  const outcomes = readBatchResults(persisted.value?.data, items.length)
  if (outcomes === null) return json(503, { error: 'persistence_failed', retryable: true, stage: 'shape' })

  // 5. ACKNOWLEDGE; the kick runs after persistence, off the response path.
  const accepted = outcomes.filter((o) => o === 'accepted').length
  if (accepted > 0 && typeof d.kick === 'function') {
    const p = Promise.resolve().then(() => d.kick()).catch(() => {})
    if (typeof d.waitUntil === 'function') {
      try { d.waitUntil(p) } catch { /* the promise still runs */ }
    }
  }
  return json(202, {
    received: batch.items.length,
    dropped: batch.dropped,
    outcomes: summarizeNotificationOutcomes(outcomes),
    kicked: accepted > 0 && typeof d.kick === 'function',
  })
}

export { NOTIFICATION_OUTCOMES }
