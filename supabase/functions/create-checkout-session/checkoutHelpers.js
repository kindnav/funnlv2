// Pure helper functions for the create-checkout-session Edge Function.
// Zero external imports — safe to unit-test in Node.js without a Deno environment.

// UUID v4 regex. Validates that the string looks like a standard v4 UUID.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Returns true when str is a valid UUID v4 string (case-insensitive).
 *
 * @param {unknown} str
 * @returns {boolean}
 */
export function isValidUUID(str) {
  return typeof str === 'string' && UUID_RE.test(str)
}

/**
 * Builds the Stripe idempotency key for a checkout session creation request from the
 * server-generated opaque checkout operation id.
 *
 * CRITICAL PRIVACY PROPERTY: the key contains ONLY the opaque operation UUID — never
 * a user id, email, or any other personal identifier. The operation id is minted by
 * the checkout_operations single-flight RPC and persisted BEFORE the Stripe call, so
 * a crash-recovery retry reuses the SAME operation id and therefore the SAME
 * idempotency key, and Stripe returns the already-created session instead of a
 * duplicate.
 *
 * The browser-supplied attemptId is NOT used here — it is not authoritative for
 * checkout deduplication (a fresh attemptId per click would defeat idempotency).
 *
 * @param {string} operationId — opaque UUID from claim_checkout_operation()
 * @returns {string}
 */
export function buildCheckoutIdempotencyKey(operationId) {
  return `checkout-op-${operationId}`
}

/**
 * Validates a Stripe-returned Checkout Session URL: absolute HTTPS on
 * checkout.stripe.com. Used server-side before storing/returning a URL.
 *
 * @param {unknown} url
 * @returns {boolean}
 */
export function isValidCheckoutUrl(url) {
  if (typeof url !== 'string' || !url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'checkout.stripe.com'
  } catch {
    return false
  }
}

/**
 * Validates a Stripe Checkout Session object returned on an HTTP-success response.
 * A session may only be finalized as 'ready' (and later reused) when ALL are true:
 *   - id is a non-empty string
 *   - url is a valid checkout.stripe.com HTTPS URL
 *   - expires_at is a finite positive integer AND strictly in the future
 * A `ready` row without a valid future expires_at could never be reused, so the next
 * request would create ANOTHER session — hence we require it here. Any failure means
 * the outcome is ambiguous (a session may or may not exist): the caller must treat it
 * as unknown, NOT finalize, and leave the operation for an idempotent retry.
 *
 * @param {unknown} session — parsed Stripe session (may be null/malformed)
 * @param {number} nowSec — current time in Unix SECONDS (must be a finite positive number).
 *   A non-finite value (NaN / Infinity — e.g. from a mis-wired clock) or a non-positive
 *   value is rejected as 'invalid_clock' so a broken clock can NEVER let a session pass.
 * @returns {{ ok: true, id: string, url: string, expiresAtIso: string }
 *          | { ok: false, reason: 'missing_session'|'missing_id'|'invalid_url'|'missing_expires_at'|'invalid_clock'|'expired' }}
 */
export function validateStripeSession(session, nowSec) {
  // Clock guard FIRST: a non-finite / non-positive nowSec (e.g. Math.floor(<ISO string>/1000)
  // === NaN from a mis-wired production clock) must fail closed, never fall through to ok.
  if (typeof nowSec !== 'number' || !Number.isFinite(nowSec) || nowSec <= 0) {
    return { ok: false, reason: 'invalid_clock' }
  }
  if (!session || typeof session !== 'object') return { ok: false, reason: 'missing_session' }
  const id = session.id
  if (typeof id !== 'string' || id.length === 0) return { ok: false, reason: 'missing_id' }
  if (!isValidCheckoutUrl(session.url)) return { ok: false, reason: 'invalid_url' }
  const exp = session.expires_at
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return { ok: false, reason: 'missing_expires_at' }
  if (exp <= nowSec) return { ok: false, reason: 'expired' }
  return { ok: true, id, url: session.url, expiresAtIso: new Date(exp * 1000).toISOString() }
}

// HTTP statuses in the 4xx range that are AMBIGUOUS about whether a Checkout Session
// was created (an interrupted request, an idempotency conflict, or rate limiting), so
// they must be retried idempotently rather than treated as proof of no session.
//   408 Request Timeout  — the request may have reached Stripe and created a session.
//   409 Conflict         — an idempotency conflict; the original request may have succeeded.
//   429 Too Many Requests — throttled; ambiguous, retry with the same idempotency key.
export const AMBIGUOUS_4XX = new Set([408, 409, 429])

/**
 * Classifies a Stripe HTTP status into a checkout provider outcome. (JSON-parse
 * failures on a 2xx response and network throws are handled by the caller as
 * 'unknown_failure' — they are not status-based.)
 *
 *   2xx                                   → 'success'
 *   408 / 409 / 429                       → 'unknown_failure' (ambiguous; idempotent retry)
 *   other 4xx (400,401,402,403,404,422,…) → 'definitive_failure' (proves no session was created)
 *   5xx / 3xx / <200 / non-number         → 'unknown_failure' (safest: retain the operation)
 *
 * @param {number} status
 * @returns {'success'|'definitive_failure'|'unknown_failure'}
 */
export function classifyProviderStatus(status) {
  if (typeof status === 'number' && status >= 200 && status < 300) return 'success'
  if (AMBIGUOUS_4XX.has(status)) return 'unknown_failure'
  if (typeof status === 'number' && status >= 400 && status < 500) return 'definitive_failure'
  return 'unknown_failure'
}

// ── Post-checkout redirect origin resolution ──────────────────────────────────
//
// Stripe returns the user to success_url / cancel_url after checkout. Those URLs
// must point back to the SAME origin that started checkout — otherwise a checkout
// begun on a Vercel Preview returns to production (www.getfunnl.com), where the
// Preview's Supabase auth session does not exist, dumping the user at /signin.
//
// The browser sends its window.location.origin. Because that value is
// attacker-controllable, it is validated against a strict allowlist before use;
// anything untrusted (or missing/malformed) falls back to the canonical
// production origin, so this can NEVER be turned into an open redirect.

// Canonical fallback — used whenever the requested origin is absent or untrusted.
export const CANONICAL_ORIGIN = 'https://www.getfunnl.com'

// Exact production origins (https only).
const PROD_ORIGINS = new Set(['https://www.getfunnl.com', 'https://getfunnl.com'])

// Trusted Vercel Preview hosts for THIS project only. Vercel preview hostnames are
// `<project>-...-<team>.vercel.app`; here both project slug and team slug are
// `funnlv2`. Requiring BOTH the `funnlv2-` prefix AND the `-funnlv2.vercel.app`
// suffix anchors to the team-scoped namespace (only the funnlv2 team can deploy
// hosts ending in `-funnlv2.vercel.app`), so an arbitrary `*.vercel.app` attacker
// host cannot match. Fully anchored; lowercase host only.
const PREVIEW_HOST_RE = /^funnlv2-[a-z0-9-]+-funnlv2\.vercel\.app$/

/**
 * Resolves a browser-supplied origin to a TRUSTED https origin string.
 * Returns CANONICAL_ORIGIN for anything missing, malformed, non-https, carrying
 * credentials or an explicit port, or not on the allowlist. Never returns an
 * attacker-controlled origin.
 *
 * @param {unknown} rawOrigin — e.g. window.location.origin from the browser
 * @returns {string} a trusted `https://host` origin (no path/query/port)
 */
export function resolveCheckoutOrigin(rawOrigin) {
  if (typeof rawOrigin !== 'string' || rawOrigin.length === 0) return CANONICAL_ORIGIN
  let u
  try {
    u = new URL(rawOrigin)
  } catch {
    return CANONICAL_ORIGIN
  }
  if (u.protocol !== 'https:') return CANONICAL_ORIGIN
  if (u.username || u.password) return CANONICAL_ORIGIN   // no userinfo trickery
  if (u.port) return CANONICAL_ORIGIN                     // prod/preview never use a custom port
  const origin = `https://${u.hostname}`
  if (PROD_ORIGINS.has(origin)) return origin
  if (PREVIEW_HOST_RE.test(u.hostname)) return origin
  return CANONICAL_ORIGIN
}

/**
 * Builds the Stripe success_url / cancel_url from a browser-supplied origin,
 * validated through resolveCheckoutOrigin. The path + query are constructed
 * server-side (never taken from the browser), so only the trusted origin varies.
 *
 * @param {unknown} rawOrigin
 * @returns {{ successUrl: string, cancelUrl: string, origin: string }}
 */
export function buildCheckoutRedirects(rawOrigin) {
  const origin = resolveCheckoutOrigin(rawOrigin)
  return {
    origin,
    successUrl: `${origin}/settings?checkout=success`,
    cancelUrl:  `${origin}/settings?checkout=cancelled`,
  }
}
