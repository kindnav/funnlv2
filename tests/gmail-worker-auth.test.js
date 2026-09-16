// Tests for private worker authentication + the E2B Edge shells' dormancy/scope guards.
// Synthetic secrets only — no real credential values anywhere.
// Run: node tests/gmail-worker-auth.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  timingSafeEqualStr, parseBearer, authorizeWorkerRequest, MIN_WORKER_SECRET_LENGTH,
} from '../supabase/functions/shared/workerAuth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

const SECRET = 'S'.repeat(MIN_WORKER_SECRET_LENGTH)          // synthetic, not a real secret
const OK = { method: 'POST', authorization: `Bearer ${SECRET}`, configuredSecret: SECRET }

console.log('\nconstant-time comparison')
test('equal strings match; any difference fails', () => {
  assert.strictEqual(timingSafeEqualStr('abc', 'abc'), true)
  assert.strictEqual(timingSafeEqualStr('abc', 'abd'), false)
  assert.strictEqual(timingSafeEqualStr('abc', 'ab'), false)
  assert.strictEqual(timingSafeEqualStr('', ''), true)
})
test('length mismatch is folded in (no early return) and non-strings fail', () => {
  assert.strictEqual(timingSafeEqualStr('a', 'a'.repeat(100)), false)
  assert.strictEqual(timingSafeEqualStr(null, 'a'), false)
  assert.strictEqual(timingSafeEqualStr('a', undefined), false)
  assert.strictEqual(timingSafeEqualStr(1, 1), false)
})
test('implementation has no short-circuit return inside the compare loop', () => {
  const src = stripJs(read('supabase/functions/shared/workerAuth.js'))
  const body = src.match(/export function timingSafeEqualStr[\s\S]*?\n\}/)[0]
  const loop = body.match(/for \(let i = 0[\s\S]*?\n  \}/)[0]
  assert.ok(!/return/.test(loop), 'the comparison loop must not return early')
  assert.ok(/diff \|=/.test(loop), 'must accumulate with |=')
})
test('multi-byte input is compared by bytes', () => {
  assert.strictEqual(timingSafeEqualStr('é', 'é'), true)
  assert.strictEqual(timingSafeEqualStr('é', 'e'), false)
})

console.log('\nparseBearer')
test('accepts a well-formed bearer, rejects everything else', () => {
  assert.strictEqual(parseBearer('Bearer abc.DEF-123_x='), 'abc.DEF-123_x=')
  assert.strictEqual(parseBearer('bearer abc'), null, 'scheme is case-sensitive')
  assert.strictEqual(parseBearer('Basic abc'), null)
  assert.strictEqual(parseBearer('Bearer'), null)
  assert.strictEqual(parseBearer('Bearer  two spaces'), null)
  assert.strictEqual(parseBearer('Bearer a b'), null)
  assert.strictEqual(parseBearer(null), null)
  assert.strictEqual(parseBearer('Bearer ' + 'x'.repeat(9000)), null, 'oversized header rejected')
})

console.log('\nauthorizeWorkerRequest: denial paths')
test('correct secret + POST authorizes', () => {
  assert.deepStrictEqual(authorizeWorkerRequest(OK), { ok: true })
})
test('non-POST is rejected 405', () => {
  for (const m of ['GET', 'PUT', 'DELETE', 'OPTIONS', undefined]) {
    const r = authorizeWorkerRequest({ ...OK, method: m })
    assert.deepStrictEqual(r, { ok: false, status: 405, code: 'method_not_allowed' })
  }
})
test('missing/short configured secret -> 503 worker_not_configured (fails closed)', () => {
  for (const s of [null, undefined, '', 'short', 'x'.repeat(MIN_WORKER_SECRET_LENGTH - 1)]) {
    const r = authorizeWorkerRequest({ ...OK, configuredSecret: s })
    assert.deepStrictEqual(r, { ok: false, status: 503, code: 'worker_not_configured' })
  }
})
test('missing/malformed authorization -> 401', () => {
  for (const a of [null, '', 'Basic x', 'Bearer', 'bearer ' + SECRET]) {
    assert.deepStrictEqual(authorizeWorkerRequest({ ...OK, authorization: a }), { ok: false, status: 401, code: 'unauthorized' })
  }
})
test('wrong secret -> 401 and never echoes the secret', () => {
  const r = authorizeWorkerRequest({ ...OK, authorization: `Bearer ${'W'.repeat(MIN_WORKER_SECRET_LENGTH)}` })
  assert.deepStrictEqual(r, { ok: false, status: 401, code: 'unauthorized' })
  assert.ok(!JSON.stringify(r).includes(SECRET))
})
test('a user JWT-shaped credential is NOT accepted as the worker secret', () => {
  const jwtish = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.sig'
  assert.deepStrictEqual(authorizeWorkerRequest({ ...OK, authorization: `Bearer ${jwtish}` }), { ok: false, status: 401, code: 'unauthorized' })
})

console.log('\nEdge shells: dormancy + scope guards')
const WORKER = read('supabase/functions/gmail-sync-worker/index.ts')
const START = read('supabase/functions/gmail-oauth-start/index.ts')
const CALLBACK = read('supabase/functions/google-oauth-callback/index.ts')
const CONFIG = read('supabase/config.toml')

test('worker requires the secret via authorizeWorkerRequest before any other work', () => {
  const code = stripJs(WORKER)
  assert.ok(/authorizeWorkerRequest\(/.test(code))
  // the auth gate must precede the service-role client construction
  assert.ok(code.indexOf('authorizeWorkerRequest') < code.indexOf('createClient('), 'auth must gate first')
})
test('worker honors the GMAIL_INTEGRATION_ENABLED kill switch, checked only AFTER the secret', () => {
  const code = stripJs(WORKER)
  assert.ok(/GMAIL_INTEGRATION_ENABLED'\) \?\? ''\) !== 'true'/.test(code), 'exact-match switch')
  assert.ok(/gmail_not_enabled/.test(code))
  const authIdx = code.indexOf('authorizeWorkerRequest(')
  const switchIdx = code.indexOf("GMAIL_INTEGRATION_ENABLED')")
  assert.ok(authIdx < switchIdx, 'an unauthenticated caller cannot probe the switch')
  assert.ok(switchIdx < code.indexOf('createClient('), 'the switch precedes any client construction')
})
test('worker is declared verify_jwt = false (user JWTs grant nothing)', () => {
  assert.ok(/\[functions\.gmail-sync-worker\][\s\S]*?verify_jwt = false/.test(CONFIG))
})
test('gmail-oauth-start keeps verify_jwt = true and calls auth.getUser()', () => {
  assert.ok(/\[functions\.gmail-oauth-start\][\s\S]*?verify_jwt = true/.test(CONFIG))
  assert.ok(/auth\.getUser\(\)/.test(START))
})
test('gmail-oauth-start is hard-gated by GMAIL_INTEGRATION_ENABLED === "true"', () => {
  assert.ok(/GMAIL_INTEGRATION_ENABLED'\) \?\? ''\) !== 'true'/.test(START))
  assert.ok(/gmail_not_enabled/.test(START))
  const code = stripJs(START)
  assert.ok(code.indexOf('GMAIL_INTEGRATION_ENABLED') < code.indexOf('auth.getUser'), 'dormancy gate is first')
})
test('worker has no scheduler/Cron/sweep and reserves exactly one connection', () => {
  const code = stripJs(WORKER)
  assert.ok(!/cron|schedule|setInterval|setTimeout\(\s*\(\)\s*=>\s*run/i.test(code), 'no self-scheduling')
  assert.ok(/reserve_due_gmail_connection/.test(code))
  assert.ok(!/for \(const (user|conn) of/.test(code), 'no loop over users/connections')
})
test('worker never calls .json()/.text() on a provider response', () => {
  const code = stripJs(WORKER)
  assert.ok(!/res\.json\(\)|response\.json\(\)/.test(code))
  assert.ok(!/\.text\(\)/.test(code))
  assert.ok(/readBoundedStream/.test(code), 'bounded read used for the token exchange too')
})
test('gmail-oauth-start requests ONLY the Gmail path (never the calendar scope builder)', () => {
  const code = stripJs(START)
  assert.ok(/buildGmailAuthUrl/.test(code))
  assert.ok(!/buildGoogleAuthUrl/.test(code), 'must not use the Calendar default builder')
  assert.ok(/integration_type:\s*GMAIL_INTEGRATION_TYPE/.test(code))
})
test('google-oauth-start (Calendar) is NOT modified by E2B', () => {
  const cal = read('supabase/functions/google-oauth-start/index.ts')
  assert.ok(!/gmail/i.test(stripJs(cal)), 'Calendar start function must contain no Gmail reference')
})
test('callback branches on integration_type and keeps the Calendar path intact', () => {
  const code = stripJs(CALLBACK)
  assert.ok(/integration_type/.test(code), 'state select includes integration_type')
  assert.ok(/const isGmailFlow = stateRow\.integration_type === GMAIL_INTEGRATION_TYPE/.test(code),
    'the flow is decided from the state row, not from any caller input')
  assert.ok(/if \(isGmailFlow\) \{/.test(code), 'explicit gmail branch')
  assert.ok(/finalizeGmailCapability\(/.test(code))
  assert.ok(/finalizeGoogleConnection\(/.test(code), 'Calendar finalizer still present')
  // the gmail branch must be reached (and return) before the Calendar finalizer runs
  assert.ok(code.search(/finalizeGmailCapability\(/) < code.search(/finalizeGoogleConnection\(\{/))
  // every exit from the gmail branch returns — it can never fall through to Calendar
  const branch = code.slice(code.search(/if \(isGmailFlow\) \{/), code.search(/finalizeGoogleConnection\(\{/))
  assert.strictEqual((branch.match(/return redirect\(/g) ?? []).length, 2, 'gmail branch returns on both ok and !ok')
  // and its error target is the gmail banner, never Calendar's
  assert.ok(/safeErrorRedirect = isGmailFlow/.test(code), 'error redirect is integration-aware')
  assert.ok(/buildGmailSettingsRedirect\(validatedOrigin, 'error'\)/.test(code))
})
test('callback requests no Gmail scope itself and stays JWT-free (public redirect endpoint)', () => {
  const code = stripJs(CALLBACK)
  assert.ok(!/gmail\.readonly|GMAIL_OAUTH_SCOPES|buildGmailAuthUrl/.test(code), 'callback never asks for scope')
  assert.ok(/\[functions\.google-oauth-callback\][\s\S]*?verify_jwt = false/.test(CONFIG), 'unchanged by E2B')
})
test('worker reuses the proven Google token helpers instead of reimplementing them', () => {
  const code = stripJs(WORKER)
  assert.ok(/shouldRefreshToken/.test(code), 'near-expiry decision reused')
  assert.ok(/validateRefreshResponse/.test(code), 'refresh-response validation reused')
  assert.ok(/grantedScopesIncludeGmailReadonly/.test(code), 'scope loss detected via the shared predicate')
})
test('store_refreshed_google_token is called with its COMPLETE argument set', () => {
  const code = stripJs(WORKER)
  const call = code.slice(code.indexOf("store_refreshed_google_token"))
  for (const p of ['p_connection_id', 'p_expected_google_sub', 'p_access_ct', 'p_access_nonce',
                   'p_refresh_ct', 'p_refresh_nonce', 'p_key_version', 'p_token_expires_at']) {
    assert.ok(new RegExp(`${p}:`).test(call.slice(0, 900)), `missing ${p}`)
  }
  // the account guard must be a real sub, and the connection id must be the reserved one
  assert.ok(/p_expected_google_sub:\s*conn\.googleSub/.test(call))
  assert.ok(/p_connection_id:\s*conn\.connectionId/.test(call))
  assert.ok(!/p_connection_id:\s*null/.test(call), 'never null')
})
test('an ambiguous refresh failure never disables Calendar', () => {
  const code = stripJs(WORKER)
  // only a literal invalid_grant is connection-wide; everything else is provider_error
  assert.ok(/error === 'invalid_grant' \? 'invalid_grant' : 'provider_error'/.test(code))
  // a Gmail-only scope loss maps to scope_revoked, never to invalid_grant
  assert.ok(/grantedScopesIncludeGmailReadonly\(echoed\)[\s\S]{0,120}reason: 'scope_revoked'/.test(code))
})
test('OAuth state minted by gmail-oauth-start is random, hashed, expiring, user/origin/integration/PKCE-bound', () => {
  const code = stripJs(START)
  assert.ok(/const state = generateRandomToken\(32\)/.test(code), '256-bit CSPRNG state')
  assert.ok(/const stateHash = await sha256Hex\(state\)/.test(code), 'only the hash is persisted')
  assert.ok(/state_hash:\s*stateHash/.test(code) && !/state:\s*state\b/.test(code), 'raw state never stored')
  assert.ok(/pkceChallengeFromVerifier\(codeVerifier\)/.test(code), 'PKCE S256')
  assert.ok(/pkce_verifier_ciphertext:\s*encVerifier\.ciphertext/.test(code), 'verifier stored encrypted')
  assert.ok(/user_id:\s*user\.id/.test(code), 'user-bound (from the verified JWT, never the body)')
  assert.ok(/return_origin:\s*returnOrigin/.test(code) && /resolveReturnOrigin\(requestedOrigin\)/.test(code), 'redirect-bound to the allowlist')
  assert.ok(/integration_type:\s*GMAIL_INTEGRATION_TYPE/.test(code), 'integration-bound')
  assert.ok(/expires_at:\s*new Date\(Date\.now\(\) \+ STATE_TTL_MS\)/.test(code) && /STATE_TTL_MS = 10 \* 60 \* 1000/.test(START), '10-minute expiry')
  assert.ok(!/state\b[^\n]*console/.test(code) && !/console\.[a-z]+\([^)]*\b(state|codeVerifier|url)\b/.test(code), 'state/verifier/url never logged')
})
test('the callback consumes state ONCE, atomically, before any provider call (replay fails)', () => {
  const code = stripJs(CALLBACK)
  const consume = code.slice(code.indexOf(".from('google_oauth_states')"), code.indexOf('.maybeSingle()'))
  assert.ok(/\.update\(\{ consumed_at: nowIso \}\)/.test(consume), 'single conditional UPDATE')
  assert.ok(/\.is\('consumed_at', null\)/.test(consume), 'already-consumed rows never match again')
  assert.ok(/\.gt\('expires_at', nowIso\)/.test(consume), 'expired rows never match')
  assert.ok(/\.eq\('state_hash', stateHash\)/.test(consume), 'matched by hash of the presented state')
  assert.ok(code.indexOf('consumed_at: nowIso') < code.indexOf('boundedFetch(GOOGLE_TOKEN_ENDPOINT'), 'consumed before the code exchange')
  assert.ok(/isGmailFlow/.test(code) && /buildGmailSettingsRedirect\(validatedOrigin/.test(code), 'gmail banners derived from the consumed row')
})
test('gmail scope is requested ONLY by the Gmail start function (no broadening elsewhere)', () => {
  const calStart = read('supabase/functions/google-oauth-start/index.ts')
  const helpers = read('supabase/functions/shared/googleOauthHelpers.js')
  const connect = read('supabase/functions/shared/googleConnect.js')
  for (const [n, src] of [['google-oauth-start', calStart], ['googleOauthHelpers', helpers], ['googleConnect', connect], ['callback', CALLBACK]]) {
    assert.ok(!/gmail\.readonly|GMAIL_OAUTH_SCOPES|GMAIL_READONLY_SCOPE/.test(src), `${n} must not reference the Gmail scope`)
  }
  assert.ok(/buildGmailAuthUrl/.test(stripJs(START)))
})
test('worker-auth wording: no "stronger" claim; the accurate explanation is present in code and docs', () => {
  const doc = read('docs/phase-e2b-gmail-oauth-worker.md')
  for (const [n, src] of [['worker', WORKER], ['config', CONFIG], ['doc', doc]]) {
    assert.ok(!/stronger/i.test(src), `${n} must not call verify_jwt=false "stronger"`)
  }
  for (const [n, src] of [['worker', WORKER], ['doc', doc]]) {
    assert.ok(/intentionally disabled for this private worker endpoint because user JWTs grant no[\s/]+authority/.test(src), `${n} carries the accurate explanation`)
    assert.ok(/separate high-entropy worker secret/.test(src) && /constant time/.test(src) && /no CORS path/.test(src) && /service-role RPCs/.test(src), `${n} lists all four properties`)
  }
})
test('worker exposes no CORS/OPTIONS browser path and never uses the anon key', () => {
  const code = stripJs(WORKER)
  assert.ok(!/Access-Control-Allow-Origin/.test(code), 'no CORS header')
  assert.ok(!/OPTIONS/.test(code), 'no preflight handler (405 via authorizeWorkerRequest)')
  assert.ok(!/SUPABASE_ANON_KEY/.test(code), 'service-role client only')
})
test('the documented callback limitation is recorded honestly (not silently rewritten)', () => {
  const doc = read('docs/phase-e2b-gmail-oauth-worker.md')
  assert.ok(/### Existing callback limitation/.test(doc))
  assert.ok(/tokenRes\.json\(\)/.test(doc) && /userinfoRes\.json\(\)/.test(doc), 'names the exact reads')
  assert.ok(/Follow-up \(separately scoped\)/.test(doc))
  // and the callback really still has them (pre-branch, Calendar path untouched by design)
  assert.ok(/await tokenRes\.json\(\)/.test(CALLBACK) && /await userinfoRes\.json\(\)/.test(CALLBACK))
})
console.log('\nbrowser CORS: gmail-oauth-start is browser-invocable; the worker is not')
test('gmail-oauth-start answers OPTIONS FIRST, before the dormancy gate, auth, env, DB, or provider', () => {
  const code = stripJs(START)
  const serve = code.slice(code.indexOf('Deno.serve('))
  const firstStmt = serve.slice(serve.indexOf('{') + 1).trim().split('\n')[0].trim()
  assert.ok(/^if \(req\.method === 'OPTIONS'\) return new Response\('ok', \{ headers: corsHeaders \}\)\s*$/.test(firstStmt),
    `first statement must be the preflight response, got: ${firstStmt}`)
  const opt = serve.indexOf("req.method === 'OPTIONS'")
  for (const later of ['GMAIL_INTEGRATION_ENABLED', 'auth.getUser', 'createClient(', 'google_oauth_states', 'buildGmailAuthUrl', 'Deno.env.get']) {
    assert.ok(opt < serve.indexOf(later), `${later} must come after the preflight return`)
  }
})
test('gmail-oauth-start preflight headers: * origin and at least authorization, apikey, content-type, x-client-info', () => {
  const block = START.match(/const corsHeaders = \{[\s\S]*?\n\}/)[0]
  assert.ok(/'Access-Control-Allow-Origin':\s*'\*'/.test(block))
  const allow = block.match(/'Access-Control-Allow-Headers':\s*'([^']+)'/)[1].split(',').map((h) => h.trim().toLowerCase())
  for (const h of ['authorization', 'apikey', 'content-type', 'x-client-info']) assert.ok(allow.includes(h), `must allow ${h}`)
})
test('gmail-oauth-start puts the CORS headers on EVERY response (single json() builder merges corsHeaders)', () => {
  const code = stripJs(START)
  assert.ok(/function json\(body: unknown, status: number\): Response \{[\s\S]*?headers: \{ \.\.\.corsHeaders, \.\.\.securityHeaders,/.test(code))
  // every non-preflight response goes through json(); no bare `new Response(` besides the preflight
  const bare = (code.match(/new Response\(/g) || []).length
  assert.strictEqual(bare, 2, 'exactly two: the preflight and the json() builder')
  for (const status of ['503', '401', '400', '500', '200']) assert.ok(new RegExp(`json\([^)]*, ${status}\)`).test(code), `status ${status} via json()`)
})
test('gmail-oauth-start CORS block is identical to the established google-oauth-start pattern', () => {
  const cal = read('supabase/functions/google-oauth-start/index.ts')
  const a = START.match(/const corsHeaders = \{[\s\S]*?\n\}/)[0]
  const b = cal.match(/const corsHeaders = \{[\s\S]*?\n\}/)[0]
  assert.strictEqual(a, b)
  assert.ok(/if \(req\.method === 'OPTIONS'\) return new Response\('ok', \{ headers: corsHeaders \}\)/.test(cal), 'same preflight line')
})
test('gmail-sync-worker stays non-browser-callable: OPTIONS -> 405, no access-control header, JWT grants nothing', () => {
  assert.deepStrictEqual(authorizeWorkerRequest({ method: 'OPTIONS', authorization: null, configuredSecret: SECRET }),
    { ok: false, status: 405, code: 'method_not_allowed' })
  assert.deepStrictEqual(authorizeWorkerRequest({ method: 'OPTIONS', authorization: `Bearer ${SECRET}`, configuredSecret: SECRET }),
    { ok: false, status: 405, code: 'method_not_allowed' }, 'even with the right secret a preflight is refused')
  const code = stripJs(WORKER)
  assert.ok(!/corsHeaders|Access-Control/.test(code), 'no CORS headers anywhere in the worker')
  assert.ok(!/req\.method === 'OPTIONS'/.test(code), 'no dedicated preflight branch')
  const jwtish = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.sig'
  assert.deepStrictEqual(authorizeWorkerRequest({ method: 'POST', authorization: `Bearer ${jwtish}`, configuredSecret: SECRET }),
    { ok: false, status: 401, code: 'unauthorized' })
})

test('no secret value is hard-coded in any E2B shell', () => {
  for (const [name, src] of [['worker', WORKER], ['start', START]]) {
    assert.ok(!/sk-[A-Za-z0-9]{8}|AIza[A-Za-z0-9]{10}|-----BEGIN/.test(src), `${name} has no literal credential`)
    // secrets are only ever READ from the environment
    assert.ok(/Deno\.env\.get\(/.test(src), `${name} reads config from env`)
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
