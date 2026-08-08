/**
 * followup-mobile.test.js
 *
 * Tests for src/lib/swipeGesture.js pure functions and static assertions
 * about the mobile swipe progressive enhancement in FollowUpsPage.
 *
 * Zero-dependency Node.js — run with: node tests/followup-mobile.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import {
  SWIPE_THRESHOLD_PX,
  DIRECTION_LOCK_RATIO,
  classifySwipeGesture,
  shouldLockHorizontal,
  swipeGestureToAction,
} from '../src/lib/swipeGesture.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dir, '..')

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

// ── Constants ─────────────────────────────────────────────────────────────────

console.log('\nswipeGesture constants\n')

test('SWIPE_THRESHOLD_PX is 60', () => {
  assert.strictEqual(SWIPE_THRESHOLD_PX, 60)
})

test('DIRECTION_LOCK_RATIO is 1.5', () => {
  assert.strictEqual(DIRECTION_LOCK_RATIO, 1.5)
})

// ── classifySwipeGesture ──────────────────────────────────────────────────────

console.log('\nclassifySwipeGesture\n')

test('returns none for horizontal displacement below threshold', () => {
  assert.strictEqual(classifySwipeGesture(59, 0), 'none')
})

test('returns right at exactly the threshold (right)', () => {
  assert.strictEqual(classifySwipeGesture(60, 0), 'right')
})

test('returns left at exactly the threshold (left)', () => {
  assert.strictEqual(classifySwipeGesture(-60, 0), 'left')
})

test('returns right for large rightward swipe', () => {
  assert.strictEqual(classifySwipeGesture(200, 5), 'right')
})

test('returns left for large leftward swipe', () => {
  assert.strictEqual(classifySwipeGesture(-200, 5), 'left')
})

test('returns none for mostly vertical gesture (dy > dx)', () => {
  assert.strictEqual(classifySwipeGesture(60, 100), 'none')
})

test('returns none for diagonal gesture below lock ratio (adx/ady < 1.5)', () => {
  // adx=70, ady=50 → ratio = 1.4 → below lock ratio
  assert.strictEqual(classifySwipeGesture(70, 50), 'none')
})

test('returns right for diagonal gesture AT lock ratio', () => {
  // adx=90, ady=60 → ratio = 1.5 → exactly at boundary
  assert.strictEqual(classifySwipeGesture(90, 60), 'right')
})

test('pure zero movement returns none', () => {
  assert.strictEqual(classifySwipeGesture(0, 0), 'none')
})

// ── shouldLockHorizontal ──────────────────────────────────────────────────────

console.log('\nshouldLockHorizontal\n')

test('returns true when adx >= 10 and ratio >= DIRECTION_LOCK_RATIO', () => {
  // adx=30, ady=10 → ratio=3 → should lock
  assert.strictEqual(shouldLockHorizontal(30, 10), true)
})

test('returns false when adx < 10 (not yet committed)', () => {
  assert.strictEqual(shouldLockHorizontal(9, 0), false)
})

test('returns false when movement is primarily vertical', () => {
  // adx=20, ady=30 → ratio=0.67 → vertical
  assert.strictEqual(shouldLockHorizontal(20, 30), false)
})

test('handles zero dy without division by zero', () => {
  assert.strictEqual(shouldLockHorizontal(30, 0), true)
})

// ── swipeGestureToAction ──────────────────────────────────────────────────────

console.log('\nswipeGestureToAction\n')

test('right gesture maps to reveal-done', () => {
  assert.strictEqual(swipeGestureToAction('right'), 'reveal-done')
})

test('left gesture maps to reveal-date-action', () => {
  assert.strictEqual(swipeGestureToAction('left'), 'reveal-date-action')
})

test('none gesture maps to null', () => {
  assert.strictEqual(swipeGestureToAction('none'), null)
})

test('unknown gesture maps to null', () => {
  assert.strictEqual(swipeGestureToAction('up'), null)
})

// ── Static assertions about FollowUpsPage ────────────────────────────────────

console.log('\nFollowUpsPage static assertions — swipe integration\n')

const followUpsSrc = readFileSync(join(projectRoot, 'src/pages/FollowUpsPage.jsx'), 'utf8')

test('imports swipeGesture module', () => {
  assert.ok(
    followUpsSrc.includes('swipeGesture') || followUpsSrc.includes('classifySwipeGesture'),
    'FollowUpsPage must import from swipeGesture.js'
  )
})

test('manages swipeOpenId state at page level (one open row at a time)', () => {
  assert.ok(
    followUpsSrc.includes('swipeOpenId'),
    'Must track which row has swipe open via swipeOpenId state'
  )
})

test('has touchstart event handling', () => {
  assert.ok(
    followUpsSrc.includes('touchstart') || followUpsSrc.includes('onTouchStart'),
    'Must attach touchstart handler for swipe detection'
  )
})

test('has touchmove event handling', () => {
  assert.ok(
    followUpsSrc.includes('touchmove') || followUpsSrc.includes('onTouchMove'),
    'Must attach touchmove handler for swipe tracking'
  )
})

test('has touchend event handling', () => {
  assert.ok(
    followUpsSrc.includes('touchend') || followUpsSrc.includes('onTouchEnd'),
    'Must attach touchend handler for swipe completion'
  )
})

test('explicit Done and Snooze buttons are always present (swipe is progressive enhancement)', () => {
  // Swipe reveals a button but the explicit primary buttons always exist
  const hasDoneButton = followUpsSrc.includes('Done') || followUpsSrc.includes('handleDone')
  const hasSnoozeButton = followUpsSrc.includes('Snooze') || followUpsSrc.includes('handleSnooze')
  assert.ok(hasDoneButton && hasSnoozeButton, 'Primary Done and Snooze buttons must always render')
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
