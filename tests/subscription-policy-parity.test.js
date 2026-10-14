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
} from '../supabase/functions/shared/subscriptionStatusPolicy.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0, failed = 0
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ } }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

// ── subscriptionGrantsAccess canonical behavior ────────────────────────────────
test('active grants access', () => assertEqual(subscriptionGrantsAccess('active'), true))
test('past_due grants access (dunning)', () => assertEqual(subscriptionGrantsAccess('past_due'), true))
test('canceled / incomplete / incomplete_expired / trialing / unpaid / paused / none do NOT grant', () => {
  for (const s of ['canceled', 'incomplete', 'incomplete_expired', 'trialing', 'unpaid', 'paused', 'none']) {
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
test('JS granting set is exactly {active, past_due}', () => {
  assertEqual([...JS_GRANTING].sort().join(','), 'active,past_due')
})

// ── SQL RPC mirror: parse migration 20260812000000 v_sub_active IN (...) ───────
test('SQL RPC granting set mirrors the JS granting set', () => {
  const sql = readFileSync(join(ROOT, 'supabase/migrations/20260812000000_add_subscriptions.sql'), 'utf8')
  const m = sql.match(/v_sub_active\s*:=\s*COALESCE\(\s*v_sub_status\s+IN\s*\(([^)]*)\)/)
  assert(m, 'could not locate v_sub_active := COALESCE(v_sub_status IN (...)) in the migration')
  const sqlSet = new Set(
    m[1].split(',').map(x => x.trim().replace(/^'/, '').replace(/'$/, '')).filter(Boolean),
  )
  // The SQL granting set must equal the JS granting set (order-insensitive).
  assertEqual([...sqlSet].sort().join(','), [...JS_GRANTING].sort().join(','),
    `SQL granting set ${JSON.stringify([...sqlSet])} must equal JS granting set ${JSON.stringify([...JS_GRANTING])}`)
})

// ── Source contract: pro-entitlement.js delegates, no local allowlist ──────────
test('pro-entitlement.js uses subscriptionGrantsAccess and has no hardcoded active/past_due allowlist', () => {
  const src = readFileSync(join(ROOT, 'supabase/functions/shared/pro-entitlement.js'), 'utf8')
  assert(src.includes('subscriptionGrantsAccess('), 'must delegate to subscriptionGrantsAccess')
  // No duplicate allowlist like: === 'active' || ... === 'past_due'
  assert(!/===\s*'active'[\s\S]{0,40}===\s*'past_due'/.test(src),
    'must not hardcode the active/past_due allowlist')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
