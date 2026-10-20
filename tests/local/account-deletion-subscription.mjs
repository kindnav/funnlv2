#!/usr/bin/env node
// SUBSCRIPTION-SAFE ACCOUNT DELETION, AGAINST A REAL DATABASE AND A FAKE STRIPE.
//
// Real Postgres (every migration), GoTrue and PostgREST; the REAL cancellation module and the REAL
// Stripe transport (makeStripeRequest) pointed at a local fake Stripe HTTP server; the deletion steps in
// delete-account's order; and the REAL webhook orchestration for events that arrive after an account is
// gone. Synthetic users and ids only; nothing reaches Stripe or Production. Reports carry check names,
// counts and match/mismatch only.
//
// RUN (from the repository root): node tests/local/account-deletion-subscription.mjs
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer as createHttp } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { createHmac, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { cancelAccountSubscriptions, makeStripeRequest } from '../../supabase/functions/delete-account/subscriptionCancellation.js'
import { runWebhookOrchestration } from '../../supabase/functions/stripe-webhook/webhookHandler.js'
import { runCheckoutOrchestration } from '../../supabase/functions/create-checkout-session/checkoutOrchestrator.js'

const NL = String.fromCharCode(10)
const ROOT = join(import.meta.dirname, '..', '..')
const NET = 'funnl-deldel-net', PG = 'funnl-deldel-pg', AUTH = 'funnl-deldel-auth', REST = 'funnl-deldel-rest'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const AUTH_IMAGE = 'public.ecr.aws/supabase/gotrue:v2.192.0'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const P = { rest: 54181, auth: 54182, gw: 54185, stripe: 54186 }
const GW = `http://127.0.0.1:${P.gw}`
const JWT_SECRET = randomBytes(32).toString('hex')
const DB_PASSWORD = randomBytes(12).toString('hex')
const STRIPE_KEY = 'sk_test_harness_not_a_real_key'
const PRICE = 'price_harness_pro'

let passed = 0, failed = 0
function check (name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); passed++ } else { console.error(`  ✗ ${name}`); if (detail) console.error(`    ${detail}`); failed++ }
}
const docker = (a) => execFileSync('docker', a, { encoding: 'utf8', stdio: 'pipe' })
const quiet = (a) => spawnSync('docker', a, { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const psql = (sql, { user = 'postgres' } = {}) => execFileSync('docker', ['exec', '-i', PG, 'psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-f', '-'], { input: sql, encoding: 'utf8', stdio: 'pipe' })
const one = (sql) => psql(sql).trim()
function waitForPg () {
  const deadline = Date.now() + 180000; let streak = 0
  while (Date.now() < deadline) {
    const r = spawnSync('docker', ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], { input: 'CREATE TABLE public._p(i int); DROP TABLE public._p;', encoding: 'utf8' })
    if (r.status === 0) { if (++streak >= 3) return } else streak = 0
    spawnSync('node', ['-e', 'setTimeout(()=>{},1000)'], { stdio: 'ignore' })
  }
  throw new Error('Postgres never became stably DDL-ready')
}
async function waitHttp (url, ok, label) {
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) { try { if (ok(await fetch(url))) return } catch { /* not up */ } await sleep(500) }
  throw new Error(`${label} never came up`)
}
function mintJwt (claims) {
  const seg = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const h = seg({ alg: 'HS256', typ: 'JWT' }), b = seg({ iat: now, exp: now + 3600, ...claims })
  return `${h}.${b}.${createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url')}`
}
const SERVICE_KEY = mintJwt({ role: 'service_role', iss: 'supabase' })

function startGateway () {
  const srv = createHttp(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    let up = null
    if (req.url.startsWith('/auth/v1/')) up = `http://127.0.0.1:${P.auth}` + req.url.slice('/auth/v1'.length)
    else if (req.url.startsWith('/rest/v1/')) up = `http://127.0.0.1:${P.rest}` + req.url.slice('/rest/v1'.length)
    if (!up) { res.writeHead(404); return res.end('{}') }
    const headers = { ...req.headers }; delete headers.host; delete headers['content-length']
    const r = await fetch(up, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) })
    res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !['content-encoding', 'transfer-encoding', 'content-length'].includes(k))))
    res.end(Buffer.from(await r.arrayBuffer()))
  })
  return new Promise((resolve) => srv.listen(P.gw, '127.0.0.1', () => resolve(srv)))
}

// ── Fake Stripe over HTTP ────────────────────────────────────────────────────────────────────────
// State is per object; `faults` makes the next matching request hang (beyond the client timeout) or fail.
const S = new Map(), C = new Map()
const faults = []                       // { method, path, kind: 'hang' | 500, times, when? }
const log = []                          // { method, path, idem, status }
const pending = new Set()
function startFakeStripe () {
  const srv = createHttp(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const url = new URL(req.url, 'http://x'), path = url.pathname, method = req.method
    if (req.headers.authorization !== `Bearer ${STRIPE_KEY}`) { res.writeHead(401); return res.end('{}') }
    const entry = { method, path, idem: req.headers['idempotency-key'] ?? null, status: null }
    log.push(entry)
    const f = faults.find((x) => x.method === method && x.path === path && x.times > 0 && (!x.when || x.when()))
    if (f) {
      f.times--
      if (f.kind === 'hang') { pending.add(res); entry.status = 'hang'; return }
      entry.status = f.kind; res.writeHead(f.kind, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"synthetic provider failure"}}')
    }
    const send = (status, body) => { entry.status = status; res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const parts = path.split('/')
    if (path.startsWith('/v1/checkout/sessions/')) {
      const s = C.get(parts[4]); if (!s) return send(404, { error: { type: 'invalid_request_error' } })
      if (method === 'GET') return send(200, s)
      if (method === 'POST' && parts[5] === 'expire') { if (s.status !== 'open') return send(400, { error: {} }); s.status = 'expired'; return send(200, s) }
    }
    if (path === '/v1/subscriptions' && method === 'GET') {
      return send(200, { data: [...S.values()].filter((s) => s.customer === url.searchParams.get('customer')), has_more: false })
    }
    if (path.startsWith('/v1/subscriptions/')) {
      const s = S.get(parts[3]); if (!s) return send(404, { error: { type: 'invalid_request_error' } })
      if (method === 'GET') return send(200, s)
      if (method === 'DELETE') {
        if (url.searchParams.get('prorate') !== 'false' || url.searchParams.get('invoice_now') !== 'false') return send(400, { error: {} })
        if (s.status === 'canceled') return send(400, { error: {} })
        s.status = 'canceled'; return send(200, s)
      }
    }
    send(404, { error: {} })
  })
  return new Promise((resolve) => srv.listen(P.stripe, '127.0.0.1', () => resolve(srv)))
}
const stripeRequest = makeStripeRequest({ stripeKey: STRIPE_KEY, timeoutMs: 800, baseUrl: `http://127.0.0.1:${P.stripe}` })
const cancels = (sub) => log.filter((e) => e.method === 'DELETE' && e.path === `/v1/subscriptions/${sub}`)
const creates = () => log.filter((e) => e.method === 'POST' && !e.path.endsWith('/expire'))

// delete-account after authentication, in its order: fence + billing, contacts, auth user.
async function deleteAccount (admin, uid) {
  const billing = await cancelAccountSubscriptions({ userId: uid, admin, stripeKey: STRIPE_KEY, stripeRequest })
  if (!billing.ok) return { status: billing.retryable ? 503 : 409, code: billing.retryable ? 'subscription_cancel_unconfirmed' : 'subscription_needs_support', reason: billing.reason }
  const { error: cErr } = await admin.from('contacts').delete().eq('user_id', uid)
  if (cErr) return { status: 500, code: 'delete_failed' }
  const { error: dErr } = await admin.auth.admin.deleteUser(uid)
  if (dErr) return { status: 500, code: 'delete_failed' }
  return { status: 200, billing }
}

// Membership + content digest of everything one user owns (rows only).
const setDigest = (rowsSql) => `(SELECT md5(coalesce(string_agg(h, ',' ORDER BY h), '')) || ':' || count(*) FROM (SELECT md5(r::text) AS h FROM (${rowsSql}) r) d)`
function owned (uid) {
  return one(`SELECT ${['contacts', 'interactions', 'subscriptions', 'checkout_operations', 'pro_trials'].map((t) => setDigest(`SELECT * FROM public.${t} WHERE user_id = '${uid}'`)).join(" || '|' || ")} || '|' || ${setDigest(`SELECT * FROM public.profiles WHERE id = '${uid}'`)} || '|' || ${setDigest(`SELECT id, email FROM auth.users WHERE id = '${uid}'`)}`)
}
const gone = (uid) => owned(uid).split('|').every((d) => d.endsWith(':0'))

let gw = null, stripeSrv = null
async function teardown () {
  for (const r of pending) { try { r.destroy() } catch { /* ignore */ } }
  try { gw?.close() } catch { /* ignore */ }
  try { stripeSrv?.close() } catch { /* ignore */ }
  for (const c of [REST, AUTH, PG]) quiet(['rm', '-f', c])
  quiet(['network', 'rm', NET])
}
async function main () {
  await teardown()
  console.log(NL + 'standing up Postgres + GoTrue + PostgREST + fake Stripe')
  quiet(['network', 'create', NET])
  docker(['run', '-d', '--name', PG, '--network', NET, '-e', `POSTGRES_PASSWORD=${DB_PASSWORD}`, PG_IMAGE])
  waitForPg()
  psql(`ALTER ROLE supabase_auth_admin WITH PASSWORD '${DB_PASSWORD}'; ALTER ROLE authenticator WITH PASSWORD '${DB_PASSWORD}';`, { user: 'supabase_admin' })
  docker(['run', '-d', '--name', AUTH, '--network', NET, '-p', `${P.auth}:9999`, '-e', 'GOTRUE_API_HOST=0.0.0.0', '-e', 'GOTRUE_API_PORT=9999',
    '-e', `API_EXTERNAL_URL=${GW}/auth/v1`, '-e', 'GOTRUE_DB_DRIVER=postgres', '-e', `GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${DB_PASSWORD}@${PG}:5432/postgres`,
    '-e', `GOTRUE_SITE_URL=${GW}`, '-e', `GOTRUE_JWT_SECRET=${JWT_SECRET}`, '-e', 'GOTRUE_JWT_EXP=3600', '-e', 'GOTRUE_JWT_AUD=authenticated',
    '-e', 'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated', '-e', 'GOTRUE_JWT_ADMIN_ROLES=service_role', '-e', 'GOTRUE_EXTERNAL_EMAIL_ENABLED=true',
    '-e', 'GOTRUE_MAILER_AUTOCONFIRM=true', '-e', 'GOTRUE_DISABLE_SIGNUP=false', AUTH_IMAGE])
  await waitHttp(`http://127.0.0.1:${P.auth}/health`, (r) => r.ok, 'GoTrue')
  const migrations = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
  for (const m of migrations) psql(readFileSync(join(ROOT, 'supabase/migrations', m), 'utf8'))
  console.log(`  applied ${migrations.length} migrations`)
  docker(['run', '-d', '--name', REST, '--network', NET, '-p', `${P.rest}:3000`, '-e', `PGRST_DB_URI=postgres://authenticator:${DB_PASSWORD}@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, REST_IMAGE])
  await waitHttp(`http://127.0.0.1:${P.rest}/`, (r) => r.status < 500, 'PostgREST')
  gw = await startGateway()
  stripeSrv = await startFakeStripe()
  const admin = createClient(GW, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

  // Synthetic users: each gets contacts + an interaction; billing as named.
  const ids = {}
  for (const tag of ['nobill', 'active', 'dbfail', 'ended', 'mismatch', 'open', 'bystander', 'race', 'oldcheckout', 'inflight', 'stalecreate', 'history']) {
    const { data, error } = await admin.auth.admin.createUser({ email: `del-${tag}@example.test`, password: randomBytes(12).toString('hex'), email_confirm: true })
    if (error) throw new Error(`createUser ${tag}: ${error.message}`)
    ids[tag] = data.user.id
    psql(`INSERT INTO public.contacts (user_id, name, company) VALUES ('${ids[tag]}', 'Ada ${tag}', 'Analytical Engines');
          INSERT INTO public.interactions (user_id, contact_id, type, interaction_date, notes)
            SELECT '${ids[tag]}', id, 'Email', current_date, 'synthetic note' FROM public.contacts WHERE user_id = '${ids[tag]}';`)
  }
  const subRow = (tag, status = 'active') => psql(`INSERT INTO public.subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, price_id)
    VALUES ('${ids[tag]}', 'cus_${tag}', 'sub_${tag}', '${status}', now() + interval '20 days', '${PRICE}');`)
  const stripeSub = (tag, status, meta = ids[tag]) => S.set(`sub_${tag}`, { id: `sub_${tag}`, object: 'subscription', customer: `cus_${tag}`, status, livemode: false, metadata: { user_id: meta },
    items: { data: [{ price: { id: PRICE }, current_period_end: Math.floor(Date.now() / 1000) + 20 * 86400 }] } })
  for (const t of ['active', 'dbfail', 'bystander']) { subRow(t); stripeSub(t, 'active') }
  subRow('ended', 'canceled'); stripeSub('ended', 'canceled')
  subRow('mismatch'); stripeSub('mismatch', 'active', ids.bystander)            // Stripe says another Funnl user owns it
  psql(`INSERT INTO public.checkout_operations (user_id, price_id, stripe_session_id, state, expires_at) VALUES ('${ids.open}', '${PRICE}', 'cs_open', 'ready', now() + interval '1 day');`)
  C.set('cs_open', { id: 'cs_open', object: 'checkout.session', status: 'open', livemode: false, client_reference_id: ids.open, metadata: { user_id: ids.open }, customer: null, subscription: null })
  const BY0 = owned(ids.bystander)

  console.log(NL + '1. No subscription')
  const r1 = await deleteAccount(admin, ids.nobill)
  check('an account without billing deletes normally', r1.status === 200 && r1.billing.billing === false, JSON.stringify(r1))
  check('...with no Stripe request at all', log.length === 0, String(log.length))
  check('...and nothing of it remains', gone(ids.nobill))

  console.log(NL + '2. Cancellation not confirmed: the account is kept, then a retry completes it')
  const A0 = owned(ids.active)
  // The cancel hangs past the client timeout; the re-read after it then fails, so nothing is confirmed.
  const hungCancel = () => log.some((e) => e.method === 'DELETE' && e.path === '/v1/subscriptions/sub_active')
  faults.push({ method: 'DELETE', path: '/v1/subscriptions/sub_active', kind: 'hang', times: 1 },
    { method: 'GET', path: '/v1/subscriptions/sub_active', kind: 500, times: 1, when: hungCancel })
  const r2 = await deleteAccount(admin, ids.active)
  check('a cancel that times out and cannot be re-confirmed is refused as retryable (503)', r2.status === 503 && r2.code === 'subscription_cancel_unconfirmed' && r2.reason === 'cancel_unconfirmed', JSON.stringify(r2))
  check('...and every row of the account is unchanged', owned(ids.active) === A0)
  check('...and the Stripe subscription is still active', S.get('sub_active').status === 'active')
  const r3 = await deleteAccount(admin, ids.active)
  check('the retry cancels it and deletes the account', r3.status === 200 && r3.billing.canceled === 1, JSON.stringify(r3))
  check('...the subscription is canceled in Stripe', S.get('sub_active').status === 'canceled')
  check('...both cancel attempts used the same idempotency key', new Set(cancels('sub_active').map((e) => e.idem)).size === 1 && cancels('sub_active').length === 2)
  check('...and nothing of the account remains', gone(ids.active))

  console.log(NL + '3. Stripe cancels, then the database deletion fails; the retry finishes safely')
  psql(`CREATE FUNCTION public._harness_block() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $f$;
        CREATE TRIGGER _harness_block BEFORE DELETE ON public.contacts FOR EACH ROW WHEN (OLD.user_id = '${ids.dbfail}') EXECUTE FUNCTION public._harness_block();`)
  const D0 = owned(ids.dbfail)
  const r4 = await deleteAccount(admin, ids.dbfail)
  check('the deletion fails with a controlled code after the cancel', r4.status === 500 && r4.code === 'delete_failed', JSON.stringify(r4))
  check('...the subscription was canceled in Stripe', S.get('sub_dbfail').status === 'canceled')
  check('...and the account and all its rows are still there', owned(ids.dbfail) === D0)
  psql('DROP TRIGGER _harness_block ON public.contacts; DROP FUNCTION public._harness_block();')
  const r5 = await deleteAccount(admin, ids.dbfail)
  check('the retry completes the deletion', r5.status === 200 && r5.billing.canceled === 0 && r5.billing.alreadyEnded === 1, JSON.stringify(r5))
  check('...without a second cancel', cancels('sub_dbfail').length === 1)
  check('...and nothing of the account remains', gone(ids.dbfail))

  console.log(NL + '4. Already canceled, ownership mismatch, open Checkout')
  const r6 = await deleteAccount(admin, ids.ended)
  check('an already-canceled subscription deletes without a cancel call', r6.status === 200 && r6.billing.alreadyEnded === 1 && cancels('sub_ended').length === 0, JSON.stringify(r6))
  const M0 = owned(ids.mismatch)
  const r7 = await deleteAccount(admin, ids.mismatch)
  check('a subscription Stripe attributes to another user is refused (409, needs support)', r7.status === 409 && r7.code === 'subscription_needs_support' && r7.reason === 'ownership_mismatch', JSON.stringify(r7))
  check('...it is not canceled, and the account is unchanged', S.get('sub_mismatch').status === 'active' && cancels('sub_mismatch').length === 0 && owned(ids.mismatch) === M0)
  const r8 = await deleteAccount(admin, ids.open)
  check('an open Checkout session is expired and the account deleted', r8.status === 200 && r8.billing.sessionsExpired === 1 && C.get('cs_open').status === 'expired' && gone(ids.open), JSON.stringify(r8))
  check('no request ever created anything at Stripe', creates().length === 0)

  console.log(NL + '5. Webhooks that arrive after the account is gone')
  const fetchSubscription = async (id) => S.get(id) ?? null
  const env = { priceId: PRICE, stripeKey: STRIPE_KEY }
  const ev = (type, object) => ({ id: 'evt_' + randomBytes(8).toString('hex'), type, created: Math.floor(Date.now() / 1000), data: { object } })
  const late = [
    ev('customer.subscription.updated', { ...S.get('sub_active') }),
    ev('customer.subscription.deleted', { ...S.get('sub_active') }),
    ev('checkout.session.completed', { id: 'cs_late', customer: 'cus_active', subscription: 'sub_active', client_reference_id: ids.active, metadata: { user_id: ids.active } }),
  ]
  const outcomes = []
  for (const e of late) outcomes.push((await runWebhookOrchestration({ event: e, requestId: 'h', supabaseAdmin: admin, fetchSubscription, env })).status)
  check('late events are answered without recreating anything for the deleted account', gone(ids.active), outcomes.join(','))
  check('...no subscription row anywhere names the deleted subscription', one("SELECT count(*) FROM public.subscriptions WHERE stripe_subscription_id IN ('sub_active','sub_dbfail','sub_open')") === '0')
  check('...a late "deleted" event is acknowledged (200)', outcomes[1] === 200, outcomes.join(','))
  console.log(`  (late updated / checkout-completed answered ${outcomes[0]} / ${outcomes[2]}: the write is refused because the account no longer exists; Stripe retries then stops)`)
  check('...and no stuck "processing" webhook rows', one("SELECT count(*) FROM public.stripe_webhook_events WHERE status = 'processing'") === '0')

  console.log(NL + '6. Finding 1: Checkout creation and deletion are serialized by the durable fence')
  const claim = (uid, mode = 'reuse_or_create') => admin.rpc('claim_checkout_operation', { p_user_id: uid, p_price_id: PRICE, p_mode: mode })
  const begin = (uid) => admin.rpc('begin_account_deletion', { p_user_id: uid })
  const resetRace = () => psql(`DELETE FROM public.account_deletion_fences WHERE user_id = '${ids.race}'; DELETE FROM public.checkout_operations WHERE user_id = '${ids.race}';`)
  let claimFirst = 0, fenceFirst = 0, violations = 0
  for (let i = 0; i < 40; i++) {
    resetRace()
    const jitter = () => sleep(Math.floor(Math.random() * 6))
    const [c, b] = await Promise.all([jitter().then(() => claim(ids.race)), jitter().then(() => begin(ids.race))])
    const cr = c.data?.result, bs = b.data?.checkout_state
    if (cr === 'claimed' && bs === 'creating') claimFirst++
    else if (cr === 'account_deleting' && bs === 'none') fenceFirst++
    else violations++
  }
  check('40 concurrent create/delete races: every outcome is one of the two serial orders', violations === 0, `claim-first ${claimFirst}, fence-first ${fenceFirst}, other ${violations}`)
  check('...never "deletion saw no billing" while a checkout was claimed', violations === 0)
  console.log(`  (orders observed: claim first ${claimFirst}, fence first ${fenceFirst})`)
  resetRace(); await begin(ids.race)
  const modes = await Promise.all(['reuse_or_create', 'reuse_only', 'fresh_only'].map((m) => claim(ids.race, m)))
  check('once fenced, every checkout mode is refused (no claim, no reuse of a stored URL)', modes.every((m) => m.data?.result === 'account_deleting'), modes.map((m) => m.data?.result).join(','))

  let stripeCreates = 0
  await begin(ids.oldcheckout)
  const oc = await runCheckoutOrchestration({
    user: { id: ids.oldcheckout, email: 'del-oldcheckout@example.test' }, supabaseAdmin: admin,
    createStripeSession: async () => { stripeCreates++; return { outcome: 'success', session: {} } },
    env: { priceId: PRICE, stripeKey: STRIPE_KEY, successUrl: 'https://www.getfunnl.com/settings?checkout=success', cancelUrl: 'https://www.getfunnl.com/settings?checkout=cancelled' },
  })
  check('the CURRENTLY DEPLOYED checkout code is blocked by the fence: 503, no Stripe call', oc.status === 503 && stripeCreates === 0, `${oc.status} / ${stripeCreates}`)

  const ic = await claim(ids.inflight)
  check('an in-flight creation is claimed before deletion starts', ic.data?.result === 'claimed')
  const I0 = owned(ids.inflight)
  const r9 = await deleteAccount(admin, ids.inflight)
  check('deletion during an unfinished creation is refused (503) and keeps the account', r9.status === 503 && r9.reason === 'checkout_creation_unresolved' && owned(ids.inflight) !== '' && gone(ids.inflight) === false, JSON.stringify(r9))
  check('...its rows are unchanged apart from the fence', owned(ids.inflight) === I0)
  C.set('cs_inflight', { id: 'cs_inflight', object: 'checkout.session', status: 'open', livemode: false, client_reference_id: ids.inflight, metadata: { user_id: ids.inflight }, customer: null, subscription: null })
  const fin = await admin.rpc('finalize_checkout_operation', { p_user_id: ids.inflight, p_claim_token: ic.data.claim_token, p_state: 'ready', p_session_id: 'cs_inflight', p_checkout_url: 'https://checkout.stripe.com/c/pay/cs_inflight', p_expires_at: new Date(Date.now() + 86400000).toISOString() })
  check('the in-flight creator can still record its session under the fence', fin.data === true, JSON.stringify(fin.error))
  const r10 = await deleteAccount(admin, ids.inflight)
  check('the retry expires that session and deletes the account', r10.status === 200 && r10.billing.sessionsExpired === 1 && C.get('cs_inflight').status === 'expired' && gone(ids.inflight), JSON.stringify(r10))

  const sc = await claim(ids.stalecreate)
  psql(`UPDATE public.checkout_operations SET updated_at = now() - interval '25 hours' WHERE user_id = '${ids.stalecreate}';`)
  const before = log.length
  const r11 = await deleteAccount(admin, ids.stalecreate)
  check('a creation older than any session lifetime no longer blocks deletion', sc.data?.result === 'claimed' && r11.status === 200 && gone(ids.stalecreate), JSON.stringify(r11))
  check('...and needs no Stripe call', log.length === before)

  psql(`INSERT INTO public.subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, price_id) VALUES ('${ids.history}', 'cus_history', 'sub_history', 'canceled', now() - interval '1 day', '${PRICE}');
        INSERT INTO public.checkout_operations (user_id, price_id, stripe_session_id, state, checkout_url, expires_at) VALUES ('${ids.history}', '${PRICE}', 'cs_h1', 'ready', 'https://checkout.stripe.com/c/pay/cs_h1', now() + interval '20 hours');`)
  stripeSub('history', 'canceled')
  for (const id of ['cs_h1', 'cs_h2']) C.set(id, { id, object: 'checkout.session', status: 'open', livemode: false, client_reference_id: ids.history, metadata: { user_id: ids.history }, customer: 'cus_history', subscription: null })
  const hc = await claim(ids.history, 'fresh_only')
  await admin.rpc('finalize_checkout_operation', { p_user_id: ids.history, p_claim_token: hc.data.claim_token, p_state: 'ready', p_session_id: 'cs_h2', p_checkout_url: 'https://checkout.stripe.com/c/pay/cs_h2', p_expires_at: new Date(Date.now() + 86400000).toISOString() })
  check('starting a new operation keeps the overwritten, still-payable session in history', one(`SELECT count(*) FROM public.checkout_session_history WHERE user_id = '${ids.history}' AND stripe_session_id = 'cs_h1'`) === '1')
  const r12 = await deleteAccount(admin, ids.history)
  check('deletion expires BOTH the overwritten and the current session', r12.status === 200 && r12.billing.sessionsExpired === 2 && C.get('cs_h1').status === 'expired' && C.get('cs_h2').status === 'expired' && gone(ids.history), JSON.stringify(r12))

  const blocked = await claim(ids.mismatch)
  psql(`UPDATE public.account_deletion_fences SET started_at = now() - interval '16 minutes' WHERE user_id = '${ids.mismatch}';`)
  const after = await claim(ids.mismatch)
  check('after a refused deletion, Checkout stays fenced, then reopens once the fence expires', blocked.data?.result === 'account_deleting' && after.data?.result === 'claimed', `${blocked.data?.result} -> ${after.data?.result}`)
  check('no request ever created anything at Stripe (whole run)', creates().length === 0)

  console.log(NL + '7. Bystander')
  check("the bystander's account and subscription are unchanged throughout", owned(ids.bystander) === BY0 && S.get('sub_bystander').status === 'active' && cancels('sub_bystander').length === 0)
}

main()
  .catch((e) => { console.error(e?.stack || e); failed++ })
  .finally(async () => {
    await teardown()
    console.log(`${NL}${passed + failed} checks: ${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  })
