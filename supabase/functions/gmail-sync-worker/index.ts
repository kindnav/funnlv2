// gmail-sync-worker — PRIVATE bounded Gmail synchronization worker.
//
// NOT user-callable. verify_jwt = false (see config.toml): platform JWT verification is
// intentionally disabled for this private worker endpoint because user JWTs grant no
// authority. The endpoint instead requires a separate high-entropy worker secret, compares
// it in constant time, exposes no CORS path, and calls only service-role RPCs. `anon` and
// `authenticated` therefore cannot invoke a run, and there is no code path that sweeps all
// users — each invocation processes EXACTLY ONE atomically reserved connection
// (reserve_due_gmail_connection has a single-row LIMIT).
//
// DORMANT BY DEFAULT: without GMAIL_WORKER_SECRET (>= 32 chars) the endpoint answers 503
// worker_not_configured. That secret is NOT created by this phase, and no scheduler/Cron
// invokes this function, so no Gmail request can occur until a human configures it after
// Privacy-Policy + Google restricted-scope verification clear.
//
// All orchestration lives in the pure, unit-tested ../shared/gmailWorker.js. This file only
// builds real dependencies and maps the controlled result to a Response. Logs carry
// aggregate counts and controlled codes only — never a token, address, subject, message or
// thread id, cursor, fingerprint, or raw provider payload.
//
// Server config (Edge secrets — never VITE_*, never returned):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_TOKEN_ENCRYPTION_KEY_V1,
//   GMAIL_WORKER_SECRET, GMAIL_INTEGRATION_ENABLED ('true' to permit a run at all)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { importKeyFromBase64, encryptToken, decryptToken } from '../shared/googleTokenCrypto.js'
import { GOOGLE_TOKEN_ENDPOINT, readBoundedStream } from '../shared/googleOauthHelpers.js'
import { authorizeWorkerRequest } from '../shared/workerAuth.js'
import { runGmailSync, CAPS } from '../shared/gmailWorker.js'
import { computeFingerprintSet } from '../shared/emailFingerprint.js'
import { classifyEmailMessages } from '../shared/emailConversationClassifier.js'
import { grantedScopesIncludeGmailReadonly } from '../shared/gmailOauth.js'
// Provider-neutral Google token helpers, reused (not reimplemented) so refresh-preservation
// and near-expiry semantics match the Calendar path exactly.
import { shouldRefreshToken, validateRefreshResponse } from '../shared/calendarSyncEngine.js'

const TOKEN_MAX_BODY_BYTES = 16_384
const TOKEN_FETCH_TIMEOUT_MS = 15_000

type GmailConn = {
  connectionId: string
  userId: string
  gmailAddress: string | null
  googleSub: string
  tokenExpiresAt: string | null
  tokenRow: Record<string, string | null>
}

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Pragma': 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...securityHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  // ── Authorize: worker secret only, constant-time, POST only ────────────────
  const auth = authorizeWorkerRequest({
    method: req.method,
    authorization: req.headers.get('authorization'),
    configuredSecret: Deno.env.get('GMAIL_WORKER_SECRET') ?? null,
  })
  if (!auth.ok) return json({ error: auth.code }, auth.status)

  // ── Operational kill switch (checked only AFTER the secret, so it is not probeable) ──
  // The same server-side switch that gates gmail-oauth-start. Unsetting it pauses every
  // Gmail run immediately without rotating or deleting the worker secret.
  if ((Deno.env.get('GMAIL_INTEGRATION_ENABLED') ?? '') !== 'true') {
    return json({ error: 'gmail_not_enabled' }, 503)
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const clientId = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
    const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''
    const keyB64 = Deno.env.get('GOOGLE_TOKEN_ENCRYPTION_KEY_V1') ?? ''
    const fpKeyB64 = Deno.env.get('EMAIL_FINGERPRINT_KEY_V1') ?? ''
    if (!supabaseUrl || !serviceKey || !clientId || !clientSecret || !keyB64 || !fpKeyB64) {
      console.error('gmail-sync-worker config_missing')
      return json({ error: 'config_missing' }, 503)
    }

    const admin = createClient(supabaseUrl, serviceKey)
    let cryptoKey: CryptoKey
    let fpKeyBytes: Uint8Array
    try {
      cryptoKey = await importKeyFromBase64(keyB64)
      fpKeyBytes = Uint8Array.from(atob(fpKeyB64), (c) => c.charCodeAt(0))
    } catch {
      console.error('gmail-sync-worker key_invalid')
      return json({ error: 'config_missing' }, 503)
    }

    const rpc = async (name: string, params: Record<string, unknown>) => {
      const { data, error } = await admin.rpc(name, params)
      if (error) throw new Error(`rpc_${name}_failed`)
      return data
    }

    const result = await runGmailSync({
      caps: CAPS,
      now: () => Date.now(),
      fetchImpl: fetch,

      reserve: async ({ leaseSeconds, dueAfterSeconds }) =>
        await rpc('reserve_due_gmail_connection', {
          p_lease_seconds: leaseSeconds, p_due_after_seconds: dueAfterSeconds,
        }) as Record<string, unknown>,

      loadConnection: async (connectionId: string) => {
        const { data, error } = await admin
          .from('google_connections')
          .select('id, user_id, google_sub, google_email, status, token_expires_at')
          .eq('id', connectionId)
          .maybeSingle()
        if (error || !data) return null
        if (data.status !== 'active') return null
        const { data: tokenRow, error: tokErr } = await admin
          .from('google_tokens')
          .select('access_token_ciphertext, access_token_nonce, refresh_token_ciphertext, refresh_token_nonce')
          .eq('connection_id', data.id)
          .maybeSingle()
        if (tokErr || !tokenRow) return null
        // The owned mailbox identity is the VERIFIED connected Google address only — no
        // alias inference, no dot/plus normalization (E1 does trim+lowercase only).
        return {
          connectionId:   data.id,
          userId:         data.user_id,
          gmailAddress:   data.google_email,
          googleSub:      data.google_sub,
          tokenExpiresAt: data.token_expires_at,
          tokenRow,
        }
      },

      loadContacts: async (userId: string) => {
        const { data, error } = await admin.from('contacts').select('id, user_id, email').eq('user_id', userId)
        if (error) throw new Error('contacts_lookup_failed')
        return data ?? []
      },

      // Reuse the stored access token while it is still comfortably valid; otherwise
      // exchange the encrypted refresh token. The already-proven Google token helpers
      // (shouldRefreshToken, validateRefreshResponse, store_refreshed_google_token) are
      // reused verbatim rather than reimplemented, so the refresh-preservation and
      // account-guard semantics are identical to Calendar's.
      resolveAccessToken: async (conn: GmailConn) => {
        const tr = conn.tokenRow
        if (!shouldRefreshToken(conn.tokenExpiresAt, Date.now())) {
          if (tr.access_token_ciphertext && tr.access_token_nonce) {
            try {
              return { ok: true, accessToken: await decryptToken(tr.access_token_ciphertext, tr.access_token_nonce, cryptoKey) }
            } catch { /* fall through to a refresh */ }
          }
        }
        if (!tr.refresh_token_ciphertext || !tr.refresh_token_nonce) {
          return { ok: false, reason: 'invalid_grant' }
        }
        let refresh: string
        try {
          refresh = await decryptToken(tr.refresh_token_ciphertext, tr.refresh_token_nonce, cryptoKey)
        } catch { return { ok: false, reason: 'invalid_grant' } }

        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), TOKEN_FETCH_TIMEOUT_MS)
        let res: Response
        try {
          res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: clientId, client_secret: clientSecret,
              refresh_token: refresh, grant_type: 'refresh_token',
            }).toString(),
            signal: ctrl.signal,
          })
        } catch { return { ok: false, reason: 'provider_error' } } finally { clearTimeout(timer) }

        // Bounded streaming read with a small hard cap — never .json()/.text().
        const bounded = await readBoundedStream(res.body, {
          maxBytes: TOKEN_MAX_BODY_BYTES,
          contentLength: res.headers.get('content-length'),
        })
        if (!bounded.ok) return { ok: false, reason: 'provider_error' }
        let parsed: Record<string, unknown> | null = null
        try { parsed = JSON.parse(bounded.text) } catch { parsed = null }

        if (res.status === 400 || res.status === 401) {
          // Google reports a dead/revoked refresh credential here. invalid_grant is
          // connection-wide; anything else is treated as a transient provider error so a
          // working Calendar connection is never disabled on an ambiguous signal.
          return { ok: false, reason: parsed?.error === 'invalid_grant' ? 'invalid_grant' : 'provider_error' }
        }
        if (res.status !== 200) return { ok: false, reason: 'provider_error' }

        const v = validateRefreshResponse(parsed)
        if (!v.ok) return { ok: false, reason: 'provider_error' }

        // Google echoes the CURRENT granted scopes on refresh. A mailbox grant the user
        // removed in their Google account therefore surfaces here: Gmail alone goes to
        // needs_reauth; the shared credential and the Calendar capability are untouched.
        const echoed = typeof parsed?.scope === 'string' ? parsed.scope : null
        if (echoed !== null && !grantedScopesIncludeGmailReadonly(echoed)) {
          return { ok: false, reason: 'scope_revoked' }
        }

        try {
          const encAccess = await encryptToken(v.accessToken, cryptoKey)
          const encRefresh = v.refreshToken ? await encryptToken(v.refreshToken, cryptoKey) : null
          await rpc('store_refreshed_google_token', {
            p_connection_id:       conn.connectionId,
            p_expected_google_sub: conn.googleSub,
            p_access_ct:           encAccess.ciphertext,
            p_access_nonce:        encAccess.nonce,
            // null → the RPC PRESERVES both existing refresh values (never half-writes).
            p_refresh_ct:          encRefresh ? encRefresh.ciphertext : null,
            p_refresh_nonce:       encRefresh ? encRefresh.nonce : null,
            p_key_version:         1,
            p_token_expires_at:    new Date(Date.now() + v.expiresIn * 1000).toISOString(),
          })
        } catch { return { ok: false, reason: 'provider_error' } }

        return { ok: true, accessToken: v.accessToken }
      },

      classify: classifyEmailMessages,

      computeFingerprintSet: async (fields: Record<string, unknown>) =>
        await computeFingerprintSet(fields, {
          current: { keyBytes: fpKeyBytes, keyVersion: 1 },
        }),

      upsertCandidate: async (a) => await rpc('upsert_email_candidate', {
        p_connection_id: a.connectionId, p_run_id: a.runId, p_contact_id: a.contactId,
        p_source: a.source, p_fingerprint: a.fingerprint, p_key_version: a.keyVersion,
        p_proposed_type: a.proposedType, p_proposed_date: a.proposedDate,
        p_retained_subject: a.retainedSubject, p_proposed_notes: a.proposedNotes,
        p_lookup_fingerprints: a.lookupFingerprints ?? null,
      }) as Record<string, unknown>,

      invalidateFingerprints: async (a) => await rpc('invalidate_email_candidates_by_fingerprint', {
        p_connection_id: a.connectionId, p_run_id: a.runId, p_fingerprints: a.fingerprints,
      }) as Record<string, unknown>,

      renew: async (a) => await rpc('renew_gmail_sync_lease', {
        p_connection_id: a.connectionId, p_run_id: a.runId, p_lease_seconds: a.leaseSeconds,
      }),

      release: async (a) => await rpc('release_gmail_sync_lease', {
        p_connection_id: a.connectionId, p_run_id: a.runId,
        p_status: a.status, p_error_code: a.errorCode,
        p_run_complete: a.runComplete, p_history_id: a.historyId,
        p_initial_done: a.initialDone, p_retry_backoff_seconds: a.backoffSeconds,
      }),

      upsertCapability: async (a) => await rpc('upsert_google_capability', {
        p_connection_id: a.connectionId, p_user_id: a.userId, p_product: a.product,
        p_status: a.status, p_granted: a.granted, p_needs_reauth: a.needsReauth,
        p_result_code: a.resultCode,
      }) as Record<string, unknown>,

      // Aggregate counts + controlled codes only. No provider content is ever logged.
      log: (obj: Record<string, unknown>) => { try { console.log(JSON.stringify(obj)) } catch { /* */ } },
    })

    return json(result, 200)
  } catch {
    console.error('gmail-sync-worker internal_error')
    return json({ error: 'internal_error' }, 500)
  }
})
