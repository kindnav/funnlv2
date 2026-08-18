// Tests for calendarRelevance.js — deterministic event → candidate truth table.
// Pure Node.js. Run: node tests/calendar-relevance.test.js

import assert from 'assert'
import { evaluateEvent, TYPE_ONE_CONTACT, TYPE_GROUP } from '../supabase/functions/shared/calendarRelevance.js'

let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

const NOW = new Date('2026-08-20T00:00:00Z') // after the events below
const contacts = [
  { id: 'c1', email: 'priya@goldman.com' },
  { id: 'c2', email: 'raj@jane.com' },
  { id: 'c3', email: 'sam@kkr.com' },
]
const connectedEmail = 'me@student.edu'

// A completed timed event helper.
function timedEvent(overrides = {}) {
  return {
    status: 'confirmed',
    start: { dateTime: '2026-08-17T15:00:00Z' },
    end: { dateTime: '2026-08-17T16:00:00Z' },
    organizer: { email: 'me@student.edu' },
    attendees: [
      { email: 'me@student.edu', self: true, responseStatus: 'accepted' },
      { email: 'priya@goldman.com', responseStatus: 'accepted' },
    ],
    ...overrides,
  }
}

console.log('\nevaluateEvent — exclusion truth table')

test('cancelled event → not relevant', () => {
  const r = evaluateEvent({ event: timedEvent({ status: 'cancelled' }), connectedEmail, contacts, now: NOW })
  assert.strictEqual(r.relevant, false); assert.strictEqual(r.reason, 'cancelled')
})
test('user declined → not relevant', () => {
  const ev = timedEvent({ attendees: [
    { email: 'me@student.edu', self: true, responseStatus: 'declined' },
    { email: 'priya@goldman.com', responseStatus: 'accepted' },
  ] })
  const r = evaluateEvent({ event: ev, connectedEmail, contacts, now: NOW })
  assert.strictEqual(r.reason, 'declined')
})
test('only the connected user present → no matched contact', () => {
  const ev = timedEvent({ organizer: { email: 'me@student.edu' }, attendees: [
    { email: 'me@student.edu', self: true, responseStatus: 'accepted' },
  ] })
  const r = evaluateEvent({ event: ev, connectedEmail, contacts, now: NOW })
  assert.strictEqual(r.reason, 'no_matched_contact')
})
test('no external match (unknown attendee) → not relevant', () => {
  const ev = timedEvent({ attendees: [{ email: 'stranger@nowhere.com', responseStatus: 'accepted' }] })
  const r = evaluateEvent({ event: ev, connectedEmail, contacts, now: NOW })
  assert.strictEqual(r.reason, 'no_matched_contact')
})
test('resource/room/automated attendees ignored → no match', () => {
  const ev = timedEvent({ attendees: [
    { email: 'room@resource.calendar.google.com', responseStatus: 'accepted' },
    { email: 'noreply@x.com', responseStatus: 'accepted' },
  ] })
  const r = evaluateEvent({ event: ev, connectedEmail, contacts, now: NOW })
  assert.strictEqual(r.reason, 'no_matched_contact')
})
test('ambiguous duplicate-email contact → not matched, ambiguousCount reported', () => {
  const dupContacts = [{ id: 'a', email: 'dup@x.com' }, { id: 'b', email: 'dup@x.com' }]
  const ev = timedEvent({ attendees: [{ email: 'dup@x.com', responseStatus: 'accepted' }] })
  const r = evaluateEvent({ event: ev, connectedEmail, contacts: dupContacts, now: NOW })
  assert.strictEqual(r.relevant, false)
  assert.strictEqual(r.reason, 'no_matched_contact')
  assert.strictEqual(r.ambiguousCount, 1)
})
test('future event → not completed', () => {
  const r = evaluateEvent({ event: timedEvent(), connectedEmail, contacts, now: new Date('2026-08-17T15:30:00Z') })
  assert.strictEqual(r.reason, 'not_completed')
})
test('invalid timing → not relevant', () => {
  const r = evaluateEvent({ event: timedEvent({ end: undefined }), connectedEmail, contacts, now: NOW })
  assert.strictEqual(r.reason, 'invalid_timing')
})

console.log('\nevaluateEvent — positive cases')

test('exactly one matched contact → Coffee chat candidate', () => {
  const r = evaluateEvent({ event: timedEvent(), connectedEmail, contacts, now: NOW })
  assert.strictEqual(r.relevant, true)
  assert.strictEqual(r.candidates.length, 1)
  assert.strictEqual(r.candidates[0].contactId, 'c1')
  assert.strictEqual(r.candidates[0].proposedType, TYPE_ONE_CONTACT)
  assert.strictEqual(r.candidates[0].proposedInteractionDate, '2026-08-17')
})
test('three matched contacts in one group event → 3 candidates, type Event', () => {
  const ev = timedEvent({ attendees: [
    { email: 'me@student.edu', self: true, responseStatus: 'accepted' },
    { email: 'priya@goldman.com', responseStatus: 'accepted' },
    { email: 'raj@jane.com', responseStatus: 'accepted' },
    { email: 'sam@kkr.com', responseStatus: 'accepted' },
  ] })
  const r = evaluateEvent({ event: ev, connectedEmail, contacts, now: NOW })
  assert.strictEqual(r.relevant, true)
  assert.strictEqual(r.candidates.length, 3)
  assert.deepStrictEqual(r.candidates.map((c) => c.contactId).sort(), ['c1', 'c2', 'c3'])
  for (const c of r.candidates) assert.strictEqual(c.proposedType, TYPE_GROUP)
})
test('all-day completed event with one match → candidate with start date', () => {
  const ev = {
    status: 'confirmed',
    start: { date: '2026-08-16' },
    end: { date: '2026-08-17' },
    organizer: { email: 'me@student.edu' },
    attendees: [{ email: 'priya@goldman.com', responseStatus: 'accepted' }],
  }
  const r = evaluateEvent({ event: ev, connectedEmail, contacts, now: NOW, fallbackTimeZone: 'UTC' })
  assert.strictEqual(r.relevant, true)
  assert.strictEqual(r.candidates[0].proposedInteractionDate, '2026-08-16')
  assert.strictEqual(r.candidates[0].occurrence.kind, 'date')
})
test('recurring instance carries originalStartTime occurrence', () => {
  const ev = timedEvent({ originalStartTime: { dateTime: '2026-08-17T15:00:00Z' }, start: { dateTime: '2026-08-17T15:00:00Z' } })
  const r = evaluateEvent({ event: ev, connectedEmail, contacts, now: NOW })
  assert.strictEqual(r.candidates[0].occurrence.value, '2026-08-17T15:00:00.000Z')
})
test('invalid event object → not relevant', () => {
  assert.strictEqual(evaluateEvent({ event: null, connectedEmail, contacts, now: NOW }).reason, 'invalid_event')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
