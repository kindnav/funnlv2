// Tests for the frontend conversation helpers.
// Imports directly from the production module — no copied implementations.
//
// Run with: node tests/ai-chat-conversation.test.js

import assert from 'assert'
import { buildProviderMessages, isRetryEligible } from '../src/lib/ai-chat-conversation.js'

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

// ── buildProviderMessages ──────────────────────────────────────────────────────
console.log('\nbuildProviderMessages')

test('returns an empty array for empty input', () => {
  assert.deepStrictEqual(buildProviderMessages([]), [])
})

test('returns an empty array for non-array input', () => {
  assert.deepStrictEqual(buildProviderMessages(null), [])
  assert.deepStrictEqual(buildProviderMessages(undefined), [])
  assert.deepStrictEqual(buildProviderMessages('string'), [])
})

test('excludes messages with localOnly: true', () => {
  const msgs = [
    { role: 'assistant', content: 'Welcome greeting', localOnly: true },
    { role: 'user', content: 'Hello' },
  ]
  const result = buildProviderMessages(msgs)
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].role, 'user')
  assert.strictEqual(result[0].content, 'Hello')
})

test('excludes INITIAL_MESSAGE-style assistant greeting when localOnly: true', () => {
  const INITIAL_MESSAGE = {
    role: 'assistant',
    content: "Your network is loaded. Ask me anything.",
    localOnly: true,
  }
  const msgs = [INITIAL_MESSAGE, { role: 'user', content: 'Who should I follow up with?' }]
  const result = buildProviderMessages(msgs)
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].content, 'Who should I follow up with?')
})

test('excludes messages with an error field (failed turns)', () => {
  const msgs = [
    { role: 'user', content: 'Failed prompt', error: { code: 'internal_error', message: 'Oops', retryable: true, request_id: null } },
  ]
  const result = buildProviderMessages(msgs)
  assert.strictEqual(result.length, 0)
})

test('includes messages with neither localOnly nor error', () => {
  const msgs = [
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: 'Answer' },
  ]
  const result = buildProviderMessages(msgs)
  assert.strictEqual(result.length, 2)
})

test('strips non-provider fields (localOnly, error, truncated) from output', () => {
  const msgs = [
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: 'Answer', truncated: true },
  ]
  const result = buildProviderMessages(msgs)
  assert.ok(!('truncated' in result[1]), 'truncated field should not be in provider message')
  assert.ok(!('localOnly' in result[0]), 'localOnly field should not be in provider message')
})

test('preserves correct role order for a multi-turn conversation', () => {
  const msgs = [
    { role: 'assistant', content: 'Greeting', localOnly: true },
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2' },
  ]
  const result = buildProviderMessages(msgs)
  assert.strictEqual(result.length, 3)
  assert.strictEqual(result[0].role, 'user')
  assert.strictEqual(result[1].role, 'assistant')
  assert.strictEqual(result[2].role, 'user')
})

test('handles a mix of excluded and included messages correctly', () => {
  const msgs = [
    { role: 'assistant', content: 'Greeting', localOnly: true },
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'First answer' },
    { role: 'user', content: 'Failed retry', error: { code: 'internal_error', message: 'Err', retryable: true, request_id: null } },
    { role: 'user', content: 'Successful question' },
    { role: 'assistant', content: 'Final answer' },
    { role: 'user', content: 'New question' },
  ]
  const result = buildProviderMessages(msgs)
  // Should include: Q1, A1, Successful question (error'd Q skipped), Final answer, New question
  assert.strictEqual(result.length, 5)
  assert.ok(!result.some(m => m.content === 'Failed retry'))
  assert.ok(!result.some(m => m.content === 'Greeting'))
})

// ── isRetryEligible ────────────────────────────────────────────────────────────
console.log('\nisRetryEligible')

test('returns false for non-array messages', () => {
  assert.strictEqual(isRetryEligible(null, 0), false)
  assert.strictEqual(isRetryEligible('string', 0), false)
  assert.strictEqual(isRetryEligible(undefined, 0), false)
})

test('returns false for negative index', () => {
  const msgs = [{ role: 'user', content: 'Q', error: { code: 'internal_error', message: 'Err', retryable: true, request_id: null } }]
  assert.strictEqual(isRetryEligible(msgs, -1), false)
})

test('returns false for out-of-bounds index', () => {
  const msgs = [{ role: 'user', content: 'Q', error: { code: 'internal_error', message: 'Err', retryable: true, request_id: null } }]
  assert.strictEqual(isRetryEligible(msgs, 5), false)
})

test('returns false when the message at index has no error field', () => {
  const msgs = [
    { role: 'user', content: 'Q' },
    { role: 'assistant', content: 'A' },
    { role: 'user', content: 'Q2' },
  ]
  assert.strictEqual(isRetryEligible(msgs, 2), false)
})

test('returns false when the message at index is from assistant role', () => {
  const msgs = [
    { role: 'user', content: 'Q' },
    { role: 'assistant', content: 'A', error: { code: 'internal_error', message: 'Err', retryable: true, request_id: null } },
  ]
  assert.strictEqual(isRetryEligible(msgs, 1), false)
})

test('returns true when failed user message is the last in the array', () => {
  const error = { code: 'internal_error', message: 'Err', retryable: true, request_id: null }
  const msgs = [
    { role: 'user', content: 'Previous question' },
    { role: 'assistant', content: 'Previous answer' },
    { role: 'user', content: 'Failed question', error },
  ]
  assert.strictEqual(isRetryEligible(msgs, 2), true)
})

test('returns true for a single failed user message at index 0', () => {
  const error = { code: 'provider_timeout', message: 'Timed out', retryable: true, request_id: null }
  const msgs = [{ role: 'user', content: 'Question', error }]
  assert.strictEqual(isRetryEligible(msgs, 0), true)
})

test('returns false when failed message is NOT the last (a later successful turn exists)', () => {
  // This is the key ordering guard: a failure in the middle must not be retried
  // because the retry would send out-of-order context (later successful turns already exist).
  const error = { code: 'internal_error', message: 'Err', retryable: true, request_id: null }
  const msgs = [
    { role: 'user', content: 'Q1', error },            // index 0 — failed but NOT last
    { role: 'user', content: 'Q2 (later successful)' }, // index 1 — later turn exists
    { role: 'assistant', content: 'A2' },
    { role: 'user', content: 'Q3' },
  ]
  assert.strictEqual(isRetryEligible(msgs, 0), false)
})

test('returns false for a failed message followed only by non-user messages', () => {
  // A failed user message at index N-2 when index N-1 is assistant — still not last
  const error = { code: 'network_data_failed', message: 'Network err', retryable: true, request_id: null }
  const msgs = [
    { role: 'user', content: 'Q', error },
    { role: 'assistant', content: 'A' },  // added after the failure
  ]
  assert.strictEqual(isRetryEligible(msgs, 0), false)
})

test('retry eligibility updates correctly after a new successful exchange follows the failure', () => {
  // Scenario: user sends Q2, it fails. isRetryEligible → true.
  // Then user sends Q3 successfully (after dismissing Q2 error or new send).
  // Now the failed Q2 is no longer last → isRetryEligible → false.
  const error = { code: 'internal_error', message: 'Err', retryable: true, request_id: null }
  const msgsBeforeNewTurn = [
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2', error },  // failed, currently last
  ]
  assert.strictEqual(isRetryEligible(msgsBeforeNewTurn, 2), true)

  // After Q3 is sent and answered successfully
  const msgsAfterNewTurn = [
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2', error },  // still failed, but no longer last
    { role: 'user', content: 'Q3' },
    { role: 'assistant', content: 'A3' },
    { role: 'user', content: 'Q4' },
  ]
  assert.strictEqual(isRetryEligible(msgsAfterNewTurn, 2), false)
})

test('INITIAL_MESSAGE-style localOnly message at index 0 is not retry-eligible', () => {
  const msgs = [
    { role: 'assistant', content: 'Greeting', localOnly: true },
  ]
  // No error field → false (correct — it's not a failed user turn)
  assert.strictEqual(isRetryEligible(msgs, 0), false)
})

// ── isRetryEligible — retryable flag enforcement ──────────────────────────────
console.log('\nisRetryEligible — retryable flag enforcement')

test('returns false for invalid_request (retryable: false) — resending is futile', () => {
  const error = { code: 'invalid_request', message: 'History error', retryable: false, request_id: null }
  const msgs = [{ role: 'user', content: 'Q', error }]
  assert.strictEqual(isRetryEligible(msgs, 0), false)
})

test('returns false for prompt_too_long (retryable: false)', () => {
  const error = { code: 'prompt_too_long', message: 'Too long', retryable: false, request_id: null }
  const msgs = [{ role: 'user', content: 'Q', error }]
  assert.strictEqual(isRetryEligible(msgs, 0), false)
})

test('returns false for pro_required (retryable: false)', () => {
  const error = { code: 'pro_required', message: 'Pro only', retryable: false, request_id: null }
  const msgs = [{ role: 'user', content: 'Q', error }]
  assert.strictEqual(isRetryEligible(msgs, 0), false)
})

test('returns false for context_too_large (retryable: false)', () => {
  const error = { code: 'context_too_large', message: 'Too large', retryable: false, request_id: null }
  const msgs = [{ role: 'user', content: 'Q', error }]
  assert.strictEqual(isRetryEligible(msgs, 0), false)
})

test('returns true for provider_timeout (retryable: true) on the last message', () => {
  const error = { code: 'provider_timeout', message: 'Timed out', retryable: true, request_id: 'abc' }
  const msgs = [
    { role: 'user',      content: 'Q1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user',      content: 'Q2', error },
  ]
  assert.strictEqual(isRetryEligible(msgs, 2), true)
})

test('returns true for internal_error (retryable: true) on the last message', () => {
  const error = { code: 'internal_error', message: 'Error', retryable: true, request_id: null }
  const msgs = [{ role: 'user', content: 'Q', error }]
  assert.strictEqual(isRetryEligible(msgs, 0), true)
})

test('returns false for retryable error that is NOT the last message', () => {
  const error = { code: 'provider_timeout', message: 'Timed out', retryable: true, request_id: null }
  const msgs = [
    { role: 'user',      content: 'Q1', error },
    { role: 'user',      content: 'Q2' },
    { role: 'assistant', content: 'A2' },
    { role: 'user',      content: 'Q3' },
  ]
  assert.strictEqual(isRetryEligible(msgs, 0), false)
})

// ── Backward compatibility: new frontend + old Edge Function ───────────────────
// When the old Edge Function is deployed, the new frontend must not break.
// The key invariant: buildProviderMessages always produces user-first provider messages
// because INITIAL_MESSAGE has localOnly: true and is therefore never sent to the Edge Function.
console.log('\nbuildProviderMessages — backward compat: new frontend + old Edge Function')

test('provider messages always start with user role when INITIAL_MESSAGE is localOnly (compatible with old Edge Function)', () => {
  // Old Edge Function accepted user-first message sequences (always did).
  // New frontend marks INITIAL_MESSAGE localOnly → buildProviderMessages filters it.
  // Result: first provider message is always from user → compatible with both old and new Edge Function.
  const msgs = [
    { role: 'assistant', content: 'Your network is loaded. Ask me anything.', localOnly: true },
    { role: 'user', content: 'Who should I follow up with?' },
    { role: 'assistant', content: 'You should follow up with...' },
    { role: 'user', content: 'Thanks!' },
  ]
  const result = buildProviderMessages(msgs)
  assert.ok(result.length > 0, 'should produce at least one message')
  assert.strictEqual(result[0].role, 'user', 'first provider message must be user (old Edge Function requirement)')
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
