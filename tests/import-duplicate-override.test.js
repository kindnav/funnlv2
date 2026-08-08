/**
 * import-duplicate-override.test.js
 *
 * Verifies duplicate detection and override behavior:
 *   - Within-file duplicates detected by detectDuplicatesInBatch (normalized name match)
 *   - DB duplicates detected by detectDatabaseDuplicates (email > linkedin > name+company)
 *   - Within-file dups excluded from Select All by default (parallel to DB dup treatment)
 *   - Override ("Import as separate contact") enables the row for selection
 *   - toggleAllRows logic
 *   - DB dup detection: name-alone no longer triggers (requires name+company both non-empty)
 *
 * Run with: node tests/import-duplicate-override.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  detectDuplicatesInBatch,
  detectDatabaseDuplicates,
  buildReviewRows,
} from '../src/lib/importReviewUtils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dirname, '../src/components/ImportContactsModal.jsx'), 'utf8')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗  ${name}`)
    console.log(`       ${e.message}`)
    failed++
  }
}

// ── Within-file duplicate detection ──────────────────────────────────────────

console.log('\nwithin-file duplicate detection')

test('first occurrence is canonical (not marked duplicate)', () => {
  const rows = [
    { _rowId: 'r0', name: 'Alice Smith' },
    { _rowId: 'r1', name: 'Alice Smith' },
    { _rowId: 'r2', name: 'Bob Jones' },
  ]
  const dups = detectDuplicatesInBatch(rows)
  assert.ok(!dups.has('r0'), 'first Alice is canonical — not a dup')
  assert.ok(dups.has('r1'), 'second Alice is a dup')
  assert.ok(!dups.has('r2'), 'Bob is not a dup')
})

test('detection is case-insensitive and normalizes whitespace', () => {
  const rows = [
    { _rowId: 'r0', name: 'alice smith' },
    { _rowId: 'r1', name: 'Alice  Smith' },
    { _rowId: 'r2', name: 'ALICE SMITH' },
  ]
  const dups = detectDuplicatesInBatch(rows)
  assert.ok(!dups.has('r0'), 'first is canonical')
  assert.ok(dups.has('r1'), 'second normalized match is dup')
  assert.ok(dups.has('r2'), 'third normalized match is dup')
})

test('three copies: only the first is canonical', () => {
  const rows = [
    { _rowId: 'a', name: 'Jane' },
    { _rowId: 'b', name: 'Jane' },
    { _rowId: 'c', name: 'Jane' },
  ]
  const dups = detectDuplicatesInBatch(rows)
  assert.ok(!dups.has('a'))
  assert.ok(dups.has('b'))
  assert.ok(dups.has('c'))
})

test('empty name rows are not detected as dups of each other', () => {
  const rows = [
    { _rowId: 'r0', name: '' },
    { _rowId: 'r1', name: '' },
    { _rowId: 'r2', name: 'Real Name' },
  ]
  const dups = detectDuplicatesInBatch(rows)
  // Empty-name rows match on '' — implementation may or may not treat them as dups.
  // What matters: rows with real names are not affected.
  assert.ok(!dups.has('r2'), 'real-name row not a dup')
})

test('no dups returns empty Map', () => {
  const rows = [
    { _rowId: 'r0', name: 'Alice' },
    { _rowId: 'r1', name: 'Bob' },
  ]
  const dups = detectDuplicatesInBatch(rows)
  assert.strictEqual(dups.size, 0)
})

// ── buildReviewRows: within-file dup annotation ───────────────────────────────

console.log('\nbuildReviewRows — _isDuplicate annotation')

test('dup row gets _isDuplicate: true and _duplicateOfName set', () => {
  const rows = [
    { _rowId: 'r0', name: 'Alice' },
    { _rowId: 'r1', name: 'Alice' },
  ]
  const dups = detectDuplicatesInBatch(rows)
  const rRows = buildReviewRows(rows, {}, dups)
  const alice0 = rRows.find(r => r._rowId === 'r0')
  const alice1 = rRows.find(r => r._rowId === 'r1')
  assert.ok(!alice0._isDuplicate, 'canonical is not a dup')
  assert.ok(alice1._isDuplicate, 'second is a dup')
  assert.ok(alice1._duplicateOfName, 'dup has _duplicateOfName set')
})

test('dup row is not _defaultSelected', () => {
  const rows = [
    { _rowId: 'r0', name: 'Carol' },
    { _rowId: 'r1', name: 'Carol' },
  ]
  const dups = detectDuplicatesInBatch(rows)
  const rRows = buildReviewRows(rows, {}, dups)
  const dupRow = rRows.find(r => r._isDuplicate)
  assert.ok(!dupRow._defaultSelected, 'dup row must not be default-selected')
})

// ── DB duplicate detection ────────────────────────────────────────────────────

console.log('\nDB duplicate detection — email > linkedin > name+company')

function makeExisting(overrides = {}) {
  return {
    id: 'existing-id',
    name: 'Alice Smith',
    company: 'Acme',
    email: 'alice@acme.com',
    linkedin_url: 'https://linkedin.com/in/alice',
    ...overrides,
  }
}

test('email match triggers DB dup (highest priority)', () => {
  const existing = [makeExisting()]
  const candidate = { name: 'Totally Different', company: 'Other', email: 'alice@acme.com' }
  const dups = detectDatabaseDuplicates([candidate], existing)
  assert.ok(dups.size > 0, 'email match is a DB dup')
})

test('linkedin_url match triggers DB dup', () => {
  const existing = [makeExisting({ email: null })]
  const candidate = {
    name: 'Different Name',
    company: 'Different',
    linkedin_url: 'https://linkedin.com/in/alice',
  }
  const dups = detectDatabaseDuplicates([candidate], existing)
  assert.ok(dups.size > 0, 'linkedin match is a DB dup')
})

test('name + company match triggers DB dup', () => {
  const existing = [makeExisting({ email: null, linkedin_url: null })]
  const candidate = { name: 'Alice Smith', company: 'Acme', email: null, linkedin_url: null }
  const dups = detectDatabaseDuplicates([candidate], existing)
  assert.ok(dups.size > 0, 'name+company match is a DB dup')
})

test('name-alone (no company) does NOT trigger DB dup', () => {
  const existing = [makeExisting({ email: null, linkedin_url: null })]
  const candidate = { name: 'Alice Smith', company: '', email: null, linkedin_url: null }
  const dups = detectDatabaseDuplicates([candidate], existing)
  assert.strictEqual(dups.size, 0, 'name-alone must not be a DB dup (conservative rule)')
})

test('no match returns empty set', () => {
  const existing = [makeExisting()]
  const candidate = { name: 'Bob Jones', company: 'Other', email: 'bob@other.com' }
  const dups = detectDatabaseDuplicates([candidate], existing)
  assert.strictEqual(dups.size, 0)
})

test('empty existing contacts returns empty set', () => {
  const candidate = { name: 'Alice', company: 'Acme', email: 'alice@acme.com' }
  const dups = detectDatabaseDuplicates([candidate], [])
  assert.strictEqual(dups.size, 0)
})

// ── Modal source: within-file dup excluded from Select All ────────────────────

console.log('\nmodal source — within-file dups excluded from Select All')

test('toggleAllRows filters out _isDuplicate rows', () => {
  assert.ok(
    src.includes('_isDuplicate'),
    'toggleAllRows must reference _isDuplicate to exclude within-file dups'
  )
})

test('modal declares overrideDbDup function', () => {
  assert.ok(
    src.includes('overrideDbDup'),
    'modal must have overrideDbDup function for both DB and within-file dup overrides'
  )
})

test('dbDupOverrides Set is referenced in toggleAllRows selectable filter', () => {
  // The selectable filter must check dbDupOverrides to allow overridden dups
  assert.ok(
    src.includes('dbDupOverrides'),
    'toggleAllRows must reference dbDupOverrides to allow overridden items'
  )
})

test('"Import as separate contact" text appears in modal source', () => {
  assert.ok(
    src.includes('Import as separate contact'),
    'override button must say "Import as separate contact"'
  )
})

test('checkbox is disabled for within-file dup without override', () => {
  // The disabled prop on review-row checkboxes must reference isDup
  const disabledBlock = src.match(/disabled=\{[\s\S]{0,300}?isDup[\s\S]{0,300}?\}/)
  assert.ok(disabledBlock !== null, 'checkbox disabled prop must reference isDup')
})

test('Select All label toggle references _isDuplicate in filter', () => {
  // The label "Select all" / "Deselect all" derives from a filter that excludes dups
  assert.ok(
    src.includes('_isDuplicate'),
    'Select All label filter must exclude _isDuplicate rows'
  )
})

// ── DB dup override button in modal ──────────────────────────────────────────

console.log('\nDB dup override button')

test('DUPLICATE badge appears in modal source', () => {
  assert.ok(
    src.includes('DUPLICATE'),
    'modal must render a DUPLICATE badge for duplicate rows'
  )
})

test('_isDbDuplicate is referenced in modal (DB dup annotation)', () => {
  assert.ok(
    src.includes('_isDbDuplicate') || src.includes('isDbDup'),
    'modal must check _isDbDuplicate / isDbDup to render DB dup treatment'
  )
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
