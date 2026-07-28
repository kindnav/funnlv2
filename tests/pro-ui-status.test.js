// Zero-dependency Node.js tests for the classifyProStatus pure helper.
//
// Run with: node tests/pro-ui-status.test.js
//
// classifyProStatus lives in: src/lib/pro-ui-status.js

import { strict as assert } from 'assert'
import { test } from 'node:test'
import { classifyProStatus } from '../src/lib/pro-ui-status.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Minimal valid status shapes — both boolean fields required.
const PERMANENT_STATUS = {
  permanent_pro:  true,
  can_use_pro:    true,
  trial_active:   false,
  trial_expired:  false,
  trial_eligible: false,
}

const TRIAL_ACTIVE_STATUS = {
  permanent_pro:  false,
  can_use_pro:    true,
  trial_active:   true,
  trial_expired:  false,
  trial_eligible: false,
}

const TRIAL_EXPIRED_STATUS = {
  permanent_pro:  false,
  can_use_pro:    false,
  trial_active:   false,
  trial_expired:  true,
  trial_eligible: false,
}

const NON_PRO_STATUS = {
  permanent_pro:  false,
  can_use_pro:    false,
  trial_active:   false,
  trial_expired:  false,
  trial_eligible: false,
}

// ── null → 'unavailable' (loading state) ─────────────────────────────────────

await test('null (loading) → unavailable', () => {
  assert.strictEqual(classifyProStatus(null), 'unavailable')
})

// ── 'error' → 'unavailable' (RPC failed) ─────────────────────────────────────

await test("'error' (RPC failed) → unavailable", () => {
  assert.strictEqual(classifyProStatus('error'), 'unavailable')
})

// ── Malformed objects → 'unavailable' ─────────────────────────────────────────

await test('malformed: empty object (missing both fields) → unavailable', () => {
  assert.strictEqual(classifyProStatus({}), 'unavailable')
})

await test('malformed: can_use_pro present but wrong type (string) → unavailable', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: 'yes', permanent_pro: false }), 'unavailable')
})

await test('malformed: permanent_pro present but wrong type (number) → unavailable', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: false, permanent_pro: 0 }), 'unavailable')
})

await test('non-object non-string (number) → unavailable', () => {
  assert.strictEqual(classifyProStatus(42), 'unavailable')
})

// ── can_use_pro=false, no trial → 'non_pro' ───────────────────────────────────

await test('confirmed non-Pro: no trial, no permanent access → non_pro', () => {
  assert.strictEqual(classifyProStatus(NON_PRO_STATUS), 'non_pro')
})

await test('trial_eligible only (not started) → non_pro (not expired, not active)', () => {
  const status = { ...NON_PRO_STATUS, trial_eligible: true }
  assert.strictEqual(classifyProStatus(status), 'non_pro')
})

// ── trial_expired → 'expired' ─────────────────────────────────────────────────

await test('trial expired: trial_expired=true, can_use_pro=false → expired', () => {
  assert.strictEqual(classifyProStatus(TRIAL_EXPIRED_STATUS), 'expired')
})

// ── trial_active → 'trial' ────────────────────────────────────────────────────

await test('active trial: can_use_pro=true, trial_active=true, permanent_pro=false → trial', () => {
  assert.strictEqual(classifyProStatus(TRIAL_ACTIVE_STATUS), 'trial')
})

// ── permanent_pro → 'permanent' ───────────────────────────────────────────────

await test('permanent Pro: permanent_pro=true → permanent', () => {
  assert.strictEqual(classifyProStatus(PERMANENT_STATUS), 'permanent')
})

await test('permanent always wins over active trial fields', () => {
  // Both permanent_pro and trial_active are true — permanent takes priority
  const both = { ...TRIAL_ACTIVE_STATUS, permanent_pro: true }
  assert.strictEqual(classifyProStatus(both), 'permanent')
})

console.log('All pro-ui-status tests passed.')
