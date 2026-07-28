import { supabase } from './supabase'

/**
 * Fetches the server-authoritative Pro access status for the current user.
 *
 * Calls the get_my_pro_access_status() RPC which uses the database clock (now()),
 * so no access decision ever depends on the browser's Date(). Returns null when
 * the RPC fails (network error, not authenticated, transient DB issue).
 *
 * Return shape on success:
 *   permanent_pro  boolean       — ai_enabled = true on profiles row
 *   trial_eligible boolean       — trial row exists with started_at IS NULL
 *   trial_active   boolean       — trial started and ends_at > server now()
 *   trial_expired  boolean       — trial started and ends_at <= server now()
 *   days_remaining int           — calendar days left (0 when not active)
 *   ends_at        string|null   — ISO timestamp of trial end
 *   server_now     string        — database clock at call time
 *   can_use_pro    boolean       — permanent_pro OR trial_active
 *
 * Callers check for null to distinguish "status unavailable" from "not Pro"
 * and must handle both cases in the UI.
 *
 * STRIPE SEAM: When Stripe billing lands (Layer D), the RPC body can be
 * updated to incorporate subscription status without changing this call site.
 *
 * @returns {Promise<object|null>}
 */
export async function getProAccessStatus() {
  const { data, error } = await supabase.rpc('get_my_pro_access_status')
  if (error) {
    console.error('getProAccessStatus failed', error.code ?? error.message)
    return null
  }
  return data ?? null
}
