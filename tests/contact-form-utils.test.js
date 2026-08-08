/**
 * contact-form-utils.test.js
 *
 * Tests for pure functions in src/lib/contactFormUtils.js.
 * Zero-dependency Node.js — run with: node tests/contact-form-utils.test.js
 */
import assert from 'assert'
import {
  normalizeName,
  normalizeCompany,
  findDuplicate,
  effectiveOutreachStatus,
} from '../src/lib/contactFormUtils.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗  ${name}: ${e.message}`)
    failed++
  }
}

// ── normalizeName ──────────────────────────────────────────────────────────────

console.log('\nnormalizeName\n')

test('trims leading and trailing whitespace', () => {
  assert.strictEqual(normalizeName('  Alice  '), 'alice')
})

test('lowercases the name', () => {
  assert.strictEqual(normalizeName('Alice Smith'), 'alice smith')
})

test('collapses internal whitespace', () => {
  assert.strictEqual(normalizeName('Alice  Smith'), 'alice smith')
})

test('handles empty string', () => {
  assert.strictEqual(normalizeName(''), '')
})

test('handles null', () => {
  assert.strictEqual(normalizeName(null), '')
})

test('handles undefined', () => {
  assert.strictEqual(normalizeName(undefined), '')
})

test('preserves single spaces between words', () => {
  assert.strictEqual(normalizeName('John A Smith'), 'john a smith')
})

// ── normalizeCompany ───────────────────────────────────────────────────────────

console.log('\nnormalizeCompany\n')

test('trims whitespace', () => {
  assert.strictEqual(normalizeCompany('  Goldman Sachs  '), 'goldman sachs')
})

test('lowercases the company', () => {
  assert.strictEqual(normalizeCompany('Goldman Sachs'), 'goldman sachs')
})

test('collapses internal whitespace', () => {
  assert.strictEqual(normalizeCompany('Goldman  Sachs'), 'goldman sachs')
})

test('handles empty string', () => {
  assert.strictEqual(normalizeCompany(''), '')
})

test('handles null', () => {
  assert.strictEqual(normalizeCompany(null), '')
})

// ── findDuplicate ──────────────────────────────────────────────────────────────

console.log('\nfindDuplicate\n')

const baseContacts = [
  { id: 'a1', name: 'Alice Smith',   company: 'Goldman Sachs' },
  { id: 'b2', name: 'Bob Jones',     company: 'McKinsey'      },
  { id: 'c3', name: 'Carol Lin',     company: null            },
  { id: 'd4', name: 'David Park',    company: ''              },
]

test('returns null when contacts array is empty', () => {
  assert.strictEqual(findDuplicate([], 'Alice Smith', 'Goldman Sachs'), null)
})

test('returns null when name is empty string', () => {
  assert.strictEqual(findDuplicate(baseContacts, '', 'Goldman Sachs'), null)
})

test('returns null when name is whitespace-only', () => {
  assert.strictEqual(findDuplicate(baseContacts, '   ', 'Goldman Sachs'), null)
})

test('finds an exact match', () => {
  const result = findDuplicate(baseContacts, 'Alice Smith', 'Goldman Sachs')
  assert.strictEqual(result.id, 'a1')
})

test('finds match with different casing', () => {
  const result = findDuplicate(baseContacts, 'alice smith', 'goldman sachs')
  assert.strictEqual(result.id, 'a1')
})

test('finds match ignoring leading/trailing whitespace', () => {
  const result = findDuplicate(baseContacts, '  Alice Smith  ', '  Goldman Sachs  ')
  assert.strictEqual(result.id, 'a1')
})

test('finds match with collapsed internal whitespace', () => {
  const result = findDuplicate(baseContacts, 'Alice  Smith', 'Goldman  Sachs')
  assert.strictEqual(result.id, 'a1')
})

test('returns null when name matches but company does not', () => {
  assert.strictEqual(findDuplicate(baseContacts, 'Alice Smith', 'Blackstone'), null)
})

test('returns null when company matches but name does not', () => {
  assert.strictEqual(findDuplicate(baseContacts, 'Eve Roberts', 'Goldman Sachs'), null)
})

test('matches contact with null company when new company is empty', () => {
  // Carol Lin has null company — normalizes to ''
  const result = findDuplicate(baseContacts, 'Carol Lin', '')
  assert.strictEqual(result.id, 'c3')
})

test('matches contact with empty string company when new company is also empty', () => {
  const result = findDuplicate(baseContacts, 'David Park', '')
  assert.strictEqual(result.id, 'd4')
})

test('excludes the contact with excludeId', () => {
  const result = findDuplicate(baseContacts, 'Alice Smith', 'Goldman Sachs', 'a1')
  assert.strictEqual(result, null)
})

test('excludes only the specified contact, not others', () => {
  const result = findDuplicate(baseContacts, 'Bob Jones', 'McKinsey', 'a1')
  assert.strictEqual(result.id, 'b2')
})

test('returns first match when multiple duplicates exist', () => {
  const dupes = [
    { id: 'x1', name: 'Twin', company: 'Acme' },
    { id: 'x2', name: 'Twin', company: 'Acme' },
  ]
  const result = findDuplicate(dupes, 'Twin', 'Acme')
  assert.strictEqual(result.id, 'x1')
})

// ── effectiveOutreachStatus ────────────────────────────────────────────────────

console.log('\neffectiveOutreachStatus\n')

test('Email + trackOutreach=true + status set → returns status', () => {
  assert.strictEqual(effectiveOutreachStatus('Email', true, 'awaiting_response'), 'awaiting_response')
})

test('Email + trackOutreach=true + empty status → returns null', () => {
  assert.strictEqual(effectiveOutreachStatus('Email', true, ''), null)
})

test('Email + trackOutreach=false → returns null regardless of status', () => {
  assert.strictEqual(effectiveOutreachStatus('Email', false, 'awaiting_response'), null)
})

test('Message + trackOutreach=true + status set → returns status', () => {
  assert.strictEqual(effectiveOutreachStatus('Message', true, 'responded'), 'responded')
})

test('Message + trackOutreach=false → returns null', () => {
  assert.strictEqual(effectiveOutreachStatus('Message', false, 'responded'), null)
})

test('Call + status set → returns status directly', () => {
  assert.strictEqual(effectiveOutreachStatus('Call', false, 'meeting_booked'), 'meeting_booked')
})

test('Call + empty status → returns null', () => {
  assert.strictEqual(effectiveOutreachStatus('Call', false, ''), null)
})

test('Other + status set → returns status directly', () => {
  assert.strictEqual(effectiveOutreachStatus('Other', true, 'no_response'), 'no_response')
})

test('Other + empty status → returns null', () => {
  assert.strictEqual(effectiveOutreachStatus('Other', false, ''), null)
})

test('Coffee chat → always returns null', () => {
  assert.strictEqual(effectiveOutreachStatus('Coffee chat', true, 'responded'), null)
})

test('Event → always returns null', () => {
  assert.strictEqual(effectiveOutreachStatus('Event', true, 'meeting_booked'), null)
})

test('unknown type → returns null', () => {
  assert.strictEqual(effectiveOutreachStatus('Seminar', true, 'responded'), null)
})

// ─────────────────────────────────────────────────────────────────────────────

console.log()
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
