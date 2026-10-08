// PARSING AND VALIDATING what Microsoft Graph POSTs to the notification endpoint.
//
// Pure: no I/O, no clock, no secrets. The endpoint handler
// (supabase/functions/outlook-notifications/handler.js) calls these and then asks the
// database to match the subscription and its clientState hash; nothing here decides that.
//
// WHAT IS READ FROM A NOTIFICATION, AND WHAT IS NOT. Only `subscriptionId`,
// `clientState`, and the event kind (`changeType` for a change, `lifecycleEvent` for a
// lifecycle notification). `resource`, `resourceData` (which carries the message id in a
// basic notification), `tenantId` and `subscriptionExpirationDateTime` are never read:
// a notification is a wake-up signal, and the delta pipeline establishes what changed.
//
// THE VALIDATION HANDSHAKE (change-notifications-delivery-webhooks): Microsoft POSTs to the
// notification URL with `?validationToken=<opaque>` and the endpoint must answer 200,
// text/plain, with the URL-decoded token, within 10 seconds. The token is opaque and is
// echoed back as plain text only - never as HTML, never logged.

import { hashClientState, isUsableSubscriptionId, MAX_CLIENT_STATE_CHARS } from './outlookSubscriptions.js'

export { hashClientState }

export const MAX_NOTIFICATIONS_PER_REQUEST = 100
export const MAX_VALIDATION_TOKEN_CHARS = 2048
/** The event kinds the endpoint records. Anything else in a batch is dropped, counted. */
export const NOTIFICATION_KINDS = Object.freeze(['change', 'reauthorizationRequired', 'subscriptionRemoved', 'missed'])
/** What the database can answer for one notification. Controlled; safe to log. */
export const NOTIFICATION_OUTCOMES = Object.freeze([
  'accepted', 'unknown_subscription', 'client_state_mismatch', 'connection_inactive', 'rpc_error',
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

/**
 * The validation token from the request URL, or null when this is not a validation
 * request. URLSearchParams performs the URL decoding Microsoft requires.
 * @param {string} requestUrl
 */
export function readValidationToken (requestUrl) {
  let u
  try { u = new URL(String(requestUrl)) } catch { return null }
  const token = u.searchParams.get('validationToken')
  if (token === null) return null
  return printable(token, MAX_VALIDATION_TOKEN_CHARS) ? token : null
}

/**
 * Parse a changeNotificationCollection into the minimum the endpoint acts on.
 * @param {unknown} json
 * @returns {{ok:true, items:Array<{subscriptionId:string, clientState:string, kind:string}>, dropped:number}
 *          |{ok:false, code:'malformed'}}
 */
export function parseNotificationBatch (json) {
  if (!isPlainObject(json) || !Array.isArray(json.value)) return { ok: false, code: 'malformed' }
  const items = []
  let dropped = 0
  for (const n of json.value.slice(0, MAX_NOTIFICATIONS_PER_REQUEST)) {
    if (!isPlainObject(n) || !isUsableSubscriptionId(n.subscriptionId) || !printable(n.clientState, MAX_CLIENT_STATE_CHARS)) {
      dropped += 1
      continue
    }
    let kind = null
    if (typeof n.lifecycleEvent === 'string') {
      kind = NOTIFICATION_KINDS.includes(n.lifecycleEvent) && n.lifecycleEvent !== 'change' ? n.lifecycleEvent : null
    } else if (typeof n.changeType === 'string' && n.changeType.length > 0 && n.changeType.length <= 32) {
      kind = 'change'
    }
    if (kind === null) { dropped += 1; continue }
    items.push({ subscriptionId: n.subscriptionId, clientState: n.clientState, kind })
  }
  dropped += Math.max(0, json.value.length - MAX_NOTIFICATIONS_PER_REQUEST)
  return { ok: true, items, dropped }
}

/**
 * One database call per (subscription, kind) in a batch. Microsoft batches many changes
 * into one POST and may deliver the same change more than once; the wake-up they all
 * ask for is the same wake-up.
 */
export function coalesceNotifications (items) {
  const seen = new Set()
  const out = []
  for (const it of Array.isArray(items) ? items : []) {
    const key = it.subscriptionId + ' ' + it.kind + ' ' + it.clientState
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

/** Counts per controlled outcome; an unknown string is counted as rpc_error. */
export function summarizeNotificationOutcomes (outcomes) {
  const counts = {}
  for (const o of Array.isArray(outcomes) ? outcomes : []) {
    const k = NOTIFICATION_OUTCOMES.includes(o) ? o : 'rpc_error'
    counts[k] = (counts[k] || 0) + 1
  }
  return counts
}
