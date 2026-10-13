// The Outlook cohort gate — server side, and the only thing that actually restricts who
// can connect or be imported. It began as one designated account and now holds a short,
// explicitly invited list; that is the only thing about it that changed.
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
// THE RULE. A comma-separated list of user ids, supplied to the FUNCTION ENVIRONMENT as
// OUTLOOK_PILOT_USER_ID. Not committed, not in the bundle, not a build flag. One id is
// still a valid list of one, and behaves exactly as it did before the list existed.
//
// IT FAILS CLOSED, IN EVERY DIRECTION, and that is the whole point. NOBODY may connect or
// be imported when the value is absent, empty, whitespace, a wildcard (`*`, `all`, `true`),
// longer than MAX_COHORT_USERS, or contains ANY segment that is not a well-formed uuid -
// including an empty segment from a trailing or doubled comma. A partially valid list is
// not partially honoured: `<good-uuid>,nonsense` admits NOBODY, because the alternative is
// to guess which half of a mis-pasted configuration was intended.
//
// DUPLICATES are admitted and deduplicated: the same id twice is the same person twice, not
// an error. The CAP is checked against the RAW segment count before deduplication, so
// eleven entries are refused even if they name only three people - a list that long is a
// mistake whatever it contains.
//
// CASE AND WHITESPACE: each segment is trimmed and lowercased, so a value pasted from a
// dashboard that capitalises uuids still matches the ids the database stores.
//
// NOT A FEATURE-FLAG FRAMEWORK. One variable, one predicate, two call sites: the OAuth
// start endpoint and the import run. Nothing here is generic, registered, or extensible,
// and removing somebody is deleting their id from the list - no table, no admin screen.

/** The function-environment variable that names the invited accounts. */
export const PILOT_USER_ENV = 'OUTLOOK_PILOT_USER_ID'

/** The one value every fail-closed path returns, so a caller cannot mutate the refusal. */
const EMPTY_COHORT = Object.freeze([])

/** Why a caller or a connection is not in the pilot. Controlled; safe to log. */
export const PILOT_REFUSALS = Object.freeze([
  // No OUTLOOK_PILOT_USER_ID, or not a uuid. Fails CLOSED: nobody is in the pilot.
  'pilot_not_configured',
  // A well-formed designation that is not this user.
  'not_in_pilot',
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The most accounts one configuration may name. Also enforced in SQL by
 * `reserve_due_outlook_connection`, deliberately: a ceiling that only exists in the
 * application is a ceiling a direct RPC call can ignore.
 */
export const MAX_COHORT_USERS = 10

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
/**
 * The designated pilot account as a normalized uuid, or null if none is configured.
 *
 * Separate from checkPilotUser because two callers need the VALUE, not a decision:
 * the reservation, which must be told whose connection it may hand out, and the run,
 * which must refuse a malformed designation BEFORE it reserves anything. Returning
 * null for anything that is not a well-formed uuid is what stops an empty string, a
 * 'true' or a '*' from being passed along as if it named somebody.
 *
 * @param {unknown} configured  the raw environment value
 * @returns {string|null}
 */
export function designatedPilotUsers (configured) {
  if (typeof configured !== 'string') return EMPTY_COHORT
  const trimmed = configured.trim()
  if (trimmed.length === 0) return EMPTY_COHORT
  const raw = trimmed.split(',')
  // The cap is on the RAW list, before deduplication: see the header.
  if (raw.length > MAX_COHORT_USERS) return EMPTY_COHORT
  const out = []
  for (const segment of raw) {
    const id = segment.trim().toLowerCase()
    // An empty segment means a trailing or doubled comma. That is a malformed list, not a
    // list with a gap in it, so it fails closed like any other malformed member.
    if (!UUID_RE.test(id)) return EMPTY_COHORT
    if (!out.includes(id)) out.push(id)
  }
  return Object.freeze(out)
}

/**
 * The single designated account, for the one caller that still needs a scalar: the
 * `p_pilot_user_id` compatibility argument of `reserve_due_outlook_connection`. Returns null
 * whenever the cohort is not exactly one account, so it can never stand in for a list.
 */
export function designatedPilotUser (configured) {
  const users = designatedPilotUsers(configured)
  return users.length === 1 ? users[0] : null
}

export function checkPilotUser (configured, userId) {
  // `configured` may be the raw environment value or an already-parsed cohort array, so the
  // worker can check the owner of a reserved connection against the same list it sent to
  // the reservation rather than re-parsing - and re-parsing cannot drift from it.
  const designated = Array.isArray(configured)
    ? configured.filter((id) => typeof id === 'string' && UUID_RE.test(id))
    : designatedPilotUsers(configured)
  if (designated.length === 0) return { ok: false, reason: 'pilot_not_configured' }
  // The CANDIDATE is only required to be a non-empty string that matches. Demanding a
  // uuid of it too would add nothing: it can only equal a uuid-shaped designation by
  // being uuid-shaped itself. The shape check that matters is the one above, on the
  // CONFIGURED value - it is what stops an empty string, a 'true', or a '*' from reading
  // as `everyone`.
  const candidate = typeof userId === 'string' ? userId.trim().toLowerCase() : ''
  if (candidate.length === 0 || !designated.includes(candidate)) {
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
