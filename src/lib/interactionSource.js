// Interaction / suggestion source provenance — pure helpers + a provider-aware
// presentation registry. No React/Supabase imports, so this is safe to unit-test in
// plain Node.
//
// Mirrors the DB CHECK constraint interactions_source_check. 'manual' is the default
// for every hand-logged interaction; 'google_calendar' is set by
// accept_interaction_candidate for interactions created from accepted Calendar
// candidates. Only this coarse label is ever exposed to the browser — never provider
// event ids, fingerprints, attendees, tokens, or refs.
//
// PROVIDER-AWARE BY DESIGN: SOURCE_PROVIDERS is the single place that defines how a
// source is presented. It is intentionally extensible — future functional sources
// (gmail, outlook) add an entry here plus a glyph in InteractionSourceBadge, and every
// surface picks them up automatically. Sources with no working integration are NOT
// listed, so they render no provider badge. 'manual' and any unknown source resolve to
// null (no badge).

export const INTERACTION_SOURCES = ['manual', 'google_calendar']
export const DEFAULT_INTERACTION_SOURCE = 'manual'
export const GOOGLE_CALENDAR_SOURCE = 'google_calendar'

// Presentation registry for sources that have a live integration today. Only
// google_calendar is functional; gmail/outlook are deliberately absent (no
// nonfunctional tabs or "coming soon" UI is exposed anywhere).
export const SOURCE_PROVIDERS = {
  google_calendar: {
    key: 'google_calendar',
    label: 'Google Calendar',
    ariaLabel: 'Source: Google Calendar',
    title: 'Added from Google Calendar',
  },
}

/** The provider presentation for a source, or null for manual/unknown (no badge). */
export function getSourceProvider(source) {
  return Object.prototype.hasOwnProperty.call(SOURCE_PROVIDERS, source)
    ? SOURCE_PROVIDERS[source]
    : null
}

/** True only for interactions/suggestions that originated from Google Calendar. */
export function isGoogleCalendarSource(source) {
  return source === GOOGLE_CALENDAR_SOURCE
}

/** True when the value is one of the constrained interaction source labels. */
export function isValidInteractionSource(source) {
  return INTERACTION_SOURCES.includes(source)
}
