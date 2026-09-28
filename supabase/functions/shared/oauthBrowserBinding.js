// Browser binding for the Google OAuth authorization-code flow.
//
// ── The hole this closes ─────────────────────────────────────────────────────
// google-oauth-start writes the INITIATING Funnl user into a google_oauth_states
// row. google-oauth-callback then takes the user id from that row. Nothing proved
// that the browser finishing Google consent was the browser that started.
//
// So: attacker A signs in as A, starts a connection, and sends the Google
// authorization URL to victim B. B consents with B's own Google account. Google
// posts code+state to the callback; the callback resolves the state, reads
// user_id = A, exchanges the code for B's tokens, and stores B's refresh token
// under A's Funnl account. A then reads B's calendar (and, once Gmail is enabled,
// B's mail) from A's own account.
//
// Single-use state does NOT stop this: the attacker discloses their own state and
// it is still on its first use. PKCE does NOT stop it: the verifier never leaves
// the server and our own callback performs the exchange. An ID-token nonce would
// NOT stop it either — a nonce binds the token to the authorization REQUEST, and
// the request really was A's; the returned token would carry B's identity and A's
// nonce, and would validate.
//
// ── The fix ──────────────────────────────────────────────────────────────────
// The start function issues a host-locked cookie holding the raw state. The
// callback requires that cookie to equal the submitted state BEFORE it touches
// the database, exchanges the authorization code, or writes a token. B's browser
// never received the cookie, so B's completion is refused with no code exchange
// and no persistence. A cannot plant a cookie on Funnl's host in B's browser.
//
// The raw state is already a 32-byte random value whose SHA-256 is the stored
// state_hash, so reusing it as the cookie value needs no new column and no
// migration. Knowing the state is not enough to complete a flow any more —
// completing also requires holding the cookie, which only the initiating browser
// does.
//
// ── Why these exact cookie attributes ────────────────────────────────────────
//   __Host- prefix  The browser itself enforces Secure, NO Domain attribute, and
//                   Path=/. That locks the cookie to one exact host: a sibling
//                   subdomain cannot plant or overwrite it. The prefix REQUIRES
//                   Path=/ — a narrower path such as /api/google-oauth-callback
//                   makes the browser reject the whole Set-Cookie, so Path=/ is a
//                   requirement here, not a preference.
//   SameSite=None   Google returns the callback with response_mode=form_post: a
//                   CROSS-SITE top-level POST from accounts.google.com. Lax is not
//                   sent on a cross-site POST (Lax covers top-level GET only), so
//                   Lax or Strict would break every legitimate completion. None is
//                   still first-party at the destination host, so third-party
//                   cookie blocking does not apply to it here.
//   Secure          Required by both __Host- and SameSite=None.
//   HttpOnly        Page scripts never need the value.
//   Max-Age         Matches the 10-minute state TTL; the cookie cannot outlive the
//                   state it binds.
//
// ── Host reachability ────────────────────────────────────────────────────────
// A cookie is only returned to the host that set it. The callback is reached at
// the branded https://www.getfunnl.com/api/google-oauth-callback (a Vercel rewrite
// to the Supabase function), so the start response must ALSO come back through a
// branded /api path — a Set-Cookie from a direct *.supabase.co call is scoped to
// supabase.co and would never be sent to www.getfunnl.com.
//
// Overlapping attempts: the cookie name is fixed, so starting a second connection
// overwrites the first cookie. Last start wins; the earlier flow then fails the
// binding check and the user simply restarts. That is deliberate — it fails
// closed, and it keeps the browser holding at most one live binding.

/** Fixed cookie name. The __Host- prefix is load-bearing (see above). */
export const BINDING_COOKIE_NAME = '__Host-fnl_oauth_bind'

/** Seconds. Matches STATE_TTL_MS in the start functions. */
export const BINDING_COOKIE_MAX_AGE_S = 600

/**
 * Set-Cookie value that binds this browser to `state`.
 *
 * @param {string} state raw state (base64url, as minted by generateRandomToken)
 * @param {number} [maxAgeSeconds]
 * @returns {string}
 */
export function buildBindingCookie (state, maxAgeSeconds = BINDING_COOKIE_MAX_AGE_S) {
  if (typeof state !== 'string' || state.length === 0) throw new Error('binding_state_required')
  if (!isCookieSafeValue(state)) throw new Error('binding_state_unsafe')
  return `${BINDING_COOKIE_NAME}=${state}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=None`
}

/** Set-Cookie value that immediately removes the binding cookie. */
export function buildClearedBindingCookie () {
  return `${BINDING_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=None`
}

/**
 * True when every character is safe to place in a cookie-value unquoted, per
 * RFC 6265 cookie-octet. Excludes control chars, space, double quote, comma,
 * semicolon and backslash. base64url output always passes.
 *
 * @param {string} v
 * @returns {boolean}
 */
export function isCookieSafeValue (v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 512) return false
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c < 0x21 || c > 0x7e) return false          // control, space, or non-ASCII
    if (c === 0x22 || c === 0x2c || c === 0x3b || c === 0x5c) return false  // " , ; \
  }
  return true
}

/**
 * Reads the binding cookie out of a raw Cookie header, unambiguously.
 *
 * Cookie headers are a flat `a=1; b=2` list with no ordering or uniqueness
 * guarantee, and a browser can legitimately present more than one cookie with the
 * same name (different Domain/Path scopes). Rather than silently picking one, a
 * duplicate name is treated as an error: with __Host- there is exactly one valid
 * scope, so two values mean something is wrong and the safe answer is to refuse.
 *
 * Name matching is exact and case-sensitive (cookie names are case-sensitive).
 * Only the FIRST '=' separates name from value, so a base64url value is never
 * truncated. Empty values are rejected.
 *
 * @param {unknown} cookieHeader
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
export function readBindingCookie (cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
    return { ok: false, reason: 'no_cookie_header' }
  }
  if (cookieHeader.length > 8192) return { ok: false, reason: 'cookie_header_too_large' }

  let found = null
  let seen = 0
  for (const rawPair of cookieHeader.split(';')) {
    const pair = rawPair.trim()
    if (pair.length === 0) continue
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    if (name !== BINDING_COOKIE_NAME) continue
    seen += 1
    found = pair.slice(eq + 1).trim()
  }

  if (seen === 0) return { ok: false, reason: 'binding_absent' }
  if (seen > 1) return { ok: false, reason: 'binding_duplicated' }
  if (!found || found.length === 0) return { ok: false, reason: 'binding_empty' }
  if (!isCookieSafeValue(found)) return { ok: false, reason: 'binding_malformed' }
  return { ok: true, value: found }
}

/**
 * Length-independent, constant-time-ish string comparison. Both inputs here are
 * high-entropy random tokens, so this guards against trivial timing probes
 * without pretending to be a full side-channel defence.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqualStrings (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * The callback's gate. Call this with the raw Cookie header and the state that
 * arrived in the form_post body, BEFORE any database access or code exchange.
 *
 * @param {unknown} cookieHeader raw `Cookie` request header
 * @param {unknown} submittedState state from the callback form body
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyBrowserBinding (cookieHeader, submittedState) {
  if (typeof submittedState !== 'string' || submittedState.length === 0) {
    return { ok: false, reason: 'state_missing' }
  }
  const cookie = readBindingCookie(cookieHeader)
  if (!cookie.ok) return cookie
  if (!timingSafeEqualStrings(cookie.value, submittedState)) {
    return { ok: false, reason: 'binding_mismatch' }
  }
  return { ok: true }
}
