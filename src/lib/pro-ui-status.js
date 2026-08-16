import { isKnownSubscriptionStatus } from './subscriptionStatusPolicy.js'

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
/**
 * Returns true when the user currently has Pro access according to the
 * server-authoritative RPC result.
 *
 * Reads can_use_pro directly — the canonical entitlement boolean — so this
 * function never needs to enumerate individual access states ('permanent',
 * 'trial', 'subscribed'). Any new access path added to the RPC (e.g. a
 * gift code) is automatically covered here without code changes.
 *
 * @param {null | 'error' | object} proStatus
 * @returns {boolean}
 */
export function hasProAccess(proStatus) {
  return (
    proStatus !== null &&
    proStatus !== 'error' &&
    typeof proStatus === 'object' &&
    proStatus.can_use_pro === true
  )
}

export function classifyProStatus(proStatus) {
  // null (loading) and 'error' (RPC failed) are both "status unavailable".
  // Treat them identically so the UI can show a neutral fallback in both cases.
  if (proStatus === null || proStatus === 'error') return 'unavailable'
  // Unexpected non-object value (e.g. an unexpected string) is also unavailable.
  if (typeof proStatus !== 'object') return 'unavailable'

  // ── Field validation (R4) ──────────────────────────────────────────────────
  // Required booleans: can_use_pro and permanent_pro must be present and boolean.
  if (
    typeof proStatus.can_use_pro !== 'boolean' ||
    typeof proStatus.permanent_pro !== 'boolean'
  ) {
    return 'unavailable'
  }
  // Optional booleans: when present they MUST be booleans (reject malformed values).
  // Absent is tolerated (older RPC shapes) and treated as false below.
  for (const field of ['subscription_active', 'trial_active', 'trial_expired', 'cancel_at_period_end']) {
    if (field in proStatus && typeof proStatus[field] !== 'boolean') return 'unavailable'
  }
  // subscription_status: when present and non-null, must be a known Stripe status
  // string (the RPC returns COALESCE(status,'none'), so null/absent means "none").
  if (proStatus.subscription_status != null && !isKnownSubscriptionStatus(proStatus.subscription_status)) {
    return 'unavailable'
  }

  const canUse     = proStatus.can_use_pro === true
  const permanent  = proStatus.permanent_pro === true
  const subscribed = proStatus.subscription_active === true
  const trialing   = proStatus.trial_active === true
  const anyGrant   = permanent || subscribed || trialing

  // ── Consistency guards (both contradiction directions) ─────────────────────
  // (a) A grant flag is true while can_use_pro is false → internally inconsistent.
  // (b) can_use_pro is true while NO grant flag is true → access with no reason,
  //     which would otherwise render 'non_pro' while hasProAccess() returns true,
  //     recreating a UI/access mismatch.
  // In both cases render a neutral 'unavailable'; can_use_pro (via hasProAccess)
  // remains the sole authority for actual access.
  if (!canUse && anyGrant) return 'unavailable'
  if (canUse && !anyGrant) return 'unavailable'

  // classifyProStatus is DISPLAY-ONLY. It never gates access — hasProAccess() is the
  // sole access gate. Reaching here, canUse === anyGrant (a consistent result).

  // Permanent access takes display priority (may coexist with subscription/trial).
  if (permanent) return 'permanent'
  // Active Stripe subscription (may coexist with an expired Funnl trial;
  // cancel_at_period_end does not remove access).
  if (subscribed) return 'subscribed'
  // Active trial (can_use_pro guaranteed true here).
  if (trialing) return 'trial'
  // No access and no grant flag: expired trial vs confirmed non-Pro (display only).
  if (proStatus.trial_expired === true) return 'expired'
  return 'non_pro'
}
