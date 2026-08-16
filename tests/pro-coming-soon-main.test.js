// Focused tests for the production "Funnl Pro — Coming Soon" patch on main.
//
// main has NO Stripe/checkout/pricing code. These source-scan tests (this repo
// has no DOM test runner) prove the shared control's copy + disabled state, that
// Settings renders it for expired and non-Pro users, that the locked Funnl AI
// screen renders it, and that none of these surfaces introduce checkout, a Stripe
// URL, or price copy ($4.99 / $7.99).
//
// Run with: node tests/pro-coming-soon-main.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

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

const comingSoon = read('src/components/ProComingSoon.jsx')
const settings = read('src/pages/SettingsPage.jsx')
const funnlAI = read('src/pages/FunnlAIPage.jsx')

// ── Shared control ─────────────────────────────────────────────────────────────
console.log('\nProComingSoon shared control')

test('contains the exact "Funnl Pro — Coming Soon" copy', () => {
  assert.ok(comingSoon.includes('Funnl Pro — Coming Soon'))
})
test('contains the supporting "Paid plans are not available yet." line', () => {
  assert.ok(comingSoon.includes('Paid plans are not available yet.'))
})
test('renders a disabled button', () => {
  assert.ok(/<button[\s\S]*\bdisabled\b/.test(comingSoon), 'button must be disabled')
})
test('has no onClick handler', () => {
  assert.ok(!comingSoon.includes('onClick='), 'must have no onClick')
})
test('supports size="sm" and size="md"', () => {
  assert.ok(comingSoon.includes("size === 'md'"), 'must branch on size')
})

// ── Settings surfaces ──────────────────────────────────────────────────────────
console.log('\nSettings renders it for expired + non-Pro users')

test('SettingsPage imports ProComingSoon', () => {
  assert.ok(settings.includes("import ProComingSoon from '../components/ProComingSoon'"))
})
test('expired state retains trial-ended info AND renders ProComingSoon size="sm"', () => {
  const i = settings.indexOf("proClass === 'expired'")
  assert.ok(i !== -1, 'expired branch not found')
  const slice = settings.slice(i, i + 400)
  assert.ok(/Trial ended/.test(slice), 'expired branch lost the trial-ended info')
  assert.ok(slice.includes('<ProComingSoon size="sm" />'), 'expired branch missing ProComingSoon')
})
test('non-Pro state retains "No active Pro access." AND renders ProComingSoon size="sm"', () => {
  const i = settings.indexOf('No active Pro access.')
  assert.ok(i !== -1, 'non_pro copy not found')
  const slice = settings.slice(i, i + 200)
  assert.ok(slice.includes('<ProComingSoon size="sm" />'), 'non_pro branch missing ProComingSoon')
})

// ── Funnl AI locked screen ──────────────────────────────────────────────────────
console.log('\nLocked Funnl AI screen renders it')

test('FunnlAIPage imports ProComingSoon', () => {
  assert.ok(funnlAI.includes("import ProComingSoon from '../components/ProComingSoon'"))
})
test('locked screen renders ProComingSoon size="md"', () => {
  assert.ok(funnlAI.includes('<ProComingSoon size="md" />'))
})
test('expired-trial "Contact us to continue" implication is removed', () => {
  assert.ok(!/Contact us to continue/i.test(funnlAI),
    'the "Contact us to continue" copy must be replaced by the shared Coming Soon state')
})

// ── No checkout / Stripe / price copy on these surfaces ─────────────────────────
console.log('\nNo checkout / Stripe / price copy introduced')

for (const [name, src] of [
  ['ProComingSoon.jsx', comingSoon],
  ['SettingsPage.jsx', settings],
  ['FunnlAIPage.jsx', funnlAI],
]) {
  test(`${name}: no create-checkout-session, Stripe URL, $4.99, or $7.99`, () => {
    assert.ok(!src.includes('create-checkout-session'), `${name} references create-checkout-session`)
    assert.ok(!/checkout\.stripe\.com|api\.stripe\.com/.test(src), `${name} references a Stripe URL`)
    assert.ok(!/4\.99/.test(src), `${name} contains 4.99`)
    assert.ok(!/7\.99/.test(src), `${name} contains 7.99`)
  })
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
