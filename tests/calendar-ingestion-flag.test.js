// Tests for calendarIngestionEnabled — the Phase A ingestion rollout flag predicate.
// Pure Node.js. Run: node tests/calendar-ingestion-flag.test.js
//
// Note: only the PURE predicate is imported. CALENDAR_INGESTION_ENABLED reads
// import.meta.env (Vite) which is undefined under Node — that path is exercised
// by the build, not here. Importing the module in Node would evaluate to disabled.

import assert from 'assert'
import { calendarIngestionEnabled } from '../src/lib/calendarIngestion.js'

let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

console.log('\ncalendarIngestionEnabled — exact-true only')

test("exactly 'true' → enabled", () => {
  assert.strictEqual(calendarIngestionEnabled('true'), true)
})
test('every other value → disabled', () => {
  for (const v of ['false', 'TRUE', 'True', '1', ' true', 'true ', '', 'yes', 'on']) {
    assert.strictEqual(calendarIngestionEnabled(v), false, `${JSON.stringify(v)} should be disabled`)
  }
})
test('non-string values → disabled', () => {
  for (const v of [undefined, null, true, 1, {}, []]) {
    assert.strictEqual(calendarIngestionEnabled(v), false)
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
