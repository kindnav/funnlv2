import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { importKeyFromBase64, decryptToken } from '../shared/googleTokenCrypto.js'
import { GOOGLE_REVOKE_ENDPOINT } from '../shared/googleOauthHelpers.js'
import { runGoogleLocalCleanup } from '../shared/googleCleanup.js'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const GOOGLE_FETCH_TIMEOUT_MS = 10_000

// NOTE: cleanupGoogle is declared AFTER the handler (hoisted) so that, in source
// order, the Authorization check precedes any reference to the admin client.

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Not authenticated' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Verify the caller's JWT
    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Not authenticated' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Admin client for deletion operations
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // Best-effort revoke + delete of local Google state. Never blocks deletion.
    await cleanupGoogle(admin, user.id)

    // Delete contacts first — cascades to interactions via ON DELETE CASCADE
    const { error: contactsErr } = await admin
      .from('contacts')
      .delete()
      .eq('user_id', user.id)
    if (contactsErr) throw new Error('Failed to delete contacts: ' + contactsErr.message)

    // Delete the auth user — cascades to profiles via ON DELETE CASCADE
    const { error: deleteErr } = await admin.auth.admin.deleteUser(user.id)
    if (deleteErr) throw new Error('Failed to delete account: ' + deleteErr.message)

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

// Best-effort: revoke the user's Google authorization and delete local Google rows
// BEFORE account deletion, via the shared runGoogleLocalCleanup helper. Every step
// is best-effort — a Google network failure can never block Funnl account deletion,
// and the auth-user deletion later also cascades any remaining Google rows (safe +
// idempotent). Never logs Google identity, email, or token data.
async function cleanupGoogle(adminClient, userId) {
  try {
    const keyB64 = Deno.env.get('GOOGLE_TOKEN_ENCRYPTION_KEY_V1') ?? ''
    const key = keyB64 ? await importKeyFromBase64(keyB64) : null
    const resolveToken = async (tokens) => {
      if (!key || !tokens) return null
      if (tokens.refresh_token_ciphertext && tokens.refresh_token_nonce) {
        return decryptToken(tokens.refresh_token_ciphertext, tokens.refresh_token_nonce, key)
      }
      if (tokens.access_token_ciphertext && tokens.access_token_nonce) {
        return decryptToken(tokens.access_token_ciphertext, tokens.access_token_nonce, key)
      }
      return null
    }
    const revoke = async (token) => {
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
    await runGoogleLocalCleanup({ admin: adminClient, userId, resolveToken, revoke })
  } catch {
    // Never block account deletion on Google cleanup failure.
    console.error('delete-account google_cleanup_skipped')
  }
}
