/**
 * ai-page-access.test.js
 *
 * Tests for all six Pro access states using classifyProStatus() from pro-ui-status.js,
 * plus static assertions about FunnlAIPage's access-gating implementation.
 *
 * The six states:
 *   1. Loading      — proStatus === null (RPC not yet resolved)
 *   2. Unavailable  — proStatus === 'error' or malformed object (RPC failed)
 *   3. Permanent    — permanent_pro: true
 *   4. Trial        — can_use_pro: true && trial_active: true
 *   5. Expired      — trial_expired: true (no permanent, no active trial)
 *   6. Non-Pro      — confirmed: no trial, no permanent access
 *
 * Zero-dependency Node.js — run with: node tests/ai-page-access.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { classifyProStatus } from '../src/lib/pro-ui-status.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const aiSrc = readFileSync(join(__dir, '..', 'src', 'pages', 'FunnlAIPage.jsx'), 'utf8')

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

// ── State 1: Loading (null) ────────────────────────────────────────────────────

console.log('\nclassifyProStatus — Loading state (null)\n')

test('null → unavailable', () => {
  assert.strictEqual(classifyProStatus(null), 'unavailable')
})

test('loading state is unavailable, not permanent or trial', () => {
  const s = classifyProStatus(null)
  assert.notStrictEqual(s, 'permanent')
  assert.notStrictEqual(s, 'trial')
})

// ── State 2: Unavailable (error / malformed) ───────────────────────────────────

console.log('\nclassifyProStatus — Unavailable state (error/malformed)\n')

test('"error" → unavailable', () => {
  assert.strictEqual(classifyProStatus('error'), 'unavailable')
})

test('unexpected string → unavailable', () => {
  assert.strictEqual(classifyProStatus('pending'), 'unavailable')
})

test('number → unavailable', () => {
  assert.strictEqual(classifyProStatus(42), 'unavailable')
})

test('object missing can_use_pro → unavailable', () => {
  assert.strictEqual(classifyProStatus({ permanent_pro: true }), 'unavailable')
})

test('object missing permanent_pro → unavailable', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: true }), 'unavailable')
})

test('object with wrong-typed fields → unavailable', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: 1, permanent_pro: 'yes' }), 'unavailable')
})

// ── State 3: Permanent ─────────────────────────────────────────────────────────

console.log('\nclassifyProStatus — Permanent state\n')

test('permanent_pro: true → permanent', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: true, permanent_pro: true, trial_active: false }), 'permanent')
})

test('permanent takes priority over trial_active', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: true, permanent_pro: true, trial_active: true }), 'permanent')
})

test('permanent takes priority over trial_expired', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: true, permanent_pro: true, trial_expired: true }), 'permanent')
})

// ── State 4: Trial ─────────────────────────────────────────────────────────────

console.log('\nclassifyProStatus — Trial state\n')

test('can_use_pro: true, trial_active: true → trial', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: true, permanent_pro: false, trial_active: true }), 'trial')
})

test('trial state enables access (same as permanent for gating)', () => {
  const s = classifyProStatus({ can_use_pro: true, permanent_pro: false, trial_active: true })
  assert.ok(s === 'trial' || s === 'permanent')
})

// ── State 5: Expired ──────────────────────────────────────────────────────────

console.log('\nclassifyProStatus — Expired state\n')

test('trial_expired: true, no active access → expired', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: false, permanent_pro: false, trial_expired: true }), 'expired')
})

test('expired state does not enable access', () => {
  const s = classifyProStatus({ can_use_pro: false, permanent_pro: false, trial_expired: true })
  assert.notStrictEqual(s, 'permanent')
  assert.notStrictEqual(s, 'trial')
})

// ── State 6: Non-Pro ───────────────────────────────────────────────────────────

console.log('\nclassifyProStatus — Non-Pro state\n')

test('no trial, no permanent → non_pro', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: false, permanent_pro: false }), 'non_pro')
})

test('non_pro does not enable access', () => {
  const s = classifyProStatus({ can_use_pro: false, permanent_pro: false })
  assert.notStrictEqual(s, 'permanent')
  assert.notStrictEqual(s, 'trial')
})

// ── Static assertions: FunnlAIPage access-gating ──────────────────────────────

console.log('\nFunnlAIPage static assertions — access gating\n')

test('loading state: renders spinner before Pro resolves', () => {
  assert.ok(aiSrc.includes('isCheckingPro') && aiSrc.includes('animate-spin'),
    'must show a spinner while proStatus is null')
})

test('loading state: does not flash Pro UI before resolving', () => {
  // The component returns early (spinner) when isCheckingPro is true,
  // so the full chat UI is never rendered before Pro status is known
  assert.ok(aiSrc.includes('if (isCheckingPro)'), 'must early-return the spinner')
})

test('unavailable state: shows retry button', () => {
  assert.ok(aiSrc.includes("displayStatus === 'unavailable'") && aiSrc.includes('retryProStatus'),
    'must show Retry when status is unavailable')
})

test('unavailable state: no Pro lock (neutral message)', () => {
  assert.ok(aiSrc.includes('Pro status unavailable'), 'must show neutral unavailable message, not an upgrade prompt')
})

test('expired state: shows trial-ended message', () => {
  assert.ok(aiSrc.includes('trial has ended') || aiSrc.includes('trial_expired'),
    'must show trial-ended message for expired state')
})

test('non-Pro state: shows upgrade message', () => {
  assert.ok(aiSrc.includes('AI only available for Pro'),
    'must show upgrade message for non-Pro users')
})

test('permanent state: shows PRO badge', () => {
  assert.ok(
    aiSrc.includes("displayStatus === 'permanent'") &&
    (aiSrc.includes("'PRO'") || aiSrc.includes('>PRO<') || aiSrc.includes('  PRO')),
    'must render PRO badge for permanent users')
})

test('trial state: shows DAYS LEFT countdown', () => {
  assert.ok(aiSrc.includes("displayStatus === 'trial'") && aiSrc.includes('DAYS LEFT'),
    'must render DAYS LEFT for trial users')
})

test('isProUser gating combines permanent and trial', () => {
  assert.ok(
    aiSrc.includes("displayStatus === 'permanent' || displayStatus === 'trial'"),
    "isProUser must accept both 'permanent' and 'trial'"
  )
})

test('composer is disabled for unavailable state', () => {
  assert.ok(aiSrc.includes("displayStatus === 'unavailable'") && aiSrc.includes('disabledBar'),
    'must disable composer for unavailable status')
})

test('composer is disabled for non-Pro', () => {
  assert.ok(aiSrc.includes('!isProUser') && aiSrc.includes('disabledBar'),
    'must disable composer for non-Pro users')
})

test('no AI request possible when access is unresolved', () => {
  // The sendMessage function is only called from the active composer (isProUser guard)
  // and starter prompts (shown only when isProUser). When loading or unavailable,
  // the composer shows a disabled bar with no submit path.
  assert.ok(aiSrc.includes('if (!isProUser)') && aiSrc.includes('disabledBar'),
    'non-Pro path must render disabled bar with no submit path')
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
