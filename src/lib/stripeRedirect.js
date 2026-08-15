// Redirect-decision helper shared by the checkout/portal redirect sites in
// FunnlAIPage and SettingsPage. Centralizes the "is this Edge Function response
// safe to send the browser to?" decision so all three redirect sites behave
// identically and are covered by one set of tests.
//
// A redirect is allowed ONLY when:
//   - the Edge Function returned no error, AND
//   - data.url is an absolute HTTPS URL on the approved Stripe hostname for `type`
//     ('checkout' → checkout.stripe.com, 'portal' → billing.stripe.com).
//
// Returns { ok: true, url } when safe, or { ok: false, reason } otherwise. Callers
// must show their visible error and fire the appropriate failed-analytics event when
// ok === false, and must NOT navigate.

import { isValidStripeUrl } from './stripeUrl.js'

/**
 * @param {unknown} data  — the `data` field from supabase.functions.invoke()
 * @param {unknown} error — the `error` field from supabase.functions.invoke()
 * @param {'checkout'|'portal'} type
 * @returns {{ ok: true, url: string } | { ok: false, reason: 'error'|'invalid_url' }}
 */
export function resolveStripeRedirect(data, error, type) {
  if (error) return { ok: false, reason: 'error' }
  const url = data && typeof data === 'object' ? data.url : undefined
  if (!isValidStripeUrl(url, type)) return { ok: false, reason: 'invalid_url' }
  return { ok: true, url }
}
