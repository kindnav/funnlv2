// Email integration — Phase E2B: capability-aware Gmail OAuth (pure, DI).
//
// Cross-runtime (Node + Deno). All effects (encryption, persistence, revoke, capability
// write) are INJECTED, so the full control flow is unit-testable in plain Node with fakes.
// This module NEVER performs a network request and NEVER logs. It returns controlled
// reason codes only — never a token, authorization code, email address, Google `sub`,
// raw provider response, or OAuth state payload.
//
// RELATIONSHIP TO THE CALENDAR FLOW (critical):
//   The existing Calendar authorization (googleOauthHelpers.GOOGLE_OAUTH_SCOPES,
//   google-oauth-start, finalizeGoogleConnection) is NOT modified and NOT imported-into.
//   Gmail is a SEPARATE authorization path that reuses the shared primitives
//   (buildGoogleAuthUrl's `scopes` parameter, identity validation, refresh-token
//   requirement/preservation). `gmail.readonly` is requested ONLY on an explicit Gmail
//   connect and is never added to GOOGLE_OAUTH_SCOPES.
//
// CAPABILITY INDEPENDENCE: a Gmail outcome only ever writes the ('gmail') capability row
// via upsert_google_capability. The Calendar capability is never read, written, or
// invalidated here, so losing Gmail scope can never disable Calendar.

import {
  GOOGLE_OAUTH_SCOPES,
  buildGoogleAuthUrl,
  validateGoogleIdentity,
  isSameGoogleAccount,
  parseGrantedScopes,
} from './googleOauthHelpers.js'
import { GMAIL_READONLY_SCOPE } from './gmailTransport.js'

// The Gmail integration type persisted on google_oauth_states (the E2A migration already
// widened google_oauth_states_integration_check to admit 'gmail').
export const GMAIL_INTEGRATION_TYPE = 'gmail'
export const GMAIL_PRODUCT = 'gmail'

// Scopes requested on an explicit Gmail connect. Identity scopes are required because the
// callback verifies the returned Google account via the userinfo endpoint before touching
// anything. `gmail.readonly` is needed (not gmail.metadata) because the bounded initial
// import uses a date-scoped `q`, which gmail.metadata forbids.
export const GMAIL_OAUTH_SCOPES = Object.freeze([
  'openid',
  'email',
  'profile',
  GMAIL_READONLY_SCOPE,
])

/** True when the granted-scope string includes the Gmail read scope we requested. */
export function grantedScopesIncludeGmailReadonly(scopeString) {
  return parseGrantedScopes(scopeString).includes(GMAIL_READONLY_SCOPE)
}

/**
 * Build the Gmail consent URL. Delegates to the shared builder with Gmail scopes, so the
 * Calendar default (GOOGLE_OAUTH_SCOPES) is untouched. include_granted_scopes=true (set by
 * the shared builder) makes this INCREMENTAL: an existing Calendar grant is preserved and
 * Gmail is added rather than replacing it.
 */
export function buildGmailAuthUrl({ clientId, redirectUri, state, codeChallenge }) {
  return buildGoogleAuthUrl({ clientId, redirectUri, state, codeChallenge, scopes: GMAIL_OAUTH_SCOPES })
}

/** Defensive invariant: the Calendar scope set must never gain a Gmail scope. */
export function calendarScopesAreGmailFree() {
  return !GOOGLE_OAUTH_SCOPES.some((s) => /gmail/i.test(s))
}

/**
 * Settings return URL for a GMAIL consent. Deliberately a separate `?gmail=` param from
 * Calendar's `?google=`, so a Gmail round trip can never raise a "Google Calendar
 * connected" banner (and vice versa). Only the two controlled values are ever emitted.
 */
export function buildGmailSettingsRedirect(origin, result) {
  return `${origin}/settings?gmail=${result === 'connected' ? 'connected' : 'error'}`
}

/** Used ONLY when no validated origin is available (the state could not be resolved). */
export const GMAIL_CANONICAL_ERROR_REDIRECT = 'https://www.getfunnl.com/settings?gmail=error'

/**
 * Decide + persist the outcome of a Gmail consent callback.
 *
 * Guarantees:
 *   - `gmail.readonly` must actually be granted, else reject + best-effort revoke.
 *   - Google identity must be valid (sub + verified email).
 *   - With an EXISTING connection, the returned `sub` MUST match it. A mismatch is
 *     rejected with NO mutation (a different Google account can never take over, and no
 *     capability or token is touched).
 *   - A NEWLY RETURNED, usable, combined-scope refresh token is REQUIRED in every case.
 *     The Gmail consent is built with access_type=offline + prompt=consent, which requests
 *     re-consent so Google is expected to issue a fresh refresh token; that is requested
 *     behavior, not a guarantee, so the missing-token branch is kept defensively. If Google
 *     returns no refresh token the consent FAILS CLOSED (`missing_refresh_token`) with zero
 *     connection/token/capability mutation. Gmail is never activated on an older
 *     Calendar-only refresh credential: such a credential predates the Gmail grant and is
 *     not proven to carry the mailbox scope, and activating on it would also mean the
 *     stored token and the stored scopes disagree.
 *   - The Gmail capability row is written ONLY after the connection/token persistence
 *     succeeds, and ONLY for product 'gmail'.
 *
 * @param {{
 *   exchange: { accessToken: string, refreshToken?: string|null, expiresIn?: number|null, scope?: string|null },
 *   identity: { sub?: string, email?: string, email_verified?: boolean },
 *   userId: string,
 *   existingConnection: { id?: string, google_sub?: string }|null,
 *   existingRefreshRow: { refresh_token_ciphertext: string|null, refresh_token_nonce: string|null }|null,
 *                       // accepted for contract symmetry with the Calendar finalizer; NEVER
 *                       // reused for Gmail activation (see the refresh-token guarantee)
 *   encryptAccess: (t: string) => Promise<{ciphertext:string,nonce:string}>,
 *   encryptRefresh: (t: string) => Promise<{ciphertext:string,nonce:string}>,
 *   store: (args: object) => Promise<string>,             // store_google_connection -> connection id
 *   upsertCapability: (args: object) => Promise<object>,   // upsert_google_capability
 *   revoke: (token: string) => Promise<void>,             // best-effort
 *   nowMs?: number,
 * }} deps
 * @returns {Promise<{ok:true, connectionId:string}|{ok:false, reason:string}>}
 */
export async function finalizeGmailCapability(deps) {
  const {
    exchange, identity, userId, existingConnection, existingRefreshRow,
    encryptAccess, encryptRefresh, store, upsertCapability, revoke, nowMs = Date.now(),
  } = deps

  const accessToken = exchange?.accessToken
  const refreshToken = exchange?.refreshToken || null
  if (!accessToken) return { ok: false, reason: 'no_access_token' }
  if (typeof userId !== 'string' || userId.length === 0) return { ok: false, reason: 'invalid_user' }

  const revokeNew = async () => {
    try { await revoke(refreshToken || accessToken) } catch { /* best-effort */ }
  }

  // REVOCATION RULE (this is what makes adding Gmail safe for an existing Calendar user):
  // Google's revoke endpoint acts on the user's GRANT for this client, and the official
  // documentation only guarantees that revoking an access token also revokes ITS refresh
  // token — it gives no guarantee that OTHER refresh tokens the app already holds for the
  // same account survive. So a just-issued Gmail token is revoked on rejection ONLY when
  //   (a) there is no existing connection at all (nothing of ours can be collateral), or
  //   (b) the token provably belongs to a DIFFERENT Google account (sub mismatch).
  // For the same account we never revoke: the unused new grant is harmless, whereas a
  // revoke could silently kill the stored refresh token Calendar is still using.
  const hasExisting = !!(existingConnection && existingConnection.google_sub)

  // 1. Google identity must be valid. Without a verified sub we cannot tell whether the
  //    new token belongs to the connected account, so an existing connection is protected.
  const idResult = validateGoogleIdentity(identity)
  if (!idResult.ok) {
    if (!hasExisting) await revokeNew()
    return { ok: false, reason: 'identity_invalid' }
  }

  // 2. Account binding. With an existing connection the sub MUST match. A mismatch is a
  //    hard refusal with NO mutation — adding Gmail must never replace, inherit, or
  //    repoint a connection that belongs to a different Google account. The new token is
  //    for that OTHER account, so revoking it cannot touch the stored credential.
  const sameSub = isSameGoogleAccount(existingConnection, idResult.sub)
  if (hasExisting && !sameSub) {
    await revokeNew()
    return { ok: false, reason: 'google_sub_mismatch' }
  }

  // 3. The Gmail scope must actually have been granted (Google's granular consent lets the
  //    user untick it). Same-account rejection leaves the working Calendar grant alone.
  if (!grantedScopesIncludeGmailReadonly(exchange?.scope)) {
    if (!hasExisting) await revokeNew()
    return { ok: false, reason: 'gmail_scope_not_granted' }
  }

  // 4. A NEW combined-scope refresh token is required — no reuse of a stored (possibly
  //    Calendar-only) credential. Fail closed with zero mutation. For an existing
  //    same-account connection nothing is revoked either: the working Calendar grant must
  //    survive a failed Gmail attempt. A brand-new connection has nothing of ours to
  //    protect, so its unusable new token is revoked best-effort.
  if (!refreshToken) {
    if (!hasExisting) await revokeNew()
    return { ok: false, reason: 'missing_refresh_token' }
  }

  // 5. Encrypt + persist connection/token atomically (single RPC), then the capability.
  //    The stored refresh pair is ALWAYS the newly returned one.
  let connectionId
  try {
    const encAccess = await encryptAccess(accessToken)
    const encRefresh = await encryptRefresh(refreshToken)
    const tokenExpiresAt = exchange?.expiresIn
      ? new Date(nowMs + exchange.expiresIn * 1000).toISOString()
      : null
    connectionId = await store({
      p_user_id:          userId,
      p_google_sub:       idResult.sub,
      p_google_email:     idResult.email,
      p_scopes:           parseGrantedScopes(exchange?.scope),
      p_status:           'active',
      p_token_expires_at: tokenExpiresAt,
      p_access_ct:        encAccess.ciphertext,
      p_access_nonce:     encAccess.nonce,
      p_refresh_ct:       encRefresh.ciphertext,
      p_refresh_nonce:    encRefresh.nonce,
      p_key_version:      1,
    })
  } catch {
    // A brand-new account's token is revocable; an existing sub-matched account keeps its
    // working grant (never revoke a credential Calendar may still be using).
    if (!hasExisting) await revokeNew()
    return { ok: false, reason: 'persist_failed' }
  }

  if (typeof connectionId !== 'string' || connectionId.length === 0) {
    return { ok: false, reason: 'persist_failed' }
  }

  // 6. Record the Gmail capability ONLY (Calendar untouched).
  try {
    const res = await upsertCapability({
      p_connection_id: connectionId,
      p_user_id:       userId,
      p_product:       GMAIL_PRODUCT,
      p_status:        'active',
      p_granted:       true,
      p_needs_reauth:  false,
      p_result_code:   'connected',
    })
    const code = res && typeof res === 'object' ? res.result : res
    if (code !== 'ok') return { ok: false, reason: 'capability_write_failed' }
  } catch {
    return { ok: false, reason: 'capability_write_failed' }
  }

  return { ok: true, connectionId }
}

/**
 * Map a Gmail runtime failure to the capability transition the worker should persist.
 * Gmail-scope loss marks ONLY Gmail needs_reauth; an invalid/revoked shared refresh
 * credential is a connection-wide failure that the caller must apply to every capability
 * using that credential (reported via `connectionWide`). Calendar is never implicitly
 * disabled by a Gmail-specific failure.
 *
 * @param {('gmail_scope_revoked'|'invalid_grant'|'provider_error'|'ok')} reason
 * @returns {{ product:'gmail', status:string, granted:boolean, needsReauth:boolean,
 *             resultCode:string, connectionWide:boolean }}
 */
export function resolveGmailCapabilityTransition(reason) {
  switch (reason) {
    case 'ok':
      return { product: GMAIL_PRODUCT, status: 'active', granted: true, needsReauth: false, resultCode: 'ok', connectionWide: false }
    case 'gmail_scope_revoked':
      // Gmail scope specifically lost → Gmail needs reauth. Calendar unaffected.
      return { product: GMAIL_PRODUCT, status: 'needs_reauth', granted: false, needsReauth: true, resultCode: 'gmail_scope_revoked', connectionWide: false }
    case 'invalid_grant':
      // The shared refresh credential itself is invalid/revoked → connection-wide failure.
      return { product: GMAIL_PRODUCT, status: 'needs_reauth', granted: false, needsReauth: true, resultCode: 'invalid_grant', connectionWide: true }
    default:
      // Transient/unknown provider failure: keep the capability usable, record the code.
      return { product: GMAIL_PRODUCT, status: 'active', granted: true, needsReauth: false, resultCode: 'provider_error', connectionWide: false }
  }
}
