// Google "Connected accounts" UI-state helper tests.
// Run with: node tests/google-connection-ui.test.js
import assert from 'assert'
import {
  classifyGoogleConnection, parseGoogleReturnParam, hasCalendarScope, GOOGLE_CALENDAR_SCOPE,
} from '../src/lib/googleConnection.js'

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}

console.log('\nclassifyGoogleConnection')
test('loading', () => assert.strictEqual(classifyGoogleConnection({ loading: true, error: false, connection: null }), 'loading'))
test('error (fetch failed)', () => assert.strictEqual(classifyGoogleConnection({ loading: false, error: true, connection: null }), 'error'))
test('not_connected (no row)', () => assert.strictEqual(classifyGoogleConnection({ loading: false, error: false, connection: null }), 'not_connected'))
test('connected (active row)', () => assert.strictEqual(classifyGoogleConnection({ loading: false, error: false, connection: { status: 'active' } }), 'connected'))
test('needs_reauth (needs_reauth status)', () => assert.strictEqual(classifyGoogleConnection({ loading: false, error: false, connection: { status: 'needs_reauth' } }), 'needs_reauth'))
test('needs_reauth (revoked status)', () => assert.strictEqual(classifyGoogleConnection({ loading: false, error: false, connection: { status: 'revoked' } }), 'needs_reauth'))
test('loading takes priority over a stale connection', () => assert.strictEqual(classifyGoogleConnection({ loading: true, error: false, connection: { status: 'active' } }), 'loading'))

console.log('\nparseGoogleReturnParam')
test('connected', () => assert.strictEqual(parseGoogleReturnParam('?google=connected'), 'connected'))
test('error', () => assert.strictEqual(parseGoogleReturnParam('?google=error'), 'error'))
test('absent / unknown → null', () => {
  assert.strictEqual(parseGoogleReturnParam(''), null)
  assert.strictEqual(parseGoogleReturnParam('?foo=bar'), null)
  assert.strictEqual(parseGoogleReturnParam('?google=whatever'), null)
})

console.log('\nhasCalendarScope')
test('true when calendar read-only present', () => assert.ok(hasCalendarScope([GOOGLE_CALENDAR_SCOPE, 'openid'])))
test('false when absent / not an array', () => {
  assert.ok(!hasCalendarScope(['openid', 'email']))
  assert.ok(!hasCalendarScope(null))
  assert.ok(!hasCalendarScope(undefined))
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
