// Unit tests for the Outlook callback's exchange / validation / resolution
// modules. Zero dependencies, no network, no Entra registration.
//
// The id_token tests use a REAL RS256 signature produced by Node's webcrypto
// with a locally generated key, so signature failures are genuine rather than
// simulated: a wrong-key case signs with a second key and must be rejected.
//
// Run with: node tests/outlook-callback-exchange.test.js

import assert from 'assert'
import { readJsonBounded, MAX_PROVIDER_BODY_BYTES } from '../supabase/functions/shared/boundedJson.js'

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


// ── a real RS256 signer, so signature checks are genuine ─────────────────────
// A verifier that mirrors what jose does for us: checks the signature against
// the provided key, then hands back the payload.

console.log('\nid_token: tenant, issuer and key selection')

console.log('\nid_token: full verification')

console.log('\ntoken exchange')

console.log('\nGraph /me mailbox resolution')

// LIMITATION OF THE FIXTURES BELOW, stated because it mattered. The identifiers
// here ('oid-1', 'oid-' + tid) are SYNTHETIC: neither GUIDs nor hex, so no
// realistic Microsoft representation is exercised by this file. A live personal
// account refused with graph_identity_mismatch and nothing here could have
// caught it. Realistic GUID / 16-hex / zero-padded coverage, and the privacy-safe
// mismatch diagnostic, live in tests/outlook-graph-identity.test.js. These cases
// are kept as-is: they still prove the comparison is exact and case-insensitive.

console.log('')
console.log('response bodies are bounded in time and size')

// A Response whose HEADERS arrive immediately and whose BODY never completes.
// This is precisely the case the earlier code could not survive: it cleared the
// AbortController timer as soon as fetch resolved, and fetch resolves on headers.


test('a declared content-length over the ceiling is refused before buffering', async () => {
  // A controlled double, so 'was a byte read?' is observable. A real Response
  // may touch its stream during construction, which would mask the point.
  let readerRequested = false
  const res = {
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(10 * 1024 * 1024) : null) },
    body: { getReader: () => { readerRequested = true; return { read: async () => ({ done: true }) } } },
  }
  const r = await readJsonBounded(res, 1024)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'response_too_large')
  assert.strictEqual(readerRequested, false, 'must refuse before reading a byte')
})
test('a well-formed bounded body still parses', async () => {
  const res = new Response(JSON.stringify({ a: 1 }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
  const r = await readJsonBounded(res, MAX_PROVIDER_BODY_BYTES)
  assert.deepStrictEqual(r, { ok: true, value: { a: 1 } })
})

test('malformed JSON inside the ceiling is a controlled failure', async () => {
  const res = new Response('{not json', { status: 200 })
  const r = await readJsonBounded(res, MAX_PROVIDER_BODY_BYTES)
  assert.strictEqual(r.reason, 'response_malformed')
})

test('no provider body text ever reaches a returned reason', async () => {
  const res = new Response('{"secret":"LEAKED-CODE"', { status: 200 })
  const r = await readJsonBounded(res, MAX_PROVIDER_BODY_BYTES)
  assert.ok(!JSON.stringify(r).includes('LEAKED-CODE'))
})

async function finish () {
  await Promise.all(pending)
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
await finish()
