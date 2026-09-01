// Tests for interaction source provenance helpers + the badge show/hide decision.
// Zero-dependency; run: node tests/interaction-source.test.js

import assert from 'assert'
import {
  INTERACTION_SOURCES, DEFAULT_INTERACTION_SOURCE, GOOGLE_CALENDAR_SOURCE,
  isGoogleCalendarSource, isValidInteractionSource,
} from '../src/lib/interactionSource.js'

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

console.log('\nconstants')
test('sources are exactly manual + google_calendar; default is manual', () => {
  assert.deepStrictEqual(INTERACTION_SOURCES, ['manual', 'google_calendar'])
  assert.strictEqual(DEFAULT_INTERACTION_SOURCE, 'manual')
  assert.strictEqual(GOOGLE_CALENDAR_SOURCE, 'google_calendar')
})

console.log('\nbadge visibility decision (isGoogleCalendarSource)')
test('google_calendar → badge shows; everything else → hidden', () => {
  assert.strictEqual(isGoogleCalendarSource('google_calendar'), true)
  // Manual + any other/unknown/missing value must NOT show the badge.
  for (const v of ['manual', 'other', '', 'Google_Calendar', ' google_calendar', undefined, null, 0, false]) {
    assert.strictEqual(isGoogleCalendarSource(v), false, `${JSON.stringify(v)} must not show the badge`)
  }
})
test('manual interactions never show the Google badge', () => {
  assert.strictEqual(isGoogleCalendarSource(DEFAULT_INTERACTION_SOURCE), false)
})

console.log('\nsource validity (mirrors DB CHECK)')
test('only the two constrained labels are valid', () => {
  assert.strictEqual(isValidInteractionSource('manual'), true)
  assert.strictEqual(isValidInteractionSource('google_calendar'), true)
  for (const v of ['', 'gcal', 'GOOGLE_CALENDAR', undefined, null, 'outlook']) {
    assert.strictEqual(isValidInteractionSource(v), false, `${JSON.stringify(v)} must be invalid`)
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
