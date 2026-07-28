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
export async function _getProAccessStatusWith(client) {
  try {
    const { data, error } = await client.rpc('get_my_pro_access_status')
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
