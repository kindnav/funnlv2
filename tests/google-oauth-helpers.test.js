// OAuth helper tests: origin allowlist, PKCE, state hashing, scopes, auth URL,
// redirect construction, refresh-token preservation.
// Run with: node tests/google-oauth-helpers.test.js
import assert from 'assert'
import { webcrypto } from 'node:crypto'
if (!globalThis.crypto) globalThis.crypto = webcrypto

import {
  GOOGLE_OAUTH_SCOPES,
  resolveReturnOrigin,
  buildSettingsRedirect,
  CANONICAL_ERROR_REDIRECT,
  generateRandomToken,
  sha256Hex,
  pkceChallengeFromVerifier,
  buildGoogleAuthUrl,
  resolveRefreshTokenColumns,
} from '../supabase/functions/shared/googleOauthHelpers.js'

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}

// ── Scopes (Calendar read-only only; NO Gmail) ────────────────────────────────
console.log('\nscopes')
await test('includes Calendar read-only', () => {
  assert.ok(GOOGLE_OAUTH_SCOPES.includes('https://www.googleapis.com/auth/calendar.events.readonly'))
})
await test('includes openid/email/profile', () => {
  for (const s of ['openid', 'email', 'profile']) assert.ok(GOOGLE_OAUTH_SCOPES.includes(s))
})
await test('contains NO Gmail scope of any kind', () => {
  for (const s of GOOGLE_OAUTH_SCOPES) assert.ok(!/gmail/i.test(s), `unexpected gmail scope: ${s}`)
})
await test('contains no write/full calendar scope', () => {
  assert.ok(!GOOGLE_OAUTH_SCOPES.includes('https://www.googleapis.com/auth/calendar'))
  assert.ok(!GOOGLE_OAUTH_SCOPES.some(s => s.endsWith('/calendar.events'))) // read-only only
})

// ── Origin allowlist ──────────────────────────────────────────────────────────
console.log('\nresolveReturnOrigin')
const PREVIEW = 'https://funnlv2-git-feature-google-integration-foundation-funnlv2.vercel.app'
await test('prod www + apex accepted', () => {
  assert.strictEqual(resolveReturnOrigin('https://www.getfunnl.com'), 'https://www.getfunnl.com')
  assert.strictEqual(resolveReturnOrigin('https://getfunnl.com'), 'https://getfunnl.com')
})
await test('trusted team-scoped Vercel preview accepted', () => {
  assert.strictEqual(resolveReturnOrigin(PREVIEW), PREVIEW)
})
await test('malicious look-alikes rejected → null', () => {
  assert.strictEqual(resolveReturnOrigin('https://funnlv2-git-evil.vercel.app'), null)         // not team-scoped
  assert.strictEqual(resolveReturnOrigin('https://evil-funnlv2.vercel.app'), null)             // wrong prefix
  assert.strictEqual(resolveReturnOrigin('https://funnlv2-x-funnlv2.vercel.app.evil.com'), null)
  assert.strictEqual(resolveReturnOrigin('https://getfunnl.com.evil.com'), null)
  assert.strictEqual(resolveReturnOrigin('https://evil.com'), null)
})
await test('http, ports, credentials, malformed rejected → null', () => {
  assert.strictEqual(resolveReturnOrigin('http://www.getfunnl.com'), null)
  assert.strictEqual(resolveReturnOrigin('https://www.getfunnl.com:8443'), null)
  assert.strictEqual(resolveReturnOrigin('https://user:pass@www.getfunnl.com'), null)
  assert.strictEqual(resolveReturnOrigin('https://www.getfunnl.com@evil.com'), null)
  assert.strictEqual(resolveReturnOrigin('not-a-url'), null)
  assert.strictEqual(resolveReturnOrigin(''), null)
  assert.strictEqual(resolveReturnOrigin(undefined), null)
  assert.strictEqual(resolveReturnOrigin(42), null)
})

// ── Redirect construction ─────────────────────────────────────────────────────
console.log('\nbuildSettingsRedirect')
await test('connected + cancelled/error paths are server-built', () => {
  assert.strictEqual(buildSettingsRedirect('https://www.getfunnl.com', 'connected'), 'https://www.getfunnl.com/settings?google=connected')
  assert.strictEqual(buildSettingsRedirect(PREVIEW, 'error'), `${PREVIEW}/settings?google=error`)
})
await test('unknown result coerces to error', () => {
  assert.strictEqual(buildSettingsRedirect('https://getfunnl.com', 'whatever'), 'https://getfunnl.com/settings?google=error')
})
await test('canonical error redirect is production', () => {
  assert.strictEqual(CANONICAL_ERROR_REDIRECT, 'https://www.getfunnl.com/settings?google=error')
})

// ── State hashing ─────────────────────────────────────────────────────────────
console.log('\nstate hashing')
await test('sha256Hex matches a known vector and is deterministic', async () => {
  assert.strictEqual(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  const s = 'some-state-value'
  assert.strictEqual(await sha256Hex(s), await sha256Hex(s))
})
await test('the raw state never equals its stored hash', async () => {
  const state = generateRandomToken(32)
  const hash = await sha256Hex(state)
  assert.notStrictEqual(state, hash)
  assert.ok(/^[0-9a-f]{64}$/.test(hash), 'hash is 64 hex chars')
})
await test('generateRandomToken is url-safe and unique', () => {
  const a = generateRandomToken(32)
  const b = generateRandomToken(32)
  assert.notStrictEqual(a, b)
  assert.ok(/^[A-Za-z0-9_-]+$/.test(a), 'base64url, no +/=')
})

// ── PKCE ──────────────────────────────────────────────────────────────────────
console.log('\nPKCE')
await test('challenge = base64url(SHA256(verifier)) — RFC 7636 test vector', async () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  const challenge = await pkceChallengeFromVerifier(verifier)
  assert.strictEqual(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

// ── Auth URL ──────────────────────────────────────────────────────────────────
console.log('\nbuildGoogleAuthUrl')
await test('offline access + S256 + scopes + state + challenge; no gmail', () => {
  const url = buildGoogleAuthUrl({
    clientId: 'CID', redirectUri: 'https://cb.example/callback', state: 'ST', codeChallenge: 'CH',
  })
  const u = new URL(url)
  assert.strictEqual(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.strictEqual(u.searchParams.get('access_type'), 'offline')
  assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256')
  assert.strictEqual(u.searchParams.get('code_challenge'), 'CH')
  assert.strictEqual(u.searchParams.get('state'), 'ST')
  assert.strictEqual(u.searchParams.get('response_type'), 'code')
  assert.ok(u.searchParams.get('scope').includes('calendar.events.readonly'))
  assert.ok(!/gmail/i.test(url), 'no gmail scope in the URL')
})

// ── Refresh-token preservation ────────────────────────────────────────────────
console.log('\nresolveRefreshTokenColumns')
await test('new refresh token replaces the stored one', () => {
  const r = resolveRefreshTokenColumns({ ciphertext: 'NEWct', nonce: 'NEWn' }, { refresh_token_ciphertext: 'OLDct', refresh_token_nonce: 'OLDn' })
  assert.strictEqual(r.refresh_token_ciphertext, 'NEWct')
  assert.strictEqual(r.refresh_token_nonce, 'NEWn')
})
await test('omitted refresh token PRESERVES the existing one', () => {
  const r = resolveRefreshTokenColumns(null, { refresh_token_ciphertext: 'OLDct', refresh_token_nonce: 'OLDn' })
  assert.strictEqual(r.refresh_token_ciphertext, 'OLDct')
  assert.strictEqual(r.refresh_token_nonce, 'OLDn')
})
await test('omitted refresh token with no prior row → null pair', () => {
  const r = resolveRefreshTokenColumns(null, null)
  assert.strictEqual(r.refresh_token_ciphertext, null)
  assert.strictEqual(r.refresh_token_nonce, null)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
