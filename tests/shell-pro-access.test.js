/**
 * Shell Pro-access tests
 *
 * Verifies that the classification logic used by shell components
 * (BottomNav, CommandPalette) correctly gates AI actions across all
 * six meaningful states. Both components share the same pattern:
 *
 *   const displayStatus = classifyProStatus(proStatus)
 *   const canUsePro = displayStatus === 'permanent' || displayStatus === 'trial'
 *
 * proStatus lifecycle:
 *   null      — initial state; getProAccessStatus() not yet resolved (loading)
 *   'error'   — getProAccessStatus() returned null (RPC failed/rejected)
 *   object    — successful response from get_my_pro_access_status() RPC
 *
 * Required shell behavior:
 *   - Permanent Pro     → canUsePro = true  (AI actions shown)
 *   - Active trial      → canUsePro = true  (AI actions shown)
 *   - Expired trial     → canUsePro = false (AI actions hidden)
 *   - Non-Pro           → canUsePro = false (AI actions hidden)
 *   - Loading (null)    → canUsePro = false (AI actions hidden; no flash)
 *   - Unavailable/error → canUsePro = false (AI actions hidden; fail closed)
 *
 * Never show an AI action before status resolves.
 * Never show a false lock when status is unavailable.
 * Never flash AI then hide it (proStatus starts null → always hides initially).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyProStatus } from '../src/lib/pro-ui-status.js'

// ── Helper ────────────────────────────────────────────────────────────────────

function canUsePro(proStatus) {
  const displayStatus = classifyProStatus(proStatus)
  return displayStatus === 'permanent' || displayStatus === 'trial'
}

// ── Loading (null) ────────────────────────────────────────────────────────────
// proStatus starts null before getProAccessStatus() resolves.
// AI actions must be hidden — no flash of Pro UI while loading.

test('loading: proStatus null → canUsePro = false, no AI flash', () => {
  assert.equal(canUsePro(null), false)
})

test('loading: classifyProStatus(null) === unavailable', () => {
  assert.equal(classifyProStatus(null), 'unavailable')
})

// ── Unavailable / error ───────────────────────────────────────────────────────
// getProAccessStatus() returns null on RPC failure; component stores 'error'.
// Must fail closed — hide AI actions, but do NOT show an explicit non-Pro lock.
// The caller must check: displayStatus !== 'expired' && displayStatus !== 'non_pro'
// to avoid showing a false "you're not Pro" message when status is merely unknown.

test('unavailable: proStatus "error" → canUsePro = false', () => {
  assert.equal(canUsePro('error'), false)
})

test('unavailable: classifyProStatus("error") === unavailable (not "non_pro")', () => {
  // Shell must distinguish unavailable from non_pro to avoid false lock messages.
  assert.equal(classifyProStatus('error'), 'unavailable')
})

test('unavailable: malformed proStatus object → unavailable, not non_pro', () => {
  assert.equal(classifyProStatus({}), 'unavailable')
  assert.equal(classifyProStatus({ can_use_pro: 'yes' }), 'unavailable')
})

// ── Non-Pro ───────────────────────────────────────────────────────────────────
// Confirmed non-Pro: no trial, ai_enabled = false, can_use_pro = false.
// AI actions hidden.

test('non_pro: no trial, no permanent access → canUsePro = false', () => {
  const status = {
    permanent_pro: false,
    trial_eligible: false,
    trial_active: false,
    trial_expired: false,
    days_remaining: 0,
    ends_at: null,
    can_use_pro: false,
  }
  assert.equal(canUsePro(status), false)
  assert.equal(classifyProStatus(status), 'non_pro')
})

test('non_pro: trial eligible (not started) → canUsePro = false', () => {
  const status = {
    permanent_pro: false,
    trial_eligible: true,
    trial_active: false,
    trial_expired: false,
    days_remaining: 0,
    ends_at: null,
    can_use_pro: false,
  }
  assert.equal(canUsePro(status), false)
})

// ── Expired trial ─────────────────────────────────────────────────────────────
// Trial has ended, user has no permanent access.
// AI actions hidden. (FunnlAIPage shows the expired state; shell just hides actions.)

test('expired: trial_expired = true, can_use_pro = false → canUsePro = false', () => {
  const status = {
    permanent_pro: false,
    trial_eligible: false,
    trial_active: false,
    trial_expired: true,
    days_remaining: 0,
    ends_at: '2026-07-21T00:00:00.000Z',
    can_use_pro: false,
  }
  assert.equal(canUsePro(status), false)
  assert.equal(classifyProStatus(status), 'expired')
})

// ── Active trial ──────────────────────────────────────────────────────────────
// Trial is currently running. can_use_pro = true. AI actions shown.

test('active trial: trial_active = true, can_use_pro = true → canUsePro = true', () => {
  const status = {
    permanent_pro: false,
    trial_eligible: false,
    trial_active: true,
    trial_expired: false,
    days_remaining: 5,
    ends_at: '2026-08-04T00:00:00.000Z',
    can_use_pro: true,
  }
  assert.equal(canUsePro(status), true)
  assert.equal(classifyProStatus(status), 'trial')
})

test('active trial: last day (days_remaining = 1) → canUsePro = true', () => {
  const status = {
    permanent_pro: false,
    trial_eligible: false,
    trial_active: true,
    trial_expired: false,
    days_remaining: 1,
    ends_at: '2026-07-29T00:00:00.000Z',
    can_use_pro: true,
  }
  assert.equal(canUsePro(status), true)
})

// ── Permanent Pro ─────────────────────────────────────────────────────────────
// ai_enabled = true on profiles row. Takes display priority over trial fields.
// AI actions shown.

test('permanent: ai_enabled=true → canUsePro = true', () => {
  const status = {
    permanent_pro: true,
    trial_eligible: false,
    trial_active: false,
    trial_expired: false,
    days_remaining: 0,
    ends_at: null,
    can_use_pro: true,
  }
  assert.equal(canUsePro(status), true)
  assert.equal(classifyProStatus(status), 'permanent')
})

test('permanent: permanent_pro=true always wins over trial fields', () => {
  // Even if trial is expired, permanent_pro wins.
  const status = {
    permanent_pro: true,
    trial_eligible: false,
    trial_active: false,
    trial_expired: true,
    days_remaining: 0,
    ends_at: '2026-07-01T00:00:00.000Z',
    can_use_pro: true,
  }
  assert.equal(canUsePro(status), true)
  assert.equal(classifyProStatus(status), 'permanent')
})

// ── No-flash guarantee ────────────────────────────────────────────────────────
// The proStatus state is initialized as null (not false, not 'error').
// Verify the state machine never produces a truthy canUsePro before resolution.

test('no-flash: initial null → cannot use pro; only resolves true after loaded status', () => {
  // t=0: null (loading) — AI hidden
  assert.equal(canUsePro(null), false)
  // t=1: status arrives (permanent Pro) — AI shown
  const loaded = { permanent_pro: true, trial_active: false, trial_expired: false, trial_eligible: false, days_remaining: 0, ends_at: null, can_use_pro: true }
  assert.equal(canUsePro(loaded), true)
})

test('no-flash: if RPC fails (null → "error"), AI stays hidden — no intermediate true', () => {
  assert.equal(canUsePro(null), false)   // before resolve
  assert.equal(canUsePro('error'), false) // after failed resolve
})

// ── Summary ───────────────────────────────────────────────────────────────────

const results = {
  'Loading (null)':        canUsePro(null),
  'Unavailable (error)':   canUsePro('error'),
  'Non-Pro':               canUsePro({ permanent_pro: false, trial_eligible: false, trial_active: false, trial_expired: false, days_remaining: 0, ends_at: null, can_use_pro: false }),
  'Expired trial':         canUsePro({ permanent_pro: false, trial_eligible: false, trial_active: false, trial_expired: true,  days_remaining: 0, ends_at: '2026-07-01T00:00:00.000Z', can_use_pro: false }),
  'Active trial':          canUsePro({ permanent_pro: false, trial_eligible: false, trial_active: true,  trial_expired: false, days_remaining: 5, ends_at: '2026-08-04T00:00:00.000Z', can_use_pro: true }),
  'Permanent Pro':         canUsePro({ permanent_pro: true,  trial_eligible: false, trial_active: false, trial_expired: false, days_remaining: 0, ends_at: null, can_use_pro: true }),
}

// Verify expected values
assert.equal(results['Loading (null)'],      false, 'Loading must be false')
assert.equal(results['Unavailable (error)'], false, 'Error must be false')
assert.equal(results['Non-Pro'],             false, 'Non-Pro must be false')
assert.equal(results['Expired trial'],       false, 'Expired must be false')
assert.equal(results['Active trial'],        true,  'Active trial must be true')
assert.equal(results['Permanent Pro'],       true,  'Permanent Pro must be true')
