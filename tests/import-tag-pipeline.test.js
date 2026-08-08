/**
 * import-tag-pipeline.test.js
 *
 * Integration tests for the complete tag transformation pipeline:
 *   CSV tags → buildReviewRows → initSuggestionReview → suggestion mutations
 *   → getFinalTags / getFinalRelType → buildImportPayload → executeBatchImport
 *
 * All modules are pure and Node-testable.
 * Run with: node tests/import-tag-pipeline.test.js
 */
import assert from 'assert'
import {
  SUGGESTION_STATES,
  initSuggestionReview,
  getFinalTags,
  getFinalRelType,
  acceptTagSuggestion,
  rejectTagSuggestion,
  editTagSuggestion,
  addCustomTag,
} from '../src/lib/importSuggestionReview.js'
import {
  buildReviewRows,
  detectDuplicatesInBatch,
  buildImportPayload,
  computeTagSummary,
  computeDoneStats,
  buildDoneStatsLine,
} from '../src/lib/importReviewUtils.js'
import {
  executeBatchImport,
} from '../src/lib/importBatchExecutor.js'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗  ${name}`)
    console.log(`       ${e.message}`)
    failed++
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function makeRow(overrides = {}) {
  return {
    _rowId: 'row-0',
    name: 'Alice Zhang',
    company: 'Goldman Sachs',
    role: 'Analyst',
    tags: [],
    relationship_type: '',
    _isMissingName: false,
    _isDuplicate: false,
    _duplicateOfName: '',
    _suggestion: null,
    _defaultSelected: true,
    ...overrides,
  }
}

function makeSupabase() {
  return {
    from() {
      return {
        insert(items) {
          return {
            select() {
              return Promise.resolve({
                data: items.map((_, i) => ({ id: `db-id-${i}`, name: items[i].name })),
                error: null,
              })
            }
          }
        }
      }
    }
  }
}

// ── Pipeline stage 1: buildReviewRows annotation ──────────────────────────────

console.log('\nbuildReviewRows annotation')

await test('CSV tags pass through to review row', () => {
  const raw = [{ _rowId: 'r0', name: 'Alice', tags: ['recruiter', 'alumni'] }]
  const rows = buildReviewRows(raw)
  assert.deepStrictEqual(rows[0].tags, ['recruiter', 'alumni'])
})

await test('high-confidence AI suggestion attached as _suggestion', () => {
  const raw = [{ _rowId: 'r0', name: 'Alice', tags: [] }]
  const suggestions = { 'r0': { suggested_tags: ['finance'], confidence: 'high' } }
  const rows = buildReviewRows(raw, suggestions)
  assert.ok(rows[0]._suggestion !== null)
  assert.strictEqual(rows[0]._suggestion.confidence, 'high')
})

await test('missing-name rows get _isMissingName=true', () => {
  const raw = [{ _rowId: 'r0', name: '' }]
  const rows = buildReviewRows(raw)
  assert.strictEqual(rows[0]._isMissingName, true)
  assert.strictEqual(rows[0]._defaultSelected, false)
})

await test('duplicate rows get _isDuplicate=true and _defaultSelected=false', () => {
  const raw = [
    { _rowId: 'r0', name: 'Alice' },
    { _rowId: 'r1', name: 'Alice' },
  ]
  const dupes = detectDuplicatesInBatch(raw)
  const rows = buildReviewRows(raw, {}, dupes)
  assert.strictEqual(rows[0]._isDuplicate, false)
  assert.strictEqual(rows[1]._isDuplicate, true)
  assert.strictEqual(rows[1]._defaultSelected, false)
})

// ── Pipeline stage 2: initSuggestionReview ────────────────────────────────────

console.log('\ninitSuggestionReview + mutation pipeline')

await test('high-confidence suggestion → ACCEPTED state', () => {
  const row = makeRow({ _suggestion: { suggested_tags: ['recruiter'], confidence: 'high' } })
  const sr = initSuggestionReview([row])
  const rowState = sr.get('row-0')
  assert.strictEqual(rowState.tags[0].state, SUGGESTION_STATES.ACCEPTED)
})

await test('medium-confidence suggestion → PENDING state', () => {
  const row = makeRow({ _suggestion: { suggested_tags: ['alumni'], confidence: 'medium' } })
  const sr = initSuggestionReview([row])
  const rowState = sr.get('row-0')
  assert.strictEqual(rowState.tags[0].state, SUGGESTION_STATES.PENDING)
})

await test('low-confidence suggestion → PENDING state', () => {
  const row = makeRow({ _suggestion: { suggested_tags: ['mentor'], confidence: 'low' } })
  const sr = initSuggestionReview([row])
  const rowState = sr.get('row-0')
  assert.strictEqual(rowState.tags[0].state, SUGGESTION_STATES.PENDING)
})

await test('accept PENDING tag by stable ID → ACCEPTED', () => {
  const row = makeRow({ _suggestion: { suggested_tags: ['alumni'], confidence: 'medium' } })
  const sr = initSuggestionReview([row])
  const tagId = sr.get('row-0').tags[0].id  // stable ID
  const sr2 = acceptTagSuggestion(sr, 'row-0', tagId)
  assert.strictEqual(sr2.get('row-0').tags[0].state, SUGGESTION_STATES.ACCEPTED)
})

await test('reject PENDING tag by stable ID → REJECTED', () => {
  const row = makeRow({ _suggestion: { suggested_tags: ['alumni'], confidence: 'medium' } })
  const sr = initSuggestionReview([row])
  const tagId = sr.get('row-0').tags[0].id
  const sr2 = rejectTagSuggestion(sr, 'row-0', tagId)
  assert.strictEqual(sr2.get('row-0').tags[0].state, SUGGESTION_STATES.REJECTED)
})

await test('edit PENDING tag by stable ID replaces value and sets EDITED state', () => {
  const row = makeRow({ _suggestion: { suggested_tags: ['alumni'], confidence: 'medium' } })
  const sr = initSuggestionReview([row])
  const tagId = sr.get('row-0').tags[0].id
  const sr2 = editTagSuggestion(sr, 'row-0', tagId, 'vc alumni')
  const tags = sr2.get('row-0').tags
  assert.strictEqual(tags[0].state, SUGGESTION_STATES.EDITED)
  assert.strictEqual(tags[0].editedValue, 'vc alumni')
})

await test('mutation returns new Map — original unchanged (immutability)', () => {
  const row = makeRow({ _suggestion: { suggested_tags: ['recruiter'], confidence: 'medium' } })
  const sr = initSuggestionReview([row])
  const tagId = sr.get('row-0').tags[0].id
  const sr2 = acceptTagSuggestion(sr, 'row-0', tagId)
  assert.strictEqual(sr.get('row-0').tags[0].state, SUGGESTION_STATES.PENDING)
  assert.strictEqual(sr2.get('row-0').tags[0].state, SUGGESTION_STATES.ACCEPTED)
  assert.notStrictEqual(sr, sr2)
})

await test('addCustomTag adds to customTags list', () => {
  const row = makeRow()
  const sr = initSuggestionReview([row])
  const sr2 = addCustomTag(sr, 'row-0', 'connector')
  assert.ok(sr2.get('row-0').customTags.includes('connector'))
})

// ── Pipeline stage 3: getFinalTags ────────────────────────────────────────────

console.log('\ngetFinalTags — full pipeline output')

await test('CSV tags always included regardless of suggestion state', () => {
  const row = makeRow({ tags: ['csv-tag'], _suggestion: { suggested_tags: ['ai-tag'], confidence: 'medium' } })
  const sr = initSuggestionReview([row])
  // pending suggestion → not included yet
  const tags = getFinalTags(['csv-tag'], sr.get('row-0'))
  assert.ok(tags.includes('csv-tag'))
})

await test('ACCEPTED suggestion tags merged with CSV tags', () => {
  const row = makeRow({ tags: ['recruiter'], _suggestion: { suggested_tags: ['alumni'], confidence: 'high' } })
  const sr = initSuggestionReview([row])
  const tags = getFinalTags(['recruiter'], sr.get('row-0'))
  assert.ok(tags.includes('recruiter'))
  assert.ok(tags.includes('alumni'))
})

await test('REJECTED suggestion tags not included', () => {
  const row = makeRow({ _suggestion: { suggested_tags: ['unwanted'], confidence: 'medium' } })
  const sr = initSuggestionReview([row])
  const tagId = sr.get('row-0').tags[0].id  // stable ID for 'unwanted'
  const sr2 = rejectTagSuggestion(sr, 'row-0', tagId)
  const tags = getFinalTags([], sr2.get('row-0'))
  assert.ok(!tags.includes('unwanted'))
})

await test('PENDING suggestion tags not included in final output', () => {
  const row = makeRow({ _suggestion: { suggested_tags: ['pending-tag'], confidence: 'medium' } })
  const sr = initSuggestionReview([row])
  const tags = getFinalTags([], sr.get('row-0'))
  assert.ok(!tags.includes('pending-tag'))
})

await test('custom tags always included', () => {
  const row = makeRow()
  const sr = initSuggestionReview([row])
  const sr2 = addCustomTag(sr, 'row-0', 'my-tag')
  const tags = getFinalTags([], sr2.get('row-0'))
  assert.ok(tags.includes('my-tag'))
})

await test('deduplication: CSV tag and ACCEPTED ai tag with same value → appear once', () => {
  const row = makeRow({ tags: ['recruiter'], _suggestion: { suggested_tags: ['recruiter'], confidence: 'high' } })
  const sr = initSuggestionReview([row])
  const tags = getFinalTags(['recruiter'], sr.get('row-0'))
  const count = tags.filter(t => t === 'recruiter').length
  assert.strictEqual(count, 1)
})

// ── Pipeline stage 4: getFinalRelType ─────────────────────────────────────────

console.log('\ngetFinalRelType — relationship type pipeline')

await test('CSV relationship_type always wins over AI suggestion', () => {
  const row = makeRow({
    relationship_type: 'Mentor',
    _suggestion: { suggested_relationship_type: 'Collaborator', confidence: 'high' },
  })
  const sr = initSuggestionReview([row])
  const rel = getFinalRelType('Mentor', sr.get('row-0'))
  assert.strictEqual(rel, 'Mentor')
})

await test('ACCEPTED AI suggestion used when no CSV relationship_type', () => {
  const row = makeRow({
    relationship_type: '',
    _suggestion: { suggested_relationship_type: 'Mentor', confidence: 'high' },
  })
  const sr = initSuggestionReview([row])
  const rel = getFinalRelType('', sr.get('row-0'))
  assert.strictEqual(rel, 'Mentor')
})

await test('PENDING suggestion not included (returns undefined)', () => {
  const row = makeRow({
    relationship_type: '',
    _suggestion: { suggested_relationship_type: 'Mentor', confidence: 'medium' },
  })
  const sr = initSuggestionReview([row])
  const rel = getFinalRelType('', sr.get('row-0'))
  assert.strictEqual(rel, undefined)
})

// ── Pipeline stage 5: buildImportPayload ──────────────────────────────────────

console.log('\nbuildImportPayload — DB payload construction')

await test('produces clean rows for DB insert', () => {
  const rows = [makeRow({ tags: ['recruiter'] })]
  const selected = new Set(['row-0'])
  const payload = buildImportPayload(rows, selected, 'user-123')
  assert.strictEqual(payload.length, 1)
  assert.strictEqual(payload[0].name, 'Alice Zhang')
  assert.strictEqual(payload[0].user_id, 'user-123')
})

await test('_* fields stripped from payload', () => {
  const rows = [makeRow()]
  const payload = buildImportPayload(rows, new Set(['row-0']), 'u1')
  const keys = Object.keys(payload[0])
  const privateKeys = keys.filter(k => k.startsWith('_'))
  assert.strictEqual(privateKeys.length, 0, `private keys found: ${privateKeys.join(', ')}`)
})

await test('unselected rows not in payload', () => {
  const rows = [
    makeRow({ _rowId: 'row-0', name: 'Alice' }),
    makeRow({ _rowId: 'row-1', name: 'Bob' }),
  ]
  const payload = buildImportPayload(rows, new Set(['row-0']), 'u1')
  assert.strictEqual(payload.length, 1)
  assert.strictEqual(payload[0].name, 'Alice')
})

await test('nameless rows silently dropped from payload', () => {
  const rows = [makeRow({ _rowId: 'row-0', name: '' })]
  const payload = buildImportPayload(rows, new Set(['row-0']), 'u1')
  assert.strictEqual(payload.length, 0)
})

await test('high-confidence AI suggestion applied in payload when _suggestion not null', () => {
  const rows = [makeRow({
    tags: [],
    _suggestion: { suggested_tags: ['recruiter'], confidence: 'high' },
  })]
  const payload = buildImportPayload(rows, new Set(['row-0']), 'u1')
  assert.ok(payload[0].tags.includes('recruiter'), 'high-confidence tag must appear in payload')
})

// ── End-to-end pipeline: initSuggestionReview → getFinalTags → executeBatchImport ──

console.log('\nend-to-end tag pipeline integration')

await test('accepted suggestions propagate through to DB payload', async () => {
  const rawRow = makeRow({
    tags: ['finance'],
    _suggestion: { suggested_tags: ['technology'], confidence: 'medium' },
  })
  // Step 1: init suggestion review — technology is PENDING
  let sr = initSuggestionReview([rawRow])
  // Step 2: user accepts "technology" by stable ID
  const techTagId = sr.get('row-0').tags[0].id
  sr = acceptTagSuggestion(sr, 'row-0', techTagId)
  // Step 3: pre-apply in handleImportReview pattern
  const resolvedRow = {
    ...rawRow,
    tags: getFinalTags(rawRow.tags, sr.get('row-0')),
    relationship_type: getFinalRelType(rawRow.relationship_type, sr.get('row-0')) ?? rawRow.relationship_type,
    _suggestion: null,
  }
  // Step 4: build payload
  const payload = buildImportPayload([resolvedRow], new Set(['row-0']), 'u1')
  assert.ok(payload[0].tags.includes('finance'), 'CSV tag must be preserved')
  assert.ok(payload[0].tags.includes('technology'), 'accepted AI tag must be included')
})

await test('rejected suggestions excluded from DB payload', async () => {
  const rawRow = makeRow({
    tags: [],
    _suggestion: { suggested_tags: ['unwanted-category'], confidence: 'medium' },
  })
  let sr = initSuggestionReview([rawRow])
  const unwantedTagId = sr.get('row-0').tags[0].id
  sr = rejectTagSuggestion(sr, 'row-0', unwantedTagId)
  const resolvedRow = {
    ...rawRow,
    tags: getFinalTags(rawRow.tags, sr.get('row-0')),
    _suggestion: null,
  }
  const payload = buildImportPayload([resolvedRow], new Set(['row-0']), 'u1')
  assert.ok(!payload[0].tags.includes('unwanted-category'))
})

await test('null _suggestion after pre-apply prevents double-application in buildImportPayload', () => {
  // buildImportPayload still applies _suggestion if not null. Setting to null prevents re-application.
  const rawRow = makeRow({
    tags: ['ai-already-applied'],
    _suggestion: { suggested_tags: ['ai-already-applied'], confidence: 'high' },
  })
  const resolvedRow = { ...rawRow, _suggestion: null }
  const payload = buildImportPayload([resolvedRow], new Set(['row-0']), 'u1')
  const count = (payload[0].tags || []).filter(t => t === 'ai-already-applied').length
  assert.strictEqual(count, 1, 'tag must appear exactly once — no double-application')
})

await test('executeBatchImport runs after pre-apply pipeline and strips _* fields', async () => {
  const rawRow = makeRow({
    tags: ['recruiter'],
    _suggestion: { suggested_tags: ['alumni'], confidence: 'high' },
  })
  let sr = initSuggestionReview([rawRow])
  const resolvedRow = {
    ...rawRow,
    tags: getFinalTags(rawRow.tags, sr.get('row-0')),
    relationship_type: getFinalRelType(rawRow.relationship_type, sr.get('row-0')) ?? rawRow.relationship_type,
    _suggestion: null,
  }
  const payload = buildImportPayload([resolvedRow], new Set(['row-0']), 'u1')
  // payloadItems have no _* keys (buildImportPayload already strips them)
  // executeBatchImport also strips — belt-and-suspenders
  let sentToDb = null
  const supabase = {
    from() {
      return {
        insert(items) {
          sentToDb = items[0]
          return { select() { return Promise.resolve({ data: [{ id: 'db-1', name: items[0].name }], error: null }) } }
        }
      }
    }
  }
  const result = await executeBatchImport(payload, supabase)
  assert.strictEqual(result.successful, 1)
  assert.ok(!sentToDb || !Object.keys(sentToDb).some(k => k.startsWith('_')), 'no _* fields must reach DB')
})

// ── computeTagSummary ─────────────────────────────────────────────────────────

console.log('\ncomputeTagSummary — bulk tag aggregation')

await test('counts tags across rows by confidence', () => {
  const rows = [
    makeRow({ _rowId: 'r0', _suggestion: { suggested_tags: ['finance'], confidence: 'high' } }),
    makeRow({ _rowId: 'r1', _suggestion: { suggested_tags: ['finance', 'banking'], confidence: 'high' } }),
    makeRow({ _rowId: 'r2', _suggestion: { suggested_tags: ['banking'], confidence: 'medium' } }),
  ]
  const summary = computeTagSummary(rows)
  const finance = summary.find(s => s.tag === 'finance')
  const banking = summary.find(s => s.tag === 'banking')
  assert.strictEqual(finance.count, 2)
  assert.strictEqual(banking.count, 2)
})

await test('sorted by count descending', () => {
  const rows = [
    makeRow({ _rowId: 'r0', _suggestion: { suggested_tags: ['finance', 'banking', 'consulting'], confidence: 'high' } }),
    makeRow({ _rowId: 'r1', _suggestion: { suggested_tags: ['finance', 'banking'], confidence: 'high' } }),
    makeRow({ _rowId: 'r2', _suggestion: { suggested_tags: ['finance'], confidence: 'high' } }),
  ]
  const summary = computeTagSummary(rows)
  assert.strictEqual(summary[0].tag, 'finance') // 3 occurrences
  assert.strictEqual(summary[1].tag, 'banking')  // 2 occurrences
})

await test('rows without _suggestion not counted', () => {
  const rows = [makeRow({ _rowId: 'r0', tags: ['recruiter'], _suggestion: null })]
  const summary = computeTagSummary(rows)
  assert.strictEqual(summary.length, 0)
})

// ── computeDoneStats + buildDoneStatsLine ─────────────────────────────────────

console.log('\ncomputeDoneStats + buildDoneStatsLine')

await test('computeDoneStats counts all annotation fields correctly', () => {
  const rows = [
    makeRow({ _rowId: 'r0', _isMissingName: false, _isDuplicate: false }),
    makeRow({ _rowId: 'r1', _isMissingName: true,  _isDuplicate: false }),
    makeRow({ _rowId: 'r2', _isMissingName: false, _isDuplicate: true  }),
    makeRow({ _rowId: 'r3', _isMissingName: false, _isDuplicate: true  }),
  ]
  const stats = computeDoneStats(rows, 1)
  assert.strictEqual(stats.importedCount, 1)
  assert.strictEqual(stats.missingNameCount, 1)
  assert.strictEqual(stats.duplicatesSkipped, 2)
})

await test('buildDoneStatsLine includes top 2 tags and skips', () => {
  const tagSummary = [
    { tag: 'recruiter', count: 5 },
    { tag: 'alumni', count: 3 },
    { tag: 'mentor', count: 1 },
  ]
  const stats = { duplicatesSkipped: 2, missingNameCount: 1 }
  const line = buildDoneStatsLine(tagSummary, stats)
  assert.ok(line.includes('recruiter'), 'top tag must appear')
  assert.ok(line.includes('alumni'), 'second tag must appear')
  assert.ok(!line.includes('mentor'), 'third tag excluded from top 2')
  assert.ok(line.includes('duplicate'))
  assert.ok(line.includes('name'))
})

await test('buildDoneStatsLine with no skips or name issues', () => {
  const line = buildDoneStatsLine([], { duplicatesSkipped: 0, missingNameCount: 0 })
  assert.strictEqual(line, '')
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
