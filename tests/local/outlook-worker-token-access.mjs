#!/usr/bin/env node
// THE REAL WORKER HANDLER, over local HTTP, obtaining its own token.
//
// This is the positive control for the slice. An authorized HTTP request reaches the
// actual `handleOutlookImportWorker` from
// supabase/functions/outlook-import-worker/handler.js - not a copy, not a stub - and the
// handler:
//   1. checks its two flags, then the worker secret, then its configuration;
//   2. reserves a connection through reserve_due_outlook_connection;
//   3. loads THAT connection's owner, contacts, encrypted cursors and encrypted tokens
//      from a real Postgres through real PostgREST;
//   4. decrypts the tokens with the token-encryption key, finds the access token
//      expired, refreshes it at a FIXTURE token endpoint, and persists the rotated
//      refresh token through rotate_microsoft_access_token;
//   5. runs the bounded metadata pass against FIXTURE Graph responses using the newly
//      refreshed token;
//   6. writes one pending known-contact suggestion and advances the encrypted cursors.
//
// THE REQUEST SUPPLIES NONE OF THAT. The positive control deliberately POSTs a body
// containing another user's id, a bogus connection id, a bogus access token and a bogus
// cursor, and asserts none of it has any effect - the handler never reads the body.
//
// FIXTURES ARE FIXTURES. Every Microsoft response here is written by this file. It shows
// what the code does GIVEN a response of that shape; it is not evidence that Microsoft
// produces that shape, and no request ever leaves this machine. The only things claimed
// about the real provider are the two constants the deployed entry uses (Microsoft's
// fixed token endpoint and the Graph origin), which are asserted to be what the
// production modules export.
//
// NOT COVERED: the browser, Kong (the handler is called directly, so no apikey gateway
// check), GoTrue, and any real mailbox. Nobody has operated the app.
//
// REQUIREMENTS: Docker, plus the two images the project already uses.
// RUN: node tests/local/outlook-worker-token-access.mjs   (builds and tears down)

import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes, createHmac, webcrypto } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert'
import {
  handleOutlookImportWorker,
} from '../../supabase/functions/outlook-import-worker/handler.js'
import {
  PRODUCTION_TOKEN_URL, makePostgrestPorts,
} from '../../supabase/functions/outlook-import-worker/endpoints.js'
import { MS_TOKEN_ENDPOINT } from '../../supabase/functions/shared/microsoftOauthHelpers.js'
import { GRAPH_BASE } from '../../supabase/functions/shared/outlookGraphTransport.js'
import {
  CONVERSATION_PAGE_SIZE,
} from '../../supabase/functions/shared/outlookImportRun.js'
import {
  MAX_CONVERSATIONS_PER_ROUND,
} from '../../supabase/functions/shared/outlookRoundState.js'
import {
  MAX_CONTACTS_LOADED, CONTACT_PAGE_SIZE,
} from '../../supabase/functions/shared/outlookRunContext.js'
import { importKeyFromBase64, encryptToken, decryptToken } from '../../supabase/functions/shared/googleTokenCrypto.js'
import { readJsonBounded, MAX_PROVIDER_BODY_BYTES } from '../../supabase/functions/shared/boundedJson.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PG = 'funnl-token-pg'
const REST = 'funnl-token-rest'
const NET = 'funnl-token-net'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const PGRST = 'http://127.0.0.1:53997'
const WORKER = 'http://127.0.0.1:53996'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const ME = 'student@getfunnl.test'
const RECRUITER = 'ava@bank.test'

// Per-run throwaway secrets. None is printed.
const WORKER_SECRET = randomBytes(24).toString('hex')          // 48 chars
const TOKEN_KEY_B64 = Buffer.from(randomBytes(32)).toString('base64')
const CLIENT_SECRET = randomBytes(16).toString('hex')
const FIXTURE_TOKEN_URL = 'https://login.microsoftonline.test/common/oauth2/v2.0/token'

let passed = 0, failed = 0
async function test (name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

// ── plumbing ─────────────────────────────────────────────────────────────────
const docker = (a, o = {}) => execFileSync('docker', a, { encoding: 'utf8', stdio: 'pipe', ...o })
const quiet = (a) => spawnSync('docker', a, { stdio: 'ignore' })
const sleepSync = (ms) => spawnSync('node', ['-e', `setTimeout(()=>{},${ms})`], { stdio: 'ignore' })

function psql (sql, { user = 'postgres', tuplesOnly = true } = {}) {
  const args = ['exec', '-i', PG, 'psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q']
  if (tuplesOnly) args.push('-At')
  args.push('-f', '-')
  return execFileSync('docker', args, { input: sql, encoding: 'utf8', stdio: 'pipe' })
}
const one = (sql) => psql(sql).trim()
const one2 = one

function waitForPg (timeoutMs = 180000) {
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

// ── the database ports, as the service role, over real PostgREST ─────────────
// Deliberately the same SHAPE as endpoints.js makePostgrestPorts - plain fetch, bounded
// read, redirect refused - rather than importing it, because the harness mints its own
// service-role JWT for PostgREST instead of holding a project service key.
let jwtSecret = null
function mintServiceJwt () {
  const seg = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const head = seg({ alg: 'HS256', typ: 'JWT' })
  const body = seg({ role: 'service_role', aud: 'authenticated', iat: now, exp: now + 3600 })
  const sig = createHmac('sha256', jwtSecret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

function makePorts () {
  const calls = []
  async function call (path, init) {
    calls.push(path)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15000)
    try {
      let res
      try {
        res = await fetch(`${PGRST}/${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${mintServiceJwt()}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          signal: ctrl.signal,
          redirect: 'error',
        })
      } catch { return { data: null, error: { code: 'unreachable' } } }
      if (res.status >= 400) {
        return { data: null, error: { code: res.status >= 500 ? 'server_error' : 'rejected' } }
      }
      const read = await readJsonBounded(res, MAX_PROVIDER_BODY_BYTES)
      if (!read.ok) return { data: null, error: { code: 'malformed' } }
      return { data: read.value, error: null }
    } finally { clearTimeout(timer) }
  }
  return {
    calls,
    select: (p) => call(p, { method: 'GET' }),
    rpc: (n, a) => call(`rpc/${n}`, { method: 'POST', body: JSON.stringify(a ?? {}) }),
  }
}

// ── fixture Microsoft endpoints ──────────────────────────────────────────────

const REFRESHED_ACCESS = 'FIXTURE-ACCESS-TOKEN-v2'
const ROTATED_REFRESH = 'FIXTURE-REFRESH-TOKEN-v2'

/** The token endpoint. Records every request; never echoes a secret. */
function tokenFixture ({ rotate = true, status = 200, body = null } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const form = new URLSearchParams(init.body)
    calls.push({
      url,
      redirect: init.redirect,
      grant: form.get('grant_type'),
      hasSecret: form.get('client_secret') === CLIENT_SECRET,
      hasRefresh: typeof form.get('refresh_token') === 'string' && form.get('refresh_token').length > 0,
      scope: form.get('scope'),
      sentRedirectUri: form.get('redirect_uri'),
    })
    const payload = body ?? {
      access_token: REFRESHED_ACCESS,
      expires_in: 3600,
      scope: 'Mail.Read User.Read offline_access',
      token_type: 'Bearer',
      ...(rotate ? { refresh_token: ROTATED_REFRESH } : {}),
    }
    return { status, headers: { get: () => null }, json: async () => payload }
  }
  return { calls, fetchImpl }
}

/** The Graph delta endpoint. One two-sided exchange; records the bearer it was given. */
function graphFixture () {
  const calls = []
  const addr = (e) => ({ emailAddress: { address: e, name: e.split('@')[0] } })
  const m = (id, from, to, sent) => ({
    id, conversationId: 'conv-1', receivedDateTime: sent, sentDateTime: sent, isDraft: false,
    subject: 'Following up after the info session',
    from: addr(from), sender: addr(from), toRecipients: to.map(addr), ccRecipients: [],
  })
  const fetchImpl = async (url, init) => {
    calls.push({ url, bearer: init.headers?.Authorization ?? null, redirect: init.redirect })
    const folder = url.includes('/mailFolders/inbox/') ? 'inbox' : 'sentitems'
    const items = folder === 'inbox'
      ? [m('ms-in-1', RECRUITER, [ME], '2026-09-20T14:05:00Z')]
      : [m('ms-out-1', ME, [RECRUITER], '2026-09-21T09:12:00Z')]
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        value: items,
        '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=NEW-${folder}`,
      }),
    }
  }
  return { calls, fetchImpl }
}

/**
 * A mailbox big enough to need several invocations.
 *
 * Each folder serves `pages` pages of one message. The QUALIFYING inbound sits on inbox
 * page `inboundAt` and the qualifying outbound on sent page `outboundAt`, chosen so the
 * two halves of the exchange cannot be read in the same invocation. Every other message
 * is from the user to the user, which the rules exclude as self_only - so it creates no
 * conversation record while still being counted as read.
 */
function pagedGraphFixture ({ pages = 25, inboundAt = 22, outboundAt = 18, rejectSaved = false } = {}) {
  const calls = []
  const addr = (e) => ({ emailAddress: { address: e, name: e.split('@')[0] } })
  const m = (id, conv, from, to, sent) => ({
    id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
    subject: 'Following up after the info session',
    from: addr(from), sender: addr(from), toRecipients: to.map(addr), ccRecipients: [],
  })
  const fetchImpl = async (url, init) => {
    calls.push({ url, bearer: init.headers?.Authorization ?? null })
    if (rejectSaved && url.includes('$skiptoken=')) {
      // Exactly how Graph reports an expired or invalidated delta token.
      return { status: 410, headers: { get: () => null }, json: async () => ({ error: { code: 'resyncRequired' } }) }
    }
    const folder = url.includes('/mailFolders/inbox/') ? 'inbox' : 'sentitems'
    const mm = /[$]skiptoken=p(\d+)/.exec(url)
    const n = mm ? Number(mm[1]) : 1
    const qualifying = folder === 'inbox' ? n === inboundAt : n === outboundAt
    const items = [qualifying
      ? (folder === 'inbox'
          ? m(`ms-in-${n}`, 'conv-split', RECRUITER, [ME], '2026-09-20T14:05:00Z')
          : m(`ms-out-${n}`, 'conv-split', ME, [RECRUITER], '2026-09-21T09:12:00Z'))
      : m(`ms-${folder}-filler-${n}`, `filler-${folder}-${n}`, ME, [ME], '2026-09-19T08:00:00Z')]
    const tail = n >= pages
      ? { '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=NEW-${folder}` }
      : { '@odata.nextLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$skiptoken=p${n + 1}` }
    return { status: 200, headers: { get: () => null }, json: async () => ({ value: items, ...tail }) }
  }
  return { calls, fetchImpl }
}

/**
 * A mailbox whose round finishes on the FIRST page of each folder but yields many
 * qualifying conversations, so the expensive part is FINALISATION - writing one bounded
 * RPC per suggestion.
 */
function manyConversationsFixture (n) {
  const calls = []
  const addr = (e) => ({ emailAddress: { address: e, name: e.split('@')[0] } })
  const m = (id, conv, from, to, sent) => ({
    id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
    subject: 'Following up after the info session',
    from: addr(from), sender: addr(from), toRecipients: to.map(addr), ccRecipients: [],
  })
  const convs = Array.from({ length: n }, (_, i) => `conv-${String(i).padStart(3, '0')}`)
  const fetchImpl = async (url, init) => {
    calls.push({ url, bearer: init.headers?.Authorization ?? null })
    const folder = url.includes('/mailFolders/inbox/') ? 'inbox' : 'sentitems'
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        value: convs.map((c, i) => (folder === 'inbox'
          ? m(`ms-in-${i}`, c, RECRUITER, [ME], '2026-09-20T14:05:00Z')
          : m(`ms-out-${i}`, c, ME, [RECRUITER], '2026-09-21T09:12:00Z'))),
        '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=NEW-${folder}`,
      }),
    }
  }
  return { calls, fetchImpl, count: n }
}

// ── the worker, served over real HTTP ────────────────────────────────────────

let currentEnv = null
let currentDeps = null
const SEEDED_CONSENT = 'ol-disc-00000000000000000000000000000000'

function startWorkerServer () {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      // A faithful web Request, body included. The handler is expected to ignore it.
      const request = new Request(`http://worker.local${req.url}`, {
        method: req.method,
        headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      })
      let out
      try {
        // The seeded connections consented under SEEDED_CONSENT; the background requirement is
        // injected to that value (the handler's test seam) so the runs model a re-consented account.
        out = await handleOutlookImportWorker(request, currentEnv, { requiredBackgroundConsent: SEEDED_CONSENT, ...currentDeps })
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ harnessError: String(e && e.message) }))
        return
      }
      const text = await out.text()
      res.writeHead(out.status, { 'Content-Type': 'application/json' })
      res.end(text)
    })
  })
  return new Promise((resolve) => server.listen(53996, '127.0.0.1', () => resolve(server)))
}

async function callWorker ({ secret, body, method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (secret) headers.Authorization = `Bearer ${secret}`
  const res = await fetch(WORKER, {
    method, headers,
    body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = text.length ? JSON.parse(text) : null } catch { parsed = text }
  return { status: res.status, body: parsed, raw: text }
}

// ── fixtures in the database ─────────────────────────────────────────────────

async function seed ({ accessExpired = true, withAccessToken = true, withRefresh = true,
  owner = U1, alsoSeedExcluded = false } = {}) {
  const key = await importKeyFromBase64(TOKEN_KEY_B64, webcrypto.subtle)
  const acc = await encryptToken('FIXTURE-ACCESS-TOKEN-v1', key, { subtle: webcrypto.subtle })
  const ref = await encryptToken('FIXTURE-REFRESH-TOKEN-v1', key, { subtle: webcrypto.subtle })
  const expiry = accessExpired
    ? "now() - interval '10 minutes'"
    : "now() + interval '2 hours'"
  psql(`
DELETE FROM public.interaction_candidates WHERE user_id IN ('${U1}','${U2}');
DELETE FROM public.interactions WHERE user_id IN ('${U1}','${U2}');
DELETE FROM public.contacts WHERE user_id IN ('${U1}','${U2}');
DELETE FROM public.microsoft_connections WHERE user_id IN ('${U1}','${U2}');
DO $seed$
DECLARE k uuid;
BEGIN
  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version, token_expires_at)
  VALUES ('${owner}', 'acct-1', 'consumers', 'personal', '${ME}',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(),
          'ol-disc-00000000000000000000000000000000', ${expiry})
  RETURNING id INTO k;
  INSERT INTO public.microsoft_tokens
    (connection_id, user_id, access_token_ciphertext, access_token_nonce,
     refresh_token_ciphertext, refresh_token_nonce, key_version, token_expires_at)
  VALUES (k, '${owner}',
          ${withAccessToken ? `'${acc.ciphertext}'` : 'NULL'},
          ${withAccessToken ? `'${acc.nonce}'` : 'NULL'},
          ${withRefresh ? `'${ref.ciphertext}'` : 'NULL'},
          ${withRefresh ? `'${ref.nonce}'` : 'NULL'},
          1, ${expiry});
  INSERT INTO public.contacts (user_id, name, email) VALUES ('${owner}', 'Ava Recruiter', '${RECRUITER}');
  -- The SAME address, tracked by a DIFFERENT user. Must never be matched.
  INSERT INTO public.contacts (user_id, name, email)
  VALUES ('${owner === U1 ? U2 : U1}', 'Ava (someone else)', '${RECRUITER}');
END $seed$;`, { tuplesOnly: false })

  // A SECOND due connection, owned by the EXCLUDED user, so both are due at once.
  // Which one the reservation would prefer is decided by
  // `min(last_success_at) ASC NULLS FIRST, c.id ASC`, and that ORDERING is proved
  // precisely in tests/sql/outlook-pilot-reservation-runtime.sql, where
  // last_success_at can be set directly. What this file proves is the consequence
  // over real HTTP: the pilot still commits, and the excluded connection is never
  // reserved, read, refreshed or written.
  if (alsoSeedExcluded) {
    psql(`
DO $seed2$
DECLARE k2 uuid;
BEGIN
  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version, token_expires_at)
  VALUES ('${U2}', 'acct-excluded', 'consumers', 'personal', 'excluded@getfunnl.test',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(),
          'ol-disc-00000000000000000000000000000000', ${expiry})
  RETURNING id INTO k2;
  INSERT INTO public.microsoft_tokens
    (connection_id, user_id, access_token_ciphertext, access_token_nonce,
     refresh_token_ciphertext, refresh_token_nonce, key_version, token_expires_at)
  VALUES (k2, '${U2}', '${acc.ciphertext}', '${acc.nonce}',
          '${ref.ciphertext}', '${ref.nonce}', 1, ${expiry});
  INSERT INTO public.contacts (user_id, name, email)
  VALUES ('${U2}', 'Ava Recruiter', '${RECRUITER}');
END $seed2$;`, { tuplesOnly: false })
  }
}

function teardown () {
  quiet(['rm', '-f', REST]); quiet(['rm', '-f', PG]); quiet(['network', 'rm', NET])
}

let server = null

async function main () {
  console.log('\nbuilding a disposable Postgres + PostgREST, and serving the real handler')
  teardown()
  quiet(['network', 'create', NET])
  docker(['run', '-d', '--name', PG, '--network', NET, '-e', 'POSTGRES_PASSWORD=disposable', PG_IMAGE])
  waitForPg()
  psql(readFileSync(join(ROOT, 'tests/sql/_bootstrap-disposable-db.sql'), 'utf8'),
    { user: 'supabase_admin', tuplesOnly: false })
  const migrations = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
  for (const m of migrations) psql(readFileSync(join(ROOT, 'supabase/migrations', m), 'utf8'), { tuplesOnly: false })
  console.log(`  applied ${migrations.length} migrations, none skipped`)

  jwtSecret = randomBytes(32).toString('hex')
  psql("ALTER ROLE authenticator WITH PASSWORD 'disposable';", { user: 'supabase_admin', tuplesOnly: false })
  docker(['run', '-d', '--name', REST, '--network', NET, '-p', '53997:3000',
    '-e', `PGRST_DB_URI=postgres://authenticator:disposable@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${jwtSecret}`, REST_IMAGE])
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${PGRST}/`); if (r.status < 500) break } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400))
  }
  server = await startWorkerServer()
  console.log('  PostgREST is serving; the worker handler is listening\n')

  const FINGERPRINT_KEY = { current: { keyBytes: new Uint8Array(32).fill(13), keyVersion: 1 } }
  const baseEnv = () => ({
    integrationEnabled: 'true',
    workerEnabled: 'true',
    workerSecret: WORKER_SECRET,
    clientId: 'fixture-client-id',
    clientSecret: CLIENT_SECRET,
    tokenKeyB64: TOKEN_KEY_B64,
    fingerprintKey: FINGERPRINT_KEY,
    keyVersion: 1,
    scope: 'Mail.Read User.Read offline_access',
    // Required configuration since the pilot gate landed: without it the handler
    // refuses `config_missing` before reading a row. U1 owns the seeded connection.
    pilotUserId: U1,
  })

  // ══ the deployed constants are the real ones ══════════════════════════════
  console.log('the deployed entry points at Microsoft, not at a fixture')
  await test('PRODUCTION_TOKEN_URL is Microsoft\'s fixed token endpoint', () => {
    assert.strictEqual(PRODUCTION_TOKEN_URL, MS_TOKEN_ENDPOINT)
    assert.ok(PRODUCTION_TOKEN_URL.startsWith('https://login.microsoftonline.com/'),
      PRODUCTION_TOKEN_URL)
    // Everything below uses a FIXTURE url, which is why it proves nothing about
    // Microsoft's own responses.
    assert.notStrictEqual(FIXTURE_TOKEN_URL, PRODUCTION_TOKEN_URL)
  })

  // ══ flags and secret still gate everything ════════════════════════════════
  console.log('\nthe flag-first and worker-secret checks are unchanged')

  await test('both flags off: 503 not_enabled, whatever else is configured', async () => {
    currentEnv = { ...baseEnv(), integrationEnabled: null, workerEnabled: null }
    currentDeps = { tokenUrl: FIXTURE_TOKEN_URL, select: () => {}, rpc: () => {} }
    const r = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(r.status, 503)
    assert.deepStrictEqual(r.body, { error: 'not_enabled' })
  })

  await test('dormancy is still checked BEFORE the secret', async () => {
    currentEnv = { ...baseEnv(), workerEnabled: null }
    currentDeps = { tokenUrl: FIXTURE_TOKEN_URL, select: () => {}, rpc: () => {} }
    const wrong = await callWorker({ secret: 'w'.repeat(48) })
    const right = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(wrong.status, 503)
    assert.deepStrictEqual(right.body, { error: 'not_enabled' })
  })

  await test('enabled but unauthorized or GET is refused before any work', async () => {
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = { tokenUrl: FIXTURE_TOKEN_URL, select: ports.select, rpc: ports.rpc }
    const noAuth = await callWorker({})
    assert.strictEqual(noAuth.status, 401)
    const wrong = await callWorker({ secret: 'x'.repeat(48) })
    assert.strictEqual(wrong.status, 401)
    const get = await callWorker({ secret: WORKER_SECRET, method: 'GET' })
    assert.strictEqual(get.status, 405)
    assert.strictEqual(ports.calls.length, 0, 'no database call may happen before authorisation')
  })

  // ══ configuration fails closed ════════════════════════════════════════════
  console.log('\nmissing Entra configuration or encryption key fails closed')

  for (const key of ['clientId', 'clientSecret', 'tokenKeyB64', 'fingerprintKey']) {
    await test(`a missing ${key} refuses with config_missing and touches no database`, async () => {
      const ports = makePorts()
      currentEnv = { ...baseEnv(), [key]: null }
      currentDeps = { tokenUrl: FIXTURE_TOKEN_URL, select: ports.select, rpc: ports.rpc }
      const r = await callWorker({ secret: WORKER_SECRET })
      assert.strictEqual(r.status, 503)
      assert.strictEqual(r.body.error, 'config_missing')
      assert.deepStrictEqual(r.body.missing, [key])
      assert.strictEqual(ports.calls.length, 0, 'nothing may be read before the config check')
      // The refusal names the key, never its value.
      assert.ok(!r.raw.includes(CLIENT_SECRET) && !r.raw.includes(TOKEN_KEY_B64))
    })
  }

  await test('a missing token endpoint also fails closed', async () => {
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = { tokenUrl: '', select: ports.select, rpc: ports.rpc }
    const r = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(r.body.error, 'config_missing')
    assert.ok(r.body.missing.includes('tokenUrl'))
    assert.strictEqual(ports.calls.length, 0)
  })

  // ══ THE POSITIVE CONTROL ══════════════════════════════════════════════════
  console.log('\nPOSITIVE CONTROL: one authorized request reaches a pending suggestion')

  const tok = tokenFixture()
  const graph = graphFixture()
  let runBody = null

  await test('the handler obtains its own token and leaves ONE pending suggestion', async () => {
    await seed({ accessExpired: true })
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL,
      fetchImpl: tok.fetchImpl,
      graphFetchImpl: graph.fetchImpl,
      select: ports.select,
      rpc: ports.rpc,
    }
    // The request carries values it must NOT be able to influence.
    const r = await callWorker({
      secret: WORKER_SECRET,
      body: {
        user_id: U2,
        connection_id: '00000000-0000-0000-0000-000000000000',
        access_token: 'ATTACKER-SUPPLIED-TOKEN',
        cursor: 'ATTACKER-SUPPLIED-CURSOR',
        proposed_notes: 'attacker-supplied note',
      },
    })
    assert.strictEqual(r.status, 200, r.raw.slice(0, 300))
    runBody = r.body
    assert.strictEqual(r.body.error, null)
    assert.strictEqual(r.body.run.outcome, 'committed', JSON.stringify(r.body.run))
    assert.strictEqual(r.body.run.created, 1)
    assert.strictEqual(r.body.run.accepted, 1)
    assert.strictEqual(r.body.run.cursors_advanced, 2)
    assert.strictEqual(one(
      `SELECT count(*) FROM public.interaction_candidates WHERE user_id='${U1}' AND source='outlook' AND status='pending';`),
    '1')
  })

  await test('the request body had NO effect: the run used the reserved connection', async () => {
    // The body named U2, a bogus connection and a bogus token. None of it landed.
    assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates WHERE user_id='${U2}';`), '0')
    assert.strictEqual(one(
      `SELECT coalesce(proposed_notes,'NULL') FROM public.interaction_candidates WHERE user_id='${U1}';`), 'NULL')
    // The Graph request carried the REFRESHED token, not the one the body offered.
    assert.ok(graph.calls.length >= 2, 'both folders must have been read')
    for (const c of graph.calls) {
      assert.strictEqual(c.bearer, `Bearer ${REFRESHED_ACCESS}`,
        'the run must use the token it obtained itself')
      assert.ok(!c.bearer.includes('ATTACKER-SUPPLIED'))
    }
  })

  await test('the token endpoint saw a refresh grant with the secret, and refused redirects', () => {
    assert.strictEqual(tok.calls.length, 1, 'exactly one refresh')
    const c = tok.calls[0]
    assert.strictEqual(c.url, FIXTURE_TOKEN_URL)
    assert.strictEqual(c.grant, 'refresh_token')
    assert.strictEqual(c.hasSecret, true, 'a confidential client sends its secret')
    assert.strictEqual(c.hasRefresh, true)
    assert.strictEqual(c.redirect, 'error', 'this POST must never follow a redirect')
    assert.strictEqual(c.sentRedirectUri, null, 'a refresh grant carries no redirect_uri')
    assert.strictEqual(c.scope, 'Mail.Read User.Read offline_access')
  })

  await test('the ROTATED refresh token was persisted, encrypted, before the run used it', async () => {
    const key = await importKeyFromBase64(TOKEN_KEY_B64, webcrypto.subtle)
    const row = psql(`SELECT access_token_ciphertext, access_token_nonce,
        refresh_token_ciphertext, refresh_token_nonce, key_version,
        token_expires_at > now() AS future
      FROM public.microsoft_tokens WHERE user_id='${U1}';`).trim().split('|')
    const access = await decryptToken(row[0], row[1], key, { subtle: webcrypto.subtle })
    const refresh = await decryptToken(row[2], row[3], key, { subtle: webcrypto.subtle })
    assert.strictEqual(access, REFRESHED_ACCESS, 'the new access token must be stored')
    assert.strictEqual(refresh, ROTATED_REFRESH,
      'Microsoft invalidates the old refresh token when it rotates; losing the new one would break the connection')
    assert.strictEqual(row[4], '1')
    assert.strictEqual(row[5], 't', 'the stored expiry must now be in the future')
    // Nothing is stored in the clear.
    assert.ok(!row[0].includes(REFRESHED_ACCESS) && !row[2].includes(ROTATED_REFRESH))
  })

  await test('the cursors were stored ENCRYPTED and decrypt back to the fixture links', async () => {
    const key = await importKeyFromBase64(TOKEN_KEY_B64, webcrypto.subtle)
    const rows = psql(`SELECT folder, delta_link_ciphertext, delta_link_nonce
      FROM public.outlook_sync_state WHERE user_id='${U1}' ORDER BY folder;`).trim().split('\n')
    assert.strictEqual(rows.length, 2)
    for (const r of rows) {
      const [folder, ct, nonce] = r.split('|')
      assert.ok(ct && ct.length > 0, `${folder} cursor not stored`)
      assert.ok(!ct.includes('deltatoken') && !ct.includes('graph.microsoft.com'),
        `${folder} cursor stored in plaintext`)
      const plain = await decryptToken(ct, nonce, key, { subtle: webcrypto.subtle })
      assert.ok(plain.includes(`NEW-${folder}`), `${folder} cursor did not round-trip`)
    }
  })

  await test('no interaction and no contact were created by the worker', () => {
    assert.strictEqual(one(`SELECT count(*) FROM public.interactions WHERE user_id='${U1}';`), '0')
    assert.strictEqual(one(`SELECT count(*) FROM public.contacts WHERE user_id='${U1}';`), '1')
    assert.strictEqual(one(`SELECT name FROM public.contacts WHERE user_id='${U1}';`), 'Ava Recruiter')
  })

  await test('the RESPONSE carries no token, cursor, id, address or fingerprint', () => {
    const raw = JSON.stringify(runBody)
    for (const secret of [REFRESHED_ACCESS, ROTATED_REFRESH, 'FIXTURE-REFRESH-TOKEN-v1',
      CLIENT_SECRET, TOKEN_KEY_B64, WORKER_SECRET, U1, U2, RECRUITER, ME,
      'deltatoken', 'NEW-inbox', 'Following up']) {
      assert.ok(!raw.includes(secret), `the response leaked: ${String(secret).slice(0, 24)}`)
    }
    assert.ok(!/[0-9a-f]{64}/.test(raw), 'the response leaked a fingerprint')
  })

  await test('a second identical request does not duplicate', async () => {
    psql(`UPDATE public.outlook_sync_state SET last_success_at = now() - interval '2 hours'
          WHERE user_id='${U1}';`, { tuplesOnly: false })
    const tok2 = tokenFixture()
    const graph2 = graphFixture()
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tok2.fetchImpl,
      graphFetchImpl: graph2.fetchImpl, select: ports.select, rpc: ports.rpc,
    }
    const r = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(r.status, 200, r.raw.slice(0, 200))
    assert.strictEqual(r.body.run.outcome, 'committed')
    assert.strictEqual(r.body.run.created, 0, 'nothing new')
    assert.strictEqual(r.body.run.accepted, 1)
    assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates WHERE user_id='${U1}';`), '1')
    // The access token is still valid, so NO refresh should have happened.
    assert.strictEqual(tok2.calls.length, 0, 'a valid token must not be refreshed again')
  })

  // ══ contact loading, against the REAL port and the REAL database ══════════
  console.log('\ncontacts: bounded paging through real PostgREST')

  /** Add `n` contacts for u1, with realistic addresses. */
  const addContacts = (n) => psql(`
    INSERT INTO public.contacts (user_id, name, email)
    SELECT '${U1}', 'Bulk ' || i,
           'contact.number.' || i || '@a-fairly-long-company-domain.example'
      FROM generate_series(1, ${n}) AS i;`, { tuplesOnly: false })

  await test('THE OVERSIZED RESPONSE: one request for the whole set is refused by the port', async () => {
    await seed({ accessExpired: false })
    addContacts(MAX_CONTACTS_LOADED)
    const ports = makePorts()
    // Exactly what the previous loader asked for: the whole supported set in one
    // response. Against real PostgREST with real rows the port refuses it.
    const one = await ports.select(
      `contacts?user_id=eq.${U1}&email=not.is.null&select=id,user_id,email` +
      `&order=id.asc&limit=${MAX_CONTACTS_LOADED}`)
    assert.ok(one.error, `the single-request read must fail, got ${JSON.stringify(one.data?.length)}`)

    // And one PAGE of the same data is accepted.
    const page = await ports.select(
      `contacts?user_id=eq.${U1}&email=not.is.null&select=id,user_id,email` +
      `&order=id.asc&limit=${CONTACT_PAGE_SIZE}&offset=0`)
    assert.strictEqual(page.error, null, JSON.stringify(page.error))
    assert.strictEqual(page.data.length, CONTACT_PAGE_SIZE)
  })

  await test('a multi-page contact set is loaded in full, through the real handler', async () => {
    await seed({ accessExpired: false })
    // Enough to need several pages, plus the one contact the exchange is with.
    addContacts(CONTACT_PAGE_SIZE * 2 + 37)
    const before = Number(one2(`SELECT count(*) FROM public.contacts WHERE user_id='${U1}';`))
    const graphC = graphFixture()
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tokenFixture().fetchImpl,
      graphFetchImpl: graphC.fetchImpl, select: ports.select, rpc: ports.rpc,
    }
    const r = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(r.status, 200, r.raw.slice(0, 300))
    assert.strictEqual(r.body.run.outcome, 'committed', JSON.stringify(r.body.run))
    // The suggestion still found the RIGHT contact, which is only possible if the page
    // holding it was actually read.
    assert.strictEqual(one2(
      `SELECT count(*) FROM public.interaction_candidates c JOIN public.contacts ct
         ON ct.id = c.contact_id WHERE ct.email = '${RECRUITER}' AND ct.user_id = '${U1}';`), '1')
    // Paged, not requested in one go.
    const contactCalls = ports.calls.filter((c) => c.startsWith('contacts'))
    assert.ok(contactCalls.length >= 3, `expected several pages, got ${contactCalls.length}`)
    for (const c of contactCalls) {
      assert.ok(c.includes(`limit=${CONTACT_PAGE_SIZE}`) || c.includes('limit=1'), c)
      assert.ok(c.includes(`user_id=eq.${U1}`), `owner-scoped: ${c}`)
    }
    assert.ok(before > CONTACT_PAGE_SIZE * 2, 'the fixture must actually span pages')
  })

  await test('THE OVERFLOW CASE: one contact past the limit fails before Graph and before any cursor', async () => {
    await seed({ accessExpired: false })
    addContacts(MAX_CONTACTS_LOADED)   // plus the two seeded ones -> over the limit
    const tokenC = tokenFixture()
    const graphC = graphFixture()
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tokenC.fetchImpl,
      graphFetchImpl: graphC.fetchImpl, select: ports.select, rpc: ports.rpc,
    }
    const r = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(r.status, 503, r.raw.slice(0, 200))
    assert.strictEqual(r.body.run.outcome, 'released_error')
    assert.strictEqual(r.body.run.reason, 'too_many_contacts')
    assert.strictEqual(graphC.calls.length, 0, 'no mailbox may be read')
    assert.strictEqual(tokenC.calls.length, 0, 'no token need even be fetched')
    assert.strictEqual(r.body.run.cursors_advanced, 0)
    assert.strictEqual(one2('SELECT count(*) FROM public.interaction_candidates;'), '0')
    assert.strictEqual(one2(`SELECT coalesce(string_agg(coalesce(delta_link_ciphertext,'NULL'),','),'none')
      FROM public.outlook_sync_state WHERE user_id='${U1}';`), 'NULL,NULL',
    'no cursor may advance')
  })

  // ══ durable continuation, against the REAL database ══════════════════════
  console.log('\ncontinuation: several invocations, one suggestion, real SQL')

  /** Make the connection due again. See the note in the first test. */
  const makeDueNow = () => psql(
    `UPDATE public.outlook_sync_state SET next_retry_at = NULL WHERE user_id = '${U1}';`,
    { tuplesOnly: false })

  const roundRows = () => psql(`SELECT folder,
      coalesce(round_id::text,'NULL'), round_page_seq, round_pages,
      coalesce(next_link_ciphertext,'NULL'), coalesce(pending_delta_ciphertext,'NULL'),
      round_folder_complete, coalesce(delta_link_ciphertext,'NULL')
    FROM public.outlook_sync_state WHERE user_id='${U1}' ORDER BY folder;`)
    .trim().split(String.fromCharCode(10)).filter((l) => l.length > 0)
    .map((l) => l.split('|').map((s) => s.trim()))

  await test('a mailbox needing SEVERAL invocations makes progress and commits ONCE', async () => {
    await seed({ accessExpired: false })
    const graphC = pagedGraphFixture({ pages: 25, inboundAt: 22, outboundAt: 18 })
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tokenFixture().fetchImpl,
      graphFetchImpl: graphC.fetchImpl, select: ports.select, rpc: ports.rpc,
    }

    const outcomes = []
    for (let i = 0; i < 8; i += 1) {
      const r = await callWorker({ secret: WORKER_SECRET })
      outcomes.push(r)
      if (r.body?.run?.outcome !== 'continued') break
      // A CONTINUED invocation answers 200 and has committed nothing.
      assert.strictEqual(r.status, 200, r.raw.slice(0, 200))
      assert.strictEqual(r.body.run.cursors_advanced, 0)
      assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates;`), '0',
        'no suggestion may exist while the round is half-read')
      assert.strictEqual(one(`SELECT coalesce(string_agg(coalesce(delta_link_ciphertext,'NULL'),','),'none')
        FROM public.outlook_sync_state WHERE user_id='${U1}';`), 'NULL,NULL',
      'no cursor may advance while the round is half-read')
      // THE POSITION IS SAVED, AND IT IS CIPHERTEXT.
      const rows = roundRows()
      const saved = rows.map((r2) => r2[4]).filter((c) => c !== 'NULL')
      for (const ct of saved) {
        assert.ok(!ct.includes('skiptoken') && !ct.includes('graph.microsoft.com'),
          'the nextLink must be stored encrypted')
      }
      // A HEALTHY round asks to be retried soon - but nothing calls the worker, which is
      // the still-open scheduler gap. Here the harness plays the caller.
      assert.strictEqual(one(`SELECT count(*) FROM public.outlook_sync_state
        WHERE user_id='${U1}' AND next_retry_at > now();`), '2',
      'an incomplete release must set a retry time on both folders')
      makeDueNow()
    }

    assert.ok(outcomes.length >= 3, `this mailbox must need 3+ invocations (took ${outcomes.length})`)
    for (const r of outcomes.slice(0, -1)) {
      assert.strictEqual(r.body.run.outcome, 'continued', JSON.stringify(r.body.run))
    }
    const last = outcomes.at(-1)
    assert.strictEqual(last.status, 200, last.raw.slice(0, 300))
    assert.strictEqual(last.body.run.outcome, 'committed', JSON.stringify(last.body.run))
    assert.strictEqual(last.body.run.intended, 1)
    assert.strictEqual(last.body.run.accepted, 1)
    assert.strictEqual(last.body.run.created, 1)
    assert.strictEqual(last.body.run.cursors_advanced, 2)

    // MORE THAN THE OLD PER-INVOCATION CEILING: 50 pages in total.
    const pageRequests = graphC.calls.length
    assert.ok(pageRequests >= 50, `the round must exceed 20 pages (${pageRequests})`)

    // EXACTLY ONE pending suggestion, for the contact the user already had.
    assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates
      WHERE user_id='${U1}' AND source='outlook' AND status='pending';`), '1')
    assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates c
      JOIN public.contacts ct ON ct.id = c.contact_id
      WHERE ct.email='${RECRUITER}' AND ct.user_id='${U1}';`), '1')
    // No content was invented from an envelope-only pass.
    assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates
      WHERE user_id='${U1}' AND (proposed_notes IS NOT NULL OR retained_subject IS NOT NULL
        OR draft_summary IS NOT NULL OR draft_follow_up IS NOT NULL);`), '0')

    // NO CONTACT, NO INTERACTION - review before save is intact.
    assert.strictEqual(one(`SELECT count(*) FROM public.interactions WHERE user_id='${U1}';`), '0')
    assert.strictEqual(one(`SELECT count(*) FROM public.contacts WHERE user_id='${U1}';`), '1')

    // THE ROUND IS ERASED by the committing release, in the same transaction.
    assert.strictEqual(one(`SELECT count(*) FROM public.outlook_conversation_progress;`), '0',
      'a committed round must leave no accumulator rows')
    for (const row of roundRows()) {
      assert.strictEqual(row[1], 'NULL', 'the round id must be cleared')
      assert.strictEqual(row[4], 'NULL', 'the saved nextLink must be cleared')
      assert.strictEqual(row[5], 'NULL', 'the pending cursor must be cleared')
      assert.notStrictEqual(row[7], 'NULL', 'the committed cursor must now be set')
    }
  })

  await test('the accumulator held ONLY fingerprints while the round was open', async () => {
    await seed({ accessExpired: false })
    const graphC = pagedGraphFixture({ pages: 25, inboundAt: 22, outboundAt: 18 })
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tokenFixture().fetchImpl,
      graphFetchImpl: graphC.fetchImpl, select: ports.select, rpc: ports.rpc,
    }
    const r = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(r.body.run.outcome, 'continued', JSON.stringify(r.body.run))

    // Every row of the real table, as text. Nothing in it may identify anyone.
    const dump = psql(`SELECT coalesce(string_agg(to_jsonb(p)::text, ' '), 'none')
      FROM public.outlook_conversation_progress p;`).trim()
    for (const leak of [RECRUITER, ME, 'Following up', 'conv-split', 'ms-in-', 'ms-out-',
      'bank.test', 'getfunnl.test']) {
      assert.ok(!dump.includes(leak), `the accumulator must never hold ${leak}`)
    }
    // And what it DOES hold is the shape the migration promises.
    const cols = psql(`SELECT string_agg(column_name, ',' ORDER BY column_name)
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='outlook_conversation_progress';`).trim()
    for (const forbidden of ['body', 'subject', 'snippet', 'header', 'email', 'address',
      'message_id', 'conversation_id']) {
      assert.ok(!cols.includes(forbidden), `no ${forbidden} column may exist`)
    }
    for (const required of ['conversation_fingerprint', 'person_fingerprint',
      'episode_fingerprint', 'first_message_fingerprint', 'key_version']) {
      assert.ok(cols.includes(required), `${required} must exist`)
    }
    // AND NO expires_at. These records live and die with their round, whose single
    // deadline is outlook_sync_state.round_expires_at. An independent one here let an
    // early two-sided exchange age out and be deleted while the round that needed it
    // stayed valid, after which finalisation would have committed a cursor past it.
    assert.ok(!cols.split(',').includes('expires_at'),
      'a record must carry no deadline of its own')
  })

  await test('a REJECTED saved nextLink restarts the round and keeps the committed cursor', async () => {
    await seed({ accessExpired: false })
    const good = pagedGraphFixture({ pages: 25, inboundAt: 22, outboundAt: 18 })
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tokenFixture().fetchImpl,
      graphFetchImpl: good.fetchImpl, select: ports.select, rpc: ports.rpc,
    }
    // Invocation 1 saves a position.
    const first = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(first.body.run.outcome, 'continued', JSON.stringify(first.body.run))
    const savedBefore = roundRows().map((row) => row[4]).filter((c) => c !== 'NULL')
    assert.ok(savedBefore.length >= 1, 'a position must have been saved')
    // Give the connection a committed cursor to protect, as a second round would have.
    // It must be REAL ciphertext: the run context decrypts the committed cursor before the
    // round starts, so a placeholder would fail the run with cursor_undecryptable and
    // never reach the restart path at all.
    const key = await importKeyFromBase64(TOKEN_KEY_B64, webcrypto.subtle)
    const committed = {}
    for (const folder of ['inbox', 'sentitems']) {
      const link = `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=PRIOR-${folder}`
      const sealed = await encryptToken(link, key, { subtle: webcrypto.subtle })
      committed[folder] = sealed
      psql(`UPDATE public.outlook_sync_state
        SET delta_link_ciphertext = '${sealed.ciphertext}', delta_link_nonce = '${sealed.nonce}'
        WHERE user_id = '${U1}' AND folder = '${folder}';`, { tuplesOnly: false })
    }
    makeDueNow()

    // Invocation 2: Microsoft refuses the saved link.
    const rejecting = pagedGraphFixture({ pages: 25, rejectSaved: true })
    currentDeps = { ...currentDeps, graphFetchImpl: rejecting.fetchImpl }
    const r = await callWorker({ secret: WORKER_SECRET })

    // Deliberately NOT a 200: a round of reading was discarded for an external reason.
    assert.strictEqual(r.status, 503, r.raw.slice(0, 300))
    assert.strictEqual(r.body.run.outcome, 'restart_required', JSON.stringify(r.body.run))
    assert.strictEqual(r.body.run.reason, 'next_link_rejected')
    assert.strictEqual(r.body.run.round_reset, 'reset')
    assert.strictEqual(r.body.run.cursors_advanced, 0)
    assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates;`), '0')
    assert.strictEqual(one(`SELECT count(*) FROM public.outlook_conversation_progress;`), '0',
      'the discarded round must leave no accumulator rows')
    for (const row of roundRows()) {
      assert.strictEqual(row[1], 'NULL', 'the round id must be cleared')
      assert.strictEqual(row[4], 'NULL', 'the rejected position must be cleared')
      // AND THE COMMITTED CURSOR SURVIVES, byte for byte. That is what stops a rejected
      // continuation token turning into a full re-import, and what stops it skipping
      // anything: the next round restarts from the last position that genuinely was
      // ingested.
      assert.strictEqual(row[7], committed[row[0]].ciphertext,
        'the committed cursor must be untouched')
    }
  })

  // ══ finalisation spans invocations, against the REAL database ═════════════
  console.log('\nfinalisation: a large final batch resumes instead of restarting')

  await test('a batch too big for one invocation finishes across invocations, ONCE each', async () => {
    // REPRODUCED BEFORE THE FIX, with the same shape as this fixture: 40 qualifying
    // conversations at one bounded RPC each spent 800s against a 120s budget. A hard stop
    // after six left six valid pending suggestions, the round saved, both cursors
    // correctly NULL - and nothing recorded those six, so the next invocation re-listed
    // all 40 and began again at the first entry, forever.
    //
    // Here the budget is made to bite by DELAYING the database port: every RPC costs real
    // time, so the write loop cannot finish in one invocation. Nothing about the hosted
    // timeout is simulated - the worker simply measures its own clock.
    await seed({ accessExpired: false })
    const graphC = manyConversationsFixture(12)
    const ports = makePorts()
    // 1.2s per candidate write: twelve of them cannot fit inside one budget once the
    // reserve (a write, recording how far we got, and the release) is held back.
    // 300ms of real delay per write, on a clock that reports time passing 100x faster, so
    // each write costs about 30s of the 120s invocation budget. Nothing about the hosted
    // timeout is faked: the worker measures the clock it is given and stops ITSELF. A real
    // 120s budget with real 30s writes would behave identically and take minutes to run.
    const slowRpc = async (name, args) => {
      if (name === 'upsert_outlook_interaction_candidate') {
        await new Promise((r) => setTimeout(r, 300))
      }
      return ports.rpc(name, args)
    }
    const SCALE = 100
    let scaleFrom = Date.now()
    const fastClock = () => scaleFrom + (Date.now() - scaleFrom) * SCALE
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tokenFixture().fetchImpl,
      graphFetchImpl: graphC.fetchImpl, select: ports.select, rpc: slowRpc,
      now: fastClock,
    }
    const outcomes = []
    for (let i = 0; i < 20; i += 1) {
      const r = await callWorker({ secret: WORKER_SECRET })
      outcomes.push(r.body?.run?.outcome)
      if (r.body?.run?.outcome !== 'continued') break
      assert.strictEqual(r.status, 200, r.raw.slice(0, 200))
      // NO CURSOR while suggestions remain unwritten.
      assert.strictEqual(r.body.run.cursors_advanced, 0)
      assert.strictEqual(one(`SELECT coalesce(string_agg(coalesce(delta_link_ciphertext,'NULL'),','),'none')
        FROM public.outlook_sync_state WHERE user_id='${U1}';`), 'NULL,NULL',
      'no cursor may advance while the batch is unfinished')
      // The finalisation resume point IS recorded, on both folder rows.
      assert.strictEqual(one(`SELECT count(*) FROM public.outlook_sync_state
        WHERE user_id='${U1}' AND round_write_cursor ~ '^[0-9a-f]{64}$';`), '2',
      'how far finalisation got must be saved')
      makeDueNow()
      scaleFrom = Date.now()        // a fresh invocation gets a fresh budget
    }

    const last = outcomes.at(-1)
    assert.strictEqual(last, 'committed', JSON.stringify(outcomes))
    assert.ok(outcomes.length >= 3,
      `finalisation must span invocations and then finish: ${JSON.stringify(outcomes)}`)
    for (const o of outcomes.slice(0, -1)) {
      assert.strictEqual(o, 'continued', JSON.stringify(outcomes))
    }
    // EXACTLY ONE suggestion per conversation - no duplicates, none dropped.
    assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates
      WHERE user_id='${U1}' AND source='outlook' AND status='pending';`), '12')
    assert.strictEqual(one(`SELECT count(DISTINCT episode_fingerprint)
      FROM public.outlook_candidate_refs WHERE user_id='${U1}';`), '12')
    // No contact, no interaction: review before save is intact.
    assert.strictEqual(one(`SELECT count(*) FROM public.interactions WHERE user_id='${U1}';`), '0')
    assert.strictEqual(one(`SELECT count(*) FROM public.contacts WHERE user_id='${U1}';`), '1')
    // And the committed round leaves no resume point behind.
    assert.strictEqual(one(`SELECT count(*) FROM public.outlook_sync_state
      WHERE user_id='${U1}' AND round_write_cursor IS NOT NULL;`), '0')
    assert.strictEqual(one('SELECT count(*) FROM public.outlook_conversation_progress;'), '0')
  })

  await test('the finalisation resume point is lease-fenced, through real PostgREST', async () => {
    await seed({ accessExpired: false })
    const graphC = manyConversationsFixture(2)
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tokenFixture().fetchImpl,
      graphFetchImpl: graphC.fetchImpl, select: ports.select, rpc: ports.rpc,
    }
    const r = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(r.body.run.outcome, 'committed', JSON.stringify(r.body.run))

    // A run that does not own the leases cannot move the resume point. Asked as the
    // service role over real HTTP, which is the only way the worker ever asks.
    const stale = await ports.rpc('advance_outlook_round_write_cursor', {
      p_connection_id: one(`SELECT id FROM public.microsoft_connections WHERE user_id='${U1}';`),
      p_run_id: '99999999-9999-9999-9999-999999999999',
      p_round_id: '88888888-8888-8888-8888-888888888888',
      p_after: 'a'.repeat(64),
    })
    assert.strictEqual(stale.error, null, JSON.stringify(stale.error))
    assert.strictEqual(stale.data.result, 'stale_run', JSON.stringify(stale.data))
    assert.strictEqual(one(`SELECT count(*) FROM public.outlook_sync_state
      WHERE user_id='${U1}' AND round_write_cursor IS NOT NULL;`), '0')
  })

  // ══ the accumulator read-back must fit the port's body bound ══════════════
  console.log('\nthe round read-back is paged, because the port bounds every response')

  /**
   * Fill a round with `n` accumulator rows at their WIDEST realistic shape: every
   * fingerprint present and a lookup array carrying two keys, as a rotation in flight
   * would. Measured at 602 bytes per row in the response, so the whole-round ceiling of
   * 2000 serialises to about 1.18 MiB.
   */
  const fillRound = (n) => psql(`
DO $fill$
DECLARE
  k uuid; r uuid; s uuid; cid uuid; i integer; fp text;
BEGIN
  SELECT id INTO k FROM public.microsoft_connections WHERE user_id = '${U1}';
  SELECT id INTO cid FROM public.contacts WHERE user_id = '${U1}' LIMIT 1;
  SELECT sync_run_id, round_id INTO s, r FROM public.outlook_sync_state
   WHERE connection_id = k LIMIT 1;
  IF r IS NULL THEN
    r := '00000000-0000-0000-0000-0000000000a1'::uuid;
    UPDATE public.outlook_sync_state SET round_id = r, round_started_at = now(),
           round_expires_at = now() + interval '1 day' WHERE connection_id = k;
  END IF;
  FOR i IN 1..${n} LOOP
    fp := lpad(to_hex(i), 64, '0');
    INSERT INTO public.outlook_conversation_progress (
      connection_id, user_id, round_id, conversation_fingerprint,
      person_fingerprint, episode_fingerprint, episode_lookup_fingerprints,
      first_message_fingerprint, key_version, contact_id,
      first_seen_at, last_seen_at, inbound_count, outbound_count, message_count,
      taint_code)
    VALUES (k, '${U1}', r, fp,
            lpad(to_hex(i + 9000000), 64, '0'), lpad(to_hex(i + 8000000), 64, '0'),
            ARRAY[lpad(to_hex(i + 8000000), 64, '0'), lpad(to_hex(i + 7000000), 64, '0')],
            lpad(to_hex(i + 6000000), 64, '0'), 1, cid,
            now() - interval '2 days', now() - interval '1 day', 2, 1, 3,
            NULL)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $fill$;`, { tuplesOnly: false })

  await test('THE OVERSIZED READ-BACK: the whole-round ceiling in one response is refused', async () => {
    await seed({ accessExpired: false })
    // A real reservation, so the round rows exist and the lease fence is satisfied.
    psql(`SELECT public.reserve_due_outlook_connection(600, 0);`, { tuplesOnly: false })
    fillRound(MAX_CONVERSATIONS_PER_ROUND)
    assert.strictEqual(one('SELECT count(*) FROM public.outlook_conversation_progress;'),
      String(MAX_CONVERSATIONS_PER_ROUND))

    const conn = one(`SELECT id FROM public.microsoft_connections WHERE user_id='${U1}';`)
    const st = psql(`SELECT sync_run_id, round_id FROM public.outlook_sync_state
      WHERE connection_id='${conn}' LIMIT 1;`).trim().split('|').map((s) => s.trim())

    // THE DEPLOYED PORT, not the harness mirror: this is the bounding that ships -
    // readJsonBounded at MAX_PROVIDER_BODY_BYTES, redirect: 'error', DB_TIMEOUT_MS and the
    // real headers. The ONE adaptation is the path: makePostgrestPorts targets Supabase's
    // gateway at /rest/v1/, and a bare PostgREST container serves at /, so the fetch is
    // wrapped to drop that prefix. Nothing about the bounding is changed.
    const deployed = makePostgrestPorts({
      url: PGRST,
      serviceRoleKey: mintServiceJwt(),
      fetchImpl: (u, init) => fetch(String(u).replace('/rest/v1/', '/'), init),
    })

    // THE HAZARD IS REAL, measured on these exact rows: the whole round in one response
    // is about 1.18 MiB, four and a half times what the port will read. Shown through the
    // SAME port on the SAME data, so this is the bound biting rather than an estimate.
    const sizeBytes = Number(one(`SELECT octet_length(jsonb_agg(jsonb_build_object(
        'cfp', conversation_fingerprint, 'pfp', person_fingerprint,
        'efp', episode_fingerprint, 'elookup', episode_lookup_fingerprints,
        'contact_id', contact_id, 'key_version', key_version,
        'first_at', first_seen_at, 'last_at', last_seen_at,
        'inbound', inbound_count, 'outbound', outbound_count,
        'messages', message_count, 'taint', taint_code))::text)
      FROM public.outlook_conversation_progress;`))
    assert.ok(sizeBytes > MAX_PROVIDER_BODY_BYTES * 4,
      `the whole round must be far over the bound: ${(sizeBytes / 1024).toFixed(1)} KiB`)
    const wholeRead = await deployed.select(
      'outlook_conversation_progress?select=conversation_fingerprint,person_fingerprint,' +
      'episode_fingerprint,episode_lookup_fingerprints,first_message_fingerprint,' +
      `contact_id,key_version,first_seen_at,last_seen_at,inbound_count,outbound_count,` +
      `message_count,taint_code&limit=${MAX_CONVERSATIONS_PER_ROUND}`)
    // 'malformed' is specifically what the port reports when readJsonBounded refuses a
    // body for being over MAX_PROVIDER_BODY_BYTES. Asserting the CODE, not merely that
    // something failed, is what makes this prove the bound rather than, say, a bad path.
    assert.strictEqual(wholeRead.error?.code, 'malformed',
      `the oversized body must be refused by the bound, got ${JSON.stringify(wholeRead.error)}` +
      ` / ${wholeRead.data?.length} rows`)

    // AND THE RPC CAN NO LONGER PRODUCE ONE. Asking for the whole round - which is what
    // the first version of this slice did - now yields one page and says there is more.
    const whole = await deployed.rpc('list_outlook_round_conversations', {
      p_connection_id: conn, p_run_id: st[0], p_round_id: st[1],
      p_limit: MAX_CONVERSATIONS_PER_ROUND, p_after: null,
    })
    assert.strictEqual(whole.error, null, JSON.stringify(whole.error))
    assert.strictEqual(whole.data.conversations.length, CONVERSATION_PAGE_SIZE,
      'the server caps the page, so a caller cannot ask for a body its own port refuses')
    assert.strictEqual(whole.data.more_rows, true)

    // And ONE PAGE of the same rows is accepted, with room to spare.
    const page = await deployed.rpc('list_outlook_round_conversations', {
      p_connection_id: conn, p_run_id: st[0], p_round_id: st[1],
      p_limit: CONVERSATION_PAGE_SIZE, p_after: null,
    })
    assert.strictEqual(page.error, null, JSON.stringify(page.error))
    assert.strictEqual(page.data.result, 'ok')
    assert.strictEqual(page.data.conversations.length, CONVERSATION_PAGE_SIZE)
    assert.strictEqual(page.data.more_rows, true, 'the page must say more rows remain')
    const bytes = Buffer.byteLength(JSON.stringify(page.data))
    assert.ok(bytes < MAX_PROVIDER_BODY_BYTES / 2,
      `a page must sit well inside the bound: ${(bytes / 1024).toFixed(1)} KiB`)

    // The ordered write cursor is what resumes it, and the pages do not overlap.
    const last = page.data.conversations.at(-1).cfp
    const next = await deployed.rpc('list_outlook_round_conversations', {
      p_connection_id: conn, p_run_id: st[0], p_round_id: st[1],
      p_limit: CONVERSATION_PAGE_SIZE, p_after: last,
    })
    assert.strictEqual(next.error, null, JSON.stringify(next.error))
    assert.ok(next.data.conversations.every((c) => c.cfp > last), 'pages must not overlap')
    assert.strictEqual(next.data.conversations.length, CONVERSATION_PAGE_SIZE)

    // Walking the whole round a page at a time reaches every row exactly once.
    let cursor = null
    let seen = 0
    const distinct = new Set()
    for (let i = 0; i < 40; i += 1) {
      const r = await deployed.rpc('list_outlook_round_conversations', {
        p_connection_id: conn, p_run_id: st[0], p_round_id: st[1],
        p_limit: CONVERSATION_PAGE_SIZE, p_after: cursor,
      })
      assert.strictEqual(r.error, null, JSON.stringify(r.error))
      for (const c of r.data.conversations) { distinct.add(c.cfp); seen += 1 }
      if (!r.data.more_rows) break
      cursor = r.data.conversations.at(-1).cfp
    }
    assert.strictEqual(seen, MAX_CONVERSATIONS_PER_ROUND)
    assert.strictEqual(distinct.size, MAX_CONVERSATIONS_PER_ROUND, 'no row twice, none missed')
  })

  // ══ round expiry, through the real worker and the real SQL ════════════════
  console.log('\nexpiry: a round is discarded as one unit, and a new one can start')

  /** Age the round past its deadline, which is what a long import does to it. */
  const expireRound = () => psql(
    `UPDATE public.outlook_sync_state SET round_expires_at = now() - interval '1 second'
      WHERE user_id = '${U1}';`, { tuplesOnly: false })

  const roundState = () => psql(`SELECT folder,
      coalesce(round_id::text,'NULL'), round_pages,
      coalesce(round_expires_at::text,'NULL'),
      coalesce(delta_link_ciphertext,'NULL')
    FROM public.outlook_sync_state WHERE user_id='${U1}' ORDER BY folder;`)
    .trim().split(String.fromCharCode(10)).filter((l) => l.length > 0)
    .map((l) => l.split('|').map((s) => s.trim()))

  await test('AN EXPIRED ROUND does not get stuck: a new one starts and makes progress', async () => {
    // REPRODUCED BEFORE THE FIX against this same SQL: read_outlook_round_progress
    // reported an expired round as ABSENT, the worker chose a new round id, and because
    // the old id was still on the folder rows every checkpoint answered round_mismatch -
    // forever. The committed cursor was never touched, so nothing was lost; nothing
    // progressed either.
    await seed({ accessExpired: false })
    const graphC = pagedGraphFixture({ pages: 25, inboundAt: 22, outboundAt: 18 })
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tokenFixture().fetchImpl,
      graphFetchImpl: graphC.fetchImpl, select: ports.select, rpc: ports.rpc,
    }

    // One invocation reads part of the round and saves where it got to.
    const first = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(first.body.run.outcome, 'continued', JSON.stringify(first.body.run))
    const before = roundState()
    const oldRound = before[0][1]
    assert.notStrictEqual(oldRound, 'NULL', 'a round must be saved')
    assert.strictEqual(before[0][1], before[1][1], 'both folders share the round id')
    assert.strictEqual(before[0][3], before[1][3],
      'and ONE deadline, identical on both rows')
    assert.ok(Number(before[0][2]) > 0, 'with pages recorded')
    assert.strictEqual(before[0][4], 'NULL', 'and no committed cursor yet')

    // The deadline passes.
    expireRound()
    makeDueNow()

    const second = await callWorker({ secret: WORKER_SECRET })
    // IT MAKES PROGRESS, where before every page was refused.
    assert.ok(['continued', 'committed'].includes(second.body.run.outcome),
      `an expired round must not get stuck: ${JSON.stringify(second.body.run)}`)
    assert.strictEqual(second.body.run.round_expired, true,
      'and the run must say it threw one away')
    assert.strictEqual(second.body.run.round_reset, 'reset')

    const after = roundState()
    assert.notStrictEqual(after[0][1], oldRound, 'a NEW round id')
    assert.strictEqual(after[0][1], after[1][1], 'on both folders')
    assert.strictEqual(after[0][3], after[1][3], 'with one shared deadline')
    // The discarded round left no records behind.
    assert.strictEqual(one(`SELECT count(*) FROM public.outlook_conversation_progress p
      JOIN public.microsoft_connections c ON c.id = p.connection_id
      WHERE c.user_id='${U1}' AND p.round_id::text='${oldRound}';`), '0')
    // AND THE COMMITTED CURSOR NEVER MOVED, so the new round re-reads from a position
    // that genuinely was ingested: it costs pages, and skips nothing.
    assert.strictEqual(one(`SELECT coalesce(string_agg(coalesce(delta_link_ciphertext,'NULL'),','),'none')
      FROM public.outlook_sync_state WHERE user_id='${U1}';`), 'NULL,NULL')
    assert.strictEqual(one('SELECT count(*) FROM public.interaction_candidates;'), '0',
      'and nothing was suggested from a round that was thrown away')
  })

  await test('a long import still reaches ONE suggestion with a round expiring part-way', async () => {
    await seed({ accessExpired: false })
    const graphC = pagedGraphFixture({ pages: 25, inboundAt: 22, outboundAt: 18 })
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tokenFixture().fetchImpl,
      graphFetchImpl: graphC.fetchImpl, select: ports.select, rpc: ports.rpc,
    }
    let outcome = null
    let expiries = 0
    for (let i = 0; i < 20; i += 1) {
      const r = await callWorker({ secret: WORKER_SECRET })
      if (r.body?.run?.round_expired === true) expiries += 1
      outcome = r.body?.run?.outcome
      if (outcome !== 'continued') break
      // The deadline passes once, in the middle of the import.
      if (i === 1) expireRound()
      makeDueNow()
    }
    assert.strictEqual(expiries, 1, 'exactly one round was discarded')
    assert.strictEqual(outcome, 'committed', `and the import still finished: ${outcome}`)
    assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates
      WHERE user_id='${U1}' AND source='outlook' AND status='pending';`), '1',
    'exactly one pending suggestion, after the rework')
    assert.strictEqual(one(`SELECT count(*) FROM public.interactions WHERE user_id='${U1}';`), '0')
  })

  await test('a round that expires MID-RUN commits no cursor and leaves no records', async () => {
    await seed({ accessExpired: false })
    const graphC = pagedGraphFixture({ pages: 1, inboundAt: 1, outboundAt: 1 })
    const ports = makePorts()
    // Expire the round between the last checkpoint and finalisation, by ageing it the
    // moment the final page is recorded.
    let expired = false
    const racingRpc = async (name, args) => {
      const res = await ports.rpc(name, args)
      if (!expired && name === 'record_outlook_page_progress'
          && args?.p_folder === 'sentitems' && args?.p_folder_complete === true) {
        expired = true
        expireRound()
      }
      return res
    }
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tokenFixture().fetchImpl,
      graphFetchImpl: graphC.fetchImpl, select: ports.select, rpc: racingRpc,
    }
    const r = await callWorker({ secret: WORKER_SECRET })
    assert.ok(expired, 'the round must actually have been aged mid-run')
    assert.strictEqual(r.body.run.outcome, 'incomplete', JSON.stringify(r.body.run))
    assert.deepStrictEqual(r.body.run.incomplete_reasons, ['round_expired'])
    assert.strictEqual(r.body.run.cursors_advanced, 0,
      'NOTHING may be committed from a dead round')
    assert.strictEqual(one(`SELECT coalesce(string_agg(coalesce(delta_link_ciphertext,'NULL'),','),'none')
      FROM public.outlook_sync_state WHERE user_id='${U1}';`), 'NULL,NULL')
    assert.strictEqual(one('SELECT count(*) FROM public.interaction_candidates;'), '0')
  })

  await test('one folder expiring expires the ROUND, not half of it', async () => {
    await seed({ accessExpired: false })
    const graphC = pagedGraphFixture({ pages: 25, inboundAt: 22, outboundAt: 18 })
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tokenFixture().fetchImpl,
      graphFetchImpl: graphC.fetchImpl, select: ports.select, rpc: ports.rpc,
    }
    const first = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(first.body.run.outcome, 'continued', JSON.stringify(first.body.run))
    const oldRound = roundState()[0][1]

    // Only Sent Items is aged. The deadline is written to both rows at once so they
    // cannot normally differ; if they ever did, the EARLIER one must govern, or one folder
    // reports a round the other does not and a run resumes half of one.
    psql(`UPDATE public.outlook_sync_state
      SET round_expires_at = now() - interval '1 second'
      WHERE user_id = '${U1}' AND folder = 'sentitems';`, { tuplesOnly: false })
    makeDueNow()

    const second = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(second.body.run.round_expired, true,
      `the earlier deadline must govern: ${JSON.stringify(second.body.run)}`)
    const after = roundState()
    assert.notStrictEqual(after[0][1], oldRound)
    assert.strictEqual(after[0][1], after[1][1],
      'both folders must end up on the SAME new round')
    assert.strictEqual(after[0][3], after[1][3], 'sharing one deadline again')
  })

  // ══ refusals ══════════════════════════════════════════════════════════════
  console.log('\nrefusals: nothing claims a cursor advanced')

  await test('a REFRESH REJECTED by the provider commits nothing and advances nothing', async () => {
    await seed({ accessExpired: true })
    // Seeding deletes the connection, which cascades the sync-state rows, so there is
    // nothing to compare against - the assertion below is simply that no cursor exists
    // after the failed run.
    const bad = tokenFixture({ status: 400, body: { error: 'invalid_grant' } })
    const graph3 = graphFixture()
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: bad.fetchImpl,
      graphFetchImpl: graph3.fetchImpl, select: ports.select, rpc: ports.rpc,
    }
    const r = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(r.status, 503, r.raw.slice(0, 200))
    assert.strictEqual(r.body.run.outcome, 'released_error')
    assert.strictEqual(r.body.run.reason, 'refresh_failed')
    assert.strictEqual(r.body.run.cursors_advanced, 0)
    assert.strictEqual(graph3.calls.length, 0, 'Graph must not be called without a token')
    assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates;`), '0')
    assert.strictEqual(one(`SELECT coalesce(string_agg(coalesce(delta_link_ciphertext,'NULL'),','),'none')
      FROM public.outlook_sync_state WHERE user_id='${U1}';`), 'NULL,NULL',
    'a failed refresh must leave both cursors unset')
    // The lease was released, not left held.
    assert.strictEqual(one(`SELECT DISTINCT sync_status FROM public.outlook_sync_state WHERE user_id='${U1}';`), 'error')
  })

  await test('a WRONG encryption key cannot decrypt, and nothing runs', async () => {
    await seed({ accessExpired: false })
    const graph4 = graphFixture()
    const ports = makePorts()
    currentEnv = { ...baseEnv(), tokenKeyB64: Buffer.from(randomBytes(32)).toString('base64') }
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tokenFixture().fetchImpl,
      graphFetchImpl: graph4.fetchImpl, select: ports.select, rpc: ports.rpc,
    }
    const r = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(r.status, 503)
    assert.strictEqual(r.body.run.reason, 'token_undecryptable')
    assert.strictEqual(graph4.calls.length, 0)
    assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates;`), '0')
  })

  await test('the SCHEMA guarantees a refresh token exists, so that branch is defensive', async () => {
    // Observed, not assumed: microsoft_tokens.refresh_token_ciphertext is NOT NULL
    // (20260921000000), while access_token_ciphertext is nullable. So a connection
    // always has something to refresh WITH, and the loader's 'no refresh token' branch
    // cannot be reached through the applied schema - it stays as a defensive guard
    // rather than a tested path, which is worth stating instead of implying coverage.
    const nullable = psql(`SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name='microsoft_tokens'
        AND column_name IN ('access_token_ciphertext','refresh_token_ciphertext')
      ORDER BY column_name;`).trim().split(String.fromCharCode(10))
    assert.deepStrictEqual(nullable, ['access_token_ciphertext|YES', 'refresh_token_ciphertext|NO'])
    // Trying to store one anyway is refused by the database.
    const refused = spawnSync('docker',
      ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'],
      { input: `UPDATE public.microsoft_tokens SET refresh_token_ciphertext = NULL;`, encoding: 'utf8' })
    assert.notStrictEqual(refused.status, 0, 'the NOT NULL constraint must refuse it')
  })

  await test('an ABSENT access token is refreshed, which is the reachable stale case', async () => {
    await seed({ accessExpired: false, withAccessToken: false })
    const tok3 = tokenFixture()
    const graph7 = graphFixture()
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tok3.fetchImpl,
      graphFetchImpl: graph7.fetchImpl, select: ports.select, rpc: ports.rpc,
    }
    const r = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(r.status, 200, r.raw.slice(0, 200))
    assert.strictEqual(r.body.run.outcome, 'committed')
    assert.strictEqual(tok3.calls.length, 1, 'an absent access token must trigger a refresh')
    for (const c of graph7.calls) {
      assert.strictEqual(c.bearer, `Bearer ${REFRESHED_ACCESS}`)
    }
  })

  await test('a GRAPH failure leaves an incomplete run with no cursor and no candidate', async () => {
    await seed({ accessExpired: false })
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL,
      fetchImpl: tokenFixture().fetchImpl,
      graphFetchImpl: async () => ({ status: 503, headers: { get: () => null }, json: async () => ({}) }),
      select: ports.select, rpc: ports.rpc,
    }
    const r = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(r.status, 200, 'an incomplete run is a correct outcome, not a server error')
    assert.strictEqual(r.body.run.outcome, 'incomplete')
    assert.ok(r.body.run.incomplete_reasons.includes('folder_incomplete'))
    assert.strictEqual(r.body.run.cursors_advanced, 0)
    assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates;`), '0')
    assert.strictEqual(one(`SELECT coalesce(delta_link_ciphertext,'NULL') FROM public.outlook_sync_state
      WHERE user_id='${U1}' AND folder='inbox';`), 'NULL')
  })

  await test('nothing due is a 200 that claims no work', async () => {
    psql(`UPDATE public.microsoft_connections SET status='revoked' WHERE user_id='${U1}';`,
      { tuplesOnly: false })
    const ports = makePorts()
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tokenFixture().fetchImpl,
      graphFetchImpl: graphFixture().fetchImpl, select: ports.select, rpc: ports.rpc,
    }
    const r = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.run.outcome, 'none_due')
    assert.strictEqual(r.body.run.cursors_advanced, 0)
    assert.strictEqual(r.body.run.intended, 0)
  })

  await test('a rotation refused by the lease fence stops the run before any Graph call', async () => {
    await seed({ accessExpired: true })
    const graph6 = graphFixture()
    const ports = makePorts()
    // Break the rotation by expiring the lease the moment it is taken: the reserve
    // succeeds, then the rotate RPC sees a stale run.
    const fencedRpc = async (name, args) => {
      const out = await ports.rpc(name, args)
      if (name === 'reserve_due_outlook_connection' && out?.data?.result === 'reserved') {
        psql(`UPDATE public.outlook_sync_state SET sync_lease_until = now() - interval '1 minute'
              WHERE connection_id='${out.data.connection_id}';`, { tuplesOnly: false })
      }
      return out
    }
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tokenFixture().fetchImpl,
      graphFetchImpl: graph6.fetchImpl, select: ports.select, rpc: fencedRpc,
    }
    const r = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(r.status, 503)
    assert.strictEqual(r.body.run.reason, 'rotation_not_persisted')
    assert.strictEqual(graph6.calls.length, 0, 'no mailbox read may happen on a lost lease')
    assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates;`), '0')
  })
  // ══ PILOT ISOLATION: what happens to an EXCLUDED user's connection ═══════
  // The reservation has no user predicate, so it hands the run whichever connection
  // is DUE - for anyone. These cases measure what the run does with one that belongs
  // to somebody who is not the designated pilot account, through the real handler,
  // real PostgREST and a real Postgres.
  console.log('\nan EXCLUDED user is refused before any Microsoft or database effect')

  await test('a non-pilot connection with an EXPIRED token: no provider call, no write',
    async () => {
      // Only U2 has a due connection; U1 is the designated pilot. The token is EXPIRED,
      // so the context load would refresh it at Microsoft and persist the rotation. Every
      // side effect is RECORDED first and asserted afterwards, so one run reports all of
      // them instead of stopping at whichever fails first.
      await seed({ accessExpired: true, owner: U2 })
      const ports = makePorts()
      const t = tokenFixture()
      const g = graphFixture()
      currentEnv = { ...baseEnv(), pilotUserId: U1 }
      currentDeps = {
        tokenUrl: FIXTURE_TOKEN_URL,
        fetchImpl: t.fetchImpl,
        graphFetchImpl: g.fetchImpl,
        select: ports.select,
        rpc: ports.rpc,
      }
      const snap = () => ({
        acc: one(`SELECT coalesce(access_token_ciphertext,'NONE')
          FROM public.microsoft_tokens WHERE user_id='${U2}';`),
        exp: one(`SELECT coalesce(token_expires_at::text,'NONE')
          FROM public.microsoft_tokens WHERE user_id='${U2}';`),
        upd: one(`SELECT updated_at::text FROM public.microsoft_tokens
          WHERE user_id='${U2}';`),
      })
      const before = snap()

      const r = await callWorker({ secret: WORKER_SECRET })
      const after = snap()

      const observed = {
        outcome: r.body?.run?.outcome ?? r.body?.error ?? r.status,
        tokenEndpointCalls: t.calls.length,
        tokenGrant: t.calls[0]?.grant ?? null,
        graphCalls: g.calls.length,
        accessTokenRewritten: after.acc !== before.acc,
        expiryRewritten: after.exp !== before.exp,
        tokenRowWritten: after.upd !== before.upd,
        foldersLeased: Number(one(`SELECT count(*) FROM public.outlook_sync_state
          WHERE user_id='${U2}';`)),
        candidates: Number(one(`SELECT count(*) FROM public.interaction_candidates
          WHERE user_id='${U2}';`)),
        interactions: Number(one(`SELECT count(*) FROM public.interactions
          WHERE user_id='${U2}';`)),
        cursorsAdvanced: Number(one(`SELECT count(*) FROM public.outlook_sync_state
          WHERE user_id='${U2}' AND (delta_link_ciphertext IS NOT NULL
             OR next_link_ciphertext IS NOT NULL);`)),
      }
      console.log(`      observed: ${JSON.stringify(observed)}`)

      assert.deepStrictEqual(observed, {
        // `none_due`, not `not_in_pilot`, and that is the stronger answer: the
        // reservation is now narrowed to the designated account, so an excluded
        // connection is not refused - it is never offered. From the worker's side
        // there is simply nothing due. Before the change this read
        // {"outcome":"not_in_pilot","tokenEndpointCalls":1,
        //  "tokenGrant":"refresh_token","accessTokenRewritten":true,
        //  "expiryRewritten":true,"tokenRowWritten":true,"foldersLeased":2}.
        outcome: 'none_due',
        // NO MICROSOFT CALL. This is what the earlier placement could not give: the
        // check sat AFTER loadRunContext, which refreshes an expired access token at
        // Microsoft and persists the rotated refresh token before returning.
        tokenEndpointCalls: 0,
        tokenGrant: null,
        graphCalls: 0,
        // NO WRITE of any kind on their rows.
        accessTokenRewritten: false,
        expiryRewritten: false,
        tokenRowWritten: false,
        // AND NEVER EVEN RESERVED - no lease was taken on their folder rows.
        foldersLeased: 0,
        candidates: 0,
        interactions: 0,
        cursorsAdvanced: 0,
      })
    })
  await test('the excluded connection is never even RESERVED', async () => {
    // The strongest form: not refused after being leased, but never chosen. Measured
    // by whether the reservation left a lease on its folder rows at all.
    const leased = one(`SELECT count(*) FROM public.outlook_sync_state WHERE user_id='${U2}';`)
    assert.strictEqual(leased, '0',
      `the excluded connection had ${leased} folder rows created by a reservation`)
  })

  await test('two due connections: the PILOT progresses, the excluded one untouched',
    async () => {
      // U1 (the pilot) and U2 (excluded) both have an active, consented, due
      // connection with an expired token. Invoked repeatedly, every invocation must
      // go to the pilot and none may be spent on - or leak into - the excluded one.
      await seed({ accessExpired: true, owner: U1, alsoSeedExcluded: true })
      const ports = makePorts()
      const picks = []
      const excludedTokenCalls = []
      const excludedBefore = one(`SELECT access_token_ciphertext || updated_at::text
        FROM public.microsoft_tokens WHERE user_id='${U2}';`)
      for (let i = 0; i < 3; i++) {
        const t = tokenFixture()
        const g = graphFixture()
        currentEnv = { ...baseEnv(), pilotUserId: U1 }
        currentDeps = {
          tokenUrl: FIXTURE_TOKEN_URL,
          fetchImpl: t.fetchImpl,
          graphFetchImpl: g.fetchImpl,
          select: ports.select,
          rpc: ports.rpc,
        }
        const r = await callWorker({ secret: WORKER_SECRET })
        picks.push(r.body?.run?.outcome ?? r.body?.error ?? r.status)
        excludedTokenCalls.push(t.calls.length)
        // Hand the PILOT's lease back so the next invocation is a real choice
        // between two due connections rather than one blocked by a live lease.
        psql(`UPDATE public.outlook_sync_state SET sync_status='idle',
          sync_lease_until=NULL, next_retry_at=NULL, last_success_at=NULL
          WHERE user_id='${U1}';`, { tuplesOnly: false })
      }
      console.log(`      picks: ${JSON.stringify(picks)}`)

      // NO invocation was consumed by the excluded account.
      assert.ok(!picks.includes('not_in_pilot'),
        `an invocation went to the excluded connection: ${JSON.stringify(picks)}`)
      // The pilot made real progress.
      assert.ok(picks.includes('committed'),
        `the pilot never committed: ${JSON.stringify(picks)}`)
      assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates
        WHERE user_id='${U1}' AND source='outlook' AND status='pending';`), '1')

      // THE EXCLUDED CONNECTION IS UNTOUCHED, on every measure.
      assert.strictEqual(one(`SELECT count(*) FROM public.outlook_sync_state
        WHERE user_id='${U2}';`), '0', 'the excluded connection was reserved')
      assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates
        WHERE user_id='${U2}';`), '0')
      assert.strictEqual(one(`SELECT count(*) FROM public.interactions
        WHERE user_id='${U2}';`), '0')
      // Their stored credentials are byte-for-byte what they were.
      assert.strictEqual(one(`SELECT access_token_ciphertext || updated_at::text
        FROM public.microsoft_tokens WHERE user_id='${U2}';`), excludedBefore,
      'the excluded token row was rewritten')
    })
  await test('with NO designated pilot, nothing is reserved at all', async () => {
    await seed({ accessExpired: true, owner: U1 })
    const ports = makePorts()
    const t = tokenFixture()
    currentEnv = { ...baseEnv(), pilotUserId: '*' }
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL,
      fetchImpl: t.fetchImpl,
      graphFetchImpl: graphFixture().fetchImpl,
      select: ports.select,
      rpc: ports.rpc,
    }
    const r = await callWorker({ secret: WORKER_SECRET })
    assert.notStrictEqual(r.status, 200, r.raw.slice(0, 200))
    assert.deepStrictEqual(t.calls, [])
    assert.strictEqual(one(`SELECT count(*) FROM public.outlook_sync_state;`), '0',
      'a malformed designation still reserved something')
  })

  // ══ wake-ups across a PAUSED round, against the REAL database and the REAL worker ═══
  console.log('\nwake-ups: a signal that arrives while finalisation is paused must survive the resuming invocation')

  await test('run A pauses in finalisation; new mail is signalled; run B completes the OLD round and leaves the signal pending; run C reads the mail and consumes it', async () => {
    // REPRODUCED BEFORE THE FIX, exactly this way: the consume trigger compared the wake-up
    // with the resuming invocation's lease start. Run B's lease began after the signal, so
    // completing A's round cleared a signal about mail that no delta read had ever seen.
    await seed({ accessExpired: false })
    const connId = one(`SELECT id FROM public.microsoft_connections WHERE user_id='${U1}';`)
    const HASH = '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e'  // sha256('client-state-one')
    psql(`INSERT INTO public.outlook_subscriptions (connection_id, user_id, subscription_id, client_state_hash, status, expires_at)
          VALUES ('${connId}', '${U1}', 'sub-pause', '${HASH}', 'active', now() + interval '2 days');`, { tuplesOnly: false })
    const graphC = manyConversationsFixture(12)
    const ports = makePorts()
    const slowRpc = async (name, args) => {
      if (name === 'upsert_outlook_interaction_candidate') await new Promise((r) => setTimeout(r, 300))
      return ports.rpc(name, args)
    }
    const SCALE = 100
    let scaleFrom = Date.now()
    const fastClock = () => scaleFrom + (Date.now() - scaleFrom) * SCALE
    currentEnv = baseEnv()
    currentDeps = {
      tokenUrl: FIXTURE_TOKEN_URL, fetchImpl: tokenFixture().fetchImpl,
      graphFetchImpl: graphC.fetchImpl, select: ports.select, rpc: slowRpc, now: fastClock,
    }
    // RUN A: discovery finishes on the first page of each folder; finalisation pauses.
    const a = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(a.body?.run?.outcome, 'continued', a.raw.slice(0, 300))
    assert.strictEqual(one(`SELECT count(*) FROM public.outlook_sync_state WHERE user_id='${U1}' AND round_folder_complete;`), '2',
      'both folders were discovered by run A')
    const graphCallsAfterA = graphC.calls.length

    // NEW MAIL ARRIVES: Microsoft signals, and the endpoint records the wake-up through the
    // same RPC it calls in production (as the service role, over real PostgREST).
    await new Promise((r) => setTimeout(r, 60))
    const n = await ports.rpc('record_outlook_change_notification', { p_subscription_id: 'sub-pause', p_client_state_hash: HASH, p_kind: 'change' })
    assert.strictEqual(n.data?.result, 'accepted', JSON.stringify(n))
    const wakeAt = one(`SELECT wake_requested_at::text FROM public.microsoft_connections WHERE id='${connId}';`)
    assert.ok(wakeAt && wakeAt !== 'NULL', 'the wake-up is recorded')

    // RUN B (and C, D... while 'continued'): the SAME round is resumed, discovery is skipped.
    makeDueNow(); scaleFrom = Date.now()
    const outcomes = []
    for (let i = 0; i < 20; i += 1) {
      const r = await callWorker({ secret: WORKER_SECRET })
      outcomes.push(r.body?.run?.outcome)
      if (r.body?.run?.outcome !== 'continued') break
      makeDueNow(); scaleFrom = Date.now()
    }
    assert.strictEqual(outcomes.at(-1), 'committed', JSON.stringify(outcomes))
    assert.strictEqual(graphC.calls.length, graphCallsAfterA,
      'the resuming invocations re-read nothing: the signalled mail was never discovered by this round')
    assert.strictEqual(one(`SELECT coalesce(wake_requested_at::text,'NULL') FROM public.microsoft_connections WHERE id='${connId}';`), wakeAt,
      'THE DEFECT: a signal newer than the completed round\'s discovery must stay pending')

    // RUN C: due by the wake-up ALONE - no makeDueNow, a fresh delta round, which finds the
    // 13th conversation (the signalled mail) and consumes the signal.
    const graphD = manyConversationsFixture(13)
    currentDeps = { ...currentDeps, graphFetchImpl: graphD.fetchImpl, rpc: ports.rpc }
    scaleFrom = Date.now()
    const c = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(c.body?.run?.outcome, 'committed', c.raw.slice(0, 300))
    assert.ok(Number.isInteger(c.body.run.wake_age_seconds), 'the run reports how old the signal was: ' + JSON.stringify(c.body.run.wake_age_seconds))
    assert.strictEqual(c.body.run.created, 1, 'the signalled mail is proposed once: ' + JSON.stringify(c.body.run.write_results))
    assert.strictEqual(one(`SELECT coalesce(wake_requested_at::text,'NULL') FROM public.microsoft_connections WHERE id='${connId}';`), 'NULL',
      'consumed by the round that actually read it')
    assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates WHERE user_id='${U1}' AND source='outlook' AND status='pending';`), '13')
    assert.strictEqual(one(`SELECT count(*) FROM public.interactions WHERE user_id='${U1}';`), '0', 'review before save is intact')
    // And a signal that arrives DURING a fresh run is kept for the next one (lease + cutoff).
    const d = await callWorker({ secret: WORKER_SECRET })
    assert.strictEqual(d.body?.run?.outcome, 'none_due', 'nothing is due after the consuming run: ' + d.raw.slice(0, 120))
  })

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
}

try { await main() } catch (e) { console.error(`\nHARNESS ERROR: ${e.message}`); failed++ }
finally {
  if (server) server.close()
  teardown()
}
