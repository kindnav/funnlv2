// CONVERSATION RECOVERY, at the module boundary.
//
// What is executed: the real request builders, the real page reader, the real fold
// (foldPage) and the real decision (finalizeConversation), with ONE injected Graph
// executor so every provider answer - the envelope, the two lookups, a 404, a 400, a
// truncated page, a transport failure - is scripted and counted. No network, no database.
//
// NO REAL IDENTIFIER, ADDRESS OR MESSAGE APPEARS IN THIS FILE.
//
// Run with: node tests/outlook-conversation-recovery.test.js

import assert from 'node:assert'
import {
  GRAPH_BASE, ENVELOPE_SELECT, MAX_RECOVERY_MESSAGES_PER_FOLDER, PREFER_IMMUTABLE_ID,
  buildMessageEnvelopeRequest, buildConversationLookupRequest, readConversationLookupPage,
  escapeODataString,
} from '../supabase/functions/shared/outlookGraphTransport.js'
import {
  recoverConversation, summarizeRecovery, RECOVERY_OUTCOME_CODES, RECOVERY_RETRYABLE,
  MAX_RECOVERIES_PER_INVOCATION, RECOVERY_ADMIT_MS, RECOVERY_REQUEST_ADMIT_MS,
} from '../supabase/functions/shared/outlookConversationRecovery.js'
import { buildSelfIdentitySet, indexContactsByEmail } from '../supabase/functions/shared/outlookParticipants.js'
import { foldPage, ROUND_TAINT_CODES } from '../supabase/functions/shared/outlookRoundState.js'
import { normalizeGraphPage } from '../supabase/functions/shared/outlookMessageNormalize.js'
import { buildMessageHandles } from '../supabase/functions/shared/outlookHandleProducer.js'
import { REQUIRED_CONTENT_CONSENT_VERSION } from '../supabase/functions/shared/outlookContentConsent.js'
import { localDateFor } from '../supabase/functions/shared/outlookMetadataPass.js'
import { CONTENT_REPORT_COUNTS, CONTENT_REPORT_MAPS } from '../supabase/functions/shared/outlookContentStage.js'

let passed = 0
let failed = 0
async function test (name, fn) {
  try { await fn(); console.log('  OK   ' + name); passed += 1 } catch (e) {
    console.error('  FAIL ' + name); console.error('       ' + (e && e.message ? e.message : String(e))); failed += 1
  }
}

// -- invented fixtures ----------------------------------------------------------
const CONN = '11111111-1111-1111-1111-111111111111'
const USER = '22222222-2222-2222-2222-222222222222'
const CONTACT = '33333333-3333-3333-3333-333333333333'
const ME = 'pilot@outlook.test'
const KNOWN = 'ava@bank.test'
const STRANGER = 'noor@fund.test'
const CONV = 'AAQkADconv-recovery-1'
const KEY_RING = { current: { keyBytes: new Uint8Array(32).fill(7), keyVersion: 1 } }
const selfSet = buildSelfIdentitySet(ME, [])
const contactIndex = indexContactsByEmail([{ id: CONTACT, user_id: USER, email: KNOWN }], USER)
const seal = async (plain) => ({ ciphertext: 'SEAL:' + plain, nonce: 'N1', keyVersion: 1 })
const decryptHandle = async ({ ciphertext }) => String(ciphertext).slice('SEAL:'.length)
const produceHandles = (selected) => buildMessageHandles({
  selected, consentVersion: REQUIRED_CONTENT_CONSENT_VERSION, requiredConsent: {}, seal,
})
const dateFor = (iso) => localDateFor(iso, 'UTC')

const rcpt = (a) => ({ emailAddress: { address: a, name: 'x' } })
const raw = (id, conv, from, to, sent) => ({
  id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
  subject: 'Following up', from: rcpt(from), sender: rcpt(from), toRecipients: to.map(rcpt), ccRecipients: [],
})
const IN = (party, id = 'AAkALgAAin-1', sent = '2026-09-21T14:00:00Z') => raw(id, CONV, party, [ME], sent)
const OUT = (party, id = 'AAkALgAAout-1', sent = '2026-09-21T16:00:00Z') => raw(id, CONV, ME, [party], sent)

/** The conversation fingerprint the round would hold, from the same fold the run uses. */
async function cfpOf (inboxRaw, sentRaw) {
  const entries = []
  for (const [list, folder] of [[inboxRaw, 'inbox'], [sentRaw, 'sentitems']]) {
    const n = normalizeGraphPage(list, folder)
    for (const m of n.messages) entries.push({ message: m, extra: n.extras.get(m.providerMessageKey) })
  }
  const f = await foldPage({ entries, selfSet, contactIndex, connectionId: CONN, keyRing: KEY_RING })
  return f.contributions[0]?.cfp ?? null
}
/** A stored handle for a message the round saw, in the shape readConversationHandles returns. */
const storedHandle = (id, folder, sentAt, mfp = 'f'.repeat(64)) => ({
  mfp, folder, sentAt, midCt: 'SEAL:' + id, midNonce: 'N1', keyVersion: 1,
})

/**
 * The scripted Graph. `script.envelope` answers the envelope GET; `script.inbox` and
 * `script.sentitems` answer the two lookups. Each is either { json } or { code }.
 */
function executor (script, log) {
  return async ({ request }) => {
    const u = request.url
    const prefer = request.headers && request.headers.Prefer
    if (u.startsWith(GRAPH_BASE + '/me/messages/')) {
      log.push({ kind: 'envelope', url: u, prefer })
      return script.envelope.code ? { ok: false, code: script.envelope.code } : { ok: true, json: script.envelope.json }
    }
    const folder = u.indexOf('/mailFolders/inbox/') >= 0 ? 'inbox' : (u.indexOf('/mailFolders/sentitems/') >= 0 ? 'sentitems' : null)
    log.push({ kind: 'lookup', folder, url: u, prefer })
    const s = script[folder] || { json: { value: [] } }
    return s.code ? { ok: false, code: s.code } : { ok: true, json: s.json }
  }
}
function params (over = {}) {
  const log = []
  const base = {
    row: { cfp: over.cfp ?? null },
    handles: [storedHandle('AAkALgAAin-1', 'inbox', '2026-09-21T14:00:00Z')],
    decryptHandle,
    accessToken: 'fixture-token',
    deps: { fetchImpl: async () => { throw new Error('the executor is injected') }, executeGraphRequest: executor(over.script ?? {}, log) },
    budgetAllows: () => true,
    selfSet, contactIndex, connectionId: CONN, keyRing: KEY_RING, produceHandles, localDateFor: dateFor,
  }
  return { log, p: { ...base, ...over, deps: over.deps ?? base.deps } }
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('1. the two requests, shaped exactly as Microsoft documents')
// ═══════════════════════════════════════════════════════════════════════════════
await test('the conversation lookup: $filter without $orderby, the envelope $select, a bounded $top, immutable ids', () => {
  const r = buildConversationLookupRequest({ folder: 'sentitems', conversationId: CONV })
  assert.strictEqual(r.method, 'GET')
  assert.strictEqual(r.stage, 'envelope')
  assert.ok(r.url.startsWith(GRAPH_BASE + '/me/mailFolders/sentitems/messages?'), r.url)
  assert.ok(r.url.indexOf('$filter=' + encodeURIComponent("conversationId eq '" + CONV + "'")) >= 0, r.url)
  assert.ok(r.url.indexOf('$select=' + ENVELOPE_SELECT.join(',')) >= 0, r.url)
  assert.ok(r.url.indexOf('$top=' + MAX_RECOVERY_MESSAGES_PER_FOLDER) >= 0, r.url)
  assert.ok(r.url.indexOf('orderby') < 0, 'NO $orderby: filter+orderby on messages fails InefficientFilter unless the ordered property leads the filter')
  assert.ok(r.url.indexOf('$search') < 0, 'never a search')
  for (const body of ['body', 'uniqueBody', 'bodyPreview', 'internetMessageHeaders']) {
    assert.ok(r.url.indexOf(body) < 0, 'envelope only: no ' + body)
  }
  assert.strictEqual(r.headers.Prefer, PREFER_IMMUTABLE_ID, 'the header is per request, so it is on this one')
})
await test('the lookup refuses the wrong folder, an unusable id, and clamps $top to the documented range', () => {
  assert.throws(() => buildConversationLookupRequest({ folder: 'drafts', conversationId: CONV }), /invalid_folder/)
  assert.throws(() => buildConversationLookupRequest({ folder: 'inbox', conversationId: 'has space' }), /invalid_conversation_id/)
  assert.throws(() => buildConversationLookupRequest({ folder: 'inbox', conversationId: "a'b" }), /invalid_conversation_id/)
  const big = buildConversationLookupRequest({ folder: 'inbox', conversationId: CONV, top: 5000 })
  assert.ok(big.url.endsWith('$top=' + MAX_RECOVERY_MESSAGES_PER_FOLDER), 'clamped to the per-folder bound')
  const small = buildConversationLookupRequest({ folder: 'inbox', conversationId: CONV, top: 0 })
  assert.ok(small.url.endsWith('$top=1'), 'and never below 1, the documented minimum')
  assert.ok(MAX_RECOVERY_MESSAGES_PER_FOLDER >= 1 && MAX_RECOVERY_MESSAGES_PER_FOLDER <= 1000, 'within $top 1..1000')
  assert.strictEqual(escapeODataString("let's"), "let''s", 'a single quote is doubled, as documented')
})
await test('the envelope GET selects the envelope only, with immutable ids, and refuses an unusable id', () => {
  const r = buildMessageEnvelopeRequest({ messageId: 'AAkALgAAin-1' })
  assert.strictEqual(r.url, GRAPH_BASE + '/me/messages/AAkALgAAin-1?$select=' + ENVELOPE_SELECT.join(','))
  assert.strictEqual(r.headers.Prefer, PREFER_IMMUTABLE_ID)
  assert.ok(ENVELOPE_SELECT.includes('conversationId'), 'the one field the recovery is after')
  assert.throws(() => buildMessageEnvelopeRequest({ messageId: 'bad id' }), /invalid_message_id/)
})
await test('the lookup page reader: items, truncation, malformed', () => {
  assert.deepStrictEqual(readConversationLookupPage({ value: [{ id: 'a' }] }), { ok: true, items: [{ id: 'a' }], truncated: false })
  assert.strictEqual(readConversationLookupPage({ value: [], '@odata.nextLink': 'https://x' }).truncated, true,
    'a next link means more than one bounded page: a thread too long to rest a summary on')
  assert.strictEqual(readConversationLookupPage({}).ok, false)
  assert.strictEqual(readConversationLookupPage({ value: [1] }).ok, false)
  assert.strictEqual(readConversationLookupPage(null).ok, false)
})

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('2. recovery decides exactly as a same-round read would')
// ═══════════════════════════════════════════════════════════════════════════════
await test('user wrote first, the stranger replied in a LATER round: recovered as a new-contact entry, bodies not yet read', async () => {
  // The round holds only the reply (inbox); Outlook holds both halves.
  const first = OUT(STRANGER, 'AAkALgAAout-1', '2026-09-20T09:00:00Z')
  const reply = IN(STRANGER, 'AAkALgAAin-1', '2026-09-21T14:00:00Z')
  const cfp = await cfpOf([reply], [first])
  const { log, p } = params({
    cfp,
    handles: [storedHandle('AAkALgAAin-1', 'inbox', '2026-09-21T14:00:00Z')],
    script: { envelope: { json: reply }, inbox: { json: { value: [reply] } }, sentitems: { json: { value: [first] } } },
  })
  const r = await recoverConversation(p)
  assert.strictEqual(r.outcome, 'recovered', JSON.stringify(r))
  assert.strictEqual(r.entry.kind, 'new_contact_suggestion')
  assert.strictEqual(r.entry.contactId, null)
  assert.strictEqual(r.entry.requiresContent, true, 'an unknown counterparty must still be screened from the headers the body fetch returns')
  assert.strictEqual(r.entry.inbound, 1)
  assert.strictEqual(r.entry.outbound, 1)
  assert.strictEqual(r.entry.proposedDate, '2026-09-21', 'the date of the LAST message in the thread')
  assert.match(r.entry.episodeFingerprint, /^[0-9a-f]{64}$/)
  // Three requests, all envelope-stage, all with immutable ids, none a body.
  assert.deepStrictEqual(log.map((l) => l.kind), ['envelope', 'lookup', 'lookup'])
  assert.deepStrictEqual(log.map((l) => l.folder).filter(Boolean), ['inbox', 'sentitems'])
  assert.ok(log.every((l) => l.prefer === PREFER_IMMUTABLE_ID))
  assert.ok(log.every((l) => l.url.indexOf('uniqueBody') < 0 && l.url.indexOf('internetMessageHeaders') < 0), 'no body was requested')
  // The recovered half gets a handle; the half the round already holds is not offered twice.
  assert.strictEqual(r.extraHandles.length, 2, JSON.stringify(r.extraHandles))
  assert.deepStrictEqual(r.stats, { envelopeFetches: 1, lookups: 2, recoveredMessages: 2, dedupedAgainstStored: 0 })
})
await test('the stranger wrote first, the user replied in a later round: the same entry, anchored on the opening message', async () => {
  const first = IN(STRANGER, 'AAkALgAAin-1', '2026-09-20T09:00:00Z')
  const reply = OUT(STRANGER, 'AAkALgAAout-1', '2026-09-21T16:00:00Z')
  const cfp = await cfpOf([first], [reply])
  const { p } = params({
    cfp,
    handles: [storedHandle('AAkALgAAout-1', 'sentitems', '2026-09-21T16:00:00Z')],
    script: { envelope: { json: reply }, inbox: { json: { value: [first] } }, sentitems: { json: { value: [reply] } } },
  })
  const r = await recoverConversation(p)
  assert.strictEqual(r.outcome, 'recovered', JSON.stringify(r))
  assert.strictEqual(r.entry.kind, 'new_contact_suggestion')
  // THE DEDUPE KEY IS THE SAME KEY a one-round read of the same thread produces.
  const entries = []
  for (const [list, folder] of [[[first], 'inbox'], [[reply], 'sentitems']]) {
    const n = normalizeGraphPage(list, folder)
    for (const m of n.messages) entries.push({ message: m, extra: n.extras.get(m.providerMessageKey) })
  }
  const same = await foldPage({ entries, selfSet, contactIndex, connectionId: CONN, keyRing: KEY_RING })
  assert.strictEqual(r.entry.episodeFingerprint, same.contributions[0].efp, 'a replay must refresh, not duplicate')
})
await test('an EXISTING contact across rounds: a known-contact entry, no screening requirement', async () => {
  const first = OUT(KNOWN, 'AAkALgAAout-1', '2026-09-20T09:00:00Z')
  const reply = IN(KNOWN, 'AAkALgAAin-1', '2026-09-21T14:00:00Z')
  const cfp = await cfpOf([reply], [first])
  const { p } = params({ cfp, script: { envelope: { json: reply }, inbox: { json: { value: [reply] } }, sentitems: { json: { value: [first] } } } })
  const r = await recoverConversation(p)
  assert.strictEqual(r.outcome, 'recovered', JSON.stringify(r))
  assert.strictEqual(r.entry.kind, 'known_contact_interaction')
  assert.strictEqual(r.entry.contactId, CONTACT)
  assert.strictEqual(r.entry.requiresContent, false)
})
await test('a message the round already holds a handle for is not offered twice', async () => {
  const first = OUT(STRANGER, 'AAkALgAAout-1', '2026-09-20T09:00:00Z')
  const reply = IN(STRANGER, 'AAkALgAAin-1', '2026-09-21T14:00:00Z')
  const cfp = await cfpOf([reply], [first])
  // Learn the real mfp of the stored half by folding once with handles.
  const n = normalizeGraphPage([reply], 'inbox')
  const probe = await foldPage({
    entries: n.messages.map((m) => ({ message: m, extra: n.extras.get(m.providerMessageKey) })),
    selfSet, contactIndex, connectionId: CONN, keyRing: KEY_RING, deps: { produceHandles },
  })
  const storedMfp = probe.messages[0].mfp
  const { p } = params({
    cfp,
    handles: [storedHandle('AAkALgAAin-1', 'inbox', '2026-09-21T14:00:00Z', storedMfp)],
    script: { envelope: { json: reply }, inbox: { json: { value: [reply] } }, sentitems: { json: { value: [first] } } },
  })
  const r = await recoverConversation(p)
  assert.strictEqual(r.outcome, 'recovered')
  assert.strictEqual(r.extraHandles.length, 1, 'only the half the round did not hold')
  assert.strictEqual(r.extraHandles[0].folder, 'sentitems')
  assert.strictEqual(r.stats.dedupedAgainstStored, 1)
})

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('3. every way it does NOT become a suggestion, and whether the work is kept')
// ═══════════════════════════════════════════════════════════════════════════════
await test('still one-sided after asking Outlook: settled as not_two_sided (an unanswered message)', async () => {
  const only = IN(STRANGER)
  const cfp = await cfpOf([only], [])
  const { p } = params({ cfp, script: { envelope: { json: only }, inbox: { json: { value: [only] } }, sentitems: { json: { value: [] } } } })
  const r = await recoverConversation(p)
  assert.deepStrictEqual([r.outcome, r.reason], ['settled', 'not_two_sided'])
  assert.strictEqual(r.stats.recoveredMessages, 1)
})
await test('no stored handle: settled as recovery_no_handles, without a single request', async () => {
  const { log, p } = params({ cfp: 'a'.repeat(64), handles: [] })
  const r = await recoverConversation(p)
  assert.deepStrictEqual([r.outcome, r.reason], ['settled', 'recovery_no_handles'])
  assert.strictEqual(log.length, 0)
})
await test('the stored message no longer resolves (404): settled as recovery_source_missing', async () => {
  const { p } = params({ cfp: 'a'.repeat(64), script: { envelope: { code: 'not_found' } } })
  const r = await recoverConversation(p)
  assert.deepStrictEqual([r.outcome, r.reason], ['settled', 'recovery_source_missing'])
})
await test('a transient failure on the envelope: RETRY, nothing settled', async () => {
  const { p } = params({ cfp: 'a'.repeat(64), script: { envelope: { code: 'server_error' } } })
  const r = await recoverConversation(p)
  assert.deepStrictEqual([r.outcome, r.reason], ['retry', 'recovery_fetch_failed'])
})
await test('the provider refuses the lookup (400): settled as recovery_unsupported - the signal the filter is not accepted', async () => {
  const only = IN(STRANGER)
  const cfp = await cfpOf([only], [])
  const { log, p } = params({ cfp, script: { envelope: { json: only }, inbox: { code: 'bad_request' } } })
  const r = await recoverConversation(p)
  assert.deepStrictEqual([r.outcome, r.reason], ['settled', 'recovery_unsupported'])
  assert.strictEqual(log.filter((l) => l.kind === 'lookup').length, 1, 'stops at the first refusal')
})
await test('a transient failure on a lookup: RETRY', async () => {
  const only = IN(STRANGER)
  const cfp = await cfpOf([only], [])
  const { p } = params({ cfp, script: { envelope: { json: only }, inbox: { json: { value: [only] } }, sentitems: { code: 'throttled' } } })
  const r = await recoverConversation(p)
  assert.deepStrictEqual([r.outcome, r.reason], ['retry', 'recovery_fetch_failed'])
})
await test('more of the thread than one bounded page: settled as recovery_truncated, never followed', async () => {
  const only = IN(STRANGER)
  const cfp = await cfpOf([only], [])
  const { p } = params({ cfp, script: { envelope: { json: only }, inbox: { json: { value: [only], '@odata.nextLink': GRAPH_BASE + '/x' } } } })
  const r = await recoverConversation(p)
  assert.deepStrictEqual([r.outcome, r.reason], ['settled', 'recovery_truncated'])
})
await test('a thread that is not the conversation the round holds: settled as recovery_mismatch', async () => {
  const first = OUT(STRANGER, 'AAkALgAAout-1', '2026-09-20T09:00:00Z')
  const reply = IN(STRANGER)
  const { p } = params({ cfp: 'b'.repeat(64), script: { envelope: { json: reply }, inbox: { json: { value: [reply] } }, sentitems: { json: { value: [first] } } } })
  const r = await recoverConversation(p)
  assert.deepStrictEqual([r.outcome, r.reason], ['settled', 'recovery_mismatch'])
})
await test('messages of ANOTHER conversation in the answer are ignored, never folded in', async () => {
  const only = IN(STRANGER)
  const other = raw('AAkALgAAother', 'AAQkADother-conv', KNOWN, [ME], '2026-09-21T15:00:00Z')
  const cfp = await cfpOf([only], [])
  const { p } = params({ cfp, script: { envelope: { json: only }, inbox: { json: { value: [only, other] } }, sentitems: { json: { value: [] } } } })
  const r = await recoverConversation(p)
  assert.deepStrictEqual([r.outcome, r.reason], ['settled', 'not_two_sided'])
  assert.strictEqual(r.stats.recoveredMessages, 1, 'the other conversation did not count')
})
await test('a second external person in the thread taints it, as a same-round read would: settled under the taint', async () => {
  const first = IN(STRANGER, 'AAkALgAAin-1', '2026-09-20T09:00:00Z')
  const group = raw('AAkALgAAout-9', CONV, ME, [STRANGER, KNOWN], '2026-09-21T16:00:00Z')
  const cfp = await cfpOf([first], [group])
  const { p } = params({ cfp, script: { envelope: { json: first }, inbox: { json: { value: [first] } }, sentitems: { json: { value: [group] } } } })
  const r = await recoverConversation(p)
  assert.strictEqual(r.outcome, 'settled')
  assert.ok(ROUND_TAINT_CODES.includes(r.reason) || r.reason === 'not_two_sided', r.reason)
})
await test('out of budget before a request: RETRY as budget_exhausted, and that request is not made', async () => {
  const only = IN(STRANGER)
  let calls = 0
  const { log, p } = params({
    cfp: 'a'.repeat(64),
    script: { envelope: { json: only }, inbox: { json: { value: [only] } }, sentitems: { json: { value: [] } } },
    budgetAllows: () => { calls += 1; return calls <= 2 },  // envelope admitted, first lookup admitted, second refused
  })
  const r = await recoverConversation(p)
  assert.deepStrictEqual([r.outcome, r.reason], ['retry', 'budget_exhausted'])
  assert.strictEqual(log.filter((l) => l.kind === 'lookup').length, 1)
  // Admitted one request at a time, like a body fetch: each of the three re-checks the
  // budget itself. Admitting on all three plus the write reserve exceeded the whole
  // invocation budget and no recovery ever ran.
  assert.ok(RECOVERY_REQUEST_ADMIT_MS > 0 && RECOVERY_ADMIT_MS === RECOVERY_REQUEST_ADMIT_MS)
})

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('4. the vocabulary is controlled and the report carries it')
// ═══════════════════════════════════════════════════════════════════════════════
await test('every outcome is in the allowlist; only two are retryable; the report names the counters and the map', () => {
  for (const c of ['recovered', 'not_two_sided', 'recovery_no_handles', 'recovery_source_missing', 'recovery_fetch_failed',
    'recovery_unsupported', 'recovery_truncated', 'recovery_mismatch', 'recovery_no_messages', 'budget_exhausted']) {
    assert.ok(RECOVERY_OUTCOME_CODES.includes(c), c)
  }
  for (const t of ROUND_TAINT_CODES) assert.ok(RECOVERY_OUTCOME_CODES.includes(t), t)
  assert.deepStrictEqual([...RECOVERY_RETRYABLE].sort(), ['budget_exhausted', 'recovery_fetch_failed'])
  assert.ok(MAX_RECOVERIES_PER_INVOCATION >= 1 && MAX_RECOVERIES_PER_INVOCATION <= 50)
  for (const k of ['recoveries_attempted', 'recoveries_two_sided', 'recovered_messages']) assert.ok(CONTENT_REPORT_COUNTS.includes(k), k)
  assert.ok(CONTENT_REPORT_MAPS.includes('recovery_outcomes'))
  const s = summarizeRecovery({ outcome: 'settled', reason: 'provider said something', stats: { lookups: 2 } })
  assert.strictEqual(s.outcome, 'recovery_mismatch', 'an unknown reason never leaves as itself')
  assert.strictEqual(s.lookups, 2)
})

console.log('')
console.log((passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed')
console.log('')
if (failed > 0) process.exit(1)
