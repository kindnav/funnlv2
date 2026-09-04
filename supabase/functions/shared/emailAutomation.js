// Phase E1 — reason-coded automation / bulk-list classification.
//
// Pure, cross-runtime. No I/O, no secrets, no logging. Operates only on a
// NormalizedMessage (metadata facts). Returns ONLY controlled reason codes — never an
// address, subject text, provider id, or header value.
//
// Two independent judgments:
//   1. bulkListReason(msg): STRONG structural bulk/list evidence → the whole episode is
//      hard-rejected (mailing lists / newsletters / bulk mail are never a 1:1 exchange).
//   2. nonHumanReason(msg): this individual message must be EXCLUDED from human-message
//      counts (out-of-office, delivery failure, auto-notification, calendar notification,
//      no-reply sender, Auto-Submitted, X-Auto-Response-Suppress). Excluding a single
//      automated message does not by itself invalidate an otherwise human exchange — the
//      remaining human messages must still independently satisfy every qualification rule.

import { parseSingleAddress } from './emailAddress.js'

// Sender local-parts that indicate a non-human/automated origin. Mirrors the Calendar
// automation semantics; separator-aware so "no-reply", "noreply", "no_reply.team" match.
const NONHUMAN_LOCAL_RE =
  /^(no[-_]?reply|do[-_]?not[-_]?reply|donotreply|mailer-daemon|postmaster|bounce|bounces|notification|notifications|automated|auto[-_]?reply|mailer)($|[._+-])/

// Well-known automated calendar-notification senders (exact, normalized).
const CALENDAR_NOTIFICATION_SENDERS = new Set([
  'calendar-notification@google.com',
])

// Conservative, documented subject heuristics. Subject is a TRANSIENT metadata input;
// it is used only in-memory here and never logged/persisted/returned.
const OOO_SUBJECT_RE = /\b(out of office|automatic reply|auto[-\s]?reply|autoreply|on vacation|away from my|out of the office)\b/
const DELIVERY_FAILURE_SUBJECT_RE = /\b(delivery status notification|undeliverable|mail delivery failed|returned mail|delivery failure|failure notice|mail delivery subsystem)\b/
const CALENDAR_SUBJECT_RE = /^\s*(invitation:|updated invitation:|accepted:|declined:|tentative:|canceled event:|cancelled event:|updated:)/

function normSubject(subject) {
  return typeof subject === 'string' ? subject.trim().toLowerCase() : ''
}

/**
 * Strong structural bulk/list evidence → hard-reject the episode.
 * @param {import('./emailProviderContract.js').NormalizedMessage} msg
 * @returns {('list_id'|'list_unsubscribe'|'precedence_bulk'|null)}
 */
export function bulkListReason(msg) {
  const a = (msg && typeof msg === 'object' && msg.automation && typeof msg.automation === 'object') ? msg.automation : {}
  if (a.hasListId === true) return 'list_id'
  if (a.hasListUnsubscribe === true) return 'list_unsubscribe'
  if (a.precedence === 'bulk' || a.precedence === 'list' || a.precedence === 'junk') return 'precedence_bulk'
  return null
}

/**
 * Reason this individual message is non-human (excluded from human counts), or null.
 * @param {import('./emailProviderContract.js').NormalizedMessage} msg
 * @returns {('auto_submitted'|'auto_response_suppress'|'no_reply_sender'|'calendar_notification'|'out_of_office'|'delivery_failure'|null)}
 */
export function nonHumanReason(msg) {
  if (!msg || typeof msg !== 'object') return 'no_reply_sender' // fail closed: treat unusable as non-human
  const a = (msg.automation && typeof msg.automation === 'object') ? msg.automation : {}

  if (typeof a.autoSubmitted === 'string' && a.autoSubmitted !== 'no' && a.autoSubmitted.length > 0) return 'auto_submitted'
  if (a.hasAutoResponseSuppress === true) return 'auto_response_suppress'

  const from = parseSingleAddress(msg.fromAddress)
  if (from) {
    if (CALENDAR_NOTIFICATION_SENDERS.has(from)) return 'calendar_notification'
    const at = from.indexOf('@')
    const local = at > 0 ? from.slice(0, at) : from
    if (NONHUMAN_LOCAL_RE.test(local)) return 'no_reply_sender'
  }

  const subj = normSubject(msg.subject)
  if (subj) {
    if (CALENDAR_SUBJECT_RE.test(subj)) return 'calendar_notification'
    if (DELIVERY_FAILURE_SUBJECT_RE.test(subj)) return 'delivery_failure'
    if (OOO_SUBJECT_RE.test(subj)) return 'out_of_office'
  }
  return null
}

/** True when the message shows strong bulk/list structure (episode hard-reject). */
export function isBulkOrList(msg) {
  return bulkListReason(msg) !== null
}

/** True when the message must be excluded from human-message counts. */
export function isNonHuman(msg) {
  return nonHumanReason(msg) !== null
}
