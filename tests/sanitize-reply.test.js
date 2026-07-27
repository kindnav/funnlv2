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

test('label match is case-insensitive: output uses stored contact name casing', () => {
  const md = `[alice smith](/contacts/${ALICE_ID}) replied.`
  const result = sanitizeContactLinks(md, ALLOWED)
  // Case-insensitive comparison accepts the match; output is canonicalised to stored-name casing
  assert.ok(result.includes(`[Alice Smith](/contacts/${ALICE_ID})`), 'canonical link not in output')
  assert.ok(!result.includes('[alice smith]'), 'lowercase label was not corrected to stored casing')
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

// UUID fixture with hex letters so toUpperCase() produces a visibly different string
const CHARLIE_ID   = 'aabbccdd-eeff-1122-3344-556677889900'
const CHARLIE_ID_U = CHARLIE_ID.toUpperCase()  // 'AABBCCDD-EEFF-1122-3344-556677889900'
const ALLOWED_EXTRA = [
  ...ALLOWED,
  { id: CHARLIE_ID, name: 'Charlie Brown' },
]

console.log('\nsanitizeContactLinks — canonicalisation')

test('uppercase UUID in model output is normalised to lowercase in the canonical link', () => {
  // CONTACT_PATH_RE accepts mixed-case UUIDs via the i flag; output is always lowercase
  const md = `[Charlie Brown](/contacts/${CHARLIE_ID_U}) is great.`
  const result = sanitizeContactLinks(md, ALLOWED_EXTRA)
  assert.ok(result.includes(`/contacts/${CHARLIE_ID}`), 'lowercase canonical UUID not in output')
  assert.ok(!result.includes(CHARLIE_ID_U), 'uppercase UUID leaked into output')
})

test('model label with different casing is replaced with exact stored name in canonical output', () => {
  const md = `[ALICE SMITH](/contacts/${ALICE_ID}) replied.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.ok(result.includes('[Alice Smith]'), 'stored-name casing not used in canonical link')
  assert.ok(!result.includes('[ALICE SMITH]'), 'model casing was not corrected')
})

test('contact path with query parameter is rejected to plain text', () => {
  const md = `[Alice Smith](/contacts/${ALICE_ID}?foo=bar) is here.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.ok(result.includes('Alice Smith'), 'label should be preserved')
  assert.ok(!result.includes('?foo=bar'), 'query parameter should be stripped')
  assert.ok(!result.includes(`/contacts/${ALICE_ID}`), 'contact path with query param should be rejected')
})

test('contact path with URL fragment is rejected to plain text', () => {
  const md = `[Alice Smith](/contacts/${ALICE_ID}#section) called.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.ok(result.includes('Alice Smith'), 'label should be preserved')
  assert.ok(!result.includes('#section'), 'fragment should be stripped')
  assert.ok(!result.includes(`/contacts/${ALICE_ID}`), 'contact path with fragment should be rejected')
})

test('contact path with trailing slash is rejected to plain text', () => {
  const md = `[Alice Smith](/contacts/${ALICE_ID}/) replied.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.ok(result.includes('Alice Smith'), 'label should be preserved')
  assert.ok(!result.includes(`/contacts/${ALICE_ID}/`), 'trailing slash path should be rejected')
})

console.log('\nsanitizeContactLinks — first-mention-only')

test('first valid mention of a contact receives the canonical link', () => {
  const md = `Reach out to [Alice Smith](/contacts/${ALICE_ID}) soon.`
  const result = sanitizeContactLinks(md, ALLOWED)
  assert.ok(result.includes(`[Alice Smith](/contacts/${ALICE_ID})`), 'first mention should be a canonical link')
})

test('second mention of the same contact ID is downgraded to plain stored name', () => {
  const md = `[Alice Smith](/contacts/${ALICE_ID}) replied. Message [Alice Smith](/contacts/${ALICE_ID}) again.`
  const result = sanitizeContactLinks(md, ALLOWED)
  // Exactly one markdown link for Alice
  const linkCount = (result.match(/\[Alice Smith\]/g) ?? []).length
  assert.strictEqual(linkCount, 1, 'only the first mention should be a markdown link')
  // Second mention appears as plain text
  assert.ok(result.includes('Message Alice Smith again.'), 'second mention should be plain stored name')
})

test('invalid first attempt (wrong label) does not prevent later valid mention from being linked', () => {
  // First occurrence has a wrong label — fails validation, not added to linkedIds
  // Second occurrence has the correct label — should receive the canonical link
  const md = `[Alicia Smith](/contacts/${ALICE_ID}) is wrong. Later [Alice Smith](/contacts/${ALICE_ID}) is right.`
  const result = sanitizeContactLinks(md, ALLOWED)
  // Invalid first attempt → plain text label
  assert.ok(result.includes('Alicia Smith is wrong.'), 'invalid label should become plain text')
  // Later valid mention → canonical link (linkedIds not consumed by the failed attempt)
  assert.ok(result.includes(`[Alice Smith](/contacts/${ALICE_ID})`), 'later valid mention should be linked')
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

test('em dash surrounded by spaces produces no double spaces', () => {
  const reply = 'First point — second point.'
  const result = sanitizeAssistantReply(reply)
  assert.ok(!result.includes('—'), 'em dash still present')
  assert.ok(!result.includes('  '), 'double space produced by replacement')
  assert.strictEqual(result, 'First point - second point.')
})

test('multiple em dashes in one reply are all replaced', () => {
  const reply = 'One—two—three.'
  const result = sanitizeAssistantReply(reply)
  assert.ok(!result.includes('—'), 'em dash still present after multi-replace')
  assert.ok(result.includes(' - '), 'at least one replacement should exist')
})

test('em dash at start of string is removed without leaving the em dash character', () => {
  const reply = '—Starting thought here.'
  const result = sanitizeAssistantReply(reply)
  assert.ok(!result.includes('—'), 'em dash at string start should be removed')
  assert.ok(result.includes('Starting thought here.'), 'content after em dash should be preserved')
})

console.log('\nsanitizeAssistantReply — multiline Markdown structure preserved')

test('em dash within first paragraph does not consume the double-newline paragraph break', () => {
  const reply = 'First paragraph—this part.\n\nSecond paragraph.'
  const result = sanitizeAssistantReply(reply)
  assert.ok(!result.includes('—'), 'em dash still present')
  assert.ok(result.includes('\n\nSecond paragraph.'), 'double-newline paragraph break was consumed')
})

test('em dash within a Markdown list item does not consume the newline before the next item', () => {
  const reply = '- item one—note here\n- item two'
  const result = sanitizeAssistantReply(reply)
  assert.ok(!result.includes('—'), 'em dash still present')
  assert.ok(result.includes('\n- item two'), 'newline before list item was consumed')
})

test('em dash at start of reply produces no leading horizontal whitespace', () => {
  const reply = '—Starting the reply.'
  const result = sanitizeAssistantReply(reply)
  assert.ok(!result.startsWith(' ') && !result.startsWith('\t'), 'leading horizontal whitespace from boundary em dash')
  assert.ok(!result.includes('—'), 'em dash should be removed')
})

test('em dash at end of reply produces no trailing horizontal whitespace', () => {
  const reply = 'End of reply—'
  const result = sanitizeAssistantReply(reply)
  assert.ok(!result.endsWith(' ') && !result.endsWith('\t'), 'trailing horizontal whitespace from boundary em dash')
  assert.ok(!result.includes('—'), 'em dash should be removed')
})

test('spaced en dash within a list item does not consume the newline before the next item', () => {
  const reply = 'Overview:\n- role – which matters\n- next item'
  const result = sanitizeAssistantReply(reply)
  assert.ok(!result.includes(' – '), 'sentence-punctuation en dash still present')
  assert.ok(result.includes('\n- next item'), 'newline before list item was consumed by en dash replacement')
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
