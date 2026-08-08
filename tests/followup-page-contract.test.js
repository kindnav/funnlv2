/**
 * followup-page-contract.test.js
 *
 * Static structural assertions about FollowUpsPage.jsx.
 * Verifies imports, group order, action presence, accessibility attributes,
 * popover behavior, and key contracts — without rendering the component.
 *
 * Zero-dependency Node.js — run with: node tests/followup-page-contract.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import {
  waitingCount,
  waitingCopy,
} from '../src/lib/followUpUtils.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dir, '..')
const src = readFileSync(join(projectRoot, 'src/pages/FollowUpsPage.jsx'), 'utf8')

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

// ── Imports ───────────────────────────────────────────────────────────────────

console.log('\nImports\n')

test('imports TopBar', () => {
  assert.ok(src.includes("import TopBar"), 'must import TopBar component')
})

test('imports followUpUtils', () => {
  assert.ok(src.includes("followUpUtils"), 'must import from followUpUtils')
})

test('imports followUpActions', () => {
  assert.ok(
    src.includes("followUpActions"),
    'must import shared followUpActions module'
  )
})

test('imports swipeGesture or individual swipe exports', () => {
  assert.ok(
    src.includes('swipeGesture') || src.includes('classifySwipeGesture'),
    'must import from swipeGesture.js for swipe progressive enhancement'
  )
})

test('imports getAvatarColor and getInitials', () => {
  assert.ok(src.includes('getAvatarColor') && src.includes('getInitials'))
})

test('imports groupAndSortFollowUps', () => {
  assert.ok(src.includes('groupAndSortFollowUps'))
})

test('imports waitingCount and waitingCopy', () => {
  assert.ok(src.includes('waitingCount') && src.includes('waitingCopy'))
})

// ── Group order ───────────────────────────────────────────────────────────────

console.log('\nGroup order (Overdue → Today → Awaiting Response → Upcoming → Recently Completed)\n')

test('Overdue group appears before Today in source', () => {
  const overdueIdx = src.indexOf('"Overdue"')
  const todayIdx   = src.indexOf('"Today"')
  assert.ok(overdueIdx !== -1, 'Overdue group must exist')
  assert.ok(todayIdx !== -1, 'Today group must exist')
  assert.ok(overdueIdx < todayIdx, 'Overdue must appear before Today')
})

test('Today group appears before Awaiting response in source', () => {
  const todayIdx    = src.indexOf('"Today"')
  const awaitingIdx = src.indexOf('"Awaiting response"') !== -1
    ? src.indexOf('"Awaiting response"')
    : src.indexOf("'Awaiting response'")
  assert.ok(awaitingIdx !== -1, 'Awaiting response group must exist')
  assert.ok(todayIdx < awaitingIdx, 'Today must appear before Awaiting response')
})

test('Awaiting response group appears before Upcoming in source', () => {
  const awaitingIdx = src.indexOf('"Awaiting response"')
  const upcomingIdx = src.indexOf('"Upcoming"')
  assert.ok(upcomingIdx !== -1, 'Upcoming group must exist')
  assert.ok(awaitingIdx < upcomingIdx, 'Awaiting response must appear before Upcoming')
})

test('Upcoming group appears before Recently completed in source', () => {
  const upcomingIdx   = src.indexOf('"Upcoming"')
  const completedIdx  = src.indexOf('"Recently completed"')
  assert.ok(completedIdx !== -1, 'Recently completed group must exist')
  assert.ok(upcomingIdx < completedIdx, 'Upcoming must appear before Recently completed')
})

// ── waitingCount formula ──────────────────────────────────────────────────────

console.log('\nwaitingCount formula\n')

test('waitingCount counts overdue + today + awaitingResponse', () => {
  const overdue = [{}, {}]
  const today   = [{}]
  const awaiting = [{}]
  assert.strictEqual(waitingCount(overdue, today, awaiting), 4)
})

test('waitingCount is zero when all groups empty', () => {
  assert.strictEqual(waitingCount([], [], []), 0)
})

test('waitingCount excludes upcoming and recently completed', () => {
  const overdue  = [{}]
  const today    = []
  const awaiting = []
  // Upcoming and recently completed should NOT be counted
  assert.strictEqual(waitingCount(overdue, today, awaiting), 1)
})

// ── waitingCopy (singular / plural / zero) ────────────────────────────────────

console.log('\nwaitingCopy\n')

test('waitingCopy for 1 item returns singular form', () => {
  const copy = waitingCopy(1)
  assert.ok(copy && copy.includes('1'), `Expected singular copy with "1", got: ${copy}`)
})

test('waitingCopy for 3 items returns plural form', () => {
  const copy = waitingCopy(3)
  assert.ok(copy && copy.includes('3'), `Expected plural copy with "3", got: ${copy}`)
})

test('waitingCopy for 0 returns null or empty (no header shown when zero)', () => {
  const copy = waitingCopy(0)
  assert.ok(!copy, `Expected falsy for zero count, got: ${JSON.stringify(copy)}`)
})

// ── Row actions: OpenFollowUpRow ──────────────────────────────────────────────

console.log('\nOpenFollowUpRow — all three actions present\n')

test('Done button is present in source', () => {
  assert.ok(src.includes('Done'), 'Done action must be rendered')
})

test('Snooze button is present in source', () => {
  assert.ok(src.includes('Snooze') || src.includes('Reschedule'), 'Snooze/Reschedule action must be rendered')
})

test('Log Result link is present in source', () => {
  assert.ok(src.includes('Log Result'), 'Log Result link must be rendered in OpenFollowUpRow')
})

test('Log Result passes openInteractionForm state', () => {
  assert.ok(src.includes('openInteractionForm'), 'Log Result must pass openInteractionForm via Router state')
})

test('Log Result passes sourceFollowUpId state', () => {
  assert.ok(src.includes('sourceFollowUpId'), 'Log Result must pass sourceFollowUpId via Router state')
})

// ── Row actions: AwaitingRow ──────────────────────────────────────────────────

console.log('\nAwaitingRow — Mark responded and Nudge actions present\n')

test('Mark responded button is present', () => {
  assert.ok(src.includes('Mark responded') || src.includes('markResponded'), 'Mark responded action must exist')
})

test('Nudge button is present', () => {
  assert.ok(src.includes('Nudge'), 'Nudge action must exist in AwaitingRow')
})

// ── Row actions: CompletedRow ─────────────────────────────────────────────────

console.log('\nCompletedRow — Undo action present\n')

test('Undo button is present on completed rows', () => {
  assert.ok(src.includes('Undo'), 'Undo button must be rendered on completed rows')
})

// ── Popover accessibility ─────────────────────────────────────────────────────

console.log('\nPopover accessibility attributes\n')

test('aria-expanded is set on popover trigger buttons', () => {
  assert.ok(src.includes('aria-expanded'), 'Snooze and Nudge triggers must have aria-expanded')
})

test('aria-controls is set on popover trigger buttons', () => {
  assert.ok(src.includes('aria-controls'), 'Snooze and Nudge triggers must have aria-controls')
})

test('popover dialog has role="dialog"', () => {
  assert.ok(src.includes('role="dialog"'), 'DateActionPopover must have role="dialog"')
})

test('popover has aria-label', () => {
  assert.ok(src.includes('aria-label='), 'DateActionPopover must have aria-label')
})

test('Escape key handling is present in popover', () => {
  assert.ok(src.includes('Escape'), 'Popover must close on Escape key')
})

test('outside-click handling is present in popover', () => {
  assert.ok(src.includes('mousedown'), 'Popover must close on outside mousedown')
})

test('popover focus management — first option receives focus on open', () => {
  assert.ok(
    src.includes('firstOptionRef') || src.includes('firstOption'),
    'First option must receive focus when popover opens'
  )
})

// ── Row keys ──────────────────────────────────────────────────────────────────

console.log('\nRow keys\n')

test('OpenFollowUpRow uses item.id as key', () => {
  assert.ok(src.includes('key={item.id}'), 'Rows must use interaction id as key — not index')
})

// ── eightAgoISO UTC correctness ───────────────────────────────────────────────

console.log('\neightAgoISO UTC correctness\n')

test('eightAgoISO uses UTC date arithmetic (setUTCDate / setUTCHours)', () => {
  assert.ok(
    src.includes('setUTCDate') || src.includes('setUTCHours'),
    'eightAgoISO must use UTC methods to avoid local-time drift'
  )
})

// ── Badge eligibility ─────────────────────────────────────────────────────────

console.log('\nfunnl:followups-changed dispatch\n')

test('dispatches funnl:followups-changed after mutations', () => {
  assert.ok(
    src.includes('funnl:followups-changed'),
    'Page must dispatch funnl:followups-changed after done/snooze/undo/nudge'
  )
})

test('listens for funnl:followups-changed to refresh', () => {
  const listenerPattern = src.includes("addEventListener('funnl:followups-changed'")
    || src.includes('addEventListener("funnl:followups-changed"')
  assert.ok(listenerPattern, 'Page must listen for funnl:followups-changed to keep badge in sync')
})

// ── Swipe integration ─────────────────────────────────────────────────────────

console.log('\nSwipe integration\n')

test('swipeOpenId state is managed at page level', () => {
  assert.ok(src.includes('swipeOpenId'), 'must track which row has swipe open')
})

// ── Empty and error states ────────────────────────────────────────────────────

console.log('\nEmpty and error states\n')

test('loading skeleton renders', () => {
  assert.ok(src.includes('Loading') || src.includes('Skeleton') || src.includes('aria-busy'), 'Must render a loading state')
})

test('fetch error renders with Try again action', () => {
  assert.ok(src.includes('Try again'), 'Error state must have a retry action')
})

test('never-used empty state renders', () => {
  assert.ok(src.includes('No follow-ups yet') || src.includes('neverUsed'), 'Must render empty state when no interactions exist')
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
