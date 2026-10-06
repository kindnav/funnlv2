// FIVE FOCUSED CORRECTIONS, each with the defect it replaced reproduced first.
//
// Every test here names a specific behaviour that was wrong and asserts the fix.
// Where the old behaviour is still correct for a different caller - the
// envelope-only pilot - that is asserted too, so the fix cannot be read as a
// blanket change.
//
// WHAT IS EXECUTED: the real producer, the real fold, the real content pass with the
// real automation classifiers, the real write planner, and the real provider
// transports driven by local fixture fetches. No network, no database, no browser.
//
// NO REAL IDENTIFIER, ADDRESS OR MESSAGE APPEARS IN THIS FILE.
//
// Run with: node tests/outlook-content-corrections.test.js

import assert from 'node:assert'
import {
  buildMessageHandles, summarizeProducer, HANDLE_FAILURES,
  MAX_HANDLE_CIPHERTEXT_CHARS,
} from '../supabase/functions/shared/outlookHandleProducer.js'
import { foldPage } from '../supabase/functions/shared/outlookRoundState.js'
import {
  summarizeConversation, DEFER_REASONS, IGNORE_REASONS,
} from '../supabase/functions/shared/outlookContentPass.js'
import {
  planContentWrite, TERMINAL_DEFERRALS, RETRYABLE_DEFERRALS,
} from '../supabase/functions/shared/outlookContentStage.js'
import {
  callDraftModel, DRAFT_TIMEOUT_MS, MAX_DRAFT_RESPONSE_BYTES, buildDraftRequest,
} from '../supabase/functions/shared/outlookDraftContract.js'
import {
  executeGraphRequest, buildMessageContentRequest, MAX_RESPONSE_BYTES,
} from '../supabase/functions/shared/outlookGraphTransport.js'

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

// ── fixtures ────────────────────────────────────────────────────────────────
const APPROVED = 'ol-disc-' + 'a'.repeat(32)
const ENVELOPE_ONLY = 'ol-disc-' + '0'.repeat(32)
const BOTH = { content: APPROVED, thirdParty: APPROVED }
const CFP = 'c'.repeat(64)
const ME = 'pilot@outlook.test'
const THEM = 'priya@fund.test'
const CONTACT_ID = '33333333-3333-3333-3333-333333333333'
const CONN = '22222222-2222-2222-2222-222222222222'

const seal = async (plain) => ({ ciphertext: 'SEAL:' + plain, nonce: 'N1', keyVersion: 1 })
const unseal = async ({ ciphertext }) => String(ciphertext).replace(/^SEAL:/, '')
const addr = (a, n) => ({ address: a, name: n })

const BODY_IN =
  'Great to meet you at the panel. I have put your name forward for the spring '
  + 'insight week and the team would like a short call next week about credit.'
const BODY_OUT =
  'Thank you - next week works. I will prepare questions about the credit desk '
  + 'and send my availability.'

/** A fetched message in the shape the pass's port must supply. */
function msg ({ dir, text = BODY_IN, automation = {}, automationComplete = true,
  subject = 'Following up after the panel', from } = {}) {
  return {
    ok: true,
    message: {
      bodyContent: text,
      uniqueBodyContent: text,
      automation,
      automationComplete,
      subject,
      from: from ?? (dir === 'inbound' ? addr(THEM, 'Priya Nair') : addr(ME, 'Pilot')),
      toRecipients: dir === 'inbound' ? [addr(ME, 'Pilot')] : [addr(THEM, 'Priya Nair')],
    },
  }
}

function handlesFor (n = 2) {
  return Array.from({ length: n }, (_, i) => ({
    mfp: String(i + 1).padStart(64, '0'),
    folder: i % 2 === 0 ? 'inbox' : 'sentitems',
    sentAt: `2026-09-2${i + 1}T10:00:00.000Z`,
    midCt: 'SEAL:AAkALgAAmsg' + (i + 1),
    midNonce: 'N1',
  }))
}

const draftReply = (over = {}) => ({
  ok: true,
  parsed: {
    result: 'interaction_draft',
    summary: 'She put your name forward for the spring insight week and wants a short '
      + 'call about the credit desk.',
    summary_evidence: 'explicit_body',
    follow_up: 'Send your insight-week availability.',
    interaction_date: '2026-09-22',
    ...over,
  },
})

const nccReply = (over = {}) => ({
  ok: true,
  parsed: {
    result: 'new_contact_suggestion',
    name: 'Priya Nair', name_evidence: 'explicit_signature', name_confidence: 'high',
    company: null, company_evidence: null, company_confidence: null,
    role: null, role_evidence: null, role_confidence: null,
    how_met: null, how_met_evidence: null, how_met_confidence: null,
    linkedin_url: null, linkedin_url_evidence: null, linkedin_url_confidence: null,
    tags: [],
    summary: 'She put your name forward for the spring insight week.',
    summary_evidence: 'explicit_body',
    follow_up: 'Send your availability.',
    interaction_date: '2026-09-22',
    ...over,
  },
})

function pass (over = {}) {
  const calls = { fetched: [], model: 0 }
  const base = {
    conversation: { cfp: CFP, contactId: CONTACT_ID, messageCount: 2, lastLocalDate: '2026-09-22' },
    consentVersion: APPROVED,
    requiredConsent: BOTH,
    handles: handlesFor(2),
    decryptHandle: unseal,
    fetchMessage: async (id) => {
      calls.fetched.push(id)
      return id.endsWith('1') ? msg({ dir: 'inbound' }) : msg({ dir: 'outbound', text: BODY_OUT })
    },
    callModel: async () => { calls.model += 1; return draftReply() },
    apiKey: 'sk-ant-fixture-not-a-real-key',
    selfAddresses: [ME],
    budgetAllows: () => true,
  }
  return { calls, params: { ...base, ...over } }
}

const planEntry = (over = {}) => ({
  kind: 'known_contact_interaction',
  contactId: CONTACT_ID,
  proposedType: 'Email',
  proposedDate: '2026-09-22',
  messageCount: 2,
  episodeFingerprint: 'e'.repeat(64),
  episodeLookupFingerprints: [],
  personFingerprint: 'f'.repeat(64),
  keyVersion: 1,
  requiresContent: false,
  ...over,
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('1. a failed REQUIRED handle fails the page')

const selectedTwo = [
  { cfp: CFP, mfp: '1'.repeat(64), messageId: 'AAkALgAAone', folder: 'inbox',
    sentAtIso: '2026-09-21T10:00:00Z' },
  { cfp: CFP, mfp: '2'.repeat(64), messageId: 'AAkALgAAtwo', folder: 'sentitems',
    sentAtIso: '2026-09-22T10:00:00Z' },
]

test('REPRODUCED: the SECOND encryption failing returns NO partial array', async () => {
  // The defect: the failure was counted and skipped, and a one-element array came
  // back that the caller checkpointed - committing a resume position past an exchange
  // that could no longer be summarized in full.
  let n = 0
  const out = await buildMessageHandles({
    consentVersion: APPROVED, requiredConsent: BOTH, selected: selectedTwo,
    seal: async (x) => { n += 1; if (n === 2) throw new Error('kms unavailable'); return seal(x) },
  })
  assert.strictEqual(out.failure, 'seal_failed', JSON.stringify(out))
  assert.deepStrictEqual(out.handles, [], 'NOT a partial array of one')
  assert.strictEqual(out.skipped.seal_failed, 1)
  assert.ok(HANDLE_FAILURES.includes(out.failure))
})

test('a sealed id too large for the column is the same kind of failure', async () => {
  let n = 0
  const out = await buildMessageHandles({
    consentVersion: APPROVED, requiredConsent: BOTH, selected: selectedTwo,
    seal: async (x) => {
      n += 1
      return n === 2
        ? { ciphertext: 'Z'.repeat(MAX_HANDLE_CIPHERTEXT_CHARS + 1), nonce: 'N', keyVersion: 1 }
        : seal(x)
    },
  })
  assert.strictEqual(out.failure, 'ciphertext_too_large')
  assert.deepStrictEqual(out.handles, [])
})

test('a MALFORMED selection is still a per-item skip, NOT a page failure', async () => {
  // The distinction that matters: a message that failed its own shape checks was
  // never a retrieval candidate, so the page has lost nothing by omitting it.
  const out = await buildMessageHandles({
    consentVersion: APPROVED, requiredConsent: BOTH, seal,
    selected: [selectedTwo[0], { cfp: CFP, mfp: 'not-hex', messageId: 'AAkALgAAx',
      folder: 'inbox', sentAtIso: '2026-09-21T10:00:00Z' }],
  })
  assert.strictEqual(out.failure, null, 'a malformed item must not fail the page')
  assert.strictEqual(out.handles.length, 1)
})

test('with consent OFF a seal failure cannot even arise, and nothing fails', async () => {
  let sealed = 0
  const out = await buildMessageHandles({
    consentVersion: ENVELOPE_ONLY, selected: selectedTwo,
    seal: async () => { sealed += 1; throw new Error('should never be called') },
  })
  assert.strictEqual(out.failure, null, 'the envelope-only page must still checkpoint')
  assert.strictEqual(out.reason, 'content_consent_missing')
  assert.strictEqual(sealed, 0)
})

test('the fold propagates handleFailure, so the caller can refuse the page', async () => {
  let n = 0
  const entries = [
    { message: {
      provider: 'outlook', providerMessageKey: 'AAkALgAAone', providerConversationKey: 'conv-1',
      timestampIso: '2026-09-21T10:00:00Z', fromAddress: THEM, toAddresses: [ME],
      ccAddresses: [], subject: 'Panel', automation: {}, folderHint: 'inbox',
    }, extra: { displayNames: {}, automationFactsComplete: true, folder: 'inbox' } },
    { message: {
      provider: 'outlook', providerMessageKey: 'AAkALgAAtwo', providerConversationKey: 'conv-1',
      timestampIso: '2026-09-22T10:00:00Z', fromAddress: ME, toAddresses: [THEM],
      ccAddresses: [], subject: 'RE: Panel', automation: {}, folderHint: 'sent',
    }, extra: { displayNames: {}, automationFactsComplete: true, folder: 'sentitems' } },
  ]
  const folded = await foldPage({
    entries,
    selfSet: new Set([ME]),
    contactIndex: new Map([[THEM, CONTACT_ID]]),
    connectionId: CONN,
    keyRing: { current: { keyBytes: new Uint8Array(32).fill(7), keyVersion: 1 } },
    deps: {
      produceHandles: (selected) => buildMessageHandles({
        selected, consentVersion: APPROVED, requiredConsent: BOTH,
        seal: async (x) => { n += 1; if (n === 2) throw new Error('kms'); return seal(x) },
      }),
    },
  })
  assert.strictEqual(folded.handleFailure, 'seal_failed', JSON.stringify(folded.handles))
  assert.deepStrictEqual(folded.messages, [], 'and no partial handle array reaches the checkpoint')
  // The fold's own work is intact - the refusal is the caller's decision to make.
  assert.strictEqual(folded.contributions.length, 1)
})

test('A SUCCESSFUL RETRY RETAINS BOTH MESSAGES', async () => {
  // The same page, re-read after the transient failure clears.
  const out = await buildMessageHandles({
    consentVersion: APPROVED, requiredConsent: BOTH, selected: selectedTwo, seal,
  })
  assert.strictEqual(out.failure, null)
  assert.strictEqual(out.handles.length, 2, 'both messages, not one')
  assert.deepStrictEqual(out.handles.map((h) => h.mfp).sort(),
    ['1'.repeat(64), '2'.repeat(64)])
  assert.deepStrictEqual(out.handles.map((h) => h.folder).sort(), ['inbox', 'sentitems'])
})

test('the logged producer summary names the failure, and still leaks nothing', async () => {
  let n = 0
  const out = await buildMessageHandles({
    consentVersion: APPROVED, requiredConsent: BOTH, selected: selectedTwo,
    seal: async (x) => { n += 1; if (n === 2) throw new Error('kms'); return seal(x) },
  })
  const log = JSON.stringify(summarizeProducer(out))
  assert.ok(log.includes('"failure":"seal_failed"'), log)
  assert.ok(!log.includes('AAkALgAA'), 'no message id')
  assert.ok(!log.includes('SEAL:'), 'no ciphertext')
  assert.ok(!log.includes('kms'), 'and not the thrown message')
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('2. automation screening finishes before an unknown person is proposed')

test('REPRODUCED: missing headers used to reach the model and return a proposal', async () => {
  // automationComplete=false means the header collection was never returned, so
  // NOTHING has been screened. The taint that sent this conversation to the content
  // stage exists precisely because those headers had not been read.
  const { calls, params } = pass({
    conversation: { cfp: CFP, contactId: null, messageCount: 2, lastLocalDate: '2026-09-22' },
    requiresScreening: true,
    fetchMessage: async (id) => {
      calls.fetched.push(id)
      return msg({ dir: id.endsWith('1') ? 'inbound' : 'outbound', automationComplete: false })
    },
    callModel: async () => { calls.model += 1; return nccReply() },
  })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.outcome, 'defer', JSON.stringify(r))
  assert.strictEqual(r.reason, 'automation_unverified')
  assert.strictEqual(calls.model, 0, 'NOT ONE model call')
  assert.strictEqual(r.proposedEmail, undefined, 'and no proposal of any kind')
})

test('a KNOWN contact is unaffected by missing headers', async () => {
  // The envelope pass accepted this exchange on its own rules and chose not to
  // require headers for an address the user already tracks. That is not revisited.
  const { calls, params } = pass({
    fetchMessage: async (id) => msg({
      dir: id.endsWith('1') ? 'inbound' : 'outbound',
      text: id.endsWith('1') ? BODY_IN : BODY_OUT,
      automationComplete: false,
    }),
  })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.outcome, 'interaction_draft', JSON.stringify(r))
  assert.strictEqual(calls.model, 1)
})

test('AN AUTOMATIC REPLY is ignored, via Auto-Submitted', async () => {
  for (const value of ['auto-replied', 'auto-generated', 'other']) {
    const { calls, params } = pass({
      conversation: { cfp: CFP, contactId: null, messageCount: 2, lastLocalDate: '2026-09-22' },
      requiresScreening: true,
      fetchMessage: async (id) => msg({
        dir: id.endsWith('1') ? 'inbound' : 'outbound',
        automation: { autoSubmitted: value },
      }),
      callModel: async () => { calls.model += 1; return nccReply() },
    })
    const r = await summarizeConversation(params)
    assert.strictEqual(r.outcome, 'ignore', `${value}: ${JSON.stringify(r)}`)
    assert.strictEqual(r.reason, 'automated_message')
    assert.strictEqual(calls.model, 0, `${value} reached the model`)
  }
})

test('Auto-Submitted: no does NOT suppress a real exchange', async () => {
  const { params } = pass({
    fetchMessage: async (id) => msg({
      dir: id.endsWith('1') ? 'inbound' : 'outbound',
      text: id.endsWith('1') ? BODY_IN : BODY_OUT,
      automation: { autoSubmitted: 'no' },
    }),
  })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.outcome, 'interaction_draft', JSON.stringify(r))
})

test('X-Auto-Response-Suppress is ignored too', async () => {
  const { calls, params } = pass({
    fetchMessage: async (id) => msg({
      dir: id.endsWith('1') ? 'inbound' : 'outbound',
      automation: { hasAutoResponseSuppress: true },
    }),
    callModel: async () => { calls.model += 1; return draftReply() },
  })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.reason, 'automated_message', JSON.stringify(r))
  assert.strictEqual(calls.model, 0)
})

test('the other classifiers the inline check used to miss all fire', async () => {
  const cases = [
    ['a no-reply sender', { from: addr('no-reply@fund.test', 'Alerts') }, 'automated_message'],
    ['a bounce domain', { from: addr('x@bounces.fund.test', 'MAILER') }, 'automated_message'],
    ['an out-of-office subject', { subject: 'Automatic reply: away from my desk' }, 'automated_message'],
    ['a delivery failure', { subject: 'Undeliverable: your message' }, 'automated_message'],
    ['a calendar notification', { subject: 'Invitation: coffee chat' }, 'automated_message'],
    ['a List-Id header', { automation: { hasListId: true } }, 'bulk_or_list_mail'],
    ['List-Unsubscribe', { automation: { hasListUnsubscribe: true } }, 'bulk_or_list_mail'],
    ['Precedence: junk', { automation: { precedence: 'junk' } }, 'bulk_or_list_mail'],
  ]
  for (const [label, over, expected] of cases) {
    const { calls, params } = pass({
      fetchMessage: async (id) => msg({ dir: id.endsWith('1') ? 'inbound' : 'outbound', ...over }),
      callModel: async () => { calls.model += 1; return draftReply() },
    })
    const r = await summarizeConversation(params)
    assert.strictEqual(r.outcome, 'ignore', `${label}: ${JSON.stringify(r)}`)
    assert.strictEqual(r.reason, expected, label)
    assert.strictEqual(calls.model, 0, `${label} reached the model`)
  }
})

test('POSITIVE CONTROL: a complete, human, two-sided exchange still proposes', async () => {
  const { calls, params } = pass({
    conversation: { cfp: CFP, contactId: null, messageCount: 2, lastLocalDate: '2026-09-22' },
    requiresScreening: true,
    fetchMessage: async (id) => msg({
      dir: id.endsWith('1') ? 'inbound' : 'outbound',
      text: id.endsWith('1') ? BODY_IN : BODY_OUT,
      // The collection WAS returned, and it is clean.
      automationComplete: true,
      automation: { autoSubmitted: null, precedence: null, hasListId: false,
        hasListUnsubscribe: false, hasAutoResponseSuppress: false },
    }),
    callModel: async () => { calls.model += 1; return nccReply() },
  })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.outcome, 'new_contact_suggestion', JSON.stringify(r))
  assert.strictEqual(r.proposedEmail, THEM)
  assert.strictEqual(calls.model, 1)
  assert.ok(/insight week/i.test(r.summary))
})

test('both new reasons are in their declared vocabularies', () => {
  assert.ok(DEFER_REASONS.includes('automation_unverified'))
  assert.ok(IGNORE_REASONS.includes('automated_message'))
  assert.ok(TERMINAL_DEFERRALS.includes('automation_unverified'))
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('3. no empty-note fallback on the content release')

test('REPRODUCED: three codes used to become a noteless suggestion', () => {
  // model_output_invalid, minimization_failed and summary_key_absent all mapped to
  // interaction_metadata with p_proposed_notes=null - the exact experience the
  // content release exists to replace.
  for (const reason of ['model_output_invalid', 'minimization_failed', 'summary_key_absent']) {
    const plan = planContentWrite(planEntry(), { outcome: 'defer', reason },
      { consentOpen: true })
    assert.strictEqual(plan.write, 'none', `${reason} still wrote a row`)
    assert.strictEqual(plan.rpc, null)
    assert.strictEqual(plan.deferral, reason, 'and the reason is reported')
  }
})

test('a CONFIGURATION or TRANSIENT failure preserves the work for retry', () => {
  for (const reason of ['summary_key_absent', 'minimization_failed', 'budget_exhausted',
    'fetch_failed', 'model_unavailable', 'handles_unreadable']) {
    assert.ok(RETRYABLE_DEFERRALS.includes(reason), `${reason} must be retryable`)
    const plan = planContentWrite(planEntry(), { outcome: 'defer', reason },
      { consentOpen: true })
    assert.strictEqual(plan.write, 'none', reason)
    assert.strictEqual(plan.retryable, true,
      `${reason} must not let the cursor pass the conversation`)
  }
})

test('a TERMINAL deferral is reported and settled, with no row', () => {
  for (const reason of ['no_usable_content', 'ambiguous_counterparty', 'counterparty_unusable',
    'model_output_invalid', 'model_deferred', 'automation_unverified']) {
    const plan = planContentWrite(planEntry(), { outcome: 'defer', reason },
      { consentOpen: true })
    assert.strictEqual(plan.write, 'none', reason)
    assert.strictEqual(plan.retryable, false, `${reason} must not be retried forever`)
    assert.strictEqual(plan.deferral, reason)
  }
})

test('THE ENVELOPE-ONLY PILOT keeps its metadata-only row, exactly as today', () => {
  const plan = planContentWrite(planEntry(),
    { outcome: 'defer', reason: 'content_consent_missing' }, { consentOpen: false })
  assert.strictEqual(plan.write, 'interaction_metadata')
  assert.strictEqual(plan.rpc, 'upsert_outlook_interaction_candidate')
  assert.strictEqual(plan.args.p_proposed_notes, null, 'NULL, never a placeholder')
  assert.strictEqual(plan.args.p_contact_id, CONTACT_ID)
  assert.strictEqual(plan.deferral, 'content_consent_missing', 'and the reason is reported')
})

test('the default is the SAFE one: no consentOpen flag means no content release', () => {
  // Called without options, the planner must not assume the content release.
  const plan = planContentWrite(planEntry(), { outcome: 'defer', reason: 'no_usable_content' })
  assert.strictEqual(plan.write, 'interaction_metadata',
    'omitting the flag must behave as the envelope-only pilot')
})

test('a successful draft still writes the note on either disclosure', () => {
  for (const consentOpen of [true, false]) {
    const plan = planContentWrite(planEntry(), {
      outcome: 'interaction_draft', summary: 'A real summary of what was discussed.',
      followUp: 'Send the CV.', interactionDate: '2026-09-23',
    }, { consentOpen })
    assert.strictEqual(plan.write, 'interaction_with_note')
    assert.strictEqual(plan.args.p_proposed_notes, 'A real summary of what was discussed.')
    assert.strictEqual(plan.args.p_proposed_date, '2026-09-23')
  }
})

test('an entry that NEEDED content still gets no fallback on either disclosure', () => {
  for (const consentOpen of [true, false]) {
    const plan = planContentWrite(planEntry({ requiresContent: true, contactId: null }),
      { outcome: 'defer', reason: 'automation_unverified' }, { consentOpen })
    assert.strictEqual(plan.write, 'none', `consentOpen=${consentOpen}`)
    assert.strictEqual(plan.deferral, 'automation_unverified')
  }
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('4. the provider bounds are real')

/** A response whose HEADERS arrive at once and whose BODY never does. */
function stallingBody (status = 200) {
  return {
    status,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: () => new Promise(() => {}),       // never resolves
        cancel: async () => {},
      }),
    },
    json: () => new Promise(() => {}),
  }
}

/** A response that streams more bytes than the ceiling allows. */
function oversizedBody (perChunk, chunks, status = 200) {
  let sent = 0
  return {
    status,
    headers: { get: () => null },          // no content-length: the stream decides
    body: {
      getReader: () => ({
        read: async () => (sent++ < chunks
          ? { done: false, value: new Uint8Array(perChunk) }
          : { done: true, value: undefined }),
        cancel: async () => {},
      }),
    },
  }
}

function jsonBody (obj, status = 200) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj))
  let done = false
  return {
    status,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => (done ? { done: true } : (done = true, { done: false, value: bytes })),
        cancel: async () => {},
      }),
    },
  }
}

const DRAFT_BODY = buildDraftRequest({
  mode: 'known_contact', subject: 'Panel', allowedDates: ['2026-09-22'],
  messages: [{ direction: 'inbound', dateIso: '2026-09-22T10:00:00Z', text: BODY_IN, signature: null }],
})

test('REPRODUCED: headers-then-stall now TIMES OUT instead of pinning the call', async () => {
  // DRAFT_TIMEOUT_MS was a declared constant that reached no request: no signal was
  // passed to fetch at all. Even passing one only to fetch would be half a fix,
  // since fetch resolves on headers.
  let aborts = 0
  const r = await callDraftModel({
    body: DRAFT_BODY,
    apiKey: 'sk-ant-fixture',
    fetchImpl: async (_url, init) => {
      // The signal must be present, and must still be live during the body read.
      assert.ok(init.signal, 'no signal was passed to fetch')
      init.signal.addEventListener('abort', () => { aborts += 1 })
      return {
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: () => new Promise((_res, rej) => {
              init.signal.addEventListener('abort', () => {
                const e = new Error('aborted'); e.name = 'AbortError'; rej(e)
              })
            }),
            cancel: async () => {},
          }),
        },
      }
    },
    sleepImpl: async () => {},
    // One attempt only, so the test does not wait for retries.
    budgetAllows: (ms) => ms <= DRAFT_TIMEOUT_MS,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'provider_timeout', JSON.stringify(r))
  assert.ok(aborts >= 1, 'the controller must have aborted the body stream')
})

test('an OVERSIZED streamed draft response is refused mid-read', async () => {
  const chunk = 64 * 1024
  const r = await callDraftModel({
    body: DRAFT_BODY,
    apiKey: 'sk-ant-fixture',
    fetchImpl: async () => oversizedBody(chunk, Math.ceil(MAX_DRAFT_RESPONSE_BYTES / chunk) + 2),
    sleepImpl: async () => {},
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'response_too_large', JSON.stringify(r))
})

test('a REDIRECT is refused, never followed, and its Location is not read', async () => {
  let locationRead = false
  const r = await callDraftModel({
    body: DRAFT_BODY,
    apiKey: 'sk-ant-fixture',
    fetchImpl: async (_url, init) => {
      assert.strictEqual(init.redirect, 'manual', 'redirects must not be auto-followed')
      return {
        status: 302,
        headers: { get: (h) => { if (String(h).toLowerCase() === 'location') locationRead = true; return null } },
      }
    },
    sleepImpl: async () => {},
  })
  assert.strictEqual(r.code, 'provider_redirected', JSON.stringify(r))
  assert.strictEqual(locationRead, false, 'the Location header must never be read')
})

test('a retry is admitted ONLY within the remaining invocation budget', async () => {
  let attempts = 0
  let slept = 0
  const r = await callDraftModel({
    body: DRAFT_BODY,
    apiKey: 'sk-ant-fixture',
    fetchImpl: async () => { attempts += 1; return { status: 429, headers: { get: () => null } } },
    sleepImpl: async () => { slept += 1 },
    // Enough for the first attempt, never enough for a second plus its backoff.
    budgetAllows: (ms) => ms <= DRAFT_TIMEOUT_MS,
  })
  assert.strictEqual(attempts, 1, 'a second attempt was started with no budget for it')
  assert.strictEqual(slept, 0, 'and no backoff was slept through')
  assert.strictEqual(r.code, 'provider_rate_limited')
})

test('with no budget at all, not one request is made', async () => {
  let attempts = 0
  const r = await callDraftModel({
    body: DRAFT_BODY,
    apiKey: 'sk-ant-fixture',
    fetchImpl: async () => { attempts += 1; return jsonBody({}) },
    budgetAllows: () => false,
  })
  assert.strictEqual(attempts, 0)
  assert.strictEqual(r.code, 'budget_exhausted')
})

test('and the happy path still parses a draft', async () => {
  const r = await callDraftModel({
    body: DRAFT_BODY,
    apiKey: 'sk-ant-fixture',
    fetchImpl: async () => jsonBody({
      content: [{ type: 'text', text: JSON.stringify(draftReply().parsed) }],
      stop_reason: 'end_turn',
    }),
  })
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  assert.strictEqual(r.parsed.result, 'interaction_draft')
})

console.log('')
console.log('   the same bounds on the Graph content read')

const CONTENT_REQ = buildMessageContentRequest({ messageId: 'AAkALgAAmsg1' })

test('headers-then-stall on a CONTENT read times out', async () => {
  const r = await executeGraphRequest({
    request: CONTENT_REQ,
    accessToken: 'injected-fixture-token',
    sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      assert.ok(init.signal, 'no signal reached the Graph fetch')
      return {
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: () => new Promise((_res, rej) => {
              init.signal.addEventListener('abort', () => {
                const e = new Error('aborted'); e.name = 'AbortError'; rej(e)
              })
            }),
            cancel: async () => {},
          }),
        },
      }
    },
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'timeout', JSON.stringify(r))
})

test('an OVERSIZED streamed Graph body is refused mid-read', async () => {
  const chunk = 512 * 1024
  const r = await executeGraphRequest({
    request: CONTENT_REQ,
    accessToken: 'injected-fixture-token',
    sleepImpl: async () => {},
    fetchImpl: async () => oversizedBody(chunk, Math.ceil(MAX_RESPONSE_BYTES / chunk) + 2),
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'response_too_large', JSON.stringify(r))
})

test('a Graph redirect is still unexpected_redirect, not followed', async () => {
  let locationRead = false
  const r = await executeGraphRequest({
    request: CONTENT_REQ,
    accessToken: 'injected-fixture-token',
    sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      assert.strictEqual(init.redirect, 'manual')
      return {
        status: 302,
        headers: { get: (h) => { if (String(h).toLowerCase() === 'location') locationRead = true; return null } },
        json: async () => ({}),
      }
    },
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'unexpected_redirect', JSON.stringify(r))
  assert.strictEqual(locationRead, false)
})

test('and the happy path still reads a content response', async () => {
  const r = await executeGraphRequest({
    request: CONTENT_REQ,
    accessToken: 'injected-fixture-token',
    sleepImpl: async () => {},
    fetchImpl: async () => jsonBody({
      id: 'AAkALgAAmsg1',
      body: { contentType: 'text', content: BODY_IN },
      uniqueBody: { contentType: 'text', content: BODY_IN },
      internetMessageHeaders: [],
    }),
  })
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  assert.strictEqual(r.json.id, 'AAkALgAAmsg1')
})

await Promise.all(pending)
console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exitCode = 1
