// Canonical Stripe subscription-status policy — the SINGLE source of truth shared by
// the checkout backend (create-checkout-session) and the frontend UI.
//
// LOCATION: this lives under supabase/functions/shared/ (the repo's established shared
// Edge location, alongside pro-entitlement.js) so the Supabase deployer resolves it from
// the function module graph without reaching into src/. The frontend imports the SAME
// module via a thin re-export at src/lib/subscriptionStatusPolicy.js — there is only one
// implementation, no duplicated status map.
//
// Zero dependencies (no Deno, React, Supabase, browser, or Node APIs) — safe to import
// from Node tests, the Vite frontend, and Deno Edge Functions.
//
// checkoutMode drives the durable checkout single-flight (claim_checkout_operation p_mode):
//   'reuse_or_create' (none)                  reuse an unexpired ready session if present, else create.
//   'reuse_only'      (incomplete)            reuse an unexpired ready session ONLY; never create a
//                                             second subscription → blocked_no_reuse if none.
//   'fresh_only'      (canceled,              NEVER reuse an old ready session (it may be a
//                      incomplete_expired)    completed/obsolete payment attempt); always start a
//                                             genuinely new operation atomically.
//   'block'           (active, past_due,      an existing subscription (or attention state) must be
//                      trialing, unpaid,      managed, not duplicated — backend returns 409, UI shows
//                      paused, unknown)       manage/attention.
//
// grantsAccess mirrors entitlement semantics (active + past_due keep access during dunning).
// It is documentation here — the authoritative gate remains can_use_pro via hasProAccess().
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
    checkoutMode: 'fresh_only', grantsAccess: false, uiState: 'can_checkout',
    description: 'Permanently ended. A new checkout is allowed; never reuse the old completed session.',
  },
  incomplete_expired: {
    checkoutMode: 'fresh_only', grantsAccess: false, uiState: 'can_checkout',
    description: 'Checkout expired without payment. A new checkout is allowed; never reuse the old/obsolete session.',
  },
  none: {
    checkoutMode: 'reuse_or_create', grantsAccess: false, uiState: 'can_checkout',
    description: 'No subscription attached. Reuse an open ready session if present, else a new checkout is allowed.',
  },
}

// Fail-closed policy for any unknown / non-string status: block a new checkout and
// surface a billing-attention UI. Never accidentally create a duplicate subscription
// because of an unexpected status string.
const UNKNOWN_POLICY = {
  checkoutMode: 'block', grantsAccess: false, uiState: 'billing_attention',
  description: 'Unknown subscription status — fail closed (no new checkout).',
}

/**
 * Returns the policy object for a Stripe subscription status.
 * null / undefined / '' are treated as 'none' (no subscription → reuse-or-create).
 * Any unrecognized non-empty string fails closed (block).
 *
 * @param {string|null|undefined} status
 * @returns {{ checkoutMode: 'reuse_or_create'|'reuse_only'|'fresh_only'|'block', grantsAccess: boolean, uiState: string, description: string }}
 */
export function checkoutPolicyForStatus(status) {
  if (status == null || status === '') return SUBSCRIPTION_STATUS_POLICY.none
  return SUBSCRIPTION_STATUS_POLICY[status] ?? UNKNOWN_POLICY
}

/**
 * The checkout single-flight mode (p_mode) the backend passes to claim_checkout_operation.
 * @param {string|null|undefined} status
 * @returns {'reuse_or_create'|'reuse_only'|'fresh_only'|'block'}
 */
export function checkoutModeForStatus(status) {
  return checkoutPolicyForStatus(status).checkoutMode
}

/**
 * True when the backend may create a NEW Checkout Session for this status
 * (reuse_or_create or fresh_only). reuse_only and block are false.
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isCheckoutCreationAllowed(status) {
  const m = checkoutModeForStatus(status)
  return m === 'reuse_or_create' || m === 'fresh_only'
}

/**
 * True when an existing open Checkout Session may be reused but NOT newly created.
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isCheckoutReuseOnly(status) {
  return checkoutModeForStatus(status) === 'reuse_only'
}

/** The set of known Stripe subscription-status strings (plus 'none'). */
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
 * DISPLAY-ONLY classification for the UI: when a subscription exists in a state that
 * needs the user's attention (and where a normal Subscribe button must NOT be shown
 * because the backend would reject / reuse-only a new checkout). Returns one of
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
