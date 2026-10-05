// The single-account Outlook pilot gate — server side, and the only thing that actually
// restricts who can connect or be imported.
//
// WHY THIS EXISTS. Before it, every server gate on the Outlook path was all-or-nothing:
// `OUTLOOK_INTEGRATION_ENABLED` either opened the OAuth start endpoint to EVERY
// authenticated Funnl user or to none, and `reserve_due_outlook_connection` picks whichever
// active consented connection is due, for ANY user. So a first real pilot had no way to be
// limited to one designated person.
//
// WHAT IS NOT A RESTRICTION, and was never one:
//   * `VITE_OUTLOOK_CONNECTION_ENABLED` and `SUGGESTION_REVIEW_ENABLED` are client-side
//     build flags. They decide what the bundle renders. A flag in a browser cannot stop a
//     request, so they are UI tidiness, not access control.
//   * Invoking the worker by hand restricts nothing either: the reservation chooses the
//     connection, not the caller, so a manual call imports whichever account is due.
//
// THE RULE. One designated user id, supplied to the FUNCTION ENVIRONMENT as
// OUTLOOK_PILOT_USER_ID. Not committed, not in the bundle, not a build flag.
//
// IT FAILS CLOSED, and that is the whole point: if the integration is enabled while no
// pilot user is designated - or the value is not a well-formed uuid - NOBODY may connect or
// be imported. Enabling Outlook therefore requires deliberately naming the one account,
// rather than enabling it for everyone by forgetting a second variable.
//
// NOT A FEATURE-FLAG FRAMEWORK. One variable, one predicate, two call sites: the OAuth
// start endpoint and the import run. Nothing here is generic, registered, or extensible.

/** The function-environment variable that designates the pilot account. */
export const PILOT_USER_ENV = 'OUTLOOK_PILOT_USER_ID'

/** Why a caller or a connection is not in the pilot. Controlled; safe to log. */
export const PILOT_REFUSALS = Object.freeze([
  // No OUTLOOK_PILOT_USER_ID, or not a uuid. Fails CLOSED: nobody is in the pilot.
  'pilot_not_configured',
  // A well-formed designation that is not this user.
  'not_in_pilot',
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Is `userId` the designated pilot account?
 *
 * Case-insensitive on the hex, because Postgres renders uuids lower-case while a value
 * pasted from a dashboard may not be; everything else must match exactly. No trimming of
 * the user id itself - that comes from a verified JWT or from the database, so a
 * whitespace difference would mean something is wrong rather than something to tolerate.
 *
 * @param {unknown} configured  the raw environment value
 * @param {unknown} userId      the authenticated caller, or a connection's owner
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function checkPilotUser (configured, userId) {
  const designated = typeof configured === 'string' ? configured.trim().toLowerCase() : ''
  if (!UUID_RE.test(designated)) return { ok: false, reason: 'pilot_not_configured' }
  // The CANDIDATE is only required to be a non-empty string that matches. Demanding a
  // uuid of it too would add nothing: it can only equal a uuid-shaped designation by
  // being uuid-shaped itself. The shape check that matters is the one above, on the
  // CONFIGURED value - it is what stops an empty string, a 'true', or a '*' from reading
  // as `everyone`.
  const candidate = typeof userId === 'string' ? userId.trim().toLowerCase() : ''
  if (candidate.length === 0 || candidate !== designated) {
    return { ok: false, reason: 'not_in_pilot' }
  }
  return { ok: true }
}

/**
 * The only shape of a pilot decision that may be logged.
 *
 * Never the designated id and never the caller's id: both identify a person, and a refusal
 * log that named them would turn an access-control event into a record of who tried.
 */
export function summarizePilotDecision (decision) {
  return {
    in_pilot: decision?.ok === true,
    reason: PILOT_REFUSALS.includes(decision?.reason) ? decision.reason : null,
  }
}
