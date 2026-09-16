// gmail-oauth-start — begins an EXPLICIT Gmail connection for the authenticated Funnl user.
//
// This is a SEPARATE function from google-oauth-start, which is left byte-untouched so the
// Calendar-only authorization flow cannot regress. `gmail.readonly` is requested ONLY here,
// only on a deliberate user action, and never added to GOOGLE_OAUTH_SCOPES.
//
// DORMANT BY DEFAULT: the function fails closed with 503 unless the server-side
// GMAIL_INTEGRATION_ENABLED secret is exactly 'true'. That env var is NOT created by this
// phase, so even a direct call to this endpoint cannot start a real Gmail consent until a
// human explicitly enables it after Privacy-Policy + Google verification clear.
//
// SECURITY:
//   - POST only; verify_jwt = true (see config.toml); we ALSO call auth.getUser().
//   - The user is derived exclusively from the verified JWT. No caller-supplied target
//     user, Google account, scope, or integration type.
//   - Only the state HASH and the ENCRYPTED PKCE verifier are persisted.
//   - Nothing is logged but controlled codes: never a token, code, state, sub, or address.
//
// Server config (Edge secrets — never VITE_*, never returned):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//   GOOGLE_CLIENT_ID, GOOGLE_OAUTH_CALLBACK_URL, GOOGLE_TOKEN_ENCRYPTION_KEY_V1,
//   GMAIL_INTEGRATION_ENABLED ('true' to permit a Gmail consent at all)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { importKeyFromBase64, encryptToken } from '../shared/googleTokenCrypto.js'
import {
  resolveReturnOrigin,
  generateRandomToken,
  sha256Hex,
  pkceChallengeFromVerifier,
  staleOauthStateCutoffIso,
  isValidConfiguredCallbackUrl,
} from '../shared/googleOauthHelpers.js'
import { buildGmailAuthUrl, GMAIL_INTEGRATION_TYPE } from '../shared/gmailOauth.js'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const securityHeaders = {
  'Cache-Control': 'no-store',
  'Pragma': 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

const STATE_TTL_MS = 10 * 60 * 1000                    // 10 minutes, single-use
const STATE_CLEANUP_RETENTION_MS = 24 * 60 * 60 * 1000 // best-effort sweep of dead rows

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
    // ── Hard dormancy gate: Gmail consent is impossible unless explicitly enabled ──
    if ((Deno.env.get('GMAIL_INTEGRATION_ENABLED') ?? '') !== 'true') {
      return json({ error: 'gmail_not_enabled' }, 503)
    }

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

    // ── Validate the return origin against the shared allowlist ─────────────
    let requestedOrigin: unknown
    try {
      const body = await req.json()
      requestedOrigin = body?.returnOrigin
    } catch { requestedOrigin = undefined }
    const returnOrigin = resolveReturnOrigin(requestedOrigin)
    if (!returnOrigin) return json({ error: 'invalid_return_origin' }, 400)

    // ── Server config — fail closed ─────────────────────────────────────────
    const clientId = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
    const callbackUrl = Deno.env.get('GOOGLE_OAUTH_CALLBACK_URL') ?? ''
    const keyB64 = Deno.env.get('GOOGLE_TOKEN_ENCRYPTION_KEY_V1') ?? ''
    if (!clientId || !keyB64 || !isValidConfiguredCallbackUrl(callbackUrl)) {
      console.error('gmail-oauth-start config_invalid')
      return json({ error: 'config_missing' }, 503)
    }

    // ── CSRF state + PKCE (single-use, expiring) ────────────────────────────
    const state = generateRandomToken(32)
    const stateHash = await sha256Hex(state)
    const codeVerifier = generateRandomToken(32)
    const codeChallenge = await pkceChallengeFromVerifier(codeVerifier)

    const key = await importKeyFromBase64(keyB64)
    const encVerifier = await encryptToken(codeVerifier, key)

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    try {
      const cutoff = staleOauthStateCutoffIso(Date.now(), STATE_CLEANUP_RETENTION_MS)
      await admin.from('google_oauth_states').delete().lt('created_at', cutoff)
    } catch { console.error('gmail-oauth-start state_cleanup_skipped') }

    const { error: insertError } = await admin.from('google_oauth_states').insert({
      state_hash:               stateHash,
      user_id:                  user.id,
      pkce_verifier_ciphertext: encVerifier.ciphertext,
      pkce_verifier_nonce:      encVerifier.nonce,
      key_version:              1,
      return_origin:            returnOrigin,
      // The E2A migration widened google_oauth_states_integration_check to admit 'gmail';
      // the shared callback branches on this value.
      integration_type:         GMAIL_INTEGRATION_TYPE,
      expires_at:               new Date(Date.now() + STATE_TTL_MS).toISOString(),
    })
    if (insertError) {
      console.error('gmail-oauth-start state_persist_failed', insertError.code ?? 'db_error')
      return json({ error: 'internal_error' }, 500)
    }

    // ── Gmail consent URL (incremental: preserves an existing Calendar grant) ──
    const url = buildGmailAuthUrl({ clientId, redirectUri: callbackUrl, state, codeChallenge })
    return json({ url }, 200)
  } catch {
    console.error('gmail-oauth-start internal_error')
    return json({ error: 'internal_error' }, 500)
  }
})
