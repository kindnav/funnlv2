/**
 * import-discard-confirmation.test.js
 *
 * Verifies the meaningful-work discard confirmation contract:
 * - requestClose is a single gate used by all close sources
 * - No raw window.confirm in the component
 * - showDiscardConfirm state declared
 * - role="alertdialog" overlay present in source
 * - "Keep editing" and "Discard import" buttons present
 * - All close sources (backdrop, header ×, upload Cancel) use requestClose
 * - Escape key handler uses requestClose
 * - Active import blocks close (importing guard in requestClose)
 *
 * Static-source assertions only — no React, no DOM, no Supabase.
 *
 * Run with: node tests/import-discard-confirmation.test.js
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

// ── requestClose presence ─────────────────────────────────────────────────────

console.log('\nrequestClose gate')

test('requestClose is declared', () => {
  assert.ok(src.includes('requestClose'), 'requestClose must be declared')
})

test('requestClose uses useCallback', () => {
  assert.ok(src.includes('const requestClose = useCallback'), 'requestClose must be a useCallback')
})

test('requestClose blocks when importing is true', () => {
  const fnStart  = src.indexOf('const requestClose = useCallback')
  const fnEnd    = src.indexOf('})', fnStart)
  const fnBody   = src.slice(fnStart, fnEnd)
  assert.ok(
    fnBody.includes('if (importing) return'),
    'requestClose must early-return when importing'
  )
})

test('requestClose calls onClose for clean states', () => {
  const fnStart  = src.indexOf('const requestClose = useCallback')
  const fnEnd    = src.indexOf('})', fnStart)
  const fnBody   = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('onClose()'), 'requestClose must call onClose() for clean states')
})

test('requestClose shows discard confirm for in-progress states', () => {
  const fnStart  = src.indexOf('const requestClose = useCallback')
  const fnEnd    = src.indexOf('})', fnStart)
  const fnBody   = src.slice(fnStart, fnEnd)
  assert.ok(
    fnBody.includes('setShowDiscardConfirm(true)'),
    'requestClose must call setShowDiscardConfirm(true) for in-progress states'
  )
})

// ── showDiscardConfirm state ──────────────────────────────────────────────────

console.log('\nshowDiscardConfirm state')

test('showDiscardConfirm state declared', () => {
  assert.ok(src.includes('showDiscardConfirm'), 'showDiscardConfirm must be declared')
})

test('setShowDiscardConfirm setter declared', () => {
  assert.ok(src.includes('setShowDiscardConfirm'), 'setShowDiscardConfirm must be declared')
})

// ── No raw window.confirm ─────────────────────────────────────────────────────

console.log('\nno raw window.confirm')

test('window.confirm is NOT used in the component', () => {
  assert.ok(
    !src.includes('window.confirm('),
    'must not use window.confirm — use accessible alertdialog instead'
  )
})

// ── alertdialog overlay ───────────────────────────────────────────────────────

console.log('\nalertalog overlay')

test('role="alertdialog" overlay present', () => {
  assert.ok(src.includes('role="alertdialog"'), 'discard confirmation must use role="alertdialog"')
})

test('aria-modal="true" on alertdialog', () => {
  // Find the alertdialog element and check it has aria-modal
  const dialogIdx  = src.indexOf('role="alertdialog"')
  const nextClose  = src.indexOf('>', dialogIdx)
  const dialogTag  = src.slice(dialogIdx, nextClose)
  assert.ok(dialogTag.includes('aria-modal') || src.slice(dialogIdx, dialogIdx + 200).includes('aria-modal'),
    'alertdialog must have aria-modal')
})

test('"Keep editing" button present', () => {
  assert.ok(
    src.includes('Keep editing'),
    'discard overlay must have a "Keep editing" button'
  )
})

test('"Discard import" button present', () => {
  assert.ok(
    src.includes('Discard import'),
    'discard overlay must have a "Discard import" button'
  )
})

test('Discard button calls onClose', () => {
  // The Discard button should eventually call onClose() (after setShowDiscardConfirm(false))
  const discardIdx = src.indexOf('Discard import')
  const nearbyCode = src.slice(Math.max(0, discardIdx - 500), discardIdx + 500)
  assert.ok(nearbyCode.includes('onClose()'), 'Discard button must call onClose()')
})

test('Keep editing button closes the overlay without discarding', () => {
  const keepIdx    = src.indexOf('Keep editing')
  const nearbyCode = src.slice(Math.max(0, keepIdx - 300), keepIdx + 200)
  assert.ok(
    nearbyCode.includes('setShowDiscardConfirm(false)'),
    '"Keep editing" must call setShowDiscardConfirm(false)'
  )
})

// ── All close sources use requestClose ───────────────────────────────────────

console.log('\nall close sources use requestClose')

test('backdrop onClick uses requestClose', () => {
  assert.ok(
    src.includes('onClick={requestClose}'),
    'backdrop must use onClick={requestClose}'
  )
})

test('no close source uses onClick={onClose} directly (all gated through requestClose)', () => {
  // onClose should only appear in: the prop declaration, the requestClose body, and the Discard button
  // — not as a raw onClick handler on any close-trigger element
  const rawOnCloseCount = (src.match(/onClick=\{onClose\}/g) || []).length
  assert.strictEqual(rawOnCloseCount, 0,
    'no interactive element should use onClick={onClose} directly — all must go through requestClose'
  )
})

test('Escape key handler uses requestClose (not onClose directly)', () => {
  const escIdx    = src.indexOf("e.key === 'Escape'")
  const nextLines = src.slice(escIdx, escIdx + 200)
  assert.ok(nextLines.includes('requestClose()'), 'Escape key must call requestClose()')
  assert.ok(!nextLines.includes('onClose()'),     'Escape key must NOT call onClose() directly')
})

// ── Active import blocks all close ────────────────────────────────────────────

console.log('\nactive import blocks close')

test('importing guard prevents close in requestClose', () => {
  const fnStart = src.indexOf('const requestClose = useCallback')
  const fnEnd   = src.indexOf('})', fnStart)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(
    fnBody.includes('if (importing) return'),
    'active import must block requestClose'
  )
})

// ── useCallback dependency array ──────────────────────────────────────────────

console.log('\nrequestClose dependency array')

test('requestClose dependency array includes importing', () => {
  const fnStart  = src.indexOf('const requestClose = useCallback')
  // The closing }, [deps]) appears after the callback body
  const depsStart = src.indexOf('}, [', fnStart)
  const depsEnd   = src.indexOf('])', depsStart)
  const deps      = src.slice(depsStart, depsEnd + 2)
  assert.ok(deps.includes('importing'), 'dependency array must include importing')
})

test('requestClose dependency array includes step', () => {
  const fnStart  = src.indexOf('const requestClose = useCallback')
  const depsStart = src.indexOf('}, [', fnStart)
  const depsEnd   = src.indexOf('])', depsStart)
  const deps      = src.slice(depsStart, depsEnd + 2)
  assert.ok(deps.includes('step'), 'dependency array must include step')
})

test('requestClose dependency array includes onClose', () => {
  const fnStart  = src.indexOf('const requestClose = useCallback')
  const depsStart = src.indexOf('}, [', fnStart)
  const depsEnd   = src.indexOf('])', depsStart)
  const deps      = src.slice(depsStart, depsEnd + 2)
  assert.ok(deps.includes('onClose'), 'dependency array must include onClose')
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
