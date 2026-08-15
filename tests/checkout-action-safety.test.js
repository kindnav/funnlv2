/**
 * R5 source-contract tests: the checkout/portal handlers wrap their Edge Function
 * invocation in try/catch (releasing the guard + clearing loading on a thrown
 * network error, never navigating), and account-switch paths synchronously release
 * the action guards. Behavioral single-flight/retry semantics are covered by
 * tests/action-guard.test.js.
 *
 * Zero deps — runs with: node tests/checkout-action-safety.test.js
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = join(__dir, '..')
const aiSrc       = readFileSync(join(ROOT, 'src/pages/FunnlAIPage.jsx'), 'utf8')
const settingsSrc = readFileSync(join(ROOT, 'src/pages/SettingsPage.jsx'), 'utf8')

let passed = 0, failed = 0
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ } }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }

// Extract a function body by name up to the line that closes it at 2-space indent.
function fnBody(src, header) {
  const start = src.indexOf(header)
  if (start === -1) throw new Error(`function not found: ${header}`)
  const end = src.indexOf('\n  }\n', start)
  return src.slice(start, end === -1 ? undefined : end + 4)
}

const aiSubscribe   = fnBody(aiSrc, 'async function handleSubscribe()')
const setSubscribe  = fnBody(settingsSrc, 'async function handleSubscribe()')
const setPortal     = fnBody(settingsSrc, 'async function handleBillingPortal()')

function assertTryCatchWrapsInvoke(body, label) {
  assert(/try\s*\{/.test(body), `${label}: must have a try block`)
  assert(/\}\s*catch/.test(body), `${label}: must have a catch block`)
  assert(body.includes('.functions.invoke('), `${label}: must invoke an Edge Function`)
  // The invoke must appear inside the try (before the catch keyword).
  const tryIdx = body.indexOf('try')
  const catchIdx = body.indexOf('catch')
  const invokeIdx = body.indexOf('.functions.invoke(')
  assert(tryIdx < invokeIdx && invokeIdx < catchIdx, `${label}: invoke must be inside the try block`)
}

// ── try/catch around invoke ─────────────────────────────────────────────────
test('FunnlAIPage handleSubscribe wraps invoke in try/catch', () => assertTryCatchWrapsInvoke(aiSubscribe, 'FunnlAIPage.handleSubscribe'))
test('SettingsPage handleSubscribe wraps invoke in try/catch', () => assertTryCatchWrapsInvoke(setSubscribe, 'SettingsPage.handleSubscribe'))
test('SettingsPage handleBillingPortal wraps invoke in try/catch', () => assertTryCatchWrapsInvoke(setPortal, 'SettingsPage.handleBillingPortal'))

// ── thrown failure releases the guard (in every handler) ────────────────────
test('FunnlAIPage handleSubscribe releases the guard on failure', () => {
  assert(aiSubscribe.includes('subscribeGuardRef.current.release()'))
})
test('SettingsPage handleSubscribe releases the guard on failure', () => {
  assert(setSubscribe.includes('subscribeGuardRef.current.release()'))
})
test('SettingsPage handleBillingPortal releases the guard on failure', () => {
  assert(setPortal.includes('billingPortalGuardRef.current.release()'))
})

// ── stale result cannot navigate after account switch ───────────────────────
test('FunnlAIPage handleSubscribe bails when the account switched mid-invoke', () => {
  assert(aiSubscribe.includes('prevUserIdRef.current !== capturedUserId'),
    'must compare the captured user id against the current one before navigating')
})
test('SettingsPage handleSubscribe bails when the account switched mid-invoke', () => {
  assert(setSubscribe.includes('accountGenRef.current !== capturedGen'))
})
test('SettingsPage handleBillingPortal bails when the account switched mid-invoke', () => {
  assert(setPortal.includes('accountGenRef.current !== capturedGen'))
})

// ── account-switch path synchronously releases guards ───────────────────────
test('FunnlAIPage account-switch effect releases the subscribe guard', () => {
  // The account-switch reset (prevUserIdRef change branch) must release the guard.
  const switchIdx = aiSrc.indexOf('prevUserIdRef.current !== userId')
  assert(switchIdx !== -1, 'account-switch branch must exist')
  const region = aiSrc.slice(switchIdx, switchIdx + 600)
  assert(region.includes('subscribeGuardRef.current.release()'),
    'account switch must synchronously release the checkout guard')
})
test('SettingsPage account-switch releases both checkout + portal guards', () => {
  const switchIdx = settingsSrc.indexOf('accountGenRef.current++')
  assert(switchIdx !== -1, 'account-switch bump must exist')
  const region = settingsSrc.slice(switchIdx, switchIdx + 700)
  assert(region.includes('subscribeGuardRef.current.release()'), 'must release checkout guard on switch')
  assert(region.includes('billingPortalGuardRef.current.release()'), 'must release portal guard on switch')
})

// ── invalid URL path is present (controlled failure → release, no navigate) ──
test('handlers route through resolveStripeRedirect and only navigate on redirect.url', () => {
  for (const [label, body] of [['ai', aiSubscribe], ['set', setSubscribe], ['portal', setPortal]]) {
    assert(body.includes('resolveStripeRedirect('), `${label}: must validate the redirect`)
    const navs = body.match(/location\.href\s*=\s*[^\n]+/g) ?? []
    for (const n of navs) assert(n.includes('redirect.url'), `${label}: navigation must use redirect.url`)
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
