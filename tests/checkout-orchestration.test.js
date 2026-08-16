/**
 * Tests for supabase/functions/create-checkout-session/checkoutOrchestrator.js
 *
 * Drives the REAL exported runCheckoutOrchestration through a mock Supabase client
 * (subscription lookup + claim/finalize RPCs) and an injected Stripe session creator
 * that returns an explicit provider OUTCOME. Asserts on {status, body}, the RPC/Stripe
 * calls, the checkout mode passed to claim, the opaque idempotency key (no PII), and
 * the R3 ambiguous-outcome handling.
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
const NOW_MS  = 1_700_000_000_000
const NOW_SEC = 1_700_000_000
const FUTURE  = NOW_SEC + 3600   // 1h ahead
const PAST    = NOW_SEC - 10

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
        // Allow separate config for ready vs failed finalize.
        if (args.p_state === 'failed' && cfg.finalizeFailed) return Promise.resolve(cfg.finalizeFailed)
        return Promise.resolve(cfg.finalize ?? { data: true, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
}

// createStripeSession fake: returns { outcome, status, session } or throws.
function makeStripe(cfg = {}) {
  const calls = []
  const fn = async ({ params, idempotencyKey, stripeKey }) => {
    calls.push({ idempotencyKey, params: params.toString(), stripeKey })
    if (cfg.throw) throw new Error('network down')
    return cfg.result ?? {
      outcome: 'success', status: 200,
      session: { id: 'cs_new', url: NEW_URL, expires_at: FUTURE },
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
    nowMs: over.nowMs ?? (() => NOW_MS),   // milliseconds
    log: (name, fields) => logs.push({ name, fields }),
    requestId: 'req-1',
  }
  return { deps, supabaseAdmin, createStripeSession, logs }
}

async function run() {
  // ── auth / config ─────────────────────────────────────────────────────────
  test('missing user → 401', async () => {
    assertEqual((await runCheckoutOrchestration(makeDeps({ user: {} }).deps)).status, 401)
  })
  test('missing config → 503, no Stripe', async () => {
    const { deps, createStripeSession } = makeDeps({ env: { priceId: '', stripeKey: '' } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 503)
    assertEqual(createStripeSession.calls.length, 0)
  })

  // ── status gating (R2 policy) ────────────────────────────────────────────────
  test('active blocks → 409, no claim, no Stripe', async () => {
    const { deps, supabaseAdmin, createStripeSession } = makeDeps({ supa: { subLookup: { data: { status: 'active' }, error: null } } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 409)
    assertEqual(supabaseAdmin.calls.rpc.length, 0)
    assertEqual(createStripeSession.calls.length, 0)
  })
  test('past_due / trialing / unpaid / paused block → 409', async () => {
    for (const status of ['past_due', 'trialing', 'unpaid', 'paused']) {
      const { deps } = makeDeps({ supa: { subLookup: { data: { status }, error: null } } })
      assertEqual((await runCheckoutOrchestration(deps)).status, 409, status)
    }
  })
  test('subscription lookup error → 503, no Stripe', async () => {
    const { deps, createStripeSession } = makeDeps({ supa: { subLookup: { data: null, error: { code: 'XX' } } } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 503)
    assertEqual(createStripeSession.calls.length, 0)
  })

  // ── checkout mode passed to claim (R1) ───────────────────────────────────────
  test('none → claim p_mode=reuse_or_create', async () => {
    const { deps, supabaseAdmin } = makeDeps({ supa: { subLookup: { data: null, error: null } } })
    await runCheckoutOrchestration(deps)
    assertEqual(supabaseAdmin.calls.rpc[0].args.p_mode, 'reuse_or_create')
  })
  test('canceled → claim p_mode=fresh_only (never reuse old completed session)', async () => {
    const { deps, supabaseAdmin } = makeDeps({ supa: { subLookup: { data: { status: 'canceled' }, error: null } } })
    await runCheckoutOrchestration(deps)
    assertEqual(supabaseAdmin.calls.rpc[0].args.p_mode, 'fresh_only')
  })
  test('incomplete_expired → claim p_mode=fresh_only', async () => {
    const { deps, supabaseAdmin } = makeDeps({ supa: { subLookup: { data: { status: 'incomplete_expired' }, error: null } } })
    await runCheckoutOrchestration(deps)
    assertEqual(supabaseAdmin.calls.rpc[0].args.p_mode, 'fresh_only')
  })
  test('incomplete → claim p_mode=reuse_only', async () => {
    const { deps, supabaseAdmin } = makeDeps({
      supa: { subLookup: { data: { status: 'incomplete' }, error: null }, claim: { data: { result: 'blocked_no_reuse' }, error: null } },
    })
    await runCheckoutOrchestration(deps)
    assertEqual(supabaseAdmin.calls.rpc[0].args.p_mode, 'reuse_only')
  })

  // ── claim results ────────────────────────────────────────────────────────────
  test('reuse → 200 with stored URL, no Stripe', async () => {
    const { deps, createStripeSession } = makeDeps({
      supa: { claim: { data: { result: 'reuse', checkout_url: READY_URL, operation_id: OP }, error: null } },
    })
    const r = await runCheckoutOrchestration(deps)
    assertEqual(r.status, 200); assertEqual(r.body.url, READY_URL)
    assertEqual(createStripeSession.calls.length, 0)
  })
  test('reuse with invalid stored URL → 502', async () => {
    const { deps } = makeDeps({ supa: { claim: { data: { result: 'reuse', checkout_url: 'https://evil.com/x', operation_id: OP }, error: null } } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 502)
  })
  test('incomplete blocked_no_reuse → 409, no Stripe', async () => {
    const { deps, createStripeSession } = makeDeps({
      supa: { subLookup: { data: { status: 'incomplete' }, error: null }, claim: { data: { result: 'blocked_no_reuse' }, error: null } },
    })
    assertEqual((await runCheckoutOrchestration(deps)).status, 409)
    assertEqual(createStripeSession.calls.length, 0)
  })
  test('in_progress → 409, no Stripe', async () => {
    const { deps, createStripeSession } = makeDeps({ supa: { claim: { data: { result: 'in_progress' }, error: null } } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 409)
    assertEqual(createStripeSession.calls.length, 0)
  })
  test('claim RPC error → 503, no Stripe', async () => {
    const { deps, createStripeSession } = makeDeps({ supa: { claim: { data: null, error: { code: 'XX' } } } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 503)
    assertEqual(createStripeSession.calls.length, 0)
  })
  test('claimed without operation_id/token → 503 fail closed', async () => {
    const { deps } = makeDeps({ supa: { claim: { data: { result: 'claimed' }, error: null } } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 503)
  })

  // ── success path ───────────────────────────────────────────────────────────
  test('success (id+url+future expires) → 200, one Stripe call, finalize ready', async () => {
    const { deps, supabaseAdmin, createStripeSession } = makeDeps()
    const r = await runCheckoutOrchestration(deps)
    assertEqual(r.status, 200); assertEqual(r.body.url, NEW_URL)
    assertEqual(createStripeSession.calls.length, 1)
    assertEqual(supabaseAdmin.calls.finalize.length, 1)
    assertEqual(supabaseAdmin.calls.finalize[0].p_state, 'ready')
    assertEqual(supabaseAdmin.calls.finalize[0].p_claim_token, TOK)
    assertEqual(supabaseAdmin.calls.finalize[0].p_session_id, 'cs_new')
    assertEqual(supabaseAdmin.calls.finalize[0].p_expires_at, new Date(FUTURE * 1000).toISOString())
  })
  test('idempotency key = opaque operation id, no PII', async () => {
    const { deps, createStripeSession } = makeDeps()
    await runCheckoutOrchestration(deps)
    const key = createStripeSession.calls[0].idempotencyKey
    assertEqual(key, `checkout-op-${OP}`)
    assert(!key.includes(USER)); assert(!key.includes(EMAIL))
  })
  test('stale reclaim reuses same operation id → same idempotency key', async () => {
    const { deps, createStripeSession } = makeDeps({ supa: { claim: { data: { result: 'claimed', operation_id: OP, claim_token: 'rot' }, error: null } } })
    await runCheckoutOrchestration(deps)
    assertEqual(createStripeSession.calls[0].idempotencyKey, `checkout-op-${OP}`)
  })

  // ── R3: ambiguous success (missing/invalid fields) → unknown, NOT finalized ──
  const AMBIG = [
    ['missing id',            { id: undefined, url: NEW_URL, expires_at: FUTURE }],
    ['missing url',           { id: 'cs', url: undefined, expires_at: FUTURE }],
    ['invalid url',           { id: 'cs', url: 'https://evil.com/x', expires_at: FUTURE }],
    ['missing expires_at',    { id: 'cs', url: NEW_URL, expires_at: undefined }],
    ['non-numeric expires_at',{ id: 'cs', url: NEW_URL, expires_at: 'soon' }],
    ['expired expires_at',    { id: 'cs', url: NEW_URL, expires_at: PAST }],
  ]
  for (const [label, session] of AMBIG) {
    test(`success but ${label} → 503, NOT finalized (retain operation)`, async () => {
      const { deps, supabaseAdmin } = makeDeps({ stripeCfg: { result: { outcome: 'success', status: 200, session } } })
      const r = await runCheckoutOrchestration(deps)
      assertEqual(r.status, 503)
      assertEqual(supabaseAdmin.calls.finalize.length, 0, 'must not finalize an ambiguous success')
    })
  }

  // ── C1: the OLD production wiring (ISO-string clock) must FAIL, never finalize ─
  // Regression: index.ts used to pass now: () => new Date().toISOString(). The
  // orchestration computes Math.floor(nowMs()/1000) → NaN for a string, and
  // validateStripeSession must fail closed on a non-finite clock.
  test('C1: ISO-string clock (old broken wiring) → 503, NOT finalized', async () => {
    const { deps, supabaseAdmin } = makeDeps({ nowMs: () => new Date(NOW_MS).toISOString() })
    const r = await runCheckoutOrchestration(deps)
    assertEqual(r.status, 503)
    assertEqual(supabaseAdmin.calls.finalize.length, 0, 'a broken clock must never finalize a session')
  })
  test('C1: numeric millisecond clock (Date.now()) → 200 success', async () => {
    const { deps } = makeDeps({ nowMs: () => NOW_MS })
    assertEqual((await runCheckoutOrchestration(deps)).status, 200)
  })

  // ── R3: unknown vs definitive provider failures ──────────────────────────────
  test('network throw → 503, NOT finalized (retain operation)', async () => {
    const { deps, supabaseAdmin } = makeDeps({ stripeCfg: { throw: true } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 503)
    assertEqual(supabaseAdmin.calls.finalize.length, 0)
  })
  test('unknown_failure (HTTP-success invalid JSON / 5xx) → 503, NOT finalized', async () => {
    const { deps, supabaseAdmin } = makeDeps({ stripeCfg: { result: { outcome: 'unknown_failure', status: 500, session: null } } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 503)
    assertEqual(supabaseAdmin.calls.finalize.length, 0, 'unknown outcome must retain the operation for idempotent retry')
  })
  test('definitive_failure → 502 after durable failed finalize', async () => {
    const { deps, supabaseAdmin } = makeDeps({ stripeCfg: { result: { outcome: 'definitive_failure', status: 400, session: null } } })
    const r = await runCheckoutOrchestration(deps)
    assertEqual(r.status, 502)
    assertEqual(supabaseAdmin.calls.finalize[0].p_state, 'failed')
  })

  // ── R3: finalize error / data=false handling ─────────────────────────────────
  test('ready finalize RPC error → 503', async () => {
    const { deps } = makeDeps({ supa: { finalize: { data: null, error: { code: 'XX' } } } })
    assertEqual((await runCheckoutOrchestration(deps)).status, 503)
  })
  test('ready finalize data=false (ownership lost) → 503, not 200', async () => {
    const { deps } = makeDeps({ supa: { finalize: { data: false, error: null } } })
    const r = await runCheckoutOrchestration(deps)
    assert(r.status !== 200, 'must not claim success when finalize returned false')
    assertEqual(r.status, 503)
  })
  test('failed finalize RPC error (after definitive failure) → 503, not 502', async () => {
    const { deps } = makeDeps({
      stripeCfg: { result: { outcome: 'definitive_failure', status: 400, session: null } },
      supa: { finalizeFailed: { data: null, error: { code: 'XX' } } },
    })
    assertEqual((await runCheckoutOrchestration(deps)).status, 503)
  })
  test('failed finalize data=false (after definitive failure) → 503, not 502', async () => {
    const { deps } = makeDeps({
      stripeCfg: { result: { outcome: 'definitive_failure', status: 400, session: null } },
      supa: { finalizeFailed: { data: false, error: null } },
    })
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
