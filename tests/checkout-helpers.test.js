/**
 * Tests for supabase/functions/create-checkout-session/checkoutHelpers.js
 *
 * Zero dependencies — runs with: node tests/checkout-helpers.test.js
 */

import {
  isValidUUID,
  buildIdempotencyKey,
  isBlockedByExistingSubscription,
} from '../supabase/functions/create-checkout-session/checkoutHelpers.js'

// ── Minimal test runner ───────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e.message}`)
    failed++
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg ?? 'Assertion failed')
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

// ── isValidUUID ───────────────────────────────────────────────────────────────

console.log('\nisValidUUID')

test('accepts a valid v4 UUID (lowercase)', () => {
  assert(isValidUUID('550e8400-e29b-41d4-a716-446655440000'))
})
test('accepts a valid v4 UUID (uppercase)', () => {
  assert(isValidUUID('550E8400-E29B-41D4-A716-446655440000'))
})
test('accepts a v4 UUID with 4 in version position', () => {
  assert(isValidUUID('f47ac10b-58cc-4372-a567-0e02b2c3d479'))
})
test('rejects a non-v4 UUID (version 1)', () => {
  assert(!isValidUUID('550e8400-e29b-11d4-a716-446655440000'))
})
test('rejects a UUID with wrong variant bits (not 8/9/a/b)', () => {
  assert(!isValidUUID('550e8400-e29b-41d4-c716-446655440000'))
})
test('rejects a string that is too short', () => {
  assert(!isValidUUID('550e8400-e29b-41d4-a716-44665544000'))
})
test('rejects a string that is too long', () => {
  assert(!isValidUUID('550e8400-e29b-41d4-a716-4466554400000'))
})
test('rejects a UUID missing hyphens', () => {
  assert(!isValidUUID('550e8400e29b41d4a716446655440000'))
})
test('rejects empty string', () => {
  assert(!isValidUUID(''))
})
test('rejects null', () => {
  assert(!isValidUUID(null))
})
test('rejects undefined', () => {
  assert(!isValidUUID(undefined))
})
test('rejects a number', () => {
  assert(!isValidUUID(12345))
})
test('rejects an object', () => {
  assert(!isValidUUID({}))
})
test('rejects a UUID with non-hex characters', () => {
  assert(!isValidUUID('550e8400-e29b-41d4-a716-44665544000g'))
})

// ── buildIdempotencyKey ───────────────────────────────────────────────────────

console.log('\nbuildIdempotencyKey')

test('produces checkout-{userId}-{attemptId} format', () => {
  const userId    = 'user-123'
  const attemptId = 'attempt-456'
  assertEqual(buildIdempotencyKey(userId, attemptId), 'checkout-user-123-attempt-456')
})
test('works with UUID-format inputs', () => {
  const userId    = '550e8400-e29b-41d4-a716-446655440000'
  const attemptId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
  assertEqual(
    buildIdempotencyKey(userId, attemptId),
    'checkout-550e8400-e29b-41d4-a716-446655440000-f47ac10b-58cc-4372-a567-0e02b2c3d479'
  )
})
test('always starts with checkout-', () => {
  const key = buildIdempotencyKey('u', 'a')
  assert(key.startsWith('checkout-'), 'Key must start with checkout-')
})
test('never produces the same key for different (userId, attemptId) pairs', () => {
  const k1 = buildIdempotencyKey('user-A', 'attempt-1')
  const k2 = buildIdempotencyKey('user-B', 'attempt-1')
  assert(k1 !== k2, 'Different userIds must produce different keys')
})
test('never produces the same key for same userId, different attemptId', () => {
  const k1 = buildIdempotencyKey('user-A', 'attempt-1')
  const k2 = buildIdempotencyKey('user-A', 'attempt-2')
  assert(k1 !== k2, 'Different attemptIds must produce different keys')
})

// ── isBlockedByExistingSubscription ──────────────────────────────────────────

console.log('\nisBlockedByExistingSubscription')

test('blocks active status', () => {
  assert(isBlockedByExistingSubscription('active'))
})
test('blocks past_due status', () => {
  assert(isBlockedByExistingSubscription('past_due'))
})
test('does not block canceled status', () => {
  assert(!isBlockedByExistingSubscription('canceled'))
})
test('does not block unpaid status', () => {
  assert(!isBlockedByExistingSubscription('unpaid'))
})
test('does not block incomplete status', () => {
  assert(!isBlockedByExistingSubscription('incomplete'))
})
test('does not block incomplete_expired status', () => {
  assert(!isBlockedByExistingSubscription('incomplete_expired'))
})
test('does not block trialing status', () => {
  assert(!isBlockedByExistingSubscription('trialing'))
})
test('does not block paused status', () => {
  assert(!isBlockedByExistingSubscription('paused'))
})
test('does not block null', () => {
  assert(!isBlockedByExistingSubscription(null))
})
test('does not block undefined', () => {
  assert(!isBlockedByExistingSubscription(undefined))
})
test('does not block empty string', () => {
  assert(!isBlockedByExistingSubscription(''))
})
test('is case-sensitive (Active is not blocked)', () => {
  assert(!isBlockedByExistingSubscription('Active'))
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
