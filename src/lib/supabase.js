import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Re-exported so callers that must reach an Edge Function through the branded
// /api path (rather than supabase.functions.invoke) can send the same apikey the
// client would. Public by design, exactly like the client above.
export const SUPABASE_ANON_KEY = supabaseAnonKey

/**
 * Bearer token for the current Supabase session, or null when signed out.
 * Lives here rather than in a feature component so session handling stays in one
 * place and no component needs to reach into the session object itself.
 * @returns {Promise<string|null>}
 */
export async function getSessionBearerToken () {
  const { data } = await supabase.auth.getSession()
  return data?.session?.access_token ?? null
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
