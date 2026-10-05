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
//     A mismatch fails closed rather than trusting the Graph body. The
//     comparison is EXACT (case-insensitive) for BOTH account types. See the
//     EVIDENCE block above resolveMailboxFromGraphBody for why no
//     personal-account equivalence is granted.
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
//
// None of this participates in the identity decision. It exists so that a
// refusal can be investigated from the Edge log WITHOUT the log ever carrying
// an identifier. Every value below is a category, a length or a boolean.

const GUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX16_SHAPE = /^[0-9a-f]{16}$/
const HEX32_SHAPE = /^[0-9a-f]{32}$/
const ZERO16 = '0000000000000000'

/** The controlled shape vocabulary. 'other' covers every unrecognised form. */
export const IDENTIFIER_SHAPES = Object.freeze(
  ['absent', 'guid', 'hex16', 'hex32', 'other'])

/**
 * Classify an identifier's FORM. Returns one of IDENTIFIER_SHAPES and never any
 * part of the value itself.
 */
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
 * trailing 16 hex digits are exactly `shortForm` (a 16-hex value)?
 *
 * This is the ONE relationship under investigation, and it is a REPORTING
 * predicate only - nothing calls it to accept an identity. A match on the
 * trailing digits WITHOUT the all-zero leading half is deliberately false, so
 * an arbitrary suffix coincidence is never reported as this relationship.
 */
export function isZeroPaddedGuidOf (guidForm, shortForm) {
  const g = typeof guidForm === 'string' ? guidForm.trim().toLowerCase() : ''
  const s = typeof shortForm === 'string' ? shortForm.trim().toLowerCase() : ''
  if (!GUID_SHAPE.test(g) || !HEX16_SHAPE.test(s)) return false
  const flat = g.replace(/-/g, '')
  return flat.slice(0, 16) === ZERO16 && flat.slice(16) === s
}

/**
 * A privacy-safe description of WHY two identifiers did not match.
 *
 * Returns shapes, lengths and booleans. It contains no identifier, no substring
 * of one, no address and no token, so it is safe to log verbatim.
 *
 * `accountType` is the classification already derived from the VALIDATED
 * id_token `tid` ('personal' for the well-known consumers tenant, 'work'
 * otherwise). Anything else is reported as 'unknown'.
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

/**
 * Cross-check and resolve. `oid` is the VALIDATED id_token object id.
 * `accountType` is optional and is used ONLY to label the diagnostic.
 * Returns { ok, email } or { ok: false, reason, diagnostic? }.
 *
 * EVIDENCE FOR THE COMPARISON BEING EXACT FOR BOTH ACCOUNT TYPES
 * --------------------------------------------------------------
 * A live personal-account consent refused here with graph_identity_mismatch,
 * which raised the question of whether a personal account's Graph `id` and its
 * id_token `oid` are two representations of one value (a 16-hex Microsoft
 * Account CID, and that CID zero-padded into GUID form). Primary documentation
 * does NOT support treating them as equivalent:
 *
 *   * ID token claims reference - `oid` is "String, a GUID", "The immutable
 *     identifier for an object"; and "Microsoft Graph returns this ID as the
 *     `id` property for a user account". That documents EQUALITY, and states no
 *     personal-account divergence anywhere.
 *   * `user` resource reference - `id` is "The unique identifier for the user.
 *     Should be treated as an opaque identifier." No format is given, and no
 *     personal-account carve-out exists.
 *   * "Working with users in Microsoft Graph" - nothing on personal-account id
 *     format at all.
 *   * The only primary-doc mention of a "Microsoft Account CID" is on the BETA
 *     `userAccountInformation` resource - a profile facet, a DIFFERENT entity
 *     from `user` - and even there no format is stated: no hex length, no
 *     padding, no stated relationship to a GUID.
 *
 * So the equivalence is UNDOCUMENTED. Accepting it would mean accepting a
 * 16-hex value as proof of ownership of a GUID-identified account on the
 * strength of an assumption, which is exactly the substitution this check
 * exists to prevent. The rule therefore stays EXACT equality for both account
 * types, UNKNOWN SHAPES STAY REJECTED, and the relationship is merely RECORDED
 * in the diagnostic above so the live representation can be established from a
 * refusal rather than guessed at. If a logged refusal shows
 * graph_id_is_short_form_of_oid true on the consumers tenant, that is the
 * evidence that would justify revisiting this - as a separate, deliberate
 * change, gated on account === 'personal'.
 *
 * Email is NEVER identity here. `mail`/`userPrincipalName` are read only AFTER
 * the identifier check passes, and only to fill ms_email.
 */
export function resolveMailboxFromGraphBody (body, oid, accountType) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'graph_me_malformed' }
  const gid = typeof body.id === 'string' ? body.id.trim() : ''
  if (!gid) return { ok: false, reason: 'graph_me_no_id' }
  if (typeof oid !== 'string' || oid.trim().length === 0) {
    return { ok: false, reason: 'no_validated_oid' }
  }
  // Fail closed: the account Graph describes must be the account the validated
  // id_token described. Otherwise we would record someone else's mailbox.
  if (gid.toLowerCase() !== oid.trim().toLowerCase()) {
    return {
      ok: false,
      reason: 'graph_identity_mismatch',
      diagnostic: describeIdentityMismatch(gid, oid, accountType),
    }
  }
  const email = pickMailboxAddress(body)
  if (!email) return { ok: false, reason: 'no_usable_mailbox_address' }
  return { ok: true, email }
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
