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
  sanitizeMessageContent, boundEpisodeContent,
  MAX_EPISODE_CHARS, MAX_EPISODE_MESSAGES,
} from '../supabase/functions/shared/outlookContentSanitizer.js'
import {
  summarizeConversation, DEFER_REASONS, IGNORE_REASONS,
} from '../supabase/functions/shared/outlookContentPass.js'
import {
  planContentWrite, TERMINAL_DEFERRALS, RETRYABLE_DEFERRALS,
} from '../supabase/functions/shared/outlookContentStage.js'
import {
  callDraftModel, DRAFT_TIMEOUT_MS, MAX_DRAFT_RESPONSE_BYTES, buildDraftRequest,
  MAX_REQUEST_CHARS,
} from '../supabase/functions/shared/outlookDraftContract.js'
import {
  executeGraphRequest, buildMessageContentRequest, MAX_RESPONSE_BYTES,
  MAX_ERROR_BODY_BYTES, GRAPH_CODES, REQUEST_TIMEOUT_MS, MAX_RETRIES,
} from '../supabase/functions/shared/outlookGraphTransport.js'
import {
  summarizeOneConversation, planContentWrite as planWrite,
} from '../supabase/functions/shared/outlookContentStage.js'

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

/**
 * A SHORT per-attempt deadline, injected.
 *
 * The stall tests previously waited out the real constants - 20s for Graph, 30s for
 * the provider - which proved the bound and cost 30 seconds of every suite run. The
 * deadline is now injectable for exactly this, defaulting to the shipped constant, so
 * these tests assert both the controlled code AND that the call returned promptly.
 */
const FAST_TIMEOUT_MS = 150

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
  // CORRECTED. `minimization_failed` was in this list, and that was the stall: the
  // privacy guard's refusal is a property of the MAIL, not of the configuration, so
  // another invocation reads the same bodies and refuses again. It kept the
  // conversation unprocessed for ever and no cursor could move. It is terminal now,
  // and the case below covers it. What this test protects is unchanged: a failure that
  // another invocation really could answer differently must not be settled.
  for (const reason of ['summary_key_absent', 'budget_exhausted',
    'fetch_failed', 'model_unavailable', 'handles_unreadable']) {
    assert.ok(RETRYABLE_DEFERRALS.includes(reason), `${reason} must be retryable`)
    assert.ok(!TERMINAL_DEFERRALS.includes(reason),
      `${reason} must not ALSO be terminal - that overlap is what stalled the round`)
    const plan = planContentWrite(planEntry(), { outcome: 'defer', reason },
      { consentOpen: true })
    assert.strictEqual(plan.write, 'none', reason)
    assert.strictEqual(plan.retryable, true,
      `${reason} must not let the cursor pass the conversation`)
  }
})

test('A DETERMINISTIC PRIVACY REFUSAL IS SETTLED, not retried for ever', () => {
  // THE STALL, at the planner. `minimization_failed` was in both classification lists
  // and planContentWrite tested the retryable one first, so it answered retryable:true.
  // The run then stopped the finalisation loop without passing the conversation - no
  // cursor, nothing written, and the same two bodies re-read on every invocation.
  //
  // Settled does NOT mean accepted: no suggestion is written, and the reason is still
  // reported. It means the round may finish.
  for (const reason of ['minimization_failed', 'request_build_failed']) {
    assert.ok(TERMINAL_DEFERRALS.includes(reason), `${reason} must be terminal`)
    assert.ok(!RETRYABLE_DEFERRALS.includes(reason), `${reason} must not also be retryable`)
    const plan = planWrite(planEntry(), { outcome: 'defer', reason }, { consentOpen: true })
    assert.strictEqual(plan.write, 'none', `${reason} must write nothing`)
    assert.strictEqual(plan.rpc, null, reason)
    assert.strictEqual(plan.retryable, false,
      `${reason} must let finalisation pass the conversation`)
    assert.strictEqual(plan.deferral, reason, 'and the reason must still be reported')
  }
})

test('THE CLASSIFICATION IS A PARTITION: every code terminal or retryable, never both', () => {
  const overlap = TERMINAL_DEFERRALS.filter((c) => RETRYABLE_DEFERRALS.includes(c))
  assert.deepStrictEqual(overlap, [], 'a code in both lists is a stall waiting to happen')
  assert.strictEqual(
    TERMINAL_DEFERRALS.length + RETRYABLE_DEFERRALS.length,
    new Set([...TERMINAL_DEFERRALS, ...RETRYABLE_DEFERRALS]).size,
    'the two lists must partition the vocabulary, not merely cover it')
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
  const startedDraft = Date.now()
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
    timeoutMs: FAST_TIMEOUT_MS,
    // One attempt only, so the test does not wait for retries.
    budgetAllows: (ms) => ms <= FAST_TIMEOUT_MS,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'provider_timeout', JSON.stringify(r))
  assert.ok(aborts >= 1, 'the controller must have aborted the body stream')
  assert.ok(Date.now() - startedDraft < 5_000,
    'the deadline must bound the body read, not merely exist')
  // And the shipped default is the real constant, not this test's figure.
  assert.strictEqual(DRAFT_TIMEOUT_MS, 30_000)
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
  const started200 = Date.now()
  const r = await executeGraphRequest({
    request: CONTENT_REQ,
    accessToken: 'injected-fixture-token',
    sleepImpl: async () => {},
    timeoutMs: FAST_TIMEOUT_MS,
    budgetAllows: (ms) => ms <= FAST_TIMEOUT_MS,
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
  assert.ok(Date.now() - started200 < 5_000, 'the deadline must actually bound the read')
  assert.strictEqual(REQUEST_TIMEOUT_MS, 20_000, 'and the shipped default is unchanged')
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

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('6. the NON-200 Graph body is bounded too')

/** A non-200 whose headers arrive at once and whose body never does. */
function stallingErrorBody (status) {
  return (_url, init) => Promise.resolve({
    status,
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
    // If anything reached for the unbounded reader, this would hang forever and the
    // test would time out rather than pass.
    json: () => new Promise(() => {}),
  })
}

/** A non-200 that streams more bytes than the error ceiling allows. */
function oversizedErrorBody (status, totalBytes) {
  const chunk = 32 * 1024
  let sent = 0
  let read = 0
  return () => Promise.resolve({
    status,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent >= totalBytes) return { done: true, value: undefined }
          const n = Math.min(chunk, totalBytes - sent)
          sent += n
          read += n
          return { done: false, value: new Uint8Array(n) }
        },
        cancel: async () => {},
      }),
    },
    get __bytesRead () { return read },
    json: () => new Promise(() => {}),
  })
}

test('REPRODUCED: a STALLED 400 body now times out instead of hanging', async () => {
  // The timer was cleared BEFORE the error body was read, and that read was an
  // unbounded res.json(). A 400 that sent headers promptly and then stalled its body
  // hung with no deadline in force at all.
  let aborted = 0
  const started = Date.now()
  const r = await executeGraphRequest({
    request: CONTENT_REQ,
    accessToken: 'injected-fixture-token',
    sleepImpl: async () => {},
    fetchImpl: (url, init) => {
      assert.ok(init.signal, 'no signal reached the Graph fetch')
      init.signal.addEventListener('abort', () => { aborted += 1 })
      return stallingErrorBody(400)(url, init)
    },
    timeoutMs: FAST_TIMEOUT_MS,
    // One attempt's worth, so the assertion is about the body read and not retries.
    budgetAllows: (ms) => ms <= FAST_TIMEOUT_MS,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'timeout', JSON.stringify(r))
  assert.ok(aborted >= 1, 'the controller must have aborted the error-body stream')
  // THE POINT: it returned under its own deadline rather than hanging. Before the
  // fix the timer was cleared before this read and nothing bounded it at all, so
  // this assertion could never have been satisfied by any wait.
  assert.ok(Date.now() - started < 5_000, 'the error-body read must be bounded in time')
})

test('REPRODUCED: an OVERSIZED error body is refused mid-stream', async () => {
  // Measured before: 4,100,048 bytes were read against a ceiling never applied to an
  // error body. The ceiling for an error payload is now its own, far smaller one -
  // an error carries a code, not a page of messages.
  const impl = oversizedErrorBody(400, MAX_ERROR_BODY_BYTES + 4096)
  let captured = null
  const r = await executeGraphRequest({
    request: CONTENT_REQ,
    accessToken: 'injected-fixture-token',
    sleepImpl: async () => {},
    fetchImpl: async (...a) => { captured = await impl(...a); return captured },
    timeoutMs: 5_000,
    budgetAllows: (ms) => ms <= 5_000,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'response_too_large', JSON.stringify(r))
  // And it stopped EARLY rather than buffering the lot: the reader is cancelled the
  // moment the running total passes the ceiling.
  assert.ok(captured.__bytesRead <= MAX_ERROR_BODY_BYTES + 32 * 1024,
    `read ${captured.__bytesRead} bytes`)
  assert.ok(MAX_ERROR_BODY_BYTES < MAX_RESPONSE_BYTES,
    'an error body must not be allowed a whole page')
})

test('CLASSIFICATION IS PRESERVED: a 400 carrying a dead-cursor code still says so', async () => {
  for (const [token, status] of [
    ['syncStateNotFound', 400], ['resyncRequired', 400],
    ['syncStateNotSupported', 400], ['synchronizationStateExpired', 410],
  ]) {
    const r = await executeGraphRequest({
      request: buildMessageContentRequest({ messageId: 'AAkALgAAmsg1' }),
      accessToken: 'injected-fixture-token',
      sleepImpl: async () => {},
      fetchImpl: async () => jsonBody({ error: { code: token } }, status),
    })
    assert.strictEqual(r.ok, false, token)
    assert.strictEqual(r.code, 'cursor_invalid', `${token}/${status}: ${JSON.stringify(r)}`)
  }
})

test('and an ordinary 400 with a readable body is still bad_request', async () => {
  const r = await executeGraphRequest({
    request: buildMessageContentRequest({ messageId: 'AAkALgAAmsg1' }),
    accessToken: 'injected-fixture-token',
    sleepImpl: async () => {},
    fetchImpl: async () => jsonBody({ error: { code: 'invalidRequest' } }, 400),
  })
  assert.strictEqual(r.code, 'bad_request', JSON.stringify(r))
})

test('a MALFORMED error body classifies on status alone, as it always did', async () => {
  const r = await executeGraphRequest({
    request: buildMessageContentRequest({ messageId: 'AAkALgAAmsg1' }),
    accessToken: 'injected-fixture-token',
    sleepImpl: async () => {},
    fetchImpl: async () => {
      const bytes = new TextEncoder().encode('<html>not json at all</html>')
      let done = false
      return {
        status: 400,
        headers: { get: () => null },
        body: { getReader: () => ({
          read: async () => (done ? { done: true } : (done = true, { done: false, value: bytes })),
          cancel: async () => {},
        }) },
      }
    },
  })
  assert.strictEqual(r.code, 'bad_request', JSON.stringify(r))
})

test('a REDIRECT body is never read at all', async () => {
  let bodyTouched = false
  let locationRead = false
  const r = await executeGraphRequest({
    request: CONTENT_REQ,
    accessToken: 'injected-fixture-token',
    sleepImpl: async () => {},
    fetchImpl: async () => ({
      status: 302,
      headers: { get: (h) => { if (String(h).toLowerCase() === 'location') locationRead = true; return null } },
      get body () { bodyTouched = true; return null },
      json: async () => { bodyTouched = true; return {} },
    }),
  })
  assert.strictEqual(r.code, 'unexpected_redirect', JSON.stringify(r))
  assert.strictEqual(bodyTouched, false,
    'the body of a response we refuse to follow must not be read')
  assert.strictEqual(locationRead, false)
})

test('every code this module can return is declared', () => {
  for (const c of ['timeout', 'response_too_large', 'budget_exhausted', 'bad_request',
    'cursor_invalid', 'unexpected_redirect', 'malformed_response']) {
    assert.ok(GRAPH_CODES.includes(c), `${c} is not in GRAPH_CODES`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('7. Graph retries respect the INVOCATION budget')

const retryable = (status) => () => Promise.resolve({
  status, headers: { get: () => null },
  body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) },
})

test('NO BUDGET means NO REQUEST', async () => {
  let attempts = 0
  const r = await executeGraphRequest({
    request: CONTENT_REQ,
    accessToken: 'injected-fixture-token',
    sleepImpl: async () => {},
    fetchImpl: async () => { attempts += 1; return jsonBody({ id: 'x' }) },
    budgetAllows: () => false,
  })
  assert.strictEqual(attempts, 0, 'a request was issued with no budget for it')
  assert.strictEqual(r.code, 'budget_exhausted', JSON.stringify(r))
  assert.strictEqual(r.attempts, 0)
})

test('REPRODUCED: 25 seconds of budget no longer buys 120 seconds of retries', async () => {
  // Before: attempts started at 0, 50,000 and 100,000 ms and the loop spent 120
  // seconds, because the only bounds consulted were MAX_RETRIES,
  // MAX_TOTAL_RETRY_DELAY_MS and the per-attempt timeout - none of which knows how
  // much of the INVOCATION is left.
  let elapsed = 0
  const REMAINING = 25_000
  const attemptStarts = []
  let slept = 0
  const r = await executeGraphRequest({
    request: CONTENT_REQ,
    accessToken: 'injected-fixture-token',
    // A clock that charges the per-attempt timeout for each attempt, as a stalled
    // attempt would.
    sleepImpl: async (ms) => { slept += ms; elapsed += ms },
    fetchImpl: async () => {
      attemptStarts.push(elapsed)
      elapsed += REQUEST_TIMEOUT_MS
      return retryable(503)()
    },
    budgetAllows: (marginMs) => REMAINING - elapsed > marginMs,
  })
  assert.strictEqual(r.ok, false)
  // ONE attempt fits in 25s: the second would need its backoff plus another 20s.
  assert.deepStrictEqual(attemptStarts, [0],
    `attempts started at ${JSON.stringify(attemptStarts)}`)
  assert.strictEqual(slept, 0, 'and no backoff was slept through')
  assert.ok(elapsed <= REMAINING + REQUEST_TIMEOUT_MS,
    `spent ${elapsed}ms of ${REMAINING}ms`)
  // The PROVIDER's answer is what the caller acts on, not our budget bookkeeping.
  assert.strictEqual(r.code, 'server_error', JSON.stringify(r))
})

test('a generous budget still retries exactly as before', async () => {
  let attempts = 0
  const r = await executeGraphRequest({
    request: CONTENT_REQ,
    accessToken: 'injected-fixture-token',
    sleepImpl: async () => {},
    fetchImpl: async () => { attempts += 1; return retryable(503)() },
    budgetAllows: () => true,
  })
  assert.strictEqual(attempts, MAX_RETRIES + 1,
    `retried ${attempts} times; the budget must not have narrowed the loop`)
  assert.strictEqual(r.ok, false)
})

test('a caller that supplies NO budget is unchanged', async () => {
  let attempts = 0
  const r = await executeGraphRequest({
    request: CONTENT_REQ,
    accessToken: 'injected-fixture-token',
    sleepImpl: async () => {},
    fetchImpl: async () => { attempts += 1; return retryable(503)() },
  })
  assert.strictEqual(attempts, MAX_RETRIES + 1, 'omitting the budget must not bound the loop')
  assert.strictEqual(r.ok, false)
})

test('the budget is re-checked AFTER the backoff, not only before it', async () => {
  // The sleep is the one step whose real duration this module does not control.
  let elapsed = 0
  let budget = 10 * REQUEST_TIMEOUT_MS
  let attempts = 0
  const r = await executeGraphRequest({
    request: CONTENT_REQ,
    accessToken: 'injected-fixture-token',
    // A backoff that OVERRUNS: it was affordable when checked, and consumed the whole
    // remaining budget while it ran.
    sleepImpl: async () => { elapsed = budget },
    fetchImpl: async () => { attempts += 1; return retryable(503)() },
    budgetAllows: (marginMs) => budget - elapsed > marginMs,
  })
  assert.strictEqual(attempts, 1,
    'a second attempt was issued after a backoff that ate the budget')
  assert.strictEqual(r.code, 'budget_exhausted', JSON.stringify(r))
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('   through the ACTUAL content-stage wiring')

/** The stage's own ports, with a fixture rpc serving one conversation's handles. */
function stageParams (over = {}) {
  const seen = { fetches: 0, model: 0 }
  const base = {
    conversation: { cfp: CFP, contactId: CONTACT_ID, messageCount: 2, lastLocalDate: '2026-09-22' },
    rpc: async (name) => {
      if (name !== 'list_outlook_round_message_handles') return { data: { result: 'ok' }, error: null }
      return {
        error: null,
        data: {
          result: 'ok',
          next_cursor: null,
          handles: [
            { cfp: CFP, mfp: '1'.repeat(64), folder: 'inbox', sent_at: '2026-09-21T10:00:00Z',
              mid_ct: 'SEAL:AAkALgAAmsg1', mid_nonce: 'N1', key_version: 1 },
            { cfp: CFP, mfp: '2'.repeat(64), folder: 'sentitems', sent_at: '2026-09-22T10:00:00Z',
              mid_ct: 'SEAL:AAkALgAAmsg2', mid_nonce: 'N1', key_version: 1 },
          ],
        },
      }
    },
    connectionId: CONN,
    runId: '44444444-4444-4444-4444-444444444444',
    roundId: '55555555-5555-5555-5555-555555555555',
    decryptCursor: async (ct) => String(ct).replace(/^SEAL:/, ''),
    accessToken: 'injected-fixture-token',
    apiKey: 'sk-ant-fixture-not-a-real-key',
    consentVersion: APPROVED,
    requiredConsent: BOTH,
    selfAddresses: [ME],
    budgetAllows: () => true,
    deps: {
      sleepImpl: async () => {},
      fetchImpl: async (url) => {
        if (String(url).includes('api.anthropic.com')) {
          seen.model += 1
          return jsonBody({
            content: [{ type: 'text', text: JSON.stringify(draftReply().parsed) }],
            stop_reason: 'end_turn',
          })
        }
        seen.fetches += 1
        const m = String(url).match(/\/me\/messages\/([^?]+)\?/)
        const id = decodeURIComponent(m[1])
        return jsonBody({
          id,
          body: { contentType: 'text', content: id.endsWith('1') ? BODY_IN : BODY_OUT },
          uniqueBody: { contentType: 'text', content: id.endsWith('1') ? BODY_IN : BODY_OUT },
          subject: 'Following up after the panel',
          from: id.endsWith('1')
            ? { emailAddress: { address: THEM, name: 'Priya Nair' } }
            : { emailAddress: { address: ME, name: 'Pilot' } },
          toRecipients: [{ emailAddress: { address: id.endsWith('1') ? ME : THEM } }],
          internetMessageHeaders: [{ name: 'Received', value: 'by fixture' }],
        })
      },
    },
  }
  return { seen, params: { ...base, ...over } }
}

test('POSITIVE CONTROL: the whole stage still produces a draft through the real transport', async () => {
  const { seen, params } = stageParams()
  const r = await summarizeOneConversation(params)
  assert.strictEqual(r.outcome, 'interaction_draft', JSON.stringify(r))
  assert.strictEqual(seen.fetches, 2, 'both bodies read through executeGraphRequest')
  assert.strictEqual(seen.model, 1)
  assert.ok(/insight week/i.test(r.summary), r.summary)
})

test('THE BUDGET REACHES THE TRANSPORT: no budget, no Graph request', async () => {
  // Proved through the real wiring, not by calling the transport directly: the
  // fetcher is constructed inside summarizeOneConversation, so this is the thread
  // summarizeOneConversation -> makeMessageFetcher -> executeGraphRequest.
  const { seen, params } = stageParams({ budgetAllows: () => false })
  const r = await summarizeOneConversation(params)
  assert.strictEqual(seen.fetches, 0, 'a Graph request was issued with no budget')
  assert.strictEqual(seen.model, 0)
  // The pass's own admission check fires first, which is the right order.
  assert.strictEqual(r.outcome, 'defer')
  assert.strictEqual(r.reason, 'budget_exhausted', JSON.stringify(r))
})

test('RETRY BUDGET EXHAUSTION through the stage defers, and reads no more', async () => {
  // Enough budget for the pass to admit a fetch, and a transport that keeps failing
  // retryably. Without the thread the transport would burn four attempts and two
  // backoffs inside that one admission.
  let elapsed = 0
  const REMAINING = 40_000
  let graphAttempts = 0
  const { seen, params } = stageParams({
    budgetAllows: (marginMs) => REMAINING - elapsed > marginMs,
    deps: {
      sleepImpl: async (ms) => { elapsed += ms },
      fetchImpl: async () => {
        graphAttempts += 1
        elapsed += REQUEST_TIMEOUT_MS
        return retryable(503)()
      },
    },
  })
  const r = await summarizeOneConversation(params)
  assert.ok(graphAttempts <= 2,
    `the transport made ${graphAttempts} attempts inside one admission`)
  assert.strictEqual(seen.model, 0, 'and never reached the provider')
  assert.strictEqual(r.outcome, 'defer', JSON.stringify(r))
  // A fetch that failed is `fetch_failed`, which is RETRYABLE - the conversation is
  // not settled and the handles are untouched.
  assert.ok(['fetch_failed', 'budget_exhausted'].includes(r.reason), JSON.stringify(r))
})

test('A REQUEST THAT CANNOT BE BUILT is its own code, not a privacy refusal', () => {
  // THE DISTINCTION THE LIVE REPORT COULD NOT MAKE. buildDraftRequest throwing used to
  // be reported as `minimization_failed` - the same code the privacy guard returns when
  // it withholds a request. One means "Funnl refused to send something"; the other means
  // "Funnl could not build anything to send".
  //
  // THIS TEST CHANGED SHAPE when the new-contact schema was trimmed to the documented
  // union-type ceiling. It used to drive the pass end to end at the sanitizer's worst
  // case, because that case serialized past MAX_REQUEST_CHARS. The trimmed schema is
  // about 1,270 characters smaller, and the worst case now FITS - so
  // `request_too_large` is no longer reachable from bounded content, and with it the
  // only route to the pass's catch. That is an improvement, and it is asserted below
  // rather than left to be discovered. The catch remains as defence in depth.
  //
  // So the three things that can still be checked are checked: the builder's own
  // refusals, the margin that makes them unreachable from real content, and the
  // classification of the code if it ever is reached.

  // 1. THE BUILDER STILL REFUSES what it documents.
  for (const [label, params, message] of [
    ['a non-object', null, 'invalid_draft_input'],
    ['an unknown mode', { mode: 'nonsense', messages: [], allowedDates: ['2026-09-20'] }, 'invalid_mode'],
    ['no allowed dates', { mode: 'known_contact', subject: 's', allowedDates: [],
      messages: [{ direction: 'inbound', dateIso: '2026-09-20T09:00:00Z', text: 'hello there', signature: null }] }, 'no_allowed_dates'],
  ]) {
    let threw = null
    try { buildDraftRequest(params) } catch (e) { threw = e.message }
    assert.strictEqual(threw, message, label + ' -> ' + threw)
  }

  // 2. THE WORST CASE THE SANITIZER PERMITS NOW FITS, on both paths. If either schema
  //    grows back toward the ceiling this fails, which is the point.
  const NL = String.fromCharCode(10)
  const SIGFILL = 'Ventures Partners LLP, Level 12, Harbour Exchange, London. '
  const per = Math.floor(MAX_EPISODE_CHARS / MAX_EPISODE_MESSAGES)
  const long = 'The programme covers markets and coverage rotations. '
    .repeat(Math.ceil(per / 52)).slice(0, per)
  const sig = ['--', 'Cleo Adeyemi', 'Analyst Programme Lead',
    SIGFILL.repeat(Math.ceil(620 / SIGFILL.length))].join(NL)
  const parts = []
  for (let i = 0; i < MAX_EPISODE_MESSAGES; i++) {
    // EVERY message inbound, so every one keeps a signature: signatures are not
    // counted against the episode character budget, which is what made the ceiling
    // reachable at all.
    const c = sanitizeMessageContent({ uniqueBodyContent: long + NL + NL + sig, uniqueBodyContentType: 'text' })
    assert.ok(c.ok, 'the fixture must sanitize: ' + c.code)
    parts.push({ direction: 'inbound', timestampIso: '2026-09-1' + i + 'T10:00:00Z',
      sanitized: c.sanitized ?? c })
  }
  const bounded = boundEpisodeContent(parts)
  assert.strictEqual(bounded.kept.length, MAX_EPISODE_MESSAGES, 'all six messages kept')
  const msgs = bounded.kept.map((k) => ({ direction: k.direction, dateIso: k.timestampIso,
    text: k.sanitized.text, signature: k.sanitized.signature }))
  for (const mode of ['new_contact', 'known_contact']) {
    const built = buildDraftRequest({ mode, displayName: 'Cleo',
      subject: 'Summer analyst referral', messages: msgs, allowedDates: ['2026-09-20'] })
    const size = JSON.stringify(built).length
    assert.ok(size <= MAX_REQUEST_CHARS,
      mode + ' serializes to ' + size + ', over the ' + MAX_REQUEST_CHARS + ' ceiling')
  }

  // 3. AND IF IT IS EVER REACHED, the code is its own and it is terminal: no write, no
  //    suggestion, the reason reported, and the conversation passed so the round ends.
  const plan = planWrite(planEntry(), { outcome: 'defer', reason: 'request_build_failed' },
    { consentOpen: true })
  assert.strictEqual(plan.write, 'none')
  assert.strictEqual(plan.rpc, null)
  assert.strictEqual(plan.retryable, false)
  assert.strictEqual(plan.deferral, 'request_build_failed')
  assert.notStrictEqual(plan.deferral, 'minimization_failed')
})

test('A DEFERRED CONVERSATION STAYS RESUMABLE: no write, no cursor advance', () => {
  // The chain that matters: a retryable deferral must plan NO write and must NOT let
  // the finalisation cursor pass the conversation. Asserted on the planner, which is
  // what the run consults, for every reason this round can produce.
  // `minimization_failed` was in this list too. It belonged in neither: a refusal the
  // same mail reproduces every time is not unfinished work, and treating it as such is
  // what made the round unfinishable.
  for (const reason of ['fetch_failed', 'budget_exhausted', 'model_unavailable',
    'handles_unreadable', 'summary_key_absent']) {
    const plan = planWrite(planEntry(), { outcome: 'defer', reason }, { consentOpen: true })
    assert.strictEqual(plan.write, 'none', `${reason} wrote something`)
    assert.strictEqual(plan.rpc, null, reason)
    assert.strictEqual(plan.retryable, true,
      `${reason} must leave the conversation unprocessed so the next invocation redoes it`)
    assert.strictEqual(plan.deferral, reason, 'and the reason must be reported')
  }
})

await Promise.all(pending)
console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exitCode = 1
