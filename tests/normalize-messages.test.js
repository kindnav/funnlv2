// Tests for normalizeMessages — the conversation history validator and normalizer.
// Imports directly from the production module — no copied implementations.
//
// Run with: node tests/normalize-messages.test.js

import assert from 'assert'
import {
  normalizeMessages,
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
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

test(`message exceeding MAX_MESSAGE_CHARS (${MAX_MESSAGE_CHARS}) returns invalid_request`, () => {
  const r = normalizeMessages([{ role: 'user', content: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }])
  assert.strictEqual(r.errorCode, 'invalid_request')
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

test('strips the frontend opening assistant greeting (INITIAL_MESSAGE)', () => {
  const r = normalizeMessages([
    { role: 'assistant', content: 'Your network is loaded. Ask me anything.' },
    { role: 'user', content: 'Hello' },
  ])
  assert.strictEqual(r.errorCode, null)
  assert.strictEqual(r.messages.length, 1)
  assert.strictEqual(r.messages[0].role, 'user')
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

// ── Size limiting ──────────────────────────────────────────────────────────────
console.log('\nnormalizeMessages — size limiting')

test('trims oldest turns when total conversation exceeds MAX_TOTAL_CONVERSATION_CHARS', () => {
  const bigContent = 'b'.repeat(MAX_MESSAGE_CHARS - 10)  // 3990 chars each
  const msgs = [
    { role: 'assistant', content: 'Greeting' },        // stripped (INITIAL_MESSAGE)
    { role: 'user',      content: bigContent },         // oldest user turn
    { role: 'assistant', content: bigContent },         // oldest assistant response
    { role: 'user',      content: bigContent },         // middle turn
    { role: 'assistant', content: bigContent },         // middle response
    { role: 'user',      content: bigContent },         // recent turn
    { role: 'assistant', content: bigContent },         // recent response
    { role: 'user',      content: 'Latest question' }, // current
  ]
  // After stripping: 7 msgs × ~3990 chars = 27,930 > MAX_TOTAL_CONVERSATION_CHARS
  const r = normalizeMessages(msgs)
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
  // Sequence must still alternate and end with user
  for (let i = 1; i < r.messages.length; i++) {
    assert.notStrictEqual(r.messages[i].role, r.messages[i - 1].role)
  }
  assert.strictEqual(r.messages[r.messages.length - 1].role, 'user')
})

test(`caps message count at MAX_MESSAGES (${MAX_MESSAGES})`, () => {
  // Build a valid alternating conversation with MAX_MESSAGES + 4 entries
  const msgs = []
  for (let i = 0; i < Math.floor((MAX_MESSAGES + 4) / 2); i++) {
    msgs.push({ role: 'user',      content: `Question ${i + 1}` })
    msgs.push({ role: 'assistant', content: `Answer ${i + 1}` })
  }
  // Add a final user message so it ends with user
  msgs.push({ role: 'user', content: 'Final question' })

  const r = normalizeMessages(msgs)
  assert.strictEqual(r.errorCode, null)
  assert.ok(r.messages.length <= MAX_MESSAGES)
  // Most recent must be preserved
  assert.strictEqual(r.messages[r.messages.length - 1].content, 'Final question')
  // Must start with user
  assert.strictEqual(r.messages[0].role, 'user')
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
