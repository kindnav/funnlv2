// THE FIRST LIVE CONTENT PILOT ANSWERED WITH NO EXPLANATION.
//
// WHAT WAS OBSERVED, read-only, in Production at main 948c0a9: both folders finished
// (Inbox 6 messages, Sent Items 5), finalisation processed 4 of 6 conversations, a
// saved finalisation position existed, no candidate row had been created, and no
// mailbox cursor had been committed. Nothing in the worker answer said why.
//
// THE DEFECT. runOutlookImport builds the explanation and always has:
//
//     content: summarizeContentStage(content)     // outlookImportRun.js, in `partial`
//
// already reduced to counts and controlled codes. summarizeRun - the selector the
// handler runs the result through before it becomes the HTTP body - never named that
// field, so it was dropped on the way out. The one answer the pilot needed existed
// inside the invocation and never left it.
//
// WHY A CODE IS THE WHOLE POINT. `content_consent_missing` on every conversation and
// `summary_key_absent` on every conversation are the SAME empty result in the
// database - no notes, no candidates - and completely different things to fix. One is
// a connection that has to reconnect under the new disclosure; the other is an
// unconfigured key. Without the report the two are indistinguishable from outside.
//
// WHAT THIS SUITE PROVES, through the REAL handler and against the REAL HTTP body:
//
//   CASE A  a round with two conversations where the provider drafts one and defers
//           the other. Both must be visible in the response: notes_written for the
//           draft, and the deferral under its controlled code. Before the fix this
//           fails at the first assertion, because run.content is absent entirely.
//   CASE B  the counts are the producer numbers, not zeroes. summarizeContentStage
//           emits snake_case; a boundary re-check that read camelCase would match
//           nothing and report six zeroes - WORSE than the dropped field, since
//           notes_written: 0 reads as "the stage ran and wrote nothing" rather than
//           "not reported". Checked against the candidate actually written, so the
//           number has to agree with what happened.
//   CASE C  nothing else rides along. The serialized body is scanned for the message
//           text, both addresses, the Graph ids, the connection and contact ids, the
//           access token, the worker secret and the API key.
//
// NO NETWORK REQUEST IS MADE. One fixture fetch answers the three surfaces the run
// touches - Graph delta, Graph message content, and the Anthropic endpoint - and
// throws on any other URL. It is INJECTED, not installed on globalThis, so this suite
// shares no global with any other.
//
// Run with: node tests/outlook-worker-content-report.test.js

import { webcrypto } from 'node:crypto'
import {
  handleOutlookImportWorker,
} from '../supabase/functions/outlook-import-worker/handler.js'
import {
  importKeyFromBase64, encryptToken,
} from '../supabase/functions/shared/googleTokenCrypto.js'
import { GRAPH_BASE } from '../supabase/functions/shared/outlookGraphTransport.js'
import { ANTHROPIC_MESSAGES_URL } from '../supabase/functions/shared/outlookDraftContract.js'
import {
  REQUIRED_CONTENT_CONSENT_VERSION,
} from '../supabase/functions/shared/outlookContentConsent.js'
import {
  CONTENT_DEFERRAL_CODES, CONTENT_IGNORE_CODES, CONTENT_REPORT_COUNTS, CONTENT_REPORT_MAPS,
} from '../supabase/functions/shared/outlookContentStage.js'
import { makeRoundStore } from './harness/outlookRoundStore.js'

let passed = 0, failed = 0
function check (name, cond, detail = '') {
  if (cond) { console.log('  OK   ' + name); passed++ }
  else { console.error('  FAIL ' + name); if (detail) console.error('       ' + detail); failed++ }
}

const subtle = webcrypto.subtle

// -- invented fixtures. No real account, address, id, token or key. ----------
const KEY_B64 = Buffer.alloc(32, 7).toString('base64')
const SECRET = 's'.repeat(40)
const API_KEY = 'sk-ant-fixture-not-a-real-key'
const CONN = '11111111-1111-1111-1111-111111111111'
const PILOT = '22222222-2222-2222-2222-222222222222'
const CONTACT_A = '33333333-3333-3333-3333-333333333333'
const CONTACT_B = '44444444-4444-4444-4444-444444444444'
const ME = 'pilot@outlook.test'
const PARTY_A = 'ava@bank.test'
const PARTY_B = 'ben@fund.test'
const MSG_A_IN = 'AAkALgAAfixture-a-in-1'
const MSG_A_OUT = 'AAkALgAAfixture-a-out-1'
const MSG_B_IN = 'AAkALgAAfixture-b-in-1'
const MSG_B_OUT = 'AAkALgAAfixture-b-out-1'
const ACCESS_TOKEN = 'fixture-access-token-not-a-secret'

// The two bodies. Deliberately free of any address, so assertRequestMinimization has
// nothing to withhold the request over, and distinctive enough that the fixture can
// tell the two model calls apart from the request text alone - which is all the
// request carries.
//
// EACH CONVERSATION NEEDS BOTH HALVES. A one-sided exchange is skipped as
// `not_two_sided` before the content stage is reached - which is how the first draft
// of this suite reported attempted: 0 and looked like the fix had failed.
const BODY_A_IN = 'Good to meet you at the info session. I have put your name forward '
  + 'for the spring insight week and the team would like a short call next week to '
  + 'talk through your interest in credit. Does Tuesday morning work?'
const BODY_A_OUT = 'Thank you, Tuesday morning works well. I will prepare a few '
  + 'questions about the credit desk beforehand.'
const BODY_B_IN = 'Following up on the coffee chat about the growth fund. I am still '
  + 'waiting on our side to confirm whether the summer slot is funded, so there is '
  + 'nothing to decide yet.'
const BODY_B_OUT = 'Understood, no rush at all. Do let me know once there is news.'

const DRAFT_SUMMARY = 'She put your name forward for the spring insight week and '
  + 'asked for a short call on Tuesday about the credit desk.'

const workerReq = () => ({
  method: 'POST',
  headers: {
    get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer ' + SECRET : null),
  },
})

const env = () => ({
  integrationEnabled: 'true', workerEnabled: 'true', workerSecret: SECRET,
  clientId: 'c', clientSecret: 'cs', tokenKeyB64: KEY_B64,
  fingerprintKey: { current: { keyBytes: new Uint8Array(32).fill(1), keyVersion: 1 } },
  keyVersion: 1, pilotUserId: PILOT,
  scope: 'openid profile email offline_access Mail.Read User.Read',
  // The SUMMARY key. Absent, every conversation would report summary_key_absent -
  // itself one of the codes this suite exists to make visible.
  anthropicApiKey: API_KEY,
})

const addr = (e) => ({ emailAddress: { address: e, name: 'x' } })
const envelope = (id, conv, from, to, sent, subject) => ({
  id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
  subject, from: addr(from), sender: addr(from), toRecipients: to.map(addr),
  ccRecipients: [],
})

const ENVELOPES = {
  [MSG_A_IN]: envelope(MSG_A_IN, 'conv-a', PARTY_A, [ME], '2026-09-21T14:00:00Z', 'Insight week'),
  [MSG_A_OUT]: envelope(MSG_A_OUT, 'conv-a', ME, [PARTY_A], '2026-09-21T16:00:00Z', 'RE: Insight week'),
  [MSG_B_IN]: envelope(MSG_B_IN, 'conv-b', PARTY_B, [ME], '2026-09-22T10:00:00Z', 'Growth fund'),
  [MSG_B_OUT]: envelope(MSG_B_OUT, 'conv-b', ME, [PARTY_B], '2026-09-22T11:00:00Z', 'RE: Growth fund'),
}
const BODIES = {
  [MSG_A_IN]: BODY_A_IN, [MSG_A_OUT]: BODY_A_OUT,
  [MSG_B_IN]: BODY_B_IN, [MSG_B_OUT]: BODY_B_OUT,
}
const INBOX_PAGE = [ENVELOPES[MSG_A_IN], ENVELOPES[MSG_B_IN]]
const SENT_PAGE = [ENVELOPES[MSG_A_OUT], ENVELOPES[MSG_B_OUT]]

const okRes = (body) => ({ status: 200, headers: { get: () => null }, json: async () => body })

/**
 * The PostgREST + RPC pair, good enough for the real run-context loader and one
 * complete round. The access token is genuinely encrypted with the key the handler is
 * configured with and expires an hour out, so the loader decrypts it and attempts no
 * refresh.
 *
 * The round-store harness predates message retrieval: it ignores p_messages and does
 * not answer the handle RPC. Both are handled here, by keeping the handle records the
 * run sealed and serving the SAME ciphertext back - so handles round-trip through this
 * fixture exactly as they would through the table, and decryptCursor does real work
 * rather than being stubbed past.
 */
async function makePorts () {
  const key = await importKeyFromBase64(KEY_B64, subtle)
  const sealed = await encryptToken(ACCESS_TOKEN, key, { subtle })
  const expires = new Date(Date.now() + 3600000).toISOString()
  const store = makeRoundStore()
  const handles = []                 // every handle record the run stored
  const candidates = []              // every candidate write
  const releases = []

  const select = async (path) => {
    if (path.startsWith('microsoft_connections?')) {
      return { data: [{
        user_id: PILOT, ms_email: ME, scopes: ['Mail.Read', 'User.Read'],
        token_expires_at: expires,
        // ON THE CONTENT RELEASE. Read from the module rather than retyped: a literal
        // here would keep passing after a notice edit moved the real version on.
        consent_policy_version: REQUIRED_CONTENT_CONSENT_VERSION,
      }], error: null }
    }
    if (path.startsWith('contacts?')) {
      return { data: path.includes('offset=0')
        ? [{ id: CONTACT_A, user_id: PILOT, email: PARTY_A },
           { id: CONTACT_B, user_id: PILOT, email: PARTY_B }]
        : [], error: null }
    }
    if (path.startsWith('outlook_sync_state?')) return { data: [], error: null }
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
      return { data: { result: 'reserved', connection_id: CONN, user_id: PILOT, run_id: 'run-1' },
               error: null }
    }
    if (name === 'renew_outlook_sync_lease') return { data: true, error: null }
    if (name === 'upsert_outlook_interaction_candidate'
        || name === 'upsert_new_contact_candidate') {
      candidates.push({ rpc: name, args })
      return { data: { result: 'created' }, error: null }
    }
    if (name === 'release_outlook_sync_lease') {
      releases.push({ status: args && args.p_status, complete: args && args.p_run_complete,
                      errorCode: args && args.p_error_code })
      if (args && args.p_run_complete === true) store.commitRelease()
      return { data: true, error: null }
    }
    if (name === 'rotate_microsoft_access_token') {
      throw new Error('no refresh may be attempted: the fixture token is fresh')
    }
    // Keep the handles the run sealed, then let the store do the rest of the page.
    if (name === 'record_outlook_page_progress') {
      for (const m of (args && args.p_messages) || []) handles.push(m)
    }
    if (name === 'list_outlook_round_message_handles') {
      const want = new Set((args && args.p_cfps) || [])
      const mine = handles
        .filter((h) => want.has(h.cfp))
        .sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)))
      return { data: { result: 'ok', handles: mine, next_cursor: null }, error: null }
    }
    const s = await store.handle(name, args)
    if (s !== null) return s
    throw new Error('unexpected rpc: ' + name)
  }

  return { select, rpc, store, handles, candidates, releases }
}

/** The per-message content URL, parsed without a regex literal. */
const MESSAGES_PREFIX = GRAPH_BASE + '/me/messages/'
function contentMessageId (u) {
  if (!u.startsWith(MESSAGES_PREFIX)) return null
  const q = u.indexOf('?', MESSAGES_PREFIX.length)
  if (q < 0) return null
  return decodeURIComponent(u.slice(MESSAGES_PREFIX.length, q))
}

/**
 * ONE fixture fetch for all three surfaces. Any other URL throws, so a stray request
 * fails the test instead of leaving the machine.
 */
function makeFetch (counts) {
  return async (url, init) => {
    const u = String(url)

    if (u === ANTHROPIC_MESSAGES_URL) {
      counts.model += 1
      const sent = String((init && init.body) || '')
      counts.modelBodies.push(sent)
      // WHICH CONVERSATION? Decided from the request text, because that is all the
      // request has - no id, no address, no contact reference.
      const isA = sent.indexOf('insight week') >= 0
      const payload = isA
        ? {
            result: 'interaction_draft',
            summary: DRAFT_SUMMARY,
            summary_evidence: 'explicit_body',
            follow_up: 'Send your insight-week availability.',
            // null is accepted, and planContentWrite falls back to the envelope date,
            // so the fixture does not have to guess the allowed-date list.
            interaction_date: null,
          }
        // THE MODEL ITSELF DECLINES. A TERMINAL deferral, so finalisation still settles
        // the conversation - which is the live shape worth proving: a round that
        // completes and reports a conversation it deliberately wrote nothing for.
        : { result: 'defer' }
      return okRes({
        id: 'msg_fixture', type: 'message', role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    }

    const id = contentMessageId(u)
    if (id !== null) {
      counts.bodies += 1
      const env_ = ENVELOPES[id]
      const text = BODIES[id]
      if (!env_ || !text) {
        return { status: 404, headers: { get: () => null }, json: async () => ({}) }
      }
      return okRes(Object.assign({}, env_, {
        body: { contentType: 'text', content: text },
        uniqueBody: { contentType: 'text', content: text },
        // Present and clean: with no header collection the exchange cannot be screened
        // and the stage reports automation_unverified instead.
        internetMessageHeaders: [{ name: 'Received', value: 'by fixture' }],
      }))
    }

    if (!u.startsWith(GRAPH_BASE)) {
      throw new Error('the fixture refuses a non-Graph URL: ' + u.slice(0, 60))
    }
    counts.delta += 1
    const inbox = u.indexOf('/mailFolders/inbox/') >= 0
    const folder = inbox ? 'inbox' : 'sentitems'
    return okRes({
      value: inbox ? INBOX_PAGE : SENT_PAGE,
      '@odata.deltaLink':
        GRAPH_BASE + '/me/mailFolders/' + folder + '/messages/delta?$deltatoken=D',
    })
  }
}

const newCounts = () => ({ delta: 0, bodies: 0, model: 0, modelBodies: [] })

/** A frozen clock, so the invocation budget admits both conversations. */
const FIXED = 1780000000000

async function runWorker () {
  const ports = await makePorts()
  const counts = newCounts()
  const res = await handleOutlookImportWorker(workerReq(), env(), {
    tokenUrl: 'https://login.invalid/token',
    select: ports.select,
    rpc: ports.rpc,
    graphFetchImpl: makeFetch(counts),
    now: () => FIXED,
    subtle,
  })
  return { res, body: await res.json(), ports, counts }
}

// ===========================================================================
console.log('')
console.log('CASE A: a draft and a deferral both reach the HTTP response')

const A = await runWorker()
const run = A.body && A.body.run

check('the invocation answers 200', A.res.status === 200, 'status=' + A.res.status)
check('the round committed', run && run.outcome === 'committed', JSON.stringify(run))
check('both conversations were finalised',
  run && run.finalize && run.finalize.processed === 2 && run.finalize.complete === true,
  JSON.stringify(run && run.finalize))

// THE REGRESSION. Before the fix this key does not exist at all.
const report = run && run.content
check('the response carries a content report at all',
  report !== null && report !== undefined && typeof report === 'object',
  'run.content was ' + JSON.stringify(report) + ' - this is the dropped-field defect')

check('both conversations were attempted', report && report.attempted === 2,
  JSON.stringify(report))
check('the successful draft is visible as notes_written',
  report && report.notes_written === 1, JSON.stringify(report))
check('the deferral is visible under its controlled code',
  report && report.deferred && report.deferred.model_deferred === 1,
  JSON.stringify(report && report.deferred))
check('every deferral code reported is one the allowlist knows',
  Object.keys((report && report.deferred) || {}).every(
    (c) => CONTENT_DEFERRAL_CODES.includes(c)),
  JSON.stringify(Object.keys((report && report.deferred) || {})))
check('bodies were actually read, and the reported count equals the fixture count',
  report && report.bodies_read === A.counts.bodies && A.counts.bodies >= 4,
  'report=' + (report && report.bodies_read) + ' fixture=' + A.counts.bodies)
check('both conversations reached the provider, and the count says so',
  report && report.model_calls === A.counts.model && A.counts.model === 2,
  'report=' + (report && report.model_calls) + ' fixture=' + A.counts.model)
check('no envelope-only metadata row was written on the content release',
  report && report.metadata_only === 0, JSON.stringify(report))

// ===========================================================================
console.log('')
console.log('CASE B: the counts are the producer numbers, not a camelCase miss reporting zeroes')

check('every declared counter is present and an integer',
  CONTENT_REPORT_COUNTS.every((k) => Number.isInteger(report && report[k])),
  JSON.stringify(report))
check('not every counter is zero, which is what a snake_case/camelCase miss produces',
  CONTENT_REPORT_COUNTS.some((k) => report && report[k] > 0), JSON.stringify(report))

// The number has to agree with what the database was actually asked to do.
const withNote = A.ports.candidates.filter(
  (c) => typeof c.args.p_proposed_notes === 'string' && c.args.p_proposed_notes.length > 0)
check('exactly one candidate was written, and it carries the note',
  A.ports.candidates.length === 1 && withNote.length === 1,
  JSON.stringify(A.ports.candidates.map((c) => c.rpc)))
check('notes_written agrees with the candidate actually written',
  report.notes_written === withNote.length)
check('the note written is the drafted summary',
  withNote.length === 1 && withNote[0].args.p_proposed_notes === DRAFT_SUMMARY)
check('the lease was released complete',
  A.ports.releases.length === 1 && A.ports.releases[0].complete === true
  && A.ports.releases[0].status === 'idle',
  JSON.stringify(A.ports.releases))

// ===========================================================================
console.log('')
console.log('CASE C: nothing else rides along')

const serialized = JSON.stringify(A.body)
const forbidden = [
  ['the inbound message text', BODY_A_IN.slice(0, 40)],
  ['the outbound message text', BODY_A_OUT.slice(0, 40)],
  ['the other inbound message text', BODY_B_IN.slice(0, 40)],
  ['the drafted summary', DRAFT_SUMMARY.slice(0, 30)],
  ['the mailbox address', ME],
  ['a counterparty address', PARTY_A],
  ['the other counterparty address', PARTY_B],
  ['a Graph message id', MSG_A_IN],
  ['another Graph message id', MSG_B_OUT],
  ['the connection id', CONN],
  ['a contact id', CONTACT_A],
  ['the worker secret', SECRET],
  ['the API key', API_KEY],
  ['the access token', ACCESS_TOKEN],
  ['a subject line', 'Insight week'],
]
for (const pair of forbidden) {
  check('the response body does not contain ' + pair[0], !serialized.includes(pair[1]),
    serialized.slice(0, 200))
}
check('the report holds only the declared counters and the controlled maps',
  Object.keys(report).every(
    (k) => CONTENT_REPORT_COUNTS.includes(k) || CONTENT_REPORT_MAPS.includes(k)),
  JSON.stringify(Object.keys(report)))
// `refusal_categories` arrived with the finalisation-stall fix: which CATEGORY the
// privacy guard objected to, counted, from the guard's own controlled vocabulary.
// Empty here because nothing in this fixture trips the guard - and empty, not absent,
// is the point: the field is always present so a reader never has to guess whether
// "no refusal" means none happened or means the field was dropped again.
check('the refusal-category map is present and empty for a clean round',
  report.refusal_categories !== null && typeof report.refusal_categories === 'object'
  && Object.keys(report.refusal_categories).length === 0,
  JSON.stringify(report.refusal_categories))
check('every ignore code reported is one the allowlist knows',
  Object.keys(report.ignored || {}).every((c) => CONTENT_IGNORE_CODES.includes(c)),
  JSON.stringify(report.ignored))

console.log('')
console.log((passed + failed) + ' checks: ' + passed + ' passed, ' + failed + ' failed')
console.log('')
if (failed > 0) process.exit(1)
