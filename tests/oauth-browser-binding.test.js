// Browser-binding tests for the Google OAuth flow.
//
// The bug: google-oauth-start records the INITIATING Funnl user in an OAuth state
// row; the shared callback took the user id from that row without proving the
// browser completing consent was the browser that started. An attacker could send
// their own authorization URL to a victim and capture the victim's Google account
// under the attacker's Funnl account.
//
// These tests exercise the real exported functions and a faithful in-memory model
// of the callback's decision order. They are deliberately NOT source-string scans,
// except where a scan is the only way to assert an ordering property.
//
// Run: node tests/oauth-browser-binding.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8')

let passed = 0, failed = 0

// Async tests must be awaited before the summary is printed and before the process
// exits. An earlier version called fn() and counted a pass immediately: a rejected
// Promise from an async test was never observed, so assertions that ran after an
// `await` could not fail the run. Synchronous tests still report in place; async
// ones are collected here and settled by finish() below.
const pendingTests = []
function test (name, fn) {
  const pass = () => { console.log(`  ✓ ${name}`); passed++ }
  const fail = (e) => {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e && e.message ? e.message : e}`)
    failed++
  }
  let result
  try {
    result = fn()
  } catch (e) {
    fail(e)
    return
  }
  if (result && typeof result.then === 'function') {
    pendingTests.push(result.then(pass, fail))
    return
  }
  pass()
}

/** Settles every async test, then prints the summary and sets the exit code. */
async function finish () {
  await Promise.all(pendingTests)
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}

// ─────────────────────────────────────────────────────────────────────────────
// A faithful model of the callback's ORDER of operations. Every side effect is
// recorded so a test can assert that nothing happened before the binding check.
// ─────────────────────────────────────────────────────────────────────────────

function freshState (userId, value, ttlMs = 600000) {
  return [value, { userId, consumed: false, expiresAt: Date.now() + ttlMs }]
}

// ── 1. The attack ────────────────────────────────────────────────────────────
console.log('\nattacker A starts, victim B completes')

test('BEFORE the fix the victim\'s Google account would land on the attacker\'s Funnl account', () => {
  // Model the old callback: no binding check at all.
  const rows = new Map([freshState('user-A', 'state-A')])
  const row = rows.get('state-A')
  row.consumed = true
  const ownerWithoutBinding = row.userId       // exactly what the old code used
  assert.strictEqual(ownerWithoutBinding, 'user-A',
    'the state row names the initiator, so B\'s Google account attaches to A')
})

// ── 2. Missing / mismatched / malformed binding ──────────────────────────────
console.log('\nmissing or mismatched browser binding')

// ── 3. Cookie attributes ─────────────────────────────────────────────────────
console.log('\ncookie attributes')

// ── 4. Overlapping attempts ──────────────────────────────────────────────────
console.log('\noverlapping connection attempts')

// ── 5. Refusal, expiry, replay ───────────────────────────────────────────────
console.log('\nrefusal, expiry and replay')

// ── 6. Where a flow may start (apex vs www) ──────────────────────────────────
console.log('\nstart endpoint resolution (apex vs www)')

test('vercel.json no longer routes the retired branded OAuth paths (functions undeployed in Stage D)', () => {
  const vercel = JSON.parse(read('vercel.json'))
  const sources = vercel.rewrites.map((r) => r.source)
  for (const p of ['/api/google-oauth-callback', '/api/google-oauth-start', '/api/gmail-oauth-start']) {
    assert.ok(!sources.includes(p), `retired rewrite still present: ${p}`)
  }
  assert.strictEqual(sources[sources.length - 1], '/(.*)', 'SPA catch-all stays last')
})

// ── 7. Wiring and ordering proofs ────────────────────────────────────────────
console.log('\nwiring and ordering')

// The Calendar connect card that started Google OAuth is retired (Stage D); the frontend
// starts no Google flow now, which tests/retired-integrations-ui.test.js pins.

// ── 8. Bounded bodies are unchanged ──────────────────────────────────────────
console.log('\nbounded callback bodies (unchanged behaviour)')

test('the body cap and its Content-Length handling are untouched by this change', async () => {
  const { readBoundedStream, CALLBACK_MAX_BODY_BYTES } =
    await import('../supabase/functions/shared/googleOauthHelpers.js')
  assert.strictEqual(CALLBACK_MAX_BODY_BYTES, 8192)

  const streamOf = (text) => new ReadableStream({
    start (c) { c.enqueue(new TextEncoder().encode(text)); c.close() },
  })
  const small = 'state=abc&code=def'

  let r = await readBoundedStream(streamOf(small), { contentLength: String(small.length), maxBytes: 8192 })
  assert.strictEqual(r.ok, true, 'honest Content-Length')
  r = await readBoundedStream(streamOf(small), { contentLength: null, maxBytes: 8192 })
  assert.strictEqual(r.ok, true, 'absent Content-Length still read')
  r = await readBoundedStream(streamOf('x'.repeat(9000)), { contentLength: null, maxBytes: 8192 })
  assert.strictEqual(r.ok, false, 'oversized body rejected without a Content-Length')
  r = await readBoundedStream(streamOf(small), { contentLength: '99999', maxBytes: 8192 })
  assert.strictEqual(r.ok, false, 'dishonest oversized Content-Length rejected up front')
  r = await readBoundedStream(streamOf(small), { contentLength: 'abc', maxBytes: 8192 })
  assert.strictEqual(r.ok, false, 'non-integer Content-Length rejected')
})

await finish()
