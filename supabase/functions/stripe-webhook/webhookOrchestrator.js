// Pure orchestration helpers for the stripe-webhook Edge Function.
// Zero external imports beyond webhookHelpers — safe to unit-test in Node.js.
//
// These functions encapsulate the decision logic for each correction so that:
//   - The decisions can be unit-tested without a Deno environment
//   - index.ts stays thin and delegates judgment to this module
//
// Nothing here does I/O (no Supabase, no Stripe, no Deno). Callers inject
// any data that comes from external systems.

import { isValidEventId, isValidStatus } from './webhookHelpers.js'

// ── C4: Event shape validation ─────────────────────────────────────────────────

/**
 * Validates that a signed Stripe event has the required shape.
 *
 * Called AFTER signature verification — a bad shape on a validly-signed request
 * indicates a Stripe API change or a bug in our parsing, so 400 is correct.
 *
 * @param {unknown} event — parsed JSON body
 * @returns {{ valid: true } | { valid: false, code: string, httpStatus: number }}
 */
export function validateEventShape(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { valid: false, code: 'invalid_event', httpStatus: 400 }
  }

  // event.id must be a valid Stripe event ID (evt_xxx format).
  if (!isValidEventId(event.id)) {
    return { valid: false, code: 'invalid_event', httpStatus: 400 }
  }

  // event.type must be a non-empty string no longer than 256 characters.
  if (typeof event.type !== 'string' || event.type.length === 0 || event.type.length > 256) {
    return { valid: false, code: 'invalid_event', httpStatus: 400 }
  }

  // event.created must be a positive integer (Unix epoch seconds from Stripe).
  if (!Number.isInteger(event.created) || event.created <= 0) {
    return { valid: false, code: 'invalid_event', httpStatus: 400 }
  }

  // event.data.object must be a non-null object.
  const obj = event?.data?.object
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, code: 'invalid_event', httpStatus: 400 }
  }

  return { valid: true }
}

// ── C6: Authoritative subscription field validation ────────────────────────────

/**
 * Validates that the subscription fetched from Stripe matches the event's
 * expectations. After a GET /v1/subscriptions/{id}, the fetched sub must:
 *   - Have an id field equal to the requested subId
 *   - Have a customer field equal to the event's customerId
 *
 * A mismatch indicates a Stripe API inconsistency or a programming error.
 * Callers should return 500 and mark the event as 'failed' on mismatch.
 *
 * @param {Record<string, unknown>} fetchedSub — response from Stripe API
 * @param {string} expectedSubId — subscription ID from the event payload
 * @param {string} expectedCustomerId — customer ID from the event payload
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
export function validateAuthoritativeSub(fetchedSub, expectedSubId, expectedCustomerId) {
  if (!fetchedSub || typeof fetchedSub !== 'object') {
    return { valid: false, reason: 'no_fetched_sub' }
  }
  if (fetchedSub.id !== expectedSubId) {
    return { valid: false, reason: 'sub_id_mismatch' }
  }
  if (fetchedSub.customer !== expectedCustomerId) {
    return { valid: false, reason: 'customer_mismatch' }
  }
  return { valid: true }
}

// ── C7: Invoice event classification ──────────────────────────────────────────

/**
 * Returns true when the event type is an invoice event.
 *
 * Invoice events are treated as informational only — no entitlement DB writes.
 * subscription.updated handles the actual subscription state change for renewals
 * and payment failures (Stripe moves the sub to past_due automatically).
 *
 * @param {string} eventType
 * @returns {boolean}
 */
export function isInvoiceEvent(eventType) {
  return eventType === 'invoice.payment_succeeded' || eventType === 'invoice.payment_failed'
}

// ── C5: Subscription deletion filter ──────────────────────────────────────────

/**
 * Builds a descriptor for the WHERE clause used when marking a subscription as
 * canceled on 'customer.subscription.deleted'.
 *
 * C5: The deletion must match both user_id AND stripe_subscription_id.
 * Matching only user_id could cancel a new subscription that replaced an old one
 * if the deleted event is delivered late (after a new checkout completed).
 *
 * @param {string} userId — Supabase user ID
 * @param {string} subId  — Stripe subscription ID being deleted
 * @returns {{ userId: string, subId: string }}
 */
export function buildDeletionFilter(userId, subId) {
  return { userId, subId }
}

// ── C8: Status allowlist check ─────────────────────────────────────────────────

/**
 * Returns true when the given status is a member of the subscription status
 * allowlist (SUBSCRIPTION_STATUS_SEMANTICS). Unknown statuses must be rejected
 * before any DB write to prevent constraint violations.
 *
 * Delegates to isValidStatus from webhookHelpers.js (single source of truth).
 *
 * @param {unknown} status
 * @returns {boolean}
 */
export function isAllowedSubscriptionStatus(status) {
  return isValidStatus(status)
}

// ── Claim result classification ────────────────────────────────────────────────

/**
 * Classifies a claim_webhook_event() JSONB result into an action for the handler.
 *
 * @param {unknown} claimResult — value returned by the claim_webhook_event() RPC
 * @returns {{ action: 'process', claimToken: string }
 *          | { action: 'duplicate' }
 *          | { action: 'in_progress' }
 *          | { action: 'error' }}
 */
export function classifyClaim(claimResult) {
  if (!claimResult || typeof claimResult !== 'object') {
    return { action: 'error' }
  }
  const { result, claim_token } = claimResult
  if (result === 'claimed') {
    if (typeof claim_token !== 'string' || claim_token.length === 0) {
      return { action: 'error' }
    }
    return { action: 'process', claimToken: claim_token }
  }
  if (result === 'duplicate') return { action: 'duplicate' }
  if (result === 'in_progress') return { action: 'in_progress' }
  return { action: 'error' }
}

// ── Safe event log payload ─────────────────────────────────────────────────────

/**
 * Builds a privacy-safe log payload for a Stripe event. Never includes
 * customer-identifying data (names, emails, metadata values).
 *
 * @param {Record<string, unknown>} event
 * @param {string} requestId
 * @returns {Record<string, unknown>}
 */
export function buildEventLogPayload(event, requestId) {
  return {
    requestId,
    eventId:   typeof event?.id === 'string' ? event.id : null,
    eventType: typeof event?.type === 'string' ? event.type : null,
    created:   typeof event?.created === 'number' ? event.created : null,
  }
}
