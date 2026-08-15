/**
 * Tests for src/lib/actionGuard.js — the synchronous single-flight guard used by
 * the Stripe checkout / billing-portal handlers to prevent duplicate sessions from
 * two rapid clicks. Also source-contract checks that both pages engage the guard
 * before generating an attemptId or invoking.
 *
 * Zero external deps — runs with: node tests/action-guard.test.js
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createActionGuard } from '../src/lib/actionGuard.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = join(__dir, '..')

let passed = 0
let failed = 0
const RUN = []
function test(name, fn) { RUN.push({ name, fn }) }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

// ── Guard primitive ──────────────────────────────────────────────────────────

test('begin() returns true for the first caller', () => {
  const g = createActionGuard()
  assertEqual(g.begin(), true)
})

test('begin() returns false for a second caller while in flight', () => {
  const g = createActionGuard()
  g.begin()
  assertEqual(g.begin(), false)
})

test('release() lets a subsequent begin() succeed again', () => {
  const g = createActionGuard()
  g.begin()
  g.release()
  assertEqual(g.begin(), true)
})

test('isInFlight reflects state', () => {
  const g = createActionGuard()
  assertEqual(g.isInFlight, false)
  g.begin()
  assertEqual(g.isInFlight, true)
  g.release()
  assertEqual(g.isInFlight, false)
})

test('release() when idle is a safe no-op', () => {
  const g = createActionGuard()
  g.release()
  assertEqual(g.begin(), true)
})

// ── Handler model: two immediate invocations → one invoke ──────────────────────
// Mirrors the exact guard sequence in handleSubscribe / handleBillingPortal:
//   if (!guard.begin()) return
//   ...generate attemptId, invoke...
//   on controlled failure → guard.release()
//   on success → leave engaged (navigation)

function makeHandler(guard, invoke, { failController = false } = {}) {
  return async function handler() {
    if (!guard.begin()) return 'blocked'
    const attemptId = `att-${Math.random()}`
    const result = await invoke(attemptId)
    if (failController || result === 'fail') {
      guard.release()          // controlled failure clears the guard
      return 'failed'
    }
    // success: navigation would occur; guard intentionally stays engaged
    return 'navigated'
  }
}

test('two immediate invocations result in exactly one invoke', async () => {
  const g = createActionGuard()
  let invokeCount = 0
  const attempts = []
  const invoke = async (attemptId) => { invokeCount++; attempts.push(attemptId); return 'ok' }
  const handler = makeHandler(g, invoke)

  // Fire twice synchronously WITHOUT awaiting the first — models a double click.
  const p1 = handler()
  const p2 = handler()
  const [r1, r2] = await Promise.all([p1, p2])

  assertEqual(invokeCount, 1, 'only one Edge Function call may happen')
  assertEqual(attempts.length, 1, 'only one attemptId may be generated')
  assert((r1 === 'navigated' && r2 === 'blocked') || (r2 === 'navigated' && r1 === 'blocked'),
    'exactly one call proceeds, the other is blocked')
})

test('after a controlled failure, a later click can retry (one invoke each)', async () => {
  const g = createActionGuard()
  let invokeCount = 0
  const invoke = async () => { invokeCount++; return 'fail' }
  const handler = makeHandler(g, invoke)

  const r1 = await handler()      // fails → releases guard
  assertEqual(r1, 'failed')
  const r2 = await handler()      // guard free again → proceeds
  assertEqual(r2, 'failed')
  assertEqual(invokeCount, 2, 'each sequential retry after a controlled failure invokes once')
})

test('after successful navigation the guard stays engaged (no second session)', async () => {
  const g = createActionGuard()
  let invokeCount = 0
  const invoke = async () => { invokeCount++; return 'ok' }
  const handler = makeHandler(g, invoke)

  const r1 = await handler()      // success → guard remains engaged
  assertEqual(r1, 'navigated')
  const r2 = await handler()      // blocked — no second checkout session
  assertEqual(r2, 'blocked')
  assertEqual(invokeCount, 1)
})

// ── Source contract: pages engage the guard before invoking ────────────────────

const aiSrc       = readFileSync(join(ROOT, 'src/pages/FunnlAIPage.jsx'), 'utf8')
const settingsSrc = readFileSync(join(ROOT, 'src/pages/SettingsPage.jsx'), 'utf8')

test('FunnlAIPage + SettingsPage import createActionGuard', () => {
  assert(aiSrc.includes("from '../lib/actionGuard'"), 'FunnlAIPage must import createActionGuard')
  assert(settingsSrc.includes("from '../lib/actionGuard'"), 'SettingsPage must import createActionGuard')
})

test('checkout handlers guard with begin() before invoking the Edge Function', () => {
  // The synchronous guard (begin()) must be engaged BEFORE the checkout invoke, so
  // two rapid clicks produce exactly one Edge Function call. (attemptId is now a
  // non-authoritative correlation value generated inline in the invoke body — the
  // server enforces single-flight via checkout_operations.)
  for (const [name, src] of [['FunnlAIPage', aiSrc], ['SettingsPage', settingsSrc]]) {
    const idxBegin  = src.indexOf('subscribeGuardRef.current.begin()')
    const idxInvoke = src.indexOf("invoke('create-checkout-session'")
    assert(idxBegin !== -1, `${name} must engage the subscribe guard via begin()`)
    assert(idxInvoke !== -1, `${name} must invoke create-checkout-session`)
    assert(idxBegin < idxInvoke, `${name} must guard before invoking`)
  }
})

test('SettingsPage billing portal is guarded', () => {
  assert(settingsSrc.includes('billingPortalGuardRef.current.begin()'),
    'billing portal handler must engage its own guard')
})

for (const { name, fn } of RUN) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
