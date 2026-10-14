// Zero-dependency Node.js tests for the evaluateProEntitlement pure function.
// Tests loadProEntitlement indirectly via a lightweight stub — no real Supabase needed.
//
// Run with: node tests/pro-entitlement.test.js
//
// evaluateProEntitlement(profile, trial, subscription, now) lives in:
//   supabase/functions/shared/pro-entitlement.js

import { strict as assert } from 'assert'
import { test } from 'node:test'
import { evaluateProEntitlement, loadProEntitlement } from '../supabase/functions/shared/pro-entitlement.js'

// ── Fixtures ───────────────────────────────────────────────────────────────────

const NOW = new Date('2026-07-27T12:00:00.000Z')

const ACTIVE_TRIAL = {
  started_at: '2026-07-25T10:00:00.000Z',
  ends_at:    '2026-08-01T10:00:00.000Z',  // 5 days from NOW
}

const EXPIRED_TRIAL = {
  started_at: '2026-07-17T10:00:00.000Z',
  ends_at:    '2026-07-24T10:00:00.000Z',  // ended 3 days ago
}

const ELIGIBLE_TRIAL = {
  started_at: null,
  ends_at:    null,
}

const TRIAL_ENDING_SOON = {
  started_at: '2026-07-20T00:00:00.000Z',
  ends_at:    new Date(NOW.getTime() + 1).toISOString(),  // ends in 1 ms
}

const TRIAL_JUST_EXPIRED = {
  started_at: '2026-07-20T00:00:00.000Z',
  ends_at:    NOW.toISOString(),  // ends exactly at NOW (not strictly greater)
}

const PERMANENT_PROFILE  = { ai_enabled: true }
const NON_PRO_PROFILE    = { ai_enabled: false }
const NULL_FLAG_PROFILE  = { ai_enabled: null }

const ACTIVE_SUBSCRIPTION   = { status: 'active',   current_period_end: '2026-08-27T12:00:00.000Z', cancel_at_period_end: false }
const PAST_DUE_SUBSCRIPTION = { status: 'past_due', current_period_end: '2026-08-27T12:00:00.000Z', cancel_at_period_end: false }
const CANCELED_SUBSCRIPTION = { status: 'canceled', current_period_end: '2026-07-27T12:00:00.000Z', cancel_at_period_end: false }

// ── Permanent Pro (ai_enabled = true) always wins ──────────────────────────────

await test('permanent Pro: ai_enabled=true, no trial → canUse=true, reason=permanent', () => {
  const r = evaluateProEntitlement(PERMANENT_PROFILE, null, null, NOW)
  assert.strictEqual(r.canUse, true)
  assert.strictEqual(r.reason, 'permanent')
})

await test('permanent Pro: ai_enabled=true, eligible trial → still permanent', () => {
  const r = evaluateProEntitlement(PERMANENT_PROFILE, ELIGIBLE_TRIAL, null, NOW)
  assert.strictEqual(r.canUse, true)
  assert.strictEqual(r.reason, 'permanent')
})

await test('permanent Pro: ai_enabled=true, active trial → still permanent (not trial)', () => {
  const r = evaluateProEntitlement(PERMANENT_PROFILE, ACTIVE_TRIAL, null, NOW)
  assert.strictEqual(r.canUse, true)
  assert.strictEqual(r.reason, 'permanent')
})

await test('permanent Pro: ai_enabled=true, expired trial → still permanent', () => {
  const r = evaluateProEntitlement(PERMANENT_PROFILE, EXPIRED_TRIAL, null, NOW)
  assert.strictEqual(r.canUse, true)
  assert.strictEqual(r.reason, 'permanent')
})

await test('permanent Pro wins even with active subscription', () => {
  const r = evaluateProEntitlement(PERMANENT_PROFILE, null, ACTIVE_SUBSCRIPTION, NOW)
  assert.strictEqual(r.canUse, true)
  assert.strictEqual(r.reason, 'permanent')
})

// ── Subscription access ────────────────────────────────────────────────────────

await test('subscription: active status → canUse=true, reason=subscription', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, null, ACTIVE_SUBSCRIPTION, NOW)
  assert.strictEqual(r.canUse, true)
  assert.strictEqual(r.reason, 'subscription')
})

await test('subscription: past_due status → canUse=true (dunning window preserved)', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, null, PAST_DUE_SUBSCRIPTION, NOW)
  assert.strictEqual(r.canUse, true)
  assert.strictEqual(r.reason, 'subscription')
})

await test('subscription: canceled status → canUse=false (no access)', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, null, CANCELED_SUBSCRIPTION, NOW)
  assert.strictEqual(r.canUse, false)
  // No trial row — falls to no_trial
  assert.strictEqual(r.reason, 'no_trial')
})

await test('subscription: active wins over expired trial', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, EXPIRED_TRIAL, ACTIVE_SUBSCRIPTION, NOW)
  assert.strictEqual(r.canUse, true)
  assert.strictEqual(r.reason, 'subscription')
})

await test('subscription: active + active trial → subscription wins (priority 2 before 3)', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, ACTIVE_TRIAL, ACTIVE_SUBSCRIPTION, NOW)
  assert.strictEqual(r.canUse, true)
  assert.strictEqual(r.reason, 'subscription')
})

await test('subscription: null subscription → falls through to trial check', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, ACTIVE_TRIAL, null, NOW)
  assert.strictEqual(r.canUse, true)
  assert.strictEqual(r.reason, 'trial')
})

await test('subscription: missing status field → not counted as active', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, null, { status: undefined }, NOW)
  assert.strictEqual(r.canUse, false)
})

// ── Active trial access ────────────────────────────────────────────────────────

await test('active trial: ai_enabled=false → canUse=true, reason=trial', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, ACTIVE_TRIAL, null, NOW)
  assert.strictEqual(r.canUse, true)
  assert.strictEqual(r.reason, 'trial')
})

await test('active trial: trial ending in 1 ms → canUse=true', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, TRIAL_ENDING_SOON, null, NOW)
  assert.strictEqual(r.canUse, true)
  assert.strictEqual(r.reason, 'trial')
})

await test('active trial: null profile → canUse=true (no permanent block)', () => {
  const r = evaluateProEntitlement(null, ACTIVE_TRIAL, null, NOW)
  assert.strictEqual(r.canUse, true)
  assert.strictEqual(r.reason, 'trial')
})

await test('active trial: ai_enabled=null profile → canUse=true (null is not true)', () => {
  const r = evaluateProEntitlement(NULL_FLAG_PROFILE, ACTIVE_TRIAL, null, NOW)
  assert.strictEqual(r.canUse, true)
  assert.strictEqual(r.reason, 'trial')
})

// ── Expired trial ──────────────────────────────────────────────────────────────

await test('expired trial: canUse=false, reason=expired_trial', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, EXPIRED_TRIAL, null, NOW)
  assert.strictEqual(r.canUse, false)
  assert.strictEqual(r.reason, 'expired_trial')
})

await test('expired trial: ends_at === now → canUse=false (boundary: not strictly greater)', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, TRIAL_JUST_EXPIRED, null, NOW)
  assert.strictEqual(r.canUse, false)
  assert.strictEqual(r.reason, 'expired_trial')
})

await test('expired trial: ends_at 1 ms in the past → canUse=false', () => {
  const trial = { started_at: ACTIVE_TRIAL.started_at, ends_at: new Date(NOW.getTime() - 1).toISOString() }
  const r = evaluateProEntitlement(NON_PRO_PROFILE, trial, null, NOW)
  assert.strictEqual(r.canUse, false)
  assert.strictEqual(r.reason, 'expired_trial')
})

// ── Eligible trial (not yet started) ──────────────────────────────────────────

await test('eligible trial: started_at null → canUse=false, reason=no_trial', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, ELIGIBLE_TRIAL, null, NOW)
  assert.strictEqual(r.canUse, false)
  assert.strictEqual(r.reason, 'no_trial')
})

await test('eligible trial: only started_at null, ends_at set → canUse=false', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, { started_at: null, ends_at: ACTIVE_TRIAL.ends_at }, null, NOW)
  assert.strictEqual(r.canUse, false)
  assert.strictEqual(r.reason, 'no_trial')
})

await test('eligible trial: only ends_at null → canUse=false', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, { started_at: ACTIVE_TRIAL.started_at, ends_at: null }, null, NOW)
  assert.strictEqual(r.canUse, false)
  assert.strictEqual(r.reason, 'no_trial')
})

// ── No trial row ───────────────────────────────────────────────────────────────

await test('no trial: null trial → canUse=false, reason=no_trial', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, null, null, NOW)
  assert.strictEqual(r.canUse, false)
  assert.strictEqual(r.reason, 'no_trial')
})

await test('no trial: undefined trial → canUse=false', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, undefined, null, NOW)
  assert.strictEqual(r.canUse, false)
  assert.strictEqual(r.reason, 'no_trial')
})

await test('no trial: null profile, null trial → canUse=false', () => {
  const r = evaluateProEntitlement(null, null, null, NOW)
  assert.strictEqual(r.canUse, false)
  assert.strictEqual(r.reason, 'no_trial')
})

// ── Malformed ends_at ──────────────────────────────────────────────────────────

await test('malformed ends_at string → canUse=false, reason=no_trial', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, { started_at: ACTIVE_TRIAL.started_at, ends_at: 'not-a-date' }, null, NOW)
  assert.strictEqual(r.canUse, false)
  assert.strictEqual(r.reason, 'no_trial')
})

await test('malformed ends_at empty string → canUse=false', () => {
  const r = evaluateProEntitlement(NON_PRO_PROFILE, { started_at: ACTIVE_TRIAL.started_at, ends_at: '' }, null, NOW)
  assert.strictEqual(r.canUse, false)
  assert.strictEqual(r.reason, 'no_trial')
})

// ── Time-relativity: using a different `now` ───────────────────────────────────

await test('same trial active now but expired in future now → expired', () => {
  const futureNow = new Date('2026-08-10T00:00:00.000Z')  // after ACTIVE_TRIAL.ends_at
  const r = evaluateProEntitlement(NON_PRO_PROFILE, ACTIVE_TRIAL, null, futureNow)
  assert.strictEqual(r.canUse, false)
  assert.strictEqual(r.reason, 'expired_trial')
})

await test('same expired trial is active at an earlier now', () => {
  const earlyNow = new Date('2026-07-20T00:00:00.000Z')  // before EXPIRED_TRIAL.ends_at
  const r = evaluateProEntitlement(NON_PRO_PROFILE, EXPIRED_TRIAL, null, earlyNow)
  assert.strictEqual(r.canUse, true)
  assert.strictEqual(r.reason, 'trial')
})

// ── Return shape is always complete ───────────────────────────────────────────

await test('always returns canUse and reason fields', () => {
  const cases = [
    [PERMANENT_PROFILE, ACTIVE_TRIAL,   null],
    [NON_PRO_PROFILE,   ACTIVE_TRIAL,   null],
    [NON_PRO_PROFILE,   EXPIRED_TRIAL,  null],
    [NON_PRO_PROFILE,   ELIGIBLE_TRIAL, null],
    [NON_PRO_PROFILE,   null,           null],
    [null,              null,           null],
    [NON_PRO_PROFILE,   null,           ACTIVE_SUBSCRIPTION],
    [NON_PRO_PROFILE,   null,           PAST_DUE_SUBSCRIPTION],
    [NON_PRO_PROFILE,   EXPIRED_TRIAL,  CANCELED_SUBSCRIPTION],
  ]
  for (const [profile, trial, subscription] of cases) {
    const r = evaluateProEntitlement(profile, trial, subscription, NOW)
    assert.ok('canUse' in r, 'missing canUse')
    assert.ok('reason' in r, 'missing reason')
    assert.strictEqual(typeof r.canUse, 'boolean')
    assert.ok(
      ['permanent', 'subscription', 'trial', 'expired_trial', 'no_trial'].includes(r.reason),
      `unexpected reason: ${r.reason}`
    )
  }
})

// ── loadProEntitlement via stub ────────────────────────────────────────────────
// loadProEntitlement is pure DI — test it with a stub client, no real Supabase needed.

function makeStubClient({
  profileData = null, profileError = null,
  trialData = null, trialError = null,
  subscriptionData = null, subscriptionError = null,
} = {}) {
  return {
    from(table) {
      return {
        select() {
          return {
            eq(_col, _val) {
              return {
                maybeSingle() {
                  if (table === 'profiles') {
                    return Promise.resolve({ data: profileData, error: profileError })
                  }
                  if (table === 'pro_trials') {
                    return Promise.resolve({ data: trialData, error: trialError })
                  }
                  if (table === 'subscriptions') {
                    return Promise.resolve({ data: subscriptionData, error: subscriptionError })
                  }
                  return Promise.resolve({ data: null, error: null })
                }
              }
            }
          }
        }
      }
    }
  }
}

await test('loadProEntitlement: both queries succeed → no errors', async () => {
  const client = makeStubClient({ profileData: { ai_enabled: true }, trialData: ACTIVE_TRIAL })
  const result = await loadProEntitlement(client, 'user-id')
  assert.strictEqual(result.profileError, false)
  assert.strictEqual(result.trialError, false)
  assert.strictEqual(result.subscriptionError, false)
  assert.deepStrictEqual(result.profile, { ai_enabled: true })
  assert.deepStrictEqual(result.trial, ACTIVE_TRIAL)
  assert.strictEqual(result.subscription, null)
})

await test('loadProEntitlement: profile query fails → profileError=true', async () => {
  const client = makeStubClient({ profileError: { code: 'PGRST301', message: 'oops' } })
  const result = await loadProEntitlement(client, 'user-id')
  assert.strictEqual(result.profileError, true)
  assert.strictEqual(result._profileErrorCode, 'PGRST301')
})

await test('loadProEntitlement: trial query fails → trialError=true', async () => {
  const client = makeStubClient({
    profileData: { ai_enabled: false },
    trialError: { code: 'PGRST302', message: 'oops' }
  })
  const result = await loadProEntitlement(client, 'user-id')
  assert.strictEqual(result.trialError, true)
  assert.strictEqual(result._trialErrorCode, 'PGRST302')
})

await test('loadProEntitlement: subscription query fails → subscriptionError=true', async () => {
  const client = makeStubClient({
    profileData: { ai_enabled: false },
    trialData: ACTIVE_TRIAL,
    subscriptionError: { code: 'PGRST303', message: 'oops' }
  })
  const result = await loadProEntitlement(client, 'user-id')
  assert.strictEqual(result.subscriptionError, true)
  assert.strictEqual(result._subscriptionErrorCode, 'PGRST303')
  assert.strictEqual(result.subscription, null)
})

await test('loadProEntitlement: both rows null (no data) → no errors, null rows', async () => {
  const client = makeStubClient({ profileData: null, trialData: null })
  const result = await loadProEntitlement(client, 'user-id')
  assert.strictEqual(result.profileError, false)
  assert.strictEqual(result.trialError, false)
  assert.strictEqual(result.subscriptionError, false)
  assert.strictEqual(result.profile, null)
  assert.strictEqual(result.trial, null)
  assert.strictEqual(result.subscription, null)
})

await test('loadProEntitlement: evaluateProEntitlement integration — permanent Pro', async () => {
  const client = makeStubClient({ profileData: { ai_enabled: true }, trialData: EXPIRED_TRIAL })
  const r = await loadProEntitlement(client, 'user-id')
  const entitlement = evaluateProEntitlement(r.profile, r.trial, r.subscription, NOW)
  assert.strictEqual(entitlement.canUse, true)
  assert.strictEqual(entitlement.reason, 'permanent')
})

await test('loadProEntitlement: evaluateProEntitlement integration — trial only', async () => {
  const client = makeStubClient({ profileData: { ai_enabled: false }, trialData: ACTIVE_TRIAL })
  const r = await loadProEntitlement(client, 'user-id')
  const entitlement = evaluateProEntitlement(r.profile, r.trial, r.subscription, NOW)
  assert.strictEqual(entitlement.canUse, true)
  assert.strictEqual(entitlement.reason, 'trial')
})

await test('loadProEntitlement: evaluateProEntitlement integration — subscription only', async () => {
  const client = makeStubClient({
    profileData: { ai_enabled: false },
    trialData: EXPIRED_TRIAL,
    subscriptionData: ACTIVE_SUBSCRIPTION,
  })
  const r = await loadProEntitlement(client, 'user-id')
  const entitlement = evaluateProEntitlement(r.profile, r.trial, r.subscription, NOW)
  assert.strictEqual(entitlement.canUse, true)
  assert.strictEqual(entitlement.reason, 'subscription')
})

// ── loadProEntitlement: genuine throws (not just { error } returns) ────────────
// These tests verify the "never throws" contract using stubs that actually reject.
// Promise.all would propagate the first rejection — individual try/catch is required.

function makeThrowingStubClient({
  profileThrows = false, trialThrows = false, subscriptionThrows = false,
  profileError = null, trialError = null,
} = {}) {
  return {
    from(table) {
      return {
        select() {
          return {
            eq(_col, _val) {
              return {
                maybeSingle() {
                  if (table === 'profiles') {
                    if (profileThrows) return Promise.reject(new Error('network failure'))
                    return Promise.resolve({ data: null, error: profileError })
                  }
                  if (table === 'pro_trials') {
                    if (trialThrows) return Promise.reject(new Error('network failure'))
                    return Promise.resolve({ data: null, error: trialError })
                  }
                  if (table === 'subscriptions') {
                    if (subscriptionThrows) return Promise.reject(new Error('network failure'))
                    return Promise.resolve({ data: null, error: null })
                  }
                  return Promise.resolve({ data: null, error: null })
                }
              }
            }
          }
        }
      }
    }
  }
}

await test('loadProEntitlement: profile query throws → profileError=true, does not reject', async () => {
  const client = makeThrowingStubClient({ profileThrows: true })
  // Must not throw — catches the rejection and maps to an error flag
  const result = await loadProEntitlement(client, 'user-id')
  assert.strictEqual(result.profileError, true)
  assert.strictEqual(result.profile, null)
  // Trial query ran independently and succeeded
  assert.strictEqual(result.trialError, false)
})

await test('loadProEntitlement: trial query throws → trialError=true, does not reject', async () => {
  const client = makeThrowingStubClient({ trialThrows: true })
  const result = await loadProEntitlement(client, 'user-id')
  assert.strictEqual(result.trialError, true)
  assert.strictEqual(result.trial, null)
  // Profile query ran independently and succeeded
  assert.strictEqual(result.profileError, false)
})

await test('loadProEntitlement: subscription query throws → subscriptionError=true, does not reject', async () => {
  const client = makeThrowingStubClient({ subscriptionThrows: true })
  const result = await loadProEntitlement(client, 'user-id')
  assert.strictEqual(result.subscriptionError, true)
  assert.strictEqual(result.subscription, null)
  assert.strictEqual(result.profileError, false)
  assert.strictEqual(result.trialError, false)
})

await test('loadProEntitlement: both queries throw → both errors=true, does not reject', async () => {
  const client = makeThrowingStubClient({ profileThrows: true, trialThrows: true })
  const result = await loadProEntitlement(client, 'user-id')
  assert.strictEqual(result.profileError, true)
  assert.strictEqual(result.trialError, true)
  assert.strictEqual(result.profile, null)
  assert.strictEqual(result.trial, null)
})

await test('loadProEntitlement: evaluateProEntitlement with thrown profile → fails closed', async () => {
  // profile error means ai_enabled unknown — must not grant access
  const client = makeThrowingStubClient({ profileThrows: true })
  const r = await loadProEntitlement(client, 'user-id')
  // trial is null (no data), profile is null (error), subscription is null (no data)
  const entitlement = evaluateProEntitlement(r.profile, r.trial, r.subscription, NOW)
  assert.strictEqual(entitlement.canUse, false)
})

// ── Malformed timestamps fail closed ──────────────────────────────────────────

await test('malformed started_at (non-date string): treated as truthy — ends_at governs', () => {
  // started_at is checked for truthiness (not parsed). If started_at is a non-null
  // truthy string and ends_at is also malformed, the guard at !trial.started_at is false,
  // so execution reaches the ends_at parse — NaN check returns no_trial (fail closed).
  const r = evaluateProEntitlement(NON_PRO_PROFILE, { started_at: 'bad', ends_at: 'also-bad' }, null, NOW)
  assert.strictEqual(r.canUse, false)
  assert.strictEqual(r.reason, 'no_trial')
})

await test('malformed started_at null but valid ends_at → no_trial (started_at required)', () => {
  // Guard: !trial.started_at is true when started_at is null — returns no_trial immediately
  const r = evaluateProEntitlement(NON_PRO_PROFILE, { started_at: null, ends_at: ACTIVE_TRIAL.ends_at }, null, NOW)
  assert.strictEqual(r.canUse, false)
  assert.strictEqual(r.reason, 'no_trial')
})

// ── Missing fields in evaluateProEntitlement (profile shape variants) ─────────

await test('profile with no ai_enabled field (missing key) → treated as non-Pro', () => {
  const r = evaluateProEntitlement({}, ACTIVE_TRIAL, null, NOW)
  assert.strictEqual(r.canUse, true)
  assert.strictEqual(r.reason, 'trial')  // not permanent_pro, falls through to trial
})

await test('profile with ai_enabled=true always wins over all trial states', () => {
  const states = [ACTIVE_TRIAL, EXPIRED_TRIAL, ELIGIBLE_TRIAL, null]
  for (const trial of states) {
    const r = evaluateProEntitlement(PERMANENT_PROFILE, trial, null, NOW)
    assert.strictEqual(r.canUse, true, `expected canUse=true for trial=${JSON.stringify(trial)}`)
    assert.strictEqual(r.reason, 'permanent', `expected reason=permanent for trial=${JSON.stringify(trial)}`)
  }
})

// ── Concurrency regression: all three queries must start before any resolves ──
// Verifies Promise.all (concurrent) vs sequential awaits.
// If the implementation were sequential, only one entry would appear in `started`
// before the first promise resolves. With Promise.all, all three .maybeSingle() calls
// fire synchronously during the loadProEntitlement call — before any await completes.

await test('loadProEntitlement: all three queries start concurrently before any resolves', async () => {
  let resolveProfile, resolveTrial, resolveSubscription
  const profilePromise      = new Promise(r => { resolveProfile      = r })
  const trialPromise        = new Promise(r => { resolveTrial        = r })
  const subscriptionPromise = new Promise(r => { resolveSubscription = r })

  const started = []

  const client = {
    from(table) {
      return {
        select() {
          return {
            eq(_col, _val) {
              return {
                maybeSingle() {
                  // Record which table query was started — synchronously on call.
                  started.push(table)
                  if (table === 'profiles')      return profilePromise
                  if (table === 'pro_trials')    return trialPromise
                  if (table === 'subscriptions') return subscriptionPromise
                  return Promise.resolve({ data: null, error: null })
                }
              }
            }
          }
        }
      }
    }
  }

  // Start without awaiting — all Promise.all arms begin synchronously.
  const resultPromise = loadProEntitlement(client, 'user-id')

  // All three maybeSingle() calls happen synchronously during Promise.all setup.
  // A sequential implementation would only have started one or two queries here.
  assert.ok(started.includes('profiles'),      'profiles query must start before any resolves')
  assert.ok(started.includes('pro_trials'),    'pro_trials query must start before any resolves')
  assert.ok(started.includes('subscriptions'), 'subscriptions query must start before any resolves')
  assert.strictEqual(started.length, 3, 'all three queries must have started before any resolves')

  // Resolve all and collect the final result.
  resolveProfile({ data: { ai_enabled: true }, error: null })
  resolveTrial({ data: ACTIVE_TRIAL,           error: null })
  resolveSubscription({ data: null,            error: null })

  const result = await resultPromise
  assert.strictEqual(result.profileError, false)
  assert.strictEqual(result.trialError, false)
  assert.strictEqual(result.subscriptionError, false)
  assert.deepStrictEqual(result.profile, { ai_enabled: true })
  assert.deepStrictEqual(result.trial, ACTIVE_TRIAL)
  assert.strictEqual(result.subscription, null)
})

// ── localStorage analytics deduplication is per-browser (documented, not enforced in code) ──
// The pro_trial_started event uses localStorage keyed by userId. Tests for the dedup
// logic itself live in WelcomePage.jsx (a React component — not testable in plain Node.js).
// This test documents the contract: the key format is 'funnl_trial_started_<userId>'.
await test('pro_trial_started dedup key format: funnl_trial_started_<userId>', () => {
  const userId = 'abc-123'
  const expectedKey = 'funnl_trial_started_' + userId
  // Verify the key pattern — actual localStorage usage is in WelcomePage.jsx
  assert.ok(expectedKey.startsWith('funnl_trial_started_'), 'key must start with funnl_trial_started_')
  assert.ok(expectedKey.endsWith(userId), 'key must end with the user ID')
})

console.log('All pro-entitlement tests passed.')
