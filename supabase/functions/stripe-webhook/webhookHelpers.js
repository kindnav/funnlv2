// Pure helper functions for the stripe-webhook Edge Function.
// Zero external imports — safe to unit-test in Node.js without a Deno environment.

// UUID v4 regex — used to validate Supabase user IDs extracted from Stripe metadata
// before writing them to the database. Prevents invalid strings from causing DB errors.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Returns true when str is a valid UUID v4 string (case-insensitive).
 *
 * @param {unknown} str
 * @returns {boolean}
 */
export function isValidUUID(str) {
  return typeof str === 'string' && UUID_RE.test(str)
}

/**
 * P6: cross-check the authoritative subscription metadata owner against another
 * resolved owner (the Checkout Session user, or the DB owner resolved by
 * subscription/customer id). Returns:
 *   { userId, mismatch: false } — the effective owner (metadata is authoritative when
 *                                 present-and-valid; otherwise the other resolved owner).
 *   { userId: null, mismatch: true } — BOTH owners are present-and-valid AND disagree.
 *
 * A missing/invalid metadata owner is NOT a mismatch (legacy subscriptions predate the
 * metadata write): the other owner is used, subject to the existing customer/subscription
 * ownership checks. Never trusts a non-UUID value.
 *
 * @param {unknown} metaUserId   — authoritative subscription metadata.user_id
 * @param {unknown} otherUserId  — resolved Checkout Session user id, or DB-resolved owner
 * @returns {{ userId: string|null, mismatch: boolean }}
 */
export function crossCheckOwnership(metaUserId, otherUserId) {
  const meta  = isValidUUID(metaUserId)  ? metaUserId  : null
  const other = isValidUUID(otherUserId) ? otherUserId : null
  if (meta && other && meta !== other) return { userId: null, mismatch: true }
  return { userId: meta ?? other, mismatch: false }
}

/**
 * Safely extract the price ID from a Stripe subscription object.
 * Returns null when the path does not exist or throws.
 *
 * @param {Record<string, unknown>} sub — Stripe subscription data object
 * @returns {string|null}
 */
export function extractPriceId(sub) {
  try {
    const items = sub.items
    return items?.data?.[0]?.price?.id ?? null
  } catch {
    return null
  }
}

/**
 * Subscription status semantics table.
 *
 * Maps every Stripe subscription status to:
 *   grantsAccess  — whether this status should grant Pro features
 *   isTerminal    — whether this status is a final non-recoverable state
 *   description   — human-readable explanation
 *
 * This table is the single source of truth for status semantics.
 * evaluateProEntitlement in shared/pro-entitlement.js also uses
 * active+past_due for access grants — keep these in sync.
 */
export const SUBSCRIPTION_STATUS_SEMANTICS = {
  active: {
    grantsAccess: true,
    isTerminal:   false,
    description:  'Subscription is current and paid. Full Pro access.',
  },
  past_due: {
    grantsAccess: true,
    isTerminal:   false,
    description:  'Payment failed; Stripe retrying. Access preserved during the dunning window to avoid false lockouts.',
  },
  canceled: {
    grantsAccess: false,
    isTerminal:   true,
    description:  'Subscription permanently ended (cancel_at_period_end reached, or immediate cancellation).',
  },
  unpaid: {
    grantsAccess: false,
    isTerminal:   false,
    description:  'All dunning retries exhausted. Access revoked. Row stays for audit trail.',
  },
  incomplete: {
    grantsAccess: false,
    isTerminal:   false,
    description:  'Checkout started but payment not yet confirmed. Transitions to active or incomplete_expired.',
  },
  incomplete_expired: {
    grantsAccess: false,
    isTerminal:   true,
    description:  'Checkout expired without payment. No access.',
  },
  trialing: {
    grantsAccess: false,
    isTerminal:   false,
    description:  'Stripe trial (not used by Funnl — Funnl trials are in pro_trials table). Treat as no access.',
  },
  paused: {
    grantsAccess: false,
    isTerminal:   false,
    description:  'Subscription paused via Stripe pause feature. No access while paused.',
  },
  none: {
    grantsAccess: false,
    isTerminal:   false,
    description:  'Placeholder status before a Stripe subscription is attached (internal Funnl default).',
  },
}

/**
 * Returns true when this Stripe subscription status should grant Pro access.
 * Matches the semantics in evaluateProEntitlement (shared/pro-entitlement.js).
 *
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function statusGrantsAccess(status) {
  return SUBSCRIPTION_STATUS_SEMANTICS[status ?? '']?.grantsAccess === true
}

/**
 * Converts a Unix epoch timestamp (seconds) from Stripe to an ISO 8601 string.
 * Returns null when the input is not a valid positive number.
 *
 * @param {unknown} unixSeconds
 * @returns {string|null}
 */
export function unixToIso(unixSeconds) {
  if (typeof unixSeconds !== 'number' || !Number.isFinite(unixSeconds) || unixSeconds <= 0) {
    return null
  }
  return new Date(unixSeconds * 1000).toISOString()
}

// ── C4: Event ID validation ────────────────────────────────────────────────────

/**
 * Regex for valid Stripe event IDs. Format: evt_ followed by 2+ alphanumeric chars.
 * Stripe consistently issues IDs in this format (evt_xxx). Non-matching IDs indicate
 * a malformed or non-Stripe payload that slipped past signature verification.
 */
export const VALID_EVENT_ID_RE = /^evt_[A-Za-z0-9]{2,}$/

/**
 * Returns true when id is a valid Stripe event ID string.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidEventId(id) {
  return typeof id === 'string' && VALID_EVENT_ID_RE.test(id)
}

// ── C8: Subscription status validation ────────────────────────────────────────

/**
 * Set of all valid Stripe subscription status strings, derived from
 * SUBSCRIPTION_STATUS_SEMANTICS. Used to validate incoming status values before
 * writing to the subscriptions table.
 */
export const VALID_STATUSES = new Set(Object.keys(SUBSCRIPTION_STATUS_SEMANTICS))

/**
 * Returns true when status is a known Stripe subscription status string.
 * Unknown statuses must be rejected before writing to the DB (C8).
 *
 * @param {unknown} status
 * @returns {boolean}
 */
export function isValidStatus(status) {
  return typeof status === 'string' && VALID_STATUSES.has(status)
}

// ── C9: Controlled failure codes ──────────────────────────────────────────────

/**
 * Set of all allowed failure_code values for the stripe_webhook_events table.
 * Must stay in sync with the CHECK constraint in the migration SQL.
 * Used in the Edge Function when marking events as 'failed'.
 */
export const VALID_FAILURE_CODES = new Set([
  'missing_user_id',
  'missing_ids',
  'config_missing',
  'stripe_fetch_failed',
  'ownership_lookup_failed',
  'owner_not_found',
  'db_write_failed',
  'handler_exception',
  'invalid_event',
  'invalid_status',
  'invalid_subscription_item', // R3: snapshot failed for our price (bad/missing period end, mixed items)
  'identity_conflict',         // R6: Stripe identity already attached to a different Funnl user
  'provider_timeout',          // P5: bounded Stripe subscription retrieval timed out (retryable)
  'ownership_mismatch',        // P6: authoritative subscription metadata.user_id disagrees with the resolved owner
])

/**
 * Determines whether a webhook event should return HTTP 500 when its user cannot
 * be identified. A 500 causes Stripe to retry delivery, which may succeed once
 * the ownership row has been created by an earlier event (e.g. checkout.session.completed).
 *
 * Returns true (retry) for entitlement-changing events where a retry could resolve
 * the missing ownership. Returns false (ignore with 200) for events that are
 * informational or where retrying is known to be futile.
 *
 * @param {string} eventType — Stripe event type string
 * @returns {boolean}
 */
export function shouldRetryOnMissingOwnership(eventType) {
  // Entitlement-changing events: subscription created/updated/deleted and invoice payment
  // success all write to the subscriptions table. Unknown ownership here is unexpected
  // and a retry might succeed once checkout.session.completed has been processed.
  const retryable = new Set([
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.payment_succeeded',
  ])
  return retryable.has(eventType)
}

// ── R3: modern billing-period extraction ────────────────────────────────────────
//
// Stripe removed the top-level `Subscription.current_period_end` in API version
// 2025-03-31.basil; the billing period now lives on the subscription ITEM
// (`sub.items.data[n].current_period_end`). This helper validates the single Funnl
// Pro item and returns a normalized snapshot with BOTH the validated price and the
// period end drawn from the SAME item — so price validation and period extraction can
// never disagree.
//
// Funnl supports exactly one Pro price and no mixed subscription items, so it FAILS
// CLOSED for any of: no items, malformed items, no item matching the configured price,
// multiple items, multiple matching items, or a matched item with neither a valid
// item-level period end nor a valid legacy top-level fallback.
//
// Returns:
//   { ok: true,  priceId, periodEndIso, periodStartIso, source: 'item'|'legacy' }
//   (periodStartIso is the start of the same billing period - the renewal moment - or null if absent)
//   { ok: false, reason }   where reason ∈
//     'price_not_configured' | 'no_items' | 'malformed_items' | 'no_matching_item' |
//     'multiple_matching_items' | 'unsupported_item_configuration' | 'no_period_end'
//
// Callers map 'no_matching_item' to "not our product" (ignore/200) and every other
// failure to a fail-closed 5xx.
export function extractProSubscriptionSnapshot(sub, priceId) {
  if (typeof priceId !== 'string' || !priceId) {
    return { ok: false, reason: 'price_not_configured' }
  }
  const items = sub?.items?.data
  if (items === undefined || items === null) return { ok: false, reason: 'no_items' }
  if (!Array.isArray(items)) return { ok: false, reason: 'malformed_items' }
  if (items.length === 0) return { ok: false, reason: 'no_items' }

  const matched = items.filter(it => it?.price?.id === priceId)
  if (matched.length === 0) return { ok: false, reason: 'no_matching_item' }
  if (matched.length > 1) return { ok: false, reason: 'multiple_matching_items' }
  // Exactly one item must match AND there must be no other (mixed) items.
  if (items.length !== 1) return { ok: false, reason: 'unsupported_item_configuration' }

  const item = matched[0]
  // Prefer the item-level period end; fall back to the legacy top-level field only.
  const fromItem   = unixToIso(item?.current_period_end)
  const fromLegacy = unixToIso(sub?.current_period_end)
  // The period start comes from the SAME source as the period end.
  if (fromItem)   return { ok: true, priceId, periodEndIso: fromItem,   periodStartIso: unixToIso(item?.current_period_start), source: 'item' }
  if (fromLegacy) return { ok: true, priceId, periodEndIso: fromLegacy, periodStartIso: unixToIso(sub?.current_period_start), source: 'legacy' }
  return { ok: false, reason: 'no_period_end' }
}

// ── R6: Postgres unique-violation detection ─────────────────────────────────────
// SQLSTATE 23505 = unique_violation. The webhook treats a unique violation on a Stripe
// identity (customer or subscription id already attached to a different Funnl user) as
// a fail-closed conflict rather than overwriting another user's row.
export function isUniqueViolation(error) {
  return !!error && error.code === '23505'
}

// ── Invoice evidence (migration 20261023000000) ────────────────────────────────────────────────────
// Access is decided from verified INVOICE facts, never from a subscription's status snapshot. These pure
// helpers read a Stripe invoice that the webhook has RE-FETCHED with the server key (never the event
// payload) and accept it only when it belongs to the expected subscription AND customer, in the key's
// mode (test/live). Both the classic and the 2025+ invoice shapes are read.

/** 'live' | 'test' | null from a secret or restricted key. */
export function stripeKeyMode(key) {
  if (typeof key !== 'string') return null
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live'
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'test'
  return null
}

/** The subscription id an invoice belongs to (classic `subscription` or 2025+ `parent.subscription_details`). */
export function invoiceSubscriptionId(inv) {
  const classic = typeof inv?.subscription === 'string' ? inv.subscription : inv?.subscription?.id
  return classic ?? inv?.parent?.subscription_details?.subscription ?? null
}

function invoiceCustomerId(inv) {
  return typeof inv?.customer === 'string' ? inv.customer : inv?.customer?.id ?? null
}

function linePriceId(line) {
  return line?.price?.id ?? line?.pricing?.price_details?.price ?? null
}

/**
 * Turns a re-fetched invoice into evidence.
 *   { ok: true, kind: 'paid', invoiceId, createdIso, periodEndIso }     paid; covers our price's line period
 *   { ok: true, kind: 'failed', invoiceId, createdIso, renewal }        unpaid after >= 1 payment attempt
 *   { ok: true, kind: 'none', invoiceId }                               draft / void / not yet attempted
 *   { ok: false, reason }  'malformed' | 'environment_mismatch' | 'ownership_mismatch' | 'no_matching_line'
 * `renewal` is true only for billing_reason 'subscription_cycle': an initial purchase never gets grace.
 * @param {object} inv
 * @param {{ subscriptionId: string, customerId: string, priceIds: string[], mode: 'live'|'test' }} expected
 */
export function extractInvoiceEvidence(inv, { subscriptionId, customerId, priceIds, mode }) {
  if (!inv || typeof inv.id !== 'string' || !inv.id.startsWith('in_')) return { ok: false, reason: 'malformed' }
  if ((mode === 'live') !== (inv.livemode === true) || (mode !== 'live' && mode !== 'test')) return { ok: false, reason: 'environment_mismatch' }
  if (!subscriptionId || !customerId || invoiceSubscriptionId(inv) !== subscriptionId || invoiceCustomerId(inv) !== customerId) {
    return { ok: false, reason: 'ownership_mismatch' }
  }
  const createdIso = unixToIso(inv.created)
  if (!createdIso) return { ok: false, reason: 'malformed' }
  if (inv.status === 'paid') {
    const lines = inv.lines?.data
    if (!Array.isArray(lines)) return { ok: false, reason: 'malformed' }
    const ours = lines.filter((l) => priceIds.includes(linePriceId(l)))
    if (ours.length !== 1) return { ok: false, reason: 'no_matching_line' }
    const periodEndIso = unixToIso(ours[0]?.period?.end)
    if (!periodEndIso) return { ok: false, reason: 'malformed' }
    return { ok: true, kind: 'paid', invoiceId: inv.id, createdIso, periodEndIso }
  }
  if ((inv.status === 'open' || inv.status === 'uncollectible') && Number(inv.attempt_count) >= 1) {
    return { ok: true, kind: 'failed', invoiceId: inv.id, createdIso, renewal: inv.billing_reason === 'subscription_cycle' }
  }
  return { ok: true, kind: 'none', invoiceId: inv.id }
}
