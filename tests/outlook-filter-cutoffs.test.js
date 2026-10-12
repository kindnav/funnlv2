// Offline behavioural checks for the owner-run filter check's cutoff arithmetic.
//
// The point of these is one defect: the helper chose a cutoff, described it in terms of the
// instant it chose, and the production builder then TRUNCATED the fraction off before
// sending it. Every assertion below is about the TRANSMITTED value - the one the request
// actually carries - and the transmission is done by the production formatter itself, not by
// a copy of its rules.
//
// Run with: node tests/outlook-filter-cutoffs.test.js

import assert from 'node:assert'
import {
  transmitted, inclusiveCutoff, exclusiveCutoff, discriminatingCutoff, wouldInclude,
} from '../scripts/lib/outlook-filter-cutoffs.mjs'

let passed = 0, failed = 0
function test (name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

console.log('\nwhat the builder actually transmits')

test('the production formatter TRUNCATES the fraction, it does not round', () => {
  assert.strictEqual(transmitted('2026-10-02T10:00:00.900Z'), '2026-10-02T10:00:00Z')
  assert.strictEqual(transmitted('2026-10-02T10:00:00.100Z'), '2026-10-02T10:00:00Z')
  assert.strictEqual(transmitted('2026-10-02T10:00:00Z'), '2026-10-02T10:00:00Z')
})

console.log('\nthe reproduced wrong claim')

test('two instants inside ONE second: no whole-second cutoff separates them', () => {
  // The exact case that was wrong: the midpoint is 10:00:00.500Z, the builder sends
  // 10:00:00Z, and that is below BOTH instants - the request discriminates nothing.
  const r = discriminatingCutoff('2026-10-02T10:00:00.100Z', '2026-10-02T10:00:00.900Z')
  assert.strictEqual(r.available, false, 'must be NOT AVAILABLE')
  assert.strictEqual(r.cutoff, null)
  assert.match(r.reason, /same second|fraction/)
})

test('and the naive midpoint really would have failed, measured', () => {
  const a = '2026-10-02T10:00:00.100Z'
  const b = '2026-10-02T10:00:00.900Z'
  const naive = transmitted(new Date((Date.parse(a) + Date.parse(b)) / 2).toISOString())
  assert.strictEqual(naive, '2026-10-02T10:00:00Z')
  // Both included under the transmitted cutoff: nothing is separated.
  assert.strictEqual(wouldInclude(a, naive), true)
  assert.strictEqual(wouldInclude(b, naive), true)
})

console.log('\na valid separated-timestamp control')

test('instants in different seconds DO yield a strictly-between whole second', () => {
  const received = '2026-10-02T09:00:00.000Z'
  const sent = '2026-10-02T08:59:30.000Z'
  const r = discriminatingCutoff(received, sent)
  assert.strictEqual(r.available, true, r.reason ?? '')
  assert.strictEqual(r.transmitted, '2026-10-02T08:59:31Z')
  // Strictly between, AFTER formatting - the property the choice exists to guarantee.
  assert.ok(Date.parse(r.transmitted) > Date.parse(sent))
  assert.ok(Date.parse(r.transmitted) < Date.parse(received))
  // And it genuinely discriminates: included under one property, excluded under the other.
  assert.strictEqual(wouldInclude(received, r.transmitted), true)
  assert.strictEqual(wouldInclude(sent, r.transmitted), false)
  assert.strictEqual(r.includedUnder, 'a')
  assert.strictEqual(r.excludedUnder, 'b')
})

test('a fractional pair in DIFFERENT seconds still works', () => {
  const r = discriminatingCutoff('2026-10-02T10:00:02.400Z', '2026-10-02T10:00:00.900Z')
  assert.strictEqual(r.available, true, r.reason ?? '')
  assert.strictEqual(r.transmitted, '2026-10-02T10:00:01Z')
  assert.strictEqual(wouldInclude('2026-10-02T10:00:02.400Z', r.transmitted), true)
  assert.strictEqual(wouldInclude('2026-10-02T10:00:00.900Z', r.transmitted), false)
})

test('exactly one second apart is refused rather than resting on an equality edge', () => {
  // The only whole second strictly after the earlier instant IS the later instant, and `ge`
  // would include it. That discriminates, but it turns on the boundary being inclusive;
  // NOT AVAILABLE keeps the owner's report free of that argument.
  const r = discriminatingCutoff('2026-10-02T10:00:01Z', '2026-10-02T10:00:00Z')
  assert.strictEqual(r.available, false)
})

test('identical instants are NOT AVAILABLE, with the reason said plainly', () => {
  const r = discriminatingCutoff('2026-10-02T10:00:00Z', '2026-10-02T10:00:00Z')
  assert.strictEqual(r.available, false)
  assert.match(r.reason, /identical/)
})

console.log('\ninclusion and exclusion')

test('an EXACT inclusive-boundary test is claimed only for a whole-second timestamp', () => {
  const whole = inclusiveCutoff('2026-10-02T10:00:00Z')
  assert.strictEqual(whole.transmitted, '2026-10-02T10:00:00Z')
  assert.strictEqual(whole.exact, true, 'the transmitted cutoff equals the message timestamp')

  const frac = inclusiveCutoff('2026-10-02T10:00:00.900Z')
  assert.strictEqual(frac.transmitted, '2026-10-02T10:00:00Z')
  assert.strictEqual(frac.exact, false,
    'the transmitted cutoff is below the message, so the boundary itself is untested')
  // It still demonstrates INCLUSION, which is all it may be reported as.
  assert.strictEqual(wouldInclude('2026-10-02T10:00:00.900Z', frac.transmitted), true)
})

test('the exclusion cutoff excludes, fractional or not', () => {
  for (const iso of ['2026-10-02T10:00:00Z', '2026-10-02T10:00:00.100Z',
    '2026-10-02T10:00:00.999Z']) {
    const e = exclusiveCutoff(iso)
    assert.strictEqual(wouldInclude(iso, e.transmitted), false,
      'must exclude ' + iso + ' at ' + e.transmitted)
    // And it is the NEXT second, not "one second later" naively formatted back down.
    assert.strictEqual(e.transmitted, '2026-10-02T10:00:01Z')
  }
})

test('a malformed instant is refused rather than guessed at', () => {
  assert.strictEqual(inclusiveCutoff('not a time').ok, false)
  assert.strictEqual(exclusiveCutoff('').ok, false)
  assert.strictEqual(discriminatingCutoff('nope', '2026-10-02T10:00:00Z').available, false)
  assert.strictEqual(wouldInclude('nope', '2026-10-02T10:00:00Z'), null)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
