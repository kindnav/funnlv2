// Privacy / structural invariant tests for the normalized email-message contract.
// Proves the classifier's input can never carry a body, attachment, raw provider
// response, or prototype-polluting shape. Synthetic metadata only — no PII, no bodies.
// Run: node tests/email-provider-contract.test.js

import assert from 'assert'
import {
  classifyNormalizedMessage, isBoundedStringArray, isIsoUtcInstant,
  PROHIBITED_KEYS, EMAIL_PROVIDERS, AUTOMATION_FACT_KEYS, FOLDER_HINTS,
  MAX_SUBJECT_INPUT, MAX_RECIPIENTS, MAX_ADDR_LEN, MAX_KEY_LEN,
} from '../supabase/functions/shared/emailProviderContract.js'

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

function valid(over = {}) {
  return {
    provider: 'gmail', providerMessageKey: 'm1', providerConversationKey: 't1',
    timestampIso: '2026-01-01T00:00:00Z', fromAddress: 'a@example.com',
    toAddresses: ['b@example.com'], ccAddresses: [], subject: 's',
    automation: { autoSubmitted: 'no', precedence: null, hasListId: false, hasListUnsubscribe: false, hasAutoResponseSuppress: false },
    folderHint: 'inbox',
    ...over,
  }
}

const CONTROLLED = new Set([
  null, 'not_object', 'prototype_pollution', 'prohibited_content',
  'bad_provider', 'bad_key', 'bad_timestamp', 'bad_addresses', 'oversized',
])

console.log('\nacceptance')
test('a well-formed metadata-only message is accepted (null)', () => {
  assert.strictEqual(classifyNormalizedMessage(valid()), null)
  assert.strictEqual(classifyNormalizedMessage(valid({ provider: 'outlook', folderHint: 'sent' })), null)
})

console.log('\nprivacy: prohibited content is always rejected, never echoed')
test('every PROHIBITED_KEYS entry causes prohibited_content', () => {
  assert.ok(PROHIBITED_KEYS.length > 0)
  for (const key of PROHIBITED_KEYS) {
    const msg = valid()
    msg[key] = 'SENSITIVE-CONTENT-SHOULD-NEVER-LEAK'
    const code = classifyNormalizedMessage(msg)
    assert.strictEqual(code, 'prohibited_content', `expected prohibited_content for key ${key}`)
    assert.ok(!String(code).includes('SENSITIVE'), 'reason code must never echo field content')
  }
})
test('common raw-response shapes (body/html/attachments/rawResponse) all rejected', () => {
  for (const key of ['body', 'html', 'snippet', 'bodyPreview', 'attachments', 'rawResponse', 'rawHeaders', 'mimeContent']) {
    assert.strictEqual(classifyNormalizedMessage(valid({ [key]: {} })), 'prohibited_content')
  }
})

console.log('\nprototype pollution + shape')
test('__proto__ / constructor / prototype own-keys rejected', () => {
  for (const k of ['__proto__', 'constructor', 'prototype']) {
    const m = valid()
    Object.defineProperty(m, k, { value: 'x', enumerable: true, configurable: true, writable: true })
    assert.strictEqual(classifyNormalizedMessage(m), 'prototype_pollution')
  }
})
test('non-plain objects rejected as not_object', () => {
  assert.strictEqual(classifyNormalizedMessage(null), 'not_object')
  assert.strictEqual(classifyNormalizedMessage([valid()]), 'not_object')
  assert.strictEqual(classifyNormalizedMessage('str'), 'not_object')
  assert.strictEqual(classifyNormalizedMessage(42), 'not_object')
  assert.strictEqual(classifyNormalizedMessage(Object.create({ evil: 1 })), 'not_object')
})

console.log('\nfield validation fails closed')
test('bad provider / key / timestamp / addresses / oversized', () => {
  assert.strictEqual(classifyNormalizedMessage(valid({ provider: 'imap' })), 'bad_provider')
  assert.strictEqual(classifyNormalizedMessage(valid({ providerMessageKey: '' })), 'bad_key')
  assert.strictEqual(classifyNormalizedMessage(valid({ providerConversationKey: 'x'.repeat(MAX_KEY_LEN + 1) })), 'bad_key')
  assert.strictEqual(classifyNormalizedMessage(valid({ timestampIso: '2026-01-01' })), 'bad_timestamp')
  assert.strictEqual(classifyNormalizedMessage(valid({ timestampIso: '2026-01-01T00:00:00+05:00' })), 'bad_timestamp') // non-UTC offset
  assert.strictEqual(classifyNormalizedMessage(valid({ toAddresses: 'b@example.com' })), 'bad_addresses') // not array
  assert.strictEqual(classifyNormalizedMessage(valid({ toAddresses: new Array(MAX_RECIPIENTS + 1).fill('x@example.com') })), 'bad_addresses')
  assert.strictEqual(classifyNormalizedMessage(valid({ subject: 's'.repeat(MAX_SUBJECT_INPUT + 1) })), 'oversized')
})

console.log('\nhelpers')
test('isBoundedStringArray', () => {
  assert.ok(isBoundedStringArray([]))
  assert.ok(isBoundedStringArray(['a', 'b']))
  assert.ok(!isBoundedStringArray('a'))
  assert.ok(!isBoundedStringArray([1]))
  assert.ok(!isBoundedStringArray(new Array(MAX_RECIPIENTS + 1).fill('a')))
})
test('isIsoUtcInstant accepts Z/+00:00, rejects local + junk', () => {
  assert.ok(isIsoUtcInstant('2026-01-01T00:00:00Z'))
  assert.ok(isIsoUtcInstant('2026-01-01T00:00:00.123Z'))
  assert.ok(isIsoUtcInstant('2026-01-01T00:00:00+00:00'))
  assert.ok(!isIsoUtcInstant('2026-01-01T00:00:00+05:00'))
  assert.ok(!isIsoUtcInstant('2026-13-01T00:00:00Z')) // Date.parse rejects month 13
  assert.ok(!isIsoUtcInstant('not-a-date'))
  assert.ok(!isIsoUtcInstant(''))
})

console.log('\ncontrolled codes + allowlist constants')
test('classifier only ever returns controlled codes', () => {
  const samples = [null, {}, valid(), valid({ body: 1 }), valid({ provider: 'x' }), 'str', [], valid({ __proto__: {} })]
  for (const s of samples) assert.ok(CONTROLLED.has(classifyNormalizedMessage(s)))
})
test('exported allowlists are frozen and sane', () => {
  assert.deepStrictEqual(EMAIL_PROVIDERS, ['gmail', 'outlook'])
  assert.ok(Object.isFrozen(EMAIL_PROVIDERS) && Object.isFrozen(PROHIBITED_KEYS))
  assert.ok(Object.isFrozen(AUTOMATION_FACT_KEYS) && Object.isFrozen(FOLDER_HINTS))
  assert.strictEqual(MAX_ADDR_LEN, 320)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
