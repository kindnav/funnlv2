/**
 * Tests for supabase/functions/stripe-webhook/verifyStripeSignature.js
 *
 * Generates REAL HMAC-SHA256 signatures with node:crypto and verifies them through
 * the production helper (which uses crypto.subtle.verify). The clock is injected so
 * replay-window assertions are deterministic.
 *
 * Zero external deps — runs with: node tests/verify-stripe-signature.test.js
 */
import crypto from 'node:crypto'
import { verifyStripeSignature, DEFAULT_TOLERANCE_SECONDS } from '../supabase/functions/stripe-webhook/verifyStripeSignature.js'

let passed = 0
let failed = 0
const RUN = []
function test(name, fn) { RUN.push({ name, fn }) }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const SECRET = 'whsec_test_secret_key_abc123'
const BODY   = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated', created: 1_700_000_000 })

// Fixed "current time" for deterministic replay-window tests.
const NOW = 1_700_000_100
const nowFn = () => NOW

// Produce a real hex HMAC-SHA256 over `${timestamp}.${body}`.
function hmacHex(body, secret, timestamp) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}
function header(timestamp, sig) {
  return `t=${timestamp},v1=${sig}`
}

async function run() {
  // ── valid ─────────────────────────────────────────────────────────────────
  test('valid signature at a recent timestamp → true', async () => {
    const ts  = NOW - 10
    const sig = hmacHex(BODY, SECRET, ts)
    assertEqual(await verifyStripeSignature(BODY, header(ts, sig), SECRET, { now: nowFn }), true)
  })

  // ── invalid signature (wrong secret) ───────────────────────────────────────
  test('signature computed with the wrong secret → false', async () => {
    const ts  = NOW - 10
    const sig = hmacHex(BODY, 'whsec_WRONG', ts)
    assertEqual(await verifyStripeSignature(BODY, header(ts, sig), SECRET, { now: nowFn }), false)
  })

  // ── modified body ──────────────────────────────────────────────────────────
  test('body modified after signing → false', async () => {
    const ts  = NOW - 10
    const sig = hmacHex(BODY, SECRET, ts)
    const tampered = BODY.replace('updated', 'deleted')
    assertEqual(await verifyStripeSignature(tampered, header(ts, sig), SECRET, { now: nowFn }), false)
  })

  // ── malformed hex (non-hex characters) ─────────────────────────────────────
  test('non-hex v1 signature → false', async () => {
    const ts = NOW - 10
    assertEqual(await verifyStripeSignature(BODY, header(ts, 'zzzz not hex zzzz'), SECRET, { now: nowFn }), false)
  })

  // ── odd-length hex ──────────────────────────────────────────────────────────
  test('odd-length hex v1 signature → false', async () => {
    const ts  = NOW - 10
    const sig = hmacHex(BODY, SECRET, ts).slice(0, 63) // 63 chars = odd length
    assertEqual(await verifyStripeSignature(BODY, header(ts, sig), SECRET, { now: nowFn }), false)
  })

  // ── missing timestamp ───────────────────────────────────────────────────────
  test('header without t= → false', async () => {
    const ts  = NOW - 10
    const sig = hmacHex(BODY, SECRET, ts)
    assertEqual(await verifyStripeSignature(BODY, `v1=${sig}`, SECRET, { now: nowFn }), false)
  })

  test('header with non-numeric timestamp → false', async () => {
    const ts  = NOW - 10
    const sig = hmacHex(BODY, SECRET, ts)
    assertEqual(await verifyStripeSignature(BODY, `t=notanumber,v1=${sig}`, SECRET, { now: nowFn }), false)
  })

  // ── missing v1 signature ─────────────────────────────────────────────────────
  test('header without any v1= → false', async () => {
    assertEqual(await verifyStripeSignature(BODY, `t=${NOW - 10}`, SECRET, { now: nowFn }), false)
  })

  // ── multiple v1 where one is valid (key rotation) ──────────────────────────
  test('multiple v1 signatures, one valid → true', async () => {
    const ts    = NOW - 10
    const good  = hmacHex(BODY, SECRET, ts)
    const bad   = hmacHex(BODY, 'whsec_OTHER', ts)
    const hdr   = `t=${ts},v1=${bad},v1=${good}`
    assertEqual(await verifyStripeSignature(BODY, hdr, SECRET, { now: nowFn }), true)
  })

  test('multiple v1 signatures, none valid → false', async () => {
    const ts   = NOW - 10
    const bad1 = hmacHex(BODY, 'whsec_A', ts)
    const bad2 = hmacHex(BODY, 'whsec_B', ts)
    assertEqual(await verifyStripeSignature(BODY, `t=${ts},v1=${bad1},v1=${bad2}`, SECRET, { now: nowFn }), false)
  })

  // ── replay window ────────────────────────────────────────────────────────────
  test('timestamp too old (beyond tolerance) → false', async () => {
    const ts  = NOW - (DEFAULT_TOLERANCE_SECONDS + 1)
    const sig = hmacHex(BODY, SECRET, ts)
    assertEqual(await verifyStripeSignature(BODY, header(ts, sig), SECRET, { now: nowFn }), false)
  })

  test('timestamp too far in the future (beyond tolerance) → false', async () => {
    const ts  = NOW + (DEFAULT_TOLERANCE_SECONDS + 1)
    const sig = hmacHex(BODY, SECRET, ts)
    assertEqual(await verifyStripeSignature(BODY, header(ts, sig), SECRET, { now: nowFn }), false)
  })

  test('timestamp exactly at tolerance boundary (past) → true', async () => {
    const ts  = NOW - DEFAULT_TOLERANCE_SECONDS
    const sig = hmacHex(BODY, SECRET, ts)
    assertEqual(await verifyStripeSignature(BODY, header(ts, sig), SECRET, { now: nowFn }), true)
  })

  test('timestamp exactly at tolerance boundary (future) → true', async () => {
    const ts  = NOW + DEFAULT_TOLERANCE_SECONDS
    const sig = hmacHex(BODY, SECRET, ts)
    assertEqual(await verifyStripeSignature(BODY, header(ts, sig), SECRET, { now: nowFn }), true)
  })

  test('custom tolerance shrinks the accepted window', async () => {
    const ts  = NOW - 100
    const sig = hmacHex(BODY, SECRET, ts)
    assertEqual(await verifyStripeSignature(BODY, header(ts, sig), SECRET, { now: nowFn, tolerance: 50 }), false)
    assertEqual(await verifyStripeSignature(BODY, header(ts, sig), SECRET, { now: nowFn, tolerance: 200 }), true)
  })

  // ── input guards ─────────────────────────────────────────────────────────────
  test('empty secret → false', async () => {
    const ts  = NOW - 10
    const sig = hmacHex(BODY, SECRET, ts)
    assertEqual(await verifyStripeSignature(BODY, header(ts, sig), '', { now: nowFn }), false)
  })

  test('non-string body → false', async () => {
    assertEqual(await verifyStripeSignature(null, `t=${NOW},v1=abc`, SECRET, { now: nowFn }), false)
  })

  test('non-string sigHeader → false', async () => {
    assertEqual(await verifyStripeSignature(BODY, null, SECRET, { now: nowFn }), false)
  })

  test('empty v1 value → false', async () => {
    assertEqual(await verifyStripeSignature(BODY, `t=${NOW},v1=`, SECRET, { now: nowFn }), false)
  })

  test('injected clock is actually used (same sig differs by clock)', async () => {
    const ts  = 1_700_000_000
    const sig = hmacHex(BODY, SECRET, ts)
    const hdr = header(ts, sig)
    // Clock near the timestamp → within window → true
    assertEqual(await verifyStripeSignature(BODY, hdr, SECRET, { now: () => ts + 5 }), true)
    // Clock far from the timestamp → outside window → false
    assertEqual(await verifyStripeSignature(BODY, hdr, SECRET, { now: () => ts + 10_000 }), false)
  })

  // Execute queued tests sequentially.
  for (const { name, fn } of RUN) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++ }
    catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
  }
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

run()
