import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { cancelAccountSubscriptions, makeStripeRequest } from './subscriptionCancellation.js'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Not authenticated' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Verify the caller's JWT
    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Not authenticated' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Admin client for deletion operations
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // The Google, Gmail and Outlook integrations are retired: no connections or tokens exist, and
    // their tables are being removed (Stage F). Any remaining rows belonging to this user are removed by
    // ON DELETE CASCADE when the auth user is deleted below, so no separate cleanup step is needed.

    // Billing first: cancel the account's Stripe subscription(s) immediately (no refund) and expire an
    // open Checkout session. If that cannot be confirmed, NOTHING is deleted and the account is kept.
    // Identifiers come only from this user's own rows and are cross-checked with Stripe.
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
    const billing = await cancelAccountSubscriptions({
      userId: user.id,
      admin,
      stripeKey,
      stripeRequest: makeStripeRequest({ stripeKey }),
    })
    if (!billing.ok) {
      // Only a controlled reason code is logged: no ids, Stripe bodies, or messages.
      console.log(JSON.stringify({ event: 'delete_account_subscription_blocked', reason: billing.reason, retryable: billing.retryable }))
      const code = billing.retryable ? 'subscription_cancel_unconfirmed' : 'subscription_needs_support'
      return new Response(
        JSON.stringify({ error: { code } }),
        { status: billing.retryable ? 503 : 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    if (billing.billing) {
      console.log(JSON.stringify({ event: 'delete_account_subscription_cleared', canceled: billing.canceled, already_ended: billing.alreadyEnded, sessions_expired: billing.sessionsExpired }))
    }

    // Delete contacts first — cascades to interactions via ON DELETE CASCADE
    const { error: contactsErr } = await admin
      .from('contacts')
      .delete()
      .eq('user_id', user.id)
    if (contactsErr) throw new Error('contacts_delete_failed')

    // Delete the auth user — cascades to profiles, subscriptions and checkout_operations via ON DELETE CASCADE
    const { error: deleteErr } = await admin.auth.admin.deleteUser(user.id)
    if (deleteErr) throw new Error('auth_user_delete_failed')

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.log(JSON.stringify({ event: 'delete_account_failed', name: err instanceof Error ? err.name : 'unknown' }))
    return new Response(
      JSON.stringify({ error: { code: 'delete_failed' } }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

