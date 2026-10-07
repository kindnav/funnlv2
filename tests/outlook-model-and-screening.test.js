// TWO FAILURES FROM THE LATEST LIVE PILOT, and what each one needed.
//
// LIVE EVIDENCE (one invocation, read-only; kept strictly separate from the fixture
// evidence below, which is invented):
//
//   outcome continued, intended 2, accepted 0, created 0, cursors_advanced 0
//   finalize { rows: 2, processed: 1, complete: false }
//   content  { attempted: 2, bodies_read: 3, model_calls: 1 }
//   content.deferred { automation_unverified: 1, model_unavailable: 1 }
//   content.refusal_categories {}
//
// Two conversations. One was settled as automation_unverified (terminal, so processed
// reached 1); the other deferred as model_unavailable (retryable, so the loop stopped
// without passing it) - which is why the round is incomplete with no cursor. That part
// behaved as designed. What the report could not say is WHY either happened.
//
// ---------------------------------------------------------------------------
// 1. THE MODEL FAILURE: a code existed and the report dropped it.
//
// callDraftModel already separated an authentication refusal from a 400, a rate limit,
// a timeout and a transport failure. The pass collapsed every one into a single
// `model_unavailable` deferral, and runOutlookImport read only `pass.reason` - never
// `pass.code`. So a conversation that read a body and spent a provider call reported
// "a model call failed" and nothing more. A caught LOCAL exception took the same path,
// so a programming fault in the call path was indistinguishable from the provider
// being down.
//
// Fixed by carrying the controlled code and, where the provider actually answered, the
// numeric status; and by giving a thrown exception its own fixed code. The deferral
// REASON is still `model_unavailable`, so classification and retryability are
// unchanged - only the diagnosis is richer.
//
// ---------------------------------------------------------------------------
// 2. THE AUTOMATION EVIDENCE: the wrong message decided the question.
//
// The screening check sat INSIDE the loop over every selected message and returned
// `automation_unverified` the moment any one of them lacked a header collection -
// including the user's own outbound message. Reproduced below both ways round: with
// the outbound first the counterparty's reply was never fetched at all; with the
// inbound first its complete, clean headers were read and then discarded.
//
// IS REQUIRING OUTBOUND HEADERS APPROPRIATE? No. The question screening answers is
// whether the COUNTERPARTY is a person or a mailing list, and every signal the
// classifiers read is set by the sending side: List-Id, List-Unsubscribe and
// Precedence identify the list that sent a message; Auto-Submitted and
// X-Auto-Response-Suppress identify an auto-generated one; the remaining rules screen
// the sender address and subject. On an outbound message the sender is the mailbox
// owner, so its headers describe the user's own mail.
//
// PROVIDER CLAIM, from Microsoft's primary Graph documentation (message resource,
// internetMessageHeaders): "A collection of message headers defined by RFC5322. The
// set includes message headers indicating the network path taken by a message from the
// sender to the recipient." It also "Requires $select to retrieve", which CONTENT_SELECT
// does. The documentation does NOT state whether the collection is present on sent
// mail, so nothing here assumes it is absent there - and nothing assumes the live
// missing collection belonged to Sent Items. The new per-folder counters measure it.
//
// Fixed by recording the absence per folder and deciding ONCE for the conversation, on
// INBOUND evidence. Absent counterparty evidence still fails closed.
//
// Run with: node tests/outlook-model-and-screening.test.js

import { webcrypto } from 'node:crypto'
import {
  handleOutlookImportWorker,
} from '../supabase/functions/outlook-import-worker/handler.js'
import {
  importKeyFromBase64, encryptToken,
} from '../supabase/functions/shared/googleTokenCrypto.js'
import { GRAPH_BASE } from '../supabase/functions/shared/outlookGraphTransport.js'
import {
  ANTHROPIC_MESSAGES_URL, callDraftModel, buildDraftRequest,
  DRAFT_FAILURE_CODES, DRAFT_MAX_RETRIES, DRAFT_TIMEOUT_MS,
} from '../supabase/functions/shared/outlookDraftContract.js'
import {
  REQUIRED_CONTENT_CONSENT_VERSION, REQUIRED_THIRD_PARTY_CONSENT_VERSION,
} from '../supabase/functions/shared/outlookContentConsent.js'
import {
  summarizeConversation,
} from '../supabase/functions/shared/outlookContentPass.js'
import {
  CONTENT_FOLDERS, CONTENT_REPORT_COUNTS, CONTENT_REPORT_MAPS,
} from '../supabase/functions/shared/outlookContentStage.js'
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
const CONTACT = '33333333-3333-3333-3333-333333333333'
const ME = 'pilot' + AT + 'outlook.test'
const THEM = 'ava' + AT + 'bank.test'
const STRANGER = 'cleo' + AT + 'ventures.test'
const V = REQUIRED_CONTENT_CONSENT_VERSION
const T = REQUIRED_THIRD_PARTY_CONSENT_VERSION

const INBOUND_TEXT = 'Good to meet you at the info session. I have put your name forward '
  + 'for the spring insight week and the team would like a short call next week.'
const OUTBOUND_TEXT = 'Thank you, next week works well. I will send a few questions over '
  + 'beforehand so we can use the time properly.'

const ok = (body, status = 200, headers = {}) => ({
  status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  json: async () => body,
})
const abortError = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e }

const SAMPLE_REQUEST = buildDraftRequest({
  mode: 'known_contact', displayName: null, subject: 'Insight week',
  messages: [{ direction: 'inbound', dateIso: '2026-09-20T09:00:00Z',
    text: INBOUND_TEXT, signature: null }],
  allowedDates: ['2026-09-20'],
})

// ===========================================================================
console.log('')
console.log('1. callDraftModel: every failure carries its controlled code, and its status')

// FIXTURE EVIDENCE. Each case is the real callDraftModel over an injected fetch; the
// sleep is injected so a rate-limit case does not spend its backoff in real time, and
// the per-attempt timeout is injected so a deadline case does not wait 30 seconds.
async function callWith (fetchImpl, opts = {}) {
  let slept = 0
  let calls = 0
  const wrapped = async (...a) => { calls += 1; return fetchImpl(...a) }
  const r = await callDraftModel({
    body: SAMPLE_REQUEST,
    apiKey: API_KEY,
    fetchImpl: wrapped,
    sleepImpl: async (ms) => { slept += ms },
    timeoutMs: opts.timeoutMs,
    budgetAllows: opts.budgetAllows,
  })
  return { r, slept, calls }
}

{
  // AUTHENTICATION REFUSAL. 401 and 403 are both "the key will not do this", and the
  // numeric status is what separates a wrong key from an unentitled one.
  for (const status of [401, 403]) {
    const { r, calls } = await callWith(async () => ok({ error: { type: 'authentication_error' } }, status))
    check('a ' + status + ' is provider_unauthorized, with the status',
      r.ok === false && r.code === 'provider_unauthorized' && r.status === status,
      JSON.stringify(r))
    check('  and it is NOT retried - a refused key will refuse again', calls === 1,
      'calls=' + calls)
  }
}

{
  // BAD REQUEST.
  const { r, calls } = await callWith(async () => ok({ error: { type: 'invalid_request_error' } }, 400))
  check('a 400 is provider_bad_request, with the status',
    r.ok === false && r.code === 'provider_bad_request' && r.status === 400, JSON.stringify(r))
  check('  and it is NOT retried', calls === 1, 'calls=' + calls)
}

{
  // RATE LIMITING. Retried to the bound, then reported - and the retry bound itself is
  // asserted, so loosening it fails here.
  const { r, slept, calls } = await callWith(async () => ok({}, 429, { 'retry-after': '2' }))
  check('a 429 is provider_rate_limited, with the status',
    r.ok === false && r.code === 'provider_rate_limited' && r.status === 429, JSON.stringify(r))
  check('  retried exactly DRAFT_MAX_RETRIES times and no more',
    calls === DRAFT_MAX_RETRIES + 1, 'calls=' + calls + ' bound=' + DRAFT_MAX_RETRIES)
  check('  Retry-After was honoured, bounded', slept > 0 && slept <= 60000, 'slept=' + slept)
}

{
  // A 5xx and a 529 take the same retried path but report provider_unavailable.
  for (const status of [500, 529]) {
    const { r, calls } = await callWith(async () => ok({}, status))
    check('a ' + status + ' is provider_unavailable, with the status',
      r.ok === false && r.code === 'provider_unavailable' && r.status === status, JSON.stringify(r))
    check('  and it used the retry budget', calls === DRAFT_MAX_RETRIES + 1, 'calls=' + calls)
  }
}

{
  // TIMEOUT. An AbortError is what the injected controller produces when the deadline
  // fires; there is no response, so there is NO status to report.
  const { r, calls } = await callWith(async () => { throw abortError() }, { timeoutMs: 5 })
  check('an aborted attempt is provider_timeout',
    r.ok === false && r.code === 'provider_timeout', JSON.stringify(r))
  check('  and carries NO status, because no response existed',
    r.status === undefined, JSON.stringify(r))
  check('  retried to the bound and no further', calls === DRAFT_MAX_RETRIES + 1, 'calls=' + calls)
  check('  the shipped deadline is still 30s', DRAFT_TIMEOUT_MS === 30000)
}

{
  // A transport failure is NOT a timeout, and is told apart from one.
  const { r } = await callWith(async () => { throw new Error('socket hang up') })
  check('a non-abort throw is transport_failure, not provider_timeout',
    r.ok === false && r.code === 'transport_failure' && r.status === undefined, JSON.stringify(r))
}

{
  // RESUMABILITY: with no budget left the call is refused before any request.
  const { r, calls } = await callWith(async () => ok({}, 200), { budgetAllows: () => false })
  check('no budget means no request at all, reported as budget_exhausted',
    r.ok === false && r.code === 'budget_exhausted' && calls === 0,
    JSON.stringify(r) + ' calls=' + calls)
}

{
  // SUCCESS. The control: a 200 with a valid payload still parses.
  const payload = { result: 'interaction_draft', summary: 'A short call next week was agreed.',
    summary_evidence: 'explicit_body', follow_up: null, interaction_date: null }
  const { r, calls } = await callWith(async () => ok({
    content: [{ type: 'text', text: JSON.stringify(payload) }], stop_reason: 'end_turn',
  }))
  check('a 200 with a valid payload succeeds', r.ok === true && calls === 1, JSON.stringify(r))
  check('  and reports no failure code', r.code === undefined, JSON.stringify(r))
}

check('every code used above is in the declared vocabulary',
  ['provider_unauthorized', 'provider_bad_request', 'provider_rate_limited',
    'provider_unavailable', 'provider_timeout', 'transport_failure', 'budget_exhausted',
    'model_call_threw'].every((c) => DRAFT_FAILURE_CODES.includes(c)))

// ===========================================================================
console.log('')
console.log('2. the pass: a LOCAL exception is its own fixed code, and its message never escapes')

function passParams (over = {}) {
  const spec = over.spec ?? [
    { folder: 'inbox', complete: true },
    { folder: 'sentitems', complete: true },
  ]
  const state = { models: 0, fetched: [] }
  const base = {
    conversation: {
      cfp: 'c'.repeat(64),
      contactId: over.knownContact === false ? null : CONTACT,
      messageCount: spec.length, lastLocalDate: '2026-09-21',
    },
    handles: spec.map((m, i) => ({
      mfp: String(i + 1).repeat(64).slice(0, 64), folder: m.folder,
      sentAt: '2026-09-1' + i + 'T09:00:00Z',
      midCt: 'S:' + i, midNonce: 'N', keyVersion: 1,
    })),
    decryptHandle: async ({ ciphertext }) => String(ciphertext).replace('S:', ''),
    fetchMessage: async (id) => {
      state.fetched.push(id)
      const m = spec[Number(id)]
      const inbound = m.folder === 'inbox'
      return { ok: true, message: {
        uniqueBodyContent: inbound ? INBOUND_TEXT : OUTBOUND_TEXT,
        bodyContent: '', subject: 'Insight week',
        from: { address: inbound ? (over.knownContact === false ? STRANGER : THEM) : ME },
        toRecipients: [{ address: inbound ? ME : (over.knownContact === false ? STRANGER : THEM) }],
        automation: m.automation ?? {}, automationComplete: m.complete,
      } }
    },
    callModel: over.callModel ?? (async () => {
      state.models += 1
      return { ok: true, parsed: { result: 'interaction_draft',
        summary: 'A short call next week was agreed about the credit desk.',
        summary_evidence: 'explicit_body', follow_up: null, interaction_date: null } }
    }),
    apiKey: API_KEY, selfAddresses: [ME], budgetAllows: () => true,
    requiresScreening: over.requiresScreening === true,
    consentVersion: V, requiredConsent: { content: V, thirdParty: T },
  }
  return { state, params: base }
}

{
  // THE SECRET IN THE THROWN VALUE MUST NOT ESCAPE. The fixture throws an error whose
  // message carries the key and the endpoint, which is exactly what a real transport
  // error can carry.
  const poison = 'leaked ' + API_KEY + ' at ' + ANTHROPIC_MESSAGES_URL
  const { params } = passParams({
    callModel: async () => { throw new Error(poison) },
  })
  const r = await summarizeConversation(params)
  check('a thrown exception defers as model_unavailable',
    r.outcome === 'defer' && r.reason === 'model_unavailable', JSON.stringify(r))
  check('  with the FIXED code model_call_threw, not a provider code',
    r.code === 'model_call_threw', JSON.stringify(r.code))
  check('  and no status, because no provider answered', r.status === null || r.status === undefined)
  const s = JSON.stringify(r)
  check('  the thrown message does not escape', s.indexOf('leaked') < 0, s.slice(0, 160))
  check('  the API key does not escape', s.indexOf(API_KEY) < 0)
  check('  the endpoint does not escape', s.indexOf('api.anthropic.com') < 0)
}

{
  // A PROVIDER verdict keeps its own code and status.
  const { params } = passParams({
    callModel: async () => ({ ok: false, code: 'provider_unauthorized', status: 401 }),
  })
  const r = await summarizeConversation(params)
  check('a provider refusal carries its code and status through the pass',
    r.reason === 'model_unavailable' && r.code === 'provider_unauthorized' && r.status === 401,
    JSON.stringify(r))
}

{
  // CONSENT IS STILL CHECKED FIRST, and a closed gate never reaches the model.
  const { state, params } = passParams()
  const r = await summarizeConversation({ ...params, consentVersion: null })
  check('a closed consent gate defers before any model call',
    r.outcome === 'defer' && r.reason === 'content_consent_missing' && state.models === 0,
    JSON.stringify(r))
}

// ===========================================================================
console.log('')
console.log('3. screening: the verdict belongs to the conversation, on INBOUND evidence')

const IN_OK = { folder: 'inbox', complete: true }
const IN_NO = { folder: 'inbox', complete: false }
const OUT_OK = { folder: 'sentitems', complete: true }
const OUT_NO = { folder: 'sentitems', complete: false }

async function screen (spec) {
  const { state, params } = passParams({
    spec, knownContact: false, requiresScreening: true,
    callModel: async () => {
      state.models += 1
      return { ok: true, parsed: {
        result: 'new_contact_suggestion',
        name: 'Cleo Adeyemi', name_evidence: 'explicit_signature', name_confidence: 'high',
        company: null, company_evidence: null, company_confidence: null,
        role: null, role_evidence: null, role_confidence: null,
        how_met: null, how_met_evidence: null, how_met_confidence: null,
        linkedin_url: null, linkedin_url_evidence: null, linkedin_url_confidence: null,
        tags: [], summary: 'She offered to put the application forward.',
        summary_evidence: 'explicit_body', follow_up: null, interaction_date: null,
      } }
    },
  })
  const r = await summarizeConversation(params)
  return { r, state }
}

{
  // THE LIVE-SHAPED CASE, both orderings. Before the fix both deferred
  // automation_unverified; with the outbound first, the inbound reply was never fetched.
  for (const [label, spec] of [['outbound first', [OUT_NO, IN_OK]], ['inbound first', [IN_OK, OUT_NO]]]) {
    const { r, state } = await screen(spec)
    check('the counterparty is screened on ITS OWN headers (' + label + ')',
      r.outcome === 'new_contact_suggestion', JSON.stringify({ o: r.outcome, re: r.reason }))
    check('  both bodies were read, so the reply was not skipped (' + label + ')',
      state.fetched.length === 2, JSON.stringify(state.fetched))
    check('  the model was reached once (' + label + ')', state.models === 1)
    check('  and the absent OUTBOUND collection is reported, by folder (' + label + ')',
      r.missingHeaders && r.missingHeaders.sentitems === 1 && !('inbox' in r.missingHeaders),
      JSON.stringify(r.missingHeaders))
  }
}

{
  // FAILS CLOSED. Missing counterparty evidence is still terminal, and an absent
  // collection is never read as clean.
  for (const [label, spec, expect] of [
    ['inbound evidence missing', [IN_NO, OUT_OK], { inbox: 1 }],
    ['no headers anywhere', [IN_NO, OUT_NO], { inbox: 1, sentitems: 1 }],
  ]) {
    const { r, state } = await screen(spec)
    check('still automation_unverified when ' + label,
      r.outcome === 'defer' && r.reason === 'automation_unverified',
      JSON.stringify({ o: r.outcome, re: r.reason }))
    check('  nothing was sent to the provider (' + label + ')', state.models === 0)
    check('  and the counts name the folders (' + label + ')',
      JSON.stringify(r.missingHeaders) === JSON.stringify(expect),
      JSON.stringify(r.missingHeaders))
  }
}

{
  // A HUMAN TWO-SIDED CONTROL.
  const { r, state } = await screen([IN_OK, OUT_OK])
  check('a human two-sided exchange is proposed',
    r.outcome === 'new_contact_suggestion' && state.models === 1, JSON.stringify(r.outcome))
  check('  with no missing-header counts at all',
    JSON.stringify(r.missingHeaders) === '{}', JSON.stringify(r.missingHeaders))
}

{
  // MAILING LISTS AND AUTOMATED REPLIES are still caught, on the inbound headers.
  for (const [label, automation, expect] of [
    ['List-Id', { hasListId: true }, 'bulk_or_list_mail'],
    ['List-Unsubscribe', { hasListUnsubscribe: true }, 'bulk_or_list_mail'],
    ['Precedence: bulk', { precedence: 'bulk' }, 'bulk_or_list_mail'],
    ['Auto-Submitted', { autoSubmitted: 'auto-replied' }, 'automated_message'],
    ['X-Auto-Response-Suppress', { hasAutoResponseSuppress: true }, 'automated_message'],
  ]) {
    const { r, state } = await screen([{ folder: 'inbox', complete: true, automation }, OUT_OK])
    check('an inbound ' + label + ' is ignored as ' + expect,
      r.outcome === 'ignore' && r.reason === expect, JSON.stringify({ o: r.outcome, re: r.reason }))
    check('  and never reaches the provider (' + label + ')', state.models === 0)
  }
}

{
  // A PRESENT collection is still screened in BOTH directions - unchanged behaviour.
  // Only the COMPLETENESS requirement moved to inbound-only.
  const { r } = await screen([IN_OK, { folder: 'sentitems', complete: true,
    automation: { autoSubmitted: 'auto-generated' } }])
  check('an auto-submitted OUTBOUND message is still screened when its headers exist',
    r.outcome === 'ignore' && r.reason === 'automated_message',
    JSON.stringify({ o: r.outcome, re: r.reason }))
}

{
  // A TRACKED CONTACT never required headers, and still does not.
  const { state, params } = passParams({ spec: [IN_NO, OUT_NO], requiresScreening: false })
  const r = await summarizeConversation(params)
  check('a tracked contact is unaffected by a missing collection',
    r.outcome === 'interaction_draft' && state.models === 1,
    JSON.stringify({ o: r.outcome, re: r.reason }))
  check('  and the absence is still reported for both folders',
    r.missingHeaders.inbox === 1 && r.missingHeaders.sentitems === 1,
    JSON.stringify(r.missingHeaders))
}

check('the reported folders are the declared Graph folders',
  CONTENT_FOLDERS.length === 2 && CONTENT_FOLDERS.includes('inbox')
  && CONTENT_FOLDERS.includes('sentitems'))

// ===========================================================================
console.log('')
console.log('4. through the REAL handler: the diagnoses reach the HTTP report')

const addr = (e) => ({ emailAddress: { address: e, name: 'x' } })
const envelope = (id, conv, from, to, sent, subject) => ({
  id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
  subject, from: addr(from), sender: addr(from), toRecipients: to.map(addr), ccRecipients: [],
})
const M = {
  in1: envelope('AAkALgAAin-1', 'conv-a-7', THEM, [ME], '2026-09-20T09:00:00Z', 'Insight week'),
  out1: envelope('AAkALgAAout-1', 'conv-a-7', ME, [THEM], '2026-09-20T11:00:00Z', 'RE: Insight week'),
}
// The OUTBOUND message carries no header collection; the inbound one does.
const HEADERS_FOR = { 'AAkALgAAin-1': [{ name: 'Received', value: 'by fixture' }], 'AAkALgAAout-1': null }
const BODY_FOR = { 'AAkALgAAin-1': INBOUND_TEXT, 'AAkALgAAout-1': OUTBOUND_TEXT }

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

async function makePorts () {
  const key = await importKeyFromBase64(KEY_B64, subtle)
  const sealed = await encryptToken('fixture-access-token-not-a-secret', key, { subtle })
  const expires = new Date(Date.now() + 3600000).toISOString()
  const store = makeRoundStore()
  const handles = []
  const candidates = []
  const releases = []
  const select = async (path) => {
    if (path.startsWith('microsoft_connections?')) {
      return { data: [{ user_id: PILOT, ms_email: ME, scopes: ['Mail.Read', 'User.Read'],
        token_expires_at: expires, consent_policy_version: V }], error: null }
    }
    if (path.startsWith('contacts?')) {
      return { data: path.includes('offset=0')
        ? [{ id: CONTACT, user_id: PILOT, email: THEM }] : [], error: null }
    }
    if (path.startsWith('outlook_sync_state?')) return { data: [], error: null }
    if (path.startsWith('microsoft_tokens?')) {
      return { data: [{ access_token_ciphertext: sealed.ciphertext, access_token_nonce: sealed.nonce,
        refresh_token_ciphertext: sealed.ciphertext, refresh_token_nonce: sealed.nonce,
        key_version: 1, token_expires_at: expires }], error: null }
    }
    throw new Error('unexpected select: ' + path)
  }
  const rpc = async (name, args) => {
    if (name === 'reserve_due_outlook_connection') {
      return { data: { result: 'reserved', connection_id: CONN, user_id: PILOT, run_id: 'run-1' }, error: null }
    }
    if (name === 'renew_outlook_sync_lease') return { data: true, error: null }
    if (name === 'upsert_outlook_interaction_candidate' || name === 'upsert_new_contact_candidate') {
      candidates.push({ rpc: name, args }); return { data: { result: 'created' }, error: null }
    }
    if (name === 'release_outlook_sync_lease') {
      releases.push({ status: args && args.p_status, complete: args && args.p_run_complete })
      if (args && args.p_run_complete === true) store.commitRelease()
      return { data: true, error: null }
    }
    if (name === 'rotate_microsoft_access_token') throw new Error('no refresh may be attempted')
    if (name === 'record_outlook_page_progress') {
      for (const m of (args && args.p_messages) || []) handles.push(m)
    }
    if (name === 'list_outlook_round_message_handles') {
      const want = new Set((args && args.p_cfps) || [])
      return { data: { result: 'ok', next_cursor: null,
        handles: handles.filter((h) => want.has(h.cfp))
          .sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at))) }, error: null }
    }
    const s = await store.handle(name, args)
    if (s !== null) return s
    throw new Error('unexpected rpc: ' + name)
  }
  return { select, rpc, store, candidates, releases }
}

const PREFIX = GRAPH_BASE + '/me/messages/'
function messageId (u) {
  if (!u.startsWith(PREFIX)) return null
  const q = u.indexOf('?', PREFIX.length)
  return q < 0 ? null : decodeURIComponent(u.slice(PREFIX.length, q))
}

function makeFetch (counts, modelReply) {
  return async (url, init) => {
    const u = String(url)
    if (u === ANTHROPIC_MESSAGES_URL) {
      counts.model += 1
      counts.bodies_sent.push(String((init && init.body) || ''))
      return modelReply()
    }
    const id = messageId(u)
    if (id !== null) {
      counts.bodies += 1
      const hdrs = HEADERS_FOR[id]
      const base = Object.assign({}, M[Object.keys(M).find((k) => M[k].id === id)], {
        body: { contentType: 'text', content: BODY_FOR[id] },
        uniqueBody: { contentType: 'text', content: BODY_FOR[id] },
      })
      // ABSENT, not empty: the property is simply not returned for this message.
      if (hdrs !== null) base.internetMessageHeaders = hdrs
      return ok(base)
    }
    if (!u.startsWith(GRAPH_BASE)) throw new Error('the fixture refuses a non-Graph URL')
    counts.delta += 1
    const inbox = u.indexOf('/mailFolders/inbox/') >= 0
    return ok({ value: inbox ? [M.in1] : [M.out1],
      '@odata.deltaLink': GRAPH_BASE + '/me/mailFolders/'
        + (inbox ? 'inbox' : 'sentitems') + '/messages/delta?$deltatoken=D' })
  }
}

const FIXED = 1780000000000
async function runWorker (modelReply) {
  const ports = await makePorts()
  const counts = { delta: 0, bodies: 0, model: 0, bodies_sent: [] }
  const res = await handleOutlookImportWorker(workerReq(), env(), {
    tokenUrl: 'https://login.invalid/token', select: ports.select, rpc: ports.rpc,
    graphFetchImpl: makeFetch(counts, modelReply), now: () => FIXED, subtle,
  })
  return { res, body: await res.json(), ports, counts }
}

{
  // AN AUTHENTICATION REFUSAL, end to end. This is the shape the live report could not
  // distinguish from a timeout or a rate limit.
  const A = await runWorker(() => ok({ error: { type: 'authentication_error' } }, 401))
  const rep = A.body && A.body.run && A.body.run.content
  check('the run still defers as model_unavailable',
    rep && rep.deferred && rep.deferred.model_unavailable === 1, JSON.stringify(rep && rep.deferred))
  check('the HTTP report now names the failure', rep && rep.model_failures
    && rep.model_failures.provider_unauthorized === 1, JSON.stringify(rep && rep.model_failures))
  check('and carries the numeric status',
    rep && rep.model_http_status && rep.model_http_status['401'] === 1,
    JSON.stringify(rep && rep.model_http_status))
  check('the absent OUTBOUND header collection is reported by folder',
    rep && rep.missing_headers && rep.missing_headers.sentitems === 1
    && !('inbox' in rep.missing_headers), JSON.stringify(rep && rep.missing_headers))
  check('no candidate was written', A.ports.candidates.length === 0)
  check('a retryable deferral still leaves the round unfinished',
    A.body.run.finalize.complete === false && A.body.run.cursors_advanced === 0,
    JSON.stringify(A.body.run.finalize))
  // DIAGNOSTICS CARRY NOTHING ELSE.
  const s = JSON.stringify(A.body)
  for (const [label, needle] of [
    ['the API key', API_KEY], ['the mailbox address', ME], ['the counterparty address', THEM],
    ['a message body', INBOUND_TEXT.slice(0, 30)], ['a Graph id', M.in1.id],
    ['the connection id', CONN], ['a contact id', CONTACT], ['the worker secret', SECRET],
    ['an at sign', AT], ['a header name', 'Received'],
  ]) {
    check('the response body does not contain ' + label, s.indexOf(needle) < 0)
  }
}

{
  // THE SUCCESS CONTROL, same fixture: the screening fix lets it through and the model
  // answers. Before the fix this conversation deferred automation_unverified.
  const B = await runWorker(() => ok({
    content: [{ type: 'text', text: JSON.stringify({
      result: 'interaction_draft', summary: 'A short call next week was agreed.',
      summary_evidence: 'explicit_body', follow_up: null, interaction_date: null }) }],
    stop_reason: 'end_turn',
  }))
  const rep = B.body && B.body.run && B.body.run.content
  check('the conversation now succeeds and writes its note',
    rep && rep.notes_written === 1, JSON.stringify(rep))
  check('  with no automation_unverified deferral',
    rep && !('automation_unverified' in rep.deferred), JSON.stringify(rep.deferred))
  check('  no model failure recorded', JSON.stringify(rep.model_failures) === '{}',
    JSON.stringify(rep.model_failures))
  check('  no status recorded', JSON.stringify(rep.model_http_status) === '{}',
    JSON.stringify(rep.model_http_status))
  check('  the missing OUTBOUND collection is STILL reported on success',
    rep.missing_headers.sentitems === 1, JSON.stringify(rep.missing_headers))
  check('  the round committed and the cursors advanced',
    B.body.run.outcome === 'committed' && B.body.run.cursors_advanced === 2,
    JSON.stringify({ o: B.body.run.outcome, c: B.body.run.cursors_advanced }))
  check('  the request carried no address', B.counts.bodies_sent.every((b) => b.indexOf(AT) < 0))
  check('  the report holds only counters and the controlled maps',
    Object.keys(rep).every((k) => CONTENT_REPORT_COUNTS.includes(k)
      || CONTENT_REPORT_MAPS.includes(k)), JSON.stringify(Object.keys(rep)))
}

console.log('')
console.log((passed + failed) + ' checks: ' + passed + ' passed, ' + failed + ' failed')
console.log('')
if (failed > 0) process.exit(1)
