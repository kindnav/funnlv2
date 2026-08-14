// Pure helper for validating Stripe-returned URLs before redirecting the browser.
// Zero dependencies — safe to unit-test in Node.js.

const STRIPE_CHECKOUT_HOSTNAME = 'checkout.stripe.com'
const STRIPE_PORTAL_HOSTNAME   = 'billing.stripe.com'

/**
 * Returns true if `url` is an absolute HTTPS URL on the approved Stripe hostname
 * for the given type.
 *
 * type 'checkout' → checkout.stripe.com
 * type 'portal'   → billing.stripe.com
 *
 * @param {string|null|undefined} url
 * @param {'checkout'|'portal'} type
 * @returns {boolean}
 */
export function isValidStripeUrl(url, type) {
  if (typeof url !== 'string' || !url) return false
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const approved = type === 'portal' ? STRIPE_PORTAL_HOSTNAME : STRIPE_CHECKOUT_HOSTNAME
  return parsed.hostname === approved
}
