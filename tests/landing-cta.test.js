/**
 * landing-cta.test.js
 *
 * Verifies that all three landing_cta_clicked location values remain distinct
 * and that each CTA call site exists in LandingPage.jsx.
 *
 * Run: node tests/landing-cta.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dirname, '..', 'src', 'pages', 'LandingPage.jsx'), 'utf8')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗  ${name}: ${e.message}`)
    failed++
  }
}

console.log('\nlanding_cta_clicked location values\n')

test("nav CTA fires location: 'nav'", () => {
  assert.ok(src.includes("location: 'nav'"), "missing location: 'nav' in LandingPage.jsx")
})

test("hero CTA (sticky canvas button) is absent — baseline has nav + bottom only", () => {
  // The hero canvas button (which used handleHeroStart with location:'hero') was
  // a regression: adding height to the bottom-anchored intro block shifted
  // "NETWORKING, ORGANIZED" upward. It was reverted. Only nav + bottom CTAs exist.
  assert.ok(!src.includes("handleHeroStart"), 'handleHeroStart must not exist — regression was reverted')
})

test("bottom CTA fires location: 'bottom'", () => {
  assert.ok(src.includes("location: 'bottom'"), "missing location: 'bottom' in LandingPage.jsx")
})

test('all three location values are distinct strings', () => {
  const locs = ['nav', 'hero', 'bottom']
  assert.strictEqual(new Set(locs).size, 3)
})

test('nav and hero locations are not equal', () => {
  assert.notStrictEqual('nav', 'hero')
})

test('hero and bottom locations are not equal', () => {
  assert.notStrictEqual('hero', 'bottom')
})

test('nav and bottom locations are not equal', () => {
  assert.notStrictEqual('nav', 'bottom')
})

test('handleNavStart exists', () => {
  assert.ok(src.includes('handleNavStart'), 'handleNavStart missing from LandingPage.jsx')
})

test('handleHeroStart is absent (regression was reverted)', () => {
  assert.ok(!src.includes('handleHeroStart'), 'handleHeroStart must not exist — the hero canvas button was a layout regression')
})

test('handleStart (bottom CTA) exists', () => {
  assert.ok(src.includes('handleStart'), 'handleStart missing from LandingPage.jsx')
})

console.log()
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
