// One reviewable Outlook suggestion: the run logic, the write contract, and the
// review surface.
//
// WHAT IS EXERCISED HERE, AND WHAT IS NOT - stated precisely, because the difference
// is the whole point of the slice.
//
//   EXERCISED, pure logic: runOutlookImport is driven end to end against a recording
//   fake RPC port, so the ORDER that matters is executed - suggestions written before
//   the cursor-advancing release, nothing written and no cursor supplied on an
//   incomplete pass, and a refused write downgrading the run to incomplete.
//
//   EXERCISED, real React render: InteractionSourceBadge is transformed with the
//   repo's own oxc transform (via vite, already a devDependency) and rendered with
//   react-dom/server. So "an Outlook suggestion is labelled Outlook, with an
//   accessible name, and a non-provider source renders no badge at all" is executed,
//   not scanned.
//
//   NOT EXERCISED - STRUCTURAL SCANS ONLY. renderToStaticMarkup produces markup and
//   dispatches no events, and this repo carries no JSDOM or React testing library. So
//   these remain source assertions:
//     * that SuggestionsPage renders the badge for a row,
//     * that its edit inputs are bound to the override fields it sends,
//     * that clicking Accept/Dismiss calls the RPCs.
//   The accept-with-edits ACTION is instead executed at the data layer, over real
//   HTTP through real PostgREST, by tests/local/outlook-first-suggestion.mjs - which
//   is where a click would end up anyway.
//
//   NOT COVERED AT ALL HERE: the database. Migration behaviour, lease fencing and
//   deduplication are proven against a real Postgres by that same harness.
//
// Run with: node tests/outlook-first-suggestion.test.js

import assert from 'node:assert'
import { makeRoundStore } from './harness/outlookRoundStore.js'
import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transformWithOxc } from 'vite'
import {
  LEASE_SECONDS, DUE_AFTER_SECONDS, RETRY_BACKOFF_SECONDS, CONTINUE_BACKOFF_SECONDS,
  RUN_OUTCOMES,
  ENTRY_SKIP_CODES, WRITE_OK, writeAccepted, releaseConfirmed, partitionPlan,
  runOutlookImport, summarizeRun,
} from '../supabase/functions/shared/outlookImportRun.js'
import {
  SOURCE_PROVIDERS, getSourceProvider, isValidInteractionSource,
} from '../src/lib/interactionSource.js'
import {
  outlookReviewEnabled, suggestionReviewEnabled, OUTLOOK_REVIEW_ENABLED,
  SUGGESTION_REVIEW_ENABLED,
} from '../src/lib/suggestionReview.js'
import { CANDIDATE_SELECT, validateOverrides } from '../src/lib/calendarReview.js'
import {
  SUGGESTION_EVENTS, SUGGESTION_SOURCES, suggestionSourceLabel, suggestionEventProps,
} from '../src/lib/suggestionAnalytics.js'

/**
 * Every run now reads and writes ROUND PROGRESS, so this suite's port is wrapped: the
 * round-progress RPCs answer from an in-memory mirror of migration 20261002000000 and
 * everything else falls through and is still recorded in `p.calls`. The mirror is a
 * convenience - the real SQL is exercised by tests/sql/outlook-durable-continuation-
 * runtime.sql and by the Docker harness.
 */
function withRounds (innerRpc, store) {
  return async (name, args) => {
    const fromStore = await store.handle(name, args)
    if (fromStore !== null) return fromStore
    const res = await innerRpc(name, args)
    if (name === 'release_outlook_sync_lease' && args?.p_run_complete === true
        && res?.data === true) store.commitRelease()
    return res
  }
}

// `encryptCursor` in this suite wraps the link as CT(<link>); the decryptor undoes that,
// so a test can assert WHICH link a resumed request used.
const DECRYPT_CURSOR = async (ct) => String(ct).replace(/^CT\(/, '').replace(/\)$/, '')

let passed = 0, failed = 0
const pending = []
function test (name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { console.log(`  ✓ ${name}`); passed++ },
        (e) => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ },
      ))
    } else { console.log(`  ✓ ${name}`); passed++ }
  } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const RUN_SRC = read('supabase/functions/shared/outlookImportRun.js')
const MIGRATION = read('supabase/migrations/20260930000000_outlook_interaction_candidate_write.sql')
const PAGE = read('src/pages/SuggestionsPage.jsx')
const BADGE_SRC = read('src/components/InteractionSourceBadge.jsx')
const GATE_SRC = read('src/lib/suggestionReview.js')
const ENTRY = read('src/components/SuggestionsEntry.jsx')
const codeOnly = (src) => src.split(String.fromCharCode(10))
  .filter((l) => !/^[ ]*([/][/]|[*]|[/][*])/.test(l)).join(String.fromCharCode(10))

// ── a real JSX render, using the repo's own transform ─────────────────────────
// Bare and relative specifiers are rewritten to absolute URLs because a data: module
// cannot resolve either. No file is written and nothing in src/ is touched.
async function loadComponent (relPath) {
  const abs = resolve(dirname(new URL(import.meta.url).pathname.slice(1)), '..', relPath)
  const out = await transformWithOxc(readFileSync(abs, 'utf8'), abs,
    { lang: 'jsx', jsx: { runtime: 'automatic' } })
  const code = out.code.replace(/(from\s*)"([^"]+)"/g, (m, kw, spec) => {
    if (spec.startsWith('.')) {
      let t = resolve(dirname(abs), spec)
      for (const ext of ['', '.js', '.jsx']) { if (existsSync(t + ext)) { t = t + ext; break } }
      return `${kw}"${pathToFileURL(t).href}"`
    }
    return `${kw}"${import.meta.resolve(spec)}"`
  })
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

// ── a recording RPC port ─────────────────────────────────────────────────────

const CONN = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const RUN = 'rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr'
const CONTACT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
// A real uuid, because microsoft_connections.user_id IS one and the pilot gate requires
// the designated account to be uuid-shaped - that shape check is what stops an empty
// string or a '*' reading as `everyone`.
const OWNER = '11111111-1111-1111-1111-111111111111'

function planEntry (over = {}) {
  return {
    kind: 'known_contact_interaction',
    contactId: CONTACT,
    counterparty: 'ava@bank.test',
    displayName: 'Ava',
    proposedType: 'Email',
    proposedDate: '2026-09-21',
    inbound: 1,
    outbound: 1,
    messageCount: 2,
    episodeFingerprint: 'e'.repeat(64),
    episodeLookupFingerprints: [],
    personFingerprint: 'p'.repeat(64),
    keyVersion: 1,
    ...over,
  }
}

/** A fake port that records every call and answers from a script. */
function port ({ reserve, writes = ['created'], release = true } = {}) {
  const calls = []
  let writeAt = 0
  const rpc = async (name, args) => {
    calls.push({ name, args })
    if (name === 'reserve_due_outlook_connection') {
      return reserve ?? { data: { result: 'reserved', connection_id: CONN, user_id: OWNER, run_id: RUN }, error: null }
    }
    if (name === 'upsert_outlook_interaction_candidate') {
      const r = writes[Math.min(writeAt, writes.length - 1)]
      writeAt += 1
      return typeof r === 'object' ? r : { data: { result: r }, error: null }
    }
    // A long fixture run triggers a renewal; confirming it keeps the run alive.
    if (name === 'renew_outlook_sync_lease') return { data: true, error: null }
    if (name === 'release_outlook_sync_lease') return { data: release, error: null }
    throw new Error(`unexpected RPC: ${name}`)
  }
  return { calls, rpc }
}

/**
 * runOutlookImport calls runOutlookMetadataPass directly, so the pass is driven with a
 * fixture fetch serving one two-sided exchange. That keeps the module under test
 * unmodified rather than adding a seam only a test would use.
 */
function graphFixture ({ complete = true } = {}) {
  const base = 'https://graph.microsoft.com/v1.0'
  const addr = (e) => ({ emailAddress: { address: e, name: e.split('@')[0] } })
  const m = (id, from, to, sent) => ({
    id, conversationId: 'conv-1', receivedDateTime: sent, sentDateTime: sent, isDraft: false,
    subject: 'Following up', from: addr(from), sender: addr(from),
    toRecipients: to.map(addr), ccRecipients: [],
  })
  const ME = 'student@getfunnl.test'
  const OTHER = 'ava@bank.test'
  return async (url) => ({
    status: 200,
    headers: { get: () => null },
    json: async () => {
      if (url.includes('/mailFolders/inbox/')) {
        return {
          value: [m('in-1', OTHER, [ME], '2026-09-20T14:00:00Z')],
          '@odata.deltaLink': `${base}/me/mailFolders/inbox/messages/delta?$deltatoken=A`,
        }
      }
      const sent = { value: [m('out-1', ME, [OTHER], '2026-09-21T09:00:00Z')] }
      return complete
        ? { ...sent, '@odata.deltaLink': `${base}/me/mailFolders/sentitems/messages/delta?$deltatoken=B` }
        : { ...sent, '@odata.nextLink': `${base}/me/mailFolders/sentitems/messages/delta?$skiptoken=n` }
    },
  })
}

/** Three distinct two-sided episodes, so three writes are intended. */
function threeEpisodeFixture () {
  const base = 'https://graph.microsoft.com/v1.0'
  const addr = (e) => ({ emailAddress: { address: e, name: e.split('@')[0] } })
  const ME = 'student@getfunnl.test'
  const OTHER = 'ava@bank.test'
  const m = (id, conv, from, to, sent) => ({
    id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
    subject: 'Following up', from: addr(from), sender: addr(from),
    toRecipients: to.map(addr), ccRecipients: [],
  })
  const convs = ['c1', 'c2', 'c3']
  return async (url) => ({
    status: 200,
    headers: { get: () => null },
    json: async () => (url.includes('/mailFolders/inbox/')
      ? {
          value: convs.map((c, i) => m(`in-${i}`, c, OTHER, [ME], '2026-09-20T14:00:00Z')),
          '@odata.deltaLink': `${base}/me/mailFolders/inbox/messages/delta?$deltatoken=A`,
        }
      : {
          value: convs.map((c, i) => m(`out-${i}`, c, ME, [OTHER], '2026-09-21T09:00:00Z')),
          '@odata.deltaLink': `${base}/me/mailFolders/sentitems/messages/delta?$deltatoken=B`,
        }),
  })
}

function context (contacts) {
  return async () => ({
    primaryEmail: 'student@getfunnl.test',
    aliases: [],
    timeZone: 'UTC',
    userId: OWNER,
    contacts,
    cursors: { inbox: null, sentitems: null },
    accessToken: 'fixture',
    keyRing: { current: { keyBytes: new Uint8Array(32).fill(3), keyVersion: 1 } },
  })
}
const OWN_CONTACT = [{ id: CONTACT, user_id: OWNER, email: 'ava@bank.test' }]

const encryptCursor = async (link) => ({
  ciphertext: `CT(${link.length})`, nonce: 'NONCE', keyVersion: 1,
})

console.log('\nthe run writes the suggestion BEFORE it advances the cursor')

test('a commit-ready pass writes one suggestion, then releases with both cursors', async () => {
  const p = port()
  const r = await runOutlookImport({
    rpc: withRounds(p.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  assert.strictEqual(r.outcome, 'committed', JSON.stringify(summarizeRun(r)))
  assert.strictEqual(r.intended, 1)
  assert.strictEqual(r.accepted, 1)
  assert.strictEqual(r.created, 1)
  const names = p.calls.map((c) => c.name)
  // Every round-progress RPC - including the call that records how far finalisation got -
  // answers from the in-memory mirror, so only these three reach this port. What must be
  // visible here is their ORDER: the suggestion is written before the release that
  // advances the cursors. (That the finalisation cursor also lands before the release is
  // asserted in tests/outlook-durable-continuation.test.js, where the mirror is inspected.)
  assert.deepStrictEqual(names, [
    'reserve_due_outlook_connection',
    'upsert_outlook_interaction_candidate',
    'release_outlook_sync_lease',
  ], 'the write must precede the cursor-advancing release')
  const rel = p.calls.at(-1).args
  assert.strictEqual(rel.p_run_complete, true)
  assert.ok(rel.p_inbox_delta_ct && rel.p_sentitems_delta_ct, 'both cursors supplied')
  assert.strictEqual(rel.p_retry_backoff_seconds, null)
})

test('the cursor reaching the database is the ENCRYPTED value, never the link', async () => {
  const p = port()
  await runOutlookImport({
    rpc: withRounds(p.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  const rel = p.calls.at(-1).args
  for (const v of [rel.p_inbox_delta_ct, rel.p_sentitems_delta_ct]) {
    assert.ok(v.startsWith('CT('), 'the raw deltaLink must not be sent')
    assert.ok(!v.includes('deltatoken') && !v.includes('graph.microsoft.com'))
  }
  assert.strictEqual(rel.p_delta_key_version, 1)
})

test('with the consent gates CLOSED the write carries a NULL note, never a placeholder', async () => {
  // This guard used to assert `p_proposed_notes` was absent entirely, which was the
  // right statement while there was no content path at all. The content slice adds
  // the parameter, so the invariant moves rather than relaxes: with the gates closed
  // the argument must be present and NULL. Null is what the RPC coalesces against
  // whatever note is already stored, so a run with no content can never blank one -
  // and it is emphatically not a placeholder string, which is the defect the whole
  // slice exists to avoid.
  const p = port()
  const r = await runOutlookImport({
    rpc: withRounds(p.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  const w = p.calls.find((c) => c.name === 'upsert_outlook_interaction_candidate').args
  assert.match(w.p_episode_fingerprint, /^[0-9a-f]{64}$/)
  assert.match(w.p_person_fingerprint, /^[0-9a-f]{64}$/)
  assert.strictEqual(w.p_proposed_type, 'Email')
  assert.strictEqual(w.p_contact_id, CONTACT)
  assert.strictEqual(w.p_proposed_notes, null, 'NULL, not a placeholder note')
  // Nothing from a body or a draft may be carried while the gates are closed.
  for (const forbidden of ['p_retained_subject', 'p_draft_summary',
    'p_draft_follow_up', 'p_subject', 'p_body', 'p_proposed_email']) {
    assert.strictEqual(w[forbidden], undefined, `the write must not carry ${forbidden}`)
  }
  // Nor an address or a provider id, even as an argument name.
  assert.ok(!JSON.stringify(w).includes('ava@bank.test'))
  assert.ok(!JSON.stringify(w).includes('in-1'))
  // AND THE ABSENCE IS EXPLAINED. A missing note must never be silent.
  assert.strictEqual(r.content.deferred.content_consent_missing, 1, JSON.stringify(r.content))
  assert.strictEqual(r.content.attempted, 0, 'and nothing was read to produce it')
  assert.strictEqual(r.content.bodies_read, 0)
  assert.strictEqual(r.content.model_calls, 0)
  assert.strictEqual(r.content.notes_written, 0)
  // No handle was stored either: the envelope-only consent does not authorize one.
  assert.strictEqual(r.handleReason, 'content_consent_missing')
  assert.strictEqual(r.handlesStored, 0)
  // And the candidate write still happened, so the suggestion is not lost.
  assert.strictEqual(r.content.metadata_only, 1)
  assert.ok(!p.calls.some((c) => c.name === 'upsert_new_contact_candidate'))
  assert.ok(!p.calls.some((c) => c.name === 'list_outlook_round_message_handles'),
    'and not one handle read was attempted')
})

console.log('\nan incomplete pass writes nothing and advances nothing')

test('no candidate write is attempted at all, and the release carries no cursor', async () => {
  const p = port()
  const r = await runOutlookImport({
    rpc: withRounds(p.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture({ complete: false }) },
  })
  // CHANGED BY DURABLE CONTINUATION, and this is the improvement. Inbox finished and Sent
  // Items did not: before, that was 'incomplete' forever, because every run restarted from
  // the same cursor, read the same pages and committed nothing - safe, but making no
  // progress. Now the folder reads until the per-INVOCATION cap, saves where it got to, and
  // reports 'continued' so a later invocation carries on.
  //
  // What has NOT changed is the point of the test: no candidate is written from a half-read
  // round, and NEITHER cursor advances - not even Inbox's, which did finish, because a
  // conversation can span both folders.
  assert.strictEqual(r.outcome, 'continued', JSON.stringify(summarizeRun(r)))
  assert.strictEqual(r.intended, 0)
  assert.strictEqual(r.accepted, 0)
  assert.strictEqual(r.created, 0)
  assert.strictEqual(r.cursorsAdvanced, 0)
  assert.ok(!p.calls.some((c) => c.name === 'upsert_outlook_interaction_candidate'),
    'a half-read round must not attempt a write')
  const rel = p.calls.at(-1).args
  assert.strictEqual(rel.p_run_complete, false)
  for (const k of ['p_inbox_delta_ct', 'p_inbox_delta_nonce',
    'p_sentitems_delta_ct', 'p_sentitems_delta_nonce', 'p_delta_key_version']) {
    assert.strictEqual(rel[k], null, k)
  }
  // A SHORTER backoff than a failure gets, on purpose: the round is healthy and half-read,
  // so the sooner something calls the worker again the sooner it finishes. Nothing here
  // calls it - there is still no scheduler - this only stops a connection with work waiting
  // being marked not-due for five minutes.
  assert.strictEqual(rel.p_retry_backoff_seconds, CONTINUE_BACKOFF_SECONDS)
  assert.ok(CONTINUE_BACKOFF_SECONDS < RETRY_BACKOFF_SECONDS)
})

test('a REFUSED write downgrades the whole run: no cursor, retry later', async () => {
  const p = port({ writes: ['stale_run'] })
  const r = await runOutlookImport({
    rpc: withRounds(p.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  assert.strictEqual(r.outcome, 'write_failed')
  assert.strictEqual(r.refusal, 'stale_run')
  assert.strictEqual(r.intended, 1)
  assert.strictEqual(r.accepted, 0, 'the only write was refused')
  assert.strictEqual(r.created, 0)
  const rel = p.calls.at(-1).args
  assert.strictEqual(rel.p_run_complete, false)
  assert.strictEqual(rel.p_inbox_delta_ct, null,
    'a cursor must never move past a suggestion that failed to persist')
})

test('refreshed and exists_terminal are SUCCESS; anything else is not', () => {
  assert.deepStrictEqual([...WRITE_OK], ['created', 'refreshed', 'exists_terminal'])
  for (const ok of WRITE_OK) assert.strictEqual(writeAccepted(ok), true, ok)
  for (const bad of ['stale_run', 'unknown_connection', 'contact_not_owned', 'invalid_type',
    'contact_required', 'rpc_error', 'unknown', '', null, undefined]) {
    assert.strictEqual(writeAccepted(bad), false, String(bad))
  }
})

test('a tombstoned exchange still lets the run commit', async () => {
  // The user dismissed it. Nothing is unpersisted, so the cursor may advance.
  const p = port({ writes: ['exists_terminal'] })
  const r = await runOutlookImport({
    rpc: withRounds(p.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  assert.strictEqual(r.outcome, 'committed')
  assert.strictEqual(p.calls.at(-1).args.p_run_complete, true)
})

test('nothing due takes no lease and performs no other call', async () => {
  const p = port({ reserve: { data: { result: 'none_due' }, error: null } })
  const r = await runOutlookImport({
    rpc: withRounds(p.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  assert.strictEqual(r.outcome, 'none_due')
  assert.deepStrictEqual(p.calls.map((c) => c.name), ['reserve_due_outlook_connection'])
})

test('a thrown pass releases the lease as an error rather than holding it', async () => {
  const p = port()
  const r = await runOutlookImport({
    rpc: withRounds(p.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: async () => { throw new Error('token fetch failed at https://secret') },
    deps: { fetchImpl: graphFixture() },
  })
  assert.strictEqual(r.outcome, 'released_error')
  const rel = p.calls.at(-1)
  assert.strictEqual(rel.name, 'release_outlook_sync_lease')
  assert.strictEqual(rel.args.p_status, 'error')
  assert.strictEqual(rel.args.p_error_code, 'pass_failed')
  assert.ok(!JSON.stringify(rel.args).includes('secret'),
    'a thrown message can contain a URL and must never be forwarded')
})

test('the lease and due windows are inside the RPC\'s own bounds', () => {
  assert.ok(LEASE_SECONDS >= 1 && LEASE_SECONDS <= 600)
  assert.ok(DUE_AFTER_SECONDS >= 0 && DUE_AFTER_SECONDS <= 2592000)
  assert.ok(RETRY_BACKOFF_SECONDS >= 0 && RETRY_BACKOFF_SECONDS <= 604800)
})

console.log('\nonly an existing contact can become a suggestion')

test('a new-contact entry is skipped with a controlled code, never written', () => {
  const { writable, skipped } = partitionPlan([
    planEntry(),
    planEntry({ kind: 'new_contact_suggestion', contactId: null }),
    planEntry({ contactId: null }),
  ])
  assert.strictEqual(writable.length, 1)
  assert.strictEqual(skipped.new_contact_not_supported, 1)
  assert.strictEqual(skipped.missing_contact, 1)
  for (const c of Object.keys(skipped)) assert.ok(ENTRY_SKIP_CODES.includes(c), c)
})

test('partitionPlan tolerates junk without throwing', () => {
  for (const junk of [null, undefined, 'x', 42, {}]) {
    const r = partitionPlan(junk)
    assert.deepStrictEqual(r.writable, [])
  }
})

test('the migration refuses a contactless write rather than inventing a person', () => {
  assert.ok(/p_contact_id IS NULL/.test(MIGRATION))
  assert.ok(/'contact_required'/.test(MIGRATION))
  assert.ok(/contact_not_owned/.test(MIGRATION), 'and refuses a contact owned by someone else')
})

console.log('\nthe write path is Outlook-specific and lease-fenced')

test('the migration fences on outlook_sync_state, never on the Gmail tables', () => {
  assert.ok(/FROM public\.outlook_sync_state s/.test(MIGRATION))
  assert.ok(/FROM public\.microsoft_connections c WHERE c\.id = p_connection_id/.test(MIGRATION),
    'the owner comes from the Microsoft connection')
  // The fence requires BOTH folder rows to belong to the same live run, matching
  // reserve_due_outlook_connection and invalidate_outlook_candidates_by_fingerprint.
  assert.ok(/count\(\*\) = 2 AND bool_and\(s\.sync_run_id = p_run_id/.test(MIGRATION),
    'one folder lease must not be enough')
  assert.ok(!/AND s\.folder = 'inbox'/.test(MIGRATION),
    'the single-folder fence must be gone')
  // Both state rows locked FOR SHARE first, as the invalidation RPC does. Checked as
  // substrings rather than one multi-line pattern, which is easy to get wrong.
  assert.ok(MIGRATION.includes('PERFORM 1 FROM public.outlook_sync_state s'))
  assert.ok(MIGRATION.includes('WHERE s.connection_id = p_connection_id FOR SHARE;'),
    'the lock must cover BOTH folder rows, not one named row')
  assert.ok(/sync_lease_until > now\(\)/.test(MIGRATION))
  assert.ok(/'stale_run'/.test(MIGRATION))
  const code = MIGRATION.split(String.fromCharCode(10))
    .filter((l) => !/^\s*--/.test(l)).join(String.fromCharCode(10))
  for (const gmail of ['gmail_sync_state', 'google_connections', 'email_candidate_refs']) {
    assert.ok(!code.includes(gmail), `a Microsoft connection must not touch ${gmail}`)
  }
})

test('the run module calls only the permitted RPCs', () => {
  // SCANNED ACROSS BOTH FILES, because the write is now dispatched by name:
  // planContentWrite returns the RPC to call, so the run's own source does not
  // contain either candidate-write literal. Scanning only the run would make this
  // guard pass vacuously while the set of reachable functions had grown.
  const STAGE_SRC = read('supabase/functions/shared/outlookContentStage.js')
  const names = [...new Set([
    ...[...codeOnly(RUN_SRC).matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]),
    // The stage names its two writes through a frozen allowlist and its read
    // through a constant, so those are read from the constants themselves.
    ...[...codeOnly(STAGE_SRC).matchAll(/'(upsert_[a-z_]+|list_outlook_[a-z_]+)'/g)]
      .map((m) => m[1]),
  ])]
  // And the dynamic call site must be fenced to that allowlist, or "dispatch by
  // name" would mean "call any database function a planner returns".
  assert.ok(/CONTENT_WRITE_RPCS\.includes\(plan\.rpc\)/.test(codeOnly(RUN_SRC)),
    'the run must check the name against the allowlist before dispatching')
  // EIGHT now. Four were there before: reserve, renew (a long run must renew or lose
  // its claim), the candidate write, and release. Durable continuation added four, and
  // each is one narrow job:
  //   read_outlook_round_progress      where did the last invocation get to?
  //   record_outlook_page_progress     ONE atomic checkpoint per Graph page
  //   list_outlook_round_conversations read the accumulator back to finalize
  //   reset_outlook_round              the controlled restart after a rejected nextLink
  //   advance_outlook_round_write_cursor  how far finalising the round's suggestions got,
  //                                     so a batch bigger than one invocation resumes
  // Nothing else may be called from here: no scheduler, no job table, no generic
  // key-value store.
  assert.deepStrictEqual(names.sort(), [
    'advance_outlook_round_write_cursor',
    'list_outlook_round_conversations',
    // The content slice added two, and each is one narrow job:
    //   list_outlook_round_message_handles  the stored handles for ONE conversation
    //   upsert_new_contact_candidate        the proposal for someone not yet tracked
    'list_outlook_round_message_handles',
    'read_outlook_round_progress',
    'record_outlook_page_progress',
    // Background sync added ONE: the change-notification subscription the run keeps alive,
    // recorded through an RPC fenced on the run id like every other worker write.
    'record_outlook_subscription_state',
    'release_outlook_sync_lease', 'renew_outlook_sync_lease',
    'reserve_due_outlook_connection', 'reset_outlook_round',
    'upsert_new_contact_candidate',
    'upsert_outlook_interaction_candidate',
  ])
  assert.ok(!codeOnly(RUN_SRC).includes('upsert_email_candidate'))
  assert.ok(!codeOnly(STAGE_SRC).includes('upsert_email_candidate'))
})

test('the write RPC is service_role only, so a user cannot manufacture a suggestion', () => {
  assert.ok(/REVOKE ALL ON FUNCTION public\.upsert_outlook_interaction_candidate\([\s\S]*?\)\s*FROM PUBLIC, anon, authenticated;/.test(MIGRATION))
  assert.ok(/GRANT EXECUTE ON FUNCTION public\.upsert_outlook_interaction_candidate\([\s\S]*?\)\s*TO service_role;/.test(MIGRATION))
  assert.ok(/SECURITY DEFINER/.test(MIGRATION) && /SET search_path = ''/.test(MIGRATION))
  assert.ok(/NOT APPLIED/.test(MIGRATION))
})

test('the migration creates no interaction and touches no contact', () => {
  const code = MIGRATION.split(String.fromCharCode(10))
    .filter((l) => !/^\s*--/.test(l)).join(String.fromCharCode(10))
  assert.ok(!/INSERT INTO public\.interactions/.test(code),
    'only the user\'s accept RPC may create an interaction')
  assert.ok(!/UPDATE public\.contacts/.test(code))
  assert.ok(!/DELETE FROM public\.contacts/.test(code))
  // It writes exactly two tables.
  const inserts = [...code.matchAll(/INSERT INTO public\.([a-z_]+)/g)].map((m) => m[1]).sort()
  assert.deepStrictEqual(inserts, ['interaction_candidates', 'outlook_candidate_refs'])
})

test('the suggestion is created with every content column left NULL', () => {
  const insert = MIGRATION.slice(MIGRATION.indexOf('INSERT INTO public.interaction_candidates'))
    .slice(0, 600)
  for (const col of ['proposed_notes', 'retained_subject', 'draft_summary',
    'draft_follow_up', 'summary_evidence', 'extraction_status']) {
    assert.ok(!insert.includes(col), `${col} must not be written by a metadata pass`)
  }
  assert.ok(insert.includes("'pending'"))
  assert.ok(insert.includes("'outlook'"))
})

console.log('\nthe log summary carries no identifier or fingerprint')

test('summarizeRun reports counts and controlled codes only', async () => {
  const p = port()
  const r = await runOutlookImport({
    rpc: withRounds(p.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  const s = JSON.stringify(summarizeRun(r))
  for (const secret of [CONN, CONTACT, 'ava@bank.test', 'student@getfunnl.test',
    'Following up', 'deltatoken', 'CT(']) {
    assert.ok(!s.includes(secret), `the summary leaked: ${secret}`)
  }
  assert.ok(!/[0-9a-f]{64}/.test(s), 'the summary leaked a fingerprint')
  assert.strictEqual(summarizeRun(r).outcome, 'committed')
  assert.strictEqual(summarizeRun(r).accepted, 1)
  assert.strictEqual(summarizeRun(r).created, 1)
  assert.strictEqual(summarizeRun(r).intended, 1)
})

test('summarizeRun normalises an unknown outcome and tolerates junk', () => {
  assert.strictEqual(summarizeRun({ outcome: 'something_new' }).outcome, 'released_error')
  for (const junk of [null, undefined, 'x', 7]) {
    assert.ok(RUN_OUTCOMES.includes(summarizeRun(junk).outcome))
  }
})

console.log('\nthe review surface: EXERCISED by a real render')

test('an Outlook suggestion renders an Outlook badge with an accessible name', async () => {
  const mod = await loadComponent('src/components/InteractionSourceBadge.jsx')
  const html = renderToStaticMarkup(createElement(mod.default, { source: 'outlook' }))
  assert.ok(html.includes('>Outlook<'), `visible label missing: ${html.slice(0, 160)}`)
  assert.ok(html.includes('aria-label="Source: Outlook"'))
  assert.ok(html.includes('data-source="outlook"'))
  assert.ok(html.includes('<svg'), 'the glyph must render')
  assert.ok(html.includes('aria-hidden="true"'), 'and be hidden from assistive tech')
})

test('a non-provider source renders NO badge at all', async () => {
  const mod = await loadComponent('src/components/InteractionSourceBadge.jsx')
  for (const s of ['manual', 'gmail', 'Outlook', ' outlook', '', undefined, null]) {
    assert.strictEqual(renderToStaticMarkup(createElement(mod.default, { source: s })), '',
      `${JSON.stringify(s)} must render nothing`)
  }
})

test('the calendar badge is unchanged by the Outlook addition', async () => {
  const mod = await loadComponent('src/components/InteractionSourceBadge.jsx')
  const html = renderToStaticMarkup(createElement(mod.default, { source: 'google_calendar' }))
  assert.ok(html.includes('>Google Calendar<'))
  assert.ok(html.includes('aria-label="Source: Google Calendar"'))
})

test('the Outlook glyph claims no Microsoft branding', () => {
  assert.ok(/NOT Microsoft's Outlook product icon/.test(BADGE_SRC),
    'the temporary-glyph rule must be recorded, as it is for the calendar mark')
  assert.ok(/brand guidelines/.test(BADGE_SRC))
  const provider = SOURCE_PROVIDERS.outlook
  for (const s of [provider.label, provider.ariaLabel, provider.title]) {
    assert.ok(!/Microsoft 365|Office 365|®|™/.test(s), s)
  }
  // The registry is what the badge reads, so assert the resolution too.
  assert.strictEqual(getSourceProvider('outlook').label, 'Outlook')
  assert.strictEqual(getSourceProvider('gmail'), null, 'gmail is valid but not presented')
  assert.strictEqual(isValidInteractionSource('outlook'), true,
    'an accepted Outlook suggestion writes interactions.source = outlook')
})

console.log('\nthe review surface: the gate, and what stays a source scan')

test('the gate is source-neutral and OFF in every environment', () => {
  assert.strictEqual(outlookReviewEnabled('true'), true)
  for (const v of ['TRUE', 'True', '1', 'yes', '', ' true', 'true ', null, undefined, true]) {
    assert.strictEqual(outlookReviewEnabled(v), false, String(v))
  }
  assert.strictEqual(suggestionReviewEnabled({ calendar: false, outlook: false }), false)
  assert.strictEqual(suggestionReviewEnabled({ calendar: true, outlook: false }), true)
  assert.strictEqual(suggestionReviewEnabled({ calendar: false, outlook: true }), true)
  // In Node, import.meta.env is undefined, so both resolve to the fail-safe default -
  // which is also their value in every real environment today.
  assert.strictEqual(OUTLOOK_REVIEW_ENABLED, false)
  assert.strictEqual(SUGGESTION_REVIEW_ENABLED, false)
})

test('the review flag is separate from the CONNECT flag', () => {
  assert.ok(/VITE_OUTLOOK_REVIEW_ENABLED/.test(GATE_SRC))
  assert.ok(/Separate from VITE_OUTLOOK_CONNECTION_ENABLED/.test(GATE_SRC),
    'connecting a mailbox and reviewing its output are different decisions')
})

test('STRUCTURAL ONLY: the page renders the badge and binds the edit fields', () => {
  // renderToStaticMarkup cannot dispatch events and this repo has no JSDOM, so these
  // are source assertions. The accept-with-edits ACTION is executed instead at the
  // data layer by tests/local/outlook-first-suggestion.mjs.
  assert.ok(/InteractionSourceBadge/.test(PAGE), 'the badge must be rendered per row')
  assert.ok(/source=\{/.test(PAGE), 'and given the row source')
  assert.ok(/accept_interaction_candidate/.test(PAGE))
  assert.ok(/dismiss_interaction_candidate/.test(PAGE))
  assert.ok(/p_override_type/.test(PAGE) && /p_override_date/.test(PAGE) && /p_override_notes/.test(PAGE),
    'the edits must reach the accept RPC')
  assert.ok(/validateOverrides/.test(PAGE), 'and be validated before it is called')
})

test('the queue is source-neutral: it never filters on source', () => {
  assert.ok(/\.eq\('status', 'pending'\)/.test(PAGE))
  assert.ok(!/\.eq\('source'/.test(PAGE), 'an Outlook row must not be filtered out')
  assert.ok(CANDIDATE_SELECT.includes('source'), 'and the source must be selected so it can be labelled')
})

test('the selected columns still exclude every identifier', () => {
  for (const forbidden of ['source_fingerprint', 'user_id', 'interaction_id', 'context_expires_at']) {
    assert.ok(!CANDIDATE_SELECT.includes(forbidden), `the queue must not select ${forbidden}`)
  }
})

test('an Outlook row with no proposed note is valid to accept, with the user\'s own note', () => {
  // The row Funnl writes has proposed_notes NULL. The user supplies the note, and the
  // client validator must accept both an empty and a real note.
  assert.deepStrictEqual(validateOverrides({ type: 'Email', date: '2026-09-21', notes: null }), { ok: true })
  assert.deepStrictEqual(
    validateOverrides({ type: 'Coffee chat', date: '2026-09-22', notes: 'She offered a referral.' }),
    { ok: true })
  assert.strictEqual(validateOverrides({ type: 'Nope', date: '2026-09-21' }).ok, false)
})

console.log('\nno Anthropic, no body, no scheduling in this slice')

test('the run module touches no body, no Anthropic and no scheduler', () => {
  const code = codeOnly(RUN_SRC)
  // The run now reaches the provider THROUGH outlookContentStage, so the invariant
  // is no longer "the word does not appear". It is that the run itself builds no
  // provider request and holds no provider credential in any form it could leak:
  // no URL, no header name, no request builder. The key passes through as one
  // opaque parameter, and the grep below proves it is never interpolated anywhere.
  for (const banned of ['api.anthropic.com', 'x-api-key', 'anthropic-version',
    'buildDraftRequest', 'callDraftModel', 'buildDraftHeaders',
    'buildMessageContentRequest', 'uniqueBody',
    'outlookDraftContract', 'outlookContentSanitizer', 'cron', 'setInterval']) {
    assert.ok(!code.includes(banned), `the run must not reference ${banned}`)
  }
  assert.ok(/contentFetches: 0/.test(RUN_SRC) || /metadata/.test(RUN_SRC))
})

test('no file under src/ mentions a service-role key', () => {
  for (const f of ['src/lib/suggestionReview.js', 'src/lib/interactionSource.js',
    'src/pages/SuggestionsPage.jsx', 'src/components/InteractionSourceBadge.jsx']) {
    assert.ok(!/service_role|SERVICE_ROLE|serviceRoleKey/.test(read(f)), f)
  }
})

console.log('')
console.log('COMMITTED requires the release RPC to confirm success')

test('releaseConfirmed is the narrow reading: no error AND data === true', () => {
  assert.strictEqual(releaseConfirmed({ data: true, error: null }), true)
  for (const bad of [
    { data: false, error: null },          // the RPC answered false: lease lost
    { data: null, error: null },
    { data: 'true', error: null },
    { data: 1, error: null },
    { data: true, error: { code: 'x' } },  // transport error alongside a body
    { data: undefined, error: undefined },
    null, undefined, {},
  ]) {
    assert.strictEqual(releaseConfirmed(bad), false, JSON.stringify(bad))
  }
})

test('a release returning FALSE is release_failed, not committed', async () => {
  // release_outlook_sync_lease returns false without raising when the run id is null or
  // no row matched - exactly the lost-lease case. An earlier version reported committed
  // with two cursors advanced here.
  const p = port({ release: false })
  const r = await runOutlookImport({
    rpc: withRounds(p.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  assert.strictEqual(r.outcome, 'release_failed')
  assert.strictEqual(r.cursorsAdvanced, 0, 'the cursor state is UNKNOWN, so claim nothing')
  // The write DID land, and that is reported honestly.
  assert.strictEqual(r.intended, 1)
  assert.strictEqual(r.accepted, 1)
  assert.strictEqual(r.created, 1)
  // The cursors were still SUPPLIED to the release - the run did everything right.
  const rel = p.calls.at(-1).args
  assert.strictEqual(rel.p_run_complete, true)
  assert.ok(rel.p_inbox_delta_ct)
})

test('a release that ERRORS is release_failed, not committed', async () => {
  const p = port({ release: { data: null, error: { status: 500 } } })
  const r = await runOutlookImport({
    rpc: withRounds(p.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  assert.strictEqual(r.outcome, 'release_failed')
  assert.strictEqual(r.cursorsAdvanced, 0)
  assert.strictEqual(r.accepted, 1)
})

test('a release that THROWS is release_failed, and does not escape the run', async () => {
  const calls = []
  const rpc = async (name, args) => {
    calls.push({ name, args })
    if (name === 'reserve_due_outlook_connection') {
      return { data: { result: 'reserved', connection_id: CONN, user_id: OWNER, run_id: RUN }, error: null }
    }
    if (name === 'upsert_outlook_interaction_candidate') return { data: { result: 'created' }, error: null }
    throw new Error('network down at https://secret.example')
  }
  const r = await runOutlookImport({
    rpc: withRounds(rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  assert.strictEqual(r.outcome, 'release_failed')
  assert.strictEqual(r.cursorsAdvanced, 0)
  assert.strictEqual(r.accepted, 1, 'the write that landed is still reported')
  assert.ok(!JSON.stringify(summarizeRun(r)).includes('secret.example'))
})

console.log('')
console.log('a thrown write or encryption is an error release, never a commit')

test('a THROWN candidate write releases as an error and commits nothing', async () => {
  const calls = []
  let released = null
  const rpc = async (name, args) => {
    calls.push({ name, args })
    if (name === 'reserve_due_outlook_connection') {
      return { data: { result: 'reserved', connection_id: CONN, user_id: OWNER, run_id: RUN }, error: null }
    }
    if (name === 'upsert_outlook_interaction_candidate') throw new Error('connection reset')
    released = args
    return { data: true, error: null }
  }
  const r = await runOutlookImport({
    rpc: withRounds(rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  assert.strictEqual(r.outcome, 'write_error')
  assert.strictEqual(r.accepted, 0)
  assert.strictEqual(r.intended, 1)
  assert.strictEqual(r.cursorsAdvanced, 0)
  // The lease is not left held: an error release was attempted.
  assert.ok(released, 'a best-effort release must still happen')
  assert.strictEqual(released.p_status, 'error')
  assert.strictEqual(released.p_error_code, 'write_failed')
  assert.strictEqual(released.p_inbox_delta_ct, null)
  assert.strictEqual(released.p_run_complete, false)
})

test('a THROWN cursor encryption now fails BEFORE any suggestion is written', async () => {
  const p = port()
  const r = await runOutlookImport({
    rpc: withRounds(p.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor: async () => { throw new Error('key unavailable') },
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  // MOVED EARLIER BY DURABLE CONTINUATION, deliberately. The cursor is now encrypted when
  // the page that produced it is CHECKPOINTED, not at commit time, so an unusable key is
  // discovered before a single page reaches the database - rather than after every
  // suggestion has been written and with a cursor that can never be stored. The outcome is
  // released_error with nothing accepted, which is a strictly better failure than the old
  // write_error with work already done.
  assert.strictEqual(r.outcome, 'released_error', JSON.stringify(summarizeRun(r)))
  assert.strictEqual(r.cursorsAdvanced, 0)
  assert.strictEqual(r.accepted, 0, 'no write may even be attempted')
  assert.strictEqual(r.created, 0)
  assert.ok(!p.calls.some((c) => c.name === 'upsert_outlook_interaction_candidate'))
  const rel = p.calls.at(-1).args
  assert.strictEqual(rel.p_status, 'error')
  assert.strictEqual(rel.p_inbox_delta_ct, null, 'no cursor may be supplied')
})

test('a best-effort release that ALSO throws still returns a controlled outcome', async () => {
  const rpc = async (name) => {
    if (name === 'reserve_due_outlook_connection') {
      return { data: { result: 'reserved', connection_id: CONN, user_id: OWNER, run_id: RUN }, error: null }
    }
    throw new Error('everything is down')
  }
  const r = await runOutlookImport({
    rpc: withRounds(rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  assert.strictEqual(r.outcome, 'write_error')
  assert.ok(RUN_OUTCOMES.includes(r.outcome))
  assert.strictEqual(r.cursorsAdvanced, 0)
})

console.log('')
console.log('partial writes are reported, not erased')

test('two of three accepted then a refusal: the two are still counted', async () => {
  const p = port({ writes: ['created', 'refreshed', 'stale_run'] })
  const r = await runOutlookImport({
    rpc: withRounds(p.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: threeEpisodeFixture() },
  })
  assert.strictEqual(r.outcome, 'write_failed')
  assert.strictEqual(r.refusal, 'stale_run')
  assert.strictEqual(r.intended, 3)
  assert.strictEqual(r.accepted, 2, 'the writes that landed must not be reported as zero')
  assert.strictEqual(r.created, 1)
  // writeResults is a null-prototype object, so compare its entries rather than the
  // object itself.
  assert.deepStrictEqual({ ...r.writeResults }, { created: 1, refreshed: 1, stale_run: 1 })
  assert.strictEqual(r.cursorsAdvanced, 0, 'and still no cursor')
  const rel = p.calls.at(-1).args
  assert.strictEqual(rel.p_run_complete, false)
  assert.strictEqual(rel.p_inbox_delta_ct, null)
})

test('the run STOPS at the first refusal rather than piling up uncommittable work', async () => {
  const p = port({ writes: ['created', 'stale_run', 'created'] })
  const r = await runOutlookImport({
    rpc: withRounds(p.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: threeEpisodeFixture() },
  })
  const writes = p.calls.filter((c) => c.name === 'upsert_outlook_interaction_candidate')
  assert.strictEqual(writes.length, 2, 'the third write must not be attempted')
  assert.strictEqual(r.accepted, 1)
  assert.strictEqual(r.intended, 3)
})

test('a partial run keeps the RETRY idempotent - no rollback, no new machinery', async () => {
  // First run: one lands, the next is refused.
  const first = port({ writes: ['created', 'stale_run'] })
  const a = await runOutlookImport({
    rpc: withRounds(first.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: threeEpisodeFixture() },
  })
  assert.strictEqual(a.accepted, 1)
  // The retry re-attempts the SAME episodes. The one that landed answers 'refreshed',
  // which is an accepted result, so the run can commit without any rollback having
  // happened in between.
  const second = port({ writes: ['refreshed', 'created', 'created'] })
  const b = await runOutlookImport({
    rpc: withRounds(second.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: threeEpisodeFixture() },
  })
  assert.strictEqual(b.outcome, 'committed')
  assert.strictEqual(b.accepted, 3)
  assert.strictEqual(b.created, 2)
  assert.strictEqual(b.cursorsAdvanced, 2)
  // Nothing in the module rolls anything back or opens a transaction.
  for (const banned of ['BEGIN', 'ROLLBACK', 'COMMIT', 'savepoint', 'transaction(']) {
    assert.ok(!codeOnly(RUN_SRC).includes(banned), `no transaction machinery: ${banned}`)
  }
})

test('summarizeRun exposes intended, accepted and created separately', async () => {
  const p = port({ writes: ['created', 'refreshed', 'rpc_error'] })
  const r = await runOutlookImport({
    rpc: withRounds(p.rpc, makeRoundStore()),
    pilotUserId: OWNER,
    encryptCursor,
    decryptCursor: DECRYPT_CURSOR,
    loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: threeEpisodeFixture() },
  })
  const s = summarizeRun(r)
  assert.strictEqual(s.intended, 3)
  assert.strictEqual(s.accepted, 2)
  assert.strictEqual(s.created, 1)
  assert.strictEqual(s.cursors_advanced, 0)
  assert.strictEqual(s.refusal, 'rpc_error')
  assert.ok(!/[0-9a-f]{64}/.test(JSON.stringify(s)))
})

console.log('')
console.log('the review analytics are source-correct')

test('the event names are source-neutral and the source travels as a property', () => {
  assert.deepStrictEqual(Object.values(SUGGESTION_EVENTS).sort(),
    ['suggestion_accepted', 'suggestion_dismissed', 'suggestion_review_viewed'])
  for (const name of Object.values(SUGGESTION_EVENTS)) {
    assert.ok(!/calendar|gmail|outlook/i.test(name),
      `a source must not be baked into the event name: ${name}`)
  }
})

test('an unrecognised source becomes a controlled label, never passed through', () => {
  for (const s of SUGGESTION_SOURCES) assert.strictEqual(suggestionSourceLabel(s), s)
  for (const bad of ['Outlook', ' outlook', 'manual', 'microsoft', '', null, undefined, 7, {}]) {
    assert.strictEqual(suggestionSourceLabel(bad), 'unknown', JSON.stringify(bad))
  }
})

test('the event properties carry behaviour only, never content', () => {
  assert.deepStrictEqual(suggestionEventProps('outlook'), { source: 'outlook' })
  assert.deepStrictEqual(suggestionEventProps('outlook', { edited: true }),
    { source: 'outlook', edited: true })
  assert.deepStrictEqual(suggestionEventProps('outlook', { edited: false }),
    { source: 'outlook', edited: false })
  // Anything else offered is dropped rather than forwarded.
  const props = suggestionEventProps('outlook', {
    edited: 'yes', contactId: 'c1', notes: 'private', email: 'a@b.test', candidateId: 'x',
  })
  assert.deepStrictEqual(props, { source: 'outlook' })
})

test('STRUCTURAL: the page emits the source-neutral events with the ROW source', () => {
  // renderToStaticMarkup dispatches no events, so the wiring is asserted on source.
  assert.ok(!/calendar_candidate_accepted|calendar_candidate_dismissed|calendar_review_viewed/.test(PAGE),
    'the calendar-named events must be gone: an Outlook row emitted them before')
  assert.ok(/track\(SUGGESTION_EVENTS\.accepted,/.test(PAGE))
  assert.ok(/track\(SUGGESTION_EVENTS\.dismissed, suggestionEventProps\(candidate\.source\)\)/.test(PAGE))
  assert.ok(/suggestionEventProps\(candidate\.source, \{ edited: !!edited \}\)/.test(PAGE),
    'the accept event must carry the row source and the edited flag')
  assert.ok(/track\(SUGGESTION_EVENTS\.viewed, suggestionEventProps\(s\)\)/.test(PAGE),
    'the viewed event must carry a source too')
  // ACROSS BOTH QUEUES. The scan used to be `rows.map(...)`, which stopped being
  // sufficient when the page gained the proposed-people queue: a view holding only a
  // proposed Outlook contact would have recorded no source at all.
  assert.ok(/new Set\(\[\.\.\.rows, \.\.\.proposals\]\.map\(\(r\) => r\.source\)\)/.test(PAGE),
    'a queue holding two sources, in either table, must not be recorded as one')
})

console.log('')
console.log('the entry count does not call an interaction a person')

test('the copy counts SUGGESTIONS, in both singular and plural', () => {
  assert.ok(/'suggestion' : 'suggestions'/.test(ENTRY),
    'an interaction suggestion for an existing contact is not a person to review')
  assert.ok(!/'person' : 'people'/.test(ENTRY))
  assert.ok(!/\bpeople to review\b/.test(ENTRY))
  assert.ok(/to review from your connected sources/.test(ENTRY), 'and stays source-neutral')
})

test('the entry still shows a count only, never any candidate or contact detail', () => {
  const code = codeOnly(ENTRY)
  for (const banned of ['proposed_notes', 'retained_subject', 'contacts(', 'name', 'email',
    'source_fingerprint']) {
    assert.ok(!code.includes(banned), `the entry must not read ${banned}`)
  }
  assert.ok(/count: 'exact', head: true/.test(code), 'a head count is all it needs')
})

async function finish () {
  await Promise.all(pending)
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
await finish()
