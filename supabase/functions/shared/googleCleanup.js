// Shared best-effort Google cleanup used by both google-oauth-disconnect and
// delete-account. Zero imports — the Supabase admin client, token resolution, and
// the revoke call are all injected, so the control flow is unit-testable in plain
// Node with fakes.
//
// INVARIANT: a failure to revoke at Google (network error, thrown revoke) must
// NEVER prevent local deletion of the user's Google tokens/state/connection.
// The revoke is wrapped in its own try/catch; the deletes always run afterward.

/**
 * Best-effort revoke, then unconditional local deletion of the user's Google rows.
 *
 * @param {{
 *   admin: any,                                  // supabase-like service-role client
 *   userId: string,
 *   resolveToken: (tokensRow: object) => Promise<string|null>, // decrypts a revocable token
 *   revoke: (token: string) => Promise<void>,    // best-effort; may reject
 * }} deps
 * @returns {Promise<{ revoked: boolean, connectionDeleteError: boolean }>}
 */
export async function runGoogleLocalCleanup({ admin, userId, resolveToken, revoke }) {
  let revoked = false

  // ── Best-effort revoke (never blocks the deletes below) ─────────────────────
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
        // Revoke/decrypt failure is swallowed — local deletion still proceeds.
      }
    }
  } catch {
    // Lookup failure is swallowed — local deletion still proceeds.
  }

  // ── Always delete local Google state ────────────────────────────────────────
  // Deleting the connection cascades google_tokens (ON DELETE CASCADE); oauth
  // states are deleted explicitly. All scoped to the user.
  await admin.from('google_oauth_states').delete().eq('user_id', userId)
  const { error: connDelErr } = await admin
    .from('google_connections')
    .delete()
    .eq('user_id', userId)

  return { revoked, connectionDeleteError: Boolean(connDelErr) }
}
