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
import { cancelAccountSubscriptions, makeStripeRequest, stripeKeyMode, ENDED_STATUSES, UNCERTAIN_CREATION_SECONDS } from '../supabase/functions/delete-account/subscriptionCancellation.js'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const TEST_KEY = 'sk_test_synthetic'
const LIVE_KEY = 'sk_live_synthetic'

// ── Fakes ────────────────────────────────────────────────────────────────────────────────────────
// The database side: begin_account_deletion() (fence + checkout state) and the subscriptions row.
// `op` is a convenience for a 'ready' operation with one session; `fence` overrides the RPC result.
function fakeAdmin ({ sub = null, op = null, subError = false, fenceError = false, fence = null } = {}) {
  const fenceData = fence ?? { fenced: true, checkout_state: op ? 'ready' : 'none', creating_age_seconds: null, sessions: op?.stripe_session_id ? [op.stripe_session_id] : [] }
  const admin = {
    rpcCalls: [],
    async rpc (name, args) {
      admin.rpcCalls.push({ name, args })
      if (name !== 'begin_account_deletion' || fenceError) return { data: null, error: { code: 'x' } }
      return { data: fenceData, error: null }
    },
    from (table) {
      if (table !== 'subscriptions') throw new Error('unexpected table ' + table)
      const q = { select () { return q }, eq () { return q }, async maybeSingle () { return subError ? { data: null, error: { code: 'x' } } : { data: sub, error: null } } }
      return q
    },
  }
  return admin
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
  assert.deepEqual(await run(fakeStripe(), fakeAdmin({ fenceError: true })), { ok: false, retryable: true, reason: 'deletion_fence_failed' })
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
  assert.equal((await run(stripe, fakeAdmin({ sub: ROW }))).reason, 'customer_conflict')
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

// ── Finding 1: the Checkout/deletion race is closed by the durable fence ───────────────────────────
const fenced = (over) => ({ fenced: true, checkout_state: 'none', creating_age_seconds: null, sessions: [], ...over })
test('F1: the fence is taken first, for the verified user only, before any read or Stripe call', async () => {
  const admin = fakeAdmin({ sub: ROW })
  const stripe = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }] })
  await run(stripe, admin)
  assert.deepEqual(admin.rpcCalls, [{ name: 'begin_account_deletion', args: { p_user_id: USER } }])
})
test('F1: a creating operation without a session id is NOT "no billing": deletion is refused, retryable', async () => {
  for (const age of [0, 119, 121, 3600, 24 * 3600]) {
    const stripe = fakeStripe()
    const r = await run(stripe, fakeAdmin({ fence: fenced({ checkout_state: 'creating', creating_age_seconds: age }) }))
    assert.deepEqual(r, { ok: false, retryable: true, reason: 'checkout_creation_unresolved' }, 'age ' + age)
    assert.equal(stripe.calls.length, 0)
  }
  const missing = await run(fakeStripe(), fakeAdmin({ fence: fenced({ checkout_state: 'creating', creating_age_seconds: null }) }))
  assert.equal(missing.reason, 'checkout_creation_unresolved', 'an unknown age is treated as unresolved')
})
test('F1: a creating operation older than any session lifetime is resolved (its session can no longer be paid)', async () => {
  const r = await run(fakeStripe(), fakeAdmin({ fence: fenced({ checkout_state: 'creating', creating_age_seconds: UNCERTAIN_CREATION_SECONDS + 1 }) }))
  assert.deepEqual(r, { ok: true, canceled: 0, alreadyEnded: 0, sessionsExpired: 0, billing: false })
  assert.ok(UNCERTAIN_CREATION_SECONDS > 24 * 3600, 'the window covers Stripe’s 24-hour maximum session lifetime')
})
test('F1: a malformed fence result fails closed', async () => {
  for (const bad of [fenced({ checkout_state: 'weird' }), fenced({ sessions: 'cs_A' }), fenced({ sessions: ['not_a_session'] }), { fenced: false }]) {
    const r = await run(fakeStripe(), fakeAdmin({ fence: bad }))
    assert.equal(r.ok, false)
  }
})
test('F1: every session the fence reports (current and overwritten) is expired', async () => {
  const stripe = fakeStripe({ sessions: [{ id: 'cs_old', status: 'open' }, { id: 'cs_new', status: 'open' }] })
  const r = await run(stripe, fakeAdmin({ fence: fenced({ checkout_state: 'ready', sessions: ['cs_new', 'cs_old'] }) }))
  assert.equal(r.sessionsExpired, 2)
  assert.equal(stripe.C.get('cs_old').status, 'expired')
})

// ── Finding 2: the customer is resolved and validated before the customer-wide check ───────────────
const listCalls = (stripe) => stripe.calls.filter((c) => c.method === 'GET' && c.path === '/v1/subscriptions')
test('F2: a subscription whose customer differs from the stored customer stops before the customer-wide check', async () => {
  const stripe = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_B', status: 'active' }] })
  assert.deepEqual(await run(stripe, fakeAdmin({ sub: ROW })), { ok: false, retryable: false, reason: 'customer_conflict' })
  assert.equal(listCalls(stripe).length, 0, 'no listing with an unvalidated customer')
  assert.equal(deletes(stripe).length, 0)
})
test('F2: a customer discovered from a completed session must match its subscription before listing', async () => {
  const stripe = fakeStripe({ sessions: [{ id: 'cs_A', status: 'complete', customer: 'cus_S', subscription: 'sub_N' }],
    subs: [{ id: 'sub_N', customer: 'cus_OTHER', status: 'active' }] })
  assert.equal((await run(stripe, fakeAdmin({ op: { stripe_session_id: 'cs_A' } }))).reason, 'customer_conflict')
  assert.equal(listCalls(stripe).length, 0)
})
test('F2: the customer-wide check uses the customer validated from the subscription itself', async () => {
  const stripe = fakeStripe({ sessions: [{ id: 'cs_A', status: 'complete', customer: 'cus_N', subscription: 'sub_N' }],
    subs: [{ id: 'sub_N', customer: 'cus_N', status: 'active' }, { id: 'sub_X', customer: 'cus_N', status: 'active' }] })
  const r = await run(stripe, fakeAdmin({ op: { stripe_session_id: 'cs_A' } }))     // no subscriptions row at all
  assert.equal(r.reason, 'other_active_subscription', 'the unknown subscription on the resolved customer is found')
  assert.deepEqual(listCalls(stripe)[0].opts.params, { customer: 'cus_N', status: 'all', limit: '100' })
  assert.equal(deletes(stripe).length, 0)
})
test('F2: malformed customer or subscription identifiers fail closed', async () => {
  assert.equal((await run(fakeStripe(), fakeAdmin({ sub: { ...ROW, stripe_customer_id: 'bogus' } }))).reason, 'customer_malformed')
  assert.equal((await run(fakeStripe(), fakeAdmin({ sub: { ...ROW, stripe_subscription_id: 'bogus' } }))).reason, 'subscription_malformed')
  const noCustomer = fakeStripe({ subs: [{ id: 'sub_A', customer: null, status: 'active' }] })
  assert.equal((await run(noCustomer, fakeAdmin({ sub: ROW }))).reason, 'customer_malformed')
  const listOther = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }],
    hooks: { 'GET /v1/subscriptions': { status: 200, body: { data: [{ id: 'sub_Z', customer: 'cus_Z', status: 'canceled', livemode: false }], has_more: false } } } })
  assert.equal((await run(listOther, fakeAdmin({ sub: ROW }))).reason, 'customer_conflict', 'a listing that returns another customer fails closed')
})

// ── Finding 3: unknown or malformed Stripe data fails closed ───────────────────────────────────────
const expires = (stripe) => stripe.calls.filter((c) => c.path.endsWith('/expire'))
test('F3: an unknown Checkout status fails closed without expiring or deleting anything', async () => {
  for (const status of ['pending', '', null, 'OPEN']) {
    const stripe = fakeStripe({ sessions: [{ id: 'cs_A', status }] })
    assert.deepEqual(await run(stripe, fakeAdmin({ op: { stripe_session_id: 'cs_A' } })), { ok: false, retryable: false, reason: 'session_status_unknown' }, String(status))
    assert.equal(expires(stripe).length, 0)
  }
})
test('F3: a completed session missing its customer or subscription fails closed', async () => {
  for (const sess of [{ customer: null, subscription: 'sub_N' }, { customer: 'cus_N', subscription: null }, { customer: 'cus_N', subscription: 'pi_123' }]) {
    const stripe = fakeStripe({ sessions: [{ id: 'cs_A', status: 'complete', ...sess }], subs: [{ id: 'sub_N', customer: 'cus_N', status: 'active' }] })
    assert.deepEqual(await run(stripe, fakeAdmin({ op: { stripe_session_id: 'cs_A' } })), { ok: false, retryable: false, reason: 'session_missing_identifiers' })
    assert.equal(deletes(stripe).length, 0)
  }
})
test('F3: an expire response that does not match is not accepted; the re-read decides', async () => {
  const mismatches = [
    (C) => ({ status: 200, body: { ...C.get('cs_A'), id: 'cs_OTHER', status: 'expired' } }),
    (C) => ({ status: 200, body: { ...C.get('cs_A'), livemode: true, status: 'expired' } }),
    (C) => ({ status: 200, body: { ...C.get('cs_A'), status: 'open' } }),
    () => ({ status: 200, body: null }),
  ]
  for (const m of mismatches) {
    // Stripe did NOT expire it: the re-read shows it still open, so deletion must not proceed.
    const still = fakeStripe({ sessions: [{ id: 'cs_A', status: 'open' }], hooks: { 'POST /v1/checkout/sessions/cs_A/expire': ({ C }) => m(C) } })
    assert.deepEqual(await run(still, fakeAdmin({ op: { stripe_session_id: 'cs_A' } })), { ok: false, retryable: true, reason: 'session_expire_unconfirmed' })
  }
  // Stripe did expire it but answered with a malformed body: the re-read confirms, deletion proceeds.
  const did = fakeStripe({ sessions: [{ id: 'cs_A', status: 'open' }], hooks: { 'POST /v1/checkout/sessions/cs_A/expire': ({ C }) => { C.get('cs_A').status = 'expired'; return { status: 200, body: { id: 'cs_A' } } } } })
  assert.equal((await run(did, fakeAdmin({ op: { stripe_session_id: 'cs_A' } }))).sessionsExpired, 1)
})
test('F3: expire times out and the re-read times out: account kept (retryable), then a retry completes', async () => {
  let n = 0
  const stripe = fakeStripe({ sessions: [{ id: 'cs_A', status: 'open' }],
    hooks: { 'POST /v1/checkout/sessions/cs_A/expire': () => (n++ === 0 ? 'timeout' : 'passthrough'), 'GET /v1/checkout/sessions/cs_A': () => (n === 1 && n++ ? 'timeout' : 'passthrough') } })
  const admin = fakeAdmin({ op: { stripe_session_id: 'cs_A' } })
  assert.deepEqual(await run(stripe, admin), { ok: false, retryable: true, reason: 'session_expire_unconfirmed' })
  const second = await run(stripe, admin)
  assert.equal(second.ok, true)
  assert.equal(stripe.C.get('cs_A').status, 'expired')
  assert.ok(expires(stripe).every((c) => c.opts.idempotencyKey === 'funnl-account-deletion:expire:cs_A'), 'the same idempotency key on every attempt')
})
test('F3: an unknown subscription status fails closed and nothing is canceled', async () => {
  const stripe = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'mystery' }] })
  assert.deepEqual(await run(stripe, fakeAdmin({ sub: ROW })), { ok: false, retryable: false, reason: 'subscription_status_unknown' })
  assert.equal(deletes(stripe).length, 0)
  const listed = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }, { id: 'sub_Q', customer: 'cus_A', status: 'mystery' }] })
  assert.equal((await run(listed, fakeAdmin({ sub: ROW }))).reason, 'subscription_status_unknown')
  assert.equal(deletes(listed).length, 0)
})
test('F3: a cancel response for a different object is not accepted as confirmation', async () => {
  const stripe = fakeStripe({ subs: [{ id: 'sub_A', customer: 'cus_A', status: 'active' }],
    hooks: { 'DELETE /v1/subscriptions/sub_A': { status: 200, body: { id: 'sub_OTHER', customer: 'cus_A', status: 'canceled', livemode: false } } } })
  assert.deepEqual(await run(stripe, fakeAdmin({ sub: ROW })), { ok: false, retryable: true, reason: 'cancel_unconfirmed' })
})
