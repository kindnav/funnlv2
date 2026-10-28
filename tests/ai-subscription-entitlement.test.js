// Subscription-based Pro for the AI Edge Functions and the browser - one decision, everywhere.
//
// Run with: node tests/ai-subscription-entitlement.test.js
//
// The billing policy is NOT defined here. It is PR #24's, already live in Production:
// shared/subscriptionStatusPolicy.js grants access for `active` and `past_due` only, and the SQL
// RPC get_my_pro_access_status() mirrors that set (tests/subscription-policy-parity.test.js).
// These checks pin that every AI function - ai-paste-email included - and every frontend gate
// apply it, alongside permanent Pro and trials, and that a subscription row is only ever read
// for the signed-in user.

import { strict as assert } from 'assert'
import { test } from 'node:test'
import { readFileSync } from 'fs'
import { decideEntitlement, loadProEntitlement } from '../supabase/functions/shared/pro-entitlement.js'
import { SUBSCRIPTION_STATUS_POLICY } from '../supabase/functions/shared/subscriptionStatusPolicy.js'
import { hasProAccess, classifyProStatus } from '../src/lib/pro-ui-status.js'

const NOW = new Date('2026-10-14T16:00:00Z')
const ACTIVE_TRIAL = { started_at: '2026-10-10T00:00:00Z', ends_at: '2026-10-17T00:00:00Z' }
const EXPIRED_TRIAL = { started_at: '2026-09-01T00:00:00Z', ends_at: '2026-09-08T00:00:00Z' }
const NO_ERRORS = { profileError: false, trialError: false, subscriptionError: false }
const decide = (profile, trial, subscription, errors = {}) =>
  decideEntitlement({ profile, trial, subscription, ...NO_ERRORS, ...errors }, NOW).status
// Evidence-based rows (migration 20261023000000): a verified paid period through 2026-11-14.
const sub = (status, extra = {}) => ({ status, evidence_version: 1, current_period_end: '2026-11-14T00:00:00Z', cancel_at_period_end: false,
  paid_through: '2026-11-14T00:00:00Z', failed_invoice_id: null, grace_started_at: null, ...extra })
// A renewal whose payment failed 2 days before NOW: paid period ended, grace from the first failure.
const FAILED = { paid_through: '2026-10-12T00:00:00Z', failed_invoice_id: 'in_renewal', grace_started_at: '2026-10-12T16:00:00Z' }

// ── The server decision ────────────────────────────────────────────────────────

test('a subscription-only account is Pro through its verified paid period, and in grace after a verified failure', () => {
  assert.equal(decide({ ai_enabled: false }, null, sub('active')), 'allow')
  assert.equal(decide({ ai_enabled: false }, EXPIRED_TRIAL, sub('past_due', FAILED)), 'allow')
  assert.equal(decide({ ai_enabled: false }, null, sub('unpaid', FAILED)), 'allow')
  // 7 days after the first failed payment the grace is over.
  assert.equal(decide({ ai_enabled: false }, null, sub('past_due', { ...FAILED, grace_started_at: '2026-10-07T16:00:00Z' })), 'deny')
  // past_due WITHOUT verified failure evidence: no grace is invented.
  assert.equal(decide({ ai_enabled: false }, null, sub('past_due', { paid_through: '2026-10-12T00:00:00Z' })), 'deny')
})

test('every other subscription status is refused, including unknown ones', () => {
  for (const s of ['none', 'trialing', 'paused', 'canceled', 'incomplete', 'incomplete_expired', 'something_new', '', null]) {
    assert.equal(decide({ ai_enabled: false }, null, s === null ? null : sub(s)), 'deny', String(s))
  }
})

test('the statuses that may grant (time-bounded) are exactly the published policy: active, past_due, unpaid', () => {
  const granting = Object.entries(SUBSCRIPTION_STATUS_POLICY).filter(([, p]) => p.grantsAccess).map(([k]) => k).sort()
  assert.deepEqual(granting, ['active', 'past_due', 'unpaid'])
})

test('cancellation is decided by status: still "active" until period end, refused once "canceled"', () => {
  // cancel_at_period_end keeps the subscription active (and Pro) until Stripe flips the status.
  assert.equal(decide({ ai_enabled: false }, null, sub('active', { cancel_at_period_end: true })), 'allow')
  assert.equal(decide({ ai_enabled: false }, null, sub('canceled', { cancel_at_period_end: true })), 'deny')
})

test('status alone never grants: an active row is Pro only through its verified paid period', () => {
  // Migration 20261023000000. No allowance after the period: an unreported renewal is Free until evidence.
  assert.equal(decide({ ai_enabled: false }, null, sub('active', { paid_through: '2026-10-10T00:00:00Z', current_period_end: '2026-11-10T00:00:00Z' })), 'deny')
  assert.equal(decide({ ai_enabled: false }, null, sub('active', { paid_through: null })), 'deny')
  // Rows from before the migration (evidence_version 0) use Stripe's reported period end, with no allowance.
  assert.equal(decide({ ai_enabled: false }, null, { status: 'active', evidence_version: 0, current_period_end: '2026-01-01T00:00:00Z' }), 'deny')
  assert.equal(decide({ ai_enabled: false }, null, { status: 'active', evidence_version: 0, current_period_end: '2026-11-14T00:00:00Z' }), 'allow')
  assert.equal(decide({ ai_enabled: false }, null, { status: 'past_due', evidence_version: 0, current_period_end: '2026-11-14T00:00:00Z' }), 'deny')
})

test('permanent Pro and valid trials are preserved; an expired trial alone is refused', () => {
  assert.equal(decide({ ai_enabled: true }, null, null), 'allow')
  assert.equal(decide({ ai_enabled: true }, EXPIRED_TRIAL, sub('canceled')), 'allow')
  assert.equal(decide({ ai_enabled: false }, ACTIVE_TRIAL, null), 'allow')
  assert.equal(decide({ ai_enabled: false }, ACTIVE_TRIAL, sub('canceled')), 'allow')
  assert.equal(decide({ ai_enabled: false }, EXPIRED_TRIAL, null), 'deny')
  assert.equal(decide(null, null, null), 'deny')
})

test('a failed lookup is never a false refusal: unknown unless another source proves access', () => {
  assert.equal(decide({ ai_enabled: false }, null, null, { subscriptionError: true }), 'unknown')
  assert.equal(decide({ ai_enabled: true }, null, null, { subscriptionError: true }), 'allow')
  assert.equal(decide({ ai_enabled: false }, null, sub('active'), { profileError: true }), 'allow')
})

// ── Ownership: only the signed-in user's rows are read ─────────────────────────

/** A service-role client over three tables that honours .eq() filters like PostgREST. */
function fakeAdmin (tables) {
  const reads = []
  return {
    reads,
    from (table) {
      const filters = []
      const q = {
        select () { return q },
        eq (col, val) { filters.push([col, val]); return q },
        async maybeSingle () {
          reads.push({ table, filters: [...filters] })
          const rows = (tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v))
          return { data: rows[0] ?? null, error: null }
        },
      }
      return q
    },
  }
}

test('a FOREIGN user’s active subscription never grants access', async () => {
  const admin = fakeAdmin({
    profiles: [{ id: 'user-a', ai_enabled: false }, { id: 'user-b', ai_enabled: false }],
    pro_trials: [],
    subscriptions: [{ user_id: 'user-a', ...sub('active') }],
  })
  const forB = await loadProEntitlement(admin, 'user-b')
  assert.equal(forB.subscription, null)
  assert.equal(decideEntitlement(forB, NOW).status, 'deny')
  const forA = await loadProEntitlement(admin, 'user-a')
  assert.equal(decideEntitlement(forA, NOW).status, 'allow')
})

test('every entitlement read is filtered to the given user id', async () => {
  const admin = fakeAdmin({ profiles: [], pro_trials: [], subscriptions: [] })
  await loadProEntitlement(admin, 'user-x')
  assert.deepEqual(admin.reads.map((r) => r.table).sort(), ['pro_trials', 'profiles', 'subscriptions'])
  for (const r of admin.reads) {
    assert.deepEqual(r.filters, [[r.table === 'profiles' ? 'id' : 'user_id', 'user-x']], r.table)
  }
})

// ── Every AI Edge Function uses the one decision ──────────────────────────────

const FUNCTIONS = ['ai-chat', 'ai-map-csv', 'ai-categorize-contacts', 'ai-parse-contact', 'ai-paste-email']
const src = (fn) => readFileSync(new URL(`../supabase/functions/${fn}/index.ts`, import.meta.url), 'utf8')

test('all five AI functions decide access with decideEntitlement, none with the old 3-argument check', () => {
  for (const fn of FUNCTIONS) {
    const s = src(fn)
    assert.ok(s.includes("import { loadProEntitlement, decideEntitlement } from '../shared/pro-entitlement.js'"), fn)
    assert.equal(s.includes('evaluateProEntitlement'), false, fn)
  }
})

test('ai-paste-email maps unknown to a retryable error and only allow to access', () => {
  const s = src('ai-paste-email')
  assert.ok(s.includes("if (decision.status === 'unknown') return { canUse: false, error: true }"))
  assert.ok(s.includes("return { canUse: decision.status === 'allow' }"))
})

// ── The browser agrees with the server ─────────────────────────────────────────

const rpc = (over) => ({
  permanent_pro: false, trial_eligible: false, trial_active: false, trial_expired: false, days_remaining: 0,
  ends_at: null, server_now: NOW.toISOString(), can_use_pro: false, subscription_active: false,
  subscription_status: 'none', subscription_period_end: null, cancel_at_period_end: false, ...over,
})

test('the browser grants Pro exactly when the server would', () => {
  const cases = [
    [rpc({ can_use_pro: true, subscription_active: true, subscription_status: 'active' }), true, 'subscribed'],
    [rpc({ can_use_pro: true, subscription_active: true, subscription_status: 'past_due' }), true, 'subscribed'],
    [rpc({ can_use_pro: true, permanent_pro: true }), true, 'permanent'],
    [rpc({ can_use_pro: true, trial_active: true, days_remaining: 3 }), true, 'trial'],
    [rpc({ trial_expired: true }), false, 'expired'],
    [rpc({ subscription_status: 'canceled' }), false, 'non_pro'],
    [rpc({ subscription_status: 'trialing' }), false, 'non_pro'],
  ]
  for (const [status, access, cls] of cases) {
    assert.equal(hasProAccess(status), access, JSON.stringify(status))
    assert.equal(classifyProStatus(status), cls, JSON.stringify(status))
  }
})

test('no frontend gate is left on the old permanent-or-trial check', () => {
  const files = ['components/AddContactDrawer.jsx', 'components/BottomNav.jsx', 'components/CommandPalette.jsx',
    'components/ImportContactsModal.jsx', 'pages/ContactDetailPage.jsx', 'pages/ContactsPage.jsx',
    'pages/DashboardPage.jsx', 'pages/FunnlAIPage.jsx']
  for (const f of files) {
    const s = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
    assert.ok(s.includes('hasProAccess('), f)
    assert.equal(/=== 'permanent' \|\| \w+ === 'trial'/.test(s), false, f)
  }
})
