/**
 * Tests for supabase/functions/stripe-webhook/webhookHandler.js
 *
 * These exercise the REAL production orchestration (runWebhookOrchestration) — the
 * same function index.ts calls — through injected fakes (mock Supabase client,
 * fake Stripe fetch, injected clock + logger). No production logic is copied into
 * the tests; they invoke the exported function and assert on its {status, body}
 * result, the DB calls it made, and the privacy-safe log payloads it emitted.
 *
 * Zero external deps — runs with: node tests/webhook-orchestration.test.js
 */
import { runWebhookOrchestration } from '../supabase/functions/stripe-webhook/webhookHandler.js'

let passed = 0
let failed = 0
const RUN = []
function test(name, fn) { RUN.push({ name, fn }) }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const USER   = '11111111-1111-4111-8111-111111111111'
const USER2  = '22222222-2222-4222-8222-222222222222'
const PRICE  = 'price_pro'
const NOW_ISO = '2026-08-14T00:00:00.000Z'

// ── Mock Supabase service-role client ──────────────────────────────────────────
// Supports exactly the chains webhookHandler.js uses:
//   .rpc('claim_webhook_event' | 'mark_webhook_event', args)
//   .from('subscriptions').select('user_id').eq(col,val).maybeSingle()
//   .from('subscriptions').upsert(payload, opts)
//   .from('subscriptions').update(payload).eq().eq().select('user_id')   (awaited)
function makeSupabase(cfg = {}) {
  const calls = { rpc: [], mark: [], lookups: [], upserts: [], deletes: [] }

  function fromBuilder() {
    const state = { op: null, filters: {}, updatePayload: null }
    const builder = {
      select(cols) { state.selectCols = cols; state.op = state.op ?? 'select'; return builder },
      eq(col, val) { state.filters[col] = val; return builder },
      maybeSingle() {
        calls.lookups.push({ filters: { ...state.filters } })
        if ('stripe_subscription_id' in state.filters) {
          return Promise.resolve(cfg.lookupBySub ?? { data: null, error: null })
        }
        if ('stripe_customer_id' in state.filters) {
          return Promise.resolve(cfg.lookupByCustomer ?? { data: null, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      },
      upsert(payload, opts) {
        calls.upserts.push({ payload, opts })
        return Promise.resolve(cfg.upsert ?? { error: null })
      },
      update(payload) { state.op = 'update'; state.updatePayload = payload; return builder },
      // Only the deletion path awaits the builder directly (after .update().eq().eq().select()).
      then(resolve, reject) {
        calls.deletes.push({ payload: state.updatePayload, filters: { ...state.filters } })
        return Promise.resolve(cfg.deleteUpdate ?? { data: [{ user_id: USER }], error: null }).then(resolve, reject)
      },
    }
    return builder
  }

  return {
    calls,
    rpc(fn, args) {
      calls.rpc.push({ fn, args })
      if (fn === 'claim_webhook_event') {
        return Promise.resolve(cfg.claim ?? { data: { result: 'claimed', claim_token: 'tok-1' }, error: null })
      }
      if (fn === 'mark_webhook_event') {
        calls.mark.push(args)
        const r = typeof cfg.mark === 'function' ? cfg.mark(args) : cfg.mark
        return Promise.resolve(r ?? { data: true, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
    from(_table) { return fromBuilder() },
  }
}

// ── Event builders ──────────────────────────────────────────────────────────────
function checkoutEvent(objOverrides = {}) {
  return { id: 'evt_co', type: 'checkout.session.completed', created: 1_700_000_000,
    data: { object: { metadata: { user_id: USER }, customer: 'cus_1', subscription: 'sub_1', ...objOverrides } } }
}
function subEvent(type, objOverrides = {}) {
  return { id: 'evt_su', type, created: 1_700_000_000,
    data: { object: { id: 'sub_1', customer: 'cus_1', metadata: {}, ...objOverrides } } }
}
function deleteEvent(objOverrides = {}) {
  return { id: 'evt_del', type: 'customer.subscription.deleted', created: 1_700_000_000,
    data: { object: { id: 'sub_1', customer: 'cus_1', metadata: {}, ...objOverrides } } }
}
function invoiceEvent(type) {
  return { id: 'evt_inv', type, created: 1_700_000_000, data: { object: { id: 'in_1', customer: 'cus_1' } } }
}

function goodSub(overrides = {}) {
  return { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: 1_701_000_000,
    cancel_at_period_end: false, metadata: {}, items: { data: [{ price: { id: PRICE } }] }, ...overrides }
}

// Default deps; override per test.
function makeDeps(over = {}) {
  const logCalls = []
  const supabaseAdmin = over.supabaseAdmin ?? makeSupabase(over.supa)
  const deps = {
    event: over.event,
    requestId: 'req-1',
    supabaseAdmin,
    fetchSubscription: over.fetchSubscription ?? (async () => goodSub()),
    env: over.env ?? { priceId: PRICE, stripeKey: 'sk_test' },
    now: () => NOW_ISO,
    log: (name, fields) => logCalls.push({ name, fields }),
  }
  return { deps, supabaseAdmin, logCalls }
}

// Sensitive values that must NEVER appear in any log payload.
const SENSITIVE = ['cus_1', 'sub_1', USER, USER2, PRICE, '@']
function assertPrivacySafeLogs(logCalls) {
  const ALLOWED_KEYS = new Set(['requestId', 'eventType', 'reason', 'markStatus'])
  for (const { fields } of logCalls) {
    for (const k of Object.keys(fields)) {
      assert(ALLOWED_KEYS.has(k), `disallowed log key: ${k}`)
      const v = fields[k]
      if (v == null) continue
      const s = String(v)
      for (const bad of SENSITIVE) {
        assert(!s.includes(bad), `log field ${k} leaked sensitive value: ${s}`)
      }
    }
  }
}

async function run() {
  // 1 ── malformed signed event rejected before claim
  test('malformed signed event → 400, claim never called', async () => {
    const { deps, supabaseAdmin } = makeDeps({ event: { id: 'not_evt', type: '', created: 0, data: {} } })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 400)
    assertEqual(supabaseAdmin.calls.rpc.length, 0, 'claim must not be called for invalid shape')
  })

  // 2 ── new claim processes (checkout)
  test('new claim, valid checkout → 200 processed', async () => {
    const { deps } = makeDeps({ event: checkoutEvent() })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
  })

  // 3 ── duplicate claim returns 200 without Stripe or DB calls
  test('duplicate claim → 200, no fetch, no subscription DB calls', async () => {
    let fetched = false
    const { deps, supabaseAdmin } = makeDeps({
      event: checkoutEvent(),
      supa: { claim: { data: { result: 'duplicate' }, error: null } },
      fetchSubscription: async () => { fetched = true; return goodSub() },
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
    assert(!fetched, 'must not call Stripe on duplicate')
    assertEqual(supabaseAdmin.calls.upserts.length, 0)
    assertEqual(supabaseAdmin.calls.mark.length, 0, 'must not mark on duplicate')
  })

  // 4 ── in-progress claim → 503
  test('in-progress claim → 503', async () => {
    const { deps } = makeDeps({ event: checkoutEvent(), supa: { claim: { data: { result: 'in_progress' }, error: null } } })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 503)
  })

  // 5 ── claim RPC error → 500
  test('claim RPC error → 500', async () => {
    const { deps } = makeDeps({ event: checkoutEvent(), supa: { claim: { data: null, error: { code: 'XX' } } } })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
  })

  // 6 ── claim payload missing a valid token → 500
  test('claim result "claimed" with no token → 500', async () => {
    const { deps } = makeDeps({ event: checkoutEvent(), supa: { claim: { data: { result: 'claimed' }, error: null } } })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
  })

  // 7 ── successful checkout upsert + processed finalization
  test('checkout upsert payload correct + mark processed', async () => {
    const { deps, supabaseAdmin } = makeDeps({ event: checkoutEvent() })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
    const up = supabaseAdmin.calls.upserts[0].payload
    assertEqual(up.user_id, USER)
    assertEqual(up.stripe_subscription_id, 'sub_1')
    assertEqual(up.stripe_customer_id, 'cus_1')
    assertEqual(up.status, 'active')
    assertEqual(up.price_id, PRICE)
    assertEqual(up.updated_at, NOW_ISO)
    assertEqual(supabaseAdmin.calls.mark[0].p_status, 'processed')
    assertEqual(supabaseAdmin.calls.mark[0].p_claim_token, 'tok-1')
  })

  // 8 ── checkout missing user ID → 500 + failed(missing_user_id)
  test('checkout missing user_id → 500, mark failed missing_user_id', async () => {
    const { deps, supabaseAdmin } = makeDeps({ event: checkoutEvent({ metadata: {}, client_reference_id: null }) })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.mark[0].p_status, 'failed')
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'missing_user_id')
  })

  // 9 ── checkout missing customer/subscription IDs → 500 missing_ids
  test('checkout missing subscription id → 500 missing_ids', async () => {
    const { deps, supabaseAdmin } = makeDeps({ event: checkoutEvent({ subscription: null }) })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'missing_ids')
  })

  // 10 ── Stripe fetch failure → 500 stripe_fetch_failed
  test('Stripe fetch returns null → 500 stripe_fetch_failed', async () => {
    const { deps, supabaseAdmin } = makeDeps({ event: checkoutEvent(), fetchSubscription: async () => null })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'stripe_fetch_failed')
  })

  // 11 ── fetched subscription ID mismatch → 500
  test('fetched sub.id mismatch → 500 stripe_fetch_failed', async () => {
    const { deps, supabaseAdmin } = makeDeps({ event: checkoutEvent(), fetchSubscription: async () => goodSub({ id: 'sub_OTHER' }) })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'stripe_fetch_failed')
  })

  // 12 ── fetched customer mismatch → 500
  test('fetched sub.customer mismatch → 500', async () => {
    const { deps } = makeDeps({ event: checkoutEvent(), fetchSubscription: async () => goodSub({ customer: 'cus_OTHER' }) })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
  })

  // 13 ── missing price configuration → 500 config_missing
  test('missing STRIPE_PRO_PRICE_ID → 500 config_missing', async () => {
    const { deps, supabaseAdmin } = makeDeps({ event: checkoutEvent(), env: { priceId: '', stripeKey: 'sk' } })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'config_missing')
  })

  // 14 ── R4: empty items (no_items) FAILS CLOSED → 500 invalid_subscription_item
  test('subscription.updated with empty items (no_items) → 500 invalid_subscription_item', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: subEvent('customer.subscription.updated', { metadata: { user_id: USER } }),
      fetchSubscription: async () => goodSub({ metadata: { user_id: USER }, items: { data: [] } }),
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.upserts.length, 0)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'invalid_subscription_item')
  })

  // 15 ── wrong price → 200 ignored
  test('wrong price → 200 ignored', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: subEvent('customer.subscription.updated'),
      fetchSubscription: async () => goodSub({ items: { data: [{ price: { id: 'price_WRONG' } }] } }),
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
    assertEqual(supabaseAdmin.calls.upserts.length, 0)
  })

  // 16 ── unknown subscription status → 500 invalid_status
  test('unknown subscription status → 500 invalid_status', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: subEvent('customer.subscription.updated', { metadata: { user_id: USER } }),
      fetchSubscription: async () => goodSub({ status: 'bogus', metadata: { user_id: USER } }),
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'invalid_status')
  })

  // 17 ── ownership query error → 500 ownership_lookup_failed
  test('ownership lookup DB error → 500 ownership_lookup_failed', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: subEvent('customer.subscription.updated'),  // empty metadata → falls to lookup
      supa: { lookupBySub: { data: null, error: { code: 'XX' } } },
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'ownership_lookup_failed')
  })

  // 18 ── ownership absent but retryable → 500 owner_not_found
  test('ownership absent (retryable event) → 500 owner_not_found', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: subEvent('customer.subscription.updated'),
      supa: { lookupBySub: { data: null, error: null }, lookupByCustomer: { data: null, error: null } },
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'owner_not_found')
  })

  // 19 ── authoritative fetched metadata used (fetched wins over event snapshot)
  test('C2/P6: fetched metadata.user_id is authoritative; DB owner absent → no mismatch', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      // Event snapshot says USER2; fetched subscription says USER — fetched must win.
      // P6 now always performs the DB lookup for the cross-check (no short-circuit); with
      // no DB owner, the metadata owner is used and there is no mismatch.
      event: subEvent('customer.subscription.updated', { metadata: { user_id: USER2 } }),
      fetchSubscription: async () => goodSub({ metadata: { user_id: USER } }),
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
    assertEqual(supabaseAdmin.calls.upserts[0].payload.user_id, USER, 'must use fetched metadata user_id')
  })

  // ── P6: metadata owner vs DB owner cross-check ─────────────────────────────────
  test('P6: metadata owner MATCHES DB owner → 200 write', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: subEvent('customer.subscription.updated', { metadata: { user_id: USER } }),
      fetchSubscription: async () => goodSub({ metadata: { user_id: USER } }),
      supa: { lookupBySub: { data: { user_id: USER }, error: null } },
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
    assertEqual(supabaseAdmin.calls.upserts[0].payload.user_id, USER)
  })
  test('P6: metadata owner MISMATCHES DB owner → 500 ownership_mismatch, no write', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: subEvent('customer.subscription.updated', { metadata: { user_id: USER } }),
      fetchSubscription: async () => goodSub({ metadata: { user_id: USER } }),
      supa: { lookupBySub: { data: { user_id: USER2 }, error: null } },  // DB owner differs
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'ownership_mismatch')
    assertEqual(supabaseAdmin.calls.upserts.length, 0, 'must not write on ownership mismatch')
  })
  test('P6: missing legacy metadata → DB owner used, no mismatch', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: subEvent('customer.subscription.updated', { metadata: {} }),
      fetchSubscription: async () => goodSub({ metadata: {} }),   // legacy: no metadata.user_id
      supa: { lookupBySub: { data: { user_id: USER }, error: null } },
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
    assertEqual(supabaseAdmin.calls.upserts[0].payload.user_id, USER)
  })
  test('P6 (checkout): fetched sub metadata owner != session user → 500 ownership_mismatch, no write', async () => {
    // checkoutEvent session user is USER; the fetched subscription claims USER2.
    const { deps, supabaseAdmin } = makeDeps({
      event: checkoutEvent(),   // session metadata.user_id = USER
      fetchSubscription: async () => goodSub({ metadata: { user_id: USER2 } }),
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'ownership_mismatch')
    assertEqual(supabaseAdmin.calls.upserts.length, 0)
  })
  test('P6 (checkout): fetched sub metadata owner == session user → 200 write', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: checkoutEvent(),
      fetchSubscription: async () => goodSub({ metadata: { user_id: USER } }),
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
    assertEqual(supabaseAdmin.calls.upserts[0].payload.user_id, USER)
  })

  // 19b ── fetched metadata missing → existing subscription lookup resolves ownership
  test('C2: fetched metadata missing → lookup by fetched sub.id resolves owner', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: subEvent('customer.subscription.updated', { metadata: { user_id: USER2 } }),
      fetchSubscription: async () => goodSub({ metadata: {} }),   // no user_id in fetched
      supa: { lookupBySub: { data: { user_id: USER }, error: null } },
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
    // Lookup used the FETCHED subscription id, and resolved USER (not the event's USER2).
    assertEqual(supabaseAdmin.calls.lookups[0].filters.stripe_subscription_id, 'sub_1')
    assertEqual(supabaseAdmin.calls.upserts[0].payload.user_id, USER)
  })

  // 20 ── subscription upsert failure → 500 db_write_failed
  test('subscription upsert failure → 500 db_write_failed', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: subEvent('customer.subscription.updated', { metadata: { user_id: USER } }),
      fetchSubscription: async () => goodSub({ metadata: { user_id: USER } }),
      supa: { upsert: { error: { code: 'XX' } } },
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'db_write_failed')
  })

  // 21 ── old subscription deletion cannot cancel a replacement → superseded (200 ignored)
  test('deletion matching zero rows → 200 ignored (superseded), filter has both keys', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: deleteEvent({ metadata: { user_id: USER } }),
      supa: { deleteUpdate: { data: [], error: null } },
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
    assertEqual(supabaseAdmin.calls.mark[0].p_status, 'ignored')
    const del = supabaseAdmin.calls.deletes[0]
    assertEqual(del.filters.user_id, USER)
    assertEqual(del.filters.stripe_subscription_id, 'sub_1')
  })

  // 22 ── matching deletion cancels the correct row → processed
  test('deletion matching one row → 200 processed, status canceled', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: deleteEvent({ metadata: { user_id: USER } }),
      supa: { deleteUpdate: { data: [{ user_id: USER }], error: null } },
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
    assertEqual(supabaseAdmin.calls.deletes[0].payload.status, 'canceled')
    assertEqual(supabaseAdmin.calls.mark[0].p_status, 'processed')
  })

  // 23 ── invoice events cause no subscription writes
  test('invoice.payment_succeeded → 200 ignored, no fetch, no writes', async () => {
    let fetched = false
    const { deps, supabaseAdmin } = makeDeps({
      event: invoiceEvent('invoice.payment_succeeded'),
      fetchSubscription: async () => { fetched = true; return goodSub() },
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
    assert(!fetched, 'invoice events must not call Stripe')
    assertEqual(supabaseAdmin.calls.upserts.length, 0)
    assertEqual(supabaseAdmin.calls.deletes.length, 0)
    assertEqual(supabaseAdmin.calls.mark[0].p_status, 'ignored')
  })

  test('invoice.payment_failed → 200 ignored, no writes', async () => {
    const { deps, supabaseAdmin } = makeDeps({ event: invoiceEvent('invoice.payment_failed') })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
    assertEqual(supabaseAdmin.calls.upserts.length, 0)
  })

  // R3 ── item-level period end is stored as the correct ISO in the DB payload
  test('R3: modern item-level current_period_end stored as ISO in upsert', async () => {
    const ITEM_PE = 1_704_067_200 // 2024-01-01T00:00:00Z
    const { deps, supabaseAdmin } = makeDeps({
      event: subEvent('customer.subscription.updated', { metadata: { user_id: USER } }),
      fetchSubscription: async () => goodSub({
        metadata: { user_id: USER },
        current_period_end: undefined,
        items: { data: [{ price: { id: PRICE }, current_period_end: ITEM_PE }] },
      }),
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
    assertEqual(supabaseAdmin.calls.upserts[0].payload.current_period_end, '2024-01-01T00:00:00.000Z')
  })

  // R3 ── our price but a period-less / malformed item → fail closed
  test('R3: our price but no valid period end → 500 invalid_subscription_item', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: subEvent('customer.subscription.updated', { metadata: { user_id: USER } }),
      fetchSubscription: async () => goodSub({
        metadata: { user_id: USER },
        current_period_end: undefined,
        items: { data: [{ price: { id: PRICE } }] }, // no item-level pe, no legacy
      }),
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'invalid_subscription_item')
  })

  // R6 ── upsert unique-violation → identity conflict, fail closed
  test('R6: upsert 23505 (identity attached to another user) → 500 identity_conflict', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: subEvent('customer.subscription.updated', { metadata: { user_id: USER } }),
      fetchSubscription: async () => goodSub({ metadata: { user_id: USER } }),
      supa: { upsert: { error: { code: '23505' } } },
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'identity_conflict')
  })

  test('R6: non-unique upsert error still → 500 db_write_failed', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: subEvent('customer.subscription.updated', { metadata: { user_id: USER } }),
      fetchSubscription: async () => goodSub({ metadata: { user_id: USER } }),
      supa: { upsert: { error: { code: '55000' } } },
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'db_write_failed')
  })

  // ── R4: no_items / malformed items fail closed on ALL routes; only no_matching_item ignores ──
  const malformedItemCases = [
    ['no_items (empty)',       { data: [] }],
    ['malformed_items',        { data: 'nope' }],
    ['multiple items (mixed)', { data: [{ price: { id: PRICE }, current_period_end: 1_704_067_200 }, { price: { id: 'other' }, current_period_end: 1_704_067_200 }] }],
    ['no_period_end',          { data: [{ price: { id: PRICE } }] }],
  ]
  for (const [label, items] of malformedItemCases) {
    test(`R4: subscription.created ${label} → 500 invalid_subscription_item`, async () => {
      const { deps, supabaseAdmin } = makeDeps({
        event: subEvent('customer.subscription.created', { metadata: { user_id: USER } }),
        fetchSubscription: async () => goodSub({ metadata: { user_id: USER }, current_period_end: undefined, items }),
      })
      const r = await runWebhookOrchestration(deps)
      assertEqual(r.status, 500)
      assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'invalid_subscription_item')
      assertEqual(supabaseAdmin.calls.upserts.length, 0)
    })
    test(`R4: checkout.session.completed ${label} → 500 invalid_subscription_item`, async () => {
      const { deps, supabaseAdmin } = makeDeps({
        event: checkoutEvent(),
        fetchSubscription: async () => goodSub({ current_period_end: undefined, items }),
      })
      const r = await runWebhookOrchestration(deps)
      assertEqual(r.status, 500)
      assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'invalid_subscription_item')
      assertEqual(supabaseAdmin.calls.upserts.length, 0)
    })
  }
  test('R4: only no_matching_item is ignored 200 (subscription.updated, wrong price)', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: subEvent('customer.subscription.updated'),
      fetchSubscription: async () => goodSub({ items: { data: [{ price: { id: 'price_OTHER' }, current_period_end: 1_704_067_200 }] } }),
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
    assertEqual(supabaseAdmin.calls.mark[0].p_status, 'ignored')
  })

  // ── P5: bounded Stripe retrieval timeout → finalize failed provider_timeout, 503 ──
  test('P5: fetch timeout on checkout.session.completed → 503 provider_timeout (finalized)', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: checkoutEvent(),
      fetchSubscription: async () => 'timeout',
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 503)
    assertEqual(supabaseAdmin.calls.mark[0].p_status, 'failed')
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'provider_timeout')
    assertEqual(supabaseAdmin.calls.upserts.length, 0)
  })
  test('P5: fetch timeout on subscription.updated → 503 provider_timeout (finalized, reclaimable)', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: subEvent('customer.subscription.updated', { metadata: { user_id: USER } }),
      fetchSubscription: async () => 'timeout',
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 503)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'provider_timeout')
  })
  test('P5: non-timeout fetch failure still → 500 stripe_fetch_failed (distinct from timeout)', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: checkoutEvent(),
      fetchSubscription: async () => null,
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'stripe_fetch_failed')
  })

  // 24 ── mark RPC error → 500 Finalize failed
  test('mark RPC error on processed finalize → 500', async () => {
    const { deps } = makeDeps({
      event: checkoutEvent(),
      supa: { mark: { data: null, error: { code: 'XX' } } },
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(r.body, 'Finalize failed')
  })

  // 25 ── claim-token mismatch (mark returns false) → 503, never 200
  test('mark returns false (ownership lost) → 503, never 200', async () => {
    const { deps } = makeDeps({
      event: checkoutEvent(),
      supa: { mark: { data: false, error: null } },   // token no longer matches
    })
    const r = await runWebhookOrchestration(deps)
    assert(r.status !== 200, 'must NOT return 200 after losing claim ownership')
    assertEqual(r.status, 503)
  })

  test('token mismatch on an ignored path also returns 503 (not 200)', async () => {
    const { deps } = makeDeps({
      event: invoiceEvent('invoice.payment_failed'),
      supa: { mark: { data: false, error: null } },
    })
    const r = await runWebhookOrchestration(deps)
    assert(r.status !== 200)
    assertEqual(r.status, 503)
  })

  // 26 ── unexpected exception → 500 handler_exception
  test('unexpected exception during handling → 500 handler_exception', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      event: checkoutEvent(),
      fetchSubscription: async () => { throw new Error('boom') },
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 500)
    assertEqual(supabaseAdmin.calls.mark[0].p_failure_code, 'handler_exception')
  })

  // 27 ── privacy-safe log payloads across representative paths
  test('log payloads are privacy-safe across many paths', async () => {
    const scenarios = [
      { event: { id: 'x', type: '', created: 0, data: {} } },
      { event: checkoutEvent({ metadata: {}, client_reference_id: null }) },
      { event: checkoutEvent(), fetchSubscription: async () => null },
      { event: checkoutEvent(), fetchSubscription: async () => goodSub({ id: 'sub_OTHER' }) },
      { event: subEvent('customer.subscription.updated'), supa: { lookupBySub: { data: null, error: { code: 'X' } } } },
      { event: subEvent('customer.subscription.updated'), fetchSubscription: async () => goodSub({ status: 'bogus', metadata: { user_id: USER } }) },
      { event: deleteEvent({ metadata: { user_id: USER } }), supa: { deleteUpdate: { data: [], error: null } } },
      { event: invoiceEvent('invoice.payment_succeeded') },
      { event: checkoutEvent(), supa: { mark: { data: false, error: null } } },
      { event: checkoutEvent(), fetchSubscription: async () => { throw new Error('boom') } },
    ]
    for (const s of scenarios) {
      const { deps, logCalls } = makeDeps(s)
      await runWebhookOrchestration(deps)
      assertPrivacySafeLogs(logCalls)
    }
  })

  // Extra ── unknown/unhandled event type → 200 ignored
  test('unhandled event type → 200 ignored', async () => {
    const { deps, supabaseAdmin } = makeDeps({ event: { id: 'evt_zz9', type: 'customer.updated', created: 1_700_000_000, data: { object: { id: 'x' } } } })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
    assertEqual(supabaseAdmin.calls.mark[0].p_status, 'ignored')
  })

  // Extra ── subscription.created success path (distinct from updated)
  test('subscription.created valid → 200 processed', async () => {
    const { deps } = makeDeps({
      event: subEvent('customer.subscription.created', { metadata: { user_id: USER } }),
      fetchSubscription: async () => goodSub({ metadata: { user_id: USER } }),
    })
    const r = await runWebhookOrchestration(deps)
    assertEqual(r.status, 200)
  })

  for (const { name, fn } of RUN) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++ }
    catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
  }
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

run()
