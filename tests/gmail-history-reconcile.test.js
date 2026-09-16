// Tests for Gmail History incremental parsing + deletion/label reconciliation (pure).
// Synthetic provider objects only — no real Gmail data, no network, no PII.
// Run: node tests/gmail-history-reconcile.test.js

import assert from 'assert'
import {
  parseHistoryPage, aggregateHistory, plausibleBoundaryKeys,
  resolveReconciliationFingerprints, classifyHistoryStatus,
  SCOPE_EXIT_LABELS, MAX_AFFECTED_THREADS, MAX_HISTORY_RECORDS,
} from '../supabase/functions/shared/gmailHistory.js'

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

const M = (id, threadId) => ({ message: { id, threadId } })
const L = (id, threadId, labelIds) => ({ message: { id, threadId }, labelIds })

console.log('\nparseHistoryPage: messageAdded / messageDeleted')
await test('messagesAdded and messagesDeleted are separated', () => {
  const r = parseHistoryPage({
    historyId: '500',
    history: [{ id: '1', messagesAdded: [M('m1', 't1')], messagesDeleted: [M('m2', 't2')] }],
  })
  assert.ok(r.ok)
  assert.deepStrictEqual(r.added, [{ id: 'm1', threadId: 't1' }])
  assert.deepStrictEqual(r.removed, [{ id: 'm2', threadId: 't2' }])
  assert.strictEqual(r.historyId, '500')
})

console.log('\nlabel semantics: scope exit vs archiving')
await test('labelsAdded TRASH/SPAM removes the message from scope', () => {
  for (const lab of SCOPE_EXIT_LABELS) {
    const r = parseHistoryPage({ history: [{ id: '1', labelsAdded: [L('m1', 't1', [lab])] }] })
    assert.deepStrictEqual(r.removed, [{ id: 'm1', threadId: 't1' }], `${lab} must remove`)
  }
})
await test('ARCHIVING (labelsRemoved INBOX) does NOT remove — an archived thread keeps its suggestion', () => {
  const r = parseHistoryPage({ history: [{ id: '1', labelsRemoved: [L('m1', 't1', ['INBOX'])] }] })
  assert.deepStrictEqual(r.removed, [])
  assert.deepStrictEqual(r.restored, [])
})
await test('labelsAdded of an unrelated label does NOT remove', () => {
  const r = parseHistoryPage({ history: [{ id: '1', labelsAdded: [L('m1', 't1', ['IMPORTANT', 'STARRED'])] }] })
  assert.deepStrictEqual(r.removed, [])
})
await test('labelsRemoved TRASH/SPAM restores the message into scope (re-evaluate, not invalidate)', () => {
  const r = parseHistoryPage({ history: [{ id: '1', labelsRemoved: [L('m1', 't1', ['TRASH'])] }] })
  assert.deepStrictEqual(r.restored, [{ id: 'm1', threadId: 't1' }])
  assert.deepStrictEqual(r.removed, [])
})

console.log('\nparseHistoryPage fails closed')
await test('non-object / prototype pollution / malformed record / oversized', () => {
  assert.strictEqual(parseHistoryPage(null).code, 'not_object')
  assert.strictEqual(parseHistoryPage([]).code, 'not_object')
  const poison = { history: [] }
  Object.defineProperty(poison, '__proto__', { value: {}, enumerable: true, configurable: true, writable: true })
  assert.strictEqual(parseHistoryPage(poison).code, 'prototype_pollution')
  assert.strictEqual(parseHistoryPage({ history: [null] }).code, 'malformed_history_record')
  assert.strictEqual(parseHistoryPage({ history: new Array(MAX_HISTORY_RECORDS + 1).fill({ id: '1' }) }).code, 'history_too_large')
})
await test('entries missing ids are skipped, not fatal', () => {
  const r = parseHistoryPage({ history: [{ id: '1', messagesAdded: [{ message: { id: 'm1' } }, M('m2', 't2')] }] })
  assert.ok(r.ok)
  assert.deepStrictEqual(r.added, [{ id: 'm2', threadId: 't2' }])
})
await test('non-numeric historyId is rejected to null (never advances a bad cursor)', () => {
  assert.strictEqual(parseHistoryPage({ historyId: 'abc', history: [] }).historyId, null)
})

console.log('\naggregateHistory')
await test('aggregates across pages, groups by thread, tracks latest historyId', () => {
  const p1 = parseHistoryPage({ historyId: '10', history: [{ id: '1', messagesAdded: [M('a1', 't1')] }] })
  const p2 = parseHistoryPage({ historyId: '20', history: [{ id: '2', messagesDeleted: [M('d1', 't1')], messagesAdded: [M('a2', 't2')] }] })
  const agg = aggregateHistory([p1, p2])
  assert.ok(agg.ok)
  assert.deepStrictEqual(agg.affectedThreads, ['t1', 't2'])
  assert.deepStrictEqual(agg.removedKeysByThread.t1, ['d1'])
  assert.deepStrictEqual(agg.addedKeysByThread.t1, ['a1'])
  assert.strictEqual(agg.latestHistoryId, '20')
})
await test('a failed page aborts the aggregate (cursor must not advance)', () => {
  const agg = aggregateHistory([{ ok: false, code: 'history_too_large' }])
  assert.deepStrictEqual(agg, { ok: false, code: 'history_too_large' })
})
await test('too many affected threads fails closed', () => {
  const pages = [parseHistoryPage({ history: Array.from({ length: MAX_AFFECTED_THREADS + 1 }, (_, i) => ({ id: String(i), messagesAdded: [M('m' + i, 't' + i)] })) })]
  assert.strictEqual(aggregateHistory(pages).code, 'too_many_affected_threads')
})

console.log('\nplausibleBoundaryKeys')
await test('union of remaining + removed keys, deduped, bounded, deterministic', () => {
  assert.deepStrictEqual(plausibleBoundaryKeys(['b', 'a'], ['c', 'a']), ['a', 'b', 'c'])
  assert.deepStrictEqual(plausibleBoundaryKeys(null, null), [])
  assert.ok(plausibleBoundaryKeys(Array.from({ length: 500 }, (_, i) => 'k' + i), []).length <= 200)
})

console.log('\nresolveReconciliationFingerprints')
// deterministic fake fingerprint: 64 hex derived from the naming triple
const fakeFp = async ({ conversationKey, contactId, firstMessageKey }) => {
  const s = `${conversationKey}|${contactId}|${firstMessageKey}`
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0').repeat(8).slice(0, 64)
}
await test('invalidates the episode whose FIRST message was deleted, keeps the surviving one', async () => {
  // thread t1: episode A boundary 'm1' (deleted), episode B boundary 'm5' (survives+qualifies)
  const keep = [await fakeFp({ conversationKey: 't1', contactId: 'c1', firstMessageKey: 'm5' })]
  const r = await resolveReconciliationFingerprints({
    threadId: 't1', contactIds: ['c1'],
    remainingKeys: ['m5', 'm6'], removedKeys: ['m1'],
    keepFingerprints: keep, computeFingerprint: fakeFp,
  })
  assert.ok(r.ok)
  const fpDeleted = await fakeFp({ conversationKey: 't1', contactId: 'c1', firstMessageKey: 'm1' })
  assert.ok(r.invalidate.includes(fpDeleted), 'deleted-boundary episode must be invalidated')
  assert.ok(!r.invalidate.includes(keep[0]), 'surviving qualifying episode must be kept')
})
await test('a still-qualifying thread invalidates nothing', async () => {
  const keepAll = await Promise.all(['m1', 'm2'].map((k) => fakeFp({ conversationKey: 't1', contactId: 'c1', firstMessageKey: k })))
  const r = await resolveReconciliationFingerprints({
    threadId: 't1', contactIds: ['c1'], remainingKeys: ['m1', 'm2'], removedKeys: [],
    keepFingerprints: keepAll, computeFingerprint: fakeFp,
  })
  assert.deepStrictEqual(r.invalidate, [])
})
await test('thread that no longer qualifies at all invalidates every plausible boundary', async () => {
  const r = await resolveReconciliationFingerprints({
    threadId: 't1', contactIds: ['c1'], remainingKeys: ['m2'], removedKeys: ['m1'],
    keepFingerprints: [], computeFingerprint: fakeFp,
  })
  assert.ok(r.ok)
  assert.strictEqual(r.invalidate.length, 2) // m1 + m2 boundaries
})
await test('per-contact isolation: contact B is unaffected by contact A losing eligibility', async () => {
  const keepB = await fakeFp({ conversationKey: 't1', contactId: 'cB', firstMessageKey: 'm1' })
  const r = await resolveReconciliationFingerprints({
    threadId: 't1', contactIds: ['cA', 'cB'], remainingKeys: ['m1'], removedKeys: [],
    keepFingerprints: [keepB], computeFingerprint: fakeFp,
  })
  const fpA = await fakeFp({ conversationKey: 't1', contactId: 'cA', firstMessageKey: 'm1' })
  assert.ok(r.invalidate.includes(fpA))
  assert.ok(!r.invalidate.includes(keepB))
})
await test('invalid args / bad fingerprint / throwing compute fail closed', async () => {
  assert.strictEqual((await resolveReconciliationFingerprints({ threadId: '', contactIds: [], computeFingerprint: fakeFp })).code, 'invalid_thread')
  assert.strictEqual((await resolveReconciliationFingerprints({ threadId: 't', contactIds: null, computeFingerprint: fakeFp })).code, 'invalid_args')
  assert.strictEqual((await resolveReconciliationFingerprints({ threadId: 't', contactIds: ['c'], remainingKeys: ['m'], keepFingerprints: [], computeFingerprint: async () => 'NOTHEX' })).code, 'fingerprint_invalid')
  assert.strictEqual((await resolveReconciliationFingerprints({ threadId: 't', contactIds: ['c'], remainingKeys: ['m'], keepFingerprints: [], computeFingerprint: async () => { throw new Error('x') } })).code, 'fingerprint_failed')
})
await test('output is bounded and deterministic', async () => {
  const a = await resolveReconciliationFingerprints({ threadId: 't', contactIds: ['c1', 'c2'], remainingKeys: ['m2', 'm1'], removedKeys: [], keepFingerprints: [], computeFingerprint: fakeFp })
  const b = await resolveReconciliationFingerprints({ threadId: 't', contactIds: ['c1', 'c2'], remainingKeys: ['m1', 'm2'], removedKeys: [], keepFingerprints: [], computeFingerprint: fakeFp })
  assert.deepStrictEqual(a.invalidate, b.invalidate, 'deterministic regardless of input order')
  assert.ok(a.invalidate.length <= 500)
})

console.log('\nclassifyHistoryStatus: expired cursor -> BOUNDED resync')
await test('404 -> bounded_resync (never an unbounded full-mailbox rescan)', () => {
  assert.deepStrictEqual(classifyHistoryStatus(404), { action: 'bounded_resync', code: 'history_cursor_expired' })
})
await test('other statuses map to controlled actions', () => {
  assert.strictEqual(classifyHistoryStatus(200).action, 'proceed')
  assert.strictEqual(classifyHistoryStatus(401).action, 'reauth')
  assert.strictEqual(classifyHistoryStatus(403).action, 'reauth')
  assert.strictEqual(classifyHistoryStatus(429).action, 'retry')
  assert.strictEqual(classifyHistoryStatus(503).action, 'retry')
  assert.strictEqual(classifyHistoryStatus(400).action, 'fail')
})

console.log('\nprivacy: no content in any parsed output')
await test('parsed output carries only opaque ids + labels — never address/subject/body', () => {
  const r = parseHistoryPage({
    historyId: '9',
    history: [{ id: '1', messagesAdded: [{ message: { id: 'm1', threadId: 't1', snippet: 'SECRET', payload: { body: { data: 'X' } } } }] }],
  })
  const json = JSON.stringify(r)
  assert.ok(!/SECRET/.test(json), 'snippet must not survive')
  assert.ok(!/payload|body|data/.test(json), 'payload must not survive')
  assert.deepStrictEqual(r.added, [{ id: 'm1', threadId: 't1' }])
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
