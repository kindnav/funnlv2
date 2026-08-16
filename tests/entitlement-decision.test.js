/**
 * C5 tests: decideEntitlement — the central entitlement decision shared by all four AI
 * Edge Functions. A temporary entitlement-query failure with no proven access must be
 * UNKNOWN (retryable 5xx), never a false pro_required 403 for a paying subscriber.
 *
 * Exercises the REAL shared helper and asserts (source-contract) that all four functions
 * call it and map unknown→500 / deny→403.
 *
 * Zero deps — runs with: node tests/entitlement-decision.test.js
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { decideEntitlement } from '../supabase/functions/shared/pro-entitlement.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0, failed = 0
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ } }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const NOW = new Date('2026-08-15T12:00:00.000Z')
const ACTIVE_TRIAL  = { started_at: '2026-08-14T00:00:00.000Z', ends_at: '2026-08-20T00:00:00.000Z' }
const EXPIRED_TRIAL = { started_at: '2026-08-01T00:00:00.000Z', ends_at: '2026-08-10T00:00:00.000Z' }

// Base loaded object — all sources absent, no errors.
function loaded(over = {}) {
  return {
    profile: null, trial: null, subscription: null,
    profileError: false, trialError: false, subscriptionError: false,
    _profileErrorCode: null, _trialErrorCode: null, _subscriptionErrorCode: null,
    ...over,
  }
}

// ── Positive entitlement from a single source → allow ───────────────────────────
test('permanent only → allow', () => assertEqual(decideEntitlement(loaded({ profile: { ai_enabled: true } }), NOW).status, 'allow'))
test('trial only (active) → allow', () => assertEqual(decideEntitlement(loaded({ trial: ACTIVE_TRIAL }), NOW).status, 'allow'))
test('subscription only (active) → allow', () => assertEqual(decideEntitlement(loaded({ subscription: { status: 'active' } }), NOW).status, 'allow'))
test('past_due subscription → allow (dunning window per policy)', () => assertEqual(decideEntitlement(loaded({ subscription: { status: 'past_due' } }), NOW).status, 'allow'))

// ── No entitlement, no errors → deny (confirmed non-Pro) ────────────────────────
test('no entitlement, no errors → deny', () => assertEqual(decideEntitlement(loaded(), NOW).status, 'deny'))
test('expired subscription (canceled), no errors → deny', () => assertEqual(decideEntitlement(loaded({ subscription: { status: 'canceled' } }), NOW).status, 'deny'))
test('unknown subscription status, no errors → deny (fail closed to non-Pro)', () => assertEqual(decideEntitlement(loaded({ subscription: { status: 'weird_status' } }), NOW).status, 'deny'))
test('expired trial, no errors → deny', () => assertEqual(decideEntitlement(loaded({ trial: EXPIRED_TRIAL }), NOW).status, 'deny'))

// ── The core fix: query failure with no proven access → unknown, NOT pro_required ─
test('subscription error, no other entitlement → unknown (NOT deny/403)', () => {
  const d = decideEntitlement(loaded({ subscriptionError: true }), NOW)
  assertEqual(d.status, 'unknown')
})
test('multiple errors, no proven entitlement → unknown', () => {
  assertEqual(decideEntitlement(loaded({ profileError: true, trialError: true, subscriptionError: true }), NOW).status, 'unknown')
})
test('profile error alone, no proven entitlement → unknown', () => {
  assertEqual(decideEntitlement(loaded({ profileError: true }), NOW).status, 'unknown')
})
test('trial error alone, no proven entitlement → unknown', () => {
  assertEqual(decideEntitlement(loaded({ trialError: true }), NOW).status, 'unknown')
})

// ── A proven source wins even if a redundant source failed → allow ──────────────
test('subscription error BUT permanent entitlement → allow', () => {
  assertEqual(decideEntitlement(loaded({ profile: { ai_enabled: true }, subscriptionError: true }), NOW).status, 'allow')
})
test('subscription error BUT active trial → allow', () => {
  assertEqual(decideEntitlement(loaded({ trial: ACTIVE_TRIAL, subscriptionError: true }), NOW).status, 'allow')
})
test('profile error BUT valid subscription → allow (paying user not denied)', () => {
  assertEqual(decideEntitlement(loaded({ subscription: { status: 'active' }, profileError: true }), NOW).status, 'allow')
})
test('trial error BUT valid subscription → allow', () => {
  assertEqual(decideEntitlement(loaded({ subscription: { status: 'active' }, trialError: true }), NOW).status, 'allow')
})

// ── Malformed subscription data → treated as no grant; deny if no errors ─────────
test('malformed subscription (no status), no errors → deny', () => {
  assertEqual(decideEntitlement(loaded({ subscription: {} }), NOW).status, 'deny')
})
test('malformed subscription (no status) WITH subscriptionError → unknown', () => {
  assertEqual(decideEntitlement(loaded({ subscription: {}, subscriptionError: true }), NOW).status, 'unknown')
})

// ── Source contract: all four AI functions use the corrected decision ───────────
const FUNCS = ['ai-chat', 'ai-parse-contact', 'ai-map-csv', 'ai-categorize-contacts']
for (const fn of FUNCS) {
  const src = readFileSync(join(ROOT, `supabase/functions/${fn}/index.ts`), 'utf8')
  test(`${fn}: imports + calls decideEntitlement`, () => {
    assert(src.includes('decideEntitlement'), `${fn} must use decideEntitlement`)
    assert(!src.includes('evaluateProEntitlement('), `${fn} must not call evaluateProEntitlement directly`)
  })
  test(`${fn}: unknown → retryable 500, deny → 403`, () => {
    assert(/decision\.status === 'unknown'/.test(src), `${fn} must handle the unknown branch`)
    assert(/decision\.status === 'deny'/.test(src), `${fn} must handle the deny branch`)
    // The unknown branch must return 500 and the deny branch 403.
    const unkIdx = src.indexOf("decision.status === 'unknown'")
    const denyIdx = src.indexOf("decision.status === 'deny'")
    // The unknown branch (500) ends before the deny branch begins.
    assert(src.slice(unkIdx, denyIdx).includes('500'), `${fn} unknown branch must be 500`)
    assert(src.slice(denyIdx, denyIdx + 500).includes('403'), `${fn} deny branch must be 403`)
  })
  test(`${fn}: no longer treats subscriptionError as a mere warning`, () => {
    assert(!/subscriptionError\s*\)\s*\{[\s\S]{0,120}console\.warn/.test(src),
      `${fn} must not just warn-and-continue on subscriptionError`)
  })
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
