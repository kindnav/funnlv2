/**
 * import-modal-accessibility.test.js
 *
 * Static assertions for accessibility requirements on ImportContactsModal.jsx.
 * Reads the modal source file and verifies the presence of required ARIA attributes,
 * semantic markup, keyboard handling, and focus management patterns.
 *
 * Run with: node tests/import-modal-accessibility.test.js
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

// ── Modal container ARIA ──────────────────────────────────────────────────────

console.log('\nmodal container ARIA attributes')

test('modal panel has role="dialog"', () => {
  assert.ok(src.includes('role="dialog"'), 'must include role="dialog"')
})

test('modal panel has aria-modal="true"', () => {
  assert.ok(src.includes('aria-modal="true"'), 'must include aria-modal="true"')
})

test('modal panel has aria-labelledby="import-modal-title"', () => {
  assert.ok(src.includes('aria-labelledby="import-modal-title"'), 'must include aria-labelledby pointing to title id')
})

test('modal title element has id="import-modal-title"', () => {
  assert.ok(src.includes('id="import-modal-title"'), 'title must have id="import-modal-title"')
})

// ── Heading and focus management ──────────────────────────────────────────────

console.log('\nheading and focus management')

test('modal title uses completionHeadingRef', () => {
  assert.ok(src.includes('completionHeadingRef'), 'must use completionHeadingRef for done-step focus')
})

test('modal title has tabIndex={-1} for programmatic focus', () => {
  assert.ok(src.includes('tabIndex={-1}'), 'title must have tabIndex={-1}')
})

test('completion heading focus effect fires on step === "done"', () => {
  assert.ok(
    src.includes("step === 'done'") && src.includes('completionHeadingRef.current.focus()'),
    'focus must be moved to heading when step becomes "done"'
  )
})

test('modalRef is declared and attached to modal panel', () => {
  assert.ok(src.includes('modalRef'), 'modalRef must be declared and used')
})

// ── Keyboard handling ─────────────────────────────────────────────────────────

console.log('\nkeyboard handling')

test('Escape key handler is present', () => {
  assert.ok(
    src.includes("'Escape'") || src.includes('"Escape"'),
    'must handle Escape key for close'
  )
})

test('Tab key is handled for focus trapping', () => {
  assert.ok(
    src.includes("'Tab'") || src.includes('"Tab"'),
    'must handle Tab key for focus trap'
  )
})

test('addEventListener for keydown is present', () => {
  assert.ok(src.includes("addEventListener('keydown'") || src.includes('addEventListener("keydown"'), 'must add keydown listener')
})

test('removeEventListener cleanup is present', () => {
  assert.ok(src.includes("removeEventListener('keydown'") || src.includes('removeEventListener("keydown"'), 'must remove keydown listener on cleanup')
})

test('focus trap queries focusable elements', () => {
  // Focus trap implementation must query interactive elements
  assert.ok(
    src.includes('querySelectorAll') || src.includes('querySelector'),
    'focus trap must query focusable elements within modal'
  )
})

// ── Body scroll lock ──────────────────────────────────────────────────────────

console.log('\nbody scroll lock')

test('body overflow is set to hidden on mount', () => {
  assert.ok(
    src.includes("document.body.style.overflow = 'hidden'") ||
    src.includes('document.body.style.overflow="hidden"'),
    'must lock body scroll on mount'
  )
})

test('body overflow is restored on unmount', () => {
  // The cleanup function restores the previous value
  assert.ok(
    src.includes('document.body.style.overflow = prev') ||
    src.includes("document.body.style.overflow = ''") ||
    (src.includes('const prev') && src.includes('document.body.style.overflow')),
    'must restore body overflow on unmount'
  )
})

// ── Stepper accessibility ─────────────────────────────────────────────────────

console.log('\nstepper accessibility')

test('stepper uses <ol> element', () => {
  assert.ok(src.includes('<ol'), 'stepper must be an ordered list <ol>')
})

test('stepper steps use <li> elements', () => {
  assert.ok(src.includes('<li'), 'stepper items must be <li> elements')
})

test('active step has aria-current="step"', () => {
  assert.ok(
    src.includes("aria-current={active ? 'step' : undefined}") ||
    src.includes("aria-current='step'") ||
    src.includes('aria-current="step"'),
    'active step must have aria-current="step"'
  )
})

test('stepper has aria-label', () => {
  assert.ok(
    src.includes('aria-label="Import steps"') || src.includes("aria-label='Import steps'"),
    'stepper ol must have aria-label="Import steps"'
  )
})

// ── Screen reader text ────────────────────────────────────────────────────────

console.log('\nscreen reader text')

test('sr-only class is used for screen reader labels', () => {
  assert.ok(src.includes('sr-only'), 'must use sr-only for screen reader text')
})

// ── Progress bar ARIA ─────────────────────────────────────────────────────────

console.log('\nprogress bar ARIA')

test('progress bar has role="progressbar"', () => {
  assert.ok(src.includes('role="progressbar"'), 'progress bar must have role="progressbar"')
})

test('progress bar has aria-valuemin', () => {
  assert.ok(src.includes('aria-valuemin'), 'progress bar must have aria-valuemin')
})

test('progress bar has aria-valuemax', () => {
  assert.ok(src.includes('aria-valuemax'), 'progress bar must have aria-valuemax')
})

test('progress bar has aria-valuenow', () => {
  assert.ok(src.includes('aria-valuenow'), 'progress bar must have aria-valuenow')
})

test('importProgressRef is used for dynamic aria-valuenow', () => {
  assert.ok(src.includes('importProgressRef'), 'must use importProgressRef for live aria-valuenow updates')
})

// ── DB duplicate checkbox accessibility ───────────────────────────────────────

console.log('\nDB duplicate checkbox accessibility')

test('DB dup checkbox has disabled attribute logic', () => {
  assert.ok(
    src.includes('disabled={') || src.includes('disabled='),
    'duplicate-row checkbox must use disabled attribute'
  )
})

test('"Import as separate contact" override button exists', () => {
  assert.ok(
    src.includes('Import as separate contact'),
    'must have override button for DB duplicates'
  )
})

test('overrideDbDup function is defined', () => {
  assert.ok(src.includes('overrideDbDup'), 'overrideDbDup function must be defined')
})

// ── Funnel SVG decorative aria ────────────────────────────────────────────────

console.log('\nfunnel SVG decorative aria')

test('done-step SVG layers have aria-hidden="true"', () => {
  assert.ok(src.includes('aria-hidden="true"'), 'decorative SVGs must be aria-hidden')
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
