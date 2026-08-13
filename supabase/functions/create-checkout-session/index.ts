import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const STRIPE_API  = 'https://api.stripe.com/v1'
const PRICE_ID    = 'price_1U3louJU7lKQodyVjgclua04'
const SUCCESS_URL = 'https://www.getfunnl.com/settings?checkout=success'
const CANCEL_URL  = 'https://www.getfunnl.com/settings?checkout=cancelled'

Deno.serve(async (req) => {
  // Browsers send a preflight OPTIONS request before the real call — return OK immediately.
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // ── 1. Verify the caller's auth token ─────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Not authenticated' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

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

    // ── 2. Check for an existing active subscription (idempotency guard) ──────
    // Prevents creating a redundant Checkout Session for a user already subscribed.
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: existingSub } = await supabaseAdmin
      .from('subscriptions')
      .select('status, stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (existingSub?.status === 'active') {
      return new Response(
        JSON.stringify({ error: 'Already subscribed' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 3. Build Stripe Checkout Session params ────────────────────────────────
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
    if (!stripeKey) {
      console.error('create-checkout-session: STRIPE_SECRET_KEY not set')
      return new Response(
        JSON.stringify({ error: 'Checkout not configured — please try again later' }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const params = new URLSearchParams()
    params.set('mode', 'subscription')
    params.set('success_url', SUCCESS_URL)
    params.set('cancel_url', CANCEL_URL)
    params.set('line_items[0][price]', PRICE_ID)
    params.set('line_items[0][quantity]', '1')
    // metadata.user_id is used by the webhook to map the Stripe customer back to
    // the Supabase user. This is the only safe mapping — Stripe customer IDs are
    // not known in advance (they're created at checkout).
    params.set('metadata[user_id]', user.id)

    if (existingSub?.stripe_customer_id) {
      // Reuse the existing Stripe customer: preserves billing history + payment methods.
      params.set('customer', existingSub.stripe_customer_id)
    } else if (user.email) {
      // No existing customer — let Stripe pre-fill the email field at checkout.
      params.set('customer_email', user.email)
    }

    // ── 4. Call Stripe API ─────────────────────────────────────────────────────
    // STRIPE_SECRET_KEY is stored in Supabase secrets — never in any file in this repo.
    const stripeRes = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })

    if (!stripeRes.ok) {
      const errText = await stripeRes.text()
      console.error('create-checkout-session: Stripe API error', {
        status: stripeRes.status,
        // Log only the first 200 chars to avoid surfacing card data in logs.
        body: errText.slice(0, 200),
      })
      return new Response(
        JSON.stringify({ error: 'Could not start checkout — please try again' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const session = await stripeRes.json()
    return new Response(
      JSON.stringify({ url: session.url }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('create-checkout-session: unexpected error', String(err))
    return new Response(
      JSON.stringify({ error: 'Something went wrong — please try again' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
