// Per-component-instance request gate for FunnlAIPage.
//
// Prevents stale AI requests from mutating conversation state after the user
// starts a new chat or a newer request supersedes an older one.
//
// Usage in a React component:
//   const gateRef = useRef(null)
//   if (!gateRef.current) gateRef.current = createRequestGate()
//
//   async function sendMessage(text) {
//     const gate  = gateRef.current
//     const token = gate.begin()          // invalidates any prior in-flight token
//     ...
//     await someAsyncCall()
//     if (!gate.isCurrent(token)) return  // stale — a newer request or reset happened
//     ...
//   }
//
//   function startNewChat() {
//     gateRef.current.invalidate()         // poisons any in-flight token before reset
//     setMessages([INITIAL_MESSAGE])
//     ...
//   }
//
// Each createRequestGate() call returns an isolated gate instance.
// Do not share a gate across component instances, users, or browser tabs.

/**
 * Creates an isolated request gate.
 *
 * @returns {{ begin: () => symbol, invalidate: () => void, isCurrent: (token: symbol) => boolean }}
 */
export function createRequestGate() {
  let currentToken = null

  return {
    /**
     * Begins a new request. Returns a unique token and makes it the current
     * active token, implicitly invalidating any prior token (including any
     * in-flight request that called begin() earlier).
     * @returns {symbol}
     */
    begin() {
      const token = Symbol()
      currentToken = token
      return token
    },

    /**
     * Invalidates the current token without starting a new request.
     * Any in-flight request holding the previous token will find
     * isCurrent() returning false and must abort all state mutations.
     */
    invalidate() {
      currentToken = null
    },

    /**
     * Returns true only if the given token is still the current active token.
     * Returns false for null, undefined, stale tokens, or after invalidate().
     * @param {symbol|null} token
     * @returns {boolean}
     */
    isCurrent(token) {
      return token !== null && token === currentToken
    },
  }
}
