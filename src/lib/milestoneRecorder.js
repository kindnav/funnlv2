/**
 * milestoneRecorder.js — pure, injectable activation milestone coordinator.
 *
 * Orchestrates the sequence of conditional DB writes and analytics events
 * for activation milestones. All external dependencies are injected so the
 * module is testable in plain Node.js without React or Supabase.
 *
 * Used by DashboardPage.recordMilestones.
 *
 * Key invariants:
 *   1. Uses shouldAttemptMilestoneWrites (single source of truth) to decide
 *      which writes to attempt — not inline boolean conditions.
 *   2. Tracks an effectiveMs object updated as each claim succeeds.
 *      The completion attempt is re-verified against effectiveMs so a
 *      race-loser on an individual step does not trigger a spurious completion.
 *   3. A failed DB mutation (ok: false) aborts the coordinator immediately.
 *   4. Analytics and callbacks fire only when claimed: true.
 *   5. Completion callbacks fire only after all three individual steps are
 *      confirmed effective (either pre-existing or just claimed).
 */

import { shouldAttemptMilestoneWrites } from './activationHelpers.js'

/**
 * Run the milestone coordinator.
 *
 * @param {object} params
 * @param {number}        params.contactCnt       Live contact count
 * @param {number|boolean} params.interactionCnt  Interaction count or boolean
 * @param {boolean}       params.hasFollowUpBool  Whether any follow-up exists
 * @param {object|null}   params.ms               Current milestone timestamps
 * @param {string}        params.now              ISO timestamp for this run
 * @param {Function}      params.conditionalUpdate async (col) => { ok, claimed }
 * @param {Function}      params.onStepClaimed    (step, effectiveMs) => void
 * @param {Function}      params.onCompletionClaimed (now) => void
 */
export async function runMilestoneRecorder({
  contactCnt,
  interactionCnt,
  hasFollowUpBool,
  ms,
  now,
  conditionalUpdate,
  onStepClaimed,
  onCompletionClaimed,
}) {
  const attempts = shouldAttemptMilestoneWrites(contactCnt, interactionCnt, hasFollowUpBool, ms)

  // effectiveMs: starts as a copy of stored timestamps, then updated as each
  // claim succeeds in this run. Used to guard the completion attempt so that
  // a race-loser on an individual step does not produce a spurious completion.
  const effectiveMs = ms != null
    ? { ...ms }
    : { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null }

  if (attempts.step1) {
    const { ok, claimed } = await conditionalUpdate('activation_five_contacts_at')
    if (!ok) return
    if (claimed) {
      effectiveMs.fiveContacts = now
      onStepClaimed('five_contacts', effectiveMs)
    }
  }

  if (attempts.step2) {
    const { ok, claimed } = await conditionalUpdate('activation_first_interaction_at')
    if (!ok) return
    if (claimed) {
      effectiveMs.firstInteraction = now
      onStepClaimed('first_interaction', effectiveMs)
    }
  }

  if (attempts.step3) {
    const { ok, claimed } = await conditionalUpdate('activation_first_followup_at')
    if (!ok) return
    if (claimed) {
      effectiveMs.firstFollowup = now
      onStepClaimed('first_followup', effectiveMs)
    }
  }

  if (attempts.completion) {
    // Re-verify against effectiveMs before attempting the completion write.
    // If any individual step was a race-loser (claimed=false), its effectiveMs
    // entry is still null, and we skip completion. The next fetchAll will see
    // all timestamps set and correctly attempt completion then.
    const allEffectivelyDone = effectiveMs.fiveContacts !== null
      && effectiveMs.firstInteraction !== null
      && effectiveMs.firstFollowup !== null
      && effectiveMs.completed === null

    if (!allEffectivelyDone) return

    const { ok, claimed } = await conditionalUpdate('activation_completed_at')
    if (!ok) return
    if (claimed) onCompletionClaimed(now)
  }
}
