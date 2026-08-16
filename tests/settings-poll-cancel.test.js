/**
 * C4 tests: SettingsPage checkout-return polling is cancelled + gated on account switch.
 *
 * Exercises the REAL production helpers (runCheckoutPolling + isStalePollResult) via a
 * harness that mirrors the SettingsPage effect's result handling, proving a stale poll
 * (account switch / sign-out / newer run / unmount) never sets confirmed/timed_out or
 * fires subscription_access_confirmed / subscription_confirmation_timed_out.
 *
 * Zero deps — runs with: node tests/settings-poll-cancel.test.js
 */
import { runCheckoutPolling, isStalePollResult, shouldStartCheckoutPoll } from '../src/lib/checkoutPolling.js'

let passed = 0, failed = 0
const RUN = []
function test(name, fn) { RUN.push({ name, fn }) }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

// ── isStalePollResult (pure) ────────────────────────────────────────────────────
const BASE = { mounted: true, aborted: false, capturedGen: 1, currentGen: 1, capturedUid: 'A', currentUid: 'A' }
test('not stale when everything matches', () => assertEqual(isStalePollResult(BASE), false))
test('stale when unmounted', () => assertEqual(isStalePollResult({ ...BASE, mounted: false }), true))
test('stale when aborted', () => assertEqual(isStalePollResult({ ...BASE, aborted: true }), true))
test('stale when generation changed', () => assertEqual(isStalePollResult({ ...BASE, currentGen: 2 }), true))
test('stale when uid changed', () => assertEqual(isStalePollResult({ ...BASE, currentUid: 'B' }), true))
test('NOT stale on mount-time null->uid of same initial account (capturedUid null)', () => {
  assertEqual(isStalePollResult({ ...BASE, capturedUid: null, currentUid: 'A' }), false)
})
test('NOT stale when current uid unknown yet (null)', () => {
  assertEqual(isStalePollResult({ ...BASE, currentUid: null }), false)
})

// ── Harness mirroring the SettingsPage polling effect ──────────────────────────
// Uses the real runCheckoutPolling + isStalePollResult. `switchAt` optionally bumps the
// account generation (and aborts) after a chosen number of delay ticks, simulating an
// account switch mid-poll.
function makeInstantDelay() {
  // Resolves each delay on a microtask so the loop advances but tests stay fast.
  return () => Promise.resolve()
}

async function runSettingsPoll({ accessOn = 99, timeoutRun = false, switchAtRefresh = -1, unmount = false } = {}) {
  const analytics = []
  let pollingState = 'polling'
  const gen = { value: 1 }
  const uid = { value: 'A' }
  const mounted = { value: true }
  const controller = new AbortController()
  const capturedGen = gen.value
  const capturedUid = uid.value

  let refreshCount = 0
  const refreshFn = () => {
    refreshCount++
    // Simulate an account switch happening on the Nth refresh.
    if (refreshCount === switchAtRefresh) {
      gen.value++            // account-switch bump
      uid.value = 'B'
      controller.abort()     // SettingsPage aborts synchronously on switch
    }
    if (unmount && refreshCount === 1) mounted.value = false
    // Return a status object; hasAccessFn decides confirmation.
    return Promise.resolve(refreshCount >= accessOn ? { can_use_pro: true } : { can_use_pro: false })
  }
  const hasAccessFn = (s) => s?.can_use_pro === true

  const result = await runCheckoutPolling({
    refreshFn,
    hasAccessFn: timeoutRun ? () => false : hasAccessFn,
    signal: controller.signal,
    delayFn: makeInstantDelay(),
  })

  const stale = isStalePollResult({
    mounted: mounted.value, aborted: controller.signal.aborted,
    capturedGen, currentGen: gen.value, capturedUid, currentUid: uid.value,
  })
  if (!stale) {
    if (result === 'confirmed') { pollingState = 'confirmed'; analytics.push('subscription_access_confirmed') }
    else if (result === 'timeout') { pollingState = 'timed_out'; analytics.push('subscription_confirmation_timed_out') }
  }
  return { result, pollingState, analytics, refreshCount }
}

test('switch during polling (mid-refresh) → aborted, no confirm, no analytics', async () => {
  const r = await runSettingsPoll({ accessOn: 99, switchAtRefresh: 1 })
  assertEqual(r.result, 'aborted')
  assertEqual(r.pollingState, 'polling', 'must not transition to confirmed/timed_out for the new account')
  assertEqual(r.analytics.length, 0, 'no stale analytics')
})

test('switch just before confirmation → confirmed result but discarded (stale)', async () => {
  // Confirm on refresh #1 AND switch on refresh #1: the poll returns confirmed, but the
  // generation changed, so the result is stale and must not fire analytics.
  const r = await runSettingsPoll({ accessOn: 1, switchAtRefresh: 1 })
  assertEqual(r.analytics.length, 0, 'stale confirmation must not fire subscription_access_confirmed')
  assertEqual(r.pollingState, 'polling')
})

test('switch just before timeout → timeout discarded (stale)', async () => {
  const r = await runSettingsPoll({ timeoutRun: true, switchAtRefresh: 4 })
  assertEqual(r.analytics.length, 0, 'stale timeout must not fire subscription_confirmation_timed_out')
})

test('unmount mid-poll → no state/analytics', async () => {
  const r = await runSettingsPoll({ accessOn: 1, unmount: true })
  assertEqual(r.analytics.length, 0)
  assertEqual(r.pollingState, 'polling')
})

test('no switch, access confirmed → confirmed + analytics fires', async () => {
  const r = await runSettingsPoll({ accessOn: 1 })
  assertEqual(r.result, 'confirmed')
  assertEqual(r.pollingState, 'confirmed')
  assertEqual(r.analytics[0], 'subscription_access_confirmed')
})

test('no switch, never confirms → timeout + analytics fires', async () => {
  const r = await runSettingsPoll({ timeoutRun: true })
  assertEqual(r.result, 'timeout')
  assertEqual(r.analytics[0], 'subscription_confirmation_timed_out')
})

test('after old poll aborts, a NEW account can poll and confirm', async () => {
  // First run switches/aborts; then a fresh run for the new account confirms cleanly.
  await runSettingsPoll({ accessOn: 99, switchAtRefresh: 1 })
  const fresh = await runSettingsPoll({ accessOn: 1 })
  assertEqual(fresh.result, 'confirmed')
  assertEqual(fresh.analytics[0], 'subscription_access_confirmed')
})

// ── P2/P3: shouldStartCheckoutPoll — never start with an unknown UID ───────────
test('8. does NOT start polling with an unknown UID (authUserId null)', () => {
  assertEqual(shouldStartCheckoutPoll({ banner: 'success', authUserId: null, alreadyStarted: false }), false)
})
test('7. account switch before profile load: still gated by authoritative UID, not profile', () => {
  // authUserId comes from the provider (auth session), independent of the profile query.
  // Until it is known, polling must not start; once known, it may.
  assertEqual(shouldStartCheckoutPoll({ banner: 'success', authUserId: undefined, alreadyStarted: false }), false)
  assertEqual(shouldStartCheckoutPoll({ banner: 'success', authUserId: 'A', alreadyStarted: false }), true)
})
test('does not start for non-success banners', () => {
  assertEqual(shouldStartCheckoutPoll({ banner: 'cancelled', authUserId: 'A', alreadyStarted: false }), false)
  assertEqual(shouldStartCheckoutPoll({ banner: null, authUserId: 'A', alreadyStarted: false }), false)
})
test('starts exactly once (alreadyStarted guard)', () => {
  assertEqual(shouldStartCheckoutPoll({ banner: 'success', authUserId: 'A', alreadyStarted: true }), false)
})

// ── Source contract: SettingsPage wires the abort + stale gate + auth gating ──
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
const sp = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'SettingsPage.jsx'), 'utf8')
test('SettingsPage aborts polling on account switch and gates results via isStalePollResult', () => {
  assert(sp.includes('pollAbortRef'), 'must keep an abort handle for polling')
  assert(sp.includes('pollAbortRef.current?.abort()'), 'must abort the poll on account switch')
  assert(sp.includes('isStalePollResult('), 'must gate poll results via isStalePollResult')
})
test('SettingsPage polling uses authoritative provider auth identity + shouldStartCheckoutPoll', () => {
  assert(sp.includes('shouldStartCheckoutPoll('), 'must gate the poll start on the authoritative UID')
  assert(sp.includes('useProAuthUserId') && sp.includes('useProAccountGeneration'), 'must read authoritative auth identity from the provider')
  assert(sp.includes('authUserIdRef.current') && sp.includes('accountGenerationRef.current'), 'stale-check must use the authoritative auth refs')
})

for (const { name, fn } of RUN) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
