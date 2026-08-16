// Display-only copy for the Funnl Pro price.
//
// Stripe and STRIPE_PRO_PRICE_ID remain the single source of truth for the
// amount actually charged. This constant is UI text only — it must be kept in
// sync with the active Stripe Pro price by hand. It intentionally does NOT hit
// Stripe or any API; it is plain display copy.
export const PRO_PRICE_DISPLAY = '$4.99/month'

// ── Billing availability flag ─────────────────────────────────────────────────
//
// Single source of truth for whether paid billing (Stripe checkout) is live.
// While the live Stripe account is not activated, billing stays DISABLED and
// every Subscribe entry point renders a non-functional "Funnl Pro — Coming Soon"
// state instead of invoking create-checkout-session. Setting the env var
// VITE_BILLING_ENABLED to exactly the string "true" re-enables the fully
// reviewed checkout flow for future activation / internal testing.
//
// Fail-safe: enabled ONLY on the exact string "true". Missing, empty, malformed,
// "false", "TRUE", "1", etc. all resolve to DISABLED. Availability is NEVER
// inferred from the hostname, and NO Stripe key is read on the frontend.

/**
 * Pure predicate: billing is enabled only when the raw flag value is exactly the
 * string 'true'. Everything else (undefined, '', 'false', 'TRUE', '1', numbers,
 * null) is disabled. Kept pure + exported so it is unit-testable without Vite.
 *
 * @param {unknown} rawValue - the raw import.meta.env.VITE_BILLING_ENABLED value
 * @returns {boolean}
 */
export function billingEnabled(rawValue) {
  return rawValue === 'true'
}

// Computed once at module load from the Vite build env. In non-Vite contexts
// (e.g. Node test runners) import.meta.env is undefined → billing disabled.
export const BILLING_ENABLED = billingEnabled(import.meta.env?.VITE_BILLING_ENABLED)
