// Mailbox address resolution via delegated Graph GET /v1.0/me.
//
// This is the ONLY reason User.Read is requested. It exists because
// microsoft_connections.ms_email is NOT NULL and id_token claims are not a
// sufficient source: Microsoft guarantees neither that `email` is present nor
// that `preferred_username` is mail-shaped, and a work/school UPN is frequently
// not a routable mailbox.
//
// SECURITY SHAPE
//   * $select is narrowed to the three fields actually used. That does NOT
//     reduce the authority User.Read grants - the permission still permits the
//     full profile and basic company information - it only reduces what is
//     returned. The disclosure describes both.
//   * The Graph `id` is cross-checked against the VALIDATED id_token `oid`.
//     A mismatch fails closed rather than trusting the Graph body. Exact
//     (case-insensitive) equality holds for every account type; personal
//     accounts additionally accept the measured zero-padded-GUID short form,
//     and nothing else. See classifyGraphIdentityMatch.
//   * The access token is passed as a bearer credential and never decoded.
//     Redirects are refused: Fetch already strips Authorization cross-origin,
//     but refusing outright also rules out an unexpected destination whose
//     response would otherwise be parsed as this user's profile.
//   * No provider response body is ever logged. The mismatch diagnostic below
//     is deliberately made of SHAPES, LENGTHS and BOOLEANS only - it can never
//     carry an id, an address, a token or any part of one.

import { displayAddressFromClaims } from './microsoftOauthHelpers.js'
import { readJsonBounded, MAX_PROVIDER_BODY_BYTES } from './boundedJson.js'

export const GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me'
export const GRAPH_ME_SELECT = 'id,mail,userPrincipalName'
export const GRAPH_TIMEOUT_MS = 10_000
export const MAX_GRAPH_RESPONSE_BYTES = MAX_PROVIDER_BODY_BYTES

function mailShaped (v) {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (s.length < 3 || s.length > 320) return null
  return /^[^\s@]+@[^\s@]+$/.test(s) ? s : null
}

/**
 * Choose the mailbox address from a Graph /me body.
 * Prefers `mail`; falls back to `userPrincipalName` ONLY when mail-shaped.
 * Returns null when neither is usable - the caller must then fail, not invent.
 */
export function pickMailboxAddress (body) {
  if (!body || typeof body !== 'object') return null
  return mailShaped(body.mail) ?? mailShaped(body.userPrincipalName) ?? null
}

// ── Identifier SHAPE vocabulary, for the mismatch diagnostic only ───────────
// None of this participates in the identity decision. It exists so a refusal
// can be investigated from the Edge log without the log carrying an identifier.

const GUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX16_SHAPE = /^[0-9a-f]{16}$/
const HEX32_SHAPE = /^[0-9a-f]{32}$/
const ZERO16 = '0000000000000000'

/** The controlled shape vocabulary. 'other' covers every unrecognised form. */
export const IDENTIFIER_SHAPES = Object.freeze(
  ['absent', 'guid', 'hex16', 'hex32', 'other'])

/** Classify an identifier's FORM. Never returns any part of the value. */
export function identifierShape (raw) {
  if (typeof raw !== 'string') return 'absent'
  const s = raw.trim().toLowerCase()
  if (s.length === 0) return 'absent'
  if (GUID_SHAPE.test(s)) return 'guid'
  if (HEX16_SHAPE.test(s)) return 'hex16'
  if (HEX32_SHAPE.test(s)) return 'hex32'
  return 'other'
}

/**
 * Is `guidForm` a GUID whose leading 16 hex digits are all zero and whose
 * trailing 16 are exactly `shortForm` (a 16-hex value)?
 *
 * A REPORTING predicate only - nothing calls it to accept an identity. A
 * trailing-digit match WITHOUT the all-zero leading half is deliberately false,
 * so an arbitrary suffix coincidence is never reported as this relationship.
 */
export function isZeroPaddedGuidOf (guidForm, shortForm) {
  const g = typeof guidForm === 'string' ? guidForm.trim().toLowerCase() : ''
  const s = typeof shortForm === 'string' ? shortForm.trim().toLowerCase() : ''
  if (!GUID_SHAPE.test(g) || !HEX16_SHAPE.test(s)) return false
  const flat = g.replace(/-/g, '')
  return flat.slice(0, 16) === ZERO16 && flat.slice(16) === s
}

/**
 * A privacy-safe description of WHY two identifiers did not match: shapes,
 * lengths and booleans, with no identifier, substring, address or token in it.
 *
 * `accountType` comes from the VALIDATED id_token `tid` ('personal' for the
 * well-known consumers tenant, 'work' otherwise); anything else is 'unknown'.
 */
export function describeIdentityMismatch (graphId, oid, accountType) {
  const g = typeof graphId === 'string' ? graphId.trim().toLowerCase() : ''
  const o = typeof oid === 'string' ? oid.trim().toLowerCase() : ''
  return {
    // Which account type the VALIDATED tenant said this was.
    account: accountType === 'personal' || accountType === 'work'
      ? accountType : 'unknown',
    graph_id_shape: identifierShape(graphId),
    oid_shape: identifierShape(oid),
    graph_id_len: g.length,
    oid_len: o.length,
    // Always false when this is called from a mismatch, and asserted as such.
    equal_case_insensitive: g.length > 0 && g === o,
    // The two directions of the zero-padded-GUID relationship. Reported so the
    // live representation can be established from a refusal, WITHOUT granting
    // the equivalence. Both stay false for an unrelated pair.
    graph_id_is_short_form_of_oid: isZeroPaddedGuidOf(o, g),
    oid_is_short_form_of_graph_id: isZeroPaddedGuidOf(g, o),
  }
}

// ── The identity rule ───────────────────────────────────────────────────────
//
// TWO rules, and no others. Both are reported so a connection's Edge log says
// which one allowed it. Each is a controlled enum value, never an identifier.
export const IDENTITY_MATCH_EXACT = 'exact'
export const IDENTITY_MATCH_PERSONAL_SHORT_FORM = 'personal_zero_padded_short_form'
export const IDENTITY_MATCHES = Object.freeze(
  [IDENTITY_MATCH_EXACT, IDENTITY_MATCH_PERSONAL_SHORT_FORM])

/**
 * How - if at all - the Graph `id` identifies the same account as the VALIDATED
 * id_token `oid`. Returns one of IDENTITY_MATCHES, or null for no match.
 *
 * RULE 1, every account type: case-insensitive exact equality.
 *
 * RULE 2, PERSONAL ACCOUNTS ONLY: the `oid` is a GUID whose leading 16 hex
 * digits are all zero and whose trailing 16 are exactly the Graph `id`. This is
 * the representation a single controlled pilot attempt MEASURED in Production:
 *
 *     account=personal  oid_shape=guid   oid_len=36
 *                       graph_id_shape=hex16  graph_id_len=16
 *                       graph_id_is_short_form_of_oid=true
 *
 * No identifier was logged to establish that - only the shape and relationship
 * booleans this module already emitted. It is consistent with the publicly
 * described zero-padding of a personal-account `oid` into GUID form, and with
 * the beta `userAccountInformation` statement that the entity identifier "is
 * set to the corresponding ... Microsoft Account CID".
 *
 * WHAT RULE 2 DELIBERATELY DOES NOT ACCEPT:
 *   * the REVERSE direction - a GUID from Graph against a 16-hex `oid`. Only
 *     isZeroPaddedGuidOf(oid, graphId) is consulted, never the mirror.
 *   * a flat 32-hex form, in either position: isZeroPaddedGuidOf requires the
 *     8-4-4-4-12 GUID form on the left and exactly 16 hex on the right.
 *   * a mere SUFFIX match. The leading 16 hex digits must ALL be zero, so a
 *     GUID that merely ends in those digits is refused.
 *   * an EMAIL match. Addresses are not consulted here at all.
 *   * WORK/SCHOOL or UNKNOWN accounts. `accountType` must be the exact string
 *     'personal', which only classifyAccountType produces, and only when the
 *     VALIDATED id_token's `tid` is the well-known consumers tenant. Any other
 *     value - 'work', 'unknown', absent, differently cased, padded - leaves
 *     rule 1 as the only rule.
 *
 * Rule 2 is injective: for one `oid` with an all-zero leading half there is
 * exactly one 16-hex value it accepts, so it cannot collapse two accounts
 * together.
 */
export function classifyGraphIdentityMatch (graphId, oid, accountType) {
  const g = typeof graphId === 'string' ? graphId.trim().toLowerCase() : ''
  const o = typeof oid === 'string' ? oid.trim().toLowerCase() : ''
  if (!g || !o) return null
  if (g === o) return IDENTITY_MATCH_EXACT
  // Strict equality on the literal, not a truthy or case-folded test.
  if (accountType === 'personal' && isZeroPaddedGuidOf(o, g)) {
    return IDENTITY_MATCH_PERSONAL_SHORT_FORM
  }
  return null
}

/**
 * Cross-check and resolve. `oid` is the VALIDATED id_token object id;
 * `accountType` is the classification derived from its `tid`.
 *
 * Returns { ok: true, email, identityMatch } or
 *         { ok: false, reason, diagnostic? }.
 *
 * THE GRAPH ID IS NEVER RETURNED, so it cannot become the connection's account
 * identity. The caller writes ms_account_id from the validated `oid` it already
 * holds; all this function yields on success is the mailbox address and which
 * rule matched. Under rule 2 the stored identity is therefore the GUID-form
 * `oid`, not the 16-hex Graph short form.
 *
 * Email is NEVER identity. `mail`/`userPrincipalName` are read only AFTER the
 * identifier check passes, and only to fill ms_email.
 */
export function resolveMailboxFromGraphBody (body, oid, accountType) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'graph_me_malformed' }
  const gid = typeof body.id === 'string' ? body.id.trim() : ''
  if (!gid) return { ok: false, reason: 'graph_me_no_id' }
  if (typeof oid !== 'string' || oid.trim().length === 0) {
    return { ok: false, reason: 'no_validated_oid' }
  }
  // Fail closed: the account Graph describes must be the account the validated
  // id_token described, under one of the two rules above. Otherwise we would
  // record someone else's mailbox.
  const identityMatch = classifyGraphIdentityMatch(gid, oid, accountType)
  if (!identityMatch) {
    return {
      ok: false,
      reason: 'graph_identity_mismatch',
      diagnostic: describeIdentityMismatch(gid, oid, accountType),
    }
  }
  const email = pickMailboxAddress(body)
  if (!email) return { ok: false, reason: 'no_usable_mailbox_address' }
  return { ok: true, email, identityMatch }
}

/**
 * Fetch and resolve. `fetchImpl` and `meUrl` are injected for tests and for the
 * loopback-only local harness; production callers pass neither.
 */
export async function fetchMailboxAddress ({
  accessToken, oid, accountType, fetchImpl = globalThis.fetch, meUrl = GRAPH_ME_URL,
  timeoutMs = GRAPH_TIMEOUT_MS, maxBytes = MAX_GRAPH_RESPONSE_BYTES,
}) {
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return { ok: false, reason: 'no_access_token' }
  }
  const url = `${meUrl}?$select=${encodeURIComponent(GRAPH_ME_SELECT)}`
  // ONE deadline covering the request AND the body read. fetch resolves on
  // HEADERS, so clearing the timer there would leave a stalled body unbounded.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let res
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: ctrl.signal,
        // Fetch already strips Authorization on a CROSS-ORIGIN redirect, so the
        // bearer token would not itself be replayed to another origin. Refusing
        // all redirects is still the right policy: it prevents a same-origin
        // redirect carrying the header somewhere unintended, and it stops an
        // unexpected destination returning a body this code would then parse as
        // the signed-in user's profile.
        redirect: 'error',
      })
    } catch {
      return { ok: false, reason: 'graph_me_unreachable' }
    }
    if (!res || typeof res.status !== 'number') return { ok: false, reason: 'graph_me_malformed' }
    if (res.status === 401 || res.status === 403) {
      // Most likely User.Read was not actually granted.
      return { ok: false, reason: 'graph_me_forbidden' }
    }
    if (res.status !== 200) return { ok: false, reason: 'graph_me_http_error' }
    const read = await readJsonBounded(res, maxBytes)
    if (!read.ok) {
      return { ok: false, reason: read.reason === 'response_malformed'
        ? 'graph_me_malformed' : read.reason }
    }
    return resolveMailboxFromGraphBody(read.value, oid, accountType)
  } finally {
    clearTimeout(timer)
  }
}

/** Belt and braces: the id_token hint must not override the Graph answer. */
export function hintDisagreesWithResolved (claims, resolvedEmail) {
  const hint = displayAddressFromClaims(claims)
  if (!hint || typeof resolvedEmail !== 'string') return false
  return hint !== resolvedEmail.trim().toLowerCase()
}
