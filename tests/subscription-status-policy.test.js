/**
 * Tests for src/lib/subscriptionStatusPolicy.js — the single shared status policy.
 * Zero deps — runs with: node tests/subscription-status-policy.test.js
 */
import {
  SUBSCRIPTION_STATUS_POLICY,
  checkoutPolicyForStatus,
  checkoutModeForStatus,
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
  ['active',             'block',           true,  'subscribed'],
  ['past_due',           'block',           true,  'billing_attention'],
  ['incomplete',         'reuse_only',      false, 'payment_incomplete'],
  ['trialing',           'block',           false, 'billing_attention'],
  ['unpaid',             'block',           false, 'billing_attention'],
  ['paused',             'block',           false, 'billing_attention'],
  ['canceled',           'fresh_only',      false, 'can_checkout'],
  ['incomplete_expired', 'fresh_only',      false, 'can_checkout'],
  ['none',               'reuse_or_create', false, 'can_checkout'],
]

// R1: canceled/incomplete_expired must NEVER reuse an old ready session (fresh_only);
// none may reuse-or-create; incomplete is reuse_only.
test('checkoutModeForStatus matches the table', () => {
  for (const [status, mode] of TABLE) assertEqual(checkoutModeForStatus(status), mode, status)
})
test('canceled + incomplete_expired are fresh_only (no reuse of old completed session)', () => {
  assertEqual(checkoutModeForStatus('canceled'), 'fresh_only')
  assertEqual(checkoutModeForStatus('incomplete_expired'), 'fresh_only')
})
test('none is reuse_or_create', () => assertEqual(checkoutModeForStatus('none'), 'reuse_or_create'))
test('unknown status → block mode', () => assertEqual(checkoutModeForStatus('wat'), 'block'))

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

// null / undefined / '' → treated as none (reuse_or_create).
test('null status → reuse_or_create (none)', () => assertEqual(checkoutPolicyForStatus(null).checkoutMode, 'reuse_or_create'))
test('undefined status → reuse_or_create (none)', () => assertEqual(checkoutPolicyForStatus(undefined).checkoutMode, 'reuse_or_create'))
test('empty string status → reuse_or_create (none)', () => assertEqual(checkoutPolicyForStatus('').checkoutMode, 'reuse_or_create'))

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
