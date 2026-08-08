// Batched contact import executor with per-row failure tracking.
// No React or UI dependencies — safe to unit-test in Node.js.
//
// Payload items are expected to have a `_rowId` field for tracking.
// All `_*` keys are stripped before the DB insert so they never reach Supabase.
//
// ExecutionResult shape:
//   {
//     attempted:       number   — total rows sent to DB (not counting already-successful retries)
//     successful:      number
//     failed:          number
//     skipped:         number   — always 0 on first run; merged-in previous successes on retry
//     successfulIds:   string[] — Supabase-generated contact UUIDs (for router state)
//     successfulContacts: object[] — full inserted rows returned by Supabase
//     failedRowIds:    string[] — _rowId values of failed rows
//     failedPayloadItems: object[] — original payload items that failed (for retry)
//   }

export const IMPORT_BATCH_SIZE = 25

/**
 * Execute the import, inserting payloadItems in batches of IMPORT_BATCH_SIZE.
 *
 * @param {Object[]} payloadItems - each item must have _rowId; all _* keys are stripped
 * @param {Object}   supabase     - Supabase client (or injectable mock)
 * @param {Object}   [opts]
 * @param {Function} [opts.onProgress] - called with (progressFraction: 0..1) after each batch
 * @param {Function} [opts.isCancelled] - if truthy return value, stops between batches
 * @returns {Promise<ExecutionResult>}
 */
export async function executeBatchImport(payloadItems, supabase, opts = {}) {
  const { onProgress, isCancelled } = opts
  if (!Array.isArray(payloadItems) || payloadItems.length === 0) {
    return _emptyResult()
  }

  const batches = _chunk(payloadItems, IMPORT_BATCH_SIZE)
  const result = {
    attempted:          0,
    successful:         0,
    failed:             0,
    skipped:            0,
    successfulIds:      [],
    successfulContacts: [],
    failedRowIds:       [],
    failedPayloadItems: [],
  }

  for (let bi = 0; bi < batches.length; bi++) {
    if (isCancelled && isCancelled()) break

    const batch = batches[bi]
    result.attempted += batch.length

    const dbRows = batch.map(item => {
      const row = {}
      for (const key of Object.keys(item)) {
        if (!key.startsWith('_')) row[key] = item[key]
      }
      return row
    })

    try {
      const { data, error } = await supabase
        .from('contacts')
        .insert(dbRows)
        .select('id, name')

      if (error) {
        // Whole batch failed — mark every row in this batch as failed
        for (const item of batch) {
          result.failed++
          result.failedRowIds.push(item._rowId)
          result.failedPayloadItems.push(item)
        }
      } else {
        // Batch succeeded — correlate returned rows by position
        const returned = Array.isArray(data) ? data : []
        for (let ri = 0; ri < batch.length; ri++) {
          const inserted = returned[ri]
          if (inserted?.id) {
            result.successful++
            result.successfulIds.push(inserted.id)
            result.successfulContacts.push(inserted)
          } else {
            // Partial batch success: insert succeeded but row data missing
            result.failed++
            result.failedRowIds.push(batch[ri]._rowId)
            result.failedPayloadItems.push(batch[ri])
          }
        }
      }
    } catch (err) {
      // Network or unexpected error — entire batch fails
      for (const item of batch) {
        result.failed++
        result.failedRowIds.push(item._rowId)
        result.failedPayloadItems.push(item)
      }
    }

    if (onProgress) {
      const fraction = (bi + 1) / batches.length
      onProgress(fraction)
    }
  }

  return result
}

/**
 * Retry only the failed rows from a previous execution.
 * Merges prior successes into the returned result so callers always see the full picture.
 * Does NOT re-insert previously successful rows.
 *
 * @param {Object[]} failedPayloadItems - from previousResult.failedPayloadItems
 * @param {Object}   previousResult     - prior ExecutionResult to merge into
 * @param {Object}   supabase           - Supabase client
 * @param {Object}   [opts]             - same opts as executeBatchImport
 * @returns {Promise<ExecutionResult>}
 */
export async function retryBatchImport(failedPayloadItems, previousResult, supabase, opts = {}) {
  if (!Array.isArray(failedPayloadItems) || failedPayloadItems.length === 0) {
    return previousResult || _emptyResult()
  }

  const retryResult = await executeBatchImport(failedPayloadItems, supabase, opts)

  // Merge: prior successes become "skipped" (already in DB), new results are added
  const prior = previousResult || _emptyResult()
  return {
    attempted:          retryResult.attempted,
    successful:         retryResult.successful,
    failed:             retryResult.failed,
    skipped:            prior.successful,
    successfulIds:      [...prior.successfulIds, ...retryResult.successfulIds],
    successfulContacts: [...prior.successfulContacts, ...retryResult.successfulContacts],
    failedRowIds:       retryResult.failedRowIds,
    failedPayloadItems: retryResult.failedPayloadItems,
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _chunk(arr, size) {
  const chunks = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

function _emptyResult() {
  return {
    attempted:          0,
    successful:         0,
    failed:             0,
    skipped:            0,
    successfulIds:      [],
    successfulContacts: [],
    failedRowIds:       [],
    failedPayloadItems: [],
  }
}
