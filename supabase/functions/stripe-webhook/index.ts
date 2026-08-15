import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyStripeSignature } from './verifyStripeSignature.js'
import { runWebhookOrchestration } from './webhookHandler.js'

// ── Stripe API helper ─────────────────────────────────────────────────────────

const STRIPE_API = 'https://api.stripe.com/v1'

// Fetches the authoritative current state of a subscription from Stripe.
// Returns the parsed subscription object, or null on failure.
// Callers must return 5xx when this returns null — never silently proceed.
async function fetchStripeSubscription(
  subscriptionId: string,
  stripeKey: string,
): Promise<Record<string, unknown> | null> {
  let res: Response
  try {
    res = await fetch(`${STRIPE_API}/subscriptions/${subscriptionId}`, {
      headers: { 'Authorization': `Bearer ${stripeKey}` },
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  try {
    return await res.json() as Record<string, unknown>
  } catch {
    return null
  }
}

// Privacy-safe structured logger. Only controlled, non-PII fields are ever passed
// by the orchestration layer (requestId, eventType, and controlled reason codes).
// Never logs Stripe payloads, metadata, customer/subscription IDs, emails, names,
// or response bodies.
function log(eventName: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: `stripe-webhook:${eventName}`, ...fields }))
}

// ── Webhook handler ────────────────────────────────────────────────────────────
//
// This is a thin transport wrapper. All decision logic lives in
// webhookHandler.js (runWebhookOrchestration) and is unit-tested from Node.
//
// HTTP response semantics (produced by the orchestration layer):
//   200 — Event processed or safely ignored for a documented reason
//   400 — Rejected (bad signature, invalid JSON, invalid event shape)
//   500 — Processing failed; Stripe WILL retry
//   503 — In progress elsewhere, OR claim ownership was lost during finalize;
//         Stripe WILL retry (a later retry hits `duplicate` once the true owner
//         durably finalizes).

Deno.serve(async (req) => {
  // Webhooks are always POST from Stripe — reject other methods without logging.
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const requestId     = crypto.randomUUID()
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''
  const sigHeader     = req.headers.get('stripe-signature') ?? ''
  const priceId       = Deno.env.get('STRIPE_PRO_PRICE_ID')  ?? ''
  const stripeKey     = Deno.env.get('STRIPE_SECRET_KEY')    ?? ''

  // Read raw body as text first — JSON.parse must happen AFTER signature verification
  // so the byte sequence used for verification is identical to what Stripe sent.
  const rawBody = await req.text()

  // ── Verify Stripe signature ────────────────────────────────────────────────
  if (!webhookSecret) {
    log('config_no_webhook_secret', { requestId })
    return new Response('Webhook not configured', { status: 500 })
  }
  if (!sigHeader) {
    return new Response('Missing signature', { status: 400 })
  }
  const isValid = await verifyStripeSignature(rawBody, sigHeader, webhookSecret)
  if (!isValid) {
    return new Response('Invalid signature', { status: 400 })
  }

  // ── Parse event ────────────────────────────────────────────────────────────
  let event: Record<string, unknown>
  try {
    event = JSON.parse(rawBody)
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  // ── Service-role client — bypasses RLS for all writes ─────────────────────
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  )

  // ── Delegate to the tested orchestration ───────────────────────────────────
  const result = await runWebhookOrchestration({
    event,
    requestId,
    supabaseAdmin,
    fetchSubscription: fetchStripeSubscription,
    env: { priceId, stripeKey },
    now: () => new Date().toISOString(),
    log,
  })

  return new Response(result.body, { status: result.status })
})
