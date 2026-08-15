/**
 * Tests for supabase/functions/create-checkout-session/checkoutOrchestrator.js
 *
 * Drives the REAL exported runCheckoutOrchestration (the same function index.ts calls)
 * through a mock Supabase client (subscription lookup + claim/finalize RPCs) and an
 * injected Stripe session creator. Asserts on {status, body}, the RPC/Stripe calls it
 * made, and the idempotency key (no PII).
 *
 * Zero deps — runs with: node tests/checkout-orchestration.test.js
 */
import { runCheckoutOrchestration } from '../supabase/functions/create-checkout-session/checkoutOrchestrator.js'

let passed = 0, failed = 0
const RUN = []
function test(name, fn) { RUN.push({ name, fn }) }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const USER  = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMAIL = 'person@example.com'
const PRICE = 'price_pro'
const OP    = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TOK   = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const READY_URL = 'https://checkout.stripe.com/c/pay/cs_ready'
const NEW_URL   = 'https://checkout.stripe.com/c/pay/cs_new'

function makeSupabase(cfg = {}) {
  const calls = { rpc: [], finalize: [], lookups: 0 }
  return {
    calls,
    from() {
      const b = {
        select() { return b },
        eq() { return b },
        maybeSingle() { calls.lookups++; return Promise.resolve(cfg.subLookup ?? { data: null, error: null }) },
      }
      return b
    },
    rpc(fn, args) {
      calls.rpc.push({ fn, args })
      if (fn === 'claim_checkout_operation') {
        return Promise.resolve(cfg.claim ?? { data: { result: 'claimed', operation_id: OP, claim_token: TOK }, error: null })
      }
      if (fn === 'finalize_checkout_operation') {
        calls.finalize.push(args)
        return Promise.resolve(cfg.finalize ?? { data: true, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
}

function makeStripe(cfg = {}) {
  const calls = []
  const fn = async ({ params, idempotencyKey, stripeKey }) => {
    calls.push({ idempotencyKey, params: params.toString(), stripeKey })
    if (cfg.throw) throw new Error('network down')
    return cfg.result ?? {
      ok: true, status: 200,
      session: { url: NEW_URL, id: 'cs_new', expires_at: 1_893_456_000 },
    }
  }
  fn.calls = calls
  return fn
}

function makeDeps(over = {}) {
  const logs = []
  const supabaseAdmin = makeSupabase(over.supa)
  const createStripeSession = over.stripe ?? makeStripe(over.stripeCfg)
  const deps = {
    user: over.user ?? { id: USER, email: EMAIL },
    supabaseAdmin,
    createStripeSession,
    env: over.env ?? { priceId: PRICE, stripeKey: 'sk_test', successUrl: 'https://x/s', cancelUrl: 'https://x/c' },
    now: () => '2026-08-15T00:00:00.000Z',
    log: (name, fields) => logs.push({ name, fields }),
    requestId: 'req-1',
  }
  return { deps, supabaseAdmin, createStripeSession, logs }
}

async function run() {
  // ── config / auth guards ──────────────────────────────────────────────────
  test('missing user → 401', async () => {
    const { deps } = makeDeps({ user: {} })
    assertEqual((await runCheckoutOrchestration(deps)).status, 401)
  })
  test('missing price/key config → 503, no Stripe', async () => {
    const { deps, createStripeSession } = makeDeps({ env: { priceId: '', stripeKey: '' } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 503)
    assertEqual(createStripeSession.calls.length, 0)
  })

  // ── subscription-status gating (R2) ─────────────────────────────────────────
  test('active subscription blocks checkout → 409, no claim, no Stripe', async () => {
    const { deps, supabaseAdmin, createStripeSession } = makeDeps({ supa: { subLookup: { data: { status: 'active' }, error: null } } })
    const r = await runCheckoutOrchestration(deps)
    assertEqual(r.status, 409)
    assertEqual(supabaseAdmin.calls.rpc.length, 0, 'must not claim when blocked')
    assertEqual(createStripeSession.calls.length, 0)
  })
  test('past_due subscription blocks checkout → 409', async () => {
    const { deps } = makeDeps({ supa: { subLookup: { data: { status: 'past_due' }, error: null } } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 409)
  })
  test('trialing/unpaid/paused block checkout → 409', async () => {
    for (const status of ['trialing', 'unpaid', 'paused']) {
      const { deps } = makeDeps({ supa: { subLookup: { data: { status }, error: null } } })
      assertEqual((await runCheckoutOrchestration(deps)).status, 409, status)
    }
  })
  test('subscription lookup error → 503, no Stripe', async () => {
    const { deps, createStripeSession } = makeDeps({ supa: { subLookup: { data: null, error: { code: 'XX' } } } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 503)
    assertEqual(createStripeSession.calls.length, 0)
  })

  // ── incomplete = reuse_only ──────────────────────────────────────────────────
  test('incomplete + reusable ready session → 200 reuse, no Stripe, allow_create=false', async () => {
    const { deps, supabaseAdmin, createStripeSession } = makeDeps({
      supa: {
        subLookup: { data: { status: 'incomplete' }, error: null },
        claim: { data: { result: 'reuse', checkout_url: READY_URL, operation_id: OP }, error: null },
      },
    })
    const r = await runCheckoutOrchestration(deps)
    assertEqual(r.status, 200)
    assertEqual(r.body.url, READY_URL)
    assertEqual(createStripeSession.calls.length, 0)
    assertEqual(supabaseAdmin.calls.rpc[0].args.p_allow_create, false, 'incomplete must not allow create')
  })
  test('incomplete + no reusable session → 409 blocked_no_reuse, no Stripe', async () => {
    const { deps, createStripeSession } = makeDeps({
      supa: {
        subLookup: { data: { status: 'incomplete' }, error: null },
        claim: { data: { result: 'blocked_no_reuse' }, error: null },
      },
    })
    assertEqual((await runCheckoutOrchestration(deps)).status, 409)
    assertEqual(createStripeSession.calls.length, 0)
  })

  // ── claim results ────────────────────────────────────────────────────────────
  test('reuse: second tab receives the same ready URL, no Stripe call', async () => {
    const { deps, createStripeSession } = makeDeps({
      supa: { claim: { data: { result: 'reuse', checkout_url: READY_URL, operation_id: OP }, error: null } },
    })
    const r = await runCheckoutOrchestration(deps)
    assertEqual(r.status, 200)
    assertEqual(r.body.url, READY_URL)
    assertEqual(createStripeSession.calls.length, 0)
  })
  test('reuse with invalid stored URL → 502', async () => {
    const { deps } = makeDeps({ supa: { claim: { data: { result: 'reuse', checkout_url: 'https://evil.com/x', operation_id: OP }, error: null } } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 502)
  })
  test('in_progress claim → 409, no Stripe (single-flight: no second call)', async () => {
    const { deps, createStripeSession } = makeDeps({ supa: { claim: { data: { result: 'in_progress' }, error: null } } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 409)
    assertEqual(createStripeSession.calls.length, 0)
  })
  test('claim RPC error → 503, no Stripe, no duplicate', async () => {
    const { deps, createStripeSession } = makeDeps({ supa: { claim: { data: null, error: { code: 'XX' } } } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 503)
    assertEqual(createStripeSession.calls.length, 0)
  })
  test('unknown claim result → 503 fail closed', async () => {
    const { deps } = makeDeps({ supa: { claim: { data: { result: 'weird' }, error: null } } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 503)
  })
  test('claimed without operation_id/token → 503 fail closed', async () => {
    const { deps } = makeDeps({ supa: { claim: { data: { result: 'claimed' }, error: null } } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 503)
  })

  // ── claimed → Stripe ─────────────────────────────────────────────────────────
  test('claimed → exactly one Stripe call, 200 with new URL, finalized ready', async () => {
    const { deps, supabaseAdmin, createStripeSession } = makeDeps()
    const r = await runCheckoutOrchestration(deps)
    assertEqual(r.status, 200)
    assertEqual(r.body.url, NEW_URL)
    assertEqual(createStripeSession.calls.length, 1, 'exactly one Stripe call')
    assertEqual(supabaseAdmin.calls.finalize.length, 1)
    assertEqual(supabaseAdmin.calls.finalize[0].p_state, 'ready')
    assertEqual(supabaseAdmin.calls.finalize[0].p_claim_token, TOK, 'finalize is token-validated')
    assertEqual(supabaseAdmin.calls.finalize[0].p_checkout_url, NEW_URL)
    // expires_at from Stripe's session.expires_at:
    assertEqual(supabaseAdmin.calls.finalize[0].p_expires_at, new Date(1_893_456_000 * 1000).toISOString())
  })
  test('idempotency key is the opaque operation id and contains NO PII', async () => {
    const { deps, createStripeSession } = makeDeps()
    await runCheckoutOrchestration(deps)
    const key = createStripeSession.calls[0].idempotencyKey
    assertEqual(key, `checkout-op-${OP}`)
    assert(!key.includes(USER), 'key must not contain the user id')
    assert(!key.includes(EMAIL), 'key must not contain the email')
  })
  test('stale reclaim reuses the SAME operation id → SAME idempotency key (crash-safety)', async () => {
    // A reclaimed 'creating' operation returns the same operation_id from claim.
    const { deps, createStripeSession } = makeDeps({
      supa: { claim: { data: { result: 'claimed', operation_id: OP, claim_token: 'rotated-token' }, error: null } },
    })
    await runCheckoutOrchestration(deps)
    assertEqual(createStripeSession.calls[0].idempotencyKey, `checkout-op-${OP}`,
      'reclaim must reuse the same Stripe idempotency key so Stripe returns the existing session')
  })

  // ── Stripe failure paths ─────────────────────────────────────────────────────
  test('Stripe throws (network) → 503, NOT finalized (leaves creating for crash-retry)', async () => {
    const { deps, supabaseAdmin } = makeDeps({ stripeCfg: { throw: true } })
    const r = await runCheckoutOrchestration(deps)
    assertEqual(r.status, 503)
    assertEqual(supabaseAdmin.calls.finalize.length, 0, 'must NOT finalize on unknown outcome')
  })
  test('Stripe definitive error → 502 + finalize failed', async () => {
    const { deps, supabaseAdmin } = makeDeps({ stripeCfg: { result: { ok: false, status: 400, session: null } } })
    const r = await runCheckoutOrchestration(deps)
    assertEqual(r.status, 502)
    assertEqual(supabaseAdmin.calls.finalize[0].p_state, 'failed')
  })
  test('Stripe ok but invalid URL → 502 + finalize failed', async () => {
    const { deps, supabaseAdmin } = makeDeps({ stripeCfg: { result: { ok: true, status: 200, session: { url: 'https://evil.com/x', id: 'cs' } } } })
    const r = await runCheckoutOrchestration(deps)
    assertEqual(r.status, 502)
    assertEqual(supabaseAdmin.calls.finalize[0].p_state, 'failed')
  })
  test('finalize RPC error on ready → 503 (retryable, no duplicate)', async () => {
    const { deps } = makeDeps({ supa: { finalize: { data: null, error: { code: 'XX' } } } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 503)
  })

  for (const { name, fn } of RUN) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++ }
    catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
  }
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}
run()
