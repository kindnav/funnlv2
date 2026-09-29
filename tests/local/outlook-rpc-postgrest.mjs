#!/usr/bin/env node
// Local verification of the two Outlook user RPCs over REAL HTTP, through REAL
// PostgREST, against a REAL Supabase Postgres image with its REAL roles.
//
// WHY THIS EXISTS
// The SQL runtime tests in tests/sql/ call the RPCs as the privileged `postgres`
// role with `set_config('request.jwt.claim.sub', ...)`. That proves the function
// bodies and the catalog facts, but it does NOT prove the thing the browser
// depends on: that a request carrying a user's JWT is switched to the
// `authenticated` role, that the EXECUTE grant is what admits it, and that the
// same role cannot read `microsoft_connections` directly. Those are the reasons
// migration 20260929000000 exists at all, so they deserve a real test.
//
// WHAT THIS IS, PRECISELY
//   HTTP client -> PostgREST -> Postgres.
// That is the same transport layer the browser uses. It is NOT an end-to-end
// browser test, and nothing here should be described as one.
//
// WHAT IT DELIBERATELY DOES NOT COVER
//   * The browser, supabase-js, and Kong (so the `apikey` gateway check is not
//     exercised; PostgREST is addressed directly).
//   * GoTrue: the JWTs are minted here with a throwaway local secret. No real
//     session, sign-in or refresh is involved.
//   * Production's exact `auth.uid()` body — see PHASE 2 below, which states
//     exactly where that assumption enters and what it is worth without it.
//
// REQUIREMENTS: Docker, and the two images the project already uses
//   public.ecr.aws/supabase/postgres:17.6.1.140
//   public.ecr.aws/supabase/postgrest:v14.14
//
// RUN: node tests/local/outlook-rpc-postgrest.mjs
// It builds a disposable database and a PostgREST container, runs, and tears
// both down. It is NOT part of `npm test`, which must stay dependency-free.

import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PG = 'funnl-verify-pg'
const REST = 'funnl-verify-rest'
const NET = 'funnl-verify-net'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const BASE = 'http://127.0.0.1:53999'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'

// Throwaway, generated per run, never written to disk or printed.
const JWT_SECRET = randomBytes(32).toString('hex')

let passed = 0, failed = 0
async function test (name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

// ── docker / psql plumbing ───────────────────────────────────────────────────

function docker (args, opts = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe', ...opts })
}
function quiet (args) {
  spawnSync('docker', args, { stdio: 'ignore' })
}
/** Runs SQL in the disposable database. Returns stdout. */
function psql (sql, { user = 'postgres', tuplesOnly = true } = {}) {
  const args = ['exec', '-i', PG, 'psql', '-U', user, '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-q']
  if (tuplesOnly) args.push('-At')
  args.push('-f', '-')
  return execFileSync('docker', args, { input: sql, encoding: 'utf8', stdio: 'pipe' })
}
function psqlFile (path, user = 'postgres') {
  return psql(readFileSync(join(ROOT, path), 'utf8'), { user, tuplesOnly: false })
}

function mintJwt (claims) {
  const seg = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const head = seg({ alg: 'HS256', typ: 'JWT' })
  const body = seg({ ...claims, iat: now, exp: now + 3600 })
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

const TOKENS = {
  anon: () => mintJwt({ role: 'anon', aud: 'authenticated' }),
  service: () => mintJwt({ role: 'service_role', aud: 'authenticated' }),
  u1: () => mintJwt({ role: 'authenticated', sub: U1, aud: 'authenticated' }),
  u2: () => mintJwt({ role: 'authenticated', sub: U2, aud: 'authenticated' }),
}

/** One HTTP call. Returns { status, body } with body parsed when it is JSON. */
async function call (method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = text.length ? JSON.parse(text) : null } catch { parsed = text }
  return { status: res.status, body: parsed, raw: text }
}

async function waitForRest (timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/', { method: 'GET' })
      if (r.status < 500) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('PostgREST did not become ready')
}

function sleepSync (ms) {
  spawnSync('node', ['-e', `setTimeout(()=>{},${ms})`], { stdio: 'ignore' })
}

/**
 * Ready means DDL works, repeatedly, not merely that the socket answers.
 *
 * Two things make a naive probe wrong here. The Supabase image RESTARTS Postgres
 * after running its own init scripts, so `pg_isready` succeeds during a
 * short-lived startup that is about to shut down; and pg_graphql's event trigger
 * is provisioned after that, so a migration run too early fails inside the
 * trigger rather than in the migration. So this requires the same trivial
 * CREATE / DROP to succeed three times in a row, a second apart.
 */
function waitForPg (timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  let streak = 0
  let last = 'never attempted'
  while (Date.now() < deadline) {
    const d = spawnSync('docker',
      ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres',
       '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'],
      { input: 'CREATE TABLE public._readiness_probe(i int); DROP TABLE public._readiness_probe;',
        encoding: 'utf8' })
    if (d.status === 0) {
      streak += 1
      if (streak >= 3) return
    } else {
      streak = 0
      last = (d.stderr || '').trim().split(String.fromCharCode(10))[0] || 'refused'
    }
    sleepSync(1000)
  }
  throw new Error(`Postgres never became stably DDL-ready: ${last}`)
}

// ── fixtures, written as the owner role (a worker would use service_role) ────

const SEED = `
DELETE FROM public.microsoft_connections WHERE user_id IN ('${U1}','${U2}');
DELETE FROM public.microsoft_oauth_states WHERE user_id IN ('${U1}','${U2}');
DELETE FROM public.contacts WHERE user_id IN ('${U1}','${U2}');
DO $seed$
DECLARE c1 uuid; c2 uuid; k1 uuid; k2 uuid;
BEGIN
  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version)
  VALUES ('${U1}', 'acct-1', 'consumers', 'personal', 'u1@example.test',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(),
          'ol-disc-00000000000000000000000000000000')
  RETURNING id INTO k1;
  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version)
  VALUES ('${U2}', 'acct-2', 'consumers', 'personal', 'u2@example.test',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(),
          'ol-disc-00000000000000000000000000000000')
  RETURNING id INTO k2;

  INSERT INTO public.microsoft_tokens
    (connection_id, user_id, access_token_ciphertext, access_token_nonce,
     refresh_token_ciphertext, refresh_token_nonce, key_version)
  VALUES (k1, '${U1}', 'CIPHERTEXT-U1', 'NONCE-U1', 'RCIPHER-U1', 'RNONCE-U1', 1),
         (k2, '${U2}', 'CIPHERTEXT-U2', 'NONCE-U2', 'RCIPHER-U2', 'RNONCE-U2', 1);

  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, delta_link_ciphertext, delta_link_nonce, delta_key_version)
  VALUES (k1, '${U1}', 'inbox', 'd1', 'dn1', 1),
         (k1, '${U1}', 'sentitems', 'd2', 'dn2', 1),
         (k2, '${U2}', 'inbox', 'd3', 'dn3', 1);

  INSERT INTO public.microsoft_oauth_states
    (state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce, key_version,
     return_origin, integration_type, consented_at, consent_policy_version, expires_at)
  VALUES (repeat('a',64), '${U1}', 'ct', 'n', 1, 'https://www.getfunnl.com', 'outlook',
          now(), 'v1', now() + interval '10 minutes'),
         (repeat('b',64), '${U2}', 'ct', 'n', 1, 'https://www.getfunnl.com', 'outlook',
          now(), 'v1', now() + interval '10 minutes');

  INSERT INTO public.contacts (user_id, name) VALUES ('${U1}', 'Seed One') RETURNING id INTO c1;
  INSERT INTO public.contacts (user_id, name) VALUES ('${U2}', 'Seed Two') RETURNING id INTO c2;

  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, proposed_notes, status, source_last_state,
     retained_subject, context_expires_at, draft_summary, draft_follow_up,
     summary_evidence, extraction_status)
  VALUES ('${U1}', c1, 'outlook', repeat('e',64), 'Email', current_date,
          'Proposed notes', 'pending', 'active', 'A retained subject',
          now() + interval '7 days', 'A drafted summary', 'A drafted follow up',
          'explicit_body', 'deterministic'),
         ('${U2}', c2, 'outlook', repeat('f',64), 'Email', current_date,
          'Proposed notes', 'pending', 'active', 'A retained subject',
          now() + interval '7 days', 'A drafted summary', 'A drafted follow up',
          'explicit_body', 'deterministic');

  INSERT INTO public.new_contact_candidates
    (user_id, source, status, person_fingerprint, episode_fingerprint, key_version,
     proposed_type, extraction_status, proposed_email, proposed_name,
     proposed_name_evidence, proposed_name_confidence, proposed_interaction_date,
     retained_subject, draft_summary, context_expires_at)
  VALUES ('${U1}', 'outlook', 'pending', repeat('c',64), repeat('d',64), 1,
          'Email', 'deterministic', 'lead1@example.test', 'Lead One',
          'explicit_signature', 'high', current_date, 'A retained subject',
          'A drafted summary', now() + interval '7 days'),
         ('${U2}', 'outlook', 'pending', repeat('7',64), repeat('8',64), 1,
          'Email', 'deterministic', 'lead2@example.test', 'Lead Two',
          'explicit_signature', 'high', current_date, 'A retained subject',
          'A drafted summary', now() + interval '7 days');
END $seed$;
`

// The claims shim discussed in PHASE 2. Applied only to the disposable database.
const CLAIMS_SHIM = `
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$fn$;
`

function teardown () {
  quiet(['rm', '-f', REST])
  quiet(['rm', '-f', PG])
  quiet(['network', 'rm', NET])
}

async function main () {
  console.log('\nbuilding a disposable database and PostgREST')
  teardown()
  quiet(['network', 'create', NET])
  docker(['run', '-d', '--name', PG, '--network', NET,
    '-e', 'POSTGRES_PASSWORD=disposable', PG_IMAGE])
  waitForPg()
  psqlFile('tests/sql/_bootstrap-disposable-db.sql', 'supabase_admin')
  const migrations = execFileSync('node', ['-e',
    "const {readdirSync}=require('fs');process.stdout.write(readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort().join('\\n'))"],
    { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  for (const m of migrations) psqlFile(`supabase/migrations/${m}`)
  console.log(`  applied ${migrations.length} migrations, none skipped`)

  // PostgREST connects as `authenticator` and switches role per request, exactly
  // as it does in a Supabase project.
  psql("ALTER ROLE authenticator WITH PASSWORD 'disposable';", { user: 'supabase_admin', tuplesOnly: false })
  docker(['run', '-d', '--name', REST, '--network', NET, '-p', '53999:3000',
    '-e', `PGRST_DB_URI=postgres://authenticator:disposable@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`,
    REST_IMAGE])
  await waitForRest()
  console.log('  PostgREST is serving\n')

  // ══ PHASE 1 ═══════════════════════════════════════════════════════════════
  // The image's auth.uid() is UNMODIFIED here. It reads
  // `request.jwt.claim.sub`, a GUC PostgREST removed in v12, so caller identity
  // does not resolve in this phase and every authenticated call answers
  // 'unauthorized'. That does not weaken what this phase proves, because what it
  // proves is the ACCESS SHAPE rather than the identity: which roles PostgREST
  // will let reach each function, and what the `authenticated` role can and
  // cannot read directly. Those are enforced by grants, not by claims.
  console.log('PHASE 1 — grants and table access, with auth.uid() unmodified')

  await test('anon cannot execute the status RPC (401, 42501)', async () => {
    const r = await call('POST', '/rpc/get_my_outlook_connection', { token: TOKENS.anon(), body: {} })
    assert.strictEqual(r.status, 401)
    assert.strictEqual(r.body.code, '42501')
  })

  await test('anon cannot execute the disconnect RPC (401, 42501)', async () => {
    const r = await call('POST', '/rpc/disconnect_my_outlook', { token: TOKENS.anon(), body: {} })
    assert.strictEqual(r.status, 401)
    assert.strictEqual(r.body.code, '42501')
  })

  await test('a request with NO token is treated as anon and refused', async () => {
    for (const fn of ['get_my_outlook_connection', 'disconnect_my_outlook']) {
      const r = await call('POST', `/rpc/${fn}`, { body: {} })
      assert.strictEqual(r.status, 401, fn)
      assert.strictEqual(r.body.code, '42501', fn)
    }
  })

  await test('service_role cannot execute either RPC — the 20260922175616 rule holds over HTTP', async () => {
    for (const fn of ['get_my_outlook_connection', 'disconnect_my_outlook']) {
      const r = await call('POST', `/rpc/${fn}`, { token: TOKENS.service(), body: {} })
      assert.strictEqual(r.body.code, '42501', `${fn} -> ${r.raw.slice(0, 120)}`)
    }
  })

  await test('authenticated CAN execute both RPCs — the grant is what admits it', async () => {
    for (const fn of ['get_my_outlook_connection', 'disconnect_my_outlook']) {
      const r = await call('POST', `/rpc/${fn}`, { token: TOKENS.u1(), body: {} })
      assert.strictEqual(r.status, 200, `${fn} -> ${r.status} ${r.raw.slice(0, 120)}`)
    }
  })

  await test('authenticated CANNOT read microsoft_connections directly (403, 42501)', async () => {
    // This is the exact denial that makes migration 20260929000000 necessary:
    // the table has RLS and an owner SELECT policy, but no grant for this role.
    const r = await call('GET', '/microsoft_connections?select=*', { token: TOKENS.u1() })
    assert.strictEqual(r.status, 403)
    assert.strictEqual(r.body.code, '42501')
    assert.ok(/permission denied for table microsoft_connections/.test(r.body.message))
  })

  await test('authenticated cannot read the token or sync tables either', async () => {
    for (const t of ['microsoft_tokens', 'outlook_sync_state', 'microsoft_oauth_states']) {
      const r = await call('GET', `/${t}?select=*`, { token: TOKENS.u1() })
      assert.strictEqual(r.body?.code, '42501', `${t} -> ${r.status} ${r.raw.slice(0, 120)}`)
    }
  })

  await test('neither RPC accepts an argument, so no caller can name another user', async () => {
    for (const fn of ['get_my_outlook_connection', 'disconnect_my_outlook']) {
      const r = await call('POST', `/rpc/${fn}`, { token: TOKENS.u1(), body: { p_user_id: U2 } })
      // PostgREST resolves overloads by argument name: a zero-argument function
      // cannot match a body carrying one, so this is a 404, not a 200.
      assert.strictEqual(r.status, 404, `${fn} -> ${r.status} ${r.raw.slice(0, 160)}`)
    }
  })

  // ══ PHASE 2 ═══════════════════════════════════════════════════════════════
  // Caller identity, which needs the JWT claim to reach auth.uid().
  //
  // THE ASSUMPTION, STATED: the shim below redefines auth.uid() to read EITHER
  // `request.jwt.claim.sub` (what this image ships) OR `request.jwt.claims ->>
  // 'sub'` (what PostgREST v14 actually sets). A current Supabase project is
  // understood to use the same two-source form, but Production's exact function
  // body was NOT read to confirm that - doing so needs Production access, which
  // is out of scope. So PHASE 2 proves the RPC logic and isolation end to end
  // over HTTP GIVEN that the claim reaches auth.uid(); it does not prove that
  // Supabase's own claim plumbing does so. PHASE 1 needs no such assumption.
  console.log('\nPHASE 2 — caller identity and isolation, with the claims shim applied')
  psql(CLAIMS_SHIM, { user: 'supabase_admin', tuplesOnly: false })

  await test('a signed-in user with no connection gets not_connected', async () => {
    const r = await call('POST', '/rpc/get_my_outlook_connection', { token: TOKENS.u1(), body: {} })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.result, 'not_connected')
  })

  psql(SEED, { tuplesOnly: false })

  await test('each user sees only their OWN mailbox, decided by the JWT', async () => {
    const a = await call('POST', '/rpc/get_my_outlook_connection', { token: TOKENS.u1(), body: {} })
    const b = await call('POST', '/rpc/get_my_outlook_connection', { token: TOKENS.u2(), body: {} })
    assert.strictEqual(a.body.mailbox, 'u1@example.test')
    assert.strictEqual(b.body.mailbox, 'u2@example.test')
    assert.strictEqual(a.body.result, 'connected')
  })

  await test('the status response carries no ciphertext, nonce or identifier', async () => {
    const r = await call('POST', '/rpc/get_my_outlook_connection', { token: TOKENS.u1(), body: {} })
    for (const leak of ['CIPHERTEXT-U1', 'NONCE-U1', 'RCIPHER-U1', 'acct-1', 'consumers']) {
      assert.ok(!r.raw.includes(leak), `the response leaked ${leak}`)
    }
    const keys = Object.keys(r.body).sort()
    assert.deepStrictEqual(keys, ['account_type', 'connected_at', 'consent_policy_version',
      'mailbox', 'needs_reauth', 'result', 'scopes', 'status'])
  })

  await test('disconnect over HTTP removes exactly what it claims, for that user only', async () => {
    const r = await call('POST', '/rpc/disconnect_my_outlook', { token: TOKENS.u1(), body: {} })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.result, 'disconnected')

    const counts = psql(`
      SELECT
        (SELECT count(*) FROM public.microsoft_connections  WHERE user_id='${U1}'),
        (SELECT count(*) FROM public.microsoft_tokens       WHERE user_id='${U1}'),
        (SELECT count(*) FROM public.outlook_sync_state     WHERE user_id='${U1}'),
        (SELECT count(*) FROM public.microsoft_oauth_states WHERE user_id='${U1}'),
        (SELECT count(*) FROM public.outlook_candidate_refs WHERE user_id='${U1}'),
        (SELECT count(*) FROM public.contacts               WHERE user_id='${U1}'),
        (SELECT count(*) FROM public.microsoft_connections  WHERE user_id='${U2}'),
        (SELECT count(*) FROM public.microsoft_tokens       WHERE user_id='${U2}');
    `).trim().split('|').map(Number)
    assert.deepStrictEqual(counts, [0, 0, 0, 0, 0, 1, 1, 1],
      `deleted/kept counts were ${counts.join(',')}`)
  })

  await test('the pending suggestions are EMPTIED, not deleted, and only for that user', async () => {
    const row = psql(`
      SELECT
        (SELECT count(*) FROM public.new_contact_candidates WHERE user_id='${U1}'),
        (SELECT status FROM public.new_contact_candidates WHERE user_id='${U1}'),
        (SELECT coalesce(proposed_email,'NULL') FROM public.new_contact_candidates WHERE user_id='${U1}'),
        (SELECT coalesce(draft_summary,'NULL') FROM public.interaction_candidates WHERE user_id='${U1}'),
        (SELECT status FROM public.interaction_candidates WHERE user_id='${U1}'),
        (SELECT status FROM public.new_contact_candidates WHERE user_id='${U2}'),
        (SELECT coalesce(proposed_email,'NULL') FROM public.new_contact_candidates WHERE user_id='${U2}');
    `).trim().split('|')
    assert.deepStrictEqual(row, ['1', 'invalidated', 'NULL', 'NULL', 'invalidated',
      'pending', 'lead2@example.test'], `got ${row.join(' | ')}`)
  })

  await test('the other user is still connected, over HTTP, after that disconnect', async () => {
    const r = await call('POST', '/rpc/get_my_outlook_connection', { token: TOKENS.u2(), body: {} })
    assert.strictEqual(r.body.result, 'connected')
    assert.strictEqual(r.body.mailbox, 'u2@example.test')
  })

  await test('the disconnected user now reads not_connected, and a second disconnect is a no-op', async () => {
    const s = await call('POST', '/rpc/get_my_outlook_connection', { token: TOKENS.u1(), body: {} })
    assert.strictEqual(s.body.result, 'not_connected')
    const d = await call('POST', '/rpc/disconnect_my_outlook', { token: TOKENS.u1(), body: {} })
    assert.strictEqual(d.body.result, 'not_connected')
  })

  await test('one user cannot disconnect another, because identity comes from the JWT', async () => {
    // u2 is still connected. u1 retries with every shape a caller could try.
    for (const body of [{}, { p_user_id: U2 }, { user_id: U2 }, { sub: U2 }]) {
      await call('POST', '/rpc/disconnect_my_outlook', { token: TOKENS.u1(), body })
    }
    const left = psql(`SELECT count(*) FROM public.microsoft_connections WHERE user_id='${U2}';`).trim()
    assert.strictEqual(left, '1', "another user's connection was removed")
  })
}

try {
  await main()
} catch (e) {
  console.error(`\nHARNESS ERROR: ${e.message}`)
  failed++
} finally {
  teardown()
}
console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
