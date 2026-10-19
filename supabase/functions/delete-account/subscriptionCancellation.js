// Subscription-safe account deletion: before any Funnl record is deleted, every Stripe subscription
// that belongs to the account is canceled immediately (no proration credit, no final invoice, no
// refund), and an open Checkout session is expired so it can no longer be paid.
//
// Policy (owner-approved, 2026-10-19):
//   - cancel the account's subscription immediately, before deleting its Funnl records;
//   - no automatic refund;
//   - if cancellation cannot be confirmed, keep the account and return a controlled error;
//   - an account with no subscription deletes normally.
//
// Trust: identifiers come ONLY from this user's own database rows (subscriptions, checkout_operations,
// looked up by the verified user id) and are then cross-checked against what Stripe returns: the Funnl
// user id in Stripe metadata, the customer, and the environment (test vs live key). Nothing is read from
// the request.
//
// Retry safety: nothing here creates a subscription, customer or charge. Cancel and expire use
// idempotency keys derived from the object id. A retry after "Stripe canceled, database deletion
// failed" re-reads the subscription, finds it already ended, and proceeds without another cancel.
//
// Privacy: returns and logs only controlled reason codes and counts - never Stripe bodies, error
// messages, customer/subscription/session ids, emails or keys.
//
// Zero Deno/Supabase imports: Node tests drive it with a fake Stripe and a fake or real admin client.
import { fetchWithTimeout, isTimeoutError } from '../shared/boundedFetch.js'

/** Stripe statuses after which the subscription can no longer bill. */
export const ENDED_STATUSES = new Set(['canceled', 'incomplete_expired'])

/** 'live' | 'test' | null, from the secret or restricted key prefix. */
export function stripeKeyMode (key) {
  if (typeof key !== 'string') return null
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live'
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'test'
  return null
}

/**
 * Production Stripe transport: query parameters for GET/DELETE, form-encoded otherwise, bounded by fetchWithTimeout. Returns { status, body }
 * (body is parsed JSON or null) and rejects with a TimeoutError on timeout.
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
 * Cancels every subscription that belongs to `userId` and expires an open Checkout session.
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
  const subQ = await admin.from('subscriptions')
    .select('stripe_customer_id, stripe_subscription_id, status').eq('user_id', userId).maybeSingle()
  if (subQ.error) return unconfirmed('billing_lookup_failed')
  const opQ = await admin.from('checkout_operations')
    .select('stripe_session_id, state').eq('user_id', userId).maybeSingle()
  if (opQ.error) return unconfirmed('billing_lookup_failed')
  const subRow = subQ.data, opRow = opQ.data

  const hasBilling = Boolean(subRow?.stripe_subscription_id || subRow?.stripe_customer_id || opRow?.stripe_session_id)
  if (!hasBilling) return { ok: true, canceled: 0, alreadyEnded: 0, sessionsExpired: 0, billing: false }

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

  let customer = subRow?.stripe_customer_id ?? null
  const subscriptionIds = []
  if (subRow?.stripe_subscription_id) subscriptionIds.push(subRow.stripe_subscription_id)
  let sessionsExpired = 0

  // ── 1. Checkout session: expire it if still open; adopt its subscription if it completed. ─────────
  if (opRow?.stripe_session_id) {
    const sid = opRow.stripe_session_id
    const path = `/v1/checkout/sessions/${encodeURIComponent(sid)}`
    let s = await call('GET', path)
    if (s.status === 404) return needsSupport('session_unverifiable')
    if (s.status !== 200 || !s.body) return unconfirmed('session_lookup_failed')
    const check = (sess) => {
      if (sess.id !== sid) return 'session_mismatch'
      if (sess.livemode !== live) return 'environment_mismatch'
      if ((sess.client_reference_id && sess.client_reference_id !== userId) || ownedByOtherUser(sess.metadata)) return 'ownership_mismatch'
      if (customer && sess.customer && sess.customer !== customer) return 'ownership_mismatch'
      return null
    }
    let bad = check(s.body)
    if (bad) return needsSupport(bad)
    if (s.body.status === 'open') {
      const ex = await call('POST', `${path}/expire`, { idempotencyKey: `funnl-account-deletion:expire:${sid}` })
      if (ex.status === 200 && ex.body?.status === 'expired') sessionsExpired++
      else {
        // Expire refused (for example it completed meanwhile) or never answered: read it again.
        s = await call('GET', path)
        if (s.status !== 200 || !s.body) return unconfirmed('session_expire_unconfirmed')
        bad = check(s.body)
        if (bad) return needsSupport(bad)
        if (s.body.status === 'expired') sessionsExpired++
        else if (s.body.status !== 'complete') return unconfirmed('session_expire_unconfirmed')
      }
    }
    if (s.body.status === 'complete') {
      if (s.body.customer && !customer) customer = s.body.customer
      if (s.body.subscription && !subscriptionIds.includes(s.body.subscription)) subscriptionIds.push(s.body.subscription)
    }
  }

  // ── 2. Before canceling anything: nothing else may still bill this customer. ──────────────────
  // A subscription Funnl does not know about (for example one whose webhook never arrived) is not
  // canceled automatically: the account is kept and the case needs a person to look at it.
  if (customer) {
    const l = await call('GET', '/v1/subscriptions', { params: { customer, status: 'all', limit: '100' } })
    if (l.status !== 200 || !Array.isArray(l.body?.data)) return unconfirmed('subscription_list_failed')
    if (l.body.has_more) return needsSupport('too_many_subscriptions')
    for (const sub of l.body.data) {
      if (sub.livemode !== live) return needsSupport('environment_mismatch')
      if (subscriptionIds.includes(sub.id)) continue
      if (!ENDED_STATUSES.has(sub.status)) return needsSupport('other_active_subscription')
    }
  }

  // ── 3. Each known subscription: verify, then cancel now unless it has already ended. ─────────────
  let canceled = 0, alreadyEnded = 0
  for (const id of subscriptionIds) {
    const path = `/v1/subscriptions/${encodeURIComponent(id)}`
    const check = (sub) => {
      if (sub.id !== id) return 'subscription_mismatch'
      if (sub.livemode !== live) return 'environment_mismatch'
      if (ownedByOtherUser(sub.metadata)) return 'ownership_mismatch'
      if (customer && sub.customer !== customer) return 'ownership_mismatch'
      return null
    }
    const g = await call('GET', path)
    if (g.status === 404) return needsSupport('subscription_unverifiable')
    if (g.status !== 200 || !g.body) return unconfirmed('subscription_lookup_failed')
    const bad = check(g.body)
    if (bad) return needsSupport(bad)
    if (!customer) customer = g.body.customer ?? null
    if (ENDED_STATUSES.has(g.body.status)) { alreadyEnded++; continue }

    const c = await call('DELETE', path, { params: { prorate: 'false', invoice_now: 'false' }, idempotencyKey: `funnl-account-deletion:cancel:${id}` })
    if (c.status === 200 && c.body && !check(c.body) && ENDED_STATUSES.has(c.body.status)) { canceled++; continue }
    // Not confirmed by the cancel response (refused, server error, timeout): read it again once.
    const r = await call('GET', path)
    if (r.status === 200 && r.body && !check(r.body) && ENDED_STATUSES.has(r.body.status)) { canceled++; continue }
    return unconfirmed('cancel_unconfirmed')
  }

  return { ok: true, canceled, alreadyEnded, sessionsExpired, billing: true }
}
