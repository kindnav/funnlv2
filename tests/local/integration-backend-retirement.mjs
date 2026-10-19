#!/usr/bin/env node
// STAGE D BACKEND RETIREMENT, AGAINST A REAL DATABASE - the forward migration
// 20261019000000_retire_integration_backend.sql, its failure paths, and account deletion on both sides.
//
// HOW THE MIGRATION IS APPLIED HERE, AND WHY. `supabase db push` (CLI 2.109.0) runs each migration
// through pkg/migration/file.go ExecBatch: every statement of the file plus the INSERT into
// supabase_migrations.schema_migrations go into ONE pgconn batch (pgconn v1.14.3) that ends with a
// single Sync, and PostgreSQL commits or rolls back everything before a Sync as one implicit
// transaction. This harness reproduces that with `psql --single-transaction -v ON_ERROR_STOP=1`
// running the file AND the same history INSERT: all of it commits, or none of it does.
//
// Real Postgres (every migration before this one), GoTrue and PostgREST, and the REAL shared helper
// delete-account uses (supabase/functions/shared/googleCleanup.js) through supabase-js, in the order
// delete-account runs it. Synthetic users and rows only; nothing reaches Production, Google or
// Microsoft. Reports carry only check names, counts and match/mismatch - never row content or digests.
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
const MIGRATION_SQL = readFileSync(join(ROOT, 'supabase/migrations', NEW_MIGRATION), 'utf8')
const NET = 'funnl-beret-net', PG = 'funnl-beret-pg', AUTH = 'funnl-beret-auth', REST = 'funnl-beret-rest'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const AUTH_IMAGE = 'public.ecr.aws/supabase/gotrue:v2.192.0'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const P = { rest: 54151, auth: 54152, gw: 54155 }
const GW = `http://127.0.0.1:${P.gw}`
const JWT_SECRET = randomBytes(32).toString('hex')
const DB_PASSWORD = randomBytes(12).toString('hex')

// The 48 RPCs the migration retires (read from the file itself), and what must survive it.
const DROP_LINES = MIGRATION_SQL.split('\n').filter((l) => l.startsWith('DROP FUNCTION IF EXISTS public.'))
const DROPPED = DROP_LINES.map((l) => l.slice('DROP FUNCTION IF EXISTS public.'.length).split('(')[0])
const RETAINED_INTEGRATION = ['run_google_local_cleanup', 'outlook_sync_state_consume_wake', 'outlook_unpaired_valid',
  'expire_pending_email_context', 'expire_pending_outlook_context']
const USER_TABLES = ['contacts', 'interactions', 'profiles', 'google_connections', 'google_oauth_states',
  'interaction_candidates', 'microsoft_connections', 'microsoft_tokens', 'microsoft_oauth_states', 'outlook_sync_state',
  'new_contact_candidates', 'outlook_subscriptions']
// CLI 2.109.0 pkg/migration/history.go, verbatim: the history table and the row ExecBatch inserts.
const CLI_HISTORY_SETUP = `CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY);
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[];
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text;`
const HISTORY_INSERT = "INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES ('20261019000000', 'retire_integration_backend', ARRAY['applied by the local harness']);"

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

// The migration exactly as `db push` runs it: file + history row, one transaction, stop on first error.
// Returns ok and the first ERROR line (used only to classify the failure, never printed in full).
function applyRetirement ({ withHistory = true } = {}) {
  const input = MIGRATION_SQL + '\n' + (withHistory ? HISTORY_INSERT + '\n' : '')
  const r = spawnSync('docker', ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-q', '-At', '-f', '-'], { input, encoding: 'utf8' })
  const errLine = (r.stderr || '').split('\n').find((l) => l.includes('ERROR:')) || ''
  return { ok: r.status === 0, errLine }
}

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

// Synthetic integration rows for one user (fingerprints derived per user).
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

// Deterministic membership + content digest of a row set: md5 over the SORTED md5 of each row's text.
// Equal digests mean the same rows with the same content; any added, removed or edited row changes it.
const setDigest = (rowsSql) => `(SELECT md5(coalesce(string_agg(h, ',' ORDER BY h), '')) || ':' || count(*) FROM (SELECT md5(r::text) AS h FROM (${rowsSql}) r) d)`
function userRowsSql (t, uid) {
  if (t === 'profiles') return `SELECT * FROM public.profiles WHERE id = '${uid}'`
  return `SELECT * FROM public.${t} WHERE user_id = '${uid}'`
}
// One user's rows in every table it owns (membership + content), plus its Google tokens.
function userDigests (uid) {
  const parts = USER_TABLES.map((t) => `SELECT '${t}', ${setDigest(userRowsSql(t, uid))}`)
  parts.push(`SELECT 'google_tokens', ${setDigest(`SELECT t.* FROM public.google_tokens t JOIN public.google_connections c ON c.id = t.connection_id WHERE c.user_id = '${uid}'`)}`)
  return Object.fromEntries(psql(parts.join(' UNION ALL ') + ';').trim().split('\n').map((l) => { const [k, v] = l.split('|'); return [k, v] }))
}
const rowCount = (d) => Number(String(d).split(':')[1])
const allEmpty = (digests) => Object.values(digests).every((v) => rowCount(v) === 0)
const allPresent = (digests) => Object.values(digests).every((v) => rowCount(v) > 0)

// Everything the migration could touch, as digests: every public table's rows, auth users, Vault rows,
// cron jobs, every public function (signature, body, grants), triggers and the migration history.
let PUBLIC_TABLES = []
function fullState () {
  const tableParts = PUBLIC_TABLES.map((t) => `SELECT 'table:${t}', ${setDigest(`SELECT * FROM public.${t}`)}`)
  const sql = [
    ...tableParts,
    `SELECT 'auth.users', ${setDigest('SELECT id, email FROM auth.users')}`,
    `SELECT 'vault', ${setDigest('SELECT * FROM vault.secrets')}`,
    `SELECT 'cron', ${setDigest('SELECT jobid, jobname, schedule, command, active, username FROM cron.job')}`,
    `SELECT 'functions', ${setDigest(`SELECT p.proname, oidvectortypes(p.proargtypes) AS args, md5(p.prosrc) AS body, p.proacl::text AS acl, p.prosecdef, p.proconfig::text AS cfg FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`)}`,
    `SELECT 'triggers', ${setDigest('SELECT tgrelid::regclass::text AS rel, tgname, tgfoid::regproc::text AS fn, tgenabled FROM pg_trigger WHERE NOT tgisinternal')}`,
    `SELECT 'history', ${setDigest('SELECT version, name FROM supabase_migrations.schema_migrations')}`,
  ].join(' UNION ALL ') + ';'
  return Object.fromEntries(psql(sql).trim().split('\n').map((l) => { const [k, v] = l.split('|'); return [k, v] }))
}
const diffKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k])
const targetedCount = () => Number(one(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND proname = ANY (ARRAY[${DROPPED.map((d) => `'${d}'`).join(',')}])`))
const historyCount = () => Number(one("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261019000000'"))
const vaultNames = () => one('SELECT coalesce(string_agg(name, \',\' ORDER BY name), \'\') FROM vault.secrets')
const cronJob = () => one("SELECT coalesce(string_agg(jobid || ':' || active || ':' || schedule, ','), '') FROM cron.job WHERE jobname = 'outlook-worker-tick'")

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
  psql(CLI_HISTORY_SETUP)
  console.log(`  applied ${migrations.length - 1} migrations (everything before the retirement) and the CLI history table`)
  docker(['run', '-d', '--name', REST, '--network', NET, '-p', `${P.rest}:3000`, '-e', `PGRST_DB_URI=postgres://authenticator:${DB_PASSWORD}@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, REST_IMAGE])
  await waitHttp(`http://127.0.0.1:${P.rest}/`, (r) => r.status < 500, 'PostgREST')
  gw = await startGateway()
  const admin = createClient(GW, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  PUBLIC_TABLES = one("SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'").split(',')

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
  check('every integration table holds synthetic rows for each user', ['a', 'b', 'c'].every((t) => allPresent(userDigests(ids[t]))))
  check('the Outlook cron job exists exactly once and is inactive', /^[0-9]+:false:/.test(cronJob()) && !cronJob().includes(','), cronJob())
  check('all 48 targeted RPCs exist', DROPPED.length === 48 && targetedCount() === 48)
  const delC = await deleteAccount(admin, ids.c)
  check('account deletion succeeds before the migration (Google cleanup, contacts, auth user)', !delC.googleCleanupError && !delC.contactsError && !delC.deleteError, JSON.stringify(delC))
  check('...and leaves none of that user\'s rows in any integration table', allEmpty(userDigests(ids.c)))
  const S0 = fullState()
  const B0 = userDigests(ids.b), A0 = userDigests(ids.a)
  const unrelatedVault = () => one('SELECT ' + setDigest("SELECT * FROM vault.secrets WHERE name = 'unrelated_synthetic_entry'"))
  const V0 = unrelatedVault()

  console.log('\n2. Failure path: a real dependency blocks the LAST drop, after every earlier action has run')
  // A synthetic view that calls the last function the migration drops. DROP FUNCTION without CASCADE
  // must refuse (SQLSTATE 2BP01) - by then the job is unscheduled, both Vault rows deleted and 47
  // functions dropped inside the transaction, so a full rollback has real work to undo.
  const last = DROP_LINES[DROP_LINES.length - 1]
  const lastName = DROPPED[DROPPED.length - 1]
  const argTypes = last.slice(last.indexOf('(') + 1, last.lastIndexOf(')')).split(', ')
  psql(`CREATE VIEW public._stage_d_synthetic_blocker AS SELECT public.${lastName}(${argTypes.map((t) => `NULL::${t}`).join(', ')}) AS r;`)
  const Sblock = fullState()
  const f1 = applyRetirement()
  check('the blocked attempt fails', !f1.ok)
  check('...on the dependency, at the last DROP (not on something earlier)', f1.errLine.includes('cannot drop function') && f1.errLine.includes(lastName), f1.errLine.slice(0, 120))
  const S1 = fullState()
  check('...and rolls back EVERYTHING: tables, auth users, Vault, cron, functions, grants, triggers, history', diffKeys(Sblock, S1).length === 0, `changed: ${diffKeys(Sblock, S1).join(', ')}`)
  check('...the cron job is still there, once, and inactive', /^[0-9]+:false:/.test(cronJob()) && !cronJob().includes(','), cronJob())
  check('...both worker Vault entries are still there', vaultNames() === 'outlook_worker_secret,outlook_worker_url,unrelated_synthetic_entry', vaultNames())
  check('...all 48 targeted RPCs are still there', targetedCount() === 48)
  check('...and no version was recorded', historyCount() === 0)
  psql('DROP VIEW public._stage_d_synthetic_blocker;')
  check('removing only the synthetic blocker restores the exact starting state', diffKeys(S0, fullState()).length === 0, `changed: ${diffKeys(S0, fullState()).join(', ')}`)

  console.log('\n3. Failure path: the cron job is unexpectedly ACTIVE')
  const jobId = one("SELECT jobid FROM cron.job WHERE jobname = 'outlook-worker-tick'")
  // A once-a-year schedule so the active job cannot fire during the test; the guard checks `active`.
  psql(`SELECT cron.alter_job(${jobId}, schedule := '0 0 1 1 *', active := true);`)
  const Sactive = fullState()
  const f2 = applyRetirement()
  check('the attempt with an active job fails', !f2.ok)
  check('...on the cron guard', f2.errLine.includes('refusing to retire outlook-worker-tick: the job is ACTIVE'), f2.errLine.slice(0, 120))
  check('...and changes nothing at all', diffKeys(Sactive, fullState()).length === 0, `changed: ${diffKeys(Sactive, fullState()).join(', ')}`)
  check('...the job is still scheduled and still active', /^[0-9]+:true:/.test(cronJob()), cronJob())
  check('...with both Vault entries, all 48 RPCs and no recorded version', vaultNames().startsWith('outlook_worker_secret,outlook_worker_url') && targetedCount() === 48 && historyCount() === 0)
  psql(`SELECT cron.alter_job(${jobId}, schedule := '* * * * *', active := false);`)
  check('restoring the original schedule and inactive state restores the exact starting state', diffKeys(S0, fullState()).length === 0, `changed: ${diffKeys(S0, fullState()).join(', ')}`)

  console.log('\n4. Successful application')
  const ok = applyRetirement()
  check('the migration and its history row commit', ok.ok, ok.errLine.slice(0, 120))
  const S2 = fullState()
  check('outlook-worker-tick is unscheduled', cronJob() === '')
  check('exactly the two worker Vault entries are deleted', vaultNames() === 'unrelated_synthetic_entry')
  check('...and the unrelated Vault entry is unchanged (content digest)', rowCount(V0) === 1 && unrelatedVault() === V0)
  check('no overload of any of the 48 retired RPCs remains', targetedCount() === 0)
  const retainedNow = one(`SELECT string_agg(p.proname || ':' || oidvectortypes(p.proargtypes) || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, ''), ';' ORDER BY 1) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`)
  check('the retained integration helpers are still present', RETAINED_INTEGRATION.every((f) => retainedNow.includes(`${f}:`)))
  check('every public table has the same rows with the same content', PUBLIC_TABLES.every((t) => S0[`table:${t}`] === S2[`table:${t}`]), PUBLIC_TABLES.filter((t) => S0[`table:${t}`] !== S2[`table:${t}`]).join(', '))
  check('auth users and triggers are unchanged', S0['auth.users'] === S2['auth.users'] && S0.triggers === S2.triggers)
  check('exactly one history row records the version', historyCount() === 1)
  check('only Vault, cron, functions and history changed', diffKeys(S0, S2).sort().join(',') === 'cron,functions,history,vault', diffKeys(S0, S2).join(','))

  psql("NOTIFY pgrst, 'reload schema';"); await sleep(2500)
  console.log('\n5. After the migration')
  const r1 = await fetch(`${GW}/rest/v1/rpc/get_my_outlook_connection`, { method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }, body: '{}' })
  check('a retired RPC is gone through the API (404)', r1.status === 404, `status ${r1.status}`)
  for (const fn of ['expire_pending_email_context', 'expire_pending_outlook_context']) {
    const { error } = await admin.rpc(fn, { p_batch_size: 10 })
    check(`the retained ${fn} still runs for the service role`, !error, error?.message)
  }
  check("the protected user's rows are unchanged by the migration (membership and content)", JSON.stringify(userDigests(ids.a)) === JSON.stringify(A0))
  const delA = await deleteAccount(admin, ids.a)
  check('account deletion succeeds after the migration (Google cleanup RPC, contacts, auth user)', !delA.googleCleanupError && !delA.contactsError && !delA.deleteError, JSON.stringify(delA))
  check('...and leaves none of that user\'s rows in any integration table', allEmpty(userDigests(ids.a)))
  check("the bystander's rows are unchanged throughout (membership and content)", JSON.stringify(userDigests(ids.b)) === JSON.stringify(B0))

  console.log('\n6. Re-applying the migration body')
  // `db push` never re-runs a recorded version; this proves the body itself is safe to run again.
  const Sbefore = fullState()
  const again = applyRetirement({ withHistory: false })
  check('re-running the body succeeds and still passes its own verification', again.ok, again.errLine.slice(0, 120))
  check('...and changes nothing', diffKeys(Sbefore, fullState()).length === 0, `changed: ${diffKeys(Sbefore, fullState()).join(', ')}`)
}

main()
  .catch((e) => { console.error(e?.stack || e); failed++ })
  .finally(async () => {
    await teardown()
    console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  })
