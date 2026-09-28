// Microsoft identity-platform helpers for the Outlook connect flow.
//
// AUDIENCE: BOTH personal Outlook.com accounts AND work/school accounts.
// Funnl serves students, who overwhelmingly arrive with a personal Microsoft
// account, so restricting to /organizations would exclude most of the audience.
// The Entra app registration must therefore use signInAudience
// "AzureADandPersonalMicrosoftAccount" and the /common authority below.
//
// TWO CORRECTIONS TO EARLIER DESIGN NOTES IN THIS REPO'S HISTORY
// --------------------------------------------------------------
//  1. "Personal accounts have no tenant ID" - WRONG. Personal Microsoft accounts
//     authenticate against a real tenant whose id is the well-known MSA tenant
//     9188040d-6c67-4c5b-b112-36a304b66dad ("consumers"). The id_token's `tid`
//     claim is present for personal accounts and equals that GUID. That is
//     precisely how account_type is classified below, and it is why
//     microsoft_connections.ms_tenant_id is nullable-but-usually-populated.
//  2. "Delegated Mail.Read is unavailable or behaves differently for personal
//     accounts" - WRONG. Delegated Mail.Read is supported for personal Microsoft
//     accounts on Microsoft Graph, and /me/messages works for both account types.
//     The real personal-account limits lie elsewhere (no admin consent flow, no
//     app-only/application permissions, and some ADVANCED endpoints - notably
//     /users/{id} directory reads and change-notification subscriptions on some
//     resources - are organization-only). Nothing this slice requests is
//     organization-only.
//
// NEVER DECODE THE GRAPH ACCESS TOKEN
// -----------------------------------
// The access token is issued for Microsoft Graph, not for us. Its format is
// explicitly not guaranteed and may be opaque; parsing it is unsupported and
// breaks without warning. Every authorization decision here is made from either
// (a) the id_token, which IS issued to this client and must be signature- and
// claim-validated, or (b) an explicit Graph call. The helpers below only ever
// read claims from a VALIDATED id_token payload handed to them.

// ── Endpoints ─────────────────────────────────────────────────────────────────
// /common accepts both personal and work/school accounts.
export const MS_AUTHORITY = 'https://login.microsoftonline.com/common'
export const MS_AUTH_ENDPOINT = `${MS_AUTHORITY}/oauth2/v2.0/authorize`
export const MS_TOKEN_ENDPOINT = `${MS_AUTHORITY}/oauth2/v2.0/token`
export const MS_JWKS_ENDPOINT = `${MS_AUTHORITY}/discovery/v2.0/keys`
export const MS_GRAPH_ME = 'https://graph.microsoft.com/v1.0/me'

/** The well-known tenant that issues tokens for personal Microsoft accounts. */
export const MSA_CONSUMERS_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad'

// ── Scopes ────────────────────────────────────────────────────────────────────
// Delegated, read-only mail plus the minimal identity/refresh scopes. Every one
// of these is supported for personal Microsoft accounts.
//   Mail.Read      read the signed-in user's mail (delegated; personal + work)
//   offline_access refresh tokens, so the worker can run without re-consent
//   openid/profile/email  identity for the id_token, and the address to display
// This list must stay a subset of the DB allowlist enforced by
// finalize_microsoft_connection and by the microsoft_connections CHECK:
//   ARRAY['Mail.Read','offline_access','openid','email','profile']
// No read-write, send, settings, files, contacts, calendar, .default, or
// application-only mail scope may ever appear here.
export const OUTLOOK_OAUTH_SCOPES = Object.freeze([
  'openid',
  'profile',
  'email',
  'offline_access',
  'https://graph.microsoft.com/Mail.Read',
])

/** What the DB will store after normalization, for test cross-checking. */
export const OUTLOOK_CANONICAL_SCOPES = Object.freeze([
  'Mail.Read', 'offline_access', 'openid', 'email', 'profile',
])

// ── Branded callback ──────────────────────────────────────────────────────────
// MUST be the branded host. A binding cookie set by *.supabase.co is never sent
// to www.getfunnl.com, so registering the Supabase function URL in Entra would
// make the binding gate structurally unenforceable no matter what the handler
// does. Entra matches redirect URIs exactly, so this is fixed at registration.
export const EXPECTED_OUTLOOK_CALLBACK_URL =
  'https://www.getfunnl.com/api/outlook-oauth-callback'

export const OUTLOOK_CANONICAL_ERROR_REDIRECT =
  'https://www.getfunnl.com/settings?outlook=error'

/** Refuses anything but the exact branded callback URL. */
export function isValidConfiguredOutlookCallbackUrl (raw) {
  return typeof raw === 'string' && raw === EXPECTED_OUTLOOK_CALLBACK_URL
}

/** Builds the post-OAuth Settings redirect from an already-trusted origin. */
export function buildOutlookSettingsRedirect (origin, result) {
  const r = result === 'connected' ? 'connected' : 'error'
  return `${origin}/settings?outlook=${r}`
}

// ── Authorization URL ─────────────────────────────────────────────────────────
/**
 * response_mode=form_post is deliberate. See the ADR block in
 * outlook-oauth-callback/index.ts for the full reasoning; in short it keeps the
 * authorization code and the state OUT of the callback URL, so neither lands in
 * browser history, the Referer header, or any intermediary access log.
 *
 * `nonce` is bound to the state so the id_token cannot be replayed from another
 * flow. It is NOT a substitute for the browser binding: an attacker who starts
 * the flow controls the nonce too.
 */
export function buildOutlookAuthUrl ({
  clientId, redirectUri, state, codeChallenge, nonce,
  scopes = OUTLOOK_OAUTH_SCOPES, prompt = 'select_account',
}) {
  if (!clientId) throw new Error('clientId required')
  if (!isValidConfiguredOutlookCallbackUrl(redirectUri)) {
    throw new Error('redirectUri must be the branded callback URL')
  }
  if (!state || !codeChallenge || !nonce) throw new Error('state, codeChallenge and nonce required')
  const p = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'form_post',
    scope: scopes.join(' '),
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt,
  })
  return `${MS_AUTH_ENDPOINT}?${p.toString()}`
}

// ── Identity, from a VALIDATED id_token payload only ──────────────────────────
/**
 * Classify the account from the id_token's `tid` claim.
 * Personal Microsoft accounts carry the well-known consumers tenant id; anything
 * else is a work/school tenant. Returns null when `tid` is absent or malformed,
 * which the caller must treat as a failure rather than guessing.
 */
export function classifyAccountType (tid) {
  if (typeof tid !== 'string') return null
  const t = tid.trim().toLowerCase()
  if (!/^[0-9a-f-]{36}$/.test(t)) return null
  return t === MSA_CONSUMERS_TENANT_ID ? 'personal' : 'work'
}

/**
 * Extract the identity this flow may act on, from an ALREADY-VALIDATED id_token
 * payload. Validation (signature via JWKS, iss, aud === our client id, exp/nbf,
 * and nonce equality) is the caller's job and must happen first.
 *
 * `oid` is the stable per-account object id and is what ms_account_id stores.
 * `email` is display-only; for personal accounts it usually arrives in `email`,
 * for work/school often in `preferred_username`. Neither is used for authorization.
 */
export function identityFromIdTokenClaims (claims) {
  if (!claims || typeof claims !== 'object') return { ok: false, reason: 'no_claims' }
  const oid = typeof claims.oid === 'string' ? claims.oid.trim() : ''
  if (!oid) return { ok: false, reason: 'missing_oid' }
  const accountType = classifyAccountType(claims.tid)
  if (!accountType) return { ok: false, reason: 'missing_or_invalid_tid' }
  const rawEmail = typeof claims.email === 'string' && claims.email.includes('@')
    ? claims.email
    : (typeof claims.preferred_username === 'string' && claims.preferred_username.includes('@')
        ? claims.preferred_username
        : '')
  const email = rawEmail.trim().toLowerCase()
  if (email.length < 3 || email.length > 320) return { ok: false, reason: 'missing_email' }
  return {
    ok: true,
    msAccountId: oid,
    msTenantId: String(claims.tid).trim().toLowerCase(),
    accountType,
    email,
  }
}

/**
 * Same-account reconnect only: a connection may be refreshed, never silently
 * repointed at a different mailbox.
 */
export function isSameMicrosoftAccount (existingConnection, newAccountId) {
  if (!existingConnection) return true
  return existingConnection.ms_account_id === newAccountId
}

/** Granted scopes come back space-delimited; compare case-insensitively. */
export function grantedScopesIncludeMailRead (scopeString) {
  if (typeof scopeString !== 'string') return false
  return scopeString.split(' ').filter(Boolean).some((s) => {
    const n = s.trim().toLowerCase()
    return n === 'mail.read' || n === 'https://graph.microsoft.com/mail.read'
  })
}
