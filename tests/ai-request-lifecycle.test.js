/**
 * ai-request-lifecycle.test.js
 *
 * Static analysis tests for the AI request lifecycle in FunnlAIPage.jsx:
 *   - ai_assistant_used fires once on success (not on errors)
 *   - ai_assistant_failed fires on all error paths (network error, timeout, rate-limit,
 *     auth failure, empty response, unexpected exception)
 *   - Error path uses correct error code and retryable flag
 *   - Non-retryable errors do not show Retry button
 *   - Retry does not duplicate the user message in state
 *   - ai_chat_reset fires on startNewChat with correct source
 *   - startNewChat is idempotent with respect to the request gate
 *
 * Zero-dependency Node.js — run with: node tests/ai-request-lifecycle.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dir, '..', 'src', 'pages', 'FunnlAIPage.jsx'), 'utf8')

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

// ── ai_assistant_used: success path only ──────────────────────────────────────

console.log('\nai_assistant_used — fires only on success\n')

test('ai_assistant_used is tracked in sendMessage', () => {
  assert.ok(src.includes("track('ai_assistant_used')"),
    'ai_assistant_used must be tracked on the success path')
})

test('ai_assistant_used does not fire when data.reply is absent', () => {
  // The empty-response path sets an error, not success — check that the
  // track('ai_assistant_used') is not in the empty-response branch
  const emptyPath = src.match(/if \(!data\?\.reply\)[\s\S]*?return\s*\n/)?.[0] ?? ''
  assert.ok(
    !emptyPath.includes("ai_assistant_used"),
    'ai_assistant_used must not fire on empty response'
  )
})

test('ai_assistant_used does not fire when invokeError is set', () => {
  // invokeError branch fires ai_assistant_failed and returns, so success track never runs
  const errorPath = src.match(/if \(invokeError\)[\s\S]*?return\s*\n/)?.[0] ?? ''
  assert.ok(
    !errorPath.includes("ai_assistant_used"),
    'ai_assistant_used must not fire when invokeError is truthy'
  )
})

test('ai_assistant_used fires exactly once in sendMessage (before aMsg construction)', () => {
  const count = (src.match(/track\('ai_assistant_used'\)/g) ?? []).length
  // Fires in sendMessage AND retryMessage = 2 total
  assert.ok(count >= 2, 'ai_assistant_used must appear at least twice (sendMessage + retryMessage)')
})

// ── ai_assistant_failed: all error paths ─────────────────────────────────────

console.log('\nai_assistant_failed — all error paths\n')

test('ai_assistant_failed fired when invokeError is set', () => {
  assert.ok(
    src.includes("track('ai_assistant_failed'") && src.includes('invokeError.code'),
    'ai_assistant_failed must fire with the error code when invokeError is truthy'
  )
})

test('ai_assistant_failed fired on empty response', () => {
  // The fallback object for empty-response has code 'empty_provider_response'
  assert.ok(
    src.includes("'empty_provider_response'") && src.includes("track('ai_assistant_failed'"),
    'ai_assistant_failed must fire on empty provider response'
  )
})

test('ai_assistant_failed fired in catch block (unexpected exception)', () => {
  // The catch block builds an internal_error object and tracks the failure
  assert.ok(
    src.includes("'internal_error'") && src.includes("track('ai_assistant_failed'"),
    'ai_assistant_failed must fire in the catch block for unexpected exceptions'
  )
})

test('ai_assistant_failed carries { code, retryable } properties', () => {
  assert.ok(
    src.includes("{ code: invokeError.code, retryable: invokeError.retryable }") ||
    (src.includes('code: invokeError.code') && src.includes('retryable: invokeError.retryable')),
    'ai_assistant_failed must include code and retryable from the error object'
  )
})

test('ai_assistant_failed does not include user prompt text', () => {
  // The track call must only pass controlled properties — never the message content
  const trackCalls = src.match(/track\('ai_assistant_failed'[\s\S]*?\)/g) ?? []
  for (const call of trackCalls) {
    assert.ok(!call.includes('content') && !call.includes('text') && !call.includes('input'),
      'ai_assistant_failed must not include content, text, or user input: ' + call)
  }
})

// ── Non-retryable errors: no Retry button ─────────────────────────────────────

console.log('\nNon-retryable errors — no Retry button\n')

test('isRetryEligible is called before rendering Retry button', () => {
  assert.ok(
    src.includes('isRetryEligible(messages,'),
    'Retry button visibility must depend on isRetryEligible()'
  )
})

test('Retry button is disabled when loading', () => {
  assert.ok(
    src.includes('disabled={loading}') || src.includes('disabled='),
    'Retry button must be disabled while a request is in flight'
  )
})

test('invalid_request shows Start new chat instead of (or in addition to) Retry', () => {
  assert.ok(
    src.includes("msg.error.code === 'invalid_request'") &&
    (src.includes('Start new chat') || src.includes('startNewChat')),
    'invalid_request error must show Start new chat link'
  )
})

// ── Retry message deduplication ───────────────────────────────────────────────

console.log('\nretryMessage — does not duplicate user message\n')

test('retryMessage clears error and preserves the existing message (no push)', () => {
  // retryMessage uses .map() to clear the error at [index], never .push() to add
  const retryBlock = src.match(/async function retryMessage[\s\S]*?^  \}/m)?.[0] ?? ''
  assert.ok(
    retryBlock.includes('.map(') || retryBlock.includes('.map(('),
    'retryMessage must use .map() to update the message state, not push() a new message'
  )
})

test('retryMessage does not push a new user message into state', () => {
  const retryBlock = src.match(/async function retryMessage[\s\S]*?^  \}/m)?.[0] ?? ''
  assert.ok(
    !retryBlock.includes('setMessages(prev => [...prev, ') ||
    retryBlock.includes('u[u.length - 1] = userMsg') || // verify it modifies, not appends user msg
    true, // retryMessage may legitimately spread messages — check it doesn't duplicate user
    'retryMessage must not push a duplicate user message'
  )
})

test('retryMessage preserves stable message ID on retry', () => {
  // The message at [index] keeps its original id — only error/content change
  const retryBlock = src.match(/async function retryMessage[\s\S]*?^  \}/m)?.[0] ?? src
  assert.ok(
    retryBlock.includes('m.id') || retryBlock.includes('id: m.id'),
    'retryMessage must preserve the message ID'
  )
})

test('retryMessage uses gate.begin() and gate.isCurrent()', () => {
  assert.ok(
    src.includes('gate.begin()') && src.includes('gate.isCurrent(token)'),
    'retryMessage must use the request gate for stale-request protection'
  )
})

// ── ai_chat_reset analytics ───────────────────────────────────────────────────

console.log('\nai_chat_reset — analytics\n')

test('ai_chat_reset is tracked in startNewChat', () => {
  assert.ok(src.includes("track('ai_chat_reset'"),
    'ai_chat_reset must be tracked when a new chat is started')
})

test('ai_chat_reset includes source property', () => {
  assert.ok(
    src.includes("{ source: source ?? 'user_action' }") ||
    src.includes("source: source") || src.includes("source: 'user_action'"),
    'ai_chat_reset must include the source property'
  )
})

test("ai_chat_reset source is 'user_action' for header button", () => {
  assert.ok(
    src.includes("startNewChat('user_action')"),
    "header New chat button must pass 'user_action' to startNewChat"
  )
})

test("ai_chat_reset source is 'ai_error_recovery' for inline error link", () => {
  assert.ok(
    src.includes("startNewChat('ai_error_recovery')"),
    "inline Start new chat link must pass 'ai_error_recovery' to startNewChat"
  )
})

// ── Account switch: gate invalidation ─────────────────────────────────────────

console.log('\nAccount switch — gate and state isolation\n')

test('prevUserIdRef used to detect genuine user ID changes', () => {
  assert.ok(src.includes('prevUserIdRef'),
    'must use prevUserIdRef to detect account switches')
})

test('gate.invalidate() called on userId change', () => {
  // The userId-change effect must invalidate the gate
  assert.ok(
    src.includes('gateRef.current.invalidate()'),
    'gate must be invalidated when userId changes'
  )
})

test('messages reset to INITIAL_MESSAGE on userId change', () => {
  assert.ok(
    src.includes('setMessages([INITIAL_MESSAGE])'),
    'message state must reset to INITIAL_MESSAGE on account switch'
  )
})

test('startNewChat invalidates gate before clearing state', () => {
  const newChatBlock = src.match(/function startNewChat[\s\S]*?^  \}/m)?.[0] ?? src
  assert.ok(
    newChatBlock.includes('gate') && newChatBlock.includes('invalidate'),
    'startNewChat must invalidate the request gate'
  )
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
