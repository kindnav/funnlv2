// Pure activation/onboarding helpers — no React/Supabase deps.
// Safe to unit-test in plain Node.js.
//
// Design spec: 09 Onboarding.dc.html, 14 Dashboard.dc.html
// The funnel mark IS the progress indicator: fills bottom-up via clip-path.

// ── Display mode constants ────────────────────────────────────────────────────

export const DISPLAY_MODES = Object.freeze({
  LOADING:         'loading',          // Fetch in progress — never show activation UI
  UNAVAILABLE:     'unavailable',      // Query error — show safe fallback, not activation UI
  WELCOME:         'welcome',          // Zero contacts, first-run welcome card
  COMPACT:         'compact',          // Has data, activation incomplete, strip visible
  COLLAPSED:       'collapsed',        // Strip dismissed — show collapsed icon only
  NEWLY_COMPLETED: 'newly_completed',  // Activation just completed in this session
  HIDDEN_COMPLETE: 'hidden_complete',  // Already complete from prior session
  NORMAL_HOME:     'normal_home',      // Welcome skipped or catch-all settled state
})

// ── Funnel fill constants ─────────────────────────────────────────────────────

// clip-path inset values for 0–3 steps complete.
// 0 steps → inset(100% 0 0 0) (empty funnel), 3 steps → inset(0% 0 0 0) (full).
export const FUNNEL_INSET_PCT = [100, 67, 33, 0]

export function getFunnelInset(stepsCompleted) {
  const n = Math.max(0, Math.min(3, Math.floor(stepsCompleted)))
  return `inset(${FUNNEL_INSET_PCT[n]}% 0 0 0)`
}

// ── Storage keys ──────────────────────────────────────────────────────────────

// sessionStorage: strip dismissal — resets each browser session.
// Versioned so we can invalidate on schema changes.
export function sessionDismissKey(uid) { return `funnl_ob_dismissed_${uid}_v1` }
export const stripDismissKey = sessionDismissKey  // canonical alias

// localStorage: welcome card "Skip, just look around" — persists across sessions.
// User made a deliberate choice; should not re-show every session.
// localStorage is correct here (vs sessionStorage) because the skip reflects
// a deliberate user decision that should survive tab/browser restarts.
export function welcomeSkipKey(uid) { return `funnl_onboarding_welcome_v1_${uid}` }

// sessionStorage: completion strip session flag.
// CompletionStrip shows only in the session where activation completes.
// sessionStorage is correct: new session = clean slate, celebration done.
export function completionSessionKey(uid) { return `funnl_activation_completion_v1_${uid}` }

// ── Safe storage accessors ────────────────────────────────────────────────────

// Returns false on SSR, SecurityError, or missing key.
export function readSessionFlag(key) {
  try { return sessionStorage.getItem(key) === '1' } catch { return false }
}

export function writeSessionFlag(key) {
  try { sessionStorage.setItem(key, '1') } catch { /* storage unavailable — no-op */ }
}

export function clearSessionFlag(key) {
  try { sessionStorage.removeItem(key) } catch { /* storage unavailable — no-op */ }
}

// Returns false on SSR, SecurityError, or missing key.
export function readLocalFlag(key) {
  try { return localStorage.getItem(key) === '1' } catch { return false }
}

export function writeLocalFlag(key) {
  try { localStorage.setItem(key, '1') } catch { /* storage unavailable — no-op */ }
}

export function clearLocalFlag(key) {
  try { localStorage.removeItem(key) } catch { /* storage unavailable — no-op */ }
}

// ── Step derivation helpers ───────────────────────────────────────────────────

// Returns the next incomplete activation action, or null if all done.
// action: 'add' | 'log' | 'followup'
export function getNextAction(step1Done, step2Done, step3Done) {
  if (!step1Done) return { step: 1, label: 'Add contacts', action: 'add' }
  if (!step2Done) return { step: 2, label: 'Log a conversation', action: 'log' }
  if (!step3Done) return { step: 3, label: 'Set a follow-up', action: 'followup' }
  return null
}

// Returns heading + doneParts + nextStep for the progress strip.
// doneParts: string[] of completed step labels (checkmarks added in JSX).
// nextStep: string label of the remaining step, or null if all done.
export function buildStepSummary(step1Done, step2Done, step3Done) {
  const stepsCompleted = [step1Done, step2Done, step3Done].filter(Boolean).length
  const headings = ['Get started', 'One of three steps done', 'Two of three steps done']
  const heading = headings[Math.min(stepsCompleted, 2)]
  const doneParts = [
    step1Done ? 'contacts added' : null,
    step2Done ? 'conversation logged' : null,
    step3Done ? 'follow-up set' : null,
  ].filter(Boolean)
  const nextStep = !step1Done
    ? 'add 5 contacts'
    : !step2Done
      ? 'log a conversation'
      : !step3Done
        ? 'set a follow-up'
        : null
  return { heading, doneParts, nextStep }
}

// Builds the accessible ARIA label string for the progressbar element.
// Identifies: completed milestones, remaining, next action.
export function buildProgressAriaLabel(step1Done, step2Done, step3Done) {
  const completedCount = [step1Done, step2Done, step3Done].filter(Boolean).length
  const doneParts = [
    step1Done ? '5 contacts added' : null,
    step2Done ? 'conversation logged' : null,
    step3Done ? 'follow-up scheduled' : null,
  ].filter(Boolean)
  const done = doneParts.length > 0 ? `Completed: ${doneParts.join(', ')}. ` : ''
  const next = !step1Done
    ? 'Next: add 5 contacts.'
    : !step2Done
      ? 'Next: log a conversation.'
      : !step3Done
        ? 'Next: set a follow-up.'
        : ''
  return `Setup progress: ${completedCount} of 3 steps done. ${done}${next}`.trim()
}

// ── Milestone write logic (pure) ──────────────────────────────────────────────

// Pure: computes which milestone steps are currently met by live data.
// Does NOT consult stored timestamps — those are checked separately.
export function computeMilestoneSteps(contactCnt, hasInteraction, hasFollowUp) {
  return {
    step1Met: (contactCnt ?? 0) >= 5,
    step2Met: hasInteraction === true || (typeof hasInteraction === 'number' && hasInteraction >= 1),
    step3Met: hasFollowUp === true,
  }
}

// Pure predicate: which DB writes should be attempted given live data and stored timestamps.
// Returns { step1, step2, step3, completion } — booleans.
// The actual Supabase writes happen in recordMilestones inside DashboardPage.
// This function is safe to unit-test in isolation.
export function shouldAttemptMilestoneWrites(contactCnt, hasInteraction, hasFollowUp, ms) {
  const { step1Met, step2Met, step3Met } = computeMilestoneSteps(contactCnt, hasInteraction, hasFollowUp)
  const fiveContactsNull     = ms == null || ms.fiveContacts == null
  const firstInteractionNull = ms == null || ms.firstInteraction == null
  const firstFollowupNull    = ms == null || ms.firstFollowup == null
  const completedNull        = ms == null || ms.completed == null
  return {
    step1:      step1Met && fiveContactsNull,
    step2:      step2Met && firstInteractionNull,
    step3:      step3Met && firstFollowupNull,
    completion: step1Met && step2Met && step3Met && completedNull,
  }
}

// ── Full activation derivation ────────────────────────────────────────────────

/**
 * Derives the complete activation display state from raw, confirmed data.
 *
 * Authority rules:
 *   1. Stored milestone timestamps are authoritative — if set, the step is done
 *      regardless of current live counts (handles deletion, retroactive data, etc.).
 *   2. Live data backfills unset timestamps for immediate display feedback.
 *   3. Loading is NOT incomplete — never show activation UI while loading.
 *   4. Query failure is NOT zero — never show welcome card after a fetch error.
 *   5. Already-completed accounts never show onboarding UI on a new session.
 *   6. Newly completed accounts show CompletionStrip only in the completion session.
 *
 * @param {object} params
 * @param {object|null}  params.milestones      { fiveContacts, firstInteraction, firstFollowup, completed } or null
 * @param {number|null}  params.contactCount     Live count; null = not yet loaded
 * @param {boolean|null} params.hasInteraction   true/false; null = not yet loaded
 * @param {boolean|null} params.hasFollowUp      true/false; null = not yet loaded
 * @param {boolean}      params.loading          Fetch in progress
 * @param {boolean}      params.queryError       At least one query failed
 * @param {boolean}      params.welcomeSkipped   User clicked "Skip" on welcome card
 * @param {boolean}      params.stripDismissed   User dismissed the strip this session
 * @param {boolean}      params.justCompleted    Activation completed in this session
 * @returns {{
 *   displayMode: string,
 *   contactsComplete: boolean,
 *   interactionComplete: boolean,
 *   followupComplete: boolean,
 *   completedCount: number,
 *   progressPercent: number,
 *   nextAction: {step:number,label:string,action:string}|null,
 *   isComplete: boolean,
 *   isEmpty: boolean,
 * }}
 */
export function deriveActivationState({
  milestones = null,
  contactCount = null,
  hasInteraction = null,
  hasFollowUp = null,
  loading = false,
  queryError = false,
  welcomeSkipped = false,
  stripDismissed = false,
  justCompleted = false,
} = {}) {
  const EMPTY = {
    contactsComplete: false, interactionComplete: false, followupComplete: false,
    completedCount: 0, progressPercent: 0, nextAction: null, isComplete: false, isEmpty: false,
  }

  if (loading)     return { ...EMPTY, displayMode: DISPLAY_MODES.LOADING }
  if (queryError)  return { ...EMPTY, displayMode: DISPLAY_MODES.UNAVAILABLE }

  // Milestone timestamp is authoritative; backfill from live data if null.
  const ms = milestones ?? {}
  const contactsComplete    = ms.fiveContacts    != null ? true : (contactCount ?? 0) >= 5
  const interactionComplete = ms.firstInteraction != null ? true : hasInteraction === true
  const followupComplete    = ms.firstFollowup   != null ? true : hasFollowUp === true

  const completedCount  = [contactsComplete, interactionComplete, followupComplete].filter(Boolean).length
  const progressPercent = Math.round((completedCount / 3) * 100)

  // isComplete: timestamp wins, OR all three live steps are confirmed done.
  const isComplete = ms.completed != null
    || (contactsComplete && interactionComplete && followupComplete)

  // dataResolved: all three primary data sources have returned explicit values.
  // null means the source has not yet resolved — do NOT treat null as zero.
  // This prevents unresolved data from triggering the welcome card.
  const dataResolved = contactCount !== null && hasInteraction !== null && hasFollowUp !== null

  // True first-run: all data is confirmed to be zero/false. Requires explicit resolution.
  // If any source is null (still loading or unknown), isEmpty is false — safe fallback.
  const isEmpty = dataResolved
    && contactCount === 0
    && hasInteraction === false
    && hasFollowUp === false
    && ms.completed == null

  const nextAction = getNextAction(contactsComplete, interactionComplete, followupComplete)

  // ── Display mode priority order ────────────────────────────────────────────
  // Priority (highest → lowest):
  //   1. loading       — fetch in progress; no activation UI
  //   2. unavailable   — query failed; safe fallback only
  //   3. newly_completed — just completed this session; beats hidden_complete
  //   4. hidden_complete  — completed in a prior session
  //   5. welcome       — confirmed zero data; first-run card
  //   6. collapsed     — strip dismissed; show reopen control only
  //   7. compact       — has data, incomplete, strip visible
  //   8. normal_home   — welcome skipped, or settled catch-all

  // 3. justCompleted wins over hidden_complete (both can be true when newly completed)
  if (justCompleted) return {
    displayMode: DISPLAY_MODES.NEWLY_COMPLETED,
    contactsComplete, interactionComplete, followupComplete,
    completedCount: 3, progressPercent: 100, nextAction: null, isComplete: true, isEmpty: false,
  }

  // 4. Already complete from a prior session — no onboarding UI
  if (isComplete) return {
    displayMode: DISPLAY_MODES.HIDDEN_COMPLETE,
    contactsComplete, interactionComplete, followupComplete,
    completedCount, progressPercent, nextAction: null, isComplete: true, isEmpty: false,
  }

  // 5. First-run welcome: confirmed zero data, not skipped, not complete
  if (isEmpty && !welcomeSkipped) return {
    displayMode: DISPLAY_MODES.WELCOME,
    contactsComplete, interactionComplete, followupComplete,
    completedCount: 0, progressPercent: 0, nextAction, isComplete: false, isEmpty: true,
  }

  // 6. Collapsed: incomplete and strip explicitly dismissed this session
  if (!isComplete && stripDismissed) return {
    displayMode: DISPLAY_MODES.COLLAPSED,
    contactsComplete, interactionComplete, followupComplete,
    completedCount, progressPercent, nextAction, isComplete: false, isEmpty: false,
  }

  // 7. Compact: has confirmed contacts, incomplete, strip visible
  if (!isComplete && contactCount !== null && contactCount > 0 && !stripDismissed) return {
    displayMode: DISPLAY_MODES.COMPACT,
    contactsComplete, interactionComplete, followupComplete,
    completedCount, progressPercent, nextAction, isComplete: false, isEmpty: false,
  }

  // 8. Normal home: welcome skipped (no data), unresolved data, or settled catch-all
  return {
    displayMode: DISPLAY_MODES.NORMAL_HOME,
    contactsComplete, interactionComplete, followupComplete,
    completedCount, progressPercent, nextAction, isComplete: false, isEmpty,
  }
}

// ── Name helpers ──────────────────────────────────────────────────────────────

// Extracts the first name from profile display_name for a personalized greeting.
// Returns null if no usable name — caller falls back to generic "Welcome to Funnl."
// Never returns an email address (no @ check needed since display_name is a user-set label,
// not an email field, but we guard against it anyway).
export function getFirstName(displayName) {
  if (!displayName || typeof displayName !== 'string') return null
  const trimmed = displayName.trim()
  if (!trimmed) return null
  // Reject email-shaped values so they never appear in a greeting
  if (trimmed.includes('@')) return null
  return trimmed.split(/\s+/)[0]
}

// ── Legacy compatibility export ───────────────────────────────────────────────

// Kept for backward compatibility with tests that test this function directly.
// New code uses deriveActivationState instead.
// Return values: 'welcome', 'newly_completed', 'hidden_complete', 'collapsed', 'compact'
export function computeDisplayMode({
  contactCount,
  stepsCompleted,
  milestonesCompleted,
  stripDismissed,
  justCompleted,
}) {
  if (contactCount === 0) return 'welcome'
  if (justCompleted) return 'newly_completed'
  if (milestonesCompleted) return 'hidden_complete'
  if (stepsCompleted >= 3) return 'hidden_complete'
  if (stripDismissed) return 'collapsed'
  return 'compact'
}
