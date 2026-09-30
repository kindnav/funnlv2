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
import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transformWithOxc } from 'vite'
import {
  LEASE_SECONDS, DUE_AFTER_SECONDS, RETRY_BACKOFF_SECONDS, RUN_OUTCOMES,
  ENTRY_SKIP_CODES, WRITE_OK, writeAccepted, partitionPlan, runOutlookImport, summarizeRun,
} from '../supabase/functions/shared/outlookImportRun.js'
import {
  SOURCE_PROVIDERS, getSourceProvider, isValidInteractionSource,
} from '../src/lib/interactionSource.js'
import {
  outlookReviewEnabled, suggestionReviewEnabled, OUTLOOK_REVIEW_ENABLED,
  SUGGESTION_REVIEW_ENABLED,
} from '../src/lib/suggestionReview.js'
import { CANDIDATE_SELECT, validateOverrides } from '../src/lib/calendarReview.js'

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
      return reserve ?? { data: { result: 'reserved', connection_id: CONN, run_id: RUN }, error: null }
    }
    if (name === 'upsert_outlook_interaction_candidate') {
      const r = writes[Math.min(writeAt, writes.length - 1)]
      writeAt += 1
      return typeof r === 'object' ? r : { data: { result: r }, error: null }
    }
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

function context (contacts) {
  return async () => ({
    primaryEmail: 'student@getfunnl.test',
    aliases: [],
    timeZone: 'UTC',
    userId: 'u1',
    contacts,
    cursors: { inbox: null, sentitems: null },
    accessToken: 'fixture',
    keyRing: { current: { keyBytes: new Uint8Array(32).fill(3), keyVersion: 1 } },
  })
}
const OWN_CONTACT = [{ id: CONTACT, user_id: 'u1', email: 'ava@bank.test' }]

const encryptCursor = async (link) => ({
  ciphertext: `CT(${link.length})`, nonce: 'NONCE', keyVersion: 1,
})

console.log('\nthe run writes the suggestion BEFORE it advances the cursor')

test('a commit-ready pass writes one suggestion, then releases with both cursors', async () => {
  const p = port()
  const r = await runOutlookImport({
    rpc: p.rpc, encryptCursor, loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  assert.strictEqual(r.outcome, 'committed', JSON.stringify(summarizeRun(r)))
  assert.strictEqual(r.written, 1)
  const names = p.calls.map((c) => c.name)
  assert.deepStrictEqual(names, [
    'reserve_due_outlook_connection',
    'upsert_outlook_interaction_candidate',
    'release_outlook_sync_lease',
  ], 'the write must precede the release')
  const rel = p.calls.at(-1).args
  assert.strictEqual(rel.p_run_complete, true)
  assert.ok(rel.p_inbox_delta_ct && rel.p_sentitems_delta_ct, 'both cursors supplied')
  assert.strictEqual(rel.p_retry_backoff_seconds, null)
})

test('the cursor reaching the database is the ENCRYPTED value, never the link', async () => {
  const p = port()
  await runOutlookImport({
    rpc: p.rpc, encryptCursor, loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  const rel = p.calls.at(-1).args
  for (const v of [rel.p_inbox_delta_ct, rel.p_sentitems_delta_ct]) {
    assert.ok(v.startsWith('CT('), 'the raw deltaLink must not be sent')
    assert.ok(!v.includes('deltatoken') && !v.includes('graph.microsoft.com'))
  }
  assert.strictEqual(rel.p_delta_key_version, 1)
})

test('the write carries the fingerprints and NO content field', async () => {
  const p = port()
  await runOutlookImport({
    rpc: p.rpc, encryptCursor, loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  const w = p.calls.find((c) => c.name === 'upsert_outlook_interaction_candidate').args
  assert.match(w.p_episode_fingerprint, /^[0-9a-f]{64}$/)
  assert.match(w.p_person_fingerprint, /^[0-9a-f]{64}$/)
  assert.strictEqual(w.p_proposed_type, 'Email')
  assert.strictEqual(w.p_contact_id, CONTACT)
  for (const forbidden of ['p_proposed_notes', 'p_retained_subject', 'p_draft_summary',
    'p_draft_follow_up', 'p_subject', 'p_body']) {
    assert.strictEqual(w[forbidden], undefined, `the write must not carry ${forbidden}`)
  }
  // Nor an address or a provider id, even as an argument name.
  assert.ok(!JSON.stringify(w).includes('ava@bank.test'))
  assert.ok(!JSON.stringify(w).includes('in-1'))
})

console.log('\nan incomplete pass writes nothing and advances nothing')

test('no candidate write is attempted at all, and the release carries no cursor', async () => {
  const p = port()
  const r = await runOutlookImport({
    rpc: p.rpc, encryptCursor, loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture({ complete: false }) },
  })
  assert.strictEqual(r.outcome, 'incomplete')
  assert.deepStrictEqual(r.incompleteReasons, ['folder_incomplete'])
  assert.strictEqual(r.written, 0)
  assert.ok(!p.calls.some((c) => c.name === 'upsert_outlook_interaction_candidate'),
    'an incomplete pass must not attempt a write')
  const rel = p.calls.at(-1).args
  assert.strictEqual(rel.p_run_complete, false)
  for (const k of ['p_inbox_delta_ct', 'p_inbox_delta_nonce',
    'p_sentitems_delta_ct', 'p_sentitems_delta_nonce', 'p_delta_key_version']) {
    assert.strictEqual(rel[k], null, k)
  }
  assert.strictEqual(rel.p_retry_backoff_seconds, RETRY_BACKOFF_SECONDS)
})

test('a REFUSED write downgrades the whole run: no cursor, retry later', async () => {
  const p = port({ writes: ['stale_run'] })
  const r = await runOutlookImport({
    rpc: p.rpc, encryptCursor, loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  assert.strictEqual(r.outcome, 'write_failed')
  assert.strictEqual(r.refusal, 'stale_run')
  assert.strictEqual(r.written, 0)
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
    rpc: p.rpc, encryptCursor, loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  assert.strictEqual(r.outcome, 'committed')
  assert.strictEqual(p.calls.at(-1).args.p_run_complete, true)
})

test('nothing due takes no lease and performs no other call', async () => {
  const p = port({ reserve: { data: { result: 'none_due' }, error: null } })
  const r = await runOutlookImport({
    rpc: p.rpc, encryptCursor, loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  assert.strictEqual(r.outcome, 'none_due')
  assert.deepStrictEqual(p.calls.map((c) => c.name), ['reserve_due_outlook_connection'])
})

test('a thrown pass releases the lease as an error rather than holding it', async () => {
  const p = port()
  const r = await runOutlookImport({
    rpc: p.rpc, encryptCursor,
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
  assert.ok(/JOIN public\.microsoft_connections c/.test(MIGRATION))
  assert.ok(/FOR SHARE OF s/.test(MIGRATION), 'the lock order must match the release RPC')
  assert.ok(/sync_lease_until > now\(\)/.test(MIGRATION))
  assert.ok(/'stale_run'/.test(MIGRATION))
  const code = MIGRATION.split(String.fromCharCode(10))
    .filter((l) => !/^\s*--/.test(l)).join(String.fromCharCode(10))
  for (const gmail of ['gmail_sync_state', 'google_connections', 'email_candidate_refs']) {
    assert.ok(!code.includes(gmail), `a Microsoft connection must not touch ${gmail}`)
  }
})

test('the run module calls only the three permitted RPCs', () => {
  const names = [...new Set([...codeOnly(RUN_SRC).matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]))]
  assert.deepStrictEqual(names.sort(), [
    'release_outlook_sync_lease', 'reserve_due_outlook_connection',
    'upsert_outlook_interaction_candidate',
  ])
  assert.ok(!codeOnly(RUN_SRC).includes('upsert_email_candidate'))
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
    rpc: p.rpc, encryptCursor, loadRunContext: context(OWN_CONTACT),
    deps: { fetchImpl: graphFixture() },
  })
  const s = JSON.stringify(summarizeRun(r))
  for (const secret of [CONN, CONTACT, 'ava@bank.test', 'student@getfunnl.test',
    'Following up', 'deltatoken', 'CT(']) {
    assert.ok(!s.includes(secret), `the summary leaked: ${secret}`)
  }
  assert.ok(!/[0-9a-f]{64}/.test(s), 'the summary leaked a fingerprint')
  assert.strictEqual(summarizeRun(r).outcome, 'committed')
  assert.strictEqual(summarizeRun(r).written, 1)
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
  for (const banned of ['anthropic', 'Anthropic', 'buildMessageContentRequest', 'uniqueBody',
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

async function finish () {
  await Promise.all(pending)
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
await finish()
