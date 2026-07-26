// Tests for sanitizeContactLinks and sanitizeAssistantReply.
// Pure Node.js — no DOM, no React, no Supabase.
//
// Run with: node tests/sanitize-reply.test.js

import assert from 'assert'
import { sanitizeContactLinks, sanitizeAssistantReply } from '../supabase/functions/ai-chat/sanitizeReply.js'

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

// ── Helper fixtures ───────────────────────────────────────────────────────────

const ALICE_ID = '11111111-1111-1111-1111-111111111111'
const BOB_ID   = '22222222-2222-2222-2222-222222222222'

const ALLOWED = [
  { id: ALICE_ID, name: 'Alice Smith' },
  { id: BOB_ID, name: 'Bob Jones' },
]

// ── sanitizeContactLinks ──────────────────────────────────────────────────────
console.log('\nsanitizeContactLinks — valid links retained')

test('valid contact link is preserved when UUID is in allowedContacts and label matches', () => {
  const md = `Meet [Alice Smith](/contacts/${ALICE_ID}) soon.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.strictEqual(result, md)
})

test('multiple valid contact links are all preserved', () => {
  const md = `[Alice Smith](/contacts/${ALICE_ID}) and [Bob Jones](/contacts/${BOB_ID}) both applied.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.strictEqual(result, md)
})

test('surrounding markdown text is preserved when link is valid', () => {
  const md = `I spoke with [Alice Smith](/contacts/${ALICE_ID}) about the role. She seemed interested.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.ok(result.includes('I spoke with'), 'text before link lost')
  assert.ok(result.includes('about the role'), 'text after link lost')
  assert.ok(result.includes(`[Alice Smith](/contacts/${ALICE_ID})`), 'valid link removed')
})

console.log('\nsanitizeContactLinks — invalid links become plain text')

test('unknown UUID not in allowedContacts is stripped to label', () => {
  const unknownId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const md = `Talk to [Alice Smith](/contacts/${unknownId}) later.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.ok(result.includes('Alice Smith'), 'label should be preserved')
  assert.ok(!result.includes(`/contacts/${unknownId}`), 'unknown link should be removed')
  assert.strictEqual(result, 'Talk to Alice Smith later.')
})

test('label that does not match stored name is stripped to label', () => {
  const md = `Talk to [Alicia Smith](/contacts/${ALICE_ID}) about it.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.ok(result.includes('Alicia Smith'), 'label should be preserved')
  assert.ok(!result.includes(`/contacts/${ALICE_ID}`), 'link with wrong label should be removed')
})

test('label match is case-insensitive (lowercase label is accepted)', () => {
  const md = `[alice smith](/contacts/${ALICE_ID}) replied.`
  const result = sanitizeContactLinks(md, ALLOWED)
  // Case-insensitive match — the link is valid and should be preserved
  assert.strictEqual(result, md)
})

test('malformed UUID (missing hex segments) is stripped to label', () => {
  const md = `[Alice Smith](/contacts/not-a-uuid) replied.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.strictEqual(result, 'Alice Smith replied.')
})

test('external URL is stripped to label', () => {
  const md = `Visit [Alice Smith](https://example.com/contacts/${ALICE_ID}) here.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.strictEqual(result, 'Visit Alice Smith here.')
})

test('javascript: URI is stripped to label', () => {
  const md = `[Alice Smith](javascript:void(0)) clicked.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.strictEqual(result, 'Alice Smith clicked.')
})

test('data: URI is stripped to label', () => {
  const md = `[Alice Smith](data:text/html,<script>alert(1)</script>) opened.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.strictEqual(result, 'Alice Smith opened.')
})

test('protocol-relative URL is stripped to label', () => {
  const md = `[Alice Smith](//evil.com/contacts/${ALICE_ID}) is here.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.strictEqual(result, 'Alice Smith is here.')
})

test('URL-encoded path bypass is stripped to label', () => {
  const md = `[Alice Smith](%2Fcontacts%2F${ALICE_ID}) clicked.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.strictEqual(result, 'Alice Smith clicked.')
})

test('invalid link does not break the rest of the answer', () => {
  const md = `Before. [Alice Smith](https://bad.com) middle. After.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.ok(result.includes('Before.'), 'text before link lost')
  assert.ok(result.includes('After.'), 'text after link lost')
  assert.ok(result.includes('Alice Smith'), 'label should be kept')
  assert.ok(!result.includes('https://bad.com'), 'bad URL should be removed')
})

test('two contacts with same name linked by correct IDs are both validated', () => {
  const id1 = '33333333-3333-3333-3333-333333333333'
  const id2 = '44444444-4444-4444-4444-444444444444'
  const contacts = [
    { id: id1, name: 'Alex Morgan' },
    { id: id2, name: 'Alex Morgan' },
  ]
  const md = `[Alex Morgan](/contacts/${id1}) and [Alex Morgan](/contacts/${id2}) both attended.`
  const result = sanitizeContactLinks(md, contacts)
  // Both links should be preserved (each is valid for its respective contact)
  assert.ok(result.includes(`/contacts/${id1}`), 'first valid link removed')
  assert.ok(result.includes(`/contacts/${id2}`), 'second valid link removed')
})

// ── sanitizeAssistantReply ────────────────────────────────────────────────────
console.log('\nsanitizeAssistantReply — em dash and en dash handling')

test('em dash (U+2014) is replaced with space-hyphen-space', () => {
  const reply = 'Meet her—she is great.'
  const result = sanitizeAssistantReply(reply)
  assert.ok(!result.includes('—'), 'em dash still present')
  assert.ok(result.includes(' - '), 'replacement not found')
})

test('en dash surrounded by spaces is replaced with space-hyphen-space', () => {
  const reply = 'This role – which is competitive – requires preparation.'
  const result = sanitizeAssistantReply(reply)
  assert.ok(!result.includes(' – '), 'sentence en dash still present')
  assert.ok((result.match(/ - /g) ?? []).length >= 2, 'both replacements not found')
})

test('en dash used as a range separator (no surrounding spaces) is preserved', () => {
  const reply = 'The program runs from 2020–2024 and covers pages 5–10.'
  const result = sanitizeAssistantReply(reply)
  assert.ok(result.includes('2020–2024'), 'year range en dash was removed')
  assert.ok(result.includes('5–10'), 'page range en dash was removed')
})

test('regular hyphen in a compound word is preserved', () => {
  const reply = 'This is a follow-up message about the well-known issue.'
  const result = sanitizeAssistantReply(reply)
  assert.strictEqual(result, reply)
})

test('ISO date hyphens are preserved', () => {
  const reply = 'The interaction on 2026-07-26 was productive.'
  const result = sanitizeAssistantReply(reply)
  assert.strictEqual(result, reply)
})

test('empty string returns empty string safely', () => {
  assert.strictEqual(sanitizeAssistantReply(''), '')
})

test('valid contact link markdown survives sanitizeAssistantReply unchanged', () => {
  const link = `[Alice Smith](/contacts/${ALICE_ID})`
  const reply = `You should follow up with ${link} soon.`
  const result = sanitizeAssistantReply(reply)
  assert.ok(result.includes(link), 'contact link was altered by sanitizeAssistantReply')
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
