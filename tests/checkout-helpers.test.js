/**
 * Tests for supabase/functions/create-checkout-session/checkoutHelpers.js
 * Zero deps — runs with: node tests/checkout-helpers.test.js
 */
import {
  isValidUUID,
  buildCheckoutIdempotencyKey,
  isValidCheckoutUrl,
  validateStripeSession,
  classifyProviderStatus,
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

// ── validateStripeSession (R3) ─────────────────────────────────────────────────
console.log('\nvalidateStripeSession')
const NOW = 1_700_000_000
const URL_OK = 'https://checkout.stripe.com/c/pay/cs_1'
test('valid: id + url + future expires_at → ok with ISO', () => {
  const r = validateStripeSession({ id: 'cs_1', url: URL_OK, expires_at: NOW + 3600 }, NOW)
  assert(r.ok); assertEqual(r.id, 'cs_1'); assertEqual(r.url, URL_OK)
  assertEqual(r.expiresAtIso, new Date((NOW + 3600) * 1000).toISOString())
})
test('missing session → missing_session', () => assertEqual(validateStripeSession(null, NOW).reason, 'missing_session'))
test('missing id → missing_id', () => assertEqual(validateStripeSession({ url: URL_OK, expires_at: NOW + 10 }, NOW).reason, 'missing_id'))
test('empty id → missing_id', () => assertEqual(validateStripeSession({ id: '', url: URL_OK, expires_at: NOW + 10 }, NOW).reason, 'missing_id'))
test('invalid url → invalid_url', () => assertEqual(validateStripeSession({ id: 'cs', url: 'https://evil.com/x', expires_at: NOW + 10 }, NOW).reason, 'invalid_url'))
test('missing expires_at → missing_expires_at', () => assertEqual(validateStripeSession({ id: 'cs', url: URL_OK }, NOW).reason, 'missing_expires_at'))
test('non-numeric expires_at → missing_expires_at', () => assertEqual(validateStripeSession({ id: 'cs', url: URL_OK, expires_at: 'soon' }, NOW).reason, 'missing_expires_at'))
test('zero/negative expires_at → missing_expires_at', () => {
  assertEqual(validateStripeSession({ id: 'cs', url: URL_OK, expires_at: 0 }, NOW).reason, 'missing_expires_at')
  assertEqual(validateStripeSession({ id: 'cs', url: URL_OK, expires_at: -5 }, NOW).reason, 'missing_expires_at')
})
test('expired expires_at (past) → expired', () => assertEqual(validateStripeSession({ id: 'cs', url: URL_OK, expires_at: NOW - 5 }, NOW).reason, 'expired'))
test('expires_at exactly now → expired (must be strictly future)', () => assertEqual(validateStripeSession({ id: 'cs', url: URL_OK, expires_at: NOW }, NOW).reason, 'expired'))
test('expires_at one second in the future → ok', () => assert(validateStripeSession({ id: 'cs', url: URL_OK, expires_at: NOW + 1 }, NOW).ok))

// ── C1: clock guard — a broken clock must NEVER let a session pass ──────────────
const GOOD = { id: 'cs', url: URL_OK, expires_at: NOW + 3600 }
test('NaN nowSec → invalid_clock (NEVER ok, even with a valid future session)', () => {
  const r = validateStripeSession(GOOD, NaN)
  assert(!r.ok, 'NaN clock must not pass')
  assertEqual(r.reason, 'invalid_clock')
})
test('Infinity nowSec → invalid_clock', () => assertEqual(validateStripeSession(GOOD, Infinity).reason, 'invalid_clock'))
test('-Infinity nowSec → invalid_clock', () => assertEqual(validateStripeSession(GOOD, -Infinity).reason, 'invalid_clock'))
test('negative nowSec → invalid_clock', () => assertEqual(validateStripeSession(GOOD, -5).reason, 'invalid_clock'))
test('zero nowSec → invalid_clock', () => assertEqual(validateStripeSession(GOOD, 0).reason, 'invalid_clock'))
test('non-number nowSec (string) → invalid_clock', () => assertEqual(validateStripeSession(GOOD, '1700000000').reason, 'invalid_clock'))
test('valid positive numeric clock → ok', () => assert(validateStripeSession(GOOD, NOW).ok))

// ── C2: classifyProviderStatus ─────────────────────────────────────────────────
console.log('\nclassifyProviderStatus')
const DEFINITIVE = [400, 401, 402, 403, 404, 422]
const UNKNOWN    = [408, 409, 429, 500, 502, 503]
for (const s of DEFINITIVE) test(`HTTP ${s} → definitive_failure`, () => assertEqual(classifyProviderStatus(s), 'definitive_failure'))
for (const s of UNKNOWN)    test(`HTTP ${s} → unknown_failure`, () => assertEqual(classifyProviderStatus(s), 'unknown_failure'))
test('HTTP 200 → success', () => assertEqual(classifyProviderStatus(200), 'success'))
test('HTTP 201 → success', () => assertEqual(classifyProviderStatus(201), 'success'))
test('429 is NOT definitive (the fix): unknown_failure', () => assertEqual(classifyProviderStatus(429), 'unknown_failure'))
test('408 (interrupted) → unknown_failure', () => assertEqual(classifyProviderStatus(408), 'unknown_failure'))
test('409 (idempotency conflict) → unknown_failure', () => assertEqual(classifyProviderStatus(409), 'unknown_failure'))
test('3xx / <200 / non-number → unknown_failure (safest)', () => {
  assertEqual(classifyProviderStatus(302), 'unknown_failure')
  assertEqual(classifyProviderStatus(100), 'unknown_failure')
  assertEqual(classifyProviderStatus(undefined), 'unknown_failure')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
