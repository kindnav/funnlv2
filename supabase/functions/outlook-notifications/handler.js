// outlook-notifications — the endpoint Microsoft Graph POSTs to when a subscribed mailbox
// changes, and the one it validates when a subscription is created.
//
// WHAT THIS ENDPOINT DOES WITH A NOTIFICATION: records a durable WAKE-UP for the connection
// the subscription belongs to, after the database has matched the subscription id and the
// SHA-256 of the clientState Microsoft sent back. Then it answers 202 within Microsoft's
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
// RESPONSES, deliberately:
//   validation          200 text/plain <token>   (POST ...?validationToken=...)
//   notifications       202 { received, outcomes }  - every well-formed batch, INCLUDING ones
//                       whose items were all rejected. Microsoft retries non-2xx answers for
//                       up to four hours; an unknown subscription or a wrong clientState will
//                       not become right by being retried, so acknowledging and dropping is
//                       the safe answer. Rejections are counted in the body and reportable.
//   not enabled         503 not_enabled           - dormant, like every Outlook function
//   method              405 method_not_allowed
//   unreadable body     400 malformed
//
// DORMANCY. OUTLOOK_INTEGRATION_ENABLED must be exactly 'true'. The worker's own flag is
// NOT checked here: a wake-up recorded while the worker is off is simply picked up when it
// is turned on, and the kick it sends answers not_enabled harmlessly.

import { readJsonBounded, MAX_PROVIDER_BODY_BYTES } from '../shared/boundedJson.js'
import {
  readValidationToken, parseNotificationBatch, coalesceNotifications, hashClientState,
  summarizeNotificationOutcomes, NOTIFICATION_OUTCOMES,
} from '../shared/outlookChangeNotifications.js'

export const NOTIFICATION_CODES = Object.freeze(['not_enabled', 'method_not_allowed', 'malformed'])
/** The one database function this endpoint may call. */
export const NOTIFICATION_RPC = 'record_outlook_change_notification'
/** The kick is bounded like every outbound request here. */
export const KICK_TIMEOUT_MS = 5_000

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
 * @param {Request} req
 * @param {{integrationEnabled?:string|null}} env
 * @param {{rpc:Function, kick?:Function|null, waitUntil?:Function, subtle?:SubtleCrypto}} deps
 */
export async function handleOutlookNotifications (req, env, deps) {
  const e = env || {}
  const d = deps || {}

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

  // 3. THE BATCH, bounded in size and parsed to the minimum.
  const read = await readJsonBounded(req, MAX_PROVIDER_BODY_BYTES)
  if (!read.ok) return json(400, { error: 'malformed' })
  const batch = parseNotificationBatch(read.value)
  if (!batch.ok) return json(400, { error: 'malformed' })

  // 4. ONE database call per distinct (subscription, kind); the database matches the hash.
  const outcomes = []
  let accepted = 0
  for (const item of coalesceNotifications(batch.items)) {
    let outcome = 'rpc_error'
    try {
      const hash = await hashClientState(item.clientState, d.subtle)
      const res = await d.rpc(NOTIFICATION_RPC, {
        p_subscription_id: item.subscriptionId,
        p_client_state_hash: hash,
        p_kind: item.kind,
      })
      const code = res?.error ? 'rpc_error' : res?.data?.result
      outcome = NOTIFICATION_OUTCOMES.includes(code) ? code : 'rpc_error'
    } catch {
      outcome = 'rpc_error'
    }
    outcomes.push(outcome)
    if (outcome === 'accepted') accepted += 1
  }

  // 5. ACKNOWLEDGE FIRST; the kick runs after the response is on its way.
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
