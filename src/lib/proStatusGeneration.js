// Pure, dependency-free helpers that drive the account-aware ProStatusProvider.
// Extracted so tests exercise the REAL transition + staleness logic the provider uses
// (rather than a copied re-implementation).

/**
 * Decides what the shared Pro-status provider must do when the authenticated UID
 * changes (from an onAuthStateChange event or the initial session).
 *
 *   'ignore' — same user (including a token refresh for the same UID). Keep the
 *              currently loaded status; do NOT discard valid state or refetch.
 *   'clear'  — signed out (newUid null). Clear status immediately; do NOT fetch.
 *   'switch' — a real account change to another user. Clear status immediately
 *              (so the previous account's access can never leak) and fetch the new
 *              user's status.
 *
 * @param {string|null|undefined} prevUid
 * @param {string|null|undefined} newUid
 * @returns {'ignore'|'clear'|'switch'}
 */
export function proStatusTransition(prevUid, newUid) {
  const prev = prevUid ?? null
  const next = newUid ?? null
  if (prev === next) return 'ignore'
  if (next === null) return 'clear'
  return 'switch'
}

/**
 * Whether an async Pro-status result (from a fetch/refresh that started earlier) may
 * be applied to shared state. It may ONLY be applied when both the captured UID and
 * the captured request generation still match the current ones — otherwise the result
 * belongs to a previous account or a superseded request and must be discarded so it
 * cannot overwrite the newer account's state.
 *
 * @param {string|null} capturedUid
 * @param {number} capturedGen
 * @param {string|null} currentUid
 * @param {number} currentGen
 * @returns {boolean}
 */
export function shouldApplyProStatusResult(capturedUid, capturedGen, currentUid, currentGen) {
  return capturedGen === currentGen && (capturedUid ?? null) === (currentUid ?? null)
}
