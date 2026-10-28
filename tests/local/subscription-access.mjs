#!/usr/bin/env node
// SUBSCRIPTION ACCESS FROM VERIFIED PAYMENT EVIDENCE, AGAINST A REAL DATABASE (migration 20261023000000).
//
// Real Postgres, GoTrue and PostgREST. Every migration before 20261023000000 is applied and synthetic
// rows are seeded. The NEW webhook is then run against that OLD database (the webhook-first rollout):
// its writes must fail retryably and change nothing. Only then is 20261023000000 applied, and the same
// events are redelivered. Then: the automatic trial (unchanged); the SQL rule and the JS rule on
// identical inputs; and the REAL webhook orchestration with a fake Stripe through first-failure grace,
// delayed and duplicate delivery, later unpaid cycles, genuine recovery, an initial purchase that
// fails, exact 7-day boundaries, and DETERMINISTIC races in which an older handler is paused after its
// Stripe read, newer evidence is applied, and the older handler is released. Finally the browser RPC
// and the AI evaluator are compared on every account, and permanent Pro is refused at Checkout.
// Synthetic data only; nothing reaches Stripe or Production.
//
// RUN (from the repository root): node tests/local/subscription-access.mjs
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer as createHttp } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { createHmac, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { subscriptionAccessUntil } from '../../supabase/functions/shared/subscriptionStatusPolicy.js'
import { loadProEntitlement, decideEntitlement } from '../../supabase/functions/shared/pro-entitlement.js'
import { runWebhookOrchestration } from '../../supabase/functions/stripe-webhook/webhookHandler.js'
import { runCheckoutOrchestration } from '../../supabase/functions/create-checkout-session/checkoutOrchestrator.js'

const NL = String.fromCharCode(10)
const ROOT = join(import.meta.dirname, '..', '..')
const NEW_MIGRATION = '20261023000000_subscription_access_periods.sql'
const NET = 'funnl-subacc-net', PG = 'funnl-subacc-pg', AUTH = 'funnl-subacc-auth', REST = 'funnl-subacc-rest'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const AUTH_IMAGE = 'public.ecr.aws/supabase/gotrue:v2.192.0'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const P = { rest: 54191, auth: 54192, gw: 54195 }
const GW = `http://127.0.0.1:${P.gw}`
const JWT_SECRET = randomBytes(32).toString('hex')
const DB_PASSWORD = randomBytes(12).toString('hex')
const PRICE = 'price_harness_new', OLD_PRICE = 'price_harness_old'
const DAY = 86400000, HOUR = 3600000

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
const ANON_KEY = mintJwt({ role: 'anon', iss: 'supabase' })
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
const setDigest = (rowsSql) => `(SELECT md5(coalesce(string_agg(h, ',' ORDER BY h), '')) || ':' || count(*) FROM (SELECT md5(r::text) AS h FROM (${rowsSql}) r) d)`
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString())
const sec = (ms) => Math.floor(ms / 1000)

let gw = null
async function teardown () {
  try { gw?.close() } catch { /* ignore */ }
  for (const c of [REST, AUTH, PG]) quiet(['rm', '-f', c])
  quiet(['network', 'rm', NET])
}
async function main () {
  await teardown()
  console.log(NL + 'standing up Postgres + GoTrue + PostgREST')
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
  const before = migrations.filter((f) => f < NEW_MIGRATION)
  for (const m of before) psql(readFileSync(join(ROOT, 'supabase/migrations', m), 'utf8'))
  console.log(`  applied ${before.length} migrations (everything before ${NEW_MIGRATION})`)
  docker(['run', '-d', '--name', REST, '--network', NET, '-p', `${P.rest}:3000`, '-e', `PGRST_DB_URI=postgres://authenticator:${DB_PASSWORD}@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, REST_IMAGE])
  await waitHttp(`http://127.0.0.1:${P.rest}/`, (r) => r.status < 500, 'PostgREST')
  gw = await startGateway()
  const admin = createClient(GW, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const asUser = (uid) => createClient(GW, mintJwt({ role: 'authenticated', sub: uid, aud: 'authenticated' }), { auth: { persistSession: false } })
  const status = async (uid) => { const { data, error } = await asUser(uid).rpc('get_my_pro_access_status'); if (error) throw new Error('rpc: ' + error.message); return data }
  const pro = async (uid) => (await status(uid)).can_use_pro
  const until = async (uid) => { const u = (await status(uid)).subscription_access_until; return u ? Date.parse(u) : null }

  // ── Accounts and synthetic rows that exist BEFORE the migration ──────────────────────────────────
  const ids = {}, passwords = {}
  const mk = async (tag, confirm = true) => {
    passwords[tag] = randomBytes(12).toString('hex')
    const { data, error } = await admin.auth.admin.createUser({ email: `acc-${tag}@example.test`, password: passwords[tag], email_confirm: confirm })
    if (error) throw new Error(`createUser ${tag}: ${error.message}`)
    ids[tag] = data.user.id
  }
  // Every new account gets the automatic trial; expire it for accounts that test SUBSCRIPTION access.
  const expireTrial = (uid) => psql(`UPDATE public.pro_trials SET started_at = now() - interval '20 days', ends_at = now() - interval '13 days' WHERE user_id = '${uid}';`)
  for (const t of ['legacytrial', 'legacystale', 'legacyactive', 'legacypastdue', 'legacyconv', 'permanent', 'bystander', 'lswapu', 'lswapc', 'lunknown']) await mk(t)
  for (const t of ['legacystale', 'legacyactive', 'legacypastdue', 'legacyconv', 'bystander', 'lswapu', 'lswapc', 'lunknown']) expireTrial(ids[t])
  psql(`UPDATE public.pro_trials SET started_at = now() - interval '3 days', ends_at = now() + interval '4 days' WHERE user_id = '${ids.legacytrial}';
        UPDATE public.profiles SET ai_enabled = true WHERE id = '${ids.permanent}';
        INSERT INTO public.subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end, price_id) VALUES
          ('${ids.legacystale}',   'cus_legacystale',   'sub_legacystale',   'active',   now() - interval '39 days', false, '${OLD_PRICE}'),
          ('${ids.legacyactive}',  'cus_legacyactive',  'sub_legacyactive',  'active',   now() + interval '25 days', false, '${PRICE}'),
          ('${ids.legacypastdue}', 'cus_legacypastdue', 'sub_legacypastdue', 'past_due', now() + interval '25 days', false, '${PRICE}'),
          ('${ids.legacyconv}',    'cus_legacyconv',    'sub_legacyconv',    'active',   now() + interval '5 days',  false, '${PRICE}'),
          ('${ids.bystander}',     'cus_bystander',     'sub_bystander',     'active',   now() + interval '20 days', false, '${PRICE}');
        -- The row was first written 400 days ago (for an earlier subscription). Subscription A (created 200 days
        -- ago) replaced that one, then B (created 30 days ago) replaced A - all before this migration, so the
        -- row is bound to B, stores no creation time, and its created_at is OLDER than A.
        INSERT INTO public.subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end, price_id, created_at) VALUES
          ('${ids.lswapu}',   'cus_lswapu',   'sub_lswapub',   'active', now() + interval '20 days', false, '${PRICE}', now() - interval '400 days'),
          ('${ids.lswapc}',   'cus_lswapc',   'sub_lswapcb',   'active', now() + interval '20 days', false, '${PRICE}', now() - interval '400 days'),
          ('${ids.lunknown}', 'cus_lunknown', 'sub_lunknownb', 'active', now() + interval '20 days', false, '${PRICE}', now() - interval '400 days');`)
  const baseCols = 'user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end, price_id, created_at, updated_at'
  const dataDigest = () => one(`SELECT ${setDigest('SELECT * FROM public.pro_trials')} || '|' || ${setDigest('SELECT * FROM public.profiles')} || '|' || ${setDigest(`SELECT ${baseCols} FROM public.subscriptions`)}`)
  const D0 = dataDigest()
  const before0 = {}
  for (const t of ['legacystale', 'legacypastdue', 'legacyactive']) before0[t] = await pro(ids[t])

  // ── Fake Stripe ──────────────────────────────────────────────────────────────────────────────────
  const stripe = { subs: new Map(), invoices: new Map() }
  const clone = (o) => (o === undefined ? null : JSON.parse(JSON.stringify(o)))
  const putSub = (o) => {
    const created = stripe.subs.get(o.id)?.created ?? sec(o.created ?? o.start)
    const s = { id: o.id, object: 'subscription', created, customer: o.customer, status: o.status ?? 'active', cancel_at_period_end: o.cancel ?? false, livemode: false,
      collection_method: o.collection ?? 'charge_automatically', cancel_at: o.cancelAt ?? null, pause_collection: null,
      metadata: { user_id: o.user }, latest_invoice: o.latest ?? null,
      items: { data: [{ price: { id: o.price ?? PRICE }, current_period_start: sec(o.start), current_period_end: sec(o.end) }] } }
    stripe.subs.set(o.id, s); return s
  }
  const putInv = (o) => {
    const i = { id: o.id, object: 'invoice', livemode: false, customer: o.customer, subscription: o.sub, created: sec(o.created),
      billing_reason: o.reason ?? 'subscription_cycle', status: o.status, attempt_count: o.attempts ?? 1,
      lines: { data: [{ price: { id: o.price ?? PRICE }, period: { start: sec(o.start), end: sec(o.end) } }] } }
    stripe.invoices.set(o.id, i); return i
  }
  const liveFetchSub = async (id) => clone(stripe.subs.get(id))
  const liveFetchInv = async (id) => clone(stripe.invoices.get(id))
  let evN = 0
  const send = (type, object, o = {}) => runWebhookOrchestration({
    event: { id: o.id ?? `evt_access${String(++evN).padStart(5, '0')}`, type, created: sec(o.created ?? Date.now()), data: { object } },
    requestId: 'h', supabaseAdmin: admin, fetchSubscription: o.fetchSubscription ?? liveFetchSub, fetchInvoice: o.fetchInvoice ?? liveFetchInv,
    env: { priceId: PRICE, stripeKey: 'sk_test_x' },
  })
  const subUpdated = (id, customer, o) => send('customer.subscription.updated', { id, customer }, o)
  const invEvent = (type, invoiceId, o) => send(type, { id: invoiceId }, o)
  const checkout = (uid, subId, customer, o) => send('checkout.session.completed', { id: `cs_${subId}`, customer, subscription: subId, client_reference_id: uid, metadata: { user_id: uid } }, o)
  const eventStatus = (id) => one(`SELECT status || ':' || coalesce(failure_code, '') FROM public.stripe_webhook_events WHERE event_id = '${id}'`)

  // ── 0. Webhook first: the NEW webhook against the OLD database ───────────────────────────────────
  console.log(NL + '0. Rollout compatibility: the new webhook against the database BEFORE the migration')
  const now0 = Date.now()
  putInv({ id: 'in_la1', customer: 'cus_legacyactive', sub: 'sub_legacyactive', created: now0 - 5 * DAY, status: 'paid', start: now0 - 5 * DAY, end: now0 + 26 * DAY })
  putSub({ id: 'sub_legacyactive', customer: 'cus_legacyactive', user: ids.legacyactive, start: now0 - 5 * DAY, end: now0 + 26 * DAY, latest: 'in_la1' })
  const e1 = await subUpdated('sub_legacyactive', 'cus_legacyactive', { id: 'evt_compatsub01' })
  const e2 = await invEvent('invoice.paid', 'in_la1', { id: 'evt_compatinv01' })
  check('subscription and invoice events FAIL retryably (5xx, recorded failed) instead of being consumed, and change no row',
    e1.status >= 500 && e2.status >= 500 && eventStatus('evt_compatsub01').startsWith('failed') && eventStatus('evt_compatinv01').startsWith('failed') && dataDigest() === D0,
    `${e1.status} ${e2.status} ${eventStatus('evt_compatsub01')} ${eventStatus('evt_compatinv01')}`)

  // ── 1. The migration ─────────────────────────────────────────────────────────────────────────────
  console.log(NL + '1. Applying the migration changes no existing trial, profile or subscription data')
  psql(readFileSync(join(ROOT, 'supabase/migrations', NEW_MIGRATION), 'utf8'))
  check('existing trials, profiles and subscription rows are byte-identical; existing rows are legacy (evidence_version 0) with no evidence',
    dataDigest() === D0 && one(`SELECT count(*) FROM public.subscriptions WHERE evidence_version <> 0 OR paid_through IS NOT NULL OR failed_invoice_id IS NOT NULL OR grace_started_at IS NOT NULL OR current_period_start IS NOT NULL`) === '0')
  check('a running trial keeps its original expiry (not restarted, extended or backfilled)', one(`SELECT (ends_at - now()) BETWEEN interval '3 days 23 hours' AND interval '4 days' FROM public.pro_trials WHERE user_id = '${ids.legacytrial}'`) === 't')
  check('a stale paid row (period ended 39 days ago, never synced) granted Pro before - and no longer does', before0.legacystale === true && !(await pro(ids.legacystale)))
  check('a legacy active row keeps Pro exactly through the period Stripe last reported', await pro(ids.legacyactive) && Math.abs(await until(ids.legacyactive) - Date.parse(one(`SELECT current_period_end FROM public.subscriptions WHERE user_id = '${ids.legacyactive}'`))) < 1000)
  check('a legacy past_due row granted Pro before and is Free now: no failure time is invented for it (flagged transition effect)', before0.legacypastdue === true && !(await pro(ids.legacypastdue)))
  check('permanent Pro is unaffected', (await status(ids.permanent)).can_use_pro === true)
  const r1 = await subUpdated('sub_legacyactive', 'cus_legacyactive', { id: 'evt_compatsub01' })
  const r2 = await invEvent('invoice.paid', 'in_la1', { id: 'evt_compatinv01' })
  const la = JSON.parse(one(`SELECT row_to_json(s) FROM (SELECT evidence_version, paid_through, last_paid_invoice_id FROM public.subscriptions WHERE user_id = '${ids.legacyactive}') s`))
  check('Stripe redelivers the SAME events after the migration: processed, and the paid invoice is recorded as evidence',
    r1.status === 200 && r2.status === 200 && eventStatus('evt_compatsub01') === 'processed:' && la.evidence_version === 1 && la.last_paid_invoice_id === 'in_la1' &&
    Date.parse(la.paid_through) === sec(now0 + 26 * DAY) * 1000, JSON.stringify([r1.status, r2.status, la]))
  // A legacy row's first write after the migration, with a later period end but NO paid invoice.
  const convEnd = Date.parse(one(`SELECT current_period_end FROM public.subscriptions WHERE user_id = '${ids.legacyconv}'`))
  putInv({ id: 'in_lc1', customer: 'cus_legacyconv', sub: 'sub_legacyconv', created: now0, status: 'open', attempts: 0, start: now0, end: now0 + 35 * DAY })
  putSub({ id: 'sub_legacyconv', customer: 'cus_legacyconv', user: ids.legacyconv, start: now0, end: now0 + 35 * DAY, latest: 'in_lc1' })
  await subUpdated('sub_legacyconv', 'cus_legacyconv')
  check('a legacy row updated with a LATER period end but no paid invoice keeps only its pre-migration period (status is not payment)',
    one(`SELECT evidence_version FROM public.subscriptions WHERE user_id = '${ids.legacyconv}'`) === '1' && await until(ids.legacyconv) === convEnd)

  // ── 2. The automatic signup trial (unchanged) ────────────────────────────────────────────────────
  console.log(NL + '2. Automatic signup trial (unchanged: no card, no restart, no extension)')
  await mk('newbie')
  const t0 = one(`SELECT extract(epoch FROM (t.ends_at - u.created_at))::int || '|' || extract(epoch FROM (t.started_at - u.created_at))::int FROM public.pro_trials t JOIN auth.users u ON u.id = t.user_id WHERE t.user_id = '${ids.newbie}'`)
  const s0 = await status(ids.newbie)
  check('an auto-confirmed account gets 7 days of Pro from creation, with no subscription', t0.split('|')[0] === String(7 * 86400) && Math.abs(Number(t0.split('|')[1])) <= 2 &&
    s0.trial_active === true && s0.can_use_pro === true && s0.days_remaining === 7 && s0.subscription_status === 'none', t0)
  const endsBefore = one(`SELECT ends_at FROM public.pro_trials WHERE user_id = '${ids.newbie}'`)
  const signedIn = createClient(GW, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const si = await signedIn.auth.signInWithPassword({ email: 'acc-newbie@example.test', password: passwords.newbie })
  const restart = await signedIn.rpc('start_my_pro_trial')
  const si2 = await signedIn.auth.signInWithPassword({ email: 'acc-newbie@example.test', password: passwords.newbie })
  await signedIn.rpc('start_my_pro_trial')
  check('signing in again (twice, with the welcome-page trial call) neither restarts nor extends the trial', !si.error && !si2.error && restart.data?.started_now === false &&
    one(`SELECT ends_at FROM public.pro_trials WHERE user_id = '${ids.newbie}'`) === endsBefore)
  await mk('unconfirmed', false)
  const u0 = await status(ids.unconfirmed)
  await admin.auth.admin.updateUserById(ids.unconfirmed, { email_confirm: true })
  const u1 = one(`SELECT (t.started_at - u.created_at) >= interval '0' AND t.ends_at = t.started_at + interval '7 days' FROM public.pro_trials t JOIN auth.users u ON u.id = t.user_id WHERE t.user_id = '${ids.unconfirmed}'`)
  check('an account that must confirm its email: 7 days from CONFIRMATION (existing behaviour; product clarification outstanding)', u0.trial_eligible === true && u0.can_use_pro === false && u1 === 't')
  psql(`UPDATE public.pro_trials SET started_at = now() - interval '7 days' + interval '5 seconds', ends_at = now() + interval '5 seconds' WHERE user_id = '${ids.newbie}';`)
  const tb = await status(ids.newbie)
  psql(`UPDATE public.pro_trials SET started_at = now() - interval '7 days', ends_at = now() WHERE user_id = '${ids.newbie}';`)
  const ta = await status(ids.newbie)
  check('trial cutoff: Pro 5 s before expiry, Free at it', tb.can_use_pro === true && ta.can_use_pro === false && ta.trial_expired === true)

  // ── 3. SQL and JS rules agree ────────────────────────────────────────────────────────────────────
  console.log(NL + '3. The SQL rule and the JS rule agree at every cutoff (identical inputs)')
  const T = Date.parse('2026-11-16T00:00:00.000Z'), F = T + HOUR
  const cases = []
  for (const st of ['active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'trialing', 'paused', 'none', 'mystery']) {
    for (const v of [0, 1]) for (const pe of [T, null]) for (const paid of [T, null]) for (const fi of ['in_x', null]) for (const g of [F, null]) for (const vp of [T, null]) for (const ra of [true, false]) {
      for (const o of [-DAY, -1, 0, 1, HOUR - 1, HOUR, DAY - 1, DAY, DAY + 1, HOUR + 7 * DAY - 1, HOUR + 7 * DAY, HOUR + 7 * DAY + 1, 30 * DAY]) cases.push({ st, v, pe, paid, fi, g, vp, ra, now: T + o })
    }
  }
  const lit = (ms) => (ms === null ? 'NULL' : `'${iso(ms)}'`)
  const values = cases.map((c, i) => `(${i}, '${c.st}', ${c.v}::smallint, ${lit(c.pe)}::timestamptz, ${lit(c.paid)}::timestamptz, ${c.fi === null ? 'NULL' : `'${c.fi}'`}, ${lit(c.g)}::timestamptz, ${lit(c.vp)}::timestamptz, ${c.ra}, '${iso(c.now)}'::timestamptz)`).join(',')
  const rows = psql(`SELECT i, coalesce(extract(epoch FROM u) * 1000, -1)::bigint, (u IS NOT NULL AND n < u) FROM (SELECT i, public.subscription_access_until(s, v, pe, pd, fi, g, vp, ra) AS u, n FROM (VALUES ${values}) x(i, s, v, pe, pd, fi, g, vp, ra, n)) y ORDER BY i;`).trim().split(NL)
  let mismatches = 0
  for (const line of rows) {
    const [i, untilMs, grants] = line.split('|'); const c = cases[Number(i)]
    const js = subscriptionAccessUntil({ status: c.st, evidence_version: c.v, current_period_end: iso(c.pe), paid_through: iso(c.paid), failed_invoice_id: c.fi, grace_started_at: iso(c.g), verified_paid_through: iso(c.vp), renews_automatically: c.ra })
    const jsGrants = js !== null && c.now < js.getTime()
    if ((js === null ? -1 : js.getTime()) !== Number(untilMs) || jsGrants !== (grants === 't')) mismatches++
  }
  check(`SQL subscription_access_until and JS subscriptionAccessUntil agree on all ${cases.length} cases (10 statuses × legacy/evidence × period, paid, failure, anchor, verified-paid and automatic-renewal shapes × 13 instants)`, rows.length === cases.length && mismatches === 0, `${mismatches} mismatches`)
  const sqlGrants = (args, n) => one(`SELECT coalesce(public.subscription_access_until(${args}) > '${iso(n)}', false)`) === 't'
  const vT = `'${iso(T)}'`
  check('exact SQL cutoffs: paid through T without automatic renewal (Pro at T-1 ms, Free at T); pending-renewal allowance (Pro at T+24h-1 ms, Free at T+24h); grace = first failure + 7 days; legacy active through its period end; neither allowance nor grace from status alone',
    sqlGrants(`'active', 1::smallint, NULL, ${vT}, NULL, NULL, ${vT}, false`, T - 1) && !sqlGrants(`'active', 1::smallint, NULL, ${vT}, NULL, NULL, ${vT}, false`, T) &&
    sqlGrants(`'active', 1::smallint, NULL, ${vT}, NULL, NULL, ${vT}, true`, T + DAY - 1) && !sqlGrants(`'active', 1::smallint, NULL, ${vT}, NULL, NULL, ${vT}, true`, T + DAY) &&
    !sqlGrants(`'active', 1::smallint, NULL, ${vT}, NULL, NULL, NULL, true`, T) &&
    sqlGrants(`'past_due', 1::smallint, NULL, ${vT}, 'in_x', '${iso(F)}', ${vT}, true`, F + 7 * DAY - 1) && !sqlGrants(`'past_due', 1::smallint, NULL, ${vT}, 'in_x', '${iso(F)}', ${vT}, true`, F + 7 * DAY) &&
    sqlGrants(`'active', 0::smallint, ${vT}, NULL, NULL, NULL, NULL, false`, T - 1) && !sqlGrants(`'active', 0::smallint, ${vT}, NULL, NULL, NULL, ${vT}, true`, T) &&
    !sqlGrants(`'past_due', 1::smallint, '${iso(T + 30 * DAY)}', ${vT}, NULL, '${iso(F)}', NULL, false`, T) &&
    !sqlGrants(`'canceled', 1::smallint, NULL, ${vT}, NULL, NULL, ${vT}, true`, T - 1))

  // ── 4. The webhook, end to end (real orchestration, real database, fake Stripe) ──────────────────
  console.log(NL + '4. Failed renewals: grace from the FIRST failed payment, never restarted')
  for (const t of ['w', 'cycle', 'initfail', 'race1', 'race2', 'edge', 'edgepaid', 'oldprice', 'unrelated', 'buyer', 'swapu', 'swapc', 'renew', 'allowdup', 'allowcut', 'failearly', 'faillate', 'allowrace']) { await mk(t); expireTrial(ids[t]) }
  const BY0 = one(`SELECT ${setDigest(`SELECT * FROM public.subscriptions WHERE user_id = '${ids.bystander}'`)}`)
  const row = (uid) => JSON.parse(one(`SELECT row_to_json(s) FROM (SELECT * FROM public.subscriptions WHERE user_id = '${uid}') s`) || 'null')
  const ms = (v) => (v === null ? null : Date.parse(v))
  const now = Date.now()
  const R = now - 3 * DAY, F1 = R + HOUR, F2 = R + DAY + HOUR, F3 = R + 2 * DAY + HOUR

  // Purchase: paid for [R-30d, R]. Delivered now; the renewal at R has not been reported yet.
  putInv({ id: 'in_w0', customer: 'cus_w', sub: 'sub_w1', created: R - 30 * DAY, reason: 'subscription_create', status: 'paid', start: R - 30 * DAY, end: R })
  putSub({ id: 'sub_w1', customer: 'cus_w', user: ids.w, start: R - 30 * DAY, end: R, latest: 'in_w0' })
  const c1 = await checkout(ids.w, 'sub_w1', 'cus_w')
  check('purchase: the paid invoice is recorded; paid through exactly the period it paid for', c1.status === 200 && row(ids.w).evidence_version === 1 && ms(row(ids.w).paid_through) === sec(R) * 1000 && row(ids.w).last_paid_invoice_id === 'in_w0')
  // Renewal at R: Stripe advances the period and reports 'active' before the invoice is paid.
  putInv({ id: 'in_w1', customer: 'cus_w', sub: 'sub_w1', created: R, status: 'open', attempts: 0, start: R, end: R + 30 * DAY })
  putSub({ id: 'sub_w1', customer: 'cus_w', user: ids.w, start: R, end: R + 30 * DAY, latest: 'in_w1' })
  await subUpdated('sub_w1', 'cus_w')
  check('an "active" snapshot for the new period with its invoice not yet paid grants nothing beyond the paid period (Free, status still active)',
    row(ids.w).status === 'active' && !(await pro(ids.w)) && ms(row(ids.w).paid_through) === sec(R) * 1000)
  // Payment fails. The RETRY (F2) is delivered before the delayed FIRST failure (F1).
  putInv({ id: 'in_w1', customer: 'cus_w', sub: 'sub_w1', created: R, status: 'open', attempts: 2, start: R, end: R + 30 * DAY })
  putSub({ id: 'sub_w1', customer: 'cus_w', user: ids.w, status: 'past_due', start: R, end: R + 30 * DAY, latest: 'in_w1' })
  await invEvent('invoice.payment_failed', 'in_w1', { id: 'evt_wfailretry2', created: F2 })
  const afterRetry = ms(row(ids.w).grace_started_at)
  await invEvent('invoice.payment_failed', 'in_w1', { id: 'evt_wfailfirst1', created: F1 })
  check('delayed first-failure delivery: the anchor moves EARLIER to the first failed payment (Stripe’s event time, not delivery time)',
    afterRetry === sec(F2) * 1000 && ms(row(ids.w).grace_started_at) === sec(F1) * 1000)
  const dup = await invEvent('invoice.payment_failed', 'in_w1', { id: 'evt_wfailfirst1', created: F1 })
  await invEvent('invoice.payment_failed', 'in_w1', { id: 'evt_wfailretry3', created: F3 })
  await subUpdated('sub_w1', 'cus_w')
  check('a duplicate event, a later retry failure and a status update do not move the anchor', dup.status === 200 && ms(row(ids.w).grace_started_at) === sec(F1) * 1000)
  const sw = await status(ids.w)
  check('Pro in grace until exactly first failure + 7 days; the browser sees payment_grace_active', sw.can_use_pro === true && sw.payment_grace_active === true && Date.parse(sw.subscription_access_until) === sec(F1) * 1000 + 7 * DAY)

  // Later unpaid cycles never restart grace; paying an OLDER renewal is not recovery; paying the newest is.
  const R2 = now - 33 * DAY, R3 = now - 3 * DAY
  putInv({ id: 'in_c1', customer: 'cus_c', sub: 'sub_c', created: R2 - 30 * DAY, reason: 'subscription_create', status: 'paid', start: R2 - 30 * DAY, end: R2 })
  putSub({ id: 'sub_c', customer: 'cus_c', user: ids.cycle, start: R2 - 30 * DAY, end: R2, latest: 'in_c1' })
  await checkout(ids.cycle, 'sub_c', 'cus_c')
  putInv({ id: 'in_c2', customer: 'cus_c', sub: 'sub_c', created: R2, status: 'open', attempts: 4, start: R2, end: R3 })
  putSub({ id: 'sub_c', customer: 'cus_c', user: ids.cycle, status: 'past_due', start: R2, end: R3, latest: 'in_c2' })
  await invEvent('invoice.payment_failed', 'in_c2', { created: R2 + HOUR })
  check('first failed renewal 33 days ago: grace ended 7 days after it; Free', ms(row(ids.cycle).grace_started_at) === sec(R2 + HOUR) * 1000 && !(await pro(ids.cycle)))
  putInv({ id: 'in_c3', customer: 'cus_c', sub: 'sub_c', created: R3, status: 'open', attempts: 1, start: R3, end: R3 + 30 * DAY })
  putSub({ id: 'sub_c', customer: 'cus_c', user: ids.cycle, status: 'past_due', start: R3, end: R3 + 30 * DAY, latest: 'in_c3' })
  await invEvent('invoice.payment_failed', 'in_c3', { created: R3 + HOUR })
  await subUpdated('sub_c', 'cus_c')
  check('the NEXT renewal also fails while still unpaid: the stretch keeps its first anchor - no new grace, still Free',
    ms(row(ids.cycle).grace_started_at) === sec(R2 + HOUR) * 1000 && row(ids.cycle).latest_failed_invoice_id === 'in_c3' && !(await pro(ids.cycle)))
  putInv({ id: 'in_c2', customer: 'cus_c', sub: 'sub_c', created: R2, status: 'paid', start: R2, end: R3 })
  await invEvent('invoice.paid', 'in_c2')
  await invEvent('invoice.payment_failed', 'in_c3', { created: now - HOUR })
  check('paying the OLDER renewal while the newer one is still unpaid is not recovery: anchor kept, still Free (a later retry does not restart it)',
    ms(row(ids.cycle).grace_started_at) === sec(R2 + HOUR) * 1000 && !(await pro(ids.cycle)))
  putInv({ id: 'in_c3', customer: 'cus_c', sub: 'sub_c', created: R3, status: 'paid', start: R3, end: R3 + 30 * DAY })
  putSub({ id: 'sub_c', customer: 'cus_c', user: ids.cycle, status: 'active', start: R3, end: R3 + 30 * DAY, latest: 'in_c3' })
  await invEvent('invoice.paid', 'in_c3')
  check('genuine recovery (the newest renewal paid): failure cleared, Pro through the newly paid period (plus the 24-hour pending-renewal allowance after it)',
    row(ids.cycle).failed_invoice_id === null && row(ids.cycle).grace_started_at === null && await pro(ids.cycle) && await until(ids.cycle) === sec(R3 + 30 * DAY) * 1000 + DAY)
  const lateFail = await invEvent('invoice.payment_failed', 'in_c2', { created: now })
  check('a delayed failure for an invoice that has since been paid is recorded as payment, not as a failure', lateFail.status === 200 && row(ids.cycle).failed_invoice_id === null)
  putInv({ id: 'in_c4', customer: 'cus_c', sub: 'sub_c', created: now - 2 * HOUR, status: 'open', attempts: 1, start: now - 2 * HOUR, end: now + 30 * DAY })
  await invEvent('invoice.payment_failed', 'in_c4', { created: now - HOUR })
  check('after a genuine recovery, a later failure starts a NEW stretch with its own anchor', ms(row(ids.cycle).grace_started_at) === sec(now - HOUR) * 1000)

  // An initial purchase whose first payment fails gets no grace.
  putInv({ id: 'in_i0', customer: 'cus_i', sub: 'sub_i', created: now - HOUR, reason: 'subscription_create', status: 'open', attempts: 1, start: now - HOUR, end: now + 30 * DAY })
  putSub({ id: 'sub_i', customer: 'cus_i', user: ids.initfail, status: 'incomplete', start: now - HOUR, end: now + 30 * DAY, latest: 'in_i0' })
  const iu = await invEvent('invoice.payment_failed', 'in_i0', { created: now - HOUR })
  await checkout(ids.initfail, 'sub_i', 'cus_i')
  const ib = await invEvent('invoice.payment_failed', 'in_i0', { created: now - HOUR + 60000 })
  check('initial purchase failure: no grace whether or not the subscription is bound yet; Free',
    iu.status === 200 && ib.status === 200 && (row(ids.initfail) === null || (row(ids.initfail).failed_invoice_id === null && row(ids.initfail).grace_started_at === null)) && !(await pro(ids.initfail)),
    JSON.stringify([iu.status, ib.status, row(ids.initfail)?.status]))

  // Exact seven-day boundaries on live rows (database clock).
  console.log(NL + '5. Exact boundaries on the database clock')
  putInv({ id: 'in_e0', customer: 'cus_e', sub: 'sub_e', created: now - 60 * DAY, reason: 'subscription_create', status: 'paid', start: now - 60 * DAY, end: now - 30 * DAY })
  putSub({ id: 'sub_e', customer: 'cus_e', user: ids.edge, status: 'past_due', start: now - 60 * DAY, end: now - 30 * DAY, latest: 'in_e0' })
  await checkout(ids.edge, 'sub_e', 'cus_e')
  const ev = (uid, sub, cus, kind, inv, created, extra) => admin.rpc('apply_subscription_evidence', { p_user_id: uid, p_subscription_id: sub, p_customer_id: cus, p_kind: kind,
    p_invoice_id: inv, p_invoice_created: created, p_paid_period_end: extra.paid ?? null, p_failed_at: extra.failed ?? null })
  const dbNow = () => Date.parse(one(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`))
  let n0 = dbNow()
  await ev(ids.edge, 'sub_e', 'cus_e', 'failed', 'in_e1', iso(n0 - 8 * DAY), { failed: iso(n0 - 7 * DAY + 5000) })
  const inGrace = await pro(ids.edge)
  await ev(ids.edge, 'sub_e', 'cus_e', 'failed', 'in_e1', iso(n0 - 8 * DAY), { failed: iso(n0 - 7 * DAY) })
  check('failure 7 days minus 5 s ago: Pro; the same renewal’s earlier failure exactly 7 days ago: Free (anchor only moves earlier)', inGrace === true && !(await pro(ids.edge)))
  // Scheduled to cancel: no allowance - access ends exactly at the verified paid period.
  putInv({ id: 'in_p0', customer: 'cus_p', sub: 'sub_p', created: now - 30 * DAY, reason: 'subscription_create', status: 'paid', start: now - 30 * DAY, end: now - 2 * DAY })
  putSub({ id: 'sub_p', customer: 'cus_p', user: ids.edgepaid, cancel: true, start: now - 30 * DAY, end: now - 2 * DAY, latest: 'in_p0' })
  await checkout(ids.edgepaid, 'sub_p', 'cus_p')
  // Renews automatically, nothing reported since its paid period: the allowance ends exactly at +24 hours.
  putInv({ id: 'in_ac0', customer: 'cus_ac', sub: 'sub_ac', created: now - 30 * DAY, reason: 'subscription_create', status: 'paid', start: now - 30 * DAY, end: now - 2 * DAY })
  putSub({ id: 'sub_ac', customer: 'cus_ac', user: ids.allowcut, start: now - 30 * DAY, end: now - 2 * DAY, latest: 'in_ac0' })
  await checkout(ids.allowcut, 'sub_ac', 'cus_ac')
  n0 = dbNow()
  await ev(ids.edgepaid, 'sub_p', 'cus_p', 'paid', 'in_p1', iso(n0 - 60000), { paid: iso(n0 + 3000) })
  await ev(ids.allowcut, 'sub_ac', 'cus_ac', 'paid', 'in_ac1', iso(n0 - 60000), { paid: iso(n0 - DAY + 3000) })
  const cancelBefore = await pro(ids.edgepaid), cutBefore = await status(ids.allowcut)
  await sleep(Math.max(0, n0 + 3000 - dbNow()) + 300)
  const cutAfter = await status(ids.allowcut)
  check('scheduled to cancel: paid through now + 3 s gives Pro before it and Free after it - no allowance', cancelBefore === true && !(await pro(ids.edgepaid)))
  check('renews automatically, no payment or failure reported: Pro (renewal_allowance_active) until exactly verified paid end + 24 h, then Free',
    cutBefore.can_use_pro === true && cutBefore.renewal_allowance_active === true && Date.parse(cutBefore.subscription_access_until) === n0 + 3000 &&
    cutAfter.can_use_pro === false && cutAfter.renewal_allowance_active === false, JSON.stringify([cutBefore.renewal_allowance_active, cutAfter.can_use_pro]))

  // ── 5b. Pending-renewal allowance (24 hours after the verified paid period) ─────────────────────
  const gate = () => { let open; const p = new Promise((r) => { open = r }); return { p, open } }
  const reached = () => { let hit; const p = new Promise((r) => { hit = r }); return { p, hit } }
  console.log(NL + '5b. Pending-renewal allowance: temporary access while Stripe collects an automatic renewal')
  async function paidThen (tag, P, extra = {}) {
    putInv({ id: `in_${tag}0`, customer: `cus_${tag}`, sub: `sub_${tag}`, created: P - 30 * DAY, reason: 'subscription_create', status: 'paid', start: P - 30 * DAY, end: P })
    putSub({ id: `sub_${tag}`, customer: `cus_${tag}`, user: ids[tag], start: P - 30 * DAY, end: P, latest: `in_${tag}0`, ...extra })
    return checkout(ids[tag], `sub_${tag}`, `cus_${tag}`)
  }
  const renewalStarts = (tag, P, o = {}) => {
    putInv({ id: `in_${tag}1`, customer: `cus_${tag}`, sub: `sub_${tag}`, created: P, status: 'open', attempts: 0, start: P, end: P + 30 * DAY })
    putSub({ id: `sub_${tag}`, customer: `cus_${tag}`, user: ids[tag], start: P, end: P + 30 * DAY, latest: `in_${tag}1`, ...o })
  }
  // Normal renewal during Stripe's collection delay.
  const P1 = now - HOUR
  await paidThen('renew', P1)
  renewalStarts('renew', P1)
  await subUpdated('sub_renew', 'cus_renew')
  const during = await status(ids.renew)
  check('normal renewal: paid period ended an hour ago, the new invoice is not yet paid - Pro through the allowance (verified paid end + 24 h), not as payment',
    during.can_use_pro === true && during.renewal_allowance_active === true && during.payment_grace_active === false &&
    Date.parse(during.subscription_access_until) === sec(P1) * 1000 + DAY && ms(row(ids.renew).paid_through) === sec(P1) * 1000)
  putInv({ id: 'in_renew1', customer: 'cus_renew', sub: 'sub_renew', created: P1, status: 'paid', start: P1, end: P1 + 30 * DAY })
  await invEvent('invoice.paid', 'in_renew1')
  const paidNow = await status(ids.renew)
  check('...Stripe collects it: verified paid access through the new period (+24 h after it); the allowance is no longer what grants Pro',
    paidNow.can_use_pro === true && paidNow.renewal_allowance_active === false && Date.parse(paidNow.subscription_access_until) === sec(P1 + 30 * DAY) * 1000 + DAY)

  // Duplicates, retries, status changes, delayed and stale deliveries never extend or restart it.
  const P2 = now - 2 * HOUR
  await paidThen('allowdup', P2)
  renewalStarts('allowdup', P2)
  const cut2 = sec(P2) * 1000 + DAY
  const dupUntil0 = await until(ids.allowdup)
  const evDup = 'evt_allowdupupd'
  await subUpdated('sub_allowdup', 'cus_allowdup', { id: evDup })
  await subUpdated('sub_allowdup', 'cus_allowdup', { id: evDup })                    // duplicate delivery
  await subUpdated('sub_allowdup', 'cus_allowdup')                                  // a retry as a new event
  renewalStarts('allowdup', P2, { status: 'past_due' })
  await subUpdated('sub_allowdup', 'cus_allowdup')                                  // status changes, no failure evidence yet
  await invEvent('invoice.paid', 'in_allowdup0')                                    // a DELAYED paid event for the previous period
  renewalStarts('allowdup', P2 + 30 * DAY)
  await subUpdated('sub_allowdup', 'cus_allowdup')                                  // a snapshot even claiming a later period
  check('duplicates, retries, status changes, a delayed paid event for the old period and a later-period snapshot leave the cutoff at exactly verified paid end + 24 h',
    dupUntil0 === cut2 && await until(ids.allowdup) === cut2 && ms(row(ids.allowdup).verified_paid_through) === sec(P2) * 1000, JSON.stringify([dupUntil0, await until(ids.allowdup), cut2]))

  // A verified failure inside the allowance: switches to the 7-day grace from the first failed payment.
  const P3 = now - 3 * HOUR, F3e = now - 2 * HOUR
  await paidThen('failearly', P3)
  renewalStarts('failearly', P3, { status: 'past_due' })
  putInv({ id: 'in_failearly1', customer: 'cus_failearly', sub: 'sub_failearly', created: P3, status: 'open', attempts: 1, start: P3, end: P3 + 30 * DAY })
  await invEvent('invoice.payment_failed', 'in_failearly1', { created: F3e })
  const fe = await status(ids.failearly)
  check('failure before the allowance expires: grace from the first failed payment (+7 days) replaces it',
    fe.can_use_pro === true && fe.payment_grace_active === true && fe.renewal_allowance_active === false && Date.parse(fe.subscription_access_until) === sec(F3e) * 1000 + 7 * DAY)
  // ...and after it expired (Free in between), the verified failure still starts the 7-day grace.
  const P4 = now - 3 * DAY, F4 = now - HOUR
  await paidThen('faillate', P4)
  renewalStarts('faillate', P4)
  await subUpdated('sub_faillate', 'cus_faillate')
  const lateBefore = await pro(ids.faillate)
  putInv({ id: 'in_faillate1', customer: 'cus_faillate', sub: 'sub_faillate', created: P4, status: 'open', attempts: 1, start: P4, end: P4 + 30 * DAY })
  await invEvent('invoice.payment_failed', 'in_faillate1', { created: F4 })
  const fl = await status(ids.faillate)
  check('allowance expired with nothing reported: Free; a later verified failure then starts the 7-day grace from that failure',
    lateBefore === false && fl.can_use_pro === true && fl.payment_grace_active === true && Date.parse(fl.subscription_access_until) === sec(F4) * 1000 + 7 * DAY)
  const cy = await status(ids.cycle)
  check('an unresolved failed renewal gains no allowance when a later billing cycle starts (the cycle account stays on its grace, now ended)',
    cy.renewal_allowance_active === false && (await status(ids.initfail)).renewal_allowance_active === false)

  // Out-of-order handlers: an OLDER read saying "renews" cannot re-enable the allowance after a NEWER read said "cancelling".
  const P5 = now - HOUR
  await paidThen('allowrace', P5)
  renewalStarts('allowrace', P5)
  const staleRenewing = clone(stripe.subs.get('sub_allowrace')), gr = gate(), hr = reached()
  const olderRead = subUpdated('sub_allowrace', 'cus_allowrace', { fetchSubscription: async () => { hr.hit(); await gr.p; return staleRenewing } })
  await hr.p
  renewalStarts('allowrace', P5, { cancel: true })
  await subUpdated('sub_allowrace', 'cus_allowrace')
  const scheduled = await status(ids.allowrace)
  gr.open(); await olderRead
  const afterStale = await status(ids.allowrace)
  check('scheduled cancellation ends the allowance, and a delayed handler holding an older "renews" read cannot bring it back',
    scheduled.renewal_allowance_active === false && scheduled.can_use_pro === false && row(ids.allowrace).renews_automatically === false &&
    afterStale.can_use_pro === false && afterStale.renewal_allowance_active === false, JSON.stringify([scheduled.can_use_pro, afterStale.can_use_pro]))
  const forged = psql(`UPDATE public.subscriptions SET renews_automatically = true WHERE user_id = '${ids.allowrace}' RETURNING renews_automatically;`).trim()
  check('a direct write without a newer Stripe read time cannot turn the allowance back on', forged === 'f')

  // ── 6. Deterministic races: an older handler paused after its Stripe read ───────────────────────
  console.log(NL + '6. Races: an older handler paused after its Stripe read, released after newer evidence')
  // race1: an older handler holds the PRE-renewal snapshot (active, previous invoice PAID); meanwhile the renewal fails.
  putInv({ id: 'in_r10', customer: 'cus_r1', sub: 'sub_r1', created: R - 30 * DAY, reason: 'subscription_create', status: 'paid', start: R - 30 * DAY, end: R })
  putSub({ id: 'sub_r1', customer: 'cus_r1', user: ids.race1, start: R - 30 * DAY, end: R, latest: 'in_r10' })
  await checkout(ids.race1, 'sub_r1', 'cus_r1')
  const staleSub1 = clone(stripe.subs.get('sub_r1')), staleInv1 = clone(stripe.invoices.get('in_r10'))
  const g1 = gate(), h1 = reached()
  const older1 = subUpdated('sub_r1', 'cus_r1', { fetchSubscription: async () => staleSub1, fetchInvoice: async () => { h1.hit(); await g1.p; return staleInv1 } })
  await h1.p                                                  // the older handler has read Stripe and is paused
  putInv({ id: 'in_r11', customer: 'cus_r1', sub: 'sub_r1', created: R, status: 'open', attempts: 1, start: R, end: R + 30 * DAY })
  putSub({ id: 'sub_r1', customer: 'cus_r1', user: ids.race1, status: 'past_due', start: R, end: R + 30 * DAY, latest: 'in_r11' })
  await invEvent('invoice.payment_failed', 'in_r11', { created: F1 })
  await subUpdated('sub_r1', 'cus_r1')
  const mid1 = await until(ids.race1)
  g1.open(); const o1 = await older1
  const r1row = row(ids.race1)
  check('released after a NEWER FAILURE: the stale "active + paid" snapshot neither clears the failure nor restores access beyond the grace',
    o1.status === 200 && r1row.failed_invoice_id === 'in_r11' && ms(r1row.grace_started_at) === sec(F1) * 1000 && ms(r1row.paid_through) === sec(R) * 1000 &&
    await until(ids.race1) === mid1 && mid1 === sec(F1) * 1000 + 7 * DAY, JSON.stringify({ status: r1row.status, mid1, after: await until(ids.race1) }))
  // race2: two older handlers (a status update and a failure event) hold UNPAID reads; meanwhile the payment succeeds.
  putInv({ id: 'in_r20', customer: 'cus_r2', sub: 'sub_r2', created: R - 30 * DAY, reason: 'subscription_create', status: 'paid', start: R - 30 * DAY, end: R })
  putSub({ id: 'sub_r2', customer: 'cus_r2', user: ids.race2, start: R - 30 * DAY, end: R, latest: 'in_r20' })
  await checkout(ids.race2, 'sub_r2', 'cus_r2')
  putInv({ id: 'in_r21', customer: 'cus_r2', sub: 'sub_r2', created: R, status: 'open', attempts: 1, start: R, end: R + 30 * DAY })
  putSub({ id: 'sub_r2', customer: 'cus_r2', user: ids.race2, status: 'past_due', start: R, end: R + 30 * DAY, latest: 'in_r21' })
  await invEvent('invoice.payment_failed', 'in_r21', { created: F1 })
  const staleSub2 = clone(stripe.subs.get('sub_r2')), staleInv2 = clone(stripe.invoices.get('in_r21'))
  const g2 = gate(), h2a = reached(), h2b = reached()
  const older2a = subUpdated('sub_r2', 'cus_r2', { fetchSubscription: async () => staleSub2, fetchInvoice: async () => { h2a.hit(); await g2.p; return staleInv2 } })
  const older2b = invEvent('invoice.payment_failed', 'in_r21', { created: F2, fetchInvoice: async () => { h2b.hit(); await g2.p; return staleInv2 } })
  await Promise.all([h2a.p, h2b.p])
  putInv({ id: 'in_r21', customer: 'cus_r2', sub: 'sub_r2', created: R, status: 'paid', start: R, end: R + 30 * DAY })
  putSub({ id: 'sub_r2', customer: 'cus_r2', user: ids.race2, status: 'active', start: R, end: R + 30 * DAY, latest: 'in_r21' })
  await invEvent('invoice.paid', 'in_r21')
  const mid2 = await until(ids.race2)
  g2.open(); const [o2a, o2b] = await Promise.all([older2a, older2b])
  const r2row = row(ids.race2)
  check('released after a GENUINE RECOVERY: the stale "past_due + unpaid" reads restart no grace and remove no paid access',
    o2a.status === 200 && o2b.status === 200 && r2row.failed_invoice_id === null && r2row.grace_started_at === null && ms(r2row.paid_through) === sec(R + 30 * DAY) * 1000 &&
    mid2 === sec(R + 30 * DAY) * 1000 + DAY && await until(ids.race2) === mid2 && await pro(ids.race2), JSON.stringify({ status: r2row.status, failed: r2row.failed_invoice_id }))
  check('a stale status write may leave the STATUS column stale, but access never depends on it (it comes only from payment evidence)', ['past_due', 'active'].includes(r2row.status))

  // ── 7. Cancellation, older prices, unrelated subscriptions ───────────────────────────────────────
  console.log(NL + '7. Cancellation, older prices and unrelated subscriptions')
  putInv({ id: 'in_b0', customer: 'cus_b', sub: 'sub_b1', created: now - 10 * DAY, reason: 'subscription_create', status: 'paid', start: now - 10 * DAY, end: now + 20 * DAY })
  putSub({ id: 'sub_b1', customer: 'cus_b', user: ids.buyer, start: now - 10 * DAY, end: now + 20 * DAY, latest: 'in_b0' })
  await checkout(ids.buyer, 'sub_b1', 'cus_b')
  putSub({ id: 'sub_b1', customer: 'cus_b', user: ids.buyer, cancel: true, start: now - 10 * DAY, end: now + 20 * DAY, latest: 'in_b0' })
  await subUpdated('sub_b1', 'cus_b')
  check('cancel at period end: Pro through the paid period, ending exactly at it', await pro(ids.buyer) && await until(ids.buyer) === sec(now + 20 * DAY) * 1000)
  const staleB = clone(stripe.subs.get('sub_b1'))
  putSub({ id: 'sub_b1', customer: 'cus_b', user: ids.buyer, status: 'canceled', start: now - 10 * DAY, end: now + 20 * DAY, latest: 'in_b0' })
  await send('customer.subscription.deleted', { id: 'sub_b1', customer: 'cus_b', metadata: { user_id: ids.buyer } })
  check('immediate cancellation: canceled, Free', row(ids.buyer).status === 'canceled' && !(await pro(ids.buyer)))
  await subUpdated('sub_b1', 'cus_b', { fetchSubscription: async () => staleB })
  check('a stale "active" for the canceled subscription cannot restore access', row(ids.buyer).status === 'canceled' && !(await pro(ids.buyer)))
  putInv({ id: 'in_b2', customer: 'cus_b', sub: 'sub_b2', created: now, reason: 'subscription_create', status: 'paid', start: now, end: now + 30 * DAY })
  putSub({ id: 'sub_b2', customer: 'cus_b', user: ids.buyer, start: now, end: now + 30 * DAY, latest: 'in_b2' })
  await checkout(ids.buyer, 'sub_b2', 'cus_b')
  check('a genuinely NEW subscription starts with fresh evidence and is Pro once its first invoice is paid',
    row(ids.buyer).stripe_subscription_id === 'sub_b2' && row(ids.buyer).last_paid_invoice_id === 'in_b2' && await pro(ids.buyer))
  const b2 = JSON.stringify(row(ids.buyer))
  putSub({ id: 'sub_b1', customer: 'cus_b', user: ids.buyer, status: 'canceled', start: now - 10 * DAY, end: now + 20 * DAY, latest: 'in_b0' })
  await subUpdated('sub_b1', 'cus_b')
  check('a delayed update for the OLD (ended) subscription cannot replace the new one or erase its evidence', JSON.stringify(row(ids.buyer)) === b2 && await pro(ids.buyer))
  psql(`INSERT INTO public.subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end, price_id)
        VALUES ('${ids.oldprice}', 'cus_old', 'sub_old', 'active', now() - interval '35 days', false, '${OLD_PRICE}');`)
  putInv({ id: 'in_o1', customer: 'cus_old', sub: 'sub_old', created: now - 5 * DAY, status: 'paid', price: OLD_PRICE, start: now - 5 * DAY, end: now + 25 * DAY })
  putSub({ id: 'sub_old', customer: 'cus_old', user: ids.oldprice, price: OLD_PRICE, start: now - 5 * DAY, end: now + 25 * DAY, latest: 'in_o1' })
  const op = await subUpdated('sub_old', 'cus_old')
  check('a subscription bound to the user on an OLDER price keeps syncing: renewal paid on that price, Pro, price kept',
    op.status === 200 && row(ids.oldprice).price_id === OLD_PRICE && row(ids.oldprice).last_paid_invoice_id === 'in_o1' && await pro(ids.oldprice))
  putSub({ id: 'sub_unrelated', customer: 'cus_unrelated', user: ids.unrelated, price: OLD_PRICE, start: now, end: now + 30 * DAY })
  const un = await subUpdated('sub_unrelated', 'cus_unrelated')
  check('an unrelated subscription on another price grants nothing (no row, no Pro)', un.status === 200 && row(ids.unrelated) === null && !(await pro(ids.unrelated)))
  check("the bystander's subscription row is unchanged throughout", one(`SELECT ${setDigest(`SELECT * FROM public.subscriptions WHERE user_id = '${ids.bystander}'`)}`) === BY0)
  const direct = psql(`UPDATE public.subscriptions SET paid_through = now() + interval '1 year', grace_started_at = now(), failed_invoice_id = 'in_forged' WHERE user_id = '${ids.cycle}' RETURNING paid_through = now() + interval '1 year', failed_invoice_id;`).trim()
  check('a direct table write cannot forge or move evidence (only the evidence merge can)', direct.startsWith('f|') && direct !== 'f|in_forged')

  // ── 7b. A superseded subscription cannot replace a newer binding ─────────────────────────────────
  console.log(NL + '7b. Races: a handler holding subscription A, released after A was cancelled and B bought')
  const subRow = (uid) => JSON.parse(one(`SELECT row_to_json(s) FROM (SELECT user_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_created, status, current_period_start,
    current_period_end, cancel_at_period_end, price_id, evidence_version, paid_through, last_paid_invoice_id, last_paid_invoice_created, failed_invoice_id, failed_invoice_created,
    latest_failed_invoice_id, latest_failed_invoice_created, grace_started_at FROM public.subscriptions WHERE user_id = '${uid}') s`))
  async function replacementRace ({ tag, via, custA, custB }) {
    const uid = ids[tag], subA = `sub_${tag}a`, subB = `sub_${tag}b`
    // A: bought 40 days ago, paid, still live.
    putInv({ id: `in_${tag}a0`, customer: custA, sub: subA, created: now - 10 * DAY, status: 'paid', start: now - 10 * DAY, end: now + 20 * DAY })
    putSub({ id: subA, customer: custA, user: uid, created: now - 40 * DAY, start: now - 10 * DAY, end: now + 20 * DAY, latest: `in_${tag}a0` })
    const bindA = via === 'checkout' ? await send('customer.subscription.created', { id: subA, customer: custA }) : await checkout(uid, subA, custA)
    const bound = bindA.status === 200 && subRow(uid).stripe_subscription_id === subA && await pro(uid)
    // A's handler reads Stripe (A is active) and is paused BEFORE its database write.
    const staleA = clone(stripe.subs.get(subA)), g = gate(), h = reached()
    const fetchPaused = async () => { h.hit(); await g.p; return staleA }
    const handlerA = via === 'checkout'
      ? send('checkout.session.completed', { id: `cs_${subA}`, customer: custA, subscription: subA, client_reference_id: uid, metadata: { user_id: uid } }, { id: `evt_${tag}stale`, fetchSubscription: fetchPaused })
      : subUpdated(subA, custA, { id: `evt_${tag}stale`, fetchSubscription: fetchPaused })
    await h.p
    // Meanwhile: A is cancelled, B is bought and its payment verified.
    putSub({ id: subA, customer: custA, user: uid, status: 'canceled', start: now - 10 * DAY, end: now + 20 * DAY, latest: `in_${tag}a0` })
    const del = await send('customer.subscription.deleted', { id: subA, customer: custA, metadata: { user_id: uid } })
    putInv({ id: `in_${tag}b0`, customer: custB, sub: subB, created: now - HOUR, reason: 'subscription_create', status: 'paid', start: now - HOUR, end: now + 30 * DAY - HOUR })
    putSub({ id: subB, customer: custB, user: uid, created: now - HOUR, start: now - HOUR, end: now + 30 * DAY - HOUR, latest: `in_${tag}b0` })
    const bindB = await checkout(uid, subB, custB)
    const rowB = subRow(uid), untilB = await until(uid)
    // Release A's handler.
    g.open(); const released = await handlerA
    const after = subRow(uid)
    check(`${via}: setup - A bound and Pro, A cancelled, B bound with verified payment`, bound && del.status === 200 && bindB.status === 200 &&
      rowB.stripe_subscription_id === subB && rowB.stripe_customer_id === custB && rowB.last_paid_invoice_id === `in_${tag}b0`, JSON.stringify([bindA.status, del.status, bindB.status]))
    check(`${via}: the released handler holding an ACTIVE snapshot of A changes nothing - B's binding, customer, status, period, payment evidence and access are identical`,
      released.status === 200 && eventStatus(`evt_${tag}stale`) === 'ignored:' && JSON.stringify(after) === JSON.stringify(rowB) && await until(uid) === untilB && await pro(uid),
      JSON.stringify({ status: released.status, sub: after.stripe_subscription_id, customer: after.stripe_customer_id }))
    // Later events for B still process normally.
    putSub({ id: subB, customer: custB, user: uid, cancel: true, start: now - HOUR, end: now + 30 * DAY - HOUR, latest: `in_${tag}b0` })
    const upd = await subUpdated(subB, custB)
    putInv({ id: `in_${tag}b1`, customer: custB, sub: subB, created: now, status: 'paid', start: now + 30 * DAY - HOUR, end: now + 60 * DAY - HOUR })
    const paid = await invEvent('invoice.paid', `in_${tag}b1`)
    const later = subRow(uid)
    check(`${via}: later events for B still process normally (update applied, renewal payment recorded)`,
      upd.status === 200 && paid.status === 200 && later.stripe_subscription_id === subB && later.cancel_at_period_end === true &&
      later.last_paid_invoice_id === `in_${tag}b1` && await until(uid) === sec(now + 60 * DAY - HOUR) * 1000, JSON.stringify([upd.status, paid.status, later.last_paid_invoice_id]))
    // A NEWER subscription that has already ended (its first payment never completed) cannot replace B either.
    putSub({ id: `sub_${tag}c`, customer: custB, user: uid, status: 'incomplete_expired', created: now, start: now, end: now + 30 * DAY })
    const ended = await subUpdated(`sub_${tag}c`, custB, { id: `evt_${tag}ended` })
    check(`${via}: a NEWER but already-ended subscription does not replace the live binding`, ended.status === 200 && eventStatus(`evt_${tag}ended`) === 'ignored:' && JSON.stringify(subRow(uid)) === JSON.stringify(later) && await pro(uid))
  }
  await replacementRace({ tag: 'swapu', via: 'subscription-update', custA: 'cus_swapua', custB: 'cus_swapub' })
  await replacementRace({ tag: 'swapc', via: 'checkout', custA: 'cus_swapc', custB: 'cus_swapc' })
  // ── 7c. Bindings from before the migration: ordering from VERIFIED Stripe evidence only ──────────
  console.log(NL + '7c. A pre-migration binding (B replaced A before the migration; row created_at older than A)')
  const psqlRefusal = (sql) => {
    const r = spawnSync('docker', ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-f', '-'], { input: sql, encoding: 'utf8' })
    return r.status === 0 ? 'applied' : ((r.stderr || '').match(/subscription_[a-z_]+/) || ['error'])[0]
  }
  async function legacyRegression ({ tag, via }) {
    const uid = ids[tag], subA = `sub_${tag}a`, subB = `sub_${tag}b`, cust = `cus_${tag}`
    // Stripe: A created 200 days ago (AFTER the row's created_at), B 30 days ago.
    putSub({ id: subA, customer: cust, user: uid, created: now - 200 * DAY, start: now - 10 * DAY, end: now + 20 * DAY })
    putSub({ id: subB, customer: cust, user: uid, created: now - 30 * DAY, start: now - 10 * DAY, end: now + 20 * DAY })
    const before = subRow(uid), untilBefore = await until(uid)
    const rowCreatedOlder = one(`SELECT created_at < '${iso(now - 200 * DAY)}' FROM public.subscriptions WHERE user_id = '${uid}'`) === 't'
    // A's delayed handler holds an ACTIVE snapshot of A; it is released now.
    const staleA = clone(stripe.subs.get(subA)), g = gate(), h = reached()
    const fetchPaused = async (id) => { if (id !== subA) return liveFetchSub(id); h.hit(); await g.p; return staleA }
    const handlerA = via === 'checkout'
      ? send('checkout.session.completed', { id: `cs_${subA}`, customer: cust, subscription: subA, client_reference_id: uid, metadata: { user_id: uid } }, { id: `evt_${tag}stale`, fetchSubscription: fetchPaused })
      : subUpdated(subA, cust, { id: `evt_${tag}stale`, fetchSubscription: fetchPaused })
    await h.p; g.open()
    const released = await handlerA
    const after = subRow(uid)
    const { stripe_subscription_created: establishedB, ...restAfter } = after
    const { stripe_subscription_created: unknownBefore, ...restBefore } = before
    check(`${via}: setup - row bound to B, no stored creation time, row created_at OLDER than A`, before.stripe_subscription_id === subB && unknownBefore === null && rowCreatedOlder && before.evidence_version === 0)
    check(`${via}: A's delayed ACTIVE snapshot is refused - B's complete row (binding, customer, status, period, price, evidence) and access are unchanged; recorded "ignored"`,
      released.status === 200 && eventStatus(`evt_${tag}stale`) === 'ignored:' && JSON.stringify(restAfter) === JSON.stringify(restBefore) && await until(uid) === untilBefore && await pro(uid),
      JSON.stringify({ status: released.status, ev: eventStatus(`evt_${tag}stale`), sub: after.stripe_subscription_id }))
    check(`${via}: ...the ONLY change is B's creation time, established from B's own verified Stripe record`, Date.parse(establishedB) === sec(now - 30 * DAY) * 1000)
    // A genuinely newer replacement still works once B's creation time is known.
    putInv({ id: `in_${tag}c0`, customer: cust, sub: `sub_${tag}c`, created: now, reason: 'subscription_create', status: 'paid', start: now, end: now + 30 * DAY })
    putSub({ id: `sub_${tag}c`, customer: cust, user: uid, created: now, start: now, end: now + 30 * DAY, latest: `in_${tag}c0` })
    const c = via === 'checkout' ? await checkout(uid, `sub_${tag}c`, cust) : await subUpdated(`sub_${tag}c`, cust)
    const rc = subRow(uid)
    check(`${via}: a genuinely NEWER subscription then replaces B normally (fresh evidence, Pro)`, c.status === 200 && rc.stripe_subscription_id === `sub_${tag}c` &&
      rc.last_paid_invoice_id === `in_${tag}c0` && Date.parse(rc.stripe_subscription_created) === sec(now) * 1000 && await pro(uid), JSON.stringify([c.status, rc.stripe_subscription_id]))
  }
  await legacyRegression({ tag: 'lswapu', via: 'subscription-update' })
  await legacyRegression({ tag: 'lswapc', via: 'checkout' })

  // Ordering that cannot be established: the bound subscription is not available from Stripe.
  const unkBefore = subRow(ids.lunknown)
  putSub({ id: 'sub_lunknownd', customer: 'cus_lunknown', user: ids.lunknown, created: now, start: now, end: now + 30 * DAY })
  const unk = await subUpdated('sub_lunknownd', 'cus_lunknown', { id: 'evt_lunknownd' })
  check('unknown ordering (the bound subscription cannot be read from Stripe): binding kept, 5xx, recorded failed - never "processed"',
    unk.status >= 500 && eventStatus('evt_lunknownd') === 'failed:stripe_fetch_failed' && JSON.stringify(subRow(ids.lunknown)) === JSON.stringify(unkBefore))

  // Equal-second creation: no ordering is invented.
  console.log(NL + '7d. Equal-second creation')
  const eq0 = subRow(ids.swapu)
  const sameSecond = Date.parse(eq0.stripe_subscription_created)
  putSub({ id: 'sub_swapusame', customer: 'cus_swapub', user: ids.swapu, created: sameSecond, start: now, end: now + 30 * DAY })
  const eqU = await subUpdated('sub_swapusame', 'cus_swapub', { id: 'evt_equalupdate' })
  const eqC = await checkout(ids.swapu, 'sub_swapusame', 'cus_swapub', { id: 'evt_equalcheckout' })
  check('a DIFFERENT subscription created in the SAME second as the bound one: binding kept through both handlers, 500 binding_conflict (retried, diagnosable)',
    eqU.status === 500 && eqC.status === 500 && eventStatus('evt_equalupdate') === 'failed:binding_conflict' && eventStatus('evt_equalcheckout') === 'failed:binding_conflict' &&
    JSON.stringify(subRow(ids.swapu)) === JSON.stringify(eq0) && await pro(ids.swapu))

  // In the database itself (no webhook): refusals raise, so nothing changes and the reason is visible.
  const swapRow = subRow(ids.swapu)
  const noCreated = psqlRefusal(`UPDATE public.subscriptions SET stripe_subscription_id = 'sub_forged', stripe_customer_id = 'cus_forged', stripe_subscription_created = NULL WHERE user_id = '${ids.swapu}';`)
  const equal = psqlRefusal(`UPDATE public.subscriptions SET stripe_subscription_id = 'sub_forged', stripe_subscription_created = '${swapRow.stripe_subscription_created}' WHERE user_id = '${ids.swapu}';`)
  const older = psqlRefusal(`UPDATE public.subscriptions SET stripe_subscription_id = 'sub_forged', stripe_subscription_created = '${iso(now - 365 * DAY)}' WHERE user_id = '${ids.swapu}';`)
  const unknownStored = psqlRefusal(`UPDATE public.subscriptions SET stripe_subscription_id = 'sub_forged', stripe_subscription_created = now() WHERE user_id = '${ids.lunknown}';`)
  const sameIdCustomer = one(`UPDATE public.subscriptions SET stripe_customer_id = 'cus_forged', stripe_subscription_created = now() WHERE user_id = '${ids.swapc}' RETURNING stripe_customer_id || '|' || (stripe_subscription_created < now() - interval '30 minutes');`)
  check('in the database itself: missing, equal, older and unknown-stored orderings each RAISE their own reason and change nothing; the same subscription never changes customer or creation time',
    noCreated === 'subscription_order_unknown' && equal === 'subscription_order_equal' && older === 'subscription_superseded' && unknownStored === 'subscription_order_unknown' &&
    JSON.stringify(subRow(ids.swapu)) === JSON.stringify(swapRow) && sameIdCustomer === 'cus_swapc|true', JSON.stringify([noCreated, equal, older, unknownStored, sameIdCustomer]))

  const swapc0 = subRow(ids.swapc)
  const estMismatch = one(`SELECT public.establish_subscription_created('${ids.swapu}', 'sub_swapub', 'cus_swapub', '${iso(now - 999 * DAY)}') ->> 'result'`)
  const estMoved = one(`SELECT public.establish_subscription_created('${ids.swapc}', 'sub_swapca', 'cus_swapc', '${iso(now - 999 * DAY)}') ->> 'result'`)
  check('establish_subscription_created never overwrites a known creation time, and records nothing once the binding has moved on',
    estMismatch === 'mismatch' && estMoved === 'binding_changed' && JSON.stringify(subRow(ids.swapu)) === JSON.stringify(swapRow) && JSON.stringify(subRow(ids.swapc)) === JSON.stringify(swapc0),
    JSON.stringify([estMismatch, estMoved]))

  // ── 8. Browser RPC and AI evaluator agree ────────────────────────────────────────────────────────
  console.log(NL + '8. Browser RPC and AI-function evaluator agree on live rows')
  let disagreements = 0
  for (const t of Object.keys(ids)) {
    const s = await status(ids[t])
    const d = decideEntitlement(await loadProEntitlement(admin, ids[t]), new Date(s.server_now))
    if ((d.status === 'allow') !== (s.can_use_pro === true)) disagreements++
  }
  check(`get_my_pro_access_status and the AI functions’ evaluator agree for all ${Object.keys(ids).length} accounts`, disagreements === 0, `${disagreements} disagreements`)

  // ── 9. Permanent Pro cannot buy ──────────────────────────────────────────────────────────────────
  console.log(NL + '9. Permanent Pro cannot buy a redundant subscription (real database)')
  let stripeCalls = 0
  const env = { priceId: PRICE, stripeKey: 'sk_test_x', successUrl: 'https://www.getfunnl.com/s', cancelUrl: 'https://www.getfunnl.com/c' }
  const pc = await runCheckoutOrchestration({ user: { id: ids.permanent, email: 'acc-permanent@example.test' }, supabaseAdmin: admin, createStripeSession: async () => { stripeCalls++; return { outcome: 'unknown_failure' } }, env })
  check('Checkout for a permanent-Pro account: 409, no claim row, no Stripe call', pc.status === 409 && pc.body.state === 'permanent_pro' && stripeCalls === 0 &&
    one(`SELECT count(*) FROM public.checkout_operations WHERE user_id = '${ids.permanent}'`) === '0', JSON.stringify(pc))
  await runCheckoutOrchestration({ user: { id: ids.newbie, email: 'acc-newbie@example.test' }, supabaseAdmin: admin, createStripeSession: async () => { stripeCalls++; return { outcome: 'unknown_failure' } }, env })
  check('a non-permanent account still reaches Checkout (claim made, Stripe called)', stripeCalls === 1 && one(`SELECT count(*) FROM public.checkout_operations WHERE user_id = '${ids.newbie}'`) === '1')
}

main()
  .catch((e) => { console.error(e?.stack || e); failed++ })
  .finally(async () => {
    await teardown()
    console.log(`${NL}${passed + failed} checks: ${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  })
