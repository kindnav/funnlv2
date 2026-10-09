// THE CONTENT-FINALISATION STALL: a deterministic privacy refusal retried forever.
//
// WHAT THE PILOT ANSWERED, live:
//
//   outcome budget_exhausted, reason finalize_budget_exhausted
//   finalize { resumed: true, rows: 2, processed: 0, cursor_advanced: false }
//   content  { attempted: 1, bodies_read: 2, model_calls: 0 }
//   content.deferred { minimization_failed: 1 }
//   accepted 0, created 0, cursors_advanced 0        ... in about two seconds.
//
// Two seconds is the tell. `budget_exhausted` was not a budget running out; it is the
// outcome the run reports whenever the finalisation loop breaks early, and a RETRYABLE
// deferral breaks it without passing the conversation.
//
// THE MECHANISM, in four steps:
//
//   1. `minimization_failed` appeared in BOTH TERMINAL_DEFERRALS and
//      RETRYABLE_DEFERRALS.
//   2. planContentWrite tested the retryable list FIRST, so it returned
//      retryable: true.
//   3. runOutlookImport saw retryable and did `outOfBudget = true; break` WITHOUT
//      incrementing rowsProcessed and without advancing processedThrough.
//   4. batchComplete was therefore false, no cursor moved, and the next invocation
//      resumed from the same write cursor - re-reading the same mail, re-fetching the
//      same two bodies, and refusing again for the same reason.
//
// WHAT THE LIVE REPORT DOES AND DOES NOT ESTABLISH. It establishes the STALL: a
// `minimization_failed` deferral left processed at 0 with no cursor, on a resumed
// invocation, in about two seconds. It does NOT establish the CAUSE, and this suite
// must not be read as though it did.
//
// Before this fix, `minimization_failed` was emitted from TWO places:
//
//   * the privacy guard refusing a built request (assertRequestMinimization), and
//   * buildDraftRequest THROWING, where no request was built and the guard never ran.
//
// The live code cannot tell those apart - which is the second defect fixed here, and
// the reason `request_build_failed` now exists. So the live refusal's cause is UNKNOWN:
// it may have been an address in the mail, or it may have been a request that could not
// be constructed at all. The next invocation on the deployed fix will say which.
//
// WHAT THIS SUITE DOES. It drives the PRIVACY-GUARD branch deliberately, with an
// address in a fixture signature block, because that branch is the one whose
// classification caused the stall. Both branches are deterministic and both are now
// terminal, so the stall is fixed either way; the fixture picks one to exercise it.
//
// WHAT IS NOT WRONG, AND IS NOT CHANGED. In the fixture's branch the guard does its
// job: the request is withheld and zero model requests are sent. The defect is purely
// in what the run does AFTER a deterministic deferral.
//
// CASES
//   A  THE STALL, reproduced end to end through the real handler: a blocked
//      conversation followed by a clean one. The blocked conversation must be settled -
//      reported, no suggestion, no model request - and the clean one must still be
//      reached, so the round completes and the cursors advance.
//   B  the blocked conversation sends ZERO model requests and writes NO candidate,
//      measured against the fixture's own counters.
//   C  controls: a clean known contact becomes an interaction suggestion with a note,
//      and a clean unknown person becomes a new-contact proposal.
//   D  cursors advance only when the WHOLE round is settled - one conversation left
//      unfinished still forfeits every cursor.
//   E  a GENUINE transient failure still preserves the resume position.
//   F  terminal and retryable are disjoint, and the diagnostics carry no message text,
//      address, identifier, token or secret.
//
// NO NETWORK REQUEST IS MADE. One injected fixture answers Graph delta, Graph message
// content and the Anthropic endpoint, and throws on any other URL.
//
// Run with: node tests/outlook-content-stall.test.js

import { webcrypto } from 'node:crypto'
import {
  handleOutlookImportWorker,
} from '../supabase/functions/outlook-import-worker/handler.js'
import {
  importKeyFromBase64, encryptToken,
} from '../supabase/functions/shared/googleTokenCrypto.js'
import { GRAPH_BASE } from '../supabase/functions/shared/outlookGraphTransport.js'
import {
  ANTHROPIC_MESSAGES_URL, assertRequestMinimization, MINIMIZATION_CATEGORIES,
} from '../supabase/functions/shared/outlookDraftContract.js'
import {
  REQUIRED_CONTENT_CONSENT_VERSION,
} from '../supabase/functions/shared/outlookContentConsent.js'
import {
  TERMINAL_DEFERRALS, RETRYABLE_DEFERRALS, DEFERRAL_CLASS,
  CONTENT_DEFERRAL_CODES, CONTENT_REPORT_COUNTS, CONTENT_REPORT_MAPS, planContentWrite,
} from '../supabase/functions/shared/outlookContentStage.js'
import { DEFER_REASONS } from '../supabase/functions/shared/outlookContentPass.js'
import { makeRoundStore } from './harness/outlookRoundStore.js'

let passed = 0, failed = 0
function check (name, cond, detail = '') {
  if (cond) { console.log('  OK   ' + name); passed++ }
  else { console.error('  FAIL ' + name); if (detail) console.error('       ' + detail); failed++ }
}

const subtle = webcrypto.subtle
const AT = String.fromCharCode(64)

// -- invented fixtures. No real account, address, id, token or key. ----------
const KEY_B64 = Buffer.alloc(32, 7).toString('base64')
const SECRET = 's'.repeat(40)
const API_KEY = 'sk-ant-fixture-not-a-real-key'
const CONN = '11111111-1111-1111-1111-111111111111'
const PILOT = '22222222-2222-2222-2222-222222222222'
const CONTACT_BLOCKED = '33333333-3333-3333-3333-333333333333'
const CONTACT_CLEAN = '44444444-4444-4444-4444-444444444444'
const ME = 'pilot' + AT + 'outlook.test'
const PARTY_BLOCKED = 'ava' + AT + 'bank.test'
const PARTY_CLEAN = 'ben' + AT + 'fund.test'
const PARTY_STRANGER = 'cleo' + AT + 'ventures.test'

// THE ADDRESS THAT TRIPS THE GUARD, in this FIXTURE. It is the counterparty's own
// address in a signature block, which is a realistic way for one to appear - but it is
// the fixture's chosen cause, NOT a reconstruction of the live one. The live report said
// only `minimization_failed`, a code that at the time also covered a request that could
// not be built; nothing in it identifies an address or a signature.
// Nothing here weakens or bypasses the scan; the fixture reproduces its input.
const BLOCKED_IN = 'Good to meet you at the info session. I have put your name forward '
  + 'for the spring insight week and the team would like a short call next week.'
  + String.fromCharCode(10) + String.fromCharCode(10)
  + 'Ava Mensah | Analyst Programme | ' + PARTY_BLOCKED
const BLOCKED_OUT = 'Thank you, next week works well. I will send a few questions over '
  + 'beforehand so we can use the time properly.'

const CLEAN_IN = 'Following up on the coffee chat about the growth fund. The summer '
  + 'slot is confirmed and the team would like to meet you again in October.'
const CLEAN_OUT = 'That is great news. October suits me, and I will bring the model I '
  + 'mentioned so we can walk through the assumptions.'

const STRANGER_IN = 'I spoke to our analyst programme lead and she is happy to review '
  + 'your application for the summer cohort. Could you send an updated CV by Friday?'
const STRANGER_OUT = 'That is really kind of you. I will send the CV tomorrow, and the '
  + 'markets track is the better fit for me.'

const DRAFT_SUMMARY = 'The summer slot is confirmed and the team would like to meet '
  + 'again in October to walk through the model.'
const PROPOSAL_SUMMARY = 'He offered to put your application in front of the analyst '
  + 'programme lead and asked for an updated CV by Friday.'

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
  anthropicApiKey: API_KEY,
})

const addr = (e) => ({ emailAddress: { address: e, name: 'x' } })
const envelope = (id, conv, from, to, sent, subject) => ({
  id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
  subject, from: addr(from), sender: addr(from), toRecipients: to.map(addr),
  ccRecipients: [],
})

// Conversation order inside the round is by first message time, so the BLOCKED one is
// deliberately first: the whole question is whether anything after it is reachable.
// THE CONVERSATION KEYS ARE CHOSEN, NOT ARBITRARY. Finalisation lists a round in
// conversation-fingerprint order, and the fingerprint is an HMAC of the connection id
// and the conversation key - so which conversation comes first is not the mail's date.
// These three keys put the BLOCKED conversation first under the fixture key, which is
// the whole scenario: if the refusal is not settled, nothing after it is reachable.
// Case A asserts the order it actually got, so a fingerprint change fails the test
// loudly instead of quietly testing a weaker arrangement.
const CONV_BLOCKED = 'conv-blocked-0'
const CONV_CLEAN = 'conv-clean-2'
const CONV_STRANGER = 'conv-stranger-19'

const M = {
  bin: envelope('AAkALgAAblocked-in', CONV_BLOCKED, PARTY_BLOCKED, [ME],
    '2026-09-20T09:00:00Z', 'Insight week'),
  bout: envelope('AAkALgAAblocked-out', CONV_BLOCKED, ME, [PARTY_BLOCKED],
    '2026-09-20T11:00:00Z', 'RE: Insight week'),
  cin: envelope('AAkALgAAclean-in', CONV_CLEAN, PARTY_CLEAN, [ME],
    '2026-09-21T09:00:00Z', 'Growth fund'),
  cout: envelope('AAkALgAAclean-out', CONV_CLEAN, ME, [PARTY_CLEAN],
    '2026-09-21T10:00:00Z', 'RE: Growth fund'),
  sin: envelope('AAkALgAAstranger-in', CONV_STRANGER, PARTY_STRANGER, [ME],
    '2026-09-22T09:00:00Z', 'Summer analyst referral'),
  sout: envelope('AAkALgAAstranger-out', CONV_STRANGER, ME, [PARTY_STRANGER],
    '2026-09-22T10:00:00Z', 'RE: Summer analyst referral'),
}
const BODY = {
  'AAkALgAAblocked-in': BLOCKED_IN, 'AAkALgAAblocked-out': BLOCKED_OUT,
  'AAkALgAAclean-in': CLEAN_IN, 'AAkALgAAclean-out': CLEAN_OUT,
  'AAkALgAAstranger-in': STRANGER_IN, 'AAkALgAAstranger-out': STRANGER_OUT,
}

const okRes = (body) => ({ status: 200, headers: { get: () => null }, json: async () => body })

async function makePorts (opts = {}) {
  const key = await importKeyFromBase64(KEY_B64, subtle)
  const sealed = await encryptToken('fixture-access-token-not-a-secret', key, { subtle })
  const expires = new Date(Date.now() + 3600000).toISOString()
  const store = makeRoundStore()
  const handles = []
  const candidates = []
  const releases = []
  const rpcNames = []

  const select = async (path) => {
    if (path.startsWith('microsoft_connections?')) {
      return { data: [{
        user_id: PILOT, ms_email: ME, scopes: ['Mail.Read', 'User.Read'],
        token_expires_at: expires,
        consent_policy_version: REQUIRED_CONTENT_CONSENT_VERSION,
      }], error: null }
    }
    if (path.startsWith('contacts?')) {
      return { data: path.includes('offset=0')
        ? [{ id: CONTACT_BLOCKED, user_id: PILOT, email: PARTY_BLOCKED },
           { id: CONTACT_CLEAN, user_id: PILOT, email: PARTY_CLEAN }]
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
    rpcNames.push(name)
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
                      errorCode: args && args.p_error_code,
                      inbox: args && args.p_inbox_delta_ct,
                      sent: args && args.p_sentitems_delta_ct })
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
      if (opts.handlesUnreadable === true) {
        return { data: { result: 'rpc_error' }, error: { message: 'injected' } }
      }
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

  return { select, rpc, store, handles, candidates, releases, rpcNames }
}

const MESSAGES_PREFIX = GRAPH_BASE + '/me/messages/'
function contentMessageId (u) {
  if (!u.startsWith(MESSAGES_PREFIX)) return null
  const q = u.indexOf('?', MESSAGES_PREFIX.length)
  if (q < 0) return null
  return decodeURIComponent(u.slice(MESSAGES_PREFIX.length, q))
}

function makeFetch (counts, opts = {}) {
  return async (url, init) => {
    const u = String(url)

    if (u === ANTHROPIC_MESSAGES_URL) {
      counts.model += 1
      const sent = String((init && init.body) || '')
      counts.modelBodies.push(sent)
      if (opts.modelUnavailable === true) {
        return { status: 529, headers: { get: () => null }, json: async () => ({}) }
      }
      // WHICH CONVERSATION? From the request text, because that is all the request has.
      let payload
      if (sent.indexOf('growth fund') >= 0) {
        payload = {
          result: 'interaction_draft',
          summary: DRAFT_SUMMARY,
          summary_evidence: 'explicit_body',
          follow_up: 'Confirm an October date and bring the model.',
          interaction_date: null,
        }
      } else if (sent.indexOf('analyst programme') >= 0) {
        payload = {
          result: 'new_contact_suggestion',
          name: 'Cleo Adeyemi',
          name_evidence: 'explicit_signature', name_confidence: 'high',
          summary: PROPOSAL_SUMMARY,
          summary_evidence: 'explicit_body',
          follow_up: 'Send the updated CV before Friday.',
          interaction_date: null,
        }
      } else {
        // THE BLOCKED CONVERSATION MUST NEVER GET HERE. Answering it with a refusal
        // code would hide the failure, so the fixture fails the test instead.
        counts.unexpectedModel.push(sent.slice(0, 60))
        payload = { result: 'defer' }
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
      counts.bodyIds.push(id)
      const env_ = M[Object.keys(M).find((k) => M[k].id === id)]
      const text = BODY[id]
      if (!env_ || !text) {
        return { status: 404, headers: { get: () => null }, json: async () => ({}) }
      }
      return okRes(Object.assign({}, env_, {
        body: { contentType: 'text', content: text },
        uniqueBody: { contentType: 'text', content: text },
        internetMessageHeaders: [{ name: 'Received', value: 'by fixture' }],
      }))
    }

    if (!u.startsWith(GRAPH_BASE)) {
      throw new Error('the fixture refuses a non-Graph URL: ' + u.slice(0, 60))
    }
    counts.delta += 1
    const inbox = u.indexOf('/mailFolders/inbox/') >= 0
    const folder = inbox ? 'inbox' : 'sentitems'
    const value = opts.conversations === 'blocked_then_clean'
      ? (inbox ? [M.bin, M.cin] : [M.bout, M.cout])
      : (inbox ? [M.bin, M.cin, M.sin] : [M.bout, M.cout, M.sout])
    return okRes({
      value,
      '@odata.deltaLink':
        GRAPH_BASE + '/me/mailFolders/' + folder + '/messages/delta?$deltatoken=D',
    })
  }
}

const newCounts = () => ({ delta: 0, bodies: 0, model: 0, modelBodies: [], bodyIds: [],
                           unexpectedModel: [] })
const FIXED = 1780000000000

async function runWorker (opts = {}) {
  const ports = await makePorts(opts)
  const counts = newCounts()
  const res = await handleOutlookImportWorker(workerReq(), env(), {
    tokenUrl: 'https://login.invalid/token',
    select: ports.select,
    rpc: ports.rpc,
    graphFetchImpl: makeFetch(counts, opts),
    now: () => FIXED,
    subtle,
    requiredBackgroundConsent: REQUIRED_CONTENT_CONSENT_VERSION,   // the row's version: re-consented under the current notice
  })
  return { res, body: await res.json(), ports, counts }
}

// ===========================================================================
console.log('')
console.log('0. the guard itself is unchanged, and the fixture really does trip it')

{
  const clean = assertRequestMinimization(
    { system: 'contract', messages: [{ role: 'user', content: CLEAN_IN }] },
    { addresses: [ME, PARTY_CLEAN] })
  check('a clean request passes the guard', clean.ok === true, JSON.stringify(clean))
  const dirty = assertRequestMinimization(
    { system: 'contract', messages: [{ role: 'user', content: BLOCKED_IN }] },
    { addresses: [ME, PARTY_BLOCKED] })
  check('a request carrying a signature address is refused, category address',
    dirty.ok === false && Array.isArray(dirty.found) && dirty.found.includes('address'),
    JSON.stringify(dirty))
  check('the guard never returns the offending value',
    !JSON.stringify(dirty).includes(PARTY_BLOCKED), JSON.stringify(dirty))
}

// ===========================================================================
console.log('')
console.log('1. CASE A: a blocked conversation no longer stalls the round')

const A = await runWorker({ conversations: 'blocked_then_clean' })
const runA = A.body && A.body.run
const repA = runA && runA.content

check('the invocation answers 200', A.res.status === 200, 'status=' + A.res.status)
// THE SCENARIO IS THE ONE INTENDED: the blocked conversation is dealt with FIRST, so
// the clean one is genuinely "after the blockage" rather than merely alongside it.
check('the BLOCKED conversation was finalised first',
  A.counts.bodyIds.length > 0 && A.counts.bodyIds[0].indexOf('blocked') >= 0,
  'first body fetched was ' + JSON.stringify(A.counts.bodyIds[0]))
// THE STALL: before the fix this is budget_exhausted / finalize_budget_exhausted after
// about two seconds, with processed 0 and no cursor.
check('the outcome is committed, not budget_exhausted',
  runA && runA.outcome === 'committed',
  'outcome=' + (runA && runA.outcome) + ' reason=' + (runA && runA.reason))
check('the run reports no finalise-budget reason',
  runA && runA.reason !== 'finalize_budget_exhausted', JSON.stringify(runA && runA.reason))
check('BOTH conversations were finalised, so the blocked one did not block the other',
  runA && runA.finalize && runA.finalize.processed === 2
  && runA.finalize.rows === 2 && runA.finalize.complete === true,
  JSON.stringify(runA && runA.finalize))
check('the write cursor advanced', runA && runA.finalize
  && runA.finalize.cursor_advanced === true, JSON.stringify(runA && runA.finalize))
check('both mailbox cursors were committed', runA && runA.cursors_advanced === 2,
  'cursors_advanced=' + (runA && runA.cursors_advanced))

check('the refusal is still REPORTED, under its controlled code',
  repA && repA.deferred && repA.deferred.minimization_failed === 1,
  JSON.stringify(repA && repA.deferred))
check('and the safe category reaches the HTTP report',
  repA && repA.refusal_categories && repA.refusal_categories.address === 1,
  JSON.stringify(repA && repA.refusal_categories))
check('the clean conversation still produced its note',
  repA && repA.notes_written === 1, JSON.stringify(repA))
check('no envelope-only metadata row was substituted for the refusal',
  repA && repA.metadata_only === 0, JSON.stringify(repA))

// ===========================================================================
console.log('')
console.log('2. CASE B: the blocked conversation reaches no provider and writes nothing')

check('exactly one model request was sent, for the clean conversation only',
  A.counts.model === 1, 'model=' + A.counts.model)
check('the fixture saw no model request it could not account for',
  A.counts.unexpectedModel.length === 0, JSON.stringify(A.counts.unexpectedModel))
check('no model request carried the blocked address',
  A.counts.modelBodies.every((b) => b.indexOf(PARTY_BLOCKED) < 0))
check('the report agrees: one model call for two attempted conversations',
  repA && repA.attempted === 2 && repA.model_calls === 1, JSON.stringify(repA))
check('the blocked bodies WERE read - the refusal happens after the read, by design',
  repA && repA.bodies_read === A.counts.bodies && A.counts.bodies === 4,
  'report=' + (repA && repA.bodies_read) + ' fixture=' + A.counts.bodies)
check('exactly one candidate was written, for the clean conversation',
  A.ports.candidates.length === 1
  && A.ports.candidates[0].rpc === 'upsert_outlook_interaction_candidate',
  JSON.stringify(A.ports.candidates.map((c) => c.rpc)))
check('and it carries a real note, not an empty one',
  A.ports.candidates[0].args.p_proposed_notes === DRAFT_SUMMARY)

// ===========================================================================
console.log('')
console.log('3. CASE C: clean known-contact and unknown-person controls')

const C = await runWorker({ conversations: 'all_three' })
const runC = C.body && C.body.run
const repC = runC && runC.content

check('the round committed', runC && runC.outcome === 'committed', JSON.stringify(runC))
check('all three conversations were finalised',
  runC && runC.finalize && runC.finalize.processed === 3
  && runC.finalize.complete === true, JSON.stringify(runC && runC.finalize))
check('one note for the known contact', repC && repC.notes_written === 1,
  JSON.stringify(repC))
check('one proposal for the unknown person', repC && repC.proposals_written === 1,
  JSON.stringify(repC))
check('the refusal is reported once, alongside both successes',
  repC && repC.deferred && repC.deferred.minimization_failed === 1,
  JSON.stringify(repC && repC.deferred))
check('two model requests, one per clean conversation', C.counts.model === 2,
  'model=' + C.counts.model)
const rpcsC = C.ports.candidates.map((c) => c.rpc).sort()
check('exactly two candidates: one interaction, one new contact',
  rpcsC.length === 2 && rpcsC[0] === 'upsert_new_contact_candidate'
  && rpcsC[1] === 'upsert_outlook_interaction_candidate', JSON.stringify(rpcsC))
const proposal = C.ports.candidates.find((c) => c.rpc === 'upsert_new_contact_candidate')
check('the proposal carries the drafted summary and an AI provenance code',
  proposal && proposal.args.p_draft_summary === PROPOSAL_SUMMARY
  && proposal.args.p_extraction_status === 'ai_extracted',
  JSON.stringify(proposal && proposal.args.p_extraction_status))
check('the proposed address came from the envelope, not the model',
  proposal && proposal.args.p_proposed_email === PARTY_STRANGER)

// ===========================================================================
console.log('')
console.log('4. CASE D: cursors advance only when the WHOLE round is settled')

check('the committed release carried both folder cursors',
  A.ports.releases.length === 1 && A.ports.releases[0].complete === true
  && typeof A.ports.releases[0].inbox === 'string'
  && typeof A.ports.releases[0].sent === 'string',
  JSON.stringify(A.ports.releases.map((r) => ({ status: r.status, complete: r.complete,
    inbox: typeof r.inbox, sent: typeof r.sent }))))

// ===========================================================================
console.log('')
console.log('5. CASE E: a genuine transient failure still preserves the resume position')

const E = await runWorker({ conversations: 'blocked_then_clean', handlesUnreadable: true })
const runE = E.body && E.body.run
const repE = runE && runE.content

check('a handle-read failure does NOT settle the conversation',
  runE && runE.finalize && runE.finalize.processed === 0,
  JSON.stringify(runE && runE.finalize))
check('and so no cursor is committed', runE && runE.cursors_advanced === 0
  && runE.finalize.cursor_advanced === false, JSON.stringify(runE && runE.finalize))
check('it is reported as the retryable code it is',
  repE && repE.deferred && repE.deferred.handles_unreadable === 1,
  JSON.stringify(repE && repE.deferred))
check('no candidate was written', E.ports.candidates.length === 0,
  JSON.stringify(E.ports.candidates.map((c) => c.rpc)))
check('and no model request was sent', E.counts.model === 0, 'model=' + E.counts.model)
check('the lease was released incomplete, so the round resumes',
  E.ports.releases.length === 1 && E.ports.releases[0].complete === false,
  JSON.stringify(E.ports.releases.map((r) => r.complete)))

// ===========================================================================
console.log('')
console.log('6. CASE F: the classification invariant, and the vocabularies')

const overlap = TERMINAL_DEFERRALS.filter((c) => RETRYABLE_DEFERRALS.includes(c))
check('TERMINAL and RETRYABLE are DISJOINT - the defect that caused the stall',
  overlap.length === 0, 'in both lists: ' + JSON.stringify(overlap))
check('every code is classified exactly once',
  CONTENT_DEFERRAL_CODES.every((c) => DEFERRAL_CLASS[c] === 'terminal'
    || DEFERRAL_CLASS[c] === 'retryable')
  && CONTENT_DEFERRAL_CODES.length
     === TERMINAL_DEFERRALS.length + RETRYABLE_DEFERRALS.length,
  JSON.stringify({ codes: CONTENT_DEFERRAL_CODES.length,
    terminal: TERMINAL_DEFERRALS.length, retryable: RETRYABLE_DEFERRALS.length }))
check('the two lists are derived from the map, so neither can drift',
  TERMINAL_DEFERRALS.every((c) => DEFERRAL_CLASS[c] === 'terminal')
  && RETRYABLE_DEFERRALS.every((c) => DEFERRAL_CLASS[c] === 'retryable'))

check('a deterministic privacy refusal is TERMINAL',
  DEFERRAL_CLASS.minimization_failed === 'terminal')
check('a request-building failure has its OWN code, also terminal',
  DEFERRAL_CLASS.request_build_failed === 'terminal'
  && DEFER_REASONS.includes('request_build_failed'))
// The two deterministic failures are DIFFERENT codes with different meanings, and the
// report can carry either. The end-to-end proof that the pass actually emits
// request_build_failed at the buildDraftRequest catch - driven through the real
// sanitizer at its own worst case - lives in outlook-content-corrections.test.js; what
// is checked here is that the vocabulary keeps them apart and that only the privacy
// refusal carries a category.
check('both deterministic failures are in the vocabulary, as separate codes',
  CONTENT_DEFERRAL_CODES.includes('request_build_failed')
  && CONTENT_DEFERRAL_CODES.includes('minimization_failed')
  && CONTENT_DEFERRAL_CODES.filter((c) => c === 'request_build_failed').length === 1)
check('only the privacy refusal carries a category, because only it inspected a request',
  MINIMIZATION_CATEGORIES.indexOf('request_build_failed') < 0)

// Genuinely transient or configuration-dependent reasons stay retryable.
for (const r of ['budget_exhausted', 'fetch_failed', 'model_unavailable',
  'handles_unreadable', 'summary_key_absent']) {
  const plan = planContentWrite(
    { contactId: CONTACT_CLEAN, proposedType: 'Email', proposedDate: '2026-09-21',
      episodeFingerprint: 'e'.repeat(64), personFingerprint: 'p'.repeat(64), keyVersion: 1 },
    { outcome: 'defer', reason: r }, { consentOpen: true })
  check('retryable preserved for ' + r,
    plan.write === 'none' && plan.retryable === true && plan.deferral === r,
    JSON.stringify(plan))
}
// And the deterministic ones settle instead.
for (const r of ['minimization_failed', 'request_build_failed', 'no_usable_content',
  'ambiguous_counterparty', 'model_output_invalid', 'model_deferred']) {
  const plan = planContentWrite(
    { contactId: CONTACT_CLEAN, proposedType: 'Email', proposedDate: '2026-09-21',
      episodeFingerprint: 'e'.repeat(64), personFingerprint: 'p'.repeat(64), keyVersion: 1 },
    { outcome: 'defer', reason: r }, { consentOpen: true })
  check('settled, with no row, for ' + r,
    plan.write === 'none' && plan.rpc === null && plan.retryable === false
    && plan.deferral === r, JSON.stringify(plan))
}

// ── the diagnostics carry nothing they should not ──────────────────────────
const bodies = [JSON.stringify(A.body), JSON.stringify(C.body), JSON.stringify(E.body)]
const forbidden = [
  ['the blocked address', PARTY_BLOCKED],
  ['the clean address', PARTY_CLEAN],
  ['the stranger address', PARTY_STRANGER],
  ['the mailbox address', ME],
  ['the blocked signature text', 'Ava Mensah'],
  ['a message body', CLEAN_IN.slice(0, 40)],
  ['a drafted summary', DRAFT_SUMMARY.slice(0, 30)],
  ['a Graph message id', M.bin.id],
  ['the connection id', CONN],
  ['a contact id', CONTACT_BLOCKED],
  ['the worker secret', SECRET],
  ['the API key', API_KEY],
  ['an at sign anywhere', AT],
]
for (const pair of forbidden) {
  check('no response body contains ' + pair[0],
    bodies.every((b) => b.indexOf(pair[1]) < 0))
}
check('every reported refusal category is in the controlled vocabulary',
  Object.keys((repA && repA.refusal_categories) || {})
    .every((c) => MINIMIZATION_CATEGORIES.includes(c)),
  JSON.stringify(repA && repA.refusal_categories))
// PINNED AGAINST ONE LIST. This used to spell the maps out inline, which meant every
// new diagnostic had to be added here, in the report suite, and in the pass suite
// separately. CONTENT_REPORT_MAPS is the single list, so a field that is not on it
// fails this check wherever it was added.
check('the report still holds only counters and the controlled maps',
  Object.keys(repA || {}).every((k) => CONTENT_REPORT_COUNTS.includes(k)
    || CONTENT_REPORT_MAPS.includes(k)),
  JSON.stringify(Object.keys(repA || {})))

console.log('')
console.log((passed + failed) + ' checks: ' + passed + ' passed, ' + failed + ' failed')
console.log('')
if (failed > 0) process.exit(1)
