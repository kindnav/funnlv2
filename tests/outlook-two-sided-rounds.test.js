// TWO-WAY COMMUNICATION, WHICHEVER SIDE STARTED, ACROSS ROUNDS - THROUGH THE REAL WORKER.
//
// THE REQUIREMENT, stated once. A NEW-CONTACT suggestion needs two-way communication
// with the same person, regardless of who opened the thread:
//
//   1. user sends -> person replies;
//   2. person sends -> user replies.
//
// A single unanswered message must never produce one. Both halves feed the drafted
// interaction. The two halves MAY arrive in different, separately completed import
// rounds. The same two-way rule applies to an existing contact. Acceptance creates the
// contact and the interaction together, after review.
//
// WHAT IS EXECUTED: the REAL worker handler (handleOutlookImportWorker) over the real
// run, the real accumulator, conversation recovery, the real content pass with the real
// screening, the real write planner and the real provider transports - driven by one
// fixture fetch that answers every surface the run touches (Graph delta, Graph message
// envelope, Graph conversation lookup, Graph message content, the Anthropic endpoint)
// and throws on anything else. No network, no database, no browser.
//
// THE TWO CORRECTIONS pinned in sections 3b and 3c were both REPRODUCED through this
// handler before they were made: the user's one older sent message falling out of a
// newest-six selection behind seven replies, and a continuing exchange that was two-sided
// in both rounds being CREATED twice because the second round anchored its identity on
// its own opening message - and, once that was corrected, the same duplicate still being
// written whenever the required recovery was REFUSED (400, truncated page, 404). A refused
// recovery is now a reported no-write settlement (3c).
//
// THE ROUND STORE is the shared in-memory stand-in for the SQL round state and mirrors
// the applied schema's two lifecycle facts exactly: a confirmed complete release ERASES
// the accumulator (release_outlook_sync_lease, 20261002000000:1164) AND the message
// handles (20261007000000, orm_round_conv_fk cascade). So nothing a previous round stored
// is available to a later one here, and cross-round recovery can only pass by asking the
// fixture's "Outlook" - which models arrival: a message exists there from the round in
// which the delta delivered it.
//
// NO REAL IDENTIFIER, ADDRESS, BODY OR KEY APPEARS IN THIS FILE.
//
// Run with: node tests/outlook-two-sided-rounds.test.js

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { handleOutlookImportWorker } from '../supabase/functions/outlook-import-worker/handler.js'
import { importKeyFromBase64, encryptToken } from '../supabase/functions/shared/googleTokenCrypto.js'
import { GRAPH_BASE, ENVELOPE_SELECT, MAX_RECOVERY_MESSAGES_PER_FOLDER } from '../supabase/functions/shared/outlookGraphTransport.js'
import { ANTHROPIC_MESSAGES_URL } from '../supabase/functions/shared/outlookDraftContract.js'
import { REQUIRED_CONTENT_CONSENT_VERSION } from '../supabase/functions/shared/outlookContentConsent.js'
import { planContentWrite } from '../supabase/functions/shared/outlookContentStage.js'
import { CANDIDATE_SELECT, validateOverrides, REVIEW_FOLLOW_UP_MAX } from '../src/lib/calendarReview.js'
import { makeRoundStore } from './harness/outlookRoundStore.js'

let passed = 0
let failed = 0
async function test (name, fn) {
  try {
    await fn()
    console.log('  OK   ' + name)
    passed += 1
  } catch (e) {
    console.error('  FAIL ' + name)
    console.error('       ' + (e && e.message ? e.message : String(e)))
    failed += 1
  }
}

const NL = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8').split(CR).join('')

// -- invented fixtures. No real account, address, id, token or key. ----------
const subtle = webcrypto.subtle
const KEY_B64 = Buffer.alloc(32, 9).toString('base64')
const SECRET = 't'.repeat(40)
const API_KEY = 'sk-ant-fixture-not-a-real-key'
const CONN = '11111111-1111-1111-1111-111111111111'
const PILOT = '22222222-2222-2222-2222-222222222222'
const KNOWN_CONTACT = '33333333-3333-3333-3333-333333333333'
const ME = 'pilot@outlook.test'
const KNOWN = 'ava@bank.test'          // already one of the user's contacts
const STRANGER = 'noor@fund.test'      // not a contact: the unknown-person path
const ACCESS_TOKEN = 'fixture-access-token-not-a-secret'

// Four bodies, two per exchange, each side distinctive enough that the model request
// can be checked for BOTH halves from its text alone - which is all the request carries.
const THEM_FIRST = 'Good to meet you at the panel. I have put your name forward for the '
  + 'spring insight week and the desk would like a short call next week about credit.'
const ME_REPLY = 'Thank you, next week works. I will prepare questions about the credit '
  + 'desk and send over my availability.'
const ME_FIRST = 'Thanks for your talk on the growth-fund panel today. I would value '
  + 'fifteen minutes on how you think about seed diligence.'
const THEM_REPLY = 'Happy to. I am free Thursday afternoon; send a couple of times and '
  + 'I will confirm one.'
const THEM_THIRD = 'Thursday at three is confirmed then; the dial-in is in the calendar invite.'

const envelope = (id, conv, from, to, sent, subject) => ({
  id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
  subject, from: { emailAddress: { address: from, name: 'x' } },
  sender: { emailAddress: { address: from, name: 'x' } },
  toRecipients: to.map((a) => ({ emailAddress: { address: a, name: 'x' } })),
  ccRecipients: [],
})

/**
 * One exchange with `party`: who wrote first, the two (optionally three) envelopes, their
 * folders and bodies. Ids and conversation ids are invented.
 */
function exchange ({ party, order, conv }) {
  const themFirst = order === 'them_first'
  const inId = 'AAkALgAA' + conv + '-in'
  const outId = 'AAkALgAA' + conv + '-out'
  const thirdId = 'AAkALgAA' + conv + '-in2'
  const inbound = envelope(inId, conv, party, [ME], themFirst ? '2026-09-21T14:00:00Z' : '2026-09-21T11:00:00Z', 'Following up')
  const outbound = envelope(outId, conv, ME, [party], themFirst ? '2026-09-21T16:00:00Z' : '2026-09-21T08:00:00Z', 'RE: Following up')
  const third = envelope(thirdId, conv, party, [ME], '2026-09-22T09:00:00Z', 'RE: Following up')
  return {
    inbound, outbound, third,
    folderOf: { [inId]: 'inbox', [outId]: 'sentitems', [thirdId]: 'inbox' },
    bodies: {
      [inId]: themFirst ? THEM_FIRST : THEM_REPLY,
      [outId]: themFirst ? ME_REPLY : ME_FIRST,
      [thirdId]: THEM_THIRD,
    },
  }
}

const workerReq = () => ({
  method: 'POST',
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer ' + SECRET : null) },
})
const env = () => ({
  integrationEnabled: 'true', workerEnabled: 'true', workerSecret: SECRET,
  clientId: 'c', clientSecret: 'cs', tokenKeyB64: KEY_B64,
  fingerprintKey: { current: { keyBytes: new Uint8Array(32).fill(1), keyVersion: 1 } },
  keyVersion: 1, pilotUserId: PILOT,
  scope: 'openid profile email offline_access Mail.Read User.Read',
  anthropicApiKey: API_KEY,
})
const okRes = (body) => ({ status: 200, headers: { get: () => null }, json: async () => body })
const errRes = (status) => ({ status, headers: { get: () => null }, json: async () => ({ error: { code: 'ErrorInvalidUrlQueryFilter', message: 'x' } }) })

/**
 * The PostgREST + RPC pair for ONE connection across as many invocations as the test
 * makes. The round store persists between invocations exactly as the tables would -
 * including erasing the accumulator AND the handles on a complete release - and the
 * committed cursors are served back from it the way the real loader reads them.
 *
 * Candidate writes are deduplicated by episode fingerprint the way the two write RPCs
 * do - a repeat answers 'refreshed' - so a re-read of the same exchange can be shown to
 * produce no second proposal.
 */
async function makePorts ({ contacts }) {
  const key = await importKeyFromBase64(KEY_B64, subtle)
  const sealed = await encryptToken(ACCESS_TOKEN, key, { subtle })
  const expires = new Date(Date.now() + 3600000).toISOString()
  const store = makeRoundStore()
  const candidates = []
  const releases = []
  const episodes = new Set()
  // Exchanges the reviewer has DECIDED (accepted or dismissed): the write RPCs answer
  // exists_terminal for them and write nothing, exactly as the applied functions do.
  const terminal = new Set()
  const select = async (path) => {
    if (path.startsWith('microsoft_connections?')) {
      return { data: [{
        user_id: PILOT, ms_email: ME, scopes: ['Mail.Read', 'User.Read'],
        token_expires_at: expires,
        consent_policy_version: REQUIRED_CONTENT_CONSENT_VERSION,
      }], error: null }
    }
    if (path.startsWith('contacts?')) {
      return { data: path.includes('offset=0') ? contacts : [], error: null }
    }
    if (path.startsWith('outlook_sync_state?')) {
      // THE COMMITTED CURSORS, exactly where the real loader reads them.
      const rows = []
      for (const folder of ['inbox', 'sentitems']) {
        const f = store.folders[folder]
        if (f && f.delta_link_ciphertext) {
          rows.push({ folder, delta_link_ciphertext: f.delta_link_ciphertext, delta_link_nonce: f.delta_link_nonce })
        }
      }
      return { data: rows, error: null }
    }
    if (path.startsWith('microsoft_tokens?')) {
      return { data: [{
        access_token_ciphertext: sealed.ciphertext, access_token_nonce: sealed.nonce,
        refresh_token_ciphertext: sealed.ciphertext, refresh_token_nonce: sealed.nonce,
        key_version: 1, token_expires_at: expires,
      }], error: null }
    }
    throw new Error('unexpected select: ' + path)
  }
  const rpc = async (name, args) => {
    if (name === 'reserve_due_outlook_connection') {
      return { data: {
        result: 'reserved', connection_id: CONN, user_id: PILOT, run_id: 'run-1',
        inbox_initial_import_done: store.folders.inbox.initial_import_done,
        sentitems_initial_import_done: store.folders.sentitems.initial_import_done,
      }, error: null }
    }
    if (name === 'renew_outlook_sync_lease') return { data: true, error: null }
    if (name === 'upsert_outlook_interaction_candidate' || name === 'upsert_new_contact_candidate') {
      const fp = args && args.p_episode_fingerprint
      const result = terminal.has(fp) ? 'exists_terminal' : episodes.has(fp) ? 'refreshed' : 'created'
      episodes.add(fp)
      candidates.push({ rpc: name, args, result })
      return { data: { result }, error: null }
    }
    if (name === 'release_outlook_sync_lease') {
      releases.push({ status: args && args.p_status, complete: args && args.p_run_complete })
      if (args && args.p_run_complete === true) store.commitRelease()
      return { data: true, error: null }
    }
    if (name === 'rotate_microsoft_access_token') {
      throw new Error('no refresh may be attempted: the fixture token is fresh')
    }
    // Everything else - the round state AND the handles, with their real lifecycle.
    const s = await store.handle(name, args)
    if (s !== null) return s
    throw new Error('unexpected rpc: ' + name)
  }
  return { select, rpc, store, candidates, releases, decide: (fp) => terminal.add(fp) }
}

const MESSAGES_PREFIX = GRAPH_BASE + '/me/messages/'
function messageIdOf (u) {
  if (!u.startsWith(MESSAGES_PREFIX)) return null
  const q = u.indexOf('?', MESSAGES_PREFIX.length)
  if (q < 0) return null
  return decodeURIComponent(u.slice(MESSAGES_PREFIX.length, q))
}
function queryParam (u, name) {
  const q = u.indexOf('?')
  if (q < 0) return null
  for (const part of u.slice(q + 1).split('&')) {
    const eq = part.indexOf('=')
    const k = eq < 0 ? part : part.slice(0, eq)
    if (k === name) return decodeURIComponent(eq < 0 ? '' : part.slice(eq + 1))
  }
  return null
}
function deltaToken (u) {
  const t = queryParam(u, '$deltatoken')
  return t === null || t.length === 0 ? null : t
}

/**
 * A MAILBOX SERVED IN ROUNDS, that also answers as "Outlook" when asked about a thread.
 *
 * `rounds[folder][k]` is the page the folder answers in its (k+1)th round. A request with
 * no $deltatoken is the first round; `Rk` - the deltaLink the previous round committed -
 * is round k+1. Every page is final, so one invocation completes one round.
 *
 * ARRIVAL IS MODELLED: a message exists in Outlook from the round whose delta page carried
 * it. So in round 1 a lookup cannot find a reply that only arrives in round 2.
 */
function makeFetch ({ rounds, envelopes, folderOf, bodies, counts, model, faults = {}, clock }) {
  const visible = new Set()
  return async (url, init) => {
    const u = String(url)
    const prefer = init && init.headers && (init.headers.Prefer || init.headers.prefer)
    if (u === ANTHROPIC_MESSAGES_URL) {
      counts.model += 1
      const sent = String((init && init.body) || '')
      counts.modelBodies.push(sent)
      const newContact = sent.indexOf('new_contact_suggestion') >= 0
      const payload = newContact
        ? {
            result: 'new_contact_suggestion',
            name: 'Noor Haddad', name_evidence: 'explicit_signature', name_confidence: 'high',
            summary: model.summary, summary_evidence: 'explicit_body',
            follow_up: model.followUp, interaction_date: null,
          }
        : {
            result: 'interaction_draft',
            summary: model.summary, summary_evidence: 'explicit_body',
            follow_up: model.followUp, interaction_date: null,
          }
      return okRes({
        id: 'msg_fixture', type: 'message', role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    }
    const id = messageIdOf(u)
    if (id !== null) {
      const select = queryParam(u, '$select') || ''
      const env_ = envelopes[id]
      if (select.indexOf('uniqueBody') < 0) {
        // THE ENVELOPE GET of conversation recovery: no body, no headers.
        counts.envelopeGets.push({ id, select, prefer })
        if (faults.envelope === 'not_found' || !env_) return { status: 404, headers: { get: () => null }, json: async () => ({ error: { code: 'ErrorItemNotFound' } }) }
        return okRes(Object.assign({}, env_))
      }
      counts.bodies += 1
      const text = bodies[id]
      if (!env_ || !text) return { status: 404, headers: { get: () => null }, json: async () => ({}) }
      const headersMissing = faults.headersMissingFor && faults.headersMissingFor.has(id)
      return okRes(Object.assign({}, env_, {
        body: { contentType: 'text', content: text },
        uniqueBody: { contentType: 'text', content: text },
      }, headersMissing ? {} : { internetMessageHeaders: [{ name: 'Received', value: 'by fixture' }] }))
    }
    if (!u.startsWith(GRAPH_BASE)) throw new Error('the fixture refuses a non-Graph URL: ' + u.slice(0, 60))
    const folder = u.indexOf('/mailFolders/inbox/') >= 0 ? 'inbox' : 'sentitems'
    const filter = queryParam(u, '$filter')
    if (filter !== null) {
      // THE CONVERSATION LOOKUP: what "Outlook" holds for this thread in this folder.
      const m = filter.startsWith("conversationId eq '") && filter.endsWith("'") ? filter.slice("conversationId eq '".length, -1) : null
      counts.lookups.push({ folder, conv: m, select: queryParam(u, '$select'), top: queryParam(u, '$top'),
        hasOrderBy: queryParam(u, '$orderby') !== null, prefer })
      if (typeof clock === 'object' && clock.trapOnLookup) { clock.ms += clock.trapOnLookup; clock.trapOnLookup = 0 }
      if (faults.lookup === 'bad_request') return errRes(400)
      const items = Object.values(envelopes)
        .filter((e) => e.conversationId === m && folderOf[e.id] === folder && visible.has(e.id))
        .filter((e) => !(faults.lookup === 'only_current' && !counts.currentIds.has(e.id)))
      const page = { value: items }
      if (faults.lookup === 'truncated') page['@odata.nextLink'] = GRAPH_BASE + '/me/mailFolders/' + folder + '/messages?$skip=25'
      return okRes(page)
    }
    const token = deltaToken(u)
    const k = token === null ? 1 : Number(token.slice(1)) + 1
    counts.delta.push({ folder, token })
    const seq = rounds[folder] || []
    const page = seq[k - 1] || []
    for (const e of page) { visible.add(e.id); counts.currentIds.add(e.id) }
    return okRes({
      value: page,
      '@odata.deltaLink': GRAPH_BASE + '/me/mailFolders/' + folder + '/messages/delta?$deltatoken=R' + k,
    })
  }
}

const newCounts = () => ({ delta: [], bodies: 0, model: 0, modelBodies: [], envelopeGets: [], lookups: [], currentIds: new Set() })
const FIXED = 1780000000000
const MODEL = {
  summary: 'They offered a short call next week about the credit desk after putting your name forward.',
  followUp: 'Send your availability for next week.',
}

async function invoke (ports, fetchImpl, clock) {
  const res = await handleOutlookImportWorker(workerReq(), env(), {
    tokenUrl: 'https://login.invalid/token',
    select: ports.select,
    rpc: ports.rpc,
    graphFetchImpl: fetchImpl,
    now: () => (clock ? clock.ms : FIXED),
    subtle,
    requiredBackgroundConsent: REQUIRED_CONTENT_CONSENT_VERSION,   // the row's version: re-consented under the current notice
  })
  const body = await res.json()
  return { status: res.status, run: body && body.run }
}

/** Build a scenario: who the party is, which side wrote first, and how the messages are spread over rounds. */
function scenario ({ party, order, inboxRounds, sentRounds }) {
  const ex = exchange({ party, order, conv: 'AAQkAD-' + order + '-' + (party === KNOWN ? 'known' : 'new') })
  const pick = (spec) => spec.map((which) => (which === 'in' ? [ex.inbound] : which === 'out' ? [ex.outbound]
    : which === 'in2' ? [ex.third] : []))
  const rounds = { inbox: pick(inboxRounds), sentitems: pick(sentRounds) }
  const envelopes = { [ex.inbound.id]: ex.inbound, [ex.outbound.id]: ex.outbound, [ex.third.id]: ex.third }
  return { ex, rounds, envelopes, folderOf: ex.folderOf, bodies: ex.bodies }
}

async function runScenario ({ party, order, inboxRounds, sentRounds, invocations = 1, faults, clock, beforeInvocation }) {
  const s = scenario({ party, order, inboxRounds, sentRounds })
  const ports = await makePorts({ contacts: [{ id: KNOWN_CONTACT, user_id: PILOT, email: KNOWN }] })  // the stranger is never a contact
  const counts = newCounts()
  const fetchImpl = makeFetch({ rounds: s.rounds, envelopes: s.envelopes, folderOf: s.folderOf, bodies: s.bodies, counts, model: MODEL, faults, clock })
  const runs = []
  // What the world looked like AFTER each invocation, so a claim about round 1 is checked
  // against round 1 and not against the state a later round left behind.
  const after = []
  for (let i = 0; i < invocations; i += 1) {
    counts.currentIds = new Set()
    if (typeof beforeInvocation === 'function') beforeInvocation(i, counts)
    runs.push(await invoke(ports, fetchImpl, clock))
    after.push({
      candidates: ports.candidates.length,
      conversations: ports.store.conversations.size,
      messages: ports.store.messages.length,
      envelopeGets: counts.envelopeGets.length,
      lookups: counts.lookups.length,
      bodies: counts.bodies,
      model: counts.model,
    })
  }
  return { runs, ports, counts, s, after }
}

const summarize = (r) => JSON.stringify({ outcome: r.run && r.run.outcome, content: r.run && r.run.content,
  skipped: r.run && r.run.entry_skipped, finalize: r.run && r.run.finalize, cursors: r.run && r.run.cursors_advanced })

function assertLookupShape (lookups, conv) {
  assert.strictEqual(lookups.length, 2, 'one lookup per folder: ' + JSON.stringify(lookups))
  assert.deepStrictEqual(lookups.map((l) => l.folder).sort(), ['inbox', 'sentitems'])
  for (const l of lookups) {
    assert.strictEqual(l.conv, conv, 'filtered to THIS conversation')
    assert.strictEqual(l.select, ENVELOPE_SELECT.join(','), 'envelope fields only')
    assert.strictEqual(l.top, String(MAX_RECOVERY_MESSAGES_PER_FOLDER))
    assert.strictEqual(l.hasOrderBy, false, 'no $orderby with $filter on messages')
    assert.ok(String(l.prefer).indexOf('IdType="ImmutableId"') >= 0, 'immutable ids on every request: ' + l.prefer)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('1. an unknown person is proposed WHICHEVER SIDE STARTED, when both halves are in one round')
// ═══════════════════════════════════════════════════════════════════════════════
const controlFingerprints = {}
for (const [label, order, inboxRounds, sentRounds, mine, theirs] of [
  ['person sends, user replies', 'them_first', ['in'], ['out'], 'credit desk', 'insight week'],
  ['user sends, person replies', 'me_first', ['in'], ['out'], 'seed diligence', 'Thursday afternoon'],
]) {
  await test(label + ' -> ONE new-contact proposal carrying both sides', async () => {
    const { runs, ports, counts } = await runScenario({ party: STRANGER, order, inboxRounds, sentRounds })
    const [r] = runs
    assert.strictEqual(r.status, 200, summarize(r))
    assert.strictEqual(r.run.outcome, 'committed', summarize(r))
    assert.strictEqual(r.run.content.proposals_written, 1, summarize(r))
    assert.strictEqual(r.run.content.notes_written, 0, 'an unknown person is a proposal, not a note')
    assert.strictEqual(r.run.content.attempted, 1)
    assert.strictEqual(r.run.content.bodies_read, 2, 'both halves were read')
    assert.strictEqual(r.run.content.model_calls, 1)
    assert.strictEqual(r.run.content.recoveries_attempted, 0, 'nothing to recover when both halves are in the round')
    assert.deepStrictEqual(r.run.content.deferred, {}, 'nothing deferred')
    assert.strictEqual(ports.candidates.length, 1)
    const w = ports.candidates[0]
    assert.strictEqual(w.rpc, 'upsert_new_contact_candidate')
    assert.strictEqual(w.args.p_proposed_email, STRANGER, 'the address is the envelope address')
    assert.strictEqual(w.args.p_proposed_name, 'Noor Haddad')
    assert.strictEqual(w.args.p_name_evidence, 'explicit_signature')
    assert.strictEqual(w.args.p_draft_summary, MODEL.summary)
    assert.strictEqual(w.args.p_draft_follow_up, MODEL.followUp, 'the next step travels with the proposal')
    assert.strictEqual(w.args.p_extraction_status, 'ai_extracted')
    controlFingerprints[order] = w.args.p_episode_fingerprint
    // BOTH SIDES REACHED THE MODEL in the one request.
    assert.strictEqual(counts.modelBodies.length, 1)
    assert.ok(counts.modelBodies[0].indexOf(mine) >= 0, 'the user side is missing from the request')
    assert.ok(counts.modelBodies[0].indexOf(theirs) >= 0, 'the other side is missing from the request')
    assert.ok(counts.modelBodies[0].indexOf(STRANGER) < 0, 'no address in the model request')
    assert.ok(counts.modelBodies[0].indexOf(ME) < 0, 'no self address in the model request')
  })
}

await test('an EXISTING contact in either order -> one note WITH its next step and provenance', async () => {
  for (const order of ['them_first', 'me_first']) {
    const { runs, ports } = await runScenario({ party: KNOWN, order, inboxRounds: ['in'], sentRounds: ['out'] })
    const [r] = runs
    assert.strictEqual(r.run.outcome, 'committed', summarize(r))
    assert.strictEqual(r.run.content.notes_written, 1, order + ': ' + summarize(r))
    assert.strictEqual(r.run.content.proposals_written, 0, order)
    const w = ports.candidates[0]
    assert.strictEqual(w.rpc, 'upsert_outlook_interaction_candidate', order)
    assert.strictEqual(w.args.p_contact_id, KNOWN_CONTACT, order)
    assert.strictEqual(w.args.p_proposed_notes, MODEL.summary, order)
    assert.strictEqual(w.args.p_draft_follow_up, MODEL.followUp, order + ': the next step used to be dropped here')
    assert.strictEqual(w.args.p_summary_evidence, 'explicit_body', order)
    assert.strictEqual(w.args.p_extraction_status, 'ai_extracted', order)
    assert.strictEqual(w.args.p_retained_subject, undefined, order + ': still no subject on the known-contact row')
    controlFingerprints['known-' + order] = w.args.p_episode_fingerprint
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('2. a single unanswered message proposes nothing, in either direction')
// ═══════════════════════════════════════════════════════════════════════════════
for (const [label, inboxRounds, sentRounds] of [
  ['the person wrote and the user never replied', ['in'], ['none']],
  ['the user wrote and the person never replied', ['none'], ['out']],
]) {
  await test(label + ' -> Outlook is asked, the thread is still one-sided: no body read, no model call, nothing written', async () => {
    const { runs, ports, counts } = await runScenario({ party: STRANGER, order: 'them_first', inboxRounds, sentRounds })
    const [r] = runs
    assert.strictEqual(r.run.outcome, 'committed', summarize(r))
    assert.strictEqual(r.run.entry_skipped.not_two_sided, 1, summarize(r))
    // The round could not know whether the other half is in Outlook, so it asked -
    // three envelope-only requests - and the answer was that there is none.
    assert.strictEqual(r.run.content.recoveries_attempted, 1, summarize(r))
    assert.deepStrictEqual(r.run.content.recovery_outcomes, { not_two_sided: 1 }, summarize(r))
    assert.strictEqual(counts.envelopeGets.length, 1)
    assert.strictEqual(counts.lookups.length, 2)
    assert.strictEqual(r.run.content.attempted, 0, 'the content stage is never reached')
    assert.strictEqual(counts.bodies, 0, 'NO body is read for a one-sided thread')
    assert.strictEqual(counts.model, 0, 'and the model is never called')
    assert.strictEqual(ports.candidates.length, 0)
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('3. the two halves in DIFFERENT, SEPARATELY COMPLETED rounds are recognised as one exchange')
// ═══════════════════════════════════════════════════════════════════════════════
//
// Round 1 reads the first half alone: the thread is one-sided, Outlook is asked and
// confirms there is no reply yet, nothing is written, the round completes, both cursors
// commit and the accumulator AND the handles are erased. Round 2 follows the committed
// deltaLink and reads the reply alone - a thread it does not remember - asks Outlook for
// the rest of it, gets both halves back, folds them exactly as a same-round read would,
// reads both bodies, drafts, and writes ONE suggestion under the SAME episode key the
// one-round control produced.
for (const [label, party, order, inboxRounds, sentRounds, expectRpc, controlKey] of [
  ['unknown person: person writes in round 1, user replies in round 2', STRANGER, 'them_first', ['in', 'none'], ['none', 'out'], 'upsert_new_contact_candidate', 'them_first'],
  ['unknown person: user writes in round 1, person replies in round 2', STRANGER, 'me_first', ['none', 'in'], ['out', 'none'], 'upsert_new_contact_candidate', 'me_first'],
  ['existing contact: person writes in round 1, user replies in round 2', KNOWN, 'them_first', ['in', 'none'], ['none', 'out'], 'upsert_outlook_interaction_candidate', 'known-them_first'],
  ['existing contact: user writes in round 1, person replies in round 2', KNOWN, 'me_first', ['none', 'in'], ['out', 'none'], 'upsert_outlook_interaction_candidate', 'known-me_first'],
]) {
  await test(label + ' -> recovered in round 2: ONE suggestion, both halves in the draft, the same key as one round', async () => {
    const { runs, ports, counts, s, after } = await runScenario({ party, order, inboxRounds, sentRounds, invocations: 2 })
    const [r1, r2] = runs
    // Round 1: one-sided, asked, confirmed one-sided, committed, erased.
    assert.strictEqual(r1.run.outcome, 'committed', 'round 1: ' + summarize(r1))
    assert.strictEqual(r1.run.entry_skipped.not_two_sided, 1, 'round 1: ' + summarize(r1))
    assert.deepStrictEqual(r1.run.content.recovery_outcomes, { not_two_sided: 1 }, 'round 1 asked Outlook and the reply was not there yet')
    assert.strictEqual(r1.run.cursors_advanced, 2, 'round 1 committed both cursors')
    assert.strictEqual(after[0].candidates, 0, 'nothing written in round 1')
    assert.strictEqual(after[0].conversations, 0, 'the accumulator is erased by the complete release')
    assert.strictEqual(after[0].messages, 0, 'and so are the handles - nothing survives into round 2')
    assert.strictEqual(after[0].bodies, 0, 'no body was read in round 1')
    const round1Envelopes = after[0].envelopeGets
    const round1Lookups = after[0].lookups
    // Round 2 really did start from the committed position.
    const tokens = counts.delta.map((d) => d.token)
    assert.ok(tokens.includes('R1'), 'round 2 must follow the committed deltaLink: ' + JSON.stringify(tokens))
    // Round 2: the reply alone in the round; recovered from Outlook; one suggestion.
    assert.strictEqual(r2.run.outcome, 'committed', 'round 2: ' + summarize(r2))
    assert.strictEqual(r2.run.content.recoveries_attempted, 1, summarize(r2))
    assert.strictEqual(r2.run.content.recoveries_two_sided, 1, summarize(r2))
    assert.strictEqual(r2.run.content.recovered_messages, 2, 'both halves came back from Outlook')
    assert.deepStrictEqual(r2.run.content.recovery_outcomes, { recovered: 1 })
    assert.strictEqual(r2.run.content.attempted, 1)
    assert.strictEqual(r2.run.content.bodies_read, 2, 'both bodies were read, after the exchange qualified')
    assert.strictEqual(r2.run.content.model_calls, 1)
    assert.deepStrictEqual(r2.run.content.deferred, {})
    assert.strictEqual(r2.run.entry_skipped.not_two_sided, undefined, 'round 2 did not give up on it')
    assert.strictEqual(r2.run.cursors_advanced, 2)
    // The requests recovery made in round 2, shaped as documented.
    assert.strictEqual(counts.envelopeGets.length - round1Envelopes, 1, 'exactly one envelope GET in round 2')
    const lookups2 = counts.lookups.slice(round1Lookups)
    assertLookupShape(lookups2, s.ex.inbound.conversationId)
    // THE WRITE.
    assert.strictEqual(ports.candidates.length, 1, JSON.stringify(ports.candidates.map((c) => c.rpc)))
    const w = ports.candidates[0]
    assert.strictEqual(w.rpc, expectRpc)
    assert.strictEqual(w.result, 'created')
    if (party === STRANGER) {
      assert.strictEqual(w.args.p_proposed_email, STRANGER)
      assert.strictEqual(w.args.p_draft_summary, MODEL.summary)
      assert.strictEqual(w.args.p_draft_follow_up, MODEL.followUp)
    } else {
      assert.strictEqual(w.args.p_contact_id, KNOWN_CONTACT)
      assert.strictEqual(w.args.p_proposed_notes, MODEL.summary)
      assert.strictEqual(w.args.p_draft_follow_up, MODEL.followUp)
    }
    // THE KEY IS THE SAME KEY the one-round read of the identical exchange produced, so a
    // later re-read of the thread refreshes this row instead of writing a second one.
    assert.strictEqual(w.args.p_episode_fingerprint, controlFingerprints[controlKey],
      'the dedupe key must not depend on which round saw which half')
    // BOTH SIDES CONTRIBUTED TO THE DRAFT: the model request carries both bodies.
    const sent = counts.modelBodies[counts.modelBodies.length - 1]
    const mine = order === 'them_first' ? 'credit desk' : 'seed diligence'
    const theirs = order === 'them_first' ? 'insight week' : 'Thursday afternoon'
    assert.ok(sent.indexOf(mine) >= 0 && sent.indexOf(theirs) >= 0, 'the model request must carry both halves')
    assert.ok(sent.indexOf(party) < 0 && sent.indexOf(ME) < 0, 'and no address')
  })
}

await test('a THIRD message in a later round refreshes the recovered suggestion under the same key - no duplicate, no re-log', async () => {
  // Round 1: both halves (proposed). Round 2: the stranger writes again -> one-sided in
  // the round -> recovered as the whole three-message thread -> the same episode key ->
  // the write RPC answers refreshed, not created.
  const { runs, ports } = await runScenario({ party: STRANGER, order: 'them_first', inboxRounds: ['in', 'in2'], sentRounds: ['out', 'none'], invocations: 2 })
  const [r1, r2] = runs
  assert.strictEqual(r1.run.created, 1, summarize(r1))
  assert.strictEqual(r2.run.outcome, 'committed', summarize(r2))
  assert.deepStrictEqual(r2.run.content.recovery_outcomes, { recovered: 1 }, summarize(r2))
  assert.strictEqual(r2.run.content.recovered_messages, 3)
  assert.strictEqual(r2.run.created, 0, 'no second proposal')
  assert.strictEqual(r2.run.accepted, 1, 'the repeat is a refresh')
  assert.strictEqual(ports.candidates.length, 2)
  assert.strictEqual(ports.candidates[0].args.p_episode_fingerprint, ports.candidates[1].args.p_episode_fingerprint)
  assert.strictEqual(ports.candidates[1].result, 'refreshed')
})

await test('the same two messages served again produce the same episode key and a refreshed write, not a second proposal', async () => {
  const { runs, ports } = await runScenario({ party: STRANGER, order: 'them_first', inboxRounds: ['in', 'in'], sentRounds: ['out', 'out'], invocations: 2 })
  const [r1, r2] = runs
  assert.strictEqual(r1.run.created, 1, summarize(r1))
  assert.strictEqual(r2.run.created, 0, 'round 2 must not create a second proposal: ' + summarize(r2))
  assert.strictEqual(r2.run.accepted, 1)
  assert.strictEqual(ports.candidates[0].args.p_episode_fingerprint, ports.candidates[1].args.p_episode_fingerprint)
  assert.strictEqual(ports.candidates[1].result, 'refreshed')
})

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('3b. BOTH SIDES survive the selection when one side wrote much more')
// ═══════════════════════════════════════════════════════════════════════════════
//
// REPRODUCED through this handler before the correction: round 1 held the user's one sent
// message and committed; round 2 brought seven newer replies; recovery qualified the
// exchange; the merged handles were sorted newest-first and cut to six - all inbound - and
// the user's own words were absent from the model request. ONE selection rule now applies
// to stored and recovered handles alike (selectBalancedHandles: the newest two per folder
// first, then recency), and the episode bound after the bodies are read reserves the
// newest two per direction the same way. The request builder refuses an oversized request
// rather than trimming it, so there is no later point at which the account turns one-sided.

/**
 * A thread of ANY shape. Each turn is [who, day, hour, body]: `who` is 'me', 'them' or an
 * invented address for a third person; the folder follows who wrote. Ids are invented.
 */
function thread ({ party, conv, turns }) {
  const envelopes = {}
  const folderOf = {}
  const bodies = {}
  const ids = []
  turns.forEach(([who, day, hour, body], i) => {
    const id = 'AAkALgAA' + conv + '-' + i
    const at = '2026-09-' + String(day).padStart(2, '0') + 'T' + String(hour).padStart(2, '0') + ':00:00Z'
    const subject = i === 0 ? 'Following up' : 'RE: Following up'
    const from = who === 'me' ? ME : who === 'them' ? party : who
    envelopes[id] = who === 'me' ? envelope(id, conv, ME, [party], at, subject) : envelope(id, conv, from, [ME], at, subject)
    folderOf[id] = who === 'me' ? 'sentitems' : 'inbox'
    bodies[id] = body
    ids.push(id)
  })
  return { envelopes, folderOf, bodies, ids, conv }
}

/** Run `threads` over rounds: `schedule[k]` lists the message ids whose delta page arrives in round k+1. */
async function runThreads ({ threads, schedule, invocations, faults, beforeInvocation }) {
  const envelopes = Object.assign({}, ...threads.map((t) => t.envelopes))
  const folderOf = Object.assign({}, ...threads.map((t) => t.folderOf))
  const bodies = Object.assign({}, ...threads.map((t) => t.bodies))
  const rounds = { inbox: [], sentitems: [] }
  for (const ids of schedule) {
    rounds.inbox.push(ids.filter((id) => folderOf[id] === 'inbox').map((id) => envelopes[id]))
    rounds.sentitems.push(ids.filter((id) => folderOf[id] === 'sentitems').map((id) => envelopes[id]))
  }
  const ports = await makePorts({ contacts: [{ id: KNOWN_CONTACT, user_id: PILOT, email: KNOWN }] })
  const counts = newCounts()
  const fetchImpl = makeFetch({ rounds, envelopes, folderOf, bodies, counts, model: MODEL, faults })
  const runs = []
  const after = []
  for (let i = 0; i < invocations; i += 1) {
    counts.currentIds = new Set()
    if (typeof beforeInvocation === 'function') beforeInvocation(i, ports, counts)
    runs.push(await invoke(ports, fetchImpl))
    after.push({ candidates: ports.candidates.length, bodies: counts.bodies, model: counts.model,
      envelopeGets: counts.envelopeGets.length, lookups: counts.lookups.length })
  }
  return { runs, ports, counts, after }
}
const carries = (text, tag) => String(text).indexOf(tag) >= 0

await test('one older sent message, then SEVEN newer replies in a later round: the user side is among the six bodies read AND in the model request', async () => {
  const t = thread({ party: STRANGER, conv: 'AAQkAD-balance-in', turns: [
    ['me', 1, 9, 'MINE-ONLY thanks for your talk on the growth-fund panel; I would value fifteen minutes on seed diligence.'],
    ['them', 2, 9, 'REPLY-ONE happy to; what are you working on at the moment?'],
    ['them', 3, 9, 'REPLY-TWO and which year are you in?'],
    ['them', 4, 9, 'REPLY-THREE I can do Thursday or Friday.'],
    ['them', 5, 9, 'REPLY-FOUR Thursday at three then.'],
    ['them', 6, 9, 'REPLY-FIVE the dial-in is in the calendar invite.'],
    ['them', 7, 9, 'REPLY-SIX looking forward to it.'],
    ['them', 8, 9, 'REPLY-SEVEN one more thing: bring a question about the fund.'],
  ] })
  const { runs, ports, counts } = await runThreads({ threads: [t], schedule: [[t.ids[0]], t.ids.slice(1)], invocations: 2 })
  const [r1, r2] = runs
  assert.strictEqual(r1.run.outcome, 'committed', summarize(r1))
  assert.deepStrictEqual(r1.run.content.recovery_outcomes, { not_two_sided: 1 }, 'round 1: the user wrote, nobody had replied')
  assert.strictEqual(r2.run.outcome, 'committed', summarize(r2))
  assert.deepStrictEqual(r2.run.content.recovery_outcomes, { recovered: 1 }, summarize(r2))
  assert.strictEqual(r2.run.content.recovered_messages, 8, 'the whole thread came back from Outlook')
  assert.strictEqual(r2.run.content.bodies_read, 6, 'the fetch limit is unchanged: six bodies')
  assert.strictEqual(r2.run.content.model_calls, 1)
  assert.strictEqual(ports.candidates.length, 1)
  assert.strictEqual(ports.candidates[0].rpc, 'upsert_new_contact_candidate')
  const sent = counts.modelBodies[0]
  assert.ok(carries(sent, 'MINE-ONLY'), 'THE USER SIDE IS IN THE MODEL REQUEST')
  for (const tag of ['REPLY-THREE', 'REPLY-FOUR', 'REPLY-FIVE', 'REPLY-SIX', 'REPLY-SEVEN']) assert.ok(carries(sent, tag), tag + ' is in the request')
  assert.ok(!carries(sent, 'REPLY-ONE') && !carries(sent, 'REPLY-TWO'), 'the two oldest replies gave way, not the other side')
  assert.ok(!carries(sent, STRANGER) && !carries(sent, ME), 'no address')
})

await test('the reversed imbalance - one older message from the person, then SEVEN newer messages from the user: the other person is in the request', async () => {
  const t = thread({ party: KNOWN, conv: 'AAQkAD-balance-out', turns: [
    ['them', 1, 9, 'THEIRS-ONLY good to meet you at the panel; I have put your name forward for the insight week.'],
    ['me', 2, 9, 'MINE-ONE thank you, that is very kind.'],
    ['me', 3, 9, 'MINE-TWO I have attached my availability.'],
    ['me', 4, 9, 'MINE-THREE and a short note on my background.'],
    ['me', 5, 9, 'MINE-FOUR is next Thursday still convenient?'],
    ['me', 6, 9, 'MINE-FIVE I will prepare questions about the credit desk.'],
    ['me', 7, 9, 'MINE-SIX looking forward to it.'],
    ['me', 8, 9, 'MINE-SEVEN see you Thursday.'],
  ] })
  const { runs, ports, counts } = await runThreads({ threads: [t], schedule: [[t.ids[0]], t.ids.slice(1)], invocations: 2 })
  const [r1, r2] = runs
  assert.deepStrictEqual(r1.run.content.recovery_outcomes, { not_two_sided: 1 }, summarize(r1))
  assert.strictEqual(r2.run.outcome, 'committed', summarize(r2))
  assert.deepStrictEqual(r2.run.content.recovery_outcomes, { recovered: 1 }, summarize(r2))
  assert.strictEqual(r2.run.content.bodies_read, 6)
  assert.strictEqual(r2.run.content.notes_written, 1, 'an existing contact: a note')
  assert.strictEqual(ports.candidates[0].rpc, 'upsert_outlook_interaction_candidate')
  const sent = counts.modelBodies[0]
  assert.ok(carries(sent, 'THEIRS-ONLY'), 'THE OTHER PERSON IS IN THE MODEL REQUEST')
  for (const tag of ['MINE-THREE', 'MINE-FOUR', 'MINE-FIVE', 'MINE-SIX', 'MINE-SEVEN']) assert.ok(carries(sent, tag), tag + ' is in the request')
  assert.ok(!carries(sent, 'MINE-ONE') && !carries(sent, 'MINE-TWO'), 'the two oldest of the user side gave way')
  assert.ok(!carries(sent, KNOWN) && !carries(sent, ME), 'no address')
})

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('3c. a CONTINUING exchange keeps ONE identity, whichever sides wrote between imports')
// ═══════════════════════════════════════════════════════════════════════════════
//
// REPRODUCED before the correction: round 1 - a message and the user's reply - left a
// pending proposal; round 2 - a further message and a further reply - was two-sided on its
// own, so recovery was bypassed, the episode was anchored on round 2's opening message, a
// DIFFERENT fingerprint, and the run answered created:1 instead of refreshing. Now a delta
// round completes EVERY conversation it is about to write from Outlook first, so the fold
// anchors on the thread's first message as Outlook holds it - the anchor a first pass
// produces - and the write RPC refreshes the pending row. The draft is built from the whole
// thread for the same reason.
for (const [label, party, expectRpc] of [
  ['an unknown person', STRANGER, 'upsert_new_contact_candidate'],
  ['an existing contact', KNOWN, 'upsert_outlook_interaction_candidate'],
]) {
  await test(label + ': round 1 two-sided and proposed, round 2 two-sided again -> the pending proposal is REFRESHED under the same identity, from the whole thread', async () => {
    const t = thread({ party, conv: 'AAQkAD-continuing-' + (party === KNOWN ? 'known' : 'new'), turns: [
      ['them', 1, 9, 'OPENING good to meet you at the panel; the desk would like a short call about credit.'],
      ['me', 1, 15, 'FIRST-REPLY thank you, next week works; I will send my availability.'],
      ['them', 3, 9, 'SECOND-MESSAGE Thursday at three is confirmed; the dial-in is in the invite.'],
      ['me', 3, 15, 'SECOND-REPLY confirmed, I will prepare questions about the credit desk.'],
    ] })
    const { runs, ports, counts } = await runThreads({ threads: [t], schedule: [t.ids.slice(0, 2), t.ids.slice(2)], invocations: 2 })
    const [r1, r2] = runs
    assert.strictEqual(r1.run.created, 1, summarize(r1))
    assert.strictEqual(r1.run.content.recoveries_attempted, 0, 'a first pass sees the whole thread and asks nothing extra')
    assert.strictEqual(r2.run.outcome, 'committed', summarize(r2))
    assert.deepStrictEqual(r2.run.content.recovery_outcomes, { recovered: 1 }, 'completed from Outlook before the write: ' + summarize(r2))
    assert.strictEqual(r2.run.content.recovered_messages, 4)
    assert.strictEqual(r2.run.created, 0, 'NO second proposal: ' + summarize(r2))
    assert.strictEqual(r2.run.accepted, 1)
    assert.deepStrictEqual(r2.run.write_results, { refreshed: 1 }, summarize(r2))
    assert.strictEqual(ports.candidates.length, 2)
    assert.strictEqual(ports.candidates[1].rpc, expectRpc)
    assert.strictEqual(ports.candidates[1].result, 'refreshed')
    assert.strictEqual(ports.candidates[1].args.p_episode_fingerprint, ports.candidates[0].args.p_episode_fingerprint, 'ONE identity across the rounds')
    // CONTEXT IS CONSISTENT TOO: round 2 drafted from the whole exchange, not from its own two messages.
    assert.strictEqual(r2.run.content.bodies_read, 4)
    const sent = counts.modelBodies[1]
    for (const tag of ['OPENING', 'FIRST-REPLY', 'SECOND-MESSAGE', 'SECOND-REPLY']) assert.ok(carries(sent, tag), tag + ' is in the round-2 request')
    assert.ok(!carries(sent, party) && !carries(sent, ME), 'no address')
  })
}

await test('after the reviewer DECIDED on the exchange, a further round of it answers exists_terminal; a NEW thread with the same person is proposed', async () => {
  const a = thread({ party: STRANGER, conv: 'AAQkAD-decided-a', turns: [
    ['them', 1, 9, 'A-OPENING good to meet you.'], ['me', 1, 15, 'A-REPLY likewise, thank you.'],
    ['them', 4, 9, 'A-THIRD here is the dial-in.'], ['me', 4, 15, 'A-FOURTH received, thank you.'],
  ] })
  const b = thread({ party: STRANGER, conv: 'AAQkAD-decided-b', turns: [
    ['me', 5, 9, 'B-OPENING a separate question about the summer programme.'], ['them', 5, 15, 'B-REPLY of course, ask away.'],
  ] })
  const { runs, ports } = await runThreads({
    threads: [a, b], schedule: [a.ids.slice(0, 2), a.ids.slice(2).concat(b.ids)], invocations: 2,
    // Between the rounds the reviewer accepts (or dismisses) round 1's proposal.
    beforeInvocation: (i, p) => { if (i === 1) p.decide(p.candidates[0].args.p_episode_fingerprint) },
  })
  const [r1, r2] = runs
  assert.strictEqual(r1.run.created, 1, summarize(r1))
  assert.strictEqual(r2.run.outcome, 'committed', summarize(r2))
  assert.deepStrictEqual(r2.run.content.recovery_outcomes, { recovered: 2 }, 'both threads of the delta round were completed: ' + summarize(r2))
  assert.deepStrictEqual(r2.run.write_results, { exists_terminal: 1, created: 1 }, summarize(r2))
  assert.strictEqual(r2.run.accepted, 2, 'both are successful outcomes for the run')
  const first = ports.candidates[0].args.p_episode_fingerprint
  const terminalCall = ports.candidates.find((c) => c.result === 'exists_terminal')
  assert.strictEqual(terminalCall.args.p_episode_fingerprint, first, 'the decided exchange keeps its identity and is NOT resurrected')
  const fresh = ports.candidates.find((c, i) => i > 0 && c.result === 'created')
  assert.notStrictEqual(fresh.args.p_episode_fingerprint, first, 'a different thread with the same person is a different identity - and IS proposed')
  assert.strictEqual(fresh.args.p_proposed_email, STRANGER)
})

await test('a THIRD person joins the thread in round 2: the COMPLETE thread shows two external people, the pass refuses to pick one, nothing is written, the round-1 proposal stands', async () => {
  const OTHER = 'sam@firm.test'
  const t = thread({ party: STRANGER, conv: 'AAQkAD-third-person', turns: [
    ['them', 1, 9, 'OPENING good to meet you.'], ['me', 1, 15, 'REPLY likewise.'],
    [OTHER, 3, 9, 'CC-IN adding myself to this thread.'], ['me', 3, 15, 'REPLY-TWO welcome aboard.'],
  ] })
  const { runs, ports } = await runThreads({ threads: [t], schedule: [t.ids.slice(0, 2), t.ids.slice(2)], invocations: 2 })
  const [r1, r2] = runs
  assert.strictEqual(r1.run.created, 1, summarize(r1))
  // On its own, round 2 looked like a two-sided exchange with the third person, and a
  // proposal for THAT person would have been drafted from a thread that is really the
  // first person's. Completed from Outlook, the thread carries both external people and
  // the content pass refuses to choose between them - the same answer a one-round read of
  // the four messages gives (ambiguous_counterparty) - so nothing is written.
  assert.strictEqual(r2.run.outcome, 'committed', summarize(r2))
  assert.deepStrictEqual(r2.run.content.recovery_outcomes, { recovered: 1 }, summarize(r2))
  assert.strictEqual(r2.run.content.recovered_messages, 4)
  assert.deepStrictEqual(r2.run.content.deferred, { ambiguous_counterparty: 1 }, summarize(r2))
  assert.strictEqual(r2.run.content.model_calls, 0, 'the model is never called')
  assert.strictEqual(r2.run.created, 0)
  assert.strictEqual(ports.candidates.length, 1, 'nothing written in round 2')
})

// WHEN THE REQUIRED RECOVERY IS REFUSED. Reproduced through this handler before the
// correction, for a known and for an unknown person: round 1 created a pending suggestion;
// round 2 held further messages from both sides; recovery settled as recovery_unsupported,
// recovery_truncated or recovery_source_missing; the worker wrote the round-local view under
// a DIFFERENT fingerprint and answered created:1 again. Now a deterministic refusal is a
// reported no-write settlement: the pending suggestion and its draft stand, nothing further
// is read or drafted, and the conversation is passed under the recovery's own code. Only a
// transient failure or a budget/cap interruption keeps the conversation for the next
// invocation (section 4, last test). The three codes are produced by fixture faults - a 400,
// a page carrying @odata.nextLink, a 404 - not by the provider; what the provider actually
// answers to the filter is the owner-run Graph Explorer check.
for (const [label, party, expectRpc] of [
  ['an unknown person', STRANGER, 'upsert_new_contact_candidate'],
  ['an existing contact', KNOWN, 'upsert_outlook_interaction_candidate'],
]) {
  for (const [faultLabel, faults, code] of [
    ['the provider refuses the filter (400)', { lookup: 'bad_request' }, 'recovery_unsupported'],
    ['the thread is longer than one bounded page', { lookup: 'truncated' }, 'recovery_truncated'],
    ['the stored message no longer resolves (404)', { envelope: 'not_found' }, 'recovery_source_missing'],
  ]) {
    await test(label + ', continuing exchange, ' + faultLabel + ' -> NO second write, nothing read or drafted, the pending suggestion untouched, ' + code + ' reported', async () => {
      const t = thread({ party, conv: 'AAQkAD-refused-' + code + (party === KNOWN ? '-known' : '-new'), turns: [
        ['them', 1, 9, 'OPENING good to meet you at the panel.'], ['me', 1, 15, 'FIRST-REPLY thank you, next week works.'],
        ['them', 3, 9, 'SECOND-MESSAGE Thursday at three is confirmed.'], ['me', 3, 15, 'SECOND-REPLY confirmed.'],
      ] })
      const { runs, ports, after } = await runThreads({ threads: [t], schedule: [t.ids.slice(0, 2), t.ids.slice(2)], invocations: 2, faults })
      const [r1, r2] = runs
      // Round 1 (a first pass): the pending suggestion, with its draft.
      assert.strictEqual(r1.run.created, 1, summarize(r1))
      assert.strictEqual(ports.candidates.length, 1)
      assert.strictEqual(ports.candidates[0].rpc, expectRpc)
      assert.strictEqual(ports.candidates[0].args.p_draft_follow_up, MODEL.followUp)
      const original = JSON.stringify(ports.candidates[0])
      // Round 2 (a delta round): recovery was required and refused; the round-local view is NOT written.
      assert.strictEqual(r2.run.outcome, 'committed', summarize(r2))
      assert.deepStrictEqual(r2.run.content.recovery_outcomes, { [code]: 1 }, summarize(r2))
      assert.strictEqual(r2.run.created, 0, 'NO second suggestion: ' + summarize(r2))
      assert.strictEqual(r2.run.accepted, 0)
      assert.deepStrictEqual(r2.run.write_results, {}, 'no producer write at all')
      assert.strictEqual(r2.run.intended, 0, 'the write the pre-pass counted is no longer needed')
      assert.deepStrictEqual(r2.run.entry_skipped, { [code]: 1 }, 'the reason is the reported skip: ' + summarize(r2))
      assert.strictEqual(r2.run.content.attempted, 0, 'the content stage is never reached')
      assert.strictEqual(after[1].bodies, after[0].bodies, 'no body read after recovery failed')
      assert.strictEqual(after[1].model, after[0].model, 'no model call after recovery failed')
      assert.strictEqual(after[1].envelopeGets - after[0].envelopeGets, 1, 'one envelope GET, the recovery itself')
      assert.strictEqual(r2.run.cursors_advanced, 2, 'a deterministic refusal is a decision: the round commits')
      assert.strictEqual(ports.candidates.length, 1, 'still exactly one write')
      assert.strictEqual(JSON.stringify(ports.candidates[0]), original, 'the original proposal is unchanged')
    })
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('4. when recovery cannot complete the exchange, it fails safely')
// ═══════════════════════════════════════════════════════════════════════════════
const CROSS = { party: STRANGER, order: 'them_first', inboxRounds: ['in', 'none'], sentRounds: ['none', 'out'], invocations: 2 }

await test('the earlier half is MISSING from Outlook: settled as one-sided, no body read, no model call, round committed', async () => {
  const { runs, ports, counts } = await runScenario({ ...CROSS, faults: { lookup: 'only_current' } })
  const r2 = runs[1]
  assert.strictEqual(r2.run.outcome, 'committed', summarize(r2))
  assert.deepStrictEqual(r2.run.content.recovery_outcomes, { not_two_sided: 1 }, summarize(r2))
  assert.strictEqual(r2.run.entry_skipped.not_two_sided, 1)
  assert.strictEqual(counts.bodies, 0)
  assert.strictEqual(counts.model, 0)
  assert.strictEqual(ports.candidates.length, 0)
})
await test('the stored message no longer resolves (404): settled as recovery_source_missing, round committed, nothing written', async () => {
  const { runs, ports } = await runScenario({ ...CROSS, faults: { envelope: 'not_found' } })
  const r2 = runs[1]
  assert.strictEqual(r2.run.outcome, 'committed', summarize(r2))
  assert.deepStrictEqual(r2.run.content.recovery_outcomes, { recovery_source_missing: 1 }, summarize(r2))
  assert.strictEqual(ports.candidates.length, 0)
})
await test('the provider refuses the conversation filter (400): settled as recovery_unsupported - the reportable signal', async () => {
  const { runs, ports, counts } = await runScenario({ ...CROSS, faults: { lookup: 'bad_request' } })
  const r2 = runs[1]
  assert.strictEqual(r2.run.outcome, 'committed', summarize(r2))
  assert.deepStrictEqual(r2.run.content.recovery_outcomes, { recovery_unsupported: 1 }, summarize(r2))
  assert.strictEqual(counts.bodies, 0)
  assert.strictEqual(ports.candidates.length, 0)
})
await test('a thread longer than one bounded page: settled as recovery_truncated, never followed', async () => {
  const { runs, ports } = await runScenario({ ...CROSS, faults: { lookup: 'truncated' } })
  const r2 = runs[1]
  assert.strictEqual(r2.run.outcome, 'committed', summarize(r2))
  assert.deepStrictEqual(r2.run.content.recovery_outcomes, { recovery_truncated: 1 }, summarize(r2))
  assert.strictEqual(ports.candidates.length, 0)
})
await test('SCREENING still applies to a recovered stranger: an inbound body without headers is automation_unverified, nothing written', async () => {
  const s0 = scenario(CROSS)
  const { runs, ports, counts } = await runScenario({ ...CROSS, faults: { headersMissingFor: new Set([s0.ex.inbound.id]) } })
  const r2 = runs[1]
  assert.strictEqual(r2.run.outcome, 'committed', summarize(r2))
  assert.deepStrictEqual(r2.run.content.recovery_outcomes, { recovered: 1 }, 'recovery itself succeeded')
  assert.strictEqual(r2.run.content.deferred.automation_unverified, 1, 'and the content pass refused to summarize an unscreened stranger: ' + summarize(r2))
  assert.strictEqual(counts.model, 0, 'the model was never called')
  assert.strictEqual(ports.candidates.length, 0)
  assert.strictEqual(r2.run.content.missing_headers.inbox, 1)
})
await test('a BUDGET interruption mid-recovery preserves the work: nothing settled, nothing written, the next invocation completes it', async () => {
  const clock = { ms: FIXED, trapOnLookup: 0 }
  const { runs, ports, after } = await runScenario({
    ...CROSS, invocations: 3, clock,
    beforeInvocation: (i) => {
      clock.ms = FIXED + i * 10_000_000
      // In round 2's first invocation the clock jumps 200 s when the first lookup is
      // served, so the invocation budget is gone before the second lookup.
      clock.trapOnLookup = i === 1 ? 200_000 : 0
    },
  })
  const [, r2a, r2b] = runs
  assert.deepStrictEqual(r2a.run.content.recovery_outcomes, { budget_exhausted: 1 }, 'interrupted: ' + summarize(r2a))
  assert.strictEqual(r2a.run.cursors_advanced, 0, 'nothing committed while the conversation is unresolved')
  assert.strictEqual(after[1].candidates, 0, 'nothing written yet')
  assert.ok(after[1].conversations >= 1, 'the round and its record are kept for the next invocation')
  assert.strictEqual(after[1].bodies, 0, 'and no body was read on the way out')
  // The next invocation, with budget, recovers and writes.
  assert.strictEqual(r2b.run.outcome, 'committed', 'completed: ' + summarize(r2b))
  assert.deepStrictEqual(r2b.run.content.recovery_outcomes, { recovered: 1 })
  assert.strictEqual(after[2].candidates, 1)
  assert.strictEqual(after[2].bodies, 2)
  assert.ok(ports.candidates.length === 1, 'exactly one write across the interrupted and the completing invocation')
})

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('5. nothing durable was added, so disconnect has nothing new to clear')
// ═══════════════════════════════════════════════════════════════════════════════
const MIG8 = read('supabase/migrations/20261008000000_outlook_known_contact_follow_up_provenance.sql')
await test('the implementation adds no table, column or retained row: recovery state lives in memory for one invocation', () => {
  assert.ok(!/CREATE TABLE|ADD COLUMN|ALTER TABLE/.test(MIG8), 'the migration changes no table')
  const REC = read('supabase/functions/shared/outlookConversationRecovery.js')
  assert.ok(!/rpc\(|\.from\(|INSERT|UPSERT/i.test(REC.replace(/^\s*\/\/.*$/gm, '')), 'the recovery module performs no database write')
  assert.ok(REC.indexOf('inbound_seen') < 0 && REC.indexOf('expires_at') < 0, 'no recognition store')
  // The existing disconnect deletes the round state and the handles; nothing else exists.
  const STORE = read('tests/harness/outlookRoundStore.js')
  assert.ok(STORE.indexOf('messages.length = 0') >= 0, 'the store erases handles with the round, as the cascade does')
})

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('6. the write RPC: the follow-up and provenance parameters, refresh semantics, and nothing else changed')
// ═══════════════════════════════════════════════════════════════════════════════
const OLD = read('supabase/migrations/20261006000000_outlook_content_note_and_new_contact_write.sql')
function fnBody (sql, head) {
  const i = sql.indexOf(head)
  assert.ok(i >= 0, 'definition not found: ' + head)
  const s = sql.indexOf('AS $$', i)
  const e = sql.indexOf('$$;', s)
  return sql.slice(s + 'AS $$'.length, e)
}
function fnParams (sql, head) {
  const i = sql.indexOf(head)
  const seg = sql.slice(i, sql.indexOf('RETURNS', i))
  const out = []
  for (const line of seg.split(NL)) {
    const t = line.trim()
    if (t.startsWith('p_')) out.push(t.split(/\s+/)[0])
  }
  return out
}
function withoutMarkedBlocks (text) {
  const kept = []
  let skipping = false
  for (const line of text.split(NL)) {
    if (line.indexOf('-- >>> 20261008') >= 0) { skipping = true; continue }
    if (line.indexOf('-- <<< 20261008') >= 0) { skipping = false; continue }
    if (!skipping) kept.push(line)
  }
  assert.strictEqual(skipping, false, 'an unclosed 20261008 block')
  return kept
}
function normalized (lines) {
  const out = []
  for (let l of lines) {
    l = l.trimEnd()
    while (l.endsWith(',') || l.endsWith(')')) l = l.slice(0, -1).trimEnd()
    if (l.trim().length > 0) out.push(l)
  }
  return out
}
function assertSameBody (newLines, oldLines) {
  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i += 1) {
    assert.strictEqual(newLines[i], oldLines[i],
      'first difference at body line ' + (i + 1) + ': applied=' + JSON.stringify(oldLines[i]) + ' new=' + JSON.stringify(newLines[i]))
  }
}
const UPSERT = 'CREATE FUNCTION public.upsert_outlook_interaction_candidate('

await test('upsert: newest, NOT APPLIED, drops the 10-argument form, creates the 13-argument one, ACL restated', () => {
  assert.ok(MIG8.indexOf('NOT APPLIED') >= 0)
  assert.ok(MIG8.indexOf('uuid, uuid, uuid, text, text, smallint, text, date, text[], text);') >= 0, 'drops exactly the applied signature')
  assert.ok(MIG8.indexOf('CREATE OR REPLACE FUNCTION public.upsert_outlook_interaction_candidate') < 0)
  assert.deepStrictEqual(fnParams(MIG8, UPSERT), [
    'p_connection_id', 'p_run_id', 'p_contact_id', 'p_episode_fingerprint', 'p_person_fingerprint',
    'p_key_version', 'p_proposed_type', 'p_proposed_date', 'p_lookup_fingerprints', 'p_proposed_notes',
    'p_draft_follow_up', 'p_summary_evidence', 'p_extraction_status',
  ])
  assert.deepStrictEqual(fnParams(OLD, UPSERT), fnParams(MIG8, UPSERT).slice(0, 10))
  assert.ok(MIG8.indexOf('upsert_outlook_interaction_candidate(\n  uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text\n) FROM PUBLIC, anon, authenticated;') >= 0)
  assert.ok(MIG8.indexOf('upsert_outlook_interaction_candidate(\n  uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text\n) TO service_role;') >= 0)
  assert.ok(MIG8.indexOf('p_retained_subject') < 0, 'no subject on the known-contact row')
})
await test('upsert: the body is the applied body plus exactly the marked additions', () => {
  const oldLines = normalized(fnBody(OLD, UPSERT).split(NL))
  const newLines = normalized(withoutMarkedBlocks(fnBody(MIG8, UPSERT)))
  assertSameBody(newLines, oldLines)
  assert.strictEqual(newLines.length, oldLines.length)
})
await test('upsert: validation mirrors the applied CHECKs with controlled codes', () => {
  const body = fnBody(MIG8, UPSERT)
  assert.ok(body.indexOf('char_length(v_follow) > 160') >= 0)
  assert.ok(body.indexOf("'invalid_follow_up'") >= 0 && body.indexOf("'invalid_evidence'") >= 0 && body.indexOf("'invalid_extraction_status'") >= 0)
  assert.ok(body.indexOf('IF v_follow IS NOT NULL AND (v_notes IS NULL') >= 0, 'a next step without a note is refused')
  assert.ok(body.indexOf("p_summary_evidence NOT IN ('explicit_body', 'subject_only')") >= 0)
  assert.ok(body.indexOf("p_extraction_status NOT IN ('deterministic', 'ai_extracted', 'ai_failed')") >= 0)
  assert.ok(body.indexOf('SQLERRM') < 0)
})
await test('upsert REFRESH: a new draft replaces the step (clearing it when absent); a metadata-only refresh preserves everything', () => {
  const body = fnBody(MIG8, UPSERT)
  assert.ok(body.indexOf('draft_follow_up          = CASE WHEN v_notes IS NOT NULL THEN v_follow ELSE draft_follow_up END') >= 0,
    'the step turns on whether THIS call carried a note - a new draft with no step clears the old one')
  assert.ok(body.indexOf('COALESCE(v_follow, draft_follow_up)') < 0, 'COALESCE kept an obsolete step beside a new summary')
  assert.ok(body.indexOf('summary_evidence         = CASE WHEN v_notes IS NOT NULL THEN p_summary_evidence ELSE summary_evidence END') >= 0)
  assert.ok(body.indexOf('extraction_status        = CASE WHEN v_notes IS NOT NULL THEN p_extraction_status ELSE extraction_status END') >= 0)
  assert.ok(body.indexOf('proposed_notes           = COALESCE(v_notes, proposed_notes)') >= 0, 'the note itself still coalesces, as applied')
  assert.ok(body.indexOf('CASE WHEN p_summary_evidence IS NOT NULL THEN v_notes END') >= 0, 'draft_summary and its evidence move as a pair')
})

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('7. the accept RPC keeps the approved next step and the chosen date, and nothing else changed')
// ═══════════════════════════════════════════════════════════════════════════════
const ACCEPT_OLD = 'CREATE OR REPLACE FUNCTION public.accept_interaction_candidate('
const ACCEPT_NEW = 'CREATE FUNCTION public.accept_interaction_candidate('
// Exactly two lines of the applied body are replaced, named here so the diff is explicit.
const REPLACED = [
  ['    INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes, source, follow_up_date)',
    '    INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes, source)'],
  ['    VALUES (v_cand.contact_id, v_uid, v_type, v_date, v_final, v_src, p_follow_up_date)',
    '    VALUES (v_cand.contact_id, v_uid, v_type, v_date, v_notes, v_src)'],
]
await test('accept: drops the applied 4-argument form, creates the 6-argument one, authenticated-only ACL restated', () => {
  assert.ok(MIG8.indexOf('DROP FUNCTION IF EXISTS public.accept_interaction_candidate(uuid, text, date, text);') >= 0)
  assert.ok(MIG8.indexOf(ACCEPT_OLD) < 0, 'a signature change is never CREATE OR REPLACE')
  assert.deepStrictEqual(fnParams(MIG8, ACCEPT_NEW), ['p_candidate_id', 'p_override_type', 'p_override_date', 'p_override_notes', 'p_follow_up', 'p_follow_up_date'])
  assert.deepStrictEqual(fnParams(OLD, ACCEPT_OLD), fnParams(MIG8, ACCEPT_NEW).slice(0, 4))
  assert.ok(MIG8.indexOf('REVOKE ALL ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text, text, date)\n  FROM PUBLIC, anon;') >= 0)
  assert.ok(MIG8.indexOf('GRANT EXECUTE ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text, text, date)\n  TO authenticated;') >= 0)
  assert.ok(!/accept_interaction_candidate\([^)]*\)\s*TO service_role/.test(MIG8), 'never granted to service_role')
})
await test('accept: the body is the applied body plus the marked additions and exactly the two named replaced lines', () => {
  const oldLines = normalized(fnBody(OLD, ACCEPT_OLD).split(NL))
  const kept = withoutMarkedBlocks(fnBody(MIG8, ACCEPT_NEW)).map((line) => {
    for (const [replaced, original] of REPLACED) if (line === replaced) return original
    return line
  })
  const newLines = normalized(kept)
  assertSameBody(newLines, oldLines)
  assert.strictEqual(newLines.length, oldLines.length)
  // Both replacements really are in the file (so the mapping above did real work).
  for (const [replaced] of REPLACED) assert.ok(MIG8.indexOf(replaced) >= 0, 'missing: ' + replaced)
})
await test('accept: the approved step is validated, saved into the note, and the date is the reviewer\'s own', () => {
  const body = fnBody(MIG8, ACCEPT_NEW)
  assert.ok(body.indexOf("v_follow := NULLIF(pg_catalog.btrim(COALESCE(p_follow_up, '')), '')") >= 0)
  assert.ok(body.indexOf('char_length(v_follow) > 160') >= 0 && body.indexOf("'invalid_follow_up'") >= 0)
  assert.ok(body.indexOf("'Next step: ' || v_follow") >= 0, 'kept as part of the note')
  assert.ok(body.indexOf('pg_catalog.chr(10) || pg_catalog.chr(10)') >= 0, 'separated from the note by a blank line')
  assert.ok(body.indexOf('WHEN v_follow IS NULL THEN v_notes') >= 0, 'a cleared step leaves the note alone')
  assert.ok(body.indexOf('v_cand.draft_follow_up') < 0, 'the draft column is never read back at accept time - only the reviewer\'s value is saved')
  assert.ok(body.indexOf('p_follow_up_date)') >= 0, 'the date passed in is the date saved')
  assert.ok(!/p_follow_up_date\s*[+-]|interval/.test(body.replace(/^\s*--.*$/gm, '')), 'no date is derived or shifted')
  // The applied guards are still there, verbatim (the diff guard proves it; these name the ones that matter).
  for (const g of ["'already_accepted'", "'interaction_previously_deleted'", "'dismissed'", "'invalidated'", "'expired'",
    'FOR KEY SHARE', 'foreign_key_violation', 'deadlock_detected OR serialization_failure',
    'draft_summary = NULL, draft_follow_up = NULL, summary_evidence = NULL']) {
    assert.ok(body.indexOf(g) >= 0, 'guard missing: ' + g)
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('8. the planner and the review surface')
// ═══════════════════════════════════════════════════════════════════════════════
await test('the write planner sends the three on a successful draft and NONE of them on the metadata-only path', () => {
  const entry = { kind: 'known_contact_interaction', contactId: KNOWN_CONTACT, proposedType: 'Email',
    proposedDate: '2026-09-21', episodeFingerprint: 'a'.repeat(64), personFingerprint: 'b'.repeat(64),
    keyVersion: 1, episodeLookupFingerprints: [] }
  const note = planContentWrite(entry, { outcome: 'interaction_draft', summary: 'A real summary.',
    summaryEvidence: 'subject_only', followUp: 'Reply with two times.', extractionStatus: 'ai_extracted',
    interactionDate: '2026-09-21' }, { consentOpen: true })
  assert.strictEqual(note.args.p_draft_follow_up, 'Reply with two times.')
  assert.strictEqual(note.args.p_summary_evidence, 'subject_only')
  assert.strictEqual(note.args.p_extraction_status, 'ai_extracted')
  const metadata = planContentWrite(entry, { outcome: 'defer', reason: 'content_consent_missing' }, { consentOpen: false })
  assert.strictEqual(metadata.write, 'interaction_metadata')
  for (const k of ['p_draft_follow_up', 'p_summary_evidence', 'p_extraction_status']) {
    assert.strictEqual(metadata.args[k], undefined, k + ' must stay absent when nothing was read')
  }
})
await test('the queue selects the two draft columns the card renders, and still no identifier', () => {
  assert.ok(CANDIDATE_SELECT.indexOf('draft_follow_up') >= 0 && CANDIDATE_SELECT.indexOf('extraction_status') >= 0)
  for (const bad of ['source_fingerprint', 'user_id', 'interaction_id', 'context_expires_at', 'retained_subject',
    'draft_summary', 'summary_evidence', 'connection_id']) {
    assert.ok(CANDIDATE_SELECT.indexOf(bad) < 0, 'the queue must not select ' + bad)
  }
})
await test('the card lets the reviewer keep, edit or clear the step, choose a date, and sends only approved values', () => {
  const PAGE = read('src/pages/SuggestionsPage.jsx')
  assert.ok(PAGE.indexOf('useState(candidate.draft_follow_up || \'\')') >= 0, 'the step starts as drafted')
  assert.ok(PAGE.indexOf('useState(\'\')') >= 0 && PAGE.indexOf('setFollowUpDate') >= 0, 'the date starts EMPTY: never derived from the step')
  assert.ok(PAGE.indexOf('name="nextStep"') >= 0 && PAGE.indexOf('name="followUpDate"') >= 0, 'both are editable fields')
  assert.ok(PAGE.indexOf('maxLength={REVIEW_FOLLOW_UP_MAX}') >= 0)
  assert.ok(PAGE.indexOf('p_follow_up: nextStep.trim() || null') >= 0, 'a cleared step is sent as null')
  assert.ok(PAGE.indexOf('p_follow_up_date: followUpDate || null') >= 0, 'an unchosen date is sent as null')
  assert.ok(PAGE.indexOf("candidate.extraction_status === 'ai_extracted'") >= 0, 'the provenance line stays conditional')
  assert.ok(PAGE.indexOf('p_override_notes: notes || null') >= 0)
  assert.ok(PAGE.indexOf('p_draft_follow_up') < 0 && PAGE.indexOf('p_extraction_status') < 0, 'the browser never writes draft columns')
  assert.strictEqual(REVIEW_FOLLOW_UP_MAX, 160)
  assert.deepStrictEqual(validateOverrides({ followUp: 'x'.repeat(160), followUpDate: '2026-10-21' }), { ok: true })
  assert.strictEqual(validateOverrides({ followUp: 'x'.repeat(161) }).code, 'invalid_follow_up')
  assert.strictEqual(validateOverrides({ followUpDate: 'next week' }).code, 'invalid_follow_up_date')
  assert.deepStrictEqual(validateOverrides({ followUp: '', followUpDate: '' }), { ok: true }, 'blank is a valid choice for both')
})

console.log('')

// Rejected committed tokens are fixtures, not a diagnosis of the pilot's valid cursors.
for (const party of [KNOWN, STRANGER]) {
  for (const decided of [false, true]) {
    await test(`committed-token recovery preserves ${party === KNOWN ? 'known' : 'new'} ${decided ? 'terminal' : 'pending'} identity`, async () => {
      const s = scenario({party,order:'me_first',inboxRounds:['in'],sentRounds:['out']})
      const ports = await makePorts({contacts:[{id:KNOWN_CONTACT,user_id:PILOT,email:KNOWN}]})
      const counts = newCounts()
      const fetchImpl = makeFetch({...s,counts,model:MODEL})
      const first = await invoke(ports,fetchImpl)
      assert.equal(first.run.created,1)
      const fp = ports.candidates[0].args.p_episode_fingerprint
      const saved = JSON.stringify(ports.candidates[0])
      if(decided) ports.decide(fp)
      const rejecting = async (url,init) => String(url).includes('$deltatoken=R1')
        ? {status:410,headers:{get:()=>null},json:async()=>({error:{code:'resyncRequired'}})}
        : fetchImpl(url,init)
      const restart = await invoke(ports,rejecting)
      assert.equal(restart.run.outcome,'restart_required',summarize(restart))
      assert.equal(restart.run.reason,'committed_delta_rejected')
      assert.equal(restart.run.cursors_advanced,0)
      assert.equal(ports.candidates.length,1)
      assert.equal(JSON.stringify(ports.candidates[0]),saved)
      const replay = await invoke(ports,rejecting)
      assert.equal(replay.run.outcome,'committed',summarize(replay))
      assert.equal(replay.run.created,0)
      assert.equal(replay.run.write_results[decided?'exists_terminal':'refreshed'],1)
      assert.equal(replay.run.content.recovery_outcomes.recovered,1)
      assert.equal(ports.candidates.length,2)
      assert.equal(ports.candidates[1].args.p_episode_fingerprint,fp)
      assert.equal(replay.run.cursors_advanced,2)
    })
  }
}

console.log((passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed')
console.log('')
if (failed > 0) process.exit(1)
