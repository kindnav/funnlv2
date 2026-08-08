/**
 * activation-helpers.test.js
 *
 * Pure unit tests for src/lib/activationHelpers.js.
 * No React, no DOM, no Supabase.
 *
 * Run with: node tests/activation-helpers.test.js
 */
import assert from 'assert'
import {
  DISPLAY_MODES,
  FUNNEL_INSET_PCT,
  getFunnelInset,
  computeDisplayMode,
  deriveActivationState,
  getNextAction,
  buildStepSummary,
  buildProgressAriaLabel,
  computeMilestoneSteps,
  shouldAttemptMilestoneWrites,
  getFirstName,
  sessionDismissKey,
  stripDismissKey,
  welcomeSkipKey,
  completionSessionKey,
  readSessionFlag,
  writeSessionFlag,
  clearSessionFlag,
  readLocalFlag,
  writeLocalFlag,
  clearLocalFlag,
} from '../src/lib/activationHelpers.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗  ${name}`)
    console.log(`       ${e.message}`)
    failed++
  }
}

// ── DISPLAY_MODES constants ───────────────────────────────────────────────────

console.log('\nDISPLAY_MODES')

test('DISPLAY_MODES.LOADING = "loading"', () => {
  assert.strictEqual(DISPLAY_MODES.LOADING, 'loading')
})
test('DISPLAY_MODES.UNAVAILABLE = "unavailable"', () => {
  assert.strictEqual(DISPLAY_MODES.UNAVAILABLE, 'unavailable')
})
test('DISPLAY_MODES.WELCOME = "welcome"', () => {
  assert.strictEqual(DISPLAY_MODES.WELCOME, 'welcome')
})
test('DISPLAY_MODES.COMPACT = "compact"', () => {
  assert.strictEqual(DISPLAY_MODES.COMPACT, 'compact')
})
test('DISPLAY_MODES.COLLAPSED = "collapsed"', () => {
  assert.strictEqual(DISPLAY_MODES.COLLAPSED, 'collapsed')
})
test('DISPLAY_MODES.NEWLY_COMPLETED = "newly_completed"', () => {
  assert.strictEqual(DISPLAY_MODES.NEWLY_COMPLETED, 'newly_completed')
})
test('DISPLAY_MODES.HIDDEN_COMPLETE = "hidden_complete"', () => {
  assert.strictEqual(DISPLAY_MODES.HIDDEN_COMPLETE, 'hidden_complete')
})
test('DISPLAY_MODES.NORMAL_HOME = "normal_home"', () => {
  assert.strictEqual(DISPLAY_MODES.NORMAL_HOME, 'normal_home')
})
test('DISPLAY_MODES is frozen (immutable)', () => {
  assert.ok(Object.isFrozen(DISPLAY_MODES))
})
test('DISPLAY_MODES has exactly 8 keys', () => {
  assert.strictEqual(Object.keys(DISPLAY_MODES).length, 8)
})

// ── FUNNEL_INSET_PCT ──────────────────────────────────────────────────────────

console.log('\nFUNNEL_INSET_PCT constants')

test('has exactly 4 entries', () => {
  assert.strictEqual(FUNNEL_INSET_PCT.length, 4)
})
test('index 0 = 100 (empty funnel)', () => {
  assert.strictEqual(FUNNEL_INSET_PCT[0], 100)
})
test('index 1 = 67 (1/3 done)', () => {
  assert.strictEqual(FUNNEL_INSET_PCT[1], 67)
})
test('index 2 = 33 (2/3 done)', () => {
  assert.strictEqual(FUNNEL_INSET_PCT[2], 33)
})
test('index 3 = 0 (full funnel)', () => {
  assert.strictEqual(FUNNEL_INSET_PCT[3], 0)
})

// ── getFunnelInset ────────────────────────────────────────────────────────────

console.log('\ngetFunnelInset')

test('0 steps → inset(100% 0 0 0)', () => {
  assert.strictEqual(getFunnelInset(0), 'inset(100% 0 0 0)')
})
test('1 step → inset(67% 0 0 0)', () => {
  assert.strictEqual(getFunnelInset(1), 'inset(67% 0 0 0)')
})
test('2 steps → inset(33% 0 0 0)', () => {
  assert.strictEqual(getFunnelInset(2), 'inset(33% 0 0 0)')
})
test('3 steps → inset(0% 0 0 0)', () => {
  assert.strictEqual(getFunnelInset(3), 'inset(0% 0 0 0)')
})
test('negative clamps to 0', () => {
  assert.strictEqual(getFunnelInset(-1), 'inset(100% 0 0 0)')
})
test('value > 3 clamps to 3', () => {
  assert.strictEqual(getFunnelInset(5), 'inset(0% 0 0 0)')
})
test('float rounds down — 1.9 treated as 1', () => {
  assert.strictEqual(getFunnelInset(1.9), 'inset(67% 0 0 0)')
})

// ── computeDisplayMode (legacy — keep OLD return values for backward compat) ──

console.log('\ncomputeDisplayMode (legacy)')

const base = { contactCount: 0, stepsCompleted: 0, milestonesCompleted: false, stripDismissed: false, justCompleted: false }

test('contactCount=0 → welcome (always wins)', () => {
  assert.strictEqual(computeDisplayMode(base), 'welcome')
})
test('contactCount=0 even when justCompleted → welcome', () => {
  assert.strictEqual(computeDisplayMode({ ...base, justCompleted: true }), 'welcome')
})
test('justCompleted=true, contactCount>0 → newly_completed', () => {
  assert.strictEqual(computeDisplayMode({ ...base, contactCount: 5, justCompleted: true }), 'newly_completed')
})
test('milestonesCompleted=true, contactCount>0 → hidden_complete', () => {
  assert.strictEqual(computeDisplayMode({ ...base, contactCount: 5, milestonesCompleted: true }), 'hidden_complete')
})
test('stepsCompleted=3, contactCount>0 → hidden_complete', () => {
  assert.strictEqual(computeDisplayMode({ ...base, contactCount: 5, stepsCompleted: 3 }), 'hidden_complete')
})
test('stripDismissed=true, contactCount>0, steps<3 → collapsed', () => {
  assert.strictEqual(computeDisplayMode({ ...base, contactCount: 5, stripDismissed: true }), 'collapsed')
})
test('default with contacts and incomplete steps → compact', () => {
  assert.strictEqual(computeDisplayMode({ ...base, contactCount: 3, stepsCompleted: 1 }), 'compact')
})
test('priority: justCompleted beats milestonesCompleted', () => {
  assert.strictEqual(
    computeDisplayMode({ ...base, contactCount: 5, justCompleted: true, milestonesCompleted: true }),
    'newly_completed'
  )
})
test('priority: milestonesCompleted beats collapsed', () => {
  assert.strictEqual(
    computeDisplayMode({ ...base, contactCount: 5, milestonesCompleted: true, stripDismissed: true }),
    'hidden_complete'
  )
})
test('priority: collapsed beats compact', () => {
  assert.strictEqual(
    computeDisplayMode({ ...base, contactCount: 5, stepsCompleted: 2, stripDismissed: true }),
    'collapsed'
  )
})

// ── getNextAction ─────────────────────────────────────────────────────────────

console.log('\ngetNextAction')

test('all false → step 1 / add', () => {
  const r = getNextAction(false, false, false)
  assert.deepStrictEqual(r, { step: 1, label: 'Add contacts', action: 'add' })
})
test('step1 done → step 2 / log', () => {
  const r = getNextAction(true, false, false)
  assert.deepStrictEqual(r, { step: 2, label: 'Log a conversation', action: 'log' })
})
test('step1+2 done → step 3 / followup', () => {
  const r = getNextAction(true, true, false)
  assert.deepStrictEqual(r, { step: 3, label: 'Set a follow-up', action: 'followup' })
})
test('all done → null', () => {
  assert.strictEqual(getNextAction(true, true, true), null)
})

// ── buildStepSummary ──────────────────────────────────────────────────────────

console.log('\nbuildStepSummary')

test('no steps done: heading = Get started', () => {
  const s = buildStepSummary(false, false, false)
  assert.strictEqual(s.heading, 'Get started')
})
test('no steps done: doneParts is empty', () => {
  const s = buildStepSummary(false, false, false)
  assert.deepStrictEqual(s.doneParts, [])
})
test('no steps done: nextStep = add 5 contacts', () => {
  const s = buildStepSummary(false, false, false)
  assert.strictEqual(s.nextStep, 'add 5 contacts')
})
test('1 step done: heading = One of three steps done', () => {
  const s = buildStepSummary(true, false, false)
  assert.strictEqual(s.heading, 'One of three steps done')
})
test('1 step done: doneParts includes contacts added', () => {
  const s = buildStepSummary(true, false, false)
  assert.ok(s.doneParts.includes('contacts added'))
})
test('1 step done: nextStep = log a conversation', () => {
  const s = buildStepSummary(true, false, false)
  assert.strictEqual(s.nextStep, 'log a conversation')
})
test('2 steps done: heading = Two of three steps done', () => {
  const s = buildStepSummary(true, true, false)
  assert.strictEqual(s.heading, 'Two of three steps done')
})
test('2 steps done: doneParts has 2 entries', () => {
  const s = buildStepSummary(true, true, false)
  assert.strictEqual(s.doneParts.length, 2)
})
test('2 steps done: nextStep = set a follow-up', () => {
  const s = buildStepSummary(true, true, false)
  assert.strictEqual(s.nextStep, 'set a follow-up')
})
test('all done: doneParts has 3 entries', () => {
  const s = buildStepSummary(true, true, true)
  assert.strictEqual(s.doneParts.length, 3)
})
test('all done: nextStep = null', () => {
  const s = buildStepSummary(true, true, true)
  assert.strictEqual(s.nextStep, null)
})
test('step2 only done: doneParts includes conversation logged', () => {
  const s = buildStepSummary(false, true, false)
  assert.ok(s.doneParts.includes('conversation logged'))
})
test('step3 only done: doneParts includes follow-up set', () => {
  const s = buildStepSummary(false, false, true)
  assert.ok(s.doneParts.includes('follow-up set'))
})

// ── buildProgressAriaLabel ────────────────────────────────────────────────────

console.log('\nbuildProgressAriaLabel')

test('0 steps — mentions 0 of 3', () => {
  const label = buildProgressAriaLabel(false, false, false)
  assert.ok(label.includes('0 of 3'))
})
test('0 steps — mentions add 5 contacts', () => {
  const label = buildProgressAriaLabel(false, false, false)
  assert.ok(label.toLowerCase().includes('add 5 contacts'))
})
test('1 step (contacts) — mentions 1 of 3', () => {
  const label = buildProgressAriaLabel(true, false, false)
  assert.ok(label.includes('1 of 3'))
})
test('1 step (contacts) — mentions 5 contacts added', () => {
  const label = buildProgressAriaLabel(true, false, false)
  assert.ok(label.includes('5 contacts added'))
})
test('1 step (contacts) — next is log a conversation', () => {
  const label = buildProgressAriaLabel(true, false, false)
  assert.ok(label.toLowerCase().includes('log a conversation'))
})
test('2 steps done — mentions 2 of 3', () => {
  const label = buildProgressAriaLabel(true, true, false)
  assert.ok(label.includes('2 of 3'))
})
test('2 steps done — next is set a follow-up', () => {
  const label = buildProgressAriaLabel(true, true, false)
  assert.ok(label.toLowerCase().includes('set a follow-up'))
})
test('all done — mentions 3 of 3', () => {
  const label = buildProgressAriaLabel(true, true, true)
  assert.ok(label.includes('3 of 3'))
})
test('all done — no "Next:" clause', () => {
  const label = buildProgressAriaLabel(true, true, true)
  assert.ok(!label.includes('Next:'))
})
test('returns a non-empty string', () => {
  const label = buildProgressAriaLabel(false, false, false)
  assert.ok(typeof label === 'string' && label.length > 0)
})

// ── computeMilestoneSteps ─────────────────────────────────────────────────────

console.log('\ncomputeMilestoneSteps')

test('5 contacts → step1Met true', () => {
  const r = computeMilestoneSteps(5, false, false)
  assert.strictEqual(r.step1Met, true)
})
test('4 contacts → step1Met false', () => {
  const r = computeMilestoneSteps(4, false, false)
  assert.strictEqual(r.step1Met, false)
})
test('0 contacts → step1Met false', () => {
  const r = computeMilestoneSteps(0, false, false)
  assert.strictEqual(r.step1Met, false)
})
test('null contacts → step1Met false', () => {
  const r = computeMilestoneSteps(null, false, false)
  assert.strictEqual(r.step1Met, false)
})
test('hasInteraction=true → step2Met true', () => {
  const r = computeMilestoneSteps(0, true, false)
  assert.strictEqual(r.step2Met, true)
})
test('hasInteraction=false → step2Met false', () => {
  const r = computeMilestoneSteps(0, false, false)
  assert.strictEqual(r.step2Met, false)
})
test('hasInteraction=1 (numeric) → step2Met true', () => {
  const r = computeMilestoneSteps(0, 1, false)
  assert.strictEqual(r.step2Met, true)
})
test('hasInteraction=0 (numeric) → step2Met false', () => {
  const r = computeMilestoneSteps(0, 0, false)
  assert.strictEqual(r.step2Met, false)
})
test('hasFollowUp=true → step3Met true', () => {
  const r = computeMilestoneSteps(0, false, true)
  assert.strictEqual(r.step3Met, true)
})
test('hasFollowUp=false → step3Met false', () => {
  const r = computeMilestoneSteps(0, false, false)
  assert.strictEqual(r.step3Met, false)
})

// ── shouldAttemptMilestoneWrites ──────────────────────────────────────────────

console.log('\nshouldAttemptMilestoneWrites')

const nullMs = { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null }
const fullMs = { fiveContacts: 'ts', firstInteraction: 'ts', firstFollowup: 'ts', completed: 'ts' }

test('all met, all null → all writes needed', () => {
  const r = shouldAttemptMilestoneWrites(5, true, true, nullMs)
  assert.deepStrictEqual(r, { step1: true, step2: true, step3: true, completion: true })
})
test('all met, all already written → no writes needed', () => {
  const r = shouldAttemptMilestoneWrites(5, true, true, fullMs)
  assert.deepStrictEqual(r, { step1: false, step2: false, step3: false, completion: false })
})
test('step1 met, already written → step1 false', () => {
  const ms = { ...nullMs, fiveContacts: 'ts' }
  const r = shouldAttemptMilestoneWrites(5, false, false, ms)
  assert.strictEqual(r.step1, false)
})
test('step1 not met → step1 false even if null', () => {
  const r = shouldAttemptMilestoneWrites(4, false, false, nullMs)
  assert.strictEqual(r.step1, false)
})
test('completion only when all steps met and completion null', () => {
  const r = shouldAttemptMilestoneWrites(5, true, true, nullMs)
  assert.strictEqual(r.completion, true)
})
test('completion=false when step2 not met', () => {
  const r = shouldAttemptMilestoneWrites(5, false, true, nullMs)
  assert.strictEqual(r.completion, false)
})
test('completion=false when completion already written', () => {
  const ms = { ...nullMs, completed: 'ts' }
  const r = shouldAttemptMilestoneWrites(5, true, true, ms)
  assert.strictEqual(r.completion, false)
})
test('null milestones treated as all null', () => {
  const r = shouldAttemptMilestoneWrites(5, true, true, null)
  assert.deepStrictEqual(r, { step1: true, step2: true, step3: true, completion: true })
})
test('step3 met but already written → step3 false', () => {
  const ms = { ...nullMs, firstFollowup: 'ts' }
  const r = shouldAttemptMilestoneWrites(0, false, true, ms)
  assert.strictEqual(r.step3, false)
})

// ── deriveActivationState ─────────────────────────────────────────────────────

console.log('\nderiveActivationState')

// Loading / error
test('loading=true → mode=loading', () => {
  const r = deriveActivationState({ loading: true })
  assert.strictEqual(r.displayMode, 'loading')
})
test('loading=true → all steps false', () => {
  const r = deriveActivationState({ loading: true })
  assert.strictEqual(r.contactsComplete, false)
  assert.strictEqual(r.interactionComplete, false)
  assert.strictEqual(r.followupComplete, false)
})
test('loading=true → completedCount 0', () => {
  const r = deriveActivationState({ loading: true })
  assert.strictEqual(r.completedCount, 0)
})
test('queryError=true → mode=unavailable', () => {
  const r = deriveActivationState({ queryError: true })
  assert.strictEqual(r.displayMode, 'unavailable')
})
test('queryError=true → isComplete=false (never fabricate completion from error)', () => {
  const r = deriveActivationState({ queryError: true })
  assert.strictEqual(r.isComplete, false)
})

// Welcome
test('zero contacts, no interactions, no followup → mode=welcome', () => {
  const r = deriveActivationState({
    contactCount: 0, hasInteraction: false, hasFollowUp: false,
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null },
  })
  assert.strictEqual(r.displayMode, 'welcome')
})
test('welcome: isEmpty=true', () => {
  const r = deriveActivationState({
    contactCount: 0, hasInteraction: false, hasFollowUp: false,
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null },
  })
  assert.strictEqual(r.isEmpty, true)
})
test('zero contacts + welcomeSkipped → mode=normal_home', () => {
  const r = deriveActivationState({
    contactCount: 0, hasInteraction: false, hasFollowUp: false, welcomeSkipped: true,
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null },
  })
  assert.strictEqual(r.displayMode, 'normal_home')
})
test('null contactCount + null data → normal_home (data not resolved, no welcome)', () => {
  const r = deriveActivationState({ contactCount: null, hasInteraction: null, hasFollowUp: null })
  assert.strictEqual(r.displayMode, 'normal_home')
})

// Compact
test('1 contact, no steps, strip visible → mode=compact', () => {
  const r = deriveActivationState({
    contactCount: 1, hasInteraction: false, hasFollowUp: false, stripDismissed: false,
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null },
  })
  assert.strictEqual(r.displayMode, 'compact')
})
test('compact: completedCount reflects live data', () => {
  const r = deriveActivationState({
    contactCount: 5, hasInteraction: true, hasFollowUp: false, stripDismissed: false,
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null },
  })
  assert.strictEqual(r.completedCount, 2)
})
test('compact: progressPercent rounds to 67 for 2/3 steps', () => {
  const r = deriveActivationState({
    contactCount: 5, hasInteraction: true, hasFollowUp: false, stripDismissed: false,
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null },
  })
  assert.strictEqual(r.progressPercent, 67)
})

// Collapsed
test('1 contact, strip dismissed → mode=collapsed', () => {
  const r = deriveActivationState({
    contactCount: 1, hasInteraction: false, hasFollowUp: false, stripDismissed: true,
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null },
  })
  assert.strictEqual(r.displayMode, 'collapsed')
})
test('collapsed: nextAction still set', () => {
  const r = deriveActivationState({
    contactCount: 1, hasInteraction: false, hasFollowUp: false, stripDismissed: true,
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null },
  })
  assert.ok(r.nextAction !== null)
})

// Newly completed
test('justCompleted=true → mode=newly_completed', () => {
  const r = deriveActivationState({
    contactCount: 5, hasInteraction: true, hasFollowUp: true, justCompleted: true,
    milestones: { fiveContacts: 'ts', firstInteraction: 'ts', firstFollowup: 'ts', completed: 'ts' },
  })
  assert.strictEqual(r.displayMode, 'newly_completed')
})
test('newly_completed: completedCount=3', () => {
  const r = deriveActivationState({
    contactCount: 5, hasInteraction: true, hasFollowUp: true, justCompleted: true,
    milestones: { fiveContacts: 'ts', firstInteraction: 'ts', firstFollowup: 'ts', completed: 'ts' },
  })
  assert.strictEqual(r.completedCount, 3)
})
test('newly_completed: isComplete=true', () => {
  const r = deriveActivationState({
    contactCount: 5, hasInteraction: true, hasFollowUp: true, justCompleted: true,
    milestones: { fiveContacts: 'ts', firstInteraction: 'ts', firstFollowup: 'ts', completed: 'ts' },
  })
  assert.strictEqual(r.isComplete, true)
})
test('newly_completed: nextAction=null', () => {
  const r = deriveActivationState({
    contactCount: 5, hasInteraction: true, hasFollowUp: true, justCompleted: true,
    milestones: { fiveContacts: 'ts', firstInteraction: 'ts', firstFollowup: 'ts', completed: 'ts' },
  })
  assert.strictEqual(r.nextAction, null)
})
test('justCompleted priority beats hidden_complete', () => {
  // Both justCompleted and milestones.completed set — justCompleted wins
  const r = deriveActivationState({
    contactCount: 5, hasInteraction: true, hasFollowUp: true,
    justCompleted: true,
    milestones: { fiveContacts: 'ts', firstInteraction: 'ts', firstFollowup: 'ts', completed: 'ts' },
  })
  assert.strictEqual(r.displayMode, 'newly_completed')
})

// Hidden complete
test('completed milestone set, no justCompleted → mode=hidden_complete', () => {
  const r = deriveActivationState({
    contactCount: 5, hasInteraction: true, hasFollowUp: true, justCompleted: false,
    milestones: { fiveContacts: 'ts', firstInteraction: 'ts', firstFollowup: 'ts', completed: 'ts' },
  })
  assert.strictEqual(r.displayMode, 'hidden_complete')
})
test('hidden_complete: isComplete=true', () => {
  const r = deriveActivationState({
    contactCount: 5, hasInteraction: true, hasFollowUp: true, justCompleted: false,
    milestones: { fiveContacts: 'ts', firstInteraction: 'ts', firstFollowup: 'ts', completed: 'ts' },
  })
  assert.strictEqual(r.isComplete, true)
})
test('hidden_complete: nextAction=null', () => {
  const r = deriveActivationState({
    contactCount: 5, hasInteraction: true, hasFollowUp: true, justCompleted: false,
    milestones: { fiveContacts: 'ts', firstInteraction: 'ts', firstFollowup: 'ts', completed: 'ts' },
  })
  assert.strictEqual(r.nextAction, null)
})

// Milestone timestamp authority
test('milestone timestamp overrides low live contactCount', () => {
  // Milestone says contacts done (timestamp set), but live count is only 3
  const r = deriveActivationState({
    contactCount: 3, hasInteraction: false, hasFollowUp: false, justCompleted: false,
    milestones: { fiveContacts: 'ts', firstInteraction: null, firstFollowup: null, completed: null },
  })
  assert.strictEqual(r.contactsComplete, true)
})
test('live data backfills when milestone null', () => {
  // No timestamp for contacts, but live count is 5
  const r = deriveActivationState({
    contactCount: 5, hasInteraction: false, hasFollowUp: false,
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null },
  })
  assert.strictEqual(r.contactsComplete, true)
})
test('completed timestamp triggers hidden_complete regardless of live steps', () => {
  // completed timestamp set but live data doesn't show 5 contacts
  const r = deriveActivationState({
    contactCount: 2, hasInteraction: false, hasFollowUp: false, justCompleted: false,
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: 'ts' },
  })
  assert.strictEqual(r.displayMode, 'hidden_complete')
})

// isEmpty semantics
test('isEmpty=false when contactCount > 0', () => {
  const r = deriveActivationState({ contactCount: 1 })
  assert.strictEqual(r.isEmpty, false)
})
test('isEmpty=false when queryError', () => {
  const r = deriveActivationState({ queryError: true })
  assert.strictEqual(r.isEmpty, false)
})
test('isEmpty=false when loading', () => {
  const r = deriveActivationState({ loading: true })
  assert.strictEqual(r.isEmpty, false)
})

// Default call — all params are null/false, data is unresolved → safe fallback
test('default (no args) → mode=normal_home (unresolved data is not empty)', () => {
  const r = deriveActivationState()
  assert.strictEqual(r.displayMode, 'normal_home')
})
test('default (no args) → isEmpty=false (null contactCount is not confirmed zero)', () => {
  const r = deriveActivationState()
  assert.strictEqual(r.isEmpty, false)
})

// ── isEmpty: requires all data explicitly resolved ────────────────────────────

console.log('\nisEmpty — dataResolved requirement')

test('contactCount=null → isEmpty=false (not resolved)', () => {
  const r = deriveActivationState({ contactCount: null, hasInteraction: false, hasFollowUp: false })
  assert.strictEqual(r.isEmpty, false)
})
test('hasInteraction=null → isEmpty=false (not resolved)', () => {
  const r = deriveActivationState({ contactCount: 0, hasInteraction: null, hasFollowUp: false })
  assert.strictEqual(r.isEmpty, false)
})
test('hasFollowUp=null → isEmpty=false (not resolved)', () => {
  const r = deriveActivationState({ contactCount: 0, hasInteraction: false, hasFollowUp: null })
  assert.strictEqual(r.isEmpty, false)
})
test('all null → isEmpty=false (none resolved)', () => {
  const r = deriveActivationState({ contactCount: null, hasInteraction: null, hasFollowUp: null })
  assert.strictEqual(r.isEmpty, false)
})
test('resolved zero account → isEmpty=true', () => {
  const r = deriveActivationState({
    contactCount: 0, hasInteraction: false, hasFollowUp: false,
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null },
  })
  assert.strictEqual(r.isEmpty, true)
})
test('resolved empty account → mode=welcome', () => {
  const r = deriveActivationState({
    contactCount: 0, hasInteraction: false, hasFollowUp: false,
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null },
  })
  assert.strictEqual(r.displayMode, 'welcome')
})
test('resolved contactCount=0 + hasInteraction=true → isEmpty=false (has interactions)', () => {
  const r = deriveActivationState({ contactCount: 0, hasInteraction: true, hasFollowUp: false })
  assert.strictEqual(r.isEmpty, false)
})
test('contactCount=null → mode=normal_home (safe fallback)', () => {
  const r = deriveActivationState({ contactCount: null, hasInteraction: false, hasFollowUp: false })
  assert.strictEqual(r.displayMode, 'normal_home')
})
test('all null → mode=normal_home (safe fallback)', () => {
  const r = deriveActivationState({ contactCount: null, hasInteraction: null, hasFollowUp: null })
  assert.strictEqual(r.displayMode, 'normal_home')
})

// ── Display mode priority verification ───────────────────────────────────────

console.log('\ndisplay mode priority')

test('loading beats unavailable (loading wins)', () => {
  const r = deriveActivationState({ loading: true, queryError: true })
  assert.strictEqual(r.displayMode, 'loading')
})
test('loading beats newly_completed (loading wins)', () => {
  const r = deriveActivationState({ loading: true, justCompleted: true })
  assert.strictEqual(r.displayMode, 'loading')
})
test('loading beats welcome (loading wins)', () => {
  const r = deriveActivationState({ loading: true, contactCount: 0, hasInteraction: false, hasFollowUp: false })
  assert.strictEqual(r.displayMode, 'loading')
})
test('unavailable beats newly_completed (error wins)', () => {
  const r = deriveActivationState({ queryError: true, justCompleted: true })
  assert.strictEqual(r.displayMode, 'unavailable')
})
test('newly_completed beats hidden_complete (justCompleted wins)', () => {
  // Both justCompleted and milestone.completed set — justCompleted takes priority
  const r = deriveActivationState({
    justCompleted: true,
    milestones: { fiveContacts: 'ts', firstInteraction: 'ts', firstFollowup: 'ts', completed: 'ts' },
    contactCount: 5, hasInteraction: true, hasFollowUp: true,
  })
  assert.strictEqual(r.displayMode, 'newly_completed')
})
test('hidden_complete beats welcome (completed milestone present)', () => {
  const r = deriveActivationState({
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: 'ts' },
    contactCount: 0, hasInteraction: false, hasFollowUp: false,
  })
  assert.strictEqual(r.displayMode, 'hidden_complete')
})
test('hidden_complete beats compact (completed milestone present)', () => {
  const r = deriveActivationState({
    milestones: { fiveContacts: 'ts', firstInteraction: 'ts', firstFollowup: 'ts', completed: 'ts' },
    contactCount: 5, hasInteraction: true, hasFollowUp: true, stripDismissed: false,
  })
  assert.strictEqual(r.displayMode, 'hidden_complete')
})
test('welcome beats collapsed (isEmpty + !welcomed beats dismiss)', () => {
  const r = deriveActivationState({
    contactCount: 0, hasInteraction: false, hasFollowUp: false,
    welcomeSkipped: false, stripDismissed: true,
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null },
  })
  assert.strictEqual(r.displayMode, 'welcome')
})
test('collapsed beats compact (stripDismissed=true with contact)', () => {
  const r = deriveActivationState({
    contactCount: 1, hasInteraction: false, hasFollowUp: false,
    stripDismissed: true,
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null },
  })
  assert.strictEqual(r.displayMode, 'collapsed')
})

// ── Compact requires contactCount !== null ────────────────────────────────────

console.log('\ncompact contactCount requirement')

test('compact requires contactCount !== null and > 0', () => {
  // contactCount=null, stripDismissed=false — should be normal_home not compact
  const r = deriveActivationState({
    contactCount: null, hasInteraction: true, hasFollowUp: false,
    stripDismissed: false,
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null },
  })
  assert.notStrictEqual(r.displayMode, 'compact')
})
test('compact fires when contactCount=1, not dismissed', () => {
  const r = deriveActivationState({
    contactCount: 1, hasInteraction: false, hasFollowUp: false,
    stripDismissed: false,
    milestones: { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null },
  })
  assert.strictEqual(r.displayMode, 'compact')
})

// ── getFirstName ──────────────────────────────────────────────────────────────

console.log('\ngetFirstName')

test('single name → returns it', () => {
  assert.strictEqual(getFirstName('Nav'), 'Nav')
})
test('first last → returns first', () => {
  assert.strictEqual(getFirstName('Naveen Kindra'), 'Naveen')
})
test('three words → returns first', () => {
  assert.strictEqual(getFirstName('Mary Jo Smith'), 'Mary')
})
test('null → null', () => {
  assert.strictEqual(getFirstName(null), null)
})
test('undefined → null', () => {
  assert.strictEqual(getFirstName(undefined), null)
})
test('empty string → null', () => {
  assert.strictEqual(getFirstName(''), null)
})
test('whitespace only → null', () => {
  assert.strictEqual(getFirstName('   '), null)
})
test('leading/trailing whitespace stripped', () => {
  assert.strictEqual(getFirstName('  Nav  '), 'Nav')
})
test('non-string (number) → null', () => {
  assert.strictEqual(getFirstName(42), null)
})
test('email-shaped value → null', () => {
  assert.strictEqual(getFirstName('user@example.com'), null)
})

// ── Storage keys ──────────────────────────────────────────────────────────────

console.log('\nStorage keys')

test('sessionDismissKey contains uid', () => {
  const key = sessionDismissKey('abc-123')
  assert.ok(key.includes('abc-123'))
})
test('sessionDismissKey starts with funnl_ob_dismissed_', () => {
  assert.ok(sessionDismissKey('uid').startsWith('funnl_ob_dismissed_'))
})
test('sessionDismissKey ends with _v1', () => {
  assert.ok(sessionDismissKey('uid').endsWith('_v1'))
})
test('stripDismissKey is an alias for sessionDismissKey', () => {
  assert.strictEqual(stripDismissKey('uid'), sessionDismissKey('uid'))
})
test('welcomeSkipKey contains uid', () => {
  assert.ok(welcomeSkipKey('uid123').includes('uid123'))
})
test('welcomeSkipKey starts with funnl_onboarding_welcome_v1_', () => {
  assert.ok(welcomeSkipKey('uid').startsWith('funnl_onboarding_welcome_v1_'))
})
test('completionSessionKey contains uid', () => {
  assert.ok(completionSessionKey('uid999').includes('uid999'))
})
test('completionSessionKey starts with funnl_activation_completion_v1_', () => {
  assert.ok(completionSessionKey('uid').startsWith('funnl_activation_completion_v1_'))
})
test('two different uids → different sessionDismissKey', () => {
  assert.notStrictEqual(sessionDismissKey('a'), sessionDismissKey('b'))
})
test('two different uids → different welcomeSkipKey', () => {
  assert.notStrictEqual(welcomeSkipKey('a'), welcomeSkipKey('b'))
})
test('two different uids → different completionSessionKey', () => {
  assert.notStrictEqual(completionSessionKey('a'), completionSessionKey('b'))
})

// ── readSessionFlag / writeSessionFlag / clearSessionFlag ─────────────────────
// sessionStorage is not available in Node.js — these must silently no-op / return false.

console.log('\nreadSessionFlag / writeSessionFlag / clearSessionFlag (Node.js — sessionStorage absent)')

test('readSessionFlag returns false when sessionStorage absent', () => {
  assert.strictEqual(readSessionFlag('test-key'), false)
})
test('writeSessionFlag does not throw when sessionStorage absent', () => {
  assert.doesNotThrow(() => writeSessionFlag('test-key'))
})
test('clearSessionFlag does not throw when sessionStorage absent', () => {
  assert.doesNotThrow(() => clearSessionFlag('test-key'))
})

// ── readLocalFlag / writeLocalFlag / clearLocalFlag ───────────────────────────

console.log('\nreadLocalFlag / writeLocalFlag / clearLocalFlag (Node.js — localStorage absent)')

test('readLocalFlag returns false when localStorage absent', () => {
  assert.strictEqual(readLocalFlag('test-key'), false)
})
test('writeLocalFlag does not throw when localStorage absent', () => {
  assert.doesNotThrow(() => writeLocalFlag('test-key'))
})
test('clearLocalFlag does not throw when localStorage absent', () => {
  assert.doesNotThrow(() => clearLocalFlag('test-key'))
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
