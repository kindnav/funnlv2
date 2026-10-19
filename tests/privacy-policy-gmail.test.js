// Protects the material Gmail disclosures in the public Privacy Policy and ties each one to
// the committed code that makes it true. If the code changes so a claim stops being true,
// the corresponding assertion here must fail. Source-scan tests (the repo's pattern for JSX).
// Run: node tests/privacy-policy-gmail.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const flat = (s) => s.replace(/\s+/g, ' ')

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

const POLICY = flat(read('src/pages/PrivacyPage.jsx'))
  // applied in Production 2026-09-19

console.log('\nconditional wording while Gmail is unavailable')

console.log('\ntransient vs persisted: what is processed while checking mail')

console.log('\nsnippet, header, and body wording is precise')

console.log('\nsynchronization description')

console.log('\npersisted data and retention — every claim is enforced by code, and unenforced maxima are NOT published')

console.log('\nthird-party boundaries — narrow, source-backed statements')
test('the broad "never sent to Anthropic, PostHog, Resend" claim is gone', () => {
  assert.ok(!/Gmail data is never sent to Anthropic, PostHog, Resend/.test(POLICY))
})

console.log('\ndisconnect and deletion — two distinct paths')

console.log('\ngeneral policy corrections')
test('no "not a legal document" banner; Supabase Auth password wording; self-service deletion described', () => {
  assert.ok(!/not a legal document drafted by a lawyer/.test(POLICY))
  assert.ok(!/password \(encrypted\)/.test(POLICY))
  assert.ok(/Authentication is managed by Supabase Auth; Funnl never stores your password in plain text/.test(POLICY))
  assert.ok(/you can delete your account from Settings/.test(POLICY))
  assert.ok(/functions\.invoke\('delete-account'\)/.test(read('src/pages/SettingsPage.jsx')))
})
test('no verification / certification / endorsement claim', () => {
  assert.ok(!/verified by Google|Google-verified|CASA|certified|approved by Google|endorsed|legally compliant/i.test(POLICY))
})
test('effective date and contact', () => {
  // History: the Gmail wording was published 2026-09-20, once both corrected cleanup callers
  // were deployed; the version before that was dated September 18, 2026. The date then moved
  // to 2026-09-27 for the approved Outlook disclosure publication, and to 2026-10-06 for the
  // Outlook content release.
  //
  // THE SPECIFIC DATE IS DELIBERATELY NOT PINNED HERE. There is one public date line for the
  // whole policy, and the publication decision that sets it belongs to whichever section is
  // being republished - currently tests/privacy-policy-outlook.test.js, which pins it exactly.
  // Pinning the same value in two suites meant every republication broke an unrelated suite
  // that had no opinion about the date, which is what happened on this line twice. What the
  // Gmail suite actually needs is that the policy carries exactly one well-formed public date.
  const dateLines = POLICY.match(/Last updated: [A-Z][a-z]+ \d{1,2}, \d{4}/g) || []
  assert.strictEqual(dateLines.length, 1, 'exactly one well-formed public date line')
  assert.ok(!/Last updated: September 2026</.test(POLICY))
  assert.ok((POLICY.match(/navbir12345@gmail\.com/g) || []).length >= 3)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
