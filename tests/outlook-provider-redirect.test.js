// Provider requests must NOT follow redirects.
//
// WHY THIS MATTERS
// The token request body carries the authorization code, the client secret and
// the PKCE verifier. A 307 or 308 preserves BOTH the method and the body, so a
// followed redirect would repost all three to whatever host the response named.
// The Graph request carries the access token in an Authorization header, which
// a followed redirect could replay elsewhere. The JWKS request carries no
// credential, but a followed redirect would let the response choose the signing
// keys the id_token is verified against.
//
// These tests use REAL local HTTP servers rather than fetch doubles: the
// redirect decision belongs to the runtime's fetch, so a double would be
// testing the double. Each redirect points at a second server that records any
// request it receives — the assertion is that it records NOTHING.
//
// Run with: node tests/outlook-provider-redirect.test.js

import assert from 'assert'
import http from 'node:http'
import { once } from 'node:events'
import { redeemAuthorizationCode } from '../supabase/functions/shared/microsoftTokenExchange.js'
import { fetchMailboxAddress } from '../supabase/functions/shared/microsoftGraphMe.js'
import { fetchJwks } from '../supabase/functions/shared/microsoftJwks.js'

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

const REDIRECT_URI = 'https://www.getfunnl.com/api/outlook-oauth-callback'

/** Records every request it receives, and what it was given. */
async function makeDestination () {
  const hits = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      hits.push({
        method: req.method,
        hadBody: body.length > 0,
        sawCode: body.includes('FIXTURE-CODE'),
        sawSecret: body.includes('SUPER-SECRET'),
        sawVerifier: body.includes('THE-VERIFIER'),
        sawBearer: String(req.headers.authorization ?? '').includes('THE-ACCESS-TOKEN'),
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        access_token: 'leaked', id_token: 'leaked', refresh_token: 'leaked',
        expires_in: 3600, scope: 'Mail.Read User.Read',
        id: 'oid-1', mail: 'leak@example.test', keys: [{ kid: 'x' }],
      }))
    })
  })
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  return { hits, origin: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }
}

/** Redirects with the given status, or serves a normal 200 payload. */
async function makeOrigin (mode, location, ok200) {
  const srv = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      if (mode === 'redirect') {
        res.writeHead(location.status, { Location: location.to })
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(ok200))
    })
  })
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  return { origin: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }
}

console.log('\nprovider requests refuse redirects')

for (const status of [301, 302, 303, 307, 308]) {
  test(`token endpoint: a ${status} is NOT followed and the destination sees nothing`, async () => {
    const dest = await makeDestination()
    const org = await makeOrigin('redirect', { status, to: `${dest.origin}/stolen` })
    try {
      const r = await redeemAuthorizationCode({
        code: 'FIXTURE-CODE', codeVerifier: 'THE-VERIFIER',
        clientId: 'cid', clientSecret: 'SUPER-SECRET', redirectUri: REDIRECT_URI,
        tokenUrl: `${org.origin}/token`, timeoutMs: 5000,
      })
      assert.strictEqual(r.ok, false, 'a redirected redemption must not succeed')
      assert.strictEqual(r.reason, 'token_endpoint_unreachable',
        `expected a controlled failure, got ${r.reason}`)
      assert.deepStrictEqual(dest.hits, [],
        `the redirect destination received ${JSON.stringify(dest.hits)}`)
    } finally { dest.close(); org.close() }
  })
}

for (const status of [302, 307, 308]) {
  test(`Graph /me: a ${status} is NOT followed and the bearer token is not replayed`, async () => {
    const dest = await makeDestination()
    const org = await makeOrigin('redirect', { status, to: `${dest.origin}/stolen` })
    try {
      const r = await fetchMailboxAddress({
        accessToken: 'THE-ACCESS-TOKEN', oid: 'oid-1',
        meUrl: `${org.origin}/me`, timeoutMs: 5000,
      })
      assert.strictEqual(r.ok, false)
      assert.strictEqual(r.reason, 'graph_me_unreachable',
        `expected a controlled failure, got ${r.reason}`)
      assert.deepStrictEqual(dest.hits, [],
        `the redirect destination received ${JSON.stringify(dest.hits)}`)
    } finally { dest.close(); org.close() }
  })
}

for (const status of [302, 307]) {
  test(`JWKS: a ${status} is NOT followed, so a response cannot choose the keys`, async () => {
    const dest = await makeDestination()
    const org = await makeOrigin('redirect', { status, to: `${dest.origin}/stolen` })
    try {
      const r = await fetchJwks(`${org.origin}/jwks`, { timeoutMs: 5000 })
      assert.strictEqual(r.ok, false)
      assert.strictEqual(r.reason, 'jwks_unreachable', `got ${r.reason}`)
      assert.deepStrictEqual(dest.hits, [], JSON.stringify(dest.hits))
    } finally { dest.close(); org.close() }
  })
}

console.log('\nnormal 200 paths remain green')

test('token endpoint: a plain 200 still succeeds', async () => {
  const org = await makeOrigin('ok', null, {
    access_token: 'at', id_token: 'it', refresh_token: 'rt',
    expires_in: 3600, scope: 'Mail.Read User.Read offline_access',
  })
  try {
    const r = await redeemAuthorizationCode({
      code: 'FIXTURE-CODE', codeVerifier: 'THE-VERIFIER',
      clientId: 'cid', clientSecret: 'SUPER-SECRET', redirectUri: REDIRECT_URI,
      tokenUrl: `${org.origin}/token`, timeoutMs: 5000,
    })
    assert.strictEqual(r.ok, true, r.reason)
    assert.strictEqual(r.accessToken, 'at')
    assert.deepStrictEqual(r.grantedScopes, ['Mail.Read', 'User.Read', 'offline_access'])
  } finally { org.close() }
})

test('Graph /me: a plain 200 still resolves the mailbox', async () => {
  const org = await makeOrigin('ok', null, { id: 'oid-1', mail: 'Student@Outlook.test' })
  try {
    const r = await fetchMailboxAddress({
      accessToken: 'THE-ACCESS-TOKEN', oid: 'oid-1',
      meUrl: `${org.origin}/me`, timeoutMs: 5000,
    })
    assert.deepStrictEqual(r, { ok: true, email: 'student@outlook.test' })
  } finally { org.close() }
})

test('JWKS: a plain 200 still returns the key document', async () => {
  const org = await makeOrigin('ok', null, { keys: [{ kid: 'k1', kty: 'RSA' }] })
  try {
    const r = await fetchJwks(`${org.origin}/jwks`, { timeoutMs: 5000 })
    assert.strictEqual(r.ok, true, r.reason)
    assert.strictEqual(r.jwks.keys.length, 1)
  } finally { org.close() }
})

test('JWKS: a key document with no keys is refused', async () => {
  const org = await makeOrigin('ok', null, { keys: [] })
  try {
    const r = await fetchJwks(`${org.origin}/jwks`, { timeoutMs: 5000 })
    assert.strictEqual(r.reason, 'jwks_malformed')
  } finally { org.close() }
})

test('every provider request sets redirect: error in source', async () => {
  const { readFileSync } = await import('node:fs')
  const files = [
    'supabase/functions/shared/microsoftTokenExchange.js',
    'supabase/functions/shared/microsoftGraphMe.js',
    'supabase/functions/shared/microsoftJwks.js',
  ]
  for (const f of files) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8')
    const fetches = (src.match(/fetchImpl\(/g) ?? []).length
    const policies = (src.match(/redirect: 'error'/g) ?? []).length
    assert.ok(fetches > 0, `${f} should perform a provider request`)
    assert.strictEqual(policies, fetches,
      `${f}: ${fetches} request(s) but ${policies} redirect policy declaration(s)`)
  }
})

async function finish () {
  await Promise.all(pending)
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
await finish()
