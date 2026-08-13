// Bounded polling logic for the checkout success reconciliation flow.
// Zero React/Supabase imports — pure JS, safe to unit-test in Node.js.

// Staged delays between each pro-status poll after a successful checkout return.
// Total wait before timeout: 1500 + 3000 + 6000 + 12000 = 22500ms (~22.5s).
// The spec target is 20–30 seconds.
export const POLL_DELAYS_MS = [1500, 3000, 6000, 12000]

/**
 * Returns the delay in ms for the Nth poll attempt (0-indexed).
 * Returns null when there are no more attempts scheduled (polling complete).
 *
 * @param {number} attempt — 0-indexed poll attempt number
 * @returns {number|null}
 */
export function getNextPollDelay(attempt) {
  if (attempt < 0 || attempt >= POLL_DELAYS_MS.length) return null
  return POLL_DELAYS_MS[attempt]
}

/**
 * Runs the bounded checkout-return polling loop.
 *
 * Calls refreshFn() repeatedly with staged delays, stopping when:
 *   (a) hasAccessFn() returns true after a refresh  → resolved with 'confirmed'
 *   (b) all POLL_DELAYS_MS attempts have been exhausted → resolved with 'timeout'
 *   (c) signal.aborted (component unmounted)         → resolved with 'aborted'
 *
 * @param {Object} opts
 * @param {() => Promise<void>} opts.refreshFn   — calls proRefresh() and awaits it
 * @param {() => boolean}       opts.hasAccessFn — returns hasProAccess(proStatus)
 * @param {AbortSignal}         opts.signal       — abort when component unmounts
 * @param {(ms: number) => Promise<void>} [opts.delayFn] — injectable sleep (default: real setTimeout)
 * @returns {Promise<'confirmed' | 'timeout' | 'aborted'>}
 */
export async function runCheckoutPolling({ refreshFn, hasAccessFn, signal, delayFn }) {
  const sleep = delayFn ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)))

  for (let i = 0; i < POLL_DELAYS_MS.length; i++) {
    if (signal.aborted) return 'aborted'

    // Wait the staged delay before polling.
    await sleep(POLL_DELAYS_MS[i])

    if (signal.aborted) return 'aborted'

    // Refresh the pro status.
    await refreshFn()

    if (signal.aborted) return 'aborted'

    // Check whether access is now confirmed.
    if (hasAccessFn()) return 'confirmed'
  }

  // All attempts exhausted without confirmation.
  return 'timeout'
}
