// runGoogleLocalCleanup orchestration tests — proves local deletion ALWAYS runs,
// even when Google revocation fails. Run with: node tests/google-cleanup.test.js
import assert from 'assert'
import { runGoogleLocalCleanup } from '../supabase/functions/shared/googleCleanup.js'

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}

// Minimal fake service-role client. Records delete calls; returns injected data
// for selects. `.eq()` yields an object that is both awaitable (delete path) and
// carries `.maybeSingle()` (select path), so both query shapes work.
function makeFakeAdmin(opts = {}) {
  const deletes = []
  return {
    deletes,
    from(table) {
      const api = {
        select() { return api },
        delete() { return api },
        eq(col, val) {
          return {
            maybeSingle: async () => {
              if (table === 'google_connections') return { data: opts.conn ?? null, error: null }
              if (table === 'google_tokens') return { data: opts.tokens ?? null, error: null }
              return { data: null, error: null }
            },
            then: (resolve) => {
              deletes.push({ table, col, val })
              let error = null
              if (table === 'google_connections' && opts.connDeleteError) error = { code: 'del' }
              if (table === 'google_oauth_states' && opts.stateDeleteError) error = { code: 'del' }
              resolve({ error })
            },
          }
        },
      }
      return api
    },
  }
}

const UID = '11111111-1111-4111-8111-111111111111'
const CONN = { id: 'conn-1' }
const TOKENS = { refresh_token_ciphertext: 'rct', refresh_token_nonce: 'rn', access_token_ciphertext: 'act', access_token_nonce: 'an' }
const deletedTables = (admin) => admin.deletes.map(d => d.table)

console.log('\nrunGoogleLocalCleanup')

await test('happy path: revoke succeeds AND both local tables are deleted', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS })
  let revokedWith = null
  const res = await runGoogleLocalCleanup({
    admin, userId: UID,
    resolveToken: async () => 'the-token',
    revoke: async (t) => { revokedWith = t },
  })
  assert.strictEqual(res.revoked, true)
  assert.strictEqual(revokedWith, 'the-token')
  assert.ok(deletedTables(admin).includes('google_oauth_states'))
  assert.ok(deletedTables(admin).includes('google_connections'))
  assert.ok(admin.deletes.every(d => d.col === 'user_id' && d.val === UID), 'deletes scoped to the user')
})

await test('INVARIANT: revoke THROWS → local tables are still deleted', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS })
  const res = await runGoogleLocalCleanup({
    admin, userId: UID,
    resolveToken: async () => 'the-token',
    revoke: async () => { throw new Error('google_unreachable') },
  })
  assert.strictEqual(res.revoked, false)
  assert.ok(deletedTables(admin).includes('google_oauth_states'))
  assert.ok(deletedTables(admin).includes('google_connections'))
})

await test('resolveToken throws → still deletes (never blocks)', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS })
  const res = await runGoogleLocalCleanup({
    admin, userId: UID,
    resolveToken: async () => { throw new Error('decrypt_failed') },
    revoke: async () => {},
  })
  assert.strictEqual(res.revoked, false)
  assert.ok(deletedTables(admin).includes('google_connections'))
})

await test('no connection → no revoke, deletes still run', async () => {
  const admin = makeFakeAdmin({ conn: null })
  let revokeCalled = false
  const res = await runGoogleLocalCleanup({
    admin, userId: UID,
    resolveToken: async () => 'tok',
    revoke: async () => { revokeCalled = true },
  })
  assert.strictEqual(revokeCalled, false)
  assert.strictEqual(res.revoked, false)
  assert.ok(deletedTables(admin).includes('google_oauth_states'))
  assert.ok(deletedTables(admin).includes('google_connections'))
})

await test('no revocable token → revoke skipped, deletes run', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS })
  let revokeCalled = false
  await runGoogleLocalCleanup({
    admin, userId: UID,
    resolveToken: async () => null,
    revoke: async () => { revokeCalled = true },
  })
  assert.strictEqual(revokeCalled, false)
  assert.ok(deletedTables(admin).includes('google_connections'))
})

await test('connection delete error is reported (separately)', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS, connDeleteError: true })
  const res = await runGoogleLocalCleanup({ admin, userId: UID, resolveToken: async () => 'tok', revoke: async () => {} })
  assert.strictEqual(res.connectionDeleteError, true)
  assert.strictEqual(res.oauthStateDeleteError, false)
})

await test('oauth-state delete error is reported (separately)', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS, stateDeleteError: true })
  const res = await runGoogleLocalCleanup({ admin, userId: UID, resolveToken: async () => 'tok', revoke: async () => {} })
  assert.strictEqual(res.oauthStateDeleteError, true)
  assert.strictEqual(res.connectionDeleteError, false)
  // Both deletes are still ATTEMPTED even when one errors.
  assert.ok(deletedTables(admin).includes('google_oauth_states'))
  assert.ok(deletedTables(admin).includes('google_connections'))
})

await test('clean success → both delete errors false', async () => {
  const admin = makeFakeAdmin({ conn: CONN, tokens: TOKENS })
  const res = await runGoogleLocalCleanup({ admin, userId: UID, resolveToken: async () => 'tok', revoke: async () => {} })
  assert.strictEqual(res.oauthStateDeleteError, false)
  assert.strictEqual(res.connectionDeleteError, false)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
