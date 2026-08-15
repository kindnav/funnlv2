/**
 * Tests for src/lib/subscriptionStatusPolicy.js — the single shared status policy.
 * Zero deps — runs with: node tests/subscription-status-policy.test.js
 */
import {
  SUBSCRIPTION_STATUS_POLICY,
  checkoutPolicyForStatus,
  isCheckoutCreationAllowed,
  isCheckoutReuseOnly,
  isKnownSubscriptionStatus,
  subscriptionAttentionState,
} from '../src/lib/subscriptionStatusPolicy.js'

let passed = 0, failed = 0
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ } }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

// Full documented table: [status, checkoutMode, grantsAccess, uiState]
const TABLE = [
  ['active',             'block',      true,  'subscribed'],
  ['past_due',           'block',      true,  'billing_attention'],
  ['incomplete',         'reuse_only', false, 'payment_incomplete'],
  ['trialing',           'block',      false, 'billing_attention'],
  ['unpaid',             'block',      false, 'billing_attention'],
  ['paused',             'block',      false, 'billing_attention'],
  ['canceled',           'allow',      false, 'can_checkout'],
  ['incomplete_expired', 'allow',      false, 'can_checkout'],
  ['none',               'allow',      false, 'can_checkout'],
]

for (const [status, mode, grants, uiState] of TABLE) {
  test(`${status}: checkoutMode=${mode}`, () => assertEqual(checkoutPolicyForStatus(status).checkoutMode, mode))
  test(`${status}: grantsAccess=${grants}`, () => assertEqual(checkoutPolicyForStatus(status).grantsAccess, grants))
  test(`${status}: uiState=${uiState}`, () => assertEqual(checkoutPolicyForStatus(status).uiState, uiState))
}

// Creation-allowed only for terminal / none.
test('isCheckoutCreationAllowed: only canceled/incomplete_expired/none', () => {
  const allowed = ['canceled', 'incomplete_expired', 'none']
  for (const s of Object.keys(SUBSCRIPTION_STATUS_POLICY)) {
    assertEqual(isCheckoutCreationAllowed(s), allowed.includes(s), `status ${s}`)
  }
})

test('isCheckoutReuseOnly: only incomplete', () => {
  for (const s of Object.keys(SUBSCRIPTION_STATUS_POLICY)) {
    assertEqual(isCheckoutReuseOnly(s), s === 'incomplete', `status ${s}`)
  }
})

// null / undefined / '' → treated as none (checkout allowed).
test('null status → allow (none)', () => assertEqual(checkoutPolicyForStatus(null).checkoutMode, 'allow'))
test('undefined status → allow (none)', () => assertEqual(checkoutPolicyForStatus(undefined).checkoutMode, 'allow'))
test('empty string status → allow (none)', () => assertEqual(checkoutPolicyForStatus('').checkoutMode, 'allow'))

// Unknown non-empty status → fail closed (block + billing_attention).
test('unknown status → fail closed (block)', () => {
  assertEqual(checkoutPolicyForStatus('wat').checkoutMode, 'block')
  assertEqual(checkoutPolicyForStatus('wat').uiState, 'billing_attention')
  assertEqual(isCheckoutCreationAllowed('wat'), false)
})

// isKnownSubscriptionStatus
test('isKnownSubscriptionStatus: all table keys known', () => {
  for (const s of Object.keys(SUBSCRIPTION_STATUS_POLICY)) assert(isKnownSubscriptionStatus(s), s)
})
test('isKnownSubscriptionStatus: unknown/null/number → false', () => {
  assert(!isKnownSubscriptionStatus('wat'))
  assert(!isKnownSubscriptionStatus(null))
  assert(!isKnownSubscriptionStatus(5))
})

// subscriptionAttentionState (display-only)
test('attention: billing_attention statuses', () => {
  for (const s of ['past_due', 'trialing', 'unpaid', 'paused']) {
    assertEqual(subscriptionAttentionState(s), 'billing_attention', s)
  }
})
test('attention: incomplete → payment_incomplete', () => {
  assertEqual(subscriptionAttentionState('incomplete'), 'payment_incomplete')
})
test('attention: active/subscribed/terminal/none → null (no attention)', () => {
  for (const s of ['active', 'canceled', 'incomplete_expired', 'none', null, undefined]) {
    assertEqual(subscriptionAttentionState(s), null, String(s))
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
