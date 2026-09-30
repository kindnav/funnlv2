// The bounded Outlook Inbox/Sent metadata pass.
//
// WHAT IS BEHAVIOURAL HERE. The pass is driven end to end against CONTROLLED PROVIDER
// FIXTURES: a fake fetch that serves scripted Graph delta pages and records every
// request it was given. So "it requests only the envelope projection", "it never reads
// a body", "it stops at the page cap", "it refuses to advance the cursor on an
// incomplete run" and "it deduplicates an episode seen in both folders" are executed,
// not inferred from the source.
//
// WHAT IS NOT. There is no Microsoft, no network and no real mailbox: the fixtures are
// what a Graph response looks like, not proof that Graph produces exactly that. And
// the pass writes nothing, so there are no database effects to verify here - the
// database side of this slice is the deliberate GAP the worker endpoint reports as
// 501, and tests/sql covers the RPCs that do exist.
//
// Run with: node tests/outlook-metadata-pass.test.js

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import {
  PASS_STAGE, MAX_CONVERSATIONS_PER_RUN, MAX_PLAN_ENTRIES, SKIP_CODES, STOP_CODES,
  INCOMPLETE_REASONS,
  localDateFor, readFolderMetadata, groupByConversation, planEpisodes,
  runOutlookMetadataPass, summarizePass,
} from '../supabase/functions/shared/outlookMetadataPass.js'
import {
  DISCOVERY_SELECT, CONTENT_SELECT, MAX_PAGES_PER_RUN, MAX_MESSAGES_PER_RUN,
  MAX_PAGE_SIZE, GRAPH_BASE,
} from '../supabase/functions/shared/outlookGraphTransport.js'
import { MAX_EPISODE_MESSAGES } from '../supabase/functions/shared/outlookParticipants.js'
import {
  handleOutlookImportWorker, flagEnabled, WORKER_FLAGS,
} from '../supabase/functions/outlook-import-worker/handler.js'

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

const PASS_SRC = readFileSync(
  new URL('../supabase/functions/shared/outlookMetadataPass.js', import.meta.url), 'utf8')
const HANDLER_SRC = readFileSync(
  new URL('../supabase/functions/outlook-import-worker/handler.js', import.meta.url), 'utf8')
const CONFIG = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8')

/** Executable lines only: a file's own prose legitimately names what it refuses to do. */
function codeOnly (src) {
  return src.split(String.fromCharCode(10))
    .filter((l) => !/^[ ]*([/][/]|[*]|[/][*])/.test(l)).join(String.fromCharCode(10))
}
const PASS_CODE = codeOnly(PASS_SRC)
const HANDLER_CODE = codeOnly(HANDLER_SRC)

// ── fixtures ─────────────────────────────────────────────────────────────────

const CONN = '33333333-3333-3333-3333-333333333333'
const ME = 'student@getfunnl.test'
const KEY_RING = {
  current: { keyBytes: new Uint8Array(32).fill(7), keyVersion: 1 },
  subtle: webcrypto.subtle,
}

/** One Graph message as the delta endpoint returns it. */
function msg ({ id, conversationId, from, to = [], cc = [], sent, subject = 'Coffee chat' }) {
  const addr = (e) => ({ emailAddress: { address: e, name: e.split('@')[0] } })
  return {
    id,
    conversationId,
    receivedDateTime: sent,
    sentDateTime: sent,
    isDraft: false,
    subject,
    from: addr(from),
    sender: addr(from),
    toRecipients: to.map(addr),
    ccRecipients: cc.map(addr),
  }
}

const RECRUITER = 'ava@bank.test'
const CONTACT_ID = '44444444-4444-4444-4444-444444444444'
const USER_ID = '11111111-1111-1111-1111-111111111111'
const CONTACTS = [{ id: CONTACT_ID, user_id: USER_ID, email: RECRUITER }]

/** A two-sided exchange with a contact the user already tracks. */
const TWO_SIDED = {
  inbox: [msg({ id: 'm1', conversationId: 'c1', from: RECRUITER, to: [ME], sent: '2026-09-20T14:00:00Z' })],
  sentitems: [msg({ id: 'm2', conversationId: 'c1', from: ME, to: [RECRUITER], sent: '2026-09-21T09:00:00Z' })],
}

/**
 * A fetch that serves scripted pages and RECORDS every request.
 * `script[folderPathFragment]` is an array of page bodies, served in order.
 */
function provider (pagesByFolder) {
  const calls = []
  const cursors = { inbox: 0, sentitems: 0 }
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const folder = url.includes('/mailFolders/inbox/') || url.includes('inbox-next') ? 'inbox'
      : url.includes('/mailFolders/sentitems/') || url.includes('sent-next') ? 'sentitems' : null
    const list = folder ? (pagesByFolder[folder] || []) : []
    const body = list[cursors[folder] ?? 0] ?? { value: [], '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=end` }
    if (folder) cursors[folder] += 1
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => body,
    }
  }
  return { calls, fetchImpl }
}

/** One finished page: the given messages, then a deltaLink. */
function finalPage (folder, messages) {
  return {
    value: messages,
    '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=final`,
  }
}

async function runPass (pagesByFolder, over = {}) {
  const p = provider(pagesByFolder)
  const result = await runOutlookMetadataPass({
    connection: { connectionId: CONN, primaryEmail: ME, timeZone: 'America/New_York' },
    accessToken: 'fixture-token',
    contacts: CONTACTS,
    userId: USER_ID,
    keyRing: KEY_RING,
    deps: { fetchImpl: p.fetchImpl },
    ...over,
  })
  return { result, calls: p.calls }
}

console.log('\nbounded requests: only the envelope, never a body')

test('every request goes to Graph, is a GET, and asks for the DISCOVERY projection', async () => {
  const { calls } = await runPass({
    inbox: [finalPage('inbox', TWO_SIDED.inbox)],
    sentitems: [finalPage('sentitems', TWO_SIDED.sentitems)],
  })
  assert.ok(calls.length >= 2, 'both folders must be read')
  for (const c of calls) {
    assert.ok(c.url.startsWith(`${GRAPH_BASE}/me/`), `off-Graph request: ${c.url}`)
    assert.strictEqual(c.init.method, 'GET')
    assert.strictEqual(c.init.redirect, 'manual', 'a redirect must never be followed')
    assert.ok(c.url.includes(`$select=${DISCOVERY_SELECT.join(',')}`) || c.url.includes('$deltatoken'),
      `request did not use the envelope projection: ${c.url}`)
  }
})

test('NO request ever asks for a body projection', async () => {
  const { calls } = await runPass({
    inbox: [finalPage('inbox', TWO_SIDED.inbox)],
    sentitems: [finalPage('sentitems', TWO_SIDED.sentitems)],
  })
  for (const c of calls) {
    for (const field of ['body', 'uniqueBody', 'bodyPreview', 'internetMessageHeaders']) {
      assert.ok(!c.url.includes(field), `a body field was requested: ${field}`)
    }
    assert.ok(!c.url.includes('/me/messages/'), 'the per-message content route was used')
    assert.ok(!/Prefer:\s*outlook\.body-content-type/i.test(JSON.stringify(c.init.headers || {})),
      'the text-body Prefer header was sent')
  }
  // And structurally: the module's CODE never names the content builder. Its prose
  // does, in order to say it is never called, so prose is stripped before scanning.
  assert.ok(!PASS_CODE.includes('buildMessageContentRequest'),
    'the stage-2 content builder must not be reachable from this module')
  for (const f of CONTENT_SELECT) {
    if (f === 'id') continue
    assert.ok(!PASS_CODE.includes(`'${f}'`), `content projection field in code: ${f}`)
  }
})

test('the pass reports zero content fetches, structurally', async () => {
  const { result } = await runPass({
    inbox: [finalPage('inbox', TWO_SIDED.inbox)],
    sentitems: [finalPage('sentitems', TWO_SIDED.sentitems)],
  })
  assert.strictEqual(result.totals.contentFetches, 0)
  for (const f of ['inbox', 'sentitems']) {
    assert.strictEqual(result.folders[f].contentFetches, 0, f)
  }
})

test('the module imports no Anthropic, draft, sanitizer or database surface', () => {
  // Plain substring checks. An earlier revision built a RegExp from '.rpc(' and threw
  // "Unterminated group" instead of asserting anything, so this asserts nothing
  // through a constructed pattern.
  for (const banned of ['anthropic', 'Anthropic', 'outlookDraftContract',
    'outlookContentSanitizer', 'createClient', 'supabase', '.rpc(', 'service_role',
    'SERVICE_ROLE', 'setInterval', 'cron']) {
    assert.ok(!PASS_CODE.includes(banned), `the pass must not reference ${banned}`)
  }
})

console.log('\ndeterministic filtering')

test('a two-sided exchange with a KNOWN contact becomes one plan entry', async () => {
  const { result } = await runPass({
    inbox: [finalPage('inbox', TWO_SIDED.inbox)],
    sentitems: [finalPage('sentitems', TWO_SIDED.sentitems)],
  })
  assert.strictEqual(result.plan.length, 1, JSON.stringify(result.skipped))
  const e = result.plan[0]
  assert.strictEqual(e.kind, 'known_contact_interaction')
  assert.strictEqual(e.contactId, CONTACT_ID)
  assert.strictEqual(e.counterparty, RECRUITER)
  assert.strictEqual(e.proposedType, 'Email')
  assert.strictEqual(e.inbound, 1)
  assert.strictEqual(e.outbound, 1)
  assert.strictEqual(e.messageCount, 2)
  assert.match(e.episodeFingerprint, /^[0-9a-f]{64}$/)
  assert.match(e.personFingerprint, /^[0-9a-f]{64}$/)
  assert.notStrictEqual(e.episodeFingerprint, e.personFingerprint,
    'episode and person fingerprints must be domain-separated')
})

test('a ONE-SIDED thread is skipped as not_two_sided', async () => {
  const { result } = await runPass({
    inbox: [finalPage('inbox', TWO_SIDED.inbox)],
    sentitems: [finalPage('sentitems', [])],
  })
  assert.strictEqual(result.plan.length, 0)
  assert.strictEqual(result.skipped.not_two_sided, 1)
})

test('a newsletter is excluded on envelope evidence alone', async () => {
  const bulk = msg({ id: 'n1', conversationId: 'cn', from: 'news@list.test', to: [ME], sent: '2026-09-20T10:00:00Z' })
  bulk.subject = 'Weekly digest'
  const { result } = await runPass({
    inbox: [finalPage('inbox', [bulk])],
    sentitems: [finalPage('sentitems', [msg({ id: 'n2', conversationId: 'cn', from: ME, to: ['news@list.test'], sent: '2026-09-20T11:00:00Z' })])],
  })
  // Either the bulk rule or the unknown-sender deferral catches it; both are
  // acceptable outcomes and BOTH mean no suggestion was produced.
  assert.strictEqual(result.plan.length, 0, JSON.stringify(result.plan))
  assert.ok(Object.keys(result.skipped).length > 0, 'a reason must be recorded')
  for (const code of Object.keys(result.skipped)) {
    assert.ok(SKIP_CODES.includes(code), `uncontrolled skip code: ${code}`)
  }
})

test('a group thread is DEFERRED, never attributed to one participant', async () => {
  const group = [
    msg({ id: 'g1', conversationId: 'cg', from: RECRUITER, to: [ME, 'third@other.test'], sent: '2026-09-20T10:00:00Z' }),
    msg({ id: 'g2', conversationId: 'cg', from: ME, to: [RECRUITER, 'third@other.test'], sent: '2026-09-20T12:00:00Z' }),
  ]
  const { result } = await runPass({
    inbox: [finalPage('inbox', [group[0]])],
    sentitems: [finalPage('sentitems', [group[1]])],
  })
  assert.strictEqual(result.plan.length, 0)
  assert.strictEqual(result.skipped.ambiguous_counterparties, 1)
})

test('a message only to yourself never becomes a suggestion', async () => {
  const { result } = await runPass({
    inbox: [finalPage('inbox', [msg({ id: 's1', conversationId: 'cs', from: ME, to: [ME], sent: '2026-09-20T10:00:00Z' })])],
    sentitems: [finalPage('sentitems', [])],
  })
  assert.strictEqual(result.plan.length, 0)
  assert.ok(result.skipped.self_only >= 1 || result.skipped.no_eligible_messages >= 1,
    JSON.stringify(result.skipped))
})

test('a metadata-only pass can only DEFER an unknown person, never propose one', async () => {
  // The design consequence stated in the module header: automation facts live in
  // headers, which this pass does not read, so evaluateMessage fails closed for a
  // sender the user does not already track.
  const stranger = 'unknown@firm.test'
  const { result } = await runPass({
    inbox: [finalPage('inbox', [msg({ id: 'u1', conversationId: 'cu', from: stranger, to: [ME], sent: '2026-09-20T10:00:00Z' })])],
    sentitems: [finalPage('sentitems', [msg({ id: 'u2', conversationId: 'cu', from: ME, to: [stranger], sent: '2026-09-20T12:00:00Z' })])],
  })
  assert.strictEqual(result.plan.filter((e) => e.kind === 'new_contact_suggestion').length, 0,
    'a metadata-only pass must never propose a brand-new contact')
  assert.strictEqual(result.skipped.automation_facts_incomplete, 1)
})
test('planEpisodes is bounded by MAX_PLAN_ENTRIES and reports the cap as a skip', async () => {
  // Driven directly, because a mailbox large enough to hit this cap is not a
  // practical fixture for the whole pass.
  const byConversation = new Map()
  for (let i = 0; i < MAX_PLAN_ENTRIES + 5; i++) {
    byConversation.set(`k${i}`, [
      { message: { providerMessageKey: `a${i}`, providerConversationKey: `k${i}`,
        timestampIso: '2026-09-20T10:00:00Z', fromAddress: RECRUITER, toAddresses: [ME],
        ccAddresses: [], subject: 's', automation: {}, folderHint: 'inbox' },
      extra: { displayNames: {}, automationFactsComplete: true } },
      { message: { providerMessageKey: `b${i}`, providerConversationKey: `k${i}`,
        timestampIso: '2026-09-21T10:00:00Z', fromAddress: ME, toAddresses: [RECRUITER],
        ccAddresses: [], subject: 's', automation: {}, folderHint: 'sent' },
      extra: { displayNames: {}, automationFactsComplete: true } },
    ])
  }
  const out = await planEpisodes({
    byConversation,
    selfSet: new Set([ME]),
    contactIndex: new Map([[RECRUITER, { contactId: CONTACT_ID }]]),
    connectionId: CONN,
    keyRing: KEY_RING,
    timeZone: 'UTC',
  })
  assert.strictEqual(out.entries.length, MAX_PLAN_ENTRIES)
  assert.strictEqual(out.skipped.plan_cap_reached, 5)
  assert.ok(SKIP_CODES.includes('plan_cap_reached'))
})

test('planEpisodes refuses a missing connection id rather than fingerprinting without one', async () => {
  await assert.rejects(() => planEpisodes({ byConversation: new Map() }), /connection_id_required/)
})


console.log('\ndeduplication')

test('the SAME message in both folders is counted once', async () => {
  const both = msg({ id: 'dup', conversationId: 'cd', from: RECRUITER, to: [ME], sent: '2026-09-20T10:00:00Z' })
  const { result } = await runPass({
    inbox: [finalPage('inbox', [both, TWO_SIDED.inbox[0]])],
    sentitems: [finalPage('sentitems', [both, TWO_SIDED.sentitems[0]])],
  })
  const c1 = result.plan.find((e) => e.messageCount === 2)
  assert.ok(c1, 'the genuine two-sided episode must still be planned')
  // 'dup' appears in both folder streams but must contribute one message, so its
  // conversation is one-sided and skipped rather than double counted.
  assert.strictEqual(result.plan.filter((e) => e.messageCount > 2).length, 0)
})

test('one episode yields ONE entry however many messages it has', async () => {
  const many = []
  for (let i = 0; i < 6; i++) {
    many.push(msg({
      id: `x${i}`, conversationId: 'cx',
      from: i % 2 === 0 ? RECRUITER : ME,
      to: [i % 2 === 0 ? ME : RECRUITER],
      sent: `2026-09-2${i}T10:00:00Z`,
    }))
  }
  const { result } = await runPass({
    inbox: [finalPage('inbox', many.filter((_, i) => i % 2 === 0))],
    sentitems: [finalPage('sentitems', many.filter((_, i) => i % 2 === 1))],
  })
  assert.strictEqual(result.plan.length, 1)
  assert.strictEqual(result.plan[0].messageCount, 6)
})

test('the same episode planned twice produces the SAME fingerprints', async () => {
  const a = await runPass({
    inbox: [finalPage('inbox', TWO_SIDED.inbox)],
    sentitems: [finalPage('sentitems', TWO_SIDED.sentitems)],
  })
  const b = await runPass({
    inbox: [finalPage('inbox', TWO_SIDED.inbox)],
    sentitems: [finalPage('sentitems', TWO_SIDED.sentitems)],
  })
  assert.strictEqual(a.result.plan[0].episodeFingerprint, b.result.plan[0].episodeFingerprint)
  assert.strictEqual(a.result.plan[0].personFingerprint, b.result.plan[0].personFingerprint)
})

test('page order does not change the plan', async () => {
  const reversed = await runPass({
    inbox: [finalPage('inbox', [...TWO_SIDED.inbox].reverse())],
    sentitems: [finalPage('sentitems', TWO_SIDED.sentitems)],
  })
  const forward = await runPass({
    inbox: [finalPage('inbox', TWO_SIDED.inbox)],
    sentitems: [finalPage('sentitems', TWO_SIDED.sentitems)],
  })
  assert.strictEqual(reversed.result.plan[0].episodeFingerprint,
    forward.result.plan[0].episodeFingerprint)
})

console.log('\ncross-user and cross-connection isolation')

test("another user's contact is NOT matched, even with the same address", async () => {
  const other = [{ id: 'not-mine', user_id: '22222222-2222-2222-2222-222222222222', email: RECRUITER }]
  const { result } = await runPass({
    inbox: [finalPage('inbox', TWO_SIDED.inbox)],
    sentitems: [finalPage('sentitems', TWO_SIDED.sentitems)],
  }, { contacts: other })
  assert.strictEqual(result.plan.filter((e) => e.contactId !== null).length, 0,
    "a contact belonging to another user was matched")
})

test('an absent owner id is refused rather than silently matching nothing', async () => {
  await assert.rejects(
    () => runOutlookMetadataPass({
      connection: { connectionId: CONN, primaryEmail: ME },
      accessToken: 't', contacts: CONTACTS, keyRing: KEY_RING,
      deps: { fetchImpl: async () => { throw new Error('must not be called') } },
    }),
    /user_id_required/,
  )
})

test('the same conversation in a DIFFERENT connection fingerprints differently', async () => {
  const a = await runPass({
    inbox: [finalPage('inbox', TWO_SIDED.inbox)],
    sentitems: [finalPage('sentitems', TWO_SIDED.sentitems)],
  })
  const b = await runPass({
    inbox: [finalPage('inbox', TWO_SIDED.inbox)],
    sentitems: [finalPage('sentitems', TWO_SIDED.sentitems)],
  }, { connection: { connectionId: '55555555-5555-5555-5555-555555555555', primaryEmail: ME, timeZone: 'America/New_York' } })
  assert.notStrictEqual(a.result.plan[0].episodeFingerprint, b.result.plan[0].episodeFingerprint,
    'fingerprints must be namespaced on the connection')
})

console.log('\ncaps and cursor discipline')

test('a stream that never ends stops at the page cap and does NOT advance the cursor', async () => {
  // Every page carries a nextLink, so the stream never completes.
  const endless = () => ({
    value: [],
    '@odata.nextLink': `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$skiptoken=inbox-next`,
  })
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return { status: 200, headers: { get: () => null }, json: async () => endless() }
  }
  const res = await readFolderMetadata({
    folder: 'inbox', accessToken: 't', deps: { fetchImpl },
  })
  assert.strictEqual(res.stop, 'max_pages_exceeded')
  assert.strictEqual(res.complete, false)
  assert.strictEqual(res.deltaLink, null, 'an incomplete run must not return a cursor')
  assert.ok(calls.length <= MAX_PAGES_PER_RUN + 1, `made ${calls.length} requests`)
})

test('the page cap is shared ACROSS folders, not per folder', async () => {
  const endless = (f) => ({
    value: [],
    '@odata.nextLink': `${GRAPH_BASE}/me/mailFolders/${f}/messages/delta?$skiptoken=${f === 'inbox' ? 'inbox' : 'sent'}-next`,
  })
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const f = url.includes('inbox') ? 'inbox' : 'sentitems'
    return { status: 200, headers: { get: () => null }, json: async () => endless(f) }
  }
  const result = await runOutlookMetadataPass({
    connection: { connectionId: CONN, primaryEmail: ME },
    accessToken: 't', contacts: CONTACTS, userId: USER_ID, keyRing: KEY_RING,
    deps: { fetchImpl },
  })
  assert.ok(calls.length <= MAX_PAGES_PER_RUN + 2,
    `a shared cap was exceeded: ${calls.length} requests`)
  assert.strictEqual(result.commitReady, false)
  assert.ok(result.incompleteReasons.includes('folder_incomplete'))
  assert.strictEqual(result.cursors, null, 'no cursor may be exposed on an incomplete run')
  for (const f of ['inbox', 'sentitems']) {
    assert.strictEqual(result.folders[f].reachedCursor, false, f)
  }
})

test('a finished stream returns its cursor, and only then', async () => {
  const { result } = await runPass({
    inbox: [finalPage('inbox', TWO_SIDED.inbox)],
    sentitems: [finalPage('sentitems', TWO_SIDED.sentitems)],
  })
  assert.strictEqual(result.commitReady, true)
  assert.deepStrictEqual(result.incompleteReasons, [])
  assert.ok(result.cursors !== null, 'a clean run must expose its cursors')
  for (const f of ['inbox', 'sentitems']) {
    assert.strictEqual(result.folders[f].complete, true, f)
    assert.strictEqual(result.folders[f].stop, 'complete', f)
    assert.strictEqual(result.folders[f].reachedCursor, true, f)
    assert.ok(typeof result.cursors[f] === 'string' && result.cursors[f].length > 0, f)
    // The VALUE lives only behind the gate, never on the per-folder record.
    assert.strictEqual(result.folders[f].deltaLink, undefined,
      'a cursor value must not be reachable past the gate')
  }
})

test('an expired delta cursor is reported as cursor_invalid, not as a failure', async () => {
  const fetchImpl = async () => ({
    status: 410,
    headers: { get: () => null },
    json: async () => ({ error: { code: 'resyncRequired' } }),
  })
  const res = await readFolderMetadata({
    folder: 'inbox', startLink: `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$deltatoken=old`,
    accessToken: 't', deps: { fetchImpl, sleepImpl: async () => {} },
  })
  assert.strictEqual(res.stop, 'cursor_invalid')
  assert.strictEqual(res.deltaLink, null)
  assert.ok(STOP_CODES.includes(res.stop))
})

test('a page with neither nextLink nor deltaLink is malformed, not finished', async () => {
  const fetchImpl = async () => ({
    status: 200, headers: { get: () => null }, json: async () => ({ value: [] }),
  })
  const res = await readFolderMetadata({ folder: 'inbox', accessToken: 't', deps: { fetchImpl } })
  assert.strictEqual(res.stop, 'malformed_response')
  assert.strictEqual(res.complete, false)
  assert.strictEqual(res.deltaLink, null)
})

test('the in-memory plan and conversation caps are bounded numbers', () => {
  assert.ok(Number.isInteger(MAX_CONVERSATIONS_PER_RUN) && MAX_CONVERSATIONS_PER_RUN > 0)
  assert.ok(Number.isInteger(MAX_PLAN_ENTRIES) && MAX_PLAN_ENTRIES > 0)
  const many = []
  for (let i = 0; i < MAX_CONVERSATIONS_PER_RUN + 25; i++) {
    many.push({ message: { providerConversationKey: `k${i}`, providerMessageKey: `m${i}`, timestampIso: '2026-09-20T10:00:00Z' } })
  }
  const g = groupByConversation(many)
  assert.strictEqual(g.byConversation.size, MAX_CONVERSATIONS_PER_RUN)
})

console.log('\nlocal dates, because a suggestion names a day')

test('the proposed date uses the connection time zone, not UTC', () => {
  // 01:30 UTC on the 21st is still the 20th in New York.
  assert.strictEqual(localDateFor('2026-09-21T01:30:00Z', 'America/New_York'), '2026-09-20')
  assert.strictEqual(localDateFor('2026-09-21T01:30:00Z', 'UTC'), '2026-09-21')
  assert.strictEqual(localDateFor('2026-09-20T23:30:00Z', 'Asia/Kolkata'), '2026-09-21')
})

test('an unusable zone falls back to UTC rather than throwing or guessing', () => {
  assert.strictEqual(localDateFor('2026-09-21T01:30:00Z', 'Not/AZone'), '2026-09-21')
  assert.strictEqual(localDateFor('2026-09-21T01:30:00Z', ''), '2026-09-21')
})

test('an unparseable timestamp yields null rather than a wrong day', () => {
  assert.strictEqual(localDateFor('not-a-date', 'UTC'), null)
  assert.strictEqual(localDateFor('', 'UTC'), null)
})

test('the planned date is the LAST message of the episode, in the local zone', async () => {
  const { result } = await runPass({
    inbox: [finalPage('inbox', TWO_SIDED.inbox)],
    sentitems: [finalPage('sentitems', TWO_SIDED.sentitems)],
  })
  // Last message is 2026-09-21T09:00:00Z, which is the 21st in New York.
  assert.strictEqual(result.plan[0].proposedDate, '2026-09-21')
})

console.log('\nthe log summary carries no content')

test('summarizePass returns counts and codes only', async () => {
  const { result } = await runPass({
    inbox: [finalPage('inbox', TWO_SIDED.inbox)],
    sentitems: [finalPage('sentitems', TWO_SIDED.sentitems)],
  })
  const s = JSON.stringify(summarizePass(result))
  for (const secret of [RECRUITER, ME, 'Coffee chat', 'ava', CONTACT_ID, CONN,
    result.plan[0].episodeFingerprint, result.plan[0].personFingerprint,
    result.cursors.inbox]) {
    assert.ok(!s.includes(secret), `the summary leaked: ${String(secret).slice(0, 24)}`)
  }
  const sum = summarizePass(result)
  assert.strictEqual(sum.stage, PASS_STAGE)
  assert.strictEqual(sum.plan_entries, 1)
  assert.strictEqual(sum.plan_by_kind.known_contact_interaction, 1)
  assert.strictEqual(sum.commit_ready, true)
})

test('a fingerprint is deliberately excluded from the summary', () => {
  // It is a stable per-user identifier for one exchange, so logging it would build a
  // durable record of who someone talks to.
  assert.ok(/A fingerprint is excluded deliberately/.test(PASS_SRC))
  const sum = summarizePass({ plan: [{ kind: 'known_contact_interaction', episodeFingerprint: 'f'.repeat(64) }] })
  assert.ok(!JSON.stringify(sum).includes('f'.repeat(64)))
})

test('summarizePass tolerates junk without throwing', () => {
  for (const junk of [null, undefined, 'x', 42, []]) {
    const s = summarizePass(junk)
    assert.strictEqual(s.stage, PASS_STAGE)
  }
})

console.log('\nthe worker endpoint is dormant, twice over')

function workerRequest (over = {}) {
  return {
    method: 'POST',
    headers: { get: (k) => (k.toLowerCase() === 'authorization' ? (over.authorization ?? null) : null) },
    ...over,
  }
}

test('both flags off: 503 not_enabled, and nothing else happens', async () => {
  const res = await handleOutlookImportWorker(workerRequest(), {})
  assert.strictEqual(res.status, 503)
  assert.deepStrictEqual(await res.json(), { error: 'not_enabled' })
})

test('one flag on is still off', async () => {
  for (const env of [
    { integrationEnabled: 'true' },
    { workerEnabled: 'true' },
    { integrationEnabled: 'true', workerEnabled: 'TRUE' },
    { integrationEnabled: '1', workerEnabled: 'true' },
    { integrationEnabled: 'true', workerEnabled: ' true' },
  ]) {
    const res = await handleOutlookImportWorker(workerRequest(), env)
    assert.strictEqual(res.status, 503, JSON.stringify(env))
  }
})

test('the flag predicate accepts only the exact string', () => {
  assert.strictEqual(flagEnabled('true'), true)
  for (const v of ['TRUE', 'True', '1', 'yes', '', ' true', 'true ', null, undefined, true]) {
    assert.strictEqual(flagEnabled(v), false, String(v))
  }
  assert.deepStrictEqual([...WORKER_FLAGS], ['OUTLOOK_INTEGRATION_ENABLED', 'OUTLOOK_IMPORT_WORKER_ENABLED'])
})

test('dormancy is checked BEFORE the secret, so a disabled endpoint is no oracle', async () => {
  const wrong = await handleOutlookImportWorker(
    workerRequest({ authorization: 'Bearer ' + 'w'.repeat(40) }), {})
  const right = await handleOutlookImportWorker(
    workerRequest({ authorization: 'Bearer ' + 's'.repeat(40) }),
    { workerSecret: 's'.repeat(40) })
  assert.strictEqual(wrong.status, 503)
  assert.strictEqual(right.status, 503, 'a correct secret must not change the disabled answer')
  assert.deepStrictEqual(await right.json(), { error: 'not_enabled' })
  // And structurally: the flag check precedes the authorize call in the source.
  assert.ok(HANDLER_SRC.indexOf('flagEnabled(e.integrationEnabled)') <
    HANDLER_SRC.indexOf('authorizeWorkerRequest('))
})

test('enabled but unauthenticated is refused, and enabled+authorised is 501, not a silent run', async () => {
  const env = { integrationEnabled: 'true', workerEnabled: 'true', workerSecret: 's'.repeat(40) }
  const noAuth = await handleOutlookImportWorker(workerRequest(), env)
  assert.strictEqual(noAuth.status, 401)

  const getOnly = await handleOutlookImportWorker(
    workerRequest({ method: 'GET', authorization: 'Bearer ' + 's'.repeat(40) }), env)
  assert.strictEqual(getOnly.status, 405)

  const unconfigured = await handleOutlookImportWorker(
    workerRequest({ authorization: 'Bearer short' }),
    { ...env, workerSecret: 'tooshort' })
  assert.strictEqual(unconfigured.status, 503)
  assert.deepStrictEqual(await unconfigured.json(), { error: 'worker_not_configured' })

  const ok = await handleOutlookImportWorker(
    workerRequest({ authorization: 'Bearer ' + 's'.repeat(40) }), env)
  assert.strictEqual(ok.status, 501)
  const body = await ok.json()
  assert.strictEqual(body.error, 'not_implemented')
  assert.strictEqual(body.reason, 'no_token_access_path')
})

test('the handler touches no provider, no database and no scheduler', () => {
  for (const banned of ['fetch(', 'graph.microsoft', 'createClient', '.rpc(', 'cron',
    'setInterval', 'setTimeout', 'anthropic', 'runOutlookMetadataPass']) {
    assert.ok(!HANDLER_CODE.includes(banned), `the handler must not reference ${banned}`)
  }
  const code = HANDLER_CODE
  // No secret may be echoed on any path.
  assert.ok(!/workerSecret/.test(code.replace(/configuredSecret: e\.workerSecret[^\n]*/, '')),
    'the secret must appear only where it is compared')
})

test('config.toml records the endpoint as private and explains the dormancy order', () => {
  assert.ok(/\[functions\.outlook-import-worker\]/.test(CONFIG))
  const section = CONFIG.slice(CONFIG.indexOf('# outlook-import-worker is PRIVATE'))
  assert.ok(/verify_jwt = false/.test(section.slice(0, 1200)))
  assert.ok(/OUTLOOK_WORKER_SECRET/.test(CONFIG))
  assert.ok(/BEFORE the secret/.test(CONFIG) && /comparison/.test(CONFIG),
    'the check order must be recorded where a reviewer reads the config')
  assert.ok(/cannot be used to probe the secret/.test(CONFIG),
    'and why that order matters')
})

console.log('\nthe gap is stated, not hidden')

test('the handler records the CLEARED write-path blocker and the current one', () => {
  // The Gmail coupling is kept on the record so the change of reason is auditable,
  // rather than the old reason simply disappearing.
  assert.ok(/upsert_email_candidate/.test(HANDLER_SRC))
  assert.ok(/gmail_sync_state/.test(HANDLER_SRC) && /google_connections/.test(HANDLER_SRC),
    'the actual coupling must stay named, not hand-waved')
  assert.ok(/outlook_candidate_refs/.test(HANDLER_SRC))
  assert.ok(/20260930000000/.test(HANDLER_SRC), 'and the migration that cleared it')
  // The current reason: a deployed run has no way to obtain a Graph access token.
  assert.ok(/no_token_access_path/.test(HANDLER_SRC))
  assert.ok(/token-encryption key/.test(HANDLER_SRC) && /Entra application/.test(HANDLER_SRC))
})

test('the pass documents that a metadata-only run cannot propose new people', () => {
  assert.ok(/can only ever DEFER a new person/.test(PASS_SRC))
  assert.ok(/NO database write/.test(PASS_SRC))
  assert.ok(/NO contact or interaction is created/.test(PASS_SRC))
})

console.log('')
console.log('completion and cursor contract: dropped work is never commit-ready')

// These are WHOLE-PASS tests on purpose. Each ceiling below used to be reported as a
// count while the run still claimed completion and handed back a cursor, so the thing
// worth asserting is the end-to-end result a caller would act on.

/** A Graph item with a distinct conversation, so N items make N conversations. */
function filler (i) {
  return msg({
    id: `f${i}`, conversationId: `fc${i}`,
    from: `person${i}@firm.test`, to: [ME],
    sent: '2026-09-20T10:00:00Z',
  })
}

/**
 * Serves `pageCount` full pages to one folder; the LAST one carries a deltaLink.
 * The other folder finishes immediately and cleanly.
 */
function bigFolderProvider (folder, pageCount, itemsPerPage) {
  let served = 0
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const isTarget = url.includes(`/mailFolders/${folder}/`) ||
      url.includes(`${folder === 'inbox' ? 'inbox' : 'sent'}-next`)
    if (!isTarget) return okPage(finalPage(folder === 'inbox' ? 'sentitems' : 'inbox', []))
    served += 1
    const value = Array.from({ length: itemsPerPage }, (_, k) => filler(served * 1000 + k))
    return okPage(served >= pageCount
      ? { value, '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=final` }
      : { value, '@odata.nextLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$skiptoken=${folder === 'inbox' ? 'inbox' : 'sent'}-next` })
  }
  return { calls, fetchImpl }
}

function okPage (body) {
  return { status: 200, headers: { get: () => null }, json: async () => body }
}

async function passWith (fetchImpl, over = {}) {
  return runOutlookMetadataPass({
    connection: { connectionId: CONN, primaryEmail: ME, timeZone: 'UTC' },
    accessToken: 't',
    contacts: CONTACTS,
    userId: USER_ID,
    keyRing: KEY_RING,
    deps: { fetchImpl },
    ...over,
  })
}

test('A FINAL PAGE THAT CARRIES A CURSOR BUT BREACHES THE MESSAGE CAP is not complete', async () => {
  // The exact defect this fix addresses. Enough pages to pass MAX_MESSAGES_PER_RUN,
  // with the last one carrying an @odata.deltaLink. Honouring the cursor first made
  // the run claim completion while the overflow had already been discarded.
  const pageCount = Math.ceil((MAX_MESSAGES_PER_RUN + MAX_PAGE_SIZE) / MAX_PAGE_SIZE)
  const p = bigFolderProvider('inbox', pageCount, MAX_PAGE_SIZE)
  const res = await readFolderMetadata({ folder: 'inbox', accessToken: 't', deps: { fetchImpl: p.fetchImpl } })

  assert.ok(res.messages > MAX_MESSAGES_PER_RUN,
    `the fixture must actually breach the cap (saw ${res.messages})`)
  assert.strictEqual(res.stop, 'max_messages_exceeded',
    'a cap breach must outrank a delta cursor')
  assert.strictEqual(res.complete, false)
  assert.strictEqual(res.deltaLink, null,
    'a cursor from an over-cap run would skip every dropped message forever')
})

test('that same case, through the WHOLE pass, is non-commit-ready with no cursors', async () => {
  const pageCount = Math.ceil((MAX_MESSAGES_PER_RUN + MAX_PAGE_SIZE) / MAX_PAGE_SIZE)
  const p = bigFolderProvider('inbox', pageCount, MAX_PAGE_SIZE)
  const result = await passWith(p.fetchImpl)

  assert.strictEqual(result.commitReady, false)
  assert.strictEqual(result.cursors, null)
  assert.deepStrictEqual(result.incompleteReasons,
    ['folder_incomplete', 'messages_dropped', 'conversations_dropped'],
    'the cap breach, the truncated page AND the knock-on grouping loss are all reported')
  assert.ok(result.droppedMessages > 0, 'the truncated page must be quantified')
  assert.strictEqual(result.folders.inbox.stop, 'max_messages_exceeded')
  assert.strictEqual(result.folders.inbox.reachedCursor, false,
    'the over-cap folder must not hold the cursor it was offered')
  for (const r of result.incompleteReasons) {
    assert.ok(INCOMPLETE_REASONS.includes(r), `uncontrolled reason: ${r}`)
  }
})

test('MESSAGES DROPPED by the entry ceiling are counted, and refuse the cursor', async () => {
  // Exactly MAX_MESSAGES_PER_RUN across full pages, every one carrying a nextLink, so
  // the entry map fills before the cap check can fire. The next page's messages have
  // nowhere to go: they are counted as dropped rather than vanishing.
  const fullPages = MAX_MESSAGES_PER_RUN / MAX_PAGE_SIZE
  assert.ok(Number.isInteger(fullPages), 'the fixture assumes the cap is a whole number of pages')
  let served = 0
  const fetchImpl = async () => {
    served += 1
    const value = Array.from({ length: MAX_PAGE_SIZE }, (_, k) => filler((served - 1) * MAX_PAGE_SIZE + k))
    return okPage({
      value,
      '@odata.nextLink': `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$skiptoken=n${served}`,
    })
  }
  const res = await readFolderMetadata({ folder: 'inbox', accessToken: 't', deps: { fetchImpl } })
  assert.strictEqual(res.entries.size, MAX_MESSAGES_PER_RUN)
  assert.ok(res.droppedMessages > 0, 'the surplus must be counted, not silently discarded')
  assert.strictEqual(res.complete, false)
  assert.strictEqual(res.deltaLink, null)
})

test('an oversized single page is refused outright rather than partly ingested', async () => {
  // readDeltaPage rejects a page above MAX_PAGE_SIZE, so there is no path by which
  // half of one page is kept and the rest quietly lost.
  const value = Array.from({ length: MAX_PAGE_SIZE + 5 }, (_, k) => filler(k))
  const fetchImpl = async () => okPage({
    value,
    '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$deltatoken=final`,
  })
  const res = await readFolderMetadata({ folder: 'inbox', accessToken: 't', deps: { fetchImpl } })
  assert.strictEqual(res.stop, 'malformed_response')
  assert.strictEqual(res.entries.size, 0)
  assert.strictEqual(res.complete, false)
  assert.strictEqual(res.deltaLink, null)
})

test('MESSAGES DROPPED surfaces in the WHOLE-PASS result, not just the folder read', async () => {
  // Regression: readFolderMetadata counted droppedMessages but the pass did not copy
  // it into its per-folder record, so the sum was always 0 and 'messages_dropped' was
  // unreachable - a run that had truncated a page reported only 'folder_incomplete'
  // and understated the loss.
  const fullPages = MAX_MESSAGES_PER_RUN / MAX_PAGE_SIZE
  let served = 0
  const fetchImpl = async (url) => {
    if (!(url.includes('/mailFolders/inbox/') || url.includes('inbox-next'))) {
      return okPage(finalPage('sentitems', []))
    }
    served += 1
    const value = Array.from({ length: MAX_PAGE_SIZE }, (_, k) => filler((served - 1) * MAX_PAGE_SIZE + k))
    return okPage({
      value,
      '@odata.nextLink': `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$skiptoken=n${served}`,
    })
  }
  const result = await passWith(fetchImpl)

  assert.ok(served > fullPages, 'the fixture must serve past the entry ceiling')
  assert.strictEqual(result.folders.inbox.droppedMessages, MAX_PAGE_SIZE,
    'the folder record must carry the count')
  assert.strictEqual(result.droppedMessages, MAX_PAGE_SIZE,
    'and the pass must sum it rather than reporting 0')
  assert.ok(result.incompleteReasons.includes('messages_dropped'),
    `messages_dropped must be reachable: ${JSON.stringify(result.incompleteReasons)}`)
  assert.strictEqual(result.commitReady, false)
  assert.strictEqual(result.cursors, null)
  // The summary must report it too, so an operator sees the loss.
  const s = summarizePass(result)
  assert.strictEqual(s.dropped_messages, MAX_PAGE_SIZE)
  assert.strictEqual(s.folders.inbox.dropped_messages, MAX_PAGE_SIZE)
  assert.ok(s.incomplete_reasons.includes('messages_dropped'))
})

test('CONVERSATIONS DROPPED: both folders finish cleanly, yet nothing commits', () => {
  // The cleanest form of the defect. Every folder reaches its deltaLink, the message
  // ceiling is NOT breached, and the loss happens entirely at the grouping stage after
  // the merge. Under the old contract this reported completion and returned cursors.
  const perPage = MAX_PAGE_SIZE
  const total = MAX_CONVERSATIONS_PER_RUN + 50
  const pages = Math.ceil(total / perPage)
  let served = 0
  const fetchImpl = async (url) => {
    if (!(url.includes('/mailFolders/inbox/') || url.includes('inbox-next'))) {
      return okPage(finalPage('sentitems', []))
    }
    served += 1
    const value = Array.from({ length: perPage }, (_, k) => filler((served - 1) * perPage + k))
    return okPage(served >= pages
      ? { value, '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$deltatoken=final` }
      : { value, '@odata.nextLink': `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$skiptoken=inbox-next` })
  }
  return passWith(fetchImpl).then((result) => {
    assert.ok(result.totals.messagesSeen <= MAX_MESSAGES_PER_RUN,
      `the fixture must NOT breach the message cap, or it proves the wrong thing (saw ${result.totals.messagesSeen})`)
    for (const f of ['inbox', 'sentitems']) {
      assert.strictEqual(result.folders[f].complete, true, `${f} should have finished`)
      assert.strictEqual(result.folders[f].reachedCursor, true, f)
      assert.strictEqual(result.folders[f].droppedMessages, 0, f)
    }
    assert.strictEqual(result.conversations, MAX_CONVERSATIONS_PER_RUN)
    assert.strictEqual(result.droppedConversations, 50)
    assert.deepStrictEqual(result.incompleteReasons, ['conversations_dropped'],
      'the reason must be exactly this one, not a coincidental folder failure')
    assert.strictEqual(result.commitReady, false)
    assert.strictEqual(result.cursors, null)
  })
})

test('groupByConversation reports dropped and truncated SEPARATELY', async () => {
  // Driven directly, because the two ceilings are distinguishable only here: a
  // discarded thread and a shortened thread are different kinds of loss.
  const overflow = []
  for (let i = 0; i < MAX_CONVERSATIONS_PER_RUN + 6; i++) {
    overflow.push({ message: { providerConversationKey: `k${i}`, providerMessageKey: `m${i}`, timestampIso: '2026-09-20T10:00:00Z' } })
  }
  const g1 = groupByConversation(overflow)
  assert.strictEqual(g1.byConversation.size, MAX_CONVERSATIONS_PER_RUN)
  assert.strictEqual(g1.droppedConversations, 6)
  assert.strictEqual(g1.truncatedConversations, 0)

  const longThread = []
  for (let i = 0; i < MAX_EPISODE_MESSAGES + 9; i++) {
    longThread.push({ message: { providerConversationKey: 'one', providerMessageKey: `m${i}`, timestampIso: `2026-09-20T10:${String(i).padStart(2, '0')}:00Z` } })
  }
  const g2 = groupByConversation(longThread)
  assert.strictEqual(g2.byConversation.get('one').length, MAX_EPISODE_MESSAGES)
  // Counted per CONVERSATION, not per discarded message.
  assert.strictEqual(g2.truncatedConversations, 1)
  assert.strictEqual(g2.droppedConversations, 0)
})

test('A TRUNCATED EPISODE makes the run non-commit-ready, because the view is partial', async () => {
  // One conversation with more messages than MAX_EPISODE_MESSAGES, split across the
  // two folders so it genuinely alternates and would otherwise qualify.
  const inbox = []
  const sent = []
  for (let i = 0; i < MAX_EPISODE_MESSAGES + 8; i++) {
    const m = msg({
      id: `t${i}`, conversationId: 'long',
      from: i % 2 === 0 ? RECRUITER : ME,
      to: [i % 2 === 0 ? ME : RECRUITER],
      sent: `2026-09-20T${String(10 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}:00Z`,
    })
    ;(i % 2 === 0 ? inbox : sent).push(m)
  }
  const fetchImpl = async (url) => okPage(
    url.includes('/mailFolders/inbox/') ? finalPage('inbox', inbox) : finalPage('sentitems', sent))
  const result = await passWith(fetchImpl)

  assert.strictEqual(result.truncatedConversations, 1)
  assert.strictEqual(result.commitReady, false,
    'a suggestion built from a shortened thread rests on a partial view')
  assert.strictEqual(result.cursors, null)
  assert.ok(result.incompleteReasons.includes('episode_truncated'),
    JSON.stringify(result.incompleteReasons))
  // Both folders DID finish - the loss is at the grouping stage, after the merge.
  for (const f of ['inbox', 'sentitems']) {
    assert.strictEqual(result.folders[f].complete, true, f)
    assert.strictEqual(result.folders[f].reachedCursor, true, f)
  }
})

test('A TRUNCATED PLAN makes the run non-commit-ready even with both folders complete', async () => {
  // MAX_PLAN_ENTRIES qualified episodes plus a few more. Both folders finish cleanly;
  // the loss is entirely at the plan stage, which is exactly the case that used to
  // report completion.
  const inbox = []
  const sent = []
  const many = MAX_PLAN_ENTRIES + 4
  for (let i = 0; i < many; i++) {
    inbox.push(msg({ id: `pi${i}`, conversationId: `pc${i}`, from: RECRUITER, to: [ME], sent: '2026-09-20T10:00:00Z' }))
    sent.push(msg({ id: `ps${i}`, conversationId: `pc${i}`, from: ME, to: [RECRUITER], sent: '2026-09-21T10:00:00Z' }))
  }
  // Paged so no single page exceeds MAX_PAGE_SIZE.
  const pageUp = (folder, items) => {
    const chunks = []
    for (let i = 0; i < items.length; i += MAX_PAGE_SIZE) chunks.push(items.slice(i, i + MAX_PAGE_SIZE))
    return chunks.map((c, i) => (i === chunks.length - 1
      ? { value: c, '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=final` }
      : { value: c, '@odata.nextLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$skiptoken=${folder === 'inbox' ? 'inbox' : 'sent'}-next` }))
  }
  const queues = { inbox: pageUp('inbox', inbox), sentitems: pageUp('sentitems', sent) }
  const at = { inbox: 0, sentitems: 0 }
  const fetchImpl = async (url) => {
    const f = (url.includes('/mailFolders/inbox/') || url.includes('inbox-next')) ? 'inbox' : 'sentitems'
    const body = queues[f][at[f]] ?? finalPage(f, [])
    at[f] += 1
    return okPage(body)
  }
  const result = await passWith(fetchImpl)

  assert.strictEqual(result.plan.length, MAX_PLAN_ENTRIES,
    `the plan must be capped (got ${result.plan.length}, skipped ${JSON.stringify(result.skipped)})`)
  assert.ok(result.skipped.plan_cap_reached > 0)
  assert.strictEqual(result.commitReady, false)
  assert.strictEqual(result.cursors, null,
    'discarded episodes would be covered by a cursor that was never earned')
  assert.ok(result.incompleteReasons.includes('plan_truncated'),
    JSON.stringify(result.incompleteReasons))
})

test('INBOX FINISHES, SENT ITEMS DOES NOT: neither cursor is handed back', async () => {
  // The asymmetric case. Inbox reaches its deltaLink cleanly; Sent Items never does.
  // Committing Inbox alone would be wrong, because an episode spans both folders and
  // the ceilings are applied after the merge - so a Sent message this run never saw
  // could belong to a conversation Inbox's cursor already covers.
  const fetchImpl = async (url) => {
    if (url.includes('/mailFolders/inbox/') || url.includes('inbox-next')) {
      return okPage(finalPage('inbox', TWO_SIDED.inbox))
    }
    return okPage({
      value: [],
      '@odata.nextLink': `${GRAPH_BASE}/me/mailFolders/sentitems/messages/delta?$skiptoken=sent-next`,
    })
  }
  const result = await passWith(fetchImpl)

  assert.strictEqual(result.folders.inbox.complete, true, 'Inbox did finish')
  assert.strictEqual(result.folders.inbox.reachedCursor, true)
  assert.strictEqual(result.folders.sentitems.complete, false, 'Sent Items did not')
  assert.strictEqual(result.folders.sentitems.stop, 'max_pages_exceeded')

  assert.strictEqual(result.commitReady, false)
  assert.strictEqual(result.cursors, null,
    "Inbox's cursor must not be committable while Sent Items is unfinished")
  assert.deepStrictEqual(result.incompleteReasons, ['folder_incomplete'])
})

test('THE ONLY commit-ready shape is: both folders finished and nothing dropped', async () => {
  const clean = await passWith(async (url) => okPage(
    url.includes('/mailFolders/inbox/') ? finalPage('inbox', TWO_SIDED.inbox)
      : finalPage('sentitems', TWO_SIDED.sentitems)))
  assert.strictEqual(clean.commitReady, true)
  assert.deepStrictEqual(clean.incompleteReasons, [])
  assert.strictEqual(clean.droppedMessages, 0)
  assert.strictEqual(clean.droppedConversations, 0)
  assert.strictEqual(clean.truncatedConversations, 0)
  assert.ok(clean.cursors && typeof clean.cursors.inbox === 'string' && typeof clean.cursors.sentitems === 'string')
  // And the plan still came out, so the gate is not simply refusing everything.
  assert.strictEqual(clean.plan.length, 1)
})

test('the cursor VALUES are unreachable except through the gate', async () => {
  const incomplete = await passWith(async () => okPage({
    value: [], '@odata.nextLink': `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$skiptoken=inbox-next`,
  }))
  assert.strictEqual(incomplete.cursors, null)
  const serialized = JSON.stringify(incomplete)
  assert.ok(!serialized.includes('$deltatoken'),
    'no delta cursor value may appear anywhere in a non-commit-ready result')
  for (const f of ['inbox', 'sentitems']) {
    assert.strictEqual(incomplete.folders[f].deltaLink, undefined)
  }
})

test('the log summary leads with commit readiness and names the reasons', async () => {
  const incomplete = await passWith(async () => okPage({
    value: [], '@odata.nextLink': `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$skiptoken=inbox-next`,
  }))
  const s = summarizePass(incomplete)
  assert.strictEqual(s.commit_ready, false)
  assert.deepStrictEqual(s.incomplete_reasons, ['folder_incomplete'])
  assert.strictEqual(Object.keys(s)[1], 'commit_ready',
    'a reader must not have to hunt for the gate')
  assert.ok(!JSON.stringify(s).includes('$deltatoken'))
  assert.strictEqual(s.folders.inbox.reached_cursor, false)
})

test('the module documents that oversized mailboxes need a continuation design', () => {
  assert.ok(/CONTINUATION IS NOT IMPLEMENTED/.test(PASS_SRC),
    'the gap must be stated where the ceilings are enforced')
  assert.ok(/makes no progress, forever/.test(PASS_SRC),
    'and its consequence stated, not softened: safe is not the same as working')
  assert.ok(/DURABLE CONTINUATION design/.test(PASS_SRC))
  assert.ok(/worker endpoint must stay disabled/.test(PASS_SRC),
    'and tied to the reason the endpoint is off')
})

test('the worker records continuation as an independent, still-open blocker', () => {
  // The write path, the token path and the continuation design are three different
  // problems. The write path is now built (migration 20260930000000), so the endpoint's
  // stated reason moved to the token path - and continuation must stay named, because
  // clearing the other two would leave an endpoint that can be enabled but cannot make
  // progress on a large mailbox.
  assert.ok(/NO CONTINUATION DESIGN/.test(HANDLER_SRC))
  assert.ok(/makes no progress\s*(\/\/)?\s*forever/.test(HANDLER_SRC))
  assert.ok(/DURABLE\s*(\/\/)?\s*CONTINUATION|Durable continuation/.test(HANDLER_SRC))
  assert.ok(/intermediate nextLink is opaque and time-limited/.test(HANDLER_SRC),
    'why storing partial progress is not trivially safe must be stated')
})

test('every INCOMPLETE_REASONS value is one this pass can actually produce', () => {
  assert.deepStrictEqual([...INCOMPLETE_REASONS].sort(), [
    'conversations_dropped', 'episode_truncated', 'folder_incomplete',
    'messages_dropped', 'plan_truncated',
  ])
  for (const r of INCOMPLETE_REASONS) {
    assert.ok(PASS_SRC.includes(`incompleteReasons.push('${r}')`),
      `${r} is declared but never produced`)
  }
})

async function finish () {
  await Promise.all(pending)
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
await finish()
