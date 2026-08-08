/**
 * onboarding-display-modes.test.js
 *
 * Verifies that deriveActivationState produces the correct display mode for every
 * possible input configuration:
 *   - All 8 modes are reachable
 *   - Priority order is strictly enforced (loading > unavailable > newly_completed >
 *     hidden_complete > welcome > collapsed > compact > normal_home)
 *   - Modes are mutually exclusive (same input cannot produce two different modes)
 *   - All returned shape fields are present and typed correctly
 *
 * Pure function tests — no React, no DOM, no Supabase.
 *
 * Run with: node tests/onboarding-display-modes.test.js
 */
import assert from 'assert'
import {
  DISPLAY_MODES,
  deriveActivationState,
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

// ── Shared fixtures ───────────────────────────────────────────────────────────

const nullMs   = { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null }
const fullMs   = { fiveContacts: 'ts', firstInteraction: 'ts', firstFollowup: 'ts', completed: 'ts' }
const emptyResolved   = { contactCount: 0, hasInteraction: false, hasFollowUp: false, milestones: nullMs }
const compactInput    = { contactCount: 1, hasInteraction: false, hasFollowUp: false, stripDismissed: false, milestones: nullMs }
const collapsedInput  = { contactCount: 1, hasInteraction: false, hasFollowUp: false, stripDismissed: true,  milestones: nullMs }
const newlyComplInput = { contactCount: 5, hasInteraction: true, hasFollowUp: true, justCompleted: true, milestones: fullMs }
const hiddenComplInput = { contactCount: 5, hasInteraction: true, hasFollowUp: true, justCompleted: false, milestones: fullMs }
const welcomeSkippedInput = { contactCount: 0, hasInteraction: false, hasFollowUp: false, welcomeSkipped: true, milestones: nullMs }

// ── All 8 modes reachable ─────────────────────────────────────────────────────

console.log('\nAll 8 modes reachable')

test('mode=loading is reachable via loading:true', () => {
  assert.strictEqual(deriveActivationState({ loading: true }).displayMode, DISPLAY_MODES.LOADING)
})
test('mode=unavailable is reachable via queryError:true', () => {
  assert.strictEqual(deriveActivationState({ queryError: true }).displayMode, DISPLAY_MODES.UNAVAILABLE)
})
test('mode=newly_completed is reachable via justCompleted:true + resolved data', () => {
  assert.strictEqual(deriveActivationState(newlyComplInput).displayMode, DISPLAY_MODES.NEWLY_COMPLETED)
})
test('mode=hidden_complete is reachable via milestones.completed set', () => {
  assert.strictEqual(deriveActivationState(hiddenComplInput).displayMode, DISPLAY_MODES.HIDDEN_COMPLETE)
})
test('mode=welcome is reachable via confirmed zero account', () => {
  assert.strictEqual(deriveActivationState(emptyResolved).displayMode, DISPLAY_MODES.WELCOME)
})
test('mode=collapsed is reachable via stripDismissed:true + 1 contact', () => {
  assert.strictEqual(deriveActivationState(collapsedInput).displayMode, DISPLAY_MODES.COLLAPSED)
})
test('mode=compact is reachable via contactCount=1 + not dismissed', () => {
  assert.strictEqual(deriveActivationState(compactInput).displayMode, DISPLAY_MODES.COMPACT)
})
test('mode=normal_home is reachable via welcomeSkipped + zero contacts', () => {
  assert.strictEqual(deriveActivationState(welcomeSkippedInput).displayMode, DISPLAY_MODES.NORMAL_HOME)
})

// ── All 8 modes produce the correct constant string ───────────────────────────

console.log('\nMode string values match DISPLAY_MODES constants')

test('loading mode string = DISPLAY_MODES.LOADING', () => {
  const r = deriveActivationState({ loading: true })
  assert.strictEqual(r.displayMode, 'loading')
})
test('unavailable mode string = DISPLAY_MODES.UNAVAILABLE', () => {
  const r = deriveActivationState({ queryError: true })
  assert.strictEqual(r.displayMode, 'unavailable')
})
test('newly_completed mode string = DISPLAY_MODES.NEWLY_COMPLETED', () => {
  const r = deriveActivationState(newlyComplInput)
  assert.strictEqual(r.displayMode, 'newly_completed')
})
test('hidden_complete mode string = DISPLAY_MODES.HIDDEN_COMPLETE', () => {
  const r = deriveActivationState(hiddenComplInput)
  assert.strictEqual(r.displayMode, 'hidden_complete')
})
test('welcome mode string = DISPLAY_MODES.WELCOME', () => {
  const r = deriveActivationState(emptyResolved)
  assert.strictEqual(r.displayMode, 'welcome')
})
test('collapsed mode string = DISPLAY_MODES.COLLAPSED', () => {
  const r = deriveActivationState(collapsedInput)
  assert.strictEqual(r.displayMode, 'collapsed')
})
test('compact mode string = DISPLAY_MODES.COMPACT', () => {
  const r = deriveActivationState(compactInput)
  assert.strictEqual(r.displayMode, 'compact')
})
test('normal_home mode string = DISPLAY_MODES.NORMAL_HOME', () => {
  const r = deriveActivationState(welcomeSkippedInput)
  assert.strictEqual(r.displayMode, 'normal_home')
})

// ── Priority: loading beats everything ───────────────────────────────────────

console.log('\nPriority: loading (1) beats all lower priorities')

test('loading beats unavailable', () => {
  assert.strictEqual(
    deriveActivationState({ loading: true, queryError: true }).displayMode,
    'loading'
  )
})
test('loading beats newly_completed', () => {
  assert.strictEqual(
    deriveActivationState({ loading: true, justCompleted: true }).displayMode,
    'loading'
  )
})
test('loading beats hidden_complete (milestone timestamps present)', () => {
  assert.strictEqual(
    deriveActivationState({ loading: true, milestones: fullMs }).displayMode,
    'loading'
  )
})
test('loading beats welcome (confirmed empty data)', () => {
  assert.strictEqual(
    deriveActivationState({ loading: true, ...emptyResolved }).displayMode,
    'loading'
  )
})
test('loading beats compact', () => {
  assert.strictEqual(
    deriveActivationState({ loading: true, ...compactInput }).displayMode,
    'loading'
  )
})
test('loading beats collapsed', () => {
  assert.strictEqual(
    deriveActivationState({ loading: true, ...collapsedInput }).displayMode,
    'loading'
  )
})
test('loading beats normal_home', () => {
  assert.strictEqual(
    deriveActivationState({ loading: true, ...welcomeSkippedInput }).displayMode,
    'loading'
  )
})

// ── Priority: unavailable beats everything below ──────────────────────────────

console.log('\nPriority: unavailable (2) beats all lower priorities')

test('unavailable beats newly_completed', () => {
  assert.strictEqual(
    deriveActivationState({ queryError: true, justCompleted: true }).displayMode,
    'unavailable'
  )
})
test('unavailable beats hidden_complete', () => {
  assert.strictEqual(
    deriveActivationState({ queryError: true, milestones: fullMs }).displayMode,
    'unavailable'
  )
})
test('unavailable beats welcome', () => {
  assert.strictEqual(
    deriveActivationState({ queryError: true, ...emptyResolved }).displayMode,
    'unavailable'
  )
})
test('unavailable beats compact', () => {
  assert.strictEqual(
    deriveActivationState({ queryError: true, ...compactInput }).displayMode,
    'unavailable'
  )
})
test('unavailable beats collapsed', () => {
  assert.strictEqual(
    deriveActivationState({ queryError: true, ...collapsedInput }).displayMode,
    'unavailable'
  )
})

// ── Priority: newly_completed beats everything below ─────────────────────────

console.log('\nPriority: newly_completed (3) beats lower priorities')

test('newly_completed beats hidden_complete (justCompleted + milestone set)', () => {
  assert.strictEqual(
    deriveActivationState({ ...newlyComplInput, justCompleted: true }).displayMode,
    'newly_completed'
  )
})
test('newly_completed beats welcome (justCompleted on cleared account edge case)', () => {
  assert.strictEqual(
    deriveActivationState({ justCompleted: true, contactCount: 0, hasInteraction: false, hasFollowUp: false, milestones: nullMs }).displayMode,
    'newly_completed'
  )
})

// ── Priority: hidden_complete beats welcome/collapsed/compact ─────────────────

console.log('\nPriority: hidden_complete (4) beats lower priorities')

test('hidden_complete beats welcome (completed milestone + empty-looking data)', () => {
  assert.strictEqual(
    deriveActivationState({
      milestones: { ...nullMs, completed: 'ts' },
      contactCount: 0, hasInteraction: false, hasFollowUp: false,
    }).displayMode,
    'hidden_complete'
  )
})
test('hidden_complete beats collapsed', () => {
  assert.strictEqual(
    deriveActivationState({ ...collapsedInput, milestones: fullMs }).displayMode,
    'hidden_complete'
  )
})
test('hidden_complete beats compact', () => {
  assert.strictEqual(
    deriveActivationState({ ...compactInput, milestones: fullMs }).displayMode,
    'hidden_complete'
  )
})

// ── Priority: welcome beats collapsed/compact ─────────────────────────────────

console.log('\nPriority: welcome (5) beats lower priorities')

test('welcome beats collapsed (empty + !skipped overrides stripDismissed)', () => {
  assert.strictEqual(
    deriveActivationState({ ...emptyResolved, welcomeSkipped: false, stripDismissed: true }).displayMode,
    'welcome'
  )
})

// ── Priority: collapsed beats compact ────────────────────────────────────────

console.log('\nPriority: collapsed (6) beats compact (7)')

test('collapsed beats compact (stripDismissed=true)', () => {
  assert.strictEqual(
    deriveActivationState({ contactCount: 2, hasInteraction: false, hasFollowUp: false, stripDismissed: true, milestones: nullMs }).displayMode,
    'collapsed'
  )
})
test('compact fires when not dismissed', () => {
  assert.strictEqual(
    deriveActivationState({ contactCount: 2, hasInteraction: false, hasFollowUp: false, stripDismissed: false, milestones: nullMs }).displayMode,
    'compact'
  )
})

// ── Return shape completeness ─────────────────────────────────────────────────

console.log('\nReturn shape — all 9 fields present in every mode')

const REQUIRED_FIELDS = [
  'displayMode', 'contactsComplete', 'interactionComplete', 'followupComplete',
  'completedCount', 'progressPercent', 'nextAction', 'isComplete', 'isEmpty',
]

const allInputs = [
  { label: 'loading',         input: { loading: true } },
  { label: 'unavailable',     input: { queryError: true } },
  { label: 'newly_completed', input: newlyComplInput },
  { label: 'hidden_complete', input: hiddenComplInput },
  { label: 'welcome',         input: emptyResolved },
  { label: 'collapsed',       input: collapsedInput },
  { label: 'compact',         input: compactInput },
  { label: 'normal_home',     input: welcomeSkippedInput },
]

for (const { label, input } of allInputs) {
  test(`${label}: all 9 fields present`, () => {
    const r = deriveActivationState(input)
    for (const field of REQUIRED_FIELDS) {
      assert.ok(field in r, `missing field "${field}" in ${label} mode`)
    }
  })
  test(`${label}: completedCount is a number 0–3`, () => {
    const r = deriveActivationState(input)
    assert.ok(typeof r.completedCount === 'number', 'completedCount must be number')
    assert.ok(r.completedCount >= 0 && r.completedCount <= 3, 'completedCount must be 0–3')
  })
  test(`${label}: progressPercent is 0–100`, () => {
    const r = deriveActivationState(input)
    assert.ok(typeof r.progressPercent === 'number', 'progressPercent must be number')
    assert.ok(r.progressPercent >= 0 && r.progressPercent <= 100, 'progressPercent must be 0–100')
  })
}

// ── isComplete semantics ──────────────────────────────────────────────────────

console.log('\nisComplete semantics')

test('loading: isComplete=false (never fabricate completion)', () => {
  assert.strictEqual(deriveActivationState({ loading: true }).isComplete, false)
})
test('unavailable: isComplete=false (never fabricate from error)', () => {
  assert.strictEqual(deriveActivationState({ queryError: true }).isComplete, false)
})
test('newly_completed: isComplete=true', () => {
  assert.strictEqual(deriveActivationState(newlyComplInput).isComplete, true)
})
test('hidden_complete: isComplete=true', () => {
  assert.strictEqual(deriveActivationState(hiddenComplInput).isComplete, true)
})
test('welcome: isComplete=false', () => {
  assert.strictEqual(deriveActivationState(emptyResolved).isComplete, false)
})
test('compact: isComplete=false', () => {
  assert.strictEqual(deriveActivationState(compactInput).isComplete, false)
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
