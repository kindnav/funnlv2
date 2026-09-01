// Interaction source/provenance — pure helpers + constants. No React/Supabase
// imports, so this is safe to unit-test in plain Node.
//
// Mirrors the DB CHECK constraint interactions_source_check. 'manual' is the default
// for every hand-logged interaction; 'google_calendar' is set by
// accept_interaction_candidate for interactions created from accepted Calendar
// candidates. Only this coarse label is ever exposed to the browser — never provider
// event ids, fingerprints, attendees, tokens, or refs.

export const INTERACTION_SOURCES = ['manual', 'google_calendar']
export const DEFAULT_INTERACTION_SOURCE = 'manual'
export const GOOGLE_CALENDAR_SOURCE = 'google_calendar'

/** True only for interactions that originated from an accepted Google Calendar candidate. */
export function isGoogleCalendarSource(source) {
  return source === GOOGLE_CALENDAR_SOURCE
}

/** True when the value is one of the constrained source labels. */
export function isValidInteractionSource(source) {
  return INTERACTION_SOURCES.includes(source)
}
