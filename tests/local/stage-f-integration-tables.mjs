#!/usr/bin/env node
// STAGE F, AGAINST A REAL DATABASE - the forward migration 20261019180000_drop_integration_tables.sql,
// its refusals, a late failure that must roll back tables it had already dropped, and account deletion
// with BOTH the deployed (old) and the Stage F (new) delete-account logic, before and after.
//
// HOW THE MIGRATION IS APPLIED HERE. `supabase db push` (CLI 2.109.0) sends the file and its
// supabase_migrations.schema_migrations INSERT as one pgconn batch closed by a single Sync, which
// PostgreSQL runs as one implicit transaction. `psql --single-transaction -v ON_ERROR_STOP=1` with the
// same history INSERT reproduces that: all of it commits, or none of it does.
//
// Real Postgres (every migration before this one, so the Stage D state), GoTrue and PostgREST. The OLD
// delete-account logic uses the real shared helper as deployed (loaded from git history by
// ./retired-google-cleanup.mjs); the NEW logic mirrors supabase/functions/delete-account/index.ts.
// Synthetic users and rows only; nothing reaches Production, Google or Microsoft. Reports carry only
// check names, counts and match/mismatch - never row content or digests.
//
// RUN (from the repository root): node tests/local/stage-f-integration-tables.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { createServer as createHttp } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { createHmac, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { loadRetiredGoogleCleanup } from './retired-google-cleanup.mjs'

const NL = String.fromCharCode(10)
const ROOT = join(import.meta.dirname, '..', '..')
const { runGoogleLocalCleanup } = await loadRetiredGoogleCleanup(ROOT)
const NEW_MIGRATION = '20261019180000_drop_integration_tables.sql'
const MIGRATION_SQL = readFileSync(join(ROOT, 'supabase/migrations', NEW_MIGRATION), 'utf8')
const NET = 'funnl-stagef-net', PG = 'funnl-stagef-pg', AUTH = 'funnl-stagef-auth', REST = 'funnl-stagef-rest'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const AUTH_IMAGE = 'public.ecr.aws/supabase/gotrue:v2.192.0'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const P = { rest: 54171, auth: 54172, gw: 54175 }
const GW = `http://127.0.0.1:${P.gw}`
const JWT_SECRET = randomBytes(32).toString('hex')
const DB_PASSWORD = randomBytes(12).toString('hex')

// The deletion scope, read from the migration itself.
const lines = MIGRATION_SQL.split(NL).map((l) => l.trim())
const DROPPED_TABLES = lines.filter((l) => l.startsWith('DROP TABLE IF EXISTS public.')).map((l) => l.slice('DROP TABLE IF EXISTS public.'.length).replace(';', ''))
const DROP_FN_LINES = lines.filter((l) => l.startsWith('DROP FUNCTION IF EXISTS public.'))
const DROPPED_FNS = DROP_FN_LINES.map((l) => l.slice('DROP FUNCTION IF EXISTS public.'.length).split('(')[0])
const RETAINED_TABLES = ['contacts', 'interactions', 'profiles', 'pro_trials', 'subscriptions', 'checkout_operations', 'stripe_webhook_events']
const RETAINED_FNS = ['activate_trial_on_confirmation', 'claim_checkout_operation', 'claim_webhook_event', 'finalize_checkout_operation',
  'get_my_pro_access_status', 'handle_new_user', 'mark_webhook_event', 'start_my_pro_trial']
const sqlList = (xs) => xs.map((x) => `'${x}'`).join(',')
const INTEG = sqlList(DROPPED_TABLES)

const CLI_HISTORY_SETUP = `CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY);
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[];
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text;`
const HISTORY_INSERT = "INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES ('20261019180000', 'drop_integration_tables', ARRAY['applied by the local harness']);"

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
function applyStageF ({ withHistory = true } = {}) {
  const input = MIGRATION_SQL + NL + (withHistory ? HISTORY_INSERT + NL : '')
  const r = spawnSync('docker', ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-q', '-At', '-f', '-'], { input, encoding: 'utf8' })
  const errLine = (r.stderr || '').split(NL).find((l) => l.includes('ERROR:')) || ''
  return { ok: r.status === 0, errLine }
}

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

// The Production shape after Stage D, for one user: ordinary saved records from every source, plus the
// leftovers Stage F deletes - settled suggestions (one accepted and linked to the saved interaction, one
// dismissed, one invalidated, each with a proposed note) and a settled new-contact record. `withState`
// adds one EXPIRED Microsoft sign-in attempt, as Production has.
function seedSql (uid, tag, { withState = false } = {}) {
  const fp = (s) => `encode(sha256(convert_to('${uid}-${s}', 'UTF8')), 'hex')`
  return `
    INSERT INTO public.contacts (user_id, name, company, tags) VALUES
      ('${uid}', 'Ada ${tag}', 'Analytical Engines', ARRAY['synthetic']),
      ('${uid}', 'Grace ${tag}', 'Compilers Inc', NULL);
    INSERT INTO public.interactions (user_id, contact_id, type, interaction_date, notes, source)
      SELECT '${uid}', id, 'Email', current_date - 3, 'synthetic saved note (manual) ${tag}', 'manual' FROM public.contacts WHERE user_id = '${uid}' AND name LIKE 'Ada%';
    INSERT INTO public.interactions (user_id, contact_id, type, interaction_date, notes, source)
      SELECT '${uid}', id, 'Email', current_date - 2, 'synthetic saved note (outlook) ${tag}', 'outlook' FROM public.contacts WHERE user_id = '${uid}' AND name LIKE 'Ada%';
    INSERT INTO public.interactions (user_id, contact_id, type, interaction_date, notes, source, follow_up_date)
      SELECT '${uid}', id, 'Coffee chat', current_date - 1, 'synthetic saved note (calendar) ${tag}', 'google_calendar', current_date + 7 FROM public.contacts WHERE user_id = '${uid}' AND name LIKE 'Grace%';
    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, proposed_notes, status, interaction_id)
      SELECT '${uid}', i.contact_id, 'outlook', ${fp('ol-acc')}, 'Email', i.interaction_date, 'synthetic drafted summary ${tag}', 'accepted', i.id
        FROM public.interactions i WHERE i.user_id = '${uid}' AND i.source = 'outlook';
    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, proposed_notes, status)
      SELECT '${uid}', id, 'google_calendar', ${fp('cal-dis')}, 'Coffee chat', current_date, 'synthetic event title ${tag}', 'dismissed' FROM public.contacts WHERE user_id = '${uid}' AND name LIKE 'Grace%';
    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, proposed_notes, status)
      SELECT '${uid}', id, 'outlook', ${fp('ol-inv')}, 'Email', current_date, 'synthetic drafted summary 2 ${tag}', 'invalidated' FROM public.contacts WHERE user_id = '${uid}' AND name LIKE 'Ada%';
    INSERT INTO public.new_contact_candidates (user_id, status, person_fingerprint, episode_fingerprint)
      VALUES ('${uid}', 'dismissed', ${fp('person')}, ${fp('episode')});
    ${withState ? `INSERT INTO public.microsoft_oauth_states (state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce, return_origin, consented_at, consent_policy_version, expires_at)
      VALUES (${fp('mstate')}, '${uid}', 'c3ludGhldGlj', 'bm9uY2U', 'https://www.getfunnl.com', now() - interval '2 days', 'ol-disc-synthetic', now() - interval '1 day');` : ''}`
}

// md5 over the SORTED md5 of each row's text: equal digests mean the same rows with the same content.
const setDigest = (rowsSql) => `(SELECT md5(coalesce(string_agg(h, ',' ORDER BY h), '')) || ':' || count(*) FROM (SELECT md5(r::text) AS h FROM (${rowsSql}) r) d)`
const kv = (out) => Object.fromEntries(out.trim().split(NL).filter(Boolean).map((l) => { const i = l.indexOf('|'); return [l.slice(0, i), l.slice(i + 1)] }))
const rowCount = (d) => Number(String(d).split(':')[1])
const diffKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k])
const exists = (t) => one(`SELECT to_regclass('public.${t}') IS NOT NULL`) === 't'

// One user's retained records (membership + content).
function retainedUser (uid) {
  const parts = [
    `SELECT 'contacts', ${setDigest(`SELECT * FROM public.contacts WHERE user_id = '${uid}'`)}`,
    `SELECT 'interactions', ${setDigest(`SELECT * FROM public.interactions WHERE user_id = '${uid}'`)}`,
    `SELECT 'profiles', ${setDigest(`SELECT * FROM public.profiles WHERE id = '${uid}'`)}`,
    `SELECT 'pro_trials', ${setDigest(`SELECT * FROM public.pro_trials WHERE user_id = '${uid}'`)}`,
    `SELECT 'auth.users', ${setDigest(`SELECT id, email FROM auth.users WHERE id = '${uid}'`)}`,
  ]
  return kv(psql(parts.join(' UNION ALL ') + ';'))
}
// One user's rows in the integration tables that still exist (all have user_id).
function integrationUser (uid) {
  const present = DROPPED_TABLES.filter((t) => exists(t) && one(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${t}' AND column_name = 'user_id'`) === '1')
  if (!present.length) return {}
  return kv(psql(present.map((t) => `SELECT '${t}', ${setDigest(`SELECT * FROM public.${t} WHERE user_id = '${uid}'`)}`).join(' UNION ALL ') + ';'))
}

// Every RETAINED object, as digests: rows of every non-integration table, auth users, functions other
// than the five dropped (signature, body, grants, settings), triggers, policies, indexes, constraints and
// grants on non-integration relations, column grants, schema grants, cron, Vault.
function retainedState () {
  const tables = one(`SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT IN (${INTEG})`).split(',')
  const notInteg = (col) => `${col} NOT IN (${INTEG})`
  const parts = [
    ...tables.map((t) => `SELECT 'table:${t}', ${setDigest(`SELECT * FROM public.${t}`)}`),
    `SELECT 'auth.users', ${setDigest('SELECT id, email, email_confirmed_at FROM auth.users')}`,
    `SELECT 'functions', ${setDigest(`SELECT p.proname, oidvectortypes(p.proargtypes) AS args, md5(p.prosrc) AS body, p.proacl::text AS acl, p.prosecdef, p.proconfig::text AS cfg FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname NOT IN (${sqlList(DROPPED_FNS)})`)}`,
    `SELECT 'triggers', ${setDigest(`SELECT c.relnamespace::regnamespace::text AS ns, c.relname, t.tgname, t.tgfoid::regproc::text AS fn, t.tgenabled, md5(pg_get_triggerdef(t.oid)) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND ${notInteg('c.relname')}`)}`,
    `SELECT 'policies', ${setDigest(`SELECT schemaname, tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND ${notInteg('tablename')}`)}`,
    `SELECT 'indexes', ${setDigest(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND ${notInteg('tablename')}`)}`,
    `SELECT 'constraints', ${setDigest(`SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) AS def FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND ${notInteg('c.relname')}`)}`,
    `SELECT 'grants', ${setDigest(`SELECT c.relname, c.relkind, c.relacl::text, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p') AND ${notInteg('c.relname')}`)}`,
    `SELECT 'column_grants', ${setDigest(`SELECT c.relname, a.attname, a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND a.attacl IS NOT NULL AND ${notInteg('c.relname')}`)}`,
    `SELECT 'schema', ${setDigest(`SELECT nspname, nspacl::text FROM pg_namespace WHERE nspname = 'public'`)}`,
    `SELECT 'auth_triggers', ${setDigest(`SELECT t.tgname, t.tgfoid::regproc::text, t.tgenabled FROM pg_trigger t WHERE t.tgrelid = 'auth.users'::regclass AND NOT t.tgisinternal`)}`,
    `SELECT 'cron', ${setDigest('SELECT jobid, jobname, schedule, command, active FROM cron.job')}`,
    `SELECT 'vault', ${setDigest('SELECT id, name FROM vault.secrets')}`,
  ]
  return kv(psql(parts.join(' UNION ALL ') + ';'))
}
// Everything, including the integration objects, to prove a failed attempt changed nothing at all.
function fullState () {
  const s = retainedState()
  for (const t of DROPPED_TABLES) s[`integration:${t}`] = exists(t) ? one(`SELECT ${setDigest(`SELECT * FROM public.${t}`)}`) : 'absent'
  s.integration_functions = one(`SELECT ${setDigest(`SELECT p.proname, oidvectortypes(p.proargtypes), md5(p.prosrc), p.proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN (${sqlList(DROPPED_FNS)})`)}`)
  s.integration_catalog = one(`SELECT ${setDigest(`SELECT c.relname, c.relkind, c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND (c.relname IN (${INTEG}) OR c.oid IN (SELECT indexrelid FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid WHERE t.relname IN (${INTEG})))`)}`)
  s.history = one(`SELECT ${setDigest('SELECT version, name FROM supabase_migrations.schema_migrations')}`)
  return s
}
const historyCount = () => Number(one("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261019180000'"))
const tablesLeft = () => DROPPED_TABLES.filter(exists).length
const fnsLeft = () => Number(one(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN (${sqlList(DROPPED_FNS)})`))
const sourceCounts = () => one("SELECT string_agg(source || '=' || n, ',' ORDER BY source) FROM (SELECT source, count(*) n FROM public.interactions GROUP BY source) s")

// OLD: delete-account as deployed (v69) - the best-effort Google cleanup through the shared helper, whose
// result the deployed wrapper ignores, then contacts, then the auth user.
async function deleteAccountOld (admin, uid) {
  const g = await runGoogleLocalCleanup({ admin, userId: uid, resolveToken: async () => null, revoke: async () => { throw new Error('no network in this harness') } })
  const { error: cErr } = await admin.from('contacts').delete().eq('user_id', uid)
  const { error: dErr } = await admin.auth.admin.deleteUser(uid)
  return { googleCleanupError: g.localCleanupError, contactsError: cErr?.message ?? null, deleteError: dErr?.message ?? null }
}
// NEW: delete-account after Stage F - contacts, then the auth user (cascade removes the rest).
async function deleteAccountNew (admin, uid) {
  const { error: cErr } = await admin.from('contacts').delete().eq('user_id', uid)
  const { error: dErr } = await admin.auth.admin.deleteUser(uid)
  return { contactsError: cErr?.message ?? null, deleteError: dErr?.message ?? null }
}
const gone = (uid) => Object.values(retainedUser(uid)).every((v) => rowCount(v) === 0) && Object.values(integrationUser(uid)).every((v) => rowCount(v) === 0)

// One refusal: create the condition, prove the attempt fails on the expected message and changes
// nothing (not even the history), then remove the condition and prove the exact starting state is back.
function refusal (label, setupSql, expect, cleanupSql, S0) {
  psql(setupSql)
  const before = fullState()
  const r = applyStageF()
  check(`${label}: the attempt fails`, !r.ok)
  check(`${label}: ...on the expected refusal`, r.errLine.includes(expect), r.errLine.slice(0, 140))
  const after = fullState()
  check(`${label}: ...and changes nothing (rows, objects, grants, history)`, diffKeys(before, after).length === 0, `changed: ${diffKeys(before, after).join(', ')}`)
  psql(cleanupSql)
  const back = fullState()
  check(`${label}: removing only the synthetic condition restores the exact starting state`, diffKeys(S0, back).length === 0, `changed: ${diffKeys(S0, back).join(', ')}`)
}

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
  check('the Stage F migration is present', migrations.includes(NEW_MIGRATION), String(migrations.length))
  // Later migrations (for example the billing deletion fence) are not part of this proof.
  const before = migrations.filter((f) => f < NEW_MIGRATION)
  for (const m of before) psql(readFileSync(join(ROOT, 'supabase/migrations', m), 'utf8'))
  psql(CLI_HISTORY_SETUP)
  console.log(`  applied ${before.length} migrations (the Stage D state) and the CLI history table`)
  docker(['run', '-d', '--name', REST, '--network', NET, '-p', `${P.rest}:3000`, '-e', `PGRST_DB_URI=postgres://authenticator:${DB_PASSWORD}@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, REST_IMAGE])
  await waitHttp(`http://127.0.0.1:${P.rest}/`, (r) => r.status < 500, 'PostgREST')
  gw = await startGateway()
  const admin = createClient(GW, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

  console.log(NL + '1. Before the migration (the Production shape after Stage D)')
  check('the deletion scope is 19 tables and 5 functions', DROPPED_TABLES.length === 19 && DROPPED_FNS.length === 5, `${DROPPED_TABLES.length}/${DROPPED_FNS.length}`)
  check('every table and function in scope exists', tablesLeft() === 19 && fnsLeft() === 5, `${tablesLeft()}/${fnsLeft()}`)
  check('every retained function exists', RETAINED_FNS.every((f) => one(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${f}'`) === '1'))
  const ids = {}
  for (const tag of ['a', 'b', 'c', 'd', 'e']) {
    const { data, error } = await admin.auth.admin.createUser({ email: `stage-f-${tag}@example.test`, password: randomBytes(12).toString('hex'), email_confirm: true })
    if (error) throw new Error(`createUser ${tag}: ${error.message}`)
    ids[tag] = data.user.id
    psql(seedSql(ids[tag], tag, { withState: tag === 'a' }))
  }
  const counts = () => one(`SELECT (SELECT count(*) FROM public.interaction_candidates) || '/' || (SELECT count(*) FROM public.interaction_candidates WHERE proposed_notes IS NOT NULL) || '/' || (SELECT count(*) FROM public.new_contact_candidates) || '/' || (SELECT count(*) FROM public.microsoft_oauth_states WHERE expires_at <= now())`)
  check('settled suggestions (with proposed notes), settled new-contact records and one expired sign-in state are present', counts() === '15/15/5/1', counts())
  check('every connection/token/sync/reference table is empty, as in Production', DROPPED_TABLES.filter((t) => !['interaction_candidates', 'new_contact_candidates', 'microsoft_oauth_states', 'google_oauth_states'].includes(t)).every((t) => one(`SELECT count(*) FROM public.${t}`) === '0'))
  const delC = await deleteAccountOld(admin, ids.c)
  check('OLD delete-account (deployed) works before the migration: Google cleanup, contacts, auth user', !delC.googleCleanupError && !delC.contactsError && !delC.deleteError, JSON.stringify(delC))
  check('...and leaves none of that user\'s rows anywhere', gone(ids.c))
  const delD = await deleteAccountNew(admin, ids.d)
  check('NEW delete-account works before the migration: contacts, auth user', !delD.contactsError && !delD.deleteError, JSON.stringify(delD))
  check('...and the cascade leaves none of that user\'s rows anywhere, suggestions and sign-in state included', gone(ids.d))
  const S0 = fullState()
  const A0 = retainedUser(ids.a), B0 = retainedUser(ids.b), E0 = retainedUser(ids.e)
  const R0 = retainedState()
  const SRC0 = sourceCounts()
  check('saved interactions carry manual, Outlook and Google Calendar labels', SRC0 === 'google_calendar=3,manual=3,outlook=3', SRC0)

  console.log(NL + '2. Refusals: unexpected or active state stops the migration before it drops anything')
  refusal('a pending suggestion',
    `INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date)
       SELECT user_id, id, 'google_calendar', encode(sha256(convert_to(id::text || '-pending', 'UTF8')), 'hex'), 'Call', current_date FROM public.contacts WHERE user_id = '${ids.b}' LIMIT 1;`,
    'still pending review',
    `DELETE FROM public.interaction_candidates WHERE user_id = '${ids.b}' AND status = 'pending';`, S0)
  refusal('an unexpired sign-in state',
    `INSERT INTO public.microsoft_oauth_states (state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce, return_origin, consented_at, consent_policy_version, expires_at)
       VALUES (encode(sha256(convert_to('${ids.b}-live', 'UTF8')), 'hex'), '${ids.b}', 'c3ludGhldGlj', 'bm9uY2U', 'https://www.getfunnl.com', now(), 'ol-disc-synthetic', now() + interval '10 minutes');`,
    'have not expired',
    `DELETE FROM public.microsoft_oauth_states WHERE user_id = '${ids.b}';`, S0)
  refusal('a connection row',
    `INSERT INTO public.google_connections (user_id, google_sub, google_email, scopes) VALUES ('${ids.b}', 'synthetic-sub-b', 'synthetic.google.b@example.test', ARRAY['openid','email']);`,
    'active integration state',
    `DELETE FROM public.google_connections WHERE user_id = '${ids.b}';`, S0)
  refusal('a scheduled job that touches integration objects',
    // Inactive and once a year, so it cannot fire during the test; the guard matches the command text.
    `SELECT cron.alter_job(cron.schedule('synthetic-integration-job', '0 0 1 1 *', 'SELECT public.expire_pending_outlook_context(10)'), active := false);`,
    'cron job(s) still reference integration objects',
    `SELECT cron.unschedule('synthetic-integration-job');`, S0)
  refusal('an object outside the set that depends on it',
    'CREATE VIEW public._stage_f_synthetic_dependent AS SELECT count(*) AS n FROM public.interaction_candidates;',
    'objects outside the integration set depend on it',
    'DROP VIEW public._stage_f_synthetic_dependent;', S0)

  console.log(NL + '3. Forced failure AFTER the tables are dropped: everything must roll back')
  // A synthetic view calls the LAST function the migration drops. The guards look only at tables, so they
  // pass; all 19 tables and the first four functions are dropped inside the transaction; then DROP FUNCTION
  // without CASCADE refuses (2BP01). A full rollback must restore every table, row and object.
  const last = DROP_FN_LINES[DROP_FN_LINES.length - 1]
  const lastName = DROPPED_FNS[DROPPED_FNS.length - 1]
  const argTypes = last.slice(last.indexOf('(') + 1, last.lastIndexOf(')')).split(', ').filter(Boolean)
  psql(`CREATE VIEW public._stage_f_synthetic_blocker AS SELECT public.${lastName}(${argTypes.map((t) => `NULL::${t}`).join(', ')}) AS r;`)
  const Sblock = fullState()
  const f1 = applyStageF()
  check('the blocked attempt fails', !f1.ok)
  check('...at the last DROP FUNCTION, after every table drop had run', f1.errLine.includes('cannot drop function') && f1.errLine.includes(lastName), f1.errLine.slice(0, 140))
  const S1 = fullState()
  check('...and rolls back EVERYTHING: 19 tables with their rows, functions, triggers, policies, indexes, grants, history', diffKeys(Sblock, S1).length === 0, `changed: ${diffKeys(Sblock, S1).join(', ')}`)
  check('...all 19 tables and 5 functions are still there, and no version was recorded', tablesLeft() === 19 && fnsLeft() === 5 && historyCount() === 0)
  psql('DROP VIEW public._stage_f_synthetic_blocker;')
  check('removing only the synthetic blocker restores the exact starting state', diffKeys(S0, fullState()).length === 0, `changed: ${diffKeys(S0, fullState()).join(', ')}`)

  console.log(NL + '4. Successful application')
  const ok = applyStageF()
  check('the migration and its history row commit', ok.ok, ok.errLine.slice(0, 140))
  check('all 19 integration tables are gone', tablesLeft() === 0, String(tablesLeft()))
  check('all 5 integration functions are gone', fnsLeft() === 0, String(fnsLeft()))
  check('the wake trigger went with its table', one("SELECT count(*) FROM pg_trigger WHERE tgname = 'outlook_sync_state_consume_wake'") === '0')
  check('no index, policy or constraint of an integration table remains', one(`SELECT (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename IN (${INTEG})) + (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN (${INTEG}))`) === '0')
  const R2 = retainedState()
  check('every retained table has the same rows with the same content', Object.keys(R0).filter((k) => k.startsWith('table:')).every((k) => R0[k] === R2[k]), Object.keys(R0).filter((k) => k.startsWith('table:') && R0[k] !== R2[k]).join(', '))
  check('...the retained table set is exactly the seven application tables', Object.keys(R2).filter((k) => k.startsWith('table:')).map((k) => k.slice(6)).sort().join(',') === [...RETAINED_TABLES].sort().join(','), Object.keys(R2).filter((k) => k.startsWith('table:')).join(','))
  check('retained functions, triggers, policies, indexes, constraints, grants, auth triggers, cron and Vault are unchanged', diffKeys(R0, R2).length === 0, `changed: ${diffKeys(R0, R2).join(', ')}`)
  check('saved interactions keep their source labels', sourceCounts() === SRC0, sourceCounts())
  check('...and the source CHECK still allows outlook and google_calendar', /outlook/.test(one("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'interactions_source_check'")) && /google_calendar/.test(one("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'interactions_source_check'")))
  check('exactly one history row records the version', historyCount() === 1)
  check('each user\'s saved records are unchanged (membership and content)', JSON.stringify(retainedUser(ids.a)) === JSON.stringify(A0) && JSON.stringify(retainedUser(ids.b)) === JSON.stringify(B0) && JSON.stringify(retainedUser(ids.e)) === JSON.stringify(E0))

  psql("NOTIFY pgrst, 'reload schema';"); await sleep(2500)
  console.log(NL + '5. After the migration')
  const h = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  const r1 = await fetch(`${GW}/rest/v1/interaction_candidates?select=id&limit=1`, { headers: h })
  check('a dropped table is gone through the API', r1.status === 404, `status ${r1.status}`)
  const r2 = await fetch(`${GW}/rest/v1/rpc/run_google_local_cleanup`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' })
  check('the dropped cleanup RPC is gone through the API', r2.status === 404, `status ${r2.status}`)
  const { data: cs, error: ce } = await admin.from('contacts').select('id').eq('user_id', ids.b)
  check('contacts are still readable through the API', !ce && cs.length === 2, ce?.message)
  const delE = await deleteAccountOld(admin, ids.e)
  check('OLD delete-account (if deployed out of order) still deletes the account: its cleanup step reports an error that the deployed wrapper ignores', delE.googleCleanupError === true && !delE.contactsError && !delE.deleteError, JSON.stringify(delE))
  check('...and leaves none of that user\'s rows anywhere', gone(ids.e))
  const delA = await deleteAccountNew(admin, ids.a)
  check('NEW delete-account works after the migration: contacts, auth user', !delA.contactsError && !delA.deleteError, JSON.stringify(delA))
  check('...and leaves none of that user\'s rows anywhere', gone(ids.a))
  check('the bystander\'s saved records are unchanged throughout (membership and content)', JSON.stringify(retainedUser(ids.b)) === JSON.stringify(B0))
  const { data: nu, error: ne } = await admin.auth.admin.createUser({ email: 'stage-f-new@example.test', password: randomBytes(12).toString('hex'), email_confirm: true })
  check('a new signup still gets its profile and trial rows (retained triggers)', !ne && one(`SELECT (SELECT count(*) FROM public.profiles WHERE id = '${nu.user.id}') || '/' || (SELECT count(*) FROM public.pro_trials WHERE user_id = '${nu.user.id}')`) === '1/1', ne?.message)

  console.log(NL + '6. Re-applying the migration body')
  // `db push` never re-runs a recorded version; this proves the body itself is safe to run again.
  const Sbefore = fullState()
  const again = applyStageF({ withHistory: false })
  check('re-running the body succeeds and still passes its own verification', again.ok, again.errLine.slice(0, 140))
  check('...and changes nothing', diffKeys(Sbefore, fullState()).length === 0, `changed: ${diffKeys(Sbefore, fullState()).join(', ')}`)
}

main()
  .catch((e) => { console.error(e?.stack || e); failed++ })
  .finally(async () => {
    await teardown()
    console.log(`${NL}${passed + failed} checks: ${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  })
