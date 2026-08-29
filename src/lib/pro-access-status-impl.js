/**
 * Pure inner implementation of the Pro access status fetch.
 *
 * Zero external imports — safe to import in Node.js test files.
 * This is the real production logic. getProAccessStatus() in pro-access-status.js
 * calls it with the default Supabase client.
 *
 * Never throws. All error paths (Supabase error result, thrown/rejected RPC call,
 * null data, malformed response) resolve to null.
 *
 * @param {{ rpc: Function }} client — Supabase client (or test stub)
 * @returns {Promise<object|null>}
 */
// PostgREST JWT-group error codes that a fresh access token resolves. PGRST303 is a
// JWT temporal-validation failure (expired / issued-at future / not-yet-valid);
// PGRST301 is a JWT verification failure (some PostgREST versions report expiry here).
// These occur when a stale/expired access token reaches PostgREST during the
// token-refresh window at app mount. Refreshing the session and retrying once fixes
// the common (expired-token) case at its root rather than hiding it.
const AUTH_REFRESHABLE_CODES = new Set(['PGRST301', 'PGRST303'])

export async function _getProAccessStatusWith(client) {
  try {
    let { data, error } = await client.rpc('get_my_pro_access_status')

    // Transient JWT error → refresh the session and retry once with a fresh token.
    if (
      error &&
      AUTH_REFRESHABLE_CODES.has(error.code) &&
      typeof client.auth?.refreshSession === 'function'
    ) {
      const { error: refreshErr } = await client.auth.refreshSession()
      if (!refreshErr) {
        const retry = await client.rpc('get_my_pro_access_status')
        data = retry.data
        error = retry.error
      }
    }

    if (error) {
      // Supabase returned a structured error (auth failure, DB error, etc.)
      // Log only the controlled error code, never the full message (may contain PII).
      console.error('getProAccessStatus failed', error.code ?? 'rpc_error')
      return null
    }
    // Validate minimum shape. can_use_pro and permanent_pro must be booleans —
    // a missing or wrong-typed field must not be treated as a grant or denial.
    if (
      !data ||
      typeof data.can_use_pro !== 'boolean' ||
      typeof data.permanent_pro !== 'boolean'
    ) {
      console.error('getProAccessStatus: malformed response')
      return null
    }
    return data
  } catch {
    // Network exception, SDK bug, aborted request — treat as status unavailable.
    // Log only a controlled label — never error.message, stack, or session info.
    console.error('getProAccessStatus: rpc_exception')
    return null
  }
}
