// Subscription-safe account deletion: before any Funnl record is deleted, every Stripe subscription
// that belongs to the account is canceled immediately (no proration credit, no final invoice, no
// refund), and every Checkout session that could still be paid is expired.
//
// Policy (owner-approved, 2026-10-19):
//   - cancel the account's subscription immediately, before deleting its Funnl records;
//   - no automatic refund;
//   - if cancellation cannot be confirmed, keep the account and return a controlled error;
//   - an account with no subscription deletes normally.
//
// Coordination with Checkout (migration 20261020000000): begin_account_deletion() writes a durable
// per-user fence under the same transaction lock that claim_checkout_operation() takes, so no new
// Checkout can be created once deletion has begun. It reports, under that lock, the checkout state and
// every session id that may still be payable. A 'creating' operation (no session id yet) is NOT "no
// billing": deletion is refused (retryable) until it is finalized, or until it is old enough that any
// session it could have created has expired (Stripe Checkout sessions live at most 24 hours).
//
// Trust: identifiers come ONLY from this user's own rows (via the verified user id) and are cross-checked
// against Stripe: Funnl user id in metadata, customer, test/live mode. The customer is resolved and
// validated from every source (stored row, completed sessions, the known subscriptions) BEFORE the
// customer-wide check, and all sources must agree. Unknown or malformed Stripe data fails closed.
//
// Retry safety: nothing here creates anything at Stripe. Cancel/expire use idempotency keys derived from
// the object id. A retry after "Stripe canceled, database deletion failed" finds the subscription ended.
//
// Privacy: returns and logs only controlled reason codes and counts.
//
// Zero Deno/Supabase imports: Node tests drive it with a fake Stripe and a fake or real admin client.
import { fetchWithTimeout, isTimeoutError } from '../shared/boundedFetch.js'

/** Stripe statuses after which the subscription can no longer bill. */
export const ENDED_STATUSES = new Set(['canceled', 'incomplete_expired'])
/** Every Stripe subscription status; anything else is unknown and fails closed. */
export const SUBSCRIPTION_STATUSES = new Set(['active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'trialing', 'paused'])
/** Every Stripe Checkout Session status; anything else is unknown and fails closed. */
export const SESSION_STATUSES = new Set(['open', 'complete', 'expired'])
/** Checkout states begin_account_deletion() may report. */
export const CHECKOUT_STATES = new Set(['none', 'creating', 'ready', 'failed'])
/**
 * A 'creating' operation younger than this may have produced a session that can still be paid:
 * Stripe's maximum Checkout Session lifetime (24 h) plus margin for the creating request itself.
 */
export const UNCERTAIN_CREATION_SECONDS = 24 * 3600 + 15 * 60

/** 'live' | 'test' | null, from the secret or restricted key prefix. */
export function stripeKeyMode (key) {
  if (typeof key !== 'string') return null
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live'
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'test'
  return null
}

const isId = (v, prefix) => typeof v === 'string' && v.startsWith(prefix) && v.length > prefix.length

/**
 * Production Stripe transport: query parameters for GET/DELETE, form-encoded otherwise, bounded by
 * fetchWithTimeout. Returns { status, body } (body is parsed JSON or null); rejects with a TimeoutError.
 */
export function makeStripeRequest ({ stripeKey, fetchImpl, timeoutMs, baseUrl = 'https://api.stripe.com' }) {
  return async function stripeRequest (method, path, { params, idempotencyKey } = {}) {
    const headers = { Authorization: `Bearer ${stripeKey}` }
    let url = baseUrl + path
    let body
    if (params && (method === 'GET' || method === 'DELETE')) url += '?' + new URLSearchParams(params).toString()
    else if (params) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(params).toString() }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
    const res = await fetchWithTimeout(url, { method, headers, body }, { fetchImpl, timeoutMs })
    let json = null
    try { json = await res.json() } catch { json = null }
    return { status: res.status, body: json }
  }
}

// Controlled outcomes. `retryable` decides the HTTP status the caller returns (503 vs 409).
const unconfirmed = (reason) => ({ ok: false, retryable: true, reason })
const needsSupport = (reason) => ({ ok: false, retryable: false, reason })

/**
 * Fences Checkout, then cancels every subscription that belongs to `userId` and expires every session
 * that could still be paid.
 *
 * @param {object} deps
 * @param {string} deps.userId          verified Funnl user id (from auth.getUser)
 * @param {object} deps.admin           service-role supabase client (or a compatible fake)
 * @param {string} deps.stripeKey       server Stripe key (only its mode is inspected here)
 * @param {Function} deps.stripeRequest (method, path, { params, idempotencyKey }) => Promise<{ status, body }>
 * @returns {Promise<{ ok: true, canceled: number, alreadyEnded: number, sessionsExpired: number, billing: boolean }
 *                  | { ok: false, retryable: boolean, reason: string }>}
 */
export async function cancelAccountSubscriptions ({ userId, admin, stripeKey, stripeRequest }) {
  // ── 0. Fence Checkout and read its state under the same lock. ────────────────────────────────────
  const fence = await admin.rpc('begin_account_deletion', { p_user_id: userId })
  if (fence.error || !fence.data || fence.data.fenced !== true) return unconfirmed('deletion_fence_failed')
  const f = fence.data
  if (!CHECKOUT_STATES.has(f.checkout_state) || !Array.isArray(f.sessions) || !f.sessions.every((s) => isId(s, 'cs_'))) {
    return needsSupport('checkout_state_unknown')
  }
  if (f.checkout_state === 'creating') {
    const age = Number(f.creating_age_seconds)
    if (!Number.isFinite(age) || age < UNCERTAIN_CREATION_SECONDS) return unconfirmed('checkout_creation_unresolved')
  }
  const sessionIds = [...new Set(f.sessions)]

  const subQ = await admin.from('subscriptions')
    .select('stripe_customer_id, stripe_subscription_id, status').eq('user_id', userId).maybeSingle()
  if (subQ.error) return unconfirmed('billing_lookup_failed')
  const subRow = subQ.data

  const hasBilling = Boolean(subRow?.stripe_subscription_id || subRow?.stripe_customer_id || sessionIds.length)
  if (!hasBilling) return { ok: true, canceled: 0, alreadyEnded: 0, sessionsExpired: 0, billing: false }
  if (subRow?.stripe_customer_id && !isId(subRow.stripe_customer_id, 'cus_')) return needsSupport('customer_malformed')
  if (subRow?.stripe_subscription_id && !isId(subRow.stripe_subscription_id, 'sub_')) return needsSupport('subscription_malformed')

  const mode = stripeKeyMode(stripeKey)
  if (!mode) return unconfirmed('billing_unavailable')
  const live = mode === 'live'

  // A Stripe call that never answered, or answered with a server error, is "not confirmed".
  async function call (method, path, opts) {
    try {
      return await stripeRequest(method, path, opts)
    } catch (err) {
      return { status: isTimeoutError(err) ? 'timeout' : 'network', body: null }
    }
  }
  const ownedByOtherUser = (meta) => typeof meta?.user_id === 'string' && meta.user_id !== '' && meta.user_id !== userId

  // Every customer source must agree; a malformed one fails closed.
  const customers = new Set()
  const addCustomer = (c) => { if (!isId(c, 'cus_')) return false; customers.add(c); return true }
  if (subRow?.stripe_customer_id) addCustomer(subRow.stripe_customer_id)
  const subscriptionIds = []
  if (subRow?.stripe_subscription_id) subscriptionIds.push(subRow.stripe_subscription_id)
  let sessionsExpired = 0

  // ── 1. Sessions that may still be paid: expire open ones; adopt a completed one's subscription. ───
  for (const sid of sessionIds) {
    const path = `/v1/checkout/sessions/${encodeURIComponent(sid)}`
    const check = (sess) => {
      if (!sess || sess.id !== sid) return 'session_mismatch'
      if (sess.livemode !== live) return 'environment_mismatch'
      if ((sess.client_reference_id && sess.client_reference_id !== userId) || ownedByOtherUser(sess.metadata)) return 'ownership_mismatch'
      if (!SESSION_STATUSES.has(sess.status)) return 'session_status_unknown'
      return null
    }
    let s = await call('GET', path)
    if (s.status === 404) return needsSupport('session_unverifiable')
    if (s.status !== 200 || !s.body) return unconfirmed('session_lookup_failed')
    let bad = check(s.body)
    if (bad) return needsSupport(bad)
    if (s.body.status === 'open') {
      const ex = await call('POST', `${path}/expire`, { idempotencyKey: `funnl-account-deletion:expire:${sid}` })
      if (ex.status === 200 && !check(ex.body) && ex.body.status === 'expired') {
        sessionsExpired++
        continue
      }
      // Expire refused, malformed or unanswered (or the session completed meanwhile): read it again.
      s = await call('GET', path)
      if (s.status !== 200 || !s.body) return unconfirmed('session_expire_unconfirmed')
      bad = check(s.body)
      if (bad) return needsSupport(bad)
      if (s.body.status === 'expired') { sessionsExpired++; continue }
      if (s.body.status !== 'complete') return unconfirmed('session_expire_unconfirmed')
    }
    if (s.body.status === 'complete') {
      // A completed subscription Checkout must name both its customer and its subscription.
      if (!isId(s.body.customer, 'cus_') || !isId(s.body.subscription, 'sub_')) return needsSupport('session_missing_identifiers')
      addCustomer(s.body.customer)
      if (!subscriptionIds.includes(s.body.subscription)) subscriptionIds.push(s.body.subscription)
    }
  }

  // ── 2. Verify every known subscription and resolve the customer from it. ──────────────────────────
  const subs = new Map()
  const checkSub = (sub, id) => {
    if (!sub || sub.id !== id) return 'subscription_mismatch'
    if (sub.livemode !== live) return 'environment_mismatch'
    if (ownedByOtherUser(sub.metadata)) return 'ownership_mismatch'
    if (!isId(sub.customer, 'cus_')) return 'customer_malformed'
    if (!SUBSCRIPTION_STATUSES.has(sub.status)) return 'subscription_status_unknown'
    return null
  }
  for (const id of subscriptionIds) {
    const g = await call('GET', `/v1/subscriptions/${encodeURIComponent(id)}`)
    if (g.status === 404) return needsSupport('subscription_unverifiable')
    if (g.status !== 200 || !g.body) return unconfirmed('subscription_lookup_failed')
    const bad = checkSub(g.body, id)
    if (bad) return needsSupport(bad)
    addCustomer(g.body.customer)
    subs.set(id, g.body)
  }
  if (customers.size > 1) return needsSupport('customer_conflict')
  const customer = customers.size === 1 ? [...customers][0] : null
  if (subscriptionIds.length && !customer) return needsSupport('customer_unresolved')

  // ── 3. Before canceling anything: nothing else may still bill this customer. ──────────────────────
  // A subscription Funnl does not know about (for example one whose webhook never arrived) is not
  // canceled automatically: the account is kept and the case needs a person to look at it.
  if (customer) {
    const l = await call('GET', '/v1/subscriptions', { params: { customer, status: 'all', limit: '100' } })
    if (l.status !== 200 || !Array.isArray(l.body?.data)) return unconfirmed('subscription_list_failed')
    if (l.body.has_more) return needsSupport('too_many_subscriptions')
    for (const sub of l.body.data) {
      if (!sub || sub.livemode !== live) return needsSupport('environment_mismatch')
      if (sub.customer !== customer) return needsSupport('customer_conflict')
      if (subs.has(sub.id)) continue
      if (!SUBSCRIPTION_STATUSES.has(sub.status)) return needsSupport('subscription_status_unknown')
      if (!ENDED_STATUSES.has(sub.status)) return needsSupport('other_active_subscription')
    }
  }

  // ── 4. Cancel each known subscription now unless it has already ended. ────────────────────────────
  let canceled = 0, alreadyEnded = 0
  for (const [id, sub] of subs) {
    if (sub.customer !== customer) return needsSupport('customer_conflict')
    if (ENDED_STATUSES.has(sub.status)) { alreadyEnded++; continue }
    const path = `/v1/subscriptions/${encodeURIComponent(id)}`
    const confirmed = (r) => r.status === 200 && !checkSub(r.body, id) && r.body.customer === customer && ENDED_STATUSES.has(r.body.status)
    const c = await call('DELETE', path, { params: { prorate: 'false', invoice_now: 'false' }, idempotencyKey: `funnl-account-deletion:cancel:${id}` })
    if (confirmed(c)) { canceled++; continue }
    // Not confirmed by the cancel response (refused, malformed, server error, timeout): read it again once.
    const r = await call('GET', path)
    if (confirmed(r)) { canceled++; continue }
    return unconfirmed('cancel_unconfirmed')
  }

  return { ok: true, canceled, alreadyEnded, sessionsExpired, billing: true }
}
