// Shared Edge-compatible bounded-fetch helper. Applies an application-level timeout to
// an outbound request (e.g. a Stripe API call) so a stalled external request cannot hold
// the Edge Function until Supabase's ~150s idle timeout. Funnl stops substantially
// earlier and returns a controlled result.
//
// Zero external imports — importable from Node tests without a Deno runtime. fetch,
// AbortController, and setTimeout/clearTimeout are injectable for deterministic tests.
//
// Privacy: this helper never logs. Callers must not log raw error objects, Stripe
// bodies, customer/subscription IDs, emails, or secrets.

// ~20 seconds per Stripe request. Well under Supabase's ~150s idle timeout, leaving room
// for the rest of the function to run and return a controlled response.
export const STRIPE_FETCH_TIMEOUT_MS = 20_000

/**
 * Performs `fetch(url, init)` with a hard timeout. On timeout the request is aborted and
 * the returned promise REJECTS with an Error whose `.name === 'TimeoutError'`. If the
 * caller passes an already-aborted or later-aborted external signal, that abort also
 * cancels the request. The internal timer is ALWAYS cleared (success, error, or abort).
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=STRIPE_FETCH_TIMEOUT_MS]
 * @param {AbortSignal} [opts.signal]  — optional external abort signal
 * @param {typeof fetch} [opts.fetchImpl]  — injectable fetch (default: global fetch)
 * @param {(fn: Function, ms: number) => any} [opts.setTimeoutImpl]
 * @param {(id: any) => void} [opts.clearTimeoutImpl]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, init = {}, opts = {}) {
  const timeoutMs       = opts.timeoutMs ?? STRIPE_FETCH_TIMEOUT_MS
  const fetchImpl       = opts.fetchImpl ?? globalThis.fetch
  const setTimeoutImpl  = opts.setTimeoutImpl ?? setTimeout
  const clearTimeoutImpl = opts.clearTimeoutImpl ?? clearTimeout

  const controller = new AbortController()
  let timedOut = false

  // If an already-aborted external signal is provided, abort immediately.
  if (opts.signal?.aborted) controller.abort()
  const onExternalAbort = () => controller.abort()
  opts.signal?.addEventListener?.('abort', onExternalAbort)

  const timer = setTimeoutImpl(() => { timedOut = true; controller.abort() }, timeoutMs)

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (timedOut) {
      const e = new Error('stripe_request_timeout')
      e.name = 'TimeoutError'
      throw e
    }
    throw err
  } finally {
    clearTimeoutImpl(timer)
    opts.signal?.removeEventListener?.('abort', onExternalAbort)
  }
}

/**
 * True when an error thrown by fetchWithTimeout represents a timeout.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTimeoutError(err) {
  return !!err && err.name === 'TimeoutError'
}
