/**
 * Tests for supabase/functions/create-checkout-session/checkoutHelpers.js
 * Zero deps — runs with: node tests/checkout-helpers.test.js
 */
import {
  isValidUUID,
  buildCheckoutIdempotencyKey,
  isValidCheckoutUrl,
} from '../supabase/functions/create-checkout-session/checkoutHelpers.js'

let passed = 0, failed = 0
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ } }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

// ── isValidUUID ───────────────────────────────────────────────────────────────
console.log('\nisValidUUID')
test('accepts a valid v4 UUID', () => assert(isValidUUID('f47ac10b-58cc-4372-a567-0e02b2c3d479')))
test('rejects non-v4', () => assert(!isValidUUID('550e8400-e29b-11d4-a716-446655440000')))
test('rejects empty / null / number', () => {
  assert(!isValidUUID(''))
  assert(!isValidUUID(null))
  assert(!isValidUUID(12345))
})

// ── buildCheckoutIdempotencyKey (opaque, no PII) ───────────────────────────────
console.log('\nbuildCheckoutIdempotencyKey')
const OP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
test('produces checkout-op-{operationId}', () => {
  assertEqual(buildCheckoutIdempotencyKey(OP), `checkout-op-${OP}`)
})
test('contains only the opaque operation id — no user id or email', () => {
  const key = buildCheckoutIdempotencyKey(OP)
  assert(!key.includes('@'), 'no email')
  assert(!/user/i.test(key), 'no user identifier token')
  assert(key.startsWith('checkout-op-'))
})
test('different operation ids → different keys', () => {
  assert(buildCheckoutIdempotencyKey('op-1') !== buildCheckoutIdempotencyKey('op-2'))
})

// ── isValidCheckoutUrl ─────────────────────────────────────────────────────────
console.log('\nisValidCheckoutUrl')
test('accepts https checkout.stripe.com', () => assert(isValidCheckoutUrl('https://checkout.stripe.com/c/pay/cs_1')))
test('rejects http', () => assert(!isValidCheckoutUrl('http://checkout.stripe.com/x')))
test('rejects wrong host', () => assert(!isValidCheckoutUrl('https://evil.com/x')))
test('rejects billing.stripe.com (that is the portal host)', () => assert(!isValidCheckoutUrl('https://billing.stripe.com/x')))
test('rejects look-alike host', () => assert(!isValidCheckoutUrl('https://checkout.stripe.com.evil.com/x')))
test('rejects null / empty / non-string', () => {
  assert(!isValidCheckoutUrl(null))
  assert(!isValidCheckoutUrl(''))
  assert(!isValidCheckoutUrl(42))
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
