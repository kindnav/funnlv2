/**
 * import-existing-duplicates.test.js
 *
 * Tests for the three DB-duplicate helpers added to importReviewUtils.js:
 *   normalizeEmailForDedup
 *   normalizeLinkedinForDedup
 *   detectDatabaseDuplicates
 *
 * Zero-dependency Node.js — run with: node tests/import-existing-duplicates.test.js
 */
import assert from 'assert'
import {
  normalizeEmailForDedup,
  normalizeLinkedinForDedup,
  normalizeCompanyForDedup,
  detectDatabaseDuplicates,
} from '../src/lib/importReviewUtils.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

// ── normalizeEmailForDedup ────────────────────────────────────────────────────

console.log('\nnormalizeEmailForDedup\n')

test('returns empty string for non-string', () => {
  assert.strictEqual(normalizeEmailForDedup(null), '')
  assert.strictEqual(normalizeEmailForDedup(undefined), '')
  assert.strictEqual(normalizeEmailForDedup(42), '')
})

test('returns empty string for empty input', () => {
  assert.strictEqual(normalizeEmailForDedup(''), '')
})

test('lowercases email', () => {
  assert.strictEqual(normalizeEmailForDedup('Alice@EXAMPLE.COM'), 'alice@example.com')
})

test('trims leading/trailing whitespace', () => {
  assert.strictEqual(normalizeEmailForDedup('  alice@example.com  '), 'alice@example.com')
})

test('preserves plus-addressing', () => {
  assert.strictEqual(normalizeEmailForDedup('alice+funnl@example.com'), 'alice+funnl@example.com')
})

test('preserves dots in local part', () => {
  assert.strictEqual(normalizeEmailForDedup('Alice.Smith@Gmail.com'), 'alice.smith@gmail.com')
})

test('two identical emails normalize to same string', () => {
  const a = normalizeEmailForDedup(' ALICE@Example.COM ')
  const b = normalizeEmailForDedup('alice@example.com')
  assert.strictEqual(a, b)
})

// ── normalizeCompanyForDedup ──────────────────────────────────────────────────

console.log('\nnormalizeCompanyForDedup\n')

test('returns empty string for non-string', () => {
  assert.strictEqual(normalizeCompanyForDedup(null), '')
  assert.strictEqual(normalizeCompanyForDedup(undefined), '')
  assert.strictEqual(normalizeCompanyForDedup(42), '')
})

test('returns empty string for empty input', () => {
  assert.strictEqual(normalizeCompanyForDedup(''), '')
})

test('lowercases company', () => {
  assert.strictEqual(normalizeCompanyForDedup('Goldman Sachs'), 'goldman sachs')
})

test('trims leading/trailing whitespace', () => {
  assert.strictEqual(normalizeCompanyForDedup('  McKinsey  '), 'mckinsey')
})

test('collapses internal whitespace', () => {
  assert.strictEqual(normalizeCompanyForDedup('Goldman  Sachs'), 'goldman sachs')
})

test('two identical companies normalize to same string', () => {
  const a = normalizeCompanyForDedup('  GOLDMAN SACHS  ')
  const b = normalizeCompanyForDedup('goldman sachs')
  assert.strictEqual(a, b)
})

// ── normalizeLinkedinForDedup ─────────────────────────────────────────────────

console.log('\nnormalizeLinkedinForDedup\n')

test('returns empty string for non-string', () => {
  assert.strictEqual(normalizeLinkedinForDedup(null), '')
  assert.strictEqual(normalizeLinkedinForDedup(undefined), '')
})

test('returns empty string for empty input', () => {
  assert.strictEqual(normalizeLinkedinForDedup(''), '')
})

test('strips https://', () => {
  const result = normalizeLinkedinForDedup('https://linkedin.com/in/alice')
  assert.ok(!result.startsWith('https://'), 'should not start with https://')
})

test('strips http://', () => {
  const result = normalizeLinkedinForDedup('http://linkedin.com/in/alice')
  assert.ok(!result.startsWith('http://'), 'should not start with http://')
})

test('strips www. prefix', () => {
  const result = normalizeLinkedinForDedup('www.linkedin.com/in/alice')
  assert.ok(!result.startsWith('www.'), 'should not start with www.')
})

test('strips trailing slash', () => {
  const result = normalizeLinkedinForDedup('linkedin.com/in/alice/')
  assert.ok(!result.endsWith('/'), 'should not end with /')
})

test('lowercases the URL', () => {
  const result = normalizeLinkedinForDedup('LinkedIn.com/in/ALICE')
  assert.strictEqual(result, 'linkedin.com/in/alice')
})

test('https://www.linkedin.com/in/alice/ matches linkedin.com/in/alice', () => {
  const a = normalizeLinkedinForDedup('https://www.linkedin.com/in/alice/')
  const b = normalizeLinkedinForDedup('linkedin.com/in/alice')
  assert.strictEqual(a, b)
})

test('http://linkedin.com/in/foo matches https://www.linkedin.com/in/foo/', () => {
  const a = normalizeLinkedinForDedup('http://linkedin.com/in/foo')
  const b = normalizeLinkedinForDedup('https://www.linkedin.com/in/foo/')
  assert.strictEqual(a, b)
})

test('preserves path after stripping protocol and www', () => {
  const result = normalizeLinkedinForDedup('https://www.linkedin.com/in/alice-smith-123')
  assert.strictEqual(result, 'linkedin.com/in/alice-smith-123')
})

test('non-linkedin URL is still normalized (protocol stripped)', () => {
  const result = normalizeLinkedinForDedup('https://example.com/profile')
  assert.strictEqual(result, 'example.com/profile')
})

// ── detectDatabaseDuplicates ──────────────────────────────────────────────────

console.log('\ndetectDatabaseDuplicates\n')

const makeIncoming = (overrides) => ({
  _rowId: 'row-1',
  name: 'Alice Smith',
  email: '',
  linkedin_url: '',
  ...overrides,
})

const makeExisting = (overrides) => ({
  id: 'db-uuid-1',
  name: 'Alice Smith',
  email: '',
  linkedin_url: '',
  ...overrides,
})

test('returns empty Map for non-array inputs', () => {
  assert.deepStrictEqual([...detectDatabaseDuplicates(null, [])], [])
  assert.deepStrictEqual([...detectDatabaseDuplicates([], null)], [])
})

test('returns empty Map when existingContacts is empty', () => {
  const incoming = [makeIncoming()]
  const result = detectDatabaseDuplicates(incoming, [])
  assert.strictEqual(result.size, 0)
})

test('returns empty Map when incomingContacts is empty', () => {
  const existing = [makeExisting()]
  const result = detectDatabaseDuplicates([], existing)
  assert.strictEqual(result.size, 0)
})

test('matches by email (exact normalized)', () => {
  const incoming = [makeIncoming({ email: 'alice@example.com' })]
  const existing = [makeExisting({ email: 'ALICE@EXAMPLE.COM' })]
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.size, 1)
  assert.strictEqual(result.get('row-1').id, 'db-uuid-1')
})

test('email match returns existing contact name', () => {
  const incoming = [makeIncoming({ email: 'alice@example.com' })]
  const existing = [makeExisting({ name: 'Alice B. Smith', email: 'alice@example.com' })]
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.get('row-1').name, 'Alice B. Smith')
})

test('matches by linkedin_url (normalized)', () => {
  const incoming = [makeIncoming({
    email: '',
    linkedin_url: 'https://www.linkedin.com/in/alice/',
  })]
  const existing = [makeExisting({
    email: '',
    linkedin_url: 'linkedin.com/in/alice',
  })]
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.size, 1)
})

test('name alone (no company on either side) does NOT match — prevents false positives', () => {
  const incoming = [makeIncoming({ email: '', linkedin_url: '', name: 'Alice Smith' })]
  const existing = [makeExisting({ email: '', linkedin_url: '', name: 'Alice Smith' })]
  // Neither side has a company — name-only match intentionally removed
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.size, 0)
})

test('name + company both match → matched (case-insensitive)', () => {
  const incoming = [makeIncoming({ email: '', linkedin_url: '', name: 'ALICE SMITH', company: 'Goldman Sachs' })]
  const existing = [makeExisting({ email: '', linkedin_url: '', name: 'alice smith', company: 'goldman sachs' })]
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.size, 1)
  assert.strictEqual(result.get('row-1').id, 'db-uuid-1')
})

test('name + company match collapses extra whitespace', () => {
  const incoming = [makeIncoming({ email: '', linkedin_url: '', name: 'Alice  Smith', company: 'Goldman  Sachs' })]
  const existing = [makeExisting({ email: '', linkedin_url: '', name: 'alice smith',  company: 'goldman sachs' })]
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.size, 1)
})

test('name matches but company differs → no match', () => {
  const incoming = [makeIncoming({ email: '', linkedin_url: '', name: 'Alice Smith', company: 'McKinsey' })]
  const existing = [makeExisting({ email: '', linkedin_url: '', name: 'Alice Smith', company: 'Goldman Sachs' })]
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.size, 0)
})

test('name matches but incoming has no company → no match', () => {
  const incoming = [makeIncoming({ email: '', linkedin_url: '', name: 'Alice Smith', company: '' })]
  const existing = [makeExisting({ email: '', linkedin_url: '', name: 'Alice Smith', company: 'Goldman Sachs' })]
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.size, 0)
})

test('name matches but existing has no company → no match', () => {
  const incoming = [makeIncoming({ email: '', linkedin_url: '', name: 'Alice Smith', company: 'Goldman Sachs' })]
  const existing = [makeExisting({ email: '', linkedin_url: '', name: 'Alice Smith', company: '' })]
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.size, 0)
})

test('no match when email, linkedin, and name all differ', () => {
  const incoming = [makeIncoming({ email: 'bob@example.com', name: 'Bob Jones' })]
  const existing = [makeExisting({ email: 'alice@example.com', name: 'Alice Smith' })]
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.size, 0)
})

test('email match takes priority over name match for different contacts', () => {
  // Incoming row: email matches db-uuid-2, name matches db-uuid-1
  // Should use email match (db-uuid-2)
  const incoming = [makeIncoming({ _rowId: 'row-x', email: 'bob@example.com', name: 'Alice Smith' })]
  const existing = [
    { id: 'db-uuid-1', name: 'Alice Smith', email: '', linkedin_url: '' },
    { id: 'db-uuid-2', name: 'Bob Jones',   email: 'bob@example.com', linkedin_url: '' },
  ]
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.get('row-x').id, 'db-uuid-2')
})

test('linkedin match takes priority over name match', () => {
  // Incoming: linkedin matches db-uuid-2, name matches db-uuid-1
  const incoming = [makeIncoming({
    _rowId: 'row-y',
    email: '',
    linkedin_url: 'linkedin.com/in/bob',
    name: 'Alice Smith',
  })]
  const existing = [
    { id: 'db-uuid-1', name: 'Alice Smith', email: '', linkedin_url: '' },
    { id: 'db-uuid-2', name: 'Bob Jones',   email: '', linkedin_url: 'https://linkedin.com/in/bob/' },
  ]
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.get('row-y').id, 'db-uuid-2')
})

test('row without name, email, linkedin does not match', () => {
  const incoming = [makeIncoming({ _rowId: 'row-empty', email: '', linkedin_url: '', name: '' })]
  const existing = [makeExisting({ email: '', linkedin_url: '', name: 'Alice Smith' })]
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.size, 0)
})

test('multiple incoming rows detected independently', () => {
  const incoming = [
    { _rowId: 'row-a', name: 'Alice Smith', email: 'alice@ex.com', linkedin_url: '' },
    { _rowId: 'row-b', name: 'Bob Jones',   email: 'bob@ex.com',   linkedin_url: '' },
    { _rowId: 'row-c', name: 'Charlie New', email: 'charlie@ex.com', linkedin_url: '' },
  ]
  const existing = [
    { id: 'db-a', name: 'Alice Smith', email: 'alice@ex.com',   linkedin_url: '' },
    { id: 'db-b', name: 'Bob Jones',   email: 'bob@ex.com',     linkedin_url: '' },
    // Charlie not in existing
  ]
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.size, 2)
  assert.strictEqual(result.get('row-a').id, 'db-a')
  assert.strictEqual(result.get('row-b').id, 'db-b')
  assert.ok(!result.has('row-c'), 'Charlie should not be flagged as a DB duplicate')
})

test('each incoming row matched only once (first-match wins)', () => {
  // row matches alice@ex.com (email) AND "Alice Smith" (name) — both map to same db ID
  const incoming = [makeIncoming({ _rowId: 'row-1', email: 'alice@ex.com', name: 'Alice Smith' })]
  const existing = [
    { id: 'db-uuid-1', name: 'Alice Smith', email: 'alice@ex.com', linkedin_url: '' },
  ]
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.size, 1)
})

test('existing contacts with empty email do not produce spurious matches on empty emails', () => {
  // Two incoming with empty email — neither should match existing with empty email
  const incoming = [
    { _rowId: 'row-1', name: 'Alice', email: '', linkedin_url: '' },
    { _rowId: 'row-2', name: 'Bob',   email: '', linkedin_url: '' },
  ]
  const existing = [{ id: 'db-x', name: 'Charlie', email: '', linkedin_url: '' }]
  // 'alice' and 'bob' names differ from 'charlie' — no match expected
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.size, 0)
})

test('existing contacts with empty linkedin do not produce spurious linkedin matches', () => {
  const incoming = [makeIncoming({ email: '', linkedin_url: '' })]
  const existing = [makeExisting({ email: '', linkedin_url: '', name: 'Different Person' })]
  const result = detectDatabaseDuplicates(incoming, existing)
  // Names differ — no match
  assert.strictEqual(result.size, 0)
})

test('result Map contains {id, name} stub with correct structure', () => {
  const incoming = [makeIncoming({ email: 'alice@ex.com' })]
  const existing = [{ id: 'the-db-id', name: 'Existing Alice', email: 'alice@ex.com', linkedin_url: '' }]
  const result = detectDatabaseDuplicates(incoming, existing)
  const stub = result.get('row-1')
  assert.ok(stub, 'stub must exist')
  assert.ok('id' in stub, 'stub must have id')
  assert.ok('name' in stub, 'stub must have name')
  assert.strictEqual(stub.id, 'the-db-id')
  assert.strictEqual(stub.name, 'Existing Alice')
})

test('handles existingContacts with null/missing fields gracefully', () => {
  const incoming = [makeIncoming({ email: 'alice@ex.com' })]
  const existing = [{ id: 'db-1', name: null, email: null, linkedin_url: null }]
  // null fields normalize to '' and should not produce spurious matches
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.size, 0)
})

test('handles incomingContacts with null/missing fields gracefully', () => {
  const incoming = [{ _rowId: 'row-null', name: null, email: null, linkedin_url: null }]
  const existing = [makeExisting({ email: 'alice@ex.com' })]
  assert.doesNotThrow(() => detectDatabaseDuplicates(incoming, existing))
  const result = detectDatabaseDuplicates(incoming, existing)
  assert.strictEqual(result.size, 0)
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
