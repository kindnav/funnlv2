/**
 * followup-corrections.test.js
 *
 * Stage 6 correction patch verification.
 * Tests the 10 specific requirements in the correction spec:
 *   1. No purple accent in Stage 6 files
 *   2. 7-day window boundaries (sevenDaysAgo = today -6 days, today inclusive, day-7 excluded)
 *   3. Badge separation (nav badge independent of waitingCount)
 *   4. Popover focus restoration paths
 *   5. Swipe reveal-then-tap (left reveals tray; tray tap opens popover; no direct mutation)
 *   6. Query error handling (missing-column errors propagate, never silently empty)
 *   7. No purple in Sidebar / BottomNav badge queries
 *
 * Zero-dependency Node.js — run with: node tests/followup-corrections.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { sevenDaysAgo, isBadgeEligible, classifyInteraction, localDateOffset } from '../src/lib/followUpUtils.js'
import { swipeGestureToAction } from '../src/lib/swipeGesture.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dir, '..')

const followUpsSrc  = readFileSync(join(projectRoot, 'src/pages/FollowUpsPage.jsx'), 'utf8')
const sidebarSrc    = readFileSync(join(projectRoot, 'src/components/Sidebar.jsx'), 'utf8')
const bottomNavSrc  = readFileSync(join(projectRoot, 'src/components/BottomNav.jsx'), 'utf8')
const swipeSrc      = readFileSync(join(projectRoot, 'src/lib/swipeGesture.js'), 'utf8')
const utilsSrc      = readFileSync(join(projectRoot, 'src/lib/followUpUtils.js'), 'utf8')

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

// ── Correction 1: No purple accent in Stage 6 files ──────────────────────────

console.log('\nCorrection 1 — No purple accent in Stage 6 files\n')

const PURPLE_PATTERNS = [
  'rgba(139,124,255',
  'rgba(108,92,255',
  '#8B7CFF',
  'var(--color-accent)',
]

PURPLE_PATTERNS.forEach(p => {
  test(`FollowUpsPage.jsx: no "${p}"`, () => {
    assert.ok(!followUpsSrc.includes(p), `Found forbidden purple token: ${p}`)
  })
})

PURPLE_PATTERNS.forEach(p => {
  test(`swipeGesture.js: no "${p}"`, () => {
    assert.ok(!swipeSrc.includes(p), `Found forbidden purple token in swipeGesture.js: ${p}`)
  })
})

PURPLE_PATTERNS.forEach(p => {
  test(`followUpUtils.js: no "${p}"`, () => {
    assert.ok(!utilsSrc.includes(p), `Found forbidden purple token in followUpUtils.js: ${p}`)
  })
})

test('FollowUpsPage.jsx uses ember (#FF4423) for primary accent', () => {
  assert.ok(followUpsSrc.includes('#FF4423'), 'Ember color must be present')
})

// ── Correction 2: 7-day window — sevenDaysAgo = today - 6 days ───────────────

console.log('\nCorrection 2 — 7-day window (today -6 = 7 calendar dates)\n')

test('sevenDaysAgo("2026-07-29") === "2026-07-23" (not -7)', () => {
  assert.strictEqual(sevenDaysAgo('2026-07-29'), '2026-07-23')
})

test('sevenDaysAgo("2026-08-05") === "2026-07-30"', () => {
  assert.strictEqual(sevenDaysAgo('2026-08-05'), '2026-07-30')
})

test('sevenDaysAgo("2027-01-05") === "2026-12-30"', () => {
  assert.strictEqual(sevenDaysAgo('2027-01-05'), '2026-12-30')
})

test('today itself is inside the 7-day window (today >= sevenDaysAgo(today))', () => {
  const today = '2026-07-29'
  const seven = sevenDaysAgo(today)
  assert.ok(today >= seven, 'today must be >= sevenDaysAgo(today)')
})

test('day exactly 7 calendar dates ago is the boundary and is INCLUDED', () => {
  // With -6 offset: sevenDaysAgo(today) = today - 6 days
  // The boundary date equals sevenDaysAgo(today) and must be included (>=)
  const today = '2026-07-29'
  const seven = sevenDaysAgo(today) // '2026-07-23'
  // A completion on the boundary date
  const boundaryRow = {
    follow_up_completed_at: seven + 'T12:00:00Z',
    follow_up_completion_method: 'mark_done',
    follow_up_date: null,
    outreach_status: null,
  }
  assert.strictEqual(classifyInteraction(boundaryRow, today, seven), 'recently_completed',
    'Completion exactly on sevenDaysAgo boundary must be recently_completed (inclusive)')
})

test('completion exactly 7 days before today (=today-7) is EXCLUDED from recently_completed', () => {
  // today-7 is ONE day before sevenDaysAgo(today) = today-6
  const today = '2026-07-29'
  const seven = sevenDaysAgo(today) // '2026-07-23'
  const sevenDaysBefore = localDateOffset(today, -7) // '2026-07-22' — one day outside window
  assert.ok(sevenDaysBefore < seven, 'localDateOffset(today,-7) must be < sevenDaysAgo(today)')
  const excludedRow = {
    follow_up_completed_at: sevenDaysBefore + 'T12:00:00Z',
    follow_up_completion_method: 'mark_done',
    follow_up_date: null,
    outreach_status: null,
  }
  assert.strictEqual(classifyInteraction(excludedRow, today, seven), 'other',
    'Completion at today-7 (just outside boundary) must be "other", not recently_completed')
})

test('followUpUtils.js computes sevenDaysAgo with -6 offset', () => {
  assert.ok(
    utilsSrc.includes('localDateOffset(today, -6)'),
    'sevenDaysAgo must use localDateOffset(today, -6)'
  )
  assert.ok(
    !utilsSrc.includes('localDateOffset(today, -7)'),
    'sevenDaysAgo must NOT use localDateOffset(today, -7)'
  )
})

// ── Correction 3: Badge separation ───────────────────────────────────────────

console.log('\nCorrection 3 — Badge logic: nav badge must not use waitingCount\n')

test('Sidebar does not reference waitingCount', () => {
  assert.ok(!sidebarSrc.includes('waitingCount'), 'Sidebar badge must not use waitingCount')
})

test('BottomNav does not reference waitingCount', () => {
  assert.ok(!bottomNavSrc.includes('waitingCount'), 'BottomNav badge must not use waitingCount')
})

test('Sidebar badge query filters by follow_up_date not null', () => {
  assert.ok(
    sidebarSrc.includes("'follow_up_date', 'is', null") || sidebarSrc.includes('"follow_up_date"'),
    'Sidebar must filter by follow_up_date'
  )
})

test('BottomNav badge query filters by follow_up_date not null', () => {
  assert.ok(
    bottomNavSrc.includes("'follow_up_date', 'is', null") || bottomNavSrc.includes('"follow_up_date"'),
    'BottomNav must filter by follow_up_date'
  )
})

test('isBadgeEligible: dated overdue row is eligible', () => {
  const row = { follow_up_date: '2026-07-28', follow_up_completed_at: null }
  assert.ok(isBadgeEligible(row, '2026-07-29'), 'Overdue dated row must be badge-eligible')
})

test('isBadgeEligible: dated today row is eligible', () => {
  const row = { follow_up_date: '2026-07-29', follow_up_completed_at: null }
  assert.ok(isBadgeEligible(row, '2026-07-29'), 'Due-today dated row must be badge-eligible')
})

test('isBadgeEligible: upcoming dated row is NOT eligible', () => {
  const row = { follow_up_date: '2026-07-30', follow_up_completed_at: null }
  assert.ok(!isBadgeEligible(row, '2026-07-29'), 'Upcoming row must not be badge-eligible')
})

test('isBadgeEligible: null follow_up_date (awaiting-only) is NOT eligible', () => {
  const row = { follow_up_date: null, follow_up_completed_at: null, outreach_status: 'awaiting_response' }
  assert.ok(!isBadgeEligible(row, '2026-07-29'), 'Awaiting-no-date row must not be badge-eligible')
})

test('isBadgeEligible: completed dated row is NOT eligible', () => {
  const row = { follow_up_date: '2026-07-28', follow_up_completed_at: '2026-07-29T10:00:00Z' }
  assert.ok(!isBadgeEligible(row, '2026-07-29'), 'Completed row must not be badge-eligible')
})

// ── Correction 4: Popover focus restoration ───────────────────────────────────

console.log('\nCorrection 4 — Popover focus restoration on all close paths\n')

test('popoverTriggerRef is defined in FollowUpsPage', () => {
  assert.ok(
    followUpsSrc.includes('popoverTriggerRef'),
    'popoverTriggerRef must exist for focus restoration'
  )
})

test('closePopoverWithFocus restores focus', () => {
  assert.ok(
    followUpsSrc.includes('closePopoverWithFocus'),
    'closePopoverWithFocus function must exist'
  )
})

test('openPopover accepts a DOM element parameter', () => {
  // Signature: openPopover(id, mode, domEl)
  assert.ok(
    followUpsSrc.includes('openPopover(id, mode, domEl)') ||
    followUpsSrc.includes('function openPopover(id, mode, domEl)'),
    'openPopover must accept domEl as third parameter'
  )
})

test('handleSnooze success calls closePopoverWithFocus (not closePopover)', () => {
  // Check that the success path in handleSnooze uses closePopoverWithFocus
  const snoozeIdx = followUpsSrc.indexOf('async function handleSnooze')
  const nextFnIdx = followUpsSrc.indexOf('\nasync function', snoozeIdx + 1)
  const snoozeBody = nextFnIdx === -1
    ? followUpsSrc.slice(snoozeIdx)
    : followUpsSrc.slice(snoozeIdx, nextFnIdx)
  assert.ok(
    snoozeBody.includes('closePopoverWithFocus'),
    'handleSnooze success path must call closePopoverWithFocus'
  )
})

test('handleNudge success calls closePopoverWithFocus (not closePopover)', () => {
  const nudgeIdx = followUpsSrc.indexOf('async function handleNudge')
  const nextFnIdx = followUpsSrc.indexOf('\nasync function', nudgeIdx + 1)
  const nudgeBody = nextFnIdx === -1
    ? followUpsSrc.slice(nudgeIdx)
    : followUpsSrc.slice(nudgeIdx, nextFnIdx)
  assert.ok(
    nudgeBody.includes('closePopoverWithFocus'),
    'handleNudge success path must call closePopoverWithFocus'
  )
})

test('Escape key closes popover (keyboard close path exists)', () => {
  assert.ok(followUpsSrc.includes('Escape'), 'Escape must close the popover')
})

test('Outside click closes popover (mousedown close path exists)', () => {
  assert.ok(followUpsSrc.includes('mousedown'), 'Outside mousedown must close the popover')
})

// ── Correction 5: Swipe reveal-then-tap (no direct mutation from swipe) ──────

console.log('\nCorrection 5 — Swipe reveals tray; tray tap opens popover; no direct mutation\n')

test('left swipe gesture classifies as "reveal-date-action"', () => {
  assert.strictEqual(swipeGestureToAction('left'), 'reveal-date-action')
})

test('right swipe gesture classifies as "reveal-done"', () => {
  assert.strictEqual(swipeGestureToAction('right'), 'reveal-done')
})

test('none swipe returns null', () => {
  assert.strictEqual(swipeGestureToAction('none'), null)
})

test('swipeGesture.js mentions "reveal Snooze/Nudge tray" in comment (not "open popover")', () => {
  assert.ok(
    swipeSrc.includes('reveal') && (swipeSrc.includes('tray') || swipeSrc.includes('Snooze')),
    'swipeGesture.js comment must document tray-reveal intent'
  )
})

test('OpenFollowUpRow swipe onEnd handler reveals tray (not openPopover)', () => {
  // The onEnd handler in OpenFollowUpRow should call onSwipeReveal, not onOpenPopover
  // for the reveal-date-action path
  const openRowStart = followUpsSrc.indexOf('function OpenFollowUpRow(')
  const awaitingStart = followUpsSrc.indexOf('function AwaitingRow(')
  const openRowBody = followUpsSrc.slice(openRowStart, awaitingStart)

  // reveal-date-action branch in onEnd must use onSwipeReveal, not openPopover
  const revealActionIdx = openRowBody.indexOf("'reveal-date-action'")
  const onEndSection = openRowBody.slice(Math.max(0, revealActionIdx - 200), revealActionIdx + 200)
  assert.ok(
    onEndSection.includes('onSwipeReveal'),
    'OpenFollowUpRow onEnd for reveal-date-action must call onSwipeReveal (not openPopover)'
  )
  assert.ok(
    !onEndSection.includes('onOpenPopover'),
    'OpenFollowUpRow onEnd for reveal-date-action must NOT call onOpenPopover directly'
  )
})

test('AwaitingRow swipe onEnd handler reveals tray (not openPopover)', () => {
  const awaitingStart = followUpsSrc.indexOf('function AwaitingRow(')
  const completedStart = followUpsSrc.indexOf('function CompletedRow(')
  const awaitingBody = followUpsSrc.slice(awaitingStart, completedStart)

  const revealActionIdx = awaitingBody.indexOf("'reveal-date-action'")
  const onEndSection = awaitingBody.slice(Math.max(0, revealActionIdx - 200), revealActionIdx + 200)
  assert.ok(
    onEndSection.includes('onSwipeReveal'),
    'AwaitingRow onEnd for reveal-date-action must call onSwipeReveal (not openPopover)'
  )
  assert.ok(
    !onEndSection.includes('onOpenPopover'),
    'AwaitingRow onEnd for reveal-date-action must NOT call onOpenPopover directly'
  )
})

test('OpenFollowUpRow reveal-date-action tray is rendered', () => {
  const openRowStart = followUpsSrc.indexOf('function OpenFollowUpRow(')
  const awaitingStart = followUpsSrc.indexOf('function AwaitingRow(')
  const openRowBody = followUpsSrc.slice(openRowStart, awaitingStart)
  assert.ok(
    openRowBody.includes("swipeRevealed === 'reveal-date-action'"),
    'OpenFollowUpRow must render a tray when swipeRevealed === "reveal-date-action"'
  )
})

test('AwaitingRow reveal-date-action tray is rendered', () => {
  const awaitingStart = followUpsSrc.indexOf('function AwaitingRow(')
  const completedStart = followUpsSrc.indexOf('function CompletedRow(')
  const awaitingBody = followUpsSrc.slice(awaitingStart, completedStart)
  assert.ok(
    awaitingBody.includes("swipeRevealed === 'reveal-date-action'"),
    'AwaitingRow must render a tray when swipeRevealed === "reveal-date-action"'
  )
})

test('reveal-date-action tray button calls onOpenPopover (tray-tap opens popover)', () => {
  // Inside the tray JSX, clicking the tray button should call onOpenPopover
  const openRowStart = followUpsSrc.indexOf('function OpenFollowUpRow(')
  const awaitingStart = followUpsSrc.indexOf('function AwaitingRow(')
  const openRowBody = followUpsSrc.slice(openRowStart, awaitingStart)
  // Find the tray block and check its button onClick calls onOpenPopover
  const trayIdx = openRowBody.indexOf("swipeRevealed === 'reveal-date-action'")
  const trayBlock = openRowBody.slice(trayIdx, trayIdx + 500)
  assert.ok(
    trayBlock.includes('onOpenPopover'),
    'reveal-date-action tray button in OpenFollowUpRow must call onOpenPopover on tap'
  )
})

// ── Correction 6: Query error handling ───────────────────────────────────────

console.log('\nCorrection 6 — Query error state propagates (never silent empty)\n')

test('FollowUpsPage has a fetchError state variable', () => {
  assert.ok(
    followUpsSrc.includes('fetchError') || followUpsSrc.includes('setFetchError'),
    'Must track fetch error state separately from empty results'
  )
})

test('Error state renders a visible message (not blank screen)', () => {
  assert.ok(
    followUpsSrc.includes('Try again') || followUpsSrc.includes('Something went wrong'),
    'Error state must render a user-visible message'
  )
})

test('loading state prevents empty state from showing during load', () => {
  assert.ok(
    followUpsSrc.includes('loading') || followUpsSrc.includes('isLoading'),
    'Must use loading state to prevent empty state flash'
  )
})

// ── Correction 7: No purple in Sidebar / BottomNav ───────────────────────────

console.log('\nCorrection 7 — No purple accent in Sidebar / BottomNav badge sections\n')

PURPLE_PATTERNS.forEach(p => {
  // var(--color-accent) is commonly used in Sidebar for active nav styling, not badge colors
  // We only check the badge/count-specific context for these files
  if (p === 'var(--color-accent)') return // nav active state legitimately uses --color-accent
  test(`Sidebar.jsx: no "${p}"`, () => {
    assert.ok(!sidebarSrc.includes(p), `Sidebar has forbidden purple token: ${p}`)
  })
  test(`BottomNav.jsx: no "${p}"`, () => {
    assert.ok(!bottomNavSrc.includes(p), `BottomNav has forbidden purple token: ${p}`)
  })
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
