/**
 * ai-current-session-storage.test.js
 *
 * Tests for parseStoredCurrentSession() and related helpers:
 *   validateStoredMessage, normalizeMessageId, hydrateMessages
 *
 * Covers all edge cases from Section 5 of the Stage 7 correction spec:
 *   - null / empty / whitespace raw input
 *   - malformed JSON
 *   - array-instead-of-object at top level
 *   - object-instead-of-array at top level
 *   - missing or invalid roles
 *   - non-string content
 *   - messages without IDs get hydrated with stable IDs
 *   - messages with existing IDs preserve them
 *   - mixed valid/invalid messages: invalid ones are discarded
 *
 * Zero-dependency Node.js — run with: node tests/ai-current-session-storage.test.js
 */
import assert from 'assert'
import {
  validateStoredMessage,
  normalizeMessageId,
  hydrateMessages,
  parseStoredCurrentSession,
} from '../src/lib/ai-history.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

// ── validateStoredMessage ─────────────────────────────────────────────────────

console.log('\nvalidateStoredMessage — basic shape validation\n')

test('accepts a valid user message', () => {
  assert.strictEqual(validateStoredMessage({ role: 'user', content: 'hello' }), true)
})

test('accepts a valid assistant message', () => {
  assert.strictEqual(validateStoredMessage({ role: 'assistant', content: 'world' }), true)
})

test('accepts message with extra fields', () => {
  assert.strictEqual(validateStoredMessage({ role: 'user', content: 'hi', id: 'abc', localOnly: false }), true)
})

test('rejects null', () => {
  assert.strictEqual(validateStoredMessage(null), false)
})

test('rejects undefined', () => {
  assert.strictEqual(validateStoredMessage(undefined), false)
})

test('rejects a string', () => {
  assert.strictEqual(validateStoredMessage('hello'), false)
})

test('rejects an array', () => {
  assert.strictEqual(validateStoredMessage([]), false)
})

test('rejects a number', () => {
  assert.strictEqual(validateStoredMessage(42), false)
})

test('rejects message with missing role', () => {
  assert.strictEqual(validateStoredMessage({ content: 'hello' }), false)
})

test('rejects message with invalid role "system"', () => {
  assert.strictEqual(validateStoredMessage({ role: 'system', content: 'hello' }), false)
})

test('rejects message with numeric role', () => {
  assert.strictEqual(validateStoredMessage({ role: 1, content: 'hello' }), false)
})

test('rejects message with missing content', () => {
  assert.strictEqual(validateStoredMessage({ role: 'user' }), false)
})

test('rejects message with numeric content', () => {
  assert.strictEqual(validateStoredMessage({ role: 'user', content: 42 }), false)
})

test('rejects message with null content', () => {
  assert.strictEqual(validateStoredMessage({ role: 'user', content: null }), false)
})

test('accepts empty string content (valid shape)', () => {
  // Empty content passes shape validation — hydrateMessages preserves it
  assert.strictEqual(validateStoredMessage({ role: 'user', content: '' }), true)
})

// ── normalizeMessageId ────────────────────────────────────────────────────────

console.log('\nnormalizeMessageId — ID hydration\n')

test('returns null for invalid message (missing role)', () => {
  assert.strictEqual(normalizeMessageId({ content: 'hello' }), null)
})

test('returns null for null input', () => {
  assert.strictEqual(normalizeMessageId(null), null)
})

test('preserves existing string ID', () => {
  const result = normalizeMessageId({ role: 'user', content: 'hi', id: 'my-stable-id' })
  assert.strictEqual(result.id, 'my-stable-id')
})

test('generates ID when id is missing', () => {
  const result = normalizeMessageId({ role: 'user', content: 'hi' })
  assert.ok(typeof result.id === 'string' && result.id.length > 0, 'must generate a non-empty string ID')
})

test('generates ID when id is empty string', () => {
  const result = normalizeMessageId({ role: 'user', content: 'hi', id: '' })
  assert.ok(typeof result.id === 'string' && result.id.length > 0, 'must generate ID for empty-string id')
})

test('generates ID when id is whitespace only', () => {
  const result = normalizeMessageId({ role: 'user', content: 'hi', id: '   ' })
  assert.ok(typeof result.id === 'string' && result.id.trim().length > 0, 'whitespace-only id must be replaced')
})

test('generates ID when id is null', () => {
  const result = normalizeMessageId({ role: 'user', content: 'hi', id: null })
  assert.ok(typeof result.id === 'string' && result.id.length > 0)
})

test('generates ID when id is a number', () => {
  const result = normalizeMessageId({ role: 'user', content: 'hi', id: 5 })
  assert.ok(typeof result.id === 'string' && result.id.length > 0)
})

test('does not mutate source message', () => {
  const msg = { role: 'user', content: 'hello' }
  normalizeMessageId(msg)
  assert.strictEqual(msg.id, undefined, 'source object must not be mutated')
})

test('preserves all other fields on the returned message', () => {
  const msg = { role: 'assistant', content: 'reply', localOnly: true, truncated: true }
  const result = normalizeMessageId(msg)
  assert.strictEqual(result.role, 'assistant')
  assert.strictEqual(result.content, 'reply')
  assert.strictEqual(result.localOnly, true)
  assert.strictEqual(result.truncated, true)
})

// ── hydrateMessages ───────────────────────────────────────────────────────────

console.log('\nhydrateMessages — array normalization\n')

test('returns [] for non-array input', () => {
  assert.deepStrictEqual(hydrateMessages(null), [])
  assert.deepStrictEqual(hydrateMessages(undefined), [])
  assert.deepStrictEqual(hydrateMessages('string'), [])
  assert.deepStrictEqual(hydrateMessages({}), [])
})

test('returns [] for empty array', () => {
  assert.deepStrictEqual(hydrateMessages([]), [])
})

test('discards invalid messages', () => {
  const result = hydrateMessages([{ content: 'no role' }, null, { role: 'invalid', content: 'x' }])
  assert.deepStrictEqual(result, [])
})

test('passes valid messages through with IDs hydrated', () => {
  const result = hydrateMessages([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' },
  ])
  assert.strictEqual(result.length, 2)
  assert.ok(typeof result[0].id === 'string' && result[0].id.length > 0)
  assert.ok(typeof result[1].id === 'string' && result[1].id.length > 0)
})

test('preserves existing IDs', () => {
  const result = hydrateMessages([{ role: 'user', content: 'hi', id: 'stable' }])
  assert.strictEqual(result[0].id, 'stable')
})

test('mixed valid/invalid: only valid survive', () => {
  const result = hydrateMessages([
    { role: 'user', content: 'good' },
    { content: 'bad — no role' },
    { role: 'assistant', content: 'also good' },
    null,
  ])
  assert.strictEqual(result.length, 2)
  assert.strictEqual(result[0].content, 'good')
  assert.strictEqual(result[1].content, 'also good')
})

test('generates unique IDs for messages without IDs', () => {
  const result = hydrateMessages([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
  ])
  assert.notStrictEqual(result[0].id, result[1].id)
})

// ── parseStoredCurrentSession ─────────────────────────────────────────────────

console.log('\nparseStoredCurrentSession — full safe parsing\n')

test('returns [] for null', () => {
  assert.deepStrictEqual(parseStoredCurrentSession(null), [])
})

test('returns [] for undefined', () => {
  assert.deepStrictEqual(parseStoredCurrentSession(undefined), [])
})

test('returns [] for empty string', () => {
  assert.deepStrictEqual(parseStoredCurrentSession(''), [])
})

test('returns [] for whitespace-only string', () => {
  assert.deepStrictEqual(parseStoredCurrentSession('   '), [])
})

test('returns [] for malformed JSON', () => {
  assert.deepStrictEqual(parseStoredCurrentSession('{not json}'), [])
})

test('returns [] for plain string JSON (non-array)', () => {
  assert.deepStrictEqual(parseStoredCurrentSession('"hello"'), [])
})

test('returns [] for JSON null', () => {
  assert.deepStrictEqual(parseStoredCurrentSession('null'), [])
})

test('returns [] for JSON object (not array)', () => {
  assert.deepStrictEqual(parseStoredCurrentSession('{"role":"user","content":"hi"}'), [])
})

test('returns [] for JSON number', () => {
  assert.deepStrictEqual(parseStoredCurrentSession('42'), [])
})

test('returns [] for JSON array of invalid messages', () => {
  const raw = JSON.stringify([{ content: 'no role' }, null, 'string'])
  assert.deepStrictEqual(parseStoredCurrentSession(raw), [])
})

test('parses a valid message array', () => {
  const msgs = [
    { role: 'user', content: 'hello', id: 'u1' },
    { role: 'assistant', content: 'world', id: 'a1' },
  ]
  const result = parseStoredCurrentSession(JSON.stringify(msgs))
  assert.strictEqual(result.length, 2)
  assert.strictEqual(result[0].content, 'hello')
  assert.strictEqual(result[1].content, 'world')
})

test('preserves existing IDs from storage', () => {
  const msgs = [{ role: 'user', content: 'hello', id: 'persistent-id' }]
  const result = parseStoredCurrentSession(JSON.stringify(msgs))
  assert.strictEqual(result[0].id, 'persistent-id')
})

test('hydrates missing IDs for stored messages', () => {
  const msgs = [{ role: 'user', content: 'hello' }]
  const result = parseStoredCurrentSession(JSON.stringify(msgs))
  assert.ok(typeof result[0].id === 'string' && result[0].id.length > 0)
})

test('discards invalid messages in a mixed array', () => {
  const msgs = [
    { role: 'user', content: 'valid' },
    { role: 'system', content: 'invalid role' },
    { role: 'assistant', content: 'valid too', id: 'a1' },
  ]
  const result = parseStoredCurrentSession(JSON.stringify(msgs))
  assert.strictEqual(result.length, 2)
  assert.strictEqual(result[0].content, 'valid')
  assert.strictEqual(result[1].content, 'valid too')
})

test('never throws on any input type', () => {
  const inputs = [null, undefined, '', '{}', '[]', '{bad}', 42, [], {}, true]
  for (const input of inputs) {
    assert.doesNotThrow(() => parseStoredCurrentSession(input))
  }
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
