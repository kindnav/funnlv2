// Pure helpers for the Google OAuth flow — origin allowlist, PKCE, state hashing,
// scope list, auth-URL construction, and the callback redirect. Zero dependencies
// beyond Web Crypto (Deno + Node 20), so every function here is unit-testable in
// the plain-Node runner.
//
// SECURITY NOTES:
//   - Only Calendar read-only is requested. NO Gmail scope appears here.
//   - The raw OAuth state is returned to the browser/Google but only its SHA-256
//     hash is ever persisted (see sha256Hex) — a DB read cannot forge a state.
//   - The return origin is validated against a strict allowlist; anything not on
//     it (http, ports, credentials, arbitrary vercel.app, look-alikes) is rejected.

import { bytesToBase64 } from './googleTokenCrypto.js'

// ── Scopes (Phase 0A: Calendar read-only only — NO Gmail) ─────────────────────
export const REQUIRED_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly'

export const GOOGLE_OAUTH_SCOPES = Object.freeze([
  'openid',
  'email',
  'profile',
  REQUIRED_CALENDAR_SCOPE,
])

export const GOOGLE_AUTH_ENDPOINT  = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_ENDPOINT  = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'
export const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'

// ── Return-origin allowlist ───────────────────────────────────────────────────
// Production apex + www, plus the Funnl team-scoped Vercel preview pattern. Only
// the funnlv2 team can deploy hosts ending in -funnlv2.vercel.app, so an arbitrary
// *.vercel.app or look-alike host cannot match. Fully anchored, lowercase host.
const PROD_ORIGINS = new Set(['https://www.getfunnl.com', 'https://getfunnl.com'])
const PREVIEW_HOST_RE = /^funnlv2-[a-z0-9-]+-funnlv2\.vercel\.app$/

/**
 * Validates a browser-supplied return origin. Returns the bare `https://host`
 * origin when trusted, or null when it must be rejected (missing, non-string,
 * malformed, non-https, credential- or port-bearing, or not on the allowlist).
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function resolveReturnOrigin(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let u
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  if (u.username || u.password) return null      // no userinfo trickery
  if (u.port) return null                        // prod/preview never use a custom port
  const origin = `https://${u.hostname}`
  if (PROD_ORIGINS.has(origin)) return origin
  if (PREVIEW_HOST_RE.test(u.hostname)) return origin
  return null
}

/**
 * Builds the post-OAuth Settings redirect from a trusted origin and a result.
 * The path + query are constructed server-side; only the origin varies and it
 * must already have passed resolveReturnOrigin.
 *
 * @param {string} origin — trusted https origin
 * @param {'connected'|'error'} result
 * @returns {string}
 */
export function buildSettingsRedirect(origin, result) {
  const r = result === 'connected' ? 'connected' : 'error'
  return `${origin}/settings?google=${r}`
}

// Canonical fallback used ONLY when no validated origin is available (e.g. the
// OAuth state could not be resolved on callback, so we cannot trust any origin).
export const CANONICAL_ERROR_REDIRECT = 'https://www.getfunnl.com/settings?google=error'

// ── base64url ─────────────────────────────────────────────────────────────────
export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ── Random tokens (OAuth state + PKCE verifier) ───────────────────────────────
/**
 * Generates a URL-safe random token (base64url of `nBytes` random bytes).
 * @param {number} nBytes
 * @param {(n:number)=>Uint8Array} getRandomBytes
 * @returns {string}
 */
export function generateRandomToken(nBytes = 32, getRandomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  return bytesToBase64Url(getRandomBytes(nBytes))
}

// ── SHA-256 helpers ───────────────────────────────────────────────────────────
async function sha256Bytes(input, subtle = globalThis.crypto.subtle) {
  const data = new TextEncoder().encode(input)
  const digest = await subtle.digest('SHA-256', data)
  return new Uint8Array(digest)
}

/** SHA-256 hex digest — used to store the state hash (raw state never persisted). */
export async function sha256Hex(input, subtle = globalThis.crypto.subtle) {
  const bytes = await sha256Bytes(input, subtle)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

/** PKCE S256 challenge = base64url(SHA-256(verifier)). */
export async function pkceChallengeFromVerifier(verifier, subtle = globalThis.crypto.subtle) {
  const bytes = await sha256Bytes(verifier, subtle)
  return bytesToBase64Url(bytes)
}

/**
 * Builds the Google authorization URL for the web-server OAuth flow with PKCE and
 * offline access (to receive a refresh token). Only Calendar read-only is scoped.
 *
 * @param {{ clientId: string, redirectUri: string, state: string, codeChallenge: string, scopes?: string[] }} p
 * @returns {string}
 */
export function buildGoogleAuthUrl({ clientId, redirectUri, state, codeChallenge, scopes = GOOGLE_OAUTH_SCOPES }) {
  const params = new URLSearchParams({
    client_id:             clientId,
    redirect_uri:          redirectUri,
    response_type:         'code',
    scope:                 scopes.join(' '),
    access_type:           'offline',                // web-server flow → refresh token
    // 'consent' forces re-consent so a refresh token is re-issued even for a
    // previously-authorized account; 'select_account' lets the user pick or replace
    // the Google account being connected. Background Calendar sync (a later phase)
    // needs a usable refresh token, so re-consent must be reliable.
    prompt:                'consent select_account',
    include_granted_scopes:'true',
    state,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  })
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`
}

// ── Granted-scope validation ──────────────────────────────────────────────────
/**
 * Parses a space-delimited granted-scope string into an array.
 * @param {unknown} scopeString
 * @returns {string[]}
 */
export function parseGrantedScopes(scopeString) {
  if (typeof scopeString !== 'string') return []
  return scopeString.split(' ').filter(Boolean)
}

/**
 * True only when the granted scopes include the required Calendar read-only scope.
 * @param {unknown} scopeString — the `scope` field of the token response
 * @returns {boolean}
 */
export function grantedScopesIncludeCalendar(scopeString) {
  return parseGrantedScopes(scopeString).includes(REQUIRED_CALENDAR_SCOPE)
}

// ── Google identity validation ────────────────────────────────────────────────
/**
 * Validates the verified Google identity (from the userinfo/ID-token response).
 * Requires a non-empty `sub`, a non-empty `email`, and `email_verified === true`.
 * google_sub is the stable identity key — email is never the primary key.
 *
 * @param {{ sub?: unknown, email?: unknown, email_verified?: unknown }|null} identity
 * @returns {{ ok: true, sub: string, email: string } | { ok: false, reason: string }}
 */
export function validateGoogleIdentity(identity) {
  const sub = identity?.sub
  const email = identity?.email
  if (typeof sub !== 'string' || sub.length === 0) return { ok: false, reason: 'missing_sub' }
  if (typeof email !== 'string' || email.length === 0) return { ok: false, reason: 'missing_email' }
  if (identity?.email_verified !== true) return { ok: false, reason: 'email_unverified' }
  return { ok: true, sub, email }
}

// ── Account identity comparison ───────────────────────────────────────────────
/**
 * True when an existing connection belongs to the SAME Google account as the newly
 * verified sub. Used to decide whether a stored refresh token may be preserved.
 * @param {{ google_sub?: string }|null} existingConnection
 * @param {string} newSub
 * @returns {boolean}
 */
export function isSameGoogleAccount(existingConnection, newSub) {
  return Boolean(existingConnection) &&
    typeof existingConnection.google_sub === 'string' &&
    existingConnection.google_sub === newSub
}

/**
 * A new refresh token is REQUIRED (cannot fall back to a stored one) whenever the
 * connection is new or the Google account changed — i.e. whenever it is not the
 * same account. Re-consent on the same account may keep the stored token.
 * @param {boolean} sameSub
 * @param {boolean} hasNewRefresh
 * @returns {boolean} true when the flow must be rejected for lacking a refresh token
 */
export function requiresNewRefreshToken(sameSub, hasNewRefresh) {
  return !sameSub && !hasNewRefresh
}

// ── Stale OAuth-state cleanup cutoff ──────────────────────────────────────────
/**
 * ISO cutoff for best-effort deletion of old OAuth state rows: any row created
 * before (now - retentionMs) is safely past its short TTL (10 min) and unusable,
 * whether it was consumed or simply expired.
 * @param {number} nowMs
 * @param {number} retentionMs
 * @returns {string} ISO timestamp
 */
export function staleOauthStateCutoffIso(nowMs, retentionMs) {
  return new Date(nowMs - retentionMs).toISOString()
}

/**
 * Decides the refresh-token columns to persist.
 *
 * A stored refresh token may be preserved ONLY when the response omits a new one
 * AND the connection is the SAME Google account (sameSub === true). When the
 * account differs, the previous account's refresh token is NEVER reused —
 * account A's refresh token can never be attached to account B. In that case, if
 * no new refresh token is present, the null pair is returned (the caller must
 * reject the flow via requiresNewRefreshToken()).
 *
 * @param {{ ciphertext: string, nonce: string }|null} newlyEncrypted — encrypted new refresh token, or null
 * @param {{ refresh_token_ciphertext: string|null, refresh_token_nonce: string|null }|null} existingRow — existing google_tokens row, or null
 * @param {boolean} sameSub — whether the existing connection is the same Google account
 * @returns {{ refresh_token_ciphertext: string|null, refresh_token_nonce: string|null }}
 */
export function resolveRefreshTokenColumns(newlyEncrypted, existingRow, sameSub) {
  if (newlyEncrypted && newlyEncrypted.ciphertext && newlyEncrypted.nonce) {
    return {
      refresh_token_ciphertext: newlyEncrypted.ciphertext,
      refresh_token_nonce:      newlyEncrypted.nonce,
    }
  }
  // No new refresh token: keep the stored one ONLY for the same Google account.
  if (sameSub === true) {
    return {
      refresh_token_ciphertext: existingRow?.refresh_token_ciphertext ?? null,
      refresh_token_nonce:      existingRow?.refresh_token_nonce ?? null,
    }
  }
  // Different (or unknown) account with no new refresh token — never reuse.
  return { refresh_token_ciphertext: null, refresh_token_nonce: null }
}
