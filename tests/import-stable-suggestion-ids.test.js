/**
 * import-stable-suggestion-ids.test.js
 *
 * Verifies that all suggestion mutation functions use stable IDs (never array indices),
 * and that the stable ID format matches expectations from the spec.
 *
 * Run with: node tests/import-stable-suggestion-ids.test.js
 */
import assert from 'assert'
import {
  SUGGESTION_STATES,
  RELATIONSHIP_TYPE_VALUES,
  initSuggestionReview,
  acceptTagSuggestion,
  rejectTagSuggestion,
  editTagSuggestion,
  acceptRelTypeSuggestion,
  rejectRelTypeSuggestion,
  changeRelTypeSuggestion,
  getFinalTags,
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

function makeRows(rowId, tags, relType = null) {
  return [{
    _rowId:            rowId,
    relationship_type: null,
    _suggestion: {
      suggested_tags:              tags,
      suggested_relationship_type: relType,
      confidence:                  'medium',
    },
  }]
}

function makeHighRows(rowId, tags, relType = null) {
  return [{
    _rowId:            rowId,
    relationship_type: null,
    _suggestion: {
      suggested_tags:              tags,
      suggested_relationship_type: relType,
      confidence:                  'high',
    },
  }]
}

// ── Tag stable ID format ───────────────────────────────────────────────────────

console.log('\nTag stable ID format')

test('tag ID is rowId:tag:normalizedTag', () => {
  const rows  = makeRows('r1', ['Recruiter'])
  const state = initSuggestionReview(rows, undefined)
  const tag   = state.get('r1').tags[0]
  assert.strictEqual(tag.id, 'r1:tag:recruiter', 'ID must be rowId:tag:normalizedTag')
})

test('tag ID is normalized lowercase', () => {
  const rows  = makeRows('r2', ['Finance Pro'])
  const state = initSuggestionReview(rows, undefined)
  const tag   = state.get('r2').tags[0]
  assert.strictEqual(tag.id, 'r2:tag:finance pro')
})

test('tag ID does not depend on insertion order', () => {
  const rows  = makeRows('r3', ['Beta', 'Alpha'])
  const state = initSuggestionReview(rows, undefined)
  const ids   = state.get('r3').tags.map(t => t.id)
  assert.ok(ids.includes('r3:tag:beta'))
  assert.ok(ids.includes('r3:tag:alpha'))
})

test('tag ID is unique within a row — no two tags share ID', () => {
  const rows  = makeRows('r4', ['A', 'B', 'C', 'D'])
  const state = initSuggestionReview(rows, undefined)
  const ids   = state.get('r4').tags.map(t => t.id)
  assert.strictEqual(new Set(ids).size, ids.length, 'all IDs must be unique')
})

test('duplicate normalized tags produce only one TagItem (deduplication)', () => {
  const rows  = makeRows('r5', ['Recruiter', 'recruiter', 'RECRUITER'])
  const state = initSuggestionReview(rows, undefined)
  assert.strictEqual(state.get('r5').tags.length, 1, 'deduplication by normalized value')
})

test('tag ID is stable across initSuggestionReview re-calls', () => {
  const rows  = makeRows('r6', ['banking'])
  const s1    = initSuggestionReview(rows, undefined)
  const id1   = s1.get('r6').tags[0].id
  const s2    = initSuggestionReview(rows, undefined)
  const id2   = s2.get('r6').tags[0].id
  assert.strictEqual(id1, id2, 'ID must be deterministic across re-init')
})

// ── RelType stable ID format ───────────────────────────────────────────────────

console.log('\nRelType stable ID format')

test('relType ID is rowId:reltype', () => {
  const rows  = makeRows('r7', [], 'Mentor')
  const state = initSuggestionReview(rows, undefined)
  const rt    = state.get('r7').relType
  assert.strictEqual(rt.id, 'r7:reltype')
})

test('relType ID uses the row ID prefix', () => {
  const rows  = makeRows('my-unique-row', [], 'Connector')
  const state = initSuggestionReview(rows, undefined)
  assert.strictEqual(state.get('my-unique-row').relType.id, 'my-unique-row:reltype')
})

// ── Accept by stable ID (not index) ──────────────────────────────────────────

console.log('\naccept/reject/edit by stable ID — not array index')

test('acceptTagSuggestion accepts the correct item by ID regardless of position', () => {
  const rows  = makeRows('r8', ['alpha', 'beta', 'gamma'])
  const state = initSuggestionReview(rows, undefined)
  const betaId = state.get('r8').tags[1].id   // 'r8:tag:beta'

  // Accept only beta — alpha and gamma remain PENDING
  const next = acceptTagSuggestion(state, 'r8', betaId)
  const tags = next.get('r8').tags
  assert.strictEqual(tags[0].state, PENDING,   'alpha must still be PENDING')
  assert.strictEqual(tags[1].state, ACCEPTED,  'beta must be ACCEPTED')
  assert.strictEqual(tags[2].state, PENDING,   'gamma must still be PENDING')
})

test('rejectTagSuggestion rejects the correct item by ID', () => {
  const rows   = makeRows('r9', ['x', 'y'])
  const state  = initSuggestionReview(rows, undefined)
  const yTagId = state.get('r9').tags[1].id
  const next   = rejectTagSuggestion(state, 'r9', yTagId)
  const tags   = next.get('r9').tags
  assert.strictEqual(tags[0].state, PENDING)
  assert.strictEqual(tags[1].state, REJECTED)
})

test('editTagSuggestion edits the correct item by ID', () => {
  const rows   = makeRows('r10', ['old', 'keep'])
  const state  = initSuggestionReview(rows, undefined)
  const oldId  = state.get('r10').tags[0].id
  const next   = editTagSuggestion(state, 'r10', oldId, 'new-value')
  const tags   = next.get('r10').tags
  assert.strictEqual(tags[0].state,       EDITED)
  assert.strictEqual(tags[0].editedValue, 'new-value')
  assert.strictEqual(tags[1].state,       PENDING,  'second tag unchanged')
})

test('operating on one tag by ID does not mutate sibling tags', () => {
  const rows   = makeRows('r11', ['p', 'q', 'r'])
  let   state  = initSuggestionReview(rows, undefined)
  const pId    = state.get('r11').tags[0].id
  const rId    = state.get('r11').tags[2].id

  state = acceptTagSuggestion(state, 'r11', pId)
  state = rejectTagSuggestion(state, 'r11', rId)

  const tags = state.get('r11').tags
  assert.strictEqual(tags[0].state, ACCEPTED)
  assert.strictEqual(tags[1].state, PENDING,   'q unmodified')
  assert.strictEqual(tags[2].state, REJECTED)
})

test('unknown suggestionId is silently ignored — no state mutation', () => {
  const rows  = makeRows('r12', ['a'])
  const state = initSuggestionReview(rows, undefined)
  const next  = acceptTagSuggestion(state, 'r12', 'nonexistent-id')
  assert.strictEqual(next.get('r12').tags[0].state, PENDING, 'PENDING unchanged')
})

// ── High-confidence IDs initialise as ACCEPTED ───────────────────────────────

console.log('\nhigh-confidence suggestions start as ACCEPTED (with stable IDs)')

test('high-confidence tag IDs are stable and start ACCEPTED', () => {
  const rows  = makeHighRows('hr1', ['hot-tag'])
  const state = initSuggestionReview(rows, undefined)
  const tag   = state.get('hr1').tags[0]
  assert.strictEqual(tag.id,    'hr1:tag:hot-tag')
  assert.strictEqual(tag.state, ACCEPTED)
})

test('high-confidence relType ID is stable and starts ACCEPTED', () => {
  const rows  = makeHighRows('hr2', [], 'Mentor')
  const state = initSuggestionReview(rows, undefined)
  const rt    = state.get('hr2').relType
  assert.strictEqual(rt.id,    'hr2:reltype')
  assert.strictEqual(rt.state, ACCEPTED)
})

test('high-confidence ACCEPTED tag can be rejected by stable ID', () => {
  const rows   = makeHighRows('hr3', ['auto-accepted'])
  const state  = initSuggestionReview(rows, undefined)
  const tagId  = state.get('hr3').tags[0].id
  const next   = rejectTagSuggestion(state, 'hr3', tagId)
  assert.strictEqual(next.get('hr3').tags[0].state, REJECTED)
})

test('high-confidence ACCEPTED tag can be edited by stable ID', () => {
  const rows   = makeHighRows('hr4', ['original'])
  const state  = initSuggestionReview(rows, undefined)
  const tagId  = state.get('hr4').tags[0].id
  const next   = editTagSuggestion(state, 'hr4', tagId, 'revised')
  const tag    = next.get('hr4').tags[0]
  assert.strictEqual(tag.state,       EDITED)
  assert.strictEqual(tag.editedValue, 'revised')
})

// ── getFinalTags respects stable IDs ─────────────────────────────────────────

console.log('\ngetFinalTags with stable-ID decisions')

test('getFinalTags includes ACCEPTED tag (stable ID)', () => {
  const rows  = makeHighRows('f1', ['finance'])   // high → ACCEPTED
  const state = initSuggestionReview(rows, undefined)
  const tags  = getFinalTags([], state.get('f1'))
  assert.deepStrictEqual(tags, ['finance'])
})

test('getFinalTags excludes REJECTED tag (stable ID)', () => {
  const rows   = makeRows('f2', ['alumni'])
  let   state  = initSuggestionReview(rows, undefined)
  const tagId  = state.get('f2').tags[0].id
  state        = rejectTagSuggestion(state, 'f2', tagId)
  const tags   = getFinalTags([], state.get('f2'))
  assert.deepStrictEqual(tags, [])
})

test('getFinalTags includes EDITED value (stable ID)', () => {
  const rows   = makeRows('f3', ['draft'])
  let   state  = initSuggestionReview(rows, undefined)
  const tagId  = state.get('f3').tags[0].id
  state        = editTagSuggestion(state, 'f3', tagId, 'final')
  // Note: medium confidence — must first accept, then edit makes sense;
  // but editTagSuggestion can be called from any state → EDITED
  state        = editTagSuggestion(state, 'f3', tagId, 'final')
  const tags   = getFinalTags([], state.get('f3'))
  assert.deepStrictEqual(tags, ['final'])
})

// ── Multi-row isolation ───────────────────────────────────────────────────────

console.log('\nmulti-row ID isolation')

test('accepting tag on row A does not affect row B', () => {
  const rows = [
    { _rowId: 'A', relationship_type: null, _suggestion: { suggested_tags: ['tag1'], suggested_relationship_type: null, confidence: 'medium' } },
    { _rowId: 'B', relationship_type: null, _suggestion: { suggested_tags: ['tag1'], suggested_relationship_type: null, confidence: 'medium' } },
  ]
  const state  = initSuggestionReview(rows, undefined)
  const aTagId = state.get('A').tags[0].id   // 'A:tag:tag1'
  const bTagId = state.get('B').tags[0].id   // 'B:tag:tag1'

  // Even though both have the same tag value, IDs differ by row prefix
  assert.notStrictEqual(aTagId, bTagId)

  const next = acceptTagSuggestion(state, 'A', aTagId)
  assert.strictEqual(next.get('A').tags[0].state, ACCEPTED)
  assert.strictEqual(next.get('B').tags[0].state, PENDING, 'B must be unaffected')
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
