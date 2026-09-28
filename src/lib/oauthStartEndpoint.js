// Where the OAuth start function must be called from.
//
// The callback proves that whoever finishes Google consent is whoever started it,
// by checking a browser cookie the start function sets. A cookie is only ever sent
// back to the host that set it, and the callback is reached at the branded
// https://www.getfunnl.com/api/google-oauth-callback (a Vercel rewrite in front of
// the Supabase function).
//
// So the start call must ALSO go through that same branded host. Calling the
// Supabase function directly (supabase.functions.invoke) would set the cookie for
// *.supabase.co, which the browser would never send to www.getfunnl.com — the flow
// would fail closed on every completion.
//
// Apex: getfunnl.com 308-redirects to www at the CDN, so the app is served from www
// in practice. If a page somehow runs on the apex, a relative fetch would follow a
// cross-origin redirect and `fetch` strips the Authorization header when it does —
// so rather than start a flow that cannot complete, this refuses and says why.

/** The one host the branded callback lives on. Must match EXPECTED_GOOGLE_CALLBACK_URL. */
export const CANONICAL_OAUTH_ORIGIN = 'https://www.getfunnl.com'

/** Branded paths, mirrored by rewrites in vercel.json. */
export const OAUTH_START_PATHS = Object.freeze({
  calendar: '/api/google-oauth-start',
  gmail: '/api/gmail-oauth-start',
})

/**
 * Resolves the URL the browser should POST to in order to begin an OAuth flow.
 *
 * Returns a RELATIVE path when the page is already on the canonical origin, so the
 * request is same-origin: no CORS, and Set-Cookie is stored for exactly that host.
 *
 * @param {string} pageOrigin typically window.location.origin
 * @param {'calendar'|'gmail'} integration
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
export function resolveOauthStartUrl (pageOrigin, integration) {
  const path = OAUTH_START_PATHS[integration]
  if (!path) return { ok: false, reason: 'unknown_integration' }
  if (typeof pageOrigin !== 'string' || pageOrigin.length === 0) {
    return { ok: false, reason: 'unknown_origin' }
  }
  if (pageOrigin === CANONICAL_OAUTH_ORIGIN) return { ok: true, url: path }
  // Any other host (apex, a preview, a local dev server) cannot produce a cookie the
  // branded callback will receive. Fail closed rather than start an unusable flow.
  return { ok: false, reason: 'non_canonical_origin' }
}

/**
 * True when an OAuth flow started from this origin could actually be completed.
 * @param {string} pageOrigin
 * @returns {boolean}
 */
export function canStartOauthFrom (pageOrigin) {
  return pageOrigin === CANONICAL_OAUTH_ORIGIN
}
