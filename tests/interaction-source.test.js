// Tests for interaction/suggestion source provenance helpers + the provider-aware
// presentation model. Zero-dependency; run: node tests/interaction-source.test.js

import assert from 'assert'
import {
  INTERACTION_SOURCES, DEFAULT_INTERACTION_SOURCE, GOOGLE_CALENDAR_SOURCE, SOURCE_PROVIDERS,
  getSourceProvider, isGoogleCalendarSource, isValidInteractionSource,
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

console.log('\nprovider registry (extensible; only functional sources listed)')
test('only google_calendar is a functional provider today', () => {
  assert.deepStrictEqual(Object.keys(SOURCE_PROVIDERS), ['google_calendar'])
  // gmail/outlook must NOT be exposed as providers yet (no nonfunctional UI).
  assert.strictEqual(SOURCE_PROVIDERS.gmail, undefined)
  assert.strictEqual(SOURCE_PROVIDERS.outlook, undefined)
})
test('google_calendar provider carries label + a11y strings', () => {
  const p = SOURCE_PROVIDERS.google_calendar
  assert.strictEqual(p.label, 'Google Calendar')
  assert.strictEqual(p.ariaLabel, 'Source: Google Calendar')
  assert.strictEqual(p.title, 'Added from Google Calendar')
})

console.log('\ngetSourceProvider → badge visibility decision')
test('google_calendar resolves a provider; manual/unknown resolve null (no badge)', () => {
  assert.ok(getSourceProvider('google_calendar'))
  assert.strictEqual(getSourceProvider('google_calendar').label, 'Google Calendar')
  for (const v of ['manual', 'gmail', 'outlook', 'other', '', 'Google_Calendar', ' google_calendar', undefined, null]) {
    assert.strictEqual(getSourceProvider(v), null, `${JSON.stringify(v)} must have no provider badge`)
  }
})
test('manual interactions never resolve a provider', () => {
  assert.strictEqual(getSourceProvider(DEFAULT_INTERACTION_SOURCE), null)
})

console.log('\nisGoogleCalendarSource / validity')
test('isGoogleCalendarSource true only for exact google_calendar', () => {
  assert.strictEqual(isGoogleCalendarSource('google_calendar'), true)
  for (const v of ['manual', 'gmail', '', undefined, null]) {
    assert.strictEqual(isGoogleCalendarSource(v), false)
  }
})
test('isValidInteractionSource mirrors the DB CHECK', () => {
  assert.strictEqual(isValidInteractionSource('manual'), true)
  assert.strictEqual(isValidInteractionSource('google_calendar'), true)
  for (const v of ['', 'gcal', 'gmail', 'outlook', undefined, null]) {
    assert.strictEqual(isValidInteractionSource(v), false)
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
