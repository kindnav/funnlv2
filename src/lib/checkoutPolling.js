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
 *   (a) hasAccessFn(returnedStatus) returns true after a refresh → resolved with 'confirmed'
 *   (b) all POLL_DELAYS_MS attempts have been exhausted             → resolved with 'timeout'
 *   (c) signal.aborted (component unmounted)                        → resolved with 'aborted'
 *
 * refreshFn must return the newly fetched status object (e.g. from ProStatusProvider.refresh()).
 * hasAccessFn receives that returned status as its argument — do not read React refs inside it.
 *
 * @param {Object} opts
 * @param {() => Promise<unknown>} opts.refreshFn   — calls proRefresh() and returns the new status
 * @param {(status: unknown) => boolean} opts.hasAccessFn — receives the returned status; returns true when access is confirmed
 * @param {AbortSignal}         opts.signal          — abort when component unmounts
 * @param {(ms: number) => Promise<void>} [opts.delayFn] — injectable sleep (default: real setTimeout)
 * @returns {Promise<'confirmed' | 'timeout' | 'aborted'>}
 */
/**
 * Whether checkout-return confirmation polling may START. It may only start for the
 * success banner, once the AUTHORITATIVE auth UID is known (non-null — never with an
 * unknown UID), and only once (not if a run already started for this banner).
 *
 * @param {Object} o
 * @param {'success'|'cancelled'|null|undefined} o.banner
 * @param {string|null|undefined} o.authUserId  — authoritative UID (null until auth resolves)
 * @param {boolean} o.alreadyStarted
 * @returns {boolean}
 */
export function shouldStartCheckoutPoll({ banner, authUserId, alreadyStarted }) {
  return banner === 'success' && authUserId != null && !alreadyStarted
}

/**
 * Whether a completed checkout-return polling run's result is STALE and must be
 * discarded (must not set confirmed/timed_out/error or fire analytics). A result is
 * stale when the component unmounted, the run was aborted, the account generation
 * changed, or the account UID changed. The account generation is the primary signal;
 * the UID check is secondary and applied only when both UIDs are known, so the
 * mount-time null→uid load of the SAME initial account is never treated as a switch.
 *
 * @param {Object} o
 * @param {boolean} o.mounted
 * @param {boolean} o.aborted
 * @param {number}  o.capturedGen
 * @param {number}  o.currentGen
 * @param {string|null} o.capturedUid
 * @param {string|null} o.currentUid
 * @returns {boolean} true when the result must be discarded
 */
export function isStalePollResult({ mounted, aborted, capturedGen, currentGen, capturedUid, currentUid }) {
  if (!mounted) return true
  if (aborted) return true
  if (currentGen !== capturedGen) return true
  if (capturedUid != null && currentUid != null && currentUid !== capturedUid) return true
  return false
}

export async function runCheckoutPolling({ refreshFn, hasAccessFn, signal, delayFn }) {
  const sleep = delayFn ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)))

  for (let i = 0; i < POLL_DELAYS_MS.length; i++) {
    if (signal.aborted) return 'aborted'

    // Wait the staged delay before polling.
    await sleep(POLL_DELAYS_MS[i])

    if (signal.aborted) return 'aborted'

    // Refresh pro status — refreshFn returns the newly fetched status.
    const newStatus = await refreshFn()

    if (signal.aborted) return 'aborted'

    // Pass the returned status directly — no React ref needed.
    if (hasAccessFn(newStatus)) return 'confirmed'
  }

  // All attempts exhausted without confirmation.
  return 'timeout'
}
