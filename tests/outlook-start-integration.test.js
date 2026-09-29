// Integration test against the REAL outlook-oauth-start request handler.
//
// This EXECUTES the endpoint. It exists because source-text assertions are not
// behavioural coverage: grepping for a string cannot show that a refusal
// actually refuses, nor that nothing was written on the way out.
//
// Controlled seams, so no Production service is touched:
//   * SUPABASE_URL points at a local sink that answers GoTrue's
//     GET /auth/v1/user with a fixed user, so auth.getUser() succeeds.
//   * The same sink answers POST /rest/v1/microsoft_oauth_states and RECORDS
//     every insert, which is how "no state inserted on refusal" is measured
//     rather than assumed.
//   * Microsoft is never contacted: the handler only builds an authorization
//     URL, it does not call one.
//
// WHAT THIS DOES NOT COVER, stated plainly: the handler's own JWT is not
// verified here (the platform's verify_jwt = true does that in Production, and
// the sink accepts any bearer), and the encryption key is a test key. This
// suite proves the consent gate's decisions and their write side effects, not
// the authenticity of the caller.
//
// OPT-IN. Needs Docker and network access to esm.sh. Enable with:
//
//   FUNNL_EDGE_INTEGRATION=1 node tests/outlook-start-integration.test.js
//
// Without the flag (or without Docker) it reports SKIPPED and exits 0.

import http from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const COOKIE = '__Host-fnl_ms_oauth_bind'
const CONTAINER = 'funnl-outlook-start-itest'
const HANDLER_PORT = 9995
const SINK_PORT = 9996
const CALLBACK_URL = 'https://www.getfunnl.com/api/outlook-oauth-callback'
const ORIGIN = 'https://www.getfunnl.com'
const CURRENT_VERSION = 'outlook-disclosure-2026-09-28'
const TEST_KEY_B64 = randomBytes(32).toString('base64')
const USER_ID = '11111111-2222-3333-4444-555555555555'

let passed = 0, failed = 0
function check (name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); passed++ }
  else { console.error(`  ✗ ${name}`); if (detail) console.error(`    ${detail}`); failed++ }
}

function skip (why) {
  console.log(`\nSKIPPED: ${why}`)
  console.log('  Enable with FUNNL_EDGE_INTEGRATION=1 and a running Docker daemon.')
  console.log('\n0 tests: 0 passed, 0 failed\n')
  process.exitCode = 0
}

if (process.env.FUNNL_EDGE_INTEGRATION !== '1') {
  skip('opt-in Edge integration test not enabled')
} else {
  let dockerOk = true
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }) } catch { dockerOk = false }
  if (!dockerOk) skip('Docker daemon not available')
  else await run()
}

function stopHandler () {
  try { execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }) } catch { /* not running */ }
}

async function startHandler (disclosureVersion) {
  stopHandler()
  const env = [
    '-e', `SUPABASE_URL=http://host.docker.internal:${SINK_PORT}`,
    '-e', 'SUPABASE_ANON_KEY=test-anon-key',
    '-e', 'SUPABASE_SERVICE_ROLE_KEY=test-service-role-key',
    '-e', 'OUTLOOK_INTEGRATION_ENABLED=true',
    '-e', 'MICROSOFT_CLIENT_ID=test-client-id',
    '-e', `OUTLOOK_OAUTH_CALLBACK_URL=${CALLBACK_URL}`,
    '-e', `MICROSOFT_TOKEN_ENCRYPTION_KEY_V1=${TEST_KEY_B64}`,
  ]
  // Absent on purpose in the first scenario.
  if (disclosureVersion !== null) {
    env.push('-e', `OUTLOOK_DISCLOSURE_VERSION=${disclosureVersion}`)
  }
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', CONTAINER,
    '-p', `${HANDLER_PORT}:8000`,
    '-v', `${join(ROOT, 'supabase', 'functions')}:/app:ro`,
    '-w', '/app',
    ...env,
    'denoland/deno:alpine',
    'run', '--allow-net', '--allow-env', '--allow-read', 'outlook-oauth-start/index.ts',
  ], { stdio: 'ignore' })

  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${HANDLER_PORT}/`, { method: 'GET' })
      if (r.status === 405) return true          // its own method guard
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('the containerised start handler never started listening')
}

async function run () {
  console.log('\nreal outlook-oauth-start handler (Deno, containerised)')

  let stateInserts = []
  const sink = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const path = req.url.split('?')[0]
      if (path === '/auth/v1/user') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: USER_ID, aud: 'authenticated', role: 'authenticated',
          email: 'student@example.test', app_metadata: {}, user_metadata: {},
          created_at: new Date().toISOString(),
        }))
        return
      }
      if (path === '/rest/v1/microsoft_oauth_states' && req.method === 'POST') {
        // Record only NON-SECRET shape facts. The PKCE ciphertext and the state
        // hash are never retained or printed by this test.
        let parsed = null
        try { parsed = JSON.parse(body) } catch { /* ignore */ }
        const row = Array.isArray(parsed) ? parsed[0] : parsed
        stateInserts.push({
          hasStateHash: typeof row?.state_hash === 'string' && row.state_hash.length === 64,
          userId: row?.user_id ?? null,
          integrationType: row?.integration_type ?? null,
          consentPolicyVersion: row?.consent_policy_version ?? null,
          hasConsentedAt: Boolean(row?.consented_at),
        })
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end('[]')
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
  })
  sink.listen(SINK_PORT, '0.0.0.0')
  await once(sink, 'listening')

  const start = async (bodyObj) => {
    stateInserts = []
    const res = await fetch(`http://127.0.0.1:${HANDLER_PORT}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-user-jwt',
      },
      body: JSON.stringify(bodyObj),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* non-JSON */ }
    await new Promise((r) => setTimeout(r, 400))
    return {
      status: res.status,
      error: json?.error ?? null,
      hasUrl: typeof json?.url === 'string',
      url: typeof json?.url === 'string' ? json.url : null,
      setCookie: res.headers.getSetCookie?.().join(' | ') ?? res.headers.get('set-cookie') ?? '',
      inserts: [...stateInserts],
    }
  }

  try {
    // ── 1. Disclosure version NOT configured, main flag deliberately ON ──────
    await startHandler(null)
    let r = await start({ returnOrigin: ORIGIN, consentPolicyVersion: CURRENT_VERSION })
    check('absent disclosure config: refuses with 503 config_missing',
      r.status === 503 && r.error === 'config_missing', `${r.status} ${r.error}`)
    check('absent disclosure config: INSERTS NO STATE',
      r.inserts.length === 0, JSON.stringify(r.inserts))
    check('absent disclosure config: issues no binding cookie',
      !r.setCookie.includes(COOKIE), r.setCookie)
    check('absent disclosure config: the main flag being true does not bypass it',
      r.status === 503, 'OUTLOOK_INTEGRATION_ENABLED=true was set for this container')
    stopHandler()

    // ── 2. Disclosure version configured ────────────────────────────────────
    await startHandler(CURRENT_VERSION)

    // 2a. missing acknowledgement
    r = await start({ returnOrigin: ORIGIN })
    check('missing acknowledgement: refuses with 400 consent_required',
      r.status === 400 && r.error === 'consent_required', `${r.status} ${r.error}`)
    check('missing acknowledgement: INSERTS NO STATE',
      r.inserts.length === 0, JSON.stringify(r.inserts))
    check('missing acknowledgement: issues no binding cookie',
      !r.setCookie.includes(COOKIE), r.setCookie)

    // 2b. stale version (a previously published one)
    r = await start({ returnOrigin: ORIGIN, consentPolicyVersion: 'outlook-disclosure-2026-01-01' })
    check('stale version: refuses with 409 consent_version_mismatch',
      r.status === 409 && r.error === 'consent_version_mismatch', `${r.status} ${r.error}`)
    check('stale version: INSERTS NO STATE', r.inserts.length === 0, JSON.stringify(r.inserts))

    // 2c. arbitrary invented version
    r = await start({ returnOrigin: ORIGIN, consentPolicyVersion: 'v-anything-i-like' })
    check('arbitrary version: refuses with 409 consent_version_mismatch',
      r.status === 409 && r.error === 'consent_version_mismatch', `${r.status} ${r.error}`)
    check('arbitrary version: INSERTS NO STATE', r.inserts.length === 0, JSON.stringify(r.inserts))

    // 2d. near-miss (trailing character) must not pass a loose comparison
    r = await start({ returnOrigin: ORIGIN, consentPolicyVersion: CURRENT_VERSION + 'x' })
    check('near-miss version: refuses with 409 (exact comparison, not prefix)',
      r.status === 409 && r.error === 'consent_version_mismatch', `${r.status} ${r.error}`)
    check('near-miss version: INSERTS NO STATE', r.inserts.length === 0, JSON.stringify(r.inserts))

    // 2e. matching version — the only accepting path
    r = await start({ returnOrigin: ORIGIN, consentPolicyVersion: CURRENT_VERSION })
    check('matching version: returns 200 with an authorization url',
      r.status === 200 && r.hasUrl, `${r.status} ${r.error}`)
    check('matching version: inserts EXACTLY ONE state row',
      r.inserts.length === 1, JSON.stringify(r.inserts))
    check('matching version: the row stores a 64-hex state hash, not the state',
      r.inserts[0]?.hasStateHash === true, JSON.stringify(r.inserts[0]))
    check('matching version: the row records the SERVER version, bound to the user',
      r.inserts[0]?.consentPolicyVersion === CURRENT_VERSION &&
      r.inserts[0]?.userId === USER_ID &&
      r.inserts[0]?.integrationType === 'outlook' &&
      r.inserts[0]?.hasConsentedAt === true, JSON.stringify(r.inserts[0]))
    check('matching version: issues the Outlook binding cookie with the right attributes',
      r.setCookie.includes(COOKIE) && r.setCookie.includes('SameSite=None') &&
      r.setCookie.includes('Secure') && r.setCookie.includes('HttpOnly') &&
      r.setCookie.includes('Path=/'), r.setCookie.replace(/=[^;]{8,}/, '=<redacted>'))
    check('matching version: authorization url uses form_post and S256',
      r.url.includes('response_mode=form_post') && r.url.includes('code_challenge_method=S256'),
      'authorization url shape')

    // 2f. an invalid return origin is still refused after consent passes
    r = await start({ returnOrigin: 'https://evil.example.com', consentPolicyVersion: CURRENT_VERSION })
    check('invalid return origin: refuses and inserts no state',
      r.status === 400 && r.error === 'invalid_return_origin' && r.inserts.length === 0,
      `${r.status} ${r.error} ${JSON.stringify(r.inserts)}`)
  } finally {
    stopHandler()
    sink.close()
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
