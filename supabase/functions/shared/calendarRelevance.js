// Deterministic relevance filtering for Calendar ingestion (Phase A).
//
// Pure, cross-runtime (Node + Deno). Composes calendarEmailMatch + calendarTime.
// No AI, no title inference, no fuzzy matching, no contact creation, no I/O.
//
// Given one Google event, the connected account identity, and the user's
// contacts, decide whether the event should become one or more interaction
// candidates and with what proposed type/date. Every exclusion returns an
// explicit reason so the sync engine and tests can assert the truth table.

import { matchEventContacts } from './calendarEmailMatch.js';
import { parseEventTiming, originalOccurrence, deriveInteractionDate, isCompleted } from './calendarTime.js';

/** Proposed interaction type for a single matched contact. */
export const TYPE_ONE_CONTACT = 'Coffee chat';
/** Proposed interaction type when several distinct contacts attended. */
export const TYPE_GROUP = 'Event';

/**
 * Collect the organizer + attendee email addresses from an event, as raw
 * (un-normalized) strings. Downstream normalization/exclusion handles the rest.
 * @param {object} event
 * @returns {string[]}
 */
function collectEventEmails(event) {
  const emails = [];
  if (event?.organizer && typeof event.organizer.email === 'string') {
    emails.push(event.organizer.email);
  }
  if (event?.creator && typeof event.creator.email === 'string') {
    emails.push(event.creator.email);
  }
  const attendees = Array.isArray(event?.attendees) ? event.attendees : [];
  for (const a of attendees) {
    if (a && typeof a.email === 'string') emails.push(a.email);
  }
  return emails;
}

/** True when the connected user themselves declined the event. */
function userDeclined(event) {
  const attendees = Array.isArray(event?.attendees) ? event.attendees : [];
  return attendees.some((a) => a && a.self === true && a.responseStatus === 'declined');
}

/**
 * Evaluate one event into zero or more candidates.
 *
 * @param {{
 *   event: object,
 *   connectedEmail: string,
 *   contacts: Array<{id: string, email?: string|null}>,
 *   now: Date,
 *   fallbackTimeZone?: string,
 * }} args
 * @returns {{
 *   relevant: boolean,
 *   reason: string|null,
 *   ambiguousCount: number,
 *   candidates: Array<{
 *     contactId: string,
 *     proposedType: string,
 *     proposedInteractionDate: string,
 *     occurrence: {kind: 'datetime'|'date', value: string},
 *     timing: object,
 *   }>,
 * }}
 */
export function evaluateEvent({ event, connectedEmail, contacts, now, fallbackTimeZone = 'UTC' }) {
  const none = (reason, ambiguousCount = 0) => ({
    relevant: false,
    reason,
    ambiguousCount,
    candidates: [],
  });

  if (!event || typeof event !== 'object') return none('invalid_event');

  // Cancelled events (whole event or a cancelled instance) never produce a
  // positive candidate. (Cancellation handling / tombstoning is the sync
  // engine's job in a later phase; here we simply do not treat it as relevant.)
  if (event.status === 'cancelled') return none('cancelled');

  if (userDeclined(event)) return none('declined');

  const timing = parseEventTiming(event);
  if (!timing.ok) return none('invalid_timing');

  // Only already-completed events become candidates (we log past interactions,
  // not future plans). Fail closed on invalid `now`.
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return none('invalid_now');
  if (!isCompleted(timing, now, fallbackTimeZone)) return none('not_completed');

  const occ = originalOccurrence(event);
  if (!occ.ok) return none('invalid_occurrence');

  const { matchedContactIds, ambiguousCount } = matchEventContacts(
    collectEventEmails(event),
    contacts,
    connectedEmail,
  );

  if (matchedContactIds.length === 0) return none('no_matched_contact', ambiguousCount);

  const proposedType = matchedContactIds.length === 1 ? TYPE_ONE_CONTACT : TYPE_GROUP;
  const proposedInteractionDate = deriveInteractionDate(timing, fallbackTimeZone);

  const candidates = matchedContactIds.map((contactId) => ({
    contactId,
    proposedType,
    proposedInteractionDate,
    occurrence: occ.occurrence,
    timing,
  }));

  return { relevant: true, reason: null, ambiguousCount, candidates };
}
