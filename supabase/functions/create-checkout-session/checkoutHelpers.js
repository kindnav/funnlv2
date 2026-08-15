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
