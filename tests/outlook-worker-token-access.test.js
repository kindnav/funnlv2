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
  CONTEXT_FAILURES, EXPIRY_SKEW_SECONDS, MAX_CONTACTS_LOADED,
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
  LEASE_SECONDS, RENEW_SECONDS, RENEW_EVERY_PAGES, RUN_OUTCOMES, runOutlookImport, summarizeRun,
} from '../supabase/functions/shared/outlookImportRun.js'
import {
  MAX_PAGES_PER_RUN, MAX_RETRIES, REQUEST_TIMEOUT_MS, MAX_TOTAL_RETRY_DELAY_MS, GRAPH_BASE,
} from '../supabase/functions/shared/outlookGraphTransport.js'

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
const U1 = '11111111-1111-1111-1111-111111111111'
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
  assert.ok(contactRead.includes(`limit=${MAX_CONTACTS_LOADED}`), 'the contact read must be bounded')
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
  assert.deepStrictEqual([...OK_OUTCOMES], ['committed', 'none_due', 'incomplete'])
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

console.log('\nthe lease is renewed, because the bounded worst case demands it')

test('the worst-case run is longer than any lease the RPC will grant', () => {
  const perRequest = (MAX_RETRIES + 1) * REQUEST_TIMEOUT_MS + MAX_TOTAL_RETRY_DELAY_MS
  const worstRun = MAX_PAGES_PER_RUN * perRequest
  assert.strictEqual(perRequest, 140_000)
  assert.strictEqual(worstRun, 2_800_000)
  assert.ok(worstRun / 1000 > 600,
    'the reservation RPC caps p_lease_seconds at 600, so one lease cannot cover a long run')
  assert.ok(LEASE_SECONDS <= 600 && RENEW_SECONDS <= 600, 'both must satisfy the RPC bound')
  assert.ok(RENEW_EVERY_PAGES * perRequest < RENEW_SECONDS * 1000 * 2,
    'renewal must happen often enough that a slow page cannot outlast the lease')
})

test('a renewal that does not confirm stops the run as lease_lost, with no cursor', async () => {
  const calls = []
  const rpc = async (name, args) => {
    calls.push({ name, args })
    if (name === 'reserve_due_outlook_connection') {
      return { data: { result: 'reserved', connection_id: CONN, run_id: RUN }, error: null }
    }
    if (name === 'renew_outlook_sync_lease') return { data: false, error: null }
    if (name === 'release_outlook_sync_lease') return { data: true, error: null }
    return { data: { result: 'created' }, error: null }
  }
  // Enough pages to trigger a renewal.
  let served = 0
  const fetchImpl = async (url) => {
    served += 1
    const folder = url.includes('/mailFolders/inbox/') ? 'inbox' : 'sentitems'
    return { status: 200, headers: { get: () => null }, json: async () => ({
      value: [],
      '@odata.nextLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$skiptoken=n${served}`,
    }) }
  }
  const r = await runOutlookImport({
    rpc, encryptCursor: async () => ({ ciphertext: 'CT', nonce: 'N', keyVersion: 1 }),
    loadRunContext: async () => ({
      primaryEmail: 'me@x.test', userId: U1, contacts: [], cursors: {}, timeZone: 'UTC',
      accessToken: 'tok', keyRing: { current: { keyBytes: new Uint8Array(32), keyVersion: 1 } },
    }),
    deps: { fetchImpl },
  })
  assert.strictEqual(r.outcome, 'lease_lost')
  assert.strictEqual(r.cursorsAdvanced, 0)
  assert.ok(calls.some((c) => c.name === 'renew_outlook_sync_lease'), 'a renewal must be attempted')
  const rel = calls.filter((c) => c.name === 'release_outlook_sync_lease').at(-1).args
  assert.strictEqual(rel.p_status, 'error')
  assert.strictEqual(rel.p_error_code, 'lease_lost')
  assert.strictEqual(rel.p_inbox_delta_ct, null)
  assert.ok(RUN_OUTCOMES.includes(summarizeRun(r).outcome))
})

test('a context failure reaches the run as a controlled reason, and releases the lease', async () => {
  const calls = []
  const rpc = async (name) => {
    calls.push(name)
    if (name === 'reserve_due_outlook_connection') {
      return { data: { result: 'reserved', connection_id: CONN, run_id: RUN }, error: null }
    }
    return { data: true, error: null }
  }
  const r = await runOutlookImport({
    rpc, encryptCursor: async () => ({ ciphertext: 'C', nonce: 'N', keyVersion: 1 }),
    loadRunContext: async () => { throw new RunContextError('refresh_failed') },
    deps: { fetchImpl: async () => { throw new Error('must not be called') } },
  })
  assert.strictEqual(r.outcome, 'released_error')
  assert.strictEqual(r.reason, 'refresh_failed')
  assert.strictEqual(summarizeRun(r).reason, 'refresh_failed')
  assert.ok(calls.includes('release_outlook_sync_lease'), 'the lease must not be left held')
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
  for (const blocker of ['DURABLE CONTINUATION', 'Entra application', 'Mail.Read', 'No scheduler']) {
    assert.ok(HANDLER_SRC.includes(blocker), `the handler must still record: ${blocker}`)
  }
})

async function finish () {
  await Promise.all(pending)
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
await finish()
