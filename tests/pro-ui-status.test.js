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

// ── classifyProStatus: contradictory shapes → unavailable ─────────────────────
// An access-granting flag that disagrees with can_use_pro=false is internally
// inconsistent. classifyProStatus must NOT render a Pro label — it falls back to
// 'unavailable' so the canonical gate (hasProAccess/can_use_pro) is never overridden
// by a stale or malformed display flag.

await test('classifyProStatus: subscription_active=true but can_use_pro=false → unavailable', () => {
  assert.strictEqual(
    classifyProStatus({ ...SUBSCRIBED_STATUS, can_use_pro: false }),
    'unavailable',
  )
})

await test('classifyProStatus: permanent_pro=true but can_use_pro=false → unavailable', () => {
  assert.strictEqual(
    classifyProStatus({ ...PERMANENT_STATUS, can_use_pro: false }),
    'unavailable',
  )
})

await test('classifyProStatus: trial_active=true but can_use_pro=false → unavailable', () => {
  assert.strictEqual(
    classifyProStatus({ ...TRIAL_ACTIVE_STATUS, can_use_pro: false }),
    'unavailable',
  )
})

await test('classifyProStatus: multiple grant flags but can_use_pro=false → unavailable', () => {
  assert.strictEqual(
    classifyProStatus({
      permanent_pro: true, subscription_active: true, trial_active: true, can_use_pro: false,
    }),
    'unavailable',
  )
})

// ── R4: inverse contradiction (can_use_pro true, no grant flag) → unavailable ──
await test('classifyProStatus: can_use_pro=true but NO grant flag → unavailable (inverse)', () => {
  assert.strictEqual(
    classifyProStatus({ can_use_pro: true, permanent_pro: false, subscription_active: false, trial_active: false }),
    'unavailable',
  )
})
await test('classifyProStatus: can_use_pro=true, only trial_expired true (no grant) → unavailable', () => {
  assert.strictEqual(
    classifyProStatus({ can_use_pro: true, permanent_pro: false, subscription_active: false, trial_active: false, trial_expired: true }),
    'unavailable',
  )
})

// ── R4: malformed field values → unavailable ──────────────────────────────────
await test('classifyProStatus: subscription_active non-boolean → unavailable', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: false, permanent_pro: false, subscription_active: 'yes' }), 'unavailable')
})
await test('classifyProStatus: trial_active non-boolean → unavailable', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: false, permanent_pro: false, trial_active: 1 }), 'unavailable')
})
await test('classifyProStatus: trial_expired non-boolean → unavailable', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: false, permanent_pro: false, trial_expired: 'no' }), 'unavailable')
})
await test('classifyProStatus: cancel_at_period_end non-boolean → unavailable', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: true, permanent_pro: true, cancel_at_period_end: 'x' }), 'unavailable')
})
await test('classifyProStatus: unknown subscription_status string → unavailable', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: false, permanent_pro: false, subscription_status: 'wat' }), 'unavailable')
})
await test('classifyProStatus: null subscription_status is tolerated (treated as none)', () => {
  assert.strictEqual(classifyProStatus({ can_use_pro: false, permanent_pro: false, subscription_status: null }), 'non_pro')
})

// ── R4: valid coexisting combinations preserved ───────────────────────────────
await test('classifyProStatus: subscribed coexists with expired Funnl trial → subscribed', () => {
  assert.strictEqual(
    classifyProStatus({ can_use_pro: true, permanent_pro: false, subscription_active: true, trial_active: false, trial_expired: true, subscription_status: 'active' }),
    'subscribed',
  )
})
await test('classifyProStatus: cancel_at_period_end=true does not remove subscription access', () => {
  assert.strictEqual(
    classifyProStatus({ can_use_pro: true, permanent_pro: false, subscription_active: true, cancel_at_period_end: true, subscription_status: 'active' }),
    'subscribed',
  )
})
await test('classifyProStatus: permanent + subscription both active → permanent (priority)', () => {
  assert.strictEqual(
    classifyProStatus({ can_use_pro: true, permanent_pro: true, subscription_active: true, subscription_status: 'active' }),
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
// New signature: shouldShowAIFill(proStatus, isEditMode) → hasProAccess(proStatus).

await test('shouldShowAIFill: permanent + add mode → true', () => {
  assert.strictEqual(shouldShowAIFill(PERMANENT_STATUS, false), true)
})

await test('shouldShowAIFill: trial + add mode → true', () => {
  assert.strictEqual(shouldShowAIFill(TRIAL_ACTIVE_STATUS, false), true)
})

await test('shouldShowAIFill: subscribed + add mode → true', () => {
  assert.strictEqual(shouldShowAIFill(SUBSCRIBED_STATUS, false), true)
})

await test('shouldShowAIFill: permanent + edit mode → false', () => {
  assert.strictEqual(shouldShowAIFill(PERMANENT_STATUS, true), false)
})

await test('shouldShowAIFill: trial + edit mode → false', () => {
  assert.strictEqual(shouldShowAIFill(TRIAL_ACTIVE_STATUS, true), false)
})

await test('shouldShowAIFill: subscribed + edit mode → false', () => {
  assert.strictEqual(shouldShowAIFill(SUBSCRIBED_STATUS, true), false)
})

await test('shouldShowAIFill: expired → false', () => {
  assert.strictEqual(shouldShowAIFill(TRIAL_EXPIRED_STATUS, false), false)
})

await test('shouldShowAIFill: non_pro → false', () => {
  assert.strictEqual(shouldShowAIFill(NON_PRO_STATUS, false), false)
})

await test('shouldShowAIFill: null (loading) / error → false', () => {
  assert.strictEqual(shouldShowAIFill(null, false), false)
  assert.strictEqual(shouldShowAIFill('error', false), false)
})

// ── Canonical Pro-access source contract ──────────────────────────────────────
// The architectural rule: every ACCESS GATE must be computed via hasProAccess().
// classifyProStatus() is display-only. A hand-written entitlement-state allowlist
// assigned to an access-gate variable (canUsePro / isProUser / canUseAI / isPro /
// showAIFill) is the exact regression that caused the paid-user lockout — it must
// fail this test even when 'subscribed' is included.

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

// Access-gate identifiers. An assignment to any of these whose right-hand side
// compares against an entitlement-state string literal is a hand-written allowlist.
const ACCESS_VARS = ['canUsePro', 'isProUser', 'canUseAI', 'isPro', 'showAIFill']
const STATE_LITERALS = ['permanent', 'trial', 'subscribed', 'expired', 'non_pro']
// Matches:  <accessVar> = ... === 'state' ...   (any number of states, any order)
const ALLOWLIST_ASSIGN_RE = new RegExp(
  `\\b(?:${ACCESS_VARS.join('|')})\\b\\s*=\\s*(?!=)[^\\n]*===\\s*['"](?:${STATE_LITERALS.join('|')})['"]`,
)

await test('C5: no src file assigns an access-gate variable from an entitlement-state allowlist', () => {
  const srcFiles = collectFiles(join(ROOT, 'src'), ['.jsx', '.js'])
  const violations = []
  for (const file of srcFiles) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (ALLOWLIST_ASSIGN_RE.test(line)) {
        const rel = file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file
        violations.push(`${rel}:${i + 1}: ${line.trim()}`)
      }
    })
  }
  assert.strictEqual(
    violations.length, 0,
    `Found ${violations.length} hand-written access-gate allowlist(s). ` +
    `Access gates must use hasProAccess(proStatus):\n\n` +
    violations.map(v => `  ${v}`).join('\n'),
  )
})

await test('C5: the three shell/AI access gates are computed via hasProAccess', () => {
  const files = {
    'src/pages/FunnlAIPage.jsx':      /isProUser\s*=\s*hasProAccess\(/,
    'src/components/BottomNav.jsx':    /canUsePro\s*=\s*hasProAccess\(/,
    'src/components/CommandPalette.jsx': /canUsePro\s*=\s*hasProAccess\(/,
  }
  const missing = []
  for (const [rel, re] of Object.entries(files)) {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    if (!re.test(src)) missing.push(rel)
  }
  assert.strictEqual(missing.length, 0,
    `These access gates must be computed via hasProAccess(): ${missing.join(', ')}`)
})

console.log('pro-ui-status.test.js: all tests passed.')
