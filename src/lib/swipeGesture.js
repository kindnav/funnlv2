/**
 * swipeGesture.js — pure swipe-gesture decision logic.
 *
 * No browser APIs, no React — safe for Node.js unit tests.
 *
 * Used by FollowUpsPage rows as a progressive enhancement:
 *   right swipe → reveal Done tray (tap to confirm)
 *   left swipe  → reveal Snooze/Nudge tray (tap to open the date popover)
 *
 * Explicit buttons remain the primary action path and are never removed.
 * Swipe is a convenience shortcut only.
 */

// Minimum horizontal displacement (px) to commit to a swipe action.
export const SWIPE_THRESHOLD_PX = 60

// Minimum dx:dy ratio for a gesture to be considered horizontal rather than vertical.
// Prevents horizontal swipe detection from blocking vertical page scrolling.
export const DIRECTION_LOCK_RATIO = 1.5

/**
 * Classify a completed touch gesture as 'right', 'left', or 'none'.
 *
 * Returns 'none' when:
 *   - |dx| is below the threshold (too small to be intentional)
 *   - the gesture is more vertical than horizontal (likely a scroll attempt)
 *
 * @param {number} dx  Horizontal displacement in px (positive = right)
 * @param {number} dy  Vertical displacement in px (positive = down)
 * @returns {'right'|'left'|'none'}
 */
export function classifySwipeGesture(dx, dy) {
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  // Primarily vertical — defer to browser scrolling
  if (ady > 0 && adx / ady < DIRECTION_LOCK_RATIO) return 'none'
  if (adx < SWIPE_THRESHOLD_PX) return 'none'
  return dx > 0 ? 'right' : 'left'
}

/**
 * Returns true once the in-progress touch gesture has committed to horizontal
 * movement and the browser's default scroll should be suppressed.
 *
 * Called on touchmove before the full threshold is reached.
 *
 * @param {number} dx  Cumulative horizontal displacement from touchstart
 * @param {number} dy  Cumulative vertical displacement from touchstart
 * @returns {boolean}
 */
export function shouldLockHorizontal(dx, dy) {
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  return adx >= 10 && adx / Math.max(ady, 1) >= DIRECTION_LOCK_RATIO
}

/**
 * Map a classified gesture to a row reveal action.
 *
 * @param {'right'|'left'|'none'} gesture
 * @returns {'reveal-done'|'reveal-snooze'|null}
 */
export function swipeGestureToAction(gesture) {
  if (gesture === 'right') return 'reveal-done'
  if (gesture === 'left')  return 'reveal-date-action'
  return null
}
