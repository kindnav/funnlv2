// Regression tests for dismissConfirmFocusTarget — the fix for the Dismiss
// keyboard-focus regression on the Calendar review card.
//
// Before the fix: opening Dismiss focused "Yes, dismiss" and Escape closed the
// confirmation, but document.activeElement fell to <body>. After the fix, cancelling
// via Cancel OR Escape restores focus to the initiating Dismiss button.
//
// Run: node tests/dismiss-confirm-focus.test.js

import { strict as assert } from 'assert'
import { test } from 'node:test'
import { dismissConfirmFocusTarget } from '../src/lib/dismissConfirmFocus.js'

await test("opening the confirmation focuses the primary 'Yes, dismiss' button", () => {
  assert.strictEqual(dismissConfirmFocusTarget('open'), 'confirm')
})

await test('Cancel restores focus to the initiating Dismiss button', () => {
  assert.strictEqual(dismissConfirmFocusTarget('cancel'), 'dismiss')
})

await test('Escape restores focus to the initiating Dismiss button', () => {
  assert.strictEqual(dismissConfirmFocusTarget('escape'), 'dismiss')
})

await test('regression: both cancel paths resolve to the SAME target (never null/body)', () => {
  const cancel = dismissConfirmFocusTarget('cancel')
  const escape = dismissConfirmFocusTarget('escape')
  assert.strictEqual(cancel, escape)
  assert.strictEqual(cancel, 'dismiss')
  assert.notStrictEqual(cancel, null) // the old behavior left focus on <body>
})

await test('unknown actions yield no focus move', () => {
  assert.strictEqual(dismissConfirmFocusTarget('unknown'), null)
  assert.strictEqual(dismissConfirmFocusTarget(undefined), null)
})

console.log('All dismiss-confirm-focus tests passed.')
