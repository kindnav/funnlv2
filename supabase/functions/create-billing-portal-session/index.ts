import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { fetchWithTimeout, isTimeoutError } from '../shared/boundedFetch.js'

// ── CORS ──────────────────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STRIPE_API  = 'https://api.stripe.com/v1'
// Return URL after the user closes the Billing Portal. Must be an allowed URL
// configured in the Stripe dashboard → Billing → Customer Portal → Return URL.
const RETURN_URL  = 'https://www.getfunnl.com/settings'

// ── Handler ──────────────────────────────────────────────────────────────────
//
// SETUP REQUIRED IN STRIPE DASHBOARD:
//   Before this Edge Function can be used in production, configure the Stripe
//   Billing Portal at: https://dashboard.stripe.com/settings/billing/portal
//   Required settings:
//     - Enable the portal
//     - Set return URL to https://www.getfunnl.com/settings (or your domain)
//     - Configure what customers can do (cancel, update payment method, etc.)
//   Without this setup, Stripe will return a 403 when creating portal sessions.
//
// SECURITY:
//   - The Stripe customer ID is resolved server-side from the user's subscriptions row.
//   - The browser never sends a customer ID — it is never trusted from the browser.
//   - Only the portal URL is returned to the browser.

Deno.serve(async (req) => {
  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // ── POST only ───────────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const requestId = crypto.randomUUID()

  try {
    // ── 1. Authenticate caller ────────────────────────────────────────────────
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

    // ── 2. Look up the Stripe customer ID from the subscriptions table ────────
    // The customer ID is resolved server-side from the database — never from
    // the browser request. This ensures the browser cannot specify an arbitrary
    // customer and access another user's billing portal.
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: sub, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (subError) {
      console.error('create-billing-portal-session: subscription lookup failed', {
        requestId,
        dbCode: subError.code,
      })
      return new Response(
        JSON.stringify({ error: 'Could not load billing information. Please try again.' }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!sub?.stripe_customer_id) {
      // No subscription row or no customer ID — user has never completed a checkout.
      // Return a controlled unavailable response rather than calling Stripe.
      return new Response(
        JSON.stringify({ error: 'No billing account found for this user' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 3. Create Stripe Billing Portal session ────────────────────────────────
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
    if (!stripeKey) {
      console.error('create-billing-portal-session: STRIPE_SECRET_KEY not set', { requestId })
      return new Response(
        JSON.stringify({ error: 'Billing portal not configured. Please try again later.' }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const params = new URLSearchParams()
    params.set('customer', sub.stripe_customer_id)
    params.set('return_url', RETURN_URL)

    let stripeRes: Response
    try {
      // Bounded ~20s timeout — a stalled Stripe call must not hold the function.
      stripeRes = await fetchWithTimeout(`${STRIPE_API}/billing_portal/sessions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripeKey}`,
          'Content-Type':  'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      })
    } catch (err) {
      // Timeout or network failure — return a controlled retryable 503. The frontend's
      // existing visible billing error continues to appear. Never log the raw error.
      console.error('create-billing-portal-session: stripe-request-unavailable', {
        requestId,
        timeout: isTimeoutError(err),
      })
      return new Response(
        JSON.stringify({ error: 'Could not open billing portal. Please try again.' }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!stripeRes.ok) {
      console.error('create-billing-portal-session: Stripe API error', {
        requestId,
        providerStatus: stripeRes.status,
      })
      return new Response(
        JSON.stringify({ error: 'Could not open billing portal. Please try again.' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Parse Stripe response — handle invalid JSON defensively.
    let portalSession: { url?: string }
    try {
      portalSession = await stripeRes.json()
    } catch {
      console.error('create-billing-portal-session: invalid JSON in Stripe response', {
        requestId,
        providerStatus: stripeRes.status,
      })
      return new Response(
        JSON.stringify({ error: 'Could not open billing portal. Please try again.' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validate the returned URL — must be HTTPS on billing.stripe.com.
    const portalUrl = portalSession?.url
    let validUrl = false
    if (typeof portalUrl === 'string' && portalUrl) {
      try {
        const parsed = new URL(portalUrl)
        validUrl = parsed.protocol === 'https:' && parsed.hostname === 'billing.stripe.com'
      } catch { /* invalid URL — validUrl stays false */ }
    }
    if (!validUrl) {
      console.error('create-billing-portal-session: Stripe returned invalid or missing portal URL', {
        requestId,
        providerStatus: stripeRes.status,
      })
      return new Response(
        JSON.stringify({ error: 'Could not open billing portal. Please try again.' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Return only the portal URL — never expose customer IDs or session IDs.
    return new Response(
      JSON.stringify({ url: portalUrl }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch {
    console.error('create-billing-portal-session: unexpected error', {
      requestId,
    })
    return new Response(
      JSON.stringify({ error: 'Something went wrong. Please try again.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
