// Tests for the pure Gmail metadata transport adapter. Synthetic provider objects
// only (example.com, generic ids) — no real Gmail data, no network, no PII.
// Run: node tests/gmail-transport.test.js

import assert from 'assert'
import {
  normalizeGmailMessage, normalizeGmailBatch, partitionForClassifier,
  buildInitialListRequest, buildHistoryRequest, buildGetMetadataRequest,
  buildGetThreadRequest, buildGetProfileRequest, HISTORY_TYPES,
  initialWindowStartEpochSec, checkRunCaps, internalDateToIso,
  normalizeAutoSubmitted, normalizePrecedence, resolveAutoSubmitted, resolvePrecedence,
  folderHintFromLabels, grantedScopesIncludeGmail,
  METADATA_HEADER_ALLOWLIST, GMAIL_READONLY_SCOPE, GMAIL_METADATA_SCOPE,
  INITIAL_WINDOW_DAYS, MAX_RESULTS_PER_PAGE, MAX_RESPONSE_BYTES, MAX_PAGES,
} from '../supabase/functions/shared/gmailTransport.js'
import { classifyNormalizedMessage } from '../supabase/functions/shared/emailProviderContract.js'

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

// Synthetic Gmail metadata-format message builder.
function hdrs(obj) { return Object.entries(obj).map(([name, value]) => ({ name, value })) }
function gmsg(over = {}) {
  const headers = over.headers || hdrs({
    From: 'peer@example.com', To: 'me@example.com', Subject: 'hi', 'Message-ID': '<a@example.com>',
  })
  const base = {
    id: over.id !== undefined ? over.id : 'm1',
    threadId: over.threadId !== undefined ? over.threadId : 't1',
    labelIds: over.labelIds || ['INBOX'],
    snippet: over.snippet !== undefined ? over.snippet : 'THIS SNIPPET MUST NEVER SURVIVE',
    internalDate: over.internalDate !== undefined ? over.internalDate : String(Date.UTC(2026, 0, 1, 10, 0, 0)),
    payload: over.payload || { mimeType: 'multipart/mixed', headers, body: { size: 12345 } },
  }
  return base
}

console.log('\nnormalization into the E1 contract')
test('a metadata message normalizes to a valid E1 NormalizedMessage', () => {
  const r = normalizeGmailMessage(gmsg())
  assert.ok(r.ok)
  assert.strictEqual(r.message.provider, 'gmail')
  assert.strictEqual(r.message.providerMessageKey, 'm1')
  assert.strictEqual(r.message.providerConversationKey, 't1')
  assert.strictEqual(r.message.timestampIso, '2026-01-01T10:00:00.000Z')
  assert.strictEqual(r.message.fromAddress, 'peer@example.com')
  assert.deepStrictEqual(r.message.toAddresses, ['me@example.com'])
  assert.strictEqual(r.message.folderHint, 'inbox')
  assert.strictEqual(classifyNormalizedMessage(r.message), null) // passes E1 validator
})
test('normalized message carries NO snippet/body/raw/attachment keys', () => {
  const r = normalizeGmailMessage(gmsg())
  const keys = Object.keys(r.message)
  for (const forbidden of ['snippet', 'body', 'raw', 'html', 'attachments', 'payload', 'labelIds', 'internalDate', 'historyId']) {
    assert.ok(!keys.includes(forbidden), `normalized must not include ${forbidden}`)
  }
})

console.log('\nallowlist: only allowed headers survive')
test('non-allowlisted headers are dropped; allowlisted map through', () => {
  const r = normalizeGmailMessage(gmsg({
    headers: hdrs({
      From: 'peer@example.com', To: 'me@example.com', Cc: 'x@example.com', Subject: 's',
      'X-Tracking-Pixel': 'evil', 'Received': 'chain', 'DKIM-Signature': 'zzz',
      'List-Id': '<list.example.com>', 'Auto-Submitted': 'auto-generated',
    }),
  }))
  assert.ok(r.ok)
  assert.strictEqual(r.message.ccAddresses[0], 'x@example.com')
  assert.strictEqual(r.message.automation.hasListId, true)
  assert.strictEqual(r.message.automation.autoSubmitted, 'auto-generated')
  // Ensure no raw header container leaked.
  assert.strictEqual(r.message.headers, undefined)
})
test('METADATA_HEADER_ALLOWLIST is the exact expected set', () => {
  assert.deepStrictEqual([...METADATA_HEADER_ALLOWLIST].sort(), [
    'auto-submitted', 'cc', 'date', 'from', 'list-id', 'list-unsubscribe',
    'message-id', 'precedence', 'subject', 'to', 'x-auto-response-suppress',
  ])
})

console.log('\nfail-closed on prohibited content / malformed input')
test('payload body DATA present -> unexpected_body (fail closed)', () => {
  const r = normalizeGmailMessage(gmsg({ payload: { headers: hdrs({ From: 'a@example.com' }), body: { size: 3, data: 'SGVsbG8' } } }))
  assert.deepStrictEqual(r, { ok: false, code: 'unexpected_body' })
})
test('nested part body DATA present -> unexpected_body', () => {
  const r = normalizeGmailMessage(gmsg({ payload: { headers: hdrs({ From: 'a@example.com' }), parts: [{ body: { size: 3, data: 'QUJD' } }] } }))
  assert.deepStrictEqual(r, { ok: false, code: 'unexpected_body' })
})
test('missing ids / no headers / bad internalDate fail closed', () => {
  assert.strictEqual(normalizeGmailMessage(gmsg({ id: '' })).code, 'missing_ids')
  assert.strictEqual(normalizeGmailMessage(gmsg({ threadId: '' })).code, 'missing_ids')
  assert.strictEqual(normalizeGmailMessage(gmsg({ payload: {} })).code, 'no_headers')
  assert.strictEqual(normalizeGmailMessage(gmsg({ internalDate: 'not-a-number' })).code, 'bad_internal_date')
})
test('prototype-polluted / non-object raw fail closed', () => {
  assert.strictEqual(normalizeGmailMessage(null).code, 'not_object')
  assert.strictEqual(normalizeGmailMessage([gmsg()]).code, 'not_object')
  const poison = gmsg(); Object.defineProperty(poison, '__proto__', { value: {}, enumerable: true, configurable: true, writable: true })
  assert.strictEqual(normalizeGmailMessage(poison).code, 'prototype_pollution')
})
test('oversized header fails closed', () => {
  const r = normalizeGmailMessage(gmsg({ headers: hdrs({ From: 'a@example.com', Subject: 's'.repeat(2000) }) }))
  assert.strictEqual(r.code, 'oversized_header')
})

console.log('\nautomation-fact mapping')
test('List-Unsubscribe / Precedence / X-Auto-Response-Suppress map to facts', () => {
  const r = normalizeGmailMessage(gmsg({ headers: hdrs({
    From: 'a@example.com', 'List-Unsubscribe': '<mailto:u@example.com>', Precedence: 'bulk', 'X-Auto-Response-Suppress': 'All',
  }) }))
  assert.strictEqual(r.message.automation.hasListUnsubscribe, true)
  assert.strictEqual(r.message.automation.precedence, 'bulk')
  assert.strictEqual(r.message.automation.hasAutoResponseSuppress, true)
})
test('normalizeAutoSubmitted / normalizePrecedence controlled enums', () => {
  assert.strictEqual(normalizeAutoSubmitted('auto-generated'), 'auto-generated')
  assert.strictEqual(normalizeAutoSubmitted('no'), 'no')
  assert.strictEqual(normalizeAutoSubmitted('weird'), 'other')
  assert.strictEqual(normalizeAutoSubmitted(''), null)
  assert.strictEqual(normalizePrecedence('list'), 'list')
  assert.strictEqual(normalizePrecedence('junk'), 'junk')
  assert.strictEqual(normalizePrecedence('whatever'), 'other')
})
test('folderHintFromLabels', () => {
  assert.strictEqual(folderHintFromLabels(['SENT']), 'sent')
  assert.strictEqual(folderHintFromLabels(['INBOX', 'IMPORTANT']), 'inbox')
  assert.strictEqual(folderHintFromLabels(['CATEGORY_PROMOTIONS']), 'unknown')
  assert.strictEqual(folderHintFromLabels(null), 'unknown')
})

console.log('\nduplicate security-header resolution (any-automated-wins)')
test('resolveAutoSubmitted: a duplicate "no" cannot hide an automated value', () => {
  assert.strictEqual(resolveAutoSubmitted(['no', 'auto-generated']), 'auto-generated')
  assert.strictEqual(resolveAutoSubmitted(['auto-replied', 'no']), 'auto-replied')
  assert.strictEqual(resolveAutoSubmitted(['no', 'no']), 'no')
  assert.strictEqual(resolveAutoSubmitted([]), null)
})
test('resolvePrecedence: a duplicate "normal" cannot hide bulk/list/junk', () => {
  assert.strictEqual(resolvePrecedence(['normal', 'bulk']), 'bulk')
  assert.strictEqual(resolvePrecedence(['list', 'normal']), 'list')
  assert.strictEqual(resolvePrecedence(['normal', 'whatever']), 'other')
  assert.strictEqual(resolvePrecedence([]), null)
})
test('normalizeGmailMessage: bulk evidence in a SECOND Precedence header is not bypassed', () => {
  const r = normalizeGmailMessage(gmsg({ headers: [
    { name: 'From', value: 'peer@example.com' },
    { name: 'Precedence', value: 'normal' },
    { name: 'Precedence', value: 'bulk' },       // must win
    { name: 'Auto-Submitted', value: 'no' },
    { name: 'Auto-Submitted', value: 'auto-generated' }, // must win
  ] }))
  assert.strictEqual(r.message.automation.precedence, 'bulk')
  assert.strictEqual(r.message.automation.autoSubmitted, 'auto-generated')
})

console.log('\ninternalDate → ISO UTC')
test('internalDateToIso valid + bounds', () => {
  assert.strictEqual(internalDateToIso(String(Date.UTC(2026, 0, 2, 3, 4, 5))), '2026-01-02T03:04:05.000Z')
  assert.strictEqual(internalDateToIso(-1), null)
  assert.strictEqual(internalDateToIso('abc'), null)
  assert.strictEqual(internalDateToIso(9e15), null)
})

console.log('\nbatch dedup + incompleteness')
test('duplicate ids across pages dedupe deterministically', () => {
  const b = normalizeGmailBatch([gmsg({ id: 'm1' }), gmsg({ id: 'm1' }), gmsg({ id: 'm2' })])
  assert.strictEqual(b.messages.length, 2)
  assert.strictEqual(b.counts.duplicates, 1)
})
test('a discarded message marks its thread incomplete', () => {
  const b = normalizeGmailBatch([
    gmsg({ id: 'ok', threadId: 't1' }),
    gmsg({ id: 'bad', threadId: 't2', internalDate: 'nope' }),
  ])
  assert.ok(b.incompleteConversationKeys.includes('t2'))
  assert.ok(!b.incompleteConversationKeys.includes('t1'))
  assert.strictEqual(b.counts.discarded, 1)
})
test('caller-supplied truncated threads start incomplete', () => {
  const b = normalizeGmailBatch([gmsg({ id: 'm1', threadId: 't1' })], { threadTruncatedKeys: ['t1'] })
  assert.deepStrictEqual(b.incompleteConversationKeys, ['t1'])
})
test('a throwing getter fails CLOSED (no crash) and makes the run incomplete', () => {
  const poison = {}
  Object.defineProperty(poison, 'payload', { get() { throw new Error('boom') }, enumerable: true })
  Object.defineProperty(poison, 'id', { value: 'm1', enumerable: true })
  Object.defineProperty(poison, 'threadId', { get() { throw new Error('boom') }, enumerable: true })
  let b
  assert.doesNotThrow(() => { b = normalizeGmailBatch([gmsg({ id: 'ok', threadId: 't1' }), poison]) })
  assert.strictEqual(b.hadUnreadable, true)
  assert.strictEqual(b.counts.discarded, 1)
  assert.strictEqual(partitionForClassifier(b).complete, false) // unreadable item -> run incomplete
})
test('an unattributable discard (no readable threadId) makes the run incomplete', () => {
  const b = normalizeGmailBatch([gmsg({ id: '', threadId: '' })]) // missing_ids, threadId unreadable
  assert.strictEqual(b.hadUnreadable, true)
  assert.strictEqual(partitionForClassifier(b).complete, false)
})

console.log('\npartitionForClassifier: incomplete threads never reach E1')
test('incomplete thread messages are withheld; run marked incomplete', () => {
  const batch = {
    messages: [
      { providerConversationKey: 't1', providerMessageKey: 'a' },
      { providerConversationKey: 't2', providerMessageKey: 'b' },
    ],
    incompleteConversationKeys: ['t2'],
  }
  const p = partitionForClassifier(batch)
  assert.deepStrictEqual(p.classifierMessages.map((m) => m.providerMessageKey), ['a'])
  assert.deepStrictEqual(p.withheldConversationKeys, ['t2'])
  assert.strictEqual(p.complete, false)
})
test('fully clean batch is complete; automation messages are NOT incomplete', () => {
  // An automated message normalizes fine (complete); E1 filters it, transport stays complete.
  const b = normalizeGmailBatch([
    gmsg({ id: 'h1', threadId: 't1' }),
    gmsg({ id: 'auto', threadId: 't1', headers: hdrs({ From: 'no-reply@example.com', 'Auto-Submitted': 'auto-generated' }) }),
  ])
  const p = partitionForClassifier(b)
  assert.strictEqual(p.complete, true)
  assert.strictEqual(p.classifierMessages.length, 2)
})
test('transportError forces incomplete even with clean messages', () => {
  const p = partitionForClassifier({ messages: [{ providerConversationKey: 't1', providerMessageKey: 'a' }], incompleteConversationKeys: [] }, { transportError: true })
  assert.strictEqual(p.complete, false)
})

console.log('\nrequest builders: server params only')
test('buildInitialListRequest constructs a bounded q and clamps maxResults', () => {
  const req = buildInitialListRequest({ afterEpochSec: 1735689600, maxResults: 99999 })
  assert.strictEqual(req.method, 'GET')
  assert.match(req.query.q, /^after:1735689600 -in:chats$/)
  assert.strictEqual(req.query.maxResults, String(MAX_RESULTS_PER_PAGE))
  assert.strictEqual(req.query.includeSpamTrash, 'false')
})
test('buildGetMetadataRequest requests ONLY format=metadata + allowlist headers', () => {
  const req = buildGetMetadataRequest({ messageId: 'abc-123_XYZ' })
  assert.strictEqual(req.query.format, 'metadata')
  assert.deepStrictEqual(req.query.metadataHeaders, [...METADATA_HEADER_ALLOWLIST])
  assert.match(req.path, /\/messages\/abc-123_XYZ$/)
})
test('buildHistoryRequest requires a numeric server history id', () => {
  const req = buildHistoryRequest({ startHistoryId: '123456' })
  assert.strictEqual(req.query.startHistoryId, '123456')
  // E2B correction: users.history.list FILTERS to the requested types, so all four must be
  // requested or deletions / TRASH / SPAM changes are never delivered to the worker.
  assert.deepStrictEqual(req.query.historyTypes, ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'])
  assert.deepStrictEqual([...HISTORY_TYPES], ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'])
  assert.notStrictEqual(req.query.historyTypes, HISTORY_TYPES, 'a copy, so callers cannot mutate the constant')
  assert.throws(() => buildHistoryRequest({ startHistoryId: 'abc' }), /invalid_history_id/)
  assert.throws(() => buildHistoryRequest({ startHistoryId: '' }), /invalid_history_id/)
})
test('buildGetThreadRequest is format=minimal only (ids + labels, never headers/payload)', () => {
  const req = buildGetThreadRequest({ threadId: 'thr_1-A' })
  assert.deepStrictEqual(req.query, { format: 'minimal' })
  assert.match(req.path, /\/threads\/thr_1-A$/)
  for (const bad of ['', 'a/b', 'x?y', 'x'.repeat(1025), 5, null]) {
    assert.throws(() => buildGetThreadRequest({ threadId: bad }), /invalid_thread_id|invalid_params/)
  }
  assert.throws(() => buildGetThreadRequest({ threadId: 't', q: 'x' }), /forbidden_request_param/)
})
test('buildGetProfileRequest carries no parameters at all', () => {
  const req = buildGetProfileRequest()
  assert.strictEqual(req.method, 'GET')
  assert.strictEqual(req.path, '/gmail/v1/users/me/profile')
  assert.deepStrictEqual(req.query, {})
})
test('builders reject caller-controlled operational params', () => {
  for (const bad of [
    { afterEpochSec: 1, q: 'from:ceo@example.com' },
    { afterEpochSec: 1, userId: 'u1' },
    { afterEpochSec: 1, connectionId: 'c1' },
    { afterEpochSec: 1, label: 'INBOX' },
    { afterEpochSec: 1, historyId: '5' },
    { afterEpochSec: 1, accessToken: 't' },
    { afterEpochSec: 1, metadataHeaders: ['X-Evil'] },
  ]) {
    assert.throws(() => buildInitialListRequest(bad), /forbidden_request_param/, JSON.stringify(bad))
  }
  assert.throws(() => buildGetMetadataRequest({ messageId: 'x', q: 'y' }), /forbidden_request_param/)
})
test('builders reject prototype pollution + bad message id', () => {
  const poison = { afterEpochSec: 1 }; Object.defineProperty(poison, '__proto__', { value: {}, enumerable: true, configurable: true, writable: true })
  assert.throws(() => buildInitialListRequest(poison), /prototype_pollution/)
  assert.throws(() => buildGetMetadataRequest({ messageId: '../../etc/passwd' }), /invalid_message_id/)
})

console.log('\ncaps + window + scope helper')
test('initialWindowStartEpochSec uses the documented lookback', () => {
  const now = Date.UTC(2026, 5, 1)
  const start = initialWindowStartEpochSec(now)
  assert.strictEqual(start, Math.floor((now - INITIAL_WINDOW_DAYS * 86400000) / 1000))
})
test('checkRunCaps flags each exhausted cap', () => {
  assert.strictEqual(checkRunCaps({ pageBytes: MAX_RESPONSE_BYTES + 1 }), 'response_too_large')
  assert.strictEqual(checkRunCaps({ pages: MAX_PAGES + 1 }), 'max_pages_exceeded')
  assert.strictEqual(checkRunCaps({ messages: 999999 }), 'max_messages_exceeded')
  assert.strictEqual(checkRunCaps({ conversations: 999999 }), 'max_conversations_exceeded')
  assert.strictEqual(checkRunCaps({ pages: 1, messages: 1, conversations: 1, pageBytes: 100 }), null)
})
test('grantedScopesIncludeGmail (dormant helper)', () => {
  assert.strictEqual(grantedScopesIncludeGmail(`openid ${GMAIL_READONLY_SCOPE}`), true)
  assert.strictEqual(grantedScopesIncludeGmail(GMAIL_METADATA_SCOPE), true)
  assert.strictEqual(grantedScopesIncludeGmail('https://www.googleapis.com/auth/calendar.events.readonly'), false)
  assert.strictEqual(grantedScopesIncludeGmail(''), false)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
