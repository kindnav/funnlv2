// Pure, testable helpers for the Calendar candidate review queue (Phase B).
// No React, no Supabase — safe to unit-test in the plain-Node runner.

export { CALENDAR_INGESTION_ENABLED, calendarIngestionEnabled } from './calendarIngestion.js'

// The six existing Funnl interaction types (the only valid accept/override types).
export const INTERACTION_TYPES = ['Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other']

// Bounded page size for the review queue — never fetch an unlimited queue.
export const REVIEW_PAGE_SIZE = 20

// Notes cap for an accepted interaction. Matches the candidate schema bound
// (interaction_candidates_notes_len: char_length <= 200) and the accept RPC, so the
// input, the candidate row, and the created interaction all agree. Compared with
// String.length (UTF-16 code units) on the client, which is always >= the DB's
// char_length (code points) — so the client never lets through a value the DB rejects.
export const REVIEW_NOTES_MAX = 200

// ONLY the RLS-safe candidate columns are ever selected; the contact join is limited to
// display fields. Provider ids, fingerprints, user_id, interaction_id, refs, and raw
// event data are NEVER selected (and are not granted to authenticated anyway).
export const CANDIDATE_SELECT =
  'id, source, proposed_type, proposed_interaction_date, proposed_notes, created_at, contacts(name, company, role)'

/**
 * Client-side validation of reviewed overrides before calling accept. Mirrors the
 * server RPC's checks so the user gets an immediate, controlled message.
 * @param {{ type?: string, date?: string, notes?: string|null }} o
 * @returns {{ ok: true } | { ok: false, code: 'invalid_type'|'invalid_date'|'invalid_notes' }}
 */
export function validateOverrides(o = {}) {
  if (o.type !== undefined && !INTERACTION_TYPES.includes(o.type)) return { ok: false, code: 'invalid_type' }
  if (o.date !== undefined) {
    if (typeof o.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) return { ok: false, code: 'invalid_date' }
  }
  if (o.notes != null && typeof o.notes === 'string' && o.notes.length > REVIEW_NOTES_MAX) {
    return { ok: false, code: 'invalid_notes' }
  }
  return { ok: true }
}

// ── Result-code → user-facing outcome mapping ────────────────────────────────
// Each entry: { message, tone, removeFromQueue }. tone drives styling only. These are
// the ONLY strings shown for an RPC outcome — raw errors are never surfaced.

const ACCEPT_RESULTS = {
  accepted:                       { message: 'Interaction added.',                              tone: 'success', removeFromQueue: true },
  already_accepted:               { message: 'This was already accepted.',                       tone: 'info',    removeFromQueue: true },
  interaction_previously_deleted: { message: 'That interaction was deleted earlier and will not be recreated.', tone: 'info', removeFromQueue: true },
  dismissed:                      { message: 'This suggestion was already dismissed.',           tone: 'info',    removeFromQueue: true },
  invalidated:                    { message: 'This suggestion is no longer available.',          tone: 'info',    removeFromQueue: true },
  not_found:                      { message: 'This suggestion is no longer available.',          tone: 'info',    removeFromQueue: true },
  invalid_type:                   { message: 'Pick a valid interaction type.',                   tone: 'error',   removeFromQueue: false },
  invalid_date:                   { message: 'Pick a valid date.',                               tone: 'error',   removeFromQueue: false },
  invalid_notes:                  { message: 'Note is too long (200 characters max).',           tone: 'error',   removeFromQueue: false },
  conflict:                       { message: 'That changed while you were reviewing. Try again.', tone: 'error',   removeFromQueue: false },
  unauthenticated:                { message: 'Please sign in again.',                            tone: 'error',   removeFromQueue: false },
}

const DISMISS_RESULTS = {
  dismissed:         { message: 'Suggestion dismissed.',                    tone: 'info',  removeFromQueue: true },
  already_dismissed: { message: 'Already dismissed.',                       tone: 'info',  removeFromQueue: true },
  already_accepted:  { message: 'This was already accepted.',               tone: 'info',  removeFromQueue: true },
  invalidated:       { message: 'This suggestion is no longer available.',  tone: 'info',  removeFromQueue: true },
  not_found:         { message: 'This suggestion is no longer available.',  tone: 'info',  removeFromQueue: true },
  unauthenticated:   { message: 'Please sign in again.',                    tone: 'error', removeFromQueue: false },
}

const UNKNOWN = { message: 'Something went wrong. Please try again.', tone: 'error', removeFromQueue: false }

export function acceptResultOutcome(code) { return ACCEPT_RESULTS[code] || UNKNOWN }
export function dismissResultOutcome(code) { return DISMISS_RESULTS[code] || UNKNOWN }

/** Extract the controlled result code from an RPC's jsonb data (or 'unknown'). */
export function resultCode(data) {
  return (data && typeof data === 'object' && typeof data.result === 'string') ? data.result : 'unknown'
}

// ── Keyset pagination ────────────────────────────────────────────────────────
// The queue is ordered (proposed_interaction_date DESC, id DESC) — a deterministic
// total order even when several candidates share a date. Pagination is KEYSET, not
// offset: each "next page" continues strictly after the last row already fetched.
// This is immune to the shrinking-result-set skip that offset pagination suffers
// when accepted/dismissed rows leave the pending set between page loads.

/**
 * The PostgREST `.or()` predicate that selects the rows strictly after `cursor`
 * in (date DESC, id DESC) order. Returns null for the first page (no cursor).
 * The cursor comes only from server rows (a date string + a uuid), so it cannot
 * contain characters that would alter the filter grammar.
 */
export function keysetFilter(cursor) {
  if (!cursor || typeof cursor.date !== 'string' || typeof cursor.id !== 'string') return null
  return `proposed_interaction_date.lt.${cursor.date},and(proposed_interaction_date.eq.${cursor.date},id.lt.${cursor.id})`
}

/**
 * The boundary cursor derived from the LAST row of a fetched page. This is tracked
 * independently of the rendered list, so removing resolved rows from the UI never
 * moves the pagination boundary (no skips, no re-fetches). Null for an empty page.
 */
export function cursorFrom(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  const last = rows[rows.length - 1]
  if (!last || typeof last.proposed_interaction_date !== 'string' || typeof last.id !== 'string') return null
  return { date: last.proposed_interaction_date, id: last.id }
}

/** Append `incoming` to `prev`, skipping any id already present (defensive against overlap). */
export function dedupeById(prev, incoming) {
  const base = Array.isArray(prev) ? prev : []
  const seen = new Set(base.map((r) => r.id))
  const merged = base.slice()
  for (const r of (Array.isArray(incoming) ? incoming : [])) {
    if (r && !seen.has(r.id)) { seen.add(r.id); merged.push(r) }
  }
  return merged
}

/** A full page implies there may be more; a short/empty page is the end of the list. */
export function computeHasMore(rowCount) {
  return rowCount === REVIEW_PAGE_SIZE
}
