// THE ADMIN-APPROVAL EXPLANATION on a failed Outlook connection.
//
// A school or work tenant that requires admin approval stops the student on Microsoft's
// "Need admin approval" page; if they return, the callback receives a provider error and, by
// design, redirects exactly like every other failure (`?outlook=error`). "Please try again"
// alone is wrong for that case, because retrying cannot succeed until the organisation approves
// the app. The callback CANNOT tell that refusal apart from any other, so the explanation must
// stay conditional ("If ...") - it is a hint, never a diagnosis.
//
// Kept in its own file so this change and the one-owner change (Draft PR #97, which adds its own
// tests to outlook-graph-identity.test.js) merge cleanly in either order.

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { messageForOutcome } from '../src/lib/outlookConnection.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
// Executable code only: explanatory comments name the very symbols the scans look for.
const exec = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')

let passed = 0
let failed = 0
function test (name, fn) {
  try { fn(); console.log('  OK   ' + name); passed += 1 } catch (e) {
    console.error('  FAIL ' + name)
    console.error('       ' + (e && e.message ? e.message : String(e)))
    failed += 1
  }
}

test('the admin-approval sentence is conditional, truthful and leaks nothing', () => {
  const m = messageForOutcome('callback_admin_approval')
  assert.ok(m.length > 0 && m.length <= 220, `${m.length} chars`)
  // Conditional: the callback cannot diagnose the refusal, so the copy must not either.
  assert.ok(/^If /.test(m), m)
  assert.ok(/admin approval/i.test(m) && /organisation has to approve Funnl/.test(m), m)
  assert.ok(/won't help/.test(m), 'must say retrying cannot fix an organisation block')
  assert.ok(/keep using Funnl without connecting Outlook/.test(m), m)
  // It must not promise that Funnl can obtain approval or that school mail is supported.
  for (const promise of ['we will', "we'll", 'request', 'contact us', 'supported', 'soon', 'coming']) {
    assert.ok(!m.toLowerCase().includes(promise), `promises "${promise}": ${m}`)
  }
  for (const leak of ['graph', 'oid', 'tenant', 'token', 'scope', 'microsoft', 'entra',
    'aadsts', 'consent_required', 'access_denied', '401', '403', '500']) {
    assert.ok(!m.toLowerCase().includes(leak), `leaks ${leak}: ${m}`)
  }
  assert.notStrictEqual(m, messageForOutcome('unknown_outcome'))
  assert.notStrictEqual(m, messageForOutcome('callback_failed'))
})


console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exitCode = 1
