// Shared best-effort Google cleanup used by both google-oauth-disconnect and
// delete-account. Zero imports — the Supabase admin client, token resolution, and
// the revoke call are all injected, so the control flow is unit-testable in plain
// Node with fakes.
//
// INVARIANT: a failure to revoke at Google (network error, thrown revoke) must
// NEVER prevent local deletion of the user's Google tokens/state/connection.
// The revoke is wrapped in its own try/catch; the local cleanup always runs afterward.
//
// LOCAL CLEANUP IS ONE ATOMIC RPC. `public.run_google_local_cleanup(p_user_id)`
// (service_role only, SECURITY DEFINER, search_path = '') performs, in a single
// transaction: (1) every PENDING Gmail suggestion of that user becomes 'invalidated'
// with retained_subject and context_expires_at erased (the row and its one-way
// fingerprint remain as the dedup tombstone); (2) google_oauth_states rows are
// deleted; (3) the google_connections row is deleted, cascading tokens,
// capabilities, cursors, and provider reference rows exactly as before.
// Doing this server-side replaced two independent client deletes that could leave a
// half-cleaned state and — the gap this closes — never touched pending Gmail context.
//
// userId MUST come from the Edge Function's verified JWT (auth.getUser()), never
// from a request body: it is the only ownership input the RPC receives.

export const GOOGLE_LOCAL_CLEANUP_RPC = 'run_google_local_cleanup'

/**
 * Best-effort revoke, then unconditional atomic local cleanup of the user's Google rows.
 *
 * @param {{
 *   admin: any,                                  // supabase-like service-role client (needs .from and .rpc)
 *   userId: string,
 *   resolveToken: (tokensRow: object) => Promise<string|null>, // decrypts a revocable token
 *   revoke: (token: string) => Promise<void>,    // best-effort; may reject
 * }} deps
 * @returns {Promise<{
 *   revoked: boolean,
 *   localCleanupError: boolean,          // true when the RPC failed or returned a non-'cleaned' code
 *   gmailCandidatesInvalidated: number,  // controlled count from the RPC (0 on error)
 * }>}
 */
export async function runGoogleLocalCleanup({ admin, userId, resolveToken, revoke }) {
  let revoked = false

  // ── Best-effort revoke (never blocks the cleanup below) ─────────────────────
  try {
    const { data: conn } = await admin
      .from('google_connections')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle()
    if (conn) {
      try {
        const { data: tokens } = await admin
          .from('google_tokens')
          .select('refresh_token_ciphertext, refresh_token_nonce, access_token_ciphertext, access_token_nonce')
          .eq('connection_id', conn.id)
          .maybeSingle()
        const token = tokens ? await resolveToken(tokens) : null
        if (token) {
          await revoke(token)
          revoked = true
        }
      } catch {
        // Revoke/decrypt failure is swallowed — local cleanup still proceeds.
      }
    }
  } catch {
    // Lookup failure is swallowed — local cleanup still proceeds.
  }

  // ── Always run the atomic local cleanup ─────────────────────────────────────
  // A thrown client error is treated exactly like an RPC error: reported, never
  // re-thrown, so delete-account's best-effort wrapper and disconnect's controlled
  // 500 both keep working.
  let localCleanupError = false
  let gmailCandidatesInvalidated = 0
  try {
    const { data, error } = await admin.rpc(GOOGLE_LOCAL_CLEANUP_RPC, { p_user_id: userId })
    if (error || !data || data.result !== 'cleaned') {
      localCleanupError = true
    } else {
      const n = Number(data.gmail_candidates_invalidated)
      gmailCandidatesInvalidated = Number.isFinite(n) && n > 0 ? n : 0
    }
  } catch {
    localCleanupError = true
  }

  return { revoked, localCleanupError, gmailCandidatesInvalidated }
}
