// Tests for providerCall.js — constants, retry decision, safe diagnostic log
// builders, and the real provider-attempt orchestration (runProviderAttempts).
//
// The orchestration tests inject fetchImpl, now, makeSignalFn, logAttempt, and
// logSummary so the full control flow runs without real HTTP or system timers.
// parseProviderResponse runs on the mock response bodies — no mocking of it.
//
// Run with: node tests/ai-chat-provider.test.js

import assert from 'assert'
import {
  MODEL,
  PRIMARY_MAX_TOKENS, PRIMARY_THINKING, PRIMARY_EFFORT,
  FALLBACK_MAX_TOKENS, FALLBACK_THINKING, FALLBACK_EFFORT,
  OVERALL_TIMEOUT_MS, PRIMARY_ATTEMPT_TIMEOUT_MS, MIN_FALLBACK_TIME_MS,
  shouldRetryForBlankReply,
  buildAttemptLog,
  buildRequestSummaryLog,
  makeSignal,
  runProviderAttempts,
} from '../supabase/functions/ai-chat/providerCall.js'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗  ${name}`)
    console.log(`       ${e.message}`)
    failed++
  }
}

// ── Test infrastructure helpers ────────────────────────────────────────────────

// Builds a minimal duck-typed Response compatible with runProviderAttempts.
function makeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => h === 'x-request-id' ? 'mock-x-req-id' : null },
    json: async () => body,
  }
}

// Builds an Anthropic API response body.
function providerBody(content, stop_reason = 'end_turn', usage = { input_tokens: 100, output_tokens: 50 }) {
  return { content, stop_reason, usage }
}

const textBlock  = (text)     => ({ type: 'text', text })
const thinkBlock = (thinking) => ({ type: 'thinking', thinking })

// Creates a fetchImpl that returns different responses on successive calls.
function sequentialFetch(...responses) {
  let callCount = 0
  const calls = []
  const impl = async (url, opts) => {
    if (opts?.signal?.aborted) {
      const e = new Error('The operation was aborted')
      e.name = 'AbortError'
      throw e
    }
    const res = responses[callCount] ?? responses[responses.length - 1]
    callCount++
    calls.push({ url, opts })
    return typeof res === 'function' ? await res() : res
  }
  impl.callCount = () => callCount
  impl.calls = calls
  return impl
}

// Shared minimal args for runProviderAttempts.
const BASE_ARGS = {
  systemPrompt: 'SYSTEM_PROMPT_TEXT',
  messages: [{ role: 'user', content: 'Who should I follow up with?' }],
  requestId: 'req-test-1',
  passUsed: 1,
  requestStart: 0,
  anthropicApiKey: 'test-key',
}

// ── Constants sanity checks ────────────────────────────────────────────────────
console.log('\nconstants')

await test('MODEL is claude-sonnet-5', () => {
  assert.strictEqual(MODEL, 'claude-sonnet-5')
})

await test('PRIMARY_MAX_TOKENS is 4096 (reliability-first: no thinking budget to share)', () => {
  assert.strictEqual(PRIMARY_MAX_TOKENS, 4096)
})

await test('PRIMARY_THINKING disables adaptive thinking for predictable output', () => {
  assert.deepStrictEqual(PRIMARY_THINKING, { type: 'disabled' })
})

await test('PRIMARY_EFFORT is high (full quality on primary attempt)', () => {
  assert.strictEqual(PRIMARY_EFFORT, 'high')
})

await test('FALLBACK_MAX_TOKENS is 4096', () => {
  assert.strictEqual(FALLBACK_MAX_TOKENS, 4096)
})

await test('FALLBACK_THINKING is disabled (no hidden thinking on fallback either)', () => {
  assert.deepStrictEqual(FALLBACK_THINKING, { type: 'disabled' })
})

await test('FALLBACK_EFFORT is medium (different execution path from primary)', () => {
  assert.strictEqual(FALLBACK_EFFORT, 'medium')
})

await test('OVERALL_TIMEOUT_MS is 60000 (hard cap for the entire request)', () => {
  assert.strictEqual(OVERALL_TIMEOUT_MS, 60_000)
})

await test('PRIMARY_ATTEMPT_TIMEOUT_MS is 45000 (per-attempt abort deadline)', () => {
  assert.strictEqual(PRIMARY_ATTEMPT_TIMEOUT_MS, 45_000)
})

await test('MIN_FALLBACK_TIME_MS is 10000 (minimum remaining time to start a fallback)', () => {
  assert.strictEqual(MIN_FALLBACK_TIME_MS, 10_000)
})

// ── makeSignal ────────────────────────────────────────────────────────────────
console.log('\nmakeSignal')

await test('makeSignal returns an AbortSignal and a clearTimer function', () => {
  const { signal, clearTimer } = makeSignal(5000)
  assert.ok(signal instanceof AbortSignal, 'signal should be an AbortSignal')
  assert.strictEqual(signal.aborted, false, 'signal should not be aborted initially')
  assert.strictEqual(typeof clearTimer, 'function', 'clearTimer should be a function')
  clearTimer()  // cancels the pending setTimeout so tests exit cleanly
})

// ── shouldRetryForBlankReply — success paths (must NOT retry) ──────────────────
console.log('\nshouldRetryForBlankReply — success paths (must not retry)')

await test('returns false when parseError is null (success path)', () => {
  assert.strictEqual(shouldRetryForBlankReply(200, null, 'end_turn', ['text']), false)
})

await test('returns false when parseError is not empty_provider_response', () => {
  assert.strictEqual(shouldRetryForBlankReply(200, 'some_other_error', 'max_tokens', []), false)
})

await test('returns false for a refusal (parseError would be null — this tests the null guard)', () => {
  assert.strictEqual(shouldRetryForBlankReply(200, null, 'end_turn', ['text']), false)
})

// ── shouldRetryForBlankReply — non-200 provider status (must NOT retry) ────────
console.log('\nshouldRetryForBlankReply — non-200 provider status (must not retry)')

await test('returns false for HTTP 429 (rate limited)', () => {
  assert.strictEqual(shouldRetryForBlankReply(429, 'empty_provider_response', null, []), false)
})

await test('returns false for HTTP 529 (overloaded)', () => {
  assert.strictEqual(shouldRetryForBlankReply(529, 'empty_provider_response', null, []), false)
})

await test('returns false for HTTP 500 (server error)', () => {
  assert.strictEqual(shouldRetryForBlankReply(500, 'empty_provider_response', null, []), false)
})

await test('returns false for HTTP 503 (unavailable)', () => {
  assert.strictEqual(shouldRetryForBlankReply(503, 'empty_provider_response', null, []), false)
})

// ── shouldRetryForBlankReply — conditions that warrant retry ──────────────────
console.log('\nshouldRetryForBlankReply — blank-reply conditions that warrant retry')

await test('returns true when stop_reason is max_tokens (budget exhausted)', () => {
  assert.strictEqual(shouldRetryForBlankReply(200, 'empty_provider_response', 'max_tokens', []), true)
})

await test('returns true for empty content array (nothing produced)', () => {
  assert.strictEqual(shouldRetryForBlankReply(200, 'empty_provider_response', 'end_turn', []), true)
})

await test('returns true when all blocks are thinking type', () => {
  assert.strictEqual(shouldRetryForBlankReply(200, 'empty_provider_response', 'end_turn', ['thinking']), true)
})

await test('returns true when all blocks are redacted_thinking type', () => {
  assert.strictEqual(shouldRetryForBlankReply(200, 'empty_provider_response', 'end_turn', ['redacted_thinking']), true)
})

await test('returns true when all blocks are mixed thinking and redacted_thinking', () => {
  assert.strictEqual(
    shouldRetryForBlankReply(200, 'empty_provider_response', 'end_turn', ['thinking', 'redacted_thinking', 'thinking']),
    true
  )
})

await test('returns true for empty content with max_tokens stop reason', () => {
  assert.strictEqual(shouldRetryForBlankReply(200, 'empty_provider_response', 'max_tokens', []), true)
})

// ── shouldRetryForBlankReply — edge cases ─────────────────────────────────────
console.log('\nshouldRetryForBlankReply — edge cases')

await test('thinking+text content: parseError is null so this function is not called', () => {
  // When both thinking AND text blocks exist, parseProviderResponse returns a
  // non-null reply. This documents that the function returns false defensively.
  assert.strictEqual(shouldRetryForBlankReply(200, null, 'end_turn', ['thinking', 'text']), false)
})

await test('null/undefined contentBlockTypes treated as empty array (retry condition)', () => {
  // null → [] inside the function → empty → retry (same as empty content array)
  assert.strictEqual(shouldRetryForBlankReply(200, 'empty_provider_response', 'end_turn', null), true)
  assert.strictEqual(shouldRetryForBlankReply(200, 'empty_provider_response', 'end_turn', undefined), true)
})

await test('returns true for null contentBlockTypes when stop_reason is max_tokens', () => {
  assert.strictEqual(shouldRetryForBlankReply(200, 'empty_provider_response', 'max_tokens', null), true)
})

// ── buildAttemptLog — structure and field safety ───────────────────────────────
console.log('\nbuildAttemptLog — structure and field safety')

const ATTEMPT_PARAMS = {
  requestId: 'req-abc',
  attempt: 1,
  model: 'claude-sonnet-5',
  max_tokens: 4096,
  thinking_mode: 'disabled',
  effort: 'high',
  providerStatus: 200,
  providerRequestId: 'ap-xyz',
  stop_reason: 'end_turn',
  contentBlockTypes: ['text'],
  usage: { input_tokens: 5000, output_tokens: 200 },
  durationMs: 1234,
  contextPass: 1,
  replyPresent: true,
}

await test('returns an object with event field ai_chat_provider_attempt', () => {
  assert.strictEqual(buildAttemptLog(ATTEMPT_PARAMS).event, 'ai_chat_provider_attempt')
})

await test('includes request_id in log output', () => {
  assert.strictEqual(buildAttemptLog(ATTEMPT_PARAMS).request_id, 'req-abc')
})

await test('includes attempt number in log output', () => {
  assert.strictEqual(buildAttemptLog(ATTEMPT_PARAMS).attempt, 1)
})

await test('includes model identifier in log output', () => {
  assert.strictEqual(buildAttemptLog(ATTEMPT_PARAMS).model, 'claude-sonnet-5')
})

await test('includes max_tokens in log output', () => {
  assert.strictEqual(buildAttemptLog(ATTEMPT_PARAMS).max_tokens, 4096)
})

await test('includes thinking_mode in log output', () => {
  assert.strictEqual(buildAttemptLog(ATTEMPT_PARAMS).thinking_mode, 'disabled')
})

await test('includes effort in log output', () => {
  assert.strictEqual(buildAttemptLog(ATTEMPT_PARAMS).effort, 'high')
})

await test('includes provider_status in log output', () => {
  assert.strictEqual(buildAttemptLog(ATTEMPT_PARAMS).provider_status, 200)
})

await test('includes stop_reason in log output', () => {
  assert.strictEqual(buildAttemptLog(ATTEMPT_PARAMS).stop_reason, 'end_turn')
})

await test('includes content_block_types array in log output', () => {
  assert.deepStrictEqual(buildAttemptLog(ATTEMPT_PARAMS).content_block_types, ['text'])
})

await test('includes input_tokens from usage object', () => {
  assert.strictEqual(buildAttemptLog(ATTEMPT_PARAMS).input_tokens, 5000)
})

await test('includes output_tokens from usage object', () => {
  assert.strictEqual(buildAttemptLog(ATTEMPT_PARAMS).output_tokens, 200)
})

await test('includes duration_ms in log output', () => {
  assert.strictEqual(buildAttemptLog(ATTEMPT_PARAMS).duration_ms, 1234)
})

await test('includes context_pass in log output', () => {
  assert.strictEqual(buildAttemptLog(ATTEMPT_PARAMS).context_pass, 1)
})

await test('reply_present is true when non-blank reply exists', () => {
  assert.strictEqual(buildAttemptLog(ATTEMPT_PARAMS).reply_present, true)
})

await test('reply_present is false when no text was returned', () => {
  assert.strictEqual(buildAttemptLog({ ...ATTEMPT_PARAMS, replyPresent: false }).reply_present, false)
})

await test('handles null/undefined values gracefully without throwing', () => {
  assert.doesNotThrow(() => buildAttemptLog({
    requestId: null, attempt: null, model: null, max_tokens: null,
    thinking_mode: null, effort: null, providerStatus: null, providerRequestId: null,
    stop_reason: null, contentBlockTypes: null, usage: null,
    durationMs: null, contextPass: null, replyPresent: null,
  }))
})

await test('null usage produces null token counts', () => {
  const log = buildAttemptLog({ ...ATTEMPT_PARAMS, usage: null })
  assert.strictEqual(log.input_tokens, null)
  assert.strictEqual(log.output_tokens, null)
  assert.strictEqual(log.cache_creation_input_tokens, null)
  assert.strictEqual(log.cache_read_input_tokens, null)
})

await test('non-array contentBlockTypes produces empty array in output', () => {
  assert.deepStrictEqual(buildAttemptLog({ ...ATTEMPT_PARAMS, contentBlockTypes: null }).content_block_types, [])
})

await test('non-numeric providerStatus produces null in output', () => {
  assert.strictEqual(buildAttemptLog({ ...ATTEMPT_PARAMS, providerStatus: 'not-a-number' }).provider_status, null)
})

await test('log does not contain any field named prompt, reply, notes, or email', () => {
  const log = buildAttemptLog(ATTEMPT_PARAMS)
  const keys = Object.keys(log)
  assert.ok(!keys.includes('prompt'), 'log must not include prompt field')
  assert.ok(!keys.includes('system'), 'log must not include system field')
  assert.ok(!keys.includes('reply'), 'log must not include reply (response text) field')
  assert.ok(!keys.includes('notes'), 'log must not include notes field')
  assert.ok(!keys.includes('email'), 'log must not include email field')
  assert.ok(!keys.includes('name'), 'log must not include name field')
  assert.ok(!keys.includes('company'), 'log must not include company field')
})

await test('cache token counts are included when usage provides them', () => {
  const log = buildAttemptLog({
    ...ATTEMPT_PARAMS,
    usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 25 },
  })
  assert.strictEqual(log.cache_creation_input_tokens, 50)
  assert.strictEqual(log.cache_read_input_tokens, 25)
})

// ── buildRequestSummaryLog — structure and field safety ────────────────────────
console.log('\nbuildRequestSummaryLog — structure and field safety')

await test('returns an object with event field ai_chat_request_complete', () => {
  const log = buildRequestSummaryLog({ requestId: 'r', success: true, attempts: 1, finalErrorCode: null, totalDurationMs: 3000 })
  assert.strictEqual(log.event, 'ai_chat_request_complete')
})

await test('success is true when the request completed with a reply', () => {
  const log = buildRequestSummaryLog({ requestId: 'r', success: true, attempts: 1, finalErrorCode: null, totalDurationMs: 3000 })
  assert.strictEqual(log.success, true)
})

await test('success is false when both attempts failed', () => {
  const log = buildRequestSummaryLog({ requestId: 'r', success: false, attempts: 2, finalErrorCode: 'empty_provider_response', totalDurationMs: 60000 })
  assert.strictEqual(log.success, false)
})

await test('attempts is 1 when primary succeeded', () => {
  const log = buildRequestSummaryLog({ requestId: 'r', success: true, attempts: 1, finalErrorCode: null, totalDurationMs: 2000 })
  assert.strictEqual(log.attempts, 1)
})

await test('attempts is 2 when fallback was triggered', () => {
  const log = buildRequestSummaryLog({ requestId: 'r', success: true, attempts: 2, finalErrorCode: null, totalDurationMs: 5000 })
  assert.strictEqual(log.attempts, 2)
})

await test('final_error_code is null on success', () => {
  const log = buildRequestSummaryLog({ requestId: 'r', success: true, attempts: 1, finalErrorCode: null, totalDurationMs: 2000 })
  assert.strictEqual(log.final_error_code, null)
})

await test('final_error_code is the error code string on failure', () => {
  const log = buildRequestSummaryLog({ requestId: 'r', success: false, attempts: 2, finalErrorCode: 'provider_timeout', totalDurationMs: 60000 })
  assert.strictEqual(log.final_error_code, 'provider_timeout')
})

await test('includes total_duration_ms in log output', () => {
  const log = buildRequestSummaryLog({ requestId: 'r', success: true, attempts: 1, finalErrorCode: null, totalDurationMs: 4567 })
  assert.strictEqual(log.total_duration_ms, 4567)
})

await test('handles null values gracefully without throwing', () => {
  assert.doesNotThrow(() => buildRequestSummaryLog({ requestId: null, success: null, attempts: null, finalErrorCode: null, totalDurationMs: null }))
})

await test('success is false when null is passed (falsy guard)', () => {
  const log = buildRequestSummaryLog({ requestId: null, success: null, attempts: null, finalErrorCode: null, totalDurationMs: null })
  assert.strictEqual(log.success, false)
})

await test('log does not contain any field that could carry user data', () => {
  const log = buildRequestSummaryLog({ requestId: 'r', success: false, attempts: 2, finalErrorCode: 'empty_provider_response', totalDurationMs: 60000 })
  const keys = Object.keys(log)
  assert.ok(!keys.includes('prompt'), 'log must not include prompt field')
  assert.ok(!keys.includes('reply'), 'log must not include reply field')
  assert.ok(!keys.includes('context'), 'log must not include context (network data) field')
  assert.ok(!keys.includes('messages'), 'log must not include messages field')
})

// ── runProviderAttempts — real orchestration tests ─────────────────────────────
// These tests execute the actual control flow inside runProviderAttempts using
// injected dependencies. parseProviderResponse runs on mock response bodies —
// no mocking of the parsing layer.
console.log('\nrunProviderAttempts — orchestration')

// 1. Primary returns visible text → one attempt
await test('1. primary returns visible text → success in one attempt', async () => {
  const fetch = sequentialFetch(makeResponse(200, providerBody([textBlock('Here is your answer.')])))
  const logged = []
  const result = await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: fetch,
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: (d) => logged.push(d),
    logSummary: (d) => logged.push(d),
  })
  assert.ok(result.ok, `expected ok=true, got errorCode=${result.errorCode}`)
  assert.strictEqual(result.reply, 'Here is your answer.')
  assert.strictEqual(result.truncated, false)
  assert.strictEqual(result.attempts, 1)
  assert.strictEqual(fetch.callCount(), 1)
})

// 2. Primary returns multiple text blocks → joined with \n\n
await test('2. primary returns multiple text blocks → joined reply', async () => {
  const fetch = sequentialFetch(
    makeResponse(200, providerBody([textBlock('Part one.'), textBlock('Part two.')]))
  )
  const result = await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: fetch,
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: () => {}, logSummary: () => {},
  })
  assert.ok(result.ok)
  assert.strictEqual(result.reply, 'Part one.\n\nPart two.')
  assert.strictEqual(result.attempts, 1)
})

// 3. Primary returns thinking + text → visible text returned, no fallback
await test('3. primary returns thinking + text → text returned, one attempt', async () => {
  const fetch = sequentialFetch(
    makeResponse(200, providerBody([thinkBlock('my reasoning'), textBlock('Visible answer.')]))
  )
  const result = await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: fetch,
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: () => {}, logSummary: () => {},
  })
  assert.ok(result.ok)
  assert.strictEqual(result.reply, 'Visible answer.')
  assert.strictEqual(result.attempts, 1)
  assert.strictEqual(fetch.callCount(), 1)
})

// 4. Primary returns a usable truncated response (text present, stop_reason=max_tokens)
await test('4. truncated response with text → success with truncated=true', async () => {
  const fetch = sequentialFetch(
    makeResponse(200, providerBody([textBlock('Partial answer that got cut')], 'max_tokens'))
  )
  const result = await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: fetch,
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: () => {}, logSummary: () => {},
  })
  assert.ok(result.ok)
  assert.strictEqual(result.reply, 'Partial answer that got cut')
  assert.strictEqual(result.truncated, true)
  assert.strictEqual(result.attempts, 1)
})

// 5. Primary returns HTTP 200 with empty content → fallback runs and succeeds
await test('5. primary: empty content → fallback runs and succeeds', async () => {
  const fetch = sequentialFetch(
    makeResponse(200, providerBody([])),                              // attempt 1: blank
    makeResponse(200, providerBody([textBlock('Fallback answer.')]))  // attempt 2: success
  )
  const result = await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: fetch,
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: () => {}, logSummary: () => {},
  })
  assert.ok(result.ok)
  assert.strictEqual(result.reply, 'Fallback answer.')
  assert.strictEqual(result.attempts, 2)
  assert.strictEqual(fetch.callCount(), 2)
})

// 6. Primary returns thinking-only content → fallback runs and succeeds
await test('6. primary: thinking-only → fallback runs and succeeds', async () => {
  const fetch = sequentialFetch(
    makeResponse(200, providerBody([thinkBlock('reason but no text')])),
    makeResponse(200, providerBody([textBlock('Fallback worked.')]))
  )
  const result = await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: fetch,
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: () => {}, logSummary: () => {},
  })
  assert.ok(result.ok)
  assert.strictEqual(result.reply, 'Fallback worked.')
  assert.strictEqual(result.attempts, 2)
})

// 7. Primary returns refusal text → treated as success (no fallback)
await test('7. refusal text from primary → success, no fallback', async () => {
  const refusalText = "I can only help with your Funnl network — I'm not able to answer that."
  const fetch = sequentialFetch(
    makeResponse(200, providerBody([textBlock(refusalText)]))
  )
  const result = await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: fetch,
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: () => {}, logSummary: () => {},
  })
  assert.ok(result.ok)
  assert.strictEqual(result.reply, refusalText)
  assert.strictEqual(result.attempts, 1)
  assert.strictEqual(fetch.callCount(), 1)
})

// 8. Primary returns 400 → no fallback
await test('8. primary HTTP 400 → provider_error, no fallback', async () => {
  const fetch = sequentialFetch(makeResponse(400, {}))
  const result = await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: fetch,
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: () => {}, logSummary: () => {},
  })
  assert.ok(!result.ok)
  assert.strictEqual(result.errorCode, 'provider_error')
  assert.strictEqual(result.attempts, 1)
  assert.strictEqual(fetch.callCount(), 1)
})

// 9. Primary returns 429 → no fallback
await test('9. primary HTTP 429 → provider_rate_limited, no fallback', async () => {
  const fetch = sequentialFetch(makeResponse(429, {}))
  const result = await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: fetch,
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: () => {}, logSummary: () => {},
  })
  assert.ok(!result.ok)
  assert.strictEqual(result.errorCode, 'provider_rate_limited')
  assert.strictEqual(result.attempts, 1)
  assert.strictEqual(fetch.callCount(), 1)
})

// 10. Primary returns 529 → no fallback
await test('10. primary HTTP 529 → provider_unavailable, no fallback', async () => {
  const fetch = sequentialFetch(makeResponse(529, {}))
  const result = await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: fetch,
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: () => {}, logSummary: () => {},
  })
  assert.ok(!result.ok)
  assert.strictEqual(result.errorCode, 'provider_unavailable')
  assert.strictEqual(result.attempts, 1)
  assert.strictEqual(fetch.callCount(), 1)
})

// 11. Primary attempt times out (signal pre-aborted → fetch throws AbortError)
await test('11. primary times out → provider_timeout, no fallback', async () => {
  // immediateAbortSignal pre-aborts the controller; fetch checks aborted and throws.
  const fetchCallCount = { n: 0 }
  const abortingFetch = async (_url, opts) => {
    fetchCallCount.n++
    if (opts?.signal?.aborted) {
      const e = new Error('Aborted')
      e.name = 'AbortError'
      throw e
    }
    return makeResponse(200, providerBody([textBlock('Should not reach')]))
  }
  const result = await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: abortingFetch,
    now: () => 100,
    makeSignalFn: (_ms) => {
      const c = new AbortController()
      c.abort()  // pre-aborted → fetch throws AbortError immediately
      return { signal: c.signal, clearTimer: () => {} }
    },
    logAttempt: () => {}, logSummary: () => {},
  })
  assert.ok(!result.ok)
  assert.strictEqual(result.errorCode, 'provider_timeout')
  assert.strictEqual(result.attempts, 1)
  // fetch was called once (the throw happens inside the fetch mock)
  assert.strictEqual(fetchCallCount.n, 1)
})

// 12. Insufficient time remains for fallback → fallback not started
await test('12. insufficient time for fallback → provider_timeout without starting fallback', async () => {
  // requestStart=0, now()=50001 → elapsed=50001, remaining=9999 < MIN_FALLBACK_TIME_MS=10000
  const fetchCallCount = { n: 0 }
  const blankFetch = async () => {
    fetchCallCount.n++
    return makeResponse(200, providerBody([]))  // blank reply
  }
  const result = await runProviderAttempts({
    ...BASE_ARGS,
    requestStart: 0,
    fetchImpl: blankFetch,
    now: () => OVERALL_TIMEOUT_MS - MIN_FALLBACK_TIME_MS + 1,  // 50001ms "elapsed"
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: () => {}, logSummary: () => {},
  })
  assert.ok(!result.ok)
  assert.strictEqual(result.errorCode, 'provider_timeout')
  assert.strictEqual(result.attempts, 1, 'fallback should not have been started')
  assert.strictEqual(fetchCallCount.n, 1, 'fetch called only once (primary only)')
})

// 13. Fallback succeeds → final result is success
await test('13. fallback succeeds → result.ok=true, attempts=2', async () => {
  const fetch = sequentialFetch(
    makeResponse(200, providerBody([thinkBlock('thinking without output')])),
    makeResponse(200, providerBody([textBlock('Fallback success.')]))
  )
  const result = await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: fetch,
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: () => {}, logSummary: () => {},
  })
  assert.ok(result.ok)
  assert.strictEqual(result.reply, 'Fallback success.')
  assert.strictEqual(result.attempts, 2)
})

// 14. Fallback also fails → one structured final error
await test('14. both attempts fail → empty_provider_response, attempts=2', async () => {
  const fetch = sequentialFetch(
    makeResponse(200, providerBody([])),   // attempt 1: blank
    makeResponse(200, providerBody([]))    // attempt 2: also blank
  )
  const result = await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: fetch,
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: () => {}, logSummary: () => {},
  })
  assert.ok(!result.ok)
  assert.strictEqual(result.errorCode, 'empty_provider_response')
  assert.strictEqual(result.attempts, 2)
})

// 15. Never more than two provider calls
await test('15. at most two provider calls regardless of how many times the loop could iterate', async () => {
  let calls = 0
  const countingFetch = async () => {
    calls++
    return makeResponse(200, providerBody([]))  // always blank
  }
  await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: countingFetch,
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: () => {}, logSummary: () => {},
  })
  assert.ok(calls <= 2, `expected ≤ 2 fetch calls, got ${calls}`)
})

// 16. Abort timer is always cleared (clearTimer called once per actual attempt)
await test('16. abort timer cleared once per actual attempt', async () => {
  let clearCount = 0
  const fetch = sequentialFetch(
    makeResponse(200, providerBody([])),
    makeResponse(200, providerBody([textBlock('ok')]))
  )
  await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: fetch,
    now: () => 100,
    makeSignalFn: (_ms) => ({
      signal: new AbortController().signal,
      clearTimer: () => { clearCount++ },
    }),
    logAttempt: () => {}, logSummary: () => {},
  })
  // Two attempts ran → clearTimer called exactly twice
  assert.strictEqual(clearCount, 2, `expected 2 clearTimer calls, got ${clearCount}`)
})

await test('16b. abort timer cleared once even on timeout (single attempt)', async () => {
  let clearCount = 0
  const abortFetch = async (_url, _opts) => {
    const e = new Error('Aborted'); e.name = 'AbortError'; throw e
  }
  await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: abortFetch,
    now: () => 100,
    makeSignalFn: (_ms) => {
      const c = new AbortController(); c.abort()
      return { signal: c.signal, clearTimer: () => { clearCount++ } }
    },
    logAttempt: () => {}, logSummary: () => {},
  })
  assert.strictEqual(clearCount, 1, `expected 1 clearTimer call on timeout, got ${clearCount}`)
})

// 17. Request completion log fires exactly once
await test('17. logSummary fires exactly once regardless of outcome', async () => {
  for (const scenario of [
    // success
    [makeResponse(200, providerBody([textBlock('ok')]))],
    // both fail
    [makeResponse(200, providerBody([])), makeResponse(200, providerBody([]))],
    // non-200
    [makeResponse(429, {})],
  ]) {
    let summaryCount = 0
    await runProviderAttempts({
      ...BASE_ARGS,
      fetchImpl: sequentialFetch(...scenario),
      now: () => 100,
      makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
      logAttempt: () => {},
      logSummary: () => { summaryCount++ },
    })
    assert.strictEqual(summaryCount, 1, `logSummary should fire exactly once, got ${summaryCount}`)
  }
})

// 18. Attempt log fires once per actual attempt
await test('18. logAttempt fires once per actual provider call', async () => {
  // 1 attempt (success)
  let count1 = 0
  await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: sequentialFetch(makeResponse(200, providerBody([textBlock('ok')]))),
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: () => { count1++ }, logSummary: () => {},
  })
  assert.strictEqual(count1, 1, `expected 1 logAttempt for 1-attempt success, got ${count1}`)

  // 2 attempts (primary blank, fallback success)
  let count2 = 0
  await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: sequentialFetch(
      makeResponse(200, providerBody([])),
      makeResponse(200, providerBody([textBlock('ok')]))
    ),
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: () => { count2++ }, logSummary: () => {},
  })
  assert.strictEqual(count2, 2, `expected 2 logAttempt calls for 2-attempt run, got ${count2}`)
})

// 19. Provider response text is never logged
await test('19. response text is never present in logged data', async () => {
  const UNIQUE_RESPONSE = 'UNIQUE_RESPONSE_TEXT_XYZ_999'
  const loggedData = []
  await runProviderAttempts({
    ...BASE_ARGS,
    fetchImpl: sequentialFetch(makeResponse(200, providerBody([textBlock(UNIQUE_RESPONSE)]))),
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: (d) => loggedData.push(JSON.stringify(d)),
    logSummary: (d) => loggedData.push(JSON.stringify(d)),
  })
  const combined = loggedData.join('\n')
  assert.ok(!combined.includes(UNIQUE_RESPONSE),
    `response text "${UNIQUE_RESPONSE}" should not appear in logs`)
})

// 20. Prompt and network data are never logged
await test('20. systemPrompt and messages content are never present in logged data', async () => {
  const UNIQUE_PROMPT = 'UNIQUE_SYSTEM_PROMPT_ABC_888'
  const UNIQUE_MSG = 'UNIQUE_USER_MESSAGE_DEF_777'
  const loggedData = []
  await runProviderAttempts({
    ...BASE_ARGS,
    systemPrompt: UNIQUE_PROMPT,
    messages: [{ role: 'user', content: UNIQUE_MSG }],
    fetchImpl: sequentialFetch(makeResponse(200, providerBody([textBlock('ok')]))),
    now: () => 100,
    makeSignalFn: (_ms) => ({ signal: new AbortController().signal, clearTimer: () => {} }),
    logAttempt: (d) => loggedData.push(JSON.stringify(d)),
    logSummary: (d) => loggedData.push(JSON.stringify(d)),
  })
  const combined = loggedData.join('\n')
  assert.ok(!combined.includes(UNIQUE_PROMPT),
    `systemPrompt should not appear in logs`)
  assert.ok(!combined.includes(UNIQUE_MSG),
    `user message content should not appear in logs`)
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
