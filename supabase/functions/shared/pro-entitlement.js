// Server-side Pro entitlement logic shared across all four AI Edge Functions.
//
// This file has zero imports — it is safe to test in Node.js without a Deno
// or Supabase environment. Both exports are pure or dependency-injected.
//
// SERVER-SIDE SEAM: this shared helper is the authoritative entitlement
// enforcement layer inside Edge Functions. The frontend seam (canUseAI() in
// src/lib/ai.js) is cosmetic only — it gates UI, not API access.
//
// When Stripe is added (Layer D), both seams need coordinated updates:
//   - Edge Functions: update loadProEntitlement / evaluateProEntitlement
//     to check subscription status in addition to ai_enabled and pro_trials.
//   - Frontend: update canUseAI() to reflect the new entitlement shape.

/**
 * Pure Pro entitlement evaluation given raw DB row values and a reference instant.
 *
 * Priority rules (permanent always wins):
 *   1. profile.ai_enabled = true   → canUse: true,  reason: 'permanent'
 *   2. active trial (started + !expired) → canUse: true,  reason: 'trial'
 *   3. expired trial               → canUse: false, reason: 'expired_trial'
 *   4. eligible trial (not started) → canUse: false, reason: 'no_trial'
 *   5. no trial row / no profile   → canUse: false, reason: 'no_trial'
 *
 * @param {{ ai_enabled: boolean }|null} profile  — profiles row or null
 * @param {{ started_at: string|null, ends_at: string|null }|null} trial — pro_trials row or null
 * @param {Date} now  — reference instant (server clock)
 * @returns {{ canUse: boolean, reason: 'permanent'|'trial'|'expired_trial'|'no_trial' }}
 */
export function evaluateProEntitlement(profile, trial, now) {
  // Permanent access always wins, regardless of trial row.
  if (profile?.ai_enabled === true) {
    return { canUse: true, reason: 'permanent' }
  }

  // No trial row or unstarted eligible row — no access.
  if (!trial || !trial.started_at || !trial.ends_at) {
    return { canUse: false, reason: 'no_trial' }
  }

  // Parse ends_at — guard against malformed strings.
  const endsAt = new Date(trial.ends_at)
  if (isNaN(endsAt.getTime())) {
    return { canUse: false, reason: 'no_trial' }
  }

  // Active trial
  if (endsAt > now) {
    return { canUse: true, reason: 'trial' }
  }

  // Expired trial
  return { canUse: false, reason: 'expired_trial' }
}

/**
 * Runs a single Supabase query promise and catches any thrown exception.
 * Returns the standard { data, error } shape in all cases — never rejects.
 *
 * This wrapper makes it safe to combine multiple queries with Promise.all:
 * because each query is individually wrapped, Promise.all sees two always-
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
 * Loads the profile and trial rows for the given user from the database.
 *
 * Uses the service-role client (bypasses RLS) to make the authoritative read.
 * No user-supplied user_id is trusted — the caller must derive userId from
 * a verified auth token before calling this function.
 *
 * Both queries run concurrently via Promise.all. Each query is individually
 * wrapped by safeQuery so a thrown exception (network error, SDK bug) is
 * caught and mapped to an error flag. The outer Promise.all cannot reject.
 *
 * Returns raw rows plus error flags. Never throws — callers check error flags.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {string} userId — verified Supabase user ID from auth token
 * @returns {Promise<{
 *   profile: { ai_enabled: boolean }|null,
 *   trial: { started_at: string|null, ends_at: string|null }|null,
 *   profileError: boolean,
 *   trialError: boolean,
 *   _profileErrorCode: string|null,
 *   _trialErrorCode: string|null,
 * }>}
 */
export async function loadProEntitlement(supabaseAdmin, userId) {
  // Both queries are started concurrently. safeQuery catches any thrown
  // exception from either query, so Promise.all cannot reject.
  // Latency = max(profileLatency, trialLatency), not their sum.
  const [profileResult, trialResult] = await Promise.all([
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
  ])

  return {
    profile:           profileResult.data ?? null,
    trial:             trialResult.data   ?? null,
    profileError:      Boolean(profileResult.error),
    trialError:        Boolean(trialResult.error),
    // Privacy-safe error codes for diagnostic logging.
    // Never log .message or full error objects which may contain PII.
    _profileErrorCode: profileResult.error?.code ?? null,
    _trialErrorCode:   trialResult.error?.code   ?? null,
  }
}
