// Analytics for the suggestion review queue, made SOURCE-CORRECT.
//
// THE DEFECT THIS REPLACES. The queue has always been source-neutral - it selects
// pending candidates without filtering on source - but it fired
// `calendar_candidate_accepted`, `calendar_candidate_dismissed` and
// `calendar_review_viewed` for every row. Accepting an Outlook suggestion therefore
// emitted a Calendar event, which is simply a false record of what happened.
//
// THE FIX. Source-neutral event names plus a controlled `source` property, so one
// funnel covers the queue and the source is a dimension rather than part of the name.
//
// WHY RENAMING IS SAFE HERE. The whole review surface is gated, and the gate has never
// been enabled in any environment (`VITE_CALENDAR_INGESTION_ENABLED` and
// `VITE_OUTLOOK_REVIEW_ENABLED` are both unset), so no event has ever been emitted and
// no PostHog insight can be built on the old names. That is stated rather than assumed
// silently: it was NOT verified against the Vercel project's environment variables,
// which is not reachable from here. If the Calendar flag turns out to have been on at
// some point, the old names would need keeping alongside these.
//
// WHAT IS NEVER SENT. No contact, no candidate id, no address, no subject, no note, no
// fingerprint, no date. Only the event name, a controlled source label, and for an
// acceptance a single boolean saying whether the user changed anything. That matches
// the project's standing rule: track behaviour, never content.

/** The sources a suggestion can come from, as an analytics dimension. */
export const SUGGESTION_SOURCES = Object.freeze(['google_calendar', 'gmail', 'outlook'])

/** Source-neutral names. The source travels as a property, not in the name. */
export const SUGGESTION_EVENTS = Object.freeze({
  viewed: 'suggestion_review_viewed',
  accepted: 'suggestion_accepted',
  dismissed: 'suggestion_dismissed',
})

/**
 * A controlled source label. Anything unrecognised becomes 'unknown' rather than being
 * passed through, so a new or malformed source value can never introduce a new
 * dimension value by accident.
 * @param {unknown} source
 */
export function suggestionSourceLabel (source) {
  return SUGGESTION_SOURCES.includes(source) ? source : 'unknown'
}

/**
 * Properties for a review event. Deliberately tiny.
 * @param {unknown} source
 * @param {{edited?: boolean}} [extra]
 */
export function suggestionEventProps (source, extra = {}) {
  const props = { source: suggestionSourceLabel(source) }
  if (typeof extra.edited === 'boolean') props.edited = extra.edited
  return props
}
