// Outlook DURABLE CONTINUATION — the four cases this slice exists to make safe.
//
// WHAT IS ACTUALLY DEMONSTRATED HERE, against controlled fixtures and a virtual clock:
//   1. an import that needs MORE THAN ONE INVOCATION and more than the 20-page
//      per-invocation ceiling;
//   2. a relevant two-sided exchange whose halves land in DIFFERENT INVOCATIONS;
//   3. a CRASH after a checkpoint, and a retry that neither re-applies nor skips a page;
//   4. a SAVED continuation token that Microsoft rejects.
//
// And in every one of them: no premature candidate, no skipped mail, exactly one pending
// suggestion once the round completes, and no contact or interaction written at all.
//
// WHY A VIRTUAL CLOCK. The invocation budget exists because hosted Edge Functions have a
// 150s request idle timeout and a 150s wall clock on the free plan. Local Deno enforces
// neither, so waiting for a real timeout would prove nothing - the deadline is driven by
// an injected clock and asserted directly. The REAL database path is covered separately by
// tests/sql/outlook-durable-continuation-runtime.sql and by
// tests/local/outlook-worker-token-access.mjs against real PostgREST.

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  runOutlookImport, summarizeRun, RUN_OUTCOMES, CONTINUE_BACKOFF_SECONDS,
  ROUND_INCOMPLETE_REASONS,
} from '../supabase/functions/shared/outlookImportRun.js'
import {
  INVOCATION_BUDGET_MS, HOSTED_WALL_MS, INVOCATION_SAFETY_MS, PAGE_ADMIT_FLOOR_MS,
  CHECKPOINT_RESERVE_MS, budgetAllowsPage, FOLDER_STOP_CODES, CONTINUABLE_STOPS,
} from '../supabase/functions/shared/outlookContinuedPass.js'
import {
  foldPage, finalizeRound, ROUND_TTL_SECONDS, MAX_PAGES_PER_ROUND,
  MAX_MESSAGES_PER_ROUND, MAX_CONVERSATIONS_PER_ROUND, ROUND_TAINT_CODES,
  ROUND_SKIP_CODES, canonicalIso, summarizeRoundProgress,
} from '../supabase/functions/shared/outlookRoundState.js'
import {
  MAX_PAGES_PER_RUN, GRAPH_BASE,
} from '../supabase/functions/shared/outlookGraphTransport.js'
import {
  buildSelfIdentitySet, indexContactsByEmail, qualifyEpisode,
  computeEpisodeFingerprints,
} from '../supabase/functions/shared/outlookParticipants.js'
import { localDateFor } from '../supabase/functions/shared/outlookMetadataPass.js'
import { normalizeGraphPage } from '../supabase/functions/shared/outlookMessageNormalize.js'
import { makeRoundStore } from './harness/outlookRoundStore.js'

let passed = 0, failed = 0
const pending = []
function test (name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { passed += 1; console.log(`  ✓ ${name}`) },
        (e) => { failed += 1; console.log(`  ✗ ${name}`); console.log(`    ${e.message}`) },
      ))
      return
    }
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
  }
}

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const MIGRATION = read('supabase/migrations/20261002000000_outlook_durable_continuation.sql')
const DESIGN = read('docs/outlook-durable-continuation-design.md')
const POLICY = read('src/pages/PrivacyPage.jsx')
const ROUND_SRC = read('supabase/functions/shared/outlookRoundState.js')
const PASS_SRC = read('supabase/functions/shared/outlookContinuedPass.js')

const CONN = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const RUN = 'rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr'
const U1 = '11111111-1111-1111-1111-111111111111'
const CONTACT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const ME = 'student@getfunnl.test'
const OTHER = 'ava@bank.test'
const KEY_RING = { current: { keyBytes: new Uint8Array(32).fill(7), keyVersion: 1 } }

const addr = (e) => ({ emailAddress: { address: e, name: e.split('@')[0] } })
const msg = (id, conv, from, to, sent) => ({
  id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
  subject: 'Following up', from: addr(from), sender: addr(from),
  toRecipients: to.map(addr), ccRecipients: [],
})

/**
 * A mailbox with many pages per folder, exactly one qualifying message in each folder, and
 * those two placed so they fall in DIFFERENT invocations.
 *
 * Filler messages are from the user to the user, which every rule excludes as `self_only`,
 * so they create no conversation record - but they are still counted as READ, which is what
 * makes the no-skipped-mail assertion meaningful.
 */
function bigMailbox ({ inboxPages, sentPages, inboundAt, outboundAt, conv = 'conv-split' }) {
  const served = []          // one entry per page actually served, in order
  const linkFor = (folder, n) =>
    `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$skiptoken=p${n}`
  const deltaFor = (folder) =>
    `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=END-${folder}`

  const pageOf = (folder, n) => {
    const total = folder === 'inbox' ? inboxPages : sentPages
    const isQualifying = folder === 'inbox' ? n === inboundAt : n === outboundAt
    const items = [isQualifying
      ? (folder === 'inbox'
          ? msg(`in-${n}`, conv, OTHER, [ME], '2026-09-20T14:00:00Z')
          : msg(`out-${n}`, conv, ME, [OTHER], '2026-09-21T09:00:00Z'))
      : msg(`${folder}-filler-${n}`, `filler-${folder}-${n}`, ME, [ME], '2026-09-19T08:00:00Z')]
    return n >= total
      ? { value: items, '@odata.deltaLink': deltaFor(folder) }
      : { value: items, '@odata.nextLink': linkFor(folder, n + 1) }
  }

  const fetchImpl = async (url) => {
    const folder = url.includes('/mailFolders/inbox/') ? 'inbox' : 'sentitems'
    const m = /\$skiptoken=p(\d+)/.exec(url)
    const n = m ? Number(m[1]) : 1
    served.push({ folder, page: n, url })
    return { status: 200, headers: { get: () => null }, json: async () => pageOf(folder, n) }
  }
  return { fetchImpl, served, deltaFor }
}

/** Everything the run needs, with no real database and no Microsoft. */
function context () {
  return async () => ({
    primaryEmail: ME, userId: U1, timeZone: 'UTC',
    contacts: [{ id: CONTACT, user_id: U1, email: OTHER }],
    cursors: {}, accessToken: 'tok', keyRing: KEY_RING,
  })
}

const ENCRYPT = async (link) => ({ ciphertext: `CT:${link}`, nonce: 'N', keyVersion: 1 })
const DECRYPT = async (ct) => String(ct).replace(/^CT:/, '')

/**
 * One connection, many invocations. The store and the call log persist across them, which
 * is the whole point: invocation N+1 must find what invocation N wrote.
 */
function harness ({ now } = {}) {
  const store = makeRoundStore()
  const calls = []
  let leaseLive = true

  const rpc = async (name, args) => {
    calls.push({ name, args })
    if (name === 'reserve_due_outlook_connection') {
      return { data: { result: 'reserved', connection_id: CONN, run_id: RUN }, error: null }
    }
    if (name === 'renew_outlook_sync_lease') return { data: leaseLive, error: null }
    if (name === 'upsert_outlook_interaction_candidate') {
      return { data: { result: 'created' }, error: null }
    }
    if (name === 'release_outlook_sync_lease') {
      if (args?.p_run_complete === true) store.commitRelease()
      return { data: true, error: null }
    }
    const fromStore = await store.handle(name, args)
    if (fromStore !== null) return fromStore
    return { data: null, error: null }
  }

  const invoke = ({ fetchImpl, requestEntryMs }) => runOutlookImport({
    rpc,
    encryptCursor: ENCRYPT,
    decryptCursor: DECRYPT,
    loadRunContext: context(),
    requestEntryMs,
    deps: { fetchImpl, now },
  })

  return {
    store,
    calls,
    invoke,
    writes: () => calls.filter((c) => c.name === 'upsert_outlook_interaction_candidate'),
    checkpoints: () => calls.filter((c) => c.name === 'record_outlook_page_progress'),
    releases: () => calls.filter((c) => c.name === 'release_outlook_sync_lease'),
    setLease: (v) => { leaseLive = v },
  }
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n1. an import that needs several invocations and more than 20 pages')
// ══════════════════════════════════════════════════════════════════════════════

test('50 pages, 3+ invocations, ONE suggestion, and nothing committed until the end', async () => {
  // The qualifying inbound is on inbox page 22 and the qualifying outbound on sent page 18,
  // so with a 20-page-per-invocation ceiling the two halves CANNOT be seen in the same
  // invocation. Recognising them as one two-sided exchange is only possible because the
  // recognition state was written down.
  const h = harness()
  const mb = bigMailbox({ inboxPages: 25, sentPages: 25, inboundAt: 22, outboundAt: 18 })

  const outcomes = []
  for (let i = 0; i < 10; i += 1) {
    const r = await h.invoke({ fetchImpl: mb.fetchImpl })
    outcomes.push(r)
    if (r.outcome !== 'continued') break
    // A continued invocation must have committed NOTHING.
    assert.strictEqual(r.cursorsAdvanced, 0, `invocation ${i + 1} advanced a cursor`)
    assert.strictEqual(r.accepted, 0, `invocation ${i + 1} wrote a suggestion`)
    assert.strictEqual(h.writes().length, 0, 'no write may happen before the round completes')
  }

  assert.ok(outcomes.length >= 3,
    `the mailbox must need at least three invocations (took ${outcomes.length})`)
  for (const r of outcomes.slice(0, -1)) {
    assert.strictEqual(r.outcome, 'continued', JSON.stringify(summarizeRun(r)))
  }

  const last = outcomes.at(-1)
  assert.strictEqual(last.outcome, 'committed', JSON.stringify(summarizeRun(last)))
  assert.strictEqual(last.intended, 1)
  assert.strictEqual(last.accepted, 1)
  assert.strictEqual(last.created, 1)
  assert.strictEqual(last.cursorsAdvanced, 2, 'both folder cursors advance, together')

  // MORE THAN THE OLD CEILING, which is the point.
  assert.strictEqual(mb.served.length, 50, `every page must be read once (${mb.served.length})`)
  assert.ok(mb.served.length > MAX_PAGES_PER_RUN * 2,
    `the round must exceed the per-invocation ceiling (${MAX_PAGES_PER_RUN})`)

  // EXACTLY ONE pending suggestion, and it is for the contact the user already has.
  assert.strictEqual(h.writes().length, 1, 'exactly one suggestion, for the whole round')
  assert.strictEqual(h.writes()[0].args.p_contact_id, CONTACT)

  // NO SKIPPED MAIL: every page served was checkpointed, once.
  assert.strictEqual(h.checkpoints().length, 50)
  const seqByFolder = { inbox: [], sentitems: [] }
  for (const c of h.checkpoints()) seqByFolder[c.args.p_folder].push(c.args.p_page_seq)
  for (const folder of ['inbox', 'sentitems']) {
    assert.deepStrictEqual(seqByFolder[folder], Array.from({ length: 25 }, (_, i) => i + 1),
      `${folder} page sequence must be gapless and in order`)
  }

  // NO CONTACT AND NO INTERACTION. Only the pending-suggestion RPC may write anything.
  const names = new Set(h.calls.map((c) => c.name))
  for (const forbidden of ['accept_interaction_candidate', 'accept_new_contact_candidate',
    'insert_contact', 'insert_interaction']) {
    assert.ok(!names.has(forbidden), `${forbidden} must never be called`)
  }
})

test('the halves really did arrive in different invocations', async () => {
  // Without this the first test could pass with both halves in one invocation, which would
  // prove nothing about continuation.
  const h = harness()
  const mb = bigMailbox({ inboxPages: 25, sentPages: 25, inboundAt: 22, outboundAt: 18 })
  const boundaries = []
  for (let i = 0; i < 10; i += 1) {
    const before = mb.served.length
    const r = await h.invoke({ fetchImpl: mb.fetchImpl })
    boundaries.push(mb.served.slice(before))
    if (r.outcome !== 'continued') break
  }
  const invocationOf = (folder, page) =>
    boundaries.findIndex((b) => b.some((s) => s.folder === folder && s.page === page))
  const inboundInv = invocationOf('inbox', 22)
  const outboundInv = invocationOf('sentitems', 18)
  assert.ok(inboundInv >= 0 && outboundInv >= 0, 'both halves must have been read')
  assert.notStrictEqual(inboundInv, outboundInv,
    `the halves must land in different invocations (both in ${inboundInv})`)
})

test('the resumed request uses the SAVED nextLink, byte for byte', async () => {
  const h = harness()
  const mb = bigMailbox({ inboxPages: 25, sentPages: 2, inboundAt: 22, outboundAt: 1 })
  await h.invoke({ fetchImpl: mb.fetchImpl })
  // What was saved at the end of invocation 1, and what invocation 2 asked for.
  const saved = h.store.folders.inbox.next_link_ciphertext
  assert.ok(typeof saved === 'string' && saved.startsWith('CT:'),
    'the nextLink must be stored as ciphertext')
  const savedLink = saved.slice(3)
  const before = mb.served.length
  await h.invoke({ fetchImpl: mb.fetchImpl })
  assert.strictEqual(mb.served[before].url, savedLink,
    'the first request of the next invocation must be exactly the saved link')
  // And the plaintext link is never what the database holds.
  assert.ok(!saved.includes('$skiptoken=p1&'), 'sanity: ciphertext is not the bare link')
  assert.notStrictEqual(saved, savedLink)
})

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n2. the invocation deadline, driven by an injected clock')
// ══════════════════════════════════════════════════════════════════════════════

test('the budget arithmetic is exactly what the design says it is', () => {
  assert.strictEqual(HOSTED_WALL_MS, 150_000, 'the documented free-plan wall clock')
  assert.strictEqual(INVOCATION_BUDGET_MS, HOSTED_WALL_MS - INVOCATION_SAFETY_MS)
  // Strictly greater, so a page costing its assumed worst cannot finish exactly as the
  // budget runs out and leave the checkpoint with nothing.
  const reserve = PAGE_ADMIT_FLOOR_MS + CHECKPOINT_RESERVE_MS
  assert.strictEqual(budgetAllowsPage({ nowMs: 0, deadlineMs: reserve }), false)
  assert.strictEqual(budgetAllowsPage({ nowMs: 0, deadlineMs: reserve + 1 }), true)
  // A slow page raises the reservation, so a slow mailbox stops earlier.
  assert.strictEqual(
    budgetAllowsPage({ nowMs: 0, deadlineMs: reserve + 1, slowestPageMs: 60_000 }), false)
  // The lease margin is NOT the budget: the lease is deliberately longer than any
  // invocation may live.
  assert.ok(INVOCATION_BUDGET_MS < 420_000)
})

test('a 30s page stops the invocation on BUDGET, not on the page cap', async () => {
  // 120s of budget, 65s reserved before admitting a page: two pages fit, the third does
  // not. Nothing about this depends on the platform actually enforcing a timeout.
  let clock = 0
  const h = harness({ now: () => clock })
  const mb = bigMailbox({ inboxPages: 25, sentPages: 25, inboundAt: 22, outboundAt: 18 })
  const slowFetch = async (url) => { clock += 30_000; return mb.fetchImpl(url) }

  const r = await h.invoke({ fetchImpl: slowFetch, requestEntryMs: 0 })
  assert.strictEqual(r.outcome, 'continued', JSON.stringify(summarizeRun(r)))
  assert.strictEqual(mb.served.length, 2, `two 30s pages fit in a 120s budget (${mb.served.length})`)
  assert.ok(mb.served.length < MAX_PAGES_PER_RUN, 'the page cap must NOT be what stopped it')
  const summary = summarizeRun(r)
  assert.strictEqual(summary.stops.inbox, 'budget_exhausted', JSON.stringify(summary.stops))
  assert.ok(CONTINUABLE_STOPS.includes('budget_exhausted'))
  // And the two pages it did read are durably saved.
  assert.strictEqual(h.store.folders.inbox.page_seq, 2)
  assert.strictEqual(h.checkpoints().length, 2)
  assert.strictEqual(r.cursorsAdvanced, 0)
})

test('an invocation that is already out of budget reads NOTHING and saves NOTHING', async () => {
  let clock = 500_000
  const h = harness({ now: () => clock })
  const mb = bigMailbox({ inboxPages: 5, sentPages: 5, inboundAt: 1, outboundAt: 1 })
  // Handler entry was long ago: the budget is already spent before the first page.
  const r = await h.invoke({ fetchImpl: mb.fetchImpl, requestEntryMs: 0 })
  assert.strictEqual(r.outcome, 'continued')
  assert.strictEqual(mb.served.length, 0, 'not one Graph request may be made')
  assert.strictEqual(h.checkpoints().length, 0)
  assert.strictEqual(r.cursorsAdvanced, 0)
  assert.strictEqual(h.writes().length, 0)
  // A healthy round asks to be retried sooner than a failure does.
  assert.strictEqual(h.releases().at(-1).args.p_retry_backoff_seconds, CONTINUE_BACKOFF_SECONDS)
})

test('with no entry time there is no invocation deadline, only the lease', async () => {
  // Backwards compatible on purpose: the budget is opt-in per call, so a suite that is
  // testing lease behaviour is not silently also testing the budget.
  const h = harness({ now: () => 10_000_000 })
  const mb = bigMailbox({ inboxPages: 1, sentPages: 1, inboundAt: 1, outboundAt: 1 })
  const r = await h.invoke({ fetchImpl: mb.fetchImpl })
  assert.strictEqual(r.outcome, 'committed', JSON.stringify(summarizeRun(r)))
})

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n3. a crash after a checkpoint')
// ══════════════════════════════════════════════════════════════════════════════

test('a run killed mid-page resumes from the checkpoint, applying no page twice', async () => {
  const h = harness()
  const mb = bigMailbox({ inboxPages: 6, sentPages: 2, inboundAt: 6, outboundAt: 1 })
  // The instance dies while fetching the 4th page: three checkpoints are already committed.
  // PERSISTENTLY dead, not one flaky request: the transport retries a failed attempt
  // several times, so a single throw would simply be retried and the run would finish.
  let requests = 0
  const dyingFetch = async (url) => {
    requests += 1
    if (requests >= 4) throw new Error('instance terminated')
    return mb.fetchImpl(url)
  }
  const crashed = await h.invoke({ fetchImpl: dyingFetch })
  assert.ok(crashed.outcome !== 'committed', `nothing may commit: ${crashed.outcome}`)
  assert.strictEqual(crashed.cursorsAdvanced, 0)
  assert.strictEqual(h.writes().length, 0, 'no suggestion from a partial view')

  // THE CHECKPOINT SURVIVED, and it is the position after the last page that committed.
  assert.strictEqual(h.store.folders.inbox.page_seq, 3)
  assert.strictEqual(h.store.folders.inbox.pages, 3)
  const resumeFrom = h.store.folders.inbox.next_link_ciphertext.slice(3)

  // Now the retry, with a healthy transport.
  const servedBefore = mb.served.length
  let outcome = null
  for (let i = 0; i < 10; i += 1) {
    const r = await h.invoke({ fetchImpl: mb.fetchImpl })
    outcome = r.outcome
    if (r.outcome !== 'continued') break
  }
  assert.strictEqual(outcome, 'committed')
  assert.strictEqual(mb.served[servedBefore].url, resumeFrom,
    'the retry must start at the saved position, not at the beginning')

  // NO PAGE APPLIED TWICE: the round read 6 + 2 pages in total, and page 4 was read once
  // (the crashed attempt never reached the transport).
  const inboxPagesRead = mb.served.filter((s) => s.folder === 'inbox').map((s) => s.page)
  assert.deepStrictEqual(inboxPagesRead, [1, 2, 3, 4, 5, 6], JSON.stringify(inboxPagesRead))
  assert.strictEqual(h.writes().length, 1, 'exactly one suggestion survives the crash')
})

test('a checkpoint re-sent after its commit is a no-op, not a double count', async () => {
  // Covers the other crash shape: the RPC committed but its answer never arrived, so the
  // caller retries the same page.
  const store = makeRoundStore()
  const page = (seq) => ({
    p_folder: 'inbox', p_round_id: 'round-1', p_page_seq: seq,
    p_next_link_ct: `CT:link-${seq}`, p_next_link_nonce: 'N', p_key_version: 1,
    p_pending_delta_ct: null, p_pending_delta_nonce: null, p_folder_complete: false,
    p_messages_seen: 4, p_messages_dropped: 0,
    p_conversations: [{
      cfp: 'a'.repeat(64), pfp: 'b'.repeat(64), efp: 'c'.repeat(64),
      first_fp: 'd'.repeat(64), first_at: '2026-09-20T14:00:00.000Z',
      last_at: '2026-09-20T14:00:00.000Z', contact_id: CONTACT, key_version: 1,
      inbound: 1, outbound: 0, messages: 1, taint: null,
    }],
  })
  const first = await store.handle('record_outlook_page_progress', page(1))
  assert.strictEqual(first.data.result, 'recorded')
  const again = await store.handle('record_outlook_page_progress', page(1))
  assert.strictEqual(again.data.result, 'duplicate_page')
  assert.strictEqual(store.folders.inbox.pages, 1, 'the page must not be counted twice')
  assert.strictEqual(store.folders.inbox.messages, 4)
  assert.strictEqual(store.conversations.get('a'.repeat(64)).inbound, 1,
    'the conversation must not be counted twice')
  // And a GAP is refused rather than silently accepted.
  const gap = await store.handle('record_outlook_page_progress', page(3))
  assert.strictEqual(gap.data.result, 'page_seq_gap')
})

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n4. a saved continuation token that Microsoft rejects')
// ══════════════════════════════════════════════════════════════════════════════

test('a rejected saved nextLink resets the round and keeps the COMMITTED cursor', async () => {
  const h = harness()
  const mb = bigMailbox({ inboxPages: 25, sentPages: 2, inboundAt: 22, outboundAt: 1 })
  // Give the connection a committed cursor to protect, as a second round would have.
  h.store.folders.inbox.delta_link_ciphertext = 'CT:committed-inbox'
  h.store.folders.inbox.delta_link_nonce = 'N'

  await h.invoke({ fetchImpl: mb.fetchImpl })
  assert.ok(h.store.folders.inbox.next_link_ciphertext, 'a position must have been saved')
  const savedPages = h.store.folders.inbox.pages
  assert.ok(savedPages > 0)

  // 410 Gone on the resumed link is exactly how Graph reports an expired delta token.
  const rejecting = async (url) => {
    if (url.includes('$skiptoken=')) {
      return { status: 410, headers: { get: () => null }, json: async () => ({ error: { code: 'resyncRequired' } }) }
    }
    return mb.fetchImpl(url)
  }
  const r = await h.invoke({ fetchImpl: rejecting })

  assert.strictEqual(r.outcome, 'restart_required', JSON.stringify(summarizeRun(r)))
  assert.strictEqual(r.reason, 'next_link_rejected')
  assert.strictEqual(summarizeRun(r).round_reset, 'reset')
  assert.strictEqual(r.cursorsAdvanced, 0)
  assert.strictEqual(h.writes().length, 0, 'no suggestion from a round that was discarded')

  // THE ROUND IS GONE...
  assert.strictEqual(h.store.folders.inbox.next_link_ciphertext, null)
  assert.strictEqual(h.store.folders.inbox.pages, 0)
  assert.strictEqual(h.store.folders.inbox.round_id, null)
  assert.strictEqual(h.store.conversations.size, 0)
  // ...AND THE COMMITTED CURSOR IS NOT. That is what stops a rejected continuation token
  // turning into a full re-import, and what stops it skipping anything.
  assert.strictEqual(h.store.folders.inbox.delta_link_ciphertext, 'CT:committed-inbox')
  assert.ok(h.calls.some((c) => c.name === 'reset_outlook_round'))
})

test('after the reset, a fresh round starts from the committed cursor and commits once', async () => {
  const h = harness()
  const mb = bigMailbox({ inboxPages: 25, sentPages: 2, inboundAt: 22, outboundAt: 1 })
  await h.invoke({ fetchImpl: mb.fetchImpl })
  const rejecting = async (url) => (url.includes('$skiptoken=')
    ? { status: 410, headers: { get: () => null }, json: async () => ({}) }
    : mb.fetchImpl(url))
  await h.invoke({ fetchImpl: rejecting })

  let outcome = null
  for (let i = 0; i < 10; i += 1) {
    const r = await h.invoke({ fetchImpl: mb.fetchImpl })
    outcome = r.outcome
    if (r.outcome !== 'continued') break
  }
  assert.strictEqual(outcome, 'committed')
  assert.strictEqual(h.writes().length, 1, 'exactly one pending suggestion, still')
})

// ══════════════════════════════════════════════════════════════════════════════
console.log('\nthe fingerprint is stable however the round was split')
// ══════════════════════════════════════════════════════════════════════════════

const CONV = 'conv-stable'
const rawEpisode = [
  msg('m1', CONV, OTHER, [ME], '2026-09-20T14:00:00Z'),
  msg('m2', CONV, ME, [OTHER], '2026-09-21T09:00:00Z'),
  msg('m3', CONV, OTHER, [ME], '2026-09-22T11:30:00Z'),
]

/** The same normalization the transport does, so the fold sees what it sees in a run. */
function normalized (rawList, folder) {
  const norm = normalizeGraphPage(rawList, folder)
  return norm.messages.map((m) => ({ message: m, extra: norm.extras.get(m.providerMessageKey) }))
}

// The inbound halves come from Inbox and the outbound half from Sent Items, because the
// folder is what decides direction when the sender is the user.
const episodeMessages = [
  ...normalized([rawEpisode[0], rawEpisode[2]], 'inbox'),
  ...normalized([rawEpisode[1]], 'sentitems'),
].sort((a, b) => a.message.timestampIso.localeCompare(b.message.timestampIso))
const selfSet = buildSelfIdentitySet(ME, [])
const contactIndex = indexContactsByEmail([{ id: CONTACT, user_id: U1, email: OTHER }], U1)

/** Fold a list of page-groups through the store and read the accumulated record back. */
async function accumulate (pageGroups) {
  const store = makeRoundStore()
  let seq = 0
  for (const group of pageGroups) {
    const { contributions } = await foldPage({
      entries: group, selfSet, contactIndex, connectionId: CONN, keyRing: KEY_RING,
    })
    seq += 1
    await store.handle('record_outlook_page_progress', {
      p_folder: 'inbox', p_round_id: 'r', p_page_seq: seq,
      p_next_link_ct: 'CT:x', p_next_link_nonce: 'N', p_key_version: 1,
      p_pending_delta_ct: null, p_pending_delta_nonce: null, p_folder_complete: false,
      p_messages_seen: group.length, p_messages_dropped: 0, p_conversations: contributions,
    })
  }
  const listed = await store.handle('list_outlook_round_conversations', { p_limit: 500 })
  return listed.data.conversations
}

test('ONE page, THREE pages, and reverse order all produce the same episode fingerprint', async () => {
  const whole = await accumulate([episodeMessages])
  const split = await accumulate([[episodeMessages[0]], [episodeMessages[1]], [episodeMessages[2]]])
  const reversed = await accumulate([[episodeMessages[2]], [episodeMessages[1]], [episodeMessages[0]]])
  const oddSplit = await accumulate([[episodeMessages[1], episodeMessages[2]], [episodeMessages[0]]])

  for (const rows of [whole, split, reversed, oddSplit]) {
    assert.strictEqual(rows.length, 1)
    assert.match(rows[0].efp, /^[0-9a-f]{64}$/)
  }
  const fp = whole[0].efp
  assert.strictEqual(split[0].efp, fp, 'a split round must not change the dedupe key')
  assert.strictEqual(reversed[0].efp, fp, 'page ARRIVAL ORDER must not change it either')
  assert.strictEqual(oddSplit[0].efp, fp)
  // And the counts are the same however it was split.
  for (const rows of [split, reversed, oddSplit]) {
    assert.strictEqual(rows[0].inbound, whole[0].inbound)
    assert.strictEqual(rows[0].outbound, whole[0].outbound)
    assert.strictEqual(rows[0].messages, whole[0].messages)
    assert.strictEqual(rows[0].last_at, whole[0].last_at)
  }
})

test('and it MATCHES the in-memory path, so the dedupe key did not change meaning', async () => {
  // Timestamps here are all distinct, which is the case where qualifyEpisode and the
  // accumulator are required to agree exactly - they order on the same field and only
  // break a TIE differently.
  const q = qualifyEpisode({ entries: episodeMessages, selfSet, contactIndex })
  assert.strictEqual(q.ok, true, q.code)
  const fps = await computeEpisodeFingerprints(q, { connectionId: CONN, keyRing: KEY_RING })
  const rows = await accumulate([[episodeMessages[0]], [episodeMessages[1], episodeMessages[2]]])
  assert.strictEqual(rows[0].efp, fps.episode.writeFingerprint)
  assert.strictEqual(rows[0].pfp, fps.person.writeFingerprint)
})

test('a one-sided exchange is never suggested, however many pages it spans', async () => {
  const oneSided = normalized([
    msg('s1', 'conv-cold', ME, [OTHER], '2026-09-20T14:00:00Z'),
    msg('s2', 'conv-cold', ME, [OTHER], '2026-09-21T14:00:00Z'),
  ], 'sentitems')
  const rows = await accumulate([[oneSided[0]], [oneSided[1]]])
  const { entries, skipped } = finalizeRound({
    conversations: rows, localDateFor: (iso) => localDateFor(iso, 'UTC'),
  })
  assert.strictEqual(entries.length, 0, 'a cold email that was never answered is not a relationship')
  assert.strictEqual(skipped.not_two_sided, 1)
})

test('a conversation that changes counterparty mid-round is tainted, not guessed at', async () => {
  const THIRD = 'ben@fund.test'
  const mixed = [
    ...normalized([msg('x1', 'conv-mixed', OTHER, [ME], '2026-09-20T14:00:00Z')], 'inbox'),
    ...normalized([msg('x2', 'conv-mixed', ME, [THIRD], '2026-09-21T14:00:00Z')], 'sentitems'),
  ]
  const rows = await accumulate([[mixed[0]], [mixed[1]]])
  assert.strictEqual(rows.length, 1)
  assert.ok(ROUND_TAINT_CODES.includes(rows[0].taint), rows[0].taint)
  const { entries } = finalizeRound({
    conversations: rows, localDateFor: (iso) => localDateFor(iso, 'UTC'),
  })
  assert.strictEqual(entries.length, 0)
})

// ══════════════════════════════════════════════════════════════════════════════
console.log('\nwhat is written down, and what is not')
// ══════════════════════════════════════════════════════════════════════════════

test('no checkpoint payload contains an address, a subject, or a provider id', async () => {
  const h = harness()
  const mb = bigMailbox({ inboxPages: 25, sentPages: 25, inboundAt: 22, outboundAt: 18 })
  for (let i = 0; i < 10; i += 1) {
    const r = await h.invoke({ fetchImpl: mb.fetchImpl })
    if (r.outcome !== 'continued') break
  }
  const allowed = new Set(['cfp', 'pfp', 'efp', 'elookup', 'first_fp', 'first_at', 'last_at',
    'contact_id', 'key_version', 'inbound', 'outbound', 'messages', 'taint'])
  let rows = 0
  for (const c of h.checkpoints()) {
    for (const conv of c.args.p_conversations) {
      rows += 1
      for (const k of Object.keys(conv)) assert.ok(allowed.has(k), `unexpected field ${k}`)
      const blob = JSON.stringify(conv)
      for (const leak of [ME, OTHER, 'Following up', 'conv-split', 'getfunnl.test', 'bank.test']) {
        assert.ok(!blob.includes(leak), `${leak} must never be persisted`)
      }
      assert.ok(!/in-\d|out-\d|filler/.test(blob), 'no provider message key may be persisted')
      for (const f of ['cfp', 'pfp', 'efp', 'first_fp']) {
        if (conv[f] !== null) assert.match(conv[f], /^[0-9a-f]{64}$/, f)
      }
    }
  }
  assert.ok(rows > 0, 'the scan must actually have seen some rows')
})

test('the accumulator table has no column that could hold content', () => {
  const table = /CREATE TABLE IF NOT EXISTS public\.outlook_conversation_progress[\s\S]*?\n\);/
    .exec(MIGRATION)[0]
  for (const forbidden of ['body', 'html', 'mime', 'snippet', 'preview', 'subject',
    'header', 'email', 'address', 'display_name', 'message_id', 'conversation_id',
    'provider_message', 'provider_conversation']) {
    assert.ok(!table.toLowerCase().includes(forbidden),
      `outlook_conversation_progress must have no ${forbidden} column`)
  }
  // Every provider-derived column is a fingerprint, and each has a shape CHECK.
  for (const fp of ['conversation_fingerprint', 'person_fingerprint', 'episode_fingerprint',
    'first_message_fingerprint']) {
    assert.ok(table.includes(fp), fp)
  }
  assert.ok(/ocp_conv_fp_shape\s+CHECK \(conversation_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/.test(table))
})

test('the nextLink is stored encrypted, and the pending delta is never the committed one', () => {
  assert.ok(/next_link_ciphertext\s+text/.test(MIGRATION))
  assert.ok(/pending_delta_ciphertext\s+text/.test(MIGRATION))
  // Mutually exclusive: a folder is either mid-stream or finished, never both.
  assert.ok(/oss_round_position_exclusive[\s\S]*?next_link_ciphertext IS NULL OR pending_delta_ciphertext IS NULL/.test(MIGRATION))
  // The pending cursor is promoted ONLY by a complete release.
  assert.ok(/round bookkeeping, new in 20261002000000/.test(MIGRATION))
  assert.ok(/pending_delta_ciphertext\s+= CASE WHEN v_complete THEN NULL ELSE s\.pending_delta_ciphertext END/.test(MIGRATION))
})

test('all four new RPCs are service_role only', () => {
  for (const fn of ['record_outlook_page_progress', 'read_outlook_round_progress',
    'list_outlook_round_conversations', 'reset_outlook_round']) {
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([\\s\\S]*?\\)\\s*FROM PUBLIC, anon, authenticated;`).test(MIGRATION),
      `${fn} must revoke from PUBLIC, anon AND authenticated`)
    assert.ok(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([\\s\\S]*?\\)\\s*TO service_role;`).test(MIGRATION),
      `${fn} must be granted to service_role only`)
  }
  assert.ok(/REVOKE ALL ON TABLE public\.outlook_conversation_progress FROM authenticated;/.test(MIGRATION))
  assert.ok(/ENABLE ROW LEVEL SECURITY/.test(MIGRATION))
  assert.ok(!/CREATE POLICY[\s\S]*outlook_conversation_progress/.test(MIGRATION),
    'worker state gets no policy for authenticated')
})

test('every checkpoint is fenced on BOTH folder leases', () => {
  const fn = /CREATE OR REPLACE FUNCTION public\.record_outlook_page_progress[\s\S]*?\n\$\$;/.exec(MIGRATION)[0]
  assert.ok(/FOR SHARE/.test(fn), 'the deterministic lock order must be taken first')
  assert.ok(/IF v_n <> 2 THEN[\s\S]{0,120}stale_run/.test(fn),
    'anything short of both folder leases must be stale_run')
  assert.ok(/sync_lease_until > now\(\)/.test(fn))
  // And the position update re-checks the lease, raising rather than half-applying.
  assert.ok(/lease_lost_during_checkpoint/.test(fn))
})

test('the JS and SQL round ceilings are the same numbers', () => {
  const sqlConst = (name) => {
    const m = new RegExp(`${name}\\s+constant integer := (\\d+);`).exec(MIGRATION)
    assert.ok(m, `${name} must be declared in the migration`)
    return Number(m[1])
  }
  assert.strictEqual(sqlConst('c_max_pages_per_round'), MAX_PAGES_PER_ROUND)
  assert.strictEqual(sqlConst('c_max_messages_per_round'), MAX_MESSAGES_PER_ROUND)
  assert.strictEqual(sqlConst('c_max_conversations_per_round'), MAX_CONVERSATIONS_PER_ROUND)
  // The round ceilings must be well above one invocation's share, or continuation would
  // buy nothing.
  assert.ok(MAX_PAGES_PER_ROUND > MAX_PAGES_PER_RUN * 2)
  assert.ok(ROUND_TTL_SECONDS >= 3600 && ROUND_TTL_SECONDS <= 604_800)
})

test('nothing in the round modules reads a body, calls AI, or schedules itself', () => {
  for (const [name, src] of [['roundState', ROUND_SRC], ['continuedPass', PASS_SRC]]) {
    for (const banned of ['anthropic', 'Anthropic', 'uniqueBody', 'buildMessageContentRequest',
      'outlookDraftContract', 'cron', 'setInterval', 'setTimeout', 'waitUntil',
      'upsert_email_candidate', 'gmail_sync_state']) {
      assert.ok(!src.includes(banned), `${name} must not reference ${banned}`)
    }
  }
})

test('the controlled vocabularies are complete and free of stray codes', () => {
  assert.ok(RUN_OUTCOMES.includes('continued'))
  assert.ok(RUN_OUTCOMES.includes('restart_required'))
  for (const c of CONTINUABLE_STOPS) assert.ok(FOLDER_STOP_CODES.includes(c), c)
  for (const c of ROUND_TAINT_CODES) assert.ok(ROUND_SKIP_CODES.includes(c), c)
  // Every taint code the SQL will accept is one the JS can produce, and vice versa.
  const sqlTaints = /ocp_taint_code_check CHECK \(taint_code IS NULL OR taint_code IN \(([\s\S]*?)\)\)/
    .exec(MIGRATION)[1]
  const listed = [...sqlTaints.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
  assert.deepStrictEqual(listed, [...ROUND_TAINT_CODES].sort())
})

test('every incomplete reason is controlled, and an unknown one never reaches a log', () => {
  for (const r of ['folder_incomplete', 'messages_dropped', 'conversations_dropped',
    'episode_truncated', 'plan_truncated', 'accumulator_unreadable', 'pending_key_mismatch']) {
    assert.ok(ROUND_INCOMPLETE_REASONS.includes(r), r)
  }
  const s = summarizeRun({
    outcome: 'incomplete',
    incompleteReasons: ['messages_dropped', 'something_invented', 'plan_truncated'],
  })
  assert.deepStrictEqual(s.incomplete_reasons, ['messages_dropped', 'plan_truncated'])
})

test('the round summary is counts and codes, never a fingerprint or a cursor', () => {
  const s = summarizeRoundProgress({
    inbox: {
      resumed: true, pages: 3, messages: 12, pageSeq: 3, folderComplete: false,
      messagesDropped: 0, conversationsDropped: 0, hasNextLink: true, hasPendingDelta: false,
      nextLink: 'https://graph.microsoft.com/secret', roundId: 'r', cfp: 'a'.repeat(64),
    },
  })
  const blob = JSON.stringify(s)
  assert.ok(!blob.includes('graph.microsoft.com'))
  assert.ok(!blob.includes('a'.repeat(64)))
  assert.ok(!blob.includes('"r"'))
  assert.strictEqual(s.inbox.has_next_link, true, 'WHETHER there is a position, not the position')
  assert.strictEqual(s.inbox.pages, 3)
})

test('canonicalIso makes JS string ordering agree with Postgres timestamp ordering', () => {
  // The ordering pair is compared as strings here and as timestamptz in the database, so a
  // non-canonical form would make the two disagree about which message came first.
  assert.strictEqual(canonicalIso('2026-09-20T14:00:00Z'), '2026-09-20T14:00:00.000Z')
  assert.strictEqual(canonicalIso('2026-09-20T14:00:00.000Z'), '2026-09-20T14:00:00.000Z')
  assert.strictEqual(canonicalIso('2026-09-20T16:00:00+02:00'), '2026-09-20T14:00:00.000Z')
  assert.strictEqual(canonicalIso('not a date'), null)
})

// ══════════════════════════════════════════════════════════════════════════════
console.log('\nthe policy and the decision are recorded, not decided')
// ══════════════════════════════════════════════════════════════════════════════

test('the live policy is UNCHANGED, and does not claim to cover this record', () => {
  // The published "What Funnl would keep" list is exhaustive. It does not name
  // per-conversation progress, and this branch must not pretend otherwise by editing it.
  for (const notThere of ['outlook_conversation_progress', 'conversation progress',
    'partial conversation state', 'continuation']) {
    assert.ok(!POLICY.toLowerCase().includes(notThere.toLowerCase()),
      `the live policy must not be edited here (found: ${notThere})`)
  }
  // What it DOES already say, which is why the field KINDS are covered even though the
  // record is not.
  assert.ok(POLICY.includes('one-way keyed fingerprints'))
  assert.ok(POLICY.includes('per-folder synchronization position'))
})

test('the design names the decision instead of making it', () => {
  assert.ok(/### D1\./.test(DESIGN), 'the policy gap must be D1')
  assert.ok(/### D2\./.test(DESIGN), 'the retention question must be D2')
  assert.ok(/one bullet must be added to the published policy/.test(DESIGN))
  assert.ok(/Round-scoped \(what is implemented\)/.test(DESIGN))
  assert.ok(/reply next week/.test(DESIGN),
    'the case round-scoped state cannot serve must be stated plainly')
  assert.ok(/not a choice an implementation[\s\S]{0,40}make quietly/.test(DESIGN))
  // And the runtime facts it is sized against, with the plan honestly unknown.
  assert.ok(/150 s free \/ 400 s paid/.test(DESIGN))
  assert.ok(/plan is not established/i.test(DESIGN))
  assert.ok(/Background tasks do not remove the wall limit/.test(DESIGN))
})

test('the migration says the accumulator is round-scoped and promises nothing more', () => {
  assert.ok(/ROUND-SCOPED/.test(MIGRATION))
  assert.ok(/No\s*\n?-- scheduler is introduced and no retention window is promised/.test(MIGRATION)
    || /no retention window is promised/.test(MIGRATION))
  assert.ok(/does NOT\s*\n?-- yet name this record/.test(MIGRATION)
    || /does NOT[\s\S]{0,80}name this record/.test(MIGRATION))
})

await Promise.all(pending)
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
