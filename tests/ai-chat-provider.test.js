// Tests for providerCall.js — retry decision logic and safe diagnostic log builders.
// Pure JavaScript, no async, no mocking required.
//
// Run with: node tests/ai-chat-provider.test.js

import assert from 'assert'
import {
  MODEL,
  PRIMARY_MAX_TOKENS, PRIMARY_THINKING, PRIMARY_EFFORT,
  FALLBACK_MAX_TOKENS, FALLBACK_THINKING, FALLBACK_EFFORT,
  PROVIDER_TIMEOUT_MS,
  shouldRetryForBlankReply,
  buildAttemptLog,
  buildRequestSummaryLog,
} from '../supabase/functions/ai-chat/providerCall.js'

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

// ── Constants sanity checks ────────────────────────────────────────────────────
console.log('\nconstants')

test('MODEL is claude-sonnet-5', () => {
  assert.strictEqual(MODEL, 'claude-sonnet-5')
})

test('PRIMARY_MAX_TOKENS is 8192', () => {
  assert.strictEqual(PRIMARY_MAX_TOKENS, 8192)
})

test('PRIMARY_THINKING is adaptive', () => {
  assert.deepStrictEqual(PRIMARY_THINKING, { type: 'adaptive' })
})

test('PRIMARY_EFFORT is medium', () => {
  assert.strictEqual(PRIMARY_EFFORT, 'medium')
})

test('FALLBACK_MAX_TOKENS is 4096', () => {
  assert.strictEqual(FALLBACK_MAX_TOKENS, 4096)
})

test('FALLBACK_THINKING is disabled', () => {
  assert.deepStrictEqual(FALLBACK_THINKING, { type: 'disabled' })
})

test('FALLBACK_EFFORT is high', () => {
  assert.strictEqual(FALLBACK_EFFORT, 'high')
})

test('PROVIDER_TIMEOUT_MS is 60000 (single deadline for both attempts)', () => {
  assert.strictEqual(PROVIDER_TIMEOUT_MS, 60_000)
})

// ── shouldRetryForBlankReply — success paths (must NOT retry) ──────────────────
console.log('\nshouldRetryForBlankReply — success paths (must not retry)')

test('returns false when parseError is null (reply was present — success path)', () => {
  // parseError is null whenever parseProviderResponse found visible text.
  // This function should never be called on success, but returns false defensively.
  assert.strictEqual(shouldRetryForBlankReply(200, null, 'end_turn', ['text']), false)
})

test('returns false when parseError is not empty_provider_response (different error)', () => {
  // Only empty_provider_response blank-reply failures are eligible for retry.
  assert.strictEqual(shouldRetryForBlankReply(200, 'some_other_error', 'max_tokens', []), false)
})

test('returns false for a refusal that produced a text block', () => {
  // A model refusal produces a text block with the refusal message.
  // parseProviderResponse returns that text as reply (parseError = null).
  // shouldRetryForBlankReply is never called; this tests the null guard explicitly.
  assert.strictEqual(shouldRetryForBlankReply(200, null, 'end_turn', ['text']), false)
})

// ── shouldRetryForBlankReply — non-200 provider status (must NOT retry) ────────
console.log('\nshouldRetryForBlankReply — non-200 provider status (must not retry)')

test('returns false for HTTP 429 (rate limited)', () => {
  assert.strictEqual(shouldRetryForBlankReply(429, 'empty_provider_response', null, []), false)
})

test('returns false for HTTP 529 (overloaded)', () => {
  assert.strictEqual(shouldRetryForBlankReply(529, 'empty_provider_response', null, []), false)
})

test('returns false for HTTP 500 (server error)', () => {
  assert.strictEqual(shouldRetryForBlankReply(500, 'empty_provider_response', null, []), false)
})

test('returns false for HTTP 503 (unavailable)', () => {
  assert.strictEqual(shouldRetryForBlankReply(503, 'empty_provider_response', null, []), false)
})

// ── shouldRetryForBlankReply — conditions that warrant retry ──────────────────
console.log('\nshouldRetryForBlankReply — blank-reply conditions that warrant retry')

test('returns true when stop_reason is max_tokens (budget exhausted — most common failure)', () => {
  // Primary cause of the complex-prompt failure: max_tokens too small →
  // thinking consumed entire budget → no visible text.
  assert.strictEqual(shouldRetryForBlankReply(200, 'empty_provider_response', 'max_tokens', ['thinking']), true)
})

test('returns true for empty content array (nothing produced)', () => {
  // Edge case: model returned HTTP 200 with content: [].
  assert.strictEqual(shouldRetryForBlankReply(200, 'empty_provider_response', 'end_turn', []), true)
})

test('returns true when all blocks are thinking type', () => {
  // Thinking-only response: model finished reasoning but emitted no visible text.
  assert.strictEqual(shouldRetryForBlankReply(200, 'empty_provider_response', 'end_turn', ['thinking']), true)
})

test('returns true when all blocks are redacted_thinking type', () => {
  // Redacted thinking — model may suppress its thinking block in some contexts.
  assert.strictEqual(shouldRetryForBlankReply(200, 'empty_provider_response', 'end_turn', ['redacted_thinking']), true)
})

test('returns true when all blocks are mixed thinking and redacted_thinking', () => {
  assert.strictEqual(
    shouldRetryForBlankReply(200, 'empty_provider_response', 'end_turn', ['thinking', 'redacted_thinking', 'thinking']),
    true
  )
})

test('returns true for empty content with max_tokens stop reason', () => {
  // Doubly confident: both the stop reason and empty content point to budget exhaustion.
  assert.strictEqual(shouldRetryForBlankReply(200, 'empty_provider_response', 'max_tokens', []), true)
})

// ── shouldRetryForBlankReply — thinking+text does not reach this function ───────
console.log('\nshouldRetryForBlankReply — thinking+text is handled by parseProviderResponse, not here')

test('returns false for thinking+text content (text is present — parseError should have been null)', () => {
  // When both thinking AND text blocks exist, parseProviderResponse extracts the text.
  // parseError is null, so shouldRetryForBlankReply is not called by the production code.
  // This test confirms the defensive return-false path works for this input:
  assert.strictEqual(shouldRetryForBlankReply(200, null, 'end_turn', ['thinking', 'text']), false)
})

test('null/undefined contentBlockTypes does not throw and is treated as empty (retry condition)', () => {
  // null and undefined contentBlockTypes coerce to [] inside the function.
  // An empty types array = no content blocks produced = same retry condition as [].
  // stop_reason 'end_turn' + empty content → returns true (retry).
  assert.strictEqual(shouldRetryForBlankReply(200, 'empty_provider_response', 'end_turn', null), true)
  assert.strictEqual(shouldRetryForBlankReply(200, 'empty_provider_response', 'end_turn', undefined), true)
})

test('returns true for null contentBlockTypes when stop_reason is max_tokens', () => {
  // stop_reason check fires before the array check, so max_tokens wins.
  assert.strictEqual(shouldRetryForBlankReply(200, 'empty_provider_response', 'max_tokens', null), true)
})

// ── buildAttemptLog — structure and field safety ───────────────────────────────
console.log('\nbuildAttemptLog — structure and field safety')

const ATTEMPT_PARAMS = {
  requestId: 'req-abc',
  attempt: 1,
  model: 'claude-sonnet-5',
  max_tokens: 8192,
  thinking_mode: 'adaptive',
  effort: 'medium',
  providerStatus: 200,
  providerRequestId: 'ap-xyz',
  stop_reason: 'max_tokens',
  contentBlockTypes: ['thinking'],
  usage: { input_tokens: 5000, output_tokens: 0 },
  durationMs: 1234,
  contextPass: 1,
  replyPresent: false,
}

test('returns an object with event field ai_chat_provider_attempt', () => {
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  assert.strictEqual(log.event, 'ai_chat_provider_attempt')
})

test('includes request_id in log output', () => {
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  assert.strictEqual(log.request_id, 'req-abc')
})

test('includes attempt number in log output', () => {
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  assert.strictEqual(log.attempt, 1)
})

test('includes model identifier in log output', () => {
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  assert.strictEqual(log.model, 'claude-sonnet-5')
})

test('includes max_tokens in log output', () => {
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  assert.strictEqual(log.max_tokens, 8192)
})

test('includes thinking_mode in log output', () => {
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  assert.strictEqual(log.thinking_mode, 'adaptive')
})

test('includes effort in log output', () => {
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  assert.strictEqual(log.effort, 'medium')
})

test('includes provider_status in log output', () => {
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  assert.strictEqual(log.provider_status, 200)
})

test('includes stop_reason in log output', () => {
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  assert.strictEqual(log.stop_reason, 'max_tokens')
})

test('includes content_block_types array in log output', () => {
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  assert.deepStrictEqual(log.content_block_types, ['thinking'])
})

test('includes input_tokens from usage object', () => {
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  assert.strictEqual(log.input_tokens, 5000)
})

test('includes output_tokens from usage object', () => {
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  assert.strictEqual(log.output_tokens, 0)
})

test('includes duration_ms in log output', () => {
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  assert.strictEqual(log.duration_ms, 1234)
})

test('includes context_pass in log output', () => {
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  assert.strictEqual(log.context_pass, 1)
})

test('reply_present is false when no text was returned', () => {
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  assert.strictEqual(log.reply_present, false)
})

test('reply_present is true when reply was present', () => {
  const log = buildAttemptLog({ ...ATTEMPT_PARAMS, replyPresent: true })
  assert.strictEqual(log.reply_present, true)
})

test('handles null/undefined values gracefully without throwing', () => {
  assert.doesNotThrow(() => buildAttemptLog({
    requestId: null, attempt: null, model: null, max_tokens: null,
    thinking_mode: null, effort: null, providerStatus: null, providerRequestId: null,
    stop_reason: null, contentBlockTypes: null, usage: null,
    durationMs: null, contextPass: null, replyPresent: null,
  }))
})

test('null usage produces null token counts', () => {
  const log = buildAttemptLog({ ...ATTEMPT_PARAMS, usage: null })
  assert.strictEqual(log.input_tokens, null)
  assert.strictEqual(log.output_tokens, null)
  assert.strictEqual(log.cache_creation_input_tokens, null)
  assert.strictEqual(log.cache_read_input_tokens, null)
})

test('non-array contentBlockTypes produces empty array in output', () => {
  const log = buildAttemptLog({ ...ATTEMPT_PARAMS, contentBlockTypes: null })
  assert.deepStrictEqual(log.content_block_types, [])
})

test('non-numeric providerStatus produces null in output', () => {
  const log = buildAttemptLog({ ...ATTEMPT_PARAMS, providerStatus: 'not-a-number' })
  assert.strictEqual(log.provider_status, null)
})

test('log does not contain any field named prompt, text, notes, or email', () => {
  // Structural check: the log object must not have fields that could carry user data.
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  const keys = Object.keys(log)
  assert.ok(!keys.includes('prompt'), 'log must not include prompt field')
  assert.ok(!keys.includes('system'), 'log must not include system field')
  assert.ok(!keys.includes('text'), 'log must not include text field')
  assert.ok(!keys.includes('notes'), 'log must not include notes field')
  assert.ok(!keys.includes('email'), 'log must not include email field')
  assert.ok(!keys.includes('name'), 'log must not include name field')
  assert.ok(!keys.includes('company'), 'log must not include company field')
  assert.ok(!keys.includes('reply'), 'log must not include reply (response text) field')
})

test('cache token counts are included when usage provides them', () => {
  const log = buildAttemptLog({
    ...ATTEMPT_PARAMS,
    usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 25 },
  })
  assert.strictEqual(log.cache_creation_input_tokens, 50)
  assert.strictEqual(log.cache_read_input_tokens, 25)
})

// ── buildRequestSummaryLog — structure and field safety ────────────────────────
console.log('\nbuildRequestSummaryLog — structure and field safety')

test('returns an object with event field ai_chat_request_complete', () => {
  const log = buildRequestSummaryLog({
    requestId: 'req-1', success: true, attempts: 1, finalErrorCode: null, totalDurationMs: 3000,
  })
  assert.strictEqual(log.event, 'ai_chat_request_complete')
})

test('success is true when the request completed with a reply', () => {
  const log = buildRequestSummaryLog({
    requestId: 'req-1', success: true, attempts: 1, finalErrorCode: null, totalDurationMs: 3000,
  })
  assert.strictEqual(log.success, true)
})

test('success is false when both attempts failed', () => {
  const log = buildRequestSummaryLog({
    requestId: 'req-1', success: false, attempts: 2, finalErrorCode: 'empty_provider_response', totalDurationMs: 60000,
  })
  assert.strictEqual(log.success, false)
})

test('attempts is 1 when primary succeeded (no retry needed)', () => {
  const log = buildRequestSummaryLog({
    requestId: 'req-1', success: true, attempts: 1, finalErrorCode: null, totalDurationMs: 2000,
  })
  assert.strictEqual(log.attempts, 1)
})

test('attempts is 2 when fallback was triggered', () => {
  const log = buildRequestSummaryLog({
    requestId: 'req-1', success: true, attempts: 2, finalErrorCode: null, totalDurationMs: 5000,
  })
  assert.strictEqual(log.attempts, 2)
})

test('final_error_code is null on success', () => {
  const log = buildRequestSummaryLog({
    requestId: 'req-1', success: true, attempts: 1, finalErrorCode: null, totalDurationMs: 2000,
  })
  assert.strictEqual(log.final_error_code, null)
})

test('final_error_code is the error code string on failure', () => {
  const log = buildRequestSummaryLog({
    requestId: 'req-1', success: false, attempts: 2, finalErrorCode: 'provider_timeout', totalDurationMs: 60000,
  })
  assert.strictEqual(log.final_error_code, 'provider_timeout')
})

test('includes total_duration_ms in log output', () => {
  const log = buildRequestSummaryLog({
    requestId: 'req-1', success: true, attempts: 1, finalErrorCode: null, totalDurationMs: 4567,
  })
  assert.strictEqual(log.total_duration_ms, 4567)
})

test('handles null values gracefully without throwing', () => {
  assert.doesNotThrow(() => buildRequestSummaryLog({
    requestId: null, success: null, attempts: null, finalErrorCode: null, totalDurationMs: null,
  }))
})

test('success is false when null is passed (falsy guard)', () => {
  const log = buildRequestSummaryLog({
    requestId: null, success: null, attempts: null, finalErrorCode: null, totalDurationMs: null,
  })
  assert.strictEqual(log.success, false)
})

test('log does not contain any field that could carry user data', () => {
  const log = buildRequestSummaryLog({
    requestId: 'req-1', success: false, attempts: 2, finalErrorCode: 'empty_provider_response', totalDurationMs: 60000,
  })
  const keys = Object.keys(log)
  assert.ok(!keys.includes('prompt'), 'log must not include prompt field')
  assert.ok(!keys.includes('reply'), 'log must not include reply field')
  assert.ok(!keys.includes('context'), 'log must not include context (network data) field')
  assert.ok(!keys.includes('messages'), 'log must not include messages field')
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
