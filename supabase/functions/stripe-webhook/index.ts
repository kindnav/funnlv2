import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  isValidUUID,
  extractPriceId,
  unixToIso,
  shouldRetryOnMissingOwnership,
} from './webhookHelpers.js'

// ── Stripe HMAC-SHA256 signature verification ──────────────────────────────────
// Done manually via Deno's crypto.subtle — no external Stripe SDK required.
//
// Stripe sends: stripe-signature: t=TIMESTAMP,v1=SIG[,v1=SIG2,...]
// Signed payload = "${timestamp}.${rawBody}"
// Expected signature = HMAC-SHA256(webhookSecret, signedPayload), hex-encoded.
// Replay protection: reject events older than 5 minutes.
//
// Security: uses crypto.subtle.verify (constant-time) — never string equality.
// Key is imported for ['verify'] usage only.
// Multiple v1 signatures are supported for Stripe key rotation.
// Malformed hex signatures are silently skipped.

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
  const payloadBytes  = new TextEncoder().encode(signedPayload)
  const secretBytes   = new TextEncoder().encode(secret)

  // Import key for VERIFY usage — required by crypto.subtle.verify.
  const key = await crypto.subtle.importKey(
    'raw', secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['verify'],
  )

  // Check each v1 signature with constant-time crypto.subtle.verify.
  // Stripe may send multiple signatures during key rotation — match any one.
  for (const part of v1Parts) {
    const hexSig = part.slice(3)
    // Reject malformed hex: odd length or non-hex characters.
    if (!hexSig || hexSig.length % 2 !== 0) continue
    if (!/^[0-9a-fA-F]+$/.test(hexSig)) continue
    const sigBytes = new Uint8Array(hexSig.length / 2)
    for (let i = 0; i < hexSig.length; i += 2) {
      sigBytes[i / 2] = parseInt(hexSig.slice(i, i + 2), 16)
    }
    const isMatch = await crypto.subtle.verify('HMAC', key, sigBytes, payloadBytes)
    if (isMatch) return true
  }
  return false
}

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

// ── Webhook handler ────────────────────────────────────────────────────────────
//
// HTTP response semantics:
//   200 — Event received and processed (or safely ignored for a documented reason)
//   400 — Event rejected (bad signature, invalid JSON, replay attack)
//   500 — Processing failed; Stripe WILL retry delivery
//   503 — Event already in progress on another handler; Stripe WILL retry
//
// CRITICAL: Any required DB write failure returns 500. This triggers Stripe retries
// and prevents silent subscription data loss. A 200 means the event was durably
// processed, not just received.
//
// Idempotency: every event is claimed via claim_webhook_event() before processing.
// Duplicate deliveries return 200 immediately. Failed events are reclaimed on the
// next Stripe delivery and retried. Stale 'processing' rows (crashed handlers)
// are reclaimed after 5 minutes.

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

  const eventId        = event.id as string | undefined
  const eventType      = event.type as string
  const eventCreatedAt = unixToIso(event.created as number)
  const eventData      = (event.data as Record<string, unknown>)?.object as Record<string, unknown>

  if (!eventData) {
    // Unknown event shape — acknowledge and ignore.
    return new Response('ok', { status: 200 })
  }

  // ── Service-role client — bypasses RLS for all writes ─────────────────────
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  )

  // ── Idempotency claim ──────────────────────────────────────────────────────
  // Every event with an ID is claimed before any processing begins.
  // claim_webhook_event() atomically:
  //   - Inserts a 'processing' row for new events           → returns 'claimed'
  //   - Finds a 'processed'/'ignored' row for duplicates    → returns 'duplicate'
  //   - Reclaims 'failed' rows for retry                    → returns 'claimed'
  //   - Reclaims stale 'processing' rows (crashed handlers) → returns 'claimed'
  //   - Returns 'in_progress' for a recent active handler   → caller returns 503
  //
  // Events without an eventId (non-standard shape) skip idempotency and are
  // handled once. Stripe always sends an event ID so this is a defensive guard.
  let eventClaimed = false

  if (eventId) {
    const { data: claim, error: claimError } = await supabaseAdmin
      .rpc('claim_webhook_event', {
        p_event_id:   eventId,
        p_event_type: eventType,
        p_created_at: eventCreatedAt ?? new Date().toISOString(),
      })

    if (claimError) {
      console.error('stripe-webhook: idempotency claim failed', {
        requestId, eventType, dbCode: claimError.code,
      })
      return new Response('Claim failed', { status: 500 })
    }

    if (claim === 'duplicate') {
      // Already processed — safe to acknowledge.
      return new Response('ok', { status: 200 })
    }

    if (claim === 'in_progress') {
      // Another handler is actively processing this event — ask Stripe to retry later.
      return new Response('In progress', { status: 503 })
    }

    // claim === 'claimed' — proceed with processing.
    eventClaimed = true
  }

  // Helper: mark the event's final status in the idempotency table.
  // Best-effort: if this call fails, the row stays in 'processing' and will
  // be reclaimed as stale after 5 minutes by the next Stripe delivery.
  async function markEvent(status: 'processed' | 'ignored' | 'failed', failureCode?: string): Promise<void> {
    if (!eventClaimed || !eventId) return
    await supabaseAdmin
      .from('stripe_webhook_events')
      .update({
        status,
        processed_at: new Date().toISOString(),
        ...(failureCode ? { failure_code: failureCode } : {}),
      })
      .eq('event_id', eventId)
      .catch(() => { /* stale processing row — reclaimable after 5 min */ })
  }

  // ── Ownership resolution ─────────────────────────────────────────────────
  // Resolves the Supabase user_id from a Stripe event in priority order:
  //   1. subscription metadata.user_id (set via subscription_data.metadata in checkout session)
  //   2. existing subscriptions row matched by stripe_subscription_id
  //   3. existing subscriptions row matched by stripe_customer_id
  //
  // Returns error=true when a DB query itself failed — caller must return 500.
  async function resolveUserId(opts: {
    metaUserId?: string | null
    subscriptionId?: string | null
    customerId?: string | null
  }): Promise<{ userId: string | null; error: boolean }> {
    if (opts.metaUserId && isValidUUID(opts.metaUserId)) {
      return { userId: opts.metaUserId, error: false }
    }

    if (opts.subscriptionId) {
      const { data, error } = await supabaseAdmin
        .from('subscriptions')
        .select('user_id')
        .eq('stripe_subscription_id', opts.subscriptionId)
        .maybeSingle()
      if (error) {
        console.error('stripe-webhook: subscription ID lookup failed', {
          requestId, eventType, dbCode: error.code,
        })
        return { userId: null, error: true }
      }
      if (data?.user_id && isValidUUID(data.user_id as string)) {
        return { userId: data.user_id as string, error: false }
      }
    }

    if (opts.customerId) {
      const { data, error } = await supabaseAdmin
        .from('subscriptions')
        .select('user_id')
        .eq('stripe_customer_id', opts.customerId)
        .maybeSingle()
      if (error) {
        console.error('stripe-webhook: customer ID lookup failed', {
          requestId, eventType, dbCode: error.code,
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
      // First event when a user completes Checkout. Fetches authoritative
      // subscription state from Stripe rather than trusting the event payload.
      // Missing userId, customerId, or subscriptionId → 500 (not retryable data
      // issue in our session creation → log as error so we can investigate).
      case 'checkout.session.completed': {
        const session = eventData
        const meta    = session.metadata as Record<string, string> | null
        const userId  = (meta?.user_id ?? session.client_reference_id) as string | undefined

        if (!userId || !isValidUUID(userId)) {
          console.error('stripe-webhook: checkout.session.completed missing valid user_id', {
            requestId, eventType,
          })
          await markEvent('failed', 'missing_user_id')
          return new Response('Missing user_id', { status: 500 })
        }

        const customerId     = session.customer as string | null
        const subscriptionId = (session.subscription as string | null) ?? null

        if (!customerId || !subscriptionId) {
          console.error('stripe-webhook: checkout.session.completed missing customer or subscription ID', {
            requestId, eventType,
          })
          await markEvent('failed', 'missing_ids')
          return new Response('Missing required IDs', { status: 500 })
        }

        // Config guard — must have both keys before any Stripe call.
        if (!stripeKey) {
          console.error('stripe-webhook: STRIPE_SECRET_KEY not set', { requestId, eventType })
          await markEvent('failed', 'config_missing')
          return new Response('Configuration error', { status: 500 })
        }
        if (!priceId) {
          console.error('stripe-webhook: STRIPE_PRO_PRICE_ID not set', { requestId, eventType })
          await markEvent('failed', 'config_missing')
          return new Response('Configuration error', { status: 500 })
        }

        // Fetch authoritative subscription state from Stripe.
        const sub = await fetchStripeSubscription(subscriptionId, stripeKey)
        if (!sub) {
          console.error('stripe-webhook: failed to fetch subscription from Stripe', {
            requestId, eventType,
          })
          await markEvent('failed', 'stripe_fetch_failed')
          return new Response('Stripe fetch failed', { status: 500 })
        }

        // Price validation (fail-closed): only write for our Pro price.
        const subPrice = extractPriceId(sub)
        if (!subPrice || subPrice !== priceId) {
          // Wrong or missing price — this checkout is not for our Pro product.
          console.warn('stripe-webhook: checkout subscription price mismatch — ignoring', {
            requestId, eventType,
          })
          await markEvent('ignored')
          return new Response('ok', { status: 200 })
        }

        const periodEnd = unixToIso(sub.current_period_end as number | null)

        const { error } = await supabaseAdmin
          .from('subscriptions')
          .upsert({
            user_id:                userId,
            stripe_customer_id:     customerId,
            stripe_subscription_id: subscriptionId,
            status:                 sub.status as string,
            current_period_end:     periodEnd,
            cancel_at_period_end:   Boolean(sub.cancel_at_period_end),
            price_id:               subPrice,
            updated_at:             new Date().toISOString(),
          }, { onConflict: 'user_id' })

        if (error) {
          console.error('stripe-webhook: checkout upsert failed', {
            requestId, eventType, dbCode: error.code,
          })
          await markEvent('failed', 'db_write_failed')
          return new Response('Database write failed', { status: 500 })
        }
        break
      }

      // ── customer.subscription.created / updated ────────────────────────────
      // Fetches authoritative state from Stripe — eliminates out-of-order issues.
      // Price validation (fail-closed):
      //   missing STRIPE_PRO_PRICE_ID  → 500 (config issue)
      //   subscription has no price    → acknowledged as 200 (not our product)
      //   price mismatch               → acknowledged as 200 (not our product)
      //   exact match                  → write subscription row
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const eventSub   = eventData
        const subId      = eventSub.id as string
        const customerId = eventSub.customer as string
        const subMeta    = eventSub.metadata as Record<string, string> | null

        // Config guards (fail-closed).
        if (!stripeKey) {
          console.error('stripe-webhook: STRIPE_SECRET_KEY not set', { requestId, eventType })
          await markEvent('failed', 'config_missing')
          return new Response('Configuration error', { status: 500 })
        }
        if (!priceId) {
          console.error('stripe-webhook: STRIPE_PRO_PRICE_ID not set', { requestId, eventType })
          await markEvent('failed', 'config_missing')
          return new Response('Configuration error', { status: 500 })
        }

        // Fetch authoritative subscription state — ignores event payload ordering.
        const sub = await fetchStripeSubscription(subId, stripeKey)
        if (!sub) {
          console.error('stripe-webhook: failed to fetch subscription from Stripe', {
            requestId, eventType,
          })
          await markEvent('failed', 'stripe_fetch_failed')
          return new Response('Stripe fetch failed', { status: 500 })
        }

        // Price validation (fail-closed).
        const incomingPrice = extractPriceId(sub)
        if (!incomingPrice) {
          // Subscription has no extractable price — not our product.
          await markEvent('ignored')
          return new Response('ok', { status: 200 })
        }
        if (incomingPrice !== priceId) {
          // Wrong price — not our Pro subscription.
          console.warn('stripe-webhook: subscription price mismatch — ignoring', {
            requestId, eventType,
          })
          await markEvent('ignored')
          return new Response('ok', { status: 200 })
        }

        // Resolve user ownership.
        const { userId, error: lookupError } = await resolveUserId({
          metaUserId:     subMeta?.user_id,
          subscriptionId: subId,
          customerId,
        })

        if (lookupError) {
          await markEvent('failed', 'ownership_lookup_failed')
          return new Response('Ownership lookup failed', { status: 500 })
        }
        if (!userId) {
          if (shouldRetryOnMissingOwnership(eventType)) {
            console.warn('stripe-webhook: unknown owner for entitlement event', {
              requestId, eventType,
            })
            await markEvent('failed', 'owner_not_found')
            return new Response('User not found — retry pending', { status: 500 })
          }
          await markEvent('ignored')
          return new Response('ok', { status: 200 })
        }

        const periodEnd = unixToIso(sub.current_period_end as number | null)

        const { error } = await supabaseAdmin
          .from('subscriptions')
          .upsert({
            user_id:                userId,
            stripe_customer_id:     customerId,
            stripe_subscription_id: subId,
            status:                 sub.status as string,
            current_period_end:     periodEnd,
            cancel_at_period_end:   Boolean(sub.cancel_at_period_end),
            price_id:               incomingPrice,
            updated_at:             new Date().toISOString(),
          }, { onConflict: 'user_id' })

        if (error) {
          console.error('stripe-webhook: subscription upsert failed', {
            requestId, eventType, dbCode: error.code,
          })
          await markEvent('failed', 'db_write_failed')
          return new Response('Database write failed', { status: 500 })
        }
        break
      }

      // ── customer.subscription.deleted ─────────────────────────────────────
      // Fetches authoritative state from Stripe to confirm final canceled status.
      // Updates to 'canceled' rather than deleting — preserves billing history.
      case 'customer.subscription.deleted': {
        const eventSub   = eventData
        const subId      = eventSub.id as string
        const customerId = eventSub.customer as string
        const subMeta    = eventSub.metadata as Record<string, string> | null

        const { userId, error: lookupError } = await resolveUserId({
          metaUserId:     subMeta?.user_id,
          subscriptionId: subId,
          customerId,
        })

        if (lookupError) {
          await markEvent('failed', 'ownership_lookup_failed')
          return new Response('Ownership lookup failed', { status: 500 })
        }
        if (!userId) {
          if (shouldRetryOnMissingOwnership(eventType)) {
            console.warn('stripe-webhook: unknown owner for subscription.deleted', {
              requestId, eventType,
            })
            await markEvent('failed', 'owner_not_found')
            return new Response('User not found — retry pending', { status: 500 })
          }
          await markEvent('ignored')
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
            requestId, eventType, dbCode: error.code,
          })
          await markEvent('failed', 'db_write_failed')
          return new Response('Database write failed', { status: 500 })
        }
        break
      }

      // ── invoice.payment_succeeded ──────────────────────────────────────────
      // Updates current_period_end on successful charge / renewal.
      // Belt-and-suspenders: subscription.updated fires on renewal too.
      case 'invoice.payment_succeeded': {
        const invoice    = eventData
        const customerId = invoice.customer as string

        const { userId, error: lookupError } = await resolveUserId({ customerId })
        if (lookupError) {
          await markEvent('failed', 'ownership_lookup_failed')
          return new Response('Ownership lookup failed', { status: 500 })
        }
        if (!userId) {
          if (shouldRetryOnMissingOwnership(eventType)) {
            await markEvent('failed', 'owner_not_found')
            return new Response('User not found — retry pending', { status: 500 })
          }
          await markEvent('ignored')
          return new Response('ok', { status: 200 })
        }

        const lines     = (invoice.lines as { data: Array<{ period: { end: number } }> } | null)?.data
        const periodEnd = unixToIso(lines?.[0]?.period?.end ?? null)
        if (!periodEnd) {
          await markEvent('ignored')
          break
        }

        const { error } = await supabaseAdmin
          .from('subscriptions')
          .update({ current_period_end: periodEnd, updated_at: new Date().toISOString() })
          .eq('user_id', userId)

        if (error) {
          console.error('stripe-webhook: invoice.payment_succeeded update failed', {
            requestId, eventType, dbCode: error.code,
          })
          await markEvent('failed', 'db_write_failed')
          return new Response('Database write failed', { status: 500 })
        }
        break
      }

      // ── invoice.payment_failed ─────────────────────────────────────────────
      // Stripe moves the subscription to 'past_due' — handled by
      // customer.subscription.updated. Acknowledged here for observability only.
      case 'invoice.payment_failed': {
        console.log('stripe-webhook: invoice.payment_failed received', {
          requestId, eventType,
        })
        await markEvent('ignored')
        return new Response('ok', { status: 200 })
      }

      default:
        // Unhandled event type — acknowledge and ignore.
        await markEvent('ignored')
        return new Response('ok', { status: 200 })
    }
  } catch {
    // Unexpected exception during event processing — return 500 so Stripe retries.
    console.error('stripe-webhook: unexpected handler error', {
      requestId, eventType,
    })
    await markEvent('failed', 'handler_exception')
    return new Response('Internal error', { status: 500 })
  }

  // Reaching here means the switch case completed successfully (no early return).
  await markEvent('processed')
  return new Response('ok', { status: 200 })
})
