/**
 * Tests for supabase/functions/stripe-webhook/webhookHelpers.js
 *
 * Zero dependencies — runs with: node tests/webhook-helpers.test.js
 */

import {
  isValidUUID,
  extractPriceId,
  SUBSCRIPTION_STATUS_SEMANTICS,
  statusGrantsAccess,
  unixToIso,
  shouldRetryOnMissingOwnership,
} from '../supabase/functions/stripe-webhook/webhookHelpers.js'

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

test('accepts a valid v4 UUID', () => {
  assert(isValidUUID('f47ac10b-58cc-4372-a567-0e02b2c3d479'))
})
test('rejects non-v4 UUID (version 1)', () => {
  assert(!isValidUUID('550e8400-e29b-11d4-a716-446655440000'))
})
test('rejects non-UUID string', () => {
  assert(!isValidUUID('user-abc-123'))
})
test('rejects null', () => {
  assert(!isValidUUID(null))
})
test('rejects undefined', () => {
  assert(!isValidUUID(undefined))
})
test('rejects empty string', () => {
  assert(!isValidUUID(''))
})

// ── extractPriceId ────────────────────────────────────────────────────────────

console.log('\nextractPriceId')

test('extracts from items.data[0].price.id (standard location)', () => {
  const sub = { items: { data: [{ price: { id: 'price_abc123' } }] } }
  assertEqual(extractPriceId(sub), 'price_abc123')
})
test('returns null when items path is absent (plan.id not a fallback)', () => {
  const sub = { plan: { id: 'price_via_plan' } }
  assertEqual(extractPriceId(sub), null)
})
test('returns null when sub is null', () => {
  assertEqual(extractPriceId(null), null)
})
test('returns null when sub is undefined', () => {
  assertEqual(extractPriceId(undefined), null)
})
test('returns null when items.data is empty', () => {
  const sub = { items: { data: [] } }
  assertEqual(extractPriceId(sub), null)
})
test('returns null when items.data[0].price is absent', () => {
  const sub = { items: { data: [{}] } }
  assertEqual(extractPriceId(sub), null)
})
test('extracts from items.data when items path is present alongside other fields', () => {
  const sub = {
    items: { data: [{ price: { id: 'price_primary' } }] },
    plan:  { id: 'price_secondary' },
  }
  assertEqual(extractPriceId(sub), 'price_primary')
})
test('returns null when neither path is present', () => {
  const sub = { status: 'active' }
  assertEqual(extractPriceId(sub), null)
})

// ── SUBSCRIPTION_STATUS_SEMANTICS ─────────────────────────────────────────────

console.log('\nSUBSCRIPTION_STATUS_SEMANTICS')

const ACCESS_GRANTED_STATUSES  = ['active', 'past_due']
const ACCESS_REVOKED_STATUSES  = ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'trialing', 'paused']
const TERMINAL_STATUSES        = ['canceled', 'incomplete_expired']
const NON_TERMINAL_STATUSES    = ['active', 'past_due', 'unpaid', 'incomplete', 'trialing', 'paused']

test('covers all expected status strings', () => {
  const allStatuses = [...ACCESS_GRANTED_STATUSES, ...ACCESS_REVOKED_STATUSES]
  for (const s of allStatuses) {
    assert(
      Object.prototype.hasOwnProperty.call(SUBSCRIPTION_STATUS_SEMANTICS, s),
      `Missing status key: ${s}`
    )
  }
})
for (const s of ACCESS_GRANTED_STATUSES) {
  test(`${s} grants access`, () => {
    assert(SUBSCRIPTION_STATUS_SEMANTICS[s].grantsAccess === true)
  })
}
for (const s of ACCESS_REVOKED_STATUSES) {
  test(`${s} does not grant access`, () => {
    assert(SUBSCRIPTION_STATUS_SEMANTICS[s].grantsAccess === false)
  })
}
for (const s of TERMINAL_STATUSES) {
  test(`${s} is terminal`, () => {
    assert(SUBSCRIPTION_STATUS_SEMANTICS[s].isTerminal === true)
  })
}
for (const s of NON_TERMINAL_STATUSES) {
  test(`${s} is not terminal`, () => {
    assert(SUBSCRIPTION_STATUS_SEMANTICS[s].isTerminal === false)
  })
}
test('every entry has a non-empty description', () => {
  for (const [status, meta] of Object.entries(SUBSCRIPTION_STATUS_SEMANTICS)) {
    assert(
      typeof meta.description === 'string' && meta.description.length > 0,
      `Missing description for status: ${status}`
    )
  }
})

// ── statusGrantsAccess ────────────────────────────────────────────────────────

console.log('\nstatusGrantsAccess')

test('returns true for active', () => {
  assert(statusGrantsAccess('active'))
})
test('returns true for past_due', () => {
  assert(statusGrantsAccess('past_due'))
})
test('returns false for canceled', () => {
  assert(!statusGrantsAccess('canceled'))
})
test('returns false for unpaid', () => {
  assert(!statusGrantsAccess('unpaid'))
})
test('returns false for null', () => {
  assert(!statusGrantsAccess(null))
})
test('returns false for undefined', () => {
  assert(!statusGrantsAccess(undefined))
})
test('returns false for unknown status', () => {
  assert(!statusGrantsAccess('unknown_future_status'))
})
test('returns false for empty string', () => {
  assert(!statusGrantsAccess(''))
})

// ── unixToIso ─────────────────────────────────────────────────────────────────

console.log('\nunixToIso')

test('converts a known Unix timestamp to ISO string', () => {
  // 2024-01-01T00:00:00.000Z = 1704067200 seconds
  assertEqual(unixToIso(1704067200), '2024-01-01T00:00:00.000Z')
})
test('returns null for null input', () => {
  assertEqual(unixToIso(null), null)
})
test('returns null for undefined input', () => {
  assertEqual(unixToIso(undefined), null)
})
test('returns null for zero (Unix epoch — suspicious for a subscription date)', () => {
  assertEqual(unixToIso(0), null)
})
test('returns null for negative numbers', () => {
  assertEqual(unixToIso(-1), null)
})
test('returns a string ending with Z (UTC)', () => {
  const result = unixToIso(1704067200)
  assert(typeof result === 'string' && result.endsWith('Z'))
})
test('converts a recent timestamp correctly', () => {
  // 2026-08-13T00:00:00.000Z
  const ts = new Date('2026-08-13T00:00:00.000Z').getTime() / 1000
  assertEqual(unixToIso(ts), '2026-08-13T00:00:00.000Z')
})

// ── shouldRetryOnMissingOwnership ─────────────────────────────────────────────

console.log('\nshouldRetryOnMissingOwnership')

const SHOULD_RETRY = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_succeeded',
]
const SHOULD_NOT_RETRY = [
  'checkout.session.completed',
  'invoice.payment_failed',
  'customer.updated',
  'payment_intent.succeeded',
]

for (const t of SHOULD_RETRY) {
  test(`returns true for ${t}`, () => {
    assert(shouldRetryOnMissingOwnership(t) === true)
  })
}
for (const t of SHOULD_NOT_RETRY) {
  test(`returns false for ${t}`, () => {
    assert(shouldRetryOnMissingOwnership(t) === false)
  })
}
test('returns false for null', () => {
  assert(!shouldRetryOnMissingOwnership(null))
})
test('returns false for unknown event type', () => {
  assert(!shouldRetryOnMissingOwnership('unknown.event.type'))
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
