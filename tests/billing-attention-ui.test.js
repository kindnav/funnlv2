/**
 * R6 tests: billing-attention is shown WITH the access label (not masked by it), and
 * a normal Subscribe button is never shown for a status the backend blocks/reuse-onlys.
 * Access is never changed — hasProAccess() remains the only gate.
 *
 * Combines classification tests (classifyProStatus + subscriptionAttentionState) with
 * source-contract checks that SettingsPage/FunnlAIPage render the notice for access
 * states too.
 *
 * Zero deps — runs with: node tests/billing-attention-ui.test.js
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { classifyProStatus, hasProAccess } from '../src/lib/pro-ui-status.js'
import { subscriptionAttentionState } from '../src/lib/subscriptionStatusPolicy.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0, failed = 0
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ } }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

function status(over) {
  return { permanent_pro: false, subscription_active: false, trial_active: false, trial_expired: false, can_use_pro: false, subscription_status: 'none', ...over }
}

// ── past_due with no trial: access retained (subscribed) + billing attention ───
test('past_due, no trial → subscribed label, access retained, billing_attention', () => {
  const s = status({ subscription_active: true, can_use_pro: true, subscription_status: 'past_due' })
  assertEqual(classifyProStatus(s), 'subscribed')
  assertEqual(hasProAccess(s), true)
  assertEqual(subscriptionAttentionState(s.subscription_status), 'billing_attention')
})

// ── past_due with active Funnl trial: subscription_active wins for access ───────
test('past_due + active trial → access retained + billing_attention', () => {
  const s = status({ subscription_active: true, trial_active: true, can_use_pro: true, subscription_status: 'past_due' })
  assertEqual(hasProAccess(s), true)
  assert(['subscribed', 'permanent', 'trial'].includes(classifyProStatus(s)), 'access label preserved')
  assertEqual(subscriptionAttentionState(s.subscription_status), 'billing_attention')
})

// ── incomplete with active Funnl trial: trial access + payment_incomplete ───────
test('incomplete + active trial → trial access + payment_incomplete', () => {
  const s = status({ trial_active: true, can_use_pro: true, subscription_status: 'incomplete' })
  assertEqual(classifyProStatus(s), 'trial')
  assertEqual(hasProAccess(s), true)
  assertEqual(subscriptionAttentionState(s.subscription_status), 'payment_incomplete')
})

// ── unpaid with permanent access: permanent label + billing_attention ──────────
test('unpaid + permanent → permanent access + billing_attention', () => {
  const s = status({ permanent_pro: true, can_use_pro: true, subscription_status: 'unpaid' })
  assertEqual(classifyProStatus(s), 'permanent')
  assertEqual(hasProAccess(s), true)
  assertEqual(subscriptionAttentionState(s.subscription_status), 'billing_attention')
})

// ── paused with no other access: no access, billing attention, no Subscribe ────
test('paused, no other access → no access + billing_attention (no Subscribe)', () => {
  const s = status({ subscription_status: 'paused' })
  assertEqual(hasProAccess(s), false)
  assertEqual(subscriptionAttentionState(s.subscription_status), 'billing_attention')
})

// ── canceled / incomplete_expired → Subscribe shown (no attention) ──────────────
test('canceled / incomplete_expired → no attention (Subscribe allowed)', () => {
  assertEqual(subscriptionAttentionState('canceled'), null)
  assertEqual(subscriptionAttentionState('incomplete_expired'), null)
})

// ── active → normal subscribed, no attention ────────────────────────────────────
test('active → subscribed, no attention', () => {
  const s = status({ subscription_active: true, can_use_pro: true, subscription_status: 'active' })
  assertEqual(classifyProStatus(s), 'subscribed')
  assertEqual(subscriptionAttentionState(s.subscription_status), null)
})

// ── Source contract: notice rendered WITH access states, not masked ────────────
const settingsSrc = readFileSync(join(ROOT, 'src/pages/SettingsPage.jsx'), 'utf8')
const aiSrc       = readFileSync(join(ROOT, 'src/pages/FunnlAIPage.jsx'), 'utf8')

test('SettingsPage renders billing attention for permanent/subscribed/trial too', () => {
  assert(/attentionState && \(proClass === 'permanent' \|\| proClass === 'subscribed' \|\| proClass === 'trial'\)/.test(settingsSrc),
    'SettingsPage must render the attention notice alongside the access label')
})
test('FunnlAIPage shows a non-blocking attention notice while unlocked (isProUser)', () => {
  // The notice appears inside the unlocked branch (after `: (`), gated on attentionState.
  const unlockedIdx = aiSrc.indexOf('{!isProUser ? renderLocked() : (')
  assert(unlockedIdx !== -1)
  const region = aiSrc.slice(unlockedIdx, unlockedIdx + 900)
  assert(region.includes('attentionState &&'), 'unlocked view must show a billing-attention notice')
  assert(region.includes('/settings'), 'notice must link to Settings')
})
test('FunnlAIPage keeps AI access gated only by hasProAccess (attention never gates)', () => {
  assert(/isProUser\s*=\s*hasProAccess\(/.test(aiSrc))
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
