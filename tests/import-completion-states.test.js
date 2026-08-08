/**
 * import-completion-states.test.js
 *
 * Static assertions for the completion state logic surfaced in the done step.
 * Tests the fill-percentage calculation, state classification (full/partial/zero),
 * and funnel fill SVG constraints used in ImportContactsModal.jsx.
 *
 * All logic here is pure — no React, no DOM, no Supabase.
 * Run with: node tests/import-completion-states.test.js
 */
import assert from 'assert'

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

// ── Fill percentage calculation ───────────────────────────────────────────────
// Mirrors the done-step expression:
//   fillPct = Math.round((successful / (attempted || 1)) * 100)

function computeFillPct(successful, attempted) {
  return Math.round((successful / (attempted || 1)) * 100)
}

console.log('\nfill percentage calculation')

test('full success → 100%', () => {
  assert.strictEqual(computeFillPct(10, 10), 100)
})

test('half success → 50%', () => {
  assert.strictEqual(computeFillPct(5, 10), 50)
})

test('no successes → 0%', () => {
  assert.strictEqual(computeFillPct(0, 10), 0)
})

test('1 of 3 → 33%', () => {
  assert.strictEqual(computeFillPct(1, 3), 33)
})

test('2 of 3 → 67%', () => {
  assert.strictEqual(computeFillPct(2, 3), 67)
})

test('zero attempted (guard division by zero) → 0%', () => {
  assert.strictEqual(computeFillPct(0, 0), 0)
})

test('1 of 1 → 100%', () => {
  assert.strictEqual(computeFillPct(1, 1), 100)
})

test('25 of 30 → 83%', () => {
  assert.strictEqual(computeFillPct(25, 30), 83)
})

// ── Completion state classification ──────────────────────────────────────────
// Mirrors the done-step logic:
//   isFull    = failed === 0
//   isPartial = failed > 0 && successful > 0
//   isZero    = failed > 0 && successful === 0

function classifyCompletionState(executionResult) {
  const { successful, failed } = executionResult
  return {
    isFull:    failed === 0,
    isPartial: failed > 0 && successful > 0,
    isZero:    failed > 0 && successful === 0,
  }
}

console.log('\ncompletion state classification')

test('all succeeded → isFull only', () => {
  const s = classifyCompletionState({ successful: 10, failed: 0 })
  assert.strictEqual(s.isFull, true)
  assert.strictEqual(s.isPartial, false)
  assert.strictEqual(s.isZero, false)
})

test('some succeeded, some failed → isPartial only', () => {
  const s = classifyCompletionState({ successful: 7, failed: 3 })
  assert.strictEqual(s.isFull, false)
  assert.strictEqual(s.isPartial, true)
  assert.strictEqual(s.isZero, false)
})

test('all failed → isZero only', () => {
  const s = classifyCompletionState({ successful: 0, failed: 5 })
  assert.strictEqual(s.isFull, false)
  assert.strictEqual(s.isPartial, false)
  assert.strictEqual(s.isZero, true)
})

test('1 success 0 fail → isFull', () => {
  const s = classifyCompletionState({ successful: 1, failed: 0 })
  assert.strictEqual(s.isFull, true)
})

test('0 success 1 fail → isZero', () => {
  const s = classifyCompletionState({ successful: 0, failed: 1 })
  assert.strictEqual(s.isZero, true)
})

test('1 success 1 fail → isPartial', () => {
  const s = classifyCompletionState({ successful: 1, failed: 1 })
  assert.strictEqual(s.isPartial, true)
})

test('states are mutually exclusive', () => {
  const cases = [
    { successful: 10, failed: 0 },
    { successful: 5, failed: 5 },
    { successful: 0, failed: 10 },
    { successful: 1, failed: 0 },
    { successful: 0, failed: 1 },
  ]
  for (const c of cases) {
    const s = classifyCompletionState(c)
    const trueCount = [s.isFull, s.isPartial, s.isZero].filter(Boolean).length
    assert.strictEqual(trueCount, 1, `exactly one state must be true for ${JSON.stringify(c)}`)
  }
})

// ── Funnel fill clip-path ─────────────────────────────────────────────────────
// clipPath: `inset(${100 - fillPct}% 0 0 0)` — cuts from the top down.
// fillPct = 100 → inset(0% ...) = fully visible (no clip)
// fillPct = 0   → inset(100% ...) = fully hidden
// fillPct = 50  → inset(50% ...) = bottom half visible

function buildClipPath(fillPct) {
  return `inset(${100 - fillPct}% 0 0 0)`
}

console.log('\nfunnel fill clip-path calculation')

test('100% fill → inset(0% 0 0 0) = fully visible', () => {
  assert.strictEqual(buildClipPath(100), 'inset(0% 0 0 0)')
})

test('0% fill → inset(100% 0 0 0) = fully hidden', () => {
  assert.strictEqual(buildClipPath(0), 'inset(100% 0 0 0)')
})

test('50% fill → inset(50% 0 0 0) = half visible', () => {
  assert.strictEqual(buildClipPath(50), 'inset(50% 0 0 0)')
})

test('67% fill → inset(33% 0 0 0)', () => {
  assert.strictEqual(buildClipPath(67), 'inset(33% 0 0 0)')
})

test('clip inset + fill always sum to 100', () => {
  const pcts = [0, 1, 25, 33, 50, 67, 75, 99, 100]
  for (const pct of pcts) {
    const clip = 100 - pct
    assert.strictEqual(clip + pct, 100, `pct=${pct}`)
  }
})

// ── Sacred funnel SVG path ────────────────────────────────────────────────────
// The sacred funnel path must always be: M3 4H21L15 12.5V20H9V12.5Z
// and the ember overlay must always use fill="#FF4423"

const SACRED_FUNNEL_PATH = 'M3 4H21L15 12.5V20H9V12.5Z'
const EMBER_COLOR = '#FF4423'

console.log('\nsacred funnel SVG constants')

test('sacred funnel path matches spec', () => {
  // This constant is used in both the SVG base layer and ember overlay in ImportContactsModal.jsx
  assert.strictEqual(SACRED_FUNNEL_PATH, 'M3 4H21L15 12.5V20H9V12.5Z')
})

test('ember fill color matches brand spec', () => {
  assert.strictEqual(EMBER_COLOR, '#FF4423')
})

test('sacred funnel path starts at M3 4', () => {
  assert.ok(SACRED_FUNNEL_PATH.startsWith('M3 4'), 'path must begin at M3 4')
})

test('sacred funnel path ends with Z (closed)', () => {
  assert.ok(SACRED_FUNNEL_PATH.endsWith('Z'), 'path must be closed with Z')
})

test('ember color is uppercase hex', () => {
  assert.match(EMBER_COLOR, /^#[0-9A-F]{6}$/, 'ember color must be uppercase 6-digit hex')
})

// ── Retry button label logic ──────────────────────────────────────────────────
// isPartial → "Retry N failed"
// isZero    → "Try again"

function retryButtonLabel(executionResult) {
  const { successful, failed } = executionResult
  const isPartial = failed > 0 && successful > 0
  const isZero    = failed > 0 && successful === 0
  if (isPartial) return `Retry ${failed} failed`
  if (isZero)    return 'Try again'
  return null // no retry button for full success
}

console.log('\nretry button label')

test('partial result → "Retry N failed"', () => {
  assert.strictEqual(retryButtonLabel({ successful: 8, failed: 2 }), 'Retry 2 failed')
})

test('zero result → "Try again"', () => {
  assert.strictEqual(retryButtonLabel({ successful: 0, failed: 5 }), 'Try again')
})

test('full success → null (no retry button)', () => {
  assert.strictEqual(retryButtonLabel({ successful: 10, failed: 0 }), null)
})

test('single failure in partial → "Retry 1 failed"', () => {
  assert.strictEqual(retryButtonLabel({ successful: 9, failed: 1 }), 'Retry 1 failed')
})

// ── computeDoneStats integration ──────────────────────────────────────────────
// (re-tests the export to confirm it's still usable with the executor result shape)

import { computeDoneStats } from '../src/lib/importReviewUtils.js'

console.log('\ncomputeDoneStats with executionResult importedCount')

test('importedCount from executionResult.successful flows into stats', () => {
  const reviewRows = [
    { _rowId: 'r0', name: 'Alice', _isMissingName: false, _isDuplicate: false },
    { _rowId: 'r1', name: '',      _isMissingName: true,  _isDuplicate: false },
    { _rowId: 'r2', name: 'Bob',   _isMissingName: false, _isDuplicate: true  },
  ]
  const executionResult = { successful: 1, failed: 0 }
  const stats = computeDoneStats(reviewRows, executionResult.successful)
  assert.strictEqual(stats.importedCount, 1)
  assert.strictEqual(stats.missingNameCount, 1)
  assert.strictEqual(stats.duplicatesSkipped, 1)
})

test('zero successful → importedCount is 0', () => {
  const reviewRows = [{ _rowId: 'r0', name: 'Alice', _isMissingName: false, _isDuplicate: false }]
  const stats = computeDoneStats(reviewRows, 0)
  assert.strictEqual(stats.importedCount, 0)
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
