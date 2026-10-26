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
  crossCheckOwnership,
  extractInvoiceEvidence,
  invoiceSubscriptionId,
  stripeKeyMode,
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
 * @param {(invoiceId: string, stripeKey: string) => Promise<Record<string, unknown>|'timeout'|null>} [args.fetchInvoice]
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
  fetchInvoice = async () => null,
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

  // Payment evidence from the subscription's latest invoice, applied after a subscription write. Only a
  // verified PAID invoice is recorded here (it advances the paid period and can end a failed renewal's
  // grace); failure times come only from invoice.payment_failed events. Returns null on success, or the
  // finalize() result to return.
  async function applyLatestPaidInvoice(sub, userId, prices) {
    const latest = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id
    if (!latest) return null
    const inv = await fetchInvoice(latest, stripeKey)
    if (inv === 'timeout') return finalize('failed', 'provider_timeout', resp(503, 'Provider timeout'))
    if (!inv) return finalize('failed', 'stripe_fetch_failed', resp(500, 'Stripe fetch failed'))
    const ev = extractInvoiceEvidence(inv, { subscriptionId: sub.id, customerId: sub.customer, priceIds: prices, mode: stripeKeyMode(stripeKey) })
    if (!ev.ok) {
      if (ev.reason === 'ownership_mismatch' || ev.reason === 'environment_mismatch') {
        log('invoice_ownership_mismatch', { requestId, eventType })
        return finalize('failed', 'ownership_mismatch', resp(500, 'Invoice mismatch'))
      }
      return null   // a latest invoice we cannot read as evidence (e.g. proration) proves nothing either way
    }
    if (ev.kind !== 'paid') return null
    const { data, error } = await supabaseAdmin.rpc('apply_subscription_evidence', {
      p_user_id: userId, p_subscription_id: sub.id, p_customer_id: sub.customer, p_kind: 'paid',
      p_invoice_id: ev.invoiceId, p_invoice_created: ev.createdIso, p_paid_period_end: ev.periodEndIso, p_failed_at: null,
    })
    if (error || !data?.result) {
      log('db_write_failed', { requestId, eventType })
      return finalize('failed', 'db_write_failed', resp(500, 'Database write failed'))
    }
    return null
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
        if (sub === 'timeout') {
          // Bounded Stripe retrieval timed out — retryable. Finalize the claimed event
          // as failed (token-safe) so Stripe retries and the event can be reclaimed.
          log('provider_timeout', { requestId, eventType })
          return finalize('failed', 'provider_timeout', resp(503, 'Provider timeout'))
        }
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
          // Only a subscription whose items exist but do NOT include our configured
          // price is provably "not our product" → acknowledge and ignore (200).
          if (snap.reason === 'no_matching_item') {
            log('price_mismatch', { requestId, eventType })
            return finalize('ignored', undefined, resp(200, 'ok'))
          }
          // Every other reason (no_items, malformed_items, multiple_matching_items,
          // unsupported_item_configuration, no_period_end) is a malformed/ambiguous
          // authoritative response — fail closed so Stripe retries, rather than
          // silently 200-acknowledging and risking a permanently locked paying user.
          log('invalid_subscription_item', { requestId, eventType, reason: snap.reason })
          return finalize('failed', 'invalid_subscription_item', resp(500, 'Invalid subscription item'))
        }

        // P6: the authoritative subscription's metadata.user_id (if present) must match
        // the resolved Checkout Session user. A mismatch means the fetched subscription
        // belongs to a different Funnl user than the session — never write; fail closed.
        const checkoutCross = crossCheckOwnership(sub.metadata?.user_id ?? null, userId)
        if (checkoutCross.mismatch) {
          log('ownership_mismatch', { requestId, eventType })
          return finalize('failed', 'ownership_mismatch', resp(500, 'Ownership mismatch'))
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
            current_period_start:   snap.periodStartIso,
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
        const paidStep = await applyLatestPaidInvoice(sub, userId, [snap.priceId])
        if (paidStep) return paidStep
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
        if (sub === 'timeout') {
          log('provider_timeout', { requestId, eventType })
          return finalize('failed', 'provider_timeout', resp(503, 'Provider timeout'))
        }
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
        let snap = extractProSubscriptionSnapshot(sub, priceId)
        // A subscription already bound to a Funnl user (same subscription AND customer in our table) keeps
        // receiving legitimate updates on the price it was bought at, even when today's checkout price
        // differs. An unbound subscription on another price is still "not our product".
        if (!snap.ok && snap.reason === 'no_matching_item') {
          const { data: bound, error: boundError } = await supabaseAdmin
            .from('subscriptions')
            .select('user_id, price_id, stripe_customer_id')
            .eq('stripe_subscription_id', sub.id)
            .maybeSingle()
          if (boundError) {
            log('ownership_lookup_failed', { requestId, eventType })
            return finalize('failed', 'ownership_lookup_failed', resp(500, 'Ownership lookup failed'))
          }
          if (bound && bound.stripe_customer_id === sub.customer && typeof bound.price_id === 'string' && bound.price_id) {
            const boundSnap = extractProSubscriptionSnapshot(sub, bound.price_id)
            if (boundSnap.ok || boundSnap.reason !== 'no_matching_item') snap = boundSnap
          }
        }
        if (!snap.ok) {
          // Only items that exist but do NOT include our price prove "not our product".
          if (snap.reason === 'no_matching_item') {
            log('price_mismatch', { requestId, eventType })
            return finalize('ignored', undefined, resp(200, 'ok'))
          }
          // no_items / malformed / multiple / no_period_end → malformed authoritative
          // response → fail closed so Stripe retries (never silently 200-acknowledge).
          log('invalid_subscription_item', { requestId, eventType, reason: snap.reason })
          return finalize('failed', 'invalid_subscription_item', resp(500, 'Invalid subscription item'))
        }

        // Ownership resolution uses the FETCHED subscription only. Resolve the DB owner
        // (by subscription/customer id) AND the authoritative metadata owner, then P6
        // cross-check them: if BOTH are present and disagree, refuse to write.
        const fetchedMetaUserId = sub.metadata?.user_id ?? null
        const { userId: dbUserId, error: lookupError } = await resolveUserId({
          subscriptionId: sub.id,
          customerId:     sub.customer,
        })

        if (lookupError) {
          return finalize('failed', 'ownership_lookup_failed', resp(500, 'Ownership lookup failed'))
        }

        // P6: metadata owner vs DB owner. A mismatch means this subscription's Stripe
        // metadata claims a different user than the one that owns the DB row — never
        // write; fail closed (retryable) so it can be investigated.
        const cross = crossCheckOwnership(fetchedMetaUserId, dbUserId)
        if (cross.mismatch) {
          log('ownership_mismatch', { requestId, eventType })
          return finalize('failed', 'ownership_mismatch', resp(500, 'Ownership mismatch'))
        }
        const userId = cross.userId

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
            current_period_start:   snap.periodStartIso,
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
        const paidStep = await applyLatestPaidInvoice(sub, userId, [snap.priceId])
        if (paidStep) return paidStep
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

      // ── invoice.paid / invoice.payment_succeeded / invoice.payment_failed ──────
      // Verified payment evidence (migration 20261023000000). The invoice is RE-FETCHED with the server
      // key and accepted only for the subscription AND customer bound to a Funnl user, in the key's
      // mode. Paid: advances the paid period, and ends a failed renewal's grace only when it is that
      // renewal or a newer invoice. Failed: the event's Stripe timestamp is the failure time; only a
      // RENEWAL (subscription_cycle) gets grace - an initial purchase never does. The database merge is
      // monotonic, so duplicates, retries, delayed delivery and concurrent handlers cannot restart or
      // undo anything.
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed': {
        const mode = stripeKeyMode(stripeKey)
        if (!stripeKey || !priceId || !mode) {
          log('config_missing', { requestId, eventType })
          return finalize('failed', 'config_missing', resp(500, 'Configuration error'))
        }
        const invoiceId = typeof eventData?.id === 'string' ? eventData.id : null
        if (!invoiceId) return finalize('failed', 'missing_ids', resp(500, 'Missing required IDs'))
        const inv = await fetchInvoice(invoiceId, stripeKey)
        if (inv === 'timeout') {
          log('provider_timeout', { requestId, eventType })
          return finalize('failed', 'provider_timeout', resp(503, 'Provider timeout'))
        }
        if (!inv) {
          log('stripe_fetch_failed', { requestId, eventType })
          return finalize('failed', 'stripe_fetch_failed', resp(500, 'Stripe fetch failed'))
        }
        const subId = invoiceSubscriptionId(inv)
        if (!subId) return finalize('ignored', undefined, resp(200, 'ok'))          // not a subscription invoice

        const { data: bound, error: boundError } = await supabaseAdmin
          .from('subscriptions')
          .select('user_id, price_id, stripe_customer_id')
          .eq('stripe_subscription_id', subId)
          .maybeSingle()
        if (boundError) {
          log('ownership_lookup_failed', { requestId, eventType })
          return finalize('failed', 'ownership_lookup_failed', resp(500, 'Ownership lookup failed'))
        }
        if (!bound?.user_id || !isValidUUID(bound.user_id)) {
          // An initial purchase that failed never binds a user: nothing to record, no retry.
          if (eventType === 'invoice.payment_failed' && inv.billing_reason === 'subscription_create') {
            return finalize('ignored', undefined, resp(200, 'ok'))
          }
          log('owner_not_found', { requestId, eventType })
          return finalize('failed', 'owner_not_found', resp(500, 'User not found - retry pending'))
        }

        const prices = [bound.price_id, priceId].filter((p) => typeof p === 'string' && p)
        const ev = extractInvoiceEvidence(inv, { subscriptionId: subId, customerId: bound.stripe_customer_id, priceIds: prices, mode })
        if (!ev.ok) {
          if (ev.reason === 'ownership_mismatch' || ev.reason === 'environment_mismatch') {
            log('invoice_ownership_mismatch', { requestId, eventType })
            return finalize('failed', 'ownership_mismatch', resp(500, 'Invoice mismatch'))
          }
          log('invalid_invoice', { requestId, eventType, reason: ev.reason })
          return finalize('failed', 'invalid_subscription_item', resp(500, 'Invalid invoice'))
        }

        let args = null
        if (ev.kind === 'paid') {
          args = { p_kind: 'paid', p_paid_period_end: ev.periodEndIso, p_failed_at: null }
        } else if (ev.kind === 'failed' && eventType === 'invoice.payment_failed' && ev.renewal) {
          const failedAt = unixToIso(event.created)
          if (!failedAt) return finalize('failed', 'invalid_event', resp(500, 'Invalid event time'))
          args = { p_kind: 'failed', p_paid_period_end: null, p_failed_at: failedAt }
        }
        if (!args) return finalize('ignored', undefined, resp(200, 'ok'))   // initial-purchase failure, or nothing proven

        const { data, error } = await supabaseAdmin.rpc('apply_subscription_evidence', {
          p_user_id: bound.user_id, p_subscription_id: subId, p_customer_id: bound.stripe_customer_id,
          p_invoice_id: ev.invoiceId, p_invoice_created: ev.createdIso, ...args,
        })
        if (error || !data?.result) {
          log('db_write_failed', { requestId, eventType })
          return finalize('failed', 'db_write_failed', resp(500, 'Database write failed'))
        }
        return finalize(data.result === 'applied' ? 'processed' : 'ignored', undefined, resp(200, 'ok'))
      }

      default:
        return finalize('ignored', undefined, resp(200, 'ok'))
    }
  } catch {
    log('handler_exception', { requestId, eventType })
    return finalize('failed', 'handler_exception', resp(500, 'Internal error'))
  }
}
