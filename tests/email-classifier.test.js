// Tests for the deterministic email-conversation classifier. Synthetic metadata only
// (example.com, generic locals) — no bodies, no real correspondence, no PII.
// Run: node tests/email-classifier.test.js

import assert from 'assert'
import { classifyEmailMessages, OUTCOME_CODES, sanitizeSubjectPreview } from '../supabase/functions/shared/emailConversationClassifier.js'

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

const AUTO = { autoSubmitted: 'no', precedence: null, hasListId: false, hasListUnsubscribe: false, hasAutoResponseSuppress: false }
function m(over) {
  return {
    provider: 'gmail', providerMessageKey: 'm', providerConversationKey: 't1',
    timestampIso: '2026-01-01T00:00:00Z', fromAddress: 'peer@example.com',
    toAddresses: ['me@example.com'], ccAddresses: [], subject: 's', automation: { ...AUTO }, folderHint: 'inbox',
    ...over,
  }
}
const OWNED = ['me@example.com']
const CONTACTS = [{ id: 'c1', user_id: 'u1', email: 'peer@example.com' }]
const NOW = Date.parse('2026-02-01T00:00:00Z')
function run(messages, over = {}) {
  return classifyEmailMessages({ messages, contacts: CONTACTS, ownedAddresses: OWNED, userId: 'u1', accountNamespace: 'conn1', now: NOW, ...over })
}
const only = (r, outcome) => r.results.filter((x) => x.outcome === outcome)

console.log('\neligible')
test('two-way human exchange, quiet -> eligible with Email + latest date + first key', () => {
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
  ])
  const e = only(r, 'eligible')
  assert.strictEqual(e.length, 1)
  assert.strictEqual(e[0].contactId, 'c1')
  assert.strictEqual(e[0].eligible.proposedType, 'Email')
  assert.strictEqual(e[0].eligible.proposedDate, '2026-01-02')
  assert.strictEqual(e[0].eligible.firstMessageKey, 'm1')
  assert.deepStrictEqual(e[0].eligible.fingerprintFields, { provider: 'gmail', accountNamespace: 'conn1', contactId: 'c1', conversationKey: 't1', firstMessageKey: 'm1' })
  assert.strictEqual(r.complete, true)
})

console.log('\none_way / cc_only')
test('inbound only -> one_way', () => {
  const r = run([m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'] })])
  assert.strictEqual(only(r, 'one_way').length, 1)
  assert.strictEqual(only(r, 'eligible').length, 0)
})
test('outbound only -> one_way', () => {
  const r = run([m({ providerMessageKey: 'm1', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'] })])
  assert.strictEqual(only(r, 'one_way').length, 1)
})
test('contact only in CC -> cc_only', () => {
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'other@example.com', toAddresses: ['me@example.com'], ccAddresses: ['peer@example.com'] }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['other@example.com'], ccAddresses: ['peer@example.com'] }),
  ])
  assert.strictEqual(only(r, 'cc_only').length, 1)
  assert.strictEqual(only(r, 'eligible').length, 0)
})

console.log('\nactive / bulk / participant cap / automation')
test('recent latest message -> active_conversation', () => {
  const recent = Date.parse('2026-01-02T12:00:00Z') // < 24h after 02T10:00
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
  ], { now: recent })
  assert.strictEqual(only(r, 'active_conversation').length, 1)
})
test('List-ID anywhere -> bulk_or_list (whole conversation)', () => {
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'] }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], automation: { ...AUTO, hasListId: true } }),
  ])
  assert.strictEqual(only(r, 'bulk_or_list').length, 1)
  assert.strictEqual(only(r, 'eligible').length, 0)
})
test('>10 external participants -> participant_cap', () => {
  const cc = Array.from({ length: 10 }, (_, i) => `o${i}@example.com`) // + peer = 11 external
  const r = run([m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], ccAddresses: cc })])
  assert.strictEqual(only(r, 'participant_cap').length, 1)
})
test('all non-human messages -> automation_only', () => {
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'no-reply@example.com', toAddresses: ['me@example.com'] }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['no-reply@example.com'], subject: 'Undeliverable: x' }),
  ])
  assert.strictEqual(only(r, 'automation_only').length, 1)
})
test('automated message excluded but human exchange still qualifies', () => {
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
    m({ providerMessageKey: 'm3', fromAddress: 'no-reply@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-02T11:00:00Z' }),
  ])
  assert.strictEqual(only(r, 'eligible').length, 1) // no-reply excluded, human pair still qualifies
})

console.log('\nepisodes / multi-contact / ambiguous')
test('>7 day gap splits into two episodes with distinct first keys', () => {
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
    m({ providerMessageKey: 'm3', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-20T10:00:00Z' }),
    m({ providerMessageKey: 'm4', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-21T10:00:00Z' }),
  ])
  const e = only(r, 'eligible')
  assert.strictEqual(e.length, 2)
  assert.deepStrictEqual(e.map((x) => x.eligible.firstMessageKey).sort(), ['m1', 'm3'])
})
test('two contacts each qualify independently from one conversation', () => {
  const contacts = [{ id: 'c1', user_id: 'u1', email: 'peer@example.com' }, { id: 'c2', user_id: 'u1', email: 'peer2@example.com' }]
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'peer2@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T11:00:00Z' }),
    m({ providerMessageKey: 'm3', fromAddress: 'me@example.com', toAddresses: ['peer@example.com', 'peer2@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
  ], { contacts })
  assert.deepStrictEqual(only(r, 'eligible').map((x) => x.contactId).sort(), ['c1', 'c2'])
})
test('duplicate contacts on same email -> ambiguous_contact', () => {
  const contacts = [{ id: 'c1', user_id: 'u1', email: 'peer@example.com' }, { id: 'c9', user_id: 'u1', email: 'PEER@example.com' }]
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'] }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'] }),
  ], { contacts })
  assert.ok(only(r, 'ambiguous_contact').length >= 1)
  assert.strictEqual(only(r, 'eligible').length, 0)
})

console.log('\nstructural triage + completeness truthfulness')
test('malformed/undeterminable/missing-key counted; complete=false; intentional filters do not', () => {
  const r = run([
    { ...m({ providerMessageKey: 'm1' }), body: 'PROHIBITED' },                 // prohibited content
    m({ providerMessageKey: 'm2', timestampIso: 'not-a-date' }),                 // undeterminable date
    m({ providerMessageKey: 'm3', providerConversationKey: '' }),                // missing conversation key
  ])
  assert.strictEqual(r.counts.byOutcome.malformed_message, 1)
  assert.strictEqual(r.counts.byOutcome.undeterminable_date, 1)
  assert.strictEqual(r.counts.byOutcome.missing_conversation_key, 1)
  assert.strictEqual(r.counts.malformedMessages, 3)
  assert.strictEqual(r.complete, false)
})
test('a purely filtered batch (one_way) is still complete=true', () => {
  const r = run([m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'] })])
  assert.strictEqual(r.complete, true)
  assert.strictEqual(only(r, 'one_way').length, 1)
})
test('determinism: identical input -> identical results', () => {
  const build = () => run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
  ])
  assert.deepStrictEqual(build().results, build().results)
})
test('unusable orchestration inputs fail closed (complete=false, no results)', () => {
  const r = classifyEmailMessages({ messages: [m({})], contacts: CONTACTS, ownedAddresses: OWNED, userId: 'u1', accountNamespace: '', now: NOW })
  assert.strictEqual(r.complete, false)
  assert.strictEqual(r.results.length, 0)
})

console.log('\nsubject preview + outcome-code hygiene')
test('sanitizeSubjectPreview strips control chars, collapses ws, caps 160', () => {
  assert.strictEqual(sanitizeSubjectPreview('  a\t\n b  '), 'a b')
  assert.strictEqual(sanitizeSubjectPreview('x'.repeat(300)).length, 160)
  assert.strictEqual(sanitizeSubjectPreview(123), '')
})
test('every result outcome is a controlled code', () => {
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
  ])
  for (const res of r.results) assert.ok(OUTCOME_CODES.includes(res.outcome))
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
