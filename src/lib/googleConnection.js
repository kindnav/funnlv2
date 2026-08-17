// Pure helpers for the Google "Connected accounts" UI. No React or Supabase
// imports, so these are unit-testable in the plain-Node runner.

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly'

/**
 * Classifies the Connected-accounts UI state from the fetch result.
 *
 * @param {{ loading: boolean, error: boolean, connection: object|null }} p
 * @returns {'loading'|'error'|'not_connected'|'connected'|'needs_reauth'}
 */
export function classifyGoogleConnection({ loading, error, connection }) {
  if (loading) return 'loading'
  if (error) return 'error'
  if (!connection) return 'not_connected'
  if (connection.status === 'needs_reauth' || connection.status === 'revoked') return 'needs_reauth'
  return 'connected'
}

/**
 * Reads the server-set ?google= result from a Settings return URL.
 * Only 'connected' and 'error' are recognized; anything else → null.
 *
 * @param {string} search — location.search
 * @returns {'connected'|'error'|null}
 */
export function parseGoogleReturnParam(search) {
  const v = new URLSearchParams(search || '').get('google')
  if (v === 'connected') return 'connected'
  if (v === 'error') return 'error'
  return null
}

/** True when the granted scopes include Calendar read-only. */
export function hasCalendarScope(scopes) {
  return Array.isArray(scopes) && scopes.includes(GOOGLE_CALENDAR_SCOPE)
}
