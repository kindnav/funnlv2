// finalizeGoogleConnection orchestration tests — scope/identity validation,
// same-vs-different account refresh handling, atomic persistence, and failure
// compensation. Run with: node tests/google-connect.test.js
import assert from 'assert'
import { finalizeGoogleConnection } from '../supabase/functions/shared/googleConnect.js'
import { REQUIRED_CALENDAR_SCOPE } from '../supabase/functions/shared/googleOauthHelpers.js'

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}

const SCOPE_OK = `openid email profile ${REQUIRED_CALENDAR_SCOPE}`
const VERIFIED = (sub, email = 'u@example.com') => ({ sub, email, email_verified: true })

// Deps factory with recording fakes. store() succeeds by default; pass storeThrows
// to simulate a DB failure. resolveOldToken returns a fixed old-account token.
function makeDeps(overrides = {}) {
  const rec = { storeArgs: [], revoked: [] }
  const deps = {
    exchange: { accessToken: 'ACCESS', refreshToken: null, expiresIn: 3600, scope: SCOPE_OK },
    identity: VERIFIED('sub-new'),
    userId: 'user-1',
    existingConnection: null,
    existingRefreshRow: null,
    encryptAccess:  async (t) => ({ ciphertext: `ENC(${t})`, nonce: `N(${t})` }),
    encryptRefresh: async (t) => ({ ciphertext: `ENC(${t})`, nonce: `N(${t})` }),
    store: async (args) => { rec.storeArgs.push(args); if (overrides.storeThrows) throw new Error('db'); return 'conn-id' },
    revoke: async (t) => { rec.revoked.push(t) },
    resolveOldToken: async () => 'OLD_A_TOKEN',
    nowMs: Date.parse('2026-08-16T12:00:00.000Z'),
    ...overrides,
  }
  return { deps, rec }
}

console.log('\nfinalizeGoogleConnection')

await test('happy path (first connection WITH refresh) → active, stored once', async () => {
  const { deps, rec } = makeDeps({ exchange: { accessToken: 'ACCESS', refreshToken: 'R1', expiresIn: 3600, scope: SCOPE_OK } })
  const r = await finalizeGoogleConnection(deps)
  assert.ok(r.ok)
  assert.strictEqual(rec.storeArgs.length, 1)
  assert.strictEqual(rec.storeArgs[0].p_status, 'active')
  assert.strictEqual(rec.storeArgs[0].p_google_sub, 'sub-new')
  assert.strictEqual(rec.storeArgs[0].p_refresh_ct, 'ENC(R1)')
  assert.strictEqual(rec.revoked.length, 0)
})

await test('Calendar scope NOT granted → reject + revoke new token, no store', async () => {
  const { deps, rec } = makeDeps({ exchange: { accessToken: 'ACCESS', refreshToken: 'R1', scope: 'openid email profile' } })
  const r = await finalizeGoogleConnection(deps)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'calendar_scope_not_granted')
  assert.strictEqual(rec.storeArgs.length, 0)
  assert.deepStrictEqual(rec.revoked, ['R1'])
})

await test('UNVERIFIED email → reject + revoke, no store', async () => {
  const { deps, rec } = makeDeps({ identity: { sub: 's', email: 'u@e.com', email_verified: false }, exchange: { accessToken: 'ACCESS', refreshToken: 'R1', scope: SCOPE_OK } })
  const r = await finalizeGoogleConnection(deps)
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'identity_invalid')
  assert.strictEqual(rec.storeArgs.length, 0)
  assert.deepStrictEqual(rec.revoked, ['R1'])
})

await test('first connection WITHOUT refresh token → reject + revoke access', async () => {
  const { deps, rec } = makeDeps({ exchange: { accessToken: 'ACCESS', refreshToken: null, scope: SCOPE_OK } })
  const r = await finalizeGoogleConnection(deps)
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'refresh_token_required')
  assert.strictEqual(rec.storeArgs.length, 0)
  assert.deepStrictEqual(rec.revoked, ['ACCESS'])  // no refresh → revoke the access token
})

await test('SAME account + omitted refresh → success, PRESERVES stored refresh, no old revoke', async () => {
  const { deps, rec } = makeDeps({
    identity: VERIFIED('sub-A'),
    existingConnection: { google_sub: 'sub-A' },
    existingRefreshRow: { refresh_token_ciphertext: 'A_ct', refresh_token_nonce: 'A_n' },
    exchange: { accessToken: 'ACCESS', refreshToken: null, scope: SCOPE_OK },
  })
  const r = await finalizeGoogleConnection(deps)
  assert.ok(r.ok)
  assert.strictEqual(rec.storeArgs[0].p_refresh_ct, 'A_ct')  // preserved
  assert.strictEqual(rec.revoked.length, 0)                  // same account → no old revoke
})

await test('SECURITY: DIFFERENT account (A→B) without refresh → reject; A token never used/stored', async () => {
  const { deps, rec } = makeDeps({
    identity: VERIFIED('sub-B'),
    existingConnection: { google_sub: 'sub-A' },
    existingRefreshRow: { refresh_token_ciphertext: 'A_ct', refresh_token_nonce: 'A_n' },
    exchange: { accessToken: 'ACCESS', refreshToken: null, scope: SCOPE_OK },
  })
  const r = await finalizeGoogleConnection(deps)
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'refresh_token_required')
  assert.strictEqual(rec.storeArgs.length, 0)  // never stored A's token on B
})

await test('SECURITY: DIFFERENT account (A→B) WITH new refresh → stores B refresh, NEVER A; revokes old A after store', async () => {
  const { deps, rec } = makeDeps({
    identity: VERIFIED('sub-B'),
    existingConnection: { google_sub: 'sub-A' },
    existingRefreshRow: { refresh_token_ciphertext: 'A_ct', refresh_token_nonce: 'A_n' },
    exchange: { accessToken: 'ACCESS', refreshToken: 'B_refresh', scope: SCOPE_OK },
  })
  const r = await finalizeGoogleConnection(deps)
  assert.ok(r.ok)
  assert.strictEqual(rec.storeArgs[0].p_refresh_ct, 'ENC(B_refresh)')   // B's token
  assert.notStrictEqual(rec.storeArgs[0].p_refresh_ct, 'A_ct')          // never A's
  assert.deepStrictEqual(rec.revoked, ['OLD_A_TOKEN'])                   // old A revoked AFTER store
})

await test('persistence failure → reject persist_failed + revoke new token, no active partial', async () => {
  const { deps, rec } = makeDeps({ storeThrows: true, exchange: { accessToken: 'ACCESS', refreshToken: 'R1', scope: SCOPE_OK } })
  const r = await finalizeGoogleConnection(deps)
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'persist_failed')
  assert.deepStrictEqual(rec.revoked, ['R1'])  // new token revoked; RPC atomicity means no partial row
})

await test('old-account revoke failure does not fail the successful new connection', async () => {
  const { deps } = makeDeps({
    identity: VERIFIED('sub-B'),
    existingConnection: { google_sub: 'sub-A' },
    existingRefreshRow: { refresh_token_ciphertext: 'A_ct', refresh_token_nonce: 'A_n' },
    exchange: { accessToken: 'ACCESS', refreshToken: 'B_refresh', scope: SCOPE_OK },
    resolveOldToken: async () => { throw new Error('decrypt') },  // old revoke prep fails
  })
  const r = await finalizeGoogleConnection(deps)
  assert.ok(r.ok, 'success is not undone by a best-effort old-revoke failure')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
