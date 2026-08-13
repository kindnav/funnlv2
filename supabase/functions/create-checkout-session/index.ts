import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  isValidUUID,
  buildIdempotencyKey,
  isBlockedByExistingSubscription,
} from './checkoutHelpers.js'

// ── CORS ──────────────────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STRIPE_API  = 'https://api.stripe.com/v1'
const SUCCESS_URL = 'https://www.getfunnl.com/settings?checkout=success'
const CANCEL_URL  = 'https://www.getfunnl.com/settings?checkout=cancelled'

// ── Controlled error codes ─────────────────────────────────────────────────────
// These codes appear in logs only — never in HTTP responses to the browser.
// User-facing error messages are generic and safe.

type ErrorCode =
  | 'missing_auth'
  | 'method_not_allowed'
  | 'invalid_attempt_id'
  | 'subscription_lookup_failed'
  | 'already_subscribed'
  | 'price_not_configured'
  | 'stripe_key_not_configured'
  | 'stripe_api_error'
  | 'internal_error'

function jsonResponse(body: unknown, status: number): Response {
  return new Response(
    JSON.stringify(body),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

// ── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // ── POST only ───────────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  // Stable request ID for correlating log lines to a single invocation.
  const requestId = crypto.randomUUID()

  try {
    // ── 1. Authenticate caller ────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return jsonResponse({ error: 'Not authenticated' }, 401)
    }

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) {
      return jsonResponse({ error: 'Not authenticated' }, 401)
    }

    // ── 2. Parse and validate request body ────────────────────────────────────
    // The frontend generates a fresh UUID per checkout click (attemptId).
    // The server validates it and incorporates it into the Stripe idempotency key.
    // A network retry of the same request sends the same attemptId — Stripe correctly
    // deduplicates. A new click generates a new attemptId — a fresh session is created.
    let body: Record<string, unknown> = {}
    try {
      body = await req.json()
    } catch {
      // No body or non-JSON body — caught below when attemptId is absent
    }

    const rawAttemptId = body?.attemptId
    if (!isValidUUID(rawAttemptId as string)) {
      console.warn('create-checkout-session: invalid or missing attemptId', {
        requestId,
        code: 'invalid_attempt_id' satisfies ErrorCode,
      })
      return jsonResponse({ error: 'Invalid request' }, 400)
    }
    const attemptId = rawAttemptId as string

    // ── 3. Check for existing active or past_due subscription ─────────────────
    // Uses service-role client so RLS does not interfere with the lookup.
    // If the query fails, we must NOT continue — we cannot safely determine whether
    // the user already has a subscription, which could create a duplicate for an
    // active or past_due subscriber.
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: existingSub, error: subLookupError } = await supabaseAdmin
      .from('subscriptions')
      .select('status, stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (subLookupError) {
      // DB failure: cannot safely verify subscription status. Return 503 so the
      // caller knows to retry rather than silently proceeding.
      console.error('create-checkout-session: subscription lookup failed', {
        requestId,
        code: 'subscription_lookup_failed' satisfies ErrorCode,
        dbCode: subLookupError.code,
      })
      return jsonResponse(
        { error: 'Could not verify subscription status — please try again' },
        503
      )
    }

    // Block both 'active' and 'past_due' — user is already subscribed in either case.
    if (isBlockedByExistingSubscription(existingSub?.status)) {
      return jsonResponse({ error: 'Already subscribed' }, 409)
    }

    // ── 4. Validate server-side configuration ─────────────────────────────────
    // Price ID comes from environment only — never from the browser request.
    // This prevents arbitrary products from being purchased through our checkout.
    const priceId   = Deno.env.get('STRIPE_PRO_PRICE_ID') ?? ''
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')   ?? ''

    if (!priceId) {
      console.error('create-checkout-session: STRIPE_PRO_PRICE_ID not configured', {
        requestId,
        code: 'price_not_configured' satisfies ErrorCode,
      })
      return jsonResponse(
        { error: 'Checkout not configured — please try again later' },
        503
      )
    }
    if (!stripeKey) {
      console.error('create-checkout-session: STRIPE_SECRET_KEY not configured', {
        requestId,
        code: 'stripe_key_not_configured' satisfies ErrorCode,
      })
      return jsonResponse(
        { error: 'Checkout not configured — please try again later' },
        503
      )
    }

    // ── 5. Build Stripe Checkout Session params ────────────────────────────────
    // Security notes:
    //   - line_items price ID comes only from STRIPE_PRO_PRICE_ID (never from browser)
    //   - client_reference_id maps the session back to the Supabase user on the
    //     checkout.session.completed webhook (Stripe's recommended pattern)
    //   - metadata.user_id is read by checkout.session.completed handler
    //   - subscription_data.metadata.user_id ensures subscription lifecycle events
    //     (subscription.created/updated) also carry the user mapping, independent
    //     of the checkout session being available
    const params = new URLSearchParams()
    params.set('mode', 'subscription')
    params.set('success_url', SUCCESS_URL)
    params.set('cancel_url', CANCEL_URL)
    params.set('line_items[0][price]', priceId)
    params.set('line_items[0][quantity]', '1')
    params.set('client_reference_id', user.id)
    params.set('metadata[user_id]', user.id)
    params.set('subscription_data[metadata][user_id]', user.id)

    if (existingSub?.stripe_customer_id) {
      // Reuse the existing Stripe customer record — preserves billing history
      // and saved payment methods for users who are re-subscribing after cancellation.
      params.set('customer', existingSub.stripe_customer_id)
    } else if (user.email) {
      // No existing customer: pre-fill the email field at checkout.
      params.set('customer_email', user.email)
    }

    // ── 6. Call Stripe API with idempotency key ────────────────────────────────
    const idempotencyKey = buildIdempotencyKey(user.id, attemptId)

    const stripeRes = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: 'POST',
      headers: {
        'Authorization':    `Bearer ${stripeKey}`,
        'Content-Type':     'application/x-www-form-urlencoded',
        'Idempotency-Key':  idempotencyKey,
      },
      body: params.toString(),
    })

    // Log only controlled, non-sensitive fields — never log the Stripe response body
    // (it may contain price data, customer details, or session URLs).
    if (!stripeRes.ok) {
      console.error('create-checkout-session: Stripe API error', {
        requestId,
        code: 'stripe_api_error' satisfies ErrorCode,
        providerStatus: stripeRes.status,
      })
      return jsonResponse(
        { error: 'Could not start checkout — please try again' },
        502
      )
    }

    const session = await stripeRes.json() as { url: string }

    // Return only the checkout URL — never expose session IDs, customer IDs,
    // or other Stripe metadata to the browser.
    return jsonResponse({ url: session.url }, 200)

  } catch (err) {
    console.error('create-checkout-session: unexpected error', {
      requestId,
      code: 'internal_error' satisfies ErrorCode,
      error: String(err),
    })
    return jsonResponse({ error: 'Something went wrong — please try again' }, 500)
  }
})
