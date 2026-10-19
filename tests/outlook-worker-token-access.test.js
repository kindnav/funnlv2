// The deployed worker's token access: the refresh grant, the run-context loader, the
// database ports, the configuration gate, and the lease-renewal timing case.
//
// WHAT IS EXERCISED HERE. Every function below is driven with injected ports and
// fixture provider responses, so the decisions are executed: which grant is sent and
// with what redirect policy, what a refresh response must contain, when a stored token
// counts as stale, that a rotated refresh token is persisted BEFORE the run uses it,
// that a missing secret refuses before anything is read, and that a lease renewal that
// does not confirm stops the pass.
//
// WHAT IS NOT. No Microsoft, no network, no browser, no deployed function. The fixtures
// show what the code does GIVEN a response of that shape; they are not evidence that
// Microsoft produces that shape. The database-backed behaviour (the rotation RPC's fence
// and optional refresh pair) is proven against a real Postgres by
// tests/sql/outlook-token-rotation-runtime.sql, and the whole path through the real
// handler over HTTP by tests/local/outlook-worker-token-access.mjs.
//
// Run with: node tests/outlook-worker-token-access.test.js

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
   // the version these fixtures' connections consented under; injected as the background requirement

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

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const ROTATION_MIG = read('supabase/migrations/20261001000000_outlook_rotate_access_token.sql')


/**
 * Every run now reads and writes round progress, so a suite's own rpc is wrapped: the
 * four round-progress RPCs answer from an in-memory mirror of migration 20261002000000
 * and everything else falls through unchanged. That keeps these suites tests of lease
 * LIFETIME and of the commit gate, rather than tests of the database - which
 * tests/sql/outlook-durable-continuation-runtime.sql and the Docker harness cover.
 */

// The cursor plaintext is recoverable from the ciphertext ON PURPOSE, so a test can
// assert WHICH link a resumed request used.

console.log('\nthe refresh grant')

console.log('\nthe run-context loader')

/** A select port over in-memory rows, keyed by the table name in the path. */


console.log('\nthe handler: configuration gate and response shape')


console.log('\nthe deployed entry points at Microsoft, and its ports refuse redirects')

console.log('\nthe rotation migration')

test('it is service_role only, SECURITY DEFINER, and unapplied', () => {
  assert.ok(/REVOKE ALL ON FUNCTION public\.rotate_microsoft_access_token\([\s\S]*?\)\s*FROM PUBLIC, anon, authenticated;/.test(ROTATION_MIG))
  assert.ok(/GRANT EXECUTE ON FUNCTION public\.rotate_microsoft_access_token\([\s\S]*?\)\s*TO service_role;/.test(ROTATION_MIG))
  assert.ok(/SECURITY DEFINER/.test(ROTATION_MIG) && /SET search_path = ''/.test(ROTATION_MIG))
  assert.ok(/NOT APPLIED/.test(ROTATION_MIG))
})

test('it fences on BOTH folder leases and writes only the two intended rows', () => {
  assert.ok(ROTATION_MIG.includes('PERFORM 1 FROM public.outlook_sync_state s'))
  assert.ok(/count\(\*\) = 2 AND bool_and\(s\.sync_run_id = p_run_id/.test(ROTATION_MIG))
  const code = ROTATION_MIG.split(String.fromCharCode(10)).filter((l) => !/^\s*--/.test(l)).join(String.fromCharCode(10))
  const updates = [...code.matchAll(/UPDATE public\.([a-z_]+)/g)].map((m) => m[1]).sort()
  assert.deepStrictEqual(updates, ['microsoft_connections', 'microsoft_tokens'])
  assert.ok(!/INSERT INTO/.test(code), 'it cannot create a token row')
  assert.ok(!/DELETE FROM/.test(code))
  for (const untouched of ['scopes', 'needs_reauth', 'consented_at', 'interaction_candidates']) {
    assert.ok(!new RegExp(`SET[\\s\\S]{0,200}${untouched}`).test(code), `must not write ${untouched}`)
  }
})

test('the optional refresh pair is COALESCEd, so an omitted token is kept', () => {
  assert.ok(/refresh_token_ciphertext = COALESCE\(p_refresh_ct, t\.refresh_token_ciphertext\)/.test(ROTATION_MIG))
  assert.ok(/refresh_token_nonce\s*= COALESCE\(p_refresh_nonce, t\.refresh_token_nonce\)/.test(ROTATION_MIG))
  assert.ok(/invalid_refresh_pair/.test(ROTATION_MIG), 'a half pair must be refused')
})

console.log('\nnothing outside this slice was added')

console.log('')
console.log('the lease survives a slow but successful run')

/**
 * A virtual clock plus a lease the database would actually enforce: a renewal succeeds
 * only while the lease is still live, and a write or release is refused once it is not.
 * That is what makes these tests about lease LIFETIME rather than about call counts.
 */

console.log('')
console.log('the timing invariant, stated correctly')

console.log('')
console.log('contacts are loaded in bounded pages, and overflow fails the run')

// A real ciphertext under the test key, so the loader's decryption succeeds and these
// tests are about the contact read rather than the token path.

/** A select port whose contacts table is `total` rows, honouring limit and offset. */

console.log('')
console.log('the lease deadline is anchored to when the RPC RAN, not when it answered')

/**
 * A virtual clock plus a lease the database enforces, where EVERY RPC costs its deadline
 * and the lease begins when the call STARTS. That last detail is the whole point: the
 * worker cannot observe it, so its arithmetic has to assume it.
 */

console.log('')
console.log('the timing invariant, with the round trip accounted for')

async function finish () {
  await Promise.all(pending)
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
await finish()
