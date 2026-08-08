/**
 * import-review-utils.test.js
 *
 * Comprehensive tests for all pure functions in src/lib/importReviewUtils.js.
 * Zero-dependency Node.js — run with: node tests/import-review-utils.test.js
 */
import assert from 'assert'
import {
  normalizeNameForDedup,
  detectDuplicatesInBatch,
  buildReviewRows,
  computeTagSummary,
  buildImportPayload,
  computeDoneStats,
  buildDoneStatsLine,
} from '../src/lib/importReviewUtils.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

// ── normalizeNameForDedup ─────────────────────────────────────────────────────

console.log('\nnormalizeNameForDedup — name normalization\n')

test('lowercase conversion', () => {
  assert.strictEqual(normalizeNameForDedup('PRIYA SHARMA'), 'priya sharma')
})

test('trims leading/trailing whitespace', () => {
  assert.strictEqual(normalizeNameForDedup('  Priya  '), 'priya')
})

test('collapses internal whitespace', () => {
  assert.strictEqual(normalizeNameForDedup('Priya  Sharma'), 'priya sharma')
})

test('handles empty string', () => {
  assert.strictEqual(normalizeNameForDedup(''), '')
})

test('handles null gracefully (returns empty string)', () => {
  assert.strictEqual(normalizeNameForDedup(null), '')
})

test('handles undefined gracefully', () => {
  assert.strictEqual(normalizeNameForDedup(undefined), '')
})

test('handles number type', () => {
  assert.strictEqual(normalizeNameForDedup(42), '')
})

test('single name', () => {
  assert.strictEqual(normalizeNameForDedup('Priya'), 'priya')
})

test('name with mixed case and multiple spaces', () => {
  assert.strictEqual(normalizeNameForDedup('  James  Kim  '), 'james kim')
})

test('name with tabs', () => {
  assert.strictEqual(normalizeNameForDedup('James\tKim'), 'james kim')
})

// ── detectDuplicatesInBatch ───────────────────────────────────────────────────

console.log('\ndetectDuplicatesInBatch — within-batch deduplication\n')

function mkC(rowId, name) { return { _rowId: rowId, name } }

test('returns empty Map for empty array', () => {
  const result = detectDuplicatesInBatch([])
  assert.strictEqual(result.size, 0)
})

test('returns empty Map for null', () => {
  const result = detectDuplicatesInBatch(null)
  assert.strictEqual(result.size, 0)
})

test('no duplicates — all unique names', () => {
  const contacts = [mkC('a', 'Priya'), mkC('b', 'Marcus'), mkC('c', 'Dana')]
  const result = detectDuplicatesInBatch(contacts)
  assert.strictEqual(result.size, 0)
})

test('exact duplicate: second row marked as duplicate of first', () => {
  const contacts = [mkC('a', 'Priya Sharma'), mkC('b', 'Priya Sharma')]
  const result = detectDuplicatesInBatch(contacts)
  assert.strictEqual(result.size, 1)
  assert.strictEqual(result.get('b'), 'a')
  assert.ok(!result.has('a'), 'first occurrence is not a duplicate')
})

test('case-insensitive: P. Sharma vs p. sharma → duplicate', () => {
  const contacts = [mkC('a', 'Priya Sharma'), mkC('b', 'priya sharma')]
  const result = detectDuplicatesInBatch(contacts)
  assert.strictEqual(result.size, 1)
  assert.strictEqual(result.get('b'), 'a')
})

test('whitespace normalization: extra spaces same name → duplicate', () => {
  const contacts = [mkC('a', 'Priya Sharma'), mkC('b', 'Priya  Sharma')]
  const result = detectDuplicatesInBatch(contacts)
  assert.strictEqual(result.size, 1)
})

test('missing-name rows are not counted as duplicates of each other', () => {
  const contacts = [mkC('a', ''), mkC('b', ''), mkC('c', '')]
  const result = detectDuplicatesInBatch(contacts)
  assert.strictEqual(result.size, 0, 'empty names must not be deduped')
})

test('null name handled safely', () => {
  const contacts = [mkC('a', null), mkC('b', null)]
  const result = detectDuplicatesInBatch(contacts)
  assert.strictEqual(result.size, 0)
})

test('three occurrences: first canonical, second and third are duplicates', () => {
  const contacts = [mkC('a', 'Alice'), mkC('b', 'Alice'), mkC('c', 'Alice')]
  const result = detectDuplicatesInBatch(contacts)
  assert.strictEqual(result.size, 2)
  assert.strictEqual(result.get('b'), 'a')
  assert.strictEqual(result.get('c'), 'a')
})

test('mixed duplicates and unique: only duplicates returned', () => {
  const contacts = [mkC('a', 'Alice'), mkC('b', 'Bob'), mkC('c', 'Alice'), mkC('d', 'Carol')]
  const result = detectDuplicatesInBatch(contacts)
  assert.strictEqual(result.size, 1)
  assert.strictEqual(result.get('c'), 'a')
})

// ── buildReviewRows ───────────────────────────────────────────────────────────

console.log('\nbuildReviewRows — row annotation\n')

function mkContact(rowId, name, extra = {}) {
  return { _rowId: rowId, name, ...extra }
}

test('returns [] for non-array input', () => {
  assert.deepStrictEqual(buildReviewRows(null), [])
})

test('valid contact has _defaultSelected = true', () => {
  const rows = buildReviewRows([mkContact('a', 'Alice')])
  assert.strictEqual(rows[0]._defaultSelected, true)
  assert.strictEqual(rows[0]._isMissingName, false)
  assert.strictEqual(rows[0]._isDuplicate, false)
})

test('missing-name row: _isMissingName=true, _defaultSelected=false', () => {
  const rows = buildReviewRows([mkContact('a', '')])
  assert.strictEqual(rows[0]._isMissingName, true)
  assert.strictEqual(rows[0]._defaultSelected, false)
})

test('null name row: _isMissingName=true', () => {
  const rows = buildReviewRows([mkContact('a', null)])
  assert.strictEqual(rows[0]._isMissingName, true)
})

test('duplicate row: _isDuplicate=true, _defaultSelected=false', () => {
  const contacts = [mkContact('a', 'Alice'), mkContact('b', 'Alice')]
  const dupsMap = new Map([['b', 'a']])
  const rows = buildReviewRows(contacts, {}, dupsMap)
  assert.strictEqual(rows[1]._isDuplicate, true)
  assert.strictEqual(rows[1]._defaultSelected, false)
})

test('duplicate row carries _duplicateOfName from canonical row', () => {
  const contacts = [mkContact('a', 'Alice Lam'), mkContact('b', 'Alice Lam')]
  const dupsMap = new Map([['b', 'a']])
  const rows = buildReviewRows(contacts, {}, dupsMap)
  assert.strictEqual(rows[1]._duplicateOfName, 'Alice Lam')
})

test('canonical row not marked as duplicate', () => {
  const contacts = [mkContact('a', 'Alice'), mkContact('b', 'Alice')]
  const dupsMap = new Map([['b', 'a']])
  const rows = buildReviewRows(contacts, {}, dupsMap)
  assert.strictEqual(rows[0]._isDuplicate, false)
  assert.strictEqual(rows[0]._defaultSelected, true)
})

test('AI suggestion is attached when present', () => {
  const contacts = [mkContact('a', 'Alice')]
  const sug = { row_id: 'a', suggested_tags: ['recruiter'], suggested_relationship_type: 'Mentor', confidence: 'high' }
  const rows = buildReviewRows(contacts, { a: sug })
  assert.deepStrictEqual(rows[0]._suggestion, sug)
})

test('no suggestion: _suggestion is null', () => {
  const rows = buildReviewRows([mkContact('a', 'Alice')], {})
  assert.strictEqual(rows[0]._suggestion, null)
})

test('source contact fields are preserved', () => {
  const c = mkContact('a', 'Alice', { company: 'ACME', role: 'PM', tags: ['alumni'] })
  const rows = buildReviewRows([c])
  assert.strictEqual(rows[0].company, 'ACME')
  assert.strictEqual(rows[0].role, 'PM')
  assert.deepStrictEqual(rows[0].tags, ['alumni'])
})

test('does not mutate original contacts array', () => {
  const original = [mkContact('a', 'Alice')]
  buildReviewRows(original, {}, new Map())
  assert.strictEqual(original[0]._isMissingName, undefined)
})

test('empty suggestionsMap defaults gracefully', () => {
  const rows = buildReviewRows([mkContact('a', 'Alice')])
  assert.strictEqual(rows[0]._suggestion, null)
})

// ── computeTagSummary ─────────────────────────────────────────────────────────

console.log('\ncomputeTagSummary — tag aggregation\n')

function mkReviewRow(rowId, name, sugTags = null, confidence = 'high') {
  return {
    _rowId: rowId, name,
    _suggestion: sugTags ? { suggested_tags: sugTags, confidence } : null,
  }
}

test('returns [] for non-array input', () => {
  assert.deepStrictEqual(computeTagSummary(null), [])
})

test('returns [] when no rows have suggestions', () => {
  const rows = [{ _rowId: 'a', name: 'Alice', _suggestion: null }]
  assert.deepStrictEqual(computeTagSummary(rows), [])
})

test('single tag, single row, high confidence', () => {
  const rows = [mkReviewRow('a', 'Alice', ['recruiter'], 'high')]
  const summary = computeTagSummary(rows)
  assert.strictEqual(summary.length, 1)
  assert.strictEqual(summary[0].tag, 'recruiter')
  assert.strictEqual(summary[0].count, 1)
  assert.strictEqual(summary[0].confidence, 'high')
  assert.strictEqual(summary[0].highCount, 1)
})

test('same tag from two rows: count = 2', () => {
  const rows = [
    mkReviewRow('a', 'Alice', ['recruiter'], 'high'),
    mkReviewRow('b', 'Bob', ['recruiter'], 'high'),
  ]
  const summary = computeTagSummary(rows)
  assert.strictEqual(summary[0].tag, 'recruiter')
  assert.strictEqual(summary[0].count, 2)
})

test('different tags: sorted by count descending', () => {
  const rows = [
    mkReviewRow('a', 'Alice', ['recruiter', 'alumni'], 'high'),
    mkReviewRow('b', 'Bob', ['recruiter'], 'high'),
    mkReviewRow('c', 'Carol', ['target firm'], 'high'),
  ]
  const summary = computeTagSummary(rows)
  assert.strictEqual(summary[0].tag, 'recruiter') // count 2
  assert.strictEqual(summary[1].tag, 'alumni')    // count 1 (alpha: alumni < target firm)
})

test('medium confidence tag: confidence = medium when no high', () => {
  const rows = [mkReviewRow('a', 'Alice', ['target firm'], 'medium')]
  const summary = computeTagSummary(rows)
  assert.strictEqual(summary[0].confidence, 'medium')
  assert.strictEqual(summary[0].mediumCount, 1)
  assert.strictEqual(summary[0].highCount, 0)
})

test('same tag from high and medium: confidence wins high', () => {
  const rows = [
    mkReviewRow('a', 'Alice', ['recruiter'], 'high'),
    mkReviewRow('b', 'Bob', ['recruiter'], 'medium'),
  ]
  const summary = computeTagSummary(rows)
  assert.strictEqual(summary[0].confidence, 'high')
  assert.strictEqual(summary[0].highCount, 1)
  assert.strictEqual(summary[0].mediumCount, 1)
})

test('tag normalization: deduplicated case-insensitively', () => {
  const rows = [
    mkReviewRow('a', 'Alice', ['Recruiter'], 'high'),
    mkReviewRow('b', 'Bob', ['recruiter'], 'high'),
  ]
  const summary = computeTagSummary(rows)
  assert.strictEqual(summary.length, 1)
  assert.strictEqual(summary[0].count, 2)
})

test('empty suggested_tags array: no entries added', () => {
  const rows = [mkReviewRow('a', 'Alice', [], 'high')]
  assert.deepStrictEqual(computeTagSummary(rows), [])
})

test('blank tag string is excluded', () => {
  const rows = [mkReviewRow('a', 'Alice', ['', '  '], 'high')]
  assert.deepStrictEqual(computeTagSummary(rows), [])
})

test('rows with null _suggestion are skipped', () => {
  const rows = [
    { _rowId: 'a', _suggestion: null },
    mkReviewRow('b', 'Bob', ['alumni'], 'high'),
  ]
  const summary = computeTagSummary(rows)
  assert.strictEqual(summary.length, 1)
  assert.strictEqual(summary[0].tag, 'alumni')
})

test('alphabetical sort as tiebreaker', () => {
  const rows = [
    mkReviewRow('a', 'Alice', ['zebra'], 'high'),
    mkReviewRow('b', 'Bob', ['apple'], 'high'),
  ]
  const summary = computeTagSummary(rows)
  assert.strictEqual(summary[0].tag, 'apple') // alphabetically first when count equal
  assert.strictEqual(summary[1].tag, 'zebra')
})

// ── buildImportPayload ────────────────────────────────────────────────────────

console.log('\nbuildImportPayload — payload construction\n')

function mkReview(rowId, name, opts = {}) {
  return {
    _rowId: rowId,
    name,
    _isMissingName: !name,
    _isDuplicate: opts.isDuplicate || false,
    _duplicateOfName: opts.duplicateOfName || '',
    _suggestion: opts.suggestion || null,
    _defaultSelected: !opts.isDuplicate && !!name,
    company: opts.company || null,
    tags: opts.tags || undefined,
    relationship_type: opts.relationship_type || undefined,
  }
}

test('returns [] for non-array reviewRows', () => {
  assert.deepStrictEqual(buildImportPayload(null, new Set(), 'u1'), [])
})

test('returns [] when selectedIds is not a Set', () => {
  const rows = [mkReview('a', 'Alice')]
  assert.deepStrictEqual(buildImportPayload(rows, [], 'u1'), [])
})

test('returns [] when userId is not a string', () => {
  const rows = [mkReview('a', 'Alice')]
  assert.deepStrictEqual(buildImportPayload(rows, new Set(['a']), null), [])
})

test('selected row is included in payload', () => {
  const rows = [mkReview('a', 'Alice')]
  const result = buildImportPayload(rows, new Set(['a']), 'user-1')
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].name, 'Alice')
})

test('unselected row is excluded', () => {
  const rows = [mkReview('a', 'Alice'), mkReview('b', 'Bob')]
  const result = buildImportPayload(rows, new Set(['a']), 'user-1')
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].name, 'Alice')
})

test('user_id is added to every row', () => {
  const rows = [mkReview('a', 'Alice')]
  const result = buildImportPayload(rows, new Set(['a']), 'user-xyz')
  assert.strictEqual(result[0].user_id, 'user-xyz')
})

test('_* fields are stripped from payload', () => {
  const rows = [mkReview('a', 'Alice')]
  const result = buildImportPayload(rows, new Set(['a']), 'user-1')
  const keys = Object.keys(result[0])
  assert.ok(!keys.some(k => k.startsWith('_')), 'internal _* fields must be stripped')
})

test('row with missing name is excluded even if in selectedIds (safety guard)', () => {
  const rows = [mkReview('a', '')]
  const result = buildImportPayload(rows, new Set(['a']), 'user-1')
  assert.strictEqual(result.length, 0)
})

test('high-confidence AI tags are merged onto payload', () => {
  const sug = { suggested_tags: ['recruiter'], suggested_relationship_type: null, confidence: 'high' }
  const rows = [mkReview('a', 'Alice', { suggestion: sug })]
  const result = buildImportPayload(rows, new Set(['a']), 'user-1')
  assert.ok(Array.isArray(result[0].tags))
  assert.ok(result[0].tags.includes('recruiter'))
})

test('AI tags deduplicated with existing CSV tags', () => {
  const sug = { suggested_tags: ['recruiter', 'alumni'], confidence: 'high' }
  const rows = [mkReview('a', 'Alice', { tags: ['recruiter'], suggestion: sug })]
  const result = buildImportPayload(rows, new Set(['a']), 'user-1')
  const times = result[0].tags.filter(t => t === 'recruiter').length
  assert.strictEqual(times, 1, 'recruiter must appear only once')
  assert.ok(result[0].tags.includes('alumni'))
})

test('high-confidence relationship_type set when contact has none', () => {
  const sug = { suggested_tags: [], suggested_relationship_type: 'Mentor', confidence: 'high' }
  const rows = [mkReview('a', 'Alice', { suggestion: sug })]
  const result = buildImportPayload(rows, new Set(['a']), 'user-1')
  assert.strictEqual(result[0].relationship_type, 'Mentor')
})

test('AI relationship_type does not overwrite existing CSV value', () => {
  const sug = { suggested_tags: [], suggested_relationship_type: 'Mentor', confidence: 'high' }
  const rows = [mkReview('a', 'Alice', { suggestion: sug, relationship_type: 'Collaborator' })]
  const result = buildImportPayload(rows, new Set(['a']), 'user-1')
  assert.strictEqual(result[0].relationship_type, 'Collaborator')
})

test('medium-confidence suggestion: tags NOT applied', () => {
  const sug = { suggested_tags: ['recruiter'], confidence: 'medium' }
  const rows = [mkReview('a', 'Alice', { suggestion: sug })]
  const result = buildImportPayload(rows, new Set(['a']), 'user-1')
  // medium confidence → not auto-applied
  assert.ok(!result[0].tags || !result[0].tags.includes('recruiter'))
})

test('empty selectedIds → empty result', () => {
  const rows = [mkReview('a', 'Alice'), mkReview('b', 'Bob')]
  const result = buildImportPayload(rows, new Set(), 'user-1')
  assert.strictEqual(result.length, 0)
})

// ── computeDoneStats ──────────────────────────────────────────────────────────

console.log('\ncomputeDoneStats — done screen stats\n')

test('returns zeros for non-array input', () => {
  const stats = computeDoneStats(null, 5)
  assert.strictEqual(stats.importedCount, 0)
  assert.strictEqual(stats.duplicatesSkipped, 0)
  assert.strictEqual(stats.missingNameCount, 0)
})

test('importedCount matches passed value', () => {
  const stats = computeDoneStats([], 7)
  assert.strictEqual(stats.importedCount, 7)
})

test('counts duplicates correctly', () => {
  const rows = [
    { _isDuplicate: true, _isMissingName: false },
    { _isDuplicate: true, _isMissingName: false },
    { _isDuplicate: false, _isMissingName: false },
  ]
  const stats = computeDoneStats(rows, 1)
  assert.strictEqual(stats.duplicatesSkipped, 2)
})

test('counts missing-name rows correctly', () => {
  const rows = [
    { _isDuplicate: false, _isMissingName: true },
    { _isDuplicate: false, _isMissingName: false },
  ]
  const stats = computeDoneStats(rows, 1)
  assert.strictEqual(stats.missingNameCount, 1)
})

test('both flags can be present on different rows', () => {
  const rows = [
    { _isDuplicate: true, _isMissingName: false },
    { _isDuplicate: false, _isMissingName: true },
  ]
  const stats = computeDoneStats(rows, 0)
  assert.strictEqual(stats.duplicatesSkipped, 1)
  assert.strictEqual(stats.missingNameCount, 1)
})

test('zero problems: all zeros', () => {
  const rows = Array.from({ length: 10 }, () => ({ _isDuplicate: false, _isMissingName: false }))
  const stats = computeDoneStats(rows, 10)
  assert.strictEqual(stats.duplicatesSkipped, 0)
  assert.strictEqual(stats.missingNameCount, 0)
  assert.strictEqual(stats.importedCount, 10)
})

test('importedCount 0 when not provided', () => {
  const stats = computeDoneStats([], undefined)
  assert.strictEqual(stats.importedCount, 0)
})

// ── buildDoneStatsLine ────────────────────────────────────────────────────────

console.log('\nbuildDoneStatsLine — stats line text\n')

test('empty inputs produce empty string', () => {
  assert.strictEqual(buildDoneStatsLine([], { duplicatesSkipped: 0, missingNameCount: 0 }), '')
})

test('single top tag', () => {
  const tagSummary = [{ tag: 'recruiter', count: 12 }]
  const line = buildDoneStatsLine(tagSummary, { duplicatesSkipped: 0, missingNameCount: 0 })
  assert.ok(line.includes('12 tagged recruiter'))
})

test('two top tags joined with ·', () => {
  const tagSummary = [{ tag: 'recruiter', count: 12 }, { tag: 'alumni', count: 8 }]
  const line = buildDoneStatsLine(tagSummary, { duplicatesSkipped: 0, missingNameCount: 0 })
  assert.ok(line.includes('12 tagged recruiter'))
  assert.ok(line.includes('8 tagged alumni'))
  assert.ok(line.includes(' · '))
})

test('only top 2 tags shown (third ignored)', () => {
  const tagSummary = [
    { tag: 'recruiter', count: 12 },
    { tag: 'alumni', count: 8 },
    { tag: 'mentor', count: 3 },
  ]
  const line = buildDoneStatsLine(tagSummary, { duplicatesSkipped: 0, missingNameCount: 0 })
  assert.ok(!line.includes('mentor'))
})

test('duplicatesSkipped included when > 0', () => {
  const line = buildDoneStatsLine([], { duplicatesSkipped: 2, missingNameCount: 0 })
  assert.ok(line.includes('2 duplicates skipped'))
})

test('singular duplicate', () => {
  const line = buildDoneStatsLine([], { duplicatesSkipped: 1, missingNameCount: 0 })
  assert.ok(line.includes('1 duplicate skipped'))
  assert.ok(!line.includes('duplicates'))
})

test('missingNameCount included when > 0', () => {
  const line = buildDoneStatsLine([], { duplicatesSkipped: 0, missingNameCount: 1 })
  assert.ok(line.includes('1 row needs a name'))
})

test('plural missing name', () => {
  const line = buildDoneStatsLine([], { duplicatesSkipped: 0, missingNameCount: 3 })
  assert.ok(line.includes('3 rows need a name'))
})

test('full stats line: tags + duplicates + missing name', () => {
  const tagSummary = [{ tag: 'recruiter', count: 12 }, { tag: 'alumni', count: 8 }]
  const stats = { duplicatesSkipped: 2, missingNameCount: 1 }
  const line = buildDoneStatsLine(tagSummary, stats)
  assert.ok(line.includes('12 tagged recruiter'))
  assert.ok(line.includes('8 tagged alumni'))
  assert.ok(line.includes('2 duplicates skipped'))
  assert.ok(line.includes('1 row needs a name'))
})

test('null tagSummary does not throw', () => {
  assert.doesNotThrow(() => buildDoneStatsLine(null, { duplicatesSkipped: 0, missingNameCount: 0 }))
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
