// THE CONTENT PASS AND THE HANDLE PRODUCER, driven with fixture Microsoft and
// Anthropic responses.
//
// WHAT IS EXECUTED HERE. Both new modules, end to end, against fixtures:
// handles are produced (fingerprint, seal, shape), then consumed (decrypt,
// fetch, sanitize, minimize, model, validate, route). The real sanitizer, the
// real draft-request builder, the real runtime minimization guard and the real
// strict response validator all run - only the two network boundaries and the
// cipher are injected.
//
// WHAT IS NOT. No Microsoft, no Anthropic, no network, no database, no browser.
// Every provider response is a local fixture built from the documented contract,
// so these tests say what the code does GIVEN a response of that shape - they
// are not evidence that either provider produces that shape. The database path
// is proven separately against a real Postgres by
// tests/sql/outlook-round-retrieval-runtime.sql and
// tests/sql/outlook-content-slice-runtime.sql.
//
// NO REAL IDENTIFIER, ADDRESS OR MESSAGE APPEARS IN THIS FILE.
//
// Run with: node tests/outlook-content-pass.test.js

import assert from 'node:assert'
import {
  buildMessageHandles, summarizeProducer, isUsableMessageId,
  MAX_HANDLE_CIPHERTEXT_CHARS,
} from '../supabase/functions/shared/outlookHandleProducer.js'
import {
  summarizeConversation, summarizePassResult, counterpartyFromEnvelopes,
  PASS_OUTCOMES, DEFER_REASONS, IGNORE_REASONS, MAX_FETCH_PER_CONVERSATION,
} from '../supabase/functions/shared/outlookContentPass.js'

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

// ── invented fixtures ───────────────────────────────────────────────────────
const APPROVED = 'ol-disc-' + 'a'.repeat(32)
const ENVELOPE_ONLY = 'ol-disc-81fe8944fd2be59ac3c059c229b4d28e'   // the live pilot's
const BOTH = { content: APPROVED, thirdParty: APPROVED }
const CFP = 'c'.repeat(64)
const ME = 'pilot@outlook.test'
const THEM = 'priya.sharma@goldman.test'
const CONTACT_ID = '33333333-3333-3333-3333-333333333333'

// A trivially reversible stand-in for AES-GCM, so the test can assert the
// plaintext id never leaves and still decrypt it.
const seal = async (plain) => ({ ciphertext: 'SEAL:' + plain, nonce: 'N1', keyVersion: 1 })
const unseal = async ({ ciphertext }) => String(ciphertext).replace(/^SEAL:/, '')

const addr = (a, n) => ({ address: a, name: n })

/** A fixture Graph content response, already in the shape the port must supply. */
function fixtureMessage ({ dir, text, subject = 'Summer analyst referral', automation = {},
  automationComplete = true } = {}) {
  return {
    ok: true,
    message: {
      bodyContent: text,
      uniqueBodyContent: text,
      automation,
      automationComplete,
      subject,
      from: dir === 'inbound' ? addr(THEM, 'Priya Sharma') : addr(ME, 'Pilot User'),
      toRecipients: dir === 'inbound' ? [addr(ME, 'Pilot User')] : [addr(THEM, 'Priya Sharma')],
    },
  }
}

const INBOUND_TEXT =
  'Hi - thanks for the chat on Tuesday. I spoke to our analyst programme lead and '
  + 'she is happy to look at your application for the summer cohort. Could you send '
  + 'over an updated CV by Friday, and let me know whether you would prefer the '
  + 'markets or the coverage track?'
const OUTBOUND_TEXT =
  'Thank you so much - that is really kind. I will send the CV across tomorrow. '
  + 'I think markets is the better fit for me given the modelling work I did last '
  + 'summer, but I would be glad to hear your view.'

function handlesFor (count = 2) {
  const out = []
  for (let i = 0; i < count; i++) {
    out.push({
      mfp: String(i + 1).padStart(64, '0'),
      folder: i % 2 === 0 ? 'inbox' : 'sentitems',
      sentAt: `2026-09-2${i + 1}T10:00:00.000Z`,
      midCt: 'SEAL:AAkALgAAmsg' + (i + 1),
      midNonce: 'N1',
    })
  }
  return out
}

/** A fixture Anthropic reply, validated by the REAL validator. */
function modelReply (over = {}) {
  return {
    ok: true,
    value: {
      result: 'interaction_draft',
      summary: 'Priya confirmed the analyst programme lead will review your application '
        + 'for the summer cohort, and asked for an updated CV by Friday plus your '
        + 'preference between the markets and coverage tracks.',
      summary_evidence: 'explicit_body',
      follow_up: 'Send the updated CV and state your track preference.',
      interaction_date: '2026-09-22',
      ...over,
    },
  }
}

function newContactReply (over = {}) {
  return {
    ok: true,
    value: {
      result: 'new_contact_suggestion',
      name: 'Priya Sharma',
      name_evidence: 'explicit_signature',
      name_confidence: 'high',
      company: null, company_evidence: null, company_confidence: null,
      role: null, role_evidence: null, role_confidence: null,
      how_met: null, how_met_evidence: null, how_met_confidence: null,
      linkedin_url: null, linkedin_url_evidence: null, linkedin_url_confidence: null,
      tags: [],
      summary: 'Priya offered to put your application in front of the analyst programme '
        + 'lead and asked for an updated CV by Friday.',
      summary_evidence: 'explicit_body',
      follow_up: 'Send the updated CV before Friday.',
      interaction_date: '2026-09-22',
      ...over,
    },
  }
}

/** The whole pass, with every port a fixture. */
function run (over = {}) {
  const calls = { fetched: [], model: 0, requests: [] }
  const base = {
    conversation: { cfp: CFP, contactId: CONTACT_ID, messageCount: 2,
      lastLocalDate: '2026-09-22' },
    consentVersion: APPROVED,
    requiredConsent: BOTH,
    handles: handlesFor(2),
    decryptHandle: unseal,
    fetchMessage: async (id) => {
      calls.fetched.push(id)
      return id.endsWith('1')
        ? fixtureMessage({ dir: 'inbound', text: INBOUND_TEXT })
        : fixtureMessage({ dir: 'outbound', text: OUTBOUND_TEXT })
    },
    callModel: async ({ body }) => { calls.model += 1; calls.requests.push(body); return modelReply() },
    apiKey: 'sk-ant-fixture-not-a-real-key',
    selfAddresses: [ME],
    budgetAllows: () => true,
  }
  return { calls, params: { ...base, ...over } }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('the producer: the envelope-only consent does NOT authorize storing handles')

test('with the content gate closed, NO handle is produced', async () => {
  // This is the point of checking consent in the producer rather than only at the
  // body read: a stored handle is a durable key to a message, which the
  // envelope-only disclosure does not describe.
  let sealed = 0
  const out = await buildMessageHandles({
    consentVersion: ENVELOPE_ONLY,
    selected: [{ cfp: CFP, mfp: '1'.repeat(64), messageId: 'AAkALgAAx',
      folder: 'inbox', sentAtIso: '2026-09-21T10:00:00Z' }],
    seal: async (x) => { sealed += 1; return seal(x) },
  })
  assert.deepStrictEqual(out.handles, [], 'no handle may be produced')
  assert.strictEqual(out.reason, 'content_consent_missing')
  assert.strictEqual(sealed, 0, 'and NOTHING may even be encrypted')
  // Production today: the required version is null, so the real default is closed
  // for every connection including an approved-looking one.
  const prod = await buildMessageHandles({
    consentVersion: APPROVED,
    selected: [{ cfp: CFP, mfp: '1'.repeat(64), messageId: 'AAkALgAAx',
      folder: 'inbox', sentAtIso: '2026-09-21T10:00:00Z' }],
    seal,
  })
  assert.strictEqual(prod.reason, 'content_consent_missing',
    'the production constants are null, so the gate is closed')
})

test('with consent, handles carry ONLY the protected fields', async () => {
  const out = await buildMessageHandles({
    consentVersion: APPROVED,
    requiredConsent: BOTH,
    selected: [
      { cfp: CFP, mfp: '1'.repeat(64), messageId: 'AAkALgAAmsg1', folder: 'inbox',
        sentAtIso: '2026-09-21T10:00:00Z' },
      { cfp: CFP, mfp: '2'.repeat(64), messageId: 'AAkALgAAmsg2', folder: 'sentitems',
        sentAtIso: '2026-09-22T10:00:00Z' },
    ],
    seal,
  })
  assert.strictEqual(out.handles.length, 2)
  assert.strictEqual(out.reason, null)
  for (const h of out.handles) {
    assert.deepStrictEqual(Object.keys(h).sort(),
      ['cfp', 'folder', 'key_version', 'mfp', 'mid_ct', 'mid_nonce', 'sent_at'])
    // THE PLAINTEXT ID IS NOT IN THE HANDLE.
    assert.ok(!h.mid_ct.includes('"'), 'ciphertext is opaque to this module')
  }
  const j = JSON.stringify(out.handles)
  for (const leak of ['subject', 'Summer analyst', THEM, ME, 'body']) {
    assert.ok(!j.includes(leak), `a handle leaked ${leak}`)
  }
})

test('a malformed selection is skipped per item, never guessed at', async () => {
  const out = await buildMessageHandles({
    consentVersion: APPROVED, requiredConsent: BOTH, seal,
    selected: [
      { cfp: CFP, mfp: 'nope', messageId: 'AAkALgAAx', folder: 'inbox', sentAtIso: 'x' },
      { cfp: 'nope', mfp: '1'.repeat(64), messageId: 'AAkALgAAx', folder: 'inbox', sentAtIso: 'x' },
      { cfp: CFP, mfp: '1'.repeat(64), messageId: 'has spaces', folder: 'inbox', sentAtIso: 'x' },
      { cfp: CFP, mfp: '1'.repeat(64), messageId: 'AAkALgAAx', folder: 'drafts', sentAtIso: 'x' },
      // sent_at missing: the selection orders by it, so this cannot be ranked.
      { cfp: CFP, mfp: '1'.repeat(64), messageId: 'AAkALgAAx', folder: 'inbox' },
      null, 'garbage',
    ],
  })
  assert.strictEqual(out.handles.length, 0)
  assert.ok(Object.keys(out.skipped).length > 0, 'the skips are counted')
  for (const k of Object.keys(out.skipped)) {
    assert.ok(['missing_fingerprint', 'unusable_message_id', 'no_selected_messages'].includes(k), k)
  }
})

test('an over-long ciphertext is refused, not truncated', async () => {
  // A truncated ciphertext will not decrypt, so storing one turns a summarizable
  // exchange into a permanent fetch failure.
  const out = await buildMessageHandles({
    consentVersion: APPROVED, requiredConsent: BOTH,
    selected: [{ cfp: CFP, mfp: '1'.repeat(64), messageId: 'AAkALgAAx', folder: 'inbox',
      sentAtIso: '2026-09-21T10:00:00Z' }],
    seal: async () => ({ ciphertext: 'Z'.repeat(MAX_HANDLE_CIPHERTEXT_CHARS + 1),
      nonce: 'N', keyVersion: 1 }),
  })
  assert.strictEqual(out.handles.length, 0)
  assert.strictEqual(out.skipped.ciphertext_too_large, 1)
})

test('the same message offered twice in one page is sealed once', async () => {
  let sealed = 0
  const m = { cfp: CFP, mfp: '1'.repeat(64), messageId: 'AAkALgAAx', folder: 'inbox',
    sentAtIso: '2026-09-21T10:00:00Z' }
  const out = await buildMessageHandles({
    consentVersion: APPROVED, requiredConsent: BOTH, selected: [m, { ...m }],
    seal: async (x) => { sealed += 1; return seal(x) },
  })
  assert.strictEqual(out.handles.length, 1)
  assert.strictEqual(sealed, 1, 'two seals would produce two ciphertexts for one id')
})

test('ids are case-sensitive and never normalized', async () => {
  const mixed = 'AAkALgAAmSgAbC'
  const out = await buildMessageHandles({
    consentVersion: APPROVED, requiredConsent: BOTH, seal,
    selected: [{ cfp: CFP, mfp: '1'.repeat(64), messageId: mixed, folder: 'inbox',
      sentAtIso: '2026-09-21T10:00:00Z' }],
  })
  assert.strictEqual(await unseal({ ciphertext: out.handles[0].mid_ct }), mixed,
    'the id must round-trip with its original casing')
  assert.ok(isUsableMessageId(mixed))
  assert.ok(!isUsableMessageId('../escape'))
  assert.ok(!isUsableMessageId('has space'))
})

test('the logged producer summary carries no id or ciphertext', async () => {
  const out = await buildMessageHandles({
    consentVersion: APPROVED, requiredConsent: BOTH, seal,
    selected: [{ cfp: CFP, mfp: '1'.repeat(64), messageId: 'AAkALgAAsecret',
      folder: 'inbox', sentAtIso: '2026-09-21T10:00:00Z' }],
  })
  const log = JSON.stringify(summarizeProducer(out))
  assert.ok(!log.includes('AAkALgAAsecret'), 'the id leaked into the log shape')
  assert.ok(!log.includes('SEAL:'), 'the ciphertext leaked into the log shape')
  assert.ok(!log.includes('ol-disc'), 'the consent version leaked')
  assert.ok(log.includes('"handles":1'))
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('consent is checked BEFORE any body is read')

test('the body gate closed: zero fetches and zero model calls', async () => {
  const { calls, params } = run({ consentVersion: ENVELOPE_ONLY })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.outcome, 'defer')
  assert.strictEqual(r.reason, 'content_consent_missing')
  assert.strictEqual(calls.fetched.length, 0, 'NOT ONE BODY may be read')
  assert.strictEqual(calls.model, 0, 'and no model call')
})

test('the THIRD-PARTY gate closed: still zero fetches, because no summary is possible', async () => {
  // Body-only is a coherent consent state, but there is no local summary worth
  // writing - that was the rejected subject-and-counts note - so the pass defers
  // without reading mail it could not use.
  const { calls, params } = run({ requiredConsent: { content: APPROVED, thirdParty: null } })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.reason, 'third_party_consent_missing')
  assert.strictEqual(calls.fetched.length, 0, 'mail is not read if it cannot be used')
  assert.strictEqual(calls.model, 0)
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('a KNOWN contact: a summary of what was actually discussed')

test('the draft is grounded in the body, not the subject', async () => {
  const { calls, params } = run()
  const r = await summarizeConversation(params)
  assert.strictEqual(r.outcome, 'interaction_draft', JSON.stringify(r))
  assert.strictEqual(r.contactId, CONTACT_ID)
  assert.strictEqual(calls.fetched.length, 2, 'both selected messages were read')
  assert.strictEqual(calls.model, 1, 'exactly one model call')
  // THE POINT OF THE WHOLE SLICE: the note says what was discussed.
  assert.ok(/analyst programme/i.test(r.summary), r.summary)
  assert.ok(/CV/.test(r.summary), r.summary)
  assert.ok(r.summary.length > 60, 'a real summary, not a label')
  assert.strictEqual(r.followUp, 'Send the updated CV and state your track preference.')
  assert.strictEqual(r.interactionDate, '2026-09-22')
  assert.strictEqual(r.extractionStatus, 'ai_extracted')
  assert.strictEqual(r.messagesSummarized, 2)
  assert.strictEqual(r.messagesInExchange, 2)
})

test('the REQUEST carries the body but NO address and no provider id', async () => {
  const { calls, params } = run()
  await summarizeConversation(params)
  const body = calls.requests[0]
  const s = JSON.stringify(body)
  // The content IS sent - that is the point.
  assert.ok(s.includes('analyst programme'), 'the sanitized body must be sent')
  // But nothing identifying.
  for (const leak of [ME, THEM, 'goldman.test', 'outlook.test', 'AAkALgAA', CFP]) {
    assert.ok(!s.includes(leak), `the request leaked ${leak}`)
  }
  assert.ok(!s.includes('SEAL:'), 'no handle ciphertext')
  // Participants are pseudonymous labels.
  assert.ok(s.includes('USER') && s.includes('CONTACT'))
})

test('NO RAW OR SANITIZED BODY COMES BACK in the result', async () => {
  const { params } = run()
  const r = await summarizeConversation(params)
  const s = JSON.stringify(r)
  // A distinctive sentence from the fixture body must not be echoed. The
  // model's summary is a different string and is allowed.
  assert.ok(!s.includes('Could you send'), 'the raw body leaked into the result')
  assert.ok(!s.includes('modelling work I did last summer'), 'the outbound body leaked')
  assert.ok(!s.includes(THEM), 'the address leaked into a known-contact result')
  assert.deepStrictEqual(Object.keys(r).sort(), [
    'contactId', 'extractionStatus', 'fetched', 'followUp', 'interactionDate',
    'messagesInExchange', 'messagesSummarized', 'outcome', 'retainedSubject', 'summary',
  ])
})

test('the logged pass summary is counts and codes only', async () => {
  const { params } = run()
  const log = JSON.stringify(summarizePassResult(await summarizeConversation(params)))
  for (const leak of ['analyst', 'CV', ME, THEM, 'Summer']) {
    assert.ok(!log.includes(leak), `the log leaked ${leak}`)
  }
  assert.ok(log.includes('"outcome":"interaction_draft"'))
  assert.ok(log.includes('"has_follow_up":true'))
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('an UNKNOWN person: a proposed contact AND the interaction, together')

test('the proposal carries the draft, and the email comes from the ENVELOPE', async () => {
  const { calls, params } = run({
    conversation: { cfp: CFP, contactId: null, messageCount: 2, lastLocalDate: '2026-09-22' },
    callModel: async ({ body }) => { calls.requests.push(body); return newContactReply() },
  })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.outcome, 'new_contact_suggestion', JSON.stringify(r))
  // THE ADDRESS IS THE ENVELOPE'S. The draft schema has no address field at all.
  assert.strictEqual(r.proposedEmail, THEM)
  assert.strictEqual(r.proposedName, 'Priya Sharma')
  assert.strictEqual(r.nameEvidence, 'explicit_signature')
  assert.strictEqual(r.nameConfidence, 'high')
  // And the interaction travels WITH it, so one acceptance creates both.
  assert.ok(/analyst programme/i.test(r.summary), r.summary)
  assert.strictEqual(r.followUp, 'Send the updated CV before Friday.')
  assert.strictEqual(r.interactionDate, '2026-09-22')
})

test('UNSUPPORTED contact fields are left blank, not stored unreviewed', async () => {
  // upsert_new_contact_candidate accepts none of company/role/how_met/linkedin/
  // tags, so a model that fills them must not have them silently carried.
  const { calls, params } = run({
    conversation: { cfp: CFP, contactId: null, messageCount: 2, lastLocalDate: '2026-09-22' },
    callModel: async () => newContactReply({
      company: 'Goldman Sachs', company_evidence: 'explicit_signature',
      company_confidence: 'high',
      role: 'Analyst', role_evidence: 'explicit_signature', role_confidence: 'high',
      tags: ['recruiter'],
    }),
  })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.outcome, 'new_contact_suggestion')
  const s = JSON.stringify(r)
  assert.ok(!s.includes('Goldman Sachs'), 'company must not be carried')
  assert.ok(!s.includes('Analyst'), 'role must not be carried')
  assert.ok(!s.includes('recruiter'), 'tags must not be carried')
  assert.strictEqual(r.company, undefined)
  assert.strictEqual(r.role, undefined)
  assert.strictEqual(r.tags, undefined)
  void calls
})

test('a model name with no evidence falls back to the provider display name', async () => {
  const { params } = run({
    conversation: { cfp: CFP, contactId: null, messageCount: 2, lastLocalDate: '2026-09-22' },
    callModel: async () => newContactReply({ name: null, name_evidence: null,
      name_confidence: null }),
  })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.proposedName, 'Priya Sharma', 'from the envelope display name')
  assert.strictEqual(r.nameEvidence, 'provider_metadata', 'with the evidence that is true')
  assert.strictEqual(r.nameConfidence, 'high')
})

test('more than one external person is DEFERRED, never guessed', async () => {
  // A genuine two-external-party thread: the reply went to Priya AND a second
  // person, so there is no single counterparty to propose as a contact. Handle 2
  // is in sentitems, so its counterparty is read from toRecipients.
  const { calls, params } = run({
    conversation: { cfp: CFP, contactId: null, messageCount: 2, lastLocalDate: '2026-09-22' },
    fetchMessage: async (id) => {
      calls.fetched.push(id)
      if (id.endsWith('1')) return fixtureMessage({ dir: 'inbound', text: INBOUND_TEXT })
      const m = fixtureMessage({ dir: 'outbound', text: OUTBOUND_TEXT })
      m.message.toRecipients = [addr(THEM, 'Priya Sharma'),
        addr('someone.else@firm.test', 'Someone Else')]
      return m
    },
  })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.reason, 'ambiguous_counterparty', JSON.stringify(r))
  assert.strictEqual(calls.model, 0, 'and no model call is made for it')
})

test('counterpartyFromEnvelopes reads the right side of each message', () => {
  const inbound = { direction: 'inbound', from: addr(THEM, 'Priya'), toRecipients: [addr(ME, 'P')] }
  const outbound = { direction: 'outbound', from: addr(ME, 'P'), toRecipients: [addr(THEM, 'Priya')] }
  assert.deepStrictEqual(counterpartyFromEnvelopes([inbound, outbound], [ME]),
    { ok: true, address: THEM, displayName: 'Priya' })
  // Self on both sides: nobody to propose.
  assert.strictEqual(counterpartyFromEnvelopes(
    [{ direction: 'inbound', from: addr(ME, 'P'), toRecipients: [] }], [ME]).reason,
    'counterparty_unusable')
  // A malformed address is unusable rather than stored.
  assert.strictEqual(counterpartyFromEnvelopes(
    [{ direction: 'inbound', from: addr('not-an-address', 'X'), toRecipients: [] }], [ME]).reason,
    'counterparty_unusable')
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('failures are stated deferrals, never an empty note')

test('a body that cannot be fetched DEFERS, and says so', async () => {
  // This is the archive-mailbox-move and export/re-import case: the immutable id
  // stops resolving.
  const { calls, params } = run({
    fetchMessage: async (id) => { calls.fetched.push(id); return { ok: false, code: 'not_found' } },
  })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.outcome, 'defer')
  assert.strictEqual(r.reason, 'fetch_failed')
  assert.strictEqual(calls.model, 0)
  assert.strictEqual(r.summary, undefined, 'NO note may accompany a deferral')
})

test('a thrown fetch error is not read, and still defers', async () => {
  const { params } = run({
    fetchMessage: async () => { throw new Error('https://graph.microsoft.com/secret?token=abc') },
  })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.reason, 'fetch_failed')
  const s = JSON.stringify(r)
  assert.ok(!s.includes('token'), 'the thrown message must not reach the result')
  assert.ok(!s.includes('graph.microsoft.com'))
})

test('bodies that sanitize to nothing DEFER rather than writing an empty note', async () => {
  const { params } = run({
    fetchMessage: async () => fixtureMessage({ dir: 'inbound', text: '   ' }),
  })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.reason, 'no_usable_content')
  assert.strictEqual(r.summary, undefined)
})

test('NO HANDLES is a stated deferral', async () => {
  const r = await summarizeConversation(run({ handles: [] }).params)
  assert.strictEqual(r.reason, 'no_handles')
})

test('a provider failure after its own retries DEFERS and is retryable', async () => {
  const { params } = run({ callModel: async () => ({ ok: false, code: 'provider_unavailable' }) })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.reason, 'model_unavailable')
  assert.strictEqual(r.code, 'provider_unavailable')
  assert.strictEqual(r.summary, undefined)
})

test('a response the STRICT validator rejects DEFERS, not writes', async () => {
  for (const bad of [
    { result: 'interaction_draft', summary: null },
    { result: 'interaction_draft', summary: 'x', email: 'sneaky@firm.test' },
    { result: 'nonsense' },
    { result: 'interaction_draft', summary: 'x', interaction_date: '1999-01-01' },
  ]) {
    const { params } = run({ callModel: async () => ({ ok: true, value: bad }) })
    const r = await summarizeConversation(params)
    assert.strictEqual(r.outcome, 'defer', JSON.stringify(bad))
    assert.strictEqual(r.reason, 'model_output_invalid', JSON.stringify(bad))
  }
})

test('a blank summary that somehow passed validation is still refused', async () => {
  const { params } = run({
    callModel: async () => modelReply({ summary: '    ' }),
  })
  const r = await summarizeConversation(params)
  assert.ok(r.outcome === 'defer', JSON.stringify(r))
  assert.strictEqual(r.summary, undefined, 'the empty note is the original complaint')
})

test('bulk and list mail is IGNORED, from the headers of the same fetch', async () => {
  for (const automation of [{ hasListId: true }, { hasListUnsubscribe: true },
    { precedence: 'bulk' }]) {
    const { calls, params } = run({
      fetchMessage: async () => fixtureMessage({ dir: 'inbound', text: INBOUND_TEXT, automation }),
    })
    const r = await summarizeConversation(params)
    assert.strictEqual(r.outcome, 'ignore', JSON.stringify(automation))
    assert.strictEqual(r.reason, 'bulk_or_list_mail')
    assert.strictEqual(calls.model, 0, 'a newsletter is never summarized')
  }
})

test('an ABSENT header collection is not mistaken for "no automation"', async () => {
  const { params } = run({
    fetchMessage: async () => fixtureMessage({ dir: 'inbound', text: INBOUND_TEXT,
      automation: {}, automationComplete: false }),
  })
  const r = await summarizeConversation(params)
  // It proceeds rather than claiming the mail is clean, because the headers were
  // not there to check. The envelope pass has already screened the exchange.
  assert.strictEqual(r.outcome, 'interaction_draft')
})

test('every reason is drawn from the declared vocabularies', async () => {
  const cases = [
    run({ consentVersion: ENVELOPE_ONLY }),
    run({ handles: [] }),
    run({ fetchMessage: async () => ({ ok: false }) }),
    run({ fetchMessage: async () => fixtureMessage({ dir: 'inbound', text: ' ' }) }),
    run({ callModel: async () => ({ ok: false, code: 'x' }) }),
    run({ callModel: async () => ({ ok: true, value: { result: 'nonsense' } }) }),
    run({ budgetAllows: () => false }),
  ]
  for (const c of cases) {
    const r = await summarizeConversation(c.params)
    assert.ok(PASS_OUTCOMES.includes(r.outcome), String(r.outcome))
    if (r.outcome === 'defer') assert.ok(DEFER_REASONS.includes(r.reason), String(r.reason))
    if (r.outcome === 'ignore') assert.ok(IGNORE_REASONS.includes(r.reason), String(r.reason))
  }
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('the invocation budget, and resuming without skipped work')

test('running out before the first fetch defers with nothing read', async () => {
  const { calls, params } = run({ budgetAllows: () => false })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.reason, 'budget_exhausted')
  assert.strictEqual(r.fetched, 0)
  assert.strictEqual(calls.fetched.length, 0)
  assert.strictEqual(calls.model, 0)
})

test('running out MID-CONVERSATION reports how far it got, and writes nothing', async () => {
  let allowed = 1
  const { calls, params } = run({
    handles: handlesFor(4),
    budgetAllows: () => allowed-- > 0,
  })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.reason, 'budget_exhausted')
  assert.strictEqual(r.fetched, 1, 'one body was read before the budget ran out')
  assert.strictEqual(calls.model, 0, 'and no partial summary was attempted')
  assert.strictEqual(r.summary, undefined)
})

test('the SAME conversation resumes completely on the next invocation', async () => {
  // Retryable means retryable: the handles are untouched, so a later invocation
  // redoes the whole conversation and skips nothing.
  let allowed = 1
  const first = run({ handles: handlesFor(2), budgetAllows: () => allowed-- > 0 })
  const r1 = await summarizeConversation(first.params)
  assert.strictEqual(r1.reason, 'budget_exhausted')

  const second = run({ handles: handlesFor(2) })        // same handles, fresh budget
  const r2 = await summarizeConversation(second.params)
  assert.strictEqual(r2.outcome, 'interaction_draft')
  assert.strictEqual(second.calls.fetched.length, 2, 'every message is read, none skipped')
  assert.ok(/analyst programme/i.test(r2.summary))
})

test('at most six bodies are fetched for one conversation', async () => {
  const { calls, params } = run({ handles: handlesFor(10) })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.outcome, 'interaction_draft')
  assert.ok(calls.fetched.length <= MAX_FETCH_PER_CONVERSATION,
    `fetched ${calls.fetched.length}`)
  assert.strictEqual(calls.fetched.length, 6)
})

test('a partial selection is reported honestly against the full exchange', async () => {
  const { params } = run({
    handles: handlesFor(6),
    conversation: { cfp: CFP, contactId: CONTACT_ID, messageCount: 11,
      lastLocalDate: '2026-09-22' },
  })
  const r = await summarizeConversation(params)
  assert.strictEqual(r.messagesSummarized, 6)
  assert.strictEqual(r.messagesInExchange, 11,
    'the reviewer can be told this is 6 of 11, rather than being misled')
})

await Promise.all(pending)
console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exitCode = 1
