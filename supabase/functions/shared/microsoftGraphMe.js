// Mailbox address resolution via delegated Graph GET /v1.0/me.
//
// This is the ONLY reason User.Read is requested. It exists because
// microsoft_connections.ms_email is NOT NULL and id_token claims are not a
// sufficient source: Microsoft guarantees neither that `email` is present nor
// that `preferred_username` is mail-shaped, and a work/school UPN is frequently
// not a routable mailbox.
//
// SECURITY SHAPE
//   * $select is narrowed to the three fields actually used. That does NOT
//     reduce the authority User.Read grants - the permission still permits the
//     full profile and basic company information - it only reduces what is
//     returned. The disclosure describes both.
//   * The Graph `id` is cross-checked against the VALIDATED id_token `oid`.
//     A mismatch fails closed rather than trusting the Graph body.
//   * The access token is passed as a bearer credential and never decoded, and
//     redirects are refused so it is not replayed to another host.
//   * No provider response body is ever logged.

import { displayAddressFromClaims } from './microsoftOauthHelpers.js'
import { readJsonBounded, MAX_PROVIDER_BODY_BYTES } from './boundedJson.js'

export const GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me'
export const GRAPH_ME_SELECT = 'id,mail,userPrincipalName'
export const GRAPH_TIMEOUT_MS = 10_000
export const MAX_GRAPH_RESPONSE_BYTES = MAX_PROVIDER_BODY_BYTES

function mailShaped (v) {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (s.length < 3 || s.length > 320) return null
  return /^[^\s@]+@[^\s@]+$/.test(s) ? s : null
}

/**
 * Choose the mailbox address from a Graph /me body.
 * Prefers `mail`; falls back to `userPrincipalName` ONLY when mail-shaped.
 * Returns null when neither is usable - the caller must then fail, not invent.
 */
export function pickMailboxAddress (body) {
  if (!body || typeof body !== 'object') return null
  return mailShaped(body.mail) ?? mailShaped(body.userPrincipalName) ?? null
}

/**
 * Cross-check and resolve. `oid` is the VALIDATED id_token object id.
 * Returns { ok, email } or { ok: false, reason }.
 */
export function resolveMailboxFromGraphBody (body, oid) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'graph_me_malformed' }
  const gid = typeof body.id === 'string' ? body.id.trim() : ''
  if (!gid) return { ok: false, reason: 'graph_me_no_id' }
  if (typeof oid !== 'string' || oid.trim().length === 0) {
    return { ok: false, reason: 'no_validated_oid' }
  }
  // Fail closed: the account Graph describes must be the account the validated
  // id_token described. Otherwise we would record someone else's mailbox.
  if (gid.toLowerCase() !== oid.trim().toLowerCase()) {
    return { ok: false, reason: 'graph_identity_mismatch' }
  }
  const email = pickMailboxAddress(body)
  if (!email) return { ok: false, reason: 'no_usable_mailbox_address' }
  return { ok: true, email }
}

/**
 * Fetch and resolve. `fetchImpl` and `meUrl` are injected for tests and for the
 * loopback-only local harness; production callers pass neither.
 */
export async function fetchMailboxAddress ({
  accessToken, oid, fetchImpl = globalThis.fetch, meUrl = GRAPH_ME_URL,
  timeoutMs = GRAPH_TIMEOUT_MS, maxBytes = MAX_GRAPH_RESPONSE_BYTES,
}) {
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return { ok: false, reason: 'no_access_token' }
  }
  const url = `${meUrl}?$select=${encodeURIComponent(GRAPH_ME_SELECT)}`
  // ONE deadline covering the request AND the body read. fetch resolves on
  // HEADERS, so clearing the timer there would leave a stalled body unbounded.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let res
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: ctrl.signal,
        // The Authorization header carries the Graph access token. Following a
        // redirect could replay that bearer credential to another host, so the
        // fetch rejects instead.
        redirect: 'error',
      })
    } catch {
      return { ok: false, reason: 'graph_me_unreachable' }
    }
    if (!res || typeof res.status !== 'number') return { ok: false, reason: 'graph_me_malformed' }
    if (res.status === 401 || res.status === 403) {
      // Most likely User.Read was not actually granted.
      return { ok: false, reason: 'graph_me_forbidden' }
    }
    if (res.status !== 200) return { ok: false, reason: 'graph_me_http_error' }
    const read = await readJsonBounded(res, maxBytes)
    if (!read.ok) {
      return { ok: false, reason: read.reason === 'response_malformed'
        ? 'graph_me_malformed' : read.reason }
    }
    return resolveMailboxFromGraphBody(read.value, oid)
  } finally {
    clearTimeout(timer)
  }
}

/** Belt and braces: the id_token hint must not override the Graph answer. */
export function hintDisagreesWithResolved (claims, resolvedEmail) {
  const hint = displayAddressFromClaims(claims)
  if (!hint || typeof resolvedEmail !== 'string') return false
  return hint !== resolvedEmail.trim().toLowerCase()
}
