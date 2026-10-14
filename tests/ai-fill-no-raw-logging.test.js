// AI FILL MUST NOT LOG WHAT THE MODEL SAID.
//
// ai-parse-contact used to log the model's raw reply when it was not valid JSON
// (`console.error('Failed to parse Claude output as JSON:', rawContent)`) and the provider's
// raw error body. Both are derived from what the user pasted about a real person. These
// tests pin the replacement: the malformed-reply path returns a controlled code, and no
// log call in the function can carry model output, the provider body, the request text or
// an exception's message.

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseModelContact, PARSE_FAILURE_CODES } from '../supabase/functions/ai-parse-contact/parse.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = readFileSync(join(ROOT, 'supabase/functions/ai-parse-contact/index.ts'), 'utf8').replace(/\r\n/g, '\n')

let passed = 0
let failed = 0
function test (name, fn) {
  try { fn(); console.log('  OK   ' + name); passed += 1 } catch (e) {
    console.error('  FAIL ' + name)
    console.error('       ' + (e && e.message ? e.message : String(e)))
    failed += 1
  }
}

const SECRET = 'Priya Sharma, priya@example.com, +1 555 0100'

console.log('the malformed-response path')

test('a malformed reply returns a controlled code and never the reply', () => {
  const r = parseModelContact(`Sure! Here is the contact: ${SECRET}`)
  assert.deepStrictEqual(r, { ok: false, code: 'unparseable_model_output' })
  assert.ok(!JSON.stringify(r).includes('Priya'), 'the code carries none of the reply')
})

test('a truncated JSON reply is the same controlled failure', () => {
  assert.deepStrictEqual(parseModelContact('{"name": "Priya Sha'), { ok: false, code: 'unparseable_model_output' })
})

test('an empty or missing reply is a controlled failure', () => {
  for (const v of ['', '   ', undefined, null, 42]) {
    assert.deepStrictEqual(parseModelContact(v), { ok: false, code: 'empty_model_output' })
  }
})

test('every failure code is in the controlled list', () => {
  for (const v of ['nope', '']) {
    const r = parseModelContact(v)
    assert.ok(PARSE_FAILURE_CODES.includes(r.code), r.code)
  }
})

console.log('the success path is unchanged')

test('plain JSON parses exactly as before', () => {
  assert.deepStrictEqual(parseModelContact('{"name":"Priya","company":"Goldman"}'),
    { ok: true, contact: { name: 'Priya', company: 'Goldman' } })
})

test('a fenced reply is unwrapped exactly as before', () => {
  assert.deepStrictEqual(parseModelContact('```json\n{"role":"Analyst"}\n```'), { ok: true, contact: { role: 'Analyst' } })
  assert.deepStrictEqual(parseModelContact('```\n{"role":"Analyst"}\n```'), { ok: true, contact: { role: 'Analyst' } })
})

console.log('nothing content-bearing reaches a log')

test('every console call in ai-parse-contact logs only fixed labels and controlled values', () => {
  const calls = INDEX.match(/console\.(error|log|warn|info|debug)\([^\n]*/g) || []
  assert.ok(calls.length >= 3, `expected the function's log calls, found ${calls.length}`)
  for (const c of calls) {
    for (const forbidden of ['rawContent', '.text()', 'anthropicData', 'text)', 'err)', 'err.message', 'body', 'contact)']) {
      assert.ok(!c.includes(forbidden), `log call carries ${forbidden}: ${c}`)
    }
  }
})

test('the old raw-output and raw-body log lines are gone', () => {
  assert.ok(!INDEX.includes('Failed to parse Claude output as JSON'), 'raw model output log line still present')
  assert.ok(!INDEX.includes("console.error('Anthropic API error:', await anthropicRes.text())"), 'raw provider body log still present')
  assert.ok(!/console\.error\('Unexpected error:', err\)/.test(INDEX), 'raw exception still logged')
})

test('the malformed path still answers the browser with the same generic message', () => {
  const i = INDEX.indexOf('parseModelContact(rawContent)')
  assert.ok(i > 0)
  assert.ok(INDEX.slice(i, i + 500).includes("Could not parse AI response — please try again"))
})

test('sanitized error codes are preserved for diagnosis', () => {
  assert.ok(INDEX.includes("console.error('ai-parse-contact provider_error', anthropicRes.status)"))
  assert.ok(INDEX.includes("console.error('ai-parse-contact', parsed.code)"))
  assert.ok(INDEX.includes("console.error('ai-parse-contact unexpected', err?.name ?? 'error')"))
  assert.ok(INDEX.includes("console.error('ai-parse-contact entitlement-unavailable'"), 'the existing entitlement code log is kept')
})

console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exitCode = 1
