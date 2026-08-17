// OAuth helper tests: origin allowlist, PKCE, state hashing, scopes, auth URL,
// redirect construction, refresh-token preservation.
// Run with: node tests/google-oauth-helpers.test.js
import assert from 'assert'
import { webcrypto } from 'node:crypto'
if (!globalThis.crypto) globalThis.crypto = webcrypto

import {
  GOOGLE_OAUTH_SCOPES,
  REQUIRED_CALENDAR_SCOPE,
  resolveReturnOrigin,
  buildSettingsRedirect,
  CANONICAL_ERROR_REDIRECT,
  generateRandomToken,
  sha256Hex,
  pkceChallengeFromVerifier,
  buildGoogleAuthUrl,
  resolveRefreshTokenColumns,
  parseGrantedScopes,
  grantedScopesIncludeCalendar,
  validateGoogleIdentity,
  isSameGoogleAccount,
  requiresNewRefreshToken,
  hasStoredRefreshTokenPair,
  resolveRefreshRequirement,
  shouldRevokeNewTokenOnFailure,
  staleOauthStateCutoffIso,
  EXPECTED_GOOGLE_CALLBACK_URL,
  isValidConfiguredCallbackUrl,
  parseCallbackFormBody,
  CALLBACK_MAX_BODY_BYTES,
} from '../supabase/functions/shared/googleOauthHelpers.js'

const FORM_CT = 'application/x-www-form-urlencoded'

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
await test('offline access + re-consent + account selection + S256; no gmail', () => {
  const url = buildGoogleAuthUrl({
    clientId: 'CID', redirectUri: 'https://cb.example/callback', state: 'ST', codeChallenge: 'CH',
  })
  const u = new URL(url)
  assert.strictEqual(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.strictEqual(u.searchParams.get('access_type'), 'offline')
  assert.strictEqual(u.searchParams.get('prompt'), 'consent select_account')
  assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256')
  assert.strictEqual(u.searchParams.get('code_challenge'), 'CH')
  assert.strictEqual(u.searchParams.get('state'), 'ST')
  assert.strictEqual(u.searchParams.get('response_type'), 'code')
  assert.strictEqual(u.searchParams.get('include_granted_scopes'), 'true')
  assert.ok(u.searchParams.get('scope').includes('calendar.events.readonly'))
  assert.ok(!/gmail/i.test(url), 'no gmail scope in the URL')
})
await test('auth URL sets response_mode=form_post exactly once', () => {
  const url = buildGoogleAuthUrl({ clientId: 'CID', redirectUri: 'https://cb/x', state: 'ST', codeChallenge: 'CH' })
  const u = new URL(url)
  assert.strictEqual(u.searchParams.get('response_mode'), 'form_post')
  assert.strictEqual(u.searchParams.getAll('response_mode').length, 1)
})

// ── parseCallbackFormBody (response_mode=form_post transport) ──────────────────
console.log('\nparseCallbackFormBody')
await test('valid form body extracts code + state (charset param allowed)', () => {
  const r = parseCallbackFormBody('state=abc123&code=xyz789', `${FORM_CT}; charset=UTF-8`)
  assert.ok(r.ok); assert.strictEqual(r.state, 'abc123'); assert.strictEqual(r.code, 'xyz789'); assert.strictEqual(r.error, null)
})
await test('access_denied form POST → ok with error, code null (existing denial path)', () => {
  const r = parseCallbackFormBody('state=abc&error=access_denied', FORM_CT)
  assert.ok(r.ok); assert.strictEqual(r.error, 'access_denied'); assert.strictEqual(r.code, null)
})
await test('unrelated Google fields are ignored', () => {
  const r = parseCallbackFormBody('state=s&code=c&scope=https://www.googleapis.com/auth/calendar.events.readonly&authuser=0&hd=x&prompt=consent', FORM_CT)
  assert.ok(r.ok); assert.strictEqual(r.state, 's'); assert.strictEqual(r.code, 'c')
})
await test('missing state is rejected', () => {
  assert.deepStrictEqual(parseCallbackFormBody('code=xyz', FORM_CT), { ok: false, reason: 'missing_state' })
})
await test('missing code without an OAuth error is rejected', () => {
  assert.deepStrictEqual(parseCallbackFormBody('state=abc', FORM_CT), { ok: false, reason: 'missing_code' })
})
await test('duplicate state/code/error are rejected (no last-wins)', () => {
  assert.strictEqual(parseCallbackFormBody('state=a&state=b&code=c', FORM_CT).reason, 'duplicate_parameter')
  assert.strictEqual(parseCallbackFormBody('state=a&code=c&code=d', FORM_CT).reason, 'duplicate_parameter')
  assert.strictEqual(parseCallbackFormBody('state=a&error=x&error=y', FORM_CT).reason, 'duplicate_parameter')
})
await test('invalid percent-encoding is rejected safely', () => {
  assert.strictEqual(parseCallbackFormBody('state=%ZZ&code=c', FORM_CT).reason, 'malformed_encoding')
  assert.strictEqual(parseCallbackFormBody('state=%&code=c', FORM_CT).reason, 'malformed_encoding')
})
await test('oversized body is rejected', () => {
  const big = 'state=' + 'a'.repeat(CALLBACK_MAX_BODY_BYTES) + '&code=c'
  assert.strictEqual(parseCallbackFormBody(big, FORM_CT).reason, 'body_too_large')
})
await test('JSON and multipart content types are rejected', () => {
  assert.strictEqual(parseCallbackFormBody('{"state":"a","code":"c"}', 'application/json').reason, 'unsupported_content_type')
  assert.strictEqual(parseCallbackFormBody('state=a&code=c', 'multipart/form-data; boundary=xyz').reason, 'unsupported_content_type')
  assert.strictEqual(parseCallbackFormBody('state=a&code=c', null).reason, 'unsupported_content_type')
})
await test('non-string body is rejected', () => {
  assert.strictEqual(parseCallbackFormBody(undefined, FORM_CT).reason, 'invalid_body')
})
await test("'+' decodes to space in field values", () => {
  const r = parseCallbackFormBody('state=a+b&code=c', FORM_CT)
  assert.ok(r.ok); assert.strictEqual(r.state, 'a b')
})

// ── Granted-scope validation ──────────────────────────────────────────────────
console.log('\ngranted-scope validation')
await test('grantedScopesIncludeCalendar true only when Calendar read-only granted', () => {
  assert.ok(grantedScopesIncludeCalendar(`openid email ${REQUIRED_CALENDAR_SCOPE}`))
  assert.ok(!grantedScopesIncludeCalendar('openid email profile'))
  assert.ok(!grantedScopesIncludeCalendar(''))
  assert.ok(!grantedScopesIncludeCalendar(undefined))
})
await test('parseGrantedScopes splits and drops empties', () => {
  assert.deepStrictEqual(parseGrantedScopes('a  b '), ['a', 'b'])
  assert.deepStrictEqual(parseGrantedScopes(null), [])
})

// ── Identity validation (email_verified required) ─────────────────────────────
console.log('\nidentity validation')
await test('valid identity (sub + email + email_verified true)', () => {
  const r = validateGoogleIdentity({ sub: 'g-123', email: 'a@b.com', email_verified: true })
  assert.ok(r.ok); assert.strictEqual(r.sub, 'g-123'); assert.strictEqual(r.email, 'a@b.com')
})
await test('UNVERIFIED email rejected', () => {
  assert.strictEqual(validateGoogleIdentity({ sub: 'g', email: 'a@b.com', email_verified: false }).ok, false)
  assert.strictEqual(validateGoogleIdentity({ sub: 'g', email: 'a@b.com' }).ok, false) // missing → not true
})
await test('missing sub or email rejected', () => {
  assert.strictEqual(validateGoogleIdentity({ sub: '', email: 'a@b.com', email_verified: true }).ok, false)
  assert.strictEqual(validateGoogleIdentity({ sub: 'g', email: '', email_verified: true }).ok, false)
  assert.strictEqual(validateGoogleIdentity(null).ok, false)
})

// ── Same-account comparison + refresh requirement ─────────────────────────────
console.log('\naccount identity + refresh requirement')
await test('isSameGoogleAccount compares google_sub, not email', () => {
  assert.ok(isSameGoogleAccount({ google_sub: 'g-1' }, 'g-1'))
  assert.ok(!isSameGoogleAccount({ google_sub: 'g-1' }, 'g-2'))
  assert.ok(!isSameGoogleAccount(null, 'g-1'))
})
await test('requiresNewRefreshToken only when new/different account lacks a refresh token', () => {
  assert.strictEqual(requiresNewRefreshToken(false, false), true)  // new/different, no refresh → require
  assert.strictEqual(requiresNewRefreshToken(false, true), false)  // new/different WITH refresh → ok
  assert.strictEqual(requiresNewRefreshToken(true, false), false)  // same account may keep stored
  assert.strictEqual(requiresNewRefreshToken(true, true), false)
})

// ── hasStoredRefreshTokenPair (both parts non-empty) ──────────────────────────
console.log('\nhasStoredRefreshTokenPair')
await test('true only when both ciphertext and nonce are non-empty strings', () => {
  assert.ok(hasStoredRefreshTokenPair({ refresh_token_ciphertext: 'ct', refresh_token_nonce: 'n' }))
  assert.ok(!hasStoredRefreshTokenPair({ refresh_token_ciphertext: 'ct', refresh_token_nonce: '' }))
  assert.ok(!hasStoredRefreshTokenPair({ refresh_token_ciphertext: '', refresh_token_nonce: 'n' }))
  assert.ok(!hasStoredRefreshTokenPair({ refresh_token_ciphertext: 'ct', refresh_token_nonce: null }))
  assert.ok(!hasStoredRefreshTokenPair({ refresh_token_ciphertext: null, refresh_token_nonce: null }))
  assert.ok(!hasStoredRefreshTokenPair(null))
})

// ── resolveRefreshRequirement (complete truth table) ──────────────────────────
console.log('\nresolveRefreshRequirement')
await test('new account + new refresh → allowed (use new)', () => {
  const r = resolveRefreshRequirement({ sameSub: false, hasNewRefresh: true, hasStoredPair: false })
  assert.deepStrictEqual(r, { ok: true, useStored: false })
})
await test('new account + no refresh → rejected', () => {
  assert.strictEqual(resolveRefreshRequirement({ sameSub: false, hasNewRefresh: false, hasStoredPair: false }).ok, false)
})
await test('different sub + new refresh → allowed', () => {
  assert.strictEqual(resolveRefreshRequirement({ sameSub: false, hasNewRefresh: true, hasStoredPair: true }).ok, true)
})
await test('different sub + no refresh → rejected (never reuse other account pair)', () => {
  assert.strictEqual(resolveRefreshRequirement({ sameSub: false, hasNewRefresh: false, hasStoredPair: true }).ok, false)
})
await test('same sub + no new + COMPLETE stored pair → allowed (use stored)', () => {
  assert.deepStrictEqual(resolveRefreshRequirement({ sameSub: true, hasNewRefresh: false, hasStoredPair: true }), { ok: true, useStored: true })
})
await test('same sub + no new + missing/incomplete stored pair → rejected', () => {
  assert.strictEqual(resolveRefreshRequirement({ sameSub: true, hasNewRefresh: false, hasStoredPair: false }).ok, false)
})

// ── shouldRevokeNewTokenOnFailure ─────────────────────────────────────────────
console.log('\nshouldRevokeNewTokenOnFailure')
await test('revoke for new/different account; PRESERVE for same account with working pair', () => {
  assert.strictEqual(shouldRevokeNewTokenOnFailure(false, false), true)  // new
  assert.strictEqual(shouldRevokeNewTokenOnFailure(false, true), true)   // different sub
  assert.strictEqual(shouldRevokeNewTokenOnFailure(true, false), true)   // same sub, no working pair
  assert.strictEqual(shouldRevokeNewTokenOnFailure(true, true), false)   // same sub + working pair → don't kill grant
})

// ── Branded callback URL validation ───────────────────────────────────────────
console.log('\nisValidConfiguredCallbackUrl')
await test('the expected callback is the branded www URL', () => {
  assert.strictEqual(EXPECTED_GOOGLE_CALLBACK_URL, 'https://www.getfunnl.com/api/google-oauth-callback')
})
await test('exact branded URL accepted', () => {
  assert.strictEqual(isValidConfiguredCallbackUrl('https://www.getfunnl.com/api/google-oauth-callback'), true)
})
await test('the direct Supabase URL is REJECTED (internal rewrite destination only)', () => {
  assert.strictEqual(isValidConfiguredCallbackUrl('https://jzybxhvgnksrwxfivdwt.supabase.co/functions/v1/google-oauth-callback'), false)
})
await test('malformed alternatives are all rejected', () => {
  for (const v of [
    'https://getfunnl.com/api/google-oauth-callback',                        // apex
    'http://www.getfunnl.com/api/google-oauth-callback',                     // http
    'https://www.getfunnl.com:443/api/google-oauth-callback',               // explicit port
    'https://user:pass@www.getfunnl.com/api/google-oauth-callback',         // credentials
    'https://www.getfunnl.com/api/google-oauth-callback?x=1',               // query string
    'https://www.getfunnl.com/api/google-oauth-callback#frag',              // fragment
    'https://www.getfunnl.com/api/google-oauth-callback/',                  // trailing slash
    'https://www.getfunnl.com.evil.com/api/google-oauth-callback',         // look-alike
    'https://wwwXgetfunnl.com/api/google-oauth-callback',                   // look-alike
    ' https://www.getfunnl.com/api/google-oauth-callback',                  // whitespace
    '', null, undefined, 42,
  ]) {
    assert.strictEqual(isValidConfiguredCallbackUrl(v), false, `expected reject for ${JSON.stringify(v)}`)
  }
})

// ── Stale state cutoff ────────────────────────────────────────────────────────
console.log('\nstaleOauthStateCutoffIso')
await test('cutoff is now minus the retention window', () => {
  const now = Date.parse('2026-08-16T12:00:00.000Z')
  assert.strictEqual(staleOauthStateCutoffIso(now, 24 * 60 * 60 * 1000), '2026-08-15T12:00:00.000Z')
})

// ── Refresh-token preservation ────────────────────────────────────────────────
console.log('\nresolveRefreshTokenColumns')
await test('new refresh token replaces the stored one (any account)', () => {
  const r = resolveRefreshTokenColumns({ ciphertext: 'NEWct', nonce: 'NEWn' }, { refresh_token_ciphertext: 'OLDct', refresh_token_nonce: 'OLDn' }, false)
  assert.strictEqual(r.refresh_token_ciphertext, 'NEWct')
  assert.strictEqual(r.refresh_token_nonce, 'NEWn')
})
await test('SAME account + omitted refresh → PRESERVES the existing one', () => {
  const r = resolveRefreshTokenColumns(null, { refresh_token_ciphertext: 'OLDct', refresh_token_nonce: 'OLDn' }, true)
  assert.strictEqual(r.refresh_token_ciphertext, 'OLDct')
  assert.strictEqual(r.refresh_token_nonce, 'OLDn')
})
await test('SECURITY: DIFFERENT account + omitted refresh → null (never reuse A on B)', () => {
  const r = resolveRefreshTokenColumns(null, { refresh_token_ciphertext: 'A_ct', refresh_token_nonce: 'A_n' }, false)
  assert.strictEqual(r.refresh_token_ciphertext, null)
  assert.strictEqual(r.refresh_token_nonce, null)
})
await test('same account, no prior row → null pair', () => {
  const r = resolveRefreshTokenColumns(null, null, true)
  assert.strictEqual(r.refresh_token_ciphertext, null)
  assert.strictEqual(r.refresh_token_nonce, null)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
