/**
 * import-suggestion-review.test.js
 *
 * Tests for src/lib/importSuggestionReview.js
 * Zero-dependency Node.js — run with: node tests/import-suggestion-review.test.js
 */
import assert from 'assert'
import {
  SUGGESTION_STATES,
  RELATIONSHIP_TYPE_VALUES,
  initSuggestionReview,
  acceptTagSuggestion,
  rejectTagSuggestion,
  editTagSuggestion,
  addCustomTag,
  removeCustomTag,
  acceptRelTypeSuggestion,
  rejectRelTypeSuggestion,
  editRelTypeSuggestion,
  changeRelTypeSuggestion,
  getFinalTags,
  getFinalRelType,
} from '../src/lib/importSuggestionReview.js'

const { PENDING, ACCEPTED, REJECTED, EDITED } = SUGGESTION_STATES

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

// ── SUGGESTION_STATES ─────────────────────────────────────────────────────────

console.log('\nSUGGESTION_STATES\n')

test('exports four state constants', () => {
  assert.strictEqual(SUGGESTION_STATES.PENDING,  'pending')
  assert.strictEqual(SUGGESTION_STATES.ACCEPTED, 'accepted')
  assert.strictEqual(SUGGESTION_STATES.REJECTED, 'rejected')
  assert.strictEqual(SUGGESTION_STATES.EDITED,   'edited')
})

test('is frozen — cannot add new properties', () => {
  assert.throws(() => { SUGGESTION_STATES.EXTRA = 'x' }, TypeError)
})

// ── initSuggestionReview ──────────────────────────────────────────────────────

console.log('\ninitSuggestionReview\n')

function makeRow(rowId, suggestion = null, relationship_type = '') {
  return { _rowId: rowId, name: 'Alice', relationship_type, _suggestion: suggestion }
}

function makeSuggestion({ tags = [], relType = null, confidence = 'high' } = {}) {
  return {
    suggested_tags: tags,
    suggested_relationship_type: relType,
    confidence,
  }
}

test('returns empty Map for non-array input', () => {
  const result = initSuggestionReview(null)
  assert.ok(result instanceof Map)
  assert.strictEqual(result.size, 0)
})

test('returns Map with one entry per row', () => {
  const rows = [makeRow('r1'), makeRow('r2')]
  const result = initSuggestionReview(rows)
  assert.strictEqual(result.size, 2)
})

test('row without suggestion gets empty state', () => {
  const rows = [makeRow('r1', null)]
  const result = initSuggestionReview(rows)
  const state = result.get('r1')
  assert.deepStrictEqual(state.tags, [])
  assert.strictEqual(state.relType, null)
  assert.deepStrictEqual(state.customTags, [])
})

test('high-confidence tags start ACCEPTED', () => {
  const rows = [makeRow('r1', makeSuggestion({ tags: ['recruiter'], confidence: 'high' }))]
  const result = initSuggestionReview(rows)
  assert.strictEqual(result.get('r1').tags[0].state, ACCEPTED)
})

test('medium-confidence tags start PENDING', () => {
  const rows = [makeRow('r1', makeSuggestion({ tags: ['recruiter'], confidence: 'medium' }))]
  const result = initSuggestionReview(rows)
  assert.strictEqual(result.get('r1').tags[0].state, PENDING)
})

test('low-confidence tags start PENDING', () => {
  const rows = [makeRow('r1', makeSuggestion({ tags: ['recruiter'], confidence: 'low' }))]
  const result = initSuggestionReview(rows)
  assert.strictEqual(result.get('r1').tags[0].state, PENDING)
})

test('tags are normalized to lowercase', () => {
  const rows = [makeRow('r1', makeSuggestion({ tags: ['Goldman Sachs Intern'] }))]
  const result = initSuggestionReview(rows)
  assert.strictEqual(result.get('r1').tags[0].tag, 'goldman sachs intern')
})

test('empty/blank tag strings are filtered', () => {
  const rows = [makeRow('r1', makeSuggestion({ tags: ['', '  ', 'recruiter'] }))]
  const result = initSuggestionReview(rows)
  assert.strictEqual(result.get('r1').tags.length, 1)
})

test('relType suggestion starts ACCEPTED when confidence high', () => {
  const rows = [makeRow('r1', makeSuggestion({ relType: 'Recruiter', confidence: 'high' }))]
  const result = initSuggestionReview(rows)
  assert.strictEqual(result.get('r1').relType.state, ACCEPTED)
})

test('relType suggestion starts PENDING when confidence medium', () => {
  const rows = [makeRow('r1', makeSuggestion({ relType: 'Mentor', confidence: 'medium' }))]
  const result = initSuggestionReview(rows)
  assert.strictEqual(result.get('r1').relType.state, PENDING)
})

test('no relType suggestion when CSV already has relationship_type', () => {
  const rows = [makeRow('r1', makeSuggestion({ relType: 'Mentor' }), 'Recruiter')]
  const result = initSuggestionReview(rows)
  assert.strictEqual(result.get('r1').relType, null)
})

test('relType suggestion allowed when CSV relationship_type is empty', () => {
  const rows = [makeRow('r1', makeSuggestion({ relType: 'Mentor' }), '')]
  const result = initSuggestionReview(rows)
  assert.ok(result.get('r1').relType !== null)
})

test('preserves existing decisions when rowId already in existingState', () => {
  const rows = [makeRow('r1', makeSuggestion({ tags: ['recruiter'] }))]
  const existingState = new Map([
    ['r1', { tags: [{ tag: 'alumni', confidence: 'high', state: REJECTED, editedValue: null }], relType: null, customTags: [] }],
  ])
  const result = initSuggestionReview(rows, existingState)
  assert.strictEqual(result.get('r1').tags[0].tag, 'alumni')
  assert.strictEqual(result.get('r1').tags[0].state, REJECTED)
})

test('initializes fresh state for rowIds not in existingState', () => {
  const rows = [makeRow('r2', makeSuggestion({ tags: ['recruiter'] }))]
  const existingState = new Map([['r1', { tags: [], relType: null, customTags: [] }]])
  const result = initSuggestionReview(rows, existingState)
  assert.strictEqual(result.get('r2').tags[0].state, ACCEPTED)
})

test('returns same size Map regardless of existingState coverage', () => {
  const rows = [makeRow('r1'), makeRow('r2'), makeRow('r3')]
  const existingState = new Map([['r1', { tags: [], relType: null, customTags: [] }]])
  const result = initSuggestionReview(rows, existingState)
  assert.strictEqual(result.size, 3)
})

// ── acceptTagSuggestion ───────────────────────────────────────────────────────

console.log('\nacceptTagSuggestion\n')

function makeState(tagStates) {
  const tags = tagStates.map((s, i) => ({
    id: `r1:tag:tag-${i}`,
    tag: `tag-${i}`, confidence: 'medium', state: s, editedValue: null,
  }))
  return new Map([['r1', { tags, relType: null, customTags: [] }]])
}

// Helper: get stable suggestion ID for tag at position i
function tagId(i) { return `r1:tag:tag-${i}` }

test('transitions PENDING → ACCEPTED', () => {
  const state = makeState([PENDING])
  const next = acceptTagSuggestion(state, 'r1', tagId(0))
  assert.strictEqual(next.get('r1').tags[0].state, ACCEPTED)
})

test('transitions REJECTED → ACCEPTED', () => {
  const state = makeState([REJECTED])
  const next = acceptTagSuggestion(state, 'r1', tagId(0))
  assert.strictEqual(next.get('r1').tags[0].state, ACCEPTED)
})

test('returns new Map (immutable)', () => {
  const state = makeState([PENDING])
  const next = acceptTagSuggestion(state, 'r1', tagId(0))
  assert.notStrictEqual(state, next)
  assert.strictEqual(state.get('r1').tags[0].state, PENDING)
})

test('only updates the specified suggestion ID', () => {
  const state = makeState([PENDING, PENDING])
  const next = acceptTagSuggestion(state, 'r1', tagId(0))
  assert.strictEqual(next.get('r1').tags[0].state, ACCEPTED)
  assert.strictEqual(next.get('r1').tags[1].state, PENDING)
})

test('returns original map if rowId not found', () => {
  const state = makeState([PENDING])
  const next = acceptTagSuggestion(state, 'unknown', tagId(0))
  assert.strictEqual(state, next)
})

// ── rejectTagSuggestion ───────────────────────────────────────────────────────

console.log('\nrejectTagSuggestion\n')

test('transitions ACCEPTED → REJECTED', () => {
  const state = makeState([ACCEPTED])
  const next = rejectTagSuggestion(state, 'r1', tagId(0))
  assert.strictEqual(next.get('r1').tags[0].state, REJECTED)
})

test('transitions PENDING → REJECTED', () => {
  const state = makeState([PENDING])
  const next = rejectTagSuggestion(state, 'r1', tagId(0))
  assert.strictEqual(next.get('r1').tags[0].state, REJECTED)
})

test('returns new Map (immutable)', () => {
  const state = makeState([ACCEPTED])
  const next = rejectTagSuggestion(state, 'r1', tagId(0))
  assert.notStrictEqual(state, next)
})

// ── editTagSuggestion ─────────────────────────────────────────────────────────

console.log('\neditTagSuggestion\n')

test('transitions to EDITED and stores new value', () => {
  const state = makeState([ACCEPTED])
  const next = editTagSuggestion(state, 'r1', tagId(0), 'New Tag Value')
  assert.strictEqual(next.get('r1').tags[0].state, EDITED)
  assert.strictEqual(next.get('r1').tags[0].editedValue, 'new tag value')
})

test('empty string transitions to REJECTED and clears editedValue', () => {
  const state = makeState([ACCEPTED])
  const next = editTagSuggestion(state, 'r1', tagId(0), '')
  assert.strictEqual(next.get('r1').tags[0].state, REJECTED)
  assert.strictEqual(next.get('r1').tags[0].editedValue, null)
})

test('whitespace-only transitions to REJECTED', () => {
  const state = makeState([ACCEPTED])
  const next = editTagSuggestion(state, 'r1', tagId(0), '   ')
  assert.strictEqual(next.get('r1').tags[0].state, REJECTED)
})

test('editing one tag does not alter another (stable ID isolation)', () => {
  const state = makeState([PENDING, ACCEPTED])
  const next = editTagSuggestion(state, 'r1', tagId(0), 'edited-value')
  assert.strictEqual(next.get('r1').tags[0].state, EDITED)
  assert.strictEqual(next.get('r1').tags[1].state, ACCEPTED, 'second tag must be unchanged')
})

// ── addCustomTag / removeCustomTag ────────────────────────────────────────────

console.log('\naddCustomTag / removeCustomTag\n')

function emptyState() {
  return new Map([['r1', { tags: [], relType: null, customTags: [] }]])
}

test('addCustomTag appends new tag', () => {
  const state = emptyState()
  const next = addCustomTag(state, 'r1', 'finance')
  assert.deepStrictEqual(next.get('r1').customTags, ['finance'])
})

test('addCustomTag normalizes to lowercase', () => {
  const state = emptyState()
  const next = addCustomTag(state, 'r1', 'Investment Banking')
  assert.deepStrictEqual(next.get('r1').customTags, ['investment banking'])
})

test('addCustomTag deduplicates', () => {
  let state = emptyState()
  state = addCustomTag(state, 'r1', 'finance')
  state = addCustomTag(state, 'r1', 'finance')
  assert.strictEqual(state.get('r1').customTags.length, 1)
})

test('addCustomTag ignores empty/blank input', () => {
  const state = emptyState()
  const next = addCustomTag(state, 'r1', '   ')
  assert.strictEqual(next, state) // same reference returned
})

test('removeCustomTag removes matching tag', () => {
  let state = emptyState()
  state = addCustomTag(state, 'r1', 'finance')
  state = removeCustomTag(state, 'r1', 'finance')
  assert.deepStrictEqual(state.get('r1').customTags, [])
})

test('removeCustomTag is a no-op when tag not present', () => {
  const state = emptyState()
  const next = removeCustomTag(state, 'r1', 'nonexistent')
  assert.deepStrictEqual(next.get('r1').customTags, [])
})

// ── acceptRelTypeSuggestion / rejectRelTypeSuggestion / editRelTypeSuggestion ─

console.log('\nRelType suggestion mutations\n')

function relTypeState(stateVal = PENDING, value = 'Recruiter') {
  return new Map([['r1', {
    tags: [],
    relType: { id: 'r1:reltype', value, confidence: 'high', state: stateVal, editedValue: null },
    customTags: [],
  }]])
}

test('acceptRelTypeSuggestion → ACCEPTED', () => {
  const state = relTypeState(PENDING)
  const next = acceptRelTypeSuggestion(state, 'r1')
  assert.strictEqual(next.get('r1').relType.state, ACCEPTED)
})

test('rejectRelTypeSuggestion → REJECTED', () => {
  const state = relTypeState(ACCEPTED)
  const next = rejectRelTypeSuggestion(state, 'r1')
  assert.strictEqual(next.get('r1').relType.state, REJECTED)
})

test('editRelTypeSuggestion → EDITED with new value', () => {
  const state = relTypeState(ACCEPTED)
  const next = editRelTypeSuggestion(state, 'r1', 'Mentor')
  assert.strictEqual(next.get('r1').relType.state, EDITED)
  assert.strictEqual(next.get('r1').relType.editedValue, 'Mentor')
})

test('editRelTypeSuggestion with empty string → REJECTED', () => {
  const state = relTypeState(ACCEPTED)
  const next = editRelTypeSuggestion(state, 'r1', '')
  assert.strictEqual(next.get('r1').relType.state, REJECTED)
})

test('relType mutation returns same map when rowId not found', () => {
  const state = relTypeState()
  const next = acceptRelTypeSuggestion(state, 'nonexistent')
  assert.strictEqual(state, next)
})

test('relType mutation is a no-op when relType is null', () => {
  const state = new Map([['r1', { tags: [], relType: null, customTags: [] }]])
  const next = acceptRelTypeSuggestion(state, 'r1')
  assert.strictEqual(next.get('r1').relType, null)
})

// ── changeRelTypeSuggestion ──────────────────────────────────────────────────

console.log('\nchangeRelTypeSuggestion\n')

test('valid enum value → EDITED with editedValue set', () => {
  const state = relTypeState(PENDING)
  const next = changeRelTypeSuggestion(state, 'r1', 'Mentor')
  assert.strictEqual(next.get('r1').relType.state, EDITED)
  assert.strictEqual(next.get('r1').relType.editedValue, 'Mentor')
})

test('invalid value → REJECTED', () => {
  const state = relTypeState(ACCEPTED)
  const next = changeRelTypeSuggestion(state, 'r1', 'NotARealType')
  assert.strictEqual(next.get('r1').relType.state, REJECTED)
  assert.strictEqual(next.get('r1').relType.editedValue, null)
})

test('empty string → REJECTED', () => {
  const state = relTypeState(ACCEPTED)
  const next = changeRelTypeSuggestion(state, 'r1', '')
  assert.strictEqual(next.get('r1').relType.state, REJECTED)
})

test('all RELATIONSHIP_TYPE_VALUES are valid', () => {
  for (const v of RELATIONSHIP_TYPE_VALUES) {
    const state = relTypeState(PENDING)
    const next = changeRelTypeSuggestion(state, 'r1', v)
    assert.strictEqual(next.get('r1').relType.state, EDITED, `${v} must be a valid enum value`)
    assert.strictEqual(next.get('r1').relType.editedValue, v)
  }
})

test('RELATIONSHIP_TYPE_VALUES has exactly the 6 expected values', () => {
  const expected = ['Mentor', 'Collaborator', 'Referral path', 'Potential employer', 'Connector', 'Other']
  assert.deepStrictEqual(RELATIONSHIP_TYPE_VALUES, expected)
})

// ── TagItem id field ──────────────────────────────────────────────────────────

console.log('\nTagItem stable id field\n')

test('each TagItem has a stable id field', () => {
  const rows = [makeRow('r1', makeSuggestion({ tags: ['recruiter', 'alumni'] }))]
  const result = initSuggestionReview(rows)
  const tags = result.get('r1').tags
  assert.ok(tags[0].id, 'first tag must have an id')
  assert.ok(tags[1].id, 'second tag must have an id')
})

test('tag id format is rowId:tag:normalizedTag', () => {
  const rows = [makeRow('r1', makeSuggestion({ tags: ['Goldman Sachs'] }))]
  const result = initSuggestionReview(rows)
  assert.strictEqual(result.get('r1').tags[0].id, 'r1:tag:goldman sachs')
})

test('duplicate tags produce only one item (deduplication by id)', () => {
  const rows = [makeRow('r1', makeSuggestion({ tags: ['Finance', 'finance', 'FINANCE'] }))]
  const result = initSuggestionReview(rows)
  assert.strictEqual(result.get('r1').tags.length, 1, 'case-variant duplicates must collapse to one')
})

test('ids are unique within a row even across different tag values', () => {
  const rows = [makeRow('r1', makeSuggestion({ tags: ['recruiter', 'alumni', 'mentor'] }))]
  const result = initSuggestionReview(rows)
  const ids = result.get('r1').tags.map(t => t.id)
  assert.strictEqual(new Set(ids).size, 3, 'all three ids must be distinct')
})

test('RelTypeItem has a stable id field', () => {
  const rows = [makeRow('r1', makeSuggestion({ relType: 'Mentor' }))]
  const result = initSuggestionReview(rows)
  assert.ok(result.get('r1').relType.id, 'relType must have an id')
  assert.strictEqual(result.get('r1').relType.id, 'r1:reltype')
})

// ── getFinalTags ──────────────────────────────────────────────────────────────

console.log('\ngetFinalTags\n')

test('CSV tags always included', () => {
  const result = getFinalTags(['finance', 'alumni'], null)
  assert.deepStrictEqual(result, ['finance', 'alumni'])
})

test('accepted AI tags are appended after CSV tags', () => {
  const rowState = {
    tags: [{ tag: 'recruiter', confidence: 'high', state: ACCEPTED, editedValue: null }],
    relType: null,
    customTags: [],
  }
  const result = getFinalTags(['alumni'], rowState)
  assert.deepStrictEqual(result, ['alumni', 'recruiter'])
})

test('rejected AI tags are excluded', () => {
  const rowState = {
    tags: [{ tag: 'recruiter', confidence: 'high', state: REJECTED, editedValue: null }],
    relType: null,
    customTags: [],
  }
  const result = getFinalTags([], rowState)
  assert.deepStrictEqual(result, [])
})

test('pending AI tags are excluded', () => {
  const rowState = {
    tags: [{ tag: 'recruiter', confidence: 'medium', state: PENDING, editedValue: null }],
    relType: null,
    customTags: [],
  }
  const result = getFinalTags([], rowState)
  assert.deepStrictEqual(result, [])
})

test('edited AI tags use the editedValue', () => {
  const rowState = {
    tags: [{ tag: 'recruiter', confidence: 'high', state: EDITED, editedValue: 'investment banking' }],
    relType: null,
    customTags: [],
  }
  const result = getFinalTags([], rowState)
  assert.deepStrictEqual(result, ['investment banking'])
})

test('custom tags are appended last', () => {
  const rowState = { tags: [], relType: null, customTags: ['vc target'] }
  const result = getFinalTags(['alumni'], rowState)
  assert.deepStrictEqual(result, ['alumni', 'vc target'])
})

test('deduplicates across CSV and AI sources', () => {
  const rowState = {
    tags: [{ tag: 'recruiter', state: ACCEPTED, confidence: 'high', editedValue: null }],
    relType: null,
    customTags: ['recruiter'],
  }
  const result = getFinalTags(['recruiter'], rowState)
  assert.deepStrictEqual(result, ['recruiter'])
})

test('deduplication is case-insensitive', () => {
  const rowState = {
    tags: [{ tag: 'finance', state: ACCEPTED, confidence: 'high', editedValue: null }],
    relType: null,
    customTags: [],
  }
  const result = getFinalTags(['Finance'], rowState)
  assert.deepStrictEqual(result, ['finance'])
})

test('returns empty array for null csvTags and null rowState', () => {
  const result = getFinalTags(null, null)
  assert.deepStrictEqual(result, [])
})

// ── getFinalRelType ───────────────────────────────────────────────────────────

console.log('\ngetFinalRelType\n')

test('CSV value always wins over AI suggestion', () => {
  const rowState = {
    tags: [], relType: { value: 'Mentor', confidence: 'high', state: ACCEPTED, editedValue: null }, customTags: [],
  }
  const result = getFinalRelType('Recruiter', rowState)
  assert.strictEqual(result, 'Recruiter')
})

test('accepted AI suggestion used when CSV is empty', () => {
  const rowState = {
    tags: [], relType: { value: 'Mentor', confidence: 'high', state: ACCEPTED, editedValue: null }, customTags: [],
  }
  const result = getFinalRelType('', rowState)
  assert.strictEqual(result, 'Mentor')
})

test('edited AI suggestion uses editedValue', () => {
  const rowState = {
    tags: [], relType: { value: 'Mentor', confidence: 'high', state: EDITED, editedValue: 'Collaborator' }, customTags: [],
  }
  const result = getFinalRelType('', rowState)
  assert.strictEqual(result, 'Collaborator')
})

test('rejected suggestion → undefined when no CSV value', () => {
  const rowState = {
    tags: [], relType: { value: 'Mentor', confidence: 'high', state: REJECTED, editedValue: null }, customTags: [],
  }
  const result = getFinalRelType('', rowState)
  assert.strictEqual(result, undefined)
})

test('pending suggestion → undefined', () => {
  const rowState = {
    tags: [], relType: { value: 'Mentor', confidence: 'medium', state: PENDING, editedValue: null }, customTags: [],
  }
  const result = getFinalRelType(undefined, rowState)
  assert.strictEqual(result, undefined)
})

test('null rowState → undefined when no CSV value', () => {
  const result = getFinalRelType('', null)
  assert.strictEqual(result, undefined)
})

test('null rowState with CSV value → CSV value returned', () => {
  const result = getFinalRelType('Recruiter', null)
  assert.strictEqual(result, 'Recruiter')
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
