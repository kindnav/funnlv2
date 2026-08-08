/**
 * ai-contact-reference-validation.test.js
 *
 * Tests for validateContactRefs() — the runtime contact-reference validation
 * helper that gates ContactRefCard rendering.
 *
 * Zero-dependency Node.js — run with: node tests/ai-contact-reference-validation.test.js
 */
import assert from 'assert'
import {
  validateContactRefs,
  extractContactRefs,
} from '../src/lib/ai-history.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

const CONTACTS = [
  { id: '00000000-0000-0000-0000-000000000001', name: 'Alice Smith', company: 'Goldman Sachs', role: 'Analyst' },
  { id: '00000000-0000-0000-0000-000000000002', name: 'Bob Jones',   company: 'Bain',          role: 'Consultant' },
  { id: '00000000-0000-0000-0000-000000000003', name: 'Carol Chen',  company: null,             role: null },
]

const ref1 = { name: 'Alice Smith', contactId: '00000000-0000-0000-0000-000000000001' }
const ref2 = { name: 'Bob Jones',   contactId: '00000000-0000-0000-0000-000000000002' }
const refUnknown = { name: 'Ghost', contactId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }

// ── Input guards ───────────────────────────────────────────────────────────────

console.log('\nvalidateContactRefs — input guards\n')

test('returns [] for null refs', () => {
  assert.deepStrictEqual(validateContactRefs(null, CONTACTS), [])
})

test('returns [] for null allowedContacts', () => {
  assert.deepStrictEqual(validateContactRefs([ref1], null), [])
})

test('returns [] for non-array refs', () => {
  assert.deepStrictEqual(validateContactRefs('not array', CONTACTS), [])
})

test('returns [] for non-array allowedContacts', () => {
  assert.deepStrictEqual(validateContactRefs([ref1], 'not array'), [])
})

test('returns [] when refs is empty', () => {
  assert.deepStrictEqual(validateContactRefs([], CONTACTS), [])
})

test('returns [] when allowedContacts is empty', () => {
  assert.deepStrictEqual(validateContactRefs([ref1], []), [])
})

// ── Valid references ───────────────────────────────────────────────────────────

console.log('\nvalidateContactRefs — valid references\n')

test('returns validated ref for known contact', () => {
  const result = validateContactRefs([ref1], CONTACTS)
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].contactId, ref1.contactId)
})

test('uses canonical name from DB, not provider-supplied label', () => {
  // Provider generates "ALICE S." but DB has "Alice Smith"
  const providerRef = { name: 'ALICE S.', contactId: '00000000-0000-0000-0000-000000000001' }
  const result = validateContactRefs([providerRef], CONTACTS)
  assert.strictEqual(result[0].name, 'Alice Smith') // DB canonical name
})

test('includes company and role from DB record', () => {
  const result = validateContactRefs([ref1], CONTACTS)
  assert.strictEqual(result[0].company, 'Goldman Sachs')
  assert.strictEqual(result[0].role, 'Analyst')
})

test('returns null for company/role when not set in DB', () => {
  const ref3 = { name: 'Carol', contactId: '00000000-0000-0000-0000-000000000003' }
  const result = validateContactRefs([ref3], CONTACTS)
  assert.strictEqual(result[0].company, null)
  assert.strictEqual(result[0].role, null)
})

test('validates multiple refs', () => {
  const result = validateContactRefs([ref1, ref2], CONTACTS)
  assert.strictEqual(result.length, 2)
})

test('preserves order of valid refs', () => {
  const result = validateContactRefs([ref2, ref1], CONTACTS)
  assert.strictEqual(result[0].contactId, ref2.contactId)
  assert.strictEqual(result[1].contactId, ref1.contactId)
})

// ── Invalid / unknown references ───────────────────────────────────────────────

console.log('\nvalidateContactRefs — invalid/unknown references\n')

test('rejects unknown UUID', () => {
  assert.deepStrictEqual(validateContactRefs([refUnknown], CONTACTS), [])
})

test('rejects null entry in refs array', () => {
  const result = validateContactRefs([null, ref1], CONTACTS)
  assert.strictEqual(result.length, 1)
})

test('rejects ref with non-string contactId', () => {
  const bad = { name: 'Alice', contactId: 12345 }
  assert.deepStrictEqual(validateContactRefs([bad], CONTACTS), [])
})

test('rejects ref with missing contactId', () => {
  const bad = { name: 'Alice' }
  assert.deepStrictEqual(validateContactRefs([bad], CONTACTS), [])
})

// ── Mixed valid / invalid ──────────────────────────────────────────────────────

console.log('\nvalidateContactRefs — mixed valid/invalid\n')

test('returns only valid refs from a mixed array', () => {
  const result = validateContactRefs([ref1, refUnknown, ref2], CONTACTS)
  assert.strictEqual(result.length, 2)
  const ids = result.map(r => r.contactId)
  assert.ok(ids.includes(ref1.contactId))
  assert.ok(ids.includes(ref2.contactId))
  assert.ok(!ids.includes(refUnknown.contactId))
})

// ── Deduplication (via extractContactRefs upstream) ───────────────────────────

console.log('\nvalidateContactRefs — with extractContactRefs\n')

test('pipeline: extract then validate works end-to-end', () => {
  const md = '[Alice Smith](/contacts/00000000-0000-0000-0000-000000000001) and [Bob Jones](/contacts/00000000-0000-0000-0000-000000000002)'
  const refs   = extractContactRefs(md)
  const result = validateContactRefs(refs, CONTACTS)
  assert.strictEqual(result.length, 2)
})

test('pipeline: unknown UUID from markdown is rejected', () => {
  const md = '[Ghost](/contacts/ffffffff-ffff-ffff-ffff-ffffffffffff)'
  const refs   = extractContactRefs(md)
  const result = validateContactRefs(refs, CONTACTS)
  assert.deepStrictEqual(result, [])
})

test('pipeline: deduplication + validation', () => {
  const id = '00000000-0000-0000-0000-000000000001'
  const md = '[Alice](/contacts/' + id + ') and [ALICE](/contacts/' + id + ')'
  const refs   = extractContactRefs(md) // deduplicated by extractContactRefs
  const result = validateContactRefs(refs, CONTACTS)
  assert.strictEqual(result.length, 1)
})

test('pipeline: empty markdown produces empty result', () => {
  const refs = extractContactRefs('No contacts here.')
  assert.deepStrictEqual(validateContactRefs(refs, CONTACTS), [])
})

// ── Security: cross-user access ────────────────────────────────────────────────

console.log('\nvalidateContactRefs — cross-user isolation\n')

test('ref from a different user is rejected because their ID is not in allowedContacts', () => {
  // The RLS layer ensures allowedContacts only contains the authenticated user's contacts.
  // The validation function itself enforces this by only accepting IDs present in that set.
  const foreignRef = { name: 'Intruder', contactId: 'aaaaaaaa-0000-0000-0000-000000000001' }
  const result = validateContactRefs([foreignRef], CONTACTS)
  assert.deepStrictEqual(result, [])
})

test('provider cannot override contact identity fields', () => {
  // Even if provider says "company: Evil Corp", validated ref uses DB company
  const trickRef = { name: 'Alice Smith (Evil Corp)', contactId: '00000000-0000-0000-0000-000000000001' }
  const result   = validateContactRefs([trickRef], CONTACTS)
  assert.strictEqual(result[0].company, 'Goldman Sachs') // from DB, not markdown
  assert.strictEqual(result[0].name,    'Alice Smith')   // canonical
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
