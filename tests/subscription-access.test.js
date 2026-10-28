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
import { subscriptionAccessUntil, subscriptionGrantsAccessAt, PAYMENT_GRACE_MS, PENDING_RENEWAL_ALLOWANCE_MS } from '../supabase/functions/shared/subscriptionStatusPolicy.js'
import { evaluateProEntitlement } from '../supabase/functions/shared/pro-entitlement.js'
import { runWebhookOrchestration } from '../supabase/functions/stripe-webhook/webhookHandler.js'
import { extractProSubscriptionSnapshot, extractInvoiceEvidence, classifyBindingRefusal, subscriptionRenewsAutomatically } from '../supabase/functions/stripe-webhook/webhookHelpers.js'
import { runCheckoutOrchestration } from '../supabase/functions/create-checkout-session/checkoutOrchestrator.js'

const DAY = 86400000
const HOUR = 3600000
const T = Date.parse('2026-11-16T00:00:00.000Z')            // a period end / renewal moment
const at = (ms) => new Date(ms)
const USER = '11111111-1111-4111-8111-111111111111'
const NEW_PRICE = 'price_new', OLD_PRICE = 'price_old'

// ── The rule at its cutoffs (evidence model, migration 20261023000000) ─────────────────────────────
const ev1 = (o) => ({ status: 'active', evidence_version: 1, current_period_end: null, paid_through: null, failed_invoice_id: null, grace_started_at: null, ...o })
test('paid access runs exactly through the verified paid period; no allowance after it', () => {
  const sub = ev1({ paid_through: new Date(T).toISOString(), current_period_end: new Date(T + 30 * DAY).toISOString() })
  for (const [ms, want] of [[T - DAY, true], [T - 1, true], [T, false], [T + 1, false], [T + 7 * DAY - 1, false]]) {
    assert.equal(subscriptionGrantsAccessAt(sub, at(ms)), want, new Date(ms).toISOString())
  }
})
test('status alone never grants: active with no verified payment, or past_due with no verified failure, is Free', () => {
  assert.equal(subscriptionAccessUntil(ev1({ current_period_end: new Date(T + 30 * DAY).toISOString() })), null)
  assert.equal(subscriptionAccessUntil(ev1({ status: 'past_due', paid_through: new Date(T).toISOString() })).getTime(), T, 'only the paid period')
})
for (const status of ['past_due', 'unpaid', 'active']) {
  test(`${status} with a verified failed renewal: Pro until exactly 7 days after the FIRST failed payment`, () => {
    const F = T + 3600000   // first failed payment, an hour after the renewal
    const sub = ev1({ status, paid_through: new Date(T).toISOString(), failed_invoice_id: 'in_r', grace_started_at: new Date(F).toISOString() })
    for (const [ms, want] of [[F, true], [F + 7 * DAY - 1, true], [F + 7 * DAY, false], [F + 20 * DAY, false]]) assert.equal(subscriptionGrantsAccessAt(sub, at(ms)), want)
    assert.equal(subscriptionAccessUntil({ ...sub, failed_invoice_id: null }).getTime(), T, 'an anchor without an outstanding failure grants nothing')
  })
}
test('legacy rows (before the migration, no evidence yet): active through Stripe’s reported period end only', () => {
  const legacy = { status: 'active', evidence_version: 0, current_period_end: new Date(T).toISOString() }
  for (const [ms, want] of [[T - 1, true], [T, false]]) assert.equal(subscriptionGrantsAccessAt(legacy, at(ms)), want)
  assert.equal(subscriptionAccessUntil({ ...legacy, status: 'past_due' }), null)
})
test('statuses without subscription access never grant, whatever the evidence', () => {
  for (const status of ['canceled', 'incomplete', 'incomplete_expired', 'trialing', 'paused', 'none', 'mystery', '', null]) {
    assert.equal(subscriptionAccessUntil(ev1({ status, paid_through: new Date(T + 30 * DAY).toISOString(), failed_invoice_id: 'in_r', grace_started_at: new Date(T).toISOString() })), null, String(status))
  }
  assert.equal(subscriptionAccessUntil(null), null)
  assert.equal(subscriptionGrantsAccessAt(ev1({ paid_through: new Date(T).toISOString() }), 'now'), false, 'requires a Date')
  assert.equal(PAYMENT_GRACE_MS, 7 * DAY)
})
test('entitlement: permanent and trial grants are unchanged; a stale paid row no longer grants forever', () => {
  const stale = { status: 'active', evidence_version: 0, current_period_end: '2026-09-13T00:00:00.000Z', cancel_at_period_end: false }
  const now = new Date('2026-10-22T00:00:00.000Z')
  assert.equal(evaluateProEntitlement({ ai_enabled: false }, null, stale, now).canUse, false)
  assert.equal(evaluateProEntitlement({ ai_enabled: true }, null, stale, now).reason, 'permanent')
  assert.equal(evaluateProEntitlement({ ai_enabled: false }, { started_at: '2026-10-20T00:00:00Z', ends_at: '2026-10-27T00:00:00Z' }, stale, now).reason, 'trial')
  assert.equal(evaluateProEntitlement({ ai_enabled: false }, null, ev1({ paid_through: '2026-10-30T00:00:00Z' }), now).reason, 'subscription')
})

// ── Invoice evidence (re-fetched invoices only) ────────────────────────────────────────────────────
const inv = (o = {}) => ({ id: 'in_R', object: 'invoice', livemode: false, customer: 'cus_X', subscription: 'sub_X', created: T / 1000, billing_reason: 'subscription_cycle',
  status: 'paid', attempt_count: 1, lines: { data: [{ price: { id: NEW_PRICE }, period: { start: T / 1000, end: (T + 30 * DAY) / 1000 } }] }, ...o })
const EXPECT = { subscriptionId: 'sub_X', customerId: 'cus_X', priceIds: [NEW_PRICE], mode: 'test' }
test('evidence: a paid invoice of the bound subscription and customer gives the period it pays for', () => {
  const e = extractInvoiceEvidence(inv(), EXPECT)
  assert.deepEqual(e, { ok: true, kind: 'paid', invoiceId: 'in_R', createdIso: new Date(T).toISOString(), periodEndIso: new Date(T + 30 * DAY).toISOString() })
  // 2025+ invoice shape: parent.subscription_details and pricing.price_details.
  const modern = inv({ subscription: undefined, parent: { subscription_details: { subscription: 'sub_X' } }, lines: { data: [{ pricing: { price_details: { price: NEW_PRICE } }, period: { end: (T + 30 * DAY) / 1000 } }] } })
  assert.equal(extractInvoiceEvidence(modern, EXPECT).kind, 'paid')
})
test('evidence: an unpaid invoice after a payment attempt is a failure; only a renewal is grace-eligible', () => {
  assert.deepEqual(extractInvoiceEvidence(inv({ status: 'open' }), EXPECT), { ok: true, kind: 'failed', invoiceId: 'in_R', createdIso: new Date(T).toISOString(), renewal: true })
  assert.equal(extractInvoiceEvidence(inv({ status: 'open', billing_reason: 'subscription_create' }), EXPECT).renewal, false)
  assert.equal(extractInvoiceEvidence(inv({ status: 'open', attempt_count: 0 }), EXPECT).kind, 'none', 'not attempted yet is not a failure')
  assert.equal(extractInvoiceEvidence(inv({ status: 'void' }), EXPECT).kind, 'none')
})
test('evidence: another subscription, another customer, the other mode or a malformed invoice is refused', () => {
  assert.equal(extractInvoiceEvidence(inv({ subscription: 'sub_OTHER' }), EXPECT).reason, 'ownership_mismatch')
  assert.equal(extractInvoiceEvidence(inv({ customer: 'cus_OTHER' }), EXPECT).reason, 'ownership_mismatch')
  assert.equal(extractInvoiceEvidence(inv({ livemode: true }), EXPECT).reason, 'environment_mismatch')
  assert.equal(extractInvoiceEvidence(inv(), { ...EXPECT, mode: null }).reason, 'environment_mismatch')
  assert.equal(extractInvoiceEvidence(inv({ lines: { data: [] } }), EXPECT).reason, 'no_matching_line')
  assert.equal(extractInvoiceEvidence(inv({ id: 'x' }), EXPECT).reason, 'malformed')
  assert.equal(extractInvoiceEvidence(inv({ created: null }), EXPECT).reason, 'malformed')
})

// ── Webhook: a subscription bound to a Funnl user keeps syncing on its bound price ─────────────────
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
      if (fn === 'apply_subscription_evidence') { (calls.evidence ??= []).push(args); return Promise.resolve({ data: { result: 'applied' }, error: null }) }
      return Promise.resolve({ data: null, error: null })
    },
    from () { return builder() },
  }
}
const subOn = (price, extra = {}) => ({ id: 'sub_X', customer: 'cus_X', status: 'active', created: (T - 60 * DAY) / 1000, cancel_at_period_end: false, metadata: { user_id: USER },
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
  // The older-price fallback (bound price) is for subscriptions already bound - never for a new purchase.
  assert.ok(checkout.includes('extractProSubscriptionSnapshot(sub, priceId)') && !checkout.includes('boundSnap') && !checkout.includes('bound.price_id'))
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

// ── Webhook: invoice events become verified evidence ───────────────────────────────────────────────
const BOUND = { user_id: USER, price_id: NEW_PRICE, stripe_customer_id: 'cus_X' }
const invoiceEvt = (type, created = T / 1000 + 3600) => ({ id: 'evt_invoice01', type, created, data: { object: { id: 'in_R' } } })
const runInvoice = (type, invoice, admin, created) => runWebhookOrchestration({ event: invoiceEvt(type, created), requestId: 'r', supabaseAdmin: admin,
  fetchSubscription: async () => { throw new Error('no subscription fetch for invoice events') }, fetchInvoice: async () => invoice, env: { priceId: NEW_PRICE, stripeKey: 'sk_test_x' } })
test('invoice.payment_failed for a renewal: the FAILURE time is Stripe’s event timestamp, applied through the merge', async () => {
  const admin = fakeAdmin({ bound: BOUND })
  const failedAt = T / 1000 + 3600
  const r = await runInvoice('invoice.payment_failed', inv({ status: 'open' }), admin, failedAt)
  assert.equal(r.status, 200)
  assert.deepEqual(admin.calls.evidence, [{ p_user_id: USER, p_subscription_id: 'sub_X', p_customer_id: 'cus_X', p_invoice_id: 'in_R', p_invoice_created: new Date(T).toISOString(),
    p_kind: 'failed', p_paid_period_end: null, p_failed_at: new Date(failedAt * 1000).toISOString() }])
  assert.equal(admin.calls.upserts.length, 0, 'no status write from an invoice event')
})
test('invoice.paid: verified paid evidence for the period it covers', async () => {
  const admin = fakeAdmin({ bound: BOUND })
  await runInvoice('invoice.paid', inv(), admin)
  assert.equal(admin.calls.evidence[0].p_kind, 'paid')
  assert.equal(admin.calls.evidence[0].p_paid_period_end, new Date(T + 30 * DAY).toISOString())
})
test('a failure event whose invoice is already PAID records payment, not a failure (delayed delivery)', async () => {
  const admin = fakeAdmin({ bound: BOUND })
  await runInvoice('invoice.payment_failed', inv(), admin)
  assert.equal(admin.calls.evidence[0].p_kind, 'paid')
})
test('an initial purchase that fails never gets grace (bound or not)', async () => {
  const unbound = fakeAdmin()
  const r = await runInvoice('invoice.payment_failed', inv({ status: 'open', billing_reason: 'subscription_create' }), unbound)
  assert.equal(r.status, 200)
  assert.deepEqual(unbound.calls.marks, ['ignored'])
  const bound = fakeAdmin({ bound: BOUND })
  await runInvoice('invoice.payment_failed', inv({ status: 'open', billing_reason: 'subscription_create' }), bound)
  assert.equal(bound.calls.evidence, undefined)
  assert.deepEqual(bound.calls.marks, ['ignored'])
})
test('an invoice of another customer, or a non-failure event on an open invoice, records nothing', async () => {
  const a1 = fakeAdmin({ bound: BOUND })
  const r1 = await runInvoice('invoice.payment_failed', inv({ status: 'open', customer: 'cus_OTHER' }), a1)
  assert.equal(r1.status, 500)
  assert.equal(a1.calls.evidence, undefined)
  const a2 = fakeAdmin({ bound: BOUND })
  await runInvoice('invoice.payment_succeeded', inv({ status: 'open' }), a2)
  assert.equal(a2.calls.evidence, undefined, 'a failure time is taken only from invoice.payment_failed')
})
test('a renewal invoice for a subscription not yet bound is retried (500), never dropped', async () => {
  const admin = fakeAdmin()
  const r = await runInvoice('invoice.paid', inv(), admin)
  assert.equal(r.status, 500)
  assert.deepEqual(admin.calls.marks, ['failed'])
})
test('after a subscription write, a PAID latest invoice is recorded as evidence; an unpaid one is not', async () => {
  const paidAdmin = fakeAdmin()
  await runWebhookOrchestration({ event: updated(subOn(NEW_PRICE, { latest_invoice: 'in_R' })), requestId: 'r', supabaseAdmin: paidAdmin,
    fetchSubscription: async () => subOn(NEW_PRICE, { latest_invoice: 'in_R' }), fetchInvoice: async () => inv(), env: { priceId: NEW_PRICE, stripeKey: 'sk_test_x' } })
  assert.equal(paidAdmin.calls.upserts.length, 1)
  assert.equal(paidAdmin.calls.evidence[0].p_kind, 'paid')
  const openAdmin = fakeAdmin()
  await runWebhookOrchestration({ event: updated(subOn(NEW_PRICE, { latest_invoice: 'in_R' })), requestId: 'r', supabaseAdmin: openAdmin,
    fetchSubscription: async () => subOn(NEW_PRICE, { latest_invoice: 'in_R' }), fetchInvoice: async () => inv({ status: 'open' }), env: { priceId: NEW_PRICE, stripeKey: 'sk_test_x' } })
  assert.equal(openAdmin.calls.evidence, undefined, 'an active snapshot with an unpaid invoice is not proof of payment')
})

// ── A different subscription replaces the bound one only on VERIFIED Stripe ordering ──────────────
test('binding refusals from the database are classified; anything else is not', () => {
  assert.equal(classifyBindingRefusal({ message: 'subscription_superseded' }), 'superseded')
  assert.equal(classifyBindingRefusal({ message: 'subscription_ended_not_bound' }), 'superseded')
  assert.equal(classifyBindingRefusal({ message: 'subscription_order_unknown' }), 'conflict')
  assert.equal(classifyBindingRefusal({ message: 'subscription_order_equal' }), 'conflict')
  for (const e of [null, undefined, {}, { message: 'boom' }, { code: '23505', message: 'duplicate key' }]) assert.equal(classifyBindingRefusal(e), null)
})
function bindingAdmin ({ current = null, upsertError = null, establish = 'recorded' } = {}) {
  const calls = { upserts: [], marks: [], establish: [] }
  const builder = () => {
    const st = { filters: {} }
    const b = {
      select () { return b }, eq (c, v) { st.filters[c] = v; return b },
      maybeSingle () { return Promise.resolve({ data: 'user_id' in st.filters ? current : null, error: null }) },
      upsert (payload) { calls.upserts.push(payload); return Promise.resolve({ error: upsertError }) },
    }
    return b
  }
  return {
    calls,
    rpc (fn, args) {
      if (fn === 'claim_webhook_event') return Promise.resolve({ data: { result: 'claimed', claim_token: 'tok' }, error: null })
      if (fn === 'mark_webhook_event') { calls.marks.push(args.p_failure_code ? `${args.p_status}:${args.p_failure_code}` : args.p_status); return Promise.resolve({ data: true, error: null }) }
      if (fn === 'establish_subscription_created') { calls.establish.push(args); return Promise.resolve({ data: { result: establish }, error: null }) }
      return Promise.resolve({ data: null, error: null })
    },
    from () { return builder() },
  }
}
// The user's row is bound (before the migration) to sub_B, whose creation time was never stored.
const LEGACY_B = { stripe_subscription_id: 'sub_B', stripe_customer_id: 'cus_X', stripe_subscription_created: null }
const stripeB = { id: 'sub_B', object: 'subscription', customer: 'cus_X', created: (T - 10 * DAY) / 1000, livemode: false, metadata: { user_id: USER } }
const incomingA = subOn(NEW_PRICE, { id: 'sub_A', created: (T - 40 * DAY) / 1000, livemode: false })
const runReplace = (admin, subs) => runWebhookOrchestration({ event: { ...updated(incomingA), id: 'evt_replace01' }, requestId: 'r', supabaseAdmin: admin,
  fetchSubscription: async (id) => subs[id] ?? null, env: { priceId: NEW_PRICE, stripeKey: 'sk_test_x' } })
test('unknown bound creation time: the BOUND subscription is fetched, verified and recorded before the write', async () => {
  const admin = bindingAdmin({ current: LEGACY_B })
  await runReplace(admin, { sub_A: incomingA, sub_B: stripeB })
  assert.deepEqual(admin.calls.establish, [{ p_user_id: USER, p_subscription_id: 'sub_B', p_customer_id: 'cus_X', p_created: new Date(T - 10 * DAY).toISOString() }])
  assert.equal(admin.calls.upserts.length, 1, 'the database then judges the replacement')
})
test('the bound subscription cannot be verified (other customer, owner or mode, no creation time, wrong id): 500 binding_conflict, no write', async () => {
  for (const bad of [{ ...stripeB, customer: 'cus_OTHER' }, { ...stripeB, metadata: { user_id: '22222222-2222-4222-8222-222222222222' } },
    { ...stripeB, livemode: true }, { ...stripeB, livemode: undefined }, { ...stripeB, created: undefined }, { ...stripeB, id: 'sub_OTHER' }]) {
    const admin = bindingAdmin({ current: LEGACY_B })
    const r = await runReplace(admin, { sub_A: incomingA, sub_B: bad })
    assert.equal(r.status, 500)
    assert.deepEqual(admin.calls.marks, ['failed:binding_conflict'])
    assert.equal(admin.calls.establish.length + admin.calls.upserts.length, 0)
  }
  const missing = bindingAdmin({ current: LEGACY_B })
  assert.equal((await runReplace(missing, { sub_A: incomingA })).status, 500, 'the bound subscription could not be fetched: retried')
  assert.deepEqual(missing.calls.marks, ['failed:stripe_fetch_failed'])
})
test('a stored creation time that differs from Stripe’s is a conflict, never overwritten', async () => {
  const admin = bindingAdmin({ current: LEGACY_B, establish: 'mismatch' })
  const r = await runReplace(admin, { sub_A: incomingA, sub_B: stripeB })
  assert.equal(r.status, 500)
  assert.deepEqual(admin.calls.marks, ['failed:binding_conflict'])
  assert.equal(admin.calls.upserts.length, 0)
})
test('known creation time, the same subscription, or no row: nothing extra is fetched or recorded', async () => {
  for (const current of [{ ...LEGACY_B, stripe_subscription_created: new Date(T).toISOString() }, { ...LEGACY_B, stripe_subscription_id: 'sub_A' }, null]) {
    const admin = bindingAdmin({ current }); const fetched = []
    await runWebhookOrchestration({ event: { ...updated(incomingA), id: 'evt_replace02' }, requestId: 'r', supabaseAdmin: admin,
      fetchSubscription: async (id) => { fetched.push(id); return id === 'sub_A' ? incomingA : stripeB }, env: { priceId: NEW_PRICE, stripeKey: 'sk_test_x' } })
    assert.deepEqual(fetched, ['sub_A'])
    assert.equal(admin.calls.establish.length, 0)
  }
})
test('database refusals: provably older or ended -> 200 ignored; unknown or equal order -> 500 binding_conflict (never "processed")', async () => {
  const known = { ...LEGACY_B, stripe_subscription_created: new Date(T).toISOString() }
  for (const [message, status, mark] of [['subscription_superseded', 200, 'ignored'], ['subscription_ended_not_bound', 200, 'ignored'],
    ['subscription_order_unknown', 500, 'failed:binding_conflict'], ['subscription_order_equal', 500, 'failed:binding_conflict']]) {
    for (const via of ['update', 'checkout']) {
      const admin = bindingAdmin({ current: known, upsertError: { code: 'P0001', message } })
      const r = via === 'update' ? await runReplace(admin, { sub_A: incomingA })
        : await runWebhookOrchestration({ event: { id: 'evt_replace03', type: 'checkout.session.completed', created: T / 1000,
          data: { object: { id: 'cs_A', customer: 'cus_X', subscription: 'sub_A', client_reference_id: USER, metadata: { user_id: USER } } } },
          requestId: 'r', supabaseAdmin: admin, fetchSubscription: async () => incomingA, env: { priceId: NEW_PRICE, stripeKey: 'sk_test_x' } })
      assert.equal(r.status, status, `${via} ${message}`)
      assert.deepEqual(admin.calls.marks, [mark], `${via} ${message}`)
    }
  }
})

// ── Pending-renewal allowance: 24 hours after the VERIFIED paid period (approved 2026-10-28) ────────
const RENEWING = (o) => ev1({ paid_through: new Date(T).toISOString(), verified_paid_through: new Date(T).toISOString(), renews_automatically: true, ...o })
test('allowance: Pro immediately before the 24-hour cutoff, Free exactly at and after it', () => {
  for (const status of ['active', 'past_due', 'unpaid']) {
    const sub = RENEWING({ status })
    for (const [ms, want] of [[T - 1, true], [T, true], [T + 24 * HOUR - 1, true], [T + 24 * HOUR, false], [T + 24 * HOUR + 1, false], [T + 7 * DAY, false]]) {
      assert.equal(subscriptionGrantsAccessAt(sub, at(ms)), want, `${status} @ ${ms - T}`)
    }
  }
  assert.equal(PENDING_RENEWAL_ALLOWANCE_MS, 24 * HOUR)
})
test('allowance requires a previously VERIFIED paid period AND automatic renewal; status alone never grants it', () => {
  // No verified paid invoice (an initial purchase never paid, or a legacy-converted row): paid period only.
  assert.equal(subscriptionAccessUntil(RENEWING({ verified_paid_through: null })).getTime(), T)
  // Scheduled to cancel / manual invoices / paused: no allowance.
  assert.equal(subscriptionAccessUntil(RENEWING({ renews_automatically: false })).getTime(), T)
  assert.equal(subscriptionAccessUntil(RENEWING({ renews_automatically: null })).getTime(), T)
  // Canceled (immediate cancellation) or any other ended status: nothing at all.
  for (const status of ['canceled', 'incomplete', 'incomplete_expired', 'paused', 'trialing']) assert.equal(subscriptionAccessUntil(RENEWING({ status })), null, status)
  // A legacy row (before the migration) never gets it.
  assert.equal(subscriptionAccessUntil({ status: 'active', evidence_version: 0, current_period_end: new Date(T).toISOString(), verified_paid_through: new Date(T).toISOString(), renews_automatically: true }).getTime(), T)
})
test('a verified failure switches to the 7-day grace from the first failed payment (no allowance alongside it)', () => {
  const failedEarly = RENEWING({ failed_invoice_id: 'in_r', grace_started_at: new Date(T + HOUR).toISOString() })
  assert.equal(subscriptionAccessUntil(failedEarly).getTime(), T + HOUR + 7 * DAY, 'failure inside the allowance window')
  const failedLate = RENEWING({ failed_invoice_id: 'in_r', grace_started_at: new Date(T + 30 * HOUR).toISOString() })
  assert.equal(subscriptionGrantsAccessAt(failedLate, at(T + 25 * HOUR)), true, 'once the failure is reported, grace runs 7 days from the failure')
  assert.equal(subscriptionAccessUntil(failedLate).getTime(), T + 30 * HOUR + 7 * DAY)
})
test('recovery advances access through the newly verified paid period; the allowance follows the NEW verified end', () => {
  const paidAgain = RENEWING({ paid_through: new Date(T + 30 * DAY).toISOString(), verified_paid_through: new Date(T + 30 * DAY).toISOString() })
  assert.equal(subscriptionAccessUntil(paidAgain).getTime(), T + 30 * DAY + 24 * HOUR)
})
test('automatic renewal: only charge_automatically, not scheduled to cancel, not paused, live status', () => {
  const base = { status: 'active', collection_method: 'charge_automatically', cancel_at_period_end: false, cancel_at: null, pause_collection: null }
  assert.equal(subscriptionRenewsAutomatically(base), true)
  assert.equal(subscriptionRenewsAutomatically({ ...base, status: 'past_due' }), true)
  for (const bad of [{ cancel_at_period_end: true }, { cancel_at_period_end: undefined }, { cancel_at: 1_800_000_000 }, { collection_method: 'send_invoice' },
    { collection_method: undefined }, { pause_collection: { behavior: 'void' } }, { status: 'canceled' }, { status: 'incomplete' }, { status: 'trialing' }]) {
    assert.equal(subscriptionRenewsAutomatically({ ...base, ...bad }), false, JSON.stringify(bad))
  }
  assert.equal(subscriptionRenewsAutomatically(null), false)
})
test('webhook writes record automatic-renewal eligibility and when the Stripe read STARTED (before the fetch)', async () => {
  const times = ['2026-11-16T00:00:01.000Z', '2026-11-16T00:00:09.000Z', '2026-11-16T00:00:10.000Z']; let i = 0
  const order = []
  const admin = fakeAdmin()
  const sub = subOn(NEW_PRICE, { collection_method: 'charge_automatically', cancel_at: null })
  await runWebhookOrchestration({ event: updated(sub), requestId: 'r', supabaseAdmin: admin, now: () => { order.push('now'); return times[Math.min(i++, times.length - 1)] },
    fetchSubscription: async () => { order.push('fetch'); return sub }, env: { priceId: NEW_PRICE, stripeKey: 'sk_test_x' } })
  assert.equal(admin.calls.upserts[0].renews_automatically, true)
  assert.equal(admin.calls.upserts[0].renewal_state_read_at, times[0], 'the time taken BEFORE the Stripe read')
  assert.equal(order.indexOf('now') < order.indexOf('fetch'), true)
  const cancelling = fakeAdmin()
  await runUpdate(subOn(NEW_PRICE, { collection_method: 'charge_automatically', cancel_at_period_end: true }), cancelling)
  assert.equal(cancelling.calls.upserts[0].renews_automatically, false)
})
