// Pure helpers for the Google "Connected accounts" UI. No React or Supabase
// imports, so these are unit-testable in the plain-Node runner.

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly'

// ── Client-side rollout flag ──────────────────────────────────────────────────
//
// Single source of truth for whether the Google Calendar connection UI is exposed
// in this build. It is a NON-SECRET build-time feature flag — it gates only UI
// visibility, never security. All OAuth secrets (client id/secret, callback,
// encryption key, tokens, scopes) live server-side in Edge secrets and are NEVER
// exposed through Vite.
//
// Fail-safe: enabled ONLY on the exact string 'true'. Missing, empty, 'false',
// 'TRUE', '1', whitespace-padded, null, and undefined all resolve to DISABLED.

/**
 * Pure predicate: the connection UI is enabled only when the raw flag value is
 * exactly the string 'true'. Kept pure + exported so it is unit-testable without
 * Vite.
 * @param {unknown} rawValue - import.meta.env.VITE_CALENDAR_CONNECTION_ENABLED
 * @returns {boolean}
 */
export function calendarConnectionEnabled(rawValue) {
  return rawValue === 'true'
}

// Computed once at module load from the Vite build env. In non-Vite (Node test)
// contexts import.meta.env is undefined → disabled (fail-safe default).
export const CALENDAR_CONNECTION_ENABLED = calendarConnectionEnabled(
  import.meta.env?.VITE_CALENDAR_CONNECTION_ENABLED,
)

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
