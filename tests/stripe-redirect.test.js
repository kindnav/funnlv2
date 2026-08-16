/**
 * Tests for src/lib/stripeRedirect.js — the redirect-decision helper actually used
 * by the checkout/portal redirect sites in FunnlAIPage and SettingsPage — plus
 * source-contract checks that those pages import and use it and never navigate to an
 * unvalidated data.url.
 *
 * Zero external deps — runs with: node tests/stripe-redirect.test.js
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { resolveStripeRedirect } from '../src/lib/stripeRedirect.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = join(__dir, '..')

let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_abc'
const PORTAL_URL   = 'https://billing.stripe.com/p/session/live_xyz'

// ── resolveStripeRedirect ───────────────────────────────────────────────────────

test('valid checkout url → ok with url', () => {
  const r = resolveStripeRedirect({ url: CHECKOUT_URL }, null, 'checkout')
  assert(r.ok === true)
  assertEqual(r.url, CHECKOUT_URL)
})

test('valid portal url → ok with url', () => {
  const r = resolveStripeRedirect({ url: PORTAL_URL }, null, 'portal')
  assert(r.ok === true)
  assertEqual(r.url, PORTAL_URL)
})

test('Edge Function error → not ok (reason error)', () => {
  const r = resolveStripeRedirect(null, { message: 'boom' }, 'checkout')
  assert(r.ok === false)
  assertEqual(r.reason, 'error')
})

test('error present even with a url → not ok', () => {
  const r = resolveStripeRedirect({ url: CHECKOUT_URL }, { message: 'boom' }, 'checkout')
  assert(r.ok === false)
})

test('missing url → not ok (invalid_url)', () => {
  const r = resolveStripeRedirect({}, null, 'checkout')
  assert(r.ok === false)
  assertEqual(r.reason, 'invalid_url')
})

test('null data → not ok', () => {
  assert(resolveStripeRedirect(null, null, 'checkout').ok === false)
})

test('non-object data → not ok', () => {
  assert(resolveStripeRedirect('https://checkout.stripe.com/x', null, 'checkout').ok === false)
})

test('http (not https) → not ok', () => {
  assert(resolveStripeRedirect({ url: 'http://checkout.stripe.com/x' }, null, 'checkout').ok === false)
})

test('wrong host for checkout → not ok', () => {
  assert(resolveStripeRedirect({ url: 'https://evil.com/x' }, null, 'checkout').ok === false)
})

test('checkout url passed as portal type → not ok (host mismatch)', () => {
  assert(resolveStripeRedirect({ url: CHECKOUT_URL }, null, 'portal').ok === false)
})

test('portal url passed as checkout type → not ok (host mismatch)', () => {
  assert(resolveStripeRedirect({ url: PORTAL_URL }, null, 'checkout').ok === false)
})

test('look-alike host (checkout.stripe.com.evil.com) → not ok', () => {
  assert(resolveStripeRedirect({ url: 'https://checkout.stripe.com.evil.com/x' }, null, 'checkout').ok === false)
})

// ── Source contract: pages use the helper at all three redirect sites ──────────

const aiSrc       = readFileSync(join(ROOT, 'src/pages/FunnlAIPage.jsx'), 'utf8')
const settingsSrc = readFileSync(join(ROOT, 'src/pages/SettingsPage.jsx'), 'utf8')

test('FunnlAIPage imports resolveStripeRedirect', () => {
  assert(aiSrc.includes("from '../lib/stripeRedirect'"), 'must import from lib/stripeRedirect')
})

test('SettingsPage imports resolveStripeRedirect', () => {
  assert(settingsSrc.includes("from '../lib/stripeRedirect'"), 'must import from lib/stripeRedirect')
})

test('FunnlAIPage checkout redirect validates with type checkout', () => {
  assert(/resolveStripeRedirect\(\s*data,\s*error,\s*'checkout'\s*\)/.test(aiSrc),
    'FunnlAIPage must validate the checkout redirect')
})

test('SettingsPage checkout redirect validates with type checkout', () => {
  assert(/resolveStripeRedirect\(\s*data,\s*error,\s*'checkout'\s*\)/.test(settingsSrc),
    'SettingsPage must validate the checkout redirect')
})

test('SettingsPage portal redirect validates with type portal', () => {
  assert(/resolveStripeRedirect\(\s*data,\s*error,\s*'portal'\s*\)/.test(settingsSrc),
    'SettingsPage must validate the portal redirect')
})

test('no page navigates to an unvalidated data.url', () => {
  // window.location.href must be assigned from the validated redirect.url, never data.url.
  assert(!/location\.href\s*=\s*data\.url/.test(aiSrc), 'FunnlAIPage must not navigate to raw data.url')
  assert(!/location\.href\s*=\s*data\.url/.test(settingsSrc), 'SettingsPage must not navigate to raw data.url')
})

test('all navigations use redirect.url', () => {
  const aiNavs = aiSrc.match(/location\.href\s*=\s*[^\n]+/g) ?? []
  const setNavs = settingsSrc.match(/location\.href\s*=\s*[^\n]+/g) ?? []
  for (const n of [...aiNavs, ...setNavs]) {
    assert(n.includes('redirect.url'), `navigation must use redirect.url: ${n}`)
  }
})

test('billing_portal_opened fires only after a validated portal URL', () => {
  // The analytics call must appear AFTER the resolveStripeRedirect(...'portal') guard
  // returns ok — i.e. the track call is below the !redirect.ok early return.
  const idxResolve = settingsSrc.indexOf("resolveStripeRedirect(data, error, 'portal')")
  const idxTrack   = settingsSrc.indexOf("track('billing_portal_opened'")
  assert(idxResolve !== -1 && idxTrack !== -1, 'both the portal validation and analytics must exist')
  assert(idxTrack > idxResolve, 'billing_portal_opened must fire after the portal URL is validated')
})

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
