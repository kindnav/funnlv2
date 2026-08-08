/**
 * import-partial-execution.test.js
 *
 * Tests for src/lib/importBatchExecutor.js
 * Zero-dependency Node.js — run with: node tests/import-partial-execution.test.js
 */
import assert from 'assert'
import {
  IMPORT_BATCH_SIZE,
  executeBatchImport,
  retryBatchImport,
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

// ── Mock Supabase ─────────────────────────────────────────────────────────────

function makeSupabase({ error = null } = {}) {
  return {
    from() {
      return {
        insert(items) {
          return {
            select() {
              if (error) return Promise.resolve({ data: null, error })
              const returned = items.map((item, i) => ({
                id: `db-${i}-${Date.now()}-${Math.random()}`,
                name: item.name || 'test',
              }))
              return Promise.resolve({ data: returned, error: null })
            }
          }
        }
      }
    }
  }
}

function makeCapturingSupabase() {
  let capturedBatches = []
  let callCount = 0
  const supabase = {
    from() {
      return {
        insert(items) {
          capturedBatches.push([...items])
          callCount++
          return {
            select() {
              return Promise.resolve({ data: items.map((_, i) => ({ id: `id-${i}`, name: 'x' })), error: null })
            }
          }
        }
      }
    }
  }
  supabase.getCapturedBatches = () => capturedBatches
  supabase.getCallCount = () => callCount
  return supabase
}

function makePayloadItems(count, startIndex = 0) {
  return Array.from({ length: count }, (_, i) => ({
    _rowId: `row-${startIndex + i}`,
    name: `Person ${startIndex + i}`,
    user_id: 'user-123',
  }))
}

// ── IMPORT_BATCH_SIZE ─────────────────────────────────────────────────────────

console.log('\nIMPORT_BATCH_SIZE')

await test('is 25', () => {
  assert.strictEqual(IMPORT_BATCH_SIZE, 25)
})

// ── executeBatchImport — empty input ─────────────────────────────────────────

console.log('\nexecuteBatchImport — empty input')

await test('returns zero result for empty array', async () => {
  const result = await executeBatchImport([], makeSupabase())
  assert.strictEqual(result.attempted, 0)
  assert.strictEqual(result.successful, 0)
  assert.strictEqual(result.failed, 0)
  assert.deepStrictEqual(result.successfulIds, [])
  assert.deepStrictEqual(result.failedRowIds, [])
  assert.deepStrictEqual(result.failedPayloadItems, [])
})

await test('returns zero result for null input', async () => {
  const result = await executeBatchImport(null, makeSupabase())
  assert.strictEqual(result.attempted, 0)
  assert.strictEqual(result.successful, 0)
})

// ── executeBatchImport — full success ─────────────────────────────────────────

console.log('\nexecuteBatchImport — full success')

await test('all items successful', async () => {
  const items = makePayloadItems(3)
  const result = await executeBatchImport(items, makeSupabase())
  assert.strictEqual(result.attempted, 3)
  assert.strictEqual(result.successful, 3)
  assert.strictEqual(result.failed, 0)
  assert.strictEqual(result.successfulIds.length, 3)
  assert.deepStrictEqual(result.failedRowIds, [])
  assert.deepStrictEqual(result.failedPayloadItems, [])
})

await test('_rowId and _* fields stripped before DB insert', async () => {
  const supabase = makeCapturingSupabase()
  const items = [{ _rowId: 'row-0', _isDuplicate: true, name: 'Alice', user_id: 'u1' }]
  await executeBatchImport(items, supabase)
  const sent = supabase.getCapturedBatches()[0][0]
  assert.ok(!('_rowId' in sent), '_rowId must be stripped')
  assert.ok(!('_isDuplicate' in sent), '_isDuplicate must be stripped')
  assert.ok('name' in sent, 'name must be preserved')
  assert.ok('user_id' in sent, 'user_id must be preserved')
})

await test('_suggestion field is also stripped', async () => {
  const supabase = makeCapturingSupabase()
  const items = [{ _rowId: 'row-0', _suggestion: { confidence: 'high' }, name: 'Bob', user_id: 'u1' }]
  await executeBatchImport(items, supabase)
  const sent = supabase.getCapturedBatches()[0][0]
  assert.ok(!('_suggestion' in sent), '_suggestion must be stripped')
})

await test('successfulContacts contain returned rows from Supabase', async () => {
  const items = makePayloadItems(2)
  const result = await executeBatchImport(items, makeSupabase())
  assert.strictEqual(result.successfulContacts.length, 2)
  assert.ok(result.successfulContacts[0].id, 'returned contact must have id')
})

await test('onProgress called once per batch for single batch', async () => {
  const items = makePayloadItems(3)
  const progressValues = []
  await executeBatchImport(items, makeSupabase(), { onProgress: f => progressValues.push(f) })
  assert.strictEqual(progressValues.length, 1)
  assert.strictEqual(progressValues[0], 1)
})

// ── executeBatchImport — full failure ─────────────────────────────────────────

console.log('\nexecuteBatchImport — full failure')

await test('all items fail when supabase returns error', async () => {
  const items = makePayloadItems(3)
  const result = await executeBatchImport(items, makeSupabase({ error: { message: 'DB down' } }))
  assert.strictEqual(result.attempted, 3)
  assert.strictEqual(result.successful, 0)
  assert.strictEqual(result.failed, 3)
  assert.deepStrictEqual(result.successfulIds, [])
  assert.strictEqual(result.failedRowIds.length, 3)
  assert.strictEqual(result.failedPayloadItems.length, 3)
})

await test('failedPayloadItems retain original _rowId for retry tracking', async () => {
  const items = [{ _rowId: 'row-99', name: 'Alice', user_id: 'u1' }]
  const result = await executeBatchImport(items, makeSupabase({ error: { message: 'error' } }))
  assert.strictEqual(result.failedPayloadItems[0]._rowId, 'row-99')
})

await test('failedRowIds match _rowId values of all failed items', async () => {
  const items = makePayloadItems(3)
  const result = await executeBatchImport(items, makeSupabase({ error: { message: 'error' } }))
  assert.deepStrictEqual(result.failedRowIds, ['row-0', 'row-1', 'row-2'])
})

await test('handles thrown exception (network failure) gracefully', async () => {
  const supabase = {
    from() {
      return { insert() { return { select() { return Promise.reject(new Error('network error')) } } } }
    }
  }
  const result = await executeBatchImport(makePayloadItems(2), supabase)
  assert.strictEqual(result.failed, 2)
  assert.strictEqual(result.successful, 0)
})

// ── executeBatchImport — batching ─────────────────────────────────────────────

console.log('\nexecuteBatchImport — batching')

await test('items split into batches of IMPORT_BATCH_SIZE', async () => {
  const supabase = makeCapturingSupabase()
  await executeBatchImport(makePayloadItems(IMPORT_BATCH_SIZE + 5), supabase)
  const batches = supabase.getCapturedBatches()
  assert.strictEqual(batches.length, 2)
  assert.strictEqual(batches[0].length, IMPORT_BATCH_SIZE)
  assert.strictEqual(batches[1].length, 5)
})

await test('onProgress called once per batch — two batches', async () => {
  const items = makePayloadItems(IMPORT_BATCH_SIZE + 5)
  const progressValues = []
  await executeBatchImport(items, makeSupabase(), { onProgress: f => progressValues.push(f) })
  assert.strictEqual(progressValues.length, 2)
  assert.ok(progressValues[0] < progressValues[1], 'progress must increase monotonically')
  assert.ok(Math.abs(progressValues[1] - 1) < 0.001, 'final progress value must equal 1')
})

await test('first progress value equals (1 / batchCount)', async () => {
  const items = makePayloadItems(IMPORT_BATCH_SIZE + 5)
  const progressValues = []
  await executeBatchImport(items, makeSupabase(), { onProgress: f => progressValues.push(f) })
  const expectedFirst = 1 / 2
  assert.ok(Math.abs(progressValues[0] - expectedFirst) < 0.001)
})

await test('isCancelled stops processing between batches', async () => {
  const supabase = makeCapturingSupabase()
  await executeBatchImport(makePayloadItems(IMPORT_BATCH_SIZE * 3), supabase, {
    isCancelled: () => supabase.getCallCount() >= 1,
  })
  assert.strictEqual(supabase.getCallCount(), 1)
})

await test('items from cancelled batches are not attempted or failed', async () => {
  const supabase = makeCapturingSupabase()
  const total = IMPORT_BATCH_SIZE * 2
  const result = await executeBatchImport(makePayloadItems(total), supabase, {
    isCancelled: () => supabase.getCallCount() >= 1,
  })
  assert.strictEqual(result.attempted, IMPORT_BATCH_SIZE)
  assert.strictEqual(result.successful, IMPORT_BATCH_SIZE)
})

// ── executeBatchImport — partial success ──────────────────────────────────────

console.log('\nexecuteBatchImport — partial success (multi-batch)')

await test('first batch succeeds, second fails — partial result', async () => {
  let callCount = 0
  const supabase = {
    from() {
      return {
        insert(items) {
          callCount++
          return {
            select() {
              if (callCount === 1) {
                return Promise.resolve({ data: items.map((_, i) => ({ id: `id-${i}`, name: 'x' })), error: null })
              }
              return Promise.resolve({ data: null, error: { message: 'fail' } })
            }
          }
        }
      }
    }
  }
  const result = await executeBatchImport(makePayloadItems(IMPORT_BATCH_SIZE + 3), supabase)
  assert.strictEqual(result.successful, IMPORT_BATCH_SIZE)
  assert.strictEqual(result.failed, 3)
  assert.strictEqual(result.attempted, IMPORT_BATCH_SIZE + 3)
})

await test('second batch succeeds, first fails — partial result', async () => {
  let callCount = 0
  const supabase = {
    from() {
      return {
        insert(items) {
          callCount++
          return {
            select() {
              if (callCount === 1) {
                return Promise.resolve({ data: null, error: { message: 'fail' } })
              }
              return Promise.resolve({ data: items.map((_, i) => ({ id: `id-${i}`, name: 'x' })), error: null })
            }
          }
        }
      }
    }
  }
  const result = await executeBatchImport(makePayloadItems(IMPORT_BATCH_SIZE + 4), supabase)
  assert.strictEqual(result.successful, 4)
  assert.strictEqual(result.failed, IMPORT_BATCH_SIZE)
})

// ── executeBatchImport — Supabase returns fewer rows than inserted ─────────────

console.log('\nexecuteBatchImport — partial row data returned')

await test('missing inserted rows are marked failed per-item', async () => {
  // Supabase returns data for only 2 of 3 items (row 2 has no id)
  const supabase = {
    from() {
      return {
        insert(items) {
          return {
            select() {
              return Promise.resolve({
                data: [
                  { id: 'id-0', name: items[0].name },
                  { id: 'id-1', name: items[1].name },
                  { name: items[2].name }, // no id — partial failure
                ],
                error: null,
              })
            }
          }
        }
      }
    }
  }
  const result = await executeBatchImport(makePayloadItems(3), supabase)
  assert.strictEqual(result.successful, 2)
  assert.strictEqual(result.failed, 1)
  assert.strictEqual(result.failedRowIds[0], 'row-2')
})

// ── retryBatchImport ──────────────────────────────────────────────────────────

console.log('\nretryBatchImport')

await test('returns previousResult unchanged when failedPayloadItems is empty', async () => {
  const previous = {
    attempted: 5, successful: 5, failed: 0, skipped: 0,
    successfulIds: ['a', 'b', 'c', 'd', 'e'],
    successfulContacts: [],
    failedRowIds: [],
    failedPayloadItems: [],
  }
  const result = await retryBatchImport([], previous, makeSupabase())
  assert.deepStrictEqual(result, previous)
})

await test('retries only failed rows — not previously successful ones', async () => {
  const supabase = makeCapturingSupabase()
  const failed = makePayloadItems(2, 5)
  const previous = {
    attempted: 5, successful: 3, failed: 2, skipped: 0,
    successfulIds: ['a', 'b', 'c'],
    successfulContacts: [{ id: 'a', name: 'x' }, { id: 'b', name: 'x' }, { id: 'c', name: 'x' }],
    failedRowIds: ['row-5', 'row-6'],
    failedPayloadItems: failed,
  }
  await retryBatchImport(failed, previous, supabase)
  const allSent = supabase.getCapturedBatches().flat()
  assert.strictEqual(allSent.length, 2, 'only the 2 failed rows should be sent to DB')
})

await test('merges previous successes as skipped — skipped = previousResult.successful', async () => {
  const failed = makePayloadItems(2, 5)
  const previous = {
    attempted: 7, successful: 5, failed: 2, skipped: 0,
    successfulIds: ['a', 'b', 'c', 'd', 'e'],
    successfulContacts: Array(5).fill({ id: 'x', name: 'y' }),
    failedRowIds: ['row-5', 'row-6'],
    failedPayloadItems: failed,
  }
  const result = await retryBatchImport(failed, previous, makeSupabase())
  assert.strictEqual(result.skipped, 5)
})

await test('merged successfulIds = previous + new successes', async () => {
  const failed = makePayloadItems(2, 5)
  const previous = {
    attempted: 7, successful: 5, failed: 2, skipped: 0,
    successfulIds: ['a', 'b', 'c', 'd', 'e'],
    successfulContacts: Array(5).fill({ id: 'x', name: 'y' }),
    failedRowIds: ['row-5', 'row-6'],
    failedPayloadItems: failed,
  }
  const result = await retryBatchImport(failed, previous, makeSupabase())
  assert.strictEqual(result.successfulIds.length, 7) // 5 previous + 2 newly succeeded
})

await test('new failures recorded correctly in merged result', async () => {
  const failed = makePayloadItems(3, 5)
  const previous = {
    attempted: 5, successful: 2, failed: 3, skipped: 0,
    successfulIds: ['a', 'b'],
    successfulContacts: [],
    failedRowIds: ['row-5', 'row-6', 'row-7'],
    failedPayloadItems: failed,
  }
  const result = await retryBatchImport(failed, previous, makeSupabase({ error: { message: 'still failing' } }))
  assert.strictEqual(result.failed, 3)
  assert.strictEqual(result.failedPayloadItems.length, 3)
})

await test('handles null previousResult gracefully', async () => {
  const items = makePayloadItems(2)
  const result = await retryBatchImport(items, null, makeSupabase())
  assert.ok(typeof result.successful === 'number')
  assert.ok(typeof result.failed === 'number')
})

await test('retry with null failedPayloadItems returns previousResult', async () => {
  const previous = {
    attempted: 3, successful: 3, failed: 0, skipped: 0,
    successfulIds: ['x', 'y', 'z'],
    successfulContacts: [],
    failedRowIds: [],
    failedPayloadItems: [],
  }
  const result = await retryBatchImport(null, previous, makeSupabase())
  assert.deepStrictEqual(result, previous)
})

// ── ExecutionResult shape invariants ─────────────────────────────────────────

console.log('\nExecutionResult shape invariants')

await test('result always has all required fields', async () => {
  const result = await executeBatchImport(makePayloadItems(1), makeSupabase())
  const required = [
    'attempted', 'successful', 'failed', 'skipped',
    'successfulIds', 'successfulContacts', 'failedRowIds', 'failedPayloadItems',
  ]
  for (const field of required) {
    assert.ok(field in result, `result must have field: ${field}`)
  }
})

await test('successfulIds and failedRowIds are always arrays', async () => {
  const result = await executeBatchImport([], makeSupabase())
  assert.ok(Array.isArray(result.successfulIds))
  assert.ok(Array.isArray(result.failedRowIds))
  assert.ok(Array.isArray(result.successfulContacts))
  assert.ok(Array.isArray(result.failedPayloadItems))
})

await test('attempted = successful + failed on full success', async () => {
  const result = await executeBatchImport(makePayloadItems(3), makeSupabase())
  assert.strictEqual(result.attempted, result.successful + result.failed)
})

await test('attempted = successful + failed on full failure', async () => {
  const result = await executeBatchImport(makePayloadItems(3), makeSupabase({ error: { message: 'e' } }))
  assert.strictEqual(result.attempted, result.successful + result.failed)
})

await test('skipped is always 0 on first executeBatchImport run', async () => {
  const result = await executeBatchImport(makePayloadItems(3), makeSupabase())
  assert.strictEqual(result.skipped, 0)
})

await test('successfulIds.length equals result.successful', async () => {
  const result = await executeBatchImport(makePayloadItems(4), makeSupabase())
  assert.strictEqual(result.successfulIds.length, result.successful)
})

await test('failedRowIds.length equals result.failed', async () => {
  const result = await executeBatchImport(makePayloadItems(3), makeSupabase({ error: { message: 'e' } }))
  assert.strictEqual(result.failedRowIds.length, result.failed)
})

await test('failedPayloadItems.length equals result.failed', async () => {
  const result = await executeBatchImport(makePayloadItems(3), makeSupabase({ error: { message: 'e' } }))
  assert.strictEqual(result.failedPayloadItems.length, result.failed)
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
