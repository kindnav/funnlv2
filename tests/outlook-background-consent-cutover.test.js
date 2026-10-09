// THE BACKGROUND-CONSENT CUTOVER, through the REAL run against fixture Microsoft and
// Anthropic answers.
//
// WHAT IS PROVEN HERE.
//
//   1. An UNCONFIGURED background requirement (null - today's value) authorizes nothing:
//      the run is released untouched, no subscription is requested, no delta page and no
//      body is read, nothing reaches the model, nothing is written.
//   2. A STALE background consent (the connection recorded an older notice than the
//      requirement names) is refused the same way.
//   3. A MATCHING, newly approved consent - the connection re-consented under the new
//      notice and ALL THREE requirements carry that version - permits unattended
//      operation, body reading and Anthropic processing together: the subscription is
//      created, both folders are read, every body is fetched, both conversations reach
//      the model, a note is written.
//   4. THE HAZARD THE OLD PLAN INSTRUCTED. Raising only the background requirement while
//      leaving the content and third-party requirements at the previous version: the
//      run proceeds (subscription, delta pages) but every body read and every model call
//      is refused, because each requirement is compared to the digest of the ENTIRE
//      notice. Reproduced here so the cutover rule is not a matter of opinion.
//
// WHAT IS NOT. No Microsoft, no Anthropic, no database. Every provider answer is a
// fixture in the documented shape. The database path for the gate's release is proven
// against a real Postgres by the SQL runtime proofs; the live facts are the activation
// plan's to establish.
//
// NO REAL IDENTIFIER, ADDRESS, MESSAGE OR KEY APPEARS IN THIS FILE.
//
// Run with: node tests/outlook-background-consent-cutover.test.js

import assert from 'node:assert'
import { webcrypto } from 'node:crypto'
import { runOutlookImport } from '../supabase/functions/shared/outlookImportRun.js'
import {
  makeRunContextLoader, makeCursorEncryptor, makeCursorDecryptor,
} from '../supabase/functions/shared/outlookRunContext.js'
import { importKeyFromBase64, encryptToken } from '../supabase/functions/shared/googleTokenCrypto.js'
import { GRAPH_BASE } from '../supabase/functions/shared/outlookGraphTransport.js'
import { ANTHROPIC_MESSAGES_URL } from '../supabase/functions/shared/outlookDraftContract.js'
import * as consent from '../supabase/functions/shared/outlookContentConsent.js'
import { makeRoundStore } from './harness/outlookRoundStore.js'

let passed = 0
let failed = 0
async function test (name, fn) {
  try { await fn(); console.log('  OK   ' + name); passed += 1 } catch (e) {
    console.error('  FAIL ' + name); console.error('       ' + (e && e.message ? e.message : String(e))); failed += 1
  }
}

const subtle = webcrypto.subtle
const FIXED = 1780000000000                       // a frozen clock, so the budget admits everything
const KEY_B64 = Buffer.alloc(32, 5).toString('base64')
const CONN = '11111111-1111-1111-1111-111111111111'
const PILOT = '22222222-2222-2222-2222-222222222222'
const CONTACT_A = '33333333-3333-3333-3333-333333333333'
const CONTACT_B = '44444444-4444-4444-4444-444444444444'
const ME = 'pilot@outlook.test'
const PARTY_A = 'ava@bank.test'
const PARTY_B = 'ben@fund.test'
const TOKEN = 'fixture-access-token-not-a-secret'
const URL_N = 'https://project.supabase.test/functions/v1/outlook-notifications'
const SUBS = GRAPH_BASE + '/subscriptions'
const API_KEY = 'sk-ant-fixture-not-a-real-key'

// The versions. OLD is whatever the module requires for content today (the version the
// current pilot connection recorded). NEW stands for the version the approved background
// wording would derive to - invented here, never configured anywhere.
const OLD = consent.REQUIRED_CONTENT_CONSENT_VERSION
const NEW = 'ol-disc-' + 'b'.repeat(32)
assert.notStrictEqual(OLD, NEW)

// Two two-sided conversations with bodies free of any address.
const MSG_A_IN = 'AAkALgAAfixture-a-in-1'
const MSG_A_OUT = 'AAkALgAAfixture-a-out-1'
const MSG_B_IN = 'AAkALgAAfixture-b-in-1'
const MSG_B_OUT = 'AAkALgAAfixture-b-out-1'
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

const addr = (e) => ({ emailAddress: { address: e, name: 'x' } })
const envelope = (id, conv, from, to, sent, subject) => ({
  id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
  subject, from: addr(from), sender: addr(from), toRecipients: to.map(addr), ccRecipients: [],
})
const ENVELOPES = {
  [MSG_A_IN]: envelope(MSG_A_IN, 'conv-a', PARTY_A, [ME], '2026-09-21T14:00:00Z', 'Insight week'),
  [MSG_A_OUT]: envelope(MSG_A_OUT, 'conv-a', ME, [PARTY_A], '2026-09-21T16:00:00Z', 'RE: Insight week'),
  [MSG_B_IN]: envelope(MSG_B_IN, 'conv-b', PARTY_B, [ME], '2026-09-22T10:00:00Z', 'Growth fund'),
  [MSG_B_OUT]: envelope(MSG_B_OUT, 'conv-b', ME, [PARTY_B], '2026-09-22T11:00:00Z', 'RE: Growth fund'),
}
const BODIES = { [MSG_A_IN]: BODY_A_IN, [MSG_A_OUT]: BODY_A_OUT, [MSG_B_IN]: BODY_B_IN, [MSG_B_OUT]: BODY_B_OUT }
const INBOX_PAGE = [ENVELOPES[MSG_A_IN], ENVELOPES[MSG_B_IN]]
const SENT_PAGE = [ENVELOPES[MSG_A_OUT], ENVELOPES[MSG_B_OUT]]
const okRes = (status, body) => ({ status, headers: { get: () => null }, json: async () => body })

const MESSAGES_PREFIX = GRAPH_BASE + '/me/messages/'
function contentMessageId (u) {
  if (!u.startsWith(MESSAGES_PREFIX)) return null
  const q = u.indexOf('?', MESSAGES_PREFIX.length)
  return q < 0 ? null : decodeURIComponent(u.slice(MESSAGES_PREFIX.length, q))
}

/** One fixture fetch for every surface: subscriptions, delta pages, bodies, the model. */
function makeFetch () {
  const counts = { subsPost: 0, delta: 0, bodies: 0, model: 0, other: 0 }
  const fetchImpl = async (url, init) => {
    const u = String(url)
    const method = (init && init.method) || 'GET'
    if (u === SUBS && method === 'POST') {
      counts.subsPost += 1
      const body = JSON.parse(init.body)
      return okRes(201, { id: 'sub-1', resource: body.resource, changeType: body.changeType,
        clientState: body.clientState, notificationUrl: body.notificationUrl, expirationDateTime: body.expirationDateTime })
    }
    if (u === ANTHROPIC_MESSAGES_URL) {
      counts.model += 1
      const sent = String((init && init.body) || '')
      const payload = sent.indexOf('insight week') >= 0
        ? { result: 'interaction_draft', summary: DRAFT_SUMMARY, summary_evidence: 'explicit_body',
            follow_up: 'Send your insight-week availability.', interaction_date: null }
        : { result: 'defer' }
      return okRes(200, { id: 'msg_fixture', type: 'message', role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(payload) }], usage: { input_tokens: 10, output_tokens: 5 } })
    }
    const id = contentMessageId(u)
    if (id !== null) {
      counts.bodies += 1
      const env_ = ENVELOPES[id]
      if (!env_) return okRes(404, {})
      return okRes(200, Object.assign({}, env_, {
        body: { contentType: 'text', content: BODIES[id] }, uniqueBody: { contentType: 'text', content: BODIES[id] },
        internetMessageHeaders: [{ name: 'Received', value: 'by fixture' }],
      }))
    }
    if (!u.startsWith(GRAPH_BASE)) throw new Error('the fixture refuses a non-Graph URL: ' + u.slice(0, 60))
    counts.delta += 1
    const inbox = u.indexOf('/mailFolders/inbox/') >= 0
    return okRes(200, { value: inbox ? INBOX_PAGE : SENT_PAGE,
      '@odata.deltaLink': GRAPH_BASE + '/me/mailFolders/' + (inbox ? 'inbox' : 'sentitems') + '/messages/delta?$deltatoken=D' })
  }
  return { fetchImpl, counts }
}

/** PostgREST + RPC ports: the round store, sealed handles served back, candidates and releases recorded. */
async function makePorts (storedVersion) {
  const key = await importKeyFromBase64(KEY_B64, subtle)
  const sealed = await encryptToken(TOKEN, key, { subtle })
  const expires = new Date(Date.now() + 3600000).toISOString()
  const store = makeRoundStore()
  const handles = []
  const state = { candidates: [], releases: [], subscriptionRow: null, recorded: [] }
  const select = async (path) => {
    if (path.startsWith('microsoft_connections?')) {
      return { data: [{ user_id: PILOT, ms_email: ME, scopes: ['Mail.Read', 'User.Read'], token_expires_at: expires,
        consent_policy_version: storedVersion }], error: null }
    }
    if (path.startsWith('contacts?')) {
      return { data: path.includes('offset=0')
        ? [{ id: CONTACT_A, user_id: PILOT, email: PARTY_A }, { id: CONTACT_B, user_id: PILOT, email: PARTY_B }] : [], error: null }
    }
    if (path.startsWith('outlook_sync_state?')) return { data: [], error: null }
    if (path.startsWith('outlook_subscriptions?')) return { data: state.subscriptionRow ? [state.subscriptionRow] : [], error: null }
    if (path.startsWith('microsoft_tokens?')) {
      return { data: [{ access_token_ciphertext: sealed.ciphertext, access_token_nonce: sealed.nonce,
        refresh_token_ciphertext: sealed.ciphertext, refresh_token_nonce: sealed.nonce, key_version: 1, token_expires_at: expires }], error: null }
    }
    throw new Error('unexpected select: ' + path)
  }
  const rpc = async (name, args) => {
    if (name === 'reserve_due_outlook_connection') {
      return { data: { result: 'reserved', connection_id: CONN, user_id: PILOT, run_id: 'run-1' }, error: null }
    }
    if (name === 'renew_outlook_sync_lease') return { data: true, error: null }
    if (name === 'record_outlook_subscription_state') {
      state.recorded.push(args)
      state.subscriptionRow = { subscription_id: args.p_subscription_id, status: args.p_status, expires_at: args.p_expires_at, client_state_hash: args.p_client_state_hash }
      return { data: { result: 'recorded' }, error: null }
    }
    if (name === 'upsert_outlook_interaction_candidate' || name === 'upsert_new_contact_candidate') {
      state.candidates.push({ rpc: name })
      return { data: { result: 'created' }, error: null }
    }
    if (name === 'release_outlook_sync_lease') {
      state.releases.push({ status: args.p_status, complete: args.p_run_complete, reason: args.p_error_code ?? null })
      if (args.p_run_complete === true) store.commitRelease()
      return { data: true, error: null }
    }
    if (name === 'rotate_microsoft_access_token') throw new Error('no refresh may be attempted: the fixture token is fresh')
    if (name === 'record_outlook_page_progress') for (const m of (args && args.p_messages) || []) handles.push(m)
    if (name === 'list_outlook_round_message_handles') {
      const want = new Set((args && args.p_cfps) || [])
      const mine = handles.filter((h) => want.has(h.cfp)).sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)))
      return { data: { result: 'ok', handles: mine, next_cursor: null }, error: null }
    }
    const s = await store.handle(name, args)
    if (s !== null) return s
    throw new Error('unexpected rpc: ' + name)
  }
  return { select, rpc, state }
}

/** The real run, with the three requirements injected the way the handler's test seam does. */
async function run ({ stored, background, content, thirdParty }) {
  const ports = await makePorts(stored)
  const graph = makeFetch()
  const config = { clientId: 'c', clientSecret: 'cs', tokenUrl: 'https://login.invalid/token', tokenKeyB64: KEY_B64, keyVersion: 1,
    keyRing: { current: { keyBytes: new Uint8Array(32).fill(1), keyVersion: 1 } }, scope: 'openid profile email offline_access Mail.Read User.Read' }
  const result = await runOutlookImport({
    rpc: ports.rpc, select: ports.select, pilotUserId: PILOT, requestEntryMs: FIXED,
    encryptCursor: makeCursorEncryptor({ tokenKeyB64: KEY_B64, keyVersion: 1, subtle }),
    decryptCursor: makeCursorDecryptor({ tokenKeyB64: KEY_B64, subtle }),
    loadRunContext: makeRunContextLoader({ select: ports.select, rpc: ports.rpc, config, deps: { subtle, now: () => FIXED } }),
    subscriptions: { notificationUrl: URL_N }, deps: { fetchImpl: graph.fetchImpl, now: () => FIXED },
    anthropicApiKey: API_KEY,
    requiredConsent: { content, thirdParty },
    requiredBackgroundConsent: background,
  })
  return { result, counts: graph.counts, state: ports.state }
}

const nothingHappened = (r, label) => {
  assert.deepStrictEqual(r.counts, { subsPost: 0, delta: 0, bodies: 0, model: 0, other: 0 }, label + ': no Graph or model request at all')
  assert.strictEqual(r.state.recorded.length, 0, label + ': no subscription recorded')
  assert.strictEqual(r.state.candidates.length, 0, label + ': nothing written')
  assert.deepStrictEqual(r.state.releases.map((x) => ({ status: x.status, complete: x.complete })), [{ status: 'idle', complete: false }], label + ': released untouched, incomplete, with the backoff')
}

console.log('')
console.log('the pure gate: closed while unconfigured, closed to stale or missing consent, open only to the exact version')
await test('an unconfigured requirement (null, undefined, malformed) authorizes nothing', () => {
  assert.strictEqual(consent.REQUIRED_BACKGROUND_CONSENT_VERSION, null, 'nothing is configured before the wording is approved')
  for (const bad of [null, undefined, '', 'not-a-version', 'OL-DISC-' + 'a'.repeat(32)]) {
    const r = consent.backgroundOperationAllowed(OLD, bad)
    assert.strictEqual(r.ok, false, JSON.stringify(bad))
    assert.strictEqual(r.reason, 'background_consent_not_configured', JSON.stringify(bad))
  }
  assert.deepStrictEqual(consent.backgroundOperationAllowed(OLD), { ok: false, reason: 'background_consent_not_configured' }, 'the module default is the unconfigured value')
})
await test('a configured requirement admits exactly its own version and refuses everything else', () => {
  assert.deepStrictEqual(consent.backgroundOperationAllowed(NEW, NEW), { ok: true, reason: 'consented' })
  assert.deepStrictEqual(consent.backgroundOperationAllowed(' ' + NEW + ' ', NEW), { ok: true, reason: 'consented' }, 'surrounding whitespace is not a different version')
  for (const stored of [OLD, null, undefined, '', 'ol-disc-' + 'c'.repeat(32), NEW.toUpperCase()]) {
    assert.deepStrictEqual(consent.backgroundOperationAllowed(stored, NEW), { ok: false, reason: 'background_consent_missing' }, JSON.stringify(stored))
  }
  assert.deepStrictEqual([...consent.BACKGROUND_CONSENT_CODES], ['background_consent_not_configured', 'background_consent_missing'])
})

console.log('')
console.log('through the real run: what each consent state permits')
await test('UNCONFIGURED background requirement: no subscription, no delta read, no body, no model call, nothing written', async () => {
  const r = await run({ stored: OLD, background: null, content: OLD, thirdParty: OLD })
  assert.strictEqual(r.result.outcome, 'consent_missing', JSON.stringify(r.result))
  assert.strictEqual(r.result.reason, 'background_consent_not_configured')
  nothingHappened(r, 'unconfigured')
  assert.strictEqual(r.state.releases[0].reason, 'background_consent_not_configured', 'the release carries the controlled reason')
})
await test('STALE background consent (connection on the old notice, requirement on the new): refused the same way', async () => {
  const r = await run({ stored: OLD, background: NEW, content: NEW, thirdParty: NEW })
  assert.strictEqual(r.result.outcome, 'consent_missing', JSON.stringify(r.result))
  assert.strictEqual(r.result.reason, 'background_consent_missing')
  nothingHappened(r, 'stale')
})
await test('MISSING consent (connection recorded no version): refused the same way', async () => {
  const r = await run({ stored: null, background: NEW, content: NEW, thirdParty: NEW })
  assert.strictEqual(r.result.outcome, 'consent_missing')
  assert.strictEqual(r.result.reason, 'background_consent_missing')
  nothingHappened(r, 'missing')
})
await test('MATCHING newly approved consent across all three requirements: subscription + folders + bodies + model + a note, together', async () => {
  const r = await run({ stored: NEW, background: NEW, content: NEW, thirdParty: NEW })
  assert.strictEqual(r.result.outcome, 'committed', JSON.stringify(r.result))
  assert.strictEqual(r.counts.subsPost, 1, 'the subscription is created under the lease')
  assert.strictEqual(r.state.recorded[0].p_status, 'active')
  assert.strictEqual(r.counts.delta, 2, 'both folders read')
  assert.strictEqual(r.counts.bodies, 4, 'every body of both two-sided conversations fetched')
  assert.strictEqual(r.counts.model, 2, 'both conversations reached the model')
  assert.strictEqual(r.result.content.bodies_read, 4)
  assert.strictEqual(r.result.content.model_calls, 2)
  assert.strictEqual(r.result.content.notes_written, 1, 'the drafted conversation became a note')
  assert.strictEqual(r.result.content.metadata_only, 0, 'no envelope-only row on the content release')
  assert.ok(r.state.candidates.length >= 1, 'a proposal was written')
  assert.deepStrictEqual(r.state.releases.map((x) => x.complete), [true], 'the round completed')
})
await test('THE HAZARD the old plan instructed: background raised alone, content and third-party left at the old version', async () => {
  // The account reconnected under the new notice (NEW recorded). The background gate opens,
  // so the run subscribes and reads folders - but both content gates compare the same stored
  // version to the OLD digest, so no body is read and nothing reaches the model.
  const r = await run({ stored: NEW, background: NEW, content: OLD, thirdParty: OLD })
  assert.strictEqual(r.result.outcome, 'committed', JSON.stringify(r.result))
  assert.strictEqual(r.counts.subsPost, 1, 'unattended operation was authorized...')
  assert.strictEqual(r.counts.delta, 2, '...and folders were read...')
  assert.strictEqual(r.counts.bodies, 0, '...but NO body may be read')
  assert.strictEqual(r.counts.model, 0, 'and NOTHING reaches Anthropic')
  assert.strictEqual(r.result.content.notes_written, 0)
  assert.ok(r.result.content.metadata_only >= 1, 'the exchanges fall back to envelope-only rows: ' + JSON.stringify(r.result.content))
  // The same holds for any one of the two content requirements left behind.
  const third = await run({ stored: NEW, background: NEW, content: NEW, thirdParty: OLD })
  assert.strictEqual(third.counts.bodies, 0, 'body and third-party must BOTH match for the model path')
  assert.strictEqual(third.counts.model, 0)
})
await test('and the current module constants agree: the two content requirements carry one value today, which the cutover moves together', () => {
  assert.strictEqual(consent.REQUIRED_CONTENT_CONSENT_VERSION, consent.REQUIRED_THIRD_PARTY_CONSENT_VERSION)
  assert.ok(consent.isDisclosureVersion(consent.REQUIRED_CONTENT_CONSENT_VERSION))
})

console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exit(1)
