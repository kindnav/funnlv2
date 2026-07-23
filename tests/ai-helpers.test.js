// Tests for the business logic rules of ai-categorize-contacts Edge Function.
// The Edge Function runs in Deno/TypeScript and cannot be imported directly in Node.js.
// These tests duplicate the pure helper functions to verify the business rules
// independently of the runtime environment.
//
// Run with: node tests/ai-helpers.test.js

import assert from 'assert'

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

// ── Helper functions (mirrored from Edge Function) ───────────────────────────
// Must stay in sync with supabase/functions/ai-categorize-contacts/index.ts

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function isValidUuidV4(s) {
  return typeof s === 'string' && UUID_V4_RE.test(s)
}

function normalizeTag(raw) {
  if (typeof raw !== 'string') return null
  const t = raw.trim().toLowerCase()
  if (t.length === 0 || t.length > 50) return null
  return t
}

function normalizeTags(rawTags, limit) {
  const seen = new Set()
  const result = []
  for (const raw of rawTags) {
    const t = normalizeTag(raw)
    if (t && !seen.has(t)) {
      seen.add(t)
      result.push(t)
      if (result.length >= limit) break
    }
  }
  return result
}

const ALLOWED_CONFIDENCE = new Set(['high', 'medium', 'low'])
const ALLOWED_REL_TYPES  = new Set(['Mentor', 'Collaborator', 'Referral path', 'Potential employer', 'Connector', 'Other'])
const MAX_CONTACTS = 20

// Simulate the output-sanitization step from the Edge Function.
// Returns the array of accepted suggestions from a raw parsed response.
function sanitizeOutput(parsed, seenInputIds) {
  if (!Array.isArray(parsed)) return null  // invalid_shape
  const usedOutputIds = new Set()
  return parsed.flatMap(entry => {
    if (typeof entry !== 'object' || entry === null) return []
    const e = entry

    const rowId = typeof e.row_id === 'string' ? e.row_id : null
    if (!rowId || !seenInputIds.has(rowId)) return []
    if (usedOutputIds.has(rowId)) return []

    // confidence must be valid — discard whole entry if not
    if (!ALLOWED_CONFIDENCE.has(e.confidence)) return []
    const confidence = e.confidence

    const tags = normalizeTags(Array.isArray(e.suggested_tags) ? e.suggested_tags : [], 5)
    const relType = typeof e.suggested_relationship_type === 'string' &&
      ALLOWED_REL_TYPES.has(e.suggested_relationship_type)
      ? e.suggested_relationship_type
      : null

    if (tags.length === 0 && !relType) return []

    // Mark used ONLY after all validation passes (first VALID wins)
    usedOutputIds.add(rowId)
    return [{ row_id: rowId, suggested_tags: tags, suggested_relationship_type: relType, confidence }]
  })
}

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
  // variant byte must be 8, 9, a, or b
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

// ── normalizeTag ──────────────────────────────────────────────────────────────
console.log('\nnormalizeTag')

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

// ── normalizeTags ──────────────────────────────────────────────────────────────
console.log('\nnormalizeTags')

test('deduplicates case-insensitively', () => {
  const result = normalizeTags(['Recruiter', 'recruiter', 'RECRUITER'], 5)
  assert.deepStrictEqual(result, ['recruiter'])
})

test('caps at limit', () => {
  const tags = ['a', 'b', 'c', 'd', 'e', 'f']
  const result = normalizeTags(tags, 3)
  assert.deepStrictEqual(result, ['a', 'b', 'c'])
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
    // First entry: valid
    { row_id: ID_A, suggested_tags: ['recruiter'], suggested_relationship_type: null, confidence: 'high' },
    // Second entry for same ID: bad confidence — should NOT discard the first
    { row_id: ID_A, suggested_tags: ['mentor'], suggested_relationship_type: null, confidence: 'invalid_value' },
  ]
  const result = sanitizeOutput(parsed, seenInputIds)
  assert.strictEqual(result.length, 1)
  assert.deepStrictEqual(result[0].suggested_tags, ['recruiter'])
})

test('bad-confidence first entry does not block valid second entry for same ID', () => {
  // This is the Correction 1 fix: usedOutputIds.add must happen AFTER validation
  const seenInputIds = new Set([ID_A])
  const parsed = [
    // First entry: bad confidence (invalid) — should be discarded without consuming the ID
    { row_id: ID_A, suggested_tags: ['mentor'], suggested_relationship_type: null, confidence: 'INVALID' },
    // Second entry: valid — should be accepted since the ID was not yet consumed
    { row_id: ID_A, suggested_tags: ['recruiter'], suggested_relationship_type: null, confidence: 'high' },
  ]
  const result = sanitizeOutput(parsed, seenInputIds)
  assert.strictEqual(result.length, 1, 'valid second entry must be accepted after invalid first')
  assert.deepStrictEqual(result[0].suggested_tags, ['recruiter'])
})

test('entry with no tags and no relType discarded without consuming ID', () => {
  const seenInputIds = new Set([ID_A])
  const parsed = [
    // Empty suggestion: no tags, no relType — should be discarded without consuming ID
    { row_id: ID_A, suggested_tags: [], suggested_relationship_type: null, confidence: 'medium' },
    // Valid follow-up entry for same ID — must be accepted
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

// ── Batch splitting (client-side) ─────────────────────────────────────────────
console.log('\nClient-side batch splitting')

function splitBatches(contacts, batchSize) {
  const batches = []
  for (let i = 0; i < contacts.length; i += batchSize) {
    batches.push(contacts.slice(i, i + batchSize))
  }
  return batches
}

test('20 contacts → 1 batch', () => {
  const contacts = Array.from({ length: 20 }, (_, i) => ({ _rowId: `id-${i}` }))
  const batches = splitBatches(contacts, 20)
  assert.strictEqual(batches.length, 1)
  assert.strictEqual(batches[0].length, 20)
})

test('21 contacts → 2 batches (20 + 1)', () => {
  const contacts = Array.from({ length: 21 }, (_, i) => ({ _rowId: `id-${i}` }))
  const batches = splitBatches(contacts, 20)
  assert.strictEqual(batches.length, 2)
  assert.strictEqual(batches[0].length, 20)
  assert.strictEqual(batches[1].length, 1)
})

test('40 contacts → 2 batches of 20', () => {
  const contacts = Array.from({ length: 40 }, (_, i) => ({ _rowId: `id-${i}` }))
  const batches = splitBatches(contacts, 20)
  assert.strictEqual(batches.length, 2)
  assert.ok(batches.every(b => b.length === 20))
})

test('no contact omitted or duplicated in batch split', () => {
  const contacts = Array.from({ length: 45 }, (_, i) => ({ _rowId: `id-${i}` }))
  const batches = splitBatches(contacts, 20)
  const allIds = batches.flat().map(c => c._rowId)
  assert.strictEqual(allIds.length, 45)
  assert.strictEqual(new Set(allIds).size, 45, 'no duplicates')
  const originalIds = contacts.map(c => c._rowId)
  assert.deepStrictEqual(allIds, originalIds, 'order preserved')
})

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
