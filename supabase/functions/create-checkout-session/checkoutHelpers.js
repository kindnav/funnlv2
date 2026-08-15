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
 * @param {number} nowSec — current time in Unix SECONDS (injectable)
 * @returns {{ ok: true, id: string, url: string, expiresAtIso: string }
 *          | { ok: false, reason: 'missing_session'|'missing_id'|'invalid_url'|'missing_expires_at'|'expired' }}
 */
export function validateStripeSession(session, nowSec) {
  if (!session || typeof session !== 'object') return { ok: false, reason: 'missing_session' }
  const id = session.id
  if (typeof id !== 'string' || id.length === 0) return { ok: false, reason: 'missing_id' }
  if (!isValidCheckoutUrl(session.url)) return { ok: false, reason: 'invalid_url' }
  const exp = session.expires_at
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return { ok: false, reason: 'missing_expires_at' }
  if (typeof nowSec !== 'number' || exp <= nowSec) return { ok: false, reason: 'expired' }
  return { ok: true, id, url: session.url, expiresAtIso: new Date(exp * 1000).toISOString() }
}
