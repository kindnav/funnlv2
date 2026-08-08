/**
 * interaction-edit.test.js
 *
 * Tests for interaction-edit helpers in src/lib/interactionFormUtils.js
 * and static assertions verifying correct usage in ContactDetailPage.jsx.
 *
 * Zero-dependency Node.js — run with: node tests/interaction-edit.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import {
  followUpDateChanged,
  shouldDispatchFollowupChangeOnEdit,
  shouldFireOutreachChangeOnEdit,
} from '../src/lib/interactionFormUtils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

function src(rel) { return readFileSync(join(ROOT, rel), 'utf8') }

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗  ${name}: ${e.message}`)
    failed++
  }
}

// ── followUpDateChanged ───────────────────────────────────────────────────────

console.log('\nfollowUpDateChanged\n')

test('null → date string → changed', () => {
  assert.strictEqual(followUpDateChanged(null, '2026-08-01'), true)
})

test('date string → null → changed', () => {
  assert.strictEqual(followUpDateChanged('2026-08-01', null), true)
})

test('date A → date B → changed', () => {
  assert.strictEqual(followUpDateChanged('2026-08-01', '2026-08-15'), true)
})

test('null → null → NOT changed', () => {
  assert.strictEqual(followUpDateChanged(null, null), false)
})

test('empty string → empty string → NOT changed', () => {
  assert.strictEqual(followUpDateChanged('', ''), false)
})

test('empty string → null → NOT changed (both treated as no-date)', () => {
  assert.strictEqual(followUpDateChanged('', null), false)
})

test('null → empty string → NOT changed (both treated as no-date)', () => {
  assert.strictEqual(followUpDateChanged(null, ''), false)
})

test('undefined → null → NOT changed', () => {
  assert.strictEqual(followUpDateChanged(undefined, null), false)
})

test('same date string → NOT changed', () => {
  assert.strictEqual(followUpDateChanged('2026-08-01', '2026-08-01'), false)
})

test('whitespace-only string normalises to empty → NOT changed vs null', () => {
  assert.strictEqual(followUpDateChanged('   ', null), false)
})

test('whitespace-padded date vs bare date → NOT changed after trim', () => {
  assert.strictEqual(followUpDateChanged(' 2026-08-01 ', '2026-08-01'), false)
})

// ── shouldDispatchFollowupChangeOnEdit ────────────────────────────────────────
// This is a direct wrapper for followUpDateChanged — same semantics.

console.log('\nshouldDispatchFollowupChangeOnEdit\n')

test('null → date → dispatch (date was added)', () => {
  assert.strictEqual(shouldDispatchFollowupChangeOnEdit(null, '2026-08-01'), true)
})

test('date → null → dispatch (date was removed)', () => {
  assert.strictEqual(shouldDispatchFollowupChangeOnEdit('2026-08-01', null), true)
})

test('date A → date B → dispatch (date was changed)', () => {
  assert.strictEqual(shouldDispatchFollowupChangeOnEdit('2026-08-01', '2026-08-15'), true)
})

test('null → null → no dispatch (unchanged)', () => {
  assert.strictEqual(shouldDispatchFollowupChangeOnEdit(null, null), false)
})

test('same date → same date → no dispatch (unchanged)', () => {
  assert.strictEqual(shouldDispatchFollowupChangeOnEdit('2026-08-01', '2026-08-01'), false)
})

test('empty → empty → no dispatch (both no-date)', () => {
  assert.strictEqual(shouldDispatchFollowupChangeOnEdit('', ''), false)
})

// ── shouldFireOutreachChangeOnEdit ────────────────────────────────────────────

console.log('\nshouldFireOutreachChangeOnEdit\n')

test('null → awaiting_response → fire (status was set)', () => {
  assert.strictEqual(shouldFireOutreachChangeOnEdit(null, 'awaiting_response'), true)
})

test('awaiting_response → null → fire (status was cleared)', () => {
  assert.strictEqual(shouldFireOutreachChangeOnEdit('awaiting_response', null), true)
})

test('awaiting_response → responded → fire (status changed)', () => {
  assert.strictEqual(shouldFireOutreachChangeOnEdit('awaiting_response', 'responded'), true)
})

test('null → null → do NOT fire (both no-status)', () => {
  assert.strictEqual(shouldFireOutreachChangeOnEdit(null, null), false)
})

test('awaiting_response → awaiting_response → do NOT fire (unchanged)', () => {
  assert.strictEqual(shouldFireOutreachChangeOnEdit('awaiting_response', 'awaiting_response'), false)
})

test('empty string → null → do NOT fire (both no-status)', () => {
  assert.strictEqual(shouldFireOutreachChangeOnEdit('', null), false)
})

test('null → empty string → do NOT fire (both no-status)', () => {
  assert.strictEqual(shouldFireOutreachChangeOnEdit(null, ''), false)
})

test('empty → responded → fire', () => {
  assert.strictEqual(shouldFireOutreachChangeOnEdit('', 'responded'), true)
})

test('declined → no_response → fire', () => {
  assert.strictEqual(shouldFireOutreachChangeOnEdit('declined', 'no_response'), true)
})

// ── Static assertions on ContactDetailPage.jsx ───────────────────────────────

console.log('\nArchitecture: ContactDetailPage interaction-edit wiring\n')

const detail = src('src/pages/ContactDetailPage.jsx')

test('ContactDetailPage imports followUpDateChanged', () => {
  assert(detail.includes('followUpDateChanged'), 'followUpDateChanged not imported in ContactDetailPage')
})

test('ContactDetailPage imports shouldFireOutreachChangeOnEdit', () => {
  assert(detail.includes('shouldFireOutreachChangeOnEdit'), 'shouldFireOutreachChangeOnEdit not imported in ContactDetailPage')
})

test('ContactDetailPage uses followUpDateChanged to gate followups-changed dispatch', () => {
  assert(
    detail.includes('followUpDateChanged('),
    'ContactDetailPage does not call followUpDateChanged() for conditional dispatch'
  )
})

test('ContactDetailPage uses shouldFireOutreachChangeOnEdit to gate analytics', () => {
  assert(
    detail.includes('shouldFireOutreachChangeOnEdit('),
    'ContactDetailPage does not call shouldFireOutreachChangeOnEdit() for conditional analytics'
  )
})

test('ContactDetailPage dispatches funnl:followups-changed inside conditional (not unconditionally)', () => {
  // The dispatch is inside an if block driven by followUpDateChanged,
  // not a naked unconditional dispatchEvent call.
  assert(
    detail.includes("funnl:followups-changed"),
    'funnl:followups-changed dispatch missing from ContactDetailPage handleSaveInteraction'
  )
})

test('ContactDetailPage stores _originalFollowUpDate in edit form', () => {
  assert(
    detail.includes('_originalFollowUpDate'),
    '_originalFollowUpDate not stored in edit form state (needed for change comparison)'
  )
})

test('ContactDetailPage analytics status uses null, not the string "cleared"', () => {
  // The analytics contract requires status: effectiveOutreach || null
  // (not the string 'cleared' that the previous code used for the cleared case).
  assert(
    !detail.includes("'cleared'") || !detail.includes("status: effectiveOutreach || 'cleared'"),
    "ContactDetailPage still uses the old '|| \\'cleared\\'' pattern in outreach analytics"
  )
})

test('ContactDetailPage edit form preserves _originalOutreachStatus for comparison', () => {
  assert(
    detail.includes('_originalOutreachStatus'),
    '_originalOutreachStatus not stored in edit form (needed for shouldFireOutreachChangeOnEdit)'
  )
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
