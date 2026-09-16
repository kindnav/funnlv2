// Email integration — Phase E2B: private worker authentication (pure).
//
// Cross-runtime (Node + Deno). No network, DB, env, or logging. The worker endpoint is NOT
// user-callable: it is gated by a dedicated shared secret compared in CONSTANT TIME, so a
// timing oracle cannot be used to recover it byte-by-byte. `anon` and `authenticated` JWTs
// are never accepted — the only credential is the worker secret, and the endpoint is
// declared verify_jwt = false precisely so a user JWT grants nothing.
//
// The secret itself is never logged, echoed, or returned. Every outcome is a bare code.

export const MIN_WORKER_SECRET_LENGTH = 32
export const WORKER_AUTH_HEADER = 'authorization'

/**
 * Constant-time string comparison. Always compares a fixed number of byte positions
 * derived from BOTH inputs, so neither an early mismatch nor a length difference short-
 * circuits the loop. Length inequality is folded into the accumulator rather than
 * returning early.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  // Fold the length difference in; then compare over a fixed span so the number of
  // iterations does not reveal where (or whether) the first mismatch occurred.
  let diff = ea.length ^ eb.length
  const span = Math.max(ea.length, eb.length)
  for (let i = 0; i < span; i++) {
    const x = i < ea.length ? ea[i] : 0
    const y = i < eb.length ? eb[i] : 0
    diff |= x ^ y
  }
  return diff === 0
}

/**
 * Extract the presented bearer credential from a request's Authorization header.
 * @param {string|null|undefined} headerValue
 * @returns {string|null}
 */
export function parseBearer(headerValue) {
  if (typeof headerValue !== 'string') return null
  // Bounded: a pathological header is rejected rather than scanned.
  if (headerValue.length === 0 || headerValue.length > 8192) return null
  const m = /^Bearer[ ]([A-Za-z0-9._\-+/=]+)$/.exec(headerValue)
  return m ? m[1] : null
}

/**
 * Authorize a worker invocation. Fails closed on a missing/short/absent secret so a
 * misconfigured deployment can never accidentally become publicly invokable.
 *
 * @param {{ method?:string, authorization?:string|null, configuredSecret?:string|null }} req
 * @returns {{ ok:true } | { ok:false, status:number, code:string }}
 */
export function authorizeWorkerRequest({ method, authorization, configuredSecret }) {
  // POST only — a worker run is never a safe/idempotent GET.
  if (method !== 'POST') return { ok: false, status: 405, code: 'method_not_allowed' }

  // A missing or too-short secret means the deployment is not configured for worker runs.
  if (typeof configuredSecret !== 'string' || configuredSecret.length < MIN_WORKER_SECRET_LENGTH) {
    return { ok: false, status: 503, code: 'worker_not_configured' }
  }

  const presented = parseBearer(authorization)
  if (presented === null) return { ok: false, status: 401, code: 'unauthorized' }

  // Constant-time comparison; the secret is never echoed in any branch.
  if (!timingSafeEqualStr(presented, configuredSecret)) {
    return { ok: false, status: 401, code: 'unauthorized' }
  }
  return { ok: true }
}
