// Tenant JWKS retrieval, with a redirect policy we control.
//
// WHY NOT createRemoteJWKSet DIRECTLY
// jose's remote key set performs its own fetch, whose redirect handling is
// jose's rather than ours. This request carries NO secret - it is a public key
// document and no Authorization header is sent - so a redirect here cannot leak
// a credential. It could, however, change WHICH keys a token is verified
// against, and the signing keys are the root of the id_token's trust. Fetching
// the document here and handing jose a LOCAL key set keeps that decision in
// code this repository can audit, under the same deadline and size bounds as
// the other provider calls.
//
// What this does NOT do: pin the key document to a specific certificate or key
// id. Trust still rests on TLS to login.microsoftonline.com plus the issuer and
// audience checks applied afterwards.

import { readJsonBounded, MAX_PROVIDER_BODY_BYTES } from './boundedJson.js'

export const JWKS_TIMEOUT_MS = 10_000
export const MAX_JWKS_BYTES = MAX_PROVIDER_BODY_BYTES

/**
 * Fetch one JWKS document. Returns { ok, jwks } or { ok: false, reason }.
 * `fetchImpl` is a parameter so tests can drive redirect and failure cases.
 */
export async function fetchJwks (jwksUrl, {
  fetchImpl = globalThis.fetch, timeoutMs = JWKS_TIMEOUT_MS, maxBytes = MAX_JWKS_BYTES,
} = {}) {
  if (typeof jwksUrl !== 'string' || jwksUrl.length === 0) {
    return { ok: false, reason: 'no_jwks_url' }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let res
    try {
      res = await fetchImpl(jwksUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
        // No credential travels here, but a followed redirect would let the
        // response choose the signing keys. Refuse rather than follow.
        redirect: 'error',
      })
    } catch {
      return { ok: false, reason: 'jwks_unreachable' }
    }
    if (!res || typeof res.status !== 'number') return { ok: false, reason: 'jwks_malformed' }
    if (res.status !== 200) return { ok: false, reason: 'jwks_http_error' }
    const read = await readJsonBounded(res, maxBytes)
    if (!read.ok) {
      return { ok: false, reason: read.reason === 'response_malformed' ? 'jwks_malformed' : read.reason }
    }
    const jwks = read.value
    if (!jwks || typeof jwks !== 'object' || !Array.isArray(jwks.keys) || jwks.keys.length === 0) {
      return { ok: false, reason: 'jwks_malformed' }
    }
    return { ok: true, jwks }
  } finally {
    clearTimeout(timer)
  }
}
