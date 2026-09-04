// Tests for the conservative email address parser + matcher. Synthetic fixtures only
// (example.com domains, single-letter locals) — no real addresses or PII.
// Run: node tests/email-address.test.js

import assert from 'assert'
import {
  normalizeEmail, isValidAddrSpec, parseAddressList, parseSingleAddress, matchContactByEmail,
} from '../supabase/functions/shared/emailAddress.js'

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

console.log('\nnormalizeEmail (trim+lowercase only; no dot/plus stripping)')
test('trims + lowercases; preserves dots and +tags', () => {
  assert.strictEqual(normalizeEmail('  A.B+Tag@Example.COM '), 'a.b+tag@example.com')
  assert.strictEqual(normalizeEmail('a.b@example.com'), 'a.b@example.com') // dots kept
  assert.strictEqual(normalizeEmail('a+x@example.com'), 'a+x@example.com') // +tag kept
  assert.strictEqual(normalizeEmail(123), '')
  assert.strictEqual(normalizeEmail(''), '')
})

console.log('\nisValidAddrSpec (conservative)')
test('accepts simple, rejects malformed/spaces/double-@', () => {
  assert.ok(isValidAddrSpec('a@example.com'))
  assert.ok(isValidAddrSpec('a.b+t@sub.example.com'))
  assert.ok(!isValidAddrSpec('a@@example.com'))
  assert.ok(!isValidAddrSpec('a b@example.com'))
  assert.ok(!isValidAddrSpec('@example.com'))
  assert.ok(!isValidAddrSpec('a@'))
  assert.ok(!isValidAddrSpec('.a@example.com')) // leading dot in local
})

console.log('\nparseAddressList')
test('bare + display-name + brackets, mixed case, dedupe', () => {
  const r = parseAddressList('A@Example.com, "Doe, J" <b@example.com>, a@example.com')
  assert.deepStrictEqual(r.addresses, ['a@example.com', 'b@example.com']) // deduped, normalized
  assert.strictEqual(r.hadMalformed, false)
})
test('quoted display name containing a comma is one recipient', () => {
  const r = parseAddressList('"Last, First" <c@example.com>')
  assert.deepStrictEqual(r.addresses, ['c@example.com'])
  assert.strictEqual(r.hadMalformed, false)
})
test('comments are stripped', () => {
  const r = parseAddressList('d@example.com (work), (home) e@example.com')
  assert.deepStrictEqual(r.addresses, ['d@example.com', 'e@example.com'])
})
test('group syntax members extracted; label dropped; trailing ; ok', () => {
  const r = parseAddressList('Team: f@example.com, g@example.com;')
  assert.deepStrictEqual(r.addresses, ['f@example.com', 'g@example.com'])
  assert.strictEqual(r.hadMalformed, false)
})
test('encoded display name ignored; address extracted', () => {
  const r = parseAddressList('=?utf-8?q?X?= <h@example.com>')
  assert.deepStrictEqual(r.addresses, ['h@example.com'])
})
test('malformed brackets fail closed (flagged, no address)', () => {
  const r = parseAddressList('Broken <i@example.com')
  assert.deepStrictEqual(r.addresses, [])
  assert.strictEqual(r.hadMalformed, true)
})
test('unbalanced quotes fail closed', () => {
  const r = parseAddressList('"unterminated <j@example.com>')
  assert.strictEqual(r.hadMalformed, true)
  assert.deepStrictEqual(r.addresses, [])
})
test('oversized input fails closed', () => {
  const r = parseAddressList('a@example.com,'.repeat(5000))
  assert.strictEqual(r.hadMalformed, true)
})

console.log('\nparseSingleAddress (From)')
test('single mailbox ok; multiple/malformed -> null', () => {
  assert.strictEqual(parseSingleAddress('"N" <k@example.com>'), 'k@example.com')
  assert.strictEqual(parseSingleAddress('a@example.com, b@example.com'), null) // >1
  assert.strictEqual(parseSingleAddress('garbage'), null)
})

console.log('\nmatchContactByEmail (exact, user-scoped, ambiguity)')
const contacts = [
  { id: 'c1', user_id: 'u1', email: 'A@Example.com' },
  { id: 'c2', user_id: 'u1', email: 'other@example.com' },
  { id: 'c3', user_id: 'u2', email: 'a@example.com' },      // different user
]
test('exact normalized match, scoped to user', () => {
  assert.deepStrictEqual(matchContactByEmail('a@example.com', contacts, 'u1'), { contactId: 'c1' })
  assert.strictEqual(matchContactByEmail('a@example.com', contacts, 'u3'), 'no_contact_match')
})
test('cross-user isolation: u2 owns c3 for a@example.com', () => {
  assert.deepStrictEqual(matchContactByEmail('a@example.com', contacts, 'u2'), { contactId: 'c3' })
  assert.strictEqual(matchContactByEmail('a@example.com', contacts, 'u3'), 'no_contact_match')
})
test('two owned contacts on same normalized email -> ambiguous_contact', () => {
  const dup = [
    { id: 'd1', user_id: 'u1', email: 'x@example.com' },
    { id: 'd2', user_id: 'u1', email: 'X@Example.com' },
  ]
  assert.strictEqual(matchContactByEmail('x@example.com', dup, 'u1'), 'ambiguous_contact')
})
test('no match / empty', () => {
  assert.strictEqual(matchContactByEmail('none@example.com', contacts, 'u1'), 'no_contact_match')
  assert.strictEqual(matchContactByEmail('', contacts, 'u1'), 'no_contact_match')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
