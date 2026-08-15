// Pure, dependency-free helpers for detecting authenticated-account switches and
// discarding stale async results. Used by FunnlAIPage (and unit-testable in Node).

/**
 * True when the authenticated UID has genuinely changed to another real user.
 * A first sign-in (prevUid null) is NOT a switch; a sign-out (newUid null) is not a
 * switch to another account (handled elsewhere by auth gating).
 *
 * @param {string|null|undefined} prevUid
 * @param {string|null|undefined} newUid
 * @returns {boolean}
 */
export function isAccountSwitch(prevUid, newUid) {
  return Boolean(prevUid) && Boolean(newUid) && prevUid !== newUid
}

/**
 * True when a captured account-generation token no longer matches the current one,
 * meaning an async result belongs to a previous account/request owner and must be
 * discarded (no navigation, no state mutation, no analytics, no localStorage write).
 *
 * @param {number} capturedGen
 * @param {number} currentGen
 * @returns {boolean}
 */
export function isStaleGeneration(capturedGen, currentGen) {
  return capturedGen !== currentGen
}
