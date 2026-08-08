/**
 * landing-page-spacing.test.js
 *
 * Source-contract tests that guard the LandingPage hero spacing regression.
 *
 * Root cause: a "Start for free" button was added inside the hero intro block,
 * which is `position: absolute; bottom: 6%`. Because the block is anchored at
 * the bottom, adding height shifts its top upward — making "NETWORKING,
 * ORGANIZED" appear closer to the funnel mark than intended.
 *
 * Fix: revert the 4 changes introduced by the regression:
 *   1. Remove `onStart` from the HeroSection function signature
 *   2. Remove the {onStart && <button>} conditional inside HeroSection
 *   3. Remove the handleHeroStart function from LandingPage
 *   4. Remove onStart={handleHeroStart} from the HeroSection call site
 *
 * These tests verify the source is at the correct baseline.
 *
 * Run with: node tests/landing-page-spacing.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const src = readFileSync(resolve('src/pages/LandingPage.jsx'), 'utf8')

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

// =============================================================================
// 1. HeroSection signature
// =============================================================================

console.log('\n1. HeroSection signature — no onStart parameter')

test('HeroSection does not accept onStart prop', () => {
  // The regression added `onStart` to the function signature. The button it
  // powers is inside the bottom-anchored intro block, which shifts the
  // "NETWORKING, ORGANIZED" text upward when extra height is added.
  assert.ok(
    !src.includes('HeroSection({ t, nat, reduced, onStart }') &&
    !src.includes('HeroSection({t,nat,reduced,onStart}'),
    'HeroSection must not have onStart in its parameter list'
  )
})

test('HeroSection has exactly the baseline 3 props (t, nat, reduced)', () => {
  assert.ok(
    src.includes('function HeroSection({ t, nat, reduced })'),
    'HeroSection must accept exactly { t, nat, reduced }'
  )
})

// =============================================================================
// 2. No regression button inside HeroSection
// =============================================================================

console.log('\n2. No extra button inside the bottom-anchored intro block')

test('handleHeroStart function does not exist', () => {
  assert.ok(
    !src.includes('handleHeroStart'),
    'handleHeroStart must not exist — it was part of the regression'
  )
})

test('onStart conditional button is not rendered inside HeroSection', () => {
  assert.ok(
    !src.includes('{onStart &&'),
    '{onStart && ...} conditional must not exist in HeroSection'
  )
})

test('no second Start-for-free button inside the sticky hero canvas', () => {
  // The correct "Start for free" buttons are in the Nav and the scroll-down
  // sections, NOT inside the sticky canvas that overlays the funnel animation.
  // This test counts total "Start for free" occurrences to detect an extra one.
  const count = (src.match(/Start for free/g) || []).length
  // The landing page legitimately has 2 "Start for free" buttons: nav + bottom CTA.
  // If the regression button is present, count would be 3.
  assert.ok(
    count <= 2,
    `Expected at most 2 "Start for free" occurrences (nav + bottom CTA), found ${count}`
  )
})

// =============================================================================
// 3. Call site — no onStart prop passed
// =============================================================================

console.log('\n3. HeroSection call site passes no onStart prop')

test('HeroSection call site does not pass onStart={handleHeroStart}', () => {
  // NavBar and CTASection legitimately use onStart. This test specifically
  // checks that HeroSection is not wired to handleHeroStart.
  assert.ok(
    !src.includes('onStart={handleHeroStart}'),
    'HeroSection must not receive onStart={handleHeroStart} — regression was reverted'
  )
})

// =============================================================================
// 4. Verified structure — intro block retains existing content
// =============================================================================

console.log('\n4. Intro block structure preserved')

test('"Networking, organized" text is still present', () => {
  assert.ok(
    src.includes('Networking, organized'),
    '"Networking, organized" must be present in HeroSection'
  )
})

test('"Meet people. Remember everything." tagline is still present', () => {
  assert.ok(
    src.includes('Meet people. Remember everything.'),
    'hero tagline must still be present'
  )
})

test('Scroll indicator (SCROLL text) still present', () => {
  assert.ok(
    src.includes('SCROLL'),
    'Scroll indicator must remain — it was after the regression button'
  )
})

// =============================================================================
// Results
// =============================================================================

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
