import { getProAccessStatus } from './pro-access-status'
import { isTrialActive, computeTrialStatus } from './pro-trial-helpers'

// Re-export pure helpers so callers of ai.js can import them without touching pro-trial-helpers.js.
// Also keeps tests/pro-trial.test.js importing from a stable path.
export { isTrialActive, computeTrialStatus }

// ── Pro entitlement ────────────────────────────────────────────────────────────
//
// Effective Pro = permanent_pro (ai_enabled=true) OR an active trial.
// ai_enabled is NEVER set to true for trial users — those paths are separate.
//
// canUseAI() is the frontend Stripe-ready seam: every UI gate calls this.
// The authoritative check is always the server (Edge Functions call the shared
// pro-entitlement.js helper). This frontend call is cosmetic — it gates UI display,
// not API access. When Stripe is added (Layer D), update getProAccessStatus() to
// incorporate subscription status; all UI gates update automatically.

/**
 * Returns true if the user currently has Pro access (permanent or active trial).
 * Uses the server-authoritative RPC — never uses new Date() on the browser.
 * Returns false on RPC failure (network error, not authenticated) to fail closed.
 *
 * @param {string} _userId - kept for call-site compatibility; identity comes from the session
 * @returns {Promise<boolean>}
 */
export async function canUseAI(_userId) {
  const status = await getProAccessStatus()
  return status?.can_use_pro === true
}

/**
 * Returns detailed trial status for UI display (Settings, FunnlAI page, Sidebar).
 * Maps the RPC response to the shape previously returned by computeTrialStatus().
 *
 * Return shape:
 *   eligible    boolean  — trial row exists but not yet started
 *   active      boolean  — trial is currently running (server clock)
 *   expired     boolean  — trial was started but has ended (server clock)
 *   daysRemaining number — calendar days left (0 when not active)
 *   endsAt      string|null — ISO timestamp of trial end
 *
 * Returns { eligible: false, active: false, expired: false, daysRemaining: 0, endsAt: null }
 * on RPC failure so callers get a consistent shape — distinguish failure from "not Pro"
 * by checking whether the overall status object is null.
 *
 * @param {string} _userId - kept for call-site compatibility
 * @returns {Promise<{eligible:boolean,active:boolean,expired:boolean,daysRemaining:number,endsAt:string|null}>}
 */
export async function getTrialStatus(_userId) {
  const status = await getProAccessStatus()
  if (!status) {
    return { eligible: false, active: false, expired: false, daysRemaining: 0, endsAt: null }
  }
  return {
    eligible:      status.trial_eligible ?? false,
    active:        status.trial_active   ?? false,
    expired:       status.trial_expired  ?? false,
    daysRemaining: status.days_remaining ?? 0,
    endsAt:        status.ends_at        ?? null,
  }
}
