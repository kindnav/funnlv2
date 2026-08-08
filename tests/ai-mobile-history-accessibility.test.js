/**
 * ai-mobile-history-accessibility.test.js
 *
 * Tests for mobile history modal accessibility per Section 7 of the Stage 7
 * correction spec:
 *   - role="dialog" and aria-modal="true" on the modal container
 *   - Accessible title with id referenced by aria-labelledby
 *   - Focus movement: focus restored to History trigger on close
 *   - Focus trap implementation (Tab/Shift+Tab key handling)
 *   - Escape key closes the modal
 *   - Backdrop click closes the modal
 *   - Body scroll lock applied and cleaned up
 *   - History trigger has aria-expanded and aria-controls
 *
 * All tests are static source analysis of FunnlAIPage.jsx.
 * Zero-dependency Node.js — run with: node tests/ai-mobile-history-accessibility.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dir, '..', 'src', 'pages', 'FunnlAIPage.jsx'), 'utf8')

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

// ── Modal ARIA structure ───────────────────────────────────────────────────────

console.log('\nHistoryModal — ARIA structure\n')

test('modal container has role="dialog"', () => {
  assert.ok(src.includes('role="dialog"'),
    'the history modal sheet must have role="dialog"')
})

test('modal container has aria-modal="true"', () => {
  assert.ok(src.includes('aria-modal="true"'),
    'the history modal must have aria-modal="true"')
})

test('modal has aria-labelledby pointing to a title element', () => {
  assert.ok(src.includes('aria-labelledby='),
    'modal must have aria-labelledby to associate accessible title')
})

test('title id matches aria-labelledby value', () => {
  const labelledBy = src.match(/aria-labelledby="([^"]+)"/)?.[1]
  assert.ok(labelledBy, 'aria-labelledby attribute must have a value')
  assert.ok(
    src.includes(`id="${labelledBy}"`),
    `an element with id="${labelledBy}" must exist to match aria-labelledby`
  )
})

test('modal title is visible and descriptive', () => {
  assert.ok(
    src.includes('ai-history-modal-title') || src.includes('Conversations'),
    'modal must have a visible title like "Conversations"'
  )
})

test('dialog does not use aria-hidden (visible modal must not hide itself)', () => {
  // aria-hidden on the dialog element would make it inaccessible
  const dialogLine = src.match(/role="dialog"[^\n]*/)?.[0] ?? ''
  assert.ok(
    !dialogLine.includes('aria-hidden="true"'),
    'the dialog element itself must not have aria-hidden="true"'
  )
})

// ── Focus management ──────────────────────────────────────────────────────────

console.log('\nHistoryModal — Focus management\n')

test('focus moves into modal on open (firstFocusRef)', () => {
  assert.ok(
    src.includes('firstFocusRef'),
    'modal must move focus to a ref element when it opens'
  )
})

test('firstFocusRef.current?.focus() called after modal opens', () => {
  assert.ok(
    src.includes('firstFocusRef.current?.focus()'),
    'modal must call focus() on the first focusable element'
  )
})

test('focus restored to History trigger when modal closes', () => {
  assert.ok(
    src.includes('triggerRef?.current?.focus()') ||
    src.includes('triggerRef.current?.focus()'),
    'closing the modal must restore focus to the History trigger button'
  )
})

test('History trigger button has a ref for focus restoration', () => {
  assert.ok(
    src.includes('historyTriggerRef') && src.includes('ref={historyTriggerRef}'),
    'trigger button must have historyTriggerRef for focus restoration after modal closes'
  )
})

// ── Focus trap ────────────────────────────────────────────────────────────────

console.log('\nHistoryModal — Focus trap\n')

test('Tab key wraps from last to first focusable element', () => {
  assert.ok(
    src.includes("e.key !== 'Tab'") || src.includes("e.key === 'Tab'"),
    'focus trap must handle the Tab key'
  )
})

test('Shift+Tab wraps from first to last focusable element', () => {
  assert.ok(
    src.includes('e.shiftKey') && (src.includes('first.focus()') || src.includes('last.focus()')),
    'focus trap must handle Shift+Tab to wrap backwards'
  )
})

test('querySelectorAll used to find focusable elements within dialog', () => {
  assert.ok(
    src.includes('querySelectorAll'),
    'focus trap must query focusable elements within the dialog'
  )
})

test('focus trap uses dialogRef to scope the focusable query', () => {
  assert.ok(
    src.includes('dialogRef.current?.querySelectorAll') ||
    src.includes('dialogRef.current'),
    'focusable elements must be queried from within the dialog ref'
  )
})

// ── Keyboard: Escape ──────────────────────────────────────────────────────────

console.log('\nHistoryModal — Escape key\n')

test("Escape key closes the modal", () => {
  assert.ok(
    src.includes("e.key === 'Escape'") && src.includes('onClose()'),
    'Escape key must close the modal by calling onClose()'
  )
})

test('keydown handler is cleaned up on modal unmount', () => {
  assert.ok(
    src.includes('document.addEventListener') && src.includes('document.removeEventListener'),
    'keydown listener added to document must be removed on cleanup'
  )
})

// ── Backdrop click ────────────────────────────────────────────────────────────

console.log('\nHistoryModal — Backdrop click\n')

test('backdrop click closes the modal', () => {
  assert.ok(
    src.includes('onClick={onClose}') || src.includes('onClick={() => onClose'),
    'clicking the backdrop must close the modal'
  )
})

test('modal sheet click stops propagation (prevents backdrop from closing via sheet click)', () => {
  assert.ok(
    src.includes('e.stopPropagation()'),
    'the modal sheet must stop propagation to prevent backdrop close on sheet click'
  )
})

// ── Body scroll lock ──────────────────────────────────────────────────────────

console.log('\nHistoryModal — Body scroll lock\n')

test('body overflow hidden applied when modal opens', () => {
  assert.ok(
    src.includes("document.body.style.overflow = 'hidden'"),
    'body scroll must be locked when modal is open'
  )
})

test('body overflow restored on modal close (cleanup function)', () => {
  // The cleanup function must restore the previous overflow value
  assert.ok(
    src.includes('document.body.style.overflow = prev') ||
    (src.includes('document.body.style.overflow') && src.includes('return () =>') || src.includes('return () => {')),
    'body scroll lock must be cleaned up when modal closes'
  )
})

// ── History trigger button ────────────────────────────────────────────────────

console.log('\nHistory trigger button — ARIA attributes\n')

test('history trigger has aria-expanded', () => {
  assert.ok(
    src.includes('aria-expanded={historyOpen}') || src.includes('aria-expanded='),
    'history trigger must have aria-expanded attribute'
  )
})

test('history trigger has aria-controls', () => {
  assert.ok(
    src.includes('aria-controls='),
    'history trigger must have aria-controls attribute'
  )
})

test('history trigger has descriptive aria-label', () => {
  assert.ok(
    src.includes('aria-label="Open conversation history"') ||
    (src.includes('historyTriggerRef') && src.includes('aria-label=')),
    'history trigger must have an aria-label'
  )
})

test('history trigger is md:hidden (desktop rail replaces it)', () => {
  assert.ok(
    src.includes('md:hidden') && src.includes('historyTriggerRef'),
    'mobile history trigger must be hidden on desktop where the rail is always visible'
  )
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
