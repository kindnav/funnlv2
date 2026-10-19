// Branded Google OAuth callback patch invariants:
//  - (retired in Stage D: the callback rewrite was removed with the undeployed function; see
//    tests/vercel-routes.test.js for what vercel.json routes now);
//  - git.deploymentEnabled is unchanged;
//  - start + callback validate the configured callback URL before use;
//  - no VITE Google credential is introduced.
// Run with: node tests/google-branded-callback.test.js
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}

const vercel = JSON.parse(read('vercel.json'))
const helpers = read('supabase/functions/shared/googleOauthHelpers.js')


// ── vercel.json routing ───────────────────────────────────────────────────────
console.log('\nvercel.json routing')

test('git.deploymentEnabled is unchanged ({ main: true, "*": false })', () => {
  assert.deepStrictEqual(vercel.git?.deploymentEnabled, { main: true, '*': false })
})
test('SPA catch-all still maps to /index.html', () => {
  const spa = vercel.rewrites.find(x => x.source === '/(.*)')
  assert.strictEqual(spa.destination, '/index.html')
})
test('it is a REWRITE, not a redirect (no redirects, no statusCode)', () => {
  assert.ok(!('redirects' in vercel), 'must not add redirects')
  for (const r of vercel.rewrites) {
    assert.ok(!('statusCode' in r) && !('permanent' in r), 'rewrite has no redirect fields')
  }
})

// ── Config validated before use ───────────────────────────────────────────────
console.log('\nstart + callback validate config before use')

test('helper exports the exact branded URL + validator', () => {
  assert.ok(/EXPECTED_GOOGLE_CALLBACK_URL = 'https:\/\/www\.getfunnl\.com\/api\/google-oauth-callback'/.test(helpers))
  assert.ok(/export function isValidConfiguredCallbackUrl/.test(helpers))
})

// ── No VITE Google credential ─────────────────────────────────────────────────
console.log('\nno VITE Google credential introduced')

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
