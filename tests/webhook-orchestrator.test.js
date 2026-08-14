/**
 * Tests for supabase/functions/stripe-webhook/webhookOrchestrator.js
 *
 * Zero dependencies — runs with: node tests/webhook-orchestrator.test.js
 *
 * Covers the pure decision logic extracted for corrections C4, C5, C6, C7, C8,
 * plus claim classification and safe log payloads (C10 — testable orchestration).
 */

import {
  validateEventShape,
  validateAuthoritativeSub,
  isInvoiceEvent,
  buildDeletionFilter,
  isAllowedSubscriptionStatus,
  classifyClaim,
  buildEventLogPayload,
} from '../supabase/functions/stripe-webhook/webhookOrchestrator.js'

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

// A minimally valid signed event object.
function validEvent(overrides = {}) {
  return {
    id:      'evt_1AbcDefGhiJkl',
    type:    'customer.subscription.updated',
    created: 1_700_000_000,
    data:    { object: { id: 'sub_123', customer: 'cus_123' } },
    ...overrides,
  }
}

// ── C4: validateEventShape ─────────────────────────────────────────────────────

test('C4: accepts a well-formed event', () => {
  const r = validateEventShape(validEvent())
  assert(r.valid === true, 'should be valid')
})

test('C4: rejects null', () => {
  const r = validateEventShape(null)
  assertEqual(r.valid, false)
  assertEqual(r.code, 'invalid_event')
  assertEqual(r.httpStatus, 400)
})

test('C4: rejects undefined', () => {
  assertEqual(validateEventShape(undefined).valid, false)
})

test('C4: rejects a string', () => {
  assertEqual(validateEventShape('evt_123').valid, false)
})

test('C4: rejects an array', () => {
  assertEqual(validateEventShape([]).valid, false)
})

test('C4: rejects missing id', () => {
  const e = validEvent(); delete e.id
  assertEqual(validateEventShape(e).valid, false)
})

test('C4: rejects malformed id (no evt_ prefix)', () => {
  assertEqual(validateEventShape(validEvent({ id: 'sub_123' })).valid, false)
})

test('C4: rejects id that is too short', () => {
  assertEqual(validateEventShape(validEvent({ id: 'evt_' })).valid, false)
})

test('C4: rejects non-string id', () => {
  assertEqual(validateEventShape(validEvent({ id: 123 })).valid, false)
})

test('C4: rejects empty type', () => {
  assertEqual(validateEventShape(validEvent({ type: '' })).valid, false)
})

test('C4: rejects non-string type', () => {
  assertEqual(validateEventShape(validEvent({ type: 42 })).valid, false)
})

test('C4: rejects type longer than 256 chars', () => {
  assertEqual(validateEventShape(validEvent({ type: 'a'.repeat(257) })).valid, false)
})

test('C4: accepts type exactly 256 chars', () => {
  assertEqual(validateEventShape(validEvent({ type: 'a'.repeat(256) })).valid, true)
})

test('C4: rejects non-integer created', () => {
  assertEqual(validateEventShape(validEvent({ created: 1.5 })).valid, false)
})

test('C4: rejects zero created', () => {
  assertEqual(validateEventShape(validEvent({ created: 0 })).valid, false)
})

test('C4: rejects negative created', () => {
  assertEqual(validateEventShape(validEvent({ created: -1 })).valid, false)
})

test('C4: rejects string created', () => {
  assertEqual(validateEventShape(validEvent({ created: '1700000000' })).valid, false)
})

test('C4: rejects missing data.object', () => {
  assertEqual(validateEventShape(validEvent({ data: {} })).valid, false)
})

test('C4: rejects null data.object', () => {
  assertEqual(validateEventShape(validEvent({ data: { object: null } })).valid, false)
})

test('C4: rejects array data.object', () => {
  assertEqual(validateEventShape(validEvent({ data: { object: [] } })).valid, false)
})

test('C4: rejects missing data entirely', () => {
  const e = validEvent(); delete e.data
  assertEqual(validateEventShape(e).valid, false)
})

// ── C6: validateAuthoritativeSub ───────────────────────────────────────────────

test('C6: accepts a matching subscription', () => {
  const r = validateAuthoritativeSub({ id: 'sub_1', customer: 'cus_1' }, 'sub_1', 'cus_1')
  assertEqual(r.valid, true)
})

test('C6: rejects null fetched sub', () => {
  const r = validateAuthoritativeSub(null, 'sub_1', 'cus_1')
  assertEqual(r.valid, false)
  assertEqual(r.reason, 'no_fetched_sub')
})

test('C6: rejects non-object fetched sub', () => {
  assertEqual(validateAuthoritativeSub('sub_1', 'sub_1', 'cus_1').valid, false)
})

test('C6: rejects subscription id mismatch', () => {
  const r = validateAuthoritativeSub({ id: 'sub_OTHER', customer: 'cus_1' }, 'sub_1', 'cus_1')
  assertEqual(r.valid, false)
  assertEqual(r.reason, 'sub_id_mismatch')
})

test('C6: rejects customer mismatch', () => {
  const r = validateAuthoritativeSub({ id: 'sub_1', customer: 'cus_OTHER' }, 'sub_1', 'cus_1')
  assertEqual(r.valid, false)
  assertEqual(r.reason, 'customer_mismatch')
})

test('C6: rejects when fetched sub has no id', () => {
  assertEqual(validateAuthoritativeSub({ customer: 'cus_1' }, 'sub_1', 'cus_1').valid, false)
})

test('C6: rejects when fetched sub has no customer', () => {
  const r = validateAuthoritativeSub({ id: 'sub_1' }, 'sub_1', 'cus_1')
  assertEqual(r.valid, false)
  assertEqual(r.reason, 'customer_mismatch')
})

// ── C7: isInvoiceEvent ─────────────────────────────────────────────────────────

test('C7: invoice.payment_succeeded is an invoice event', () => {
  assert(isInvoiceEvent('invoice.payment_succeeded') === true)
})

test('C7: invoice.payment_failed is an invoice event', () => {
  assert(isInvoiceEvent('invoice.payment_failed') === true)
})

test('C7: subscription events are not invoice events', () => {
  assert(isInvoiceEvent('customer.subscription.updated') === false)
})

test('C7: checkout event is not an invoice event', () => {
  assert(isInvoiceEvent('checkout.session.completed') === false)
})

test('C7: unrelated invoice subtype is not treated as handled invoice event', () => {
  assert(isInvoiceEvent('invoice.created') === false)
})

// ── C5: buildDeletionFilter ────────────────────────────────────────────────────

test('C5: filter carries both user_id and subId', () => {
  const f = buildDeletionFilter('user-1', 'sub_1')
  assertEqual(f.userId, 'user-1')
  assertEqual(f.subId, 'sub_1')
})

test('C5: filter preserves exact values', () => {
  const f = buildDeletionFilter('abc', 'sub_zzz')
  assert(f.userId === 'abc' && f.subId === 'sub_zzz')
})

// ── C8: isAllowedSubscriptionStatus ────────────────────────────────────────────

test('C8: active is allowed', () => {
  assert(isAllowedSubscriptionStatus('active') === true)
})

test('C8: past_due is allowed', () => {
  assert(isAllowedSubscriptionStatus('past_due') === true)
})

test('C8: canceled is allowed', () => {
  assert(isAllowedSubscriptionStatus('canceled') === true)
})

test('C8: incomplete_expired is allowed', () => {
  assert(isAllowedSubscriptionStatus('incomplete_expired') === true)
})

test('C8: unknown status is rejected', () => {
  assert(isAllowedSubscriptionStatus('bogus_status') === false)
})

test('C8: null is rejected', () => {
  assert(isAllowedSubscriptionStatus(null) === false)
})

test('C8: undefined is rejected', () => {
  assert(isAllowedSubscriptionStatus(undefined) === false)
})

test('C8: empty string is rejected', () => {
  assert(isAllowedSubscriptionStatus('') === false)
})

// ── classifyClaim ──────────────────────────────────────────────────────────────

test('classifyClaim: claimed with token → process', () => {
  const r = classifyClaim({ result: 'claimed', claim_token: 'tok-123' })
  assertEqual(r.action, 'process')
  assertEqual(r.claimToken, 'tok-123')
})

test('classifyClaim: claimed without token → error', () => {
  assertEqual(classifyClaim({ result: 'claimed' }).action, 'error')
})

test('classifyClaim: claimed with empty token → error', () => {
  assertEqual(classifyClaim({ result: 'claimed', claim_token: '' }).action, 'error')
})

test('classifyClaim: claimed with non-string token → error', () => {
  assertEqual(classifyClaim({ result: 'claimed', claim_token: 123 }).action, 'error')
})

test('classifyClaim: duplicate → duplicate', () => {
  assertEqual(classifyClaim({ result: 'duplicate' }).action, 'duplicate')
})

test('classifyClaim: in_progress → in_progress', () => {
  assertEqual(classifyClaim({ result: 'in_progress' }).action, 'in_progress')
})

test('classifyClaim: null → error', () => {
  assertEqual(classifyClaim(null).action, 'error')
})

test('classifyClaim: undefined → error', () => {
  assertEqual(classifyClaim(undefined).action, 'error')
})

test('classifyClaim: string payload → error', () => {
  assertEqual(classifyClaim('claimed').action, 'error')
})

test('classifyClaim: unknown result → error', () => {
  assertEqual(classifyClaim({ result: 'something_else' }).action, 'error')
})

// ── buildEventLogPayload (privacy-safe) ────────────────────────────────────────

test('log payload includes only id, type, created, requestId', () => {
  const p = buildEventLogPayload(validEvent(), 'req-1')
  assertEqual(p.requestId, 'req-1')
  assertEqual(p.eventId, 'evt_1AbcDefGhiJkl')
  assertEqual(p.eventType, 'customer.subscription.updated')
  assertEqual(p.created, 1_700_000_000)
})

test('log payload never contains the data object', () => {
  const p = buildEventLogPayload(validEvent(), 'req-1')
  assert(!('data' in p), 'must not leak event.data')
  assert(!('object' in p), 'must not leak object')
})

test('log payload tolerates missing fields (nulls, no throw)', () => {
  const p = buildEventLogPayload({}, 'req-2')
  assertEqual(p.eventId, null)
  assertEqual(p.eventType, null)
  assertEqual(p.created, null)
  assertEqual(p.requestId, 'req-2')
})

test('log payload nulls a non-string id', () => {
  const p = buildEventLogPayload({ id: 123, type: 't', created: 5 }, 'r')
  assertEqual(p.eventId, null)
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
