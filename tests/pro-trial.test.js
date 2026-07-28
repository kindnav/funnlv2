// Zero-dependency Node.js tests for the Pro trial pure helpers.
// Imports only from src/lib/ai.js — no React, no Supabase, no fetch.
//
// Run with: node tests/pro-trial.test.js
//
// All tests exercise the exported pure functions:
//   isTrialActive(trial, now)
//   computeTrialStatus(trial, now)
//
// The Supabase-calling functions (canUseAI, getTrialStatus) are not tested here
// because they require a live DB. The pure helpers they delegate to are fully covered.

import { strict as assert } from 'assert'
import { test } from 'node:test'
import { isTrialActive, computeTrialStatus } from '../src/lib/pro-trial-helpers.js'

// ── Test fixtures ──────────────────────────────────────────────────────────────

const NOW = new Date('2026-07-27T12:00:00.000Z')

// Trial started 2 days ago, ends in 5 days (active)
const ACTIVE_TRIAL = {
  started_at: '2026-07-25T10:00:00.000Z',
  ends_at:    '2026-08-01T10:00:00.000Z',
}

// Trial started 10 days ago, ended 3 days ago (expired)
const EXPIRED_TRIAL = {
  started_at: '2026-07-17T10:00:00.000Z',
  ends_at:    '2026-07-24T10:00:00.000Z',
}

// Row exists but trial not yet started
const ELIGIBLE_TRIAL = {
  started_at: null,
  ends_at:    null,
}

// Trial ending in exactly 1 ms (still active)
const TRIAL_ENDING_SOON = {
  started_at: '2026-07-20T00:00:00.000Z',
  ends_at:    new Date(NOW.getTime() + 1).toISOString(),
}

// Trial that ended exactly at NOW (expired — not strictly greater)
const TRIAL_JUST_EXPIRED = {
  started_at: '2026-07-20T00:00:00.000Z',
  ends_at:    NOW.toISOString(),
}

// ── isTrialActive ──────────────────────────────────────────────────────────────

await test('isTrialActive: null trial → false', () => {
  assert.strictEqual(isTrialActive(null, NOW), false)
})

await test('isTrialActive: undefined trial → false', () => {
  assert.strictEqual(isTrialActive(undefined, NOW), false)
})

await test('isTrialActive: eligible trial (started_at null) → false', () => {
  assert.strictEqual(isTrialActive(ELIGIBLE_TRIAL, NOW), false)
})

await test('isTrialActive: active trial → true', () => {
  assert.strictEqual(isTrialActive(ACTIVE_TRIAL, NOW), true)
})

await test('isTrialActive: expired trial → false', () => {
  assert.strictEqual(isTrialActive(EXPIRED_TRIAL, NOW), false)
})

await test('isTrialActive: trial ending in 1 ms → true (still active)', () => {
  assert.strictEqual(isTrialActive(TRIAL_ENDING_SOON, NOW), true)
})

await test('isTrialActive: trial ends_at === now → false (boundary: not strictly greater)', () => {
  assert.strictEqual(isTrialActive(TRIAL_JUST_EXPIRED, NOW), false)
})

await test('isTrialActive: ends_at in past by 1 ms → false', () => {
  const trial = { started_at: '2026-07-20T00:00:00.000Z', ends_at: new Date(NOW.getTime() - 1).toISOString() }
  assert.strictEqual(isTrialActive(trial, NOW), false)
})

await test('isTrialActive: only started_at set, ends_at null → false', () => {
  assert.strictEqual(isTrialActive({ started_at: '2026-07-25T00:00:00.000Z', ends_at: null }, NOW), false)
})

await test('isTrialActive: only ends_at set, started_at null → false', () => {
  assert.strictEqual(isTrialActive({ started_at: null, ends_at: '2026-08-01T00:00:00.000Z' }, NOW), false)
})

await test('isTrialActive: uses provided now — same trial, different now', () => {
  const PAST_NOW = new Date('2026-08-05T00:00:00.000Z')  // after ends_at
  assert.strictEqual(isTrialActive(ACTIVE_TRIAL, PAST_NOW), false)

  const EARLY_NOW = new Date('2026-07-26T00:00:00.000Z')  // before ends_at
  assert.strictEqual(isTrialActive(ACTIVE_TRIAL, EARLY_NOW), true)
})

await test('isTrialActive: no now argument — uses new Date() as default', () => {
  // Can only verify it doesn't throw and returns a boolean
  const result = isTrialActive(ACTIVE_TRIAL)
  assert.strictEqual(typeof result, 'boolean')
})

// ── computeTrialStatus: null / missing trial ───────────────────────────────────

await test('computeTrialStatus: null trial → all false, 0 days, null endsAt', () => {
  const s = computeTrialStatus(null, NOW)
  assert.strictEqual(s.eligible, false)
  assert.strictEqual(s.active, false)
  assert.strictEqual(s.expired, false)
  assert.strictEqual(s.daysRemaining, 0)
  assert.strictEqual(s.endsAt, null)
})

await test('computeTrialStatus: undefined trial → all false', () => {
  const s = computeTrialStatus(undefined, NOW)
  assert.strictEqual(s.eligible, false)
  assert.strictEqual(s.active, false)
  assert.strictEqual(s.expired, false)
  assert.strictEqual(s.daysRemaining, 0)
  assert.strictEqual(s.endsAt, null)
})

// ── computeTrialStatus: eligible (started_at IS NULL) ─────────────────────────

await test('computeTrialStatus: eligible trial → eligible=true, active=false, expired=false', () => {
  const s = computeTrialStatus(ELIGIBLE_TRIAL, NOW)
  assert.strictEqual(s.eligible, true)
  assert.strictEqual(s.active, false)
  assert.strictEqual(s.expired, false)
  assert.strictEqual(s.daysRemaining, 0)
  assert.strictEqual(s.endsAt, null)
})

// ── computeTrialStatus: active trial ──────────────────────────────────────────

await test('computeTrialStatus: active trial → active=true, eligible=false, expired=false', () => {
  const s = computeTrialStatus(ACTIVE_TRIAL, NOW)
  assert.strictEqual(s.active, true)
  assert.strictEqual(s.eligible, false)
  assert.strictEqual(s.expired, false)
})

await test('computeTrialStatus: active trial → endsAt matches trial.ends_at', () => {
  const s = computeTrialStatus(ACTIVE_TRIAL, NOW)
  assert.strictEqual(s.endsAt, ACTIVE_TRIAL.ends_at)
})

await test('computeTrialStatus: active trial → daysRemaining > 0', () => {
  const s = computeTrialStatus(ACTIVE_TRIAL, NOW)
  assert.ok(s.daysRemaining > 0, 'daysRemaining should be positive for active trial')
})

await test('computeTrialStatus: active trial with 5 days left → daysRemaining = 5', () => {
  // NOW = 2026-07-27T12:00:00Z, ends_at = 2026-08-01T10:00:00Z
  // diff = 4d22h = 118h = ~4.9167 days → ceil = 5
  const s = computeTrialStatus(ACTIVE_TRIAL, NOW)
  assert.strictEqual(s.daysRemaining, 5)
})

await test('computeTrialStatus: trial ending in 23h 59m → daysRemaining = 1 (ceil)', () => {
  const almostOneDayLeft = new Date(NOW.getTime() + 23 * 60 * 60 * 1000 + 59 * 60 * 1000)
  const trial = { started_at: ACTIVE_TRIAL.started_at, ends_at: almostOneDayLeft.toISOString() }
  const s = computeTrialStatus(trial, NOW)
  assert.strictEqual(s.daysRemaining, 1)
})

await test('computeTrialStatus: trial ending in 1 ms → daysRemaining = 1 (ceil of tiny fraction)', () => {
  const s = computeTrialStatus(TRIAL_ENDING_SOON, NOW)
  assert.strictEqual(s.daysRemaining, 1)
})

await test('computeTrialStatus: trial ending in exactly 24h → daysRemaining = 1', () => {
  const exactly24h = new Date(NOW.getTime() + 24 * 60 * 60 * 1000)
  const trial = { started_at: ACTIVE_TRIAL.started_at, ends_at: exactly24h.toISOString() }
  const s = computeTrialStatus(trial, NOW)
  assert.strictEqual(s.daysRemaining, 1)
})

await test('computeTrialStatus: trial ending in 24h + 1ms → daysRemaining = 2 (ceil)', () => {
  const slightly_over = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1)
  const trial = { started_at: ACTIVE_TRIAL.started_at, ends_at: slightly_over.toISOString() }
  const s = computeTrialStatus(trial, NOW)
  assert.strictEqual(s.daysRemaining, 2)
})

// ── computeTrialStatus: expired trial ─────────────────────────────────────────

await test('computeTrialStatus: expired trial → expired=true, active=false, eligible=false', () => {
  const s = computeTrialStatus(EXPIRED_TRIAL, NOW)
  assert.strictEqual(s.expired, true)
  assert.strictEqual(s.active, false)
  assert.strictEqual(s.eligible, false)
})

await test('computeTrialStatus: expired trial → daysRemaining = 0', () => {
  const s = computeTrialStatus(EXPIRED_TRIAL, NOW)
  assert.strictEqual(s.daysRemaining, 0)
})

await test('computeTrialStatus: expired trial → endsAt still returned (for display)', () => {
  const s = computeTrialStatus(EXPIRED_TRIAL, NOW)
  assert.strictEqual(s.endsAt, EXPIRED_TRIAL.ends_at)
})

await test('computeTrialStatus: trial just expired (ends_at === now) → expired=true', () => {
  const s = computeTrialStatus(TRIAL_JUST_EXPIRED, NOW)
  assert.strictEqual(s.expired, true)
  assert.strictEqual(s.active, false)
  assert.strictEqual(s.daysRemaining, 0)
})

// ── computeTrialStatus: mutual exclusivity ────────────────────────────────────

await test('computeTrialStatus: at most one of eligible/active/expired is true for active', () => {
  const s = computeTrialStatus(ACTIVE_TRIAL, NOW)
  const trueCount = [s.eligible, s.active, s.expired].filter(Boolean).length
  assert.strictEqual(trueCount, 1)
})

await test('computeTrialStatus: at most one of eligible/active/expired is true for expired', () => {
  const s = computeTrialStatus(EXPIRED_TRIAL, NOW)
  const trueCount = [s.eligible, s.active, s.expired].filter(Boolean).length
  assert.strictEqual(trueCount, 1)
})

await test('computeTrialStatus: at most one of eligible/active/expired is true for eligible', () => {
  const s = computeTrialStatus(ELIGIBLE_TRIAL, NOW)
  const trueCount = [s.eligible, s.active, s.expired].filter(Boolean).length
  assert.strictEqual(trueCount, 1)
})

await test('computeTrialStatus: none true for null trial', () => {
  const s = computeTrialStatus(null, NOW)
  const trueCount = [s.eligible, s.active, s.expired].filter(Boolean).length
  assert.strictEqual(trueCount, 0)
})

// ── computeTrialStatus: output shape is always complete ───────────────────────

await test('computeTrialStatus: always returns all 5 fields', () => {
  for (const trial of [null, ELIGIBLE_TRIAL, ACTIVE_TRIAL, EXPIRED_TRIAL]) {
    const s = computeTrialStatus(trial, NOW)
    assert.ok('eligible' in s, 'missing eligible')
    assert.ok('active' in s, 'missing active')
    assert.ok('expired' in s, 'missing expired')
    assert.ok('daysRemaining' in s, 'missing daysRemaining')
    assert.ok('endsAt' in s, 'missing endsAt')
  }
})

// ── isTrialActive + computeTrialStatus agreement ──────────────────────────────

await test('isTrialActive and computeTrialStatus.active agree for active trial', () => {
  assert.strictEqual(isTrialActive(ACTIVE_TRIAL, NOW), computeTrialStatus(ACTIVE_TRIAL, NOW).active)
})

await test('isTrialActive and computeTrialStatus.active agree for expired trial', () => {
  assert.strictEqual(isTrialActive(EXPIRED_TRIAL, NOW), computeTrialStatus(EXPIRED_TRIAL, NOW).active)
})

await test('isTrialActive and computeTrialStatus.active agree for eligible trial', () => {
  assert.strictEqual(isTrialActive(ELIGIBLE_TRIAL, NOW), computeTrialStatus(ELIGIBLE_TRIAL, NOW).active)
})

await test('isTrialActive and computeTrialStatus.active agree for null', () => {
  assert.strictEqual(isTrialActive(null, NOW), computeTrialStatus(null, NOW).active)
})

console.log('All pro-trial tests passed.')
