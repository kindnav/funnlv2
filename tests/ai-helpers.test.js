// Tests for AI categorization business logic.
// Imports directly from production modules — no copied implementations.
//
// Run with: node tests/ai-helpers.test.js

import assert from 'assert'
import {
  UUID_V4_RE, MAX_CONTACTS, ALLOWED_CONFIDENCE, ALLOWED_REL_TYPES,
  normalizeTag, normalizeTags, sanitizeOutput,
} from '../supabase/functions/shared/categorization-helpers.js'
import {
  normalizeContactTag, mergeContactTags, splitContactBatches,
} from '../src/lib/contactCategorization.js'

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

function isValidUuidV4(s) { return typeof s === 'string' && UUID_V4_RE.test(s) }

// ── UUID v4 validation ────────────────────────────────────────────────────────
console.log('\nUUID v4 validation')

test('valid v4 UUIDs accepted', () => {
  assert.strictEqual(isValidUuidV4('f47ac10b-58cc-4372-a567-0e02b2c3d479'), true)
  assert.strictEqual(isValidUuidV4('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('v1 UUID (version digit 1) rejected', () => {
  assert.strictEqual(isValidUuidV4('550e8400-e29b-11d4-a716-446655440000'), false)
})

test('v4 UUID with uppercase rejected', () => {
  assert.strictEqual(isValidUuidV4('F47AC10B-58CC-4372-A567-0E02B2C3D479'), false)
})

test('UUID with wrong version digit (3) rejected', () => {
  assert.strictEqual(isValidUuidV4('f47ac10b-58cc-3372-a567-0e02b2c3d479'), false)
})

test('UUID with wrong variant byte rejected', () => {
  assert.strictEqual(isValidUuidV4('f47ac10b-58cc-4372-1567-0e02b2c3d479'), false)
})

test('empty string rejected', () => {
  assert.strictEqual(isValidUuidV4(''), false)
})

test('null rejected', () => {
  assert.strictEqual(isValidUuidV4(null), false)
})

test('truncated UUID rejected', () => {
  assert.strictEqual(isValidUuidV4('f47ac10b-58cc-4372-a567'), false)
})

// ── normalizeTag (shared categorization-helpers module) ───────────────────────
console.log('\nnormalizeTag (shared module)')

test('trims and lowercases', () => {
  assert.strictEqual(normalizeTag('  Recruiter  '), 'recruiter')
})

test('returns null for non-string', () => {
  assert.strictEqual(normalizeTag(123), null)
  assert.strictEqual(normalizeTag(null), null)
  assert.strictEqual(normalizeTag(undefined), null)
})

test('returns null for empty string after trim', () => {
  assert.strictEqual(normalizeTag('   '), null)
  assert.strictEqual(normalizeTag(''), null)
})

test('returns null for string > 50 chars', () => {
  assert.strictEqual(normalizeTag('a'.repeat(51)), null)
})

test('accepts exactly 50 chars', () => {
  const s = 'a'.repeat(50)
  assert.strictEqual(normalizeTag(s), s)
})

// ── normalizeTags (shared module — AI output, capped at limit) ─────────────────
console.log('\nnormalizeTags (shared module — AI suggestions capped at limit)')

test('deduplicates case-insensitively', () => {
  const result = normalizeTags(['Recruiter', 'recruiter', 'RECRUITER'], 5)
  assert.deepStrictEqual(result, ['recruiter'])
})

test('caps at limit (AI per-contact suggestion cap)', () => {
  const tags = ['a', 'b', 'c', 'd', 'e', 'f']
  const result = normalizeTags(tags, 5)
  assert.deepStrictEqual(result, ['a', 'b', 'c', 'd', 'e'])
})

test('skips invalid entries but keeps valid ones', () => {
  const result = normalizeTags([null, 'mentor', 123, 'alumni'], 5)
  assert.deepStrictEqual(result, ['mentor', 'alumni'])
})

test('rejects tag > 50 chars', () => {
  const result = normalizeTags(['a'.repeat(51), 'ok'], 5)
  assert.deepStrictEqual(result, ['ok'])
})

// ── Output sanitization — first valid wins ────────────────────────────────────
console.log('\nOutput sanitization / first-valid-wins')

const ID_A = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const ID_B = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'

test('first valid suggestion for an ID wins when second has bad confidence', () => {
  const seenInputIds = new Set([ID_A])
  const parsed = [
    { row_id: ID_A, suggested_tags: ['recruiter'], suggested_relationship_type: null, confidence: 'high' },
    { row_id: ID_A, suggested_tags: ['mentor'], suggested_relationship_type: null, confidence: 'invalid_value' },
  ]
  const result = sanitizeOutput(parsed, seenInputIds)
  assert.strictEqual(result.length, 1)
  assert.deepStrictEqual(result[0].suggested_tags, ['recruiter'])
})

test('bad-confidence first entry does not block valid second entry for same ID', () => {
  const seenInputIds = new Set([ID_A])
  const parsed = [
    { row_id: ID_A, suggested_tags: ['mentor'], suggested_relationship_type: null, confidence: 'INVALID' },
    { row_id: ID_A, suggested_tags: ['recruiter'], suggested_relationship_type: null, confidence: 'high' },
  ]
  const result = sanitizeOutput(parsed, seenInputIds)
  assert.strictEqual(result.length, 1, 'valid second entry must be accepted after invalid first')
  assert.deepStrictEqual(result[0].suggested_tags, ['recruiter'])
})

test('entry with no tags and no relType discarded without consuming ID', () => {
  const seenInputIds = new Set([ID_A])
  const parsed = [
    { row_id: ID_A, suggested_tags: [], suggested_relationship_type: null, confidence: 'medium' },
    { row_id: ID_A, suggested_tags: ['alumni'], suggested_relationship_type: null, confidence: 'low' },
  ]
  const result = sanitizeOutput(parsed, seenInputIds)
  assert.strictEqual(result.length, 1)
  assert.deepStrictEqual(result[0].suggested_tags, ['alumni'])
})

test('unknown row_id rejected', () => {
  const seenInputIds = new Set([ID_A])
  const parsed = [
    { row_id: ID_B, suggested_tags: ['recruiter'], suggested_relationship_type: null, confidence: 'high' },
  ]
  const result = sanitizeOutput(parsed, seenInputIds)
  assert.strictEqual(result.length, 0)
})

test('duplicate valid entries: first wins, second discarded', () => {
  const seenInputIds = new Set([ID_A])
  const parsed = [
    { row_id: ID_A, suggested_tags: ['recruiter'], suggested_relationship_type: null, confidence: 'high' },
    { row_id: ID_A, suggested_tags: ['mentor'],    suggested_relationship_type: null, confidence: 'medium' },
  ]
  const result = sanitizeOutput(parsed, seenInputIds)
  assert.strictEqual(result.length, 1)
  assert.deepStrictEqual(result[0].suggested_tags, ['recruiter'])
})

test('sanitizeOutput returns null for non-array input', () => {
  assert.strictEqual(sanitizeOutput('not an array', new Set()), null)
  assert.strictEqual(sanitizeOutput(null, new Set()), null)
  assert.strictEqual(sanitizeOutput({}, new Set()), null)
})

// ── Confidence validation ─────────────────────────────────────────────────────
console.log('\nConfidence validation')

test('high / medium / low accepted', () => {
  for (const c of ['high', 'medium', 'low']) {
    assert.strictEqual(ALLOWED_CONFIDENCE.has(c), true)
  }
})

test('uppercase / misspelled / missing rejected', () => {
  for (const c of ['High', 'HIGH', 'MEDIUM', '', null, undefined, 'unknown']) {
    assert.strictEqual(ALLOWED_CONFIDENCE.has(c), false)
  }
})

// ── RelType validation ────────────────────────────────────────────────────────
console.log('\nRelType validation')

test('all valid rel types accepted', () => {
  const valid = ['Mentor', 'Collaborator', 'Referral path', 'Potential employer', 'Connector', 'Other']
  for (const r of valid) assert.strictEqual(ALLOWED_REL_TYPES.has(r), true)
})

test('lowercase / unknown / empty relType rejected', () => {
  for (const r of ['mentor', 'recruiter', '', null]) {
    assert.strictEqual(ALLOWED_REL_TYPES.has(r), false)
  }
})

// ── Max batch size ────────────────────────────────────────────────────────────
console.log('\nMax batch size')

test('MAX_CONTACTS is 20', () => {
  assert.strictEqual(MAX_CONTACTS, 20)
})

// ── splitContactBatches (production module) ───────────────────────────────────
console.log('\nClient-side batch splitting (production splitContactBatches)')

test('20 contacts → 1 batch', () => {
  const contacts = Array.from({ length: 20 }, (_, i) => ({ _rowId: `id-${i}` }))
  const batches = splitContactBatches(contacts, 20)
  assert.strictEqual(batches.length, 1)
  assert.strictEqual(batches[0].length, 20)
})

test('21 contacts → 2 batches (20 + 1)', () => {
  const contacts = Array.from({ length: 21 }, (_, i) => ({ _rowId: `id-${i}` }))
  const batches = splitContactBatches(contacts, 20)
  assert.strictEqual(batches.length, 2)
  assert.strictEqual(batches[0].length, 20)
  assert.strictEqual(batches[1].length, 1)
})

test('40 contacts → 2 batches of 20', () => {
  const contacts = Array.from({ length: 40 }, (_, i) => ({ _rowId: `id-${i}` }))
  const batches = splitContactBatches(contacts, 20)
  assert.strictEqual(batches.length, 2)
  assert.ok(batches.every(b => b.length === 20))
})

test('no contact omitted or duplicated in batch split', () => {
  const contacts = Array.from({ length: 45 }, (_, i) => ({ _rowId: `id-${i}` }))
  const batches = splitContactBatches(contacts, 20)
  const allIds = batches.flat().map(c => c._rowId)
  assert.strictEqual(allIds.length, 45)
  assert.strictEqual(new Set(allIds).size, 45, 'no duplicates')
  const originalIds = contacts.map(c => c._rowId)
  assert.deepStrictEqual(allIds, originalIds, 'order preserved')
})

// ── normalizeContactTag (production contactCategorization module) ──────────────
console.log('\nnormalizeContactTag (production module)')

test('trims and lowercases', () => {
  assert.strictEqual(normalizeContactTag('  Alumni  '), 'alumni')
})

test('returns null for non-string', () => {
  assert.strictEqual(normalizeContactTag(42), null)
  assert.strictEqual(normalizeContactTag(null), null)
  assert.strictEqual(normalizeContactTag(undefined), null)
})

test('returns null for empty or whitespace-only string', () => {
  assert.strictEqual(normalizeContactTag(''), null)
  assert.strictEqual(normalizeContactTag('   '), null)
})

test('returns null for string longer than 50 chars', () => {
  assert.strictEqual(normalizeContactTag('x'.repeat(51)), null)
})

test('accepts exactly 50 chars', () => {
  const s = 'b'.repeat(50)
  assert.strictEqual(normalizeContactTag(s), s)
})

// ── mergeContactTags (production contactCategorization module) ─────────────────
console.log('\nmergeContactTags (production module)')

test('CSV tags are preserved in output', () => {
  const result = mergeContactTags(['recruiter', 'alumni'], [], [], [])
  assert.deepStrictEqual(result, ['recruiter', 'alumni'])
})

test('more than 5 total tags are allowed', () => {
  const csv = ['a', 'b', 'c']
  const ai  = ['d', 'e', 'f']
  const custom = ['g']
  const result = mergeContactTags(csv, [], ai, custom)
  assert.strictEqual(result.length, 7, 'all 7 tags must be retained — no total cap')
})

test('CSV + AI + custom tags merge correctly', () => {
  const result = mergeContactTags(['recruiter'], [], ['alumni'], ['target firm'])
  assert.deepStrictEqual(result, ['recruiter', 'alumni', 'target firm'])
})

test('case-insensitive duplicates are removed', () => {
  const result = mergeContactTags(['Recruiter'], [], ['recruiter'], ['RECRUITER'])
  assert.deepStrictEqual(result, ['recruiter'])
})

test('source priority: CSV before AI before custom', () => {
  // Same value appears in AI and CSV — CSV (first) wins position
  const result = mergeContactTags(['alumni'], [], ['alumni', 'mentor'], ['connector'])
  assert.deepStrictEqual(result, ['alumni', 'mentor', 'connector'])
})

test('empty string tags are removed', () => {
  const result = mergeContactTags(['', '  ', 'recruiter'], [], [], [])
  assert.deepStrictEqual(result, ['recruiter'])
})

test('tags longer than 50 chars are silently dropped', () => {
  const long = 'x'.repeat(51)
  const result = mergeContactTags([long, 'ok'], [], [], [])
  assert.deepStrictEqual(result, ['ok'])
})

test('no valid CSV or manual tags are truncated (unlimited storage)', () => {
  const csv = Array.from({ length: 10 }, (_, i) => `tag${i}`)
  const custom = Array.from({ length: 5 }, (_, i) => `custom${i}`)
  const result = mergeContactTags(csv, [], [], custom)
  assert.strictEqual(result.length, 15, 'all 15 unique tags must be retained')
})

test('returns empty array when all inputs are empty', () => {
  assert.deepStrictEqual(mergeContactTags([], [], [], []), [])
})

test('non-string entries in any source are silently dropped', () => {
  const result = mergeContactTags([null, 'recruiter', 42, 'alumni'], [], [undefined], [])
  assert.deepStrictEqual(result, ['recruiter', 'alumni'])
})

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
