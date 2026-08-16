// Regression test: no `.catch()` chained onto a Supabase PostgREST query builder.
//
// Demonstrated failure (Preview console, repeated on every navigation):
//   TypeError: U.from(...).select(...).eq(...).maybeSingle(...).catch is not a function
//
// PostgREST builders are thenable but do NOT implement `.catch`, so chaining
// `.catch(...)` directly onto `.maybeSingle()` / `.eq()` throws synchronously.
// In Sidebar.fetchProfile the un-awaited call surfaced as a repeating unhandled
// rejection; in SettingsPage it broke the profile + contact-count load. The fix
// awaits inside try/catch instead. This test guards both files against the
// pattern regressing.
//
// Run with: node tests/query-builder-catch.test.js

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

const settings = read('src/pages/SettingsPage.jsx')
const sidebar = read('src/components/Sidebar.jsx')

console.log('\nNo builder .catch in the affected files')

test('SettingsPage.jsx contains no .catch( chained on a query', () => {
  assert.ok(!/\.catch\(/.test(settings), 'SettingsPage still chains .catch()')
})
test('Sidebar.jsx contains no .catch( chained on a query', () => {
  assert.ok(!/\.catch\(/.test(sidebar), 'Sidebar still chains .catch()')
})

console.log('\nDemonstrated failure pattern is gone')

// The specific broken chain: a builder terminator immediately followed by .catch.
const brokenChain = /\.(maybeSingle|single)\(\)\s*\.catch\(/m
test('SettingsPage.jsx has no maybeSingle().catch( chain', () => {
  assert.ok(!brokenChain.test(settings), 'SettingsPage still has maybeSingle().catch()')
})
test('Sidebar.jsx has no maybeSingle().catch( chain', () => {
  assert.ok(!brokenChain.test(sidebar), 'Sidebar still has maybeSingle().catch()')
})

console.log('\nBehavior preserved (queries still present)')

test('SettingsPage.jsx still queries profiles via maybeSingle()', () => {
  assert.ok(settings.includes('.maybeSingle()'), 'SettingsPage lost its maybeSingle query')
})
test('Sidebar.jsx still queries the profile via maybeSingle()', () => {
  assert.ok(sidebar.includes('.maybeSingle()'), 'Sidebar lost its maybeSingle query')
})
test('Sidebar.fetchProfile awaits inside try/catch', () => {
  // The fix wraps the awaited query in try/catch rather than chaining .catch.
  const idx = sidebar.indexOf('const fetchProfile')
  assert.ok(idx !== -1, 'fetchProfile not found')
  const slice = sidebar.slice(idx, idx + 400)
  assert.ok(/try\s*\{/.test(slice) && /catch\s*\{/.test(slice),
    'fetchProfile no longer uses try/catch')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
