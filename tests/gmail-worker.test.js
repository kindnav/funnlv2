// Tests for the bounded Gmail sync worker core (pure, DI). Synthetic provider fixtures
// only — no network, no real Gmail data, no PII.
// Run: node tests/gmail-worker.test.js

import assert from 'assert'
import { runGmailSync, fetchBoundedJson, CAPS } from '../supabase/functions/shared/gmailWorker.js'
import { classifyEmailMessages } from '../supabase/functions/shared/emailConversationClassifier.js'

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

// ── synthetic provider plumbing ────────────────────────────────────────────────
function streamOf(text) {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } })
}
function resp(status, bodyObj, headers = {}) {
  const text = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj)
  return { status, body: streamOf(text), headers: { get: (k) => headers[k.toLowerCase()] ?? null } }
}
const HDRS = (from, to, subject = 's') => [
  { name: 'From', value: from }, { name: 'To', value: to },
  { name: 'Subject', value: subject }, { name: 'Message-ID', value: '<x@example.com>' },
]
function gmsg(id, threadId, from, to, tsMs, labels = ['INBOX']) {
  return {
    id, threadId, labelIds: labels, snippet: 'MUST-NOT-SURVIVE',
    internalDate: String(tsMs),
    payload: { mimeType: 'multipart/mixed', headers: HDRS(from, to), body: { size: 10 } },
  }
}

const ME = 'me@example.com', PEER = 'peer@example.com'
const T0 = Date.UTC(2026, 0, 1, 10, 0, 0)
const NOW = Date.UTC(2026, 1, 1)

// A thread that qualifies: inbound from peer + outbound to peer, quiet.
const QUALIFYING = [
  gmsg('m1', 't1', PEER, ME, T0),
  gmsg('m2', 't1', ME, PEER, T0 + 3600_000, ['SENT']),
]

function harness(over = {}) {
  const calls = { upserts: [], invalidations: [], releases: [], capabilities: [], urls: [] }
  const fpCounter = { n: 0 }
  const deps = {
    caps: { ...CAPS, ...(over.caps || {}) },
    now: () => NOW,
    fetchImpl: over.fetchImpl || (async (url) => {
      calls.urls.push(url)
      if (url.includes('/profile')) return resp(200, { emailAddress: ME, messagesTotal: 2, threadsTotal: 1, historyId: '500' })
      if (url.includes('/threads/t1')) return resp(200, { id: 't1', historyId: '500', messages: [{ id: 'm1', threadId: 't1', labelIds: ['INBOX'] }, { id: 'm2', threadId: 't1', labelIds: ['SENT'] }] })
      if (url.includes('/messages?')) return resp(200, { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't1' }] })
      if (url.includes('/messages/m1')) return resp(200, QUALIFYING[0])
      if (url.includes('/messages/m2')) return resp(200, QUALIFYING[1])
      return resp(404, { error: 'nope' })
    }),
    reserve: over.reserve || (async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: null, initial_import_done: false })),
    loadConnection: over.loadConnection || (async () => ({ userId: 'u1', gmailAddress: ME, googleSub: 'sub-1' })),
    loadContacts: over.loadContacts || (async () => ([{ id: 'c1', user_id: 'u1', email: PEER }])),
    resolveAccessToken: over.resolveAccessToken || (async () => ({ ok: true, accessToken: 'AT' })),
    classify: over.classify || classifyEmailMessages,
    computeFingerprintSet: over.computeFingerprintSet || (async (fields) => {
      const key = `${fields.conversationKey || ''}|${fields.contactId || ''}|${fields.firstMessageKey || ''}`
      let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
      const fp = h.toString(16).padStart(8, '0').repeat(8).slice(0, 64)
      fpCounter.n++
      return { writeFingerprint: fp, writeKeyVersion: 1, lookupFingerprints: [{ keyVersion: 1, fingerprint: fp }] }
    }),
    upsertCandidate: over.upsertCandidate || (async (a) => { calls.upserts.push(a); return { result: 'created' } }),
    invalidateFingerprints: over.invalidateFingerprints || (async (a) => { calls.invalidations.push(a); return { result: 'invalidated', invalidated: a.fingerprints.length } }),
    release: over.release || (async (a) => { calls.releases.push(a) }),
    renew: over.renew || (async () => true),
    upsertCapability: over.upsertCapability || (async (a) => { calls.capabilities.push(a); return { result: 'ok' } }),
    log: () => {},
  }
  return { calls, deps, fpCounter }
}

console.log('\nbounded streaming reads (never .json()/.text())')
await test('over-cap response is rejected as response_too_large before buffering', async () => {
  const big = 'x'.repeat(5000)
  const r = await fetchBoundedJson({ fetchImpl: async () => resp(200, JSON.stringify({ p: big })), url: 'u', accessToken: 'AT', maxBytes: 1000 })
  assert.deepStrictEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'response_too_large' })
})
await test('declared Content-Length over cap is rejected up front', async () => {
  const r = await fetchBoundedJson({ fetchImpl: async () => resp(200, { a: 1 }, { 'content-length': '999999' }), url: 'u', accessToken: 'AT', maxBytes: 100 })
  assert.strictEqual(r.code, 'response_too_large')
})
await test('non-200 and invalid JSON map to controlled codes', async () => {
  assert.strictEqual((await fetchBoundedJson({ fetchImpl: async () => resp(500, { e: 1 }), url: 'u', accessToken: 'AT', maxBytes: 1e6 })).code, 'provider_status')
  assert.strictEqual((await fetchBoundedJson({ fetchImpl: async () => resp(200, 'not-json'), url: 'u', accessToken: 'AT', maxBytes: 1e6 })).code, 'invalid_json')
  assert.strictEqual((await fetchBoundedJson({ fetchImpl: async () => { throw new Error('net') }, url: 'u', accessToken: 'AT', maxBytes: 1e6 })).code, 'network_error')
})
await test('the worker module never calls .json() or .text() on a provider response', async () => {
  const raw = (await import('fs')).readFileSync('supabase/functions/shared/gmailWorker.js', 'utf8')
  // Strip comments: the header documents that .json()/.text() are never called, and the
  // assertion is about CODE, not prose.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.ok(!/\.json\(\)/.test(src), 'must not call response.json()')
  assert.ok(!/\.text\(\)/.test(src), 'must not call response.text()')
  assert.ok(/readBoundedStream/.test(raw), 'must use readBoundedStream')
})

console.log('\nreservation: exactly one connection, never a sweep')
await test('no due connection -> none_due, nothing touched', async () => {
  const h = harness({ reserve: async () => ({ result: 'none_due' }) })
  const r = await runGmailSync(h.deps)
  assert.deepStrictEqual(r, { result: 'none_due' })
  assert.strictEqual(h.calls.upserts.length, 0)
  assert.strictEqual(h.calls.releases.length, 0)
})
await test('reserve is called exactly once per invocation (no loop over users)', async () => {
  let n = 0
  const h = harness({ reserve: async () => { n++; return { result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: null, initial_import_done: false } } })
  await runGmailSync(h.deps)
  assert.strictEqual(n, 1)
})
await test('reserve failure is a controlled error', async () => {
  const h = harness({ reserve: async () => { throw new Error('db') } })
  assert.deepStrictEqual(await runGmailSync(h.deps), { result: 'error', code: 'reserve_failed' })
})

console.log('\ninitial bounded sync + cursor semantics')
await test('complete initial run creates a candidate and advances the cursor', async () => {
  const h = harness()
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'complete', JSON.stringify(r))
  assert.strictEqual(h.calls.upserts.length, 1)
  assert.strictEqual(h.calls.upserts[0].source, 'gmail')
  const rel = h.calls.releases[0]
  assert.strictEqual(rel.runComplete, true)
  assert.strictEqual(rel.initialDone, true, 'initial import marked done on a complete run')
})
await test('the initial list request is date-bounded to the 90-day window', async () => {
  const h = harness()
  await runGmailSync(h.deps)
  const listUrl = h.calls.urls.find((u) => u.includes('/messages?'))
  const q = decodeURIComponent(new URL(listUrl).searchParams.get('q'))
  const after = Number(q.match(/after:(\d+)/)[1])
  assert.strictEqual(after, Math.floor((NOW - 90 * 86400000) / 1000))
  assert.ok(q.includes('-in:chats'))
})
await test('messages.get requests format=metadata with only allowlisted headers', async () => {
  const h = harness()
  await runGmailSync(h.deps)
  const getUrl = h.calls.urls.find((u) => u.includes('/messages/m1'))
  const sp = new URL(getUrl).searchParams
  assert.strictEqual(sp.get('format'), 'metadata')
  const mh = sp.getAll('metadataHeaders').map((x) => x.toLowerCase())
  assert.ok(mh.includes('from') && mh.includes('list-id') && mh.includes('subject'))
  assert.ok(!mh.includes('received') && !mh.includes('dkim-signature'))
})

console.log('\nevery cap marks the run incomplete and HOLDS the cursor')
for (const [label, caps] of [
  ['maxPagesPerRun', { maxPagesPerRun: 0 }],
  ['maxMessagesPerRun', { maxMessagesPerRun: 1 }],
  ['maxConversationsPerRun', { maxConversationsPerRun: 0 }],
  ['maxBytesPerRun', { maxBytesPerRun: 1 }],
  ['runtimeBudgetMs', { runtimeBudgetMs: -1 }],
]) {
  await test(`cap ${label} -> incomplete, cursor NOT advanced`, async () => {
    const h = harness({ caps })
    const r = await runGmailSync(h.deps)
    assert.strictEqual(r.result, 'incomplete', `${label}: ${JSON.stringify(r)}`)
    const rel = h.calls.releases[0]
    assert.strictEqual(rel.runComplete, false)
    assert.strictEqual(rel.historyId, null, 'cursor must be held')
    assert.strictEqual(rel.initialDone, false)
  })
}
await test('oversized single message -> thread incomplete, no eligible candidate', async () => {
  const h = harness({ caps: { maxBytesPerMessage: 50 } })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'incomplete')
  assert.strictEqual(h.calls.upserts.length, 0, 'an unreadable thread can never emit eligible')
  assert.strictEqual(h.calls.releases[0].historyId, null)
})
await test('a failing messages.get withholds its thread (no candidate) and holds the cursor', async () => {
  const h = harness({
    fetchImpl: async (url) => {
      if (url.includes('/messages?')) return resp(200, { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't1' }] })
      if (url.includes('/messages/m1')) return resp(200, QUALIFYING[0])
      return resp(500, { e: 1 })                       // m2 fails
    },
  })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'incomplete')
  assert.strictEqual(h.calls.upserts.length, 0)
  assert.strictEqual(h.calls.releases[0].runComplete, false)
})

console.log('\nincremental history')
const histAdded = { historyId: '900', history: [{ id: '1', messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }, { message: { id: 'm2', threadId: 't1' } }] }] }
await test('incremental run advances to the latest historyId on success', async () => {
  const h = harness({
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    fetchImpl: async (url) => {
      if (url.includes('/history?')) return resp(200, histAdded)
      if (url.includes('/messages/m1')) return resp(200, QUALIFYING[0])
      if (url.includes('/messages/m2')) return resp(200, QUALIFYING[1])
      return resp(404, {})
    },
  })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'complete', JSON.stringify(r))
  assert.strictEqual(h.calls.releases[0].historyId, '900')
})
await test('expired cursor (404) falls back to the BOUNDED window, not a full rescan', async () => {
  const urls = []
  const h = harness({
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    fetchImpl: async (url) => {
      urls.push(url)
      if (url.includes('/history?')) return resp(404, { error: 'expired' })
      if (url.includes('/profile')) return resp(200, { emailAddress: ME, historyId: '777' })
      if (url.includes('/messages?')) return resp(200, { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't1' }] })
      if (url.includes('/messages/m1')) return resp(200, QUALIFYING[0])
      if (url.includes('/messages/m2')) return resp(200, QUALIFYING[1])
      return resp(404, {})
    },
  })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'complete', JSON.stringify(r))
  const listUrl = urls.find((u) => u.includes('/messages?'))
  assert.ok(listUrl, 'must fall back to the bounded list endpoint')
  const q = decodeURIComponent(new URL(listUrl).searchParams.get('q'))
  assert.ok(/after:\d+/.test(q), 'fallback is date-bounded (never unbounded)')
  // the resync re-establishes a TRUTHFUL boundary from the profile, never the dead cursor
  assert.strictEqual(h.calls.releases[0].historyId, '777')
  assert.strictEqual(h.calls.releases[0].initialDone, true)
})
await test('malformed history page holds the cursor', async () => {
  const h = harness({
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    fetchImpl: async (url) => url.includes('/history?') ? resp(200, { history: [null] }) : resp(404, {}),
  })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'incomplete')
  assert.strictEqual(h.calls.releases[0].historyId, null)
})

console.log('\ndeletion / label-removal reconciliation')
const histDeleted = {
  historyId: '950',
  history: [{ id: '1', messagesDeleted: [{ message: { id: 'm1', threadId: 't1' } }] }],
}
await test('messageDeleted triggers fingerprint invalidation for the affected thread', async () => {
  const h = harness({
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    fetchImpl: async (url) => {
      if (url.includes('/history?')) return resp(200, histDeleted)
      return resp(404, {})
    },
    // the thread no longer classifies (no messages fetched) -> nothing kept
    classify: () => ({ results: [{ outcome: 'one_way', conversationKey: 't1', contactId: 'c1' }], counts: {}, complete: true }),
  })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(h.calls.invalidations.length, 1, JSON.stringify(r))
  assert.strictEqual(h.calls.invalidations[0].connectionId, 'conn-1')
  assert.ok(h.calls.invalidations[0].fingerprints.length > 0)
  assert.ok(h.calls.invalidations[0].fingerprints.every((f) => /^[0-9a-f]{64}$/.test(f)))
})
await test('scope-exit label (TRASH) reconciles like a deletion', async () => {
  const h = harness({
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    fetchImpl: async (url) => url.includes('/history?')
      ? resp(200, { historyId: '960', history: [{ id: '1', labelsAdded: [{ message: { id: 'm1', threadId: 't1' }, labelIds: ['TRASH'] }] }] })
      : resp(404, {}),
    classify: () => ({ results: [{ outcome: 'one_way', conversationKey: 't1', contactId: 'c1' }], counts: {}, complete: true }),
  })
  await runGmailSync(h.deps)
  assert.strictEqual(h.calls.invalidations.length, 1)
})
await test('archiving (INBOX removed) triggers NO invalidation', async () => {
  const h = harness({
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    fetchImpl: async (url) => url.includes('/history?')
      ? resp(200, { historyId: '970', history: [{ id: '1', labelsRemoved: [{ message: { id: 'm1', threadId: 't1' }, labelIds: ['INBOX'] }] }] })
      : resp(404, {}),
  })
  await runGmailSync(h.deps)
  assert.strictEqual(h.calls.invalidations.length, 0, 'an archived thread must keep its suggestion')
})

console.log('\ncandidate behavior + privacy')
await test('eligible candidate carries a sanitized subject and NO provider identifiers', async () => {
  const h = harness()
  await runGmailSync(h.deps)
  const u = h.calls.upserts[0]
  assert.ok(/^[0-9a-f]{64}$/.test(u.fingerprint), 'HMAC fingerprint only')
  assert.ok(!('threadId' in u) && !('messageId' in u) && !('gmailId' in u))
  const json = JSON.stringify(u)
  assert.ok(!/MUST-NOT-SURVIVE/.test(json), 'snippet must never reach the candidate')
  assert.ok(!/payload|snippet|body/.test(json))
  assert.ok(u.retainedSubject === null || u.retainedSubject.length <= 160)
})
await test('prior-key lookups are passed and bounded', async () => {
  const h = harness({ caps: { maxPriorKeys: 2 } })
  await runGmailSync(h.deps)
  assert.ok(Array.isArray(h.calls.upserts[0].lookupFingerprints))
  assert.ok(h.calls.upserts[0].lookupFingerprints.length <= 2)
})
await test('idempotent: refreshed/exists_terminal are not failures', async () => {
  for (const code of ['refreshed', 'exists_terminal']) {
    const h = harness({ upsertCandidate: async () => ({ result: code }) })
    const r = await runGmailSync(h.deps)
    assert.strictEqual(r.result, 'complete', `${code} must not fail the run`)
  }
})
await test('worker NEVER creates an interaction (only candidate upserts)', async () => {
  const h = harness()
  await runGmailSync(h.deps)
  const names = Object.keys(h.deps).join(',')
  assert.ok(!/interaction|accept/i.test(names), 'no interaction-creating dependency exists')
  assert.ok(h.calls.upserts.every((u) => u.source === 'gmail'))
})
await test('a partial run emits NO eligible candidate and holds the cursor', async () => {
  const h = harness({ caps: { maxMessagesPerRun: 1 } })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'incomplete')
  assert.strictEqual(h.calls.upserts.length, 0)
  assert.strictEqual(h.calls.releases[0].historyId, null)
})

console.log('\nE2B review regressions: truthful boundary, full-thread context, real reconciliation')
// Same deterministic fake HMAC the harness uses, so expected fingerprints can be named.
function fakeFp(conv, contact, first) {
  const key = `${conv}|${contact}|${first}`
  let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0').repeat(8).slice(0, 64)
}
const CAND_FP = fakeFp('t1', 'c1', 'm1')   // the qualifying episode's candidate fingerprint

await test('REGRESSION: a complete initial import records the profile historyId as the boundary', async () => {
  // Without this every later run would re-import the window forever and never reach History.
  const h = harness()
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'complete')
  assert.strictEqual(h.calls.releases[0].historyId, '500', 'boundary comes from users.getProfile')
  assert.strictEqual(h.calls.releases[0].initialDone, true)
  const profileIdx = h.calls.urls.findIndex((u) => u.includes('/profile'))
  const listIdx = h.calls.urls.findIndex((u) => u.includes('/messages?'))
  assert.ok(profileIdx >= 0 && profileIdx < listIdx, 'profile is captured BEFORE the list (lower bound)')
})
await test('profile failure or malformed historyId holds the cursor and marks the run incomplete', async () => {
  for (const body of [resp(500, {}), resp(200, { historyId: 'abc' }), resp(200, {}), resp(200, { historyId: '9'.repeat(300) })]) {
    const h = harness({ fetchImpl: async (url) => url.includes('/profile') ? body : resp(404, {}) })
    const r = await runGmailSync(h.deps)
    assert.strictEqual(r.result, 'incomplete')
    assert.strictEqual(h.calls.releases[0].historyId, null)
    assert.strictEqual(h.calls.releases[0].initialDone, false)
    assert.strictEqual(h.calls.upserts.length, 0)
  }
})
await test('REGRESSION: the history request asks for ALL four history types', async () => {
  const urls = []
  const h = harness({
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    fetchImpl: async (url) => { urls.push(url); return resp(200, { historyId: '101', history: [] }) },
  })
  await runGmailSync(h.deps)
  const u = new URL(urls.find((x) => x.includes('/history?')))
  assert.deepStrictEqual(u.searchParams.getAll('historyTypes').sort(),
    ['labelAdded', 'labelRemoved', 'messageAdded', 'messageDeleted'])
})
await test('REGRESSION: deleting the episode boundary message invalidates the candidate (real classifier, no messageAdded)', async () => {
  // Yesterday's run created the candidate for (t1, c1, m1). Today's history carries ONLY a
  // messageDeleted for m1; the thread still holds the outbound m2, which cannot qualify alone.
  const h = harness({
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    fetchImpl: async (url) => {
      if (url.includes('/history?')) return resp(200, { historyId: '950', history: [{ id: '1', messagesDeleted: [{ message: { id: 'm1', threadId: 't1' } }] }] })
      if (url.includes('/threads/t1')) return resp(200, { id: 't1', messages: [{ id: 'm2', threadId: 't1', labelIds: ['SENT'] }] })
      if (url.includes('/messages/m2')) return resp(200, QUALIFYING[1])
      return resp(404, {})
    },
  })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'complete', JSON.stringify(r))
  assert.strictEqual(h.calls.upserts.length, 0, 'an outbound-only thread creates nothing')
  const all = h.calls.invalidations.flatMap((i) => i.fingerprints)
  assert.ok(all.includes(CAND_FP), 'the candidate keyed on the deleted boundary is invalidated')
  assert.strictEqual(h.calls.releases[0].historyId, '950', 'cursor advances after a complete reconciliation')
})
await test('REGRESSION: a fully deleted thread (404) reconciles via the contact fallback', async () => {
  const h = harness({
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    loadContacts: async () => ([{ id: 'c1', user_id: 'u1', email: PEER }, { id: 'c2', user_id: 'u1', email: 'other@example.com' }]),
    fetchImpl: async (url) => {
      if (url.includes('/history?')) return resp(200, { historyId: '960', history: [{ id: '1', messagesDeleted: [{ message: { id: 'm1', threadId: 't1' } }, { message: { id: 'm2', threadId: 't1' } }] }] })
      return resp(404, {})   // threads.get 404: the thread is gone
    },
  })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'complete', JSON.stringify(r))
  const all = h.calls.invalidations.flatMap((i) => i.fingerprints)
  assert.ok(all.includes(CAND_FP))
  // every (contact x boundary) is enumerated because the contact is unknowable
  assert.ok(all.includes(fakeFp('t1', 'c2', 'm1')) && all.includes(fakeFp('t1', 'c2', 'm2')))
  assert.strictEqual(new Set(all).size, 4)
})
await test('deleting a NON-boundary message keeps a still-qualifying episode', async () => {
  // m3 (a later reply) is deleted; m1+m2 remain and still qualify -> candidate is KEPT.
  const h = harness({
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    fetchImpl: async (url) => {
      if (url.includes('/history?')) return resp(200, { historyId: '970', history: [{ id: '1', messagesDeleted: [{ message: { id: 'm3', threadId: 't1' } }] }] })
      if (url.includes('/threads/t1')) return resp(200, { id: 't1', messages: [{ id: 'm1', threadId: 't1', labelIds: ['INBOX'] }, { id: 'm2', threadId: 't1', labelIds: ['SENT'] }] })
      if (url.includes('/messages/m1')) return resp(200, QUALIFYING[0])
      if (url.includes('/messages/m2')) return resp(200, QUALIFYING[1])
      return resp(404, {})
    },
  })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'complete', JSON.stringify(r))
  assert.strictEqual(h.calls.upserts.length, 1, 'the episode is re-upserted (idempotent refresh)')
  const all = h.calls.invalidations.flatMap((i) => i.fingerprints)
  assert.ok(!all.includes(CAND_FP), 'the surviving episode must NOT be invalidated')
  assert.ok(all.includes(fakeFp('t1', 'c1', 'm3')) && all.includes(fakeFp('t1', 'c1', 'm2')), 'only non-kept plausible boundaries')
})
await test('REGRESSION: a reply added today is classified with the thread it belongs to', async () => {
  // Yesterday only m1 (inbound) existed -> nothing qualified. Today history adds m2 (the
  // reply). The run must re-read the WHOLE thread, otherwise m2 alone never qualifies.
  const h = harness({
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    fetchImpl: async (url) => {
      if (url.includes('/history?')) return resp(200, { historyId: '980', history: [{ id: '1', messagesAdded: [{ message: { id: 'm2', threadId: 't1' } }] }] })
      if (url.includes('/threads/t1')) return resp(200, { id: 't1', messages: [{ id: 'm1', threadId: 't1', labelIds: ['INBOX'] }, { id: 'm2', threadId: 't1', labelIds: ['SENT'] }] })
      if (url.includes('/messages/m1')) return resp(200, QUALIFYING[0])
      if (url.includes('/messages/m2')) return resp(200, QUALIFYING[1])
      return resp(404, {})
    },
  })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'complete', JSON.stringify(r))
  assert.strictEqual(h.calls.upserts.length, 1)
  assert.strictEqual(h.calls.upserts[0].fingerprint, CAND_FP)
})
await test('messages already in TRASH/SPAM are not "remaining"; thread fetch honors run caps', async () => {
  const h = harness({
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    fetchImpl: async (url) => {
      if (url.includes('/history?')) return resp(200, { historyId: '990', history: [{ id: '1', labelsAdded: [{ message: { id: 'm1', threadId: 't1' }, labelIds: ['TRASH'] }] }] })
      if (url.includes('/threads/t1')) return resp(200, { id: 't1', messages: [{ id: 'm1', threadId: 't1', labelIds: ['TRASH'] }, { id: 'm2', threadId: 't1', labelIds: ['SENT'] }] })
      if (url.includes('/messages/m2')) return resp(200, QUALIFYING[1])
      return resp(404, {})
    },
  })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'complete', JSON.stringify(r))
  assert.ok(!h.calls.urls.some((u) => u.includes('/messages/m1')), 'a trashed message is never fetched')
  assert.ok(h.calls.invalidations.flatMap((i) => i.fingerprints).includes(CAND_FP))
})
await test('a thread listing that cannot be read holds the cursor (never reconciles blind)', async () => {
  const h = harness({
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    fetchImpl: async (url) => {
      if (url.includes('/history?')) return resp(200, { historyId: '991', history: [{ id: '1', messagesDeleted: [{ message: { id: 'm1', threadId: 't1' } }] }] })
      if (url.includes('/threads/t1')) return resp(503, {})
      return resp(404, {})
    },
  })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'incomplete')
  assert.strictEqual(r.code, 'thread_fetch_failed')
  assert.strictEqual(h.calls.releases[0].historyId, null)
  assert.strictEqual(h.calls.invalidations.length, 0, 'no reconciliation on an unreadable thread')
})
await test('a thread whose remaining message could not be fetched is NOT reconciled', async () => {
  // The listing succeeded but m2 (a remaining message) 503s: the keep set is unknowable, so
  // reconciling would wrongly invalidate a possibly-valid episode. Cursor held instead.
  const h = harness({
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    fetchImpl: async (url) => {
      if (url.includes('/history?')) return resp(200, { historyId: '992', history: [{ id: '1', messagesDeleted: [{ message: { id: 'm3', threadId: 't1' } }] }] })
      if (url.includes('/threads/t1')) return resp(200, { id: 't1', messages: [{ id: 'm1', threadId: 't1', labelIds: ['INBOX'] }, { id: 'm2', threadId: 't1', labelIds: ['SENT'] }] })
      if (url.includes('/messages/m1')) return resp(200, QUALIFYING[0])
      if (url.includes('/messages/m2')) return resp(503, {})
      return resp(404, {})
    },
  })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'incomplete')
  assert.strictEqual(h.calls.invalidations.length, 0)
  assert.strictEqual(h.calls.upserts.length, 0, 'a withheld thread emits nothing')
  assert.strictEqual(h.calls.releases[0].historyId, null)
})
await test('duplicate and reordered history records are idempotent (one fetch, one upsert)', async () => {
  const h = harness({
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    fetchImpl: async (url) => {
      h.calls.urls.push(url)
      if (url.includes('/history?')) return resp(200, { historyId: '995', history: [
        { id: '3', messagesAdded: [{ message: { id: 'm2', threadId: 't1' } }] },
        { id: '1', messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] },
        { id: '2', messagesAdded: [{ message: { id: 'm2', threadId: 't1' } }, { message: { id: 'm1', threadId: 't1' } }] },
      ] })
      if (url.includes('/threads/t1')) return resp(200, { id: 't1', messages: [{ id: 'm1', threadId: 't1', labelIds: ['INBOX'] }, { id: 'm2', threadId: 't1', labelIds: ['SENT'] }] })
      if (url.includes('/messages/m1')) return resp(200, QUALIFYING[0])
      if (url.includes('/messages/m2')) return resp(200, QUALIFYING[1])
      return resp(404, {})
    },
  })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'complete', JSON.stringify(r))
  assert.strictEqual(h.calls.urls.filter((u) => u.includes('/threads/t1')).length, 1)
  assert.strictEqual(h.calls.urls.filter((u) => u.includes('/messages/m1')).length, 1)
  assert.strictEqual(h.calls.upserts.length, 1)
})
await test('reconciliation is chunked at the RPC bound (never truncated, never one oversized call)', async () => {
  const contacts = Array.from({ length: 600 }, (_, i) => ({ id: `c${i}`, user_id: 'u1', email: `p${i}@example.com` }))
  const h = harness({
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    loadContacts: async () => contacts,
    fetchImpl: async (url) => {
      if (url.includes('/history?')) return resp(200, { historyId: '996', history: [{ id: '1', messagesDeleted: [{ message: { id: 'm1', threadId: 't1' } }] }] })
      return resp(404, {})
    },
  })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'complete', JSON.stringify(r))
  assert.strictEqual(h.calls.invalidations.length, 2)
  assert.ok(h.calls.invalidations.every((i) => i.fingerprints.length <= 500))
  assert.strictEqual(h.calls.invalidations.reduce((n, i) => n + i.fingerprints.length, 0), 600)
})
await test('beyond the per-thread reconciliation cap the run is incomplete, not a guess', async () => {
  const contacts = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, user_id: 'u1', email: `p${i}@example.com` }))
  const h = harness({
    caps: { maxReconcileFingerprintsPerThread: 20 },
    reserve: async () => ({ result: 'reserved', connection_id: 'conn-1', run_id: 'run-1', history_id: '100', initial_import_done: true }),
    loadContacts: async () => contacts,
    fetchImpl: async (url) => {
      if (url.includes('/history?')) return resp(200, { historyId: '997', history: [{ id: '1', messagesDeleted: [{ message: { id: 'm1', threadId: 't1' } }] }] })
      return resp(404, {})
    },
  })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'incomplete')
  assert.strictEqual(r.code, 'too_many_fingerprints')
  assert.strictEqual(h.calls.invalidations.length, 0)
  assert.strictEqual(h.calls.releases[0].historyId, null)
})
await test('a hung provider request is aborted by the per-request deadline (run stays bounded)', async () => {
  let sawSignal = false
  const h = harness({
    caps: { requestTimeoutMs: 25 },
    fetchImpl: (url, init) => new Promise((_, reject) => {
      if (!init?.signal) return reject(new Error('no signal'))
      sawSignal = true
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }),
  })
  const t0 = Date.now()
  const r = await runGmailSync(h.deps)
  assert.ok(sawSignal, 'every provider request carries an AbortSignal')
  assert.ok(Date.now() - t0 < 2000, 'must not hang')
  assert.strictEqual(r.result, 'incomplete')
  assert.strictEqual(h.calls.releases[0].historyId, null)
})
await test('the per-request deadline is clipped to the remaining run budget', async () => {
  let clock = NOW
  const h = harness({
    caps: { requestTimeoutMs: 15000, runtimeBudgetMs: 100 },
    now: () => clock,
    fetchImpl: (url, init) => new Promise((_, reject) => {
      clock += 99                                   // nearly the whole budget already spent
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }),
  })
  const t0 = Date.now()
  const r = await runGmailSync(h.deps)
  assert.ok(Date.now() - t0 < 2000, 'deadline must be min(requestTimeout, remaining budget)')
  assert.strictEqual(r.result, 'incomplete')
})

console.log('\ncapability transitions from the worker')
await test('scope revoked -> Gmail needs_reauth only (Calendar untouched)', async () => {
  const h = harness({ resolveAccessToken: async () => ({ ok: false, reason: 'scope_revoked' }) })
  const r = await runGmailSync(h.deps)
  assert.strictEqual(r.result, 'incomplete')
  assert.strictEqual(h.calls.capabilities.length, 1)
  assert.strictEqual(h.calls.capabilities[0].product, 'gmail')
  assert.strictEqual(h.calls.capabilities[0].status, 'needs_reauth')
  assert.ok(!h.calls.capabilities.some((c) => c.product === 'calendar'), 'Calendar never written')
})
await test('invalid_grant is reported as the connection-wide code', async () => {
  const h = harness({ resolveAccessToken: async () => ({ ok: false, reason: 'invalid_grant' }) })
  await runGmailSync(h.deps)
  assert.strictEqual(h.calls.capabilities[0].resultCode, 'invalid_grant')
})
await test('a TRANSIENT token failure never flips a capability to needs_reauth', async () => {
  // A provider blip (5xx, timeout, malformed body, unknown reason) must not force the user
  // to reconnect: the Gmail capability stays active and the run simply retries later.
  for (const reason of ['provider_error', undefined, 'something_new']) {
    const h = harness({ resolveAccessToken: async () => ({ ok: false, reason }) })
    const r = await runGmailSync(h.deps)
    assert.strictEqual(r.result, 'incomplete')
    assert.strictEqual(h.calls.capabilities.length, 1)
    assert.strictEqual(h.calls.capabilities[0].status, 'active', `reason=${reason}`)
    assert.strictEqual(h.calls.capabilities[0].needsReauth, false, `reason=${reason}`)
    assert.strictEqual(h.calls.capabilities[0].granted, true, `reason=${reason}`)
    assert.strictEqual(h.calls.capabilities[0].resultCode, 'provider_error')
    assert.strictEqual(h.calls.releases[0].historyId, null, 'cursor never advances')
  }
})
await test('a null/absent token result is treated as transient, not as a revocation', async () => {
  const h = harness({ resolveAccessToken: async () => null })
  await runGmailSync(h.deps)
  assert.strictEqual(h.calls.capabilities[0].status, 'active')
  assert.strictEqual(h.calls.capabilities[0].resultCode, 'provider_error')
})

console.log('\nresult shape is privacy-safe')
await test('result carries only codes + aggregate counts', async () => {
  const h = harness()
  const r = await runGmailSync(h.deps)
  const json = JSON.stringify(r)
  assert.ok(!/example\.com|AT|sub-1|MUST-NOT-SURVIVE/.test(json), `leaked: ${json}`)
  assert.ok(typeof r.counts.messagesFetched === 'number')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
