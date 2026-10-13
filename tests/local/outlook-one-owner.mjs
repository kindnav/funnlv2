// ONE FUNNL OWNER PER MICROSOFT ACCOUNT: the defect reproduced, then fixed, in one pass.
//
// Before 20261014000000, `finalize_microsoft_connection` compared the incoming Microsoft
// identity only with the CALLER'S OWN connection, and `microsoft_connections` was unique on
// `user_id` alone. A second Funnl user could therefore connect a Microsoft account another
// Funnl user already had connected.
//
// This file runs every migration EXCEPT the fix and measures that on the REAL function over
// real PostgREST. Then it drives the REAL subscription module (`maintainSubscription`)
// through the REAL `record_outlook_subscription_state` and `record_outlook_change_notification`
// RPCs. Microsoft Graph is a FIXTURE: an in-process model of the documented subscription
// semantics - one subscription per (Microsoft user, app, resource, changeType), a 409 on a
// duplicate, list/delete/renew scoped to the signed-in Microsoft user. NO request reaches
// Microsoft. Then the fix is applied and every property below is proven.
//
// IDENTITY IS TESTED ON THE PROVIDER FIELDS. Each case varies `ms_tenant_id` / `ms_account_id`
// (the id_token `tid` / `oid`) independently of the mailbox address text: same identity with
// different address text is the SAME account; same address text with a different identity is
// a DIFFERENT account.
//
// WHAT IT PROVES
//   0. The disposable finalize is the function Production runs (md5 of prosrc, read-only).
//   1. BEFORE: two Funnl users hold one Microsoft identity; the second connection's
//      subscription setup deletes the first's Graph subscription; notifications then reach
//      only the second; the first's renewal deletes the second's in turn.
//   2. The fix refuses to apply while such a duplicate exists, and changes nothing.
//   3. AFTER: a second user is refused with `account_in_use`, nothing is written, the state is
//      not consumed and the existing connection is byte-identical; case variants are the same
//      identity; a different identity with the same address text is allowed; a same-user,
//      same-account update still succeeds on the same row; a different account for the same
//      user is still `different_account`; a concurrent race yields exactly one owner and the
//      loser gets `account_in_use` (blocking + commit, blocking + rollback, and a burst);
//      a refused user has no connection, so no run can be reserved and no subscription
//      request is made; disconnecting releases the account for another user.
//
// NOT part of `npm test`: it needs Docker. Teardown is unconditional.
// RUN: node tests/local/outlook-one-owner.mjs

import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { randomBytes, createHmac, createHash, webcrypto } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert'
import {
  maintainSubscription, hashClientState, SUBSCRIPTION_RENEW_BEFORE_MS,
} from '../../supabase/functions/shared/outlookSubscriptions.js'
import { GRAPH_BASE } from '../../supabase/functions/shared/outlookGraphTransport.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PG = 'funnl-oneowner-pg'
const REST = 'funnl-oneowner-rest'
const NET = 'funnl-oneowner-net'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const PORT = 53997
const BASE = `http://127.0.0.1:${PORT}`
const JWT_SECRET = randomBytes(32).toString('hex')

const FIX_MIGRATION = '20261014000000_outlook_one_owner_per_microsoft_account.sql'
// Read-only from Production on 2026-10-13: md5(prosrc) of the one finalize overload.
const PROD_FINALIZE_PROSRC_MD5 = 'e5809302c1b467858573dd8ba9398270'

const CONSUMERS = '9188040d-6c67-4c5b-b112-36a304b66dad'
const WORK_TENANT = '11111111-2222-4333-8444-555555555555'
const CONSENT = `ol-disc-${'a'.repeat(32)}`
const CONSENT_NEXT = `ol-disc-${'b'.repeat(32)}`
const SCOPES = ['openid', 'profile', 'email', 'offline_access',
  'https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/User.Read']
const NOTIFY_URL = 'https://fixture.funnl.test/api/outlook-notifications'

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const oidOf = (n) => `00000000-0000-0000-${String(n).padStart(4, '0')}-${String(n).padStart(12, '0')}`
const A = uid(1); const B = uid(2); const C = uid(3)
const D = uid(4); const E = uid(5); const F = uid(6); const G = uid(7)
const BURST = Array.from({ length: 10 }, (_, k) => uid(100 + k))
const OID_X = oidOf(1); const OID_Y = oidOf(2); const OID_Z = oidOf(3)
const OID_W = oidOf(4); const OID_V = oidOf(5); const OID_OTHER = oidOf(9)

let passed = 0
let failed = 0
async function test (name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); passed += 1 }
  catch (e) { console.error(`  FAIL ${name}\n       ${e && e.message}`); failed += 1 }
}

// ── docker plumbing ──────────────────────────────────────────────────────────
const docker = (a, o = {}) => execFileSync('docker', a, { encoding: 'utf8', stdio: 'pipe', ...o })
const quiet = (a) => spawnSync('docker', a, { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function psql (sql, { user = 'postgres', tuplesOnly = true } = {}) {
  const args = ['exec', '-i', PG, 'psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q']
  if (tuplesOnly) args.push('-At')
  args.push('-f', '-')
  return execFileSync('docker', args, { input: sql, encoding: 'utf8', stdio: 'pipe' })
}
const psqlFile = (p, user = 'postgres') =>
  psql(readFileSync(join(ROOT, p), 'utf8'), { user, tuplesOnly: false })
const one = (sql) => psql(sql).trim()

function alignAuthUidWithProduction () {
  psql(`
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$f$;`, { user: 'supabase_admin', tuplesOnly: false })
}

function waitForPg (timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  let streak = 0
  while (Date.now() < deadline) {
    const d = spawnSync('docker',
      ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'],
      { input: 'CREATE TABLE public._probe(i int); DROP TABLE public._probe;', encoding: 'utf8' })
    if (d.status === 0) { streak += 1; if (streak >= 3) return } else streak = 0
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)'])
  }
  throw new Error('postgres never became ready')
}

async function waitForRest (timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/`, { headers: { Accept: 'application/json' } })
      if (r.status < 500) return
    } catch { /* not up yet */ }
    await sleep(1000)
  }
  throw new Error('PostgREST never became ready')
}

function teardown () {
  quiet(['rm', '-f', REST]); quiet(['rm', '-f', PG]); quiet(['network', 'rm', NET])
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function mintJwt (claims) {
  const seg = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const head = seg({ alg: 'HS256', typ: 'JWT' })
  const body = seg({ ...claims, iat: now, exp: now + 3600 })
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}
const workerToken = () => mintJwt({ role: 'service_role', aud: 'authenticated' })
const userToken = (sub) => mintJwt({ role: 'authenticated', aud: 'authenticated', sub })

async function http (method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (token) { headers.Authorization = `Bearer ${token}`; headers.apikey = token }
  const r = await fetch(`${BASE}${path}`,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const raw = await r.text()
  let parsed = null
  try { parsed = raw.length ? JSON.parse(raw) : null } catch { parsed = null }
  return { status: r.status, body: parsed, raw }
}

// ── the connect flow's database half ─────────────────────────────────────────
function addUser (id) {
  psql(`INSERT INTO auth.users (id, email, email_confirmed_at, created_at, updated_at)
        VALUES ('${id}', 'u-${id.slice(-4)}@funnl.test', now(), now(), now())
        ON CONFLICT (id) DO NOTHING;`, { tuplesOnly: false })
}

/** A fresh consented, unconsumed OAuth state for `userId`, exactly as outlook-oauth-start writes it. */
function mintState (userId, version = CONSENT) {
  const hash = createHash('sha256').update(randomBytes(32)).digest('hex')
  psql(`INSERT INTO public.microsoft_oauth_states
          (state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce, key_version,
           return_origin, integration_type, consented_at, consent_policy_version, expires_at)
        VALUES ('${hash}', '${userId}', 'ct', 'nonce', 1, 'https://www.getfunnl.com', 'outlook',
                now(), '${version}', now() + interval '10 minutes');`, { tuplesOnly: false })
  return hash
}

const finalizeArgs = (userId, stateHash, id) => ({
  p_state_hash: stateHash,
  p_expected_user_id: userId,
  p_ms_account_id: id.oid,
  p_ms_tenant_id: id.tid,
  p_account_type: id.tid.toLowerCase() === CONSUMERS ? 'personal' : 'work',
  p_ms_email: id.email,
  p_scopes: SCOPES,
  p_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  p_access_ct: `access-${id.tag ?? 'x'}`,
  p_access_nonce: 'an',
  p_refresh_ct: `refresh-${id.tag ?? 'x'}`,
  p_refresh_nonce: 'rn',
  p_key_version: 1,
})

/** One call to the REAL finalize RPC, as outlook-oauth-callback makes it. */
async function finalize (userId, id, { version } = {}) {
  const state = mintState(userId, version)
  const r = await http('POST', '/rpc/finalize_microsoft_connection',
    { token: workerToken(), body: finalizeArgs(userId, state, id) })
  return { status: r.status, result: r.body?.result ?? null, connectionId: r.body?.connection_id ?? null, state, raw: r.raw }
}

/** The same call as SQL, for a psql session that must hold its transaction open. */
function finalizeSql (userId, stateHash, id) {
  const a = finalizeArgs(userId, stateHash, id)
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`
  return `SELECT public.finalize_microsoft_connection(${q(a.p_state_hash)}, ${q(a.p_expected_user_id)}::uuid,
    ${q(a.p_ms_account_id)}, ${q(a.p_ms_tenant_id)}, ${q(a.p_account_type)}, ${q(a.p_ms_email)},
    ARRAY[${a.p_scopes.map(q).join(',')}]::text[], ${q(a.p_token_expires_at)}::timestamptz,
    ${q(a.p_access_ct)}, ${q(a.p_access_nonce)}, ${q(a.p_refresh_ct)}, ${q(a.p_refresh_nonce)}, 1::smallint)->>'result';`
}

const connectionsFor = (userId) => Number(one(`SELECT count(*) FROM public.microsoft_connections WHERE user_id='${userId}';`))
const holdersOf = (tid, oid) => Number(one(`SELECT count(*) FROM public.microsoft_connections
  WHERE lower(coalesce(ms_tenant_id,''))=lower('${tid}') AND lower(ms_account_id)=lower('${oid}');`))
const stateConsumed = (hash) => one(`SELECT (consumed_at IS NOT NULL)::text FROM public.microsoft_oauth_states WHERE state_hash='${hash}';`)
/** Every stored column of a user's connection and tokens, as one digest. */
const rowDigest = (userId) => one(`SELECT md5(coalesce((SELECT row(c.*)::text FROM public.microsoft_connections c WHERE c.user_id='${userId}'),'none')
  || '|' || coalesce((SELECT row(t.*)::text FROM public.microsoft_tokens t WHERE t.user_id='${userId}'),'none'));`)

// ── the worker's lease, which every subscription write is fenced on ──────────
function syncRows (connId, userId) {
  psql(`INSERT INTO public.outlook_sync_state (connection_id, user_id, folder, sync_status, initial_import_done, last_run_complete)
        VALUES ('${connId}','${userId}','inbox','idle',true,true), ('${connId}','${userId}','sentitems','idle',true,true)
        ON CONFLICT DO NOTHING;`, { tuplesOnly: false })
}
function lease (connId, runId) {
  psql(`UPDATE public.outlook_sync_state SET sync_status='running', sync_run_id='${runId}',
          sync_lease_until = now() + interval '5 minutes' WHERE connection_id='${connId}';`, { tuplesOnly: false })
}
function release (connId) {
  psql(`UPDATE public.outlook_sync_state SET sync_status='idle', sync_run_id=NULL, sync_lease_until=NULL
         WHERE connection_id='${connId}';`, { tuplesOnly: false })
}
const subRow = (connId) => {
  const r = one(`SELECT coalesce(subscription_id,'null')||'|'||status||'|'||coalesce(client_state_hash,'null')
                   FROM public.outlook_subscriptions WHERE connection_id='${connId}';`)
  if (!r) return null
  const [subscriptionId, status, hash] = r.split('|')
  return { subscriptionId, status, hash }
}
const wakeCount = (connId) => Number(one(`SELECT wake_count FROM public.microsoft_connections WHERE id='${connId}';`))

// ── Microsoft Graph subscriptions: an in-process FIXTURE of the documented semantics ──
// One subscription per (Microsoft user, app, resource, changeType); a duplicate create is
// 409; list, renew and delete see only the signed-in Microsoft user's subscriptions. The
// bearer token decides the Microsoft user - two Funnl connections on one Microsoft account
// hold two tokens for the SAME Microsoft user.
function graphFixture () {
  const tokenUser = new Map()
  const subs = new Map()
  const calls = []
  let next = 1
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } })
  async function fetchImpl (url, init) {
    const token = String(init?.headers?.Authorization ?? '').replace(/^Bearer /, '')
    const user = tokenUser.get(token)
    const method = init?.method ?? 'GET'
    const base = `${GRAPH_BASE}/subscriptions`
    assert.ok(url.startsWith(base), `unexpected Graph URL ${url}`)
    const id = decodeURIComponent(url.slice(base.length).replace(/^\//, ''))
    calls.push({ method, id: id || null, token })
    if (!user) return json(401, { error: { code: 'InvalidAuthenticationToken' } })
    if (method === 'POST') {
      const b = JSON.parse(init.body)
      for (const s of subs.values()) {
        if (s.user === user && s.resource === b.resource && s.changeType === b.changeType) {
          return json(409, { error: { code: 'Conflict' } })
        }
      }
      const sid = `sub-${next++}`
      subs.set(sid, { id: sid, user, resource: b.resource, changeType: b.changeType,
        notificationUrl: b.notificationUrl, clientState: b.clientState, expirationDateTime: b.expirationDateTime })
      return json(201, { id: sid, resource: b.resource, changeType: b.changeType,
        notificationUrl: b.notificationUrl, expirationDateTime: b.expirationDateTime })
    }
    if (method === 'GET') {
      return json(200, { value: [...subs.values()].filter((s) => s.user === user).map((s) => ({
        id: s.id, resource: s.resource, changeType: s.changeType,
        notificationUrl: s.notificationUrl, expirationDateTime: s.expirationDateTime })) })
    }
    const s = subs.get(id)
    if (!s || s.user !== user) return json(404, { error: { code: 'ResourceNotFound' } })
    if (method === 'DELETE') { subs.delete(id); return new Response(null, { status: 204 }) }
    if (method === 'PATCH') {
      s.expirationDateTime = JSON.parse(init.body).expirationDateTime
      return json(200, { id: s.id, expirationDateTime: s.expirationDateTime })
    }
    return json(405, {})
  }
  return { fetchImpl, tokenUser, subs, calls }
}

/** One subscription step exactly as the worker runs it: real module, real fenced RPC. */
async function subscriptionStep (fx, { connId, userId, token, now }) {
  const run = `20000000-0000-4000-8000-${randomBytes(6).toString('hex')}`
  lease(connId, run)
  try {
    const r = await http('GET', `/outlook_subscriptions?connection_id=eq.${connId}&select=subscription_id,status,expires_at,client_state_hash`,
      { token: workerToken() })
    const row = Array.isArray(r.body) && r.body[0] ? r.body[0] : null
    return await maintainSubscription({
      row, accessToken: token, deps: { fetchImpl: fx.fetchImpl }, notificationUrl: NOTIFY_URL,
      now: now ?? Date.now, subtle: webcrypto.subtle,
      persist: async (state) => {
        const saved = await http('POST', '/rpc/record_outlook_subscription_state', {
          token: workerToken(),
          body: {
            p_connection_id: connId, p_run_id: run, p_status: state.status,
            p_subscription_id: state.subscriptionId ?? null, p_resource: state.resource ?? null,
            p_change_type: state.changeType ?? null, p_client_state_hash: state.clientStateHash ?? null,
            p_expires_at: state.expiresAt ?? null, p_error_code: state.errorCode ?? null,
          },
        })
        return saved.body?.result === 'recorded'
      },
    })
  } finally { release(connId) }
}

/** Microsoft delivering a change notification for a LIVE subscription, through the real RPC. */
async function deliverNotification (fx, subscriptionId) {
  const s = fx.subs.get(subscriptionId)
  assert.ok(s, `Microsoft has no subscription ${subscriptionId} to notify for`)
  const r = await http('POST', '/rpc/record_outlook_change_notification', {
    token: workerToken(),
    body: { p_subscription_id: subscriptionId, p_client_state_hash: await hashClientState(s.clientState, webcrypto.subtle), p_kind: 'change' },
  })
  return r.body?.result ?? null
}

// ═════════════════════════════════════════════════════════════════════════════
let harnessError = null
try {
  console.log('\nbuilding a disposable database and PostgREST')
  teardown()
  quiet(['network', 'create', NET])
  docker(['run', '-d', '--name', PG, '--network', NET, '-e', 'POSTGRES_PASSWORD=disposable', PG_IMAGE])
  waitForPg()
  psqlFile('tests/sql/_bootstrap-disposable-db.sql', 'supabase_admin')
  alignAuthUidWithProduction()
  const all = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
  assert.ok(all.includes(FIX_MIGRATION), 'the fix migration must exist')
  const before = all.filter((f) => f !== FIX_MIGRATION)
  for (const m of before) psqlFile(`supabase/migrations/${m}`)
  console.log(`  applied ${before.length} migrations, DEFERRING ${FIX_MIGRATION}`)
  psql("ALTER ROLE authenticator WITH PASSWORD 'disposable';", { user: 'supabase_admin', tuplesOnly: false })
  docker(['run', '-d', '--name', REST, '--network', NET, '-p', `${PORT}:3000`,
    '-e', `PGRST_DB_URI=postgres://authenticator:disposable@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, REST_IMAGE])
  await waitForRest()
  console.log('  PostgREST is serving\n')
  for (const u of [A, B, C, D, E, F, G, ...BURST]) addUser(u)

  // ══ 0. parity ══════════════════════════════════════════════════════════════
  console.log('0. the function under test is the one Production runs')
  await test('md5(prosrc) of the unfixed finalize equals Production\'s (read-only digest)', () => {
    const local = one(`SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public' AND p.proname='finalize_microsoft_connection';`)
    assert.strictEqual(local, PROD_FINALIZE_PROSRC_MD5)
  })

  // ══ 1. the defect ══════════════════════════════════════════════════════════
  console.log('\n1. BEFORE the fix: one Microsoft account, two Funnl owners')
  const X = { tid: CONSUMERS, oid: OID_X, email: 'owner@outlook.test', tag: 'a' }
  let connA = null; let connB = null
  await test('user A connects Microsoft account X', async () => {
    const r = await finalize(A, X)
    assert.strictEqual(r.result, 'stored', r.raw)
    connA = r.connectionId
  })
  await test('DEFECT: user B connects the SAME identity (tid+oid) with different address text, and it is stored', async () => {
    const r = await finalize(B, { ...X, email: 'alias-of-owner@outlook.test', tag: 'b' })
    assert.strictEqual(r.result, 'stored', r.raw)
    connB = r.connectionId
    assert.strictEqual(holdersOf(X.tid, X.oid), 2, 'two Funnl users now hold one Microsoft account')
    assert.notStrictEqual(connA, connB)
  })

  const fx = graphFixture()
  fx.tokenUser.set('token-A', 'graph-user-X')
  fx.tokenUser.set('token-B', 'graph-user-X')   // the same Microsoft user: that is the defect
  syncRows(connA, A); syncRows(connB, B)
  let subA1 = null; let subB1 = null
  await test('A\'s run creates A\'s subscription', async () => {
    const r = await subscriptionStep(fx, { connId: connA, userId: A, token: 'token-A' })
    assert.strictEqual(r.outcome, 'created', JSON.stringify(r))
    subA1 = subRow(connA).subscriptionId
    assert.ok(fx.subs.has(subA1))
  })
  await test('INTERFERENCE: B\'s run gets 409, lists, DELETES A\'s subscription and creates its own', async () => {
    const mark = fx.calls.length
    const r = await subscriptionStep(fx, { connId: connB, userId: B, token: 'token-B' })
    assert.strictEqual(r.outcome, 'created', JSON.stringify(r))
    const seq = fx.calls.slice(mark).map((c) => `${c.method}${c.id ? ' ' + c.id : ''}`)
    assert.deepStrictEqual(seq, ['POST', 'GET', `DELETE ${subA1}`, 'POST'], seq.join(', '))
    subB1 = subRow(connB).subscriptionId
    assert.ok(!fx.subs.has(subA1), 'A\'s subscription is gone at Microsoft')
    const a = subRow(connA)
    assert.strictEqual(a.subscriptionId, subA1)
    assert.strictEqual(a.status, 'active', 'A\'s row still claims a live subscription Microsoft no longer has')
  })
  await test('notifications for the mailbox now wake only B; A is silent', async () => {
    const a0 = wakeCount(connA); const b0 = wakeCount(connB)
    assert.strictEqual(await deliverNotification(fx, subB1), 'accepted')
    assert.strictEqual(wakeCount(connB), b0 + 1)
    assert.strictEqual(wakeCount(connA), a0, 'nothing can reach A: Microsoft holds no subscription of A\'s')
  })
  await test('PING-PONG: A\'s renewal 404s, recreates, 409s and deletes B\'s subscription', async () => {
    const exp = Date.parse(one(`SELECT expires_at FROM public.outlook_subscriptions WHERE connection_id='${connA}';`))
    const mark = fx.calls.length
    const r = await subscriptionStep(fx, { connId: connA, userId: A, token: 'token-A',
      now: () => exp - Math.floor(SUBSCRIPTION_RENEW_BEFORE_MS / 2) })
    assert.strictEqual(r.outcome, 'recreated', JSON.stringify(r))
    const seq = fx.calls.slice(mark).map((c) => `${c.method}${c.id ? ' ' + c.id : ''}`)
    assert.deepStrictEqual(seq, [`PATCH ${subA1}`, 'POST', 'GET', `DELETE ${subB1}`, 'POST'], seq.join(', '))
    assert.ok(!fx.subs.has(subB1), 'B\'s subscription is gone at Microsoft')
    assert.strictEqual(subRow(connB).status, 'active', 'B\'s row now claims a dead subscription')
  })

  // ══ 2. the fix will not paper over an existing duplicate ════════════════════
  console.log('\n2. applying the fix while a duplicate exists')
  await test('the migration REFUSES, and changes nothing', () => {
    const fnBefore = one(`SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                          WHERE n.nspname='public' AND p.proname='finalize_microsoft_connection';`)
    let err = null
    try { psqlFile(`supabase/migrations/${FIX_MIGRATION}`) } catch (e) { err = String(e.stderr ?? e.message) }
    assert.ok(err && err.includes('outlook_one_owner_duplicates'), err)
    assert.strictEqual(holdersOf(X.tid, X.oid), 2, 'no connection was deleted')
    assert.strictEqual(one(`SELECT count(*) FROM pg_indexes WHERE indexname='microsoft_connections_ms_identity_unique';`), '0')
    assert.strictEqual(one(`SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                            WHERE n.nspname='public' AND p.proname='finalize_microsoft_connection';`), fnBefore)
  })
  // DISPOSABLE-ONLY test setup: resolve the duplicate the way an operator would, deliberately,
  // by disconnecting B through the user RPC, so the fix can be applied. Production has none.
  await test('(disposable setup) B disconnects through its own RPC; the fix then applies', async () => {
    const r = await http('POST', '/rpc/disconnect_my_outlook', { token: userToken(B), body: {} })
    assert.ok(r.status === 200, r.raw)
    assert.strictEqual(connectionsFor(B), 0)
    psqlFile(`supabase/migrations/${FIX_MIGRATION}`)
    assert.strictEqual(one(`SELECT count(*) FROM pg_indexes WHERE indexname='microsoft_connections_ms_identity_unique';`), '1')
    assert.strictEqual(one(`SELECT count(*)::text||'|'||bool_and(prosecdef)::text||'|'||max(array_to_string(proconfig,','))
                              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                             WHERE n.nspname='public' AND p.proname='finalize_microsoft_connection';`), '1|true|search_path=""')
    assert.strictEqual(one(`SELECT has_function_privilege('authenticated',
      'public.finalize_microsoft_connection(text,uuid,text,text,text,text,text[],timestamptz,text,text,text,text,smallint)','EXECUTE')::text`), 'false')
  })

  // ══ 3. after the fix ═══════════════════════════════════════════════════════
  console.log('\n3. AFTER the fix')
  await test('B is refused with account_in_use; nothing written; state NOT consumed; A byte-identical', async () => {
    const aBefore = rowDigest(A); const subBefore = JSON.stringify(subRow(connA))
    const r = await finalize(B, { ...X, email: 'alias-of-owner@outlook.test', tag: 'b2' })
    assert.strictEqual(r.status, 200, r.raw)
    assert.strictEqual(r.result, 'account_in_use', r.raw)
    assert.ok(!r.raw.includes(A) && !r.raw.includes(connA) && !r.raw.includes('owner@'), 'the refusal names no one')
    assert.strictEqual(connectionsFor(B), 0)
    assert.strictEqual(stateConsumed(r.state), 'false')
    assert.strictEqual(rowDigest(A), aBefore)
    assert.strictEqual(JSON.stringify(subRow(connA)), subBefore)
  })
  await test('case variants of the same tenant and object id are the SAME identity', async () => {
    for (const v of [{ ...X, oid: OID_X.toUpperCase() }, { ...X, tid: CONSUMERS.toUpperCase() }]) {
      const r = await finalize(B, { ...v, tag: 'case' })
      assert.strictEqual(r.result, 'account_in_use', JSON.stringify(v))
    }
    assert.strictEqual(connectionsFor(B), 0)
  })
  await test('identity, not address text: C may connect a DIFFERENT identity that shows A\'s address', async () => {
    const r = await finalize(C, { tid: CONSUMERS, oid: OID_Y, email: X.email, tag: 'c' })
    assert.strictEqual(r.result, 'stored', r.raw)
  })
  await test('identity is scoped by tenant: the same object id under another tenant is another identity', async () => {
    const r = await finalize(G, { tid: WORK_TENANT, oid: OID_X, email: 'g@school.test', tag: 'g' })
    assert.strictEqual(r.result, 'stored', r.raw)
  })
  await test('SAME user, SAME account: a permission update still succeeds on the same row', async () => {
    const id0 = one(`SELECT id FROM public.microsoft_connections WHERE user_id='${A}';`)
    const r = await finalize(A, { ...X, tag: 'a2' }, { version: CONSENT_NEXT })
    assert.strictEqual(r.result, 'stored', r.raw)
    assert.strictEqual(r.connectionId, id0)
    assert.strictEqual(one(`SELECT consent_policy_version FROM public.microsoft_connections WHERE user_id='${A}';`), CONSENT_NEXT)
    assert.strictEqual(one(`SELECT refresh_token_ciphertext FROM public.microsoft_tokens WHERE user_id='${A}';`), 'refresh-a2')
    assert.strictEqual(holdersOf(X.tid, X.oid), 1)
  })
  await test('SAME user, DIFFERENT account is still different_account (unchanged rule)', async () => {
    const r = await finalize(A, { tid: CONSUMERS, oid: OID_OTHER, email: 'other@outlook.test', tag: 'a3' })
    assert.strictEqual(r.result, 'different_account', r.raw)
  })

  await test('RACE (commit): D holds an uncommitted connect; E blocks, then gets account_in_use', async () => {
    const Z = { tid: CONSUMERS, oid: OID_Z, email: 'z@outlook.test', tag: 'z' }
    const sD = mintState(D)
    const session = spawn('docker', ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-f', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    session.stdout.on('data', (b) => { out += b })
    session.stdin.end(`BEGIN;\n${finalizeSql(D, sD, Z)}\nSELECT pg_sleep(4);\nCOMMIT;\n`)
    await sleep(1500)   // D's INSERT now holds the index entry, uncommitted
    const t0 = Date.now()
    const r = await finalize(E, { ...Z, tag: 'e' })
    const waited = Date.now() - t0
    await new Promise((res) => session.on('close', res))
    assert.ok(out.includes('stored'), `D: ${out}`)
    assert.strictEqual(r.result, 'account_in_use', r.raw)
    assert.ok(waited >= 1500, `E must have waited on D's transaction (waited ${waited} ms)`)
    assert.strictEqual(holdersOf(Z.tid, Z.oid), 1)
    assert.strictEqual(connectionsFor(E), 0)
  })
  await test('RACE (rollback): F holds an uncommitted connect and rolls back; E then succeeds', async () => {
    const W = { tid: CONSUMERS, oid: OID_W, email: 'w@outlook.test', tag: 'w' }
    const sF = mintState(F)
    const session = spawn('docker', ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-f', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    session.stdin.end(`BEGIN;\n${finalizeSql(F, sF, W)}\nSELECT pg_sleep(4);\nROLLBACK;\n`)
    await sleep(1500)
    const r = await finalize(E, { ...W, tag: 'e2' })
    await new Promise((res) => session.on('close', res))
    assert.strictEqual(r.result, 'stored', r.raw)
    assert.strictEqual(holdersOf(W.tid, W.oid), 1)
    assert.strictEqual(connectionsFor(F), 0)
  })
  await test('BURST: ten users connect one new identity at once; exactly one is stored, nine refused, no errors', async () => {
    const V = { tid: CONSUMERS, oid: OID_V, email: 'v@outlook.test', tag: 'v' }
    const results = await Promise.all(BURST.map((u) => finalize(u, V)))
    const tally = {}
    for (const r of results) tally[`${r.status}:${r.result}`] = (tally[`${r.status}:${r.result}`] ?? 0) + 1
    assert.deepStrictEqual(tally, { '200:stored': 1, '200:account_in_use': 9 }, JSON.stringify(tally))
    assert.strictEqual(holdersOf(V.tid, V.oid), 1)
  })

  await test('REFUSAL BEFORE INTERFERENCE: a refused user has no connection, so no run is reserved and no subscription request is made', async () => {
    const callsBefore = fx.calls.length
    const subsBefore = JSON.stringify([...fx.subs.keys()])
    assert.strictEqual(connectionsFor(B), 0)
    assert.strictEqual(one(`SELECT count(*) FROM public.outlook_sync_state s JOIN public.microsoft_connections c ON c.id=s.connection_id WHERE c.user_id='${B}';`), '0')
    psql(`UPDATE public.microsoft_connections SET wake_requested_at = now() WHERE user_id='${A}';`, { tuplesOnly: false })
    const r = await http('POST', '/rpc/reserve_due_outlook_connection',
      { token: workerToken(), body: { p_lease_seconds: 60, p_due_after_seconds: 0, p_pilot_user_ids: [B] } })
    assert.strictEqual(r.body?.result, 'none_due', r.raw)
    assert.strictEqual(fx.calls.length, callsBefore, 'no Graph subscription request was made')
    assert.strictEqual(JSON.stringify([...fx.subs.keys()]), subsBefore)
  })
  await test('ownership is current, not permanent: after A disconnects, B may connect X', async () => {
    const d = await http('POST', '/rpc/disconnect_my_outlook', { token: userToken(A), body: {} })
    assert.strictEqual(d.status, 200, d.raw)
    const r = await finalize(B, { ...X, tag: 'b3' })
    assert.strictEqual(r.result, 'stored', r.raw)
    assert.strictEqual(holdersOf(X.tid, X.oid), 1)
  })
  await test('no table anywhere holds two owners of one identity', () => {
    assert.strictEqual(one(`SELECT count(*) FROM (SELECT 1 FROM public.microsoft_connections
      GROUP BY coalesce(lower(ms_tenant_id),''), lower(ms_account_id) HAVING count(*) > 1) d;`), '0')
  })

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`)
} catch (e) {
  harnessError = e
  console.error(`\nHARNESS ERROR: ${e.message}\n${e.stack}`)
  if (e.stdout) console.error(String(e.stdout).slice(-3000))
  if (e.stderr) console.error(String(e.stderr).slice(-3000))
} finally {
  teardown()
  if (harnessError) console.error('FAILED: the harness threw before finishing; the run proves nothing.')
  if (failed > 0 || harnessError) process.exitCode = 1
}
