// finalizeGoogleConnection — the post-token-exchange decision + persistence flow
// for the OAuth callback. All effects (encryption, storage, revoke, old-token
// resolution) are injected, so the full control flow is unit-testable in plain
// Node with fakes. Zero imports except the pure validators.
//
// Guarantees enforced here:
//   - Required Calendar scope must be granted (else reject + revoke new token).
//   - Google identity must be valid (sub, email, email_verified === true).
//   - A refresh token is REQUIRED for a new/replacement account (different sub).
//   - A stored refresh token is preserved ONLY for the same Google account — a
//     token from account A can never attach to account B.
//   - Connection + tokens are persisted ATOMICALLY (store() is a single RPC); a
//     persistence failure best-effort revokes the newly issued token and leaves
//     no active connection without tokens.
//   - When replacing a different account, the OLD account's token is revoked
//     best-effort AFTER the new connection is stored — and never before, so a
//     failed authorization does not destroy the working old connection.
//   - No tokens/codes/identity/response bodies are logged (this module never logs).

import {
  grantedScopesIncludeCalendar,
  validateGoogleIdentity,
  isSameGoogleAccount,
  requiresNewRefreshToken,
  resolveRefreshTokenColumns,
} from './googleOauthHelpers.js'

/**
 * @param {{
 *   exchange: { accessToken: string, refreshToken?: string|null, expiresIn?: number|null, scope?: string|null },
 *   identity: { sub?: string, email?: string, email_verified?: boolean },
 *   userId: string,
 *   existingConnection: { google_sub?: string }|null,
 *   encryptAccess: (t: string) => Promise<{ ciphertext: string, nonce: string }>,
 *   encryptRefresh: (t: string) => Promise<{ ciphertext: string, nonce: string }>,
 *   existingRefreshRow: { refresh_token_ciphertext: string|null, refresh_token_nonce: string|null }|null,
 *   store: (args: object) => Promise<string>,        // atomic RPC → connection id (may throw)
 *   revoke: (token: string) => Promise<void>,        // best-effort; may reject
 *   resolveOldToken: () => Promise<string|null>,     // decrypts the OLD account's token (only used on account change)
 *   nowMs?: number,
 * }} deps
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function finalizeGoogleConnection(deps) {
  const {
    exchange, identity, userId, existingConnection,
    encryptAccess, encryptRefresh, existingRefreshRow,
    store, revoke, resolveOldToken, nowMs = Date.now(),
  } = deps

  const accessToken  = exchange?.accessToken
  const refreshToken = exchange?.refreshToken || null
  if (!accessToken) return { ok: false, reason: 'no_access_token' }

  // Best-effort revoke of the just-issued token, used on every pre-persistence reject.
  const revokeNew = async () => {
    try { await revoke(refreshToken || accessToken) } catch { /* best-effort */ }
  }

  // 1. Required Calendar scope must be granted.
  if (!grantedScopesIncludeCalendar(exchange?.scope)) {
    await revokeNew()
    return { ok: false, reason: 'calendar_scope_not_granted' }
  }

  // 2. Google identity must be valid (sub + email + email_verified === true).
  const idResult = validateGoogleIdentity(identity)
  if (!idResult.ok) {
    await revokeNew()
    return { ok: false, reason: 'identity_invalid' }
  }

  // 3. Refresh-token requirement for a new / different account.
  const sameSub = isSameGoogleAccount(existingConnection, idResult.sub)
  if (requiresNewRefreshToken(sameSub, Boolean(refreshToken))) {
    await revokeNew()
    return { ok: false, reason: 'refresh_token_required' }
  }

  // 4. Encrypt tokens. Refresh preserved ONLY for the same account.
  const encAccess  = await encryptAccess(accessToken)
  const encRefresh = refreshToken ? await encryptRefresh(refreshToken) : null
  const refreshCols = resolveRefreshTokenColumns(encRefresh, existingRefreshRow, sameSub)

  // 5. Atomic persistence (single RPC). On failure, revoke the new token and
  //    leave NO partial active connection (the RPC rolls both rows back).
  const tokenExpiresAt = exchange?.expiresIn
    ? new Date(nowMs + exchange.expiresIn * 1000).toISOString()
    : null
  const scopes = (exchange?.scope || '').split(' ').filter(Boolean)
  try {
    await store({
      p_user_id:          userId,
      p_google_sub:       idResult.sub,
      p_google_email:     idResult.email,
      p_scopes:           scopes,
      p_status:           'active',
      p_token_expires_at: tokenExpiresAt,
      p_access_ct:        encAccess.ciphertext,
      p_access_nonce:     encAccess.nonce,
      p_refresh_ct:       refreshCols.refresh_token_ciphertext,
      p_refresh_nonce:    refreshCols.refresh_token_nonce,
      p_key_version:      1,
    })
  } catch {
    await revokeNew()
    return { ok: false, reason: 'persist_failed' }
  }

  // 6. Account was replaced → best-effort revoke the OLD account's token AFTER
  //    the new connection is safely stored (never before).
  if (!sameSub && existingConnection) {
    try {
      const oldToken = await resolveOldToken()
      if (oldToken) await revoke(oldToken)
    } catch { /* best-effort */ }
  }

  return { ok: true }
}
