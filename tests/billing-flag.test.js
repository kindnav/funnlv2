// Focused tests for the temporary "Funnl Pro — Coming Soon" billing gate.
//
// Covers:
//   - billingEnabled() predicate: only exact 'true' enables; missing/empty/
//     malformed/'false' disable (fail-safe).
//   - BILLING_ENABLED defaults DISABLED outside Vite (import.meta.env undefined).
//   - Source proofs (this repo has no DOM test runner): every customer-facing
//     Subscribe entry point is gated by the same BILLING_ENABLED flag, renders
//     ProComingSoon when disabled, cannot invoke checkout when disabled, and the
//     enabled path still shows $4.99/month via the existing checkout handler.
//   - No $7.99 customer-facing copy returns.
//
// Run with: node tests/billing-flag.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { billingEnabled, BILLING_ENABLED, PRO_PRICE_DISPLAY } from '../src/lib/proPricing.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8')

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗  ${name}`)
    console.log(`       ${e.message}`)
    failed++
  }
}

const proPricing = read('src/lib/proPricing.js')
const settings = read('src/pages/SettingsPage.jsx')
const funnlAI = read('src/pages/FunnlAIPage.jsx')
const comingSoon = read('src/components/ProComingSoon.jsx')

// ── billingEnabled() predicate ────────────────────────────────────────────────
console.log('\nbillingEnabled() predicate')

test('exact string "true" enables billing', () => {
  assert.strictEqual(billingEnabled('true'), true)
})
test('missing (undefined) disables billing', () => {
  assert.strictEqual(billingEnabled(undefined), false)
})
test('empty string disables billing', () => {
  assert.strictEqual(billingEnabled(''), false)
})
test('"false" disables billing', () => {
  assert.strictEqual(billingEnabled('false'), false)
})
test('malformed / other values disable billing', () => {
  for (const v of ['TRUE', 'True', '1', 'yes', ' true', 'true ', 'enabled', '0', null, 1, true]) {
    assert.strictEqual(billingEnabled(v), false, `expected disabled for ${JSON.stringify(v)}`)
  }
})

// ── BILLING_ENABLED fail-safe default ─────────────────────────────────────────
console.log('\nBILLING_ENABLED default (no Vite env present)')

test('defaults to DISABLED when import.meta.env is absent', () => {
  assert.strictEqual(BILLING_ENABLED, false)
})
test('flag reads VITE_BILLING_ENABLED and never the hostname / a Stripe key', () => {
  assert.ok(proPricing.includes("import.meta.env?.VITE_BILLING_ENABLED"),
    'BILLING_ENABLED must derive from VITE_BILLING_ENABLED')
  assert.ok(proPricing.includes("rawValue === 'true'"), 'must require exact string true')
  assert.ok(!/window\.location|location\.hostname|\.hostname\b/.test(proPricing),
    'flag must not read the hostname in code')
  assert.ok(!/sk_(test|live)|STRIPE_SECRET|pk_(test|live)/.test(proPricing),
    'no Stripe key on the frontend flag')
})

// ── ProComingSoon component ───────────────────────────────────────────────────
console.log('\nProComingSoon disabled state')

test('renders the exact "Funnl Pro — Coming Soon" copy', () => {
  assert.ok(comingSoon.includes('Funnl Pro — Coming Soon'),
    'missing the Coming Soon label')
})
test('includes the supporting "Paid plans are not available yet." line', () => {
  assert.ok(comingSoon.includes('Paid plans are not available yet.'))
})
test('is a disabled control that cannot invoke checkout', () => {
  assert.ok(/disabled/.test(comingSoon), 'must be disabled')
  assert.ok(!comingSoon.includes('onClick='), 'must have no onClick handler')
  assert.ok(!comingSoon.includes('handleSubscribe'), 'must not call handleSubscribe')
  assert.ok(!comingSoon.includes('create-checkout-session'), 'must not reference checkout')
})

// ── Every Subscribe entry point uses the same flag ────────────────────────────
console.log('\nSubscribe entry points gated by the same flag')

for (const [name, src] of [['SettingsPage.jsx', settings], ['FunnlAIPage.jsx', funnlAI]]) {
  test(`${name} imports BILLING_ENABLED and ProComingSoon`, () => {
    assert.ok(/import\s*\{[^}]*BILLING_ENABLED[^}]*\}\s*from\s*'\.\.\/lib\/proPricing'/.test(src),
      'does not import BILLING_ENABLED from proPricing')
    assert.ok(src.includes("import ProComingSoon from '../components/ProComingSoon'"),
      'does not import ProComingSoon')
  })
  test(`${name} shows ProComingSoon when billing disabled`, () => {
    assert.ok(src.includes('<ProComingSoon'), 'ProComingSoon not rendered')
    assert.ok(src.includes('BILLING_ENABLED ?'), 'no BILLING_ENABLED conditional around the CTA')
  })
  test(`${name} handleSubscribe early-returns when billing disabled`, () => {
    const i = src.indexOf('async function handleSubscribe()')
    assert.ok(i !== -1, 'handleSubscribe not found')
    const head = src.slice(i, i + 400)
    assert.ok(/if\s*\(!BILLING_ENABLED\)\s*return/.test(head),
      'handleSubscribe missing the !BILLING_ENABLED guard')
  })
  test(`${name} enabled path retains $4.99/month + existing checkout handler`, () => {
    assert.ok(src.includes('Subscribe - ${PRO_PRICE_DISPLAY}'),
      'enabled Subscribe CTA no longer uses PRO_PRICE_DISPLAY')
    assert.ok(src.includes("supabase.functions.invoke('create-checkout-session'"),
      'enabled path lost the create-checkout-session handler')
  })
  test(`${name} every onClick={handleSubscribe} button sits under a BILLING_ENABLED branch`, () => {
    // Each checkout button must be preceded by a BILLING_ENABLED gate; the count of
    // BILLING_ENABLED conditionals is >= the count of handleSubscribe buttons.
    const buttons = (src.match(/onClick=\{handleSubscribe\}/g) || []).length
    const gates = (src.match(/BILLING_ENABLED \?/g) || []).length
    assert.ok(buttons >= 1, 'expected at least one Subscribe button')
    assert.ok(gates >= buttons, `only ${gates} gates for ${buttons} Subscribe buttons`)
  })
}

test('PRO_PRICE_DISPLAY is still $4.99/month', () => {
  assert.strictEqual(PRO_PRICE_DISPLAY, '$4.99/month')
})

// ── No stale $7.99 copy anywhere customer-facing ──────────────────────────────
console.log('\nNo $7.99 copy returns')

test('SettingsPage.jsx / FunnlAIPage.jsx / ProComingSoon.jsx contain no 7.99', () => {
  for (const [name, src] of [['SettingsPage', settings], ['FunnlAI', funnlAI], ['ProComingSoon', comingSoon]]) {
    assert.ok(!/7\.99/.test(src), `${name} still contains 7.99`)
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
