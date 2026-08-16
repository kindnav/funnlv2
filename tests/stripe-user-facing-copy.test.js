/**
 * R8 targeted test: no NEW user-visible Stripe/billing string (Edge Function API error
 * bodies + frontend billing/checkout UI copy) contains an em dash (U+2014) or &mdash;.
 * Scoped to Stripe surfaces — NOT a whole-repo ban (historical comments may use them).
 *
 * Zero deps — runs with: node tests/stripe-user-facing-copy.test.js
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0, failed = 0
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ } }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }

const EM = '—'

// Extract user-visible message string literals: the value of `error:` JSON fields in the
// Edge Functions, and single-quoted strings assigned to *Error setters / passed to
// setSubscribeError / setBillingPortalError in the frontend.
function edgeErrorStrings(src) {
  const out = []
  const re = /error:\s*'([^']*)'/g
  let m
  while ((m = re.exec(src)) !== null) out.push(m[1])
  return out
}
function frontendBillingStrings(src) {
  const out = []
  const re = /set(?:Subscribe|BillingPortal)Error\('([^']*)'\)/g
  let m
  while ((m = re.exec(src)) !== null) out.push(m[1])
  return out
}

const checkoutOrch = readFileSync(join(ROOT, 'supabase/functions/create-checkout-session/checkoutOrchestrator.js'), 'utf8')
const portal       = readFileSync(join(ROOT, 'supabase/functions/create-billing-portal-session/index.ts'), 'utf8')
const settings     = readFileSync(join(ROOT, 'src/pages/SettingsPage.jsx'), 'utf8')
const ai           = readFileSync(join(ROOT, 'src/pages/FunnlAIPage.jsx'), 'utf8')

const groups = [
  ['checkoutOrchestrator error bodies', edgeErrorStrings(checkoutOrch)],
  ['billing-portal error bodies',       edgeErrorStrings(portal)],
  ['SettingsPage billing errors',       frontendBillingStrings(settings)],
  ['FunnlAIPage billing errors',        frontendBillingStrings(ai)],
]

for (const [label, strings] of groups) {
  test(`${label}: at least one message found`, () => {
    assert(strings.length > 0, `expected to find user-visible strings in ${label}`)
  })
  test(`${label}: no em dash / &mdash; in any message`, () => {
    for (const s of strings) {
      assert(!s.includes(EM), `em dash in ${label}: "${s}"`)
      assert(!s.includes('&mdash;'), `&mdash; in ${label}: "${s}"`)
    }
  })
}

// The known billing-portal messages must be em-dash-free specifically.
test('billing-portal known messages are em-dash-free', () => {
  const needles = [
    'Could not load billing information',
    'Billing portal not configured',
    'Could not open billing portal',
    'Something went wrong',
  ]
  for (const n of needles) {
    const idx = portal.indexOf(n)
    assert(idx !== -1, `expected message present: ${n}`)
    // The surrounding string literal must not contain an em dash.
    const around = portal.slice(idx, idx + 80)
    assert(!around.includes(EM), `em dash near "${n}"`)
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
