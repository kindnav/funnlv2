/**
 * onboarding-milestone-writes.test.js
 *
 * Verifies the pure milestone-write decision functions:
 *   - computeMilestoneSteps: derives which steps are met by live data
 *   - shouldAttemptMilestoneWrites: decides which DB writes to attempt
 *
 * Core invariants:
 *   - A step is attempted ONLY when the live data criterion is met AND the stored
 *     timestamp is still null (atomic idempotent guard).
 *   - A write is never re-attempted when a timestamp is already set.
 *   - completion is only attempted when ALL three steps are met AND completed=null.
 *   - ms=null is treated the same as all-null timestamps.
 *
 * Pure function tests — no React, no DOM, no Supabase.
 *
 * Run with: node tests/onboarding-milestone-writes.test.js
 */
import assert from 'assert'
import {
  computeMilestoneSteps,
  shouldAttemptMilestoneWrites,
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

const nullMs = { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null }
const fullMs = { fiveContacts: 'ts', firstInteraction: 'ts', firstFollowup: 'ts', completed: 'ts' }

// ── computeMilestoneSteps: step1 (5 contacts) ─────────────────────────────────

console.log('\ncomputeMilestoneSteps — step1: 5 contacts criterion')

test('contactCnt=5 → step1Met=true', () => {
  const { step1Met } = computeMilestoneSteps(5, false, false)
  assert.strictEqual(step1Met, true)
})
test('contactCnt=6 → step1Met=true (above threshold)', () => {
  const { step1Met } = computeMilestoneSteps(6, false, false)
  assert.strictEqual(step1Met, true)
})
test('contactCnt=4 → step1Met=false', () => {
  const { step1Met } = computeMilestoneSteps(4, false, false)
  assert.strictEqual(step1Met, false)
})
test('contactCnt=0 → step1Met=false', () => {
  const { step1Met } = computeMilestoneSteps(0, false, false)
  assert.strictEqual(step1Met, false)
})
test('contactCnt=null → step1Met=false (null treated as 0)', () => {
  const { step1Met } = computeMilestoneSteps(null, false, false)
  assert.strictEqual(step1Met, false)
})

// ── computeMilestoneSteps: step2 (first interaction) ─────────────────────────

console.log('\ncomputeMilestoneSteps — step2: first interaction criterion')

test('hasInteraction=true → step2Met=true', () => {
  const { step2Met } = computeMilestoneSteps(0, true, false)
  assert.strictEqual(step2Met, true)
})
test('hasInteraction=false → step2Met=false', () => {
  const { step2Met } = computeMilestoneSteps(0, false, false)
  assert.strictEqual(step2Met, false)
})
test('hasInteraction=null → step2Met=false', () => {
  const { step2Met } = computeMilestoneSteps(0, null, false)
  assert.strictEqual(step2Met, false)
})
test('hasInteraction=1 (numeric) → step2Met=true', () => {
  const { step2Met } = computeMilestoneSteps(0, 1, false)
  assert.strictEqual(step2Met, true)
})
test('hasInteraction=0 (numeric) → step2Met=false', () => {
  const { step2Met } = computeMilestoneSteps(0, 0, false)
  assert.strictEqual(step2Met, false)
})

// ── computeMilestoneSteps: step3 (first follow-up) ───────────────────────────

console.log('\ncomputeMilestoneSteps — step3: follow-up criterion')

test('hasFollowUp=true → step3Met=true', () => {
  const { step3Met } = computeMilestoneSteps(0, false, true)
  assert.strictEqual(step3Met, true)
})
test('hasFollowUp=false → step3Met=false', () => {
  const { step3Met } = computeMilestoneSteps(0, false, false)
  assert.strictEqual(step3Met, false)
})
test('hasFollowUp=null → step3Met=false', () => {
  const { step3Met } = computeMilestoneSteps(0, false, null)
  assert.strictEqual(step3Met, false)
})

// ── shouldAttemptMilestoneWrites: writes attempted only when needed ───────────

console.log('\nshouldAttemptMilestoneWrites — write attempted only when met + null')

test('step1 met + fiveContacts=null → step1=true', () => {
  const r = shouldAttemptMilestoneWrites(5, false, false, nullMs)
  assert.strictEqual(r.step1, true)
})
test('step1 met + fiveContacts already set → step1=false (idempotent)', () => {
  const r = shouldAttemptMilestoneWrites(5, false, false, { ...nullMs, fiveContacts: 'ts' })
  assert.strictEqual(r.step1, false)
})
test('step1 not met + fiveContacts=null → step1=false', () => {
  const r = shouldAttemptMilestoneWrites(3, false, false, nullMs)
  assert.strictEqual(r.step1, false)
})

test('step2 met + firstInteraction=null → step2=true', () => {
  const r = shouldAttemptMilestoneWrites(0, true, false, nullMs)
  assert.strictEqual(r.step2, true)
})
test('step2 met + firstInteraction already set → step2=false (idempotent)', () => {
  const r = shouldAttemptMilestoneWrites(0, true, false, { ...nullMs, firstInteraction: 'ts' })
  assert.strictEqual(r.step2, false)
})
test('step2 not met + firstInteraction=null → step2=false', () => {
  const r = shouldAttemptMilestoneWrites(0, false, false, nullMs)
  assert.strictEqual(r.step2, false)
})

test('step3 met + firstFollowup=null → step3=true', () => {
  const r = shouldAttemptMilestoneWrites(0, false, true, nullMs)
  assert.strictEqual(r.step3, true)
})
test('step3 met + firstFollowup already set → step3=false (idempotent)', () => {
  const r = shouldAttemptMilestoneWrites(0, false, true, { ...nullMs, firstFollowup: 'ts' })
  assert.strictEqual(r.step3, false)
})
test('step3 not met + firstFollowup=null → step3=false', () => {
  const r = shouldAttemptMilestoneWrites(0, false, false, nullMs)
  assert.strictEqual(r.step3, false)
})

// ── completion write: all three must be met ───────────────────────────────────

console.log('\ncompletion write — all three must be met AND completed=null')

test('all three met + completed=null → completion=true', () => {
  const r = shouldAttemptMilestoneWrites(5, true, true, nullMs)
  assert.strictEqual(r.completion, true)
})
test('all three met + completed already set → completion=false', () => {
  const r = shouldAttemptMilestoneWrites(5, true, true, fullMs)
  assert.strictEqual(r.completion, false)
})
test('step1 not met + others met → completion=false', () => {
  const r = shouldAttemptMilestoneWrites(4, true, true, nullMs)
  assert.strictEqual(r.completion, false)
})
test('step2 not met + others met → completion=false', () => {
  const r = shouldAttemptMilestoneWrites(5, false, true, nullMs)
  assert.strictEqual(r.completion, false)
})
test('step3 not met + others met → completion=false', () => {
  const r = shouldAttemptMilestoneWrites(5, true, false, nullMs)
  assert.strictEqual(r.completion, false)
})

// ── ms=null is treated as all-null timestamps ─────────────────────────────────

console.log('\nms=null treated as all-null (no pro_trials row)')

test('ms=null + step1 met → step1=true', () => {
  const r = shouldAttemptMilestoneWrites(5, false, false, null)
  assert.strictEqual(r.step1, true)
})
test('ms=null + all three met → completion=true', () => {
  const r = shouldAttemptMilestoneWrites(5, true, true, null)
  assert.strictEqual(r.completion, true)
})
test('ms=null + no steps met → all false', () => {
  const r = shouldAttemptMilestoneWrites(0, false, false, null)
  assert.deepStrictEqual(r, { step1: false, step2: false, step3: false, completion: false })
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
