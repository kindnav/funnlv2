/**
 * dashboard-redundancy.test.js
 *
 * Source-contract tests that guard against information-architecture redundancy
 * in DashboardPage's pulse strip.
 *
 * Defect: the pulse strip contained a { label: 'NETWORK', value: contactCount }
 * stat that duplicated the total contact count already shown in the summary
 * sentence immediately above ("X contacts in your network."). Both were visible
 * simultaneously, repeating the same number in the same viewport.
 *
 * Fix: remove the NETWORK entry from pulseStats. The remaining pulse stats
 * (NEW THIS WEEK, INTERACTIONS, AWAITING, RESPONSE RATE, TOP TAG) are distinct
 * supplemental metrics not shown anywhere else.
 *
 * Run with: node tests/dashboard-redundancy.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const src = readFileSync(resolve('src/pages/DashboardPage.jsx'), 'utf8')

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
// 1. NETWORK stat removed from pulse strip
// =============================================================================

console.log('\n1. NETWORK stat removed from pulseStats')

test("'NETWORK' label is not in the pulseStats array", () => {
  // The pulse strip is the horizontally-scrolling data strip. The NETWORK stat
  // was the first entry — it duplicated contactCount from the summary sentence.
  assert.ok(
    !src.includes("label: 'NETWORK'"),
    "pulseStats must not contain { label: 'NETWORK' } — it duplicates the summary sentence"
  )
})

test('contactCount is not the first pulseStats entry', () => {
  // Even if the label changed, String(contactCount) as the first/only value
  // without a conditionality guard would still duplicate the summary.
  const pulseMatch = src.match(/const pulseStats\s*=\s*\[([\s\S]*?)\]\.filter/)
  if (pulseMatch) {
    const pulseBody = pulseMatch[1]
    // The first non-null entry should NOT be the raw contactCount
    const firstEntry = pulseBody.trim().split('\n')[0].trim()
    assert.ok(
      !firstEntry.includes('String(contactCount)') || firstEntry.includes('?'),
      'raw contactCount without a conditional guard must not be the first pulseStats entry'
    )
  }
  // If the regex doesn't match, the structure changed enough that this check is moot.
})

// =============================================================================
// 2. Summary sentence still shows contactCount
// =============================================================================

console.log('\n2. Summary sentence still shows the contact total')

test('contactCount appears in the summary sentence', () => {
  // The removal of the NETWORK stat from the pulse strip must not have also
  // removed the primary display of contactCount in the summary sentence.
  // The sentence uses a conditional plural: contact{...} in your network.
  assert.ok(
    src.includes('in your network'),
    '"in your network" summary sentence must still exist'
  )
})

test('contactCount is still used in the render', () => {
  // After removing one usage, contactCount must still appear elsewhere.
  // If it was removed entirely, the summary sentence would be broken.
  const usages = (src.match(/contactCount/g) || []).length
  assert.ok(
    usages >= 3,
    `contactCount should appear multiple times (state declaration, setter, render). Found ${usages}.`
  )
})

// =============================================================================
// 3. Remaining pulse stats are distinct
// =============================================================================

console.log('\n3. Remaining pulse stats are distinct metrics')

test("'NEW THIS WEEK' stat is still in pulseStats", () => {
  assert.ok(
    src.includes("label: 'NEW THIS WEEK'"),
    "NEW THIS WEEK stat must remain in pulseStats"
  )
})

test("'INTERACTIONS' stat is still in pulseStats", () => {
  assert.ok(
    src.includes("label: 'INTERACTIONS'"),
    "INTERACTIONS stat must remain in pulseStats"
  )
})

test("'AWAITING' stat is still in pulseStats", () => {
  assert.ok(
    src.includes("label: 'AWAITING'"),
    "AWAITING stat must remain in pulseStats"
  )
})

test("'RESPONSE RATE' stat is still in pulseStats", () => {
  assert.ok(
    src.includes("label: 'RESPONSE RATE'"),
    "RESPONSE RATE stat must remain in pulseStats"
  )
})

test("'TOP TAG' stat is still in pulseStats", () => {
  assert.ok(
    src.includes("label: 'TOP TAG'"),
    "TOP TAG stat must remain in pulseStats"
  )
})

// =============================================================================
// 4. pulseStats array still exists and filters nulls
// =============================================================================

console.log('\n4. pulseStats array structure intact')

test('pulseStats uses .filter(Boolean) to exclude null entries', () => {
  assert.ok(
    src.includes('].filter(Boolean)'),
    'pulseStats must use .filter(Boolean) to remove conditional null entries'
  )
})

// =============================================================================
// Results
// =============================================================================

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
