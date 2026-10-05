// Is the suggestion REVIEW surface exposed at all?
//
// WHY THIS EXISTS. The Suggestions page, its sidebar entry and its route were all
// gated on CALENDAR_INGESTION_ENABLED, because Calendar was the only thing that could
// produce a suggestion. An Outlook suggestion now can, so a Calendar-named flag would
// decide whether an Outlook suggestion is reachable - and turning Outlook review on
// would have meant turning Calendar review on with it.
//
// So the gate is source-neutral: the review surface appears when AT LEAST ONE source
// that can produce a suggestion is enabled, and each source keeps its own flag.
//
// The queue itself was already source-neutral: it selects pending
// `interaction_candidates` without filtering on source, and accept/dismiss are
// source-aware in the database. This only decides visibility.
//
// BOTH FLAGS ARE OFF EVERYWHERE, so this resolves to false in every environment,
// including Production. Fail-safe: enabled only on the exact string 'true'. Missing,
// empty, 'TRUE', '1', whitespace-padded, null, undefined and any non-string are off.
//
// NON-SECRET build-time flags. They gate UI visibility only, never security and never
// any server behaviour. The worker has its own, separate server-side flags.

import { CALENDAR_INGESTION_ENABLED } from './calendarIngestion.js'

/** Pure predicate, kept exported so it is testable without Vite. */
export function outlookReviewEnabled (rawValue) {
  return rawValue === 'true'
}

/**
 * Outlook suggestion review. Separate from VITE_OUTLOOK_CONNECTION_ENABLED (the
 * Settings connect/disconnect card) on purpose: being able to connect a mailbox and
 * being able to review what it produced are different decisions, and the second one
 * should not be forced by the first.
 */
export const OUTLOOK_REVIEW_ENABLED = outlookReviewEnabled(
  import.meta.env?.VITE_OUTLOOK_REVIEW_ENABLED,
)

/** Pure: the surface is visible when any source that can produce a suggestion is on. */
export function suggestionReviewEnabled ({ calendar, outlook }) {
  return calendar === true || outlook === true
}

export const SUGGESTION_REVIEW_ENABLED = suggestionReviewEnabled({
  calendar: CALENDAR_INGESTION_ENABLED,
  outlook: OUTLOOK_REVIEW_ENABLED,
})
