/**
 * Maps a proStatus value to a display classification for the AI page
 * and related Pro-access UI components.
 *
 * proStatus values:
 *   null      — initial state; status not yet fetched (loading)
 *   'error'   — getProAccessStatus() returned null (RPC failed or rejected)
 *   object    — successful status from getProAccessStatus()
 *
 * @param {null | 'error' | object} proStatus
 * @returns {'unavailable' | 'permanent' | 'subscribed' | 'trial' | 'expired' | 'non_pro'}
 *
 *   'unavailable' — null, 'error', or a malformed object: cannot determine access.
 *                   UI must show a neutral state — never claim Pro or non-Pro.
 *   'permanent'   — ai_enabled = true on the user's profile (permanent Pro)
 *   'subscribed'  — active Stripe subscription (status 'active' or 'past_due')
 *   'trial'       — active 7-day trial (not permanent, not subscribed)
 *   'expired'     — trial has ended and user has no permanent or subscription access
 *   'non_pro'     — confirmed not Pro: no trial, no subscription, no permanent access
 */
export function classifyProStatus(proStatus) {
  // null (loading) and 'error' (RPC failed) are both "status unavailable".
  // Treat them identically so the UI can show a neutral fallback in both cases.
  if (proStatus === null || proStatus === 'error') return 'unavailable'
  // Unexpected non-object value (e.g. an unexpected string) is also unavailable.
  if (typeof proStatus !== 'object') return 'unavailable'
  // Validate minimum shape: both boolean fields must be present and boolean.
  // A missing or wrong-typed field must not be silently treated as a grant or denial.
  if (
    typeof proStatus.can_use_pro !== 'boolean' ||
    typeof proStatus.permanent_pro !== 'boolean'
  ) {
    return 'unavailable'
  }
  // Permanent access always takes display priority, regardless of trial or subscription.
  if (proStatus.permanent_pro === true) return 'permanent'
  // Active Stripe subscription (subscription_active may be absent on older RPC shapes
  // — safe default false via truthy check).
  if (proStatus.subscription_active === true) return 'subscribed'
  // Active trial (non-permanent, non-subscribed user with a running trial)
  if (proStatus.can_use_pro === true && proStatus.trial_active === true) return 'trial'
  // Expired trial (non-permanent, no subscription, no active access)
  if (proStatus.trial_expired === true) return 'expired'
  // Confirmed non-Pro: no trial of any kind, no subscription, no permanent access
  return 'non_pro'
}
