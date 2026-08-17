// google-oauth-callback — Google redirects here after consent. Deployed with
// verify_jwt=false (Google's redirect carries no Supabase JWT); it is instead
// securely gated by the one-time, hashed, expiring OAuth state from oauth-start.
//
// Flow: resolve + atomically consume state (also gives the validated redirect
// origin) → exchange code (PKCE) server-side → verify Google identity via the
// official userinfo endpoint → delegate the decision + ATOMIC persistence to the
// tested finalizeGoogleConnection helper (granted-scope check, email_verified,
// same-account refresh preservation, refresh-required-for-new-account, atomic
// store via RPC, best-effort revoke on failure, old-account revoke after replace)
// → redirect ONLY to the validated origin with a server-constructed
// /settings?google=connected|error path.
//
// Tokens are never returned to the browser. Only controlled error codes are logged.
//
// Server config: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_OAUTH_CALLBACK_URL,
// GOOGLE_TOKEN_ENCRYPTION_KEY_V1.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { importKeyFromBase64, encryptToken, decryptToken } from '../shared/googleTokenCrypto.js'
import {
  sha256Hex,
  buildSettingsRedirect,
  resolveReturnOrigin,
  CANONICAL_ERROR_REDIRECT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
  GOOGLE_REVOKE_ENDPOINT,
} from '../shared/googleOauthHelpers.js'
import { finalizeGoogleConnection } from '../shared/googleConnect.js'

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

async function revokeToken(token: string): Promise<void> {
  await boundedFetch(GOOGLE_REVOKE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  })
}

Deno.serve(async (req) => {
  // A safe error redirect needs a validated origin; until the state is resolved we
  // can only trust the canonical production origin.
  let safeErrorRedirect = CANONICAL_ERROR_REDIRECT

  try {
    const url = new URL(req.url)
    const code        = url.searchParams.get('code')
    const state       = url.searchParams.get('state')
    const googleError = url.searchParams.get('error')  // e.g. access_denied

    // With no state we can never trust a browser-supplied origin.
    if (!state) {
      console.error('google-oauth-callback missing_state')
      return redirect(safeErrorRedirect)
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // ── Atomically consume the one-time state ───────────────────────────────
    // A single conditional UPDATE marks it consumed only if not already consumed
    // and not expired; RETURNING the row proves this caller won the race. This
    // runs even on error/denial so we can redirect to the ORIGINATING origin.
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
      console.error('google-oauth-callback invalid_state')
      return redirect(safeErrorRedirect)  // canonical — no trusted origin
    }

    // We now have a validated origin for all subsequent redirects.
    const validatedOrigin = resolveReturnOrigin(stateRow.return_origin)
    safeErrorRedirect = validatedOrigin
      ? buildSettingsRedirect(validatedOrigin, 'error')
      : CANONICAL_ERROR_REDIRECT

    // Google returned an error (e.g. access_denied) or no code → error to origin.
    if (googleError || !code) {
      console.error('google-oauth-callback provider_error_or_no_code')
      return redirect(safeErrorRedirect)
    }

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
    const accessToken = tokenData.access_token as string | undefined
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
      // Best-effort revoke the token we cannot verify.
      try { await revokeToken(accessToken) } catch { /* best-effort */ }
      return redirect(safeErrorRedirect)
    }
    const identity = await userinfoRes.json()

    // ── Load the user's existing connection + tokens (for same-account logic
    //    and old-account revocation) BEFORE any write ────────────────────────
    const { data: existingConnection } = await admin
      .from('google_connections')
      .select('id, google_sub')
      .eq('user_id', stateRow.user_id)
      .maybeSingle()
    let existingRefreshRow: Record<string, string | null> | null = null
    if (existingConnection) {
      const { data } = await admin
        .from('google_tokens')
        .select('refresh_token_ciphertext, refresh_token_nonce, access_token_ciphertext, access_token_nonce')
        .eq('connection_id', existingConnection.id)
        .maybeSingle()
      existingRefreshRow = data ?? null
    }

    // ── Delegate the decision + ATOMIC persistence ──────────────────────────
    const result = await finalizeGoogleConnection({
      exchange: {
        accessToken,
        refreshToken: tokenData.refresh_token ?? null,
        expiresIn:    tokenData.expires_in ?? null,
        scope:        tokenData.scope ?? '',
      },
      identity,
      userId: stateRow.user_id,
      existingConnection: existingConnection ?? null,
      existingRefreshRow,
      encryptAccess:  (t: string) => encryptToken(t, key),
      encryptRefresh: (t: string) => encryptToken(t, key),
      // Atomic single-RPC persistence; throws on DB error so finalize compensates.
      store: async (args: Record<string, unknown>) => {
        const { data, error } = await admin.rpc('store_google_connection', args)
        if (error) throw new Error('store_failed')
        return data as string
      },
      revoke: revokeToken,
      // Old account's revocable token (used only when the account changed).
      resolveOldToken: async () => {
        if (!existingRefreshRow) return null
        if (existingRefreshRow.refresh_token_ciphertext && existingRefreshRow.refresh_token_nonce) {
          return decryptToken(existingRefreshRow.refresh_token_ciphertext, existingRefreshRow.refresh_token_nonce, key)
        }
        if (existingRefreshRow.access_token_ciphertext && existingRefreshRow.access_token_nonce) {
          return decryptToken(existingRefreshRow.access_token_ciphertext, existingRefreshRow.access_token_nonce, key)
        }
        return null
      },
    })

    if (!result.ok) {
      console.error('google-oauth-callback finalize_rejected', result.reason)
      return redirect(safeErrorRedirect)
    }

    return redirect(
      validatedOrigin ? buildSettingsRedirect(validatedOrigin, 'connected') : CANONICAL_ERROR_REDIRECT,
    )
  } catch {
    console.error('google-oauth-callback internal_error')
    return redirect(safeErrorRedirect)
  }
})
