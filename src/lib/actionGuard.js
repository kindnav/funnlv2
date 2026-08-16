// Synchronous single-flight guard for user-triggered async actions such as
// starting a Stripe Checkout session or opening the billing portal.
//
// Why a synchronous guard (not a React state boolean): between a click handler
// calling setState(true) and React committing that render, a second rapid click can
// run the handler again and read the still-false state — creating two attempt IDs /
// two Stripe sessions. This guard flips a plain in-memory flag synchronously, so the
// second invocation is rejected immediately, before any attemptId is generated or any
// Edge Function is invoked.
//
// Usage (stored in a ref so it survives re-renders):
//   const guardRef = useRef(null)
//   if (!guardRef.current) guardRef.current = createActionGuard()
//   ...
//   if (!guardRef.current.begin()) return         // second click bails here
//   try { ...await invoke... } catch { }
//   // on controlled failure: guardRef.current.release()
//   // on success navigation: leave engaged so a late click cannot re-fire
//
// begin() returns true for exactly one caller until release() is called.
export function createActionGuard() {
  let inFlight = false
  return {
    /** @returns {boolean} true if the caller acquired the guard; false if already in flight. */
    begin() {
      if (inFlight) return false
      inFlight = true
      return true
    },
    /** Release the guard so a future action may begin. */
    release() {
      inFlight = false
    },
    /** @returns {boolean} whether an action currently holds the guard. */
    get isInFlight() {
      return inFlight
    },
  }
}
