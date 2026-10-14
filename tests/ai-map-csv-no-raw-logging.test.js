// CSV mapping (ai-map-csv) logs - no raw AI reply and no provider error content.
//
// Run with: node tests/ai-map-csv-no-raw-logging.test.js
//
// The model's reply is derived from the user's CSV headers and sample rows, and the provider's
// error body is not ours to keep, so neither may reach a log. Only fixed labels and controlled
// values remain. What the browser receives, and how the reply is parsed, are unchanged.

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'

const SRC = readFileSync(new URL('../supabase/functions/ai-map-csv/index.ts', import.meta.url), 'utf8')
  .split(String.fromCharCode(13)).join('')

let passed = 0, failed = 0
function test (name, fn) {
  try { fn(); console.log(`  OK   ${name}`); passed++ } catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++ }
}

/** Every console.* call, with its full argument text (balanced parentheses). */
function consoleCalls (src) {
  const out = []
  for (const m of src.matchAll(/console\.(log|error|warn|info|debug)\(/g)) {
    let depth = 1, i = m.index + m[0].length
    while (i < src.length && depth > 0) { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; i++ }
    out.push(src.slice(m.index, i))
  }
  return out
}

console.log('nothing content-bearing reaches a log')
test('every console call logs only a fixed label and controlled values', () => {
  const allowed = [
    /^console\.error\('ai-map-csv entitlement-unavailable', \{[^]*?ErrorCode[^]*\}\)$/,
    /^console\.error\('ai-map-csv provider_error', anthropicRes\.status\)$/,
    /^console\.error\('ai-map-csv', code\)$/,
    /^console\.error\('ai-map-csv unexpected', err\?\.name \?\? 'error'\)$/,
  ]
  const calls = consoleCalls(SRC)
  assert.equal(calls.length, 4, calls.join('\n'))
  for (const c of calls) assert.ok(allowed.some((re) => re.test(c)), `unexpected log call: ${c}`)
})
test('no log reads the reply, the provider body or the raw error', () => {
  for (const c of consoleCalls(SRC)) {
    for (const bad of ['rawContent', '.text()', 'anthropicData', 'prompt', 'headers', 'sampleRows', ', err)']) {
      assert.equal(c.includes(bad), false, `${c} contains ${bad}`)
    }
  }
})
test('the old raw-output and raw-body log lines are gone', () => {
  assert.equal(SRC.includes("console.error('Failed to parse Claude output as JSON:', rawContent)"), false)
  assert.equal(SRC.includes("console.error('Anthropic API error:', await anthropicRes.text())"), false)
  assert.equal(SRC.includes("console.error('Unexpected error:', err)"), false)
})
test('the malformed-reply code is controlled: empty or unparseable only', () => {
  assert.ok(SRC.includes("const code = rawContent.length === 0 ? 'empty_model_output' : 'unparseable_model_output'"))
})

console.log('the browser sees exactly what it saw before')
test('the three error replies are unchanged', () => {
  assert.ok(SRC.includes("JSON.stringify({ error: 'AI service error — please try again' })"))
  assert.ok(SRC.includes("JSON.stringify({ error: 'Could not parse AI response — please try again' })"))
  assert.ok(SRC.includes("JSON.stringify({ error: 'Something went wrong — please try again' })"))
})
test('parsing and sanitising are unchanged', () => {
  assert.ok(SRC.includes("rawContent = rawContent.replace(/^```(?:json)?\\n?/, '').replace(/\\n?```$/, '').trim()"))
  assert.ok(SRC.includes('parsed = JSON.parse(rawContent)'))
  assert.ok(SRC.includes('const headerSet = new Set(headers as string[])'))
})
test('access is still decided by the shared subscription-aware check', () => {
  assert.ok(SRC.includes("import { loadProEntitlement, decideEntitlement } from '../shared/pro-entitlement.js'"))
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
