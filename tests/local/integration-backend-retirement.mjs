#!/usr/bin/env node
// STAGE D BACKEND RETIREMENT, AGAINST A REAL DATABASE - the forward migration
// 20261019000000_retire_integration_backend.sql and account deletion on both sides of it.
//
// Real Postgres (every migration up to this one), GoTrue and PostgREST, and the REAL shared helper
// delete-account uses (supabase/functions/shared/googleCleanup.js) through supabase-js, in the same
// order delete-account runs it. Synthetic users and rows only; nothing reaches Production, Google or
// Microsoft. Proves:
//   - account deletion works BEFORE the migration (the state after functions are undeployed),
//   - the migration unschedules outlook-worker-tick, deletes exactly its two Vault entries and drops
//     exactly the 48 retired RPCs, leaving every table row, trigger and retained function unchanged,
//   - a dropped RPC is gone through the API, while the retained cleanup RPC and expiry helpers work,
//   - account deletion still works AFTER the migration and cascades every integration row,
//   - another user's rows are untouched throughout, and re-applying the migration is a no-op.
//
// RUN (from the repository root): node tests/local/integration-backend-retirement.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { createServer as createHttp } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { createHmac, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { runGoogleLocalCleanup } from '../../supabase/functions/shared/googleCleanup.js'

const ROOT = join(import.meta.dirname, '..', '..')
const NEW_MIGRATION = '20261019000000_retire_integration_backend.sql'
const NET = 'funnl-beret-net', PG = 'funnl-beret-pg', AUTH = 'funnl-beret-auth', REST = 'funnl-beret-rest'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const AUTH_IMAGE = 'public.ecr.aws/supabase/gotrue:v2.192.0'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const P = { rest: 54151, auth: 54152, gw: 54155 }
const GW = `http://127.0.0.1:${P.gw}`
const JWT_SECRET = randomBytes(32).toString('hex')
const DB_PASSWORD = randomBytes(12).toString('hex')

// The 48 RPCs the migration retires, and what must survive it.
const DROPPED = readFileSync(join(ROOT, 'supabase/migrations', NEW_MIGRATION), 'utf8')
  .split('\n').filter((l) => l.startsWith('DROP FUNCTION IF EXISTS public.'))
  .map((l) => l.slice('DROP FUNCTION IF EXISTS public.'.length).split('(')[0])
const RETAINED_INTEGRATION = ['run_google_local_cleanup', 'outlook_sync_state_consume_wake', 'outlook_unpaired_valid',
  'expire_pending_email_context', 'expire_pending_outlook_context']
const USER_TABLES = ['contacts', 'interactions', 'profiles', 'google_connections', 'google_oauth_states',
  'interaction_candidates', 'microsoft_connections', 'microsoft_tokens', 'microsoft_oauth_states', 'outlook_sync_state',
  'new_contact_candidates', 'outlook_subscriptions']

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

// A minimal Supabase-style gateway so supabase-js reaches GoTrue and PostgREST at one URL.
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

// Synthetic integration rows for one user, one per retained table family (fingerprints derived per user).
function seedSql (uid, tag) {
  const fp = (s) => `encode(sha256(convert_to('${uid}-${s}', 'UTF8')), 'hex')`
  return `
    INSERT INTO public.contacts (user_id, name, company) VALUES ('${uid}', 'Ada ${tag}', 'Analytical Engines');
    INSERT INTO public.interactions (user_id, contact_id, type, interaction_date, notes)
      SELECT '${uid}', id, 'Email', current_date, 'synthetic note' FROM public.contacts WHERE user_id = '${uid}';
    INSERT INTO public.google_connections (user_id, google_sub, google_email, scopes)
      VALUES ('${uid}', 'synthetic-sub-${tag}', 'synthetic.google.${tag}@example.test', ARRAY['openid','email']);
    INSERT INTO public.google_tokens (connection_id, access_token_ciphertext, access_token_nonce)
      SELECT id, 'c3ludGhldGljLWNpcGhlcnRleHQ', 'c3ludGhldGljbm9uY2U' FROM public.google_connections WHERE user_id = '${uid}';
    INSERT INTO public.google_oauth_states (state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce, return_origin, expires_at)
      VALUES (${fp('gstate')}, '${uid}', 'c3ludGhldGlj', 'bm9uY2U', 'https://www.getfunnl.com', now() + interval '5 minutes');
    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date)
      SELECT '${uid}', id, 'google_calendar', ${fp('cal')}, 'Coffee chat', current_date FROM public.contacts WHERE user_id = '${uid}';
    INSERT INTO public.microsoft_connections (user_id, ms_account_id, account_type, ms_email, scopes, consented_at, consent_policy_version)
      VALUES ('${uid}', 'synthetic-ms-${tag}', 'personal', 'synthetic.ms.${tag}@example.test', ARRAY['Mail.Read','User.Read','offline_access','openid','email','profile'], now(), 'ol-disc-synthetic');
    INSERT INTO public.microsoft_tokens (connection_id, user_id, refresh_token_ciphertext, refresh_token_nonce)
      SELECT id, '${uid}', 'c3ludGhldGlj', 'bm9uY2U' FROM public.microsoft_connections WHERE user_id = '${uid}';
    INSERT INTO public.microsoft_oauth_states (state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce, return_origin, consented_at, consent_policy_version, expires_at)
      VALUES (${fp('mstate')}, '${uid}', 'c3ludGhldGlj', 'bm9uY2U', 'https://www.getfunnl.com', now() - interval '2 days', 'ol-disc-synthetic', now() - interval '1 day');
    INSERT INTO public.outlook_sync_state (connection_id, user_id, folder)
      SELECT id, '${uid}', 'inbox' FROM public.microsoft_connections WHERE user_id = '${uid}';
    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date)
      SELECT '${uid}', id, 'outlook', ${fp('ol')}, 'Email', current_date FROM public.contacts WHERE user_id = '${uid}';
    INSERT INTO public.new_contact_candidates (user_id, status, person_fingerprint, episode_fingerprint)
      VALUES ('${uid}', 'dismissed', ${fp('person')}, ${fp('episode')});
    INSERT INTO public.outlook_subscriptions (connection_id, user_id)
      SELECT id, '${uid}' FROM public.microsoft_connections WHERE user_id = '${uid}';`
}
function countsFor (uid) {
  const parts = USER_TABLES.map((t) => `SELECT '${t}', count(*) FROM public.${t} WHERE ${t === 'profiles' ? 'id' : 'user_id'} = '${uid}'`)
  parts.push(`SELECT 'google_tokens', count(*) FROM public.google_tokens t JOIN public.google_connections c ON c.id = t.connection_id WHERE c.user_id = '${uid}'`)
  return Object.fromEntries(psql(parts.join(' UNION ALL ') + ';').trim().split('\n').map((l) => { const [k, v] = l.split('|'); return [k, Number(v)] }))
}
const allZero = (c) => Object.values(c).every((v) => v === 0)
const allPositive = (c) => Object.values(c).every((v) => v > 0)
const retainedSnapshot = () => one(`SELECT string_agg(p.proname || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, ''), ';' ORDER BY p.proname, p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND NOT (p.proname = ANY (ARRAY[${DROPPED.map((d) => `'${d}'`).join(',')}]))`)
const tableSnapshot = () => one(`SELECT string_agg(c.relname || '=' || (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM public.' || quote_ident(c.relname), false, true, '')))[1]::text, ',' ORDER BY c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`)
const triggerSnapshot = () => one(`SELECT string_agg(tgrelid::regclass || ':' || tgname || ':' || tgfoid::regproc, ',' ORDER BY 1) FROM pg_trigger WHERE NOT tgisinternal`)

// Mirrors supabase/functions/delete-account/index.ts after authentication: best-effort Google cleanup
// through the shared helper, delete contacts, delete the auth user.
async function deleteAccount (admin, uid) {
  const g = await runGoogleLocalCleanup({ admin, userId: uid, resolveToken: async () => null, revoke: async () => { throw new Error('no network in this harness') } })
  const { error: cErr } = await admin.from('contacts').delete().eq('user_id', uid)
  const { error: dErr } = await admin.auth.admin.deleteUser(uid)
  return { googleCleanupError: g.localCleanupError, contactsError: cErr?.message ?? null, deleteError: dErr?.message ?? null }
}

let gw = null
async function teardown () {
  try { gw?.close() } catch { /* ignore */ }
  for (const c of [REST, AUTH, PG]) quiet(['rm', '-f', c])
  quiet(['network', 'rm', NET])
}
async function main () {
  await teardown()
  console.log('\nstanding up Postgres + GoTrue + PostgREST')
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
  check('the retirement migration is the latest migration', migrations[migrations.length - 1] === NEW_MIGRATION, migrations.slice(-2).join(', '))
  for (const m of migrations.filter((f) => f !== NEW_MIGRATION)) psql(readFileSync(join(ROOT, 'supabase/migrations', m), 'utf8'))
  console.log(`  applied ${migrations.length - 1} migrations (everything before the retirement)`)
  docker(['run', '-d', '--name', REST, '--network', NET, '-p', `${P.rest}:3000`, '-e', `PGRST_DB_URI=postgres://authenticator:${DB_PASSWORD}@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, REST_IMAGE])
  await waitHttp(`http://127.0.0.1:${P.rest}/`, (r) => r.status < 500, 'PostgREST')
  gw = await startGateway()
  const admin = createClient(GW, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

  console.log('\n1. Before the migration (the state once the functions are undeployed)')
  const ids = {}
  for (const tag of ['a', 'b', 'c']) {
    const { data, error } = await admin.auth.admin.createUser({ email: `retire-${tag}@example.test`, password: randomBytes(12).toString('hex'), email_confirm: true })
    if (error) throw new Error(`createUser ${tag}: ${error.message}`)
    ids[tag] = data.user.id
    psql(seedSql(ids[tag], tag))
  }
  psql(`SELECT vault.create_secret('https://example.invalid/functions/v1/outlook-import-worker', 'outlook_worker_url');
        SELECT vault.create_secret('synthetic-placeholder-not-a-secret-0000000', 'outlook_worker_secret');
        SELECT vault.create_secret('synthetic-unrelated-value', 'unrelated_synthetic_entry');`)
  check('every integration table holds synthetic rows for each user', ['a', 'b', 'c'].every((t) => allPositive(countsFor(ids[t]))))
  check('the Outlook cron job exists and is inactive', one("SELECT count(*) || ':' || bool_or(active) FROM cron.job WHERE jobname = 'outlook-worker-tick'") === '1:false')
  const delC = await deleteAccount(admin, ids.c)
  check('account deletion succeeds before the migration (Google cleanup, contacts, auth user)', !delC.googleCleanupError && !delC.contactsError && !delC.deleteError, JSON.stringify(delC))
  check('...and cascades every integration row of that user', allZero(countsFor(ids.c)), JSON.stringify(countsFor(ids.c)))

  const bBefore = countsFor(ids.b)
  const fnBefore = retainedSnapshot(), tblBefore = tableSnapshot(), trgBefore = triggerSnapshot()
  check('48 retired RPCs exist before the migration', Number(one(`SELECT count(DISTINCT proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND proname = ANY (ARRAY[${DROPPED.map((d) => `'${d}'`).join(',')}])`)) === 48 && DROPPED.length === 48)

  console.log('\n2. Applying the retirement migration')
  psql(readFileSync(join(ROOT, 'supabase/migrations', NEW_MIGRATION), 'utf8'))
  check('outlook-worker-tick is unscheduled', one("SELECT count(*) FROM cron.job WHERE jobname = 'outlook-worker-tick'") === '0')
  check('exactly the two worker Vault entries are deleted; the unrelated entry remains', one('SELECT string_agg(name, \',\' ORDER BY name) FROM vault.secrets') === 'unrelated_synthetic_entry')
  check('no overload of any of the 48 retired RPCs remains', one(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND proname = ANY (ARRAY[${DROPPED.map((d) => `'${d}'`).join(',')}])`) === '0')
  check('every retained function is byte-identical, with the same grants', retainedSnapshot() === fnBefore)
  check('the retained integration helpers are among them', RETAINED_INTEGRATION.every((f) => fnBefore.includes(`${f}:`)))
  check('no table row was added, changed in count or removed', tableSnapshot() === tblBefore)
  check('every trigger is unchanged', triggerSnapshot() === trgBefore)

  psql("NOTIFY pgrst, 'reload schema';"); await sleep(2500)
  console.log('\n3. After the migration')
  const r1 = await fetch(`${GW}/rest/v1/rpc/get_my_outlook_connection`, { method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }, body: '{}' })
  check('a retired RPC is gone through the API (404)', r1.status === 404, `status ${r1.status}`)
  for (const fn of ['expire_pending_email_context', 'expire_pending_outlook_context']) {
    const { error } = await admin.rpc(fn, { p_batch_size: 10 })
    check(`the retained ${fn} still runs for the service role`, !error, error?.message)
  }
  const delA = await deleteAccount(admin, ids.a)
  check('account deletion succeeds after the migration (Google cleanup RPC, contacts, auth user)', !delA.googleCleanupError && !delA.contactsError && !delA.deleteError, JSON.stringify(delA))
  check('...and cascades every integration row of that user', allZero(countsFor(ids.a)), JSON.stringify(countsFor(ids.a)))
  check("the bystander's rows are unchanged throughout", JSON.stringify(countsFor(ids.b)) === JSON.stringify(bBefore), JSON.stringify(countsFor(ids.b)))

  console.log('\n4. Re-applying the migration')
  const fnAfter = retainedSnapshot()
  let reapplied = true
  try { psql(readFileSync(join(ROOT, 'supabase/migrations', NEW_MIGRATION), 'utf8')) } catch { reapplied = false }
  check('re-applying is a no-op that still passes its own verification', reapplied && retainedSnapshot() === fnAfter)
}

main()
  .catch((e) => { console.error(e?.stack || e); failed++ })
  .finally(async () => {
    await teardown()
    console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  })
