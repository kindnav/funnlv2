// Pure-logic tests for the Phase B candidate review helpers. No React/Supabase.
// Run: node tests/calendar-review.test.js

import assert from 'assert'
import {
  calendarIngestionEnabled, INTERACTION_TYPES, REVIEW_PAGE_SIZE, REVIEW_NOTES_MAX,
  CANDIDATE_SELECT, validateOverrides, acceptResultOutcome, dismissResultOutcome, resultCode,
} from '../src/lib/calendarReview.js'

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

console.log('\nflag + constants')
test('ingestion flag: only exact "true" enables', () => {
  assert.strictEqual(calendarIngestionEnabled('true'), true)
  for (const v of ['false', 'TRUE', ' true', 'true ', '1', '', undefined, null, true, 1]) {
    assert.strictEqual(calendarIngestionEnabled(v), false, `${JSON.stringify(v)} must be disabled`)
  }
})
test('six interaction types + bounded page size + notes cap', () => {
  assert.deepStrictEqual(INTERACTION_TYPES, ['Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other'])
  assert.ok(REVIEW_PAGE_SIZE > 0 && REVIEW_PAGE_SIZE <= 50)
  assert.strictEqual(REVIEW_NOTES_MAX, 2000)
})
test('CANDIDATE_SELECT never selects provider/sensitive fields', () => {
  for (const bad of ['source_fingerprint', 'user_id', 'interaction_id', 'google_', 'event_id', 'connection_id']) {
    assert.ok(!CANDIDATE_SELECT.includes(bad), `must not select ${bad}`)
  }
  for (const ok of ['proposed_type', 'proposed_interaction_date', 'proposed_notes', 'contacts(name']) {
    assert.ok(CANDIDATE_SELECT.includes(ok), `should select ${ok}`)
  }
})

console.log('\nvalidateOverrides')
test('valid overrides pass; invalid rejected with controlled codes', () => {
  assert.deepStrictEqual(validateOverrides({ type: 'Coffee chat', date: '2026-08-01', notes: 'ok' }), { ok: true })
  assert.deepStrictEqual(validateOverrides({}), { ok: true })
  assert.strictEqual(validateOverrides({ type: 'Bad' }).code, 'invalid_type')
  assert.strictEqual(validateOverrides({ date: '2026-8-1' }).code, 'invalid_date')
  assert.strictEqual(validateOverrides({ date: 'nope' }).code, 'invalid_date')
  assert.strictEqual(validateOverrides({ notes: 'x'.repeat(2001) }).code, 'invalid_notes')
  assert.deepStrictEqual(validateOverrides({ notes: null }), { ok: true })
})

console.log('\nresult-code mapping')
test('resultCode extracts controlled code or unknown', () => {
  assert.strictEqual(resultCode({ result: 'accepted' }), 'accepted')
  assert.strictEqual(resultCode({}), 'unknown')
  assert.strictEqual(resultCode(null), 'unknown')
})
test('accept outcomes: terminal states leave queue; validation stays', () => {
  assert.strictEqual(acceptResultOutcome('accepted').removeFromQueue, true)
  assert.strictEqual(acceptResultOutcome('already_accepted').removeFromQueue, true)
  assert.strictEqual(acceptResultOutcome('interaction_previously_deleted').removeFromQueue, true)
  assert.strictEqual(acceptResultOutcome('dismissed').removeFromQueue, true)
  assert.strictEqual(acceptResultOutcome('invalidated').removeFromQueue, true)
  assert.strictEqual(acceptResultOutcome('not_found').removeFromQueue, true)
  assert.strictEqual(acceptResultOutcome('invalid_type').removeFromQueue, false)
  assert.strictEqual(acceptResultOutcome('unauthenticated').removeFromQueue, false)
  assert.strictEqual(acceptResultOutcome('accepted').message, 'Interaction added.')
  assert.strictEqual(acceptResultOutcome('weird_unknown_code').removeFromQueue, false) // unknown → safe error
})
test('dismiss outcomes', () => {
  assert.strictEqual(dismissResultOutcome('dismissed').removeFromQueue, true)
  assert.strictEqual(dismissResultOutcome('already_dismissed').removeFromQueue, true)
  assert.strictEqual(dismissResultOutcome('already_accepted').removeFromQueue, true)
  assert.strictEqual(dismissResultOutcome('invalidated').removeFromQueue, true)
  assert.strictEqual(dismissResultOutcome('unauthenticated').removeFromQueue, false)
})
test('no outcome message leaks provider/sensitive content', () => {
  const codes = ['accepted','already_accepted','interaction_previously_deleted','dismissed','invalidated','not_found','invalid_type','invalid_date','invalid_notes','unauthenticated','already_dismissed','unknown']
  for (const c of codes) {
    const m = (acceptResultOutcome(c).message + ' ' + dismissResultOutcome(c).message)
    assert.ok(!/@|google|token|fingerprint|uuid|sub-|event_id/i.test(m), `message for ${c} leaks`)
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
