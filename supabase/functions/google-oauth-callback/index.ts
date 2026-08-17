// google-oauth-callback — Google redirects here after consent. This function is
// deployed with verify_jwt=false (Google's redirect carries no Supabase JWT); it
// is instead securely gated by the one-time, hashed, expiring OAuth state that
// was created by google-oauth-start.
//
// Flow: validate+atomically consume state → exchange code (PKCE) server-side →
// verify the Google identity via the official userinfo endpoint → bind to the
// Funnl user stored with the state → encrypt+store tokens (preserving an existing
// refresh token if omitted) → redirect ONLY to the previously validated origin
// with a server-constructed /settings?google=connected|error path.
//
// Tokens are never returned to the browser. Only controlled error codes are logged.
//
// Server config (Edge secrets):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_OAUTH_CALLBACK_URL,
//   GOOGLE_TOKEN_ENCRYPTION_KEY_V1

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { importKeyFromBase64, encryptToken, decryptToken } from '../shared/googleTokenCrypto.js'
import {
  sha256Hex,
  buildSettingsRedirect,
  resolveReturnOrigin,
  resolveRefreshTokenColumns,
  CANONICAL_ERROR_REDIRECT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
} from '../shared/googleOauthHelpers.js'

const GOOGLE_FETCH_TIMEOUT_MS = 10_000

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } })
}

async function boundedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), GOOGLE_FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

Deno.serve(async (req) => {
  // Google redirects with a GET. A safe error redirect needs a validated origin;
  // until the state is resolved we can only trust the canonical production origin.
  let safeErrorRedirect = CANONICAL_ERROR_REDIRECT

  try {
    const url = new URL(req.url)
    const code       = url.searchParams.get('code')
    const state      = url.searchParams.get('state')
    const googleError = url.searchParams.get('error')

    if (googleError || !code || !state) {
      console.error('google-oauth-callback missing_code_or_state')
      return redirect(safeErrorRedirect)
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // ── Atomically consume the one-time state ───────────────────────────────
    // A single conditional UPDATE marks it consumed only if not already consumed
    // and not expired; RETURNING the row proves this caller won the race.
    const stateHash = await sha256Hex(state)
    const nowIso = new Date().toISOString()
    const { data: stateRow, error: consumeError } = await admin
      .from('google_oauth_states')
      .update({ consumed_at: nowIso })
      .eq('state_hash', stateHash)
      .is('consumed_at', null)
      .gt('expires_at', nowIso)
      .select('user_id, pkce_verifier_ciphertext, pkce_verifier_nonce, return_origin')
      .maybeSingle()

    if (consumeError || !stateRow) {
      // Missing, expired, already-used, or mismatched state.
      console.error('google-oauth-callback invalid_state')
      return redirect(safeErrorRedirect)
    }

    // From here we have a validated origin to redirect to.
    const validatedOrigin = resolveReturnOrigin(stateRow.return_origin)
    safeErrorRedirect = validatedOrigin
      ? buildSettingsRedirect(validatedOrigin, 'error')
      : CANONICAL_ERROR_REDIRECT

    // ── Server config ───────────────────────────────────────────────────────
    const clientId     = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
    const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''
    const callbackUrl  = Deno.env.get('GOOGLE_OAUTH_CALLBACK_URL') ?? ''
    const keyB64       = Deno.env.get('GOOGLE_TOKEN_ENCRYPTION_KEY_V1') ?? ''
    if (!clientId || !clientSecret || !callbackUrl || !keyB64) {
      console.error('google-oauth-callback config_missing')
      return redirect(safeErrorRedirect)
    }
    const key = await importKeyFromBase64(keyB64)

    // ── Decrypt PKCE verifier + exchange the authorization code ─────────────
    const codeVerifier = await decryptToken(
      stateRow.pkce_verifier_ciphertext,
      stateRow.pkce_verifier_nonce,
      key,
    )

    const tokenParams = new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  callbackUrl,
      grant_type:    'authorization_code',
      code_verifier: codeVerifier,
    })
    const tokenRes = await boundedFetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    })
    if (!tokenRes.ok) {
      console.error('google-oauth-callback token_exchange_failed', tokenRes.status)
      return redirect(safeErrorRedirect)
    }
    const tokenData = await tokenRes.json()
    const accessToken  = tokenData.access_token as string | undefined
    const refreshToken = tokenData.refresh_token as string | undefined
    const expiresIn    = tokenData.expires_in as number | undefined
    const grantedScope = (tokenData.scope as string | undefined) ?? ''
    if (!accessToken) {
      console.error('google-oauth-callback no_access_token')
      return redirect(safeErrorRedirect)
    }

    // ── Verify the Google identity via the official userinfo endpoint ───────
    const userinfoRes = await boundedFetch(GOOGLE_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!userinfoRes.ok) {
      console.error('google-oauth-callback userinfo_failed', userinfoRes.status)
      return redirect(safeErrorRedirect)
    }
    const userinfo = await userinfoRes.json()
    const googleSub   = userinfo.sub as string | undefined
    const googleEmail = userinfo.email as string | undefined
    if (!googleSub || !googleEmail) {
      console.error('google-oauth-callback userinfo_incomplete')
      return redirect(safeErrorRedirect)
    }

    // ── Upsert the connection (one per user) bound to the state's user ──────
    const tokenExpiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null
    const scopes = grantedScope ? grantedScope.split(' ').filter(Boolean) : []
    const { data: conn, error: connError } = await admin
      .from('google_connections')
      .upsert({
        user_id:          stateRow.user_id,
        google_sub:       googleSub,
        google_email:     googleEmail,
        scopes,
        status:           'active',
        token_expires_at: tokenExpiresAt,
        updated_at:       new Date().toISOString(),
      }, { onConflict: 'user_id' })
      .select('id')
      .single()
    if (connError || !conn) {
      console.error('google-oauth-callback connection_upsert_failed', connError?.code ?? 'db_error')
      return redirect(safeErrorRedirect)
    }

    // ── Encrypt + store tokens, preserving an existing refresh token ────────
    const encAccess = await encryptToken(accessToken, key)
    const encRefresh = refreshToken ? await encryptToken(refreshToken, key) : null

    const { data: existingTokens } = await admin
      .from('google_tokens')
      .select('refresh_token_ciphertext, refresh_token_nonce')
      .eq('connection_id', conn.id)
      .maybeSingle()

    const refreshCols = resolveRefreshTokenColumns(encRefresh, existingTokens ?? null)

    const { error: tokenStoreError } = await admin
      .from('google_tokens')
      .upsert({
        connection_id:           conn.id,
        access_token_ciphertext: encAccess.ciphertext,
        access_token_nonce:      encAccess.nonce,
        refresh_token_ciphertext: refreshCols.refresh_token_ciphertext,
        refresh_token_nonce:      refreshCols.refresh_token_nonce,
        key_version:             1,
        updated_at:              new Date().toISOString(),
      }, { onConflict: 'connection_id' })
    if (tokenStoreError) {
      console.error('google-oauth-callback token_store_failed', tokenStoreError.code ?? 'db_error')
      return redirect(safeErrorRedirect)
    }

    // ── Success: redirect only to the validated origin ──────────────────────
    const successRedirect = validatedOrigin
      ? buildSettingsRedirect(validatedOrigin, 'connected')
      : CANONICAL_ERROR_REDIRECT
    return redirect(successRedirect)
  } catch {
    console.error('google-oauth-callback internal_error')
    return redirect(safeErrorRedirect)
  }
})
