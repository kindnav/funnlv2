// The deployed worker's token access: the refresh grant, the run-context loader, the
// database ports, the configuration gate, and the lease-renewal timing case.
//
// WHAT IS EXERCISED HERE. Every function below is driven with injected ports and
// fixture provider responses, so the decisions are executed: which grant is sent and
// with what redirect policy, what a refresh response must contain, when a stored token
// counts as stale, that a rotated refresh token is persisted BEFORE the run uses it,
// that a missing secret refuses before anything is read, and that a lease renewal that
// does not confirm stops the pass.
//
// WHAT IS NOT. No Microsoft, no network, no browser, no deployed function. The fixtures
// show what the code does GIVEN a response of that shape; they are not evidence that
// Microsoft produces that shape. The database-backed behaviour (the rotation RPC's fence
// and optional refresh pair) is proven against a real Postgres by
// tests/sql/outlook-token-rotation-runtime.sql, and the whole path through the real
// handler over HTTP by tests/local/outlook-worker-token-access.mjs.
//
// Run with: node tests/outlook-worker-token-access.test.js

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import {
  refreshAccessToken, validateRefreshResponseShape,
} from '../supabase/functions/shared/microsoftTokenExchange.js'
import {
  makeRunContextLoader, makeCursorEncryptor, RunContextError,
  CONTEXT_FAILURES, EXPIRY_SKEW_SECONDS, MAX_CONTACTS_LOADED, CONTACT_PAGE_SIZE,
} from '../supabase/functions/shared/outlookRunContext.js'
import {
  importKeyFromBase64, encryptToken, decryptToken,
} from '../supabase/functions/shared/googleTokenCrypto.js'
import {
  handleOutlookImportWorker, missingConfig, statusForOutcome,
  REQUIRED_CONFIG, OK_OUTCOMES, WORKER_CODES, flagEnabled,
} from '../supabase/functions/outlook-import-worker/handler.js'
import { makePostgrestPorts, PRODUCTION_TOKEN_URL, DB_TIMEOUT_MS } from '../supabase/functions/outlook-import-worker/endpoints.js'
import { MS_TOKEN_ENDPOINT } from '../supabase/functions/shared/microsoftOauthHelpers.js'
import {
  LEASE_SECONDS, RENEW_SECONDS, PAGE_WORST_MS, CONTEXT_WORST_MS, WRITE_STEP_MS,
  RELEASE_WORST_MS, RPC_ROUND_TRIP_MS, CONTEXT_DB_CALLS,
  RUN_OUTCOMES, runOutlookImport, summarizeRun,
} from '../supabase/functions/shared/outlookImportRun.js'
import {
  MAX_PAGES_PER_RUN, MAX_RETRIES, REQUEST_TIMEOUT_MS, MAX_TOTAL_RETRY_DELAY_MS, GRAPH_BASE,
} from '../supabase/functions/shared/outlookGraphTransport.js'
import { readFolderMetadata } from '../supabase/functions/shared/outlookMetadataPass.js'
import { makeRoundStore } from './harness/outlookRoundStore.js'
import { MAX_PROVIDER_BODY_BYTES } from '../supabase/functions/shared/boundedJson.js'
import { TOKEN_TIMEOUT_MS } from '../supabase/functions/shared/microsoftTokenExchange.js'

let passed = 0, failed = 0
const pending = []
function test (name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { console.log(`  ✓ ${name}`); passed++ },
        (e) => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ },
      ))
    } else { console.log(`  ✓ ${name}`); passed++ }
  } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const CTX_SRC = read('supabase/functions/shared/outlookRunContext.js')
const HANDLER_SRC = read('supabase/functions/outlook-import-worker/handler.js')
const ENTRY_SRC = read('supabase/functions/outlook-import-worker/index.ts')
const ENDPOINTS_SRC = read('supabase/functions/outlook-import-worker/endpoints.js')
const ROTATION_MIG = read('supabase/migrations/20261001000000_outlook_rotate_access_token.sql')
const codeOnly = (src) => src.split(String.fromCharCode(10))
  .filter((l) => !/^[ ]*([/][/]|[*]|[/][*])/.test(l)).join(String.fromCharCode(10))

const CONN = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const RUN = 'rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr'

/**
 * Every run now reads and writes round progress, so a suite's own rpc is wrapped: the
 * four round-progress RPCs answer from an in-memory mirror of migration 20261002000000
 * and everything else falls through unchanged. That keeps these suites tests of lease
 * LIFETIME and of the commit gate, rather than tests of the database - which
 * tests/sql/outlook-durable-continuation-runtime.sql and the Docker harness cover.
 */
function withRounds (innerRpc, store) {
  return async (name, args) => {
    const fromStore = await store.handle(name, args)
    if (fromStore !== null) return fromStore
    const res = await innerRpc(name, args)
    // A CONFIRMED complete release promotes the pending cursors and erases the round,
    // exactly as release_outlook_sync_lease does.
    if (name === 'release_outlook_sync_lease' && args?.p_run_complete === true
        && res?.data === true) store.commitRelease()
    return res
  }
}

// The cursor plaintext is recoverable from the ciphertext ON PURPOSE, so a test can
// assert WHICH link a resumed request used.
const ENCRYPT_CURSOR = async (link) => ({ ciphertext: `CT:${link}`, nonce: 'N', keyVersion: 1 })
const DECRYPT_CURSOR = async (ct) => String(ct).replace(/^CT:/, '')
const U1 = '11111111-1111-1111-1111-111111111111'
const CONTACT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const KEY_B64 = Buffer.from(new Uint8Array(32).fill(5)).toString('base64')
const subtle = webcrypto.subtle

console.log('\nthe refresh grant')

test('a refresh response needs an access token and an expiry, but NOT an id_token', () => {
  assert.strictEqual(validateRefreshResponseShape({ access_token: 'a', expires_in: 3600 }).ok, true)
  assert.strictEqual(validateRefreshResponseShape({ access_token: 'a', expires_in: 3600 }).rotated, false)
  assert.strictEqual(
    validateRefreshResponseShape({ access_token: 'a', expires_in: 3600, refresh_token: 'r' }).rotated, true)
  // An absent refresh token is NORMAL: Microsoft may or may not rotate one, and treating
  // its absence as failure would break every other refresh.
  for (const [body, reason] of [
    [{ expires_in: 3600 }, 'token_response_no_access_token'],
    [{ access_token: '', expires_in: 3600 }, 'token_response_no_access_token'],
    [{ access_token: 'a' }, 'token_response_no_expiry'],
    [{ access_token: 'a', expires_in: 0 }, 'token_response_no_expiry'],
    [{ access_token: 'a', expires_in: 'soon' }, 'token_response_no_expiry'],
    [null, 'token_response_malformed'],
  ]) {
    assert.strictEqual(validateRefreshResponseShape(body).reason, reason, JSON.stringify(body))
  }
})

test('the request is a confidential-client refresh grant that refuses redirects', async () => {
  let seen = null
  const r = await refreshAccessToken({
    refreshToken: 'rt', clientId: 'cid', clientSecret: 'csec',
    scope: 'Mail.Read User.Read offline_access', tokenUrl: 'https://fixture/token',
    fetchImpl: async (url, init) => {
      seen = { url, init, form: new URLSearchParams(init.body) }
      return { status: 200, headers: { get: () => null },
        json: async () => ({ access_token: 'new', expires_in: 3600, scope: 'Mail.Read User.Read' }) }
    },
  })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(seen.init.method, 'POST')
  assert.strictEqual(seen.init.redirect, 'error',
    'this POST carries the client secret and the refresh token')
  assert.strictEqual(seen.form.get('grant_type'), 'refresh_token')
  assert.strictEqual(seen.form.get('client_secret'), 'csec')
  assert.strictEqual(seen.form.get('scope'), 'Mail.Read User.Read offline_access')
  assert.strictEqual(seen.form.get('redirect_uri'), null, 'a refresh grant carries no redirect_uri')
  assert.strictEqual(seen.form.get('code'), null)
  assert.strictEqual(seen.form.get('code_verifier'), null)
})

test('missing inputs are refused before any request is made', async () => {
  let called = false
  const fetchImpl = async () => { called = true }
  for (const [args, reason] of [
    [{ clientId: 'c', clientSecret: 's', tokenUrl: 'u' }, 'no_refresh_token'],
    [{ refreshToken: 'r', clientSecret: 's', tokenUrl: 'u' }, 'no_client_id'],
    [{ refreshToken: 'r', clientId: 'c', tokenUrl: 'u' }, 'no_client_secret'],
    [{ refreshToken: 'r', clientId: 'c', clientSecret: 's' }, 'no_token_url'],
  ]) {
    const r = await refreshAccessToken({ ...args, fetchImpl })
    assert.strictEqual(r.reason, reason)
  }
  assert.strictEqual(called, false, 'nothing may be sent with incomplete inputs')
})

test('a rejection and an outage are distinguished, and no body is returned', async () => {
  const mk = (status) => async () => ({ status, headers: { get: () => null }, json: async () => ({ error: 'invalid_grant', error_description: 'secret detail' }) })
  const a = await refreshAccessToken({ refreshToken: 'r', clientId: 'c', clientSecret: 's', tokenUrl: 'u', fetchImpl: mk(400) })
  const b = await refreshAccessToken({ refreshToken: 'r', clientId: 'c', clientSecret: 's', tokenUrl: 'u', fetchImpl: mk(503) })
  assert.strictEqual(a.reason, 'refresh_rejected')
  assert.strictEqual(b.reason, 'token_endpoint_server_error')
  for (const r of [a, b]) assert.ok(!JSON.stringify(r).includes('secret detail'))
  const c = await refreshAccessToken({ refreshToken: 'r', clientId: 'c', clientSecret: 's', tokenUrl: 'u',
    fetchImpl: async () => { throw new Error('dns failure for https://login...') } })
  assert.strictEqual(c.reason, 'token_endpoint_unreachable')
  assert.ok(!JSON.stringify(c).includes('login'))
})

test('a refresh that came back without both permissions is refused', async () => {
  const r = await refreshAccessToken({
    refreshToken: 'r', clientId: 'c', clientSecret: 's', tokenUrl: 'u',
    fetchImpl: async () => ({ status: 200, headers: { get: () => null },
      json: async () => ({ access_token: 'a', expires_in: 3600, scope: 'Mail.Read offline_access' }) }),
  })
  assert.strictEqual(r.reason, 'refresh_scopes_insufficient',
    'a user may revoke one permission at Microsoft')
})

console.log('\nthe run-context loader')

/** A select port over in-memory rows, keyed by the table name in the path. */
function selectPort (tables, calls = []) {
  return async (path) => {
    calls.push(path)
    const table = path.split('?')[0]
    if (!(table in tables)) return { data: null, error: { code: 'rejected' } }
    const v = tables[table]
    if (typeof v === 'function') return v(path)
    return { data: v, error: null }
  }
}

async function seedTables ({ expired = true, hasAccess = true, key } = {}) {
  const k = key ?? await importKeyFromBase64(KEY_B64, subtle)
  const acc = await encryptToken('OLD-ACCESS', k, { subtle })
  const ref = await encryptToken('OLD-REFRESH', k, { subtle })
  const when = expired ? new Date(Date.now() - 60_000) : new Date(Date.now() + 7_200_000)
  return {
    microsoft_connections: [{ user_id: U1, ms_email: 'me@x.test', scopes: ['Mail.Read'], token_expires_at: when.toISOString() }],
    contacts: [{ id: 'aaaa', user_id: U1, email: 'ava@bank.test' }],
    outlook_sync_state: [{ folder: 'inbox', delta_link_ciphertext: null, delta_link_nonce: null },
      { folder: 'sentitems', delta_link_ciphertext: null, delta_link_nonce: null }],
    microsoft_tokens: [{
      access_token_ciphertext: hasAccess ? acc.ciphertext : null,
      access_token_nonce: hasAccess ? acc.nonce : null,
      refresh_token_ciphertext: ref.ciphertext,
      refresh_token_nonce: ref.nonce,
      key_version: 1,
      token_expires_at: when.toISOString(),
    }],
  }
}

const baseConfig = {
  clientId: 'cid', clientSecret: 'csec', tokenUrl: 'https://fixture/token',
  tokenKeyB64: KEY_B64, keyVersion: 1, keyRing: { current: { keyBytes: new Uint8Array(32).fill(1), keyVersion: 1 } },
}

test('missing configuration fails closed BEFORE any row is read', async () => {
  for (const drop of ['clientId', 'clientSecret', 'tokenUrl', 'tokenKeyB64']) {
    const calls = []
    const load = makeRunContextLoader({
      select: selectPort({}, calls), rpc: async () => ({ data: null, error: null }),
      config: { ...baseConfig, [drop]: '' },
    })
    await assert.rejects(() => load(CONN, RUN), (e) => e.reason === 'config_missing', drop)
    assert.strictEqual(calls.length, 0, `${drop}: nothing may be read`)
  }
})

test('it reads ONLY the reserved connection, and only the columns it uses', async () => {
  const calls = []
  const tables = await seedTables({ expired: false })
  const load = makeRunContextLoader({
    select: selectPort(tables, calls), rpc: async () => ({ data: null, error: null }),
    config: baseConfig, deps: { subtle },
  })
  const ctx = await load(CONN, RUN)
  assert.strictEqual(ctx.userId, U1)
  assert.strictEqual(ctx.primaryEmail, 'me@x.test')
  assert.strictEqual(ctx.accessToken, 'OLD-ACCESS', 'a valid token is used as-is')
  // Every read is scoped to the reserved connection or its owner.
  for (const p of calls) {
    assert.ok(/(id|connection_id)=eq\.cccccccc|user_id=eq\.11111111/.test(p), `unscoped read: ${p}`)
  }
  const connRead = calls.find((p) => p.startsWith('microsoft_connections'))
  assert.ok(connRead.includes('select=user_id,ms_email,scopes,token_expires_at'))
  for (const forbidden of ['ms_account_id', 'ms_tenant_id', 'needs_reauth', 'last_result_code']) {
    assert.ok(!connRead.includes(forbidden), `the loader must not select ${forbidden}`)
  }
  const contactRead = calls.find((p) => p.startsWith('contacts'))
  assert.ok(contactRead.includes('select=id,user_id,email'))
  for (const forbidden of ['name', 'company', 'relationship_note', 'linkedin_url']) {
    assert.ok(!contactRead.includes(forbidden), `the matcher does not need ${forbidden}`)
  }
  assert.ok(contactRead.includes(`limit=${CONTACT_PAGE_SIZE}`),
    'each contact request must be bounded well inside the port body limit')
  assert.ok(contactRead.includes('order=id.asc'), 'paging needs a deterministic order')
})

test('a token within the skew window is treated as stale and refreshed', async () => {
  const k = await importKeyFromBase64(KEY_B64, subtle)
  const acc = await encryptToken('SOON-TO-DIE', k, { subtle })
  const ref = await encryptToken('REF', k, { subtle })
  // Inside EXPIRY_SKEW_SECONDS of expiry: still valid, but not for long enough.
  const when = new Date(Date.now() + (EXPIRY_SKEW_SECONDS - 30) * 1000).toISOString()
  let refreshed = 0
  const rpcCalls = []
  const load = makeRunContextLoader({
    select: selectPort({
      microsoft_connections: [{ user_id: U1, ms_email: 'me@x.test', token_expires_at: when }],
      contacts: [], outlook_sync_state: [],
      microsoft_tokens: [{
        access_token_ciphertext: acc.ciphertext, access_token_nonce: acc.nonce,
        refresh_token_ciphertext: ref.ciphertext, refresh_token_nonce: ref.nonce,
        key_version: 1, token_expires_at: when,
      }],
    }),
    rpc: async (name, args) => { rpcCalls.push({ name, args }); return { data: { result: 'rotated' }, error: null } },
    config: baseConfig,
    deps: {
      subtle,
      fetchImpl: async () => { refreshed += 1; return { status: 200, headers: { get: () => null },
        json: async () => ({ access_token: 'FRESH', expires_in: 3600, scope: 'Mail.Read User.Read' }) } },
    },
  })
  const ctx = await load(CONN, RUN)
  assert.strictEqual(refreshed, 1, 'a token dying inside the skew window must be refreshed')
  assert.strictEqual(ctx.accessToken, 'FRESH')
  assert.strictEqual(ctx.refreshed, true)
  assert.strictEqual(rpcCalls[0].name, 'rotate_microsoft_access_token')
})

test('a ROTATED refresh token is encrypted and persisted before the token is returned', async () => {
  const tables = await seedTables({ expired: true })
  let stored = null
  const load = makeRunContextLoader({
    select: selectPort(tables),
    rpc: async (name, args) => { stored = args; return { data: { result: 'rotated' }, error: null } },
    config: baseConfig,
    deps: { subtle, fetchImpl: async () => ({ status: 200, headers: { get: () => null },
      json: async () => ({ access_token: 'FRESH', refresh_token: 'ROTATED', expires_in: 3600, scope: 'Mail.Read User.Read' }) }) },
  })
  const ctx = await load(CONN, RUN)
  assert.strictEqual(ctx.accessToken, 'FRESH')
  const k = await importKeyFromBase64(KEY_B64, subtle)
  assert.strictEqual(await decryptToken(stored.p_access_ct, stored.p_access_nonce, k, { subtle }), 'FRESH')
  assert.strictEqual(await decryptToken(stored.p_refresh_ct, stored.p_refresh_nonce, k, { subtle }), 'ROTATED')
  assert.strictEqual(stored.p_run_id, RUN, 'the rotation must be fenced on the run')
  assert.strictEqual(stored.p_key_version, 1)
  // No plaintext crosses the RPC boundary.
  assert.ok(!JSON.stringify(stored).includes('FRESH'))
  assert.ok(!JSON.stringify(stored).includes('ROTATED'))
})

test('an UNROTATED refresh sends nulls, so the stored refresh token is kept', async () => {
  const tables = await seedTables({ expired: true })
  let stored = null
  const load = makeRunContextLoader({
    select: selectPort(tables),
    rpc: async (name, args) => { stored = args; return { data: { result: 'rotated' }, error: null } },
    config: baseConfig,
    deps: { subtle, fetchImpl: async () => ({ status: 200, headers: { get: () => null },
      json: async () => ({ access_token: 'FRESH', expires_in: 3600, scope: 'Mail.Read User.Read' }) }) },
  })
  await load(CONN, RUN)
  assert.strictEqual(stored.p_refresh_ct, null)
  assert.strictEqual(stored.p_refresh_nonce, null)
})

test('a rotation the database refuses stops the load; the token is NOT used', async () => {
  const tables = await seedTables({ expired: true })
  for (const answer of [
    { data: { result: 'stale_run' }, error: null },
    { data: { result: 'no_token_row' }, error: null },
    { data: null, error: { code: 'rejected' } },
  ]) {
    const load = makeRunContextLoader({
      select: selectPort(tables), rpc: async () => answer, config: baseConfig,
      deps: { subtle, fetchImpl: async () => ({ status: 200, headers: { get: () => null },
        json: async () => ({ access_token: 'FRESH', expires_in: 3600, scope: 'Mail.Read User.Read' }) }) },
    })
    await assert.rejects(() => load(CONN, RUN),
      (e) => e.reason === 'rotation_not_persisted', JSON.stringify(answer))
  }
})

test('every failure is a controlled reason, never a provider message', async () => {
  const tables = await seedTables({ expired: true })
  const load = makeRunContextLoader({
    select: selectPort(tables), rpc: async () => ({ data: { result: 'rotated' }, error: null }),
    config: baseConfig,
    deps: { subtle, fetchImpl: async () => { throw new Error('unreachable https://login.microsoftonline.com/x') } },
  })
  await assert.rejects(() => load(CONN, RUN), (e) => {
    assert.ok(e instanceof RunContextError)
    assert.strictEqual(e.reason, 'refresh_failed')
    assert.ok(CONTEXT_FAILURES.includes(e.reason))
    assert.ok(!String(e.message).includes('microsoftonline'))
    return true
  })
})

test('a wrong key is token_undecryptable; an unusable key is key_unusable', async () => {
  const tables = await seedTables({ expired: false })
  const wrong = makeRunContextLoader({
    select: selectPort(tables), rpc: async () => ({}), deps: { subtle },
    config: { ...baseConfig, tokenKeyB64: Buffer.from(new Uint8Array(32).fill(9)).toString('base64') },
  })
  await assert.rejects(() => wrong(CONN, RUN), (e) => e.reason === 'token_undecryptable')
  const short = makeRunContextLoader({
    select: selectPort(tables), rpc: async () => ({}), deps: { subtle },
    config: { ...baseConfig, tokenKeyB64: Buffer.from(new Uint8Array(8)).toString('base64') },
  })
  await assert.rejects(() => short(CONN, RUN), (e) => e.reason === 'key_unusable')
})

test('an undecryptable CURSOR refuses rather than silently restarting the mailbox', async () => {
  const tables = await seedTables({ expired: false })
  tables.outlook_sync_state = [
    { folder: 'inbox', delta_link_ciphertext: 'not-real', delta_link_nonce: 'nope' },
    { folder: 'sentitems', delta_link_ciphertext: null, delta_link_nonce: null },
  ]
  const load = makeRunContextLoader({
    select: selectPort(tables), rpc: async () => ({}), config: baseConfig, deps: { subtle },
  })
  await assert.rejects(() => load(CONN, RUN), (e) => e.reason === 'cursor_undecryptable')
})

test('stored cursors are decrypted and handed to the pass in the clear', async () => {
  const k = await importKeyFromBase64(KEY_B64, subtle)
  const cur = await encryptToken('https://graph.microsoft.com/v1.0/me/x?$deltatoken=ABC', k, { subtle })
  const tables = await seedTables({ expired: false })
  tables.outlook_sync_state = [
    { folder: 'inbox', delta_link_ciphertext: cur.ciphertext, delta_link_nonce: cur.nonce },
    { folder: 'sentitems', delta_link_ciphertext: null, delta_link_nonce: null },
  ]
  const load = makeRunContextLoader({
    select: selectPort(tables), rpc: async () => ({}), config: baseConfig, deps: { subtle },
  })
  const ctx = await load(CONN, RUN)
  assert.ok(ctx.cursors.inbox.includes('$deltatoken=ABC'))
  assert.strictEqual(ctx.cursors.sentitems, null, 'an absent cursor is a first pass')
})

test('an unreadable table is a controlled reason, per table', async () => {
  const tables = await seedTables({ expired: false })
  for (const [drop, reason] of [
    ['microsoft_connections', 'connection_unreadable'],
    ['contacts', 'contacts_unreadable'],
    ['outlook_sync_state', 'sync_state_unreadable'],
  ]) {
    const t = { ...tables }
    delete t[drop]
    const load = makeRunContextLoader({
      select: selectPort(t), rpc: async () => ({}), config: baseConfig, deps: { subtle },
    })
    await assert.rejects(() => load(CONN, RUN), (e) => e.reason === reason, drop)
  }
  const noToken = { ...tables, microsoft_tokens: [] }
  const load = makeRunContextLoader({
    select: selectPort(noToken), rpc: async () => ({}), config: baseConfig, deps: { subtle },
  })
  await assert.rejects(() => load(CONN, RUN), (e) => e.reason === 'token_row_missing')
})

test('the cursor encryptor produces ciphertext that round-trips, and never logs', async () => {
  const enc = makeCursorEncryptor({ tokenKeyB64: KEY_B64, keyVersion: 2, subtle })
  const out = await enc('https://graph.microsoft.com/v1.0/x?$deltatoken=Z')
  assert.strictEqual(out.keyVersion, 2)
  assert.ok(!out.ciphertext.includes('deltatoken'))
  const k = await importKeyFromBase64(KEY_B64, subtle)
  assert.ok((await decryptToken(out.ciphertext, out.nonce, k, { subtle })).includes('$deltatoken=Z'))
  const bad = makeCursorEncryptor({ tokenKeyB64: 'short', subtle })
  await assert.rejects(() => bad('x'), (e) => e.reason === 'key_unusable')
})

test('the loader module logs nothing at all', () => {
  const code = codeOnly(CTX_SRC)
  for (const banned of ['console.log', 'console.error', 'console.warn', 'console.info']) {
    assert.ok(!code.includes(banned), `the loader must not ${banned}`)
  }
})

console.log('\nthe handler: configuration gate and response shape')

const workerReq = (over = {}) => ({
  method: 'POST',
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? (over.authorization ?? null) : null) },
  ...over,
})
const SECRET = 's'.repeat(40)
const goodEnv = () => ({
  integrationEnabled: 'true', workerEnabled: 'true', workerSecret: SECRET,
  clientId: 'c', clientSecret: 'cs', tokenKeyB64: KEY_B64,
  fingerprintKey: { current: { keyBytes: new Uint8Array(32), keyVersion: 1 } }, keyVersion: 1,
  // The designated pilot account. REQUIRED, like the other four: the run's pilot gate
  // fails closed without it, so the handler refuses one step earlier and with a clearer
  // code than a reserved-then-released lease.
  pilotUserId: U1,
})

test('the flags still come first, and a correct secret does not change a disabled answer', async () => {
  for (const env of [{}, { integrationEnabled: 'true' }, { workerEnabled: 'true' },
    { integrationEnabled: 'true', workerEnabled: 'TRUE' }]) {
    const r = await handleOutlookImportWorker(workerReq({ authorization: `Bearer ${SECRET}` }),
      { ...env, workerSecret: SECRET }, { tokenUrl: 'u', select: () => {}, rpc: () => {} })
    assert.strictEqual(r.status, 503, JSON.stringify(env))
    assert.deepStrictEqual(await r.json(), { error: 'not_enabled' })
  }
  assert.ok(HANDLER_SRC.indexOf('flagEnabled(e.integrationEnabled)') < HANDLER_SRC.indexOf('authorizeWorkerRequest('))
  assert.ok(HANDLER_SRC.indexOf('authorizeWorkerRequest(') < HANDLER_SRC.indexOf('missingConfig(e)'),
    'the secret check must precede the configuration check')
})

test('missingConfig names the absent keys and nothing else', () => {
  assert.deepStrictEqual(missingConfig({}), [...REQUIRED_CONFIG])
  assert.deepStrictEqual(missingConfig({ ...goodEnv() }), [])
  assert.deepStrictEqual(missingConfig({ ...goodEnv(), clientSecret: '' }), ['clientSecret'])
  assert.deepStrictEqual(missingConfig({ ...goodEnv(), fingerprintKey: null }), ['fingerprintKey'])
})

test('a half-configured deployment refuses without reading anything', async () => {
  for (const key of REQUIRED_CONFIG) {
    let touched = 0
    const r = await handleOutlookImportWorker(
      workerReq({ authorization: `Bearer ${SECRET}` }),
      { ...goodEnv(), [key]: null },
      { tokenUrl: 'https://u', select: async () => { touched += 1 }, rpc: async () => { touched += 1 } })
    assert.strictEqual(r.status, 503, key)
    const body = await r.json()
    assert.strictEqual(body.error, 'config_missing')
    assert.deepStrictEqual(body.missing, [key])
    assert.strictEqual(touched, 0, `${key}: nothing may be read`)
  }
})

test('an absent token endpoint or database port also fails closed', async () => {
  const noUrl = await handleOutlookImportWorker(workerReq({ authorization: `Bearer ${SECRET}` }),
    goodEnv(), { tokenUrl: '', select: () => {}, rpc: () => {} })
  assert.ok((await noUrl.json()).missing.includes('tokenUrl'))
  const noDb = await handleOutlookImportWorker(workerReq({ authorization: `Bearer ${SECRET}` }),
    goodEnv(), { tokenUrl: 'https://u' })
  assert.deepStrictEqual((await noDb.json()).missing, ['database'])
})

test('the 501 is gone, and no response is a success-shaped no-op', async () => {
  assert.ok(!/not_implemented|no_token_access_path/.test(codeOnly(HANDLER_SRC)),
    'the placeholder refusal must be gone now that the path runs')
  assert.ok(!WORKER_CODES.includes('not_implemented'))
  // Only these outcomes answer 200, and each of them reports what it did.
  // `continued` answers 200 because it is the designed behaviour of a large mailbox:
  // progress saved, no cursor advanced, nothing written. `restart_required` does NOT,
  // because a round's reading was discarded for an external reason.
  assert.deepStrictEqual([...OK_OUTCOMES],
    ['committed', 'none_due', 'incomplete', 'continued'])
  assert.strictEqual(statusForOutcome('restart_required'), 503)
  for (const o of RUN_OUTCOMES) {
    const expected = OK_OUTCOMES.includes(o) ? 200 : 503
    assert.strictEqual(statusForOutcome(o), expected, o)
  }
  assert.strictEqual(statusForOutcome('something_new'), 503, 'an unknown outcome is not a success')
})

test('the handler never reads the request body', () => {
  const code = codeOnly(HANDLER_SRC)
  for (const banned of ['req.json', 'req.text', 'await req.', '.formData', '.arrayBuffer']) {
    assert.ok(!code.includes(banned), `the handler must not call ${banned}`)
  }
  // The only thing read off the request is the method and one header.
  assert.ok(code.includes('req?.method'))
  assert.ok(code.includes("req?.headers?.get?.('authorization')"))
})

test('a run result is reported through summarizeRun, so no raw value can leak', () => {
  assert.ok(codeOnly(HANDLER_SRC).includes('summarizeRun(result)'))
  assert.ok(!codeOnly(HANDLER_SRC).includes('run: result'), 'the raw result must never be returned')
})

test('flagEnabled stays exact-match', () => {
  assert.strictEqual(flagEnabled('true'), true)
  for (const v of ['TRUE', '1', 'yes', '', ' true', null, undefined, true]) {
    assert.strictEqual(flagEnabled(v), false, String(v))
  }
})

console.log('\nthe deployed entry points at Microsoft, and its ports refuse redirects')

test('the token URL is a constant, not configuration', () => {
  assert.strictEqual(PRODUCTION_TOKEN_URL, MS_TOKEN_ENDPOINT)
  assert.ok(PRODUCTION_TOKEN_URL.startsWith('https://login.microsoftonline.com/'))
  // The entry must not let an env var decide where the secret is sent.
  assert.ok(!/Deno\.env\.get\([^)]*TOKEN_URL/.test(ENTRY_SRC))
  assert.ok(ENTRY_SRC.includes('PRODUCTION_TOKEN_URL'))
})

test('both database ports refuse redirects and bound the body', async () => {
  const seen = []
  const ports = makePostgrestPorts({
    url: 'https://proj.supabase.co/', serviceRoleKey: 'SRK',
    fetchImpl: async (url, init) => {
      seen.push({ url, init })
      return { status: 200, headers: { get: () => null }, json: async () => [{ ok: 1 }] }
    },
  })
  await ports.select('contacts?select=id')
  await ports.rpc('reserve_due_outlook_connection', { a: 1 })
  assert.strictEqual(seen.length, 2)
  for (const s of seen) {
    assert.strictEqual(s.init.redirect, 'error',
      'a followed redirect would repost the service-role key')
    assert.strictEqual(s.init.headers.apikey, 'SRK')
    assert.ok(s.url.startsWith('https://proj.supabase.co/rest/v1/'), s.url)
  }
  assert.strictEqual(seen[0].init.method, 'GET')
  assert.strictEqual(seen[1].init.method, 'POST')
  assert.ok(codeOnly(ENDPOINTS_SRC).includes('readJsonBounded'), 'the body must be bounded')
  assert.ok(Number.isInteger(DB_TIMEOUT_MS) && DB_TIMEOUT_MS > 0)
})

test('a database error is reduced to a status class; no body or key survives', async () => {
  const ports = makePostgrestPorts({
    url: 'https://p.co', serviceRoleKey: 'SRK',
    fetchImpl: async () => ({ status: 403, headers: { get: () => null },
      json: async () => ({ message: 'permission denied for table microsoft_tokens' }) }),
  })
  const r = await ports.select('microsoft_tokens?select=*')
  assert.deepStrictEqual(r, { data: null, error: { code: 'rejected' } })
  const boom = makePostgrestPorts({
    url: 'https://p.co', serviceRoleKey: 'SRK',
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED https://p.co with key SRK') },
  })
  const e = await boom.select('contacts')
  assert.deepStrictEqual(e, { data: null, error: { code: 'unreachable' } })
  assert.ok(!JSON.stringify(e).includes('SRK'))
})

test('the deployed entry builds a fingerprint key ring and fails closed without one', () => {
  assert.ok(ENTRY_SRC.includes('OUTLOOK_FINGERPRINT_HMAC_KEY_V1'))
  assert.ok(ENTRY_SRC.includes('if (!b64) return null'),
    'an absent key must become null so the handler refuses')
  assert.ok(ENTRY_SRC.includes('MICROSOFT_CLIENT_SECRET'))
  assert.ok(ENTRY_SRC.includes('MICROSOFT_TOKEN_ENCRYPTION_KEY_V1'))
  // The entry must not use supabase-js: its redirect policy would not be ours.
  assert.ok(!/@supabase\/supabase-js|createClient/.test(ENTRY_SRC))
})

console.log('\nthe rotation migration')

test('it is service_role only, SECURITY DEFINER, and unapplied', () => {
  assert.ok(/REVOKE ALL ON FUNCTION public\.rotate_microsoft_access_token\([\s\S]*?\)\s*FROM PUBLIC, anon, authenticated;/.test(ROTATION_MIG))
  assert.ok(/GRANT EXECUTE ON FUNCTION public\.rotate_microsoft_access_token\([\s\S]*?\)\s*TO service_role;/.test(ROTATION_MIG))
  assert.ok(/SECURITY DEFINER/.test(ROTATION_MIG) && /SET search_path = ''/.test(ROTATION_MIG))
  assert.ok(/NOT APPLIED/.test(ROTATION_MIG))
})

test('it fences on BOTH folder leases and writes only the two intended rows', () => {
  assert.ok(ROTATION_MIG.includes('PERFORM 1 FROM public.outlook_sync_state s'))
  assert.ok(/count\(\*\) = 2 AND bool_and\(s\.sync_run_id = p_run_id/.test(ROTATION_MIG))
  const code = ROTATION_MIG.split(String.fromCharCode(10)).filter((l) => !/^\s*--/.test(l)).join(String.fromCharCode(10))
  const updates = [...code.matchAll(/UPDATE public\.([a-z_]+)/g)].map((m) => m[1]).sort()
  assert.deepStrictEqual(updates, ['microsoft_connections', 'microsoft_tokens'])
  assert.ok(!/INSERT INTO/.test(code), 'it cannot create a token row')
  assert.ok(!/DELETE FROM/.test(code))
  for (const untouched of ['scopes', 'needs_reauth', 'consented_at', 'interaction_candidates']) {
    assert.ok(!new RegExp(`SET[\\s\\S]{0,200}${untouched}`).test(code), `must not write ${untouched}`)
  }
})

test('the optional refresh pair is COALESCEd, so an omitted token is kept', () => {
  assert.ok(/refresh_token_ciphertext = COALESCE\(p_refresh_ct, t\.refresh_token_ciphertext\)/.test(ROTATION_MIG))
  assert.ok(/refresh_token_nonce\s*= COALESCE\(p_refresh_nonce, t\.refresh_token_nonce\)/.test(ROTATION_MIG))
  assert.ok(/invalid_refresh_pair/.test(ROTATION_MIG), 'a half pair must be refused')
})

console.log('\nnothing outside this slice was added')

test('no message body, no Anthropic, no scheduler, no new-contact path', () => {
  for (const [name, src] of [['loader', CTX_SRC], ['handler', HANDLER_SRC], ['endpoints', ENDPOINTS_SRC]]) {
    const code = codeOnly(src)
    for (const banned of ['anthropic', 'Anthropic', 'uniqueBody', 'buildMessageContentRequest',
      'outlookDraftContract', 'outlookContentSanitizer', 'cron', 'setInterval',
      'new_contact_candidates', 'upsert_email_candidate']) {
      assert.ok(!code.includes(banned), `${name} must not reference ${banned}`)
    }
  }
})

test('the handler records what still blocks enablement', () => {
  // DURABLE CONTINUATION has left this list because it is built. What replaced it is the
  // part code cannot settle: the policy bullet and the retention decision.
  assert.ok(!HANDLER_SRC.includes('DURABLE CONTINUATION is still unbuilt'),
    'the old blocker must not be claimed once continuation exists')
  for (const blocker of ['A PRODUCT DECISION AND A POLICY EDIT', 'D1 and D2',
    'Entra application', 'Mail.Read', 'No scheduler',
    'CONTEXT_WORST_MS', 'COMMITTED deltaLink']) {
    assert.ok(HANDLER_SRC.includes(blocker), `the handler must still record: ${blocker}`)
  }
})

console.log('')
console.log('the lease survives a slow but successful run')

/**
 * A virtual clock plus a lease the database would actually enforce: a renewal succeeds
 * only while the lease is still live, and a write or release is refused once it is not.
 * That is what makes these tests about lease LIFETIME rather than about call counts.
 */
function slowRun ({ pagesPerFolder, contextMs = 200_000, writeMs = 5_000, pageMs = PAGE_WORST_MS }) {
  let clock = 0
  const now = () => clock
  let leaseUntil = LEASE_SECONDS * 1000
  const events = []
  let renewals = 0
  let renewalsRefused = 0

  const rpc = async (name) => {
    if (name === 'reserve_due_outlook_connection') {
      return { data: { result: 'reserved', connection_id: CONN, user_id: U1, run_id: RUN }, error: null }
    }
    if (name === 'renew_outlook_sync_lease') {
      renewals += 1
      if (leaseUntil <= clock) { renewalsRefused += 1; return { data: false, error: null } }
      leaseUntil = clock + RENEW_SECONDS * 1000
      events.push(`renew@${clock / 1000}`)
      return { data: true, error: null }
    }
    if (name === 'upsert_outlook_interaction_candidate') {
      clock += writeMs
      const live = leaseUntil > clock
      events.push(`write@${clock / 1000}:${live ? 'live' : 'EXPIRED'}`)
      return { data: { result: live ? 'created' : 'stale_run' }, error: null }
    }
    if (name === 'release_outlook_sync_lease') {
      const live = leaseUntil > clock
      events.push(`release@${clock / 1000}:${live}`)
      return { data: live, error: null }
    }
    return { data: null, error: null }
  }

  const served = { inbox: 0, sentitems: 0 }
  const addr = (e) => ({ emailAddress: { address: e, name: 'x' } })
  const m = (id, from, to, sent) => ({
    id, conversationId: 'c1', receivedDateTime: sent, sentDateTime: sent, isDraft: false,
    subject: 's', from: addr(from), sender: addr(from), toRecipients: to.map(addr), ccRecipients: [],
  })
  const ME = 'me@x.test'
  const OTHER = 'ava@bank.test'
  const fetchImpl = async (url) => {
    clock += pageMs
    const folder = url.includes('/mailFolders/inbox/') ? 'inbox' : 'sentitems'
    served[folder] += 1
    const last = served[folder] >= pagesPerFolder
    const items = folder === 'inbox'
      ? [m(`in-${served[folder]}`, OTHER, [ME], '2026-09-20T14:00:00Z')]
      : [m(`out-${served[folder]}`, ME, [OTHER], '2026-09-21T09:00:00Z')]
    return {
      status: 200, headers: { get: () => null },
      json: async () => (last
        ? { value: items, '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=F` }
        : { value: items, '@odata.nextLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$skiptoken=n${served[folder]}` }),
    }
  }

  const loadRunContext = async () => {
    clock += contextMs
    return {
      primaryEmail: ME, userId: U1, timeZone: 'UTC',
      contacts: [{ id: CONTACT, user_id: U1, email: OTHER }],
      cursors: {}, accessToken: 'tok',
      keyRing: { current: { keyBytes: new Uint8Array(32).fill(1), keyVersion: 1 } },
    }
  }

  const run = () => runOutlookImport({
    rpc: withRounds(rpc, makeRoundStore()),
    pilotUserId: U1,
    encryptCursor: ENCRYPT_CURSOR,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext,
    deps: { fetchImpl, now },
  })
  return { run, events, stats: () => ({ renewals, renewalsRefused, clock, leaseUntil }) }
}

test('ONE FINAL PAGE PER FOLDER: the run commits, where before it renewed zero times', async () => {
  // REPRODUCED BEFORE THE FIX: readFolderMetadata fired the per-page hook only below its
  // two breaks, so a folder whose stream ended on its first page never fired it at all.
  // With 200s of context loading and two 140s pages, the lease died at 300s, the
  // candidate write at 485s was refused `stale_run`, the release returned false, and the
  // outcome was write_failed with nothing committed - a run that had done all its work.
  const h = slowRun({ pagesPerFolder: 1 })
  const r = await h.run()
  const s = h.stats()
  assert.strictEqual(r.outcome, 'committed',
    `${r.outcome} / ${JSON.stringify(r.writeResults)} / ${h.events.join(' ')}`)
  assert.strictEqual(r.created, 1)
  assert.strictEqual(r.cursorsAdvanced, 2)
  assert.ok(s.renewals > 0, 'a slow run must renew at least once')
  assert.strictEqual(s.renewalsRefused, 0)
  assert.ok(s.clock > LEASE_SECONDS * 1000,
    `the run must actually outlast one lease to be a real test (ran ${s.clock / 1000}s)`)
  assert.ok(h.events.every((e) => !e.includes('EXPIRED')), h.events.join(' '))
  assert.ok(h.events.at(-1).startsWith('release@') && h.events.at(-1).endsWith(':true'),
    `the release must confirm: ${h.events.join(' ')}`)
})

test('THREE PAGES PER FOLDER: still committed, with renewals arriving in time', async () => {
  // Before the fix this reached its single renewal at 480s, long after the 300s lease had
  // died, and ended lease_lost.
  const h = slowRun({ pagesPerFolder: 3 })
  const r = await h.run()
  const s = h.stats()
  assert.strictEqual(r.outcome, 'committed', `${r.outcome} / ${h.events.join(' ')}`)
  assert.strictEqual(r.cursorsAdvanced, 2)
  assert.strictEqual(s.renewalsRefused, 0, h.events.join(' '))
  assert.ok(s.clock > LEASE_SECONDS * 1000,
    `a six-page run must outlast a whole lease to be a real test (ran ${s.clock / 1000}s)`)
})

test('a run slow enough to need renewal DURING the writes still commits', async () => {
  // Many plan entries, each a slow round trip: MAX_PLAN_ENTRIES writes can outlast any
  // lease, so the guard runs before EVERY write, not once before the loop.
  let clock = 0
  let leaseUntil = LEASE_SECONDS * 1000
  let writes = 0
  let refusedWrites = 0
  let renewals = 0
  const rpc = async (name) => {
    if (name === 'reserve_due_outlook_connection') {
      return { data: { result: 'reserved', connection_id: CONN, user_id: U1, run_id: RUN }, error: null }
    }
    if (name === 'renew_outlook_sync_lease') {
      renewals += 1
      if (leaseUntil <= clock) return { data: false, error: null }
      leaseUntil = clock + RENEW_SECONDS * 1000
      return { data: true, error: null }
    }
    if (name === 'upsert_outlook_interaction_candidate') {
      clock += WRITE_STEP_MS            // each write takes its whole worst case
      writes += 1
      if (leaseUntil <= clock) { refusedWrites += 1; return { data: { result: 'stale_run' }, error: null } }
      return { data: { result: 'created' }, error: null }
    }
    if (name === 'release_outlook_sync_lease') return { data: leaseUntil > clock, error: null }
    return { data: null, error: null }
  }
  // 40 distinct two-sided episodes -> 40 writes -> 800s of writing on a 300s lease.
  const addr = (e) => ({ emailAddress: { address: e, name: 'x' } })
  const mk = (id, conv, from, to, sent) => ({
    id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
    subject: 's', from: addr(from), sender: addr(from), toRecipients: to.map(addr), ccRecipients: [],
  })
  const ME = 'me@x.test'
  const OTHER = 'ava@bank.test'
  const convs = Array.from({ length: 40 }, (_, i) => `c${i}`)
  const fetchImpl = async (url) => {
    clock += 1000
    const inbox = url.includes('/mailFolders/inbox/')
    return {
      status: 200, headers: { get: () => null },
      json: async () => ({
        value: convs.map((c, i) => (inbox
          ? mk(`in-${i}`, c, OTHER, [ME], '2026-09-20T14:00:00Z')
          : mk(`out-${i}`, c, ME, [OTHER], '2026-09-21T09:00:00Z'))),
        '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${inbox ? 'inbox' : 'sentitems'}/messages/delta?$deltatoken=F`,
      }),
    }
  }
  const r = await runOutlookImport({
    rpc: withRounds(rpc, makeRoundStore()),
    pilotUserId: U1,
    encryptCursor: ENCRYPT_CURSOR,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: async () => ({
      primaryEmail: ME, userId: U1, timeZone: 'UTC',
      contacts: [{ id: CONTACT, user_id: U1, email: OTHER }],
      cursors: {}, accessToken: 'tok',
      keyRing: { current: { keyBytes: new Uint8Array(32).fill(1), keyVersion: 1 } },
    }),
    deps: { fetchImpl, now: () => clock },
  })
  assert.strictEqual(writes, 40, `all writes must be attempted (got ${writes})`)
  assert.ok(clock > LEASE_SECONDS * 1000, `the writing must outlast a lease (${clock / 1000}s)`)
  assert.strictEqual(refusedWrites, 0, 'no write may be refused for a dead lease')
  assert.ok(renewals >= 2, `the guard must renew during the loop (renewals=${renewals})`)
  assert.strictEqual(r.outcome, 'committed')
  assert.strictEqual(r.accepted, 40)
  assert.strictEqual(r.cursorsAdvanced, 2)
})

test('the lease is renewed BEFORE context loading, not after', async () => {
  // Context loading can consume most of a lease on its own, so the guard runs first.
  const order = []
  let clock = 0
  const rpc = async (name) => {
    order.push(name)
    if (name === 'reserve_due_outlook_connection') {
      return { data: { result: 'reserved', connection_id: CONN, user_id: U1, run_id: RUN }, error: null }
    }
    if (name === 'renew_outlook_sync_lease') return { data: true, error: null }
    if (name === 'release_outlook_sync_lease') return { data: true, error: null }
    return { data: { result: 'created' }, error: null }
  }
  await runOutlookImport({
    rpc: withRounds(rpc, makeRoundStore()),
    pilotUserId: U1,
    encryptCursor: ENCRYPT_CURSOR,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: async () => {
      order.push('loadRunContext')
      return { primaryEmail: 'me@x.test', userId: U1, timeZone: 'UTC', contacts: [],
        cursors: {}, accessToken: 't', keyRing: { current: { keyBytes: new Uint8Array(32), keyVersion: 1 } } }
    },
    // Start with almost no lease left so the guard must act.
    deps: {
      now: () => { clock += LEASE_SECONDS * 1000; return clock },
      fetchImpl: async () => ({ status: 200, headers: { get: () => null },
        json: async () => ({ value: [], '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$deltatoken=F` }) }),
    },
  })
  const firstRenew = order.indexOf('renew_outlook_sync_lease')
  const load = order.indexOf('loadRunContext')
  assert.ok(firstRenew !== -1, `a renewal must happen: ${order.join(',')}`)
  assert.ok(firstRenew < load, `renewal must precede context loading: ${order.join(',')}`)
})

test('a FAILED renewal stops the run and advances NEITHER cursor', async () => {
  for (const failAt of ['context', 'page', 'write']) {
    let clock = 0
    let released = null
    let renewCalls = 0
    const rpc = async (name, args) => {
      if (name === 'reserve_due_outlook_connection') {
        return { data: { result: 'reserved', connection_id: CONN, user_id: U1, run_id: RUN }, error: null }
      }
      if (name === 'renew_outlook_sync_lease') {
        renewCalls += 1
        // Refuse the renewal for the stage under test; allow earlier ones.
        const refuse = (failAt === 'context' && renewCalls >= 1)
          || (failAt === 'page' && renewCalls >= 2)
          || (failAt === 'write' && renewCalls >= 3)
        return { data: !refuse, error: null }
      }
      if (name === 'release_outlook_sync_lease') { released = args; return { data: true, error: null } }
      return { data: { result: 'created' }, error: null }
    }
    const r = await runOutlookImport({
      rpc: withRounds(rpc, makeRoundStore()),
      pilotUserId: U1,
      encryptCursor: ENCRYPT_CURSOR,
      decryptCursor: DECRYPT_CURSOR,
      loadRunContext: async () => ({
        primaryEmail: 'me@x.test', userId: U1, timeZone: 'UTC',
        contacts: [{ id: CONTACT, user_id: U1, email: 'ava@bank.test' }],
        cursors: {}, accessToken: 't',
        keyRing: { current: { keyBytes: new Uint8Array(32), keyVersion: 1 } },
      }),
      deps: {
        // Time always jumps a whole lease, so every guard must renew.
        now: () => { clock += LEASE_SECONDS * 1000; return clock },
        fetchImpl: async (url) => {
          const inbox = url.includes('/mailFolders/inbox/')
          const addr = (e) => ({ emailAddress: { address: e, name: 'x' } })
          const m = (id, from, to, sent) => ({ id, conversationId: 'c1', receivedDateTime: sent,
            sentDateTime: sent, isDraft: false, subject: 's', from: addr(from), sender: addr(from),
            toRecipients: to.map(addr), ccRecipients: [] })
          return { status: 200, headers: { get: () => null }, json: async () => ({
            value: [inbox ? m('in', 'ava@bank.test', ['me@x.test'], '2026-09-20T14:00:00Z')
              : m('out', 'me@x.test', ['ava@bank.test'], '2026-09-21T09:00:00Z')],
            '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${inbox ? 'inbox' : 'sentitems'}/messages/delta?$deltatoken=F`,
          }) }
        },
      },
    })
    assert.strictEqual(r.outcome, 'lease_lost', `${failAt}: got ${r.outcome}`)
    assert.strictEqual(r.cursorsAdvanced, 0, failAt)
    assert.ok(released, `${failAt}: the lease must still be released`)
    assert.strictEqual(released.p_inbox_delta_ct, null, failAt)
    assert.strictEqual(released.p_sentitems_delta_ct, null, failAt)
    assert.strictEqual(released.p_run_complete, false, failAt)
    assert.strictEqual(released.p_error_code, 'lease_lost', failAt)
    // And the loggable summary says so too, with no cursor claimed.
    const s = summarizeRun(r)
    assert.strictEqual(s.outcome, 'lease_lost', failAt)
    assert.strictEqual(s.cursors_advanced, 0, failAt)
  }
})

test('the per-page hook fires for a FINAL page, which is what the old order missed', async () => {
  const fired = []
  const res = await readFolderMetadata({
    folder: 'inbox', accessToken: 't',
    deps: {
      onPageComplete: (info) => { fired.push(info) },
      fetchImpl: async () => ({ status: 200, headers: { get: () => null },
        json: async () => ({ value: [], '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$deltatoken=F` }) }),
    },
  })
  assert.strictEqual(res.stop, 'complete')
  assert.strictEqual(fired.length, 1, 'a single final page must still fire the hook')
  assert.strictEqual(fired[0].final, true, 'and say that it was the final one')
})

test('a hook that throws on the final page stops the folder without a cursor', async () => {
  await assert.rejects(() => readFolderMetadata({
    folder: 'inbox', accessToken: 't',
    deps: {
      onPageComplete: () => { throw new Error('lease_lost') },
      fetchImpl: async () => ({ status: 200, headers: { get: () => null },
        json: async () => ({ value: [], '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$deltatoken=F` }) }),
    },
  }), /lease_lost/)
})

console.log('')
console.log('the timing invariant, stated correctly')

test('EVERY stage margin fits inside one renewal - the invariant the scheme rests on', () => {
  // THE OLD ASSERTION WAS RENEW_EVERY_PAGES * perRequest < RENEW_SECONDS * 1000 * 2,
  // i.e. 280s < 600s. That compared two pages against TWICE the renewal period, which
  // establishes nothing: the lease is 300s, not 600s, and the comparison ignored context
  // loading and candidate writes entirely. Under it a run could - and did - exceed its
  // lease while the assertion passed.
  //
  // The real invariant is per STAGE: a single renewal must cover whatever comes next.
  for (const [name, ms] of [
    ['one Graph page', PAGE_WORST_MS],
    ['loading the run context', CONTEXT_WORST_MS],
    ['one candidate write', WRITE_STEP_MS],
  ]) {
    assert.ok(ms <= RENEW_SECONDS * 1000,
      `${name} (${ms / 1000}s) must fit inside one renewal (${RENEW_SECONDS}s)`)
  }
  // And the numbers are derived from the transport, not invented.
  assert.strictEqual(PAGE_WORST_MS, (MAX_RETRIES + 1) * REQUEST_TIMEOUT_MS + MAX_TOTAL_RETRY_DELAY_MS)
  assert.strictEqual(PAGE_WORST_MS, 140_000)
  // The initial lease must itself cover the first stage that runs without a prior renewal
  // opportunity - which is why a fresh reservation is enough to start.
  assert.ok(LEASE_SECONDS * 1000 >= CONTEXT_WORST_MS,
    'a fresh reservation must cover a full context load')
  assert.ok(LEASE_SECONDS <= 600 && RENEW_SECONDS <= 600,
    'both must satisfy the reservation RPC bound')
  // What the old assertion could not say: a whole worst-case run vastly exceeds any
  // lease, which is exactly why per-stage renewal is required rather than optional.
  assert.ok(MAX_PAGES_PER_RUN * PAGE_WORST_MS > RENEW_SECONDS * 1000 * 5)
})

console.log('')
console.log('contacts are loaded in bounded pages, and overflow fails the run')

// A real ciphertext under the test key, so the loader's decryption succeeds and these
// tests are about the contact read rather than the token path.
const VALID_TOKEN = await (async () => {
  const k = await importKeyFromBase64(KEY_B64, subtle)
  return encryptToken('VALID-ACCESS', k, { subtle })
})()

/** A select port whose contacts table is `total` rows, honouring limit and offset. */
function contactPort (total, { calls = [], rowBytes = null } = {}) {
  const mkRow = (i) => ({
    id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    user_id: U1,
    email: rowBytes
      ? `${'x'.repeat(Math.max(1, rowBytes - 20))}@e.test`
      : `c${i}@e.test`,
  })
  return async (path) => {
    calls.push(path)
    if (path.startsWith('contacts')) {
      const u = new URLSearchParams(path.split('?')[1])
      const limit = Number(u.get('limit'))
      const offset = Number(u.get('offset') ?? 0)
      const rows = []
      for (let i = offset; i < Math.min(total, offset + limit); i++) rows.push(mkRow(i))
      // The port bounds every response; a chunk that would exceed it must not be asked for.
      const size = Buffer.byteLength(JSON.stringify(rows))
      if (size > MAX_PROVIDER_BODY_BYTES) return { data: null, error: { code: 'response_too_large' } }
      return { data: rows, error: null }
    }
    if (path.startsWith('microsoft_connections')) {
      return { data: [{ user_id: U1, ms_email: 'me@x.test', scopes: ['Mail.Read'],
        token_expires_at: new Date(Date.now() + 7_200_000).toISOString() }], error: null }
    }
    if (path.startsWith('outlook_sync_state')) return { data: [], error: null }
    if (path.startsWith('microsoft_tokens')) {
      // A REAL encrypted, still-valid access token, so these tests exercise the contact
      // paging rather than the refresh path.
      return { data: [{ access_token_ciphertext: VALID_TOKEN.ciphertext,
        access_token_nonce: VALID_TOKEN.nonce,
        refresh_token_ciphertext: VALID_TOKEN.ciphertext,
        refresh_token_nonce: VALID_TOKEN.nonce, key_version: 1,
        token_expires_at: new Date(Date.now() + 7_200_000).toISOString() }], error: null }
    }
    return { data: null, error: { code: 'rejected' } }
  }
}

function loaderFor (select, over = {}) {
  return makeRunContextLoader({
    select,
    rpc: async () => ({ data: { result: 'rotated' }, error: null }),
    config: { clientId: 'c', clientSecret: 's', tokenUrl: 'https://t', tokenKeyB64: KEY_B64, keyVersion: 1 },
    deps: {
      subtle,
      fetchImpl: async () => ({ status: 200, headers: { get: () => null },
        json: async () => ({ access_token: 'FRESH', expires_in: 3600, scope: 'Mail.Read User.Read' }) }),
      ...over,
    },
  })
}

test('THE OVERSIZED RESPONSE: one request for the whole supported set exceeds the bound', () => {
  // Measured, which is how the defect was found. The previous read asked for
  // limit=MAX_CONTACTS_LOADED in a single response.
  const rows = Array.from({ length: MAX_CONTACTS_LOADED }, (_, i) => ({
    id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    user_id: U1,
    email: `contact.number.${i}@a-fairly-long-company-domain.example`,
  }))
  const bytes = Buffer.byteLength(JSON.stringify(rows))
  assert.ok(bytes > MAX_PROVIDER_BODY_BYTES,
    `${MAX_CONTACTS_LOADED} rows are ${bytes} bytes, bound is ${MAX_PROVIDER_BODY_BYTES}`)
  // The page size chosen instead stays inside the bound even at the schema's worst case:
  // a 36-char id, a 36-char user_id and a 320-char email.
  const worst = Array.from({ length: CONTACT_PAGE_SIZE }, () => ({
    id: 'x'.repeat(36), user_id: 'y'.repeat(36), email: `${'z'.repeat(311)}@e.test`,
  }))
  assert.ok(Buffer.byteLength(JSON.stringify(worst)) < MAX_PROVIDER_BODY_BYTES,
    'a full page must fit even with the longest addresses the schema allows')
})

test('a large set is read in pages that each fit, and every contact arrives', async () => {
  const calls = []
  const ctx = await loaderFor(contactPort(1_234, { calls }))(CONN, RUN)
  assert.strictEqual(ctx.contacts.length, 1_234, 'no contact may be dropped')
  const contactCalls = calls.filter((p) => p.startsWith('contacts'))
  assert.strictEqual(contactCalls.length, Math.ceil(1_234 / CONTACT_PAGE_SIZE))
  for (const p of contactCalls) {
    assert.ok(p.includes(`limit=${CONTACT_PAGE_SIZE}`), p)
    assert.ok(p.includes(`user_id=eq.${U1}`), `every page must stay owner-scoped: ${p}`)
    assert.ok(p.includes('select=id,user_id,email'), `no unused field may be read: ${p}`)
    assert.ok(p.includes('order=id.asc'), `paging needs a deterministic order: ${p}`)
    for (const unused of ['name', 'company', 'relationship_note', 'linkedin_url', 'tags']) {
      assert.ok(!p.includes(unused), `${unused} must not be requested`)
    }
  }
  // Offsets advance by a page and never repeat, so nothing is skipped or duplicated.
  const offsets = contactCalls.map((p) => Number(new URLSearchParams(p.split('?')[1]).get('offset')))
  assert.deepStrictEqual(offsets, offsets.map((_, i) => i * CONTACT_PAGE_SIZE))
  const ids = new Set(ctx.contacts.map((c) => c.id))
  assert.strictEqual(ids.size, 1_234, 'no duplicates')
})

test('a set at EXACTLY the supported limit loads, and is not mistaken for overflow', async () => {
  const calls = []
  const ctx = await loaderFor(contactPort(MAX_CONTACTS_LOADED, { calls }))(CONN, RUN)
  assert.strictEqual(ctx.contacts.length, MAX_CONTACTS_LOADED)
  // The probe beyond the limit must have been made, and found nothing.
  const probe = calls.find((p) => p.includes(`offset=${MAX_CONTACTS_LOADED}`))
  assert.ok(probe, `the overflow probe must run: ${calls.filter((c) => c.startsWith('contacts')).join(' | ')}`)
  assert.ok(probe.includes('limit=1'), 'the probe must ask for one row only')
  assert.ok(probe.includes('select=id'), 'and only one column')
})

test('THE OVERFLOW CASE: one contact beyond the limit fails the run outright', async () => {
  const calls = []
  await assert.rejects(
    () => loaderFor(contactPort(MAX_CONTACTS_LOADED + 1, { calls }))(CONN, RUN),
    (e) => {
      assert.strictEqual(e.reason, 'too_many_contacts')
      assert.ok(CONTEXT_FAILURES.includes(e.reason))
      return true
    })
  // It failed BEFORE the token refresh, so before anything could reach Graph.
  assert.ok(!calls.some((p) => p.startsWith('microsoft_tokens')),
    'the run must fail before it even loads a token')
})

test('an overflowing set NEVER silently treats a tracked contact as unknown', async () => {
  // The whole point: the alternative to failing is matching against a subset, which turns
  // a person the user tracks into a stranger and defers - or would later propose - their
  // exchanges as if they were new.
  let graphCalled = 0
  let released = null
  const rpc = async (name, args) => {
    if (name === 'reserve_due_outlook_connection') {
      return { data: { result: 'reserved', connection_id: CONN, user_id: U1, run_id: RUN }, error: null }
    }
    if (name === 'renew_outlook_sync_lease') return { data: true, error: null }
    if (name === 'release_outlook_sync_lease') { released = args; return { data: true, error: null } }
    return { data: { result: 'created' }, error: null }
  }
  const r = await runOutlookImport({
    rpc: withRounds(rpc, makeRoundStore()),
    pilotUserId: U1,
    encryptCursor: ENCRYPT_CURSOR,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: loaderFor(contactPort(MAX_CONTACTS_LOADED + 1)),
    deps: { fetchImpl: async () => { graphCalled += 1; throw new Error('must not be called') } },
  })
  assert.strictEqual(r.outcome, 'released_error')
  assert.strictEqual(r.reason, 'too_many_contacts')
  assert.strictEqual(graphCalled, 0, 'no Graph request may be made')
  assert.strictEqual(r.cursorsAdvanced, 0)
  assert.strictEqual(released.p_inbox_delta_ct, null, 'no cursor may advance')
  assert.strictEqual(released.p_sentitems_delta_ct, null)
  assert.strictEqual(released.p_run_complete, false)
})

test('a page the port refuses is a controlled failure, not a partial contact set', async () => {
  // If a chunk ever did exceed the bound, the read must fail rather than proceed with
  // whatever arrived.
  const select = contactPort(1000)
  const wrapped = async (path) => {
    if (path.startsWith('contacts') && path.includes('offset=400')) {
      return { data: null, error: { code: 'response_too_large' } }
    }
    return select(path)
  }
  await assert.rejects(() => loaderFor(wrapped)(CONN, RUN),
    (e) => e.reason === 'contacts_unreadable')
})

test('an owner with no contacts loads cleanly, with one request', async () => {
  const calls = []
  const ctx = await loaderFor(contactPort(0, { calls }))(CONN, RUN)
  assert.deepStrictEqual(ctx.contacts, [])
  assert.strictEqual(calls.filter((p) => p.startsWith('contacts')).length, 1,
    'an empty first page ends the paging immediately')
})

console.log('')
console.log('the lease deadline is anchored to when the RPC RAN, not when it answered')

/**
 * A virtual clock plus a lease the database enforces, where EVERY RPC costs its deadline
 * and the lease begins when the call STARTS. That last detail is the whole point: the
 * worker cannot observe it, so its arithmetic has to assume it.
 */
function leaseScenario ({
  contextMs, releaseMs = RPC_ROUND_TRIP_MS, writeMs = 2_000, pageMs = 1_000,
  pagesPerFolder = 1, episodes = 1, refuseRenewalAfter = null, refuseRenewalsAfterWrites = null,
}) {
  let clock = 0
  let leaseUntil = null
  const events = []
  let renewals = 0
  let refusedRenewals = 0
  let expiredWrites = 0
  let writeCount = 0

  const rpc = async (name) => {
    const started = clock
    clock += RPC_ROUND_TRIP_MS
    if (name === 'reserve_due_outlook_connection') {
      leaseUntil = started + LEASE_SECONDS * 1000
      return { data: { result: 'reserved', connection_id: CONN, user_id: U1, run_id: RUN }, error: null }
    }
    if (name === 'renew_outlook_sync_lease') {
      renewals += 1
      const targeted = refuseRenewalsAfterWrites !== null && writeCount >= refuseRenewalsAfterWrites
      if (targeted || (refuseRenewalAfter !== null && renewals > refuseRenewalAfter)) {
        refusedRenewals += 1
        return { data: false, error: null }
      }
      if (leaseUntil <= started) { refusedRenewals += 1; return { data: false, error: null } }
      leaseUntil = started + RENEW_SECONDS * 1000
      events.push(`renew@${started / 1000}->${leaseUntil / 1000}`)
      return { data: true, error: null }
    }
    if (name === 'upsert_outlook_interaction_candidate') {
      clock += writeMs
      writeCount += 1
      const live = leaseUntil > clock
      if (!live) { expiredWrites += 1; events.push(`write@${clock / 1000}:EXPIRED`) }
      return { data: { result: live ? 'created' : 'stale_run' }, error: null }
    }
    if (name === 'release_outlook_sync_lease') {
      const leftBefore = leaseUntil - started
      clock += releaseMs
      const live = leaseUntil > clock
      events.push(`release@${started / 1000} with ${leftBefore / 1000}s -> ${live}`)
      return { data: live, error: null }
    }
    return { data: null, error: null }
  }

  const addr = (e) => ({ emailAddress: { address: e, name: 'x' } })
  const mk = (id, conv, from, to, sent) => ({
    id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
    subject: 's', from: addr(from), sender: addr(from), toRecipients: to.map(addr), ccRecipients: [],
  })
  const ME = 'me@x.test'
  const OTHER = 'ava@bank.test'
  const convs = Array.from({ length: episodes }, (_, i) => `conv${i}`)
  const served = { inbox: 0, sentitems: 0 }
  const fetchImpl = async (url) => {
    clock += pageMs
    const folder = url.includes('/mailFolders/inbox/') ? 'inbox' : 'sentitems'
    served[folder] += 1
    const last = served[folder] >= pagesPerFolder
    const value = convs.map((c, i) => (folder === 'inbox'
      ? mk(`in-${served[folder]}-${i}`, c, OTHER, [ME], '2026-09-20T14:00:00Z')
      : mk(`out-${served[folder]}-${i}`, c, ME, [OTHER], '2026-09-21T09:00:00Z')))
    return {
      status: 200, headers: { get: () => null },
      json: async () => (last
        ? { value, '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=F` }
        : { value, '@odata.nextLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$skiptoken=n${served[folder]}` }),
    }
  }

  const run = () => runOutlookImport({
    rpc: withRounds(rpc, makeRoundStore()),
    pilotUserId: U1,
    encryptCursor: ENCRYPT_CURSOR,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: async () => {
      clock += contextMs
      events.push(`context@${clock / 1000}:${leaseUntil > clock ? 'live' : 'EXPIRED'}`)
      return {
        primaryEmail: ME, userId: U1, timeZone: 'UTC',
        contacts: [{ id: CONTACT, user_id: U1, email: OTHER }],
        cursors: {}, accessToken: 'tok',
        keyRing: { current: { keyBytes: new Uint8Array(32).fill(1), keyVersion: 1 } },
      }
    },
    deps: { fetchImpl, now: () => clock },
  })
  return { run, events, stats: () => ({ clock, leaseUntil, renewals, refusedRenewals, expiredWrites }) }
}

test('THE FULL CONTEXT PATH fits, where a 255s margin and a response-anchored deadline lost it', async () => {
  // REPRODUCED BEFORE THE FIX. The declared margin was 255s while the longest path is
  // 285s - 18 bounded database calls plus one token refresh - and the deadline was
  // anchored to the reservation's RESPONSE, so the worker believed a 300s lease ran to
  // t=315 when the database had started it at t=0. The guard saw 300s remaining, skipped,
  // the context finished at t=300 exactly as the lease died, the renewal was refused, and
  // the run ended lease_lost with nothing committed.
  const h = leaseScenario({ contextMs: CONTEXT_WORST_MS })
  const r = await h.run()
  const s = h.stats()
  assert.strictEqual(r.outcome, 'committed', `${r.outcome} / ${h.events.join(' ')}`)
  assert.strictEqual(r.created, 1)
  assert.strictEqual(r.cursorsAdvanced, 2)
  assert.strictEqual(s.refusedRenewals, 0, h.events.join(' '))
  assert.strictEqual(s.expiredWrites, 0, 'no write may run against a dead lease')
  assert.ok(h.events.some((e) => e.startsWith('context@') && e.endsWith(':live')),
    `the context must finish inside the lease: ${h.events.join(' ')}`)
  assert.ok(h.events.at(-1).endsWith('-> true'), `the release must confirm: ${h.events.at(-1)}`)
})

test('THE RELEASE STAGE now has its own guard, where before it was left short', async () => {
  // REPRODUCED BEFORE THE FIX. The write loop only ever guaranteed enough lease for the
  // NEXT WRITE, so a loop of twenty writes topped itself up to just above WRITE_STEP_MS
  // and then handed the release less than it needed: the release began with the lease 6s
  // DEAD, returned false, and a run with 16 suggestions already written advanced no
  // cursor - all of that work to be redone next time. One write had also executed against
  // an expired lease.
  const h = leaseScenario({ contextMs: 1_000, episodes: 20, pageMs: 500, writeMs: 2_000 })
  const r = await h.run()
  const s = h.stats()
  assert.strictEqual(r.outcome, 'committed', `${r.outcome} / ${h.events.join(' ')}`)
  assert.strictEqual(r.accepted, 20, 'every suggestion must land')
  assert.strictEqual(r.created, 20)
  assert.strictEqual(r.cursorsAdvanced, 2, 'and the cursors must actually advance')
  assert.strictEqual(s.expiredWrites, 0, 'no write may run against a dead lease')
  const releaseEvent = h.events.find((e) => e.startsWith('release@'))
  const leftAtRelease = Number(releaseEvent.match(/with (-?[\d.]+)s/)[1])
  assert.ok(leftAtRelease * 1000 > RELEASE_WORST_MS,
    `the release must start with more than its own margin (had ${leftAtRelease}s)`)
})

test('a run whose write loop spans several leases still commits and advances', async () => {
  // Long enough that the loop must renew repeatedly, and the release still lands live.
  // 40 episodes, under the transport's MAX_PAGE_SIZE of 50 so the page is accepted.
  const h = leaseScenario({ contextMs: 1_000, episodes: 40, pageMs: 500, writeMs: 20_000 })
  const r = await h.run()
  const s = h.stats()
  assert.strictEqual(r.outcome, 'committed', `${r.outcome} / ${h.events.join(' ')}`)
  assert.strictEqual(r.accepted, 40)
  assert.strictEqual(r.cursorsAdvanced, 2)
  assert.strictEqual(s.expiredWrites, 0)
  assert.ok(s.clock > 2 * LEASE_SECONDS * 1000,
    `the run must outlast several leases to be a real test (${s.clock / 1000}s)`)
  assert.ok(s.renewals >= 2, `renewals=${s.renewals}`)
})

test('FAIL CLOSED: a refused renewal before the release commits nothing and advances nothing', async () => {
  // The renewal the release stage needs is refused. Whatever was written stays and is
  // reported honestly; no cursor is claimed and the outcome is not committed.
  // writeMs is chosen so twenty writes consume nearly the whole lease: the last one
  // leaves less than RELEASE_WORST_MS, so the release stage must renew - and that is the
  // renewal this scenario refuses.
  const h = leaseScenario({
    contextMs: 1_000, episodes: 20, pageMs: 500, writeMs: 4_500,
    refuseRenewalsAfterWrites: 20,
  })
  const r = await h.run()
  assert.strictEqual(r.outcome, 'lease_lost', `${r.outcome} / ${h.events.join(' ')}`)
  assert.strictEqual(r.cursorsAdvanced, 0)
  assert.ok(r.accepted >= 0 && r.accepted <= 20)
  const releaseEvent = h.events.find((e) => e.startsWith('release@'))
  assert.ok(releaseEvent, 'the lease must still be released')
  assert.ok(RUN_OUTCOMES.includes(summarizeRun(r).outcome))
  assert.strictEqual(summarizeRun(r).cursors_advanced, 0)
})

console.log('')
console.log('the timing invariant, with the round trip accounted for')

test('the effective fresh lease STRICTLY covers every stage margin', () => {
  // The lease the worker can rely on is what it asked for MINUS one round trip, because
  // the database starts it when the RPC runs rather than when the response arrives.
  const effective = LEASE_SECONDS * 1000 - RPC_ROUND_TRIP_MS
  for (const [name, ms] of [
    ['loading the run context', CONTEXT_WORST_MS],
    ['one Graph page', PAGE_WORST_MS],
    ['one candidate write', WRITE_STEP_MS],
    ['cursor encryption + release', RELEASE_WORST_MS],
  ]) {
    assert.ok(effective > ms,
      `${name} (${ms / 1000}s) must be strictly covered by the effective lease (${effective / 1000}s)`)
  }
  // A renewal must clear the largest margin too, or the guard would renew forever without
  // ever getting past it. That is the trap 300s fell into once the margin became 285s.
  const effectiveRenewal = RENEW_SECONDS * 1000 - RPC_ROUND_TRIP_MS
  const largest = Math.max(CONTEXT_WORST_MS, PAGE_WORST_MS, WRITE_STEP_MS, RELEASE_WORST_MS)
  assert.ok(effectiveRenewal > largest,
    `a renewal (${effectiveRenewal / 1000}s) must clear the largest margin (${largest / 1000}s)`)
  assert.ok(LEASE_SECONDS <= 600 && RENEW_SECONDS <= 600,
    'both must satisfy the reservation RPC bound')
})

test('CONTEXT_WORST_MS counts the real path, including the refresh and the rotation', () => {
  // Counted from the loader's own constants, so adding a page or a read moves it.
  const pages = Math.ceil(MAX_CONTACTS_LOADED / CONTACT_PAGE_SIZE)
  assert.strictEqual(CONTEXT_DB_CALLS, 1 + pages + 1 + 1 + 1 + 1,
    'connection + contact pages + overflow probe + sync state + tokens + rotation')
  assert.strictEqual(CONTEXT_DB_CALLS, 18)
  assert.strictEqual(CONTEXT_WORST_MS, CONTEXT_DB_CALLS * RPC_ROUND_TRIP_MS + TOKEN_TIMEOUT_MS)
  assert.strictEqual(CONTEXT_WORST_MS, 285_000)
  // The earlier 255s omitted exactly the refresh and the rotation RPC.
  assert.ok(CONTEXT_WORST_MS > 255_000)
})

test('the round trip matches the port that actually makes the calls', () => {
  // Two constants describing one thing; pinned so they cannot drift apart.
  assert.strictEqual(RPC_ROUND_TRIP_MS, DB_TIMEOUT_MS)
  assert.strictEqual(WRITE_STEP_MS, RPC_ROUND_TRIP_MS + 5_000)
  assert.strictEqual(RELEASE_WORST_MS, RPC_ROUND_TRIP_MS + 5_000)
  assert.strictEqual(PAGE_WORST_MS, (MAX_RETRIES + 1) * REQUEST_TIMEOUT_MS + MAX_TOTAL_RETRY_DELAY_MS)
})

test('every deadline is anchored BEFORE its RPC, in the source', () => {
  const code = codeOnly(read('supabase/functions/shared/outlookImportRun.js'))
  assert.ok(/const reserveStartedMs = clock\(\)[\s\S]{0,200}rpc\('reserve_due_outlook_connection'/.test(code),
    'the reservation clock must be read before the call')
  assert.ok(/leaseUntilMs = reserveStartedMs \+ LEASE_SECONDS \* 1000/.test(code))
  assert.ok(/const renewStartedMs = clock\(\)[\s\S]{0,300}rpc\('renew_outlook_sync_lease'/.test(code),
    'the renewal clock must be read before the call')
  assert.ok(/leaseUntilMs = renewStartedMs \+ RENEW_SECONDS \* 1000/.test(code))
  assert.ok(!/leaseUntilMs = clock\(\)/.test(code),
    'no deadline may be anchored to a response')
  // And the release stage is guarded.
  assert.ok(/await ensureLease\(RELEASE_WORST_MS\)/.test(code))
  // Five call sites. The per-page hook is `() => ensureLease(PAGE_WORST_MS)`, which is
  // returned rather than awaited in place, so the sites are named individually.
  assert.ok(/await ensureLease\(CONTEXT_WORST_MS\)/.test(code), 'before the context load')
  assert.ok(/onPageComplete = \(\) => ensureLease\(PAGE_WORST_MS\)/.test(code), 'per page')
  assert.strictEqual((code.match(/ensureLease\(PAGE_WORST_MS\)/g) || []).length, 2,
    'the per-page hook plus the one before the first page')
  assert.ok(/await ensureLease\(WRITE_STEP_MS\)/.test(code), 'before each write')
  assert.ok(/await ensureLease\(RELEASE_WORST_MS\)/.test(code), 'before the release')
})

test('no heartbeat, scheduler or job framework was introduced', () => {
  const code = codeOnly(read('supabase/functions/shared/outlookImportRun.js'))
  for (const banned of ['setInterval', 'setTimeout', 'cron', 'queue', 'Worker(', 'heartbeat']) {
    assert.ok(!code.includes(banned), `must not use ${banned}`)
  }
  // The whole mechanism is one guard function called from five places.
  assert.strictEqual((code.match(/const ensureLease = async/g) || []).length, 1)
})

async function finish () {
  await Promise.all(pending)
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
await finish()
