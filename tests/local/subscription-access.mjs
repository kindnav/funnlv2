#!/usr/bin/env node
// SUBSCRIPTION ACCESS AND SYNC, AGAINST A REAL DATABASE (migration 20261023000000).
//
// Real Postgres, GoTrue and PostgREST. Every migration up to 20261020000000 is applied, synthetic users
// and rows are seeded, and only then is 20261023000000 applied - so the test proves it changes no
// existing trial, profile or subscription data. Then: the automatic signup trial; exact cutoffs, with
// the SQL rule and the JS rule evaluated on identical inputs; the RPC the browser uses and the
// evaluator every AI function uses agreeing on live rows; and the REAL webhook orchestration
// (fake Stripe objects) through renewal failure, duplicates, out-of-order delivery, recovery,
// cancellation, older-price updates and unrelated subscriptions; and the REAL checkout orchestration
// refusing permanent Pro. Synthetic data only; nothing reaches Stripe or Production.
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
const DAY = 86400000

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

  // ── Existing data before the migration ────────────────────────────────────────────────────────────
  const ids = {}, passwords = {}
  const mk = async (tag, confirm = true) => {
    passwords[tag] = randomBytes(12).toString('hex')
    const { data, error } = await admin.auth.admin.createUser({ email: `acc-${tag}@example.test`, password: passwords[tag], email_confirm: confirm })
    if (error) throw new Error(`createUser ${tag}: ${error.message}`)
    ids[tag] = data.user.id
  }
  for (const t of ['legacytrial', 'legacystale', 'legacyactive', 'permanent', 'bystander']) await mk(t)
  // Every new account gets the automatic trial; expire it for the accounts that test SUBSCRIPTION access, so
  // their result depends on the subscription alone.
  const expireTrial = (uid) => psql(`UPDATE public.pro_trials SET started_at = now() - interval '20 days', ends_at = now() - interval '13 days' WHERE user_id = '${uid}';`)
  for (const t of ['legacystale', 'legacyactive', 'bystander']) expireTrial(ids[t])
  psql(`UPDATE public.pro_trials SET started_at = now() - interval '3 days', ends_at = now() + interval '4 days' WHERE user_id = '${ids.legacytrial}';
        UPDATE public.profiles SET ai_enabled = true WHERE id = '${ids.permanent}';
        INSERT INTO public.subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end, price_id)
          VALUES ('${ids.legacystale}', 'cus_legacystale', 'sub_legacystale', 'active', now() - interval '39 days', false, '${OLD_PRICE}'),
                 ('${ids.legacyactive}', 'cus_legacyactive', 'sub_legacyactive', 'active', now() + interval '25 days', false, '${PRICE}'),
                 ('${ids.bystander}', 'cus_bystander', 'sub_bystander', 'active', now() + interval '20 days', false, '${PRICE}');`)
  const dataDigest = () => one(`SELECT ${setDigest('SELECT * FROM public.pro_trials')} || '|' || ${setDigest('SELECT * FROM public.profiles')} || '|' || ${setDigest('SELECT user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end, price_id, created_at, updated_at FROM public.subscriptions')}`)
  const D0 = dataDigest()
  const legacyBefore = await status(ids.legacystale)

  console.log(NL + '1. Applying the migration changes no existing trial, profile or subscription data')
  psql(readFileSync(join(ROOT, 'supabase/migrations', NEW_MIGRATION), 'utf8'))
  check('existing trials, profiles and subscription rows are byte-identical after the migration (new columns NULL)', dataDigest() === D0 &&
    one('SELECT count(*) FROM public.subscriptions WHERE current_period_start IS NOT NULL OR grace_started_at IS NOT NULL') === '0')
  check('a running trial keeps its original expiry (not restarted, extended or backfilled)', one(`SELECT (ends_at - now()) BETWEEN interval '3 days 23 hours' AND interval '4 days' FROM public.pro_trials WHERE user_id = '${ids.legacytrial}'`) === 't')
  const legacyAfter = await status(ids.legacystale)
  check('a stale paid row (period ended 39 days ago, never synced) granted Pro before - and no longer does', legacyBefore.can_use_pro === true && legacyAfter.can_use_pro === false && legacyAfter.subscription_status === 'active', JSON.stringify([legacyBefore.can_use_pro, legacyAfter.can_use_pro]))
  check('a current paid row still grants Pro, and reports when it ends', (await status(ids.legacyactive)).can_use_pro === true && Boolean((await status(ids.legacyactive)).subscription_access_until))
  check('permanent Pro is unaffected', (await status(ids.permanent)).permanent_pro === true && (await status(ids.permanent)).can_use_pro === true)

  console.log(NL + '2. Automatic signup trial (no card, no payment)')
  await mk('newbie')
  const t0 = one(`SELECT extract(epoch FROM (t.ends_at - u.created_at))::int || '|' || extract(epoch FROM (t.started_at - u.created_at))::int FROM public.pro_trials t JOIN auth.users u ON u.id = t.user_id WHERE t.user_id = '${ids.newbie}'`)
  const s0 = await status(ids.newbie)
  check('a new (auto-confirmed) account gets 7 days of Pro from creation: trial_active, can_use_pro, no subscription', t0.split('|')[0] === String(7 * 86400) && Math.abs(Number(t0.split('|')[1])) <= 2 &&
    s0.trial_active === true && s0.can_use_pro === true && s0.days_remaining === 7 && s0.subscription_status === 'none', t0)
  const endsBefore = one(`SELECT ends_at FROM public.pro_trials WHERE user_id = '${ids.newbie}'`)
  const signedIn = createClient(GW, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const si = await signedIn.auth.signInWithPassword({ email: 'acc-newbie@example.test', password: passwords.newbie })
  const restart = await signedIn.rpc('start_my_pro_trial')
  const si2 = await signedIn.auth.signInWithPassword({ email: 'acc-newbie@example.test', password: passwords.newbie })
  await signedIn.rpc('start_my_pro_trial')
  check('signing in again (twice, with the welcome-page trial call) neither restarts nor extends the trial', !si.error && !si2.error && restart.data?.started_now === false &&
    one(`SELECT ends_at FROM public.pro_trials WHERE user_id = '${ids.newbie}'`) === endsBefore, JSON.stringify(restart.error))
  await mk('unconfirmed', false)
  const u0 = await status(ids.unconfirmed)
  await admin.auth.admin.updateUserById(ids.unconfirmed, { email_confirm: true })
  const u1 = one(`SELECT (t.started_at - u.created_at) >= interval '0' AND t.ends_at = t.started_at + interval '7 days' FROM public.pro_trials t JOIN auth.users u ON u.id = t.user_id WHERE t.user_id = '${ids.unconfirmed}'`)
  check('an account that must confirm its email: trial eligible until confirmation, then 7 days from confirmation (existing behaviour, flagged)', u0.trial_eligible === true && u0.can_use_pro === false && u1 === 't')
  psql(`UPDATE public.pro_trials SET started_at = now() - interval '7 days' + interval '5 seconds', ends_at = now() + interval '5 seconds' WHERE user_id = '${ids.newbie}';`)
  const tb = await status(ids.newbie)
  psql(`UPDATE public.pro_trials SET started_at = now() - interval '7 days', ends_at = now() WHERE user_id = '${ids.newbie}';`)
  const ta = await status(ids.newbie)
  check('trial cutoff: Pro 5 s before expiry, Free at/after it (then Free unless paid or permanent)', tb.can_use_pro === true && ta.can_use_pro === false && ta.trial_expired === true)

  console.log(NL + '3. The SQL rule and the JS rule agree at every cutoff (identical inputs)')
  const T = Date.parse('2026-11-16T00:00:00.000Z')
  const iso = (ms) => (ms === null ? null : new Date(ms).toISOString())
  const shapes = []
  for (const status of ['active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'trialing', 'paused', 'none', 'mystery']) {
    for (const cancel of [false, true]) for (const pe of [T, null]) for (const gs of [T - 2 * DAY, null]) shapes.push({ status, cancel, pe, gs })
  }
  const offsets = [-DAY, -1, 0, 1, 5 * DAY - 1, 5 * DAY, 7 * DAY - 1, 7 * DAY, 7 * DAY + 1, 30 * DAY]
  const cases = []
  for (const s of shapes) for (const o of offsets) cases.push({ ...s, now: T + o })
  const values = cases.map((c, i) => `(${i}, '${c.status}', ${c.pe === null ? 'NULL' : `'${iso(c.pe)}'`}::timestamptz, ${c.cancel}, ${c.gs === null ? 'NULL' : `'${iso(c.gs)}'`}::timestamptz, '${iso(c.now)}'::timestamptz)`).join(',')
  const rows = psql(`SELECT i, coalesce(extract(epoch FROM u) * 1000, -1)::bigint, (u IS NOT NULL AND n < u) FROM (SELECT i, public.subscription_access_until(s, pe, c, g) AS u, n FROM (VALUES ${values}) v(i, s, pe, c, g, n)) x ORDER BY i;`).trim().split(NL)
  let mismatches = 0
  for (const line of rows) {
    const [i, untilMs, grants] = line.split('|'); const c = cases[Number(i)]
    const jsUntil = subscriptionAccessUntil({ status: c.status, current_period_end: iso(c.pe), cancel_at_period_end: c.cancel, grace_started_at: iso(c.gs) })
    const jsGrants = jsUntil !== null && c.now < jsUntil.getTime()
    if ((jsUntil === null ? -1 : jsUntil.getTime()) !== Number(untilMs) || jsGrants !== (grants === 't')) mismatches++
  }
  check(`SQL subscription_access_until and JS subscriptionAccessUntil agree on all ${cases.length} cases (10 statuses × period/cancel/grace shapes × 10 instants around each cutoff)`, rows.length === cases.length && mismatches === 0, `${mismatches} mismatches`)
  const sqlAt = (s, pe, c, g, n) => one(`SELECT public.subscription_access_until('${s}', '${iso(pe)}', ${c}, ${g === null ? 'NULL' : `'${iso(g)}'`}) > '${iso(n)}'`) === 't'
  check('cutoffs in SQL: renewing paid period ends at period end + 7 days; scheduled cancellation at period end; grace at anchor + 7 days',
    sqlAt('active', T, false, null, T + 7 * DAY - 1) && !sqlAt('active', T, false, null, T + 7 * DAY) &&
    sqlAt('active', T, true, null, T - 1) && !sqlAt('active', T, true, null, T) &&
    sqlAt('past_due', T + 30 * DAY, false, T, T + 7 * DAY - 1) && !sqlAt('past_due', T + 30 * DAY, false, T, T + 7 * DAY))

  console.log(NL + '4. The webhook, end to end, through the real orchestration and the database trigger')
  for (const t of ['w', 'unrelated', 'oldprice']) { await mk(t); expireTrial(ids[t]) }
  const BY0 = one(`SELECT ${setDigest(`SELECT * FROM public.subscriptions WHERE user_id = '${ids.bystander}'`)}`)
  const now = Date.now()
  const stripeSub = (o) => ({ id: o.id ?? 'sub_w1', object: 'subscription', customer: o.customer ?? 'cus_w', status: o.status ?? 'active', cancel_at_period_end: o.cancel ?? false, livemode: false,
    metadata: { user_id: o.user ?? ids.w }, items: { data: [{ price: { id: o.price ?? PRICE }, current_period_start: Math.floor(o.start / 1000), current_period_end: Math.floor(o.end / 1000) }] } })
  let current = null
  let evN = 0
  const send = async (type, object, { id } = {}) => {
    const event = { id: id ?? `evt_access${String(++evN).padStart(4, '0')}`, type, created: Math.floor(Date.now() / 1000), data: { object } }
    return runWebhookOrchestration({ event, requestId: 'h', supabaseAdmin: admin, fetchSubscription: async () => current, env: { priceId: PRICE, stripeKey: 'sk_test_x' } })
  }
  const row = (uid) => JSON.parse(one(`SELECT row_to_json(s) FROM (SELECT status, current_period_start, current_period_end, grace_started_at, price_id, stripe_subscription_id FROM public.subscriptions WHERE user_id = '${uid}') s`) || 'null')
  const pro = async (uid) => (await status(uid)).can_use_pro

  // Purchase.
  current = stripeSub({ start: now - 10 * DAY, end: now + 20 * DAY })
  const c1 = await send('checkout.session.completed', { id: 'cs_w', customer: 'cus_w', subscription: 'sub_w1', client_reference_id: ids.w, metadata: { user_id: ids.w } })
  check('purchase: the subscription is recorded with Stripe’s period start and end; Pro', c1.status === 200 && row(ids.w).status === 'active' && row(ids.w).current_period_start !== null && await pro(ids.w))
  // Renewal fails: Stripe advances the period and marks it past_due. Anchor = the new period's start.
  const renewal = now - 3 * DAY
  current = stripeSub({ status: 'past_due', start: renewal, end: renewal + 30 * DAY })
  const failEvt = 'evt_accessfail0001'
  await send('customer.subscription.updated', { id: 'sub_w1', customer: 'cus_w' }, { id: failEvt })
  const g1 = row(ids.w).grace_started_at
  check('renewal failure: grace anchored to Stripe’s renewal moment (not the processing time); still Pro within 7 days', Date.parse(g1) === Math.floor(renewal / 1000) * 1000 && await pro(ids.w), g1)
  const dup = await send('customer.subscription.updated', { id: 'sub_w1', customer: 'cus_w' }, { id: failEvt })
  await send('customer.subscription.updated', { id: 'sub_w1', customer: 'cus_w' })     // a retry fails again: new event, same renewal
  await send('invoice.payment_failed', { id: 'in_1' })
  check('a duplicate event, a repeated failure and invoice events do not restart the grace', dup.status === 200 && row(ids.w).grace_started_at === g1)
  current = stripeSub({ status: 'past_due', start: renewal + 30 * DAY, end: renewal + 60 * DAY })   // still unpaid at the NEXT renewal
  await send('customer.subscription.updated', { id: 'sub_w1', customer: 'cus_w' })
  check('even the next renewal cycle while still unpaid keeps the FIRST anchor (Free until payment succeeds)', row(ids.w).grace_started_at === g1)
  current = stripeSub({ status: 'unpaid', start: renewal + 30 * DAY, end: renewal + 60 * DAY })
  await send('customer.subscription.updated', { id: 'sub_w1', customer: 'cus_w' })
  check('Stripe moving it to unpaid keeps the same anchor', row(ids.w).status === 'unpaid' && row(ids.w).grace_started_at === g1)
  psql(`UPDATE public.subscriptions SET grace_started_at = grace_started_at - interval '5 days', current_period_start = current_period_start - interval '5 days' WHERE user_id = '${ids.w}';`)
  check('even a direct database write cannot move the grace anchor while the subscription stays unpaid', row(ids.w).grace_started_at === g1)
  // Simulate the clock moving 5 days on (test-only: the trigger is paused for this single time shift).
  psql(`ALTER TABLE public.subscriptions DISABLE TRIGGER subscriptions_access_guard;
        UPDATE public.subscriptions SET grace_started_at = grace_started_at - interval '5 days' WHERE user_id = '${ids.w}';
        ALTER TABLE public.subscriptions ENABLE TRIGGER subscriptions_access_guard;`)
  check('8 days after the failed renewal: Free (grace over), while the row still says unpaid', !(await pro(ids.w)) && (await status(ids.w)).subscription_status === 'unpaid')
  // Recovery.
  current = stripeSub({ status: 'active', start: renewal + 30 * DAY, end: renewal + 60 * DAY })
  await send('customer.subscription.updated', { id: 'sub_w1', customer: 'cus_w' })
  check('payment succeeds: active again, grace cleared, Pro restored', row(ids.w).status === 'active' && row(ids.w).grace_started_at === null && await pro(ids.w))
  // Cancellation at period end, and a missing final webhook.
  current = stripeSub({ status: 'active', cancel: true, start: now - 29 * DAY, end: now + DAY })
  await send('customer.subscription.updated', { id: 'sub_w1', customer: 'cus_w' })
  check('cancel at period end: Pro through the paid period', await pro(ids.w) && (await status(ids.w)).cancel_at_period_end === true)
  psql(`UPDATE public.subscriptions SET current_period_end = now() - interval '1 second' WHERE user_id = '${ids.w}';`)
  check('...and Free once the period has ended, even if the final "deleted" webhook never arrives', !(await pro(ids.w)))
  // Immediate cancellation, then a stale out-of-order update.
  current = stripeSub({ status: 'active', start: now - DAY, end: now + 29 * DAY })
  await send('customer.subscription.updated', { id: 'sub_w1', customer: 'cus_w' })
  const staleSnapshot = current
  await send('customer.subscription.deleted', { id: 'sub_w1', customer: 'cus_w', metadata: { user_id: ids.w } })
  check('immediate cancellation: canceled, Free', row(ids.w).status === 'canceled' && !(await pro(ids.w)))
  current = staleSnapshot
  const st = await send('customer.subscription.updated', { id: 'sub_w1', customer: 'cus_w' })
  check('a stale/out-of-order update carrying "active" for the canceled subscription cannot restore access', st.status === 200 && row(ids.w).status === 'canceled' && !(await pro(ids.w)))
  current = stripeSub({ id: 'sub_w2', status: 'active', start: now, end: now + 30 * DAY })
  await send('checkout.session.completed', { id: 'cs_w2', customer: 'cus_w', subscription: 'sub_w2', client_reference_id: ids.w, metadata: { user_id: ids.w } })
  check('a genuinely NEW subscription after cancellation is recorded normally', row(ids.w).stripe_subscription_id === 'sub_w2' && row(ids.w).status === 'active' && await pro(ids.w))
  // Delayed renewal webhook.
  psql(`UPDATE public.subscriptions SET current_period_end = now() - interval '2 days' WHERE user_id = '${ids.w}';`)
  const delayedPro = await pro(ids.w)
  psql(`UPDATE public.subscriptions SET current_period_end = now() - interval '8 days' WHERE user_id = '${ids.w}';`)
  check('renewal not yet synced: Pro for up to 7 days after the period end, then Free', delayedPro === true && !(await pro(ids.w)))

  // Older price, bound to the user.
  psql(`INSERT INTO public.subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end, price_id)
        VALUES ('${ids.oldprice}', 'cus_old', 'sub_old', 'active', now() - interval '35 days', false, '${OLD_PRICE}');`)
  current = stripeSub({ id: 'sub_old', customer: 'cus_old', user: ids.oldprice, price: OLD_PRICE, start: now - 5 * DAY, end: now + 25 * DAY })
  const op = await send('customer.subscription.updated', { id: 'sub_old', customer: 'cus_old' })
  check('an update on an OLDER price for a subscription bound to the user is applied (period renewed, price kept)', op.status === 200 && row(ids.oldprice).price_id === OLD_PRICE && Date.parse(row(ids.oldprice).current_period_end) > now && await pro(ids.oldprice))
  current = stripeSub({ id: 'sub_unrelated', customer: 'cus_unrelated', user: ids.unrelated, price: OLD_PRICE, start: now, end: now + 30 * DAY })
  const un = await send('customer.subscription.updated', { id: 'sub_unrelated', customer: 'cus_unrelated' })
  check('an unrelated subscription on another price grants nothing (no row, no Pro)', un.status === 200 && row(ids.unrelated) === null && !(await pro(ids.unrelated)))
  check("the bystander's subscription row is unchanged throughout", one(`SELECT ${setDigest(`SELECT * FROM public.subscriptions WHERE user_id = '${ids.bystander}'`)}`) === BY0)

  console.log(NL + '5. Browser RPC and AI-function evaluator agree on live rows')
  let disagreements = 0
  for (const t of Object.keys(ids)) {
    const s = await status(ids[t])
    const d = decideEntitlement(await loadProEntitlement(admin, ids[t]), new Date(s.server_now))
    if ((d.status === 'allow') !== (s.can_use_pro === true)) disagreements++
  }
  check(`get_my_pro_access_status and the AI functions’ evaluator agree for all ${Object.keys(ids).length} accounts`, disagreements === 0, `${disagreements} disagreements`)

  console.log(NL + '6. Permanent Pro cannot buy a redundant subscription (real database)')
  let stripeCalls = 0
  const env = { priceId: PRICE, stripeKey: 'sk_test_x', successUrl: 'https://www.getfunnl.com/s', cancelUrl: 'https://www.getfunnl.com/c' }
  const pc = await runCheckoutOrchestration({ user: { id: ids.permanent, email: 'acc-permanent@example.test' }, supabaseAdmin: admin, createStripeSession: async () => { stripeCalls++; return { outcome: 'unknown_failure' } }, env })
  check('Checkout for a permanent-Pro account: 409, no claim row, no Stripe call', pc.status === 409 && pc.body.state === 'permanent_pro' && stripeCalls === 0 &&
    one(`SELECT count(*) FROM public.checkout_operations WHERE user_id = '${ids.permanent}'`) === '0', JSON.stringify(pc))
  const nc = await runCheckoutOrchestration({ user: { id: ids.newbie, email: 'acc-newbie@example.test' }, supabaseAdmin: admin, createStripeSession: async () => { stripeCalls++; return { outcome: 'unknown_failure' } }, env })
  check('a trial (non-permanent) account still reaches Checkout (claim made, Stripe called)', stripeCalls === 1 && nc.status === 503 && one(`SELECT count(*) FROM public.checkout_operations WHERE user_id = '${ids.newbie}'`) === '1')
}

main()
  .catch((e) => { console.error(e?.stack || e); failed++ })
  .finally(async () => {
    await teardown()
    console.log(`${NL}${passed + failed} checks: ${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  })
