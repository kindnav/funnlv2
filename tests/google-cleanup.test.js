// runGoogleLocalCleanup orchestration tests — proves the atomic local cleanup RPC
// ALWAYS runs, even when Google revocation fails, and that it is the ONLY local
// mutation path (no independent client deletes). Run with: node tests/google-cleanup.test.js
import assert from 'assert'
import { runGoogleLocalCleanup, GOOGLE_LOCAL_CLEANUP_RPC } from '../supabase/functions/shared/googleCleanup.js'

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}

// Minimal fake service-role client. Records every .from().delete() (there must be
// NONE) and every .rpc() call; returns injected data for selects.
function makeFakeAdmin(opts = {}) {
  const deletes = []
  const rpcs = []
  return {
    deletes,
    rpcs,
    from(table) {
      const api = {
        select() { return api },
        delete() { deletes.push({ table }); return api },
        eq() {
          return {
            maybeSingle: async () => {
              if (opts.lookupThrows) throw new Error('lookup_failed')
              if (table === 'google_connections') return { data: opts.conn ?? null, error: null }
              if (table === 'google_tokens') return { data: opts.tokens ?? null, error: null }
              return { data: null, error: null }
            },
            then: (resolve) => resolve({ error: null }),
          }
        },
      }
      return api
    },
    async rpc(name, args) {
      rpcs.push({ name, args })
      if (opts.rpcThrows) throw new Error('rpc_transport_failed')
      if (opts.rpcError) return { data: null, error: { code: 'P0001' } }
      if ('rpcData' in opts) return { data: opts.rpcData, error: null }
      return {
        data: {
          result: 'cleaned',
          connections_deleted: opts.conn ? 1 : 0,
          oauth_states_deleted: 0,
          gmail_candidates_invalidated: opts.invalidated ?? 0,
        },
        error: null,
      }
    },
  }
}

const UID = '11111111-1111-4111-8111-111111111111'
const CONN = { id: 'conn-1' }
const TOKENS = { refresh_token_ciphertext: 'rct', refresh_token_nonce: 'rn', access_token_ciphertext: 'act', access_token_nonce: 'an' }
const cleanupCalls = (admin) => admin.rpcs.filter(r => r.name === GOOGLE_LOCAL_CLEANUP_RPC)

console.log('\nrunGoogleLocalCleanup')

await test('RPC name is the service-only cleanup function', () => {
  assert.strictEqual(GOOGLE_LOCAL_CLEANUP_RPC, 'run_google_local_cleanup')
})

await test('happy path: revoke succeeds AND the atomic cleanup RPC runs once, scoped to the user', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS, invalidated: 3 })
  let revokedWith = null
  const res = await runGoogleLocalCleanup({
    admin, userId: UID,
    resolveToken: async () => 'the-token',
    revoke: async (t) => { revokedWith = t },
  })
  assert.strictEqual(res.revoked, true)
  assert.strictEqual(revokedWith, 'the-token')
  assert.strictEqual(cleanupCalls(admin).length, 1)
  assert.deepStrictEqual(cleanupCalls(admin)[0].args, { p_user_id: UID }, 'ownership input is exactly the verified user id')
  assert.strictEqual(res.localCleanupError, false)
  assert.strictEqual(res.gmailCandidatesInvalidated, 3)
})

await test('NO independent client deletes remain (atomicity lives in the RPC)', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS })
  await runGoogleLocalCleanup({ admin, userId: UID, resolveToken: async () => 'tok', revoke: async () => {} })
  assert.deepStrictEqual(admin.deletes, [], 'helper must not issue .delete() calls')
})

await test('INVARIANT: revoke THROWS → local cleanup still runs and succeeds', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS, invalidated: 2 })
  const res = await runGoogleLocalCleanup({
    admin, userId: UID,
    resolveToken: async () => 'the-token',
    revoke: async () => { throw new Error('google_unreachable') },
  })
  assert.strictEqual(res.revoked, false)
  assert.strictEqual(cleanupCalls(admin).length, 1)
  assert.strictEqual(res.localCleanupError, false)
  assert.strictEqual(res.gmailCandidatesInvalidated, 2, 'pending Gmail context is erased even when Google was unreachable')
})

await test('resolveToken throws → still cleans up (never blocks)', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS })
  const res = await runGoogleLocalCleanup({
    admin, userId: UID,
    resolveToken: async () => { throw new Error('decrypt_failed') },
    revoke: async () => {},
  })
  assert.strictEqual(res.revoked, false)
  assert.strictEqual(cleanupCalls(admin).length, 1)
  assert.strictEqual(res.localCleanupError, false)
})

await test('connection lookup throws → revoke skipped, cleanup still runs', async () => {
  const admin = makeFakeAdmin({ lookupThrows: true })
  let revokeCalled = false
  const res = await runGoogleLocalCleanup({ admin, userId: UID, resolveToken: async () => 'tok', revoke: async () => { revokeCalled = true } })
  assert.strictEqual(revokeCalled, false)
  assert.strictEqual(res.revoked, false)
  assert.strictEqual(cleanupCalls(admin).length, 1)
})

await test('no connection → no revoke, cleanup still runs (idempotent path)', async () => {
  const admin = makeFakeAdmin({ conn: null })
  let revokeCalled = false
  const res = await runGoogleLocalCleanup({
    admin, userId: UID,
    resolveToken: async () => 'tok',
    revoke: async () => { revokeCalled = true },
  })
  assert.strictEqual(revokeCalled, false)
  assert.strictEqual(res.revoked, false)
  assert.strictEqual(cleanupCalls(admin).length, 1)
  assert.strictEqual(res.localCleanupError, false)
  assert.strictEqual(res.gmailCandidatesInvalidated, 0)
})

await test('no revocable token → revoke skipped, cleanup runs', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS })
  let revokeCalled = false
  await runGoogleLocalCleanup({
    admin, userId: UID,
    resolveToken: async () => null,
    revoke: async () => { revokeCalled = true },
  })
  assert.strictEqual(revokeCalled, false)
  assert.strictEqual(cleanupCalls(admin).length, 1)
})

await test('RPC error → localCleanupError true, count 0, nothing thrown', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS, rpcError: true })
  const res = await runGoogleLocalCleanup({ admin, userId: UID, resolveToken: async () => 'tok', revoke: async () => {} })
  assert.strictEqual(res.localCleanupError, true)
  assert.strictEqual(res.gmailCandidatesInvalidated, 0)
})

await test('RPC transport throws → localCleanupError true, nothing thrown (delete-account stays best-effort)', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS, rpcThrows: true })
  const res = await runGoogleLocalCleanup({ admin, userId: UID, resolveToken: async () => 'tok', revoke: async () => {} })
  assert.strictEqual(res.localCleanupError, true)
})

await test('RPC returns a non-"cleaned" code → treated as an error (fail closed)', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS, rpcData: { result: 'invalid_user' } })
  const res = await runGoogleLocalCleanup({ admin, userId: UID, resolveToken: async () => 'tok', revoke: async () => {} })
  assert.strictEqual(res.localCleanupError, true)
})

await test('RPC returns null data → treated as an error (fail closed)', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS, rpcData: null })
  const res = await runGoogleLocalCleanup({ admin, userId: UID, resolveToken: async () => 'tok', revoke: async () => {} })
  assert.strictEqual(res.localCleanupError, true)
})

await test('malformed count in RPC payload normalizes to 0 (never NaN/negative)', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS, rpcData: { result: 'cleaned', gmail_candidates_invalidated: 'x' } })
  const res = await runGoogleLocalCleanup({ admin, userId: UID, resolveToken: async () => 'tok', revoke: async () => {} })
  assert.strictEqual(res.localCleanupError, false)
  assert.strictEqual(res.gmailCandidatesInvalidated, 0)
})

await test('clean success → localCleanupError false and the old two-flag contract is gone', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS })
  const res = await runGoogleLocalCleanup({ admin, userId: UID, resolveToken: async () => 'tok', revoke: async () => {} })
  assert.strictEqual(res.localCleanupError, false)
  assert.ok(!('oauthStateDeleteError' in res) && !('connectionDeleteError' in res))
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
