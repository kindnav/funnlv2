// Tests for the request gate used by FunnlAIPage to prevent stale AI requests
// from corrupting conversation state after startNewChat() or a newer send.
//
// The gate is a pure value object with no React, DOM, or Supabase dependencies,
// so these tests run in plain Node.js without any additional framework.
//
// Run with: node tests/ai-chat-request-gate.test.js

import assert from 'assert'
import { createRequestGate } from '../src/lib/ai-chat-request-gate.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗  ${name}`)
    console.log(`       ${e.message}`)
    failed++
  }
}

// ── Token lifecycle ────────────────────────────────────────────────────────────
console.log('\ncreateRequestGate — token lifecycle')

test('a fresh gate has no current token — isCurrent(null) is false', () => {
  const gate = createRequestGate()
  assert.strictEqual(gate.isCurrent(null), false)
})

test('token is current immediately after begin()', () => {
  const gate = createRequestGate()
  const token = gate.begin()
  assert.strictEqual(gate.isCurrent(token), true)
})

test('a second begin() makes the first token stale', () => {
  const gate = createRequestGate()
  const first = gate.begin()
  gate.begin()
  assert.strictEqual(gate.isCurrent(first), false)
})

test('a second begin() returns a token that is current', () => {
  const gate = createRequestGate()
  gate.begin()
  const second = gate.begin()
  assert.strictEqual(gate.isCurrent(second), true)
})

test('invalidate() makes the active token stale', () => {
  const gate = createRequestGate()
  const token = gate.begin()
  gate.invalidate()
  assert.strictEqual(gate.isCurrent(token), false)
})

test('isCurrent returns false for all prior tokens after invalidate()', () => {
  const gate = createRequestGate()
  const t1 = gate.begin()
  const t2 = gate.begin()  // t1 already stale; t2 is active
  gate.invalidate()
  assert.strictEqual(gate.isCurrent(t1), false)
  assert.strictEqual(gate.isCurrent(t2), false)
})

test('a new token after invalidate() is current', () => {
  const gate = createRequestGate()
  gate.begin()
  gate.invalidate()
  const fresh = gate.begin()
  assert.strictEqual(gate.isCurrent(fresh), true)
})

test('isCurrent(null) is always false regardless of gate state', () => {
  const gate = createRequestGate()
  assert.strictEqual(gate.isCurrent(null), false)
  gate.begin()
  assert.strictEqual(gate.isCurrent(null), false)
})

test('each begin() returns a distinct token (Symbols are unique by identity)', () => {
  const gate = createRequestGate()
  const t1 = gate.begin()
  const t2 = gate.begin()
  assert.notStrictEqual(t1, t2)
})

test('two independent gate instances do not share state', () => {
  const gateA = createRequestGate()
  const gateB = createRequestGate()
  const tA = gateA.begin()
  const tB = gateB.begin()
  assert.strictEqual(gateA.isCurrent(tA), true)
  assert.strictEqual(gateB.isCurrent(tB), true)
  gateA.invalidate()
  assert.strictEqual(gateA.isCurrent(tA), false, 'gateA token must be stale')
  assert.strictEqual(gateB.isCurrent(tB), true, 'invalidating gateA must not affect gateB')
})

// ── FunnlAIPage control flow invariants ──────────────────────────────────────
// These tests verify the token-check logic used in sendMessage() and
// retryMessage() without requiring React, DOM, or Supabase.
// FunnlAIPage checks gate.isCurrent(token) before every post-await state
// mutation and before the finally block clears loading.
console.log('\ncreateRequestGate — FunnlAIPage control flow invariants')

test('startNewChat flow: old token stale, new token current — no cross-contamination', () => {
  // Simulates: sendMessage starts (token1), startNewChat called (invalidate),
  // new sendMessage starts (token2). Old request must not mutate the new chat.
  const gate = createRequestGate()
  const oldToken = gate.begin()   // sendMessage1 started
  gate.invalidate()               // startNewChat() — invalidate before reset
  const newToken = gate.begin()   // sendMessage2 started after reset

  assert.strictEqual(gate.isCurrent(oldToken), false, 'old request token must be stale after reset')
  assert.strictEqual(gate.isCurrent(newToken), true,  'new request token must be current')
})

test('stale request must not clear loading for a newer in-flight request', () => {
  // Two requests run; only the current one may call setLoading(false) in finally.
  const gate = createRequestGate()
  const stale  = gate.begin()  // request 1 (in-flight)
  const active = gate.begin()  // request 2 supersedes request 1

  // Request 1 finally block: gate.isCurrent(stale) → false → must skip setLoading(false)
  assert.strictEqual(gate.isCurrent(stale), false,
    'stale request finally block must not clear loading')
  // Request 2 finally block: gate.isCurrent(active) → true → may call setLoading(false)
  assert.strictEqual(gate.isCurrent(active), true,
    'active request finally block must clear loading')
})

test('simulated async flow: stale request cannot mutate messages or analytics after reset', async () => {
  // Simulates the FunnlAIPage post-await pattern for a send→reset→resolve sequence.
  // Each await point in sendMessage/retryMessage calls gate.isCurrent(token) first.
  const gate = createRequestGate()
  let messagesMutated = false
  let analyticsFired   = false
  let loadingCleared   = false

  const token = gate.begin()              // sendMessage started

  gate.invalidate()                        // startNewChat called mid-flight

  // Simulated post-await check (as coded in sendMessage after invoke() resolves):
  if (gate.isCurrent(token)) {
    analyticsFired  = true                // track() call
    messagesMutated = true                // setMessages() call
  }

  // Simulated finally block:
  if (gate.isCurrent(token)) {
    loadingCleared = true                 // setLoading(false) call
  }

  assert.strictEqual(messagesMutated, false, 'stale request must not mutate messages')
  assert.strictEqual(analyticsFired,   false, 'stale request must not fire analytics')
  assert.strictEqual(loadingCleared,   false, 'stale request must not clear loading')
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
