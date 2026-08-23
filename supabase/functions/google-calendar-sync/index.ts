// google-calendar-sync — Phase C1 manual Calendar sync engine (JWT-authenticated).
//
// Reads the authenticated user's COMPLETED primary-calendar events from the last
// 90 days and writes review candidates via the Phase A service-role RPCs. It is a
// thin Deno shell: all orchestration lives in the pure, unit-tested
// ../shared/calendarSyncEngine.js (runCalendarSync). This file only builds real
// dependencies (Supabase clients, fetch, Web Crypto, env) and maps the result to a
// Response.
//
// SECURITY:
//   - POST only; verify_jwt=true (see config.toml); we ALSO call auth.getUser().
//   - The user is derived exclusively from the verified JWT. No caller-supplied
//     target user, Google account, calendar, window, page token, or query option.
//   - The service-role client is used only inside this function and never returned.
//   - Google tokens/ciphertext/nonces/secrets and event/contact identifiers are
//     never returned or logged. Responses/logs carry aggregate counts + controlled
//     codes only.
//   - Read-only Calendar scope only. No Gmail. No Calendar write. No scheduler.
//
// Server config (Edge secrets — never VITE_*, never returned):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_TOKEN_ENCRYPTION_KEY_V1

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { importKeyFromBase64, encryptToken, decryptToken } from '../shared/googleTokenCrypto.js'
import { GOOGLE_TOKEN_ENDPOINT, readBoundedStream } from '../shared/googleOauthHelpers.js'
import {
  runCalendarSync,
  CALENDAR_ID,
  LEASE_SECONDS,
  MAX_PAGE_BYTES,
} from '../shared/calendarSyncEngine.js'

// Small hard cap for token-endpoint responses (Google's are ~1 KB).
const TOKEN_MAX_BODY_BYTES = 16_384

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
const GOOGLE_FETCH_TIMEOUT_MS = 15_000

function json(body: unknown, status: number): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, ...securityHeaders, 'Content-Type': 'application/json' },
  })
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  // Early method gate: reject non-POST before any privileged setup.
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  try {
  // Server config — fail closed if any secret is missing.
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''
  const keyB64 = Deno.env.get('GOOGLE_TOKEN_ENCRYPTION_KEY_V1') ?? ''
  if (!supabaseUrl || !anonKey || !serviceKey || !clientId || !clientSecret || !keyB64) {
    console.error('google-calendar-sync config_missing')
    return json({ error: 'config_missing' }, 503)
  }

  const authHeader = req.headers.get('Authorization') ?? ''
  const admin = createClient(supabaseUrl, serviceKey)

  let cryptoKey: CryptoKey
  try {
    cryptoKey = await importKeyFromBase64(keyB64)
  } catch {
    console.error('google-calendar-sync key_invalid')
    return json({ error: 'config_missing' }, 503)
  }

  // RPC wrapper: throw on error so the engine's control flow handles it.
  async function rpc(name: string, params: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await admin.rpc(name, params)
    if (error) throw new Error(`rpc_${name}_failed`)
    return data
  }

  const deps = {
    method: req.method,
    now: () => new Date(),
    subtle: globalThis.crypto.subtle,
    log: (obj: Record<string, unknown>) => { try { console.log(JSON.stringify(obj)) } catch { /* */ } },

    async getUser() {
      if (!authHeader) return null
      const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
      const { data: { user }, error } = await userClient.auth.getUser()
      if (error || !user) return null
      return { userId: user.id }
    },

    async loadConnection(userId: string) {
      const { data: connection, error: connErr } = await admin
        .from('google_connections')
        .select('id, google_sub, google_email, status, token_expires_at')
        .eq('user_id', userId)
        .maybeSingle()
      if (connErr) throw new Error('connection_lookup_failed')
      if (!connection) return null
      const { data: tokenRow, error: tokErr } = await admin
        .from('google_tokens')
        .select('access_token_ciphertext, access_token_nonce, refresh_token_ciphertext, refresh_token_nonce')
        .eq('connection_id', connection.id)
        .maybeSingle()
      if (tokErr) throw new Error('token_lookup_failed')
      if (!tokenRow) return null // connection without tokens → treat as not connected
      return { connection, tokenRow }
    },

    async loadContacts(userId: string) {
      // Minimum needed for exact email matching: id + email only.
      const { data, error } = await admin
        .from('contacts')
        .select('id, email')
        .eq('user_id', userId)
      if (error) throw new Error('contacts_lookup_failed')
      return data ?? []
    },

    async decrypt(ct: string, nonce: string) {
      return await decryptToken(ct, nonce, cryptoKey)
    },
    async encrypt(plaintext: string) {
      return await encryptToken(plaintext, cryptoKey)
    },

    async refreshAccessToken(refreshPlaintext: string) {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshPlaintext,
        grant_type: 'refresh_token',
      })
      const res = await boundedFetch(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
      // Bounded, incremental read (small hard cap) — never buffer an unbounded token body.
      const read = await readBoundedStream(res.body, {
        maxBytes: TOKEN_MAX_BODY_BYTES,
        contentLength: res.headers.get('content-length'),
      })
      let parsed: unknown = null
      if (read.ok) { try { parsed = JSON.parse(read.text) } catch { parsed = null } }
      return { status: res.status, json: parsed }
    },

    async fetchEventsPage({ accessToken, url }: { accessToken: string; url: string }) {
      const res = await boundedFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } })
      if (res.status !== 200) { try { await res.body?.cancel() } catch { /* */ }; return { status: res.status, json: null } }
      // Bounded, incremental streaming read: honors Content-Length pre-check, counts
      // actual bytes, cancels the stream on cap, fails closed on stream/UTF-8 errors.
      // Never uses res.text()/res.json() (which would buffer an unbounded body).
      const read = await readBoundedStream(res.body, {
        maxBytes: MAX_PAGE_BYTES,
        contentLength: res.headers.get('content-length'),
      })
      if (!read.ok) return { status: 200, json: null }   // too-large / stream error / invalid UTF-8 → malformed
      let parsed: unknown = null
      try { parsed = JSON.parse(read.text) } catch { parsed = null }
      return { status: 200, json: parsed, bytes: read.text.length }
    },

    rpc: {
      claimLease: (connId: string) =>
        rpc('claim_calendar_sync_lease', { p_connection_id: connId, p_calendar_id: CALENDAR_ID, p_lease_seconds: LEASE_SECONDS }),
      renewLease: (connId: string, runId: string) =>
        rpc('renew_calendar_sync_lease', { p_connection_id: connId, p_calendar_id: CALENDAR_ID, p_run_id: runId, p_lease_seconds: LEASE_SECONDS }),
      releaseLease: (connId: string, runId: string, status: string, errorCode: string | null, complete: boolean) =>
        rpc('release_calendar_sync_lease', { p_connection_id: connId, p_calendar_id: CALENDAR_ID, p_run_id: runId, p_status: status, p_error_code: errorCode, p_run_complete: complete }),
      upsertCandidate: (args: Record<string, unknown>) => rpc('upsert_calendar_candidate', args),
      reconcileOccurrence: (args: Record<string, unknown>) => rpc('reconcile_calendar_occurrence', args),
      storeRefreshedToken: (a: {
        connectionId: string; expectedGoogleSub: string; accessCt: string; accessNonce: string;
        refreshCt: string | null; refreshNonce: string | null; keyVersion: number; tokenExpiresAt: string;
      }) => rpc('store_refreshed_google_token', {
        p_connection_id: a.connectionId, p_expected_google_sub: a.expectedGoogleSub,
        p_access_ct: a.accessCt, p_access_nonce: a.accessNonce,
        p_refresh_ct: a.refreshCt, p_refresh_nonce: a.refreshNonce,
        p_key_version: a.keyVersion, p_token_expires_at: a.tokenExpiresAt,
      }),
      markNeedsReauth: (connId: string, sub: string) =>
        rpc('mark_google_needs_reauth', { p_connection_id: connId, p_expected_google_sub: sub }),
    },
  }

  const { status, body } = await runCalendarSync(deps)
  return json(body, status)
  } catch {
    // Any uncontrolled failure (config/client/key setup or unexpected throw) → a single
    // controlled 500. No stack trace or raw error ever reaches the response.
    console.error('google-calendar-sync internal_error')
    return json({ error: 'internal_error' }, 500)
  }
})
