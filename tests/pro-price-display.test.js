// Regression test: Funnl Pro price display copy.
//
// Proves the Settings page and the locked Pro screen (FunnlAIPage) show the
// current $4.99/month price and never the stale $7.99. The amount actually
// charged is governed by Stripe + STRIPE_PRO_PRICE_ID; this test only guards
// the display copy so a stale price can never resurface in the CTAs.
//
// Run with: node tests/pro-price-display.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { PRO_PRICE_DISPLAY } from '../src/lib/proPricing.js'

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

const settings = read('src/pages/SettingsPage.jsx')
const funnlAI = read('src/pages/FunnlAIPage.jsx')

console.log('\nPRO_PRICE_DISPLAY constant')

test('is exactly $4.99/month', () => {
  assert.strictEqual(PRO_PRICE_DISPLAY, '$4.99/month')
})
test('does not contain the stale 7.99', () => {
  assert.ok(!PRO_PRICE_DISPLAY.includes('7.99'), 'constant still references 7.99')
})

console.log('\nSettings page price CTA')

test('SettingsPage.jsx does not display $7.99 / 7.99', () => {
  assert.ok(!/7\.99/.test(settings), 'SettingsPage still contains 7.99')
})
test('SettingsPage.jsx renders the price via PRO_PRICE_DISPLAY', () => {
  assert.ok(settings.includes("import { PRO_PRICE_DISPLAY } from '../lib/proPricing'"),
    'SettingsPage does not import PRO_PRICE_DISPLAY')
  assert.ok(settings.includes('Subscribe - ${PRO_PRICE_DISPLAY}'),
    'SettingsPage Subscribe CTA does not use PRO_PRICE_DISPLAY')
})

console.log('\nLocked Pro screen price CTA (FunnlAIPage)')

test('FunnlAIPage.jsx does not display $7.99 / 7.99', () => {
  assert.ok(!/7\.99/.test(funnlAI), 'FunnlAIPage still contains 7.99')
})
test('FunnlAIPage.jsx renders the price via PRO_PRICE_DISPLAY', () => {
  assert.ok(funnlAI.includes("import { PRO_PRICE_DISPLAY } from '../lib/proPricing'"),
    'FunnlAIPage does not import PRO_PRICE_DISPLAY')
  assert.ok(funnlAI.includes('Subscribe - ${PRO_PRICE_DISPLAY}'),
    'FunnlAIPage Subscribe CTA does not use PRO_PRICE_DISPLAY')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
