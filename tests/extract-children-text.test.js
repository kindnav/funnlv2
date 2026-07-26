// Tests for extractChildrenText — the helper used by FunnlAIPage to generate
// accessible aria-label text from React children.
// Pure Node.js — no DOM, no React, no JSX.
// React elements are plain objects with a `props` property; this file constructs
// them directly to avoid any build toolchain dependency.
//
// Run with: node tests/extract-children-text.test.js

import assert from 'assert'
import { extractChildrenText } from '../src/lib/extractChildrenText.js'

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

// ── extractChildrenText ───────────────────────────────────────────────────────
console.log('\nextractChildrenText')

test('simple string child returns the string', () => {
  assert.strictEqual(extractChildrenText('Ryan Miller'), 'Ryan Miller')
})

test('array of string children are joined into one string', () => {
  // ReactMarkdown passes strong/em inline elements as arrays of children
  assert.strictEqual(extractChildrenText(['Alice', ' ', 'Smith']), 'Alice Smith')
})

test('nested React element (object with props.children) is traversed', () => {
  // Simulates a React element: { props: { children: 'Alice Smith' } }
  const element = { props: { children: 'Alice Smith' } }
  assert.strictEqual(extractChildrenText(element), 'Alice Smith')
})

test('null, undefined, and boolean children return empty string (aria fallback to "Open contact details")', () => {
  assert.strictEqual(extractChildrenText(null), '')
  assert.strictEqual(extractChildrenText(undefined), '')
  assert.strictEqual(extractChildrenText(true), '')
  assert.strictEqual(extractChildrenText(false), '')
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
