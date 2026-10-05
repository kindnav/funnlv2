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
test('the source list mirrors the DB CHECK, which admits all four', () => {
  // Widened deliberately. interactions_source_check allows manual, google_calendar,
  // gmail and outlook, and accept_interaction_candidate sets source = 'outlook' for an
  // accepted Outlook suggestion - so calling 'outlook' invalid here contradicted the
  // database.
  assert.deepStrictEqual(INTERACTION_SOURCES, ['manual', 'google_calendar', 'gmail', 'outlook'])
  assert.strictEqual(DEFAULT_INTERACTION_SOURCE, 'manual')
  assert.strictEqual(GOOGLE_CALENDAR_SOURCE, 'google_calendar')
})

console.log('\nprovider registry (extensible; only functional sources listed)')
test('a provider is listed only when its suggestions can reach the review queue', () => {
  // outlook is now PRESENTED, because a pending Outlook suggestion can appear in the
  // queue. gmail stays absent: nothing produces a reviewable Gmail suggestion, so a
  // label for it would sit on a surface that never renders.
  assert.deepStrictEqual(Object.keys(SOURCE_PROVIDERS), ['google_calendar', 'outlook'])
  assert.strictEqual(SOURCE_PROVIDERS.gmail, undefined)
  assert.strictEqual(SOURCE_PROVIDERS.manual, undefined)
})
test('the outlook provider carries label + a11y strings and no Microsoft branding claim', () => {
  const p = SOURCE_PROVIDERS.outlook
  assert.strictEqual(p.label, 'Outlook')
  assert.strictEqual(p.ariaLabel, 'Source: Outlook')
  assert.ok(p.title.length > 0)
  for (const s of [p.label, p.ariaLabel, p.title]) {
    assert.ok(!/Microsoft 365|Office 365|®|™/.test(s),
      `provider text must not imply endorsement: ${s}`)
  }
})
test('google_calendar provider carries label + a11y strings', () => {
  const p = SOURCE_PROVIDERS.google_calendar
  assert.strictEqual(p.label, 'Google Calendar')
  assert.strictEqual(p.ariaLabel, 'Source: Google Calendar')
  assert.strictEqual(p.title, 'Added from Google Calendar')
})

console.log('\ngetSourceProvider → badge visibility decision')
test('the two presented sources resolve a provider; manual/unknown resolve null', () => {
  assert.strictEqual(getSourceProvider('google_calendar').label, 'Google Calendar')
  assert.strictEqual(getSourceProvider('outlook').label, 'Outlook')
  for (const v of ['manual', 'gmail', 'other', '', 'Outlook', ' outlook', 'Google_Calendar',
    ' google_calendar', undefined, null]) {
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
test('isValidInteractionSource mirrors the DB CHECK, all four values', () => {
  for (const v of ['manual', 'google_calendar', 'gmail', 'outlook']) {
    assert.strictEqual(isValidInteractionSource(v), true, v)
  }
  // Validity is not the same as being presented: gmail is a valid source with no badge.
  assert.strictEqual(getSourceProvider('gmail'), null)
  for (const v of ['', 'gcal', 'Outlook', ' outlook', 'microsoft', undefined, null]) {
    assert.strictEqual(isValidInteractionSource(v), false, String(v))
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
