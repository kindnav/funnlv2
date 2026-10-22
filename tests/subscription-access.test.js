/**
 * subscription-access.test.js — time-bounded subscription access (owner-approved 2026-10-22), the
 * webhook's sync of a subscription already bound to a Funnl user on an older price, and the
 * server-side refusal of Checkout for permanent-Pro accounts. Pure Node; no network, no database.
 *
 * The SQL mirror (public.subscription_access_until) is checked against this JS at the same cutoffs on a
 * real database by tests/local/subscription-access.mjs.
 *
 * Run with: node tests/subscription-access.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { subscriptionAccessUntil, subscriptionGrantsAccessAt, PAYMENT_GRACE_MS } from '../supabase/functions/shared/subscriptionStatusPolicy.js'
import { evaluateProEntitlement } from '../supabase/functions/shared/pro-entitlement.js'
import { runWebhookOrchestration } from '../supabase/functions/stripe-webhook/webhookHandler.js'
import { extractProSubscriptionSnapshot } from '../supabase/functions/stripe-webhook/webhookHelpers.js'
import { runCheckoutOrchestration } from '../supabase/functions/create-checkout-session/checkoutOrchestrator.js'

const DAY = 86400000
const T = Date.parse('2026-11-16T00:00:00.000Z')            // a period end / renewal moment
const at = (ms) => new Date(ms)

// ── The rule at its cutoffs ────────────────────────────────────────────────────────────────────────
test('active, renewing: Pro through the period and 7 days after its end (renewal not yet synced), then Free', () => {
  const sub = { status: 'active', current_period_end: new Date(T).toISOString(), cancel_at_period_end: false }
  assert.equal(subscriptionAccessUntil(sub).getTime(), T + 7 * DAY)
  for (const [ms, want] of [[T - DAY, true], [T, true], [T + 7 * DAY - 1, true], [T + 7 * DAY, false], [T + 7 * DAY + 1, false], [T + 60 * DAY, false]]) {
    assert.equal(subscriptionGrantsAccessAt(sub, at(ms)), want, new Date(ms).toISOString())
  }
})
test('active, cancel at period end: Pro until exactly the period end, then Free (no grace)', () => {
  const sub = { status: 'active', current_period_end: new Date(T).toISOString(), cancel_at_period_end: true }
  for (const [ms, want] of [[T - 1, true], [T, false], [T + 1, false]]) assert.equal(subscriptionGrantsAccessAt(sub, at(ms)), want)
})
for (const status of ['past_due', 'unpaid']) {
  test(`${status}: Pro until 7 days after the failed renewal (grace anchor), then Free`, () => {
    const sub = { status, current_period_end: new Date(T + 30 * DAY).toISOString(), cancel_at_period_end: false, grace_started_at: new Date(T).toISOString() }
    for (const [ms, want] of [[T, true], [T + 7 * DAY - 1, true], [T + 7 * DAY, false], [T + 20 * DAY, false]]) assert.equal(subscriptionGrantsAccessAt(sub, at(ms)), want)
    assert.equal(subscriptionGrantsAccessAt({ ...sub, grace_started_at: null }, at(T)), false, 'no anchor: fail closed')
  })
}
test('statuses without subscription access, and malformed rows, never grant', () => {
  for (const status of ['canceled', 'incomplete', 'incomplete_expired', 'trialing', 'paused', 'none', 'mystery', '', null]) {
    assert.equal(subscriptionAccessUntil({ status, current_period_end: new Date(T + 30 * DAY).toISOString(), grace_started_at: new Date(T).toISOString() }), null, String(status))
  }
  assert.equal(subscriptionAccessUntil({ status: 'active', current_period_end: null }), null)
  assert.equal(subscriptionAccessUntil({ status: 'active', current_period_end: 'not a date' }), null)
  assert.equal(subscriptionAccessUntil(null), null)
  assert.equal(subscriptionGrantsAccessAt({ status: 'active', current_period_end: new Date(T).toISOString() }, 'now'), false, 'requires a Date')
  assert.equal(PAYMENT_GRACE_MS, 7 * DAY)
})
test('entitlement: permanent and trial grants are unchanged; a stale paid row no longer grants forever', () => {
  const stale = { status: 'active', current_period_end: '2026-09-13T00:00:00.000Z', cancel_at_period_end: false }
  const now = new Date('2026-10-22T00:00:00.000Z')
  assert.equal(evaluateProEntitlement({ ai_enabled: false }, null, stale, now).canUse, false)
  assert.equal(evaluateProEntitlement({ ai_enabled: true }, null, stale, now).reason, 'permanent')
  assert.equal(evaluateProEntitlement({ ai_enabled: false }, { started_at: '2026-10-20T00:00:00Z', ends_at: '2026-10-27T00:00:00Z' }, stale, now).reason, 'trial')
  assert.equal(evaluateProEntitlement({ ai_enabled: false }, null, { ...stale, current_period_end: '2026-10-30T00:00:00Z' }, now).reason, 'subscription')
})

// ── Webhook: a subscription bound to a Funnl user keeps syncing on its bound price ─────────────────
const USER = '11111111-1111-4111-8111-111111111111'
const NEW_PRICE = 'price_new', OLD_PRICE = 'price_old'
function fakeAdmin ({ bound = null } = {}) {
  const calls = { upserts: [], marks: [], lookups: [] }
  const builder = () => {
    const st = { filters: {} }
    const b = {
      select () { return b }, eq (c, v) { st.filters[c] = v; return b },
      maybeSingle () { calls.lookups.push({ ...st.filters }); return Promise.resolve({ data: 'stripe_subscription_id' in st.filters ? bound : null, error: null }) },
      upsert (payload) { calls.upserts.push(payload); return Promise.resolve({ error: null }) },
    }
    return b
  }
  return {
    calls,
    rpc (fn, args) {
      if (fn === 'claim_webhook_event') return Promise.resolve({ data: { result: 'claimed', claim_token: 'tok' }, error: null })
      if (fn === 'mark_webhook_event') { calls.marks.push(args.p_status); return Promise.resolve({ data: true, error: null }) }
      return Promise.resolve({ data: null, error: null })
    },
    from () { return builder() },
  }
}
const subOn = (price, extra = {}) => ({ id: 'sub_X', customer: 'cus_X', status: 'active', cancel_at_period_end: false, metadata: { user_id: USER },
  items: { data: [{ price: { id: price }, current_period_start: T / 1000, current_period_end: (T + 30 * DAY) / 1000 }] }, ...extra })
const updated = (sub) => ({ id: 'evt_access01', type: 'customer.subscription.updated', created: Math.floor(T / 1000), data: { object: { id: sub.id, customer: sub.customer } } })
const runUpdate = async (sub, admin) => runWebhookOrchestration({ event: updated(sub), requestId: 'r', supabaseAdmin: admin, fetchSubscription: async () => sub, env: { priceId: NEW_PRICE, stripeKey: 'sk_test_x' } })

test('snapshot carries the period start from the same item as the period end', () => {
  const s = extractProSubscriptionSnapshot(subOn(NEW_PRICE), NEW_PRICE)
  assert.equal(s.periodStartIso, new Date(T).toISOString())
  assert.equal(s.periodEndIso, new Date(T + 30 * DAY).toISOString())
})
test('an update on today’s price writes the period start and end (unchanged behaviour)', async () => {
  const admin = fakeAdmin()
  const r = await runUpdate(subOn(NEW_PRICE), admin)
  assert.equal(r.status, 200)
  assert.equal(admin.calls.upserts[0].current_period_start, new Date(T).toISOString())
  assert.equal(admin.calls.upserts[0].price_id, NEW_PRICE)
})
test('an update for a subscription BOUND to the user on an OLDER price is applied, keeping its price', async () => {
  const admin = fakeAdmin({ bound: { user_id: USER, price_id: OLD_PRICE, stripe_customer_id: 'cus_X' } })
  const r = await runUpdate(subOn(OLD_PRICE, { status: 'past_due' }), admin)
  assert.equal(r.status, 200)
  assert.deepEqual(admin.calls.marks, ['processed'])
  assert.equal(admin.calls.upserts.length, 1)
  assert.equal(admin.calls.upserts[0].status, 'past_due')
  assert.equal(admin.calls.upserts[0].price_id, OLD_PRICE)
})
test('an UNBOUND subscription on another price is still ignored (no Pro from an unrelated subscription)', async () => {
  const admin = fakeAdmin()
  const r = await runUpdate(subOn(OLD_PRICE), admin)
  assert.equal(r.status, 200)
  assert.deepEqual(admin.calls.marks, ['ignored'])
  assert.equal(admin.calls.upserts.length, 0)
})
test('a bound row for a DIFFERENT customer does not unlock the older price', async () => {
  const admin = fakeAdmin({ bound: { user_id: USER, price_id: OLD_PRICE, stripe_customer_id: 'cus_OTHER' } })
  const r = await runUpdate(subOn(OLD_PRICE), admin)
  assert.deepEqual(admin.calls.marks, ['ignored'])
  assert.equal(admin.calls.upserts.length, 0)
  assert.equal(r.status, 200)
})
test('a bound subscription that moved to a third, unknown price is still ignored', async () => {
  const admin = fakeAdmin({ bound: { user_id: USER, price_id: OLD_PRICE, stripe_customer_id: 'cus_X' } })
  await runUpdate(subOn('price_third'), admin)
  assert.deepEqual(admin.calls.marks, ['ignored'])
})
test('a NEW purchase (checkout.session.completed) still requires today’s configured price', () => {
  const src = readFileSync(new URL('../supabase/functions/stripe-webhook/webhookHandler.js', import.meta.url), 'utf8')
  const checkout = src.slice(src.indexOf("case 'checkout.session.completed'"), src.indexOf("case 'customer.subscription.created'"))
  assert.ok(checkout.includes('extractProSubscriptionSnapshot(sub, priceId)') && !checkout.includes('bound'))
})

// ── Checkout: permanent Pro cannot buy a redundant subscription ────────────────────────────────────
function checkoutAdmin (profile) {
  const calls = { rpc: 0, tables: [] }
  return {
    calls,
    from (table) {
      calls.tables.push(table)
      const b = { select () { return b }, eq () { return b }, maybeSingle () { return Promise.resolve(table === 'profiles' ? profile : { data: null, error: null }) } }
      return b
    },
    rpc () { calls.rpc++; return Promise.resolve({ data: { result: 'claimed', operation_id: 'op', claim_token: 'tok' }, error: null }) },
  }
}
const ENV = { priceId: NEW_PRICE, stripeKey: 'sk_test_x', successUrl: 'https://www.getfunnl.com/s', cancelUrl: 'https://www.getfunnl.com/c' }
test('permanent Pro: Checkout is refused server-side (409) before any claim or Stripe call', async () => {
  let stripeCalls = 0
  const admin = checkoutAdmin({ data: { ai_enabled: true }, error: null })
  const r = await runCheckoutOrchestration({ user: { id: USER, email: 'a@example.test' }, supabaseAdmin: admin, createStripeSession: async () => { stripeCalls++; return { outcome: 'success' } }, env: ENV })
  assert.equal(r.status, 409)
  assert.equal(r.body.state, 'permanent_pro')
  assert.equal(stripeCalls + admin.calls.rpc, 0)
  assert.deepEqual(admin.calls.tables, ['profiles'])
})
test('a profile lookup failure fails closed (503) without calling Stripe', async () => {
  let stripeCalls = 0
  const r = await runCheckoutOrchestration({ user: { id: USER }, supabaseAdmin: checkoutAdmin({ data: null, error: { code: 'x' } }), createStripeSession: async () => { stripeCalls++ }, env: ENV })
  assert.equal(r.status, 503)
  assert.equal(stripeCalls, 0)
})
test('a non-permanent account still reaches the normal Checkout path', async () => {
  const admin = checkoutAdmin({ data: { ai_enabled: false }, error: null })
  await runCheckoutOrchestration({ user: { id: USER, email: 'a@example.test' }, supabaseAdmin: admin, createStripeSession: async () => ({ outcome: 'unknown_failure' }), env: ENV })
  assert.deepEqual(admin.calls.tables.slice(0, 2), ['profiles', 'subscriptions'])
  assert.equal(admin.calls.rpc, 1, 'the claim ran')
})
test('the app offers no purchase to permanent Pro (no upgrade control in the permanent state)', () => {
  const page = readFileSync(new URL('../src/pages/SettingsPage.jsx', import.meta.url), 'utf8')
  const at = page.indexOf("proClass === 'permanent' ?"), end = page.indexOf("proClass === 'subscribed' ?", at)
  assert.ok(at > 0 && end > at)
  assert.ok(!page.slice(at, end).includes('ProComingSoon') && !/checkout|Upgrade|Subscribe/i.test(page.slice(at, end)))
})
