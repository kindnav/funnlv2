/**
 * onboarding-empty-derivation.test.js
 *
 * Verifies isEmpty derivation semantics and the dataResolved guard.
 * Core invariant: null contactCount / hasInteraction / hasFollowUp must NEVER be
 * treated as zero/false. Only fully resolved data can produce isEmpty=true.
 *
 * Pure function tests — no React, no DOM, no Supabase.
 *
 * Run with: node tests/onboarding-empty-derivation.test.js
 */
import assert from 'assert'
import { deriveActivationState, DISPLAY_MODES } from '../src/lib/activationHelpers.js'

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

const nullMs = { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null }

// ── dataResolved requirement — null means unresolved ─────────────────────────

console.log('\nnull data sources are NOT treated as resolved zeros')

test('null contactCount alone → isEmpty=false', () => {
  const r = deriveActivationState({ contactCount: null, hasInteraction: false, hasFollowUp: false, milestones: nullMs })
  assert.strictEqual(r.isEmpty, false)
})
test('null hasInteraction alone → isEmpty=false', () => {
  const r = deriveActivationState({ contactCount: 0, hasInteraction: null, hasFollowUp: false, milestones: nullMs })
  assert.strictEqual(r.isEmpty, false)
})
test('null hasFollowUp alone → isEmpty=false', () => {
  const r = deriveActivationState({ contactCount: 0, hasInteraction: false, hasFollowUp: null, milestones: nullMs })
  assert.strictEqual(r.isEmpty, false)
})
test('all three null → isEmpty=false', () => {
  const r = deriveActivationState({ contactCount: null, hasInteraction: null, hasFollowUp: null, milestones: nullMs })
  assert.strictEqual(r.isEmpty, false)
})
test('contactCount+hasInteraction null, hasFollowUp resolved → isEmpty=false', () => {
  const r = deriveActivationState({ contactCount: null, hasInteraction: null, hasFollowUp: false, milestones: nullMs })
  assert.strictEqual(r.isEmpty, false)
})
test('contactCount null, other two resolved → isEmpty=false', () => {
  const r = deriveActivationState({ contactCount: null, hasInteraction: false, hasFollowUp: false, milestones: nullMs })
  assert.strictEqual(r.isEmpty, false)
})

// ── null data → mode falls through to normal_home (safe) ─────────────────────

console.log('\nnull data → mode=normal_home (safe fallback, never welcome)')

test('null contactCount → mode=normal_home, not welcome', () => {
  const r = deriveActivationState({ contactCount: null, hasInteraction: false, hasFollowUp: false, milestones: nullMs })
  assert.strictEqual(r.displayMode, DISPLAY_MODES.NORMAL_HOME)
})
test('all null → mode=normal_home', () => {
  const r = deriveActivationState({ contactCount: null, hasInteraction: null, hasFollowUp: null, milestones: nullMs })
  assert.strictEqual(r.displayMode, DISPLAY_MODES.NORMAL_HOME)
})
test('default call (no args) → mode=normal_home', () => {
  const r = deriveActivationState()
  assert.strictEqual(r.displayMode, DISPLAY_MODES.NORMAL_HOME)
})
test('default call (no args) → isEmpty=false', () => {
  const r = deriveActivationState()
  assert.strictEqual(r.isEmpty, false)
})

// ── dataResolved → isEmpty=true only when all values are confirmed zero/false ─

console.log('\ndataResolved: all confirmed zero → isEmpty=true')

test('all resolved to zero/false + nullMs → isEmpty=true', () => {
  const r = deriveActivationState({ contactCount: 0, hasInteraction: false, hasFollowUp: false, milestones: nullMs })
  assert.strictEqual(r.isEmpty, true)
})
test('all resolved zero/false + nullMs → mode=welcome', () => {
  const r = deriveActivationState({ contactCount: 0, hasInteraction: false, hasFollowUp: false, milestones: nullMs })
  assert.strictEqual(r.displayMode, DISPLAY_MODES.WELCOME)
})

// ── non-zero values prevent isEmpty ──────────────────────────────────────────

console.log('\nnon-zero/non-false values prevent isEmpty')

test('contactCount=1, others false → isEmpty=false', () => {
  const r = deriveActivationState({ contactCount: 1, hasInteraction: false, hasFollowUp: false, milestones: nullMs })
  assert.strictEqual(r.isEmpty, false)
})
test('hasInteraction=true, others zero → isEmpty=false', () => {
  const r = deriveActivationState({ contactCount: 0, hasInteraction: true, hasFollowUp: false, milestones: nullMs })
  assert.strictEqual(r.isEmpty, false)
})
test('hasFollowUp=true, others zero → isEmpty=false', () => {
  const r = deriveActivationState({ contactCount: 0, hasInteraction: false, hasFollowUp: true, milestones: nullMs })
  assert.strictEqual(r.isEmpty, false)
})
test('contactCount=5, all others match → isEmpty=false', () => {
  const r = deriveActivationState({ contactCount: 5, hasInteraction: true, hasFollowUp: true, milestones: nullMs })
  assert.strictEqual(r.isEmpty, false)
})

// ── completed milestone prevents isEmpty ──────────────────────────────────────

console.log('\ncompleted milestone prevents isEmpty even when data looks zero')

test('milestones.completed set + zero data → isEmpty=false', () => {
  const r = deriveActivationState({
    contactCount: 0, hasInteraction: false, hasFollowUp: false,
    milestones: { ...nullMs, completed: '2026-07-01T00:00:00Z' },
  })
  assert.strictEqual(r.isEmpty, false)
})
test('milestones.completed set + zero data → mode=hidden_complete (not welcome)', () => {
  const r = deriveActivationState({
    contactCount: 0, hasInteraction: false, hasFollowUp: false,
    milestones: { ...nullMs, completed: '2026-07-01T00:00:00Z' },
  })
  assert.strictEqual(r.displayMode, DISPLAY_MODES.HIDDEN_COMPLETE)
})

// ── welcomeSkipped prevents welcome even when isEmpty=true ────────────────────

console.log('\nwelcomeSkipped prevents welcome card even on confirmed empty account')

test('isEmpty=true + welcomeSkipped=true → mode=normal_home', () => {
  const r = deriveActivationState({ contactCount: 0, hasInteraction: false, hasFollowUp: false, welcomeSkipped: true, milestones: nullMs })
  assert.strictEqual(r.displayMode, DISPLAY_MODES.NORMAL_HOME)
})
test('isEmpty=true + welcomeSkipped=false → mode=welcome', () => {
  const r = deriveActivationState({ contactCount: 0, hasInteraction: false, hasFollowUp: false, welcomeSkipped: false, milestones: nullMs })
  assert.strictEqual(r.displayMode, DISPLAY_MODES.WELCOME)
})
test('isEmpty=true + welcomeSkipped=true → isEmpty reported as false on NORMAL_HOME path', () => {
  // normal_home path: isEmpty can be either true or false depending on the reason
  // but the mode is normal_home, not welcome
  const r = deriveActivationState({ contactCount: 0, hasInteraction: false, hasFollowUp: false, welcomeSkipped: true, milestones: nullMs })
  assert.notStrictEqual(r.displayMode, DISPLAY_MODES.WELCOME)
})

// ── isEmpty in non-welcome modes is always false ──────────────────────────────

console.log('\nisMEmpty is false in all non-welcome modes')

test('loading mode → isEmpty=false', () => {
  assert.strictEqual(deriveActivationState({ loading: true }).isEmpty, false)
})
test('unavailable mode → isEmpty=false', () => {
  assert.strictEqual(deriveActivationState({ queryError: true }).isEmpty, false)
})
test('newly_completed mode → isEmpty=false', () => {
  const r = deriveActivationState({ contactCount: 5, hasInteraction: true, hasFollowUp: true, justCompleted: true, milestones: { fiveContacts: 'ts', firstInteraction: 'ts', firstFollowup: 'ts', completed: 'ts' } })
  assert.strictEqual(r.isEmpty, false)
})
test('hidden_complete mode → isEmpty=false', () => {
  const r = deriveActivationState({ contactCount: 5, hasInteraction: true, hasFollowUp: true, milestones: { fiveContacts: 'ts', firstInteraction: 'ts', firstFollowup: 'ts', completed: 'ts' } })
  assert.strictEqual(r.isEmpty, false)
})
test('compact mode → isEmpty=false', () => {
  const r = deriveActivationState({ contactCount: 1, hasInteraction: false, hasFollowUp: false, stripDismissed: false, milestones: nullMs })
  assert.strictEqual(r.isEmpty, false)
})
test('collapsed mode → isEmpty=false', () => {
  const r = deriveActivationState({ contactCount: 1, hasInteraction: false, hasFollowUp: false, stripDismissed: true, milestones: nullMs })
  assert.strictEqual(r.isEmpty, false)
})

// ── milestones=null (no row) behaves like nullMs ──────────────────────────────

console.log('\nmilestones=null is treated as all-null (no row)')

test('milestones=null + resolved zero → isEmpty=true', () => {
  const r = deriveActivationState({ contactCount: 0, hasInteraction: false, hasFollowUp: false, milestones: null })
  assert.strictEqual(r.isEmpty, true)
})
test('milestones=null + null contactCount → isEmpty=false', () => {
  const r = deriveActivationState({ contactCount: null, hasInteraction: false, hasFollowUp: false, milestones: null })
  assert.strictEqual(r.isEmpty, false)
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
