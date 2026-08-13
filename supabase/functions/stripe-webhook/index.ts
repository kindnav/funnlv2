import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Stripe HMAC-SHA256 signature verification ──────────────────────────────────
// Done manually via Deno's crypto.subtle — no external Stripe SDK required.
//
// Stripe sends: stripe-signature: t=TIMESTAMP,v1=SIG[,v1=SIG2,...]
// Signed payload = "${timestamp}.${rawBody}"
// Expected signature = HMAC-SHA256(webhookSecret, signedPayload), hex-encoded.
// Replay protection: reject events older than 5 minutes.

async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string,
  secret: string,
): Promise<boolean> {
  const parts   = sigHeader.split(',')
  const tPart   = parts.find(p => p.startsWith('t='))
  const v1Parts = parts.filter(p => p.startsWith('v1='))
  if (!tPart || !v1Parts.length) return false

  const timestamp = tPart.slice(2)
  if (!timestamp || isNaN(Number(timestamp))) return false

  // Reject events older than 5 minutes (replay attack protection).
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - Number(timestamp)) > 300) return false

  const signedPayload = `${timestamp}.${rawBody}`

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBytes = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(signedPayload),
  )
  const computed = Array.from(new Uint8Array(sigBytes))
    .map(b => b.toString(16).padStart(2, '0')).join('')

  // Stripe may send multiple v1 signatures during key rotation — match any one.
  return v1Parts.some(p => p.slice(3) === computed)
}

// ── Helper: safely extract a nested price ID from a subscription object ────────
function extractPriceId(sub: Record<string, unknown>): string | null {
  try {
    const items = sub.items as { data: Array<{ price: { id: string } }> }
    return items?.data?.[0]?.price?.id ?? null
  } catch {
    return null
  }
}

// ── Webhook handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // Webhooks are always POST from Stripe — ignore other methods.
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''
  const sigHeader     = req.headers.get('stripe-signature') ?? ''

  // Read raw body as text first — JSON.parse must happen AFTER signature verification
  // so the body bytes used for verification are identical to what Stripe sent.
  const rawBody = await req.text()

  // ── Verify Stripe signature ────────────────────────────────────────────────
  if (!webhookSecret) {
    console.error('stripe-webhook: STRIPE_WEBHOOK_SECRET not set')
    return new Response('Webhook not configured', { status: 500 })
  }
  if (!sigHeader) {
    console.warn('stripe-webhook: missing stripe-signature header')
    return new Response('Missing signature', { status: 400 })
  }

  const isValid = await verifyStripeSignature(rawBody, sigHeader, webhookSecret)
  if (!isValid) {
    console.warn('stripe-webhook: signature verification failed')
    return new Response('Invalid signature', { status: 400 })
  }

  // ── Parse event ────────────────────────────────────────────────────────────
  let event: Record<string, unknown>
  try {
    event = JSON.parse(rawBody)
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  const eventType = event.type as string
  const eventData = (event.data as Record<string, unknown>)?.object as Record<string, unknown>
  if (!eventData) {
    // Unknown event shape — acknowledge and ignore.
    return new Response('ok', { status: 200 })
  }

  // ── Service-role client — bypasses RLS for all writes ─────────────────────
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  )

  // ── Helper: look up our user_id from a Stripe customer ID ─────────────────
  // Subscription events after checkout carry customer ID but not user_id.
  // The unique index on subscriptions.stripe_customer_id makes this fast.
  async function lookupByCustomer(customerId: string): Promise<string | null> {
    const { data } = await supabaseAdmin
      .from('subscriptions')
      .select('user_id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle()
    return (data as { user_id: string } | null)?.user_id ?? null
  }

  // ── Handle events ──────────────────────────────────────────────────────────
  try {
    switch (eventType) {

      // ── checkout.session.completed ─────────────────────────────────────────
      // First event when a user completes Checkout. metadata.user_id maps the
      // Stripe customer to the Supabase user. A full subscription.created event
      // follows shortly with complete subscription details.
      case 'checkout.session.completed': {
        const session    = eventData
        const meta       = session.metadata as Record<string, string> | null
        const userId     = meta?.user_id
        if (!userId) {
          console.warn('stripe-webhook: checkout.session.completed missing metadata.user_id')
          break
        }
        const customerId      = session.customer as string
        const subscriptionId  = (session.subscription as string | null) ?? null

        const { error } = await supabaseAdmin
          .from('subscriptions')
          .upsert({
            user_id:               userId,
            stripe_customer_id:    customerId,
            stripe_subscription_id: subscriptionId,
            status:                'active',   // payment succeeded at Checkout
            updated_at:            new Date().toISOString(),
          }, { onConflict: 'user_id' })

        if (error) {
          console.error('stripe-webhook: checkout upsert error', { code: error.code })
        }
        break
      }

      // ── customer.subscription.created / updated ────────────────────────────
      // Fired after checkout and on every subscription change (renewal, cancel,
      // dunning status change). This is the authoritative source for subscription
      // status, period end, and cancel_at_period_end.
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub        = eventData
        const customerId = sub.customer as string
        const userId     = await lookupByCustomer(customerId)
        if (!userId) {
          console.warn('stripe-webhook: subscription event for unknown customer', {
            eventType,
            customer: customerId,
          })
          break
        }

        const periodEndUnix = sub.current_period_end as number | null
        const periodEnd     = periodEndUnix
          ? new Date(periodEndUnix * 1000).toISOString()
          : null

        const { error } = await supabaseAdmin
          .from('subscriptions')
          .upsert({
            user_id:               userId,
            stripe_customer_id:    customerId,
            stripe_subscription_id: sub.id as string,
            status:                sub.status as string,
            current_period_end:    periodEnd,
            cancel_at_period_end:  Boolean(sub.cancel_at_period_end),
            price_id:              extractPriceId(sub),
            updated_at:            new Date().toISOString(),
          }, { onConflict: 'user_id' })

        if (error) {
          console.error('stripe-webhook: subscription upsert error', {
            eventType,
            code: error.code,
          })
        }
        break
      }

      // ── customer.subscription.deleted ─────────────────────────────────────
      // Stripe sends this when a subscription reaches its final canceled state
      // (after cancel_at_period_end, or immediately on immediate cancellation,
      // or after dunning fails completely). Pro access is revoked at this point.
      case 'customer.subscription.deleted': {
        const sub        = eventData
        const customerId = sub.customer as string
        const userId     = await lookupByCustomer(customerId)
        if (!userId) {
          console.warn('stripe-webhook: subscription.deleted for unknown customer', {
            customer: customerId,
          })
          break
        }

        const { error } = await supabaseAdmin
          .from('subscriptions')
          .update({
            status:     'canceled',
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)

        if (error) {
          console.error('stripe-webhook: subscription.deleted update error', { code: error.code })
        }
        break
      }

      // ── invoice.payment_succeeded ──────────────────────────────────────────
      // Fired on successful charge — including renewals. Updates current_period_end
      // so the UI shows the correct next renewal date. (subscription.updated also
      // fires on renewal, so this is a belt-and-suspenders update.)
      case 'invoice.payment_succeeded': {
        const invoice    = eventData
        const customerId = invoice.customer as string
        const userId     = await lookupByCustomer(customerId)
        if (!userId) break  // No row yet — checkout.session.completed handles the initial insert.

        const lines = (invoice.lines as { data: Array<{ period: { end: number } }> } | null)?.data
        const periodEndUnix = lines?.[0]?.period?.end
        if (!periodEndUnix) break

        const periodEnd = new Date(periodEndUnix * 1000).toISOString()
        const { error } = await supabaseAdmin
          .from('subscriptions')
          .update({ current_period_end: periodEnd, updated_at: new Date().toISOString() })
          .eq('user_id', userId)

        if (error) {
          console.error('stripe-webhook: invoice.payment_succeeded update error', { code: error.code })
        }
        break
      }

      // ── invoice.payment_failed ─────────────────────────────────────────────
      // Stripe moves the subscription to 'past_due' status, which is handled by
      // the customer.subscription.updated event. Log here for observability only.
      case 'invoice.payment_failed': {
        const invoice = eventData
        console.log('stripe-webhook: invoice.payment_failed', {
          customer:      invoice.customer,
          attempt_count: invoice.attempt_count,
        })
        break
      }

      default:
        // Unhandled event type — acknowledge and ignore.
        break
    }
  } catch (err) {
    console.error('stripe-webhook: handler error', { eventType, error: String(err) })
    return new Response('Internal error', { status: 500 })
  }

  // Always return 200 after successful verification so Stripe knows we received the event.
  return new Response('ok', { status: 200 })
})
