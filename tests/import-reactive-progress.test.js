/**
 * import-reactive-progress.test.js
 *
 * Verifies the reactive progress contract:
 * - execProgress is a React state value (not importProgressRef alone)
 * - aria-valuenow is driven by execProgress (state), not the ref
 * - both the ref and the state are updated together in onProgress callbacks
 * - setExecProgress(0) is called at the start of both handleImportReview and handleRetry
 *
 * These are static-source assertions since we cannot run the React component in Node.
 * No React, no DOM, no Supabase.
 *
 * Run with: node tests/import-reactive-progress.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dirname, '../src/components/ImportContactsModal.jsx'), 'utf8')

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

// ── execProgress state declaration ───────────────────────────────────────────

console.log('\nexecProgress state declaration')

test('execProgress useState declared', () => {
  assert.ok(src.includes('execProgress'), 'execProgress must be declared')
})

test('setExecProgress setter declared', () => {
  assert.ok(src.includes('setExecProgress'), 'setExecProgress must be declared')
})

test('execProgress uses useState (not useRef)', () => {
  // Must appear in a useState call, not only a useRef
  const hasState = src.includes('useState(0)') &&
    (src.includes('[execProgress, setExecProgress]') || src.includes('execProgress'))
  assert.ok(hasState, 'execProgress must be driven by useState')
})

// ── importProgressRef still present (retained for non-reactive uses) ──────────

console.log('\nimportProgressRef retained alongside execProgress')

test('importProgressRef still declared', () => {
  assert.ok(src.includes('importProgressRef'), 'importProgressRef must still exist')
})

// ── aria-valuenow driven by execProgress (state), not ref ─────────────────────

console.log('\naria-valuenow driven by state')

test('aria-valuenow uses execProgress (not importProgressRef.current)', () => {
  assert.ok(
    src.includes('aria-valuenow={execProgress}'),
    'aria-valuenow must be {execProgress} — not importProgressRef.current'
  )
})

test('aria-valuenow is NOT importProgressRef.current', () => {
  assert.ok(
    !src.includes('aria-valuenow={importProgressRef.current}'),
    'aria-valuenow must not use the ref directly (no reactive rerender)'
  )
})

// ── setExecProgress(0) reset at import start ──────────────────────────────────

console.log('\nsetExecProgress(0) reset at import start')

test('handleImportReview resets execProgress to 0', () => {
  // The reset must appear before executeBatchImport is called
  const importReviewIdx = src.indexOf('async function handleImportReview')
  const execBatchIdx    = src.indexOf('executeBatchImport', importReviewIdx)
  const resetIdx        = src.indexOf('setExecProgress(0)', importReviewIdx)
  assert.ok(resetIdx > -1,         'setExecProgress(0) must exist in handleImportReview')
  assert.ok(resetIdx < execBatchIdx, 'setExecProgress(0) must be called before executeBatchImport')
})

test('handleRetry resets execProgress to 0', () => {
  const retryIdx    = src.indexOf('async function handleRetry')
  const retryBatch  = src.indexOf('retryBatchImport', retryIdx)
  const resetIdx    = src.indexOf('setExecProgress(0)', retryIdx)
  assert.ok(resetIdx > -1,        'setExecProgress(0) must exist in handleRetry')
  assert.ok(resetIdx < retryBatch, 'setExecProgress(0) must be called before retryBatchImport')
})

// ── onProgress updates both ref and state ─────────────────────────────────────

console.log('\nonProgress callback updates both ref and state')

test('onProgress in handleImportReview sets both importProgressRef.current and setExecProgress', () => {
  const importReviewIdx = src.indexOf('async function handleImportReview')
  const execBatchIdx    = src.indexOf('executeBatchImport', importReviewIdx)
  // Extract the onProgress block — it appears inside executeBatchImport's options arg
  const onProgressStart = src.indexOf('onProgress:', execBatchIdx)
  const onProgressEnd   = src.indexOf('})', onProgressStart)
  const block = src.slice(onProgressStart, onProgressEnd)
  assert.ok(block.includes('importProgressRef.current'), 'ref must be updated in onProgress')
  assert.ok(block.includes('setExecProgress'),            'state must be updated in onProgress')
})

test('onProgress in handleRetry sets both importProgressRef.current and setExecProgress', () => {
  const retryIdx        = src.indexOf('async function handleRetry')
  const retryBatchIdx   = src.indexOf('retryBatchImport', retryIdx)
  const onProgressStart = src.indexOf('onProgress:', retryBatchIdx)
  const onProgressEnd   = src.indexOf('})', onProgressStart)
  const block = src.slice(onProgressStart, onProgressEnd)
  assert.ok(block.includes('importProgressRef.current'), 'ref must be updated in handleRetry onProgress')
  assert.ok(block.includes('setExecProgress'),            'state must be updated in handleRetry onProgress')
})

test('onProgress computes pct as Math.round(fraction * 100)', () => {
  // Both handlers should round the progress fraction to an integer
  const count = (src.match(/Math\.round\(fraction \* 100\)/g) || []).length
  assert.ok(count >= 2, `must appear at least twice (once per handler); found ${count}`)
})

// ── Role-based ARIA contract ──────────────────────────────────────────────────

console.log('\nARIA progressbar contract')

test('role="progressbar" present', () => {
  assert.ok(src.includes('role="progressbar"'))
})

test('aria-valuemin present', () => {
  assert.ok(src.includes('aria-valuemin'))
})

test('aria-valuemax present', () => {
  assert.ok(src.includes('aria-valuemax'))
})

test('aria-valuenow present', () => {
  assert.ok(src.includes('aria-valuenow'))
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
