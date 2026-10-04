#!/usr/bin/env node
// HOW LONG DOES LOADING THE RUN CONTEXT ACTUALLY TAKE?
//
// WHY THIS EXISTS. `CONTEXT_WORST_MS` is 285 seconds, which is larger than the whole
// 120-second invocation budget - so on paper the worker can never prepare a run. That
// number is the SUM OF PER-CALL TIMEOUT CEILINGS: 18 bounded database calls at the port's
// 15-second deadline plus a 30-second token-exchange timeout. It is what the lease and
// budget guards must survive, and it says nothing about what the path costs when the
// database answers normally. Deciding whether the loader is an enablement blocker needs
// the measured number, not the ceiling.
//
// WHAT IS MEASURED. The REAL `makeRunContextLoader` from
// supabase/functions/shared/outlookRunContext.js, through the REAL deployed port
// (`makePostgrestPorts` from the worker's endpoints.js - its 15s deadline, its 256 KiB
// response bound, its headers and `redirect: 'error'`), against a real Postgres behind
// real PostgREST, for three account sizes and with an EXPIRED access token so the refresh
// and the rotation RPC are on the path too.
//
// WHAT IT CANNOT MEASURE. Hosted latency. Postgres and PostgREST are containers on this
// machine, so per-call round trips are faster here than from a deployed Edge Function to
// Supabase. What transfers is the SHAPE of the path - how many calls, how many bytes, how
// the cost scales with the contact count - plus the fact that nothing in it is
// accidentally quadratic or unbounded. The report states that limit rather than implying
// the hosted figure was measured.
//
// FIXTURES ARE FIXTURES. The Microsoft token endpoint here is written by this file. No
// request leaves this machine.
//
// REQUIREMENTS: Docker, plus the two images the project already uses.
// RUN: node tests/local/outlook-context-load-budget.mjs   (builds and tears down)

import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID, createHmac, webcrypto } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert'
import { makePostgrestPorts, DB_TIMEOUT_MS } from '../../supabase/functions/outlook-import-worker/endpoints.js'
import {
  makeRunContextLoader, MAX_CONTACTS_LOADED, CONTACT_PAGE_SIZE, CONTEXT_STEP_MS,
} from '../../supabase/functions/shared/outlookRunContext.js'
import {
  CONTEXT_WORST_MS, CONTEXT_DB_CALLS, RPC_ROUND_TRIP_MS,
} from '../../supabase/functions/shared/outlookImportRun.js'
import {
  INVOCATION_BUDGET_MS, PAGE_ADMIT_FLOOR_MS, CHECKPOINT_RESERVE_MS,
} from '../../supabase/functions/shared/outlookContinuedPass.js'
import { TOKEN_TIMEOUT_MS } from '../../supabase/functions/shared/microsoftTokenExchange.js'
import { importKeyFromBase64, encryptToken } from '../../supabase/functions/shared/googleTokenCrypto.js'
import { MAX_PROVIDER_BODY_BYTES } from '../../supabase/functions/shared/boundedJson.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PG = 'funnl-ctx-pg'
const REST = 'funnl-ctx-rest'
const NET = 'funnl-ctx-net'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const PGRST = 'http://127.0.0.1:53993'

const TOKEN_KEY_B64 = Buffer.from(randomBytes(32)).toString('base64')
const CLIENT_SECRET = randomBytes(16).toString('hex')
const FIXTURE_TOKEN_URL = 'https://login.microsoftonline.test/common/oauth2/v2.0/token'
const FINGERPRINT_KEY = { current: { keyBytes: new Uint8Array(32).fill(13), keyVersion: 1 } }

let passed = 0, failed = 0
async function test (name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`) }
  catch (e) { failed += 1; console.log(`  ✗ ${name}`); console.log(`    ${e.message}`) }
}

const docker = (a, o = {}) => execFileSync('docker', a, { encoding: 'utf8', stdio: 'pipe', ...o })
const quiet = (a) => spawnSync('docker', a, { stdio: 'ignore' })

function psql (sql, { user = 'postgres', tuplesOnly = true } = {}) {
  const args = ['exec', '-i', PG, 'psql', '-U', user, '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-q', '-A', '-F', '|']
  if (tuplesOnly) args.push('-t')
  args.push('-f', '-')
  return execFileSync('docker', args, { input: sql, encoding: 'utf8' })
}
const one = (sql) => psql(sql).trim()
const sleepSync = (ms) => spawnSync('node', ['-e', `setTimeout(()=>{},${ms})`], { stdio: 'ignore' })

/**
 * A single successful query is not enough: initdb runs a temporary server, so a probe can
 * succeed and then the real server restarts underneath it - which showed up here as
 * `the database system is shutting down` partway through the bootstrap. Require a streak
 * of successful DDL instead, exactly as the other local harnesses do.
 */
function waitForPg (timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  let streak = 0
  while (Date.now() < deadline) {
    const r = spawnSync('docker',
      ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'],
      { input: 'CREATE TABLE public._probe(i int); DROP TABLE public._probe;', encoding: 'utf8' })
    if (r.status === 0) { streak += 1; if (streak >= 3) return } else { streak = 0 }
    sleepSync(1000)
  }
  throw new Error('Postgres never became stably DDL-ready')
}

let jwtSecret = null
function mintServiceJwt () {
  const seg = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const head = seg({ alg: 'HS256', typ: 'JWT' })
  const body = seg({ role: 'service_role', aud: 'authenticated', iat: now, exp: now + 3600 })
  const sig = createHmac('sha256', jwtSecret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

/**
 * The DEPLOYED port, instrumented.
 *
 * The ONE adaptation is the path: makePostgrestPorts targets Supabase's gateway at
 * /rest/v1/, and a bare PostgREST container serves at /. Everything that matters - the
 * 15s deadline, the 256 KiB response bound, the headers, redirect: 'error' - is the
 * shipping code. Bytes are counted by reading the response twice: once here to size it,
 * once by the port itself, so the port sees exactly what it would in production.
 */
function instrumentedPorts () {
  const calls = []
  const ports = makePostgrestPorts({
    url: PGRST,
    serviceRoleKey: mintServiceJwt(),
    fetchImpl: async (u, init) => {
      const url = String(u).replace('/rest/v1/', '/')
      const started = performance.now()
      const res = await fetch(url, init)
      const body = await res.clone().arrayBuffer()
      calls.push({
        path: url.replace(PGRST + '/', ''),
        ms: performance.now() - started,
        bytes: body.byteLength,
        status: res.status,
      })
      return res
    },
  })
  return { calls, ...ports }
}

/** An expired access token, so the refresh and the rotation RPC are on the measured path. */
function tokenFixture () {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, redirect: init?.redirect })
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        access_token: 'FIXTURE-ACCESS-TOKEN-v2',
        refresh_token: 'FIXTURE-REFRESH-TOKEN-v2',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'Mail.Read User.Read offline_access',
      }),
    }
  }
  return { calls, fetchImpl }
}

/** One account with `contacts` contacts and an EXPIRED access token. */
async function seedAccount (userId, email, contacts) {
  // The bootstrap seeds two fixture users; a third account needs its own auth row, with
  // the values GoTrue would set.
  psql(`INSERT INTO auth.users
      (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
    VALUES ('00000000-0000-0000-0000-000000000000', '${userId}', 'authenticated',
            'authenticated', '${email}', now(), now(), now())
    ON CONFLICT (id) DO NOTHING;`, { user: 'supabase_admin', tuplesOnly: false })
  const key = await importKeyFromBase64(TOKEN_KEY_B64, webcrypto.subtle)
  const acc = await encryptToken('FIXTURE-ACCESS-TOKEN-v1', key, { subtle: webcrypto.subtle })
  const ref = await encryptToken('FIXTURE-REFRESH-TOKEN-v1', key, { subtle: webcrypto.subtle })
  psql(`
DO $seed$
DECLARE k uuid;
BEGIN
  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version, token_expires_at)
  VALUES ('${userId}', 'acct-${userId}', 'consumers', 'personal', '${email}',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(),
          'ol-disc-00000000000000000000000000000000', now() - interval '10 minutes')
  RETURNING id INTO k;
  INSERT INTO public.microsoft_tokens
    (connection_id, user_id, access_token_ciphertext, access_token_nonce,
     refresh_token_ciphertext, refresh_token_nonce, key_version, token_expires_at)
  VALUES (k, '${userId}', '${acc.ciphertext}', '${acc.nonce}',
          '${ref.ciphertext}', '${ref.nonce}', 1, now() - interval '10 minutes');
  -- Realistic addresses: a long local part and a long domain, so the response bytes are
  -- not flattered by short fixtures.
  INSERT INTO public.contacts (user_id, name, email)
  SELECT '${userId}', 'Contact Number ' || i,
         'contact.number.' || i || '.' || '${userId}' || '@a-fairly-long-company-domain.example'
    FROM generate_series(1, ${contacts}) AS i;
END $seed$;`, { tuplesOnly: false })
}

/**
 * Put a live lease on ONE named connection.
 *
 * Not through reserve_due_outlook_connection: that picks whichever connection is due,
 * ordered by last success and then by id, so it kept handing back the first account
 * while this harness measured the third. The reservation is covered by the other local
 * harnesses; what is measured here is the LOADER, which needs a run that owns both
 * folder leases because the token-rotation RPC is fenced on them.
 */
function leaseConnection (conn, userId) {
  const runId = randomUUID()
  psql(`
INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, sync_run_id, sync_lease_until, run_started_at)
SELECT '${conn}', '${userId}', f, 'running', '${runId}', now() + interval '10 minutes', now()
  FROM (VALUES ('inbox'), ('sentitems')) AS t(f)
ON CONFLICT (connection_id, folder) DO UPDATE
   SET sync_status = 'running', sync_run_id = '${runId}',
       sync_lease_until = now() + interval '10 minutes', run_started_at = now();`,
    { tuplesOnly: false })
  return runId
}

function teardown () {
  quiet(['rm', '-f', REST]); quiet(['rm', '-f', PG]); quiet(['network', 'rm', NET])
}

const fmt = (n) => n.toLocaleString('en-US')
const ms = (n) => `${n.toFixed(0)} ms`
const kib = (n) => `${(n / 1024).toFixed(1)} KiB`

async function main () {
  console.log('\nbuilding a disposable Postgres + PostgREST to measure the real loader')
  teardown()
  quiet(['network', 'create', NET])
  docker(['run', '-d', '--name', PG, '--network', NET, '-e', 'POSTGRES_PASSWORD=disposable', PG_IMAGE])
  waitForPg()
  psql(readFileSync(join(ROOT, 'tests/sql/_bootstrap-disposable-db.sql'), 'utf8'),
    { user: 'supabase_admin', tuplesOnly: false })
  const migrations = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
  for (const m of migrations) psql(readFileSync(join(ROOT, 'supabase/migrations', m), 'utf8'), { tuplesOnly: false })
  console.log(`  applied ${migrations.length} migrations`)

  jwtSecret = randomBytes(32).toString('hex')
  psql("ALTER ROLE authenticator WITH PASSWORD 'disposable';", { user: 'supabase_admin', tuplesOnly: false })
  docker(['run', '-d', '--name', REST, '--network', NET, '-p', '53993:3000',
    '-e', `PGRST_DB_URI=postgres://authenticator:disposable@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${jwtSecret}`, REST_IMAGE])
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`${PGRST}/`); if (r.status < 500) break } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400))
  }
  console.log('  PostgREST is serving\n')

  // ── the accounts ──────────────────────────────────────────────────────────
  const ACCOUNTS = [
    { id: '11111111-1111-1111-1111-111111111111', label: 'small', contacts: 25 },
    { id: '22222222-2222-2222-2222-222222222222', label: 'medium', contacts: 1_200 },
    { id: '33333333-3333-3333-3333-333333333333', label: 'supported maximum', contacts: MAX_CONTACTS_LOADED },
  ]
  for (const a of ACCOUNTS) {
    await seedAccount(a.id, `user-${a.label.replace(/\s/g, '-')}@getfunnl.test`, a.contacts)
  }
  console.log('seeded: ' + ACCOUNTS.map((a) => `${a.label} ${fmt(a.contacts)}`).join(', '))

  console.log('\nthe CEILING these measurements are compared against')
  console.log(`  CONTEXT_WORST_MS      ${fmt(CONTEXT_WORST_MS)} ms  = ${CONTEXT_DB_CALLS}` +
    ` bounded calls x ${fmt(RPC_ROUND_TRIP_MS)} ms + ${fmt(TOKEN_TIMEOUT_MS)} ms token timeout`)
  console.log(`  INVOCATION_BUDGET_MS  ${fmt(INVOCATION_BUDGET_MS)} ms`)
  console.log(`  a page needs          ${fmt(PAGE_ADMIT_FLOOR_MS)} ms admission` +
    ` + ${fmt(CHECKPOINT_RESERVE_MS)} ms checkpoint reserve`)
  console.log('  CONTEXT_WORST_MS is the SUM OF TIMEOUT CEILINGS, not a path anyone walks.')

  // ── measure ───────────────────────────────────────────────────────────────
  console.log('\nMEASURED, real loader + real port + real PostgREST (local containers)')
  const results = []
  for (const a of ACCOUNTS) {
    const conn = one(`SELECT id FROM public.microsoft_connections WHERE user_id='${a.id}';`)
    const runId = leaseConnection(conn, a.id)

    const ports = instrumentedPorts()
    const tok = tokenFixture()
    const loader = makeRunContextLoader({
      select: ports.select,
      rpc: ports.rpc,
      config: {
        clientId: 'fixture-client-id',
        clientSecret: CLIENT_SECRET,
        tokenUrl: FIXTURE_TOKEN_URL,
        tokenKeyB64: TOKEN_KEY_B64,
        keyVersion: 1,
        keyRing: FINGERPRINT_KEY,
        scope: 'Mail.Read User.Read offline_access',
      },
      deps: { fetchImpl: tok.fetchImpl, subtle: webcrypto.subtle },
    })

    const started = performance.now()
    const ctx = await loader(conn, runId, {
      deadlineMs: Number.POSITIVE_INFINITY,
      now: () => performance.now(),
    })
    const elapsed = performance.now() - started

    const bytes = ports.calls.reduce((n, c) => n + c.bytes, 0)
    const biggest = ports.calls.reduce((m, c) => Math.max(m, c.bytes), 0)
    const contactReads = ports.calls.filter((c) => c.path.startsWith('contacts')).length
    const remaining = INVOCATION_BUDGET_MS - elapsed
    results.push({
      ...a, conn, runId, elapsed, bytes, biggest, contactReads,
      requests: ports.calls.length, remaining, loaded: ctx.contacts.length,
      refreshed: ctx.refreshed === true, tokenCalls: tok.calls.length, calls: ports.calls,
    })

    psql(`SELECT public.release_outlook_sync_lease('${conn}', '${runId}', 'idle',
      NULL, false, NULL, NULL, NULL, NULL, NULL, false, NULL);`, { tuplesOnly: false })
  }

  console.log('')
  console.log('  account            contacts  requests   contact    total      largest   elapsed   budget left')
  console.log('                                          reads      bytes      response')
  for (const r of results) {
    console.log(
      `  ${r.label.padEnd(18)}${fmt(r.contacts).padStart(8)}` +
      `${String(r.requests).padStart(10)}${String(r.contactReads).padStart(10)}` +
      `${kib(r.bytes).padStart(11)}${kib(r.biggest).padStart(11)}` +
      `${ms(r.elapsed).padStart(10)}${ms(r.remaining).padStart(13)}`)
  }

  // ── the assertions that make the capacity claim checkable ─────────────────
  console.log('\nwhat the measurements have to satisfy')

  for (const r of results) {
    await test(`${r.label}: every contact is loaded, and the token was refreshed and rotated`, () => {
      assert.strictEqual(r.loaded, r.contacts, `loaded ${r.loaded} of ${r.contacts}`)
      assert.strictEqual(r.refreshed, true, 'an expired access token must be refreshed')
      assert.strictEqual(r.tokenCalls, 1, 'exactly one token exchange')
      const rotations = r.calls.filter((c) => c.path.includes('rotate_microsoft_access_token'))
      assert.strictEqual(rotations.length, 1, 'the rotated refresh token must be persisted')
    })

    await test(`${r.label}: the request count is the bounded shape, not a surprise`, () => {
      // MEASURED AND EXPLAINED, because the obvious formula is wrong. The loop stops when a
      // page comes back SHORT, so a contact count that is an exact multiple of the page
      // size costs one extra empty read - there is no other way to know the set ended.
      // 1,200 contacts is 3 full pages plus that empty read, which is 4, not 3.
      const full = Math.floor(r.contacts / CONTACT_PAGE_SIZE)
      const exactMultiple = r.contacts % CONTACT_PAGE_SIZE === 0
      const capped = r.contacts >= MAX_CONTACTS_LOADED
      const expectedContactReads = capped
        // At the supported maximum the loop exits on the count, so no empty read - but it
        // then probes once beyond the limit to tell `exactly full` from `there are more`.
        ? Math.ceil(MAX_CONTACTS_LOADED / CONTACT_PAGE_SIZE) + 1
        : Math.max(exactMultiple ? full + 1 : Math.ceil(r.contacts / CONTACT_PAGE_SIZE), 1)
      assert.strictEqual(r.contactReads, expectedContactReads,
        `contact reads: ${r.contactReads}, expected ${expectedContactReads}`)
      assert.ok(r.requests <= CONTEXT_DB_CALLS,
        `requests (${r.requests}) must not exceed the counted worst case (${CONTEXT_DB_CALLS})`)
    })

    await test(`${r.label}: no response comes near the port's body bound`, () => {
      assert.ok(r.biggest < MAX_PROVIDER_BODY_BYTES / 2,
        `largest response ${kib(r.biggest)} of a ${kib(MAX_PROVIDER_BODY_BYTES)} bound`)
    })

    await test(`${r.label}: the budget still has room for a Graph page AND its checkpoint`, () => {
      const needed = PAGE_ADMIT_FLOOR_MS + CHECKPOINT_RESERVE_MS
      assert.ok(r.remaining > needed,
        `only ${ms(r.remaining)} left, a page plus checkpoint needs ${fmt(needed)} ms`)
      // And comfortably: the load must not be a material share of the budget.
      assert.ok(r.elapsed < INVOCATION_BUDGET_MS / 10,
        `the load took ${ms(r.elapsed)}, over a tenth of the budget`)
    })
  }

  await test('the cost scales with the contact count, and nothing is quadratic', () => {
    const small = results[0]
    const max = results[2]
    // 200x the contacts must not cost anywhere near 200x the time: the read is paged and
    // linear, and the fixed calls dominate at small sizes.
    const ratio = max.elapsed / Math.max(small.elapsed, 0.01)
    assert.ok(ratio < 60, `elapsed grew ${ratio.toFixed(1)}x for 200x the contacts`)
    assert.ok(max.contactReads === Math.ceil(MAX_CONTACTS_LOADED / CONTACT_PAGE_SIZE) + 1,
      'the supported maximum pages the read and probes for overflow exactly once')
  })

  await test('a SLOW database still stops cleanly at a step boundary, not past the budget', async () => {
    // The healthy numbers above say nothing about a degraded database. This is the other
    // half of the claim: when calls are slow, the loader gives up between steps rather
    // than being killed mid-load with the lease held.
    const a = ACCOUNTS[2]
    const conn = one(`SELECT id FROM public.microsoft_connections WHERE user_id='${a.id}';`)
    const runId = leaseConnection(conn, a.id)

    let clock = 0
    const ports = instrumentedPorts()
    const slowSelect = async (path) => { clock += 20_000; return ports.select(path) }
    const loader = makeRunContextLoader({
      select: slowSelect,
      rpc: ports.rpc,
      config: {
        clientId: 'id', clientSecret: CLIENT_SECRET, tokenUrl: FIXTURE_TOKEN_URL,
        tokenKeyB64: TOKEN_KEY_B64, keyVersion: 1, keyRing: FINGERPRINT_KEY,
      },
      deps: { fetchImpl: tokenFixture().fetchImpl, subtle: webcrypto.subtle, now: () => clock },
    })
    let thrown = null
    try {
      await loader(conn, runId, { deadlineMs: INVOCATION_BUDGET_MS, now: () => clock })
    } catch (e) { thrown = e }
    assert.ok(thrown, 'a load that cannot finish must stop')
    assert.strictEqual(thrown.reason, 'context_budget_exhausted')
    const reads = ports.calls.length
    assert.ok(reads <= 6, `it stopped at a page boundary after ${reads} reads`)
    assert.ok(clock < INVOCATION_BUDGET_MS + CONTEXT_STEP_MS,
      `and did not overrun the budget by more than one step: ${fmt(clock)} ms`)
    psql(`SELECT public.release_outlook_sync_lease('${conn}', '${runId}', 'idle',
      NULL, false, NULL, NULL, NULL, NULL, NULL, false, NULL);`, { tuplesOnly: false })
  })

  // ── the verdict, in the numbers ───────────────────────────────────────────
  const max = results[2]
  console.log('\nVERDICT')
  console.log(`  the supported maximum (${fmt(MAX_CONTACTS_LOADED)} contacts) loaded in ` +
    `${ms(max.elapsed)} over ${max.requests} bounded calls and ${kib(max.bytes)},`)
  console.log(`  leaving ${ms(max.remaining)} of the ${fmt(INVOCATION_BUDGET_MS)} ms budget - ` +
    `a page plus checkpoint needs ${fmt(PAGE_ADMIT_FLOOR_MS + CHECKPOINT_RESERVE_MS)} ms.`)
  console.log(`  CONTEXT_WORST_MS (${fmt(CONTEXT_WORST_MS)} ms) is ` +
    `${(CONTEXT_WORST_MS / max.elapsed).toFixed(0)}x the measured cost: it is the sum of`)
  console.log('  per-call timeout CEILINGS, which is what the guards must survive, not a path.')
  console.log(`  NOT MEASURED: hosted latency. Each call here is local; the port allows ` +
    `${fmt(DB_TIMEOUT_MS)} ms per call.`)
  console.log(`  At ${max.requests} calls, the hosted per-call cost that would exhaust the ` +
    `budget is ~${fmt(Math.floor(INVOCATION_BUDGET_MS / max.requests))} ms per call.`)

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`)
}

try {
  await main()
} finally {
  teardown()
}
if (failed > 0) process.exit(1)
