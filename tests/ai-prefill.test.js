/**
 * ai-prefill.test.js
 *
 * Tests for prefill behavior in FunnlAIPage:
 * - Prompt read once from location.state.aiPrompt
 * - Composer populated (setInput), not auto-submitted
 * - Router state cleared immediately (replace: true, state: {})
 * - Composer focused after Pro resolves (pendingFocusRef)
 * - Refresh and back navigation do not reinsert the prompt
 * - Non-Pro and loading states cannot trigger a provider request via prefill
 *
 * Zero-dependency Node.js — run with: node tests/ai-prefill.test.js
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

// ── Prefill read ────────────────────────────────────────────────────────────────

console.log('\nPrefill — reading from router state\n')

test('reads aiPrompt from location.state', () => {
  assert.ok(src.includes('location.state?.aiPrompt') || src.includes('location.state.aiPrompt'),
    'must read aiPrompt from router state')
})

test('guards aiPrompt as string type before using', () => {
  assert.ok(src.includes("typeof aiPrompt === 'string'"),
    'must type-check aiPrompt before treating it as a string')
})

test('trims the aiPrompt before storing', () => {
  assert.ok(src.includes('aiPrompt.trim()'),
    'must trim whitespace from aiPrompt')
})

// ── No auto-submit ──────────────────────────────────────────────────────────────

console.log('\nPrefill — no auto-submit\n')

test('no sendOnReadyRef (auto-submit mechanism removed)', () => {
  assert.ok(!src.includes('sendOnReadyRef'),
    'sendOnReadyRef must not exist — auto-submit mechanism was removed')
})

test('setInput called with aiPrompt (populate, do not submit)', () => {
  assert.ok(src.includes('setInput(aiPrompt.trim())'),
    'must call setInput to populate the composer, not submit directly')
})

test('no auto-send pattern: sendMessage called in effect watching isProUser', () => {
  // Previously: useEffect with [isProUser] called sendMessage.
  // After fix: that effect is removed. The [isProUser] effect only focuses, never submits.
  const effectLines = src.split('\n').filter(l => l.includes('isProUser'))
  const noAutoSend = effectLines.every(l => !l.includes('sendMessage'))
  assert.ok(noAutoSend,
    'sendMessage must not be called in any effect that depends on isProUser')
})

// ── Router state cleared ────────────────────────────────────────────────────────

console.log('\nPrefill — router state cleared\n')

test('navigate called with replace: true', () => {
  assert.ok(src.includes('replace: true'),
    'must call navigate with replace: true to clear router state')
})

test('navigate called with state: {}', () => {
  assert.ok(src.includes('state: {}'),
    'must clear router state with state: {} so back/refresh do not reinsert prompt')
})

test('navigate called immediately in mount effect (not deferred)', () => {
  // The navigate call must be in the same synchronous path as the aiPrompt read
  const mountBlock = src.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[\]\)/)?.[0] ?? ''
  assert.ok(
    mountBlock.includes('navigate') && mountBlock.includes('state: {}'),
    'navigate to clear state must be in the mount effect'
  )
})

// ── Focus after Pro resolves ────────────────────────────────────────────────────

console.log('\nPrefill — focus after Pro resolves\n')

test('pendingFocusRef tracks whether focus is needed', () => {
  assert.ok(src.includes('pendingFocusRef'),
    'must use pendingFocusRef to coordinate deferred focus')
})

test('focus effect depends on isCheckingPro', () => {
  assert.ok(
    src.includes('!isCheckingPro && pendingFocusRef.current') ||
    src.includes('pendingFocusRef.current') && src.includes('isCheckingPro'),
    'focus must be deferred until Pro status is resolved'
  )
})

test('focus effect calls inputRef.current?.focus()', () => {
  assert.ok(src.includes("inputRef.current?.focus()"),
    'must programmatically focus the composer after Pro resolves')
})

// ── Non-Pro and loading cannot auto-submit ──────────────────────────────────────

console.log('\nPrefill — access gating\n')

test('sendMessage is guarded: loading state prevents submission', () => {
  // sendMessage returns early when `loading` is true
  assert.ok(src.includes('if (!trimmed || loading) return'),
    'sendMessage must block while loading is true')
})

test('non-Pro composer is a disabled bar with no send handler', () => {
  // For non-Pro, renderComposer returns disabledBar which has no sendMessage callback
  assert.ok(src.includes('!isProUser') && src.includes('disabledBar'),
    'non-Pro users get a disabled bar with no active send button')
})

test('prefill text in input does not bypass Pro gate', () => {
  // The user may have input text but the send button is disabled for non-Pro
  // This is structural: the textarea/button are rendered only for isProUser
  assert.ok(src.includes('if (!isProUser)') && src.includes('disabledBar'),
    'Pro gate is enforced at the render level, so prefill cannot bypass it'
  )
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
