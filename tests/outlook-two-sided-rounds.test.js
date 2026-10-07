// TWO-WAY COMMUNICATION, WHICHEVER SIDE STARTED, AND WHAT HAPPENS ACROSS ROUNDS.
//
// THE REQUIREMENT, stated once. A NEW-CONTACT suggestion needs two-way communication
// with the same person, regardless of who opened the thread:
//
//   1. user sends -> person replies;
//   2. person sends -> user replies.
//
// A single unanswered message must never produce one. Both halves - what was sent and
// what was received - feed the drafted interaction. Acceptance creates the contact and
// the interaction together, after review.
//
// WHAT IS EXECUTED: the REAL worker handler (handleOutlookImportWorker) over the real
// run, the real accumulator, the real content pass with the real screening, the real
// write planner and the real provider transports - driven by one fixture fetch that
// answers the three surfaces the run touches (Graph delta, Graph message content, the
// Anthropic endpoint) and throws on anything else. No network, no database, no browser.
//
// THE ROUND STORE is the shared in-memory stand-in for the SQL round state, and it
// mirrors the applied schema's one relevant property exactly: a confirmed complete
// release ERASES the accumulator (release_outlook_sync_lease, 20261002000000:1164;
// commitRelease in tests/harness/outlookRoundStore.js). That property is what the
// cross-round section below is about.
//
// NO REAL IDENTIFIER, ADDRESS, BODY OR KEY APPEARS IN THIS FILE.
//
// Run with: node tests/outlook-two-sided-rounds.test.js

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { handleOutlookImportWorker } from '../supabase/functions/outlook-import-worker/handler.js'
import { importKeyFromBase64, encryptToken } from '../supabase/functions/shared/googleTokenCrypto.js'
import { GRAPH_BASE } from '../supabase/functions/shared/outlookGraphTransport.js'
import { ANTHROPIC_MESSAGES_URL } from '../supabase/functions/shared/outlookDraftContract.js'
import { REQUIRED_CONTENT_CONSENT_VERSION } from '../supabase/functions/shared/outlookContentConsent.js'
import { planContentWrite } from '../supabase/functions/shared/outlookContentStage.js'
import { CANDIDATE_SELECT } from '../src/lib/calendarReview.js'
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

const envelope = (id, conv, from, to, sent, subject) => ({
  id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
  subject, from: { emailAddress: { address: from, name: 'x' } },
  sender: { emailAddress: { address: from, name: 'x' } },
  toRecipients: to.map((a) => ({ emailAddress: { address: a, name: 'x' } })),
  ccRecipients: [],
})

/**
 * A two-sided exchange with `party`, in one of the two orders. Returns the two
 * envelopes and the bodies keyed by id. Ids and conversation ids are invented.
 */
function exchange ({ party, order, conv }) {
  const themFirst = order === 'them_first'
  const inId = 'AAkALgAA' + conv + '-in'
  const outId = 'AAkALgAA' + conv + '-out'
  const inbound = envelope(inId, conv, party, [ME],
    themFirst ? '2026-09-21T14:00:00Z' : '2026-09-21T11:00:00Z', 'Following up')
  const outbound = envelope(outId, conv, ME, [party],
    themFirst ? '2026-09-21T16:00:00Z' : '2026-09-21T08:00:00Z', 'RE: Following up')
  return {
    inbound, outbound,
    bodies: {
      [inId]: themFirst ? THEM_FIRST : THEM_REPLY,
      [outId]: themFirst ? ME_REPLY : ME_FIRST,
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

/**
 * The PostgREST + RPC pair for ONE connection across as many invocations as the test
 * makes. The store persists between invocations, exactly as the table would, and a
 * confirmed complete release erases the accumulator exactly as the SQL does.
 *
 * Candidate writes are deduplicated by episode fingerprint the way the two write RPCs
 * do - a repeat answers 'refreshed' - so a re-read of the same exchange can be shown
 * to produce no second proposal.
 */
async function makePorts ({ contacts }) {
  const key = await importKeyFromBase64(KEY_B64, subtle)
  const sealed = await encryptToken(ACCESS_TOKEN, key, { subtle })
  const expires = new Date(Date.now() + 3600000).toISOString()
  const store = makeRoundStore()
  const handles = []
  const candidates = []
  const releases = []
  const episodes = new Set()
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
      // THE COMMITTED CURSORS, exactly where the real loader reads them: the table rows
      // release_outlook_sync_lease promoted the pending deltaLink into. The store
      // performs that same promotion in commitRelease(), and the ciphertext it holds is
      // the one the run sealed with the configured key, so the loader decrypts it for
      // real and round 2 follows the link round 1 committed. Returning [] here is what a
      // FIRST read looks like; returning these is what every later read looks like.
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
      return { data: { result: 'reserved', connection_id: CONN, user_id: PILOT, run_id: 'run-1' }, error: null }
    }
    if (name === 'renew_outlook_sync_lease') return { data: true, error: null }
    if (name === 'upsert_outlook_interaction_candidate' || name === 'upsert_new_contact_candidate') {
      const fp = args && args.p_episode_fingerprint
      const result = episodes.has(fp) ? 'refreshed' : 'created'
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
    if (name === 'record_outlook_page_progress') {
      for (const m of (args && args.p_messages) || []) handles.push(m)
    }
    if (name === 'list_outlook_round_message_handles') {
      const want = new Set((args && args.p_cfps) || [])
      const mine = handles.filter((h) => want.has(h.cfp))
        .sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)))
      return { data: { result: 'ok', handles: mine, next_cursor: null }, error: null }
    }
    const s = await store.handle(name, args)
    if (s !== null) return s
    throw new Error('unexpected rpc: ' + name)
  }
  return { select, rpc, store, handles, candidates, releases }
}

const MESSAGES_PREFIX = GRAPH_BASE + '/me/messages/'
function contentMessageId (u) {
  if (!u.startsWith(MESSAGES_PREFIX)) return null
  const q = u.indexOf('?', MESSAGES_PREFIX.length)
  if (q < 0) return null
  return decodeURIComponent(u.slice(MESSAGES_PREFIX.length, q))
}
function deltaToken (u) {
  const i = u.indexOf('$deltatoken=')
  if (i < 0) return null
  const rest = u.slice(i + '$deltatoken='.length)
  const amp = rest.indexOf('&')
  return amp < 0 ? rest : rest.slice(0, amp)
}

/**
 * A MAILBOX SERVED IN ROUNDS. `rounds[folder][k]` is the page the folder answers in
 * its (k+1)th round. A request with no $deltatoken is the first round; a request
 * carrying `Rk` - the deltaLink the previous round committed - is round k+1. Every page
 * is final (it ends in a deltaLink), so one invocation completes one round.
 */
function makeFetch ({ rounds, envelopes, bodies, counts, model }) {
  return async (url, init) => {
    const u = String(url)
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
    const id = contentMessageId(u)
    if (id !== null) {
      counts.bodies += 1
      const env_ = envelopes[id]
      const text = bodies[id]
      if (!env_ || !text) return { status: 404, headers: { get: () => null }, json: async () => ({}) }
      return okRes(Object.assign({}, env_, {
        body: { contentType: 'text', content: text },
        uniqueBody: { contentType: 'text', content: text },
        // Present and clean on EVERY message, so screening passes and only the
        // two-sidedness rules decide the outcome.
        internetMessageHeaders: [{ name: 'Received', value: 'by fixture' }],
      }))
    }
    if (!u.startsWith(GRAPH_BASE)) throw new Error('the fixture refuses a non-Graph URL: ' + u.slice(0, 60))
    const folder = u.indexOf('/mailFolders/inbox/') >= 0 ? 'inbox' : 'sentitems'
    const token = deltaToken(u)
    const k = token === null ? 1 : Number(token.slice(1)) + 1
    counts.delta.push({ folder, token })
    const seq = rounds[folder] || []
    return okRes({
      value: seq[k - 1] || [],
      '@odata.deltaLink': GRAPH_BASE + '/me/mailFolders/' + folder + '/messages/delta?$deltatoken=R' + k,
    })
  }
}

const newCounts = () => ({ delta: [], bodies: 0, model: 0, modelBodies: [] })
const FIXED = 1780000000000
const MODEL = {
  summary: 'They offered a short call next week about the credit desk after putting your name forward.',
  followUp: 'Send your availability for next week.',
}

/** One invocation of the real handler against the given ports and fixture. */
async function invoke (ports, fetchImpl) {
  const res = await handleOutlookImportWorker(workerReq(), env(), {
    tokenUrl: 'https://login.invalid/token',
    select: ports.select,
    rpc: ports.rpc,
    graphFetchImpl: fetchImpl,
    now: () => FIXED,
    subtle,
  })
  const body = await res.json()
  return { status: res.status, run: body && body.run }
}

/** Build a scenario: who the party is, which side wrote first, and how the halves are spread over rounds. */
function scenario ({ party, order, inboxRounds, sentRounds }) {
  const ex = exchange({ party, order, conv: 'conv-' + order + '-' + (party === KNOWN ? 'known' : 'new') })
  const pick = (spec) => spec.map((which) => (which === 'in' ? [ex.inbound] : which === 'out' ? [ex.outbound] : []))
  const rounds = { inbox: pick(inboxRounds), sentitems: pick(sentRounds) }
  const envelopes = { [ex.inbound.id]: ex.inbound, [ex.outbound.id]: ex.outbound }
  return { ex, rounds, envelopes, bodies: ex.bodies }
}

async function runScenario ({ party, order, inboxRounds, sentRounds, invocations = 1, contacts }) {
  const s = scenario({ party, order, inboxRounds, sentRounds })
  const ports = await makePorts({ contacts: contacts ?? (party === KNOWN
    ? [{ id: KNOWN_CONTACT, user_id: PILOT, email: KNOWN }]
    : [{ id: KNOWN_CONTACT, user_id: PILOT, email: KNOWN }]) })   // the stranger is never a contact
  const counts = newCounts()
  const fetchImpl = makeFetch({ rounds: s.rounds, envelopes: s.envelopes, bodies: s.bodies, counts, model: MODEL })
  const runs = []
  for (let i = 0; i < invocations; i += 1) runs.push(await invoke(ports, fetchImpl))
  return { runs, ports, counts, s }
}

const summarize = (r) => JSON.stringify({ outcome: r.run && r.run.outcome, content: r.run && r.run.content,
  skipped: r.run && r.run.entry_skipped, finalize: r.run && r.run.finalize })

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('1. an unknown person is proposed WHICHEVER SIDE STARTED, when both halves are in one round')
// ═══════════════════════════════════════════════════════════════════════════════
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
    // BOTH SIDES REACHED THE MODEL: the sent half and the received half are each in the
    // one request, which is what "describing the discussion" rests on.
    assert.strictEqual(counts.modelBodies.length, 1)
    assert.ok(counts.modelBodies[0].indexOf(mine) >= 0, 'the user side is missing from the request')
    assert.ok(counts.modelBodies[0].indexOf(theirs) >= 0, 'the other side is missing from the request')
    // And nothing the request must not carry.
    assert.ok(counts.modelBodies[0].indexOf(STRANGER) < 0, 'no address in the model request')
    assert.ok(counts.modelBodies[0].indexOf(ME) < 0, 'no self address in the model request')
  })
}

await test('an EXISTING contact in either order -> one note, now WITH its next step and provenance', async () => {
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
    // THE FIX, through the real run: these three were never sent before.
    assert.strictEqual(w.args.p_draft_follow_up, MODEL.followUp, order + ': the next step used to be dropped here')
    assert.strictEqual(w.args.p_summary_evidence, 'explicit_body', order)
    assert.strictEqual(w.args.p_extraction_status, 'ai_extracted', order)
    assert.strictEqual(w.args.p_retained_subject, undefined, order + ': still no subject on the known-contact row')
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
  await test(label + ' -> no proposal, no body read, no model call', async () => {
    const { runs, ports, counts } = await runScenario({ party: STRANGER, order: 'them_first', inboxRounds, sentRounds })
    const [r] = runs
    assert.strictEqual(r.run.outcome, 'committed', summarize(r))
    assert.strictEqual(r.run.entry_skipped.not_two_sided, 1, summarize(r))
    assert.strictEqual(r.run.content.attempted, 0, 'the content stage is never reached')
    assert.strictEqual(counts.bodies, 0, 'no body is read for a one-sided thread')
    assert.strictEqual(counts.model, 0)
    assert.strictEqual(ports.candidates.length, 0)
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('3. REPRODUCED: the two halves in DIFFERENT ROUNDS are never recognised as one exchange')
// ═══════════════════════════════════════════════════════════════════════════════
//
// THE GAP, demonstrated rather than described. Round 1 reads the first half alone: the
// thread is one-sided, nothing is written, the round completes, both cursors commit and
// the accumulator is ERASED (release_outlook_sync_lease: "Only a confirmed, complete
// release erases the accumulator"). Round 2 follows the committed deltaLink and reads
// the reply alone. It is a thread the worker no longer remembers, so it is one-sided
// again, and no suggestion is ever made - for an unknown person AND for an existing
// contact, in both orders.
//
// This is docs/outlook-durable-continuation-design.md "D2 as a decision sheet": the
// accumulator is ROUND-SCOPED by design, the live notice and /privacy both promise the
// working records are removed when a read completes, and keeping them across rounds is
// a retention decision with published wording, not a code fix. These tests pin the
// CURRENT behaviour so that decision is made on evidence; when D2 is approved they are
// the tests that flip.
for (const [label, party, order, inboxRounds, sentRounds] of [
  ['unknown person: person writes in round 1, user replies in round 2', STRANGER, 'them_first', ['in', 'none'], ['none', 'out']],
  ['unknown person: user writes in round 1, person replies in round 2', STRANGER, 'me_first', ['none', 'in'], ['out', 'none']],
  ['existing contact: person writes in round 1, user replies in round 2', KNOWN, 'them_first', ['in', 'none'], ['none', 'out']],
  ['existing contact: user writes in round 1, person replies in round 2', KNOWN, 'me_first', ['none', 'in'], ['out', 'none']],
]) {
  await test(label + ' -> NOTHING is suggested in either round (the D2 gap)', async () => {
    const { runs, ports, counts } = await runScenario({ party, order, inboxRounds, sentRounds, invocations: 2 })
    const [r1, r2] = runs
    // Round 1: one-sided, committed, erased.
    assert.strictEqual(r1.run.outcome, 'committed', 'round 1: ' + summarize(r1))
    assert.strictEqual(r1.run.entry_skipped.not_two_sided, 1, 'round 1: ' + summarize(r1))
    assert.strictEqual(r1.run.cursors_advanced, 2, 'round 1 committed both cursors')
    assert.strictEqual(ports.store.conversations.size, 0, 'the accumulator is erased by the complete release')
    // Round 2 really did start from the committed position.
    const tokens = counts.delta.map((d) => d.token)
    assert.ok(tokens.includes('R1'), 'round 2 must follow the committed deltaLink: ' + JSON.stringify(tokens))
    // Round 2: the reply alone, one-sided again.
    assert.strictEqual(r2.run.outcome, 'committed', 'round 2: ' + summarize(r2))
    assert.strictEqual(r2.run.entry_skipped.not_two_sided, 1, 'round 2: ' + summarize(r2))
    assert.strictEqual(r2.run.content.attempted, 0, 'round 2 never reaches the content stage')
    assert.strictEqual(counts.bodies, 0, 'no body is ever read')
    assert.strictEqual(counts.model, 0, 'the model is never called')
    assert.strictEqual(ports.candidates.length, 0, 'NO suggestion across both rounds - this is the gap')
  })
}

await test('CONTROL: the same two halves in ONE round are proposed - the gap is the round boundary, not the content', async () => {
  const { runs, ports } = await runScenario({ party: STRANGER, order: 'them_first', inboxRounds: ['in'], sentRounds: ['out'] })
  assert.strictEqual(runs[0].run.content.proposals_written, 1)
  assert.strictEqual(ports.candidates.length, 1)
})

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('4. a re-read of the same exchange does not duplicate the proposal')
// ═══════════════════════════════════════════════════════════════════════════════
await test('the same two messages served again produce the same episode key and a refreshed write, not a second proposal', async () => {
  // Both halves in round 1; round 2 serves the SAME two messages again (what a reset
  // cursor would do). The episode fingerprint is deterministic from the conversation and
  // its first message, so the second write targets the existing row and the RPC answers
  // 'refreshed' - counted as accepted, not created.
  const { runs, ports } = await runScenario({ party: STRANGER, order: 'them_first', inboxRounds: ['in', 'in'], sentRounds: ['out', 'out'], invocations: 2 })
  const [r1, r2] = runs
  assert.strictEqual(r1.run.created, 1, summarize(r1))
  assert.strictEqual(r2.run.created, 0, 'round 2 must not create a second proposal: ' + summarize(r2))
  assert.strictEqual(r2.run.accepted, 1, 'the repeat is accepted as a refresh')
  assert.strictEqual(ports.candidates.length, 2)
  assert.strictEqual(ports.candidates[0].args.p_episode_fingerprint, ports.candidates[1].args.p_episode_fingerprint,
    'the dedupe key must not change between reads')
  assert.strictEqual(ports.candidates[1].result, 'refreshed')
})

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('5. the known-contact write RPC: the follow-up and provenance parameters, and nothing else changed')
// ═══════════════════════════════════════════════════════════════════════════════
const OLD = read('supabase/migrations/20261006000000_outlook_content_note_and_new_contact_write.sql')
const NEW = read('supabase/migrations/20261008000000_outlook_known_contact_follow_up_provenance.sql')
const FN = 'CREATE FUNCTION public.upsert_outlook_interaction_candidate('
function fnBody (sql) {
  const i = sql.indexOf(FN)
  assert.ok(i >= 0, 'definition not found')
  const s = sql.indexOf('AS $$', i)
  const e = sql.indexOf('$$;', s)
  return sql.slice(s + 'AS $$'.length, e)
}
function fnParams (sql) {
  const i = sql.indexOf(FN)
  const head = sql.slice(i, sql.indexOf('RETURNS', i))
  const out = []
  for (const line of head.split(NL)) {
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

await test('the migration is the newest, says NOT APPLIED, and drops the 10-argument form before creating the 13-argument one', () => {
  assert.ok(NEW.indexOf('NOT APPLIED') >= 0)
  assert.ok(NEW.indexOf('DROP FUNCTION IF EXISTS public.upsert_outlook_interaction_candidate(') >= 0)
  assert.ok(NEW.indexOf('uuid, uuid, uuid, text, text, smallint, text, date, text[], text);') >= 0,
    'the dropped signature must be exactly the applied 10-argument one')
  assert.ok(NEW.indexOf('CREATE OR REPLACE FUNCTION public.upsert_outlook_interaction_candidate') < 0,
    'a signature change must never be CREATE OR REPLACE - that creates an overload')
  assert.deepStrictEqual(fnParams(NEW), [
    'p_connection_id', 'p_run_id', 'p_contact_id', 'p_episode_fingerprint', 'p_person_fingerprint',
    'p_key_version', 'p_proposed_type', 'p_proposed_date', 'p_lookup_fingerprints', 'p_proposed_notes',
    'p_draft_follow_up', 'p_summary_evidence', 'p_extraction_status',
  ])
  assert.deepStrictEqual(fnParams(OLD), fnParams(NEW).slice(0, 10), 'the first ten parameters are the applied ones, in order')
  for (const stmt of ['REVOKE ALL ON FUNCTION', 'GRANT EXECUTE ON FUNCTION']) {
    const i = NEW.indexOf(stmt)
    assert.ok(i >= 0, stmt)
    const sig = NEW.slice(i, NEW.indexOf(';', i))
    assert.ok(sig.indexOf('uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text') >= 0,
      stmt + ' must name the new 13-type signature')
  }
  assert.ok(NEW.indexOf(') FROM PUBLIC, anon, authenticated;') >= 0)
  assert.ok(NEW.indexOf(') TO service_role;') >= 0)
  assert.ok(NEW.indexOf('SECURITY DEFINER') >= 0 && NEW.indexOf("SET search_path = ''") >= 0)
  // Still no subject on the known-contact row: the privacy property the applied comment
  // cites is kept, and this is the one thing the new parameters must not include.
  assert.ok(NEW.indexOf('p_retained_subject') < 0, 'no subject parameter may be added to the known-contact write')
})

await test('the body is the applied 20261006000000 body plus exactly the marked additions - no guard was dropped or reworded', () => {
  const additions = (NEW.match(/-- >>> 20261008/g) || []).length
  assert.ok(additions >= 5, 'the additions must be marked: ' + additions)
  assert.strictEqual((NEW.match(/-- <<< 20261008/g) || []).length, additions, 'every block must close')
  const oldLines = normalized(fnBody(OLD).split(NL))
  const newLines = normalized(withoutMarkedBlocks(fnBody(NEW)))
  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i += 1) {
    assert.strictEqual(newLines[i], oldLines[i],
      'first difference at body line ' + (i + 1) + ': applied=' + JSON.stringify(oldLines[i]) + ' new=' + JSON.stringify(newLines[i]))
  }
  assert.strictEqual(newLines.length, oldLines.length)
})

await test('each new value is validated against the applied CHECK constraints and refused with a controlled code', () => {
  const body = fnBody(NEW)
  // draft_follow_up: <= 160, no control characters, no URL, never without a note.
  assert.ok(body.indexOf('char_length(v_follow) > 160') >= 0)
  assert.ok(body.indexOf("v_follow ~ '[[:cntrl:]]'") >= 0)
  assert.ok(body.indexOf("'invalid_follow_up'") >= 0)
  assert.ok(body.indexOf('IF v_follow IS NOT NULL AND (v_notes IS NULL') >= 0, 'a next step without a note is refused')
  // summary_evidence: one of the pair, never without a note, and the note then must not carry a URL.
  assert.ok(body.indexOf("p_summary_evidence NOT IN ('explicit_body', 'subject_only')") >= 0)
  assert.ok(body.indexOf("'invalid_evidence'") >= 0)
  assert.ok(body.indexOf('IF p_summary_evidence IS NOT NULL AND (v_notes IS NULL') >= 0)
  // extraction_status: the applied allowlist.
  assert.ok(body.indexOf("p_extraction_status NOT IN ('deterministic', 'ai_extracted', 'ai_failed')") >= 0)
  assert.ok(body.indexOf("'invalid_extraction_status'") >= 0)
  // draft_summary and summary_evidence move together, on INSERT and on refresh.
  assert.ok(body.indexOf('CASE WHEN p_summary_evidence IS NOT NULL THEN v_notes END') >= 0, 'INSERT pairs them')
  assert.ok(body.indexOf('draft_summary            = CASE WHEN p_summary_evidence IS NOT NULL THEN v_notes ELSE draft_summary END') >= 0, 'refresh pairs them')
  assert.ok(body.indexOf('draft_follow_up          = COALESCE(v_follow, draft_follow_up)') >= 0,
    'a later run with no next step must not blank one an earlier run wrote')
  // No provider or database error text can leave the function.
  assert.ok(body.indexOf('SQLERRM') < 0)
})

await test('the write planner sends the three on a successful draft and NONE of them on the metadata-only path', () => {
  const entry = { kind: 'known_contact_interaction', contactId: KNOWN_CONTACT, proposedType: 'Email',
    proposedDate: '2026-09-21', episodeFingerprint: 'a'.repeat(64), personFingerprint: 'b'.repeat(64),
    keyVersion: 1, episodeLookupFingerprints: [] }
  const note = planContentWrite(entry, { outcome: 'interaction_draft', summary: 'A real summary.',
    summaryEvidence: 'subject_only', followUp: 'Reply with two times.', extractionStatus: 'ai_extracted',
    interactionDate: '2026-09-21' }, { consentOpen: true })
  assert.strictEqual(note.rpc, 'upsert_outlook_interaction_candidate')
  assert.strictEqual(note.args.p_draft_follow_up, 'Reply with two times.')
  assert.strictEqual(note.args.p_summary_evidence, 'subject_only')
  assert.strictEqual(note.args.p_extraction_status, 'ai_extracted')
  const metadata = planContentWrite(entry, { outcome: 'defer', reason: 'content_consent_missing' }, { consentOpen: false })
  assert.strictEqual(metadata.write, 'interaction_metadata')
  for (const k of ['p_draft_follow_up', 'p_summary_evidence', 'p_extraction_status']) {
    assert.strictEqual(metadata.args[k], undefined, k + ' must stay absent when nothing was read')
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('6. the review queue shows the next step and the provenance for an existing contact')
// ═══════════════════════════════════════════════════════════════════════════════
await test('the queue selects the two draft columns the card renders, and still no identifier', () => {
  assert.ok(CANDIDATE_SELECT.indexOf('draft_follow_up') >= 0)
  assert.ok(CANDIDATE_SELECT.indexOf('extraction_status') >= 0)
  for (const bad of ['source_fingerprint', 'user_id', 'interaction_id', 'context_expires_at', 'retained_subject',
    'draft_summary', 'summary_evidence', 'connection_id']) {
    assert.ok(CANDIDATE_SELECT.indexOf(bad) < 0, 'the queue must not select ' + bad)
  }
})
await test('the card renders the suggested next step and says when the note was drafted by AI', () => {
  const PAGE = read('src/pages/SuggestionsPage.jsx')
  assert.ok(PAGE.indexOf('candidate.draft_follow_up') >= 0, 'the next step is rendered')
  assert.ok(PAGE.indexOf('Suggested next step:') >= 0)
  assert.ok(PAGE.indexOf("candidate.extraction_status === 'ai_extracted'") >= 0, 'the provenance line is conditional on the AI status')
  assert.ok(PAGE.indexOf('Drafted by AI from the message text') >= 0)
  // Neither is editable and neither is sent back: acceptance still carries the note alone.
  assert.ok(PAGE.indexOf('p_override_notes: notes || null') >= 0)
  assert.ok(PAGE.indexOf('p_draft_follow_up') < 0 && PAGE.indexOf('p_extraction_status') < 0,
    'the browser never writes draft columns')
})

console.log('')
console.log((passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed')
console.log('')
if (failed > 0) process.exit(1)
