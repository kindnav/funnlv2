// Tests for capability-aware Gmail OAuth (pure, DI). Synthetic values only — no real
// tokens, codes, subs, addresses, or credentials.
// Run: node tests/gmail-oauth-capability.test.js

import assert from 'assert'
import {
  GMAIL_OAUTH_SCOPES, GMAIL_INTEGRATION_TYPE, GMAIL_PRODUCT,
  grantedScopesIncludeGmailReadonly, buildGmailAuthUrl, calendarScopesAreGmailFree,
  finalizeGmailCapability, resolveGmailCapabilityTransition,
} from '../supabase/functions/shared/gmailOauth.js'
import { GOOGLE_OAUTH_SCOPES, REQUIRED_CALENDAR_SCOPE } from '../supabase/functions/shared/googleOauthHelpers.js'
import { GMAIL_READONLY_SCOPE } from '../supabase/functions/shared/gmailTransport.js'

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

// ── fixtures ────────────────────────────────────────────────────────────────────
const SUB = 'sub-A'
const ID_OK = { sub: SUB, email: 'u1@example.com', email_verified: true }
const SCOPE_WITH_GMAIL = `openid email profile ${GMAIL_READONLY_SCOPE}`
const enc = (tag) => async () => ({ ciphertext: 'ct-' + tag, nonce: 'nc-' + tag })

function harness(over = {}) {
  const calls = { store: [], cap: [], revoked: [] }
  return {
    calls,
    deps: {
      exchange: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: SCOPE_WITH_GMAIL },
      identity: ID_OK,
      userId: 'u1',
      existingConnection: null,
      existingRefreshRow: null,
      encryptAccess: enc('a'),
      encryptRefresh: enc('r'),
      store: async (args) => { calls.store.push(args); return 'conn-1' },
      upsertCapability: async (args) => { calls.cap.push(args); return { result: 'ok' } },
      revoke: async (t) => { calls.revoked.push(t) },
      nowMs: Date.UTC(2026, 0, 1),
      ...over,
    },
  }
}

console.log('\nCalendar-only authorization must remain unchanged')
await test('GOOGLE_OAUTH_SCOPES still Calendar-only — no Gmail scope added', () => {
  assert.deepStrictEqual([...GOOGLE_OAUTH_SCOPES], ['openid', 'email', 'profile', REQUIRED_CALENDAR_SCOPE])
  assert.ok(calendarScopesAreGmailFree())
  assert.ok(!GOOGLE_OAUTH_SCOPES.some((s) => s.includes('gmail')))
})
await test('Gmail consent URL requests gmail.readonly and NOT the calendar scope', () => {
  const url = buildGmailAuthUrl({ clientId: 'cid', redirectUri: 'https://x.example/cb', state: 'st', codeChallenge: 'cc' })
  const scope = decodeURIComponent(new URL(url).searchParams.get('scope'))
  assert.ok(scope.includes(GMAIL_READONLY_SCOPE), 'gmail scope present')
  assert.ok(!scope.includes(REQUIRED_CALENDAR_SCOPE), 'calendar scope must NOT be requested')
  // incremental authorization preserves an existing Calendar grant
  assert.strictEqual(new URL(url).searchParams.get('include_granted_scopes'), 'true')
  assert.strictEqual(new URL(url).searchParams.get('access_type'), 'offline')
  assert.strictEqual(new URL(url).searchParams.get('code_challenge_method'), 'S256')
})
await test('integration type + product constants are gmail', () => {
  assert.strictEqual(GMAIL_INTEGRATION_TYPE, 'gmail')
  assert.strictEqual(GMAIL_PRODUCT, 'gmail')
  assert.deepStrictEqual([...GMAIL_OAUTH_SCOPES], ['openid', 'email', 'profile', GMAIL_READONLY_SCOPE])
})
await test('grantedScopesIncludeGmailReadonly', () => {
  assert.strictEqual(grantedScopesIncludeGmailReadonly(SCOPE_WITH_GMAIL), true)
  assert.strictEqual(grantedScopesIncludeGmailReadonly(`openid ${REQUIRED_CALENDAR_SCOPE}`), false)
  assert.strictEqual(grantedScopesIncludeGmailReadonly(''), false)
  assert.strictEqual(grantedScopesIncludeGmailReadonly(null), false)
})

console.log('\nGmail consent adds ONLY the Gmail capability')
await test('success writes exactly one capability row, product gmail', async () => {
  const h = harness()
  const r = await finalizeGmailCapability(h.deps)
  assert.deepStrictEqual(r, { ok: true, connectionId: 'conn-1' })
  assert.strictEqual(h.calls.cap.length, 1)
  assert.strictEqual(h.calls.cap[0].p_product, 'gmail')
  assert.strictEqual(h.calls.cap[0].p_status, 'active')
  assert.strictEqual(h.calls.cap[0].p_granted, true)
  assert.strictEqual(h.calls.cap[0].p_needs_reauth, false)
  // never writes a calendar capability
  assert.ok(!h.calls.cap.some((c) => c.p_product === 'calendar'))
})
await test('capability is written only AFTER connection/token persistence', async () => {
  const order = []
  const h = harness({
    store: async () => { order.push('store'); return 'conn-1' },
    upsertCapability: async () => { order.push('cap'); return { result: 'ok' } },
  })
  await finalizeGmailCapability(h.deps)
  assert.deepStrictEqual(order, ['store', 'cap'])
})
await test('persist failure -> no capability write', async () => {
  const h = harness({ store: async () => { throw new Error('db') } })
  const r = await finalizeGmailCapability(h.deps)
  assert.deepStrictEqual(r, { ok: false, reason: 'persist_failed' })
  assert.strictEqual(h.calls.cap.length, 0)
})
await test('capability write failure surfaces a controlled reason', async () => {
  const h = harness({ upsertCapability: async () => ({ result: 'owner_mismatch' }) })
  const r = await finalizeGmailCapability(h.deps)
  assert.deepStrictEqual(r, { ok: false, reason: 'capability_write_failed' })
})

console.log('\nGoogle sub mismatch is rejected WITHOUT mutation')
await test('different sub on an existing connection -> google_sub_mismatch, nothing written', async () => {
  const h = harness({ existingConnection: { id: 'conn-1', google_sub: 'sub-OTHER' } })
  const r = await finalizeGmailCapability(h.deps)
  assert.deepStrictEqual(r, { ok: false, reason: 'google_sub_mismatch' })
  assert.strictEqual(h.calls.store.length, 0, 'no connection/token write')
  assert.strictEqual(h.calls.cap.length, 0, 'no capability write')
  assert.strictEqual(h.calls.revoked.length, 1, 'the new token is revoked best-effort')
})
await test('matching sub on an existing connection proceeds', async () => {
  const h = harness({ existingConnection: { id: 'conn-1', google_sub: SUB } })
  const r = await finalizeGmailCapability(h.deps)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(h.calls.store[0].p_google_sub, SUB)
})

console.log('\nrefresh-token semantics')
await test('FAIL-CLOSED: missing refresh token on the SAME account -> zero mutation, no revoke, Gmail NOT activated', async () => {
  // Every other precondition holds (verified same sub, gmail.readonly granted, valid identity)
  // but Google returned no new refresh token. The stored Calendar-only credential must NOT
  // be reused to activate Gmail, nothing may be written, and nothing may be revoked.
  const h = harness({
    exchange: { accessToken: 'AT', refreshToken: null, expiresIn: 3600, scope: SCOPE_WITH_GMAIL },
    existingConnection: { id: 'conn-1', google_sub: SUB },
    existingRefreshRow: { refresh_token_ciphertext: 'OLD-CT', refresh_token_nonce: 'OLD-NC' },
  })
  const r = await finalizeGmailCapability(h.deps)
  assert.deepStrictEqual(r, { ok: false, reason: 'missing_refresh_token' })
  assert.strictEqual(h.calls.store.length, 0, 'no connection/token write')
  assert.strictEqual(h.calls.cap.length, 0, 'no capability write')
  assert.strictEqual(h.calls.revoked.length, 0, 'the working Calendar grant is never revoked')
  for (const v of ['', undefined]) {
    const h2 = harness({
      exchange: { accessToken: 'AT', refreshToken: v, scope: SCOPE_WITH_GMAIL },
      existingConnection: { id: 'conn-1', google_sub: SUB },
      existingRefreshRow: { refresh_token_ciphertext: 'OLD-CT', refresh_token_nonce: 'OLD-NC' },
    })
    assert.strictEqual((await finalizeGmailCapability(h2.deps)).reason, 'missing_refresh_token')
    assert.strictEqual(h2.calls.store.length + h2.calls.cap.length + h2.calls.revoked.length, 0)
  }
})
await test('missing refresh token with NO existing connection is refused (unusable new token revoked)', async () => {
  const h = harness({ exchange: { accessToken: 'AT', refreshToken: null, scope: SCOPE_WITH_GMAIL } })
  const r = await finalizeGmailCapability(h.deps)
  assert.deepStrictEqual(r, { ok: false, reason: 'missing_refresh_token' })
  assert.strictEqual(h.calls.store.length, 0)
  assert.strictEqual(h.calls.cap.length, 0)
  assert.strictEqual(h.calls.revoked.length, 1, 'nothing of ours to protect: revoke the unusable token')
})
await test('the stored refresh pair is NEVER consulted for activation (source invariant)', async () => {
  const src = (await import('fs')).readFileSync('supabase/functions/shared/gmailOauth.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.ok(!/resolveRefreshTokenColumns|hasStoredRefreshTokenPair|resolveRefreshRequirement/.test(src),
    'no reuse helper may be imported or called')
  assert.ok(!/existingRefreshRow\??\.refresh_token/.test(src), 'stored ciphertext never read')
  assert.ok(/p_refresh_ct:\s*encRefresh\.ciphertext/.test(src) && /p_refresh_nonce:\s*encRefresh\.nonce/.test(src),
    'only the newly encrypted pair is stored')
})
await test('a NEW refresh token is used (and replaces the stored pair)', async () => {
  const h = harness({
    existingConnection: { id: 'conn-1', google_sub: SUB },
    existingRefreshRow: { refresh_token_ciphertext: 'OLD-CT', refresh_token_nonce: 'OLD-NC' },
  })
  await finalizeGmailCapability(h.deps)
  assert.strictEqual(h.calls.store[0].p_refresh_ct, 'ct-r')
})
await test('same-account persist failure does NOT revoke the shared working credential', async () => {
  const h = harness({
    existingConnection: { id: 'conn-1', google_sub: SUB },
    existingRefreshRow: { refresh_token_ciphertext: 'OLD-CT', refresh_token_nonce: 'OLD-NC' },
    store: async () => { throw new Error('db') },
  })
  const r = await finalizeGmailCapability(h.deps)
  assert.strictEqual(r.reason, 'persist_failed')
  assert.strictEqual(h.calls.revoked.length, 0, 'must not revoke a credential Calendar may still use')
})

console.log('\nscope / identity failures')
await test('gmail scope not granted -> rejected + revoked, nothing written', async () => {
  const h = harness({ exchange: { accessToken: 'AT', refreshToken: 'RT', scope: `openid ${REQUIRED_CALENDAR_SCOPE}` } })
  const r = await finalizeGmailCapability(h.deps)
  assert.deepStrictEqual(r, { ok: false, reason: 'gmail_scope_not_granted' })
  assert.strictEqual(h.calls.store.length, 0)
  assert.strictEqual(h.calls.cap.length, 0)
  assert.strictEqual(h.calls.revoked.length, 1)
})
await test('invalid identity (unverified email / missing sub) -> rejected', async () => {
  for (const bad of [{ sub: SUB, email: 'u@example.com', email_verified: false }, { email: 'u@example.com', email_verified: true }, {}]) {
    const h = harness({ identity: bad })
    const r = await finalizeGmailCapability(h.deps)
    assert.deepStrictEqual(r, { ok: false, reason: 'identity_invalid' })
    assert.strictEqual(h.calls.store.length, 0)
  }
})
await test('REGRESSION: same-account rejection NEVER revokes (Calendar keeps its grant)', async () => {
  // The user already has a working Calendar connection on this Google account and now
  // adds Gmail but unticks the mailbox scope (granular consent) / identity fails / no
  // refresh token. A revoke of the just-issued token is not guaranteed by Google's docs to
  // leave OTHER refresh tokens of the same grant alive, so nothing may be revoked.
  const existing = { id: 'conn-1', google_sub: SUB }
  const cases = [
    ['scope not granted', { exchange: { accessToken: 'AT', refreshToken: 'RT', scope: `openid ${REQUIRED_CALENDAR_SCOPE}` } }, 'gmail_scope_not_granted'],
    ['identity invalid',  { identity: { email: 'u@example.com', email_verified: true } }, 'identity_invalid'],
    ['refresh missing',   { exchange: { accessToken: 'AT', refreshToken: null, scope: SCOPE_WITH_GMAIL }, existingRefreshRow: null }, 'missing_refresh_token'],
  ]
  for (const [label, over, reason] of cases) {
    const h = harness({ existingConnection: existing, existingRefreshRow: null, ...over })
    const r = await finalizeGmailCapability(h.deps)
    assert.strictEqual(r.reason, reason, label)
    assert.strictEqual(h.calls.revoked.length, 0, `${label}: must not revoke`)
    assert.strictEqual(h.calls.store.length, 0, `${label}: no mutation`)
    assert.strictEqual(h.calls.cap.length, 0, `${label}: no capability write`)
  }
})
await test('a DIFFERENT account is still revoked on rejection (cannot touch the stored grant)', async () => {
  const h = harness({
    existingConnection: { id: 'conn-1', google_sub: 'someone-else' },
    exchange: { accessToken: 'AT', refreshToken: 'RT', scope: `openid ${REQUIRED_CALENDAR_SCOPE}` },   // gmail not granted either
  })
  const r = await finalizeGmailCapability(h.deps)
  assert.strictEqual(r.reason, 'google_sub_mismatch', 'account binding is decided before scope')
  assert.strictEqual(h.calls.revoked.length, 1)
  assert.strictEqual(h.calls.store.length, 0)
})
await test('with NO existing connection every rejection still revokes the new token', async () => {
  for (const over of [
    { exchange: { accessToken: 'AT', refreshToken: 'RT', scope: 'openid' } },
    { identity: {} },
    { exchange: { accessToken: 'AT', refreshToken: null, scope: SCOPE_WITH_GMAIL } },
  ]) {
    const h = harness(over)
    const r = await finalizeGmailCapability(h.deps)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(h.calls.revoked.length, 1)
  }
})
await test('missing access token / invalid user -> controlled refusal', async () => {
  assert.strictEqual((await finalizeGmailCapability(harness({ exchange: { accessToken: '' } }).deps)).reason, 'no_access_token')
  assert.strictEqual((await finalizeGmailCapability(harness({ userId: '' }).deps)).reason, 'invalid_user')
})

console.log('\ncapability transitions: Gmail failure never disables Calendar')
await test('gmail scope revoked -> gmail needs_reauth only, NOT connection-wide', () => {
  const t = resolveGmailCapabilityTransition('gmail_scope_revoked')
  assert.strictEqual(t.product, 'gmail')
  assert.strictEqual(t.status, 'needs_reauth')
  assert.strictEqual(t.granted, false)
  assert.strictEqual(t.needsReauth, true)
  assert.strictEqual(t.connectionWide, false, 'must NOT cascade to Calendar')
})
await test('invalid_grant (shared credential dead) -> connection-wide failure', () => {
  const t = resolveGmailCapabilityTransition('invalid_grant')
  assert.strictEqual(t.status, 'needs_reauth')
  assert.strictEqual(t.connectionWide, true)
})
await test('transient provider error keeps the capability usable', () => {
  const t = resolveGmailCapabilityTransition('provider_error')
  assert.strictEqual(t.status, 'active')
  assert.strictEqual(t.granted, true)
  assert.strictEqual(t.connectionWide, false)
})
await test('ok -> active/granted', () => {
  const t = resolveGmailCapabilityTransition('ok')
  assert.strictEqual(t.status, 'active'); assert.strictEqual(t.granted, true); assert.strictEqual(t.needsReauth, false)
})
await test('every transition targets ONLY the gmail product', () => {
  for (const r of ['ok', 'gmail_scope_revoked', 'invalid_grant', 'provider_error', 'whatever']) {
    assert.strictEqual(resolveGmailCapabilityTransition(r).product, 'gmail')
  }
})

console.log('\nprivacy: no sensitive value in any returned reason')
await test('reasons are controlled codes only', async () => {
  const reasons = []
  for (const over of [
    { exchange: { accessToken: '' } },
    { exchange: { accessToken: 'AT', refreshToken: 'RT', scope: 'openid' } },
    { identity: {} },
    { existingConnection: { id: 'c', google_sub: 'other' } },
    { exchange: { accessToken: 'AT', refreshToken: null, scope: SCOPE_WITH_GMAIL } },
    { store: async () => { throw new Error('db boom') } },
  ]) {
    const r = await finalizeGmailCapability(harness(over).deps)
    if (!r.ok) reasons.push(r.reason)
  }
  for (const x of reasons) {
    assert.ok(/^[a-z_]+$/.test(x), `reason must be a bare code: ${x}`)
    assert.ok(!/AT|RT|example\.com|sub-/.test(x), `reason leaked a value: ${x}`)
  }
  assert.ok(reasons.length >= 6)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
