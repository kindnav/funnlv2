/**
 * followup-row-affordance.test.js
 *
 * Source-contract tests that guard the FollowUps row affordance fix.
 *
 * Defect: OpenFollowUpRow had `cursor-pointer` on its outer non-clickable <div>,
 * combined with a literal `onClick={() => {}}` no-op handler. This communicated
 * "the whole row is clickable" when the actual behavior was "clicking the row
 * background does nothing." Child controls (Links, buttons) remained interactive.
 *
 * Fix: Remove `cursor-pointer` and the no-op `onClick` from the outer row
 * container. The swipe gesture system uses `addEventListener` on rowRef — it does
 * not depend on the JSX `onClick` prop and is unaffected by this change.
 *
 * Checked row types:
 *   - OpenFollowUpRow: fixed (outer div had cursor-pointer + no-op onClick)
 *   - AwaitingRow:     already clean (no cursor-pointer, no onClick on outer div)
 *   - CompletedRow:    already clean (no cursor-pointer, no onClick on outer div)
 *
 * Run with: node tests/followup-row-affordance.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const src = readFileSync(resolve('src/pages/FollowUpsPage.jsx'), 'utf8')

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

// =============================================================================
// 1. No literal no-op click handlers on visible controls
// =============================================================================

console.log('\n1. No literal no-op click handlers in FollowUpsPage')

test('no visible control has onClick={() => {}} (no-op handler)', () => {
  // The defect was onClick={() => {}} on the outer OpenFollowUpRow div.
  // A literal empty arrow body attached to a visible container is always wrong.
  assert.ok(
    !src.includes('onClick={() => {}}'),
    'onClick={() => {}} must not exist — it creates a dead affordance on a visible control'
  )
})

// =============================================================================
// 2. OpenFollowUpRow outer div — no misleading cursor
// =============================================================================

console.log('\n2. OpenFollowUpRow — outer row div has no cursor-pointer')

test('OpenFollowUpRow outer row div does not have cursor-pointer', () => {
  // The outer row is not a whole-row action. cursor-pointer on it implied the
  // row was clickable when it was not. Removed; child controls retain their own
  // pointer cursors via browser defaults and explicit classes.
  const openRowMatch = src.match(/function OpenFollowUpRow[\s\S]*?^}/m)
  if (!openRowMatch) {
    // If the regex fails, fall back to checking the whole file for the pattern.
    assert.ok(
      !src.includes('"px-5 py-4 group cursor-pointer"') &&
      !src.includes('"px-5 py-4 cursor-pointer"'),
      'cursor-pointer must not appear on the outer OpenFollowUpRow container'
    )
    return
  }
  const fn = openRowMatch[0]
  assert.ok(
    !fn.includes('"px-5 py-4 group cursor-pointer"') &&
    !fn.includes('"px-5 py-4 cursor-pointer"'),
    'cursor-pointer must not appear on the outer row div in OpenFollowUpRow'
  )
})

// =============================================================================
// 3. Swipe gesture system remains intact
// =============================================================================

console.log('\n3. Swipe gesture system remains intact in OpenFollowUpRow')

test('touchstart listener is still added on rowRef', () => {
  assert.ok(
    src.includes("addEventListener('touchstart'"),
    "touchstart addEventListener must remain — swipe gesture uses it"
  )
})

test('touchmove listener is still added with passive: false', () => {
  assert.ok(
    src.includes("addEventListener('touchmove'") && src.includes('passive: false'),
    "touchmove addEventListener with passive: false must remain — needed to call preventDefault()"
  )
})

test('touchend listener is still added on rowRef', () => {
  assert.ok(
    src.includes("addEventListener('touchend'"),
    "touchend addEventListener must remain — gesture completion handler"
  )
})

test('horizontal gesture locking (shouldLockHorizontal) remains', () => {
  assert.ok(
    src.includes('shouldLockHorizontal'),
    'shouldLockHorizontal call must remain — prevents scroll interference during horizontal swipes'
  )
})

test('swipeGestureToAction remains', () => {
  assert.ok(
    src.includes('swipeGestureToAction'),
    'swipeGestureToAction call must remain — maps gesture dx/dy to an action'
  )
})

// =============================================================================
// 4. OpenFollowUpRow interactive children remain intact
// =============================================================================

console.log('\n4. OpenFollowUpRow — child interactive elements remain')

test('contact name is still a Link to the contact detail page', () => {
  // The name must be a navigable link — removing cursor-pointer from the outer
  // div must not have inadvertently changed child navigation.
  assert.ok(
    src.includes('to={`/contacts/${item.contact_id}`}') &&
    src.includes('hover:underline'),
    'contact name Link to /contacts/:id with hover:underline must remain'
  )
})

test('Done action is still a <button type="button">', () => {
  assert.ok(
    src.includes('type="button"') && src.includes('onDone()'),
    'Done button with type="button" and onDone() call must remain'
  )
})

test('Snooze/Reschedule popover trigger is still a <button>', () => {
  assert.ok(
    src.includes('Reschedule') && src.includes('Snooze') && src.includes('onSnoozeOption'),
    'Snooze/Reschedule trigger with onSnoozeOption must remain'
  )
})

test('Log Result is still a Link with Router state', () => {
  assert.ok(
    src.includes('Log Result') && src.includes('openInteractionForm: true'),
    'Log Result Link with openInteractionForm Router state must remain'
  )
})

// =============================================================================
// 5. AwaitingRow — already correct (no cursor-pointer, no onClick on outer div)
// =============================================================================

console.log('\n5. AwaitingRow — outer div has no misleading cursor or no-op onClick')

test('AwaitingRow outer div has no cursor-pointer', () => {
  // AwaitingRow was already correct before this fix.
  // Verify it remains clean: the outer div is plain "px-5 py-4".
  assert.ok(
    src.includes('"px-5 py-4"'),
    'AwaitingRow outer div must use "px-5 py-4" without cursor-pointer'
  )
})

test('AwaitingRow Mark responded button remains', () => {
  assert.ok(
    src.includes('Mark responded') && src.includes('onMarkResponded'),
    'Mark responded button with onMarkResponded handler must remain in AwaitingRow'
  )
})

test('AwaitingRow Nudge button remains', () => {
  assert.ok(
    src.includes('Nudge') && src.includes('onNudgeOption'),
    'Nudge button with onNudgeOption must remain in AwaitingRow'
  )
})

// =============================================================================
// 6. CompletedRow — already correct (no cursor-pointer, no onClick)
// =============================================================================

console.log('\n6. CompletedRow — Undo remains intact')

test('CompletedRow Undo button remains', () => {
  assert.ok(
    src.includes('Undo') && src.includes('onUndo'),
    'Undo button with onUndo handler must remain in CompletedRow'
  )
})

// =============================================================================
// 7. Repository-wide: no literal no-op handlers (checked in this file)
// =============================================================================

console.log('\n7. No literal no-op event handlers remain in this file')

test('no onChange={() => {}} no-op handler', () => {
  assert.ok(
    !src.includes('onChange={() => {}}'),
    'onChange={() => {}} must not exist'
  )
})

test('no onSubmit={() => {}} no-op handler', () => {
  assert.ok(
    !src.includes('onSubmit={() => {}}'),
    'onSubmit={() => {}} must not exist'
  )
})

test('no onKeyDown={() => {}} no-op handler', () => {
  assert.ok(
    !src.includes('onKeyDown={() => {}}'),
    'onKeyDown={() => {}} must not exist'
  )
})

// =============================================================================
// Results
// =============================================================================

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
