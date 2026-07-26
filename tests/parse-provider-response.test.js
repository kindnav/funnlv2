// Tests for parseProviderResponse — the Anthropic API response parser.
// Imports directly from the production module — no copied implementations.
//
// Run with: node tests/parse-provider-response.test.js

import assert from 'assert'
import { parseProviderResponse, STOP_REASON } from '../supabase/functions/ai-chat/parseProviderResponse.js'

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

// ── Malformed / missing response ──────────────────────────────────────────────
console.log('\nparseProviderResponse — malformed or missing response')

test('null returns empty_provider_response', () => {
  const r = parseProviderResponse(null)
  assert.strictEqual(r.error, 'empty_provider_response')
  assert.strictEqual(r.reply, null)
})

test('non-object (string) returns empty_provider_response', () => {
  const r = parseProviderResponse('some text')
  assert.strictEqual(r.error, 'empty_provider_response')
  assert.strictEqual(r.reply, null)
})

test('missing content field returns empty_provider_response', () => {
  const r = parseProviderResponse({ stop_reason: 'end_turn' })
  assert.strictEqual(r.error, 'empty_provider_response')
  assert.strictEqual(r.reply, null)
})

test('content is not an array returns empty_provider_response', () => {
  const r = parseProviderResponse({ content: 'text', stop_reason: 'end_turn' })
  assert.strictEqual(r.error, 'empty_provider_response')
})

test('empty content array returns empty_provider_response', () => {
  const r = parseProviderResponse({ content: [], stop_reason: 'end_turn' })
  assert.strictEqual(r.error, 'empty_provider_response')
  assert.strictEqual(r.reply, null)
})

test('thinking-only content (no text blocks) returns empty_provider_response', () => {
  const r = parseProviderResponse({
    content: [{ type: 'thinking', thinking: 'internal reasoning...' }],
    stop_reason: 'end_turn',
  })
  assert.strictEqual(r.error, 'empty_provider_response')
  assert.strictEqual(r.reply, null)
})

test('whitespace-only text block returns empty_provider_response', () => {
  const r = parseProviderResponse({
    content: [{ type: 'text', text: '   \n\t  ' }],
    stop_reason: 'end_turn',
  })
  assert.strictEqual(r.error, 'empty_provider_response')
  assert.strictEqual(r.reply, null)
})

// ── Successful text extraction ─────────────────────────────────────────────────
console.log('\nparseProviderResponse — successful text extraction')

test('single text block returns the text', () => {
  const r = parseProviderResponse({
    content: [{ type: 'text', text: 'Hello there.' }],
    stop_reason: 'end_turn',
  })
  assert.strictEqual(r.error, null)
  assert.strictEqual(r.reply, 'Hello there.')
})

test('multiple text blocks are joined with double newline', () => {
  const r = parseProviderResponse({
    content: [
      { type: 'text', text: 'First part.' },
      { type: 'text', text: 'Second part.' },
    ],
    stop_reason: 'end_turn',
  })
  assert.strictEqual(r.error, null)
  assert.strictEqual(r.reply, 'First part.\n\nSecond part.')
})

test('thinking block before text: text is extracted, thinking is skipped', () => {
  const r = parseProviderResponse({
    content: [
      { type: 'thinking', thinking: 'let me think...' },
      { type: 'text', text: 'My answer.' },
    ],
    stop_reason: 'end_turn',
  })
  assert.strictEqual(r.error, null)
  assert.strictEqual(r.reply, 'My answer.')
  assert.ok(!r.reply.includes('let me think'))
})

test('text block before thinking: text is extracted', () => {
  const r = parseProviderResponse({
    content: [
      { type: 'text', text: 'My answer.' },
      { type: 'thinking', thinking: 'post-processing thoughts' },
    ],
    stop_reason: 'end_turn',
  })
  assert.strictEqual(r.error, null)
  assert.strictEqual(r.reply, 'My answer.')
})

test('multiple text blocks with thinking blocks interspersed: all text joined', () => {
  const r = parseProviderResponse({
    content: [
      { type: 'thinking', thinking: 'step 1' },
      { type: 'text', text: 'Part one.' },
      { type: 'thinking', thinking: 'step 2' },
      { type: 'text', text: 'Part two.' },
    ],
    stop_reason: 'end_turn',
  })
  assert.strictEqual(r.error, null)
  assert.strictEqual(r.reply, 'Part one.\n\nPart two.')
})

// ── stop_reason handling ───────────────────────────────────────────────────────
console.log('\nparseProviderResponse — stop_reason handling')

test('stop_reason end_turn → truncated: false', () => {
  const r = parseProviderResponse({
    content: [{ type: 'text', text: 'Complete response.' }],
    stop_reason: STOP_REASON.END_TURN,
  })
  assert.strictEqual(r.truncated, false)
  assert.strictEqual(r.stop_reason, 'end_turn')
  assert.strictEqual(r.error, null)
})

test('stop_reason max_tokens with text → truncated: true, error: null', () => {
  const r = parseProviderResponse({
    content: [{ type: 'text', text: 'Partial response that got cut off...' }],
    stop_reason: STOP_REASON.MAX_TOKENS,
  })
  assert.strictEqual(r.truncated, true)
  assert.strictEqual(r.error, null)
  assert.ok(r.reply.length > 0)
})

test('stop_reason max_tokens with no text → empty_provider_response', () => {
  const r = parseProviderResponse({
    content: [{ type: 'thinking', thinking: 'only thinking, cut off' }],
    stop_reason: STOP_REASON.MAX_TOKENS,
  })
  assert.strictEqual(r.error, 'empty_provider_response')
  assert.strictEqual(r.reply, null)
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
