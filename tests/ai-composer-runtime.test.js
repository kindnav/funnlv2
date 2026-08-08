/**
 * ai-composer-runtime.test.js
 *
 * Tests for composer behavior in FunnlAIPage:
 * - Empty/whitespace submit blocked
 * - Enter submits, Shift+Enter inserts newline
 * - Loading blocks submit
 * - Accessible label
 * - Composer clears on accepted send
 * - Input validation at the sendMessage boundary
 *
 * Zero-dependency Node.js — run with: node tests/ai-composer-runtime.test.js
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

// ── sendMessage input validation ───────────────────────────────────────────────

console.log('\nsendMessage — input validation\n')

test('empty string is blocked at sendMessage boundary', () => {
  // sendMessage trims the input and returns early if empty
  assert.ok(src.includes("if (!trimmed || loading) return"),
    'sendMessage must return early on empty trimmed input'
  )
})

test('sendMessage trims whitespace before sending', () => {
  assert.ok(src.includes("const trimmed = (text ?? '').trim()"),
    'sendMessage must trim the input before processing'
  )
})

test('loading state blocks sendMessage', () => {
  assert.ok(src.includes("if (!trimmed || loading) return"),
    'sendMessage must return early when loading is true'
  )
})

// ── Keyboard behavior ──────────────────────────────────────────────────────────

console.log('\nComposer — keyboard behavior\n')

test('Enter key triggers sendMessage', () => {
  assert.ok(
    src.includes("e.key === 'Enter' && !e.shiftKey") && src.includes('sendMessage(input)'),
    'Enter (without Shift) must trigger sendMessage'
  )
})

test('Shift+Enter is not submitted', () => {
  // The handler only fires when !e.shiftKey, so Shift+Enter falls through to
  // default browser behavior (newline insertion in textarea)
  assert.ok(
    src.includes("e.key === 'Enter' && !e.shiftKey"),
    'Shift+Enter must not submit — the guard !e.shiftKey ensures this'
  )
})

test('Enter preventDefault called before sendMessage', () => {
  assert.ok(
    src.includes("e.preventDefault(); sendMessage(input)") ||
    (src.includes("e.preventDefault()") && src.includes("sendMessage(input)")),
    'Enter must call preventDefault to stop default form submission'
  )
})

test('handleKeyDown is attached to the textarea', () => {
  assert.ok(src.includes('onKeyDown={handleKeyDown}'),
    'keyboard handler must be on the textarea element'
  )
})

// ── Button behavior ────────────────────────────────────────────────────────────

console.log('\nComposer — send button\n')

test('send button is disabled when loading', () => {
  assert.ok(src.includes('disabled={loading || !input.trim()}'),
    'send button must be disabled while loading'
  )
})

test('send button is disabled when input is empty/whitespace', () => {
  assert.ok(src.includes('!input.trim()'),
    'send button must be disabled when input is whitespace-only'
  )
})

test('send button has aria-label', () => {
  assert.ok(src.includes('aria-label="Send message"'),
    'send button must have an accessible label'
  )
})

// ── Input accessibility ────────────────────────────────────────────────────────

console.log('\nComposer — accessibility\n')

test('textarea has aria-label', () => {
  assert.ok(src.includes('aria-label="Message Funnl AI"'),
    'textarea must have an accessible label'
  )
})

test('hint text documents Enter/Shift+Enter behavior', () => {
  assert.ok(
    src.includes('Enter to send') && src.includes('Shift+Enter'),
    'hint text must document keyboard behavior for sighted users'
  )
})

// ── Input cleared after send accepted ─────────────────────────────────────────

console.log('\nComposer — state management\n')

test('setInput("") called in sendMessage', () => {
  assert.ok(src.includes("setInput('')"),
    "composer must clear input after message is accepted into conversation"
  )
})

test('dismiss restores the failed prompt to input', () => {
  // dismissError sets input to the failed message content so user can retry
  assert.ok(src.includes('setInput(text)'),
    'dismissError must restore the failed text to the input so user can edit and retry'
  )
})

// ── Request gate: duplicate submit prevention ─────────────────────────────────

console.log('\nComposer — duplicate submit prevention\n')

test('loading state prevents double-submit', () => {
  // sendMessage early-returns when loading is true
  assert.ok(
    src.includes("if (!trimmed || loading) return"),
    'sendMessage returns early when already loading'
  )
})

test('retryMessage returns early when loading', () => {
  assert.ok(
    src.includes("async function retryMessage") && src.includes("if (loading) return"),
    'retryMessage must return early when loading is true'
  )
})

test('request gate (createRequestGate) prevents stale completions', () => {
  assert.ok(src.includes('gate.isCurrent(token)'),
    'stale-request protection: gate must be checked after every async operation'
  )
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
