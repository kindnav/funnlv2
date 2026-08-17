// Client-side rollout flag tests for VITE_CALENDAR_CONNECTION_ENABLED.
// Predicate + fail-safe default + source-scan proofs that the Settings card is
// gated, disabled mode cannot invoke the OAuth functions, and no VITE Google
// credential is introduced. Run with: node tests/google-rollout-flag.test.js
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { calendarConnectionEnabled, CALENDAR_CONNECTION_ENABLED } from '../src/lib/googleConnection.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8')

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}

const card = read('src/components/GoogleConnectionCard.jsx')
const settings = read('src/pages/SettingsPage.jsx')
const lib = read('src/lib/googleConnection.js')

// ── Predicate ─────────────────────────────────────────────────────────────────
console.log('\ncalendarConnectionEnabled predicate')
test('exact "true" enables', () => assert.strictEqual(calendarConnectionEnabled('true'), true))
test('missing / empty / false / TRUE / 1 / padded / null all disable', () => {
  for (const v of [undefined, '', 'false', 'TRUE', 'True', '1', ' true', 'true ', 'yes', null, 1, true]) {
    assert.strictEqual(calendarConnectionEnabled(v), false, `expected disabled for ${JSON.stringify(v)}`)
  }
})
test('CALENDAR_CONNECTION_ENABLED defaults DISABLED (no Vite env in Node)', () => {
  assert.strictEqual(CALENDAR_CONNECTION_ENABLED, false)
})
test('flag reads VITE_CALENDAR_CONNECTION_ENABLED via exact "true"', () => {
  assert.ok(lib.includes('import.meta.env?.VITE_CALENDAR_CONNECTION_ENABLED'))
  assert.ok(lib.includes("rawValue === 'true'"))
})

// ── Settings card is gated by the same constant ───────────────────────────────
console.log('\nSettings gating')
test('SettingsPage imports the flag and gates the card with it', () => {
  assert.ok(settings.includes("import { CALENDAR_CONNECTION_ENABLED } from '../lib/googleConnection'"))
  assert.ok(/\{CALENDAR_CONNECTION_ENABLED && \([\s\S]*<GoogleConnectionCard \/>/.test(settings),
    'the Connected accounts card must be wrapped in a CALENDAR_CONNECTION_ENABLED guard')
})

// ── Disabled mode cannot invoke the OAuth functions ───────────────────────────
console.log('\ndisabled mode cannot invoke OAuth')
test('handleConnect early-returns when disabled', () => {
  const i = card.indexOf('function handleConnect')
  const slice = card.slice(i, i + 200)
  assert.ok(/if \(!CALENDAR_CONNECTION_ENABLED\) return/.test(slice), 'handleConnect must guard on the flag')
})
test('handleDisconnect early-returns when disabled', () => {
  const i = card.indexOf('function handleDisconnect')
  const slice = card.slice(i, i + 200)
  assert.ok(/if \(!CALENDAR_CONNECTION_ENABLED\) return/.test(slice), 'handleDisconnect must guard on the flag')
})
test('the card renders nothing and runs no effect side-effects when disabled', () => {
  assert.ok(/if \(!CALENDAR_CONNECTION_ENABLED\) return null/.test(card), 'card returns null when disabled')
  // mount effect guards before parsing the banner / fetching
  const eff = card.slice(card.indexOf('useEffect(() => {\n    if (!CALENDAR_CONNECTION_ENABLED) return'))
  assert.ok(eff.length > 0, 'mount effect must guard on the flag before any side effect')
})

// ── Enabled mode retains the reviewed UI ──────────────────────────────────────
console.log('\nenabled mode retains UI')
test('the connect/disconnect Edge invocations are still present (enabled path)', () => {
  assert.ok(card.includes("supabase.functions.invoke('google-oauth-start'"))
  assert.ok(card.includes("supabase.functions.invoke('google-oauth-disconnect'"))
  assert.ok(card.includes('Connect Google Calendar'))
  assert.ok(card.includes('Disconnect'))
})

// ── No VITE Google credential introduced ──────────────────────────────────────
console.log('\nno VITE Google credential')
test('only the boolean flag is read from Vite — no id/secret/scope/token/callback', () => {
  for (const src of [lib, card, settings]) {
    // The only permitted VITE_ read for Google is the boolean rollout flag.
    const viteReads = [...src.matchAll(/import\.meta\.env\??\.\s*([A-Z0-9_]+)/g)].map(m => m[1])
    for (const name of viteReads) {
      assert.ok(name === 'VITE_CALENDAR_CONNECTION_ENABLED', `unexpected Vite env read: ${name}`)
    }
    assert.ok(!/VITE_GOOGLE_|client_secret|CLIENT_SECRET|ENCRYPTION_KEY|refresh_token|access_token/i.test(src),
      'no Google credential material in the frontend')
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
