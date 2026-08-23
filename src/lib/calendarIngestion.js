// Client-side rollout flag foundation for Calendar EVENT INGESTION (Phase A).
//
// This is deliberately a foundation only: it is NOT imported or rendered anywhere
// yet (no Settings/Dashboard review UI exists until Phase B). It exists so the
// build has a single, unit-testable source of truth for whether the ingestion
// review UI is exposed — mirroring the connection flag in ./googleConnection.js.
//
// It is a NON-SECRET build-time feature flag: it gates only future UI visibility,
// never security or any server behavior. No credentials, no OAuth material, no
// Supabase access. All secrets remain server-side in Edge secrets, never in Vite.
//
// Fail-safe: enabled ONLY on the exact string 'true'. Missing, empty, 'false',
// 'TRUE', '1', whitespace-padded, null, undefined, and any non-string all
// resolve to DISABLED.

/**
 * Pure predicate: ingestion review UI is enabled only when the raw flag value is
 * exactly the string 'true'. Kept pure + exported so it is unit-testable without
 * Vite.
 * @param {unknown} rawValue - import.meta.env.VITE_CALENDAR_INGESTION_ENABLED
 * @returns {boolean}
 */
export function calendarIngestionEnabled(rawValue) {
  return rawValue === 'true'
}

// Computed once at module load from the Vite build env. In non-Vite (Node test)
// contexts import.meta.env is undefined → disabled (fail-safe default).
export const CALENDAR_INGESTION_ENABLED = calendarIngestionEnabled(
  import.meta.env?.VITE_CALENDAR_INGESTION_ENABLED,
)
