// Injectable Stripe-webhook orchestration.
//
// This module contains the REAL control flow used in production by index.ts:
//   event-shape validation → idempotency claim → event routing → authoritative
//   Stripe retrieval → ownership resolution → Supabase writes → token-validated
//   finalization → HTTP status/body decision.
//
// index.ts is a thin Deno.serve wrapper that reads env + body, verifies the Stripe
// signature, parses JSON, then calls runWebhookOrchestration() with real
// dependencies. Node tests call the SAME exported function with injected fakes, so
// the tests exercise production control flow rather than a re-implementation.
//
// All external effects are injected via `deps`:
//   supabaseAdmin      — object with .rpc() and .from() (Supabase service-role client)
//   fetchSubscription  — async (subId, stripeKey) => sub object | null
//   env                — { priceId, stripeKey }
//   now                — () => ISO timestamp string (injectable clock)
//   log                — (eventName, fields) => void  (privacy-safe; controlled fields only)
//   requestId          — string correlation id
//
// The function returns { status: number, body: string } — never a Deno Response —
// so it is runtime-agnostic and unit-testable.

import {
  isValidUUID,
  unixToIso,
  shouldRetryOnMissingOwnership,
  extractProSubscriptionSnapshot,
  isUniqueViolation,
} from './webhookHelpers.js'
import {
  validateEventShape,
  validateAuthoritativeSub,
  isAllowedSubscriptionStatus,
  classifyClaim,
} from './webhookOrchestrator.js'

function resp(status, body) {
  return { status, body }
}

const noopLog = () => {}

/**
 * @param {object} args
 * @param {Record<string, unknown>} args.event — parsed, signature-verified Stripe event
 * @param {string} args.requestId
 * @param {object} args.supabaseAdmin
 * @param {(subId: string, stripeKey: string) => Promise<Record<string, unknown>|null>} args.fetchSubscription
 * @param {{ priceId: string, stripeKey: string }} args.env
 * @param {() => string} [args.now]
 * @param {(eventName: string, fields: Record<string, unknown>) => void} [args.log]
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function runWebhookOrchestration({
  event,
  requestId,
  supabaseAdmin,
  fetchSubscription,
  env,
  now = () => new Date().toISOString(),
  log = noopLog,
}) {
  const priceId   = env?.priceId   ?? ''
  const stripeKey  = env?.stripeKey ?? ''

  // ── Event-shape validation (already signature-verified upstream) ──────────────
  // A validly-signed request with a malformed shape is rejected BEFORE the claim,
  // so no idempotency row is persisted for a structurally invalid event.
  const shape = validateEventShape(event)
  if (!shape.valid) {
    log('invalid_event', { requestId, eventType: typeof event?.type === 'string' ? event.type : null })
    return resp(400, 'Invalid event')
  }

  const eventId        = event.id
  const eventType      = event.type
  const eventCreatedAt = unixToIso(event.created)
  const eventData      = event.data.object

  // ── Idempotency claim ─────────────────────────────────────────────────────────
  const { data: claimRaw, error: claimError } = await supabaseAdmin.rpc('claim_webhook_event', {
    p_event_id:   eventId,
    p_event_type: eventType,
    p_created_at: eventCreatedAt ?? now(),
  })

  if (claimError) {
    log('claim_failed', { requestId, eventType })
    return resp(500, 'Claim failed')
  }

  const claim = classifyClaim(claimRaw)
  if (claim.action === 'duplicate')  return resp(200, 'ok')
  if (claim.action === 'in_progress') return resp(503, 'In progress')
  if (claim.action === 'error') {
    log('claim_bad_payload', { requestId, eventType })
    return resp(500, 'Claim failed')
  }

  const claimToken = claim.claimToken

  // ── Token-validated finalization ──────────────────────────────────────────────
  // mark_webhook_event() returns:
  //   error            → RPC itself failed          → treat as 500 (retry)
  //   data === true    → row transitioned to terminal (we still own the claim)
  //   data === false   → claim ownership lost: row was reclaimed by a newer handler
  //                      or is already terminal. We MUST NOT return the intended 200 —
  //                      returning 200 could let Stripe stop retrying while the true
  //                      owner never durably finalized. Return retryable 503 instead.
  async function markEvent(status, failureCode) {
    const { data, error } = await supabaseAdmin.rpc('mark_webhook_event', {
      p_event_id:     eventId,
      p_claim_token:  claimToken,
      p_status:       status,
      p_failure_code: failureCode ?? null,
    })
    if (error) return { ok: false, tokenValid: false }
    return { ok: true, tokenValid: data === true }
  }

  async function finalize(status, failureCode, intended) {
    const mark = await markEvent(status, failureCode)
    if (!mark.ok) {
      log('mark_rpc_error', { requestId, eventType, markStatus: status })
      return resp(500, 'Finalize failed')
    }
    if (!mark.tokenValid) {
      // C1: lost claim ownership — never acknowledge with the intended 200.
      log('claim_ownership_lost', { requestId, eventType, markStatus: status })
      return resp(503, 'Claim superseded')
    }
    return intended
  }

  // ── Ownership resolution ─────────────────────────────────────────────────────
  // Priority: metadata.user_id → subscriptions row by subscription_id → by customer_id.
  // error=true means a DB query itself failed — caller returns 500.
  async function resolveUserId(opts) {
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
        log('ownership_lookup_failed', { requestId, eventType })
        return { userId: null, error: true }
      }
      if (data?.user_id && isValidUUID(data.user_id)) {
        return { userId: data.user_id, error: false }
      }
    }
    if (opts.customerId) {
      const { data, error } = await supabaseAdmin
        .from('subscriptions')
        .select('user_id')
        .eq('stripe_customer_id', opts.customerId)
        .maybeSingle()
      if (error) {
        log('ownership_lookup_failed', { requestId, eventType })
        return { userId: null, error: true }
      }
      if (data?.user_id && isValidUUID(data.user_id)) {
        return { userId: data.user_id, error: false }
      }
    }
    return { userId: null, error: false }
  }

  try {
    switch (eventType) {

      // ── checkout.session.completed ─────────────────────────────────────────
      case 'checkout.session.completed': {
        const session = eventData
        const meta    = session.metadata ?? null
        const userId  = meta?.user_id ?? session.client_reference_id

        if (!userId || !isValidUUID(userId)) {
          log('checkout_missing_user_id', { requestId, eventType })
          return finalize('failed', 'missing_user_id', resp(500, 'Missing user_id'))
        }

        const customerId     = session.customer ?? null
        const subscriptionId = session.subscription ?? null
        if (!customerId || !subscriptionId) {
          log('checkout_missing_ids', { requestId, eventType })
          return finalize('failed', 'missing_ids', resp(500, 'Missing required IDs'))
        }

        if (!stripeKey || !priceId) {
          log('config_missing', { requestId, eventType })
          return finalize('failed', 'config_missing', resp(500, 'Configuration error'))
        }

        const sub = await fetchSubscription(subscriptionId, stripeKey)
        if (!sub) {
          log('stripe_fetch_failed', { requestId, eventType })
          return finalize('failed', 'stripe_fetch_failed', resp(500, 'Stripe fetch failed'))
        }

        // C6: fetched subscription must match the event's IDs before we trust it.
        const authCheck = validateAuthoritativeSub(sub, subscriptionId, customerId)
        if (!authCheck.valid) {
          log('authoritative_mismatch', { requestId, eventType, reason: authCheck.reason })
          return finalize('failed', 'stripe_fetch_failed', resp(500, 'Subscription mismatch'))
        }

        // R3: price validation AND period-end come from the SAME validated Pro item.
        const snap = extractProSubscriptionSnapshot(sub, priceId)
        if (!snap.ok) {
          if (snap.reason === 'no_matching_item' || snap.reason === 'no_items') {
            // No Funnl Pro item present — not our product. Acknowledge and ignore.
            log('price_mismatch', { requestId, eventType })
            return finalize('ignored', undefined, resp(200, 'ok'))
          }
          // Our price but a malformed / mixed / period-less item — fail closed.
          log('invalid_subscription_item', { requestId, eventType, reason: snap.reason })
          return finalize('failed', 'invalid_subscription_item', resp(500, 'Invalid subscription item'))
        }

        const subStatus = sub.status
        if (!isAllowedSubscriptionStatus(subStatus)) {
          log('invalid_status', { requestId, eventType })
          return finalize('failed', 'invalid_status', resp(500, 'Invalid status'))
        }

        const { error } = await supabaseAdmin
          .from('subscriptions')
          .upsert({
            user_id:                userId,
            stripe_customer_id:     sub.customer,
            stripe_subscription_id: sub.id,
            status:                 subStatus,
            current_period_end:     snap.periodEndIso,
            cancel_at_period_end:   Boolean(sub.cancel_at_period_end),
            price_id:               snap.priceId,
            updated_at:             now(),
          }, { onConflict: 'user_id' })

        if (error) {
          // R6: a unique-violation means this Stripe identity is already attached to a
          // different Funnl user — fail closed (never overwrite another user's row).
          const code = isUniqueViolation(error) ? 'identity_conflict' : 'db_write_failed'
          log(code, { requestId, eventType })
          return finalize('failed', code, resp(500, 'Database write failed'))
        }
        return finalize('processed', undefined, resp(200, 'ok'))
      }

      // ── customer.subscription.created / updated ────────────────────────────
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const eventSub   = eventData
        // Event snapshot IDs are used ONLY as expected values for validation.
        const expectedSubId      = eventSub.id
        const expectedCustomerId = eventSub.customer

        if (!stripeKey || !priceId) {
          log('config_missing', { requestId, eventType })
          return finalize('failed', 'config_missing', resp(500, 'Configuration error'))
        }

        const sub = await fetchSubscription(expectedSubId, stripeKey)
        if (!sub) {
          log('stripe_fetch_failed', { requestId, eventType })
          return finalize('failed', 'stripe_fetch_failed', resp(500, 'Stripe fetch failed'))
        }

        // C6: fetched subscription must match the event's IDs.
        const authCheck = validateAuthoritativeSub(sub, expectedSubId, expectedCustomerId)
        if (!authCheck.valid) {
          log('authoritative_mismatch', { requestId, eventType, reason: authCheck.reason })
          return finalize('failed', 'stripe_fetch_failed', resp(500, 'Subscription mismatch'))
        }

        // From here on, use ONLY the authoritative fetched subscription.
        // R3: price validation AND period-end come from the SAME validated Pro item.
        const snap = extractProSubscriptionSnapshot(sub, priceId)
        if (!snap.ok) {
          if (snap.reason === 'no_matching_item' || snap.reason === 'no_items') {
            // No Funnl Pro item present — not our product. Acknowledge and ignore.
            log('price_mismatch', { requestId, eventType })
            return finalize('ignored', undefined, resp(200, 'ok'))
          }
          log('invalid_subscription_item', { requestId, eventType, reason: snap.reason })
          return finalize('failed', 'invalid_subscription_item', resp(500, 'Invalid subscription item'))
        }

        // C2: ownership resolution uses the FETCHED subscription's metadata + IDs,
        // never the (possibly stale) event snapshot.
        const fetchedMetaUserId = sub.metadata?.user_id ?? null
        const { userId, error: lookupError } = await resolveUserId({
          metaUserId:     fetchedMetaUserId,
          subscriptionId: sub.id,
          customerId:     sub.customer,
        })

        if (lookupError) {
          return finalize('failed', 'ownership_lookup_failed', resp(500, 'Ownership lookup failed'))
        }
        if (!userId) {
          if (shouldRetryOnMissingOwnership(eventType)) {
            log('owner_not_found', { requestId, eventType })
            return finalize('failed', 'owner_not_found', resp(500, 'User not found - retry pending'))
          }
          return finalize('ignored', undefined, resp(200, 'ok'))
        }

        const subStatus = sub.status
        if (!isAllowedSubscriptionStatus(subStatus)) {
          log('invalid_status', { requestId, eventType })
          return finalize('failed', 'invalid_status', resp(500, 'Invalid status'))
        }

        const { error } = await supabaseAdmin
          .from('subscriptions')
          .upsert({
            user_id:                userId,
            stripe_customer_id:     sub.customer,
            stripe_subscription_id: sub.id,
            status:                 subStatus,
            current_period_end:     snap.periodEndIso,
            cancel_at_period_end:   Boolean(sub.cancel_at_period_end),
            price_id:               snap.priceId,
            updated_at:             now(),
          }, { onConflict: 'user_id' })

        if (error) {
          // R6: unique-violation → Stripe identity already attached to another user.
          const code = isUniqueViolation(error) ? 'identity_conflict' : 'db_write_failed'
          log(code, { requestId, eventType })
          return finalize('failed', code, resp(500, 'Database write failed'))
        }
        return finalize('processed', undefined, resp(200, 'ok'))
      }

      // ── customer.subscription.deleted ─────────────────────────────────────
      // C5: cancel only the row matching BOTH user_id AND stripe_subscription_id so
      // a late delete cannot cancel a newer subscription that replaced this one.
      case 'customer.subscription.deleted': {
        const eventSub   = eventData
        const subId      = eventSub.id
        const customerId = eventSub.customer
        const subMeta    = eventSub.metadata ?? null

        const { userId, error: lookupError } = await resolveUserId({
          metaUserId:     subMeta?.user_id,
          subscriptionId: subId,
          customerId,
        })

        if (lookupError) {
          return finalize('failed', 'ownership_lookup_failed', resp(500, 'Ownership lookup failed'))
        }
        if (!userId) {
          if (shouldRetryOnMissingOwnership(eventType)) {
            log('owner_not_found', { requestId, eventType })
            return finalize('failed', 'owner_not_found', resp(500, 'User not found - retry pending'))
          }
          return finalize('ignored', undefined, resp(200, 'ok'))
        }

        const { data: updated, error } = await supabaseAdmin
          .from('subscriptions')
          .update({ status: 'canceled', updated_at: now() })
          .eq('user_id', userId)
          .eq('stripe_subscription_id', subId)
          .select('user_id')

        if (error) {
          log('db_write_failed', { requestId, eventType })
          return finalize('failed', 'db_write_failed', resp(500, 'Database write failed'))
        }
        if (!updated || updated.length === 0) {
          // Superseded by a newer subscription — benign no-op, not an error.
          log('deletion_superseded', { requestId, eventType })
          return finalize('ignored', undefined, resp(200, 'ok'))
        }
        return finalize('processed', undefined, resp(200, 'ok'))
      }

      // ── invoice.payment_succeeded / invoice.payment_failed ─────────────────
      // C7: informational only — no subscription DB writes. The authoritative
      // period/status is applied by customer.subscription.updated.
      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed': {
        log('invoice_informational', { requestId, eventType })
        return finalize('ignored', undefined, resp(200, 'ok'))
      }

      default:
        return finalize('ignored', undefined, resp(200, 'ok'))
    }
  } catch {
    log('handler_exception', { requestId, eventType })
    return finalize('failed', 'handler_exception', resp(500, 'Internal error'))
  }
}
