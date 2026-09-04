// Tests for the deterministic email-conversation classifier. Synthetic metadata only
// (example.com, generic locals) — no bodies, no real correspondence, no PII.
// Run: node tests/email-classifier.test.js

import assert from 'assert'
import {
  classifyEmailMessages, OUTCOME_CODES, sanitizeSubjectPreview, localDateInZone,
} from '../supabase/functions/shared/emailConversationClassifier.js'

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

console.log('\neligible + timezone-safe dates')
test('two-way human exchange, quiet -> eligible with UTC instant + first key (no local date without tz)', () => {
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
  ])
  const e = only(r, 'eligible')
  assert.strictEqual(e.length, 1)
  assert.strictEqual(e[0].contactId, 'c1')
  assert.strictEqual(e[0].eligible.proposedType, 'Email')
  assert.strictEqual(e[0].eligible.proposedInstant, '2026-01-02T10:00:00Z')
  assert.strictEqual(e[0].eligible.proposedLocalDate, null) // no tz supplied -> never a UTC slice
  assert.strictEqual(e[0].eligible.firstMessageKey, 'm1')
  assert.deepStrictEqual(e[0].eligible.fingerprintFields, { provider: 'gmail', accountNamespace: 'conn1', contactId: 'c1', conversationKey: 't1', firstMessageKey: 'm1' })
  assert.strictEqual(r.complete, true)
})
test('evening UTC email resolves to the correct LOCAL day (no UTC-slice day shift)', () => {
  // 2026-01-02T02:00Z is Jan 1, 20:00 in America/Chicago (UTC-6). A UTC slice would say Jan 2.
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T15:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-02T02:00:00Z' }),
  ], { config: { timeZone: 'America/Chicago' } })
  const e = only(r, 'eligible')[0]
  assert.strictEqual(e.eligible.proposedInstant, '2026-01-02T02:00:00Z')
  assert.strictEqual(e.eligible.proposedLocalDate, '2026-01-01') // correct local day, NOT '2026-01-02'
})
test('localDateInZone: valid zone, invalid zone -> null, never machine tz', () => {
  assert.strictEqual(localDateInZone('2026-01-02T02:00:00Z', 'America/Chicago'), '2026-01-01')
  assert.strictEqual(localDateInZone('2026-01-02T02:00:00Z', 'Asia/Tokyo'), '2026-01-02') // UTC+9 -> Jan 2 11:00
  assert.strictEqual(localDateInZone('2026-01-02T02:00:00Z', 'Not/AZone'), null)
  assert.strictEqual(localDateInZone('not-a-date', 'America/Chicago'), null)
  assert.strictEqual(localDateInZone('2026-01-02T02:00:00Z', ''), null)
})

console.log('\ndeterministic ordering by numeric instant (not string)')
test('fractional seconds do not misorder the episode boundary', () => {
  // String sort would place ".500Z" before "00Z"; numeric sort keeps the earlier instant first.
  const r = run([
    m({ providerMessageKey: 'a', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-01T00:00:00Z' }),
    m({ providerMessageKey: 'b', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T00:00:00.500Z' }),
  ])
  const e = only(r, 'eligible')
  assert.strictEqual(e.length, 1)
  assert.strictEqual(e[0].eligible.firstMessageKey, 'a') // earlier instant, despite lexicographic order
})
test('+00:00 and Z are treated as the same instant', () => {
  const r = run([
    m({ providerMessageKey: 'a', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T09:00:00+00:00' }),
    m({ providerMessageKey: 'b', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
  ])
  assert.strictEqual(only(r, 'eligible').length, 1)
})

console.log('\none_way / cc_only / direction attribution')
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
test('inbound present but outbound only CC -> one_way (CC-only outbound never qualifies)', () => {
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['other@example.com'], ccAddresses: ['peer@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
  ])
  assert.strictEqual(only(r, 'one_way').length, 1)
  assert.strictEqual(only(r, 'eligible').length, 0)
})
test("a different contact's reply cannot satisfy the target contact's inbound requirement", () => {
  const contacts = [{ id: 'c1', user_id: 'u1', email: 'peer@example.com' }, { id: 'c2', user_id: 'u1', email: 'peer2@example.com' }]
  const r = run([
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com', 'peer2@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
    m({ providerMessageKey: 'm3', fromAddress: 'peer2@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-03T10:00:00Z' }),
  ], { contacts })
  // c1 (peer) never authored -> one_way; c2 (peer2) authored + is in To -> eligible.
  assert.deepStrictEqual(only(r, 'eligible').map((x) => x.contactId), ['c2'])
  assert.deepStrictEqual(only(r, 'one_way').map((x) => x.contactId), ['c1'])
})

console.log('\nactive / bulk / participant cap / automation')
test('recent latest message -> active_conversation', () => {
  const recent = Date.parse('2026-01-02T12:00:00Z')
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
  const cc = Array.from({ length: 10 }, (_, i) => `o${i}@example.com`)
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
test('one out-of-office reply excluded but human exchange still qualifies', () => {
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
    m({ providerMessageKey: 'm3', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], subject: 'Automatic reply: away', timestampIso: '2026-01-02T11:00:00Z' }),
  ])
  assert.strictEqual(only(r, 'eligible').length, 1)
})
test('excluded automated message does not create an artificial episode/boundary', () => {
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
    m({ providerMessageKey: 'auto', fromAddress: 'no-reply@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-20T10:00:00Z' }),
  ])
  assert.strictEqual(only(r, 'eligible').length, 1)
  assert.strictEqual(only(r, 'one_way').length, 0)
  assert.strictEqual(only(r, 'active_conversation').length, 0)
})

console.log('\nepisodes: strict >7-day gap')
test('exactly 7 days does NOT split (one episode, one eligible)', () => {
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T12:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-01T12:00:00Z' }),
    m({ providerMessageKey: 'm3', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-08T12:00:00Z' }),
    m({ providerMessageKey: 'm4', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-08T12:00:00Z' }),
  ])
  const e = only(r, 'eligible')
  assert.strictEqual(e.length, 1)
  assert.strictEqual(e[0].eligible.firstMessageKey, 'm1')
})
test('more than 7 days splits into two episodes with distinct first keys', () => {
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T12:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-01T12:00:00Z' }),
    m({ providerMessageKey: 'm3', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-09T12:00:00Z' }),
    m({ providerMessageKey: 'm4', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-09T12:00:00Z' }),
  ])
  const e = only(r, 'eligible')
  assert.strictEqual(e.length, 2)
  assert.deepStrictEqual(e.map((x) => x.eligible.firstMessageKey).sort(), ['m1', 'm3'])
})

console.log('\nmulti-contact / ambiguous')
test('two contacts each qualify independently from one conversation', () => {
  const contacts = [{ id: 'c1', user_id: 'u1', email: 'peer@example.com' }, { id: 'c2', user_id: 'u1', email: 'peer2@example.com' }]
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'peer2@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T11:00:00Z' }),
    m({ providerMessageKey: 'm3', fromAddress: 'me@example.com', toAddresses: ['peer@example.com', 'peer2@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
  ], { contacts })
  assert.deepStrictEqual(only(r, 'eligible').map((x) => x.contactId).sort(), ['c1', 'c2'])
})
test('duplicate contacts on same email -> ambiguous_contact (never a suggestion)', () => {
  const contacts = [{ id: 'c1', user_id: 'u1', email: 'peer@example.com' }, { id: 'c9', user_id: 'u1', email: 'PEER@example.com' }]
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'] }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'] }),
  ], { contacts })
  assert.ok(only(r, 'ambiguous_contact').length >= 1)
  assert.strictEqual(only(r, 'eligible').length, 0)
})

console.log('\npartial/malformed conversation safety')
test('attributable malformed message makes ITS conversation incomplete; other conversations still classify', () => {
  const r = run([
    // t1: otherwise-eligible pair + one undeterminable-date message (attributable to t1)
    m({ providerMessageKey: 'a1', providerConversationKey: 't1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'a2', providerConversationKey: 't1', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
    m({ providerMessageKey: 'a3', providerConversationKey: 't1', timestampIso: 'not-a-date' }),
    // t2: fully valid eligible pair
    m({ providerMessageKey: 'b1', providerConversationKey: 't2', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'b2', providerConversationKey: 't2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
  ])
  assert.strictEqual(only(r, 'eligible').length, 1)                       // only t2
  assert.strictEqual(only(r, 'eligible')[0].conversationKey, 't2')
  assert.ok(only(r, 'incomplete_conversation').some((x) => x.conversationKey === 't1'))
  assert.strictEqual(r.counts.byOutcome.undeterminable_date, 1)
  assert.strictEqual(r.complete, false)
})
test('unattributable malformed (prohibited content) makes the WHOLE run incomplete', () => {
  const r = run([
    { ...m({ providerMessageKey: 'x', providerConversationKey: 't1' }), body: 'PROHIBITED' }, // tainted -> unattributable
    m({ providerMessageKey: 'b1', providerConversationKey: 't2', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'b2', providerConversationKey: 't2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
  ])
  assert.strictEqual(only(r, 'eligible').length, 0)                       // even the valid conversation is suppressed
  assert.ok(only(r, 'incomplete_conversation').length >= 1)
  assert.strictEqual(r.complete, false)
})
test('structurally malformed recipient list makes the conversation incomplete', () => {
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['"unterminated <peer@example.com>'], timestampIso: '2026-01-02T10:00:00Z' }),
  ])
  assert.strictEqual(only(r, 'eligible').length, 0)
  assert.strictEqual(only(r, 'incomplete_conversation').length, 1)
  assert.strictEqual(r.complete, false)
})
test('missing-key + undeterminable + prohibited counted; complete=false', () => {
  const r = run([
    { ...m({ providerMessageKey: 'm1' }), body: 'PROHIBITED' },
    m({ providerMessageKey: 'm2', timestampIso: 'not-a-date' }),
    m({ providerMessageKey: 'm3', providerConversationKey: '' }),
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

console.log('\nbounds / DoS resistance')
test('too many contacts fails closed', () => {
  const contacts = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, user_id: 'u1', email: `c${i}@example.com` }))
  const r = classifyEmailMessages({ messages: [m({})], contacts, ownedAddresses: OWNED, userId: 'u1', accountNamespace: 'conn1', now: NOW, config: { maxContacts: 5 } })
  assert.strictEqual(r.complete, false)
  assert.strictEqual(r.results.length, 0)
})
test('too many conversations fails closed', () => {
  const msgs = Array.from({ length: 4 }, (_, i) => m({ providerMessageKey: `k${i}`, providerConversationKey: `t${i}` }))
  const r = run(msgs, { config: { maxConversations: 3 } })
  assert.strictEqual(r.complete, false)
  assert.strictEqual(r.results.length, 0)
})
test('too many messages fails closed', () => {
  const msgs = Array.from({ length: 6 }, (_, i) => m({ providerMessageKey: `k${i}` }))
  const r = run(msgs, { config: { maxMessages: 5 } })
  assert.strictEqual(r.complete, false)
  assert.strictEqual(r.results.length, 0)
})
test('unusable orchestration inputs fail closed (complete=false, no results)', () => {
  const r = classifyEmailMessages({ messages: [m({})], contacts: CONTACTS, ownedAddresses: OWNED, userId: 'u1', accountNamespace: '', now: NOW })
  assert.strictEqual(r.complete, false)
  assert.strictEqual(r.results.length, 0)
})

console.log('\nsubject sanitization')
test('strips control/bidi/zero-width, collapses whitespace incl NBSP, trims', () => {
  const NBSP = '\u00A0', BIDI = '\u202E', ZW = '\u200B', BOM = '\uFEFF'
  assert.strictEqual(sanitizeSubjectPreview('  a\t\n b  '), 'a b')          // tab + newline
  assert.strictEqual(sanitizeSubjectPreview('a\r\nb'), 'a b')               // CRLF
  assert.strictEqual(sanitizeSubjectPreview('a' + NBSP + 'b'), 'a b')       // NBSP -> space
  assert.strictEqual(sanitizeSubjectPreview('a' + BIDI + 'b'), 'ab')        // bidi override removed
  assert.strictEqual(sanitizeSubjectPreview('a' + ZW + 'b'), 'ab')          // zero-width removed
  assert.strictEqual(sanitizeSubjectPreview(BOM + 'hi'), 'hi')              // BOM removed
  assert.strictEqual(sanitizeSubjectPreview(''), '')
  assert.strictEqual(sanitizeSubjectPreview(123), '')
})
test('overlength Unicode capped at 160 without splitting a surrogate pair', () => {
  const raw = 'a'.repeat(159) + '\u{1D518}' // 159 + astral char (2 code units) = 161
  const out = sanitizeSubjectPreview(raw)
  assert.ok(out.length <= 160)
  const last = out.charCodeAt(out.length - 1)
  assert.ok(!(last >= 0xD800 && last <= 0xDBFF), 'must not end on a lone high surrogate')
})

console.log('\noutcome-code hygiene + determinism')
test('every result outcome is a controlled code', () => {
  const r = run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
  ])
  for (const res of r.results) assert.ok(OUTCOME_CODES.includes(res.outcome))
})
test('determinism: identical input -> identical results', () => {
  const build = () => run([
    m({ providerMessageKey: 'm1', fromAddress: 'peer@example.com', toAddresses: ['me@example.com'], timestampIso: '2026-01-01T10:00:00Z' }),
    m({ providerMessageKey: 'm2', fromAddress: 'me@example.com', toAddresses: ['peer@example.com'], timestampIso: '2026-01-02T10:00:00Z' }),
  ])
  assert.deepStrictEqual(build().results, build().results)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
