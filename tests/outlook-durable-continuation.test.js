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
import { webcrypto } from 'node:crypto'
import {
  runOutlookImport, summarizeRun, RUN_OUTCOMES, CONTINUE_BACKOFF_SECONDS,
  ROUND_INCOMPLETE_REASONS, RPC_ROUND_TRIP_MS, WRITE_STEP_RESERVE_MS, WRITE_STEP_MS,
  CONVERSATION_PAGE_SIZE,
  PROGRESS_STEP_MS, RELEASE_WORST_MS,
  FINALIZE_RESERVE_MS,
} from '../supabase/functions/shared/outlookImportRun.js'
import {
  makeRunContextLoader, CONTEXT_FAILURES, CONTEXT_STEP_MS, CONTACT_PAGE_SIZE,
} from '../supabase/functions/shared/outlookRunContext.js'
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
  MAX_PAGES_PER_RUN, GRAPH_BASE, GRAPH_FOLDERS,
} from '../supabase/functions/shared/outlookGraphTransport.js'
import {
  buildSelfIdentitySet, indexContactsByEmail, qualifyEpisode,
  computeEpisodeFingerprints,
} from '../supabase/functions/shared/outlookParticipants.js'
import { localDateFor } from '../supabase/functions/shared/outlookMetadataPass.js'
import { normalizeGraphPage } from '../supabase/functions/shared/outlookMessageNormalize.js'
import {
  makeRoundStore, CONVERSATION_PAGE_SIZE as STORE_PAGE_SIZE,
} from './harness/outlookRoundStore.js'
const CONSENTED = 'ol-disc-' + '0'.repeat(32)   // the version these fixtures' connections consented under; injected as the background requirement

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
const READINESS = read('docs/outlook-privacy-consent-readiness.md')

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
    cursors: {}, accessToken: 'tok', consentVersion: CONSENTED, keyRing: KEY_RING,
  })
}

const ENCRYPT = async (link) => ({ ciphertext: `CT:${link}`, nonce: 'N', keyVersion: 1 })
const DECRYPT = async (ct) => String(ct).replace(/^CT:/, '')

/**
 * One connection, many invocations. The store and the call log persist across them, which
 * is the whole point: invocation N+1 must find what invocation N wrote.
 */
function harness ({ now, advance, writeCostMs = 0 } = {}) {
  const store = makeRoundStore()
  const calls = []
  let leaseLive = true
  let killAfter = Infinity
  let refuseAt = -1
  let refuseCode = 'contact_not_owned'
  let writeCount = 0
  const results = Object.create(null)
  // Which episode fingerprints are already pending, so a repeat answers 'refreshed'
  // exactly as upsert_outlook_interaction_candidate does for a row that already exists.
  const pendingRows = new Set()

  const rpc = async (name, args) => {
    calls.push({ name, args })
    if (name === 'reserve_due_outlook_connection') {
      return { data: { result: 'reserved', connection_id: CONN, user_id: U1, run_id: RUN }, error: null }
    }
    if (name === 'renew_outlook_sync_lease') return { data: leaseLive, error: null }
    if (name === 'upsert_outlook_interaction_candidate') {
      // Each write costs a bounded round trip of virtual time, which is what makes the
      // invocation budget bite during FINALISATION rather than during the page loop.
      if (typeof advance === 'function' && writeCostMs > 0) advance(writeCostMs)
      if (writeCount >= killAfter) {
        // THE HARD STOP: the platform shuts the instance down. Nothing after this runs.
        throw Object.assign(new Error('instance terminated'), { __kill: true })
      }
      if (writeCount === refuseAt) {
        writeCount += 1
        results[refuseCode] = (results[refuseCode] || 0) + 1
        return { data: { result: refuseCode }, error: null }
      }
      writeCount += 1
      const fp = args.p_episode_fingerprint
      const code = pendingRows.has(fp) ? 'refreshed' : 'created'
      pendingRows.add(fp)
      results[code] = (results[code] || 0) + 1
      return { data: { result: code }, error: null }
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
    pilotUserId: U1,
    requiredBackgroundConsent: CONSENTED,
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
    rpc,
    pilotUserId: U1,
    requiredBackgroundConsent: CONSENTED,
    // Results ACROSS invocations, which is what a resumed finalisation has to be judged on.
    results: () => ({ ...results }),
    distinctWritten: () => pendingRows.size,
    killWritesAfter: (n) => { killAfter = n },
    refuseWriteAt: (n, code) => { refuseAt = n; refuseCode = code ?? refuseCode },
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
  // NOT 'continued'. An invocation that saved nothing must not look like one that moved
  // the round forward: 'continued' promises the next invocation will carry on from here,
  // and there is no 'here'. A no-progress invocation says so, and does not answer 200.
  assert.strictEqual(r.outcome, 'budget_exhausted', JSON.stringify(summarizeRun(r)))
  assert.strictEqual(r.reason, 'context_budget_exhausted')
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
console.log('\n5. the WHOLE invocation is budgeted, not only the page loop')
// ══════════════════════════════════════════════════════════════════════════════

/**
 * A mailbox with `n` qualifying conversations, all on one page per folder, so the round
 * finishes immediately and the expensive part is FINALISATION.
 */
function manyConversations (n) {
  const convs = Array.from({ length: n }, (_, i) => `conv-${String(i).padStart(3, '0')}`)
  const served = []
  const fetchImpl = async (url) => {
    const inbox = url.includes('/mailFolders/inbox/')
    served.push(inbox ? 'inbox' : 'sentitems')
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        value: convs.map((c, i) => (inbox
          ? msg(`in-${i}`, c, OTHER, [ME], '2026-09-20T14:00:00Z')
          : msg(`out-${i}`, c, ME, [OTHER], '2026-09-21T09:00:00Z'))),
        '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${inbox ? 'inbox' : 'sentitems'}/messages/delta?$deltatoken=D`,
      }),
    }
  }
  return { fetchImpl, served, count: n }
}

test('REPRODUCED: a context load longer than the budget is bounded, not killed', async () => {
  // BEFORE: loadRunContext ran before the only budget check, which lived inside the page
  // loop. A 200s load against a 120s budget returned a 200 'continued' having read no
  // mail and saved no checkpoint - and on the real platform the instance was already
  // killed at 150s mid-load, leaving the lease held until it expired. Reproduced exactly
  // that way before this test existed.
  let clock = 0
  const h = harness({ now: () => clock })
  const mb = bigMailbox({ inboxPages: 2, sentPages: 2, inboundAt: 1, outboundAt: 1 })
  const r = await runOutlookImport({
    rpc: h.rpc,
    pilotUserId: U1,
    requiredBackgroundConsent: CONSENTED,
    encryptCursor: ENCRYPT,
    decryptCursor: DECRYPT,
    // The real loader checks the same deadline between its bounded steps; this stub stands
    // in for one that has already spent the budget by the time it is asked to continue.
    loadRunContext: async (_c, _r, budgetOpts) => {
      assert.ok(Number.isFinite(budgetOpts?.deadlineMs),
        'the loader must be TOLD the invocation deadline')
      clock += 200_000
      throw Object.assign(new Error('x'), { reason: 'context_budget_exhausted' })
    },
    requestEntryMs: 0,
    deps: { fetchImpl: mb.fetchImpl, now: () => clock },
  })
  // The run gives the lease back and says why, instead of being killed holding it.
  assert.strictEqual(r.outcome, 'released_error', JSON.stringify(summarizeRun(r)))
  assert.strictEqual(r.reason, 'context_budget_exhausted')
  assert.strictEqual(mb.served.length, 0, 'no mail may be read')
  assert.strictEqual(r.cursorsAdvanced, 0)
  const rel = h.releases().at(-1).args
  assert.strictEqual(rel.p_run_complete, false)
  assert.strictEqual(rel.p_inbox_delta_ct, null)
})

test('an invocation with no budget left does not even start the context load', async () => {
  let clock = 118_000          // 2s left of a 120s budget
  const h = harness({ now: () => clock })
  const mb = bigMailbox({ inboxPages: 1, sentPages: 1, inboundAt: 1, outboundAt: 1 })
  let loads = 0
  const r = await runOutlookImport({
    rpc: h.rpc,
    pilotUserId: U1,
    requiredBackgroundConsent: CONSENTED,
    encryptCursor: ENCRYPT,
    decryptCursor: DECRYPT,
    loadRunContext: async () => { loads += 1; return context()() },
    requestEntryMs: 0,
    deps: { fetchImpl: mb.fetchImpl, now: () => clock },
  })
  assert.strictEqual(loads, 0, 'not one database read may be made')
  assert.strictEqual(r.outcome, 'budget_exhausted', JSON.stringify(summarizeRun(r)))
  assert.strictEqual(r.reason, 'context_budget_exhausted')
  assert.strictEqual(mb.served.length, 0)
  // The lease is RELEASED rather than left held until it expires - which is the whole
  // difference between stopping ourselves and being killed.
  assert.strictEqual(h.releases().length, 1)
  assert.strictEqual(h.releases()[0].args.p_status, 'idle')
})

test('the real loader stops at a PAGE BOUNDARY when a delayed port eats the budget', async () => {
  // Delayed ports rather than a stubbed loader: every PostgREST read costs 20s of virtual
  // time, so the paged contact read - 13 of the load's 18 bounded calls - cannot finish.
  let clock = 0
  const reads = []
  const select = async (path) => {
    reads.push(path.split('?')[0])
    clock += 20_000
    if (path.startsWith('microsoft_connections')) {
      return { data: [{ user_id: U1, ms_email: ME, scopes: ['Mail.Read'], token_expires_at: null }], error: null }
    }
    if (path.startsWith('contacts')) {
      // A full page every time, so the loop keeps going until something stops it.
      return {
        data: Array.from({ length: CONTACT_PAGE_SIZE }, (_, i) => ({
          id: `c${reads.length}-${i}`, user_id: U1, email: `p${reads.length}-${i}@x.test`,
        })),
        error: null,
      }
    }
    return { data: [], error: null }
  }
  const loader = makeRunContextLoader({
    select,
    rpc: async () => ({ data: { result: 'rotated' }, error: null }),
    config: {
      clientId: 'id', clientSecret: 'secret', tokenUrl: 'https://t.test',
      tokenKeyB64: Buffer.from(new Uint8Array(32).fill(3)).toString('base64'),
      keyRing: KEY_RING,
    },
    deps: { now: () => clock, subtle: webcrypto.subtle },
  })

  let thrown = null
  try {
    await loader(CONN, RUN, { deadlineMs: INVOCATION_BUDGET_MS, now: () => clock })
  } catch (e) { thrown = e }

  assert.ok(thrown, 'the load must not run past the budget')
  assert.strictEqual(thrown.reason, 'context_budget_exhausted')
  assert.ok(CONTEXT_FAILURES.includes(thrown.reason), 'the reason must be controlled')
  // It stopped BETWEEN reads, not mid-read: 120s of budget at 20s a read is five reads,
  // and the margin means the sixth is never started.
  assert.ok(reads.length <= 6, `stopped at a page boundary, after ${reads.length} reads`)
  assert.ok(reads.length >= 2, 'it must have got past the connection read')
  assert.ok(clock < INVOCATION_BUDGET_MS + 20_000,
    `it must not overrun the budget by more than one step (${clock}ms)`)
})

test('the finalisation reserves are derived, not guessed', () => {
  // What a write must keep in hand: the write itself, the call that records it, and the
  // release. Derived from those three so adding a step cannot silently shrink the margin.
  assert.strictEqual(WRITE_STEP_RESERVE_MS, WRITE_STEP_MS + PROGRESS_STEP_MS + RELEASE_WORST_MS)
  // And starting finalisation at all needs the list call on top of one write's reserve.
  assert.strictEqual(FINALIZE_RESERVE_MS, PROGRESS_STEP_MS + WRITE_STEP_RESERVE_MS)
  // Both must fit inside one invocation, or finalisation could never start.
  assert.ok(FINALIZE_RESERVE_MS < INVOCATION_BUDGET_MS,
    'the invocation budget must be able to cover listing plus one write')
})

test('CONTEXT_STEP_MS is the same bounded round trip the run budgets with', () => {
  // Two modules, one number. The loader cannot import endpoints.js (that belongs to the
  // worker function, not shared/), so the only thing stopping them drifting is this.
  assert.strictEqual(CONTEXT_STEP_MS, RPC_ROUND_TRIP_MS)
})

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n6. finalising a large batch spans invocations instead of restarting')
// ══════════════════════════════════════════════════════════════════════════════

test('REPRODUCED AND FIXED: 40 suggestions finish across invocations, each written ONCE', async () => {
  // BEFORE: the write loop had no budget check. 40 qualifying conversations at one bounded
  // RPC each spent 800s against a 120s budget; with the platform stopping the instance
  // after six, six valid pending suggestions existed, the round was still saved, both
  // cursors were correctly NULL - and nothing recorded those six, so the next invocation
  // re-listed all 40 and began again at the first entry, forever.
  let clock = 0
  const h = harness({ now: () => clock, advance: (ms) => { clock += ms }, writeCostMs: 20_000 })
  const mb = manyConversations(40)

  // 120s of budget, 60s reserved before admitting a write (the write, recording how far
  // we got, and the release), and 20s a write: three writes an invocation, so 40 needs
  // fourteen of them.
  const perInvocation = []
  let committedAt = -1
  for (let i = 0; i < 25; i += 1) {
    clock = 0                                  // a fresh invocation, a fresh 120s budget
    const before = h.writes().length
    const r = await h.invoke({ fetchImpl: mb.fetchImpl, requestEntryMs: 0 })
    perInvocation.push({ outcome: r.outcome, wrote: h.writes().length - before, r })
    if (r.outcome === 'committed') { committedAt = i; break }
    assert.strictEqual(r.outcome, 'continued', JSON.stringify(summarizeRun(r)))
    // NO CURSOR until every intended write is confirmed.
    assert.strictEqual(r.cursorsAdvanced, 0)
    assert.strictEqual(h.store.folders.inbox.delta_link_ciphertext, null,
      'the committed cursor must not move while suggestions remain unwritten')
    // Progress IS recorded, so the next invocation starts further along.
    assert.match(h.store.folders.inbox.write_cursor ?? '', /^[0-9a-f]{64}$/,
      'the finalisation cursor must be saved')
  }

  assert.ok(committedAt > 0,
    `finalisation must need more than one invocation and then finish (${JSON.stringify(perInvocation.map((x) => x.outcome))})`)
  // Every invocation before the last did real work, so this is progress and not a loop.
  for (const inv of perInvocation.slice(0, -1)) {
    assert.ok(inv.wrote > 0, 'each continued invocation must write some suggestions')
    assert.ok(inv.wrote < 40, 'and must not write them all')
  }

  // EXACTLY 40 writes, each conversation once - no duplicates, none dropped.
  assert.strictEqual(h.writes().length, 40, `40 writes in total, got ${h.writes().length}`)
  const fps = h.writes().map((c) => c.args.p_episode_fingerprint)
  assert.strictEqual(new Set(fps).size, 40, 'no suggestion may be written twice')

  const last = perInvocation.at(-1).r
  assert.strictEqual(last.outcome, 'committed')
  assert.strictEqual(last.cursorsAdvanced, 2, 'both cursors advance, together, at the end')
  assert.strictEqual(summarizeRun(last).finalize.complete, true)
  // And the round is erased, write cursor included.
  assert.strictEqual(h.store.folders.inbox.write_cursor, null)
  assert.strictEqual(h.store.conversations.size, 0)
})

test('intended still means "writes this batch needs", not "writes we got round to"', async () => {
  let clock = 0
  const h = harness({ now: () => clock, advance: (ms) => { clock += ms }, writeCostMs: 20_000 })
  const mb = manyConversations(40)
  const r = await h.invoke({ fetchImpl: mb.fetchImpl, requestEntryMs: 0 })
  const s = summarizeRun(r)
  assert.strictEqual(r.outcome, 'continued')
  assert.strictEqual(s.intended, 40, 'the whole batch is intended')
  assert.ok(s.accepted > 0 && s.accepted < 40, `part of it landed (${s.accepted})`)
  assert.strictEqual(s.finalize.rows, 40)
  assert.strictEqual(s.finalize.processed, s.accepted)
  assert.strictEqual(s.finalize.complete, false)
  assert.strictEqual(s.finalize.cursor_advanced, true)
  assert.strictEqual(s.cursors_advanced, 0)
})

test('A THROWN write still records how far finalisation got', async () => {
  // Worth separating from a hard stop: a write that THROWS (a reset connection, say) is
  // caught by the run, so the write cursor is still recorded and the next invocation
  // resumes. Only a platform kill loses that.
  let clock = 0
  const h = harness({ now: () => clock, advance: (ms) => { clock += ms }, writeCostMs: 1_000 })
  const mb = manyConversations(10)
  h.killWritesAfter(3)
  const r = await h.invoke({ fetchImpl: mb.fetchImpl, requestEntryMs: 0 })
  assert.strictEqual(r.outcome, 'write_error', JSON.stringify(summarizeRun(r)))
  assert.strictEqual(r.accepted, 3, 'the three that landed are reported')
  assert.strictEqual(r.cursorsAdvanced, 0, 'and no cursor moved')
  assert.match(h.store.folders.inbox.write_cursor ?? '', /^[0-9a-f]{64}$/,
    'how far it got is still recorded, so the retry resumes')
  const rows = [...h.store.conversations.values()].map((c) => c.cfp).sort()
  assert.strictEqual(h.store.folders.inbox.write_cursor, rows[2])
})

test('A HARD STOP mid-batch loses no suggestion and duplicates none', async () => {
  let clock = 0
  // A CHEAP write here on purpose: this test is about the kill, not about the budget, so
  // the budget must not be what stops the loop before the kill point is reached.
  const h = harness({ now: () => clock, advance: (ms) => { clock += ms }, writeCostMs: 1_000 })
  const mb = manyConversations(40)

  // A FAITHFUL platform kill: the instance dies on the 4th write and NOTHING after it
  // runs - so the call that records how far finalisation got never lands either. (A
  // thrown write alone is caught by the run and does record it; that is the test above.)
  h.killWritesAfter(3)
  h.store.refuse('advance_outlook_round_write_cursor', 'stale_run')
  let crashed = null
  try {
    await h.invoke({ fetchImpl: mb.fetchImpl, requestEntryMs: 0 })
  } catch (e) { crashed = e }
  const writtenBeforeKill = h.writes().length
  assert.strictEqual(writtenBeforeKill, 4, 'three landed; the fourth is where it died')
  assert.strictEqual(h.distinctWritten(), 3, 'three pending suggestions exist')
  assert.strictEqual(h.store.folders.inbox.write_cursor, null,
    'the stop happened before the cursor could be recorded')
  assert.strictEqual(h.store.folders.inbox.delta_link_ciphertext, null,
    'and NO cursor advanced')
  assert.strictEqual(h.store.folders.inbox.folder_complete, true, 'the round is still saved')
  assert.strictEqual(h.store.conversations.size, 40, 'with its accumulator intact')
  // The run itself returns (it catches a thrown write), but the state is exactly what a
  // kill leaves: suggestions written, round saved, nothing recorded about the batch.
  assert.ok(crashed === null, 'the simulated kill is observed through the state, not a throw')

  // The retry re-walks from the last RECORDED point, which is the start: bounded rework,
  // and the candidate upsert answers 'refreshed' for the three already there.
  h.killWritesAfter(Infinity)
  h.store.allow('advance_outlook_round_write_cursor')
  let outcome = null
  for (let i = 0; i < 25; i += 1) {
    clock = 0
    const r = await h.invoke({ fetchImpl: mb.fetchImpl, requestEntryMs: 0 })
    outcome = r.outcome
    if (outcome !== 'continued') break
  }
  assert.strictEqual(outcome, 'committed')
  // 40 distinct conversations, whatever the rework.
  const fps = h.writes().map((c) => c.args.p_episode_fingerprint)
  assert.strictEqual(new Set(fps).size, 40, 'every conversation is suggested, exactly once')
  assert.strictEqual(h.distinctWritten(), 40)
  const refreshed = h.results().refreshed ?? 0
  assert.ok(refreshed >= 3,
    `the three before the stop were re-sent and deduped, not lost: ${refreshed} refreshed`)
  // BOUNDED rework: the batch restarted from the last RECORDED point, which was the
  // start - so at most one invocation's worth of writes was repeated, not all 40 on every
  // attempt, which is what the old behaviour did.
  assert.ok(h.writes().length < 40 * 3,
    `rework must be bounded, not repeated forever (${h.writes().length} writes)`)
})

test('a REFUSED write does not let the finalisation cursor pass it', async () => {
  let clock = 0
  const h = harness({ now: () => clock, advance: (ms) => { clock += ms }, writeCostMs: 1_000 })
  const mb = manyConversations(5)
  h.refuseWriteAt(3, 'contact_not_owned')      // the 4th write is refused
  const r = await h.invoke({ fetchImpl: mb.fetchImpl, requestEntryMs: 0 })
  assert.strictEqual(r.outcome, 'write_failed', JSON.stringify(summarizeRun(r)))
  assert.strictEqual(r.refusal, 'contact_not_owned')
  assert.strictEqual(r.accepted, 3, 'the three that landed are reported honestly')
  assert.strictEqual(r.cursorsAdvanced, 0)
  // The cursor stops BEFORE the refused conversation, so the retry reattempts it rather
  // than skipping it.
  const cursor = h.store.folders.inbox.write_cursor
  const rows = [...h.store.conversations.values()].map((c) => c.cfp).sort()
  assert.strictEqual(cursor, rows[2], 'the cursor stops at the last ACCEPTED conversation')
  assert.ok(cursor < rows[3], 'and never passes the refused one')
})

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n7. the accumulator read-back is PAGED, and truncation is whole-round')
// ══════════════════════════════════════════════════════════════════════════════

const hexFp = (n) => n.toString(16).padStart(64, '0')

/**
 * Put the store in the state a FINISHED round leaves behind: both folders complete with
 * a staged cursor, and `n` accumulator rows waiting to be finalised.
 *
 * Seeded directly rather than through Graph pages because these tests are about
 * finalisation, and 450 qualifying conversations would otherwise need 450 fixture
 * messages to say nothing extra.
 */
function seedCompletedRound (store, { n, taintAt = [] }) {
  const ROUND = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
  for (const f of GRAPH_FOLDERS) {
    store.folders[f].round_id = ROUND
    store.folders[f].page_seq = 1
    store.folders[f].pages = 1
    store.folders[f].messages = n
    store.folders[f].folder_complete = true
    store.folders[f].pending_delta_ciphertext = `CT:delta-${f}`
    store.folders[f].pending_delta_nonce = 'N'
    store.folders[f].pending_delta_key_version = 1
  }
  for (let i = 0; i < n; i += 1) {
    const cfp = hexFp(i + 1)
    store.conversations.set(cfp, {
      cfp,
      pfp: hexFp(i + 1_000_000),
      efp: hexFp(i + 2_000_000),
      elookup: [hexFp(i + 2_000_000)],
      first_fp: hexFp(i + 3_000_000),
      first_at: '2026-09-20T14:00:00.000Z',
      last_at: '2026-09-21T09:00:00.000Z',
      contact_id: CONTACT,
      key_version: 1,
      inbound: 1,
      outbound: 1,
      messages: taintAt.includes(i) ? 60 : 2,
      taint: taintAt.includes(i) ? 'episode_truncated' : null,
    })
  }
  return ROUND
}

/** A round that is already finished needs no Graph page at all. */
const noGraph = async () => { throw new Error('no Graph request should happen') }

test('the JS page size is the one the SQL caps every read-back at', () => {
  assert.strictEqual(CONVERSATION_PAGE_SIZE, STORE_PAGE_SIZE)
  // And it is well under the round ceiling, or paging would buy nothing.
  assert.ok(CONVERSATION_PAGE_SIZE < MAX_CONVERSATIONS_PER_ROUND)
  // The SQL must cap it too, not merely default to it: a caller asking for the whole
  // round would otherwise get a body its own port refuses to read.
  assert.ok(MIGRATION.includes('LEAST(GREATEST(COALESCE(p_limit, 200), 1), 200)'),
    'the SQL must clamp p_limit to the measured page size')
  assert.ok(MIGRATION.includes('about 1.18 MiB'),
    'the measured size that forced paging must be recorded')
})

test('450 conversations finalise across THREE pages and commit once', async () => {
  const h = harness()
  seedCompletedRound(h.store, { n: 450 })
  const r = await h.invoke({ fetchImpl: noGraph })
  const s = summarizeRun(r)
  assert.strictEqual(r.outcome, 'committed', JSON.stringify(s))
  assert.strictEqual(s.finalize.pages, 3, `450 rows at ${CONVERSATION_PAGE_SIZE} a page`)
  assert.strictEqual(s.finalize.rows, 450)
  assert.strictEqual(s.finalize.processed, 450)
  assert.strictEqual(s.finalize.more_rows, false)
  assert.strictEqual(s.finalize.complete, true)
  assert.strictEqual(r.intended, 450)
  assert.strictEqual(r.accepted, 450)
  assert.strictEqual(r.cursorsAdvanced, 2)
  // Every conversation written exactly once, across the pages.
  assert.strictEqual(h.distinctWritten(), 450)
  assert.strictEqual(h.writes().length, 450)
  // No page ever asked for more than fits.
  for (const c of h.calls.filter((x) => x.name === 'list_outlook_round_conversations')) {
    assert.ok(c.args.p_limit <= CONVERSATION_PAGE_SIZE, `asked for ${c.args.p_limit}`)
  }
})

test('the pages resume on the ORDERED write cursor, with no overlap and no gap', async () => {
  const h = harness()
  seedCompletedRound(h.store, { n: 450 })
  await h.invoke({ fetchImpl: noGraph })
  const lists = h.calls.filter((x) => x.name === 'list_outlook_round_conversations')
  // The first page starts from nothing; each later one starts after the previous page's
  // last conversation, which is also where the write cursor is recorded.
  assert.strictEqual(lists[0].args.p_after, null)
  const writes = h.writes().map((c) => c.args.p_episode_fingerprint)
  assert.strictEqual(new Set(writes).size, writes.length, 'no conversation written twice')
  for (let i = 1; i < lists.length; i += 1) {
    assert.match(lists[i].args.p_after, /^[0-9a-f]{64}$/)
    assert.ok(lists[i].args.p_after > (lists[i - 1].args.p_after ?? ''),
      'the resume point must move strictly forward')
  }
})

test('REGRESSION: a truncated episode blocks the commit, and NO cursor moves', async () => {
  // The whole-round gate used to catch this; per-row finalisation then skipped the
  // tainted conversation and said nothing, so the run committed BOTH cursors past an
  // exchange it had discarded - permanently, because a delta cursor never offers those
  // messages again.
  const h = harness()
  seedCompletedRound(h.store, { n: 3, taintAt: [1] })
  const r = await h.invoke({ fetchImpl: noGraph })
  const s = summarizeRun(r)
  assert.strictEqual(r.outcome, 'incomplete', JSON.stringify(s))
  assert.ok(s.incomplete_reasons.includes('episode_truncated'),
    JSON.stringify(s.incomplete_reasons))
  // NOTHING is written from a round that cannot commit.
  assert.strictEqual(h.writes().length, 0, 'no suggestion from a round that forfeits its cursor')
  assert.strictEqual(r.accepted, 0)
  assert.strictEqual(r.cursorsAdvanced, 0)
  // And the cursor state is untouched: both committed cursors absent, and finalisation
  // did not record progress it did not make.
  for (const f of GRAPH_FOLDERS) {
    assert.strictEqual(h.store.folders[f].delta_link_ciphertext, null, f)
    assert.strictEqual(h.store.folders[f].write_cursor, null, f)
    assert.strictEqual(h.store.folders[f].pending_delta_ciphertext, `CT:delta-${f}`,
      'the staged cursor stays staged, never promoted')
  }
})

test('REGRESSION, THE HARD CASE: the tainted row is on an EARLIER page', async () => {
  // This is the one a per-page check cannot catch. A previous invocation already dealt
  // with the page holding the shortened exchange and recorded the write cursor past it,
  // so the page THIS invocation lists does not contain it at all. The round must still
  // refuse to commit, because the discarded work is a property of the ROUND.
  const h = harness()
  seedCompletedRound(h.store, { n: 3, taintAt: [0] })
  // As if finalisation had already passed the first conversation - the tainted one.
  for (const f of GRAPH_FOLDERS) h.store.folders[f].write_cursor = hexFp(1)

  const r = await h.invoke({ fetchImpl: noGraph })
  const s = summarizeRun(r)

  // The page in hand is CLEAN - the tainted conversation is behind the cursor.
  const listed = h.calls.find((x) => x.name === 'list_outlook_round_conversations')
  assert.strictEqual(listed.args.p_after, hexFp(1), 'the listing resumed past the tainted row')

  assert.strictEqual(r.outcome, 'incomplete', JSON.stringify(s))
  assert.ok(s.incomplete_reasons.includes('episode_truncated'),
    'a shortened exchange on an earlier page must still forfeit the cursor')
  assert.strictEqual(r.cursorsAdvanced, 0)
  assert.strictEqual(h.writes().length, 0)
  for (const f of GRAPH_FOLDERS) {
    assert.strictEqual(h.store.folders[f].delta_link_ciphertext, null,
      'NO cursor may advance past work the round discarded')
  }
})

test('a clean round of the same shape DOES commit, so the gate is not just always-on', async () => {
  const h = harness()
  seedCompletedRound(h.store, { n: 3 })
  for (const f of GRAPH_FOLDERS) h.store.folders[f].write_cursor = hexFp(1)
  const r = await h.invoke({ fetchImpl: noGraph })
  assert.strictEqual(r.outcome, 'committed', JSON.stringify(summarizeRun(r)))
  assert.strictEqual(r.intended, 2, 'the conversation behind the cursor is not redone')
  assert.strictEqual(r.accepted, 2)
  assert.strictEqual(r.cursorsAdvanced, 2)
})

test('more rows remaining with no budget left is CONTINUATION, not incompleteness', async () => {
  let clock = 0
  const h = harness({
    now: () => clock, advance: (ms) => { clock += ms }, writeCostMs: 20_000,
  })
  seedCompletedRound(h.store, { n: 450 })
  const r = await h.invoke({ fetchImpl: noGraph, requestEntryMs: 0 })
  const s = summarizeRun(r)
  assert.strictEqual(r.outcome, 'continued', JSON.stringify(s))
  // Not reported as a dropped-work reason: there is simply more to do.
  assert.deepStrictEqual(s.incomplete_reasons, [])
  assert.strictEqual(s.finalize.complete, false)
  assert.strictEqual(r.cursorsAdvanced, 0)
  assert.ok(r.accepted > 0 && r.accepted < 450, `part of it landed (${r.accepted})`)
  assert.match(h.store.folders.inbox.write_cursor ?? '', /^[0-9a-f]{64}$/)
  // Then it finishes across invocations without redoing anything.
  let outcome = r.outcome
  for (let i = 0; i < 400 && outcome === 'continued'; i += 1) {
    clock = 0
    outcome = (await h.invoke({ fetchImpl: noGraph, requestEntryMs: 0 })).outcome
  }
  assert.strictEqual(outcome, 'committed')
  assert.strictEqual(h.distinctWritten(), 450)
  assert.strictEqual((h.results().refreshed ?? 0), 0, 'nothing was written twice')
})

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n8. a round expires AS ONE UNIT, and a new one can always start')
// ══════════════════════════════════════════════════════════════════════════════

/** A harness whose store shares the test's virtual clock, so expiry is controllable. */
function expiryHarness () {
  let clock = 1_000_000
  const store = makeRoundStore({ clock: () => clock })
  const calls = []
  const rpc = async (name, args) => {
    calls.push({ name, args })
    if (name === 'reserve_due_outlook_connection') {
      return { data: { result: 'reserved', connection_id: CONN, user_id: U1, run_id: RUN }, error: null }
    }
    if (name === 'renew_outlook_sync_lease') return { data: true, error: null }
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
  return {
    store,
    calls,
    advance: (ms) => { clock += ms },
    now: () => clock,
    invoke: ({ fetchImpl }) => runOutlookImport({
      rpc,
      pilotUserId: U1,
      requiredBackgroundConsent: CONSENTED,
      encryptCursor: ENCRYPT,
      decryptCursor: DECRYPT,
      loadRunContext: context(),
      deps: { fetchImpl },
    }),
    writes: () => calls.filter((c) => c.name === 'upsert_outlook_interaction_candidate'),
    named: (n) => calls.filter((c) => c.name === n),
  }
}

test('a later page does NOT extend the round deadline', async () => {
  const h = expiryHarness()
  // Big enough that the round is still OPEN afterwards - a committed round erases its
  // deadline along with everything else, so there would be nothing to compare.
  const mb = bigMailbox({ inboxPages: 25, sentPages: 25, inboundAt: 22, outboundAt: 18 })
  const r = await h.invoke({ fetchImpl: mb.fetchImpl })
  assert.strictEqual(r.outcome, 'continued', JSON.stringify(summarizeRun(r)))
  const ends = GRAPH_FOLDERS.map((f) => h.store.folders[f].round_expires_ms)
  // ONE deadline, the same on both rows. Extending it per page is what let a round
  // outlive the records it depended on.
  assert.strictEqual(ends[0], ends[1], 'both folders must carry the same deadline')
  assert.ok(ends[0] > h.now(), 'and it must be in the future')
  // Several pages were checkpointed, and the deadline is still the adoption one.
  assert.ok(h.named('record_outlook_page_progress').length >= 3)
  assert.strictEqual(ends[0], 1_000_000 + ROUND_TTL_SECONDS * 1000)
})

test('REPRODUCED: an expired round used to get STUCK; now a new one starts', async () => {
  // BEFORE: read_outlook_round_progress reported an expired round as ABSENT, so the run
  // chose a new round id - while the old id was still on the folder rows, so every
  // checkpoint answered round_mismatch, forever. Nothing was lost (the committed cursor
  // was never touched) and nothing progressed either.
  const h = expiryHarness()
  const mb = bigMailbox({ inboxPages: 25, sentPages: 25, inboundAt: 22, outboundAt: 18 })

  // One invocation reads part of the round...
  const first = await h.invoke({ fetchImpl: mb.fetchImpl })
  assert.strictEqual(first.outcome, 'continued', JSON.stringify(summarizeRun(first)))
  const savedPages = h.store.folders.inbox.pages
  assert.ok(savedPages > 0, 'a position must have been saved')
  const oldRound = h.store.folders.inbox.round_id

  // ...then the round's deadline passes.
  h.advance(ROUND_TTL_SECONDS * 1000 + 1)

  const second = await h.invoke({ fetchImpl: mb.fetchImpl })
  const s = summarizeRun(second)
  // IT MAKES PROGRESS. Before the fix this was round_mismatch on every page.
  assert.ok(['continued', 'committed'].includes(second.outcome),
    `an expired round must not get stuck: ${JSON.stringify(s)}`)
  assert.strictEqual(s.round_expired, true, 'and it must say it threw one away')
  assert.strictEqual(s.round_reset, 'reset')
  // A NEW round, from scratch.
  assert.notStrictEqual(h.store.folders.inbox.round_id, oldRound)
  assert.strictEqual(h.store.folders.inbox.round_id, h.store.folders.sentitems.round_id)
  // No checkpoint was refused for a round mismatch.
  assert.strictEqual(h.named('record_outlook_page_progress')
    .filter((c) => c.args.p_round_id === oldRound && c.args.p_page_seq > savedPages).length, 0)
  // AND THE COMMITTED CURSOR NEVER MOVED, so the fresh round re-reads from a position
  // that genuinely was ingested: it costs pages, and skips nothing.
  for (const f of GRAPH_FOLDERS) {
    assert.strictEqual(h.store.folders[f].delta_link_ciphertext, null, f)
  }
})

test('a long import still finishes across invocations while rounds expire', async () => {
  // The point of the rule is that expiry costs re-reading, never progress. Here the
  // deadline passes part-way through, the round restarts from the committed cursor, and
  // the import still reaches exactly one suggestion.
  const h = expiryHarness()
  const mb = bigMailbox({ inboxPages: 25, sentPages: 25, inboundAt: 22, outboundAt: 18 })
  let outcome = null
  let expiries = 0
  for (let i = 0; i < 20; i += 1) {
    const r = await h.invoke({ fetchImpl: mb.fetchImpl })
    if (r.roundExpired === true) expiries += 1
    outcome = r.outcome
    if (outcome !== 'continued') break
    // The deadline passes once, in the middle of the import.
    if (i === 1) h.advance(ROUND_TTL_SECONDS * 1000 + 1)
  }
  assert.strictEqual(expiries, 1, 'exactly one round was discarded')
  assert.strictEqual(outcome, 'committed', 'and the import still finished')
  assert.strictEqual(h.writes().length, 1, 'exactly one pending suggestion')
})

test('REPRODUCED: a record cannot vanish from under a live round', async () => {
  // BEFORE: conversation records carried their OWN expires_at while every page pushed
  // round_expires_at forward, so an early two-sided exchange aged out and was deleted by
  // a later page's cleanup while the round and its saved nextLink stayed valid -
  // finalisation then listed only the survivors and committed both cursors past it.
  //
  // Records have no independent deadline now, so the only way one goes is with its round.
  const h = expiryHarness()
  // The qualifying inbound is on the FIRST inbox page, so a record exists straight away,
  // and the mailbox is big enough that the round stays open to hold it.
  const mb = bigMailbox({ inboxPages: 25, sentPages: 25, inboundAt: 1, outboundAt: 18 })
  const first = await h.invoke({ fetchImpl: mb.fetchImpl })
  assert.strictEqual(first.outcome, 'continued', JSON.stringify(summarizeRun(first)))
  const before = h.store.conversations.size
  assert.ok(before > 0, 'the exchange must be in the accumulator')
  const rows = [...h.store.conversations.values()]
  for (const row of rows) {
    assert.strictEqual('expires_at' in row, false,
      'a record must carry no deadline of its own')
  }
  // Time passes well beyond what a record used to live for, but inside the round.
  h.advance(ROUND_TTL_SECONDS * 1000 - 1000)
  await h.invoke({ fetchImpl: mb.fetchImpl })
  assert.ok(h.store.conversations.size >= before,
    'no record may be dropped while its round is live')
})

test('a round that expires MID-RUN commits nothing at all', async () => {
  const h = expiryHarness()
  seedCompletedRound(h.store, { n: 3 })
  // The seeded round is live...
  for (const f of GRAPH_FOLDERS) {
    h.store.folders[f].round_expires_ms = h.now() + 60_000
  }
  // ...but its deadline passes before finalisation can list it.
  h.advance(60_001)
  const r = await h.invoke({ fetchImpl: noGraph })
  const s = summarizeRun(r)
  // It is thrown away and a fresh round is started - which, with no Graph pages to read,
  // means this invocation simply makes no suggestion.
  assert.strictEqual(s.round_expired, true, JSON.stringify(s))
  assert.strictEqual(r.cursorsAdvanced, 0, 'NOTHING may be committed from a dead round')
  assert.strictEqual(h.writes().length, 0)
  for (const f of GRAPH_FOLDERS) {
    assert.strictEqual(h.store.folders[f].delta_link_ciphertext, null, f)
  }
  // The discarded round left no records behind.
  assert.strictEqual(h.store.conversations.size, 0)
})

test('one folder expiring expires the ROUND, not half of it', async () => {
  const h = expiryHarness()
  const mb = bigMailbox({ inboxPages: 25, sentPages: 25, inboundAt: 22, outboundAt: 18 })
  await h.invoke({ fetchImpl: mb.fetchImpl })
  const oldRound = h.store.folders.inbox.round_id
  assert.ok(oldRound)
  // The deadline is written to both rows at once, so they cannot normally differ. If they
  // ever did, the EARLIER one must govern - otherwise one folder reports a round the
  // other does not, and a run resumes half of one.
  h.store.folders.sentitems.round_expires_ms = h.now() - 1
  const r = await h.invoke({ fetchImpl: mb.fetchImpl })
  assert.strictEqual(summarizeRun(r).round_expired, true,
    'the earlier of the two deadlines must govern')
  assert.notStrictEqual(h.store.folders.inbox.round_id, oldRound)
  assert.strictEqual(h.store.folders.inbox.round_id, h.store.folders.sentitems.round_id,
    'and both folders must end up on the SAME new round')
})

test('the design records the expiry rule, its cost and its remaining limit', () => {
  assert.ok(DESIGN.includes('5d. A round expires as ONE unit'))
  // All three reproduced failures, named.
  assert.ok(DESIGN.includes('It could get stuck'))
  assert.ok(DESIGN.includes('It could skip mail'))
  assert.ok(DESIGN.includes('The two folders could disagree'))
  // The rule itself.
  assert.ok(DESIGN.includes('One deadline per round'))
  assert.ok(DESIGN.includes('Records have no deadline of their own'))
  assert.ok(DESIGN.includes('discarded as a unit'))
  // Honest about what it costs and what it does not fix.
  assert.ok(DESIGN.includes('Can a long import still make progress'))
  assert.ok(DESIGN.includes('re-reading pages from the committed cursor'))
  assert.ok(DESIGN.includes('The remaining limit, stated'))
  // And the thing that must stay open.
  assert.ok(DESIGN.includes('D2 as a decision sheet'),
    'the cross-round privacy decision must stay open')
})

test('round_expired is a controlled reason, and the TTL is still bounded', () => {
  assert.ok(ROUND_INCOMPLETE_REASONS.includes('round_expired'))
  // Bounded retention, unchanged in intent: the window runs from the round's START, so a
  // round cannot keep extending its own life by making slow progress.
  assert.ok(ROUND_TTL_SECONDS >= 3600 && ROUND_TTL_SECONDS <= 604_800)
  assert.ok(MIGRATION.includes('ONE DEADLINE, FOR THE WHOLE ROUND'))
  assert.ok(MIGRATION.includes('Later pages do NOT'),
    'the no-extension rule must be stated')
  assert.ok(MIGRATION.includes('NO expires_at'),
    'records must be documented as having no deadline of their own')
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
    'episode_truncated', 'accumulator_unreadable', 'pending_key_mismatch']) {
    assert.ok(ROUND_INCOMPLETE_REASONS.includes(r), r)
  }
  // `plan_truncated` is gone: the read-back is PAGED now, so `more rows remain` means
  // continue rather than `this round is incomplete`. The run only commits once a page
  // comes back with none left, which is stronger than the old check.
  assert.ok(!ROUND_INCOMPLETE_REASONS.includes('plan_truncated'))
  const s = summarizeRun({
    outcome: 'incomplete',
    // 'plan_truncated' is no longer a reason, so it must be filtered out alongside an
    // invented one - a stale code must never reach a log either.
    incompleteReasons: ['messages_dropped', 'something_invented', 'plan_truncated',
      'episode_truncated'],
  })
  assert.deepStrictEqual(s.incomplete_reasons,
    ['messages_dropped', 'episode_truncated'])
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

test('the design records that the WHOLE invocation is budgeted, and what still is not', () => {
  // The two stages that used to run outside the budget, and the honest verdict on each.
  assert.ok(DESIGN.includes('5a. The budget covers the WHOLE invocation'))
  assert.ok(DESIGN.includes('having read no mail and saved no checkpoint'),
    'the context-load reproduction must be recorded')
  assert.ok(DESIGN.includes('800 s'),
    'the finalisation reproduction must be recorded with its real number')
  assert.ok(DESIGN.includes('began again'))
  assert.ok(DESIGN.includes('at the first entry'))
  // The context load was listed as an enablement blocker on the strength of a ceiling.
  // It is now MEASURED, so the design must carry the numbers rather than the claim - and
  // must not quietly drop the limits the measurement does not cover.
  assert.ok(DESIGN.includes('sum of per-call timeout ceilings'),
    'the 285s figure must be explained as a ceiling, not a path')
  assert.ok(DESIGN.includes('245-268 ms') || DESIGN.includes('245–268 ms'),
    'the measured cost at the supported maximum must be recorded')
  assert.ok(DESIGN.includes('What was NOT measured: hosted latency'),
    'the measurement must state what it cannot cover')
  assert.ok(DESIGN.includes('6.7 s per call'),
    'the hosted threshold that would exhaust the budget must be stated')
  // The multiplier must be DERIVED, not asserted: 120,000 ms over 18 calls is ~6.7 s a
  // call against a measured ~14 ms, which is ~450-500x - an earlier draft said 25x.
  assert.ok(DESIGN.includes('450–500×') || DESIGN.includes('450-500x'),
    'the per-call slowdown multiplier must be the derived one')
  assert.ok(!DESIGN.includes('25× worse') && !DESIGN.includes('25x worse'),
    'the superseded 25x figure must be gone')
  assert.ok(DESIGN.includes('120,000 ms / 18 calls'),
    'the derivation must be shown so the arithmetic is checkable')
  assert.ok(DESIGN.includes('The residual, stated honestly'),
    'the liveness residual must stay visible')
  assert.ok(DESIGN.includes('Supported capacity'),
    'the supported account size must be stated')
  // And the trade-off in persisting the write cursor once per invocation is stated.
  assert.ok(DESIGN.includes('once per invocation'))
  assert.ok(DESIGN.includes('bounded rework, never a lost'))
})

test('the design records the measured read-back size and the whole-round gate', () => {
  assert.ok(DESIGN.includes('5b. The accumulator read-back is paged'))
  // The numbers that forced paging, not an estimate.
  assert.ok(DESIGN.includes('1,204,055 bytes'))
  assert.ok(DESIGN.includes('262,144 bytes'))
  assert.ok(DESIGN.includes('4.6'))
  assert.ok(DESIGN.includes('clamps'), 'the SQL must be recorded as clamping, not defaulting')
  assert.ok(DESIGN.includes('same ordered write cursor'))
  // And the regression, named as one.
  assert.ok(DESIGN.includes('5c. A shortened exchange forfeits'))
  assert.ok(DESIGN.includes('committed both cursors past an exchange it had discarded'))
  assert.ok(DESIGN.includes('cannot be a check on the page in hand'))
  assert.ok(DESIGN.includes('round_truncated_episodes'))
})

test('the cross-round decision sheet names fields, retention, deletion and wording', () => {
  // The owner has to be able to decide on specifics, not in the abstract.
  assert.ok(DESIGN.includes('D2 as a decision sheet'))
  assert.ok(DESIGN.includes('Minimum retained fields'))
  assert.ok(DESIGN.includes('Booleans, not counts'),
    'the minimum must be argued, not just listed')
  assert.ok(DESIGN.includes('90 days from'))
  assert.ok(DESIGN.includes('Alternatives worth rejecting'))
  assert.ok(DESIGN.includes('Deletion on disconnect'))
  assert.ok(DESIGN.includes('Exact privacy wording for review'))
  // It must still be a PROPOSAL: nothing implemented, and the live policy untouched.
  assert.ok(DESIGN.includes('Nothing below is implemented'))
  assert.ok(!MIGRATION.includes('inbound_seen'),
    'the cross-round fields must NOT be implemented by this branch')
  // Checked on a phrase unique to the PROPOSAL. '90 days' alone appears in the live
  // policy already - for Gmail's initial lookback window, which is unrelated.
  assert.ok(POLICY.includes('looks back roughly 90 days'),
    'sanity: the unrelated Gmail lookback is what the live policy says about 90 days')
  for (const proposed of ['whether each side has replied',
    'after the last message it saw', 'recognize a reply that arrives later']) {
    assert.ok(!POLICY.includes(proposed),
      `the proposed retention wording must not be published: ${proposed}`)
  }
  // The readiness packet must point at it, so the decision is not buried in a design doc.
  assert.ok(READINESS.includes('decision sheet'))
  assert.ok(READINESS.includes('expire_pending_outlook_context'),
    'approving it would add a second expiry path while the first is unscheduled')
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
