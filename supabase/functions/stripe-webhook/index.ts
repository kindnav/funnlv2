import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  isValidUUID,
  extractPriceId,
  unixToIso,
  shouldRetryOnMissingOwnership,
} from './webhookHelpers.js'
import {
  validateEventShape,
  validateAuthoritativeSub,
  isAllowedSubscriptionStatus,
  classifyClaim,
} from './webhookOrchestrator.js'

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
//   400 — Event rejected (bad signature, invalid JSON, replay attack, invalid event shape)
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
// are reclaimed after 5 minutes. Finalization uses mark_webhook_event() with the
// claim_token so a stale handler cannot overwrite a newer claimant's row.

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

  // ── C4: Validate event shape ────────────────────────────────────────────────
  // A validly-signed request with a malformed shape indicates a Stripe API change
  // or a bug — reject with 400 rather than silently ignoring. This runs BEFORE the
  // idempotency claim so we never persist a row for a structurally invalid event.
  const shape = validateEventShape(event)
  if (!shape.valid) {
    console.error('stripe-webhook: invalid event shape', {
      requestId,
      eventType: typeof event?.type === 'string' ? event.type : null,
    })
    return new Response('Invalid event', { status: shape.httpStatus })
  }

  const eventId        = event.id as string
  const eventType      = event.type as string
  const eventCreatedAt = unixToIso(event.created as number)
  const eventData      = (event.data as Record<string, unknown>).object as Record<string, unknown>

  // ── Service-role client — bypasses RLS for all writes ─────────────────────
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  )

  // ── Idempotency claim ──────────────────────────────────────────────────────
  // Every event is claimed before any processing begins. claim_webhook_event()
  // returns JSONB atomically:
  //   {result:'claimed', claim_token:<uuid>} → this handler owns processing
  //   {result:'duplicate'}                   → already processed/ignored; 200
  //   {result:'in_progress'}                 → active handler elsewhere; 503
  //
  // The claim_token is required by mark_webhook_event() to finalize the row —
  // this prevents a stale (reclaimed) handler from overwriting a newer claim.
  const { data: claimRaw, error: claimError } = await supabaseAdmin
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

  const claim = classifyClaim(claimRaw)

  if (claim.action === 'duplicate') {
    // Already processed — safe to acknowledge.
    return new Response('ok', { status: 200 })
  }
  if (claim.action === 'in_progress') {
    // Another handler is actively processing this event — ask Stripe to retry later.
    return new Response('In progress', { status: 503 })
  }
  if (claim.action === 'error') {
    // Unexpected claim payload — treat as a transient failure so Stripe retries.
    console.error('stripe-webhook: unexpected claim result', { requestId, eventType })
    return new Response('Claim failed', { status: 500 })
  }

  // claim.action === 'process' — this handler owns the claim.
  const claimToken = claim.claimToken

  // ── C3: Finalize the event via mark_webhook_event() with the claim_token ──────
  // Returns { ok, tokenValid }:
  //   ok=false        → the RPC itself failed (DB error) → caller returns 500
  //   tokenValid=false → the row was reclaimed by a newer handler → non-fatal;
  //                      the newer handler owns finalization, so we do NOT 500
  // A 500 is returned only when the RPC errors, never on a benign token mismatch.
  async function markEvent(
    status: 'processed' | 'ignored' | 'failed',
    failureCode?: string,
  ): Promise<{ ok: boolean; tokenValid: boolean }> {
    const { data, error } = await supabaseAdmin
      .rpc('mark_webhook_event', {
        p_event_id:     eventId,
        p_claim_token:  claimToken,
        p_status:       status,
        p_failure_code: failureCode ?? null,
      })
    if (error) {
      console.error('stripe-webhook: mark_webhook_event failed', {
        requestId, eventType, status, dbCode: error.code,
      })
      return { ok: false, tokenValid: false }
    }
    // data is the boolean returned by the RPC: true = row updated (token matched).
    return { ok: true, tokenValid: data === true }
  }

  // Finalizes with markEvent, then maps the result to an HTTP Response.
  // If the mark RPC errors, we surface 500 so Stripe retries (the row stays
  // in 'processing' and is reclaimable). A benign token mismatch keeps the
  // originally-intended response.
  async function finalize(
    status: 'processed' | 'ignored' | 'failed',
    failureCode: string | undefined,
    intended: Response,
  ): Promise<Response> {
    const mark = await markEvent(status, failureCode)
    if (!mark.ok) {
      return new Response('Finalize failed', { status: 500 })
    }
    return intended
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
      case 'checkout.session.completed': {
        const session = eventData
        const meta    = session.metadata as Record<string, string> | null
        const userId  = (meta?.user_id ?? session.client_reference_id) as string | undefined

        if (!userId || !isValidUUID(userId)) {
          console.error('stripe-webhook: checkout.session.completed missing valid user_id', {
            requestId, eventType,
          })
          return await finalize('failed', 'missing_user_id',
            new Response('Missing user_id', { status: 500 }))
        }

        const customerId     = session.customer as string | null
        const subscriptionId = (session.subscription as string | null) ?? null

        if (!customerId || !subscriptionId) {
          console.error('stripe-webhook: checkout.session.completed missing customer or subscription ID', {
            requestId, eventType,
          })
          return await finalize('failed', 'missing_ids',
            new Response('Missing required IDs', { status: 500 }))
        }

        // Config guard — must have both keys before any Stripe call.
        if (!stripeKey) {
          console.error('stripe-webhook: STRIPE_SECRET_KEY not set', { requestId, eventType })
          return await finalize('failed', 'config_missing',
            new Response('Configuration error', { status: 500 }))
        }
        if (!priceId) {
          console.error('stripe-webhook: STRIPE_PRO_PRICE_ID not set', { requestId, eventType })
          return await finalize('failed', 'config_missing',
            new Response('Configuration error', { status: 500 }))
        }

        // Fetch authoritative subscription state from Stripe.
        const sub = await fetchStripeSubscription(subscriptionId, stripeKey)
        if (!sub) {
          console.error('stripe-webhook: failed to fetch subscription from Stripe', {
            requestId, eventType,
          })
          return await finalize('failed', 'stripe_fetch_failed',
            new Response('Stripe fetch failed', { status: 500 }))
        }

        // C6: Validate the fetched subscription matches the event's IDs. A mismatch
        // means Stripe returned an inconsistent object — refuse to write it.
        const authCheck = validateAuthoritativeSub(sub, subscriptionId, customerId)
        if (!authCheck.valid) {
          console.error('stripe-webhook: authoritative subscription mismatch', {
            requestId, eventType, reason: authCheck.reason,
          })
          return await finalize('failed', 'stripe_fetch_failed',
            new Response('Subscription mismatch', { status: 500 }))
        }

        // Price validation (fail-closed): only write for our Pro price.
        // Uses ONLY the authoritative fetched subscription's fields (C6).
        const subPrice = extractPriceId(sub)
        if (!subPrice || subPrice !== priceId) {
          // Wrong or missing price — this checkout is not for our Pro product.
          console.warn('stripe-webhook: checkout subscription price mismatch — ignoring', {
            requestId, eventType,
          })
          return await finalize('ignored', undefined,
            new Response('ok', { status: 200 }))
        }

        // C8: Validate status against the allowlist before writing.
        const subStatus = sub.status as string
        if (!isAllowedSubscriptionStatus(subStatus)) {
          console.error('stripe-webhook: unknown subscription status — ignoring', {
            requestId, eventType,
          })
          return await finalize('failed', 'invalid_status',
            new Response('Invalid status', { status: 500 }))
        }

        const periodEnd = unixToIso(sub.current_period_end as number | null)

        const { error } = await supabaseAdmin
          .from('subscriptions')
          .upsert({
            user_id:                userId,
            stripe_customer_id:     sub.customer as string,
            stripe_subscription_id: sub.id as string,
            status:                 subStatus,
            current_period_end:     periodEnd,
            cancel_at_period_end:   Boolean(sub.cancel_at_period_end),
            price_id:               subPrice,
            updated_at:             new Date().toISOString(),
          }, { onConflict: 'user_id' })

        if (error) {
          console.error('stripe-webhook: checkout upsert failed', {
            requestId, eventType, dbCode: error.code,
          })
          return await finalize('failed', 'db_write_failed',
            new Response('Database write failed', { status: 500 }))
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
          return await finalize('failed', 'config_missing',
            new Response('Configuration error', { status: 500 }))
        }
        if (!priceId) {
          console.error('stripe-webhook: STRIPE_PRO_PRICE_ID not set', { requestId, eventType })
          return await finalize('failed', 'config_missing',
            new Response('Configuration error', { status: 500 }))
        }

        // Fetch authoritative subscription state — ignores event payload ordering.
        const sub = await fetchStripeSubscription(subId, stripeKey)
        if (!sub) {
          console.error('stripe-webhook: failed to fetch subscription from Stripe', {
            requestId, eventType,
          })
          return await finalize('failed', 'stripe_fetch_failed',
            new Response('Stripe fetch failed', { status: 500 }))
        }

        // C6: Validate the fetched subscription matches the event's IDs.
        const authCheck = validateAuthoritativeSub(sub, subId, customerId)
        if (!authCheck.valid) {
          console.error('stripe-webhook: authoritative subscription mismatch', {
            requestId, eventType, reason: authCheck.reason,
          })
          return await finalize('failed', 'stripe_fetch_failed',
            new Response('Subscription mismatch', { status: 500 }))
        }

        // Price validation (fail-closed) — uses only the fetched subscription (C6).
        const incomingPrice = extractPriceId(sub)
        if (!incomingPrice) {
          // Subscription has no extractable price — not our product.
          return await finalize('ignored', undefined,
            new Response('ok', { status: 200 }))
        }
        if (incomingPrice !== priceId) {
          // Wrong price — not our Pro subscription.
          console.warn('stripe-webhook: subscription price mismatch — ignoring', {
            requestId, eventType,
          })
          return await finalize('ignored', undefined,
            new Response('ok', { status: 200 }))
        }

        // Resolve user ownership.
        const { userId, error: lookupError } = await resolveUserId({
          metaUserId:     subMeta?.user_id,
          subscriptionId: subId,
          customerId,
        })

        if (lookupError) {
          return await finalize('failed', 'ownership_lookup_failed',
            new Response('Ownership lookup failed', { status: 500 }))
        }
        if (!userId) {
          if (shouldRetryOnMissingOwnership(eventType)) {
            console.warn('stripe-webhook: unknown owner for entitlement event', {
              requestId, eventType,
            })
            return await finalize('failed', 'owner_not_found',
              new Response('User not found — retry pending', { status: 500 }))
          }
          return await finalize('ignored', undefined,
            new Response('ok', { status: 200 }))
        }

        // C8: Validate status against the allowlist before writing.
        const subStatus = sub.status as string
        if (!isAllowedSubscriptionStatus(subStatus)) {
          console.error('stripe-webhook: unknown subscription status — ignoring', {
            requestId, eventType,
          })
          return await finalize('failed', 'invalid_status',
            new Response('Invalid status', { status: 500 }))
        }

        const periodEnd = unixToIso(sub.current_period_end as number | null)

        const { error } = await supabaseAdmin
          .from('subscriptions')
          .upsert({
            user_id:                userId,
            stripe_customer_id:     sub.customer as string,
            stripe_subscription_id: sub.id as string,
            status:                 subStatus,
            current_period_end:     periodEnd,
            cancel_at_period_end:   Boolean(sub.cancel_at_period_end),
            price_id:               incomingPrice,
            updated_at:             new Date().toISOString(),
          }, { onConflict: 'user_id' })

        if (error) {
          console.error('stripe-webhook: subscription upsert failed', {
            requestId, eventType, dbCode: error.code,
          })
          return await finalize('failed', 'db_write_failed',
            new Response('Database write failed', { status: 500 }))
        }
        break
      }

      // ── customer.subscription.deleted ─────────────────────────────────────
      // Marks the subscription 'canceled' rather than deleting — preserves history.
      // C5: The UPDATE matches BOTH user_id AND stripe_subscription_id so a late
      // 'deleted' event cannot cancel a newer subscription that replaced this one.
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
          return await finalize('failed', 'ownership_lookup_failed',
            new Response('Ownership lookup failed', { status: 500 }))
        }
        if (!userId) {
          if (shouldRetryOnMissingOwnership(eventType)) {
            console.warn('stripe-webhook: unknown owner for subscription.deleted', {
              requestId, eventType,
            })
            return await finalize('failed', 'owner_not_found',
              new Response('User not found — retry pending', { status: 500 }))
          }
          return await finalize('ignored', undefined,
            new Response('ok', { status: 200 }))
        }

        // C5: match both user_id AND stripe_subscription_id.
        const { data: updated, error } = await supabaseAdmin
          .from('subscriptions')
          .update({
            status:     'canceled',
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)
          .eq('stripe_subscription_id', subId)
          .select('user_id')

        if (error) {
          console.error('stripe-webhook: subscription.deleted update failed', {
            requestId, eventType, dbCode: error.code,
          })
          return await finalize('failed', 'db_write_failed',
            new Response('Database write failed', { status: 500 }))
        }

        // Zero rows updated → this subscription is not the current row (it was
        // superseded by a newer subscription). This is a benign no-op, not an error.
        if (!updated || updated.length === 0) {
          console.log('stripe-webhook: subscription.deleted matched no current row — superseded, ignoring', {
            requestId, eventType,
          })
          return await finalize('ignored', undefined,
            new Response('ok', { status: 200 }))
        }
        break
      }

      // ── invoice.payment_succeeded / invoice.payment_failed ─────────────────
      // C7: Invoice events are informational only — no DB writes. The authoritative
      // subscription state (current_period_end, past_due, etc.) is applied by
      // customer.subscription.updated, which fetches the live subscription from
      // Stripe. Writing here would duplicate that path and risk out-of-order data.
      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed': {
        console.log('stripe-webhook: invoice event received (informational only)', {
          requestId, eventType,
        })
        return await finalize('ignored', undefined,
          new Response('ok', { status: 200 }))
      }

      default:
        // Unhandled event type — acknowledge and ignore.
        return await finalize('ignored', undefined,
          new Response('ok', { status: 200 }))
    }
  } catch {
    // Unexpected exception during event processing — return 500 so Stripe retries.
    console.error('stripe-webhook: unexpected handler error', {
      requestId, eventType,
    })
    return await finalize('failed', 'handler_exception',
      new Response('Internal error', { status: 500 }))
  }

  // Reaching here means a switch case completed successfully (no early return).
  return await finalize('processed', undefined,
    new Response('ok', { status: 200 }))
})
