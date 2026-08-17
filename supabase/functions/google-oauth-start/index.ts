// google-oauth-start — begins a Google Calendar connection for the authenticated
// Funnl user. JWT-authenticated. Generates CSRF state + PKCE, persists only the
// state HASH and the ENCRYPTED PKCE verifier, and returns the Google authorization
// URL to the browser. No token is ever handled here.
//
// Phase 0A: Calendar read-only scope only. No Gmail scope, no Calendar API call.
//
// Server config (Edge secrets — never VITE_*, never returned to the browser):
//   GOOGLE_CLIENT_ID
//   GOOGLE_OAUTH_CALLBACK_URL          (the public callback function URL)
//   GOOGLE_TOKEN_ENCRYPTION_KEY_V1     (base64 32-byte AES-256-GCM key)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { importKeyFromBase64, encryptToken } from '../shared/googleTokenCrypto.js'
import {
  resolveReturnOrigin,
  generateRandomToken,
  sha256Hex,
  pkceChallengeFromVerifier,
  buildGoogleAuthUrl,
  staleOauthStateCutoffIso,
  isValidConfiguredCallbackUrl,
} from '../shared/googleOauthHelpers.js'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Security headers: never cache an OAuth start response (it mints CSRF state),
// never leak the URL via Referer, and no MIME sniffing. CORS is preserved.
const securityHeaders = {
  'Cache-Control':          'no-store',
  'Pragma':                 'no-cache',
  'Referrer-Policy':        'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes
// Any OAuth state row older than this is well past its 10-minute TTL and unusable
// (whether consumed or expired). Cleaned up best-effort when a new flow starts.
const STATE_CLEANUP_RETENTION_MS = 24 * 60 * 60 * 1000 // 24 hours

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, ...securityHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  try {
    // ── Authenticate the caller ─────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'unauthorized' }, 401)

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    )
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) return json({ error: 'unauthorized' }, 401)

    // ── Validate the return origin against the allowlist ────────────────────
    let requestedOrigin: unknown
    try {
      const body = await req.json()
      requestedOrigin = body?.returnOrigin
    } catch {
      requestedOrigin = undefined
    }
    const returnOrigin = resolveReturnOrigin(requestedOrigin)
    if (!returnOrigin) return json({ error: 'invalid_return_origin' }, 400)

    // ── Server config ───────────────────────────────────────────────────────
    // GOOGLE_OAUTH_CALLBACK_URL must equal the BRANDED www callback exactly (the
    // URL registered in Google Cloud). Fail closed otherwise. The direct Supabase
    // Functions URL is ONLY the internal Vercel rewrite destination — it must NOT
    // be registered with Google or set here. Never log the rejected value.
    const clientId    = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
    const callbackUrl = Deno.env.get('GOOGLE_OAUTH_CALLBACK_URL') ?? ''
    const keyB64      = Deno.env.get('GOOGLE_TOKEN_ENCRYPTION_KEY_V1') ?? ''
    if (!clientId || !keyB64 || !isValidConfiguredCallbackUrl(callbackUrl)) {
      console.error('google-oauth-start config_invalid')
      return json({ error: 'config_missing' }, 503)
    }

    // ── Generate CSRF state + PKCE ──────────────────────────────────────────
    const state         = generateRandomToken(32)            // returned to Google
    const stateHash     = await sha256Hex(state)             // only the hash is stored
    const codeVerifier  = generateRandomToken(32)            // PKCE verifier (kept secret)
    const codeChallenge = await pkceChallengeFromVerifier(codeVerifier)

    // Encrypt the PKCE verifier before storing it.
    const key = await importKeyFromBase64(keyB64)
    const encVerifier = await encryptToken(codeVerifier, key)

    // ── Persist the one-time state (service role) ───────────────────────────
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // Bounded best-effort cleanup of old OAuth state rows (no scheduler). Deletes
    // only rows created before the retention cutoff — safely past their 10-minute
    // TTL, whether consumed or expired. A failure here must NOT weaken or block the
    // new OAuth request, so it is fully swallowed.
    try {
      const cutoff = staleOauthStateCutoffIso(Date.now(), STATE_CLEANUP_RETENTION_MS)
      await admin.from('google_oauth_states').delete().lt('created_at', cutoff)
    } catch {
      console.error('google-oauth-start state_cleanup_skipped')
    }

    const { error: insertError } = await admin.from('google_oauth_states').insert({
      state_hash:               stateHash,
      user_id:                  user.id,
      pkce_verifier_ciphertext: encVerifier.ciphertext,
      pkce_verifier_nonce:      encVerifier.nonce,
      key_version:              1,
      return_origin:            returnOrigin,
      integration_type:         'calendar',
      expires_at:               new Date(Date.now() + STATE_TTL_MS).toISOString(),
    })
    if (insertError) {
      console.error('google-oauth-start state_persist_failed', insertError.code ?? 'db_error')
      return json({ error: 'internal_error' }, 500)
    }

    // ── Build the authorization URL (Calendar read-only only) ───────────────
    const url = buildGoogleAuthUrl({
      clientId,
      redirectUri:   callbackUrl,
      state,
      codeChallenge,
    })

    return json({ url }, 200)
  } catch {
    console.error('google-oauth-start internal_error')
    return json({ error: 'internal_error' }, 500)
  }
})
