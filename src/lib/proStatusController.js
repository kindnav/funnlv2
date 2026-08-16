// Dependency-free request-sequencing controller for the shared Pro-status provider.
//
// It is the SINGLE source of truth for "may this async status result be applied?".
// The React provider (useProStatus.js) owns one instance and calls it directly, and
// tests import and exercise THIS production object (no mirrored logic).
//
// Two monotonically increasing counters:
//   requestSeq   — bumped on EVERY status request (an auth-triggered fetch OR a
//                  refresh()). Only the newest request (token === requestSeq) for the
//                  unchanged UID may write shared state. This makes same-account
//                  overlapping refreshes "newest-request-wins": an older refresh that
//                  resolves later is discarded, so it can never re-lock a paying user.
//   accountGen   — bumped ONLY on account transitions (a real UID change or sign-out),
//                  NOT on a refresh. Exposed to consumers (e.g. Settings checkout
//                  polling) that need to detect account switches without being churned
//                  by ordinary refreshes.
//
// `active` gates everything: deactivate() on unmount discards all in-flight results.

export function createProStatusController() {
  let uid = null
  let requestSeq = 0
  let accountGen = 0
  let active = true

  return {
    activate() { active = true },
    deactivate() { active = false },

    get active() { return active },
    get uid() { return uid },
    get requestSeq() { return requestSeq },
    get accountGeneration() { return accountGen },

    /**
     * Process an auth event. Returns { action, token, uid, accountGeneration }.
     *   'ignore' — same UID (e.g. TOKEN_REFRESHED). No counters change; valid state kept.
     *   'clear'  — signed out (UID null). Bumps both counters (invalidates in-flight).
     *   'fetch'  — real account change (incl. initial load). Bumps both counters; the
     *              caller fetches and applies only if canApply(token, uid).
     */
    onAuth(newUid) {
      const next = newUid ?? null
      if ((uid ?? null) === next) {
        return { action: 'ignore', token: requestSeq, uid, accountGeneration: accountGen }
      }
      uid = next
      accountGen += 1
      const token = ++requestSeq   // invalidate every prior in-flight request
      return { action: next === null ? 'clear' : 'fetch', token, uid: next, accountGeneration: accountGen }
    },

    /**
     * Begin a refresh for the CURRENT uid. Mints a NEW token (bumps requestSeq only, not
     * accountGen) so an older same-uid refresh is superseded by this newer one.
     * @returns {{ token: number, uid: string|null }}
     */
    beginRefresh() {
      const token = ++requestSeq
      return { token, uid }
    },

    /**
     * May the result of the request that captured (token, capturedUid) be applied to
     * shared state? Only when still active, the UID is unchanged, and no newer request
     * has superseded it (token is still the latest requestSeq).
     * @param {number} token
     * @param {string|null} capturedUid
     * @returns {boolean}
     */
    canApply(token, capturedUid) {
      return active && token === requestSeq && (capturedUid ?? null) === (uid ?? null)
    },
  }
}
