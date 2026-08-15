// Canonical Stripe subscription-status policy — the SINGLE source of truth shared
// by the checkout backend (create-checkout-session) and the frontend UI. Zero
// dependencies (no React, no Supabase) so it is safe to import from Node tests, the
// Vite frontend, and Deno Edge Functions.
//
// Why one table: deciding "can this user start a new checkout?" must be identical
// on the server (security) and in the UI (don't show a Subscribe button the server
// will reject). A hand-written list duplicated in two places drifts; this module
// prevents that.
//
// checkoutMode:
//   'allow'      — no existing non-terminal Stripe subscription; a new checkout is fine.
//   'block'      — an existing subscription (or attention state) must be managed, not
//                  duplicated. The backend returns 409; the UI shows manage/attention.
//   'reuse_only' — a Stripe subscription exists but payment is not yet complete
//                  (incomplete). Reuse an open Checkout Session if one is recoverable;
//                  never blindly create a second subscription.
//
// grantsAccess mirrors the entitlement semantics (active + past_due keep access during
// dunning). It is documentation here — the authoritative access gate remains
// can_use_pro from get_my_pro_access_status(), read via hasProAccess().
//
// uiState is a DISPLAY classification only. It must NEVER be used as an access gate.

export const SUBSCRIPTION_STATUS_POLICY = {
  active: {
    checkoutMode: 'block', grantsAccess: true, uiState: 'subscribed',
    description: 'Current and paid. Manage billing; do not create another checkout.',
  },
  past_due: {
    checkoutMode: 'block', grantsAccess: true, uiState: 'billing_attention',
    description: 'Payment failed; Stripe retrying. Access preserved during dunning; offer billing management.',
  },
  incomplete: {
    checkoutMode: 'reuse_only', grantsAccess: false, uiState: 'payment_incomplete',
    description: 'Checkout started, payment not confirmed. Reuse the open session; never create a second subscription.',
  },
  trialing: {
    checkoutMode: 'block', grantsAccess: false, uiState: 'billing_attention',
    description: 'Stripe trial (Funnl does not use Stripe trials). Direct to billing management; do not create another subscription.',
  },
  unpaid: {
    checkoutMode: 'block', grantsAccess: false, uiState: 'billing_attention',
    description: 'Dunning exhausted. Direct to billing management / recovery; do not auto-create another subscription.',
  },
  paused: {
    checkoutMode: 'block', grantsAccess: false, uiState: 'billing_attention',
    description: 'Subscription paused. Direct to billing management; do not create another subscription.',
  },
  canceled: {
    checkoutMode: 'allow', grantsAccess: false, uiState: 'can_checkout',
    description: 'Permanently ended. A new checkout is allowed.',
  },
  incomplete_expired: {
    checkoutMode: 'allow', grantsAccess: false, uiState: 'can_checkout',
    description: 'Checkout expired without payment. A new checkout is allowed.',
  },
  none: {
    checkoutMode: 'allow', grantsAccess: false, uiState: 'can_checkout',
    description: 'No subscription attached. A new checkout is allowed.',
  },
}

// Fail-closed policy for any unknown / non-string status: block a new checkout and
// surface a billing-attention UI. Never accidentally allow a duplicate subscription
// because of an unexpected status string.
const UNKNOWN_POLICY = {
  checkoutMode: 'block', grantsAccess: false, uiState: 'billing_attention',
  description: 'Unknown subscription status — fail closed (no new checkout).',
}

/**
 * Returns the policy object for a Stripe subscription status.
 * null / undefined / '' are treated as 'none' (no subscription → checkout allowed).
 * Any unrecognized non-empty string fails closed (block).
 *
 * @param {string|null|undefined} status
 * @returns {{ checkoutMode: 'allow'|'block'|'reuse_only', grantsAccess: boolean, uiState: string, description: string }}
 */
export function checkoutPolicyForStatus(status) {
  if (status == null || status === '') return SUBSCRIPTION_STATUS_POLICY.none
  return SUBSCRIPTION_STATUS_POLICY[status] ?? UNKNOWN_POLICY
}

/**
 * Whether the backend may create a brand-new Checkout Session for this status.
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isCheckoutCreationAllowed(status) {
  return checkoutPolicyForStatus(status).checkoutMode === 'allow'
}

/**
 * Whether an existing open Checkout Session may be reused (but not newly created).
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isCheckoutReuseOnly(status) {
  return checkoutPolicyForStatus(status).checkoutMode === 'reuse_only'
}

/**
 * The set of known Stripe subscription-status strings (plus 'none').
 */
export const KNOWN_SUBSCRIPTION_STATUSES = new Set(Object.keys(SUBSCRIPTION_STATUS_POLICY))

/**
 * True when the status is a known Stripe subscription-status string.
 * Used by classifyProStatus() to validate the RPC's subscription_status field.
 * @param {unknown} status
 * @returns {boolean}
 */
export function isKnownSubscriptionStatus(status) {
  return typeof status === 'string' && KNOWN_SUBSCRIPTION_STATUSES.has(status)
}

/**
 * DISPLAY-ONLY classification for the UI: when a subscription exists in a state
 * that needs the user's attention (and where a normal Subscribe button must NOT be
 * shown because the backend would reject a new checkout). Returns one of
 * 'billing_attention' | 'payment_incomplete', or null when no attention is needed.
 *
 * NEVER use this as an access gate — hasProAccess(proStatus) is the only gate.
 * @param {string|null|undefined} status
 * @returns {'billing_attention'|'payment_incomplete'|null}
 */
export function subscriptionAttentionState(status) {
  const uiState = checkoutPolicyForStatus(status).uiState
  return uiState === 'billing_attention' || uiState === 'payment_incomplete' ? uiState : null
}
