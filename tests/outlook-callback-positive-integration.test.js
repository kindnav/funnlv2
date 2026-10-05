// BOUND POSITIVE CONTROL against the REAL outlook-oauth-callback handler.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT — stated precisely, because the
// distinction is the whole point of having it.
//
//   PROVES: a bound request gets past the browser-binding gate, performs the
//   state lookup, redeems the code, validates a genuinely RS256-signed
//   id_token against a served JWKS, calls Graph /me, and reaches
//   finalize_microsoft_connection with the arguments it should — including the
//   provider-granted scopes, the Graph-resolved mailbox address, and the
//   state's own user_id. It also proves the handler treats ONLY a 'stored'
//   result as success.
//
//   DOES NOT PROVE: that the RPC wrote a connection row. This harness records
//   the RPC request at a sink; a recorded request is not a write. The RPC's
//   own behaviour — atomic single-use consumption, the scope allowlist, the
//   same-account rule, consent copying — is proven separately against a real
//   Postgres by tests/sql/outlook-user-read-scope-runtime.sql and
//   tests/sql/outlook-content-draft-runtime.sql.
//
//   NOT EXERCISED AT ALL: real Microsoft behaviour. Every provider response
//   here is a local fixture built from Microsoft's documented contract. No
//   Entra registration exists, so the real /token, /discovery and /me
//   responses remain unverified assumptions.
//
// HOW THE FIXTURES ARE INJECTED: through a SEPARATE harness entrypoint
// (tests/harness/outlook-callback-fixture-entry.ts) that imports the same
// handler and passes its own endpoint object. The deployable entrypoint
// (supabase/functions/outlook-oauth-callback/index.ts) passes fixed Microsoft
// and Graph URLs and reads no endpoint configuration, so there is no branch in
// deployed code that could redirect the authorization code, the client secret
// or the Graph access token.
//
// OPT-IN:  FUNNL_EDGE_INTEGRATION=1 node tests/outlook-callback-positive-integration.test.js

import http from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { webcrypto, randomBytes, createHash } from 'node:crypto'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const COOKIE = '__Host-fnl_ms_oauth_bind'
const CONTAINER = 'funnl-outlook-positive-itest'
const HANDLER_PORT = 9981
const SINK_PORT = 9982
const FIXTURE_PORT = 9983
const CLIENT_ID = 'test-client-id'
const CALLBACK_URL = 'https://www.getfunnl.com/api/outlook-oauth-callback'
const USER_ID = '22222222-3333-4444-5555-666666666666'
const CONSUMERS = '9188040d-6c67-4c5b-b112-36a304b66dad'
// A plausible PERSONAL-account shape: a GUID whose leading 16 hex digits are
// zero. OID_SHORT_16 is its trailing 16 hex digits - the representation a live
// refusal raised a question about. Both are invented for this harness and are
// not any real account's identifier.
const OID = '00000000-0000-0000-7a3b-9c15e204d6f8'
const OID_SHORT_16 = '7a3b9c15e204d6f8'
// A WORK/SCHOOL tenant, and an oid that is ALSO zero-padded. Together they
// prove the short-form rule is gated on the TENANT and not merely on the shape:
// identical shapes, different tenant, and the connection must be refused.
const WORK_TENANT = '7c9e1b40-2a85-4d63-9f11-5ab8e0c47d22'
const WORK_OID = '00000000-0000-0000-5d2e-81ba37f4c609'
const WORK_OID_SHORT_16 = '5d2e81ba37f4c609'
const MAILBOX = 'student@outlook.test'

let passed = 0, failed = 0
function check (name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); passed++ }
  else { console.error(`  ✗ ${name}`); if (detail) console.error(`    ${detail}`); failed++ }
}
function skip (why) {
  console.log(`\nSKIPPED: ${why}`)
  console.log('\n0 tests: 0 passed, 0 failed\n')
  process.exitCode = 0
}


// ── helpers ──────────────────────────────────────────────────────────────────
const b64u = (b) => Buffer.from(b).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

async function aesEncrypt (plaintext, rawKey) {
  const key = await webcrypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt'])
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(plaintext))
  return {
    ciphertext: Buffer.from(new Uint8Array(ct)).toString('base64'),
    nonce: Buffer.from(iv).toString('base64'),
  }
}

async function aesDecrypt (ciphertextB64, nonceB64, rawKey) {
  const key = await webcrypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt'])
  const pt = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(nonceB64, 'base64') }, key,
    Buffer.from(ciphertextB64, 'base64'))
  return new TextDecoder().decode(pt)
}

async function makeSigner () {
  const kp = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'])
  const jwk = await webcrypto.subtle.exportKey('jwk', kp.publicKey)
  const kid = 'test-key-1'
  return {
    jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] },
    sign: async (payload) => {
      const h = b64u(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })))
      const p = b64u(Buffer.from(JSON.stringify(payload)))
      const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey,
        new TextEncoder().encode(`${h}.${p}`))
      return `${h}.${p}.${b64u(new Uint8Array(sig))}`
    },
  }
}

function stopHandler () {
  try { execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }) } catch { /* not running */ }
}

async function startHandler (keyB64, callbackUrl = CALLBACK_URL) {
  stopHandler()
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', CONTAINER,
    '-p', `${HANDLER_PORT}:8000`,
    // Mount the REPO ROOT so the harness entry can import the shared handler.
    '-v', `${ROOT}:/repo:ro`,
    '-w', '/repo',
    '-e', `SUPABASE_URL=http://host.docker.internal:${SINK_PORT}`,
    '-e', 'SUPABASE_SERVICE_ROLE_KEY=test-service-role-key',
    '-e', 'OUTLOOK_INTEGRATION_ENABLED=true',
    '-e', `MICROSOFT_CLIENT_ID=${CLIENT_ID}`,
    '-e', 'MICROSOFT_CLIENT_SECRET=test-client-secret',
    '-e', `OUTLOOK_OAUTH_CALLBACK_URL=${callbackUrl}`,
    '-e', `MICROSOFT_TOKEN_ENCRYPTION_KEY_V1=${keyB64}`,
    '-e', `FIXTURE_BASE=http://host.docker.internal:${FIXTURE_PORT}`,
    'denoland/deno:alpine',
    // --no-lock: the repo is mounted read-only, so Deno must not try to write
    // a lockfile into it.
    'run', '--no-lock', '--allow-net', '--allow-env', '--allow-read',
    'tests/harness/outlook-callback-fixture-entry.ts',
  ], { stdio: 'ignore' })
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${HANDLER_PORT}/`, { method: 'GET' })
      if (r.status === 405) return
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('the containerised callback never started listening')
}

async function run () {
  console.log('\nreal outlook-oauth-callback: BOUND POSITIVE CONTROL (local fixtures)')

  const rawKey = randomBytes(32)
  const keyB64 = rawKey.toString('base64')
  const signer = await makeSigner()

  const state = b64u(randomBytes(32))
  const stateHash = sha256hex(state)
  const expectedNonce = sha256hex(`nonce:${state}`)
  const verifier = b64u(randomBytes(32))
  const sealedVerifier = await aesEncrypt(verifier, rawKey)

  // What the scenario should hand back.
  let scenario = {
    grantedScope: 'openid profile email offline_access Mail.Read User.Read',
    meBody: { id: OID, mail: MAILBOX, userPrincipalName: 'upn@outlook.test' },
    rpcResult: { result: 'stored', connection_id: 'conn-1' },
    stateRow: null,   // set below
    tokenStatus: 200,
    // The id_token's tenant and object id. Scenario-driven so a work/school
    // account can be described as well as a personal one; the issuer is derived
    // from the tenant, exactly as the handler pins it.
    tid: CONSUMERS,
    oid: OID,
  }
  const freshRow = (over = {}) => ({
    state_hash: stateHash, user_id: USER_ID,
    pkce_verifier_ciphertext: sealedVerifier.ciphertext,
    pkce_verifier_nonce: sealedVerifier.nonce,
    key_version: 1, return_origin: 'https://www.getfunnl.com',
    expires_at: new Date(Date.now() + 9 * 60_000).toISOString(),
    consumed_at: null, ...over,
  })
  scenario.stateRow = freshRow()

  const seen = { tokenCalls: 0, meCalls: 0, rpcArgs: [], stateQueries: 0, verifierSent: null }

  // ── Supabase sink: state row + the finalize RPC ───────────────────────────
  const sink = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const path = req.url.split('?')[0]
      if (path === '/rest/v1/microsoft_oauth_states' && req.method === 'GET') {
        seen.stateQueries++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(scenario.stateRow ? [scenario.stateRow] : []))
      }
      if (path === '/rest/v1/rpc/finalize_microsoft_connection' && req.method === 'POST') {
        try { seen.rpcArgs.push(JSON.parse(body)) } catch { seen.rpcArgs.push(null) }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(scenario.rpcResult))
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
  })
  sink.listen(SINK_PORT, '0.0.0.0'); await once(sink, 'listening')

  // ── Microsoft / Graph fixtures (loopback only) ────────────────────────────
  const fixtures = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      const path = req.url.split('?')[0]
      if (path === '/token' && req.method === 'POST') {
        seen.tokenCalls++
        seen.verifierSent = new URLSearchParams(body).get('code_verifier')
        if (scenario.tokenStatus !== 200) {
          res.writeHead(scenario.tokenStatus, { 'Content-Type': 'application/json' })
          return res.end('{"error":"invalid_grant"}')
        }
        const now = Math.floor(Date.now() / 1000)
        const idToken = await signer.sign({
          iss: `https://login.microsoftonline.com/${scenario.tid}/v2.0`,
          aud: CLIENT_ID, tid: scenario.tid, oid: scenario.oid, nonce: expectedNonce,
          exp: now + 3600, nbf: now - 60, iat: now, email: MAILBOX,
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({
          access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token',
          id_token: idToken, expires_in: 3600, scope: scenario.grantedScope,
        }))
      }
      if (path === '/jwks') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(signer.jwks))
      }
      if (path === '/me') {
        seen.meCalls++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(scenario.meBody))
      }
      res.writeHead(404); res.end()
    })
  })
  fixtures.listen(FIXTURE_PORT, '0.0.0.0'); await once(fixtures, 'listening')

  const post = async (cookie) => {
    seen.tokenCalls = 0; seen.meCalls = 0; seen.rpcArgs = []; seen.stateQueries = 0
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
    if (cookie) headers.Cookie = cookie
    const res = await fetch(`http://127.0.0.1:${HANDLER_PORT}/`, {
      method: 'POST', headers, redirect: 'manual',
      body: new URLSearchParams({ state, code: 'FIXTURE-CODE' }).toString(),
    })
    await new Promise((r) => setTimeout(r, 600))
    return { status: res.status, location: res.headers.get('location') }
  }

  try {
    await startHandler(keyB64)

    // ── THE POSITIVE CONTROL ────────────────────────────────────────────────
    let r = await post(`${COOKIE}=${state}`)
    check('bound POST reaches the STATE LOOKUP (gate passed)',
      seen.stateQueries === 1, `stateQueries=${seen.stateQueries}`)
    check('bound POST redeems the code at the token endpoint',
      seen.tokenCalls === 1, `tokenCalls=${seen.tokenCalls}`)
    check('the DECRYPTED PKCE verifier is sent to the token endpoint',
      seen.verifierSent === verifier, 'verifier round-trip failed')
    check('bound POST calls Graph /me', seen.meCalls === 1, `meCalls=${seen.meCalls}`)
    check('bound POST reaches finalize_microsoft_connection',
      seen.rpcArgs.length === 1, `rpcCalls=${seen.rpcArgs.length}`)

    const a = seen.rpcArgs[0] ?? {}
    check('finalize receives the state hash, not the state',
      a.p_state_hash === stateHash && a.p_state_hash !== state, 'wrong p_state_hash')
    check('finalize receives the user id FROM THE STATE ROW',
      a.p_expected_user_id === USER_ID, String(a.p_expected_user_id))
    check('finalize receives the Graph-resolved mailbox address',
      a.p_ms_email === MAILBOX, String(a.p_ms_email))
    check('finalize receives identity from the VALIDATED id_token',
      a.p_ms_account_id === OID && a.p_ms_tenant_id === CONSUMERS && a.p_account_type === 'personal',
      JSON.stringify({ id: a.p_ms_account_id, tid: a.p_ms_tenant_id, t: a.p_account_type }))
    check('finalize receives PROVIDER-GRANTED scopes, not what we asked for',
      Array.isArray(a.p_scopes) && a.p_scopes.includes('Mail.Read') && a.p_scopes.includes('User.Read'),
      JSON.stringify(a.p_scopes))
    // A real round trip, not merely 'the ciphertext differs from the plaintext'.
    // Decrypt what the handler sent, with the same key it was given, and
    // compare against the fixture tokens.
    let decAccess = null, decRefresh = null
    try {
      decAccess = await aesDecrypt(a.p_access_ct, a.p_access_nonce, rawKey)
      decRefresh = await aesDecrypt(a.p_refresh_ct, a.p_refresh_nonce, rawKey)
    } catch (e) { decAccess = 'DECRYPT FAILED: ' + e.message }
    check('access token DECRYPTS back to the fixture token',
      decAccess === 'fixture-access-token', String(decAccess).slice(0, 60))
    check('refresh token DECRYPTS back to the fixture token',
      decRefresh === 'fixture-refresh-token', String(decRefresh).slice(0, 60))
    check('the ciphertext is not the plaintext, and a nonce accompanies each',
      a.p_access_ct !== 'fixture-access-token' &&
      a.p_refresh_ct !== 'fixture-refresh-token' &&
      typeof a.p_access_nonce === 'string' && a.p_access_nonce.length > 0 &&
      typeof a.p_refresh_nonce === 'string' && a.p_refresh_nonce.length > 0 &&
      a.p_access_nonce !== a.p_refresh_nonce,
      'ciphertext/nonce shape wrong')
    check('a stored result redirects to the CONNECTED settings page',
      r.status === 303 && String(r.location).endsWith('/settings?outlook=connected'),
      `${r.status} ${r.location}`)

    // ── refusals: each must stop BEFORE the provider ─────────────────────────
    scenario.stateRow = null
    r = await post(`${COOKIE}=${state}`)
    check('unknown state: refused, no token call',
      seen.tokenCalls === 0 && r.status === 303 && String(r.location).includes('outlook=error'),
      `tokenCalls=${seen.tokenCalls}`)

    scenario.stateRow = freshRow({ consumed_at: new Date().toISOString() })
    r = await post(`${COOKIE}=${state}`)
    check('REPLAY of a consumed state: refused, no token call',
      seen.tokenCalls === 0 && seen.rpcArgs.length === 0, `tokenCalls=${seen.tokenCalls}`)

    scenario.stateRow = freshRow({ expires_at: new Date(Date.now() - 60_000).toISOString() })
    r = await post(`${COOKIE}=${state}`)
    check('expired state: refused, no token call',
      seen.tokenCalls === 0 && seen.rpcArgs.length === 0, `tokenCalls=${seen.tokenCalls}`)

    // ── failures after redemption ───────────────────────────────────────────
    scenario.stateRow = freshRow()
    scenario.tokenStatus = 400
    r = await post(`${COOKIE}=${state}`)
    check('failed redemption: no Graph call, no finalize',
      seen.meCalls === 0 && seen.rpcArgs.length === 0 && String(r.location).includes('outlook=error'),
      `me=${seen.meCalls} rpc=${seen.rpcArgs.length}`)
    scenario.tokenStatus = 200

    scenario.grantedScope = 'openid profile email offline_access Mail.Read'
    r = await post(`${COOKIE}=${state}`)
    check('User.Read DECLINED by the user: no Graph call, no finalize',
      seen.meCalls === 0 && seen.rpcArgs.length === 0, `me=${seen.meCalls} rpc=${seen.rpcArgs.length}`)
    scenario.grantedScope = 'openid profile email offline_access Mail.Read User.Read'

    scenario.meBody = { id: 'a-different-account', mail: MAILBOX }
    r = await post(`${COOKIE}=${state}`)
    check('MISMATCHED Graph identity: fails closed, no finalize',
      seen.rpcArgs.length === 0 && String(r.location).includes('outlook=error'),
      `rpc=${seen.rpcArgs.length}`)

    // ── THE MAPPED PERSONAL PAIR: the measured live representation ─────────
    // Graph returns the 16-hex trailing half of the zero-padded GUID the
    // id_token asserted, on the consumers tenant. One controlled Production
    // attempt measured exactly this. It must now REACH finalization - and the
    // identity it stores must still be the VALIDATED oid, not the short form.
    scenario.meBody = { id: OID_SHORT_16, mail: MAILBOX }
    r = await post(`${COOKIE}=${state}`)
    check('MAPPED personal pair (16-hex vs zero-padded GUID) REACHES finalize',
      seen.rpcArgs.length === 1, `rpc=${seen.rpcArgs.length}`)
    check('MAPPED personal pair redirects to the CONNECTED settings page',
      r.status === 303 && String(r.location).endsWith('/settings?outlook=connected'),
      `${r.status} ${r.location}`)
    const mapped = seen.rpcArgs[0] ?? {}
    check('the stored identity is the VALIDATED oid, NOT the Graph short form',
      mapped.p_ms_account_id === OID && mapped.p_ms_account_id !== OID_SHORT_16,
      'p_ms_account_id is not the validated oid')
    check('and it is still classified personal on the consumers tenant',
      mapped.p_ms_tenant_id === CONSUMERS && mapped.p_account_type === 'personal',
      JSON.stringify({ tid: mapped.p_ms_tenant_id, t: mapped.p_account_type }))
    check('the Graph-resolved mailbox address is still what is stored',
      mapped.p_ms_email === MAILBOX, String(mapped.p_ms_email))
    // Casing is not promised by Graph, so the rule must survive it.
    scenario.meBody = { id: OID_SHORT_16.toUpperCase(), mail: MAILBOX }
    r = await post(`${COOKIE}=${state}`)
    check('an UPPERCASE short form also finalizes, with the same stored identity',
      seen.rpcArgs.length === 1 && (seen.rpcArgs[0] ?? {}).p_ms_account_id === OID,
      `rpc=${seen.rpcArgs.length}`)

    // ── refusals that must SURVIVE the new rule ────────────────────────────
    // The REVERSE direction: a GUID from Graph against a 16-hex oid.
    scenario.oid = OID_SHORT_16
    scenario.meBody = { id: OID, mail: MAILBOX }
    r = await post(`${COOKIE}=${state}`)
    check('REVERSE direction (GUID from Graph, 16-hex oid): NO finalize',
      seen.rpcArgs.length === 0 && String(r.location).includes('outlook=error'),
      `rpc=${seen.rpcArgs.length}`)
    scenario.oid = OID

    // A FLAT 32-hex form is not the GUID form the rule requires.
    scenario.meBody = { id: OID.replace(/-/g, ''), mail: MAILBOX }
    r = await post(`${COOKIE}=${state}`)
    check('flat 32-hex Graph id vs GUID oid: NO finalize',
      seen.rpcArgs.length === 0 && String(r.location).includes('outlook=error'),
      `rpc=${seen.rpcArgs.length}`)

    // An UNRELATED personal account, zero-padded like the real one.
    scenario.meBody = { id: '1111222233334444', mail: MAILBOX }
    r = await post(`${COOKIE}=${state}`)
    check('an UNRELATED personal 16-hex id: NO finalize',
      seen.rpcArgs.length === 0 && String(r.location).includes('outlook=error'),
      `rpc=${seen.rpcArgs.length}`)

    // MALFORMED: an address-shaped id, and an absent id.
    scenario.meBody = { id: MAILBOX, mail: MAILBOX }
    r = await post(`${COOKIE}=${state}`)
    check('an address-shaped Graph id: NO finalize (email is never identity)',
      seen.rpcArgs.length === 0 && String(r.location).includes('outlook=error'),
      `rpc=${seen.rpcArgs.length}`)
    scenario.meBody = { mail: MAILBOX }
    r = await post(`${COOKIE}=${state}`)
    check('a Graph body with NO id at all: NO finalize',
      seen.rpcArgs.length === 0 && String(r.location).includes('outlook=error'),
      `rpc=${seen.rpcArgs.length}`)

    // ── WORK/SCHOOL: identical shapes, different tenant, still refused ─────
    scenario.tid = WORK_TENANT
    scenario.oid = WORK_OID
    scenario.meBody = { id: WORK_OID_SHORT_16, mail: MAILBOX }
    r = await post(`${COOKIE}=${state}`)
    check('a WORK/SCHOOL short form is REFUSED even though the shape matches',
      seen.rpcArgs.length === 0 && String(r.location).includes('outlook=error'),
      `rpc=${seen.rpcArgs.length}`)
    check('that refusal came after Graph /me, so the rule was actually consulted',
      seen.meCalls === 1, `me=${seen.meCalls}`)
    // CONTROL for the work tenant: exact equality still works there.
    scenario.meBody = { id: WORK_OID, mail: MAILBOX }
    r = await post(`${COOKIE}=${state}`)
    const workExact = seen.rpcArgs[0] ?? {}
    check('a WORK/SCHOOL account with an EXACTLY equal id still finalizes',
      seen.rpcArgs.length === 1 && String(r.location).endsWith('/settings?outlook=connected'),
      `rpc=${seen.rpcArgs.length} ${r.location}`)
    check('and it is classified work, with the validated oid stored',
      workExact.p_account_type === 'work' && workExact.p_ms_account_id === WORK_OID,
      JSON.stringify({ t: workExact.p_account_type }))
    scenario.tid = CONSUMERS
    scenario.oid = OID

    // POSITIVE CONTROL: exact equality on the personal account, unchanged.
    scenario.meBody = { id: OID, mail: MAILBOX, userPrincipalName: 'upn@outlook.test' }
    r = await post(`${COOKIE}=${state}`)
    check('an exactly equal personal Graph id still finalizes',
      seen.rpcArgs.length === 1 && String(r.location).endsWith('/settings?outlook=connected'),
      `rpc=${seen.rpcArgs.length} ${r.location}`)

    scenario.meBody = { id: OID, userPrincipalName: 'NOT-AN-ADDRESS' }
    r = await post(`${COOKIE}=${state}`)
    check('unusable mailbox address: no finalize, no invented address',
      seen.rpcArgs.length === 0, `rpc=${seen.rpcArgs.length}`)
    scenario.meBody = { id: OID, mail: MAILBOX, userPrincipalName: 'upn@outlook.test' }

    scenario.rpcResult = { result: 'state_consumed' }
    r = await post(`${COOKIE}=${state}`)
    check('a NON-stored RPC result is NOT treated as success',
      r.status === 303 && String(r.location).includes('outlook=error'), String(r.location))
    scenario.rpcResult = { result: 'stored', connection_id: 'conn-1' }

    // ── a wrong but NON-EMPTY callback URI must send no code anywhere ───────
    // outlook-oauth-start refuses to mint unless the configured callback URL is
    // the exact branded URI; the callback must apply the same check BEFORE it
    // forwards a code and a client secret to the token endpoint.
    scenario.stateRow = freshRow()
    await startHandler(keyB64, 'https://attacker.example.com/api/outlook-oauth-callback')
    r = await post(`${COOKIE}=${state}`)
    check('WRONG callback URI config: state looked up but NO token request',
      seen.tokenCalls === 0 && seen.meCalls === 0 && seen.rpcArgs.length === 0,
      `token=${seen.tokenCalls} me=${seen.meCalls} rpc=${seen.rpcArgs.length}`)
    check('WRONG callback URI config: redirects to the error page',
      r.status === 303 && String(r.location).includes('outlook=error'), String(r.location))
    await startHandler(keyB64)

    // ── the gate still comes first ──────────────────────────────────────────
    r = await post(null)
    check('UNBOUND POST still makes zero state, provider and RPC calls',
      seen.stateQueries === 0 && seen.tokenCalls === 0 && seen.meCalls === 0 && seen.rpcArgs.length === 0,
      JSON.stringify(seen))
  } finally {
    stopHandler()
    sink.close()
    fixtures.close()
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}


// Entry point last: the helpers above are const-declared and would otherwise
// be in the temporal dead zone when run() executes.
if (process.env.FUNNL_EDGE_INTEGRATION !== '1') {
  skip('opt-in Edge integration test not enabled')
} else {
  let ok = true
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }) } catch { ok = false }
  if (!ok) skip('Docker daemon not available')
  else await run()
}