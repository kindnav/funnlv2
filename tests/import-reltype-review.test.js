/**
 * import-reltype-review.test.js
 *
 * Verifies the full relationship-type suggestion review state machine:
 * PENDING / ACCEPTED / REJECTED / EDITED
 * Validates changeRelTypeSuggestion against the RELATIONSHIP_TYPE_VALUES enum.
 * Verifies getFinalRelType output for all states.
 * Verifies CSV value always wins over AI suggestion.
 *
 * No React, no DOM, no Supabase.
 *
 * Run with: node tests/import-reltype-review.test.js
 */
import assert from 'assert'
import {
  SUGGESTION_STATES,
  RELATIONSHIP_TYPE_VALUES,
  initSuggestionReview,
  acceptRelTypeSuggestion,
  rejectRelTypeSuggestion,
  changeRelTypeSuggestion,
  editRelTypeSuggestion,
  getFinalRelType,
} from '../src/lib/importSuggestionReview.js'

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

const { PENDING, ACCEPTED, REJECTED, EDITED } = SUGGESTION_STATES

function makeState(rowId, relType, confidence = 'medium', csvRelType = null) {
  return initSuggestionReview([{
    _rowId:            rowId,
    relationship_type: csvRelType,
    _suggestion: {
      suggested_tags:              [],
      suggested_relationship_type: relType,
      confidence,
    },
  }], undefined)
}

function makeHighState(rowId, relType) {
  return makeState(rowId, relType, 'high')
}

// ── Enum completeness ─────────────────────────────────────────────────────────

console.log('\nRELATIONSHIP_TYPE_VALUES enum')

test('contains exactly 6 values', () => {
  assert.strictEqual(RELATIONSHIP_TYPE_VALUES.length, 6)
})

test('contains Mentor', () => {
  assert.ok(RELATIONSHIP_TYPE_VALUES.includes('Mentor'))
})

test('contains Collaborator', () => {
  assert.ok(RELATIONSHIP_TYPE_VALUES.includes('Collaborator'))
})

test('contains Referral path', () => {
  assert.ok(RELATIONSHIP_TYPE_VALUES.includes('Referral path'))
})

test('contains Potential employer', () => {
  assert.ok(RELATIONSHIP_TYPE_VALUES.includes('Potential employer'))
})

test('contains Connector', () => {
  assert.ok(RELATIONSHIP_TYPE_VALUES.includes('Connector'))
})

test('contains Other', () => {
  assert.ok(RELATIONSHIP_TYPE_VALUES.includes('Other'))
})

// ── Initial states ────────────────────────────────────────────────────────────

console.log('\ninitial relType states')

test('medium confidence → PENDING', () => {
  const s = makeState('r1', 'Mentor', 'medium')
  assert.strictEqual(s.get('r1').relType.state, PENDING)
})

test('high confidence → ACCEPTED', () => {
  const s = makeHighState('r2', 'Connector')
  assert.strictEqual(s.get('r2').relType.state, ACCEPTED)
})

test('relType is null when no suggestion', () => {
  const s = initSuggestionReview([{ _rowId: 'r3', relationship_type: null, _suggestion: null }], undefined)
  assert.strictEqual(s.get('r3').relType, null)
})

test('relType is null when CSV already has relationship_type', () => {
  const s = makeState('r4', 'Mentor', 'high', 'Collaborator')  // CSV wins — AI suggestion suppressed
  assert.strictEqual(s.get('r4').relType, null,
    'AI suggestion suppressed when CSV already has a value')
})

test('relType ID is rowId:reltype', () => {
  const s = makeState('r5', 'Mentor')
  assert.strictEqual(s.get('r5').relType.id, 'r5:reltype')
})

// ── PENDING → ACCEPTED ────────────────────────────────────────────────────────

console.log('\nPENDING → ACCEPTED')

test('acceptRelTypeSuggestion transitions PENDING → ACCEPTED', () => {
  let s = makeState('a1', 'Mentor')
  s = acceptRelTypeSuggestion(s, 'a1')
  assert.strictEqual(s.get('a1').relType.state, ACCEPTED)
})

test('getFinalRelType returns value when ACCEPTED', () => {
  let s = makeState('a2', 'Connector')
  s = acceptRelTypeSuggestion(s, 'a2')
  assert.strictEqual(getFinalRelType(null, s.get('a2')), 'Connector')
})

// ── PENDING → REJECTED ────────────────────────────────────────────────────────

console.log('\nPENDING → REJECTED')

test('rejectRelTypeSuggestion transitions PENDING → REJECTED', () => {
  let s = makeState('rj1', 'Other')
  s = rejectRelTypeSuggestion(s, 'rj1')
  assert.strictEqual(s.get('rj1').relType.state, REJECTED)
})

test('getFinalRelType returns undefined when REJECTED', () => {
  let s = makeState('rj2', 'Mentor')
  s = rejectRelTypeSuggestion(s, 'rj2')
  assert.strictEqual(getFinalRelType(null, s.get('rj2')), undefined)
})

// ── ACCEPTED → REJECTED ───────────────────────────────────────────────────────

console.log('\nACCEPTED → REJECTED')

test('rejectRelTypeSuggestion on ACCEPTED → REJECTED', () => {
  let s = makeHighState('ar1', 'Mentor')  // starts ACCEPTED
  s = rejectRelTypeSuggestion(s, 'ar1')
  assert.strictEqual(s.get('ar1').relType.state, REJECTED)
})

test('getFinalRelType returns undefined after rejecting an ACCEPTED suggestion', () => {
  let s = makeHighState('ar2', 'Collaborator')
  s = rejectRelTypeSuggestion(s, 'ar2')
  assert.strictEqual(getFinalRelType(null, s.get('ar2')), undefined)
})

// ── changeRelTypeSuggestion — enum-validated ──────────────────────────────────

console.log('\nchangeRelTypeSuggestion — enum validation')

test('valid enum value → EDITED', () => {
  let s = makeState('ch1', 'Mentor')
  s = changeRelTypeSuggestion(s, 'ch1', 'Collaborator')
  assert.strictEqual(s.get('ch1').relType.state, EDITED)
})

test('valid enum value stores editedValue', () => {
  let s = makeState('ch2', 'Other')
  s = changeRelTypeSuggestion(s, 'ch2', 'Referral path')
  assert.strictEqual(s.get('ch2').relType.editedValue, 'Referral path')
})

test('invalid value → REJECTED', () => {
  let s = makeState('ch3', 'Mentor')
  s = changeRelTypeSuggestion(s, 'ch3', 'Not a real type')
  assert.strictEqual(s.get('ch3').relType.state, REJECTED)
})

test('empty string → REJECTED', () => {
  let s = makeState('ch4', 'Mentor')
  s = changeRelTypeSuggestion(s, 'ch4', '')
  assert.strictEqual(s.get('ch4').relType.state, REJECTED)
})

test('editedValue is null for invalid/empty change', () => {
  let s = makeState('ch5', 'Mentor')
  s = changeRelTypeSuggestion(s, 'ch5', '')
  assert.strictEqual(s.get('ch5').relType.editedValue, null)
})

test('all 6 RELATIONSHIP_TYPE_VALUES are accepted by changeRelTypeSuggestion', () => {
  for (const v of RELATIONSHIP_TYPE_VALUES) {
    let s = makeState(`chv-${v}`, 'Other')
    s = changeRelTypeSuggestion(s, `chv-${v}`, v)
    assert.strictEqual(s.get(`chv-${v}`).relType.state, EDITED, `${v} must be valid`)
    assert.strictEqual(s.get(`chv-${v}`).relType.editedValue, v)
  }
})

test('getFinalRelType returns editedValue for EDITED relType', () => {
  let s = makeState('ch6', 'Mentor')
  s = changeRelTypeSuggestion(s, 'ch6', 'Collaborator')
  assert.strictEqual(getFinalRelType(null, s.get('ch6')), 'Collaborator')
})

// ── editRelTypeSuggestion — free-form backward compat ────────────────────────

console.log('\neditRelTypeSuggestion (free-form, backward compat)')

test('editRelTypeSuggestion with non-empty value → EDITED', () => {
  let s = makeState('er1', 'Other')
  s = editRelTypeSuggestion(s, 'er1', 'Anything goes')
  assert.strictEqual(s.get('er1').relType.state, EDITED)
  assert.strictEqual(s.get('er1').relType.editedValue, 'Anything goes')
})

test('editRelTypeSuggestion with empty → REJECTED', () => {
  let s = makeState('er2', 'Other')
  s = editRelTypeSuggestion(s, 'er2', '')
  assert.strictEqual(s.get('er2').relType.state, REJECTED)
})

// ── CSV value always wins over AI suggestion ──────────────────────────────────

console.log('\nCSV value always wins over AI suggestion')

test('getFinalRelType returns CSV value even if AI suggestion is ACCEPTED', () => {
  // When CSV has a relType, initSuggestionReview sets relType = null,
  // so the AI suggestion is already suppressed. Test that getFinalRelType
  // also correctly prioritizes the csvRelType argument.
  const s = makeState('csv1', 'Mentor', 'high')   // high → ACCEPTED
  // Pass a CSV value explicitly to getFinalRelType
  assert.strictEqual(getFinalRelType('Collaborator', s.get('csv1')), 'Collaborator',
    'CSV relType arg wins over ACCEPTED AI suggestion in getFinalRelType')
})

test('getFinalRelType returns undefined when no CSV and relType is null', () => {
  const s = initSuggestionReview([{ _rowId: 'n1', relationship_type: null, _suggestion: null }], undefined)
  assert.strictEqual(getFinalRelType(null, s.get('n1')), undefined)
})

test('getFinalRelType returns undefined when row state is undefined', () => {
  assert.strictEqual(getFinalRelType(null, undefined), undefined)
})

// ── Operations on null relType are no-ops ─────────────────────────────────────

console.log('\noperations on null relType are no-ops')

test('acceptRelTypeSuggestion when relType is null → no change', () => {
  const s = initSuggestionReview([{ _rowId: 'n2', relationship_type: null, _suggestion: null }], undefined)
  const next = acceptRelTypeSuggestion(s, 'n2')
  assert.strictEqual(next.get('n2').relType, null)
})

test('rejectRelTypeSuggestion when relType is null → no change', () => {
  const s = initSuggestionReview([{ _rowId: 'n3', relationship_type: null, _suggestion: null }], undefined)
  const next = rejectRelTypeSuggestion(s, 'n3')
  assert.strictEqual(next.get('n3').relType, null)
})

// ── Immutability ──────────────────────────────────────────────────────────────

console.log('\nimmutability')

test('changeRelTypeSuggestion returns new Map', () => {
  const s  = makeState('i1', 'Mentor')
  const n  = changeRelTypeSuggestion(s, 'i1', 'Collaborator')
  assert.notStrictEqual(s, n)
})

test('original state unchanged after changeRelTypeSuggestion', () => {
  const s  = makeState('i2', 'Other')
  changeRelTypeSuggestion(s, 'i2', 'Mentor')
  assert.strictEqual(s.get('i2').relType.state, PENDING)
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
