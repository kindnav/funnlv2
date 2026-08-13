// Zero-dependency Node.js tests for:
//   src/lib/pro-ui-status.js  — hasProAccess, classifyProStatus
//   src/lib/interactionFormUtils.js — shouldShowAIFill
//
// Run with: node tests/pro-ui-status.test.js

import { strict as assert } from 'assert'
import { test } from 'node:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { hasProAccess, classifyProStatus } from '../src/lib/pro-ui-status.js'
import { shouldShowAIFill } from '../src/lib/interactionFormUtils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PERMANENT_STATUS = {
  permanent_pro:          true,
  can_use_pro:            true,
  trial_active:           false,
  trial_expired:          false,
  trial_eligible:         false,
  subscription_active:    false,
  subscription_status:    null,
}

const SUBSCRIBED_STATUS = {
  permanent_pro:          false,
  can_use_pro:            true,
  trial_active:           false,
  trial_expired:          false,
  trial_eligible:         false,
  subscription_active:    true,
  subscription_status:    'active',
}

const PAST_DUE_STATUS = {
  ...SUBSCRIBED_STATUS,
  subscription_status:    'past_due',
}

const TRIAL_ACTIVE_STATUS = {
  permanent_pro:          false,
  can_use_pro:            true,
  trial_active:           true,
  trial_expired:          false,
  trial_eligible:         false,
  subscription_active:    false,
  subscription_status:    null,
}

const TRIAL_EXPIRED_STATUS = {
  permanent_pro:          false,
  can_use_pro:            false,
  trial_active:           false,
  trial_expired:          true,
  trial_eligible:         false,
  subscription_active:    false,
  subscription_status:    null,
}

const NON_PRO_STATUS = {
  permanent_pro:          false,
  can_use_pro:            false,
  trial_active:           false,
  trial_expired:          false,
  trial_eligible:         false,
  subscription_active:    false,
  subscription_status:    null,
}

const CANCELED_STATUS = {
  ...SUBSCRIBED_STATUS,
  subscription_active:    false,
  subscription_status:    'canceled',
  can_use_pro:            false,
}

// ── classifyProStatus: null / error / malformed ───────────────────────────────

await test('classifyProStatus: null (loading) → unavailable', () => {
  assert.strictEqual(classifyProStatus(null), 'unavailable')
})

await test("classifyProStatus: 'error' (RPC failed) → unavailable", () => {
  assert.strictEqual(classifyProStatus('error'), 'unavailable')
})

await test('classifyProStatus: empty object (missing both fields) → unavailable', () => {
  assert.strictEqual(classifyProStatus({}), 'unavailable')
})

await test('classifyProStatus: can_use_pro wrong type (string) → unavailable', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: 'yes', permanent_pro: false }), 'unavailable')
})

await test('classifyProStatus: permanent_pro wrong type (number) → unavailable', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: false, permanent_pro: 0 }), 'unavailable')
})

await test('classifyProStatus: non-object (number) → unavailable', () => {
  assert.strictEqual(classifyProStatus(42), 'unavailable')
})

// ── classifyProStatus: confirmed non-Pro ──────────────────────────────────────

await test('classifyProStatus: no trial, no subscription, no permanent → non_pro', () => {
  assert.strictEqual(classifyProStatus(NON_PRO_STATUS), 'non_pro')
})

await test('classifyProStatus: trial_eligible only (not started) → non_pro', () => {
  assert.strictEqual(classifyProStatus({ ...NON_PRO_STATUS, trial_eligible: true }), 'non_pro')
})

await test('classifyProStatus: canceled subscription → non_pro', () => {
  assert.strictEqual(classifyProStatus(CANCELED_STATUS), 'non_pro')
})

// ── classifyProStatus: expired ────────────────────────────────────────────────

await test('classifyProStatus: trial_expired=true, can_use_pro=false → expired', () => {
  assert.strictEqual(classifyProStatus(TRIAL_EXPIRED_STATUS), 'expired')
})

// ── classifyProStatus: trial ──────────────────────────────────────────────────

await test('classifyProStatus: can_use_pro=true, trial_active=true, not permanent → trial', () => {
  assert.strictEqual(classifyProStatus(TRIAL_ACTIVE_STATUS), 'trial')
})

// ── classifyProStatus: subscribed ─────────────────────────────────────────────

await test('classifyProStatus: subscription_active=true, status=active → subscribed', () => {
  assert.strictEqual(classifyProStatus(SUBSCRIBED_STATUS), 'subscribed')
})

await test('classifyProStatus: subscription_active=true, status=past_due → subscribed', () => {
  assert.strictEqual(classifyProStatus(PAST_DUE_STATUS), 'subscribed')
})

// ── classifyProStatus: permanent ──────────────────────────────────────────────

await test('classifyProStatus: permanent_pro=true → permanent', () => {
  assert.strictEqual(classifyProStatus(PERMANENT_STATUS), 'permanent')
})

await test('classifyProStatus: permanent wins over subscription_active', () => {
  assert.strictEqual(
    classifyProStatus({ ...SUBSCRIBED_STATUS, permanent_pro: true }),
    'permanent',
  )
})

await test('classifyProStatus: permanent wins over active trial fields', () => {
  assert.strictEqual(
    classifyProStatus({ ...TRIAL_ACTIVE_STATUS, permanent_pro: true }),
    'permanent',
  )
})

// ── hasProAccess: true cases ──────────────────────────────────────────────────

await test('hasProAccess: permanent Pro → true', () => {
  assert.strictEqual(hasProAccess(PERMANENT_STATUS), true)
})

await test('hasProAccess: active Stripe subscription → true', () => {
  assert.strictEqual(hasProAccess(SUBSCRIBED_STATUS), true)
})

await test('hasProAccess: past_due subscription → true', () => {
  assert.strictEqual(hasProAccess(PAST_DUE_STATUS), true)
})

await test('hasProAccess: active trial → true', () => {
  assert.strictEqual(hasProAccess(TRIAL_ACTIVE_STATUS), true)
})

// ── hasProAccess: false cases ─────────────────────────────────────────────────

await test('hasProAccess: null (loading) → false', () => {
  assert.strictEqual(hasProAccess(null), false)
})

await test("hasProAccess: 'error' (RPC failed) → false", () => {
  assert.strictEqual(hasProAccess('error'), false)
})

await test('hasProAccess: expired trial → false', () => {
  assert.strictEqual(hasProAccess(TRIAL_EXPIRED_STATUS), false)
})

await test('hasProAccess: non_pro → false', () => {
  assert.strictEqual(hasProAccess(NON_PRO_STATUS), false)
})

await test('hasProAccess: canceled subscription → false', () => {
  assert.strictEqual(hasProAccess(CANCELED_STATUS), false)
})

await test('hasProAccess: can_use_pro=false in otherwise-valid object → false', () => {
  assert.strictEqual(hasProAccess({ ...TRIAL_ACTIVE_STATUS, can_use_pro: false }), false)
})

await test('hasProAccess: missing can_use_pro field → false', () => {
  const { can_use_pro: _removed, ...rest } = PERMANENT_STATUS
  assert.strictEqual(hasProAccess(rest), false)
})

await test("hasProAccess: can_use_pro='true' (string) → false (strict === true)", () => {
  assert.strictEqual(hasProAccess({ ...TRIAL_ACTIVE_STATUS, can_use_pro: 'true' }), false)
})

await test('hasProAccess: unexpected string value → false', () => {
  assert.strictEqual(hasProAccess('permanent'), false)
})

await test('hasProAccess: number → false', () => {
  assert.strictEqual(hasProAccess(1), false)
})

await test('hasProAccess: empty object → false', () => {
  assert.strictEqual(hasProAccess({}), false)
})

// ── shouldShowAIFill ──────────────────────────────────────────────────────────

await test('shouldShowAIFill: permanent + add mode → true', () => {
  assert.strictEqual(shouldShowAIFill('permanent', false), true)
})

await test('shouldShowAIFill: trial + add mode → true', () => {
  assert.strictEqual(shouldShowAIFill('trial', false), true)
})

await test('shouldShowAIFill: subscribed + add mode → true (the bug fix)', () => {
  assert.strictEqual(shouldShowAIFill('subscribed', false), true)
})

await test('shouldShowAIFill: permanent + edit mode → false', () => {
  assert.strictEqual(shouldShowAIFill('permanent', true), false)
})

await test('shouldShowAIFill: trial + edit mode → false', () => {
  assert.strictEqual(shouldShowAIFill('trial', true), false)
})

await test('shouldShowAIFill: subscribed + edit mode → false', () => {
  assert.strictEqual(shouldShowAIFill('subscribed', true), false)
})

await test('shouldShowAIFill: expired → false', () => {
  assert.strictEqual(shouldShowAIFill('expired', false), false)
})

await test('shouldShowAIFill: non_pro → false', () => {
  assert.strictEqual(shouldShowAIFill('non_pro', false), false)
})

await test('shouldShowAIFill: unavailable (loading/error) → false', () => {
  assert.strictEqual(shouldShowAIFill('unavailable', false), false)
})

// ── Source-contract regression ────────────────────────────────────────────────
// Fails if any src file still uses the old combined access-gate pattern.
// The pattern is: === 'permanent' || someVar === 'trial'
// (indicates a hand-rolled allowlist rather than hasProAccess).
// Display-only comparisons — badge labels, ternary text — are isolated
// single checks (e.g. proClass === 'trial' ? 'TRIAL' : 'PRO') that
// do NOT combine with a paired === 'trial' term, so they are not matched.

const OLD_GATE_RE = /===\s*['"]permanent['"]\s*\|\|\s*\w+\s*===\s*['"]trial['"]/

function collectFiles(dir, exts, results = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectFiles(full, exts, results)
    } else if (exts.some(ext => entry.endsWith(ext))) {
      results.push(full)
    }
  }
  return results
}

await test('no src file uses the old permanent-or-trial gate pattern', () => {
  const srcDir = join(ROOT, 'src')
  const srcFiles = collectFiles(srcDir, ['.jsx', '.js'])
  const violations = []

  for (const file of srcFiles) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      // A line is a violation only if it matches the old combined gate pattern
      // AND does not also include 'subscribed' — the incomplete two-state form.
      // (interactionFormUtils.js legitimately lists all three states explicitly.)
      if (OLD_GATE_RE.test(line) && !line.includes("'subscribed'") && !line.includes('"subscribed"')) {
        const rel = file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file
        violations.push(`${rel}:${i + 1}: ${line.trim()}`)
      }
    })
  }

  assert.strictEqual(
    violations.length,
    0,
    `Found ${violations.length} file(s) still using the old permanent||trial gate pattern.\n` +
    `Replace with hasProAccess(proStatus) from src/lib/pro-ui-status.js:\n\n` +
    violations.map(v => `  ${v}`).join('\n'),
  )
})

console.log('pro-ui-status.test.js: all tests passed.')
