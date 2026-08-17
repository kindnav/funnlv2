// Google "Connected accounts" UI-state helper tests.
// Run with: node tests/google-connection-ui.test.js
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import {
  classifyGoogleConnection, parseGoogleReturnParam, hasCalendarScope, GOOGLE_CALENDAR_SCOPE,
} from '../src/lib/googleConnection.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const card = readFileSync(join(__dirname, '..', 'src/components/GoogleConnectionCard.jsx'), 'utf8')

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

// ── Card lifecycle + error UX (Correction 6) ──────────────────────────────────
console.log('\ncard lifecycle + Retry UX')
test('mountedRef is Strict-Mode safe: set true on mount, false on cleanup', () => {
  assert.ok(/mountedRef\.current = true\s*\n\s*return \(\) => \{ mountedRef\.current = false \}/.test(card))
})
test("error state shows a Retry button wired to fetchConnection", () => {
  // fetchConnection is used as an onClick only by the Retry control.
  assert.ok(/onClick=\{fetchConnection\}[\s\S]*?\{loading \? 'Retrying…' : 'Retry'\}/.test(card),
    'Retry button calls fetchConnection and shows Retry/Retrying')
})
test('Retry is disabled while loading (no duplicate retries)', () => {
  assert.ok(/onClick=\{fetchConnection\}[\s\S]*?disabled=\{loading\}[\s\S]*?Retry/.test(card))
})
test("the Connect button is never rendered for the error state", () => {
  // The old combined condition (not_connected || error) must be gone.
  assert.ok(!/state === 'not_connected' \|\| state === 'error'/.test(card))
})
test("Connect only offered for definitive not_connected; Reconnect for needs_reauth", () => {
  assert.ok(/state === 'not_connected' &&[\s\S]*?onClick=\{handleConnect\}/.test(card))
  assert.ok(/state === 'needs_reauth' &&[\s\S]*?onClick=\{handleConnect\}/.test(card))
  // Connect button is NOT rendered for the error state.
  assert.ok(!/state === 'not_connected' \|\| state === 'error'/.test(card))
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
