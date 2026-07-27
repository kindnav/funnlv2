// Tests for normalizeMessages — the conversation history validator and normalizer.
// Imports directly from the production module — no copied implementations.
//
// Run with: node tests/normalize-messages.test.js

import assert from 'assert'
import {
  normalizeMessages,
  shortenAssistantForHistory,
  MAX_MESSAGES,
  MAX_USER_MESSAGE_CHARS,
  MAX_ASSISTANT_HISTORY_CHARS,
  MAX_TOTAL_CONVERSATION_CHARS,
} from '../supabase/functions/ai-chat/normalizeMessages.js'

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

// ── Invalid input structure ────────────────────────────────────────────────────
console.log('\nnormalizeMessages — invalid input structure')

test('null returns invalid_request', () => {
  const r = normalizeMessages(null)
  assert.strictEqual(r.errorCode, 'invalid_request')
  assert.strictEqual(r.messages, null)
})

test('non-array (object) returns invalid_request', () => {
  const r = normalizeMessages({ role: 'user', content: 'hello' })
  assert.strictEqual(r.errorCode, 'invalid_request')
})

test('empty array returns invalid_request', () => {
  const r = normalizeMessages([])
  assert.strictEqual(r.errorCode, 'invalid_request')
})

test('message with invalid role returns invalid_request', () => {
  const r = normalizeMessages([{ role: 'system', content: 'You are a bot' }])
  assert.strictEqual(r.errorCode, 'invalid_request')
})

test('message with non-string content returns invalid_request', () => {
  const r = normalizeMessages([{ role: 'user', content: 42 }])
  assert.strictEqual(r.errorCode, 'invalid_request')
})

test('message with blank content returns invalid_request', () => {
  const r = normalizeMessages([{ role: 'user', content: '   ' }])
  assert.strictEqual(r.errorCode, 'invalid_request')
})

test(`user message exceeding MAX_USER_MESSAGE_CHARS (${MAX_USER_MESSAGE_CHARS}) returns prompt_too_long`, () => {
  const r = normalizeMessages([{ role: 'user', content: 'x'.repeat(MAX_USER_MESSAGE_CHARS + 1) }])
  assert.strictEqual(r.errorCode, 'prompt_too_long')
  assert.strictEqual(r.messages, null)
})

test('consecutive user messages return invalid_request', () => {
  const r = normalizeMessages([
    { role: 'user', content: 'Question one' },
    { role: 'user', content: 'Question two' },
  ])
  assert.strictEqual(r.errorCode, 'invalid_request')
})

test('consecutive assistant messages return invalid_request', () => {
  const r = normalizeMessages([
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: 'Answer A' },
    { role: 'assistant', content: 'Answer B' },
    { role: 'user', content: 'Follow-up' },
  ])
  assert.strictEqual(r.errorCode, 'invalid_request')
})

test('sequence ending with assistant role returns invalid_request', () => {
  const r = normalizeMessages([
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: 'Answer' },
  ])
  assert.strictEqual(r.errorCode, 'invalid_request')
})

// ── Successful normalization ───────────────────────────────────────────────────
console.log('\nnormalizeMessages — successful normalization')

test('single valid user message succeeds', () => {
  const r = normalizeMessages([{ role: 'user', content: 'Hello' }])
  assert.strictEqual(r.errorCode, null)
  assert.deepStrictEqual(r.messages, [{ role: 'user', content: 'Hello' }])
})

test('valid multi-turn conversation succeeds', () => {
  const r = normalizeMessages([
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: 'Answer' },
    { role: 'user', content: 'Follow-up' },
  ])
  assert.strictEqual(r.errorCode, null)
  assert.strictEqual(r.messages.length, 3)
})

test('leading assistant role returns invalid_request (localOnly messages filtered before invoke)', () => {
  const r = normalizeMessages([
    { role: 'assistant', content: 'Your network is loaded. Ask me anything.' },
    { role: 'user', content: 'Hello' },
  ])
  assert.strictEqual(r.errorCode, 'invalid_request')
  assert.strictEqual(r.messages, null)
})

test('does NOT strip a real assistant reply at a later position', () => {
  const r = normalizeMessages([
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'First answer' },
    { role: 'user', content: 'Second question' },
  ])
  assert.strictEqual(r.errorCode, null)
  assert.strictEqual(r.messages.length, 3)
  assert.strictEqual(r.messages[1].content, 'First answer')
})

test('result messages contain only role and content fields (extra fields stripped)', () => {
  const r = normalizeMessages([
    { role: 'user', content: 'Question', extra: 'unwanted', nested: { data: true } },
  ])
  assert.strictEqual(r.errorCode, null)
  const m = r.messages[0]
  assert.ok('role' in m)
  assert.ok('content' in m)
  assert.ok(!('extra' in m))
  assert.ok(!('nested' in m))
})

test('content is trimmed', () => {
  const r = normalizeMessages([{ role: 'user', content: '  hello  ' }])
  assert.strictEqual(r.errorCode, null)
  assert.strictEqual(r.messages[0].content, 'hello')
})

// ── Production regression: long assistant response followed by short follow-up ──
console.log('\nnormalizeMessages — production regression: long assistant history')

test('10,000-char assistant response followed by short follow-up succeeds', () => {
  // Reproduces the production failure: a long assistant response is sent back as
  // history. Previously rejected because 10,000 > MAX_MESSAGE_CHARS (4,000).
  // After fix: shortened for history, follow-up accepted.
  const longAssistant = 'a'.repeat(10_000)
  const msgs = [
    { role: 'user',      content: 'Who fits these criteria from my network?' },
    { role: 'assistant', content: longAssistant },
    { role: 'user',      content: 'do not include indiana students' },
  ]
  const r = normalizeMessages(msgs)
  assert.strictEqual(r.errorCode, null, `expected success but got errorCode=${r.errorCode}`)
  assert.ok(r.messages, 'messages should not be null')
  assert.strictEqual(r.messages[r.messages.length - 1].content, 'do not include indiana students')
})

test('exact production sequence: complex request, long list, short refinement', () => {
  // Mirrors support ref 04b0e67f: user sends complex request, gets a long list
  // of contacts matching criteria (e.g. 8,000-char list), then refines with
  // "do not include indiana students". Previously returned HTTP 400.
  const longList = 'Here are the contacts:\n' + 'Contact Name, Company, Role. Relevant because...\n'.repeat(120)
  const msgs = [
    { role: 'user',      content: 'Review my network and identify strong contacts for venture capital introductions. For each, cite specific stored facts.' },
    { role: 'assistant', content: longList },
    { role: 'user',      content: 'do not include indiana students' },
  ]
  const r = normalizeMessages(msgs)
  assert.strictEqual(r.errorCode, null, `production regression: expected success but got errorCode=${r.errorCode}`)
  assert.ok(r.messages)
  assert.strictEqual(r.messages[r.messages.length - 1].content, 'do not include indiana students')
})

test('assistant response at exact MAX_ASSISTANT_HISTORY_CHARS succeeds unchanged', () => {
  const exactContent = 'x'.repeat(MAX_ASSISTANT_HISTORY_CHARS)
  const msgs = [
    { role: 'user',      content: 'Question' },
    { role: 'assistant', content: exactContent },
    { role: 'user',      content: 'Follow-up' },
  ]
  const r = normalizeMessages(msgs)
  assert.strictEqual(r.errorCode, null)
  assert.strictEqual(r.messages[1].content, exactContent, 'exact-limit content should be unchanged')
})

test('assistant response over MAX_ASSISTANT_HISTORY_CHARS is shortened, not rejected', () => {
  const oversized = 'x'.repeat(MAX_ASSISTANT_HISTORY_CHARS + 1_000)
  const msgs = [
    { role: 'user',      content: 'Question' },
    { role: 'assistant', content: oversized },
    { role: 'user',      content: 'Follow-up' },
  ]
  const r = normalizeMessages(msgs)
  assert.strictEqual(r.errorCode, null, 'oversized assistant history must not return error')
  assert.ok(r.messages, 'messages must not be null')
  // History copy is shortened
  const historyContent = r.messages[1].content
  assert.ok(historyContent.length <= MAX_ASSISTANT_HISTORY_CHARS,
    `shortened content ${historyContent.length} > limit ${MAX_ASSISTANT_HISTORY_CHARS}`)
  // Shortening marker is present
  assert.ok(historyContent.includes('[Previous assistant response shortened for conversation history]'),
    'shortening marker not found in history')
})

test('original input string is never mutated by normalizeMessages', () => {
  const oversized = 'x'.repeat(MAX_ASSISTANT_HISTORY_CHARS + 500)
  const original = oversized.length
  const msgs = [
    { role: 'user',      content: 'Q' },
    { role: 'assistant', content: oversized },
    { role: 'user',      content: 'Follow-up' },
  ]
  normalizeMessages(msgs)
  assert.strictEqual(oversized.length, original, 'input string was mutated')
  assert.strictEqual(msgs[1].content, oversized, 'input message was mutated')
})

test('oversized prompt_too_long: current user message too long returns prompt_too_long', () => {
  const msgs = [
    { role: 'user', content: 'x'.repeat(MAX_USER_MESSAGE_CHARS + 1) },
  ]
  const r = normalizeMessages(msgs)
  assert.strictEqual(r.errorCode, 'prompt_too_long')
  assert.strictEqual(r.messages, null)
})

// ── shortenAssistantForHistory ────────────────────────────────────────────────
console.log('\nshortenAssistantForHistory — shortening behavior')

test('content within limit is returned unchanged', () => {
  const s = 'a'.repeat(MAX_ASSISTANT_HISTORY_CHARS)
  assert.strictEqual(shortenAssistantForHistory(s), s)
})

test('content over limit is shortened to at most MAX_ASSISTANT_HISTORY_CHARS chars', () => {
  const s = 'a'.repeat(MAX_ASSISTANT_HISTORY_CHARS + 5_000)
  const result = shortenAssistantForHistory(s)
  assert.ok(result.length <= MAX_ASSISTANT_HISTORY_CHARS,
    `shortened length ${result.length} > ${MAX_ASSISTANT_HISTORY_CHARS}`)
})

test('shortened result includes the shortening marker', () => {
  const s = 'a'.repeat(MAX_ASSISTANT_HISTORY_CHARS + 1_000)
  const result = shortenAssistantForHistory(s)
  assert.ok(result.includes('[Previous assistant response shortened for conversation history]'))
})

test('shortened result preserves both the beginning and the end of the original', () => {
  // Build a distinguishable string: AAAA...BBBB
  const half = Math.floor(MAX_ASSISTANT_HISTORY_CHARS / 2) + 2_000
  const s = 'A'.repeat(half) + 'B'.repeat(half)
  const result = shortenAssistantForHistory(s)
  assert.ok(result.startsWith('A'), 'beginning of original not preserved')
  assert.ok(result.endsWith('B'), 'end of original not preserved')
})

// ── Size limiting ──────────────────────────────────────────────────────────────
console.log('\nnormalizeMessages — size limiting')

test('trims oldest turns when total conversation exceeds MAX_TOTAL_CONVERSATION_CHARS', () => {
  const bigContent = 'b'.repeat(2_000)  // well within per-message limits
  // 22 × 2,000 + 15 = 44,015 > MAX_TOTAL_CONVERSATION_CHARS (40,000) — trimming required
  const manyMsgs = []
  for (let i = 0; i < 11; i++) {
    manyMsgs.push({ role: 'user', content: bigContent })
    manyMsgs.push({ role: 'assistant', content: bigContent })
  }
  manyMsgs.push({ role: 'user', content: 'Latest question' })

  const r = normalizeMessages(manyMsgs)
  assert.strictEqual(r.errorCode, null)
  assert.ok(r.messages)
  // Latest question must be preserved
  assert.strictEqual(r.messages[r.messages.length - 1].content, 'Latest question')
  // Total must be within budget
  const totalChars = r.messages.reduce((sum, m) => sum + m.content.length, 0)
  assert.ok(
    totalChars <= MAX_TOTAL_CONVERSATION_CHARS,
    `total ${totalChars} > ${MAX_TOTAL_CONVERSATION_CHARS}`
  )
  // Must start with user
  assert.strictEqual(r.messages[0].role, 'user')
  // Sequence must still alternate
  for (let i = 1; i < r.messages.length; i++) {
    assert.notStrictEqual(r.messages[i].role, r.messages[i - 1].role)
  }
  assert.strictEqual(r.messages[r.messages.length - 1].role, 'user')
})

test(`caps message count at MAX_MESSAGES (${MAX_MESSAGES})`, () => {
  const msgs = []
  for (let i = 0; i < Math.floor((MAX_MESSAGES + 4) / 2); i++) {
    msgs.push({ role: 'user',      content: `Question ${i + 1}` })
    msgs.push({ role: 'assistant', content: `Answer ${i + 1}` })
  }
  msgs.push({ role: 'user', content: 'Final question' })

  const r = normalizeMessages(msgs)
  assert.strictEqual(r.errorCode, null)
  assert.ok(r.messages.length <= MAX_MESSAGES)
  assert.strictEqual(r.messages[r.messages.length - 1].content, 'Final question')
  assert.strictEqual(r.messages[0].role, 'user')
})

test('normalized history always starts with user and ends with user', () => {
  const r = normalizeMessages([
    { role: 'user',      content: 'Q1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user',      content: 'Q2' },
    { role: 'assistant', content: 'A2' },
    { role: 'user',      content: 'Q3' },
  ])
  assert.strictEqual(r.errorCode, null)
  assert.strictEqual(r.messages[0].role, 'user', 'must start with user')
  assert.strictEqual(r.messages[r.messages.length - 1].role, 'user', 'must end with user')
})

// ── Validation diagnostic reasons ────────────────────────────────────────────
console.log('\nnormalizeMessages — validation diagnostic reasons')

test('validationReason is present on error returns', () => {
  const r = normalizeMessages(null)
  assert.ok(typeof r.validationReason === 'string' && r.validationReason.length > 0,
    'validationReason should be a non-empty string on error')
})

test('validationReason does not contain message content', () => {
  // Over-limit user message — validationReason must be a controlled enum value,
  // not the actual content. Content is 'x'.repeat(N); reason must not include it.
  const r2 = normalizeMessages([{ role: 'user', content: 'x'.repeat(MAX_USER_MESSAGE_CHARS + 1) }])
  assert.ok(!r2.validationReason.includes('x'.repeat(10)),
    'validationReason must not contain message content')
})

test('null input has controlled reason messages_not_array', () => {
  const r = normalizeMessages(null)
  assert.strictEqual(r.validationReason, 'messages_not_array')
})

test('empty array has controlled reason messages_empty', () => {
  const r = normalizeMessages([])
  assert.strictEqual(r.validationReason, 'messages_empty')
})

test('invalid role has controlled reason invalid_role', () => {
  const r = normalizeMessages([{ role: 'system', content: 'hi' }])
  assert.strictEqual(r.validationReason, 'invalid_role')
})

test('blank content has controlled reason blank_content', () => {
  const r = normalizeMessages([{ role: 'user', content: '   ' }])
  assert.strictEqual(r.validationReason, 'blank_content')
})

test('user message too long has controlled reason user_message_too_long', () => {
  const r = normalizeMessages([{ role: 'user', content: 'x'.repeat(MAX_USER_MESSAGE_CHARS + 1) }])
  assert.strictEqual(r.validationReason, 'user_message_too_long')
})

test('leading assistant has controlled reason leading_assistant', () => {
  const r = normalizeMessages([
    { role: 'assistant', content: 'Hi' },
    { role: 'user', content: 'Hello' },
  ])
  assert.strictEqual(r.validationReason, 'leading_assistant')
})

test('consecutive same roles has controlled reason invalid_role_sequence', () => {
  const r = normalizeMessages([
    { role: 'user', content: 'Q1' },
    { role: 'user', content: 'Q2' },
  ])
  assert.strictEqual(r.validationReason, 'invalid_role_sequence')
})

test('ends with assistant has controlled reason conversation_not_user_terminated', () => {
  const r = normalizeMessages([
    { role: 'user', content: 'Q' },
    { role: 'assistant', content: 'A' },
  ])
  assert.strictEqual(r.validationReason, 'conversation_not_user_terminated')
})

test('successful normalization has no validationReason', () => {
  const r = normalizeMessages([{ role: 'user', content: 'Hello' }])
  assert.strictEqual(r.errorCode, null)
  assert.ok(!r.validationReason, 'successful result should not have validationReason')
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
