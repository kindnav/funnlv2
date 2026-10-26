/**
 * P4 tests: the subscription access-granting status set is CANONICAL in one JS place,
 * and the SQL RPC mirrors it.
 *
 *  - subscriptionGrantsAccess() (shared/subscriptionStatusPolicy.js) is the single JS
 *    source of truth; evaluateProEntitlement() delegates to it (no local allowlist).
 *  - The SQL RPC in migration 20260812000000 cannot import JS, so it MIRRORS the granting
 *    set. This test parses that migration's `v_sub_active := ... IN (...)` clause and
 *    asserts its status set equals the JS granting set (statuses where
 *    subscriptionGrantsAccess === true). It does NOT claim one executable source.
 *
 * Zero deps — runs with: node tests/subscription-policy-parity.test.js
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import {
  SUBSCRIPTION_STATUS_POLICY,
  subscriptionGrantsAccess,
  PAYMENT_GRACE_MS,
} from '../supabase/functions/shared/subscriptionStatusPolicy.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0, failed = 0
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ } }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

// ── subscriptionGrantsAccess canonical behavior ────────────────────────────────
test('active grants access', () => assertEqual(subscriptionGrantsAccess('active'), true))
test('past_due grants access (dunning)', () => assertEqual(subscriptionGrantsAccess('past_due'), true))
test('unpaid is grace-eligible (a failed renewal keeps Pro for 7 days, time-bounded)', () => assertEqual(subscriptionGrantsAccess('unpaid'), true))
test('canceled / incomplete / incomplete_expired / trialing / paused / none do NOT grant', () => {
  for (const s of ['canceled', 'incomplete', 'incomplete_expired', 'trialing', 'paused', 'none']) {
    assertEqual(subscriptionGrantsAccess(s), false, s)
  }
})
test('unknown / null / non-string do NOT grant (fail closed)', () => {
  assertEqual(subscriptionGrantsAccess('weird'), false)
  assertEqual(subscriptionGrantsAccess(null), false)
  assertEqual(subscriptionGrantsAccess(undefined), false)
  assertEqual(subscriptionGrantsAccess(5), false)
})

// The canonical JS granting set (derived from the policy table).
const JS_GRANTING = new Set(
  Object.keys(SUBSCRIPTION_STATUS_POLICY).filter(s => SUBSCRIPTION_STATUS_POLICY[s].grantsAccess === true),
)
test('JS status set that MAY grant (within its time window) is exactly {active, past_due, unpaid}', () => {
  assertEqual([...JS_GRANTING].sort().join(','), 'active,past_due,unpaid')
})

// ── SQL mirror: migration 20261023000000 subscription_access_until(...) ────────
// Exact behavioural parity at the cutoffs is proven against a real database by
// tests/local/subscription-access.mjs; this offline check pins the statuses and the 7-day constant.
test('SQL subscription_access_until mentions exactly the JS status set and the same 7-day grace', () => {
  const sql = readFileSync(join(ROOT, 'supabase/migrations/20261023000000_subscription_access_periods.sql'), 'utf8')
  const at = sql.indexOf('CREATE OR REPLACE FUNCTION public.subscription_access_until(')
  const body = sql.slice(at, sql.indexOf('$$', sql.indexOf('AS $$', at) + 5))
  const sqlSet = new Set([...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))
  assertEqual([...sqlSet].sort().join(','), [...JS_GRANTING].sort().join(','),
    `SQL statuses ${JSON.stringify([...sqlSet])} must equal JS granting set ${JSON.stringify([...JS_GRANTING])}`)
  assertEqual((body.match(/interval '7 days'/g) || []).length, 1, 'SQL uses the 7-day grace once (failed renewals only)')
  assertEqual(PAYMENT_GRACE_MS, 7 * 24 * 60 * 60 * 1000, 'JS grace is 7 days')
  // get_my_pro_access_status uses the function, with no status-only shortcut left.
  assert(/v_sub_active := v_sub_until IS NOT NULL AND v_now < v_sub_until;/.test(sql))
  assert(!/v_sub_active\s*:=\s*COALESCE\(\s*v_sub_status\s+IN/.test(sql))
})

// ── Source contract: pro-entitlement.js delegates, no local allowlist ──────────
test('pro-entitlement.js uses the time-bounded subscriptionGrantsAccessAt and has no hardcoded allowlist', () => {
  const src = readFileSync(join(ROOT, 'supabase/functions/shared/pro-entitlement.js'), 'utf8')
  assert(src.includes('subscriptionGrantsAccessAt(subscription, now)'), 'must delegate to subscriptionGrantsAccessAt')
  assert(src.includes("select('status, current_period_end, cancel_at_period_end, evidence_version, paid_through, failed_invoice_id, grace_started_at')"), 'must load the columns the rule needs')
  // No duplicate allowlist like: === 'active' || ... === 'past_due'
  assert(!/===\s*'active'[\s\S]{0,40}===\s*'past_due'/.test(src),
    'must not hardcode the active/past_due allowlist')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
