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
