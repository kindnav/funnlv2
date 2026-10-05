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

// VALIDITY mirrors the DB CHECK interactions_source_check, which admits all four.
// An earlier revision listed only the first two, so isValidInteractionSource said
// 'outlook' was invalid while the database accepted it - and accept_interaction_candidate
// does set interactions.source = 'outlook' for an accepted Outlook suggestion.
export const INTERACTION_SOURCES = ['manual', 'google_calendar', 'gmail', 'outlook']
export const DEFAULT_INTERACTION_SOURCE = 'manual'
export const GOOGLE_CALENDAR_SOURCE = 'google_calendar'

// Presentation registry for sources whose suggestions can actually reach a user's
// review queue. google_calendar and outlook qualify; gmail is deliberately absent,
// because nothing produces a reviewable Gmail suggestion and a label on a surface
// that never renders is worse than no label.
export const SOURCE_PROVIDERS = {
  google_calendar: {
    key: 'google_calendar',
    label: 'Google Calendar',
    ariaLabel: 'Source: Google Calendar',
    title: 'Added from Google Calendar',
  },
  // PRESENTED, because an Outlook suggestion can now actually appear in the review
  // queue. gmail stays absent: nothing produces a reviewable Gmail suggestion, so
  // listing it would put a label on a surface that never renders.
  outlook: {
    key: 'outlook',
    label: 'Outlook',
    ariaLabel: 'Source: Outlook',
    title: 'Suggested from your Outlook mailbox',
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
