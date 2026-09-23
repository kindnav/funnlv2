// Outlook PR-B — envelope normalization + deterministic participant matching.
//
// ZERO NETWORK ACCESS: both modules are pure. Every identity is synthetic and uses
// example.invalid; every message id and body is invented.
//
// Run with: node tests/outlook-participants.test.js
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import {
  normalizeGraphMessage, normalizeGraphPage, automationFactsFromHeaders,
  graphDateToIso, readRemoval, CONTENT_KEYS, applyAutomationFacts,
} from '../supabase/functions/shared/outlookMessageNormalize.js'
import {
  buildSelfIdentitySet, indexContactsByEmail, splitParticipants, evaluateMessage,
  qualifyEpisode, buildEpisodeFingerprintFields, buildPersonFingerprintFields,
  computeEpisodeFingerprints,
} from '../supabase/functions/shared/outlookParticipants.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const P_SRC = readFileSync(join(__dirname, '../supabase/functions/shared/outlookParticipants.js'), 'utf8')
const N_SRC = readFileSync(join(__dirname, '../supabase/functions/shared/outlookMessageNormalize.js'), 'utf8')

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}
async function atest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const USER = 'student@example.invalid'
const USER_ALIAS = 'Student.Alias@example.invalid'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const DANA = 'dana.swope@contoso.example.invalid'
const ALEX = 'alex.wilber@fabrikam.example.invalid'

const rcpt = (address, name) => ({ emailAddress: name ? { name, address } : { address } })

function graphMsg(over = {}) {
  return {
    id: 'AAMk_msg_1',
    conversationId: 'AAQk_conv_1',
    internetMessageId: '<abc@contoso.example.invalid>',
    receivedDateTime: '2026-09-10T14:03:00Z',
    sentDateTime: '2026-09-10T14:02:55Z',
    isDraft: false,
    subject: 'Coffee chat follow-up',
    from: rcpt(DANA, 'Dana Swope'),
    toRecipients: [rcpt(USER, 'A Student')],
    ccRecipients: [],
    // NOTE: no `internetMessageHeaders`, no `body`, no `uniqueBody`. A delta/discovery
    // item carries none of them, and nothing downstream may require them.
    ...over,
  }
}

const selfSet = buildSelfIdentitySet(USER, [USER_ALIAS])
const contacts = [{ id: 'c-dana', user_id: USER_ID, email: 'Dana.Swope@Contoso.Example.Invalid' }]
const contactIndex = indexContactsByEmail(contacts, USER_ID)

function norm(raw, folder = 'inbox') {
  const r = normalizeGraphMessage(raw, folder)
  assert.ok(r.ok, `fixture must normalize: ${r.code}`)
  return r
}

// A discovery item ALWAYS has incomplete automation facts (headers are not in the
// discovery projection). `assessed()` simulates the per-message content read having
// supplied them, which is what the worker will do before a new-contact suggestion is
// allowed. Tests about MATCHING use it so they are not silently testing the
// automation-deferral rule instead.
const CLEAN_FACTS = {
  facts: {
    autoSubmitted: null, precedence: null,
    hasListId: false, hasListUnsubscribe: false, hasAutoResponseSuppress: false,
  },
  complete: true,
}
function assessed(raw, folder = 'inbox') {
  const r = norm(raw, folder)
  return applyAutomationFacts(r.message, r.extra, CLEAN_FACTS)
}

// Same, but with the facts Graph's per-message GET would yield for `headers`.
function assessedWithHeaders(raw, headers, folder = 'inbox') {
  const r = norm(raw, folder)
  return applyAutomationFacts(r.message, r.extra, automationFactsFromHeaders(headers))
}

// ── Normalization ────────────────────────────────────────────────────────────
console.log('\nenvelope normalization')

test('a well-formed inbox message normalizes to the E1 contract with no content keys', () => {
  const { message, extra } = norm(graphMsg())
  assert.strictEqual(message.provider, 'outlook')
  assert.strictEqual(message.providerMessageKey, 'AAMk_msg_1')
  assert.strictEqual(message.providerConversationKey, 'AAQk_conv_1')
  assert.strictEqual(message.timestampIso, '2026-09-10T14:03:00.000Z')
  assert.strictEqual(message.fromAddress, DANA)
  assert.deepStrictEqual(message.toAddresses, [USER])
  assert.strictEqual(message.folderHint, 'inbox')
  for (const k of ['body', 'bodyPreview', 'uniqueBody', 'attachments', 'internetMessageHeaders']) {
    assert.ok(!(k in message), `normalized message must not carry ${k}`)
  }
  assert.strictEqual(extra.displayNames[DANA], 'Dana Swope')
})

test('a stage-1 payload carrying a body is REFUSED (the select was widened by mistake)', () => {
  for (const k of CONTENT_KEYS) {
    const r = normalizeGraphMessage(graphMsg({ [k]: { contentType: 'text', content: 'leak' } }), 'inbox')
    assert.ok(!r.ok && r.code === 'unexpected_content', `${k} must fail closed`)
  }
})

test('drafts and removal tombstones never become usable messages', () => {
  assert.strictEqual(normalizeGraphMessage(graphMsg({ isDraft: true }), 'inbox').code, 'is_draft')
  const removed = { id: 'AAMk_msg_9', '@removed': { reason: 'deleted' } }
  assert.strictEqual(normalizeGraphMessage(removed, 'inbox').code, 'removed_tombstone')
  assert.deepStrictEqual(readRemoval(removed), { removed: true, messageId: 'AAMk_msg_9', reason: 'deleted' })
})

test('sent-folder messages take the sent timestamp and the sent folder hint', () => {
  const { message } = norm(graphMsg({
    from: rcpt(USER), toRecipients: [rcpt(DANA)],
    sentDateTime: '2026-09-11T08:00:00Z', receivedDateTime: '2026-09-11T08:00:05Z',
  }), 'sentitems')
  assert.strictEqual(message.folderHint, 'sent')
  assert.strictEqual(message.timestampIso, '2026-09-11T08:00:00.000Z')
})

test('malformed timestamps and ids fail closed', () => {
  assert.strictEqual(normalizeGraphMessage(graphMsg({ receivedDateTime: 'yesterday', sentDateTime: null }), 'inbox').code, 'bad_timestamp')
  assert.strictEqual(normalizeGraphMessage(graphMsg({ id: '' }), 'inbox').code, 'missing_ids')
  assert.strictEqual(normalizeGraphMessage(graphMsg({ conversationId: undefined }), 'inbox').code, 'missing_ids')
  assert.strictEqual(graphDateToIso('1899-01-01T00:00:00Z'), null, 'absurd dates refused')
})

test('display names equal to the address are not treated as names', () => {
  const { extra } = norm(graphMsg({ from: rcpt(DANA, DANA) }))
  assert.strictEqual(extra.displayNames[DANA], undefined)
})

test('a DISCOVERY item is always unassessed, even if headers somehow appear on it', () => {
  // Behaviour must not fork on provider whim: discovery never assesses automation.
  const { message, extra } = norm(graphMsg({
    internetMessageHeaders: [{ name: 'List-Id', value: '<newsletter.contoso.example.invalid>' }],
  }))
  assert.strictEqual(extra.automationFactsComplete, false, 'discovery is never "assessed"')
  assert.deepStrictEqual(message.automation, {
    autoSubmitted: null, precedence: null,
    hasListId: false, hasListUnsubscribe: false, hasAutoResponseSuppress: false,
  })
  assert.ok(!JSON.stringify(message).includes('newsletter.contoso'),
    'and no raw header value survives either way')
})

test('facts from the CONTENT read are reduced to booleans and enums, values discarded', () => {
  const a = assessedWithHeaders(graphMsg(), [
    { name: 'List-Id', value: '<newsletter.contoso.example.invalid>' },
    { name: 'Precedence', value: 'bulk' },
    { name: 'Auto-Submitted', value: 'auto-generated; owner' },
    { name: 'X-Auto-Response-Suppress', value: 'All' },
  ])
  assert.deepStrictEqual(a.message.automation, {
    autoSubmitted: 'auto-generated', precedence: 'bulk',
    hasListId: true, hasListUnsubscribe: false, hasAutoResponseSuppress: true,
  })
  assert.strictEqual(a.extra.automationFactsComplete, true)
  assert.ok(!JSON.stringify(a.message).includes('newsletter.contoso'),
    'raw header value must not survive classification')
  assert.ok(!JSON.stringify(a.message).includes('X-Auto-Response-Suppress'),
    'nor any raw header name')
})

test('a duplicated benign header cannot mask a real automation header', () => {
  const a = automationFactsFromHeaders([
    { name: 'Auto-Submitted', value: 'no' },
    { name: 'Auto-Submitted', value: 'auto-replied' },
  ])
  assert.strictEqual(a.facts.autoSubmitted, 'auto-replied', 'automation wins over an added "no"')
  const b = automationFactsFromHeaders([
    { name: 'Precedence', value: 'normal' },
    { name: 'Precedence', value: 'bulk' },
  ])
  assert.strictEqual(b.facts.precedence, 'bulk', 'bulk wins over an added "normal"')
})

test('a missing header collection is reported as INCOMPLETE, not as "no automation"', () => {
  const r = automationFactsFromHeaders(undefined)
  assert.strictEqual(r.complete, false)
  assert.strictEqual(r.facts.hasListId, false)
})

test('a page normalizes with dedup, removals and per-code discard counts', () => {
  const page = normalizeGraphPage([
    graphMsg(),
    graphMsg(),                                            // duplicate id
    graphMsg({ id: 'AAMk_msg_2', isDraft: true }),         // discarded
    { id: 'AAMk_msg_3', '@removed': { reason: 'deleted' } },
    'not an object',
  ], 'inbox')
  assert.strictEqual(page.messages.length, 1)
  assert.strictEqual(page.counts.duplicates, 1)
  assert.strictEqual(page.removals.length, 1)
  assert.strictEqual(page.byDiscardCode.is_draft, 1)
  assert.strictEqual(page.byDiscardCode.not_object, 1)
})

test('an adversarial throwing payload cannot crash the page normalizer', () => {
  const evil = {}
  Object.defineProperty(evil, 'id', { get() { throw new Error('boom') }, enumerable: true })
  const page = normalizeGraphPage([evil, graphMsg()], 'inbox')
  assert.strictEqual(page.messages.length, 1)
  assert.strictEqual(page.hadUnreadable, true)
})

// ── Self / alias exclusion ───────────────────────────────────────────────────
console.log('\nself and alias exclusion')

test('the connected mailbox and its aliases are removed from the counterparty set', () => {
  assert.ok(selfSet.has(USER) && selfSet.has('student.alias@example.invalid'),
    'aliases are normalized to lowercase')
  const { message } = norm(graphMsg({ from: rcpt(USER_ALIAS), toRecipients: [rcpt(USER)] }), 'sentitems')
  const parts = splitParticipants(message, selfSet)
  assert.deepStrictEqual(parts.direct, [], 'a note to yourself has no counterparty')
  const r = evaluateMessage({ message, selfSet, contactIndex })
  assert.deepStrictEqual(r, { outcome: 'excluded', code: 'self_only' })
})

// ── Exact-address matching ───────────────────────────────────────────────────
console.log('\nexact-address contact matching')

test('a known contact matches case-insensitively but ONLY on the exact address', () => {
  const r = evaluateMessage({ message: norm(graphMsg()).message, selfSet, contactIndex })
  assert.strictEqual(r.outcome, 'eligible')
  assert.strictEqual(r.contactId, 'c-dana')
  assert.strictEqual(r.counterparty, DANA)
})

test('dots and plus-tags are NOT normalized away — a different address is a different person', () => {
  const variants = ['danaswope@contoso.example.invalid', 'dana.swope+jobs@contoso.example.invalid']
  for (const v of variants) {
    const a = assessed(graphMsg({ from: rcpt(v) }))
    const r = evaluateMessage({ message: a.message, extra: a.extra, selfSet, contactIndex })
    assert.strictEqual(r.outcome, 'eligible')
    assert.strictEqual(r.contactId, null, `${v} must not match the stored contact`)
  }
})

test('a matching NAME with a different address never links to the contact', () => {
  const a = assessed(graphMsg({ from: rcpt('dana.swope@other.example.invalid', 'Dana Swope') }))
  const r = evaluateMessage({ message: a.message, extra: a.extra, selfSet, contactIndex })
  assert.strictEqual(r.contactId, null, 'names must never drive a link')
})

test('one address owned by two contacts defers instead of picking', () => {
  const idx = indexContactsByEmail([
    { id: 'c-1', user_id: USER_ID, email: DANA },
    { id: 'c-2', user_id: USER_ID, email: DANA },
  ], USER_ID)
  assert.strictEqual(idx.get(DANA), 'ambiguous_contact')
  const r = evaluateMessage({ message: norm(graphMsg()).message, selfSet, contactIndex: idx })
  assert.deepStrictEqual(r, { outcome: 'deferred', code: 'ambiguous_contact' })
})

test('another user\'s contacts are never visible to this user\'s matching', () => {
  const idx = indexContactsByEmail([{ id: 'c-other', user_id: 'someone-else', email: DANA }], USER_ID)
  assert.strictEqual(idx.size, 0)
})

// ── Automated senders ────────────────────────────────────────────────────────
console.log('\nautomated sender exclusion')

test('mailing lists and bulk mail are hard-excluded once the GET supplies headers', () => {
  for (const headers of [
    [{ name: 'List-Id', value: '<l.example.invalid>' }],
    [{ name: 'List-Unsubscribe', value: '<mailto:u@example.invalid>' }],
    [{ name: 'Precedence', value: 'bulk' }],
  ]) {
    const a = assessedWithHeaders(graphMsg(), headers)
    const r = evaluateMessage({ message: a.message, extra: a.extra, selfSet, contactIndex })
    assert.deepStrictEqual(r, { outcome: 'excluded', code: 'bulk_or_list' },
      'a newsletter is rejected even though it came from a tracked address')
  }
})

test('envelope-based sender rules work at DISCOVERY, with no headers available', () => {
  for (const addr of [
    'no-reply@contoso.example.invalid', 'noreply@contoso.example.invalid',
    'donotreply@contoso.example.invalid', 'mailer-daemon@contoso.example.invalid',
    'bounces@contoso.example.invalid', 'notifications@contoso.example.invalid',
    'hello@no-reply.example.invalid',
  ]) {
    const r = evaluateMessage({ message: norm(graphMsg({ from: rcpt(addr) })).message, selfSet, contactIndex })
    assert.deepStrictEqual(r, { outcome: 'excluded', code: 'non_human_message' }, addr)
  }
})

test('subject-based automation rules also work at DISCOVERY, with no headers', () => {
  for (const subject of [
    'Automatic reply: Coffee chat', 'Out of Office: back Monday',
    'Undeliverable: Coffee chat', 'Delivery Status Notification (Failure)',
  ]) {
    const r = evaluateMessage({ message: norm(graphMsg({ subject })).message, selfSet, contactIndex })
    assert.deepStrictEqual(r, { outcome: 'excluded', code: 'non_human_message' }, subject)
  }
})

test('a legitimate human address at a normal domain is NOT excluded', () => {
  const a = assessed(graphMsg({ from: rcpt('reply.team@contoso.example.invalid') }))
  const r = evaluateMessage({ message: a.message, extra: a.extra, selfSet, contactIndex })
  assert.strictEqual(r.outcome, 'eligible', 'the exclusion rules stay conservative')
})

// ── CC-only ──────────────────────────────────────────────────────────────────
console.log('\ncc-only and ambiguity')

test('being CC-d is never an interaction and never proposes a contact', () => {
  const { message } = norm(graphMsg({
    from: rcpt(USER), toRecipients: [rcpt(USER_ALIAS)], ccRecipients: [rcpt(ALEX, 'Alex Wilber')],
  }), 'sentitems')
  const parts = splitParticipants(message, selfSet)
  assert.deepStrictEqual(parts.direct, [])
  assert.deepStrictEqual(parts.ccOnly, [ALEX])
  assert.deepStrictEqual(evaluateMessage({ message, selfSet, contactIndex }),
    { outcome: 'excluded', code: 'cc_only' })
})

test('a person on To is direct even when also on Cc', () => {
  const { message } = norm(graphMsg({ from: rcpt(USER), toRecipients: [rcpt(DANA)], ccRecipients: [rcpt(DANA)] }), 'sentitems')
  const parts = splitParticipants(message, selfSet)
  assert.deepStrictEqual(parts.direct, [DANA])
  assert.deepStrictEqual(parts.ccOnly, [])
})

test('a group thread with several direct counterparties DEFERS rather than guessing', () => {
  const { message } = norm(graphMsg({ from: rcpt(DANA), toRecipients: [rcpt(USER), rcpt(ALEX)] }))
  assert.deepStrictEqual(evaluateMessage({ message, selfSet, contactIndex }),
    { outcome: 'deferred', code: 'ambiguous_counterparties' })
})

test('a discovery item has incomplete facts: unknown DEFERS, known is still eligible', () => {
  // This is the default state of every delta item now that headers are not selected.
  const unknown = norm(graphMsg({ from: rcpt(ALEX) }))
  assert.strictEqual(unknown.extra.automationFactsComplete, false)
  assert.deepStrictEqual(
    evaluateMessage({ message: unknown.message, extra: unknown.extra, selfSet, contactIndex }),
    { outcome: 'deferred', code: 'automation_facts_incomplete' },
    'an unknown sender is never accepted on unassessed automation')

  const known = norm(graphMsg())
  const r = evaluateMessage({ message: known.message, extra: known.extra, selfSet, contactIndex })
  assert.strictEqual(r.outcome, 'eligible',
    'a tracked exact address is not suppressed merely because optional headers are absent')
  assert.strictEqual(r.contactId, 'c-dana')
})

test('a missing `extra` fails CLOSED for an unknown sender', () => {
  const m = norm(graphMsg({ from: rcpt(ALEX) })).message
  assert.deepStrictEqual(evaluateMessage({ message: m, selfSet, contactIndex }),
    { outcome: 'deferred', code: 'automation_facts_incomplete' },
    'forgetting to thread the facts through must not accept a stranger')
})

test('an inconclusive header collection does not upgrade the state', () => {
  const r = norm(graphMsg({ from: rcpt(ALEX) }))
  // Graph answered, but without the collection: still not assessed.
  const a = applyAutomationFacts(r.message, r.extra, automationFactsFromHeaders(undefined))
  assert.strictEqual(a.extra.automationFactsComplete, false)
  assert.deepStrictEqual(evaluateMessage({ message: a.message, extra: a.extra, selfSet, contactIndex }),
    { outcome: 'deferred', code: 'automation_facts_incomplete' })
})

test('applyAutomationFacts never accepts a raw header collection', () => {
  const r = norm(graphMsg())
  // Anything that is not the classified {facts, complete} shape leaves the pair
  // conservative rather than being interpreted.
  for (const junk of [null, undefined, [{ name: 'List-Id', value: '<x>' }], 'headers', 42]) {
    const a = applyAutomationFacts(r.message, r.extra, junk)
    assert.ok(a.extra === undefined || a.extra.automationFactsComplete !== true,
      `must not mark assessed from ${JSON.stringify(junk)}`)
  }
})

// ── Episode qualification ────────────────────────────────────────────────────
console.log('\nepisode qualification')

const inboundFromDana = () => norm(graphMsg({ id: 'AAMk_in_1', receivedDateTime: '2026-09-10T14:03:00Z' }))
const outboundToDana = () => norm(graphMsg({
  id: 'AAMk_out_1', from: rcpt(USER), toRecipients: [rcpt(DANA)],
  sentDateTime: '2026-09-11T09:00:00Z', receivedDateTime: '2026-09-11T09:00:00Z',
}), 'sentitems')

test('a two-sided exchange with a known contact yields an interaction draft', () => {
  const r = qualifyEpisode({ entries: [inboundFromDana(), outboundToDana()], selfSet, contactIndex })
  assert.ok(r.ok)
  assert.strictEqual(r.kind, 'known_contact_interaction')
  assert.strictEqual(r.contactId, 'c-dana')
  assert.strictEqual(r.inbound, 1)
  assert.strictEqual(r.outbound, 1)
  assert.strictEqual(r.firstMessageKey, 'AAMk_in_1', 'episode anchors on the earliest message')
})

test('a ONE-SIDED exchange is refused in both directions', () => {
  assert.strictEqual(qualifyEpisode({ entries: [inboundFromDana()], selfSet, contactIndex }).code, 'not_two_sided')
  assert.strictEqual(qualifyEpisode({ entries: [outboundToDana()], selfSet, contactIndex }).code, 'not_two_sided')
})

test('an unknown but genuinely two-sided counterparty yields a NEW CONTACT suggestion', () => {
  // Only reachable AFTER the per-message GET has supplied the automation facts.
  const inbound = assessed(graphMsg({ id: 'i1', from: rcpt(ALEX, 'Alex Wilber'), conversationId: 'conv_alex' }))
  const outbound = assessed(graphMsg({
    id: 'o1', conversationId: 'conv_alex', from: rcpt(USER), toRecipients: [rcpt(ALEX)],
    sentDateTime: '2026-09-12T09:00:00Z',
  }), 'sentitems')
  const r = qualifyEpisode({ entries: [inbound, outbound], selfSet, contactIndex })
  assert.ok(r.ok)
  assert.strictEqual(r.kind, 'new_contact_suggestion')
  assert.strictEqual(r.contactId, null)
  assert.strictEqual(r.counterparty, ALEX, 'the address comes from the envelope')
  assert.strictEqual(r.displayName, 'Alex Wilber', 'provider metadata name is carried for review')
})

test('nothing in the qualification result creates or implies an automatic save', () => {
  const r = qualifyEpisode({ entries: [inboundFromDana(), outboundToDana()], selfSet, contactIndex })
  const keys = Object.keys(r).sort()
  for (const forbidden of ['contact', 'created', 'inserted', 'saved', 'interactionId']) {
    assert.ok(!keys.includes(forbidden), `result must not contain ${forbidden}`)
  }
  assert.ok(!/insert|upsert|\.from\(|rpc\(/i.test(P_SRC.replace(/^\s*\/\/.*$/gm, '')),
    'the module performs no database work at all')
})

test('a deferral anywhere in the conversation taints the whole episode', () => {
  const group = norm(graphMsg({ id: 'g1', from: rcpt(DANA), toRecipients: [rcpt(USER), rcpt(ALEX)] }))
  const r = qualifyEpisode({ entries: [inboundFromDana(), outboundToDana(), group], selfSet, contactIndex })
  assert.ok(!r.ok)
  assert.strictEqual(r.code, 'ambiguous_counterparties',
    'we never summarize only the subset we happened to understand')
})

test('an episode whose messages are all excluded produces nothing', () => {
  // Excluded at DISCOVERY on envelope evidence alone (a no-reply sender).
  const envelopeJunk = norm(graphMsg({ id: 'j1', from: rcpt('no-reply@contoso.example.invalid') }))
  assert.strictEqual(qualifyEpisode({ entries: [envelopeJunk], selfSet, contactIndex }).code,
    'no_eligible_messages')
  // Excluded only once the CONTENT read revealed a List-Id.
  const listJunk = assessedWithHeaders(graphMsg({ id: 'j2' }), [{ name: 'List-Id', value: '<x>' }])
  assert.strictEqual(qualifyEpisode({ entries: [listJunk], selfSet, contactIndex }).code,
    'no_eligible_messages')
  assert.strictEqual(qualifyEpisode({ entries: [], selfSet, contactIndex }).code, 'no_eligible_messages')
})

// ── Fingerprints ─────────────────────────────────────────────────────────────
console.log('\nfingerprints')

const CONN = '22222222-2222-4222-8222-222222222222'
const keyRing = {
  current: { keyBytes: new Uint8Array(32).fill(7), keyVersion: 1 },
  subtle: globalThis.crypto.subtle,
}

test('field builders produce the canonical five-slot shape with domain tags', () => {
  const ep = buildEpisodeFingerprintFields({ connectionId: CONN, conversationKey: 'conv', firstMessageKey: 'm1', contactId: 'c-dana' })
  assert.strictEqual(ep.provider, 'outlook')
  assert.strictEqual(ep.accountNamespace, CONN)
  assert.strictEqual(ep.contactId, 'episode:c-dana')
  const pe = buildPersonFingerprintFields({ connectionId: CONN, email: 'Dana.Swope@Contoso.Example.Invalid' })
  assert.strictEqual(pe.contactId, `person:${DANA}`, 'address is normalized before it is committed')
  assert.throws(() => buildPersonFingerprintFields({ connectionId: CONN, email: 'not-an-email' }), /invalid_fingerprint_input/)
})

await atest('fingerprints are 64 lowercase hex chars — the shape the CHECK constraints require', async () => {
  const q = qualifyEpisode({ entries: [inboundFromDana(), outboundToDana()], selfSet, contactIndex })
  const { episode, person } = await computeEpisodeFingerprints(q, { connectionId: CONN, keyRing })
  for (const fp of [episode.writeFingerprint, person.writeFingerprint]) {
    assert.match(fp, /^[0-9a-f]{64}$/, 'must satisfy ^[0-9a-f]{64}$')
  }
})

await atest('the same episode always fingerprints identically; a different one does not', async () => {
  const q = qualifyEpisode({ entries: [inboundFromDana(), outboundToDana()], selfSet, contactIndex })
  const a = await computeEpisodeFingerprints(q, { connectionId: CONN, keyRing })
  const b = await computeEpisodeFingerprints(q, { connectionId: CONN, keyRing })
  assert.strictEqual(a.episode.writeFingerprint, b.episode.writeFingerprint, 'deterministic')

  const other = await computeEpisodeFingerprints(
    { ...q, conversationKey: 'different_conv' }, { connectionId: CONN, keyRing })
  assert.notStrictEqual(a.episode.writeFingerprint, other.episode.writeFingerprint)

  const otherConn = await computeEpisodeFingerprints(q, { connectionId: 'other-conn', keyRing })
  assert.notStrictEqual(a.episode.writeFingerprint, otherConn.episode.writeFingerprint,
    'fingerprints are scoped to the connection')
})

await atest('episode and person fingerprints occupy separate domains', async () => {
  const q = qualifyEpisode({ entries: [inboundFromDana(), outboundToDana()], selfSet, contactIndex })
  const { episode, person } = await computeEpisodeFingerprints(q, { connectionId: CONN, keyRing })
  assert.notStrictEqual(episode.writeFingerprint, person.writeFingerprint)
})

await atest('no key material or address appears in a fingerprint result', async () => {
  const q = qualifyEpisode({ entries: [inboundFromDana(), outboundToDana()], selfSet, contactIndex })
  const out = await computeEpisodeFingerprints(q, { connectionId: CONN, keyRing })
  const s = JSON.stringify(out)
  assert.ok(!s.includes(DANA) && !s.includes('keyBytes'), 'opaque output only')
})

test('no new secret, key or environment read is introduced by this phase', () => {
  for (const src of [P_SRC, N_SRC]) {
    const exec = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    for (const bad of ['process.env', 'Deno.env', 'ANTHROPIC', 'GOOGLE_', 'MICROSOFT_', 'crypto.randomUUID', 'generateKey']) {
      assert.ok(!exec.includes(bad), `must not contain ${bad}`)
    }
    assert.ok(!/console\s*\./.test(exec), 'no logging')
  }
})

// Strip line comments AND block/JSDoc comments, so prose that merely MENTIONS the
// other providers (e.g. explaining why they are not imported) is not a false positive.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')

test('zero Gmail or Calendar coupling', () => {
  for (const src of [P_SRC, N_SRC]) {
    const imports = [...src.matchAll(/^import [\s\S]*? from '(.+?)'$/gm)].map((m) => m[1])
    assert.ok(imports.length > 0 || !/^import/m.test(src), 'import scan must actually see the imports')
    for (const i of imports) {
      assert.ok(!/gmail|calendar|google/i.test(i), `must not import ${i}`)
    }
    assert.ok(!/\bgmail\b|\bgoogle\b|\bcalendar\b/i.test(stripComments(src)),
      'no Gmail/Google/Calendar reference in executable code')
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
