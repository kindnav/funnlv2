/**
 * import-tag-editing.test.js
 *
 * Verifies the full tag suggestion edit lifecycle:
 * PENDING → ACCEPTED → EDITED → REJECTED
 * and the custom tag (add/remove) flow.
 *
 * All mutation functions use stable suggestion IDs (never array indices).
 * No React, no DOM, no Supabase.
 *
 * Run with: node tests/import-tag-editing.test.js
 */
import assert from 'assert'
import {
  SUGGESTION_STATES,
  initSuggestionReview,
  acceptTagSuggestion,
  rejectTagSuggestion,
  editTagSuggestion,
  addCustomTag,
  removeCustomTag,
  getFinalTags,
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

function makeState(rowId, tags, confidence = 'medium') {
  return initSuggestionReview([{
    _rowId:            rowId,
    relationship_type: null,
    _suggestion: {
      suggested_tags:              tags,
      suggested_relationship_type: null,
      confidence,
    },
  }], undefined)
}

function tagId(state, rowId, index) {
  return state.get(rowId).tags[index].id
}

// ── Initial states ────────────────────────────────────────────────────────────

console.log('\ninitial states')

test('medium confidence → PENDING', () => {
  const s = makeState('r', ['t1'], 'medium')
  assert.strictEqual(s.get('r').tags[0].state, PENDING)
})

test('high confidence → ACCEPTED', () => {
  const s = makeState('r', ['t1'], 'high')
  assert.strictEqual(s.get('r').tags[0].state, ACCEPTED)
})

test('low confidence → PENDING', () => {
  const s = makeState('r', ['t1'], 'low')
  assert.strictEqual(s.get('r').tags[0].state, PENDING)
})

// ── PENDING → ACCEPTED ────────────────────────────────────────────────────────

console.log('\nPENDING → ACCEPTED')

test('acceptTagSuggestion transitions PENDING → ACCEPTED', () => {
  let s = makeState('r1', ['tag'])
  const id = tagId(s, 'r1', 0)
  s = acceptTagSuggestion(s, 'r1', id)
  assert.strictEqual(s.get('r1').tags[0].state, ACCEPTED)
})

test('accepted tag appears in getFinalTags', () => {
  let s = makeState('r2', ['alpha'])
  s = acceptTagSuggestion(s, 'r2', tagId(s, 'r2', 0))
  assert.deepStrictEqual(getFinalTags([], s.get('r2')), ['alpha'])
})

// ── PENDING → REJECTED ────────────────────────────────────────────────────────

console.log('\nPENDING → REJECTED')

test('rejectTagSuggestion transitions PENDING → REJECTED', () => {
  let s = makeState('r3', ['unwanted'])
  s = rejectTagSuggestion(s, 'r3', tagId(s, 'r3', 0))
  assert.strictEqual(s.get('r3').tags[0].state, REJECTED)
})

test('rejected tag excluded from getFinalTags', () => {
  let s = makeState('r4', ['nope'])
  s = rejectTagSuggestion(s, 'r4', tagId(s, 'r4', 0))
  assert.deepStrictEqual(getFinalTags([], s.get('r4')), [])
})

// ── ACCEPTED → EDITED ─────────────────────────────────────────────────────────

console.log('\nACCEPTED → EDITED')

test('editTagSuggestion on ACCEPTED → EDITED with trimmed lowercase value', () => {
  let s  = makeState('r5', ['orig'], 'high')  // high → ACCEPTED
  const id = tagId(s, 'r5', 0)
  s = editTagSuggestion(s, 'r5', id, '  NewValue  ')
  const tag = s.get('r5').tags[0]
  assert.strictEqual(tag.state,       EDITED)
  assert.strictEqual(tag.editedValue, 'newvalue')
})

test('EDITED value appears in getFinalTags instead of original', () => {
  let s  = makeState('r6', ['orig'], 'high')
  const id = tagId(s, 'r6', 0)
  s = editTagSuggestion(s, 'r6', id, 'revised')
  assert.deepStrictEqual(getFinalTags([], s.get('r6')), ['revised'])
})

// ── ACCEPTED → REJECTED (remove accepted tag) ─────────────────────────────────

console.log('\nACCEPTED → REJECTED (remove)')

test('rejectTagSuggestion on ACCEPTED tag → REJECTED', () => {
  let s  = makeState('r7', ['accepted-one'], 'high')  // starts ACCEPTED
  const id = tagId(s, 'r7', 0)
  s = rejectTagSuggestion(s, 'r7', id)
  assert.strictEqual(s.get('r7').tags[0].state, REJECTED)
})

test('rejected accepted tag disappears from getFinalTags', () => {
  let s  = makeState('r8', ['gone'], 'high')
  s = rejectTagSuggestion(s, 'r8', tagId(s, 'r8', 0))
  assert.deepStrictEqual(getFinalTags([], s.get('r8')), [])
})

// ── Edit transitions to REJECTED when value is empty ──────────────────────────

console.log('\nedit with empty value → REJECTED')

test('editTagSuggestion with empty string → REJECTED', () => {
  let s  = makeState('r9', ['value'], 'high')
  s = editTagSuggestion(s, 'r9', tagId(s, 'r9', 0), '')
  assert.strictEqual(s.get('r9').tags[0].state, REJECTED)
})

test('editTagSuggestion with whitespace-only → REJECTED', () => {
  let s  = makeState('r10', ['val'], 'high')
  s = editTagSuggestion(s, 'r10', tagId(s, 'r10', 0), '   ')
  assert.strictEqual(s.get('r10').tags[0].state, REJECTED)
})

test('editTagSuggestion with empty → editedValue is null', () => {
  let s  = makeState('r11', ['val'], 'high')
  s = editTagSuggestion(s, 'r11', tagId(s, 'r11', 0), '')
  assert.strictEqual(s.get('r11').tags[0].editedValue, null)
})

// ── EDITED → REJECTED ─────────────────────────────────────────────────────────

console.log('\nEDITED → REJECTED')

test('rejecting an EDITED tag transitions to REJECTED', () => {
  let s  = makeState('r12', ['orig'], 'high')
  const id = tagId(s, 'r12', 0)
  s = editTagSuggestion(s, 'r12', id, 'edited')
  s = rejectTagSuggestion(s, 'r12', id)
  assert.strictEqual(s.get('r12').tags[0].state, REJECTED)
})

// ── Multiple tags — independent state machines ─────────────────────────────────

console.log('\nmultiple tags — independent state machines')

test('three tags can be in three different states simultaneously', () => {
  let s = makeState('m1', ['a', 'b', 'c'], 'medium')
  const [idA, idB, idC] = [tagId(s, 'm1', 0), tagId(s, 'm1', 1), tagId(s, 'm1', 2)]
  s = acceptTagSuggestion(s, 'm1', idA)
  s = rejectTagSuggestion(s, 'm1', idB)
  // idC stays PENDING
  const tags = s.get('m1').tags
  assert.strictEqual(tags[0].state, ACCEPTED)
  assert.strictEqual(tags[1].state, REJECTED)
  assert.strictEqual(tags[2].state, PENDING)
})

test('getFinalTags only includes ACCEPTED and EDITED from multi-tag row', () => {
  let s = makeState('m2', ['keep', 'edit', 'drop'])
  const [idK, idE, idD] = [tagId(s, 'm2', 0), tagId(s, 'm2', 1), tagId(s, 'm2', 2)]
  s = acceptTagSuggestion(s, 'm2', idK)
  s = editTagSuggestion(s, 'm2', idE, 'edited-tag')
  s = rejectTagSuggestion(s, 'm2', idD)
  const result = getFinalTags([], s.get('m2'))
  assert.deepStrictEqual(result, ['keep', 'edited-tag'])
})

// ── Custom tags ───────────────────────────────────────────────────────────────

console.log('\ncustom tags (add/remove)')

test('addCustomTag appends to customTags', () => {
  const s = makeState('c1', [])
  const next = addCustomTag(s, 'c1', 'myCustom')
  assert.deepStrictEqual(next.get('c1').customTags, ['mycustom'])
})

test('addCustomTag is normalized lowercase', () => {
  const s = makeState('c2', [])
  const next = addCustomTag(s, 'c2', 'Finance')
  assert.deepStrictEqual(next.get('c2').customTags, ['finance'])
})

test('addCustomTag deduplicates by normalized value', () => {
  let s = makeState('c3', [])
  s = addCustomTag(s, 'c3', 'Alumni')
  s = addCustomTag(s, 'c3', 'alumni')
  assert.deepStrictEqual(s.get('c3').customTags, ['alumni'])
})

test('removeCustomTag removes the matching entry', () => {
  let s = makeState('c4', [])
  s = addCustomTag(s, 'c4', 'Tech')
  s = removeCustomTag(s, 'c4', 'tech')
  assert.deepStrictEqual(s.get('c4').customTags, [])
})

test('custom tags appear in getFinalTags', () => {
  let s = makeState('c5', [])
  s = addCustomTag(s, 'c5', 'venture')
  assert.deepStrictEqual(getFinalTags([], s.get('c5')), ['venture'])
})

test('custom tags are deduplicated with csv tags in getFinalTags', () => {
  let s = makeState('c6', [])
  s = addCustomTag(s, 'c6', 'recruiter')
  const tags = getFinalTags(['recruiter'], s.get('c6'))
  assert.deepStrictEqual(tags, ['recruiter'], 'duplicate removed across csv + custom')
})

test('addCustomTag with empty string is ignored', () => {
  const s    = makeState('c7', [])
  const next = addCustomTag(s, 'c7', '')
  assert.deepStrictEqual(next.get('c7').customTags, [])
})

test('addCustomTag with whitespace-only is ignored', () => {
  const s    = makeState('c8', [])
  const next = addCustomTag(s, 'c8', '   ')
  assert.deepStrictEqual(next.get('c8').customTags, [])
})

// ── CSV tags always included regardless of AI state ───────────────────────────

console.log('\nCSV tags always first in getFinalTags')

test('CSV tags are always included, before AI suggestions', () => {
  let s = makeState('csv1', ['ai-tag'], 'high')  // ACCEPTED
  const tags = getFinalTags(['csv-tag'], s.get('csv1'))
  assert.deepStrictEqual(tags, ['csv-tag', 'ai-tag'])
})

test('CSV tags are always included even if all AI tags are rejected', () => {
  let s = makeState('csv2', ['rejected-tag'])
  s = rejectTagSuggestion(s, 'csv2', tagId(s, 'csv2', 0))
  const tags = getFinalTags(['csv-tag'], s.get('csv2'))
  assert.deepStrictEqual(tags, ['csv-tag'])
})

// ── Immutability — state returns new Map ──────────────────────────────────────

console.log('\nimmutability')

test('acceptTagSuggestion returns a new Map reference', () => {
  const s = makeState('imm1', ['x'])
  const id = tagId(s, 'imm1', 0)
  const next = acceptTagSuggestion(s, 'imm1', id)
  assert.notStrictEqual(s, next, 'must return a new Map')
})

test('original state unchanged after mutation', () => {
  const s = makeState('imm2', ['x'])
  const id = tagId(s, 'imm2', 0)
  acceptTagSuggestion(s, 'imm2', id)
  assert.strictEqual(s.get('imm2').tags[0].state, PENDING, 'original unmodified')
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
