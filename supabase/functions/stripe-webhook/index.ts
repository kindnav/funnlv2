import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  isValidUUID,
  extractPriceId,
  unixToIso,
  shouldRetryOnMissingOwnership,
  SUBSCRIPTION_STATUS_SEMANTICS,
} from './webhookHelpers.js'

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

// ── Webhook handler ────────────────────────────────────────────────────────────
//
// Subscription status semantics (documented in webhookHelpers.SUBSCRIPTION_STATUS_SEMANTICS):
//   active           → grants access (full, current subscription)
//   past_due         → grants access (dunning window; Stripe retrying payment)
//   canceled         → revokes access (final state after cancel_at_period_end or immediate cancel)
//   unpaid           → revokes access (all dunning attempts exhausted)
//   incomplete       → no access (payment not yet confirmed during checkout)
//   incomplete_expired → no access (checkout expired)
//   trialing         → no access (Stripe trials; Funnl uses pro_trials table instead)
//   paused           → no access (Stripe pause feature)
//   none             → no access (internal placeholder; should not arrive via webhook)
//
// HTTP response semantics:
//   200 — Event received and processed (or safely ignored for a documented reason)
//   400 — Event rejected (bad signature, invalid JSON, replay attack)
//   500 — Processing failed; Stripe WILL retry delivery
//
// CRITICAL: Any required DB write failure returns 500. This triggers Stripe retries
// and prevents silent subscription data loss. A 200 means the event was durably
// processed, not just received.

Deno.serve(async (req) => {
  // Webhooks are always POST from Stripe — reject other methods without logging.
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const requestId     = crypto.randomUUID()
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''
  const sigHeader     = req.headers.get('stripe-signature') ?? ''
  const priceId       = Deno.env.get('STRIPE_PRO_PRICE_ID') ?? ''

  // Read raw body as text first — JSON.parse must happen AFTER signature verification
  // so the byte sequence used for verification is identical to what Stripe sent.
  const rawBody = await req.text()

  // ── Verify Stripe signature ────────────────────────────────────────────────
  if (!webhookSecret) {
    console.error('stripe-webhook: STRIPE_WEBHOOK_SECRET not set', { requestId })
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

  const eventId       = event.id as string | undefined
  const eventType     = event.type as string
  const eventCreatedAt = unixToIso(event.created as number)
  const eventData     = (event.data as Record<string, unknown>)?.object as Record<string, unknown>

  if (!eventData) {
    // Unknown event shape — acknowledge and ignore.
    return new Response('ok', { status: 200 })
  }

  // ── Service-role client — bypasses RLS for all writes ─────────────────────
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  )

  // ── Ownership resolution ─────────────────────────────────────────────────
  // Resolves the Supabase user_id from a Stripe event in priority order:
  //   1. subscription metadata.user_id (set via subscription_data.metadata in checkout session)
  //   2. existing subscriptions row matched by stripe_subscription_id
  //   3. existing subscriptions row matched by stripe_customer_id
  //
  // Returns null userId when no match is found (not necessarily an error —
  // depends on event type and caller's retry policy).
  // Returns error=true when a DB query itself failed — caller must return 500.
  async function resolveUserId(opts: {
    metaUserId?: string | null
    subscriptionId?: string | null
    customerId?: string | null
  }): Promise<{ userId: string | null; error: boolean }> {
    // 1. From metadata (fastest — no DB query required)
    if (opts.metaUserId && isValidUUID(opts.metaUserId)) {
      return { userId: opts.metaUserId, error: false }
    }

    // 2. Lookup by stripe_subscription_id
    if (opts.subscriptionId) {
      const { data, error } = await supabaseAdmin
        .from('subscriptions')
        .select('user_id')
        .eq('stripe_subscription_id', opts.subscriptionId)
        .maybeSingle()
      if (error) {
        console.error('stripe-webhook: subscription ID lookup failed', {
          requestId, eventId, eventType, dbCode: error.code,
        })
        return { userId: null, error: true }
      }
      if (data?.user_id && isValidUUID(data.user_id as string)) {
        return { userId: data.user_id as string, error: false }
      }
    }

    // 3. Lookup by stripe_customer_id
    if (opts.customerId) {
      const { data, error } = await supabaseAdmin
        .from('subscriptions')
        .select('user_id')
        .eq('stripe_customer_id', opts.customerId)
        .maybeSingle()
      if (error) {
        console.error('stripe-webhook: customer ID lookup failed', {
          requestId, eventId, eventType, dbCode: error.code,
        })
        return { userId: null, error: true }
      }
      if (data?.user_id && isValidUUID(data.user_id as string)) {
        return { userId: data.user_id as string, error: false }
      }
    }

    return { userId: null, error: false }
  }

  // ── Handle events ──────────────────────────────────────────────────────────
  try {
    switch (eventType) {

      // ── checkout.session.completed ─────────────────────────────────────────
      // First event when a user completes Checkout. We use multiple ownership
      // sources: metadata.user_id (from session metadata), and
      // client_reference_id (also set to userId during session creation).
      // A full subscription.created event follows with complete subscription details.
      case 'checkout.session.completed': {
        const session    = eventData
        const meta       = session.metadata as Record<string, string> | null
        const userId     = (meta?.user_id ?? session.client_reference_id) as string | undefined

        if (!userId || !isValidUUID(userId)) {
          // Cannot identify user — log and return 200 (not retryable; data issue in session creation)
          console.warn('stripe-webhook: checkout.session.completed missing valid user_id', {
            requestId, eventId, eventType,
          })
          return new Response('ok', { status: 200 })
        }

        const customerId     = session.customer as string | null
        const subscriptionId = (session.subscription as string | null) ?? null

        if (!customerId) {
          console.warn('stripe-webhook: checkout.session.completed missing customer ID', {
            requestId, eventId, eventType,
          })
          return new Response('ok', { status: 200 })
        }

        const { error } = await supabaseAdmin
          .from('subscriptions')
          .upsert({
            user_id:                userId,
            stripe_customer_id:     customerId,
            stripe_subscription_id: subscriptionId,
            status:                 'active',   // payment succeeded at Checkout
            updated_at:             new Date().toISOString(),
          }, { onConflict: 'user_id' })

        if (error) {
          // DB write failed — return 500 so Stripe retries delivery.
          // Do NOT return 200: that would silently lose the subscription record.
          console.error('stripe-webhook: checkout upsert failed', {
            requestId, eventId, eventType, dbCode: error.code,
          })
          return new Response('Database write failed', { status: 500 })
        }
        break
      }

      // ── customer.subscription.created / updated ────────────────────────────
      // Fired after checkout and on every subscription change (renewal, cancel,
      // dunning status change). Authoritative source for subscription status,
      // period end, and cancel_at_period_end.
      //
      // Price validation: only write if the price matches STRIPE_PRO_PRICE_ID.
      // This prevents events from other Stripe products from writing to the
      // subscriptions table. A mismatch is logged and the event is acknowledged.
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub        = eventData
        const customerId = sub.customer as string
        const subMeta    = sub.metadata as Record<string, string> | null

        // Validate price before any DB operations
        const incomingPrice = extractPriceId(sub)
        if (priceId && incomingPrice && incomingPrice !== priceId) {
          console.warn('stripe-webhook: subscription price mismatch — ignoring', {
            requestId, eventId, eventType,
          })
          return new Response('ok', { status: 200 })
        }

        // Resolve user ownership
        const { userId, error: lookupError } = await resolveUserId({
          metaUserId:     subMeta?.user_id,
          subscriptionId: sub.id as string | null,
          customerId,
        })

        if (lookupError) {
          return new Response('Ownership lookup failed', { status: 500 })
        }
        if (!userId) {
          // Unknown owner — if this event type is entitlement-changing, return 500
          // so Stripe retries. A later checkout.session.completed event may create
          // the subscriptions row that the next retry can look up.
          if (shouldRetryOnMissingOwnership(eventType)) {
            console.warn('stripe-webhook: unknown owner for entitlement event', {
              requestId, eventId, eventType,
            })
            return new Response('User not found — retry pending', { status: 500 })
          }
          return new Response('ok', { status: 200 })
        }

        const periodEnd = unixToIso(sub.current_period_end as number | null)

        const { error } = await supabaseAdmin
          .from('subscriptions')
          .upsert({
            user_id:                userId,
            stripe_customer_id:     customerId,
            stripe_subscription_id: sub.id as string,
            status:                 sub.status as string,
            current_period_end:     periodEnd,
            cancel_at_period_end:   Boolean(sub.cancel_at_period_end),
            price_id:               incomingPrice,
            updated_at:             new Date().toISOString(),
          }, { onConflict: 'user_id' })

        if (error) {
          console.error('stripe-webhook: subscription upsert failed', {
            requestId, eventId, eventType, dbCode: error.code,
          })
          return new Response('Database write failed', { status: 500 })
        }
        break
      }

      // ── customer.subscription.deleted ─────────────────────────────────────
      // Stripe sends this when a subscription reaches its final canceled state.
      // Pro access is revoked. We update to 'canceled' rather than deleting the
      // row so billing history is preserved for audits and support.
      case 'customer.subscription.deleted': {
        const sub        = eventData
        const customerId = sub.customer as string
        const subMeta    = sub.metadata as Record<string, string> | null

        const { userId, error: lookupError } = await resolveUserId({
          metaUserId:     subMeta?.user_id,
          subscriptionId: sub.id as string | null,
          customerId,
        })

        if (lookupError) {
          return new Response('Ownership lookup failed', { status: 500 })
        }
        if (!userId) {
          if (shouldRetryOnMissingOwnership(eventType)) {
            console.warn('stripe-webhook: unknown owner for subscription.deleted', {
              requestId, eventId, eventType,
            })
            return new Response('User not found — retry pending', { status: 500 })
          }
          return new Response('ok', { status: 200 })
        }

        const { error } = await supabaseAdmin
          .from('subscriptions')
          .update({
            status:     'canceled',
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)

        if (error) {
          console.error('stripe-webhook: subscription.deleted update failed', {
            requestId, eventId, eventType, dbCode: error.code,
          })
          return new Response('Database write failed', { status: 500 })
        }
        break
      }

      // ── invoice.payment_succeeded ──────────────────────────────────────────
      // Fired on successful charge — including renewals. Updates current_period_end
      // so the UI shows the correct next renewal date.
      // (subscription.updated also fires on renewal — belt-and-suspenders update.)
      case 'invoice.payment_succeeded': {
        const invoice    = eventData
        const customerId = invoice.customer as string

        const { userId, error: lookupError } = await resolveUserId({ customerId })
        if (lookupError) {
          return new Response('Ownership lookup failed', { status: 500 })
        }
        if (!userId) {
          // No subscription row yet — checkout.session.completed handles the initial
          // insert. Unknown ownership here is retryable.
          if (shouldRetryOnMissingOwnership(eventType)) {
            return new Response('User not found — retry pending', { status: 500 })
          }
          return new Response('ok', { status: 200 })
        }

        const lines = (invoice.lines as { data: Array<{ period: { end: number } }> } | null)?.data
        const periodEnd = unixToIso(lines?.[0]?.period?.end ?? null)
        if (!periodEnd) break

        const { error } = await supabaseAdmin
          .from('subscriptions')
          .update({ current_period_end: periodEnd, updated_at: new Date().toISOString() })
          .eq('user_id', userId)

        if (error) {
          console.error('stripe-webhook: invoice.payment_succeeded update failed', {
            requestId, eventId, eventType, dbCode: error.code,
          })
          return new Response('Database write failed', { status: 500 })
        }
        break
      }

      // ── invoice.payment_failed ─────────────────────────────────────────────
      // Stripe moves the subscription to 'past_due' status, which is handled by
      // the customer.subscription.updated event. Log here for observability only.
      // No DB write required, so returning 200 is safe.
      case 'invoice.payment_failed': {
        const invoice = eventData
        console.log('stripe-webhook: invoice.payment_failed', {
          requestId,
          eventId,
          eventType,
          attemptCount: invoice.attempt_count,
        })
        break
      }

      default:
        // Unhandled event type — acknowledge and ignore.
        break
    }
  } catch (err) {
    // Unexpected exception during event processing — return 500 so Stripe retries.
    console.error('stripe-webhook: unexpected handler error', {
      requestId,
      eventId,
      eventType,
      error: String(err),
    })
    return new Response('Internal error', { status: 500 })
  }

  // Returning 200 here means: event was either processed successfully, or
  // was intentionally ignored (unhandled type, price mismatch, informational-only event).
  return new Response('ok', { status: 200 })
})
