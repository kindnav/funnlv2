/**
 * account-deletion-subscription.test.js — subscription-safe account deletion
 * (supabase/functions/delete-account/subscriptionCancellation.js), driven by a fake Stripe and a fake
 * database client. No network, no real Stripe, no Production.
 *
 * Policy pinned here: cancel immediately before deleting, no refund (prorate=false, invoice_now=false),
 * keep the account when cancellation cannot be confirmed, and delete normally without a subscription.
 *
 * Run with: node tests/account-deletion-subscription.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cancelAccountSubscriptions, makeStripeRequest, stripeKeyMode, ENDED_STATUSES } from '../supabase/functions/delete-account/subscriptionCancellation.js'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const TEST_KEY = 'sk_test_synthetic'
const LIVE_KEY = 'sk_live_synthetic'

// ── Fakes ────────────────────────────────────────────────────────────────────────────────────────
function fakeAdmin ({ sub = null, op = null, subError = false, opError = false } = {}) {
  return {
    from (table) {
      const row = table === 'subscriptions' ? sub : table === 'checkout_operations' ? op : null
      const failing = table === 'subscriptions' ? subError : opError
      const q = { select () { return q }, eq () { return q }, async maybeSingle () { return failing ? { data: null, error: { code: 'x' } } : { data: row, error: null } } }
      return q
    },
  }
}
const timeoutErr = () => { const e = new Error('stripe_request_timeout'); e.name = 'TimeoutError'; return e }

// In-memory Stripe. `hooks` can override any single call by "METHOD path" (once or always).
function fakeStripe ({ live = false, subs = [], sessions = [], hooks = {} } = {}) {
  const S = new Map(subs.map((s) => [s.id, { livemode: live, metadata: { user_id: USER }, ...s }]))
  const C = new Map(sessions.map((s) => [s.id, { livemode: live, client_reference_id: USER, metadata: { user_id: USER }, ...s }]))
  const calls = []
  async function stripeRequest (method, path, opts = {}) {
    calls.push({ method, path, opts })
    const key = method + ' ' + path
    const h = hooks[key]
    if (h) {
      const r = typeof h === 'function' ? h({ S, C, calls }) : h
      if (r === 'timeout') throw timeoutErr()
      if (r !== 'passthrough') return r
    }
    const parts = path.split('/')
    if (path.startsWith('/v1/checkout/sessions/')) {
      const s = C.get(decodeURIComponent(parts[4]))
      if (!s) return { status: 404, body: { error: { type: 'invalid_request_error' } } }
      if (method === 'GET') return { status: 200, body: { ...s } }
      if (method === 'POST' && parts[5] === 'expire') {
        if (s.status !== 'open') return { status: 400, body: { error: { type: 'invalid_request_error' } } }
        s.status = 'expired'; return { status: 200, body: { ...s } }
      }
    }
    if (path === '/v1/subscriptions' && method === 'GET') {
      return { status: 200, body: { data: [...S.values()].filter((s) => s.customer === opts.params.customer).map((s) => ({ ...s })), has_more: false } }
    }
    if (path.startsWith('/v1/subscriptions/')) {
      const s = S.get(decodeURIComponent(parts[3]))
      if (!s) return { status: 404, body: { error: { type: 'invalid_request_error' } } }
      if (method === 'GET') return { status: 200, body: { ...s } }
      if (method === 'DELETE') {
        if (ENDED_STATUSES.has(s.status)) return { status: 400, body: { error: { type: 'invalid_request_error' } } }
        s.status = 'canceled'; return { status: 200, body: { ...s } }
      }
    }
    return { status: 500, body: null }
  }
  return { stripeRequest, calls, S, C }
}
const run = (stripe, admin, key = TEST_KEY) => cancelAccountSubscriptions({ userId: USER, admin, stripeKey: key, stripeRequest: stripe.stripeRequest })
const deletes = (stripe) => stripe.calls.filter((c) => c.method === 'DELETE')
const ROW = { stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A', status: 'active' }

// ── No subscription ─────────────────────────────────────────────────────────────────────────────
test('an account without billing rows deletes normally and Stripe is never called', async () => {
  const stripe = fakeStripe()
  const r = await run(stripe, fakeAdmin(), '')
  assert.deepEqual(r, { ok: true, canceled: 0, alreadyEnded: 0, sessionsExpired: 0, billing: false })
  assert.equal(stripe.calls.length, 0)
})
test('billing rows without a usable Stripe key: account kept, retryable, Stripe not called', async () => {
  for (const key of ['', 'pk_live_x', 'whsec_x', undefined]) {
    const stripe = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }] })
    const r = await cancelAccountSubscriptions({ userId: USER, admin: fakeAdmin({ sub: ROW }), stripeKey: key, stripeRequest: stripe.stripeRequest })
    assert.deepEqual(r, { ok: false, retryable: true, reason: 'billing_unavailable' })
    assert.equal(stripe.calls.length, 0)
  }
})
test('a database lookup failure keeps the account (retryable)', async () => {
  assert.equal((await run(fakeStripe(), fakeAdmin({ subError: true }))).reason, 'billing_lookup_failed')
  assert.equal((await run(fakeStripe(), fakeAdmin({ opError: true }))).reason, 'billing_lookup_failed')
})

// ── Every known subscription state ──────────────────────────────────────────────────────────────
for (const status of ['active', 'past_due', 'trialing', 'unpaid', 'paused', 'incomplete']) {
  test(`status ${status}: canceled immediately with no proration and no final invoice`, async () => {
    const stripe = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status }] })
    const r = await run(stripe, fakeAdmin({ sub: { ...ROW, status } }))
    assert.deepEqual(r, { ok: true, canceled: 1, alreadyEnded: 0, sessionsExpired: 0, billing: true })
    const d = deletes(stripe)
    assert.equal(d.length, 1)
    assert.deepEqual(d[0].opts.params, { prorate: 'false', invoice_now: 'false' })
    assert.equal(d[0].opts.idempotencyKey, 'funnl-account-deletion:cancel:sub_A')
    assert.equal(stripe.S.get('sub_A').status, 'canceled')
  })
}
for (const status of ['canceled', 'incomplete_expired']) {
  test(`status ${status}: already ended, so no cancel call and deletion proceeds`, async () => {
    const stripe = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status }] })
    const r = await run(stripe, fakeAdmin({ sub: { ...ROW, status } }))
    assert.deepEqual(r, { ok: true, canceled: 0, alreadyEnded: 1, sessionsExpired: 0, billing: true })
    assert.equal(deletes(stripe).length, 0)
  })
}
test('the stored status is never trusted: a row saying canceled is still checked and canceled if active in Stripe', async () => {
  const stripe = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }] })
  const r = await run(stripe, fakeAdmin({ sub: { ...ROW, status: 'canceled' } }))
  assert.equal(r.canceled, 1)
})

// ── Failures, timeouts and retries ──────────────────────────────────────────────────────────────
test('cancel times out but Stripe did cancel: the re-read confirms it', async () => {
  const stripe = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }],
    hooks: { 'DELETE /v1/subscriptions/sub_A': ({ S }) => { S.get('sub_A').status = 'canceled'; return 'timeout' } } })
  assert.deepEqual(await run(stripe, fakeAdmin({ sub: ROW })), { ok: true, canceled: 1, alreadyEnded: 0, sessionsExpired: 0, billing: true })
})
test('cancel times out and the re-read also fails: account kept (retryable)', async () => {
  let n = 0
  const stripe = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }],
    hooks: { 'DELETE /v1/subscriptions/sub_A': 'timeout', 'GET /v1/subscriptions/sub_A': () => (n++ === 0 ? 'passthrough' : 'timeout') } })
  assert.deepEqual(await run(stripe, fakeAdmin({ sub: ROW })), { ok: false, retryable: true, reason: 'cancel_unconfirmed' })
})
test('cancel refused with a server error and the subscription is still active: account kept', async () => {
  const stripe = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }],
    hooks: { 'DELETE /v1/subscriptions/sub_A': { status: 500, body: { error: { message: 'secret detail' } } } } })
  const r = await run(stripe, fakeAdmin({ sub: ROW }))
  assert.deepEqual(r, { ok: false, retryable: true, reason: 'cancel_unconfirmed' })
  assert.ok(!JSON.stringify(r).includes('secret detail'), 'provider text never leaves the module')
})
test('a timed-out or failed lookup keeps the account (retryable); an unknown subscription needs support', async () => {
  const t = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }], hooks: { 'GET /v1/subscriptions/sub_A': 'timeout' } })
  assert.equal((await run(t, fakeAdmin({ sub: ROW }))).reason, 'subscription_lookup_failed')
  const l = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }], hooks: { 'GET /v1/subscriptions': 'timeout' } })
  assert.deepEqual(await run(l, fakeAdmin({ sub: ROW })), { ok: false, retryable: true, reason: 'subscription_list_failed' })
  assert.equal(deletes(l).length, 0, 'nothing canceled before the customer check passes')
  const missing = fakeStripe({ subs: [] })
  assert.deepEqual(await run(missing, fakeAdmin({ sub: ROW })), { ok: false, retryable: false, reason: 'subscription_unverifiable' })
})
test('repeated requests are idempotent: the second run finds it canceled and makes no cancel call', async () => {
  const stripe = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }] })
  const admin = fakeAdmin({ sub: ROW })                    // database deletion "failed": the row is still there
  assert.equal((await run(stripe, admin)).canceled, 1)
  const before = deletes(stripe).length
  const second = await run(stripe, admin)
  assert.deepEqual(second, { ok: true, canceled: 0, alreadyEnded: 1, sessionsExpired: 0, billing: true })
  assert.equal(deletes(stripe).length, before, 'no second cancel')
  assert.ok(!stripe.calls.some((c) => c.method === 'POST' && !c.path.endsWith('/expire')), 'nothing is ever created')
})

// ── Ownership and environment ───────────────────────────────────────────────────────────────────
test('a subscription whose Stripe metadata names another Funnl user is not canceled (needs support)', async () => {
  const stripe = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active', metadata: { user_id: OTHER } }] })
  assert.deepEqual(await run(stripe, fakeAdmin({ sub: ROW })), { ok: false, retryable: false, reason: 'ownership_mismatch' })
  assert.equal(deletes(stripe).length, 0)
})
test('a subscription on a different customer than the stored one is not canceled', async () => {
  const stripe = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_OTHER', status: 'active' }] })
  assert.equal((await run(stripe, fakeAdmin({ sub: ROW }))).reason, 'ownership_mismatch')
  assert.equal(deletes(stripe).length, 0)
})
test('test/live mismatch is refused, both ways', async () => {
  const liveObj = fakeStripe({ live: true, subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }] })
  assert.equal((await run(liveObj, fakeAdmin({ sub: ROW }), TEST_KEY)).reason, 'environment_mismatch')
  const testObj = fakeStripe({ live: false, subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }] })
  assert.equal((await run(testObj, fakeAdmin({ sub: ROW }), LIVE_KEY)).reason, 'environment_mismatch')
  assert.equal(deletes(liveObj).length + deletes(testObj).length, 0)
  const ok = fakeStripe({ live: true, subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }] })
  assert.equal((await run(ok, fakeAdmin({ sub: ROW }), 'rk_live_synthetic')).canceled, 1, 'restricted live key in live mode works')
})
test('another active subscription on the same customer: refused BEFORE anything is canceled', async () => {
  const stripe = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }, { id: 'sub_B', customer: 'cus_A', status: 'active' }] })
  assert.deepEqual(await run(stripe, fakeAdmin({ sub: ROW })), { ok: false, retryable: false, reason: 'other_active_subscription' })
  assert.equal(deletes(stripe).length, 0)
  const ended = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }, { id: 'sub_OLD', customer: 'cus_A', status: 'canceled' }] })
  assert.equal((await run(ended, fakeAdmin({ sub: ROW }))).canceled, 1, 'an old ended subscription does not block')
})

// ── Checkout sessions (delayed activation) ──────────────────────────────────────────────────────
const OP = { stripe_session_id: 'cs_A', state: 'ready' }
test('an open Checkout session is expired so it can no longer be paid', async () => {
  const stripe = fakeStripe({ sessions: [{ id: 'cs_A', status: 'open', customer: null, subscription: null }] })
  const r = await run(stripe, fakeAdmin({ op: OP }))
  assert.deepEqual(r, { ok: true, canceled: 0, alreadyEnded: 0, sessionsExpired: 1, billing: true })
  const ex = stripe.calls.find((c) => c.path.endsWith('/expire'))
  assert.equal(ex.opts.idempotencyKey, 'funnl-account-deletion:expire:cs_A')
})
test('paid before its webhook arrived: the completed session’s subscription is found and canceled', async () => {
  const stripe = fakeStripe({ sessions: [{ id: 'cs_A', status: 'complete', customer: 'cus_N', subscription: 'sub_N' }],
    subs: [{ id: 'sub_N', customer: 'cus_N', status: 'active' }] })
  const r = await run(stripe, fakeAdmin({ op: OP }))             // no subscriptions row yet
  assert.equal(r.canceled, 1)
  assert.equal(stripe.S.get('sub_N').status, 'canceled')
})
test('the session completes while being expired: the re-read finds the subscription and cancels it', async () => {
  const stripe = fakeStripe({ sessions: [{ id: 'cs_A', status: 'open', customer: 'cus_N', subscription: null }],
    subs: [{ id: 'sub_N', customer: 'cus_N', status: 'active' }],
    hooks: { 'POST /v1/checkout/sessions/cs_A/expire': ({ C }) => { Object.assign(C.get('cs_A'), { status: 'complete', subscription: 'sub_N' }); return { status: 400, body: null } } } })
  const r = await run(stripe, fakeAdmin({ op: OP }))
  assert.deepEqual(r, { ok: true, canceled: 1, alreadyEnded: 0, sessionsExpired: 0, billing: true })
})
test('a session for another user, an unknown session, or an unanswered one keeps the account', async () => {
  const other = fakeStripe({ sessions: [{ id: 'cs_A', status: 'open', client_reference_id: OTHER, metadata: { user_id: OTHER } }] })
  assert.equal((await run(other, fakeAdmin({ op: OP }))).reason, 'ownership_mismatch')
  assert.deepEqual(await run(fakeStripe(), fakeAdmin({ op: OP })), { ok: false, retryable: false, reason: 'session_unverifiable' })
  const slow = fakeStripe({ sessions: [{ id: 'cs_A', status: 'open' }], hooks: { 'GET /v1/checkout/sessions/cs_A': 'timeout' } })
  assert.deepEqual(await run(slow, fakeAdmin({ op: OP })), { ok: false, retryable: true, reason: 'session_lookup_failed' })
})

// ── Privacy and transport ───────────────────────────────────────────────────────────────────────
test('results carry only codes and counts - never ids, keys or provider text', async () => {
  const cases = [
    [fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }] }), fakeAdmin({ sub: ROW })],
    [fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active', metadata: { user_id: OTHER } }] }), fakeAdmin({ sub: ROW })],
    [fakeStripe({ sessions: [{ id: 'cs_A', status: 'open' }] }), fakeAdmin({ op: OP })],
  ]
  for (const [s, a] of cases) {
    const text = JSON.stringify(await run(s, a))
    for (const secret of ['sub_A', 'cus_A', 'cs_A', USER, OTHER, TEST_KEY]) assert.ok(!text.includes(secret), secret)
  }
})
test('stripeKeyMode recognises only secret and restricted keys', () => {
  assert.equal(stripeKeyMode('sk_test_x'), 'test'); assert.equal(stripeKeyMode('rk_test_x'), 'test')
  assert.equal(stripeKeyMode('sk_live_x'), 'live'); assert.equal(stripeKeyMode('rk_live_x'), 'live')
  for (const k of ['pk_live_x', 'whsec_x', '', null, 42]) assert.equal(stripeKeyMode(k), null)
})
test('makeStripeRequest: query parameters for GET/DELETE, idempotency header, bearer key, bounded by a timeout', async () => {
  const seen = []
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return { status: 200, json: async () => ({ ok: 1 }) } }
  const req = makeStripeRequest({ stripeKey: 'sk_test_k', fetchImpl, baseUrl: 'https://stripe.invalid' })
  await req('DELETE', '/v1/subscriptions/sub_A', { params: { prorate: 'false', invoice_now: 'false' }, idempotencyKey: 'k1' })
  assert.equal(seen[0].url, 'https://stripe.invalid/v1/subscriptions/sub_A?prorate=false&invoice_now=false')
  assert.equal(seen[0].init.method, 'DELETE')
  assert.equal(seen[0].init.headers.Authorization, 'Bearer sk_test_k')
  assert.equal(seen[0].init.headers['Idempotency-Key'], 'k1')
  assert.equal(seen[0].init.body, undefined)
  await req('POST', '/v1/checkout/sessions/cs_A/expire', { idempotencyKey: 'k2' })
  assert.equal(seen[1].init.method, 'POST')
  const hang = makeStripeRequest({ stripeKey: 'sk_test_k', timeoutMs: 20, fetchImpl: (u, i) => new Promise((resolve, reject) => i.signal.addEventListener('abort', () => reject(new Error('aborted')))) })
  await assert.rejects(hang('GET', '/v1/subscriptions/sub_A'), (e) => e.name === 'TimeoutError')
})
test('the default Stripe base URL is fixed (no environment override)', () => {
  const src = readFileSync(new URL('../supabase/functions/delete-account/subscriptionCancellation.js', import.meta.url), 'utf8')
  assert.ok(src.includes("baseUrl = 'https://api.stripe.com'"))
  const idx = readFileSync(new URL('../supabase/functions/delete-account/index.ts', import.meta.url), 'utf8')
  assert.ok(idx.includes('makeStripeRequest({ stripeKey })'), 'the function never passes a base URL')
})

// ── The Edge Function and the Settings page ─────────────────────────────────────────────────────
import { readDeleteAccountErrorCode, deleteAccountErrorMessage } from '../src/lib/settingsLifecycle.js'
const EDGE = readFileSync(new URL('../supabase/functions/delete-account/index.ts', import.meta.url), 'utf8')
test('delete-account: authentication, then billing, then contacts, then the auth user', () => {
  const at = (n) => { const i = EDGE.indexOf(n); assert.ok(i > 0, n); return i }
  assert.ok(at('auth.getUser()') < at('const admin = createClient(') && at('const admin = createClient(') < at('cancelAccountSubscriptions({'))
  assert.ok(at('cancelAccountSubscriptions({') < at("from('contacts')") && at("from('contacts')") < at('auth.admin.deleteUser(user.id)'))
  assert.ok(at('if (!billing.ok) {') < at("from('contacts')"), 'a billing refusal returns before anything is deleted')
  assert.ok(EDGE.includes('userId: user.id,'), 'billing uses only the verified user id')
})
test('delete-account: controlled codes only, never error text, and 503 vs 409 by retryability', () => {
  assert.ok(EDGE.includes("billing.retryable ? 'subscription_cancel_unconfirmed' : 'subscription_needs_support'"))
  assert.ok(EDGE.includes('status: billing.retryable ? 503 : 409'))
  assert.ok(!EDGE.includes('err.message') && !EDGE.includes('Err.message'), 'no database or provider text in a response')
  assert.ok(EDGE.includes("JSON.stringify({ error: { code: 'delete_failed' } })"))
  const logs = EDGE.split('console.log(').slice(1).map((s) => s.slice(0, s.indexOf(')))') + 2))
  for (const l of logs) for (const bad of ['user.id', 'stripeKey', 'customer', 'subscription_id', 'session']) assert.ok(!l.includes(bad), bad + ' in a log')
})
test('Settings reads the controlled code from a failed invoke and shows an actionable message', async () => {
  const ctx = (body) => ({ context: { json: async () => body } })
  assert.equal(await readDeleteAccountErrorCode(ctx({ error: { code: 'subscription_cancel_unconfirmed' } }), 'x'), 'subscription_cancel_unconfirmed')
  assert.equal(await readDeleteAccountErrorCode(ctx({ error: 'Not authenticated' }), 'network_error'), 'network_error')
  assert.equal(await readDeleteAccountErrorCode({ context: { json: async () => { throw new Error('no body') } } }, 'network_error'), 'network_error')
  assert.equal(await readDeleteAccountErrorCode(null, 'unknown'), 'unknown')
  assert.ok(deleteAccountErrorMessage('subscription_cancel_unconfirmed').includes('your account was not deleted'))
  assert.ok(deleteAccountErrorMessage('subscription_cancel_unconfirmed').includes('try again'))
  assert.ok(deleteAccountErrorMessage('subscription_needs_support').includes('navbir12345@gmail.com'))
  assert.equal(deleteAccountErrorMessage('delete_failed'), 'Something went wrong. Please try again.')
  const page = readFileSync(new URL('../src/pages/SettingsPage.jsx', import.meta.url), 'utf8')
  assert.ok(page.includes('it is canceled immediately, without a refund.'), 'the dialog states the policy before confirming')
  assert.ok(page.includes('setDeleteError(deleteAccountErrorMessage(code))'))
})
test('defense in depth: the subscription itself is environment-checked even if the customer listing passed', async () => {
  const stripe = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }],
    hooks: { 'GET /v1/subscriptions/sub_A': ({ S }) => ({ status: 200, body: { ...S.get('sub_A'), livemode: true } }) } })
  assert.deepEqual(await run(stripe, fakeAdmin({ sub: ROW })), { ok: false, retryable: false, reason: 'environment_mismatch' })
  assert.equal(deletes(stripe).length, 0)
})
