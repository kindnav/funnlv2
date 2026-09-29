// Authorization-code redemption at the Microsoft token endpoint.
//
// Confidential client: the secret never leaves the Edge Function, and the
// request carries the PKCE verifier plus the EXACT registered redirect URI
// (Microsoft requires it to match the one used at /authorize).
//
// NEVER LOGGED: the code, the verifier, the client secret, the returned tokens,
// or any provider response body. Failures surface as controlled reason codes.

import { readJsonBounded, MAX_PROVIDER_BODY_BYTES } from './boundedJson.js'

export const TOKEN_TIMEOUT_MS = 15_000
export const MAX_TOKEN_RESPONSE_BYTES = MAX_PROVIDER_BODY_BYTES

/** Space-delimited granted scopes, exactly as the provider returned them. */
export function parseGrantedScopes (scopeString) {
  if (typeof scopeString !== 'string') return []
  return scopeString.split(' ').map((s) => s.trim()).filter(Boolean)
}

function includesScope (granted, name) {
  const want = name.toLowerCase()
  return granted.some((s) => {
    const n = s.toLowerCase().replace('https://graph.microsoft.com/', '')
    return n === want
  })
}

/**
 * Both permissions must actually have been granted. A user can decline
 * individual permissions, so what we ASKED for is not what we GOT.
 */
export function grantedScopesSufficient (granted) {
  const missing = []
  if (!includesScope(granted, 'mail.read')) missing.push('Mail.Read')
  if (!includesScope(granted, 'user.read')) missing.push('User.Read')
  return { ok: missing.length === 0, missing }
}

/** Shape check on the token response. Returns a controlled reason on failure. */
export function validateTokenResponseShape (body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'token_response_malformed' }
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    return { ok: false, reason: 'token_response_no_access_token' }
  }
  if (typeof body.id_token !== 'string' || body.id_token.length === 0) {
    return { ok: false, reason: 'token_response_no_id_token' }
  }
  // offline_access was requested, so a refresh token is expected. Without one
  // the connection cannot survive access-token expiry.
  if (typeof body.refresh_token !== 'string' || body.refresh_token.length === 0) {
    return { ok: false, reason: 'refresh_token_required' }
  }
  const expiresIn = Number(body.expires_in)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    return { ok: false, reason: 'token_response_no_expiry' }
  }
  return { ok: true, expiresIn }
}

/**
 * Redeem the code. `fetchImpl` and `tokenUrl` are parameters: the deployed
 * entrypoint passes fixed Microsoft URLs, and only the test harness passes others.
 *
 * Returns { ok, accessToken, refreshToken, idToken, grantedScopes, expiresAt }
 * or { ok: false, reason }.
 */
export async function redeemAuthorizationCode ({
  code, codeVerifier, clientId, clientSecret, redirectUri,
  fetchImpl = globalThis.fetch, tokenUrl, timeoutMs = TOKEN_TIMEOUT_MS, now = () => Date.now(), maxBytes = MAX_TOKEN_RESPONSE_BYTES,
}) {
  for (const [v, reason] of [
    [code, 'no_code'], [codeVerifier, 'no_verifier'], [clientId, 'no_client_id'],
    [clientSecret, 'no_client_secret'], [redirectUri, 'no_redirect_uri'], [tokenUrl, 'no_token_url'],
  ]) {
    if (typeof v !== 'string' || v.length === 0) return { ok: false, reason }
  }

  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  })

  // ONE deadline covering the request AND the body read. fetch resolves when
  // the HEADERS arrive, so clearing the timer here would leave a stalled or
  // endless body unbounded.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let res
    try {
      res = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form.toString(),
        signal: ctrl.signal,
        // This body carries the authorization code, the client secret and the
        // PKCE verifier. A 307 or 308 preserves method AND body, so a followed
        // redirect would repost all three to whatever host the response named.
        // 'error' makes the fetch reject instead of following anything.
        redirect: 'error',
      })
    } catch {
      return { ok: false, reason: 'token_endpoint_unreachable' }
    }

    if (!res || typeof res.status !== 'number') return { ok: false, reason: 'token_response_malformed' }
    if (res.status !== 200) {
      // The provider body can contain the code and diagnostic detail: not logged,
      // not returned. Only the status class is kept.
      return { ok: false, reason: res.status >= 500 ? 'token_endpoint_server_error' : 'token_exchange_rejected' }
    }

    const read = await readJsonBounded(res, maxBytes)
    if (!read.ok) {
      return { ok: false, reason: read.reason === 'response_malformed'
        ? 'token_response_malformed' : read.reason }
    }
    const body = read.value

    const shape = validateTokenResponseShape(body)
    if (!shape.ok) return { ok: false, reason: shape.reason }

    const granted = parseGrantedScopes(body.scope)
    return {
      ok: true,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      idToken: body.id_token,
      grantedScopes: granted,
      expiresAt: new Date(now() + shape.expiresIn * 1000).toISOString(),
    }
  } finally {
    clearTimeout(timer)
  }
}
