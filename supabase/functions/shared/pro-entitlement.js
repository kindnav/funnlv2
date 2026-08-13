// Server-side Pro entitlement logic shared across all four AI Edge Functions.
//
// This file has zero imports — it is safe to test in Node.js without a Deno
// or Supabase environment. Both exports are pure or dependency-injected.
//
// SERVER-SIDE SEAM: this shared helper is the authoritative entitlement
// enforcement layer inside Edge Functions. The frontend seam (canUseAI() in
// src/lib/ai.js) is cosmetic only — it gates UI, not API access.
//
// Layer D (Stripe): subscription check is now included. To update billing
// logic (e.g. add grace periods, new statuses), update evaluateProEntitlement
// and the subscriptions table — no changes needed in individual Edge Functions.

/**
 * Pure Pro entitlement evaluation given raw DB row values and a reference instant.
 *
 * Priority rules (permanent always wins):
 *   1. profile.ai_enabled = true           → canUse: true,  reason: 'permanent'
 *   2. subscription.status 'active'/'past_due' → canUse: true,  reason: 'subscription'
 *   3. active trial (started + !expired)   → canUse: true,  reason: 'trial'
 *   4. expired trial                       → canUse: false, reason: 'expired_trial'
 *   5. eligible / no trial row / no profile → canUse: false, reason: 'no_trial'
 *
 * @param {{ ai_enabled: boolean }|null} profile  — profiles row or null
 * @param {{ started_at: string|null, ends_at: string|null }|null} trial — pro_trials row or null
 * @param {{ status: string }|null} subscription — subscriptions row or null
 * @param {Date} now  — reference instant (server clock)
 * @returns {{ canUse: boolean, reason: 'permanent'|'subscription'|'trial'|'expired_trial'|'no_trial' }}
 */
export function evaluateProEntitlement(profile, trial, subscription, now) {
  // 1. Permanent access always wins, regardless of trial or subscription.
  if (profile?.ai_enabled === true) {
    return { canUse: true, reason: 'permanent' }
  }

  // 2. Active Stripe subscription — 'past_due' included (dunning window; Stripe
  //    retries the charge and reverts to 'active' on success or 'canceled'/'unpaid'
  //    on final failure). Access is preserved during this window.
  const subStatus = subscription?.status
  if (subStatus === 'active' || subStatus === 'past_due') {
    return { canUse: true, reason: 'subscription' }
  }

  // 3–5: Trial state.
  // No trial row or unstarted eligible row — no access.
  if (!trial || !trial.started_at || !trial.ends_at) {
    return { canUse: false, reason: 'no_trial' }
  }

  // Parse ends_at — guard against malformed strings.
  const endsAt = new Date(trial.ends_at)
  if (isNaN(endsAt.getTime())) {
    return { canUse: false, reason: 'no_trial' }
  }

  // 3. Active trial.
  if (endsAt > now) {
    return { canUse: true, reason: 'trial' }
  }

  // 4. Expired trial.
  return { canUse: false, reason: 'expired_trial' }
}

/**
 * Runs a single Supabase query promise and catches any thrown exception.
 * Returns the standard { data, error } shape in all cases — never rejects.
 *
 * This wrapper makes it safe to combine multiple queries with Promise.all:
 * because each query is individually wrapped, Promise.all sees three always-
 * resolving promises and cannot itself reject from a query failure.
 *
 * @param {Promise<{ data: any, error: any }>} queryPromise
 * @returns {Promise<{ data: any, error: any }>}
 */
async function safeQuery(queryPromise) {
  try {
    return await queryPromise
  } catch (e) {
    return { data: null, error: e }
  }
}

/**
 * Loads the profile, trial, and subscription rows for the given user.
 *
 * Uses the service-role client (bypasses RLS) to make the authoritative read.
 * No user-supplied user_id is trusted — the caller must derive userId from
 * a verified auth token before calling this function.
 *
 * All three queries run concurrently via Promise.all. Each query is individually
 * wrapped by safeQuery so a thrown exception is caught and mapped to an error
 * flag. The outer Promise.all cannot reject.
 *
 * subscriptionError is non-fatal: a failed subscription query is logged but
 * does not block permanent or trial users. A subscribed-only user whose
 * subscription query fails will temporarily receive a 403 (not a silent grant)
 * — this is rare and transient.
 *
 * Returns raw rows plus error flags. Never throws — callers check error flags.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {string} userId — verified Supabase user ID from auth token
 * @returns {Promise<{
 *   profile: { ai_enabled: boolean }|null,
 *   trial: { started_at: string|null, ends_at: string|null }|null,
 *   subscription: { status: string, current_period_end: string|null, cancel_at_period_end: boolean }|null,
 *   profileError: boolean,
 *   trialError: boolean,
 *   subscriptionError: boolean,
 *   _profileErrorCode: string|null,
 *   _trialErrorCode: string|null,
 *   _subscriptionErrorCode: string|null,
 * }>}
 */
export async function loadProEntitlement(supabaseAdmin, userId) {
  // All three queries are started concurrently. safeQuery catches any thrown
  // exception from any query, so Promise.all cannot reject.
  // Latency = max(profileLatency, trialLatency, subscriptionLatency), not their sum.
  const [profileResult, trialResult, subscriptionResult] = await Promise.all([
    safeQuery(
      supabaseAdmin
        .from('profiles')
        .select('ai_enabled')
        .eq('id', userId)
        .maybeSingle()
    ),
    safeQuery(
      supabaseAdmin
        .from('pro_trials')
        .select('started_at, ends_at')
        .eq('user_id', userId)
        .maybeSingle()
    ),
    safeQuery(
      supabaseAdmin
        .from('subscriptions')
        .select('status, current_period_end, cancel_at_period_end')
        .eq('user_id', userId)
        .maybeSingle()
    ),
  ])

  return {
    profile:                profileResult.data      ?? null,
    trial:                  trialResult.data        ?? null,
    subscription:           subscriptionResult.data ?? null,
    profileError:           Boolean(profileResult.error),
    trialError:             Boolean(trialResult.error),
    subscriptionError:      Boolean(subscriptionResult.error),
    // Privacy-safe error codes for diagnostic logging.
    // Never log .message or full error objects which may contain PII.
    _profileErrorCode:      profileResult.error?.code      ?? null,
    _trialErrorCode:        trialResult.error?.code        ?? null,
    _subscriptionErrorCode: subscriptionResult.error?.code ?? null,
  }
}
