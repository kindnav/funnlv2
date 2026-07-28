// Pure helpers for the 7-day Pro trial.
// No Supabase imports, no React imports — safe to import in Node.js test files.
//
// The Supabase-calling functions (canUseAI, getTrialStatus) live in ai.js
// and delegate to these pure functions.

/**
 * Returns true when the trial row represents an active trial as of `now`.
 *
 * @param {object|null} trial - { started_at: string|null, ends_at: string|null } or null
 * @param {Date} [now] - reference instant (defaults to current time)
 * @returns {boolean}
 */
export function isTrialActive(trial, now = new Date()) {
  if (!trial?.started_at || !trial?.ends_at) return false
  return new Date(trial.ends_at) > now
}

/**
 * Computes full trial status from a trial row and a reference instant.
 *
 * Return shape:
 *   eligible    boolean  — row exists with started_at IS NULL (not yet activated)
 *   active      boolean  — trial is currently running
 *   expired     boolean  — trial was started but has ended
 *   daysRemaining number — calendar days left, ceil-rounded (0 when not active)
 *   endsAt      string|null — ISO timestamp of trial end (null when no trial started)
 *
 * @param {object|null} trial - { started_at: string|null, ends_at: string|null } or null
 * @param {Date} now - reference instant
 * @returns {{eligible:boolean,active:boolean,expired:boolean,daysRemaining:number,endsAt:string|null}}
 */
export function computeTrialStatus(trial, now) {
  if (!trial) {
    return { eligible: false, active: false, expired: false, daysRemaining: 0, endsAt: null }
  }
  if (!trial.started_at) {
    // Row exists but trial not yet started (email not yet confirmed, or edge case)
    return { eligible: true, active: false, expired: false, daysRemaining: 0, endsAt: null }
  }
  const ends = new Date(trial.ends_at)
  const active = ends > now
  const expired = !active
  const daysRemaining = active
    ? Math.ceil((ends - now) / (1000 * 60 * 60 * 24))
    : 0
  return { eligible: false, active, expired, daysRemaining, endsAt: trial.ends_at }
}
