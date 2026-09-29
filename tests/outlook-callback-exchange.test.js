// Unit tests for the Outlook callback's exchange / validation / resolution
// modules. Zero dependencies, no network, no Entra registration.
//
// The id_token tests use a REAL RS256 signature produced by Node's webcrypto
// with a locally generated key, so signature failures are genuine rather than
// simulated: a wrong-key case signs with a second key and must be rejected.
//
// Run with: node tests/outlook-callback-exchange.test.js

import assert from 'assert'
import { webcrypto } from 'node:crypto'
import {
  expectedIssuerForTenant, jwksUrlForTenant, unverifiedTenantId,
  validateIdTokenClaims, verifyMicrosoftIdToken, CLOCK_SKEW_S, MS_LOGIN_HOST,
} from '../supabase/functions/shared/microsoftIdToken.js'
import {
  parseGrantedScopes, grantedScopesSufficient, validateTokenResponseShape,
  redeemAuthorizationCode,
} from '../supabase/functions/shared/microsoftTokenExchange.js'
import {
  pickMailboxAddress, resolveMailboxFromGraphBody, fetchMailboxAddress,
  GRAPH_ME_SELECT,
} from '../supabase/functions/shared/microsoftGraphMe.js'
import {
  isLoopbackBase, resolveMicrosoftEndpoints, resolveJwksUrl,
} from '../supabase/functions/shared/microsoftEndpoints.js'
import { MS_TOKEN_ENDPOINT } from '../supabase/functions/shared/microsoftOauthHelpers.js'

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

const CONSUMERS = '9188040d-6c67-4c5b-b112-36a304b66dad'
const WORK = '72f988bf-86f1-41af-91ab-2d7cd011db47'
const CLIENT_ID = 'client-id-under-test'
const NONCE = 'a'.repeat(64)

// ── a real RS256 signer, so signature checks are genuine ─────────────────────
function b64url (bytes) {
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function makeKey () {
  return webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'])
}
async function signJwt (payload, key) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const body = b64url(Buffer.from(JSON.stringify(payload)))
  const data = new TextEncoder().encode(`${header}.${body}`)
  const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, data)
  return `${header}.${body}.${b64url(new Uint8Array(sig))}`
}
function claimsFor (tid, over = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: `${MS_LOGIN_HOST}/${tid}/v2.0`,
    aud: CLIENT_ID, tid, oid: 'oid-' + tid, nonce: NONCE,
    exp: now + 3600, nbf: now - 60, iat: now,
    email: 'student@example.test',
    ...over,
  }
}
// A verifier that mirrors what jose does for us: checks the signature against
// the provided key, then hands back the payload.
function makeVerifier (expectKey) {
  return async (token, keySet) => {
    const [h, b, s] = token.split('.')
    const data = new TextEncoder().encode(`${h}.${b}`)
    const sig = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    const ok = await webcrypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', keySet ?? expectKey.publicKey, sig, data)
    if (!ok) throw new Error('signature verification failed')
    return { payload: JSON.parse(Buffer.from(b, 'base64url').toString('utf8')) }
  }
}

console.log('\nid_token: tenant, issuer and key selection')

test('issuer and JWKS are TENANT-specific, never a single literal', () => {
  assert.strictEqual(expectedIssuerForTenant(CONSUMERS), `${MS_LOGIN_HOST}/${CONSUMERS}/v2.0`)
  assert.strictEqual(expectedIssuerForTenant(WORK), `${MS_LOGIN_HOST}/${WORK}/v2.0`)
  assert.notStrictEqual(expectedIssuerForTenant(CONSUMERS), expectedIssuerForTenant(WORK))
  assert.strictEqual(jwksUrlForTenant(WORK), `${MS_LOGIN_HOST}/${WORK}/discovery/v2.0/keys`)
})

test('a malformed tid yields no issuer and no key URL', () => {
  for (const bad of ['', 'not-a-guid', '-'.repeat(36), null, undefined]) {
    assert.strictEqual(expectedIssuerForTenant(bad), null)
    assert.strictEqual(jwksUrlForTenant(bad), null)
  }
})

test('unverifiedTenantId reads tid without trusting anything else', async () => {
  const key = await makeKey()
  const t = await signJwt(claimsFor(WORK), key)
  assert.strictEqual(unverifiedTenantId(t), WORK)
  assert.strictEqual(unverifiedTenantId('not.a.jwt'), null)
  assert.strictEqual(unverifiedTenantId('a.b'), null)
  assert.strictEqual(unverifiedTenantId(null), null)
})

console.log('\nid_token: full verification')

test('a valid PERSONAL-tenant token verifies', async () => {
  const key = await makeKey()
  const token = await signJwt(claimsFor(CONSUMERS), key)
  const r = await verifyMicrosoftIdToken({
    idToken: token, clientId: CLIENT_ID, expectedNonce: NONCE,
    verifyJwt: makeVerifier(key), jwksFor: async () => key.publicKey,
  })
  assert.strictEqual(r.ok, true, r.reason)
  assert.strictEqual(r.tenantId, CONSUMERS)
  assert.strictEqual(r.payload.oid, 'oid-' + CONSUMERS)
})

test('a valid WORK-tenant token verifies', async () => {
  const key = await makeKey()
  const token = await signJwt(claimsFor(WORK), key)
  const r = await verifyMicrosoftIdToken({
    idToken: token, clientId: CLIENT_ID, expectedNonce: NONCE,
    verifyJwt: makeVerifier(key), jwksFor: async () => key.publicKey,
  })
  assert.strictEqual(r.ok, true, r.reason)
  assert.strictEqual(r.tenantId, WORK)
})

test('a token signed by the WRONG KEY is rejected', async () => {
  const key = await makeKey()
  const attacker = await makeKey()
  const token = await signJwt(claimsFor(WORK), attacker)
  const r = await verifyMicrosoftIdToken({
    idToken: token, clientId: CLIENT_ID, expectedNonce: NONCE,
    verifyJwt: makeVerifier(key), jwksFor: async () => key.publicKey,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'signature_or_key_invalid')
})

test('a WRONG ISSUER is rejected even with a good signature', async () => {
  const key = await makeKey()
  const token = await signJwt(
    claimsFor(WORK, { iss: `${MS_LOGIN_HOST}/${CONSUMERS}/v2.0` }), key)
  const r = await verifyMicrosoftIdToken({
    idToken: token, clientId: CLIENT_ID, expectedNonce: NONCE,
    verifyJwt: makeVerifier(key), jwksFor: async () => key.publicKey,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'issuer_mismatch')
})

test('a WRONG AUDIENCE is rejected', async () => {
  const key = await makeKey()
  const token = await signJwt(claimsFor(WORK, { aud: 'some-other-app' }), key)
  const r = await verifyMicrosoftIdToken({
    idToken: token, clientId: CLIENT_ID, expectedNonce: NONCE,
    verifyJwt: makeVerifier(key), jwksFor: async () => key.publicKey,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'audience_mismatch')
})

test('a WRONG NONCE is rejected — this is the replay guard', async () => {
  const key = await makeKey()
  const token = await signJwt(claimsFor(WORK, { nonce: 'b'.repeat(64) }), key)
  const r = await verifyMicrosoftIdToken({
    idToken: token, clientId: CLIENT_ID, expectedNonce: NONCE,
    verifyJwt: makeVerifier(key), jwksFor: async () => key.publicKey,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'nonce_mismatch')
})

test('an EXPIRED token is rejected, and skew is bounded', async () => {
  const key = await makeKey()
  const now = Math.floor(Date.now() / 1000)
  const token = await signJwt(claimsFor(WORK, { exp: now - (CLOCK_SKEW_S + 120) }), key)
  const r = await verifyMicrosoftIdToken({
    idToken: token, clientId: CLIENT_ID, expectedNonce: NONCE,
    verifyJwt: makeVerifier(key), jwksFor: async () => key.publicKey,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'token_expired')
})

test('a NOT-YET-VALID token is rejected', () => {
  const now = Math.floor(Date.now() / 1000)
  const r = validateIdTokenClaims(
    { iss: 'i', aud: CLIENT_ID, exp: now + 3600, nbf: now + 600, nonce: NONCE },
    { clientId: CLIENT_ID, expectedNonce: NONCE, expectedIssuer: 'i', nowSeconds: now })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'token_not_yet_valid')
})

test('an array aud containing our client id is accepted', () => {
  const now = Math.floor(Date.now() / 1000)
  const r = validateIdTokenClaims(
    { iss: 'i', aud: ['other', CLIENT_ID], exp: now + 60, nonce: NONCE },
    { clientId: CLIENT_ID, expectedNonce: NONCE, expectedIssuer: 'i', nowSeconds: now })
  assert.strictEqual(r.ok, true)
})

test('verification failures never leak the library message', async () => {
  const key = await makeKey()
  const token = await signJwt(claimsFor(WORK), key)
  const r = await verifyMicrosoftIdToken({
    idToken: token, clientId: CLIENT_ID, expectedNonce: NONCE,
    verifyJwt: async () => { throw new Error('secret detail ' + token) },
    jwksFor: async () => key.publicKey,
  })
  assert.strictEqual(r.reason, 'signature_or_key_invalid')
  assert.ok(!JSON.stringify(r).includes(token))
})

console.log('\ntoken exchange')

test('granted scopes must include BOTH Mail.Read and User.Read', () => {
  assert.strictEqual(grantedScopesSufficient(['Mail.Read', 'User.Read']).ok, true)
  assert.strictEqual(grantedScopesSufficient(
    ['https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/User.Read']).ok, true)
  const a = grantedScopesSufficient(['Mail.Read'])
  assert.strictEqual(a.ok, false)
  assert.deepStrictEqual(a.missing, ['User.Read'])
  const b = grantedScopesSufficient(['User.Read'])
  assert.deepStrictEqual(b.missing, ['Mail.Read'])
  assert.deepStrictEqual(grantedScopesSufficient([]).missing, ['Mail.Read', 'User.Read'])
})

test('a malformed token response is refused with a controlled reason', () => {
  assert.strictEqual(validateTokenResponseShape(null).reason, 'token_response_malformed')
  assert.strictEqual(validateTokenResponseShape({}).reason, 'token_response_no_access_token')
  assert.strictEqual(validateTokenResponseShape({ access_token: 'a' }).reason, 'token_response_no_id_token')
  assert.strictEqual(validateTokenResponseShape(
    { access_token: 'a', id_token: 'b' }).reason, 'refresh_token_required')
  assert.strictEqual(validateTokenResponseShape(
    { access_token: 'a', id_token: 'b', refresh_token: 'c' }).reason, 'token_response_no_expiry')
  assert.strictEqual(validateTokenResponseShape(
    { access_token: 'a', id_token: 'b', refresh_token: 'c', expires_in: 3600 }).ok, true)
})

test('redemption sends the exact registered redirect URI and the verifier', async () => {
  let seen = null
  const r = await redeemAuthorizationCode({
    code: 'CODE', codeVerifier: 'VERIFIER', clientId: 'cid', clientSecret: 'sec',
    redirectUri: 'https://www.getfunnl.com/api/outlook-oauth-callback',
    tokenUrl: 'https://token.invalid/token',
    fetchImpl: async (url, init) => {
      seen = { url, body: init.body }
      return { status: 200, json: async () => ({
        access_token: 'at', id_token: 'it', refresh_token: 'rt',
        expires_in: 3600, scope: 'Mail.Read User.Read offline_access' }) }
    },
    now: () => 1_700_000_000_000,
  })
  assert.strictEqual(r.ok, true, r.reason)
  const p = new URLSearchParams(seen.body)
  assert.strictEqual(p.get('grant_type'), 'authorization_code')
  assert.strictEqual(p.get('code'), 'CODE')
  assert.strictEqual(p.get('code_verifier'), 'VERIFIER')
  assert.strictEqual(p.get('redirect_uri'), 'https://www.getfunnl.com/api/outlook-oauth-callback')
  assert.strictEqual(p.get('client_secret'), 'sec')
  assert.deepStrictEqual(r.grantedScopes, ['Mail.Read', 'User.Read', 'offline_access'])
  assert.strictEqual(r.expiresAt, new Date(1_700_000_000_000 + 3600_000).toISOString())
})

test('a non-200 redemption is classified without echoing the body', async () => {
  const bad = await redeemAuthorizationCode({
    code: 'c', codeVerifier: 'v', clientId: 'i', clientSecret: 's',
    redirectUri: 'r', tokenUrl: 'https://t.invalid',
    fetchImpl: async () => ({ status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'CODE LEAK' }) }),
  })
  assert.strictEqual(bad.ok, false)
  assert.strictEqual(bad.reason, 'token_exchange_rejected')
  assert.ok(!JSON.stringify(bad).includes('CODE LEAK'))
  const five = await redeemAuthorizationCode({
    code: 'c', codeVerifier: 'v', clientId: 'i', clientSecret: 's',
    redirectUri: 'r', tokenUrl: 'https://t.invalid',
    fetchImpl: async () => ({ status: 503, json: async () => ({}) }),
  })
  assert.strictEqual(five.reason, 'token_endpoint_server_error')
})

test('an unreachable token endpoint is a controlled failure', async () => {
  const r = await redeemAuthorizationCode({
    code: 'c', codeVerifier: 'v', clientId: 'i', clientSecret: 's',
    redirectUri: 'r', tokenUrl: 'https://t.invalid',
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
  })
  assert.strictEqual(r.reason, 'token_endpoint_unreachable')
})

test('missing inputs are refused before any network call', async () => {
  let called = false
  for (const [k, reason] of [['code', 'no_code'], ['codeVerifier', 'no_verifier'],
    ['clientSecret', 'no_client_secret'], ['tokenUrl', 'no_token_url']]) {
    const args = { code: 'c', codeVerifier: 'v', clientId: 'i', clientSecret: 's',
      redirectUri: 'r', tokenUrl: 't', fetchImpl: async () => { called = true; return { status: 200 } } }
    args[k] = ''
    const r = await redeemAuthorizationCode(args)
    assert.strictEqual(r.reason, reason)
  }
  assert.strictEqual(called, false, 'no network call may happen on invalid input')
})

test('parseGrantedScopes never invents scopes', () => {
  assert.deepStrictEqual(parseGrantedScopes('a  b '), ['a', 'b'])
  assert.deepStrictEqual(parseGrantedScopes(null), [])
  assert.deepStrictEqual(parseGrantedScopes(undefined), [])
})

console.log('\nGraph /me mailbox resolution')

test('prefers mail, falls back to a mail-shaped UPN only', () => {
  assert.strictEqual(pickMailboxAddress({ mail: 'A@B.co', userPrincipalName: 'x@y.z' }), 'a@b.co')
  assert.strictEqual(pickMailboxAddress({ userPrincipalName: 'U@V.co' }), 'u@v.co')
  assert.strictEqual(pickMailboxAddress({ userPrincipalName: 'DOMAIN\\user' }), null)
  assert.strictEqual(pickMailboxAddress({ mail: null }), null)
  assert.strictEqual(pickMailboxAddress(null), null)
})

test('Graph id must match the validated oid — fails closed on mismatch', () => {
  assert.deepStrictEqual(
    resolveMailboxFromGraphBody({ id: 'OID-1', mail: 'a@b.co' }, 'oid-1'),
    { ok: true, email: 'a@b.co' })
  assert.strictEqual(
    resolveMailboxFromGraphBody({ id: 'someone-else', mail: 'a@b.co' }, 'oid-1').reason,
    'graph_identity_mismatch')
  assert.strictEqual(resolveMailboxFromGraphBody({ mail: 'a@b.co' }, 'oid-1').reason, 'graph_me_no_id')
  assert.strictEqual(resolveMailboxFromGraphBody({ id: 'oid-1' }, 'oid-1').reason, 'no_usable_mailbox_address')
  assert.strictEqual(resolveMailboxFromGraphBody({ id: 'oid-1', mail: 'a@b.co' }, '').reason, 'no_validated_oid')
})

test('the request narrows $select to the three fields used', async () => {
  let seenUrl = null
  await fetchMailboxAddress({
    accessToken: 'at', oid: 'oid-1',
    fetchImpl: async (url) => { seenUrl = url; return { status: 200, json: async () => ({ id: 'oid-1', mail: 'a@b.co' }) } },
    meUrl: 'https://graph.invalid/me',
  })
  assert.ok(seenUrl.includes(encodeURIComponent(GRAPH_ME_SELECT)))
  assert.strictEqual(GRAPH_ME_SELECT, 'id,mail,userPrincipalName')
})

test('a 401/403 from Graph reports the likely missing permission', async () => {
  for (const status of [401, 403]) {
    const r = await fetchMailboxAddress({
      accessToken: 'at', oid: 'o',
      fetchImpl: async () => ({ status, json: async () => ({}) }),
      meUrl: 'https://graph.invalid/me',
    })
    assert.strictEqual(r.reason, 'graph_me_forbidden')
  }
})

test('an unreachable or malformed Graph is a controlled failure', async () => {
  const a = await fetchMailboxAddress({
    accessToken: 'at', oid: 'o',
    fetchImpl: async () => { throw new Error('down') }, meUrl: 'https://g.invalid/me' })
  assert.strictEqual(a.reason, 'graph_me_unreachable')
  const b = await fetchMailboxAddress({
    accessToken: 'at', oid: 'o',
    fetchImpl: async () => ({ status: 200, json: async () => { throw new Error('bad json') } }),
    meUrl: 'https://g.invalid/me' })
  assert.strictEqual(b.reason, 'graph_me_malformed')
  const c = await fetchMailboxAddress({ accessToken: '', oid: 'o', meUrl: 'https://g.invalid/me' })
  assert.strictEqual(c.reason, 'no_access_token')
})

console.log('\nendpoint seam is loopback-only')

test('production endpoints are used when the fixture flag is unset', () => {
  const e = resolveMicrosoftEndpoints(() => undefined)
  assert.strictEqual(e.tokenUrl, MS_TOKEN_ENDPOINT)
  assert.strictEqual(e.usingFixtures, false)
})

test('a NON-loopback override is ignored even with the flag on', () => {
  const env = (k) => ({
    OUTLOOK_LOCAL_FIXTURES: 'true',
    OUTLOOK_FIXTURE_BASE: 'https://attacker.example.com',
  })[k]
  const e = resolveMicrosoftEndpoints(env)
  assert.strictEqual(e.usingFixtures, false, 'a public host must never be honoured')
  assert.strictEqual(e.tokenUrl, MS_TOKEN_ENDPOINT)
})

test('the override needs BOTH the flag and a loopback base', () => {
  const onlyBase = resolveMicrosoftEndpoints((k) =>
    ({ OUTLOOK_FIXTURE_BASE: 'http://127.0.0.1:9000' })[k])
  assert.strictEqual(onlyBase.usingFixtures, false)
  const both = resolveMicrosoftEndpoints((k) => ({
    OUTLOOK_LOCAL_FIXTURES: 'true', OUTLOOK_FIXTURE_BASE: 'http://127.0.0.1:9000',
  })[k])
  assert.strictEqual(both.usingFixtures, true)
  assert.strictEqual(both.tokenUrl, 'http://127.0.0.1:9000/token')
  assert.strictEqual(both.graphMeUrl, 'http://127.0.0.1:9000/me')
})

test('loopback detection accepts only real loopback hosts', () => {
  for (const good of ['http://127.0.0.1:1', 'http://localhost:2', 'http://[::1]:3',
    'http://host.docker.internal:4']) {
    assert.ok(isLoopbackBase(good), good)
  }
  for (const bad of ['https://example.com', 'http://127.0.0.1.evil.com',
    'ftp://127.0.0.1', 'file:///etc', '', null, 'not a url']) {
    assert.ok(!isLoopbackBase(bad), String(bad))
  }
})

test('the tenant JWKS URL is used unchanged in production', () => {
  const prod = resolveMicrosoftEndpoints(() => undefined)
  const tenantUrl = jwksUrlForTenant(WORK)
  assert.strictEqual(resolveJwksUrl(prod, tenantUrl), tenantUrl)
})

async function finish () {
  await Promise.all(pending)
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
await finish()
