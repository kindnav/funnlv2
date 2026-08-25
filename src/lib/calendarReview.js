// Pure, testable helpers for the Calendar candidate review queue (Phase B).
// No React, no Supabase — safe to unit-test in the plain-Node runner.

export { CALENDAR_INGESTION_ENABLED, calendarIngestionEnabled } from './calendarIngestion.js'

// The six existing Funnl interaction types (the only valid accept/override types).
export const INTERACTION_TYPES = ['Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other']

// Bounded page size for the review queue — never fetch an unlimited queue.
export const REVIEW_PAGE_SIZE = 20

// Notes cap for an accepted interaction (mirrors the RPC's server-side bound).
export const REVIEW_NOTES_MAX = 2000

// ONLY the RLS-safe candidate columns are ever selected; the contact join is limited to
// display fields. Provider ids, fingerprints, user_id, interaction_id, refs, and raw
// event data are NEVER selected (and are not granted to authenticated anyway).
export const CANDIDATE_SELECT =
  'id, proposed_type, proposed_interaction_date, proposed_notes, created_at, contacts(name, company, role)'

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
  invalid_notes:                  { message: 'Note is too long.',                                tone: 'error',   removeFromQueue: false },
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
