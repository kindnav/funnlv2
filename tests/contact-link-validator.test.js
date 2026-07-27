// Tests for isValidContactLink — the shared URL validator used by FunnlAIPage.jsx.
// Pure Node.js — no DOM, no React.
//
// Run with: node tests/contact-link-validator.test.js

import assert from 'assert'
import { isValidContactLink } from '../src/lib/contactLinkValidator.js'

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

// ── isValidContactLink ────────────────────────────────────────────────────────
console.log('\nisValidContactLink')

const VALID_UUID = '11111111-1111-1111-1111-111111111111'

test('valid internal contact path returns true', () => {
  assert.strictEqual(isValidContactLink(`/contacts/${VALID_UUID}`), true)
})

test('external URL returns false', () => {
  assert.strictEqual(isValidContactLink(`https://evil.com/contacts/${VALID_UUID}`), false)
})

test('javascript: URI returns false', () => {
  assert.strictEqual(isValidContactLink('javascript:void(0)'), false)
})

test('data: URI returns false', () => {
  assert.strictEqual(isValidContactLink('data:text/html,<h1>hi</h1>'), false)
})

test('path without valid UUID format returns false', () => {
  assert.strictEqual(isValidContactLink('/contacts/not-a-uuid'), false)
})

test('path with uppercase UUID returns false (server always canonicalises to lowercase)', () => {
  assert.strictEqual(isValidContactLink('/contacts/11111111-1111-1111-1111-11111111111A'), false)
})

test('contact path with query string returns false', () => {
  assert.strictEqual(isValidContactLink('/contacts/11111111-1111-1111-1111-111111111111?foo=bar'), false)
})

test('contact path with URL fragment returns false', () => {
  assert.strictEqual(isValidContactLink('/contacts/11111111-1111-1111-1111-111111111111#section'), false)
})

test('contact path with trailing slash returns false', () => {
  assert.strictEqual(isValidContactLink('/contacts/11111111-1111-1111-1111-111111111111/'), false)
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
