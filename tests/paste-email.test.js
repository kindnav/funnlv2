// Paste an email (Pro) - the server module supabase/functions/shared/pasteEmail.js.
//
// Run with: node tests/paste-email.test.js
//
// Covers: input bounds, address extraction from ambiguous multi-participant threads, masking,
// the minimization refusal (no model call), date decisions for quoted / multiple / zone-less /
// numeric headers, Pro enforcement before anything else, validation of BOTH model outputs,
// and that no response or log line carries the pasted text or raw model output.

import { strict as assert } from 'assert'
import { test } from 'node:test'
import { readFileSync } from 'fs'
import {
  normalizePaste, extractAddresses, maskAddresses, parseHeaderDate, detectInteractionDate,
  buildContactRequest, buildNoteRequest, validateContactFields, validateNote, handlePasteEmail,
  AI_FILL_INSTRUCTIONS, CONTACT_SYSTEM_RULES, MAX_PASTE_CHARS, MAX_ADDRESSES, PASTE_CODES,
} from '../supabase/functions/shared/pasteEmail.js'
import { SYSTEM_CONTRACT, DRAFT_MODEL } from '../supabase/functions/shared/outlookDraftContract.js'

const NL = String.fromCharCode(10)
const MARK = 'ZQXRAWPASTEMARKER'
const NOW = new Date('2026-10-13T15:00:00.000Z')
const PLACEHOLDER = '2026-10-13'

// A realistic, deliberately ambiguous thread: the user's own address, two recipients, a
// signature address and quoted history from a third person.
const THREAD = [
  'From: Me Student <me@school.edu>',
  'To: Priya Shah <Priya.Shah@goldman.example>',
  'Cc: Sam Lee <sam@club.example>',
  'Date: Tue, 13 Oct 2026 14:05:00 -0400',
  'Subject: Thanks for the chat',
  '',
  `Hi Priya, thanks for the coffee chat. ${MARK}`,
  '',
  'Best,',
  'Me',
  'Treasurer, Finance Club | treasurer@club.example',
  '',
  'On Mon, Oct 12, 2026 at 9:00 AM Priya Shah <priya.shah@goldman.example> wrote:',
  '> Happy to talk tomorrow.',
].join(NL)

const SINGLE = [
  'From: Priya Shah <priya@goldman.example>',
  'To: me@school.edu',
  'Date: Tue, 13 Oct 2026 14:05:00 -0400',
  '',
  `Great to meet you. ${MARK}`,
].join(NL)

const GOOD_NOTE = { result: 'interaction_draft', summary: 'Priya thanked the user for the coffee chat.', summary_evidence: 'explicit_body', follow_up: 'Send a thank-you note', interaction_date: PLACEHOLDER }
const GOOD_CONTACT = { name: 'Priya Shah', company: 'Goldman Sachs', role: 'Analyst', how_met: 'Coffee chat', linkedin_url: null, relationship_note: null, tags: ['finance'] }

function deps (over = {}) {
  const calls = []
  const logs = []
  return {
    calls, logs,
    loadEntitlement: async () => ({ canUse: true }),
    callModel: async (body) => {
      calls.push(body)
      const isNote = body.system === SYSTEM_CONTRACT
      return { ok: true, parsed: isNote ? GOOD_NOTE : GOOD_CONTACT }
    },
    log: (event, fields) => logs.push(JSON.stringify([event, fields])),
    now: () => NOW,
    ...over,
  }
}

// ── Input ──────────────────────────────────────────────────────────────────────

test('normalizePaste: type, empty, length bound, line endings', () => {
  assert.deepEqual(normalizePaste(42), { ok: false, code: 'bad_type' })
  assert.deepEqual(normalizePaste('   '), { ok: false, code: 'empty' })
  assert.deepEqual(normalizePaste('x'.repeat(MAX_PASTE_CHARS + 1)), { ok: false, code: 'too_long' })
  assert.equal(normalizePaste('x'.repeat(MAX_PASTE_CHARS)).ok, true)
  const cr = String.fromCharCode(13)
  assert.equal(normalizePaste('a' + cr + NL + 'b').text, 'a' + NL + 'b')
})

// ── Ambiguous participants ─────────────────────────────────────────────────────

test('extractAddresses: every participant, header first, lower-cased, de-duplicated', () => {
  const a = extractAddresses(THREAD)
  assert.deepEqual(a.map((x) => x.address), ['me@school.edu', 'priya.shah@goldman.example', 'sam@club.example', 'treasurer@club.example'])
  assert.deepEqual(a.map((x) => x.inHeader), [true, true, true, false])
})

test('extractAddresses: obfuscated forms are found, and the list is bounded', () => {
  const t = ['alice&#64;a.example', 'bob&#x40;b.example', 'carol&commat;c.example', 'dan%40d.example', 'mailto:erin@e.example'].join(' ')
  assert.deepEqual(extractAddresses(t).map((x) => x.address), ['alice@a.example', 'bob@b.example', 'carol@c.example', 'dan@d.example', 'erin@e.example'])
  const many = Array.from({ length: MAX_ADDRESSES + 5 }, (_, i) => `p${i}@x.example`).join(' ')
  assert.equal(extractAddresses(many).length, MAX_ADDRESSES)
})

test('handler: an ambiguous thread returns ALL addresses and picks no person', async () => {
  const d = deps()
  const r = await handlePasteEmail({ text: THREAD }, d)
  assert.equal(r.status, 200)
  assert.equal(r.json.addresses.length, 4)
  for (const k of ['person', 'contact_id', 'email', 'selected']) assert.equal(k in r.json, false, k)
  assert.equal('email' in r.json.contact.fields, false)
})

test('handler: a model-supplied email or an address inside a field never reaches the response', async () => {
  const d = deps({
    callModel: async (body) => body.system === SYSTEM_CONTRACT
      ? { ok: true, parsed: GOOD_NOTE }
      : { ok: true, parsed: { ...GOOD_CONTACT, email: 'priya@goldman.example', role: 'Analyst, priya@goldman.example' } },
  })
  const r = await handlePasteEmail({ text: SINGLE }, d)
  assert.equal(r.json.contact.fields.email, undefined)
  assert.equal(r.json.contact.fields.role, undefined)
  assert.deepEqual(r.json.contact.dropped, ['role'])
})

// ── Masking and the minimization gate ──────────────────────────────────────────

test('requests carry no found address in any recognised form, and mark content untrusted', async () => {
  const text = THREAD + NL + 'Also dan%40d.example and erin&#64;e.example'
  const d = deps()
  await handlePasteEmail({ text }, d)
  assert.equal(d.calls.length, 2)
  for (const body of d.calls) {
    const s = JSON.stringify(body).toLowerCase()
    for (const a of extractAddresses(text)) {
      const [local, domain] = a.address.split('@')
      assert.equal(s.includes(a.address), false, a.address)
      assert.equal(s.includes(local + '%40' + domain), false)
      assert.equal(s.includes(local + '&#64;' + domain), false)
    }
    assert.ok(s.includes('[email removed]'))
    assert.ok(JSON.stringify(body).includes('=== BEGIN UNTRUSTED EMAIL CONTENT ==='))
    assert.equal(body.model, DRAFT_MODEL)
  }
})

test('minimization refusal: a token in the paste is refused with NO model call', async () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl'
  for (const secret of [jwt, 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789']) {
    const d = deps()
    const r = await handlePasteEmail({ text: SINGLE + NL + secret }, d)
    assert.equal(r.status, 422)
    assert.equal(r.json.code, 'minimization_refused')
    assert.ok(r.json.found.includes('token'))
    assert.equal(d.calls.length, 0)
    const out = JSON.stringify(r) + d.logs.join('')
    assert.equal(out.includes(MARK), false)
    assert.equal(out.includes('eyJ'), false)
    assert.equal(out.includes('abcdefghij'), false)
  }
})

test('maskAddresses is the unchanged Outlook redactor', () => {
  assert.equal(maskAddresses('write to a@b.example'), 'write to [email removed]')
})

// ── Pro enforcement ────────────────────────────────────────────────────────────

test('Pro: a non-Pro caller is refused before the paste is even read, with no model call', async () => {
  const d = deps({ loadEntitlement: async () => ({ canUse: false }) })
  const r = await handlePasteEmail({ text: SINGLE }, d)
  assert.deepEqual(r, { status: 403, json: { code: 'pro_required' } })
  assert.equal(d.calls.length, 0)
  const r2 = await handlePasteEmail({ text: '' }, deps({ loadEntitlement: async () => ({ canUse: false }) }))
  assert.equal(r2.status, 403)
})

test('Pro: an entitlement lookup failure is 500, not a lock-out and not a pass', async () => {
  const d = deps({ loadEntitlement: async () => ({ canUse: false, error: true }) })
  const r = await handlePasteEmail({ text: SINGLE }, d)
  assert.deepEqual(r, { status: 500, json: { code: 'entitlement_unavailable' } })
  assert.equal(d.calls.length, 0)
})

test('Pro: anything but canUse === true is refused', async () => {
  for (const ent of [{}, { canUse: 'true' }, { canUse: 1 }, null]) {
    const d = deps({ loadEntitlement: async () => ent })
    assert.equal((await handlePasteEmail({ text: SINGLE }, d)).status, 403)
    assert.equal(d.calls.length, 0)
  }
})

test('the Edge Function checks auth and entitlement server-side and requires a JWT', () => {
  const src = readFileSync(new URL('../supabase/functions/ai-paste-email/index.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('auth.getUser()'))
  assert.ok(src.includes('loadProEntitlement') && src.includes('evaluateProEntitlement'))
  assert.equal(src.includes('console.log'), false)
  const cfg = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8').split(String.fromCharCode(13)).join('')
  assert.ok(cfg.includes('[functions.ai-paste-email]' + NL + 'verify_jwt = true'))
})

// ── Dates ──────────────────────────────────────────────────────────────────────

test('dates: a single unquoted header with an offset is a clear instant', () => {
  assert.deepEqual(detectInteractionDate(SINGLE), { status: 'clear', kind: 'instant', value: '2026-10-13T18:05:00.000Z' })
  assert.deepEqual(parseHeaderDate('Tuesday, October 13, 2026 2:05 PM GMT'), { status: 'clear', kind: 'instant', value: '2026-10-13T14:05:00.000Z' })
  assert.deepEqual(parseHeaderDate('2026-10-13'), { status: 'clear', kind: 'date', value: '2026-10-13' })
  assert.deepEqual(parseHeaderDate('October 13, 2026'), { status: 'clear', kind: 'date', value: '2026-10-13' })
})

test('dates: quoted history makes even a single top header ambiguous', () => {
  assert.deepEqual(detectInteractionDate(THREAD), { status: 'ambiguous', reason: 'quoted_history' })
  const fwd = ['---------- Forwarded message ---------', 'Date: Tue, 13 Oct 2026 14:05:00 -0400', 'hello'].join(NL)
  assert.equal(detectInteractionDate(fwd).reason, 'quoted_history')
  const quoted = ['hi', '> Date: Tue, 13 Oct 2026 14:05:00 -0400'].join(NL)
  assert.equal(detectInteractionDate(quoted).reason, 'quoted_history')
  assert.equal(detectInteractionDate(['-----Original Message-----', 'Sent: Monday, October 12, 2026 9:00 AM'].join(NL)).reason, 'quoted_history')
})

test('dates: several Date/Sent headers never pick one', () => {
  const t = ['Date: Tue, 13 Oct 2026 14:05:00 -0400', 'body', 'Sent: Monday, October 12, 2026 9:00 AM -0400'].join(NL)
  assert.deepEqual(detectInteractionDate(t), { status: 'ambiguous', reason: 'multiple_dates' })
})

test('dates: zone-less, abbreviation-only, numeric and impossible dates are left for review', () => {
  assert.equal(parseHeaderDate('Tuesday, October 13, 2026 11:30 PM').reason, 'no_timezone')
  assert.equal(parseHeaderDate('Tue, 13 Oct 2026 23:30 EDT').reason, 'no_timezone')
  assert.equal(parseHeaderDate('2026-10-13T23:30:00').reason, 'no_timezone')
  assert.equal(parseHeaderDate('10/11/2026').reason, 'numeric_format')
  assert.equal(parseHeaderDate('11.10.2026 09:00').reason, 'numeric_format')
  assert.equal(parseHeaderDate('February 30, 2026').reason, 'invalid_date')
  assert.equal(parseHeaderDate('sometime last week').reason, 'unrecognised')
  assert.deepEqual(detectInteractionDate('no headers at all'), { status: 'none' })
})

test('dates: the response date comes from the paste, never from the model', async () => {
  const d = deps({
    callModel: async (body) => body.system === SYSTEM_CONTRACT
      ? { ok: true, parsed: { ...GOOD_NOTE, interaction_date: PLACEHOLDER } }
      : { ok: true, parsed: GOOD_CONTACT },
  })
  const r = await handlePasteEmail({ text: THREAD }, d)
  assert.deepEqual(r.json.date, { status: 'ambiguous', reason: 'quoted_history' })
  assert.deepEqual(Object.keys(r.json.note).sort(), ['follow_up', 'summary'])
})

// ── Validating both model outputs ──────────────────────────────────────────────

test('contact fields: each failing field is dropped (never truncated); unknown keys ignored', () => {
  const v = validateContactFields({
    name: 'Priya Shah',
    company: 'x'.repeat(500),
    role: 'See https://example.com',
    how_met: 'Met at' + String.fromCharCode(7) + 'fair',
    relationship_note: 'Mentioned her immigration status',
    linkedin_url: 'https://evil.example/in/priya',
    tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    email: 'priya@goldman.example',
  })
  assert.equal(v.ok, true)
  assert.deepEqual(v.fields, { name: 'Priya Shah', tags: ['a', 'b', 'c', 'd', 'e'] })
  assert.deepEqual(v.dropped, { company: 'too_long', role: 'url', how_met: 'control_characters', relationship_note: 'sensitive_inference', linkedin_url: 'url' })
  assert.equal(validateContactFields({ linkedin_url: 'https://www.linkedin.com/in/priya-shah' }).fields.linkedin_url, 'https://www.linkedin.com/in/priya-shah')
  assert.equal(validateContactFields({ name: '[email removed]' }).dropped.name, 'address')
})

test('contact fields: non-objects and prototype keys are refused outright', () => {
  assert.equal(validateContactFields(null).code, 'not_object')
  assert.equal(validateContactFields([]).code, 'not_object')
  assert.equal(validateContactFields(JSON.parse('{"__proto__":{"x":1},"name":"A"}')).code, 'prototype_pollution')
})

test('note: the Outlook validator decides; ignore/defer/invalid are not drafts', () => {
  assert.deepEqual(validateNote(GOOD_NOTE, PLACEHOLDER), { ok: true, note: { summary: GOOD_NOTE.summary, follow_up: GOOD_NOTE.follow_up } })
  assert.equal(validateNote({ result: 'ignore' }, PLACEHOLDER).code, 'note_ignore')
  assert.equal(validateNote({ result: 'defer' }, PLACEHOLDER).code, 'note_defer')
  assert.equal(validateNote({ ...GOOD_NOTE, extra: 1 }, PLACEHOLDER).code, 'note_extra_keys')
  assert.equal(validateNote({ ...GOOD_NOTE, interaction_date: '2020-01-01' }, PLACEHOLDER).code, 'note_bad_date')
  assert.equal(validateNote({ ...GOOD_NOTE, summary: 'x'.repeat(2001) }, PLACEHOLDER).code, 'note_too_long')
})

test('handler: one failed half still returns the other; both failed is 502', async () => {
  const half = deps({ callModel: async (b) => b.system === SYSTEM_CONTRACT ? { ok: false, code: 'provider_error' } : { ok: true, parsed: GOOD_CONTACT } })
  const r1 = await handlePasteEmail({ text: SINGLE }, half)
  assert.equal(r1.status, 200)
  assert.equal(r1.json.note, null)
  assert.equal(r1.json.note_code, 'note_provider_error')

  const none = deps({ callModel: async () => ({ ok: true, parsed: 'not an object' }) })
  const r2 = await handlePasteEmail({ text: SINGLE }, none)
  assert.equal(r2.status, 502)
  assert.equal(r2.json.code, 'drafting_failed')
  assert.ok(none.logs.some((l) => l.includes('"drafting_failed"')))
})

test('nothing returned or logged carries the paste or raw model output', async () => {
  const leaky = 'LEAKYMODELTEXT'
  const d = deps({ callModel: async (b) => b.system === SYSTEM_CONTRACT ? { ok: true, parsed: { result: leaky } } : { ok: true, parsed: { name: null, junk: leaky } } })
  const r = await handlePasteEmail({ text: THREAD }, d)
  const out = JSON.stringify(r.json) + d.logs.join('')
  assert.equal(out.includes(MARK), false)
  assert.equal(out.includes(leaky), false)
  for (const line of d.logs) assert.equal(line.includes('@'), false)
  for (const line of d.logs) {
    const [, fields] = JSON.parse(line)
    assert.ok(PASTE_CODES.includes(fields.code), fields.code)
  }
})

test('input errors map to 400 / 413 after the Pro check', async () => {
  assert.equal((await handlePasteEmail({ text: 5 }, deps())).status, 400)
  assert.equal((await handlePasteEmail({ text: '' }, deps())).status, 400)
  assert.equal((await handlePasteEmail({ text: 'x'.repeat(MAX_PASTE_CHARS + 1) }, deps())).status, 413)
})

// ── Reuse, not re-invention ────────────────────────────────────────────────────

test('contact instructions are AI Fill instructions, verbatim', () => {
  const src = readFileSync(new URL('../supabase/functions/ai-parse-contact/index.ts', import.meta.url), 'utf8').split(String.fromCharCode(13)).join('')
  const a = src.indexOf('Parse the following text about a person into contact fields.')
  const b = src.indexOf(NL + NL + 'Text: ${JSON.stringify(text)}')
  assert.ok(a > 0 && b > a)
  assert.equal(src.slice(a, b), AI_FILL_INSTRUCTIONS)
  assert.ok(buildContactRequest('x').messages[0].content.startsWith(AI_FILL_INSTRUCTIONS))
})

test('contact system rules are the drafting contract absolute rules, derived not copied', () => {
  assert.ok(SYSTEM_CONTRACT.startsWith(CONTACT_SYSTEM_RULES))
  assert.equal(CONTACT_SYSTEM_RULES.includes('WHAT THE SUMMARY MUST RECORD'), false)
  assert.ok(CONTACT_SYSTEM_RULES.length > 500)
  assert.equal(buildNoteRequest('x', PLACEHOLDER).system, SYSTEM_CONTRACT)
})
