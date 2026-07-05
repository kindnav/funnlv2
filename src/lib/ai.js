import { supabase } from './supabase'

// Stripe-ready Pro gate — the ONLY place in the app that decides "can this user use AI?"
//
// Every AI feature calls canUseAI() before doing anything. Nothing reads ai_enabled directly.
// That's the seam: when Stripe is added (Layer D), only this function changes.
// All AI features become Stripe-gated automatically with no other code changes.
//
// Today: reads ai_enabled from the profiles table.
// Future (Stripe): replace this body to check subscription status instead.
export async function canUseAI(userId) {
  const { data } = await supabase
    .from('profiles')
    .select('ai_enabled')
    .eq('id', userId)
    .maybeSingle()
  return data?.ai_enabled === true
}
