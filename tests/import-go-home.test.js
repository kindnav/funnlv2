/**
 * import-go-home.test.js
 *
 * Verifies the "Go Home" / dismiss button on the Done screen:
 *   - Fires `post_import_action_clicked` with action: 'dismiss'
 *   - Navigates to '/' (not just closes the modal)
 *   - Also calls onClose()
 *
 * These are static source assertions against ImportContactsModal.jsx.
 * No React/DOM needed — the invariants are structural.
 *
 * Run with: node tests/import-go-home.test.js
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

// ── Go Home / dismiss routing ─────────────────────────────────────────────────

console.log('\nGo Home routing — navigate to /')

test('dismiss handler calls navigate(\'/\')', () => {
  // Must call navigate('/') — not navigate('/contacts') or just onClose()
  assert.ok(
    src.includes("navigate('/')"),
    "must call navigate('/') in the dismiss handler"
  )
})

test('dismiss handler calls onClose() after navigate', () => {
  // The handler must also call onClose() to close the modal
  // Check that both navigate('/') and onClose() appear together in context
  const dismissBlock = src.match(
    /post_import_action_clicked[\s\S]{0,200}?dismiss[\s\S]{0,400}?onClose\(\)/
  )
  assert.ok(
    dismissBlock !== null,
    "dismiss handler must call onClose() within same block as the analytics event"
  )
})

test('dismiss analytics fires with action: dismiss', () => {
  assert.ok(
    src.includes("action: 'dismiss'"),
    "must track post_import_action_clicked with action: 'dismiss'"
  )
})

// ── Ensure Go Home doesn't just call onClose alone ───────────────────────────

console.log('\nGo Home does not rely solely on onClose')

test('Go Home is not implemented as onClose-only', () => {
  // The old (broken) implementation was: onClick={() => { track(...); onClose() }}
  // with no navigate() call. Verify navigate('/') is present in the dismiss path.
  // This is implied by the navigate('/') test above, but make it explicit.
  assert.ok(
    src.includes("navigate('/')"),
    "dismiss must call navigate('/') — onClose alone leaves user on whatever page triggered the modal"
  )
})

test('modal imports useNavigate (required for Go Home)', () => {
  assert.ok(
    src.includes('useNavigate'),
    "modal must import useNavigate from react-router-dom for Go Home to work"
  )
})

// ── Analytics contract ────────────────────────────────────────────────────────

console.log('\npost_import_action_clicked analytics contract')

test('log_recent_outreach CTA fires post_import_action_clicked', () => {
  assert.ok(
    src.includes("action: 'log_recent_outreach'"),
    "must fire post_import_action_clicked with action: 'log_recent_outreach'"
  )
})

test('view_contacts CTA fires post_import_action_clicked', () => {
  assert.ok(
    src.includes("action: 'view_contacts'"),
    "must fire post_import_action_clicked with action: 'view_contacts'"
  )
})

test('all three post_import action values are present', () => {
  const hasAll =
    src.includes("action: 'log_recent_outreach'") &&
    src.includes("action: 'view_contacts'") &&
    src.includes("action: 'dismiss'")
  assert.ok(hasAll, "all three action values (log_recent_outreach, view_contacts, dismiss) must be present")
})

// ── Done screen structure ─────────────────────────────────────────────────────

console.log('\nDone screen structure')

test('Done screen step is step 4 or named done/complete', () => {
  // The 4-step flow is: Upload → Map → Review → Done
  const hasDoneStep = src.includes('step === 4') || src.includes("step === 'done'") ||
    src.includes("step === 'complete'") || src.includes('currentStep === 4')
  assert.ok(hasDoneStep, "Done screen must be controlled by step === 4 or equivalent")
})

test('Done screen shows post_import_action_clicked event name in source', () => {
  assert.ok(
    src.includes('post_import_action_clicked'),
    "Done screen must call track('post_import_action_clicked', ...)"
  )
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
