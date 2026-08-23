// Tests for calendarEmailMatch.js — deterministic email → contact matching.
// Pure Node.js — no DOM, no Supabase. Run: node tests/calendar-email-match.test.js

import assert from 'assert'
import {
  normalizeCalendarEmail,
  isExcludedAddress,
  isConnectedUserEmail,
  resolveContactMatch,
  matchEventContacts,
} from '../supabase/functions/shared/calendarEmailMatch.js'

let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

// ── normalizeCalendarEmail ────────────────────────────────────────────────────
console.log('\nnormalizeCalendarEmail')

test('trims and lowercases', () => {
  assert.strictEqual(normalizeCalendarEmail('  Priya@Goldman.COM '), 'priya@goldman.com')
})
test('non-string → empty string', () => {
  assert.strictEqual(normalizeCalendarEmail(null), '')
  assert.strictEqual(normalizeCalendarEmail(undefined), '')
  assert.strictEqual(normalizeCalendarEmail(42), '')
  assert.strictEqual(normalizeCalendarEmail({}), '')
})

// ── isExcludedAddress ─────────────────────────────────────────────────────────
console.log('\nisExcludedAddress')

test('normal personal address is not excluded', () => {
  assert.strictEqual(isExcludedAddress('priya@goldman.com'), false)
})
test('empty / malformed excluded (fail closed)', () => {
  assert.strictEqual(isExcludedAddress(''), true)
  assert.strictEqual(isExcludedAddress('no-at-sign'), true)
  assert.strictEqual(isExcludedAddress('a@@b.com'), true)
  assert.strictEqual(isExcludedAddress('@nolocal.com'), true)
  assert.strictEqual(isExcludedAddress('trailing@'), true)
})
test('google resource/room/group calendar domains excluded', () => {
  assert.strictEqual(isExcludedAddress('c_abc123@resource.calendar.google.com'), true)
  assert.strictEqual(isExcludedAddress('xyz@group.calendar.google.com'), true)
  assert.strictEqual(isExcludedAddress('en.usa#holiday@group.v.calendar.google.com'), true)
})
test('calendar-notification@google.com excluded', () => {
  assert.strictEqual(isExcludedAddress('calendar-notification@google.com'), true)
})
test('automated / no-reply local parts excluded', () => {
  for (const a of [
    'noreply@acme.com', 'no-reply@acme.com', 'no_reply.team@acme.com',
    'donotreply@acme.com', 'do-not-reply@acme.com', 'mailer-daemon@acme.com',
    'postmaster@acme.com', 'bounce@acme.com', 'bounces+x@acme.com',
    'notifications@acme.com', 'automated@acme.com', 'auto-reply@acme.com',
  ]) {
    assert.strictEqual(isExcludedAddress(a), true, `${a} should be excluded`)
  }
})
test('real words that merely start with an excluded prefix are NOT excluded', () => {
  assert.strictEqual(isExcludedAddress('norbert@acme.com'), false)   // "nor" not "no-reply"
  assert.strictEqual(isExcludedAddress('noreplyfan@acme.com'), false) // no separator/boundary
  assert.strictEqual(isExcludedAddress('automation-lead@acme.com'), false) // "automation" not "automated"
})

// ── isConnectedUserEmail ──────────────────────────────────────────────────────
console.log('\nisConnectedUserEmail')

test('matches the connected user regardless of case/space', () => {
  assert.strictEqual(isConnectedUserEmail('me@x.com', '  Me@X.com '), true)
})
test('different address is not the connected user', () => {
  assert.strictEqual(isConnectedUserEmail('me@x.com', 'you@x.com'), false)
})
test('blank connected email never matches', () => {
  assert.strictEqual(isConnectedUserEmail('me@x.com', ''), false)
  assert.strictEqual(isConnectedUserEmail('me@x.com', null), false)
})

// ── resolveContactMatch ───────────────────────────────────────────────────────
console.log('\nresolveContactMatch')

const contacts = [
  { id: 'c1', email: 'Priya@Goldman.com' },
  { id: 'c2', email: 'raj@jane.com' },
  { id: 'c3', email: null },
]

test('exactly one match → matched with contactId', () => {
  assert.deepStrictEqual(resolveContactMatch('priya@goldman.com', contacts), { result: 'matched', contactId: 'c1' })
})
test('zero matches → none', () => {
  assert.deepStrictEqual(resolveContactMatch('nobody@x.com', contacts), { result: 'none' })
})
test('excluded address → excluded (never a match)', () => {
  assert.deepStrictEqual(resolveContactMatch('noreply@x.com', contacts), { result: 'excluded' })
})
test('two contacts sharing a normalized email → ambiguous', () => {
  const dup = [{ id: 'a', email: 'dup@x.com' }, { id: 'b', email: 'DUP@x.com' }]
  assert.deepStrictEqual(resolveContactMatch('dup@x.com', dup), { result: 'ambiguous', count: 2 })
})
test('duplicate rows for the SAME contact id count once → matched', () => {
  const dupRows = [{ id: 'a', email: 'x@x.com' }, { id: 'a', email: 'x@x.com' }]
  assert.deepStrictEqual(resolveContactMatch('x@x.com', dupRows), { result: 'matched', contactId: 'a' })
})
test('never fuzzy matches (substring is not a match)', () => {
  assert.deepStrictEqual(resolveContactMatch('priya@goldman.co', contacts), { result: 'none' })
})

// ── matchEventContacts ────────────────────────────────────────────────────────
console.log('\nmatchEventContacts')

test('three distinct matched contacts from one attendee list', () => {
  const three = [{ id: 'c1', email: 'a@x.com' }, { id: 'c2', email: 'b@x.com' }, { id: 'c3', email: 'c@x.com' }]
  const emails = ['A@x.com', 'b@x.com', 'C@x.com']
  const { matchedContactIds, ambiguousCount } = matchEventContacts(emails, three, 'me@x.com')
  assert.deepStrictEqual(matchedContactIds.sort(), ['c1', 'c2', 'c3'])
  assert.strictEqual(ambiguousCount, 0)
})
test('excludes the connected user + de-dupes repeated addresses', () => {
  const cs = [{ id: 'c1', email: 'a@x.com' }]
  const { matchedContactIds } = matchEventContacts(['me@x.com', 'a@x.com', 'a@x.com'], cs, 'me@x.com')
  assert.deepStrictEqual(matchedContactIds, ['c1'])
})
test('ambiguous duplicate emails counted, not matched', () => {
  const cs = [{ id: 'a', email: 'dup@x.com' }, { id: 'b', email: 'dup@x.com' }]
  const { matchedContactIds, ambiguousCount } = matchEventContacts(['dup@x.com'], cs, 'me@x.com')
  assert.deepStrictEqual(matchedContactIds, [])
  assert.strictEqual(ambiguousCount, 1)
})
test('resource/automated addresses ignored', () => {
  const cs = [{ id: 'c1', email: 'a@x.com' }]
  const { matchedContactIds } = matchEventContacts(
    ['room@resource.calendar.google.com', 'noreply@x.com', 'a@x.com'], cs, 'me@x.com')
  assert.deepStrictEqual(matchedContactIds, ['c1'])
})
test('non-array emails handled safely', () => {
  assert.deepStrictEqual(matchEventContacts(null, [], 'me@x.com'), { matchedContactIds: [], ambiguousCount: 0 })
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
