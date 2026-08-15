import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { runCheckoutOrchestration } from './checkoutOrchestrator.js'

// ── CORS ──────────────────────────────────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Constants ─────────────────────────────────────────────────────────────────
const STRIPE_API  = 'https://api.stripe.com/v1'
const SUCCESS_URL = 'https://www.getfunnl.com/settings?checkout=success'
const CANCEL_URL  = 'https://www.getfunnl.com/settings?checkout=cancelled'

function jsonResponse(body: unknown, status: number): Response {
  return new Response(
    JSON.stringify(body),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

// Privacy-safe structured logger. The orchestration passes only controlled fields
// (requestId + controlled reason codes) — never user ids, emails, or Stripe bodies.
function log(eventName: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: `create-checkout-session:${eventName}`, ...fields }))
}

// Real Stripe Checkout Session creation. Returns a normalized result; the
// orchestration validates the returned URL. Never logs the Stripe response body.
async function createStripeSession(
  { params, idempotencyKey, stripeKey }:
  { params: URLSearchParams; idempotencyKey: string; stripeKey: string },
): Promise<{ ok: boolean; status: number; session: Record<string, unknown> | null }> {
  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      'Authorization':   `Bearer ${stripeKey}`,
      'Content-Type':    'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotencyKey,
    },
    body: params.toString(),
  })
  if (!res.ok) return { ok: false, status: res.status, session: null }
  try {
    return { ok: true, status: res.status, session: await res.json() as Record<string, unknown> }
  } catch {
    return { ok: false, status: res.status, session: null }
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const requestId = crypto.randomUUID()

  try {
    // ── Authenticate caller ─────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return jsonResponse({ error: 'Not authenticated' }, 401)

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    )
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) return jsonResponse({ error: 'Not authenticated' }, 401)

    // Note: a browser-supplied attemptId (if present) is NON-authoritative and is
    // deliberately ignored for deduplication — the server-side checkout_operations
    // single-flight is the authority. We do not parse the body for it.

    // ── Service-role client + delegate to tested orchestration ──────────────────
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const result = await runCheckoutOrchestration({
      user: { id: user.id, email: user.email },
      supabaseAdmin,
      createStripeSession,
      env: {
        priceId:    Deno.env.get('STRIPE_PRO_PRICE_ID') ?? '',
        stripeKey:  Deno.env.get('STRIPE_SECRET_KEY') ?? '',
        successUrl: SUCCESS_URL,
        cancelUrl:  CANCEL_URL,
      },
      now: () => new Date().toISOString(),
      log,
      requestId,
    })

    return jsonResponse(result.body, result.status)
  } catch {
    log('internal_error', { requestId })
    return jsonResponse({ error: 'Something went wrong - please try again' }, 500)
  }
})
