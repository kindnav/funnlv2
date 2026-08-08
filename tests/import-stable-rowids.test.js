/**
 * import-stable-rowids.test.js
 *
 * Verifies that the _rowId scheme is stable across Map→Review navigation cycles,
 * and that suggestion-review decisions keyed by _rowId survive Back→Review.
 *
 * Uses only pure functions from importReviewUtils + importSuggestionReview.
 * No React, no DOM, no Supabase.
 *
 * Run with: node tests/import-stable-rowids.test.js
 */
import assert from 'assert'
import {
  buildReviewRows,
  detectDuplicatesInBatch,
} from '../src/lib/importReviewUtils.js'
import {
  initSuggestionReview,
  acceptTagSuggestion,
  rejectTagSuggestion,
  SUGGESTION_STATES,
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

// ── Stable ID format ─────────────────────────────────────────────────────────

// The ID format produced by the modal is:  f${fileRunId}:${sourceRowIndex}
// We simulate two consecutive file loads (fileRunId 1 and 2).

function makeRowId(fileRunId, sourceIndex) {
  return `f${fileRunId}:${sourceIndex}`
}

function makeContacts(fileRunId, names) {
  return names.map((name, i) => ({ _rowId: makeRowId(fileRunId, i), name }))
}

console.log('\nrow ID format')

test('row ID is f{run}:{index}', () => {
  assert.strictEqual(makeRowId(1, 0), 'f1:0')
  assert.strictEqual(makeRowId(1, 4), 'f1:4')
  assert.strictEqual(makeRowId(2, 0), 'f2:0')
})

test('IDs are unique within a file run', () => {
  const ids = [0, 1, 2, 3, 4].map(i => makeRowId(1, i))
  assert.strictEqual(new Set(ids).size, 5)
})

test('IDs are unique across file runs', () => {
  const run1 = makeRowId(1, 0)
  const run2 = makeRowId(2, 0)
  assert.notStrictEqual(run1, run2)
})

test('IDs do not reuse between file loads', () => {
  // Simulates: load file A (run 1), then load file B (run 2)
  const run1Ids = [0, 1, 2].map(i => makeRowId(1, i))
  const run2Ids = [0, 1, 2].map(i => makeRowId(2, i))
  const allIds = [...run1Ids, ...run2Ids]
  assert.strictEqual(new Set(allIds).size, 6)
})

// ── Decision preservation across Map→Review cycles ───────────────────────────

console.log('\ndecision preservation across Back→Review navigation')

function makeSuggestion(tags) {
  return { suggested_tags: tags, suggested_relationship_type: null, confidence: 'medium' }
}

test('initSuggestionReview preserves decisions for existing rowIds', () => {
  const fileRunId = 1
  const contacts = makeContacts(fileRunId, ['Alice', 'Bob', 'Carol'])
  const suggestions = {
    [makeRowId(fileRunId, 0)]: makeSuggestion(['recruiter', 'finance']),
    [makeRowId(fileRunId, 1)]: makeSuggestion(['alumni']),
  }

  const dups = detectDuplicatesInBatch(contacts)
  const rRows = buildReviewRows(contacts, suggestions, dups)

  // First visit to Review: initialize state
  const state1 = initSuggestionReview(rRows, undefined)
  assert.ok(state1.has(makeRowId(fileRunId, 0)))
  assert.ok(state1.has(makeRowId(fileRunId, 1)))

  // User accepts one tag on Alice — use stable suggestion ID from initialized state
  const aliceRowId = makeRowId(fileRunId, 0)
  const aliceTagId = state1.get(aliceRowId).tags[0].id  // stable ID (not index)
  const state2 = acceptTagSuggestion(state1, aliceRowId, aliceTagId)
  const aliceState = state2.get(aliceRowId)
  assert.strictEqual(aliceState.tags[0].state, SUGGESTION_STATES.ACCEPTED)

  // User goes Back to Map and returns to Review — same rows, same fileRunId
  // initSuggestionReview called again with previous state
  const state3 = initSuggestionReview(rRows, state2)
  const aliceAfterNav = state3.get(aliceRowId)
  assert.strictEqual(aliceAfterNav.tags[0].state, SUGGESTION_STATES.ACCEPTED,
    'acceptance decision survives Back→Review navigation')
})

test('new file load does not bleed decisions from prior load', () => {
  const run1 = 1
  const run2 = 2
  const contacts1 = makeContacts(run1, ['Alice', 'Bob'])
  const contacts2 = makeContacts(run2, ['Alice', 'Bob'])
  const sug1 = { [makeRowId(run1, 0)]: makeSuggestion(['recruiter']) }
  const sug2 = { [makeRowId(run2, 0)]: makeSuggestion(['alumni']) }

  const rRows1 = buildReviewRows(contacts1, sug1, new Map())
  const state1 = initSuggestionReview(rRows1, undefined)
  // Accept using stable suggestion ID from initialized state
  const run1RowId = makeRowId(run1, 0)
  const run1TagId = state1.get(run1RowId).tags[0].id
  const stateModified = acceptTagSuggestion(state1, run1RowId, run1TagId)

  // Load second file (new fileRunId) — prior state should not apply
  const rRows2 = buildReviewRows(contacts2, sug2, new Map())
  const state2 = initSuggestionReview(rRows2, stateModified)
  const aliceRun2 = state2.get(makeRowId(run2, 0))

  // run2:0 and run1:0 are different keys — run2 Alice is PENDING (medium confidence)
  assert.strictEqual(aliceRun2.tags[0].state, SUGGESTION_STATES.PENDING,
    'run-2 Alice starts fresh: prior run-1 decisions do not bleed')
})

test('decisions survive across multiple Back→Review cycles', () => {
  const fileRunId = 3
  const contacts = makeContacts(fileRunId, ['X', 'Y'])
  const sug = {
    [makeRowId(fileRunId, 0)]: makeSuggestion(['vc', 'pe']),
    [makeRowId(fileRunId, 1)]: makeSuggestion(['banking']),
  }
  const rRows = buildReviewRows(contacts, sug, new Map())

  let state = initSuggestionReview(rRows, undefined)

  // Cycle 1: accept first tag on X, reject second (using stable IDs)
  const xRowId   = makeRowId(fileRunId, 0)
  const vcTagId  = state.get(xRowId).tags[0].id
  const peTagId  = state.get(xRowId).tags[1].id
  state = acceptTagSuggestion(state, xRowId, vcTagId)
  state = rejectTagSuggestion(state, xRowId, peTagId)

  // Cycle 2: Back→Review again
  state = initSuggestionReview(rRows, state)
  const xState = state.get(xRowId)
  assert.strictEqual(xState.tags[0].state, SUGGESTION_STATES.ACCEPTED)
  assert.strictEqual(xState.tags[1].state, SUGGESTION_STATES.REJECTED)

  // Cycle 3: Back→Review again (no changes between)
  state = initSuggestionReview(rRows, state)
  const xState3 = state.get(xRowId)
  assert.strictEqual(xState3.tags[0].state, SUGGESTION_STATES.ACCEPTED)
  assert.strictEqual(xState3.tags[1].state, SUGGESTION_STATES.REJECTED)
})

// ── ID stability under simulated reorder / filter ────────────────────────────

console.log('\nID stability under simulated array operations')

test('row ID is stable regardless of displayed array order', () => {
  const fileRunId = 4
  // Original order: Alice(0), Bob(1), Carol(2)
  const contacts = makeContacts(fileRunId, ['Alice', 'Bob', 'Carol'])
  const sug = {
    [makeRowId(fileRunId, 1)]: makeSuggestion(['finance']),
  }
  const rRows = buildReviewRows(contacts, sug, new Map())
  let state = initSuggestionReview(rRows, undefined)

  // Accept Bob's tag using stable suggestion ID
  const bobRowId = makeRowId(fileRunId, 1)
  const bobTagId = state.get(bobRowId).tags[0].id
  state = acceptTagSuggestion(state, bobRowId, bobTagId)

  // Simulate "reorder" by reversing the array (display only — IDs don't change)
  const reversed = [...rRows].reverse()
  state = initSuggestionReview(reversed, state)

  // Bob is still identified by makeRowId(4,1), not by position
  const bob = state.get(bobRowId)
  assert.strictEqual(bob.tags[0].state, SUGGESTION_STATES.ACCEPTED,
    'Bob keeps accepted tag after array reversal')
})

test('row ID is stable after a name-fix operation (row stays at same index)', () => {
  const fileRunId = 5
  const contacts = [
    { _rowId: makeRowId(fileRunId, 0), name: '' },      // initially missing name
    { _rowId: makeRowId(fileRunId, 1), name: 'Bob' },
  ]
  const sug = { [makeRowId(fileRunId, 0)]: makeSuggestion(['analyst']) }
  const rRows = buildReviewRows(contacts, sug, new Map())
  let state = initSuggestionReview(rRows, undefined)

  // User accepts the suggestion for the nameless row BEFORE fixing the name (stable ID)
  const namelessRowId = makeRowId(fileRunId, 0)
  const analystTagId  = state.get(namelessRowId).tags[0].id
  state = acceptTagSuggestion(state, namelessRowId, analystTagId)

  // Simulate name fix: the row object is updated but _rowId stays the same
  const fixedRows = rRows.map(r =>
    r._rowId === namelessRowId
      ? { ...r, name: 'Alice Fixed', _isMissingName: false }
      : r
  )

  // Re-init with fixed rows — decision preserved because _rowId unchanged
  state = initSuggestionReview(fixedRows, state)
  const aliceFixed = state.get(namelessRowId)
  assert.strictEqual(aliceFixed.tags[0].state, SUGGESTION_STATES.ACCEPTED,
    'accepted suggestion survives name-fix (same _rowId)')
})

// ── getFinalTags respects suggestion decisions keyed by stable ID ─────────────

console.log('\ngetFinalTags with stable IDs')

test('getFinalTags merges accepted AI tag into CSV tags for correct row', () => {
  const fileRunId = 6
  const contacts = makeContacts(fileRunId, ['Alice', 'Bob'])
  const sug = {
    [makeRowId(fileRunId, 0)]: makeSuggestion(['recruiter']),
  }
  const rRows = buildReviewRows(contacts, sug, new Map())
  let state = initSuggestionReview(rRows, undefined)
  const aliceRowId = makeRowId(fileRunId, 0)
  const recruiterTagId = state.get(aliceRowId).tags[0].id
  state = acceptTagSuggestion(state, aliceRowId, recruiterTagId)

  const aliceTags = getFinalTags(['banking'], state.get(aliceRowId))
  const bobTags   = getFinalTags([], state.get(makeRowId(fileRunId, 1)))

  assert.deepStrictEqual(aliceTags, ['banking', 'recruiter'])
  assert.deepStrictEqual(bobTags, [])
})

test('getFinalTags does not apply rejected suggestion', () => {
  const fileRunId = 7
  const contacts = makeContacts(fileRunId, ['Alice'])
  const sug = { [makeRowId(fileRunId, 0)]: makeSuggestion(['alumni']) }
  const rRows = buildReviewRows(contacts, sug, new Map())
  let state = initSuggestionReview(rRows, undefined)
  const aliceRowId  = makeRowId(fileRunId, 0)
  const alumniTagId = state.get(aliceRowId).tags[0].id
  state = rejectTagSuggestion(state, aliceRowId, alumniTagId)

  const tags = getFinalTags([], state.get(aliceRowId))
  assert.deepStrictEqual(tags, [], 'rejected suggestion must not appear in final tags')
})

// ── Import modal source assertions (static) ───────────────────────────────────

console.log('\nmodal source — stable ID contract')

import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dirname, '../src/components/ImportContactsModal.jsx'), 'utf8')

test('modal declares fileRunIdRef', () => {
  assert.ok(src.includes('fileRunIdRef'), 'must declare fileRunIdRef for stable per-file run ID')
})

test('modal increments fileRunIdRef on file parse', () => {
  assert.ok(
    src.includes('fileRunIdRef.current++'),
    'must increment fileRunIdRef.current in handleFile'
  )
})

test('modal uses f{fileRunId}:{sourceRowNumber} pattern for _rowId', () => {
  assert.ok(
    src.includes('`f${fileRunId}:${row._sourceRowNumber}`') ||
    src.includes('`f${fileRunId}:${i}`') ||
    src.includes("'f' + fileRunId + ':' + i"),
    'must use f{run}:{sourceRowNumber} format for _rowId in goToReview'
  )
})

test('modal captures fileRunId before allContacts map', () => {
  // fileRunId must be captured outside the .map() so it is consistent per call
  assert.ok(
    src.includes('const fileRunId = fileRunIdRef.current'),
    'fileRunId must be captured as a local const before the rows.map()'
  )
})

test('modal does NOT use raw row-${i} pattern after stable ID refactor', () => {
  // The old pattern was `row-${i}` — check it is gone from the _rowId assignment
  const assignmentLine = src.match(/_rowId:.*`row-\$\{i\}`/)
  assert.ok(!assignmentLine, 'old row-${i} _rowId assignment must be removed')
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
