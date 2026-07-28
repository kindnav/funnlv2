import { supabase } from './supabase'
import { isTrialActive, computeTrialStatus } from './pro-trial-helpers'

// Re-export pure helpers so callers of ai.js can import them without touching pro-trial-helpers.js
export { isTrialActive, computeTrialStatus }

// ── Pro entitlement ────────────────────────────────────────────────────────────
//
// Effective Pro = ai_enabled is true (permanent/manual grant) OR an active trial.
// ai_enabled is NEVER set to true for trial users — they are entirely separate.
//
// canUseAI() is the Stripe-ready seam: every AI feature calls this.
// Nothing reads ai_enabled directly. When Stripe is added (Layer D), replace
// this function body to check subscription status — all AI features become
// Stripe-gated automatically with no other code changes needed.

/**
 * Returns true if the user currently has Pro access (permanent or active trial).
 * @param {string} userId - Supabase auth user ID
 * @returns {Promise<boolean>}
 */
export async function canUseAI(userId) {
  const [profileResult, trialResult] = await Promise.all([
    supabase.from('profiles').select('ai_enabled').eq('id', userId).maybeSingle(),
    supabase.from('pro_trials').select('started_at, ends_at').eq('user_id', userId).maybeSingle(),
  ])
  if (profileResult.data?.ai_enabled === true) return true
  return isTrialActive(trialResult.data)
}

/**
 * Returns detailed trial status for UI display (Settings, FunnlAI page, etc.).
 *
 * Return shape:
 *   eligible    boolean  — row exists with started_at IS NULL (not yet activated)
 *   active      boolean  — trial is currently running
 *   expired     boolean  — trial was started but has ended
 *   daysRemaining number — calendar days left (0 when not active)
 *   endsAt      string|null — ISO timestamp of trial end
 *
 * @param {string} userId - Supabase auth user ID
 * @returns {Promise<{eligible:boolean,active:boolean,expired:boolean,daysRemaining:number,endsAt:string|null}>}
 */
export async function getTrialStatus(userId) {
  const { data } = await supabase
    .from('pro_trials')
    .select('started_at, ends_at')
    .eq('user_id', userId)
    .maybeSingle()
  return computeTrialStatus(data, new Date())
}
