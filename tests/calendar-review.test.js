// Pure-logic tests for the Phase B candidate review helpers. No React/Supabase.
// Run: node tests/calendar-review.test.js

import assert from 'assert'
import {
  calendarIngestionEnabled, INTERACTION_TYPES, REVIEW_PAGE_SIZE, REVIEW_NOTES_MAX,
  CANDIDATE_SELECT, validateOverrides, acceptResultOutcome, dismissResultOutcome, resultCode,
  keysetFilter, cursorFrom, dedupeById, computeHasMore,
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
test('six interaction types + bounded page size + notes cap matches schema (200)', () => {
  assert.deepStrictEqual(INTERACTION_TYPES, ['Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other'])
  assert.ok(REVIEW_PAGE_SIZE > 0 && REVIEW_PAGE_SIZE <= 50)
  assert.strictEqual(REVIEW_NOTES_MAX, 200)   // must equal interaction_candidates_notes_len bound
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
  assert.deepStrictEqual(validateOverrides({ notes: 'x'.repeat(200) }), { ok: true })   // 200 ok
  assert.strictEqual(validateOverrides({ notes: 'x'.repeat(201) }).code, 'invalid_notes') // 201 too long
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
  assert.strictEqual(acceptResultOutcome('conflict').removeFromQueue, false)   // transient → stay, retry
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
  const codes = ['accepted','already_accepted','interaction_previously_deleted','dismissed','invalidated','not_found','invalid_type','invalid_date','invalid_notes','conflict','unauthenticated','already_dismissed','unknown']
  for (const c of codes) {
    const m = (acceptResultOutcome(c).message + ' ' + dismissResultOutcome(c).message)
    assert.ok(!/@|google|token|fingerprint|uuid|sub-|event_id/i.test(m), `message for ${c} leaks`)
  }
})

console.log('\nkeyset pagination (shrinking-set safe)')
// Rows are (proposed_interaction_date DESC, id DESC). Build a deterministic page.
function mkRow(date, id) { return { id, proposed_interaction_date: date, proposed_type: 'Email', contacts: { name: 'X' } } }

test('keysetFilter: first page has no filter; later pages continue strictly after cursor', () => {
  assert.strictEqual(keysetFilter(null), null)
  assert.strictEqual(keysetFilter({ date: '2026-08-01' }), null)            // incomplete cursor
  assert.strictEqual(keysetFilter({ id: 'abc' }), null)
  assert.strictEqual(
    keysetFilter({ date: '2026-08-01', id: '00000000-0000-0000-0000-000000000009' }),
    'proposed_interaction_date.lt.2026-08-01,and(proposed_interaction_date.eq.2026-08-01,id.lt.00000000-0000-0000-0000-000000000009)'
  )
})

test('cursorFrom: boundary is the LAST fetched row, independent of what is displayed', () => {
  const page = [mkRow('2026-08-05', 'i5'), mkRow('2026-08-03', 'i3'), mkRow('2026-08-01', 'i1')]
  const cur = cursorFrom(page)
  assert.deepStrictEqual(cur, { date: '2026-08-01', id: 'i1' })
  // Removing displayed rows must NOT move the cursor (it is derived from the fetch, not the list).
  const displayedAfterResolving = page.filter((r) => r.id !== 'i1')  // user resolved the last-shown row
  assert.deepStrictEqual(cursorFrom(page), cur, 'cursor stays put regardless of UI removals')
  assert.notDeepStrictEqual(cursorFrom(displayedAfterResolving), cur, 'a list-derived cursor WOULD move — proving why we decouple')
  assert.strictEqual(cursorFrom([]), null)
})

test('no skip after accept/dismiss: cursor from fetched page still yields the next contiguous rows', () => {
  // Page 1 fetched (5-row pages for the test).
  const page1 = [mkRow('2026-08-20','i20'), mkRow('2026-08-19','i19'), mkRow('2026-08-18','i18'), mkRow('2026-08-17','i17'), mkRow('2026-08-16','i16')]
  const cursor = cursorFrom(page1)                        // {2026-08-16, i16}
  // User accepts/dismisses three of the shown rows → the DISPLAY list shrinks…
  let displayed = page1.filter((r) => !['i20','i19','i18'].includes(r.id))  // [i17, i16]
  // …but the server's "next page after cursor" is unaffected by those removals.
  const page2 = [mkRow('2026-08-15','i15'), mkRow('2026-08-14','i14')]      // rows strictly < i16
  // The filter encodes exactly the i16 boundary — nothing between i17..i16 is re-queried, nothing after is skipped.
  assert.ok(keysetFilter(cursor).includes('id.lt.i16'))
  const merged = dedupeById(displayed, page2)
  assert.deepStrictEqual(merged.map((r) => r.id), ['i17','i16','i15','i14'])  // contiguous, no skip, no dup
})

test('dedupeById: overlap removed, order preserved (Retry cannot append duplicates)', () => {
  const prev = [mkRow('2026-08-10','a'), mkRow('2026-08-09','b')]
  const incoming = [mkRow('2026-08-09','b'), mkRow('2026-08-08','c')]  // 'b' overlaps
  assert.deepStrictEqual(dedupeById(prev, incoming).map((r) => r.id), ['a','b','c'])
  assert.deepStrictEqual(dedupeById(prev, []).map((r) => r.id), ['a','b'])
  assert.deepStrictEqual(dedupeById([], incoming).map((r) => r.id), ['b','c'])
  assert.deepStrictEqual(dedupeById(null, null), [])
})

test('computeHasMore: full page → maybe more; short/empty page → end of list', () => {
  assert.strictEqual(computeHasMore(REVIEW_PAGE_SIZE), true)
  assert.strictEqual(computeHasMore(REVIEW_PAGE_SIZE - 1), false)
  assert.strictEqual(computeHasMore(0), false)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
