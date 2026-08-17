// google-oauth-disconnect — JWT-authenticated. Best-effort revokes the user's
// Google authorization, then ALWAYS deletes all local Google state (tokens,
// oauth states, connection) for that user via the shared runGoogleLocalCleanup
// helper. A failure to reach Google must never block local deletion. Only
// controlled status/error codes are logged.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { importKeyFromBase64, decryptToken } from '../shared/googleTokenCrypto.js'
import { GOOGLE_REVOKE_ENDPOINT } from '../shared/googleOauthHelpers.js'
import { runGoogleLocalCleanup } from '../shared/googleCleanup.js'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const GOOGLE_FETCH_TIMEOUT_MS = 10_000

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// Decrypts a revocable token (prefer refresh, fall back to access) from a tokens row.
async function makeResolveToken() {
  const keyB64 = Deno.env.get('GOOGLE_TOKEN_ENCRYPTION_KEY_V1') ?? ''
  const key = keyB64 ? await importKeyFromBase64(keyB64) : null
  return async (tokens: Record<string, string | null>) => {
    if (!key || !tokens) return null
    if (tokens.refresh_token_ciphertext && tokens.refresh_token_nonce) {
      return decryptToken(tokens.refresh_token_ciphertext, tokens.refresh_token_nonce, key)
    }
    if (tokens.access_token_ciphertext && tokens.access_token_nonce) {
      return decryptToken(tokens.access_token_ciphertext, tokens.access_token_nonce, key)
    }
    return null
  }
}

// Best-effort Google token revocation with a bounded timeout. Never throws.
async function revoke(token: string): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), GOOGLE_FETCH_TIMEOUT_MS)
  try {
    await fetch(GOOGLE_REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'unauthorized' }, 401)

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    )
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) return json({ error: 'unauthorized' }, 401)

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const resolveToken = await makeResolveToken()
    const { oauthStateDeleteError, connectionDeleteError } = await runGoogleLocalCleanup({
      admin,
      userId: user.id,
      resolveToken,
      revoke,
    })

    // Success only when BOTH local deletions succeeded. Remote revocation is
    // best-effort and never affects this result. A local failure → controlled 500
    // so the user can retry; no raw database details are returned.
    if (oauthStateDeleteError || connectionDeleteError) {
      console.error('google-oauth-disconnect local_delete_failed')
      return json({ error: 'internal_error' }, 500)
    }
    return json({ success: true }, 200)
  } catch {
    console.error('google-oauth-disconnect internal_error')
    return json({ error: 'internal_error' }, 500)
  }
})
