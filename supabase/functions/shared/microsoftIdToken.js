// id_token validation for the multitenant Microsoft identity platform.
//
// WHY A SEPARATE MODULE: every step here is a decision that must be testable
// without an Entra registration. The network-touching parts (JWKS fetch, JWT
// verify) are injected, so the suite can drive personal and work tenants and
// every failure mode with fixtures.
//
// WHAT IS VALIDATED, and why each one matters for /common:
//   signature   against the TENANT'S signing keys, not a global blob
//   iss         must be exactly https://login.microsoftonline.com/<tid>/v2.0.
//               With /common the issuer is tenant-specific, so pinning a single
//               literal issuer is wrong and accepting any issuer is worse. The
//               tid is read from the UNVERIFIED payload only to select the key
//               set and expected issuer, and the subsequent signature check is
//               what makes that selection trustworthy. This is Microsoft's
//               documented pattern for multitenant validation.
//   aud         must equal our client id: a token minted for another app is not
//               a token for us.
//   exp / nbf   with a small clock skew allowance.
//   nonce       must equal the value bound to THIS flow's state. Without it an
//               id_token from another of the attacker's own flows could be
//               replayed. (It is not a substitute for the browser binding: an
//               attacker who starts the flow controls the nonce too.)
//
// The Graph ACCESS token is never decoded here or anywhere else. Its format is
// not guaranteed and parsing it is unsupported.

export const MS_LOGIN_HOST = 'https://login.microsoftonline.com'

/** Clock skew tolerated on exp/nbf, in seconds. */
export const CLOCK_SKEW_S = 60

const GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Tenant-specific v2 issuer. Returns null for a malformed tid. */
export function expectedIssuerForTenant (tid) {
  if (typeof tid !== 'string') return null
  const t = tid.trim().toLowerCase()
  if (!GUID_RE.test(t)) return null
  return `${MS_LOGIN_HOST}/${t}/v2.0`
}

/** Tenant-specific JWKS endpoint. Returns null for a malformed tid. */
export function jwksUrlForTenant (tid) {
  if (typeof tid !== 'string') return null
  const t = tid.trim().toLowerCase()
  if (!GUID_RE.test(t)) return null
  return `${MS_LOGIN_HOST}/${t}/discovery/v2.0/keys`
}

/**
 * Read the payload WITHOUT verifying, purely to discover `tid`.
 * The result must never be trusted for anything else: it selects the key set
 * and the expected issuer, and the signature check that follows is what makes
 * that selection sound. Returns null on any malformed input.
 */
export function unverifiedTenantId (idToken) {
  if (typeof idToken !== 'string') return null
  const parts = idToken.split('.')
  if (parts.length !== 3) return null
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4 !== 0) b64 += '='
    const json = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))))
    const tid = typeof json?.tid === 'string' ? json.tid.trim().toLowerCase() : null
    return tid && GUID_RE.test(tid) ? tid : null
  } catch {
    return null
  }
}

/**
 * Pure claim checks applied AFTER a successful signature verification.
 * Returns { ok } or { ok: false, reason } with a controlled reason code.
 */
export function validateIdTokenClaims (payload, { clientId, expectedNonce, expectedIssuer, nowSeconds }) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'no_payload' }
  if (typeof clientId !== 'string' || clientId.length === 0) {
    return { ok: false, reason: 'no_client_id' }
  }
  if (payload.iss !== expectedIssuer) return { ok: false, reason: 'issuer_mismatch' }

  const aud = payload.aud
  const audOk = Array.isArray(aud) ? aud.includes(clientId) : aud === clientId
  if (!audOk) return { ok: false, reason: 'audience_mismatch' }

  const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000)
  if (!Number.isFinite(payload.exp)) return { ok: false, reason: 'no_exp' }
  if (payload.exp + CLOCK_SKEW_S <= now) return { ok: false, reason: 'token_expired' }
  if (Number.isFinite(payload.nbf) && payload.nbf - CLOCK_SKEW_S > now) {
    return { ok: false, reason: 'token_not_yet_valid' }
  }

  if (typeof expectedNonce !== 'string' || expectedNonce.length === 0) {
    return { ok: false, reason: 'no_expected_nonce' }
  }
  if (payload.nonce !== expectedNonce) return { ok: false, reason: 'nonce_mismatch' }

  return { ok: true }
}

/**
 * Full verification. `verifyJwt` and `jwksFor` are injected so this is testable
 * without Entra and without network.
 *
 *   verifyJwt(token, keySet, { issuer, audience }) -> { payload }  (throws on failure)
 *   jwksFor(jwksUrl) -> key set accepted by verifyJwt
 */
export async function verifyMicrosoftIdToken ({
  idToken, clientId, expectedNonce, verifyJwt, jwksFor, nowSeconds = undefined,
}) {
  if (typeof idToken !== 'string' || idToken.length === 0) {
    return { ok: false, reason: 'no_id_token' }
  }
  const tid = unverifiedTenantId(idToken)
  if (!tid) return { ok: false, reason: 'no_or_invalid_tid' }

  const expectedIssuer = expectedIssuerForTenant(tid)
  const jwksUrl = jwksUrlForTenant(tid)
  if (!expectedIssuer || !jwksUrl) return { ok: false, reason: 'no_or_invalid_tid' }

  let payload
  try {
    const keySet = await jwksFor(jwksUrl)
    const res = await verifyJwt(idToken, keySet, {
      issuer: expectedIssuer,
      audience: clientId,
    })
    payload = res?.payload
  } catch {
    // Never surface the library's message: it can echo token contents.
    return { ok: false, reason: 'signature_or_key_invalid' }
  }

  const claims = validateIdTokenClaims(payload, {
    clientId, expectedNonce, expectedIssuer, nowSeconds,
  })
  if (!claims.ok) return { ok: false, reason: claims.reason }

  return { ok: true, payload, tenantId: tid }
}
