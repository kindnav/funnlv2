// Browser binding for the Microsoft (Outlook) OAuth flow.
//
// WHY THIS IS A SEPARATE MODULE, NOT A REUSE OF oauthBrowserBinding.js
// --------------------------------------------------------------------
// The Google module hardcodes BINDING_COOKIE_NAME = '__Host-fnl_oauth_bind' and
// exposes no way to vary it. Outlook needs its OWN cookie so that a Google flow
// in flight can never satisfy an Outlook callback (or the reverse): two flows can
// legitimately overlap in one browser, and a shared cookie name would let the
// newer start silently rebind the older flow. Parameterising the Google module
// was rejected deliberately — that module is now on the Production-verified
// Google path, and widening it would put a verified control back in question for
// no benefit. The security properties below are identical by construction, and
// the unit tests assert they stay in lockstep.
//
// THE THREAT THIS CLOSES
// ----------------------
// Attacker A starts an Outlook connect in A's own Funnl account, takes the
// resulting Microsoft authorization URL, and gets victim B to complete consent
// with B's mailbox. Microsoft posts the code back to Funnl. Without binding, the
// callback resolves the state to user A and links B's mailbox into A's account.
// State, PKCE and the id_token nonce all fail to stop this: A holds the state and
// the verifier, and the nonce is checked against the same state A created. Only
// proof that the completing browser is the one that STARTED the flow closes it,
// and a cookie set at start time is that proof.
//
// COOKIE ATTRIBUTES, AND WHY EACH ONE
// -----------------------------------
//   __Host-       Forbids a Domain attribute and requires Path=/ and Secure, so a
//                 subdomain (or anything that can write one) cannot plant or
//                 overwrite it. Enforced by the browser, not by us.
//   SameSite=None Microsoft returns the callback via response_mode=form_post: a
//                 cross-site TOP-LEVEL POST. Lax is NOT sent on cross-site POST,
//                 so Lax would make the gate permanently unsatisfiable and fail
//                 every connection closed. None is required by the delivery mode.
//   Secure        Required by both __Host- and SameSite=None.
//   HttpOnly      Page scripts never need it; keeps it out of reach of XSS.
//   Path=/        Required by __Host-.
//   Max-Age       Matches the 10-minute state TTL: the cookie must not outlive
//                 the state it binds.
//
// HOST SCOPING IS LOAD-BEARING
// ----------------------------
// The cookie is only useful if it is set on, and sent back to, the SAME host that
// receives the callback. A cookie set by *.supabase.co is never sent to
// www.getfunnl.com, so both the start and the callback MUST be reached through
// the branded /api/... path, and the Entra redirect URI must be the branded URL.
// See EXPECTED_OUTLOOK_CALLBACK_URL in microsoftOauthHelpers.js.
//
// The cookie value is the raw state. The state is already a 32-byte random value
// whose SHA-256 is what gets persisted, so reusing it needs no new column and no
// second secret. A database reader still cannot forge a state.

export const MS_BINDING_COOKIE_NAME = '__Host-fnl_ms_oauth_bind'

/** Matches the state TTL in microsoft_oauth_states. */
export const MS_BINDING_COOKIE_MAX_AGE_S = 600

/** Set at start time. `state` must already be cookie-safe (base64url is). */
export function buildMsBindingCookie (state, maxAgeSeconds = MS_BINDING_COOKIE_MAX_AGE_S) {
  if (!isCookieSafeValue(state)) throw new Error('unsafe state value for cookie')
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0) throw new Error('bad max age')
  return `${MS_BINDING_COOKIE_NAME}=${state}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=None`
}

/**
 * Sent on EVERY terminal callback response. The flow is over either way, and a
 * stale binding must never be reusable by a later attempt.
 */
export function buildClearedMsBindingCookie () {
  return `${MS_BINDING_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=None`
}

/**
 * True when every character is safe in an unquoted cookie-value per RFC 6265
 * cookie-octet: excludes control characters, space, double quote, comma,
 * semicolon and backslash.
 */
export function isCookieSafeValue (v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 4096) return false
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c < 0x21 || c > 0x7e) return false
    if (c === 0x22 || c === 0x2c || c === 0x3b || c === 0x5c) return false
  }
  return true
}

/**
 * Read our cookie out of a raw Cookie header. Returns null when absent.
 * Deliberately tolerant of other cookies and of odd whitespace, and never
 * throws on malformed input.
 */
export function readMsBindingCookie (cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return null
  if (cookieHeader.length > 16384) return null
  const parts = cookieHeader.split(';')
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (name !== MS_BINDING_COOKIE_NAME) continue
    const value = part.slice(eq + 1).trim()
    if (!isCookieSafeValue(value)) return null
    return value
  }
  return null
}

/** Length-independent comparison, to avoid leaking a prefix match by timing. */
export function timingSafeEqualStrings (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ab = new TextEncoder().encode(a)
  const bb = new TextEncoder().encode(b)
  let diff = ab.length ^ bb.length
  const n = Math.max(ab.length, bb.length)
  for (let i = 0; i < n; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return diff === 0
}

/**
 * The gate. Returns { ok, reason } where reason is a controlled code suitable
 * for logging: never the cookie, never the state.
 *
 * MUST be called before any database read, any token exchange, and any Graph
 * call, so an unbound completion costs nothing and touches nothing.
 */
export function verifyMsBrowserBinding (cookieHeader, submittedState) {
  if (typeof submittedState !== 'string' || submittedState.length === 0) {
    return { ok: false, reason: 'no_submitted_state' }
  }
  const bound = readMsBindingCookie(cookieHeader)
  if (bound === null) return { ok: false, reason: 'no_cookie_header' }
  if (!timingSafeEqualStrings(bound, submittedState)) {
    return { ok: false, reason: 'binding_mismatch' }
  }
  return { ok: true, reason: 'bound' }
}
