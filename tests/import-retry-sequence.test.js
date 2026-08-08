/**
 * import-retry-sequence.test.js
 *
 * Proves retryBatchImport idempotency for a multi-step retry sequence.
 *
 * Sequence under test:
 *   1. Initial import [A, B, C, D]: A and B succeed; C and D fail.
 *   2. Retry [C, D]: C succeeds; D fails.
 *   3. Retry [D]: D succeeds.
 *
 * Invariants verified:
 *   - A and B are never retried (never passed to supabase again).
 *   - C is not retried after its success in step 2.
 *   - D is inserted exactly once (in the final retry step).
 *   - No contact ID appears twice in successfulIds.
 *   - No source-row ID appears in both final success and final failure.
 *   - Browse-imported list contains A, B, C, D exactly once.
 *   - Chooser contacts contain A, B, C, D exactly once.
 *
 * Mock design note:
 *   executeBatchImport batches ALL items in one DB insert call when count < BATCH_SIZE (25).
 *   Per-row success/failure is controlled by returning partial data arrays: success rows get
 *   { id, name }, fail rows get null. The executor's `inserted?.id` check handles nulls
 *   as the "partial batch success: row data missing" code path. This avoids a batch-level
 *   error which would mark ALL rows (including A+B) as failed in the same call.
 *
 * Run with: node tests/import-retry-sequence.test.js
 */
import assert from 'assert'
import { executeBatchImport, retryBatchImport } from '../src/lib/importBatchExecutor.js'

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeItem(rowId, name) {
  return { _rowId: rowId, name, company: 'Acme' }
}

/**
 * Build a Supabase mock that returns per-row success or failure within one batch call.
 *
 * Rows in successSet → returned as { id: `db-${rowId}`, name } in the data array.
 * Rows in failSet    → returned as null in the data array (triggers the executor's
 *                      "partial batch success: insert succeeded but row data missing" path).
 * Unknown rows (not in either set) → returned as null (treated as failed).
 *
 * The mock derives rowId from the row's `name` field using the naming convention
 * `name = 'contact-${rowId}'` used in makeItem() above.
 *
 * insertedRowIds tracks every rowId for which a non-null data row was returned,
 * so tests can assert "D was inserted exactly N times across all steps."
 */
function makeSelectiveMock(successSet, failSet) {
  const insertedRowIds = []

  const mock = {
    insertedRowIds,
    from() {
      return {
        insert(rows) {
          return {
            select() {
              const data = rows.map(r => {
                // _rowId is stripped before insert; recover it from the name convention.
                const rowId = r.name.replace(/^contact-/, '')
                if (failSet.has(rowId)) {
                  return null // executor treats missing id as "row failed"
                }
                insertedRowIds.push(rowId)
                return { id: `db-${rowId}`, name: r.name }
              })
              return Promise.resolve({ data, error: null })
            },
          }
        },
      }
    },
  }
  return mock
}

// ── Full retry sequence ───────────────────────────────────────────────────────

console.log('\nfull 3-step retry sequence')

await test('step 1: all four submitted; A and B succeed, C and D fail', async () => {
  const items = [
    makeItem('row-A', 'contact-row-A'),
    makeItem('row-B', 'contact-row-B'),
    makeItem('row-C', 'contact-row-C'),
    makeItem('row-D', 'contact-row-D'),
  ]
  // Mock: A+B → non-null data; C+D → null (fail path via missing id)
  const mock = makeSelectiveMock(new Set(['row-A', 'row-B']), new Set(['row-C', 'row-D']))
  const result = await executeBatchImport(items, mock)

  assert.strictEqual(result.attempted, 4, 'all 4 rows attempted')
  assert.strictEqual(result.successful, 2, '2 succeed')
  assert.strictEqual(result.failed, 2, '2 fail')
  assert.ok(result.successfulIds.includes('db-row-A'), 'A in successfulIds')
  assert.ok(result.successfulIds.includes('db-row-B'), 'B in successfulIds')
  assert.ok(result.failedRowIds.includes('row-C'), 'C in failedRowIds')
  assert.ok(result.failedRowIds.includes('row-D'), 'D in failedRowIds')
  assert.ok(!result.successfulIds.includes('db-row-C'), 'C not in successfulIds')
  assert.ok(!result.successfulIds.includes('db-row-D'), 'D not in successfulIds')
  assert.strictEqual(result.failedPayloadItems.length, 2, '2 items queued for retry')
  // C and D are queued for retry
  const retryIds = result.failedPayloadItems.map(p => p._rowId)
  assert.ok(retryIds.includes('row-C'))
  assert.ok(retryIds.includes('row-D'))
})

await test('step 2: retry [C, D]; C succeeds, D still fails', async () => {
  const items = [
    makeItem('row-A', 'contact-row-A'),
    makeItem('row-B', 'contact-row-B'),
    makeItem('row-C', 'contact-row-C'),
    makeItem('row-D', 'contact-row-D'),
  ]
  const step1Mock = makeSelectiveMock(new Set(['row-A', 'row-B']), new Set(['row-C', 'row-D']))
  const step1Result = await executeBatchImport(items, step1Mock)

  // Retry with only C succeeding, D still failing
  const step2Mock = makeSelectiveMock(new Set(['row-C']), new Set(['row-D']))
  const step2Result = await retryBatchImport(step1Result.failedPayloadItems, step1Result, step2Mock)

  assert.strictEqual(step2Result.attempted, 2, 'retry attempted = 2 (C and D only)')
  assert.strictEqual(step2Result.successful, 1, 'retry successful = 1 (C only)')
  assert.strictEqual(step2Result.failed, 1, 'retry failed = 1 (D only)')
  assert.strictEqual(step2Result.skipped, 2, 'prior successes A+B = 2 skipped')

  // Combined successfulIds = [A, B, C]
  assert.ok(step2Result.successfulIds.includes('db-row-A'), 'A still in successfulIds')
  assert.ok(step2Result.successfulIds.includes('db-row-B'), 'B still in successfulIds')
  assert.ok(step2Result.successfulIds.includes('db-row-C'), 'C now in successfulIds')
  assert.ok(!step2Result.successfulIds.includes('db-row-D'), 'D not yet in successfulIds')

  // D still failing
  assert.ok(step2Result.failedRowIds.includes('row-D'), 'D still in failedRowIds')
  assert.strictEqual(step2Result.failedPayloadItems.length, 1, 'D queued for next retry')

  // A and B were NOT re-inserted in step 2
  assert.ok(!step2Mock.insertedRowIds.includes('row-A'), 'A not re-inserted')
  assert.ok(!step2Mock.insertedRowIds.includes('row-B'), 'B not re-inserted')
})

await test('step 3: retry [D]; D succeeds; all four now successful', async () => {
  const items = [
    makeItem('row-A', 'contact-row-A'),
    makeItem('row-B', 'contact-row-B'),
    makeItem('row-C', 'contact-row-C'),
    makeItem('row-D', 'contact-row-D'),
  ]
  const step1Mock = makeSelectiveMock(new Set(['row-A', 'row-B']), new Set(['row-C', 'row-D']))
  const step1Result = await executeBatchImport(items, step1Mock)

  const step2Mock = makeSelectiveMock(new Set(['row-C']), new Set(['row-D']))
  const step2Result = await retryBatchImport(step1Result.failedPayloadItems, step1Result, step2Mock)

  const step3Mock = makeSelectiveMock(new Set(['row-D']), new Set())
  const step3Result = await retryBatchImport(step2Result.failedPayloadItems, step2Result, step3Mock)

  assert.strictEqual(step3Result.attempted, 1, 'step-3 attempted = 1 (D only)')
  assert.strictEqual(step3Result.successful, 1, 'step-3 successful = 1')
  assert.strictEqual(step3Result.failed, 0, 'step-3 failed = 0')
  assert.strictEqual(step3Result.failedPayloadItems.length, 0, 'nothing left to retry')

  // All four IDs present in final successfulIds
  const all = step3Result.successfulIds
  assert.ok(all.includes('db-row-A'), 'A present')
  assert.ok(all.includes('db-row-B'), 'B present')
  assert.ok(all.includes('db-row-C'), 'C present')
  assert.ok(all.includes('db-row-D'), 'D present')

  // No duplicates in successfulIds
  assert.strictEqual(new Set(all).size, all.length, 'no duplicate IDs in successfulIds')

  // D inserted exactly once (step 3 only, not in steps 1 or 2)
  const dInserts = [
    ...step1Mock.insertedRowIds,
    ...step2Mock.insertedRowIds,
    ...step3Mock.insertedRowIds,
  ].filter(id => id === 'row-D')
  assert.strictEqual(dInserts.length, 1, 'D inserted exactly once across all steps')

  // Chooser list contains A, B, C, D exactly once
  const contactNames = step3Result.successfulContacts.map(c => c.name)
  assert.strictEqual(contactNames.filter(n => n === 'contact-row-A').length, 1, 'chooser has A once')
  assert.strictEqual(contactNames.filter(n => n === 'contact-row-B').length, 1, 'chooser has B once')
  assert.strictEqual(contactNames.filter(n => n === 'contact-row-C').length, 1, 'chooser has C once')
  assert.strictEqual(contactNames.filter(n => n === 'contact-row-D').length, 1, 'chooser has D once')
})

// ── A and B never re-inserted ─────────────────────────────────────────────────

console.log('\nA and B never re-inserted on retry')

await test('A and B are not passed to supabase on any retry step', async () => {
  const items = [
    makeItem('row-A', 'contact-row-A'),
    makeItem('row-B', 'contact-row-B'),
    makeItem('row-C', 'contact-row-C'),
  ]
  const step1Mock = makeSelectiveMock(new Set(['row-A', 'row-B']), new Set(['row-C']))
  const step1 = await executeBatchImport(items, step1Mock)

  const step2Mock = makeSelectiveMock(new Set(['row-C']), new Set())
  await retryBatchImport(step1.failedPayloadItems, step1, step2Mock)

  assert.ok(!step2Mock.insertedRowIds.includes('row-A'), 'A not re-inserted')
  assert.ok(!step2Mock.insertedRowIds.includes('row-B'), 'B not re-inserted')
  assert.ok(step2Mock.insertedRowIds.includes('row-C'), 'C inserted in retry')
})

// ── No source-row ID in both success and failure ──────────────────────────────

console.log('\nno row ID in both success and failure simultaneously')

await test('final result has disjoint successfulIds and failedRowIds', async () => {
  const items = [
    makeItem('r0', 'contact-r0'),
    makeItem('r1', 'contact-r1'),
    makeItem('r2', 'contact-r2'),
  ]
  const step1Mock = makeSelectiveMock(new Set(['r0']), new Set(['r1', 'r2']))
  const step1 = await executeBatchImport(items, step1Mock)

  const step2Mock = makeSelectiveMock(new Set(['r1']), new Set(['r2']))
  const step2 = await retryBatchImport(step1.failedPayloadItems, step1, step2Mock)

  // No failedRowId maps to a successfulId (they store different formats but can be correlated)
  const successDbIds = new Set(step2.successfulIds)
  for (const failedId of step2.failedRowIds) {
    assert.ok(
      !successDbIds.has(`db-${failedId}`),
      `${failedId} must not appear in both success and failure`,
    )
  }
})

// ── C not retried after its success ──────────────────────────────────────────

console.log('\nC not retried after its success in step 2')

await test('step 2 failedPayloadItems contains only D, not C', async () => {
  const items = [
    makeItem('row-A', 'contact-row-A'),
    makeItem('row-B', 'contact-row-B'),
    makeItem('row-C', 'contact-row-C'),
    makeItem('row-D', 'contact-row-D'),
  ]
  const step1Mock = makeSelectiveMock(new Set(['row-A', 'row-B']), new Set(['row-C', 'row-D']))
  const step1 = await executeBatchImport(items, step1Mock)

  const step2Mock = makeSelectiveMock(new Set(['row-C']), new Set(['row-D']))
  const step2 = await retryBatchImport(step1.failedPayloadItems, step1, step2Mock)

  // After step 2, only D remains in failedPayloadItems
  const retryableIds = step2.failedPayloadItems.map(p => p._rowId)
  assert.ok(!retryableIds.includes('row-C'), 'C not in step-2 failedPayloadItems')
  assert.ok(retryableIds.includes('row-D'), 'D still in step-2 failedPayloadItems')
})

await test('step 3 mock receives D but not C or A or B', async () => {
  const items = [
    makeItem('row-A', 'contact-row-A'),
    makeItem('row-B', 'contact-row-B'),
    makeItem('row-C', 'contact-row-C'),
    makeItem('row-D', 'contact-row-D'),
  ]
  const step1Mock = makeSelectiveMock(new Set(['row-A', 'row-B']), new Set(['row-C', 'row-D']))
  const step1 = await executeBatchImport(items, step1Mock)

  const step2Mock = makeSelectiveMock(new Set(['row-C']), new Set(['row-D']))
  const step2 = await retryBatchImport(step1.failedPayloadItems, step1, step2Mock)

  const step3Mock = makeSelectiveMock(new Set(['row-D']), new Set())
  await retryBatchImport(step2.failedPayloadItems, step2, step3Mock)

  // step3Mock only inserted D
  assert.strictEqual(step3Mock.insertedRowIds.length, 1, 'step 3 inserted exactly 1 row')
  assert.strictEqual(step3Mock.insertedRowIds[0], 'row-D', 'that row is D')
})

// ── Empty retry input ─────────────────────────────────────────────────────────

console.log('\nempty retry input')

await test('retryBatchImport with empty failedPayloadItems returns previousResult unchanged', async () => {
  const items = [makeItem('r0', 'contact-r0')]
  const step1Mock = makeSelectiveMock(new Set(['r0']), new Set())
  const step1 = await executeBatchImport(items, step1Mock)

  const step2Mock = makeSelectiveMock(new Set(), new Set())
  const step2 = await retryBatchImport([], step1, step2Mock)

  assert.deepStrictEqual(step2, step1, 'empty retry returns previousResult unchanged')
  assert.strictEqual(step2Mock.insertedRowIds.length, 0, 'step2 mock not called')
})

// ── Completion state after full retry ────────────────────────────────────────

console.log('\ncompletion state after full success')

await test('after final retry, failed count is 0 and failedPayloadItems is empty', async () => {
  const items = [makeItem('r0', 'contact-r0'), makeItem('r1', 'contact-r1')]
  const step1Mock = makeSelectiveMock(new Set(['r0']), new Set(['r1']))
  const step1 = await executeBatchImport(items, step1Mock)
  assert.strictEqual(step1.failed, 1)

  const step2Mock = makeSelectiveMock(new Set(['r1']), new Set())
  const step2 = await retryBatchImport(step1.failedPayloadItems, step1, step2Mock)

  assert.strictEqual(step2.failed, 0, 'no more failures')
  assert.strictEqual(step2.failedPayloadItems.length, 0, 'nothing left to retry')
})

// ── Browse-imported and chooser source ────────────────────────────────────────

console.log('\nbrowse-imported and chooser source after full sequence')

await test('successfulIds and successfulContacts are parallel arrays (same length, IDs match)', async () => {
  const items = [
    makeItem('x0', 'contact-x0'),
    makeItem('x1', 'contact-x1'),
    makeItem('x2', 'contact-x2'),
  ]
  const step1Mock = makeSelectiveMock(new Set(['x0']), new Set(['x1', 'x2']))
  const step1 = await executeBatchImport(items, step1Mock)

  const step2Mock = makeSelectiveMock(new Set(['x1', 'x2']), new Set())
  const step2 = await retryBatchImport(step1.failedPayloadItems, step1, step2Mock)

  // successfulIds and successfulContacts must be parallel
  assert.strictEqual(step2.successfulIds.length, step2.successfulContacts.length,
    'successfulIds and successfulContacts same length')
  for (let i = 0; i < step2.successfulIds.length; i++) {
    assert.strictEqual(step2.successfulIds[i], step2.successfulContacts[i].id,
      `position ${i}: id matches contact.id`)
  }
  // All three contacts browseable
  const ids = step2.successfulIds
  assert.ok(ids.includes('db-x0'))
  assert.ok(ids.includes('db-x1'))
  assert.ok(ids.includes('db-x2'))
})

await test('no contact ID appears twice in successfulIds', async () => {
  const items = [
    makeItem('p0', 'contact-p0'),
    makeItem('p1', 'contact-p1'),
    makeItem('p2', 'contact-p2'),
  ]
  const step1Mock = makeSelectiveMock(new Set(['p0', 'p1']), new Set(['p2']))
  const step1 = await executeBatchImport(items, step1Mock)

  const step2Mock = makeSelectiveMock(new Set(['p2']), new Set())
  const step2 = await retryBatchImport(step1.failedPayloadItems, step1, step2Mock)

  const ids = step2.successfulIds
  assert.strictEqual(new Set(ids).size, ids.length, 'no duplicates in successfulIds')
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
