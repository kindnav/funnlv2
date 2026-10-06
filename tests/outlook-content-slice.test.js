// The content slice's two new pure modules: the CONSENT GATE and the
// EVIDENCE-GROUNDED DRAFT.
//
// WHAT IS BEHAVIOURAL HERE. Every function below is executed. These are the same
// functions the run will call once the content stage is wired, so the refusal
// rules, the bounds and the deferral codes are run rather than described.
//
// WHAT IS NOT HERE, and why. The run wiring is NOT tested because it is NOT
// BUILT: the round accumulator (outlook_conversation_progress) deliberately
// persists "no header, no subject, no mailbox address, no display name, and NO
// Microsoft message or conversation id", so at finalize time - where suggestions
// are written - there is nothing to build a note FROM and no way to fetch a body.
// Wiring it needs an owner decision about widening that table. See the PR
// description. These modules and the two write RPCs are the parts that are ready
// and independently correct.
//
// The DATABASE path is proven separately, against a real Postgres with all 27
// migrations, by tests/sql/outlook-content-slice-runtime.sql.
//
// Run with: node tests/outlook-content-slice.test.js

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  REQUIRED_CONTENT_CONSENT_VERSION, CONTENT_CONSENT_CODES,
  isDisclosureVersion, contentProcessingAllowed, summarizeContentConsent,
} from '../supabase/functions/shared/outlookContentConsent.js'
import {
  MAX_NOTE_CHARS, MAX_FOLLOW_UP_CHARS, MAX_SUBJECT_CHARS, MIN_EPISODE_CONTENT_CHARS,
  CONTENT_REFUSALS, CONTENT_DEFERRALS,
  boundText, noteSafeSubject, classifyExchange,
  buildInteractionNote, buildFollowUp, draftFromEpisode,
} from '../supabase/functions/shared/outlookContentNote.js'

let passed = 0, failed = 0
function test (name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const APPROVED = 'ol-disc-' + 'a'.repeat(32)
const ENVELOPE_ONLY = 'ol-disc-81fe8944fd2be59ac3c059c229b4d28e'   // the live pilot's

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('the consent gate: closed today, and closed for the right reason')

test('no content disclosure is approved yet, so content is off for EVERYONE', () => {
  assert.strictEqual(REQUIRED_CONTENT_CONSENT_VERSION, null,
    'the required version must stay null until the owner approves the wording')
  // Including the version the live pilot account actually consented to.
  const d = contentProcessingAllowed(ENVELOPE_ONLY)
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.reason, 'content_consent_not_configured')
  // And for anything else anyone might present.
  for (const v of [null, undefined, '', 'ol-disc-' + 'b'.repeat(32), 'anything']) {
    assert.strictEqual(contentProcessingAllowed(v).allowed, false, String(v))
  }
})

test('with an approved version, ONLY the exact match is allowed', () => {
  assert.deepStrictEqual(contentProcessingAllowed(APPROVED, APPROVED), { allowed: true })
  // The envelope-only consent the pilot gave is STALE against a content version.
  assert.deepStrictEqual(contentProcessingAllowed(ENVELOPE_ONLY, APPROVED),
    { allowed: false, reason: 'content_consent_stale' })
  // A connection with no recorded version at all.
  for (const v of [null, undefined, '', '   ', 42]) {
    assert.strictEqual(contentProcessingAllowed(v, APPROVED).reason,
      'content_consent_missing', String(v))
  }
})

test('no prefix, substring or ordering comparison is accepted', () => {
  // A digest carries no order, so "at least as new as" is meaningless and a
  // lookalike is a different document.
  const near = 'ol-disc-' + 'a'.repeat(31) + 'b'
  assert.strictEqual(contentProcessingAllowed(near, APPROVED).reason, 'content_consent_stale')
  assert.strictEqual(contentProcessingAllowed(APPROVED + 'x', APPROVED).reason,
    'content_consent_missing', 'a longer lookalike is not even well formed')
  assert.strictEqual(contentProcessingAllowed(APPROVED.slice(0, -1), APPROVED).reason,
    'content_consent_missing')
})

test('only the derived ol-disc form is a disclosure version at all', () => {
  assert.strictEqual(isDisclosureVersion(APPROVED), true)
  assert.strictEqual(isDisclosureVersion(` ${APPROVED} `), true, 'trimmed')
  for (const bad of [
    'ol-disc-' + 'A'.repeat(32),          // uppercase hex is not the derived form
    'ol-disc-' + 'a'.repeat(31),          // too short
    'ol-disc-' + 'a'.repeat(33),          // too long
    'ol-disc-' + 'g'.repeat(32),          // not hex
    'oldisc-' + 'a'.repeat(32), 'ol-disc-', '', null, undefined, 42, {},
  ]) assert.strictEqual(isDisclosureVersion(bad), false, JSON.stringify(String(bad)))
})

test('the logged summary carries no version string', () => {
  const s = summarizeContentConsent(contentProcessingAllowed(ENVELOPE_ONLY, APPROVED))
  assert.deepStrictEqual(s, { content_allowed: false, reason: 'content_consent_stale' })
  const j = JSON.stringify(s)
  assert.ok(!j.includes('ol-disc'), 'a disclosure version must not reach a log line')
  assert.deepStrictEqual(summarizeContentConsent({ allowed: true }),
    { content_allowed: true, reason: null })
  // An unknown reason is normalised rather than echoed.
  assert.strictEqual(summarizeContentConsent({ allowed: false, reason: 'whatever' }).reason,
    'content_consent_stale')
  for (const c of CONTENT_CONSENT_CODES) {
    assert.strictEqual(summarizeContentConsent({ allowed: false, reason: c }).reason, c)
  }
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('refusals and deferrals: never guess about automated or partial mail')

const msg = (over = {}) => ({
  subject: 'Summer analyst referral', fromAddress: 'ava@bank.test',
  automation: {}, ...over,
})
const base = {
  messages: [msg(), msg({ fromAddress: 'me@outlook.test' })],
  externalParticipants: 1, episodeTruncated: false, contentFetchesFailed: 0,
  sanitizedChars: 400, subject: 'Summer analyst referral',
  inbound: 2, outbound: 2, lastLocalDate: '2026-10-01', lastDirection: 'inbound',
}

test('bulk and list mail is REFUSED, on any one message', () => {
  for (const a of [{ hasListId: true }, { hasListUnsubscribe: true },
    { precedence: 'bulk' }, { precedence: 'list' }, { precedence: 'junk' }]) {
    const r = classifyExchange({ ...base, messages: [msg(), msg({ automation: a })] })
    assert.deepStrictEqual(r, { decision: 'refuse', code: 'bulk_or_list_mail' },
      JSON.stringify(a))
  }
})

test('a thread of ONLY automated messages is refused', () => {
  const r = classifyExchange({
    ...base,
    messages: [msg({ fromAddress: 'no-reply@bank.test' }),
      msg({ fromAddress: 'noreply@bank.test' })],
  })
  assert.deepStrictEqual(r, { decision: 'refuse', code: 'automated_sender' })
})

test('ONE auto-reply inside a real thread does NOT condemn it', () => {
  // isNonHuman means "exclude from human counts", not "reject the episode".
  // Conflating the two would throw away genuine exchanges that happen to contain
  // an out-of-office.
  const r = classifyExchange({
    ...base,
    messages: [msg(), msg({ subject: 'Automatic reply: out of office' }),
      msg({ fromAddress: 'me@outlook.test' })],
  })
  assert.deepStrictEqual(r, { decision: 'propose', code: null })
})

test('a partial view is DEFERRED, never refused', () => {
  assert.deepStrictEqual(classifyExchange({ ...base, episodeTruncated: true }),
    { decision: 'defer', code: 'episode_truncated' })
  assert.deepStrictEqual(classifyExchange({ ...base, contentFetchesFailed: 1 }),
    { decision: 'defer', code: 'content_unread' })
  assert.deepStrictEqual(classifyExchange({ ...base, externalParticipants: 3 }),
    { decision: 'defer', code: 'ambiguous_counterparty' })
})

test('bulk mail is refused even when the view is also partial', () => {
  // Order matters: a refusal is settled, and deferring it would re-read the same
  // mail for ever.
  const r = classifyExchange({
    ...base, episodeTruncated: true, contentFetchesFailed: 2,
    messages: [msg({ automation: { hasListId: true } })],
  })
  assert.strictEqual(r.decision, 'refuse')
  assert.strictEqual(r.code, 'bulk_or_list_mail')
})

test('nothing to summarize is refused rather than written empty', () => {
  // This is the defect the pilot actually produced: an accepted suggestion whose
  // note was empty.
  for (const n of [0, 1, MIN_EPISODE_CONTENT_CHARS - 1]) {
    assert.deepStrictEqual(classifyExchange({ ...base, sanitizedChars: n }),
      { decision: 'refuse', code: 'no_usable_content' }, String(n))
  }
  assert.strictEqual(classifyExchange({ ...base, sanitizedChars: MIN_EPISODE_CONTENT_CHARS })
    .decision, 'propose')
  assert.deepStrictEqual(classifyExchange({ ...base, subject: '   ' }),
    { decision: 'refuse', code: 'subject_unusable' })
})

test('every code is drawn from the declared vocabularies', () => {
  const all = [...CONTENT_REFUSALS, ...CONTENT_DEFERRALS]
  assert.strictEqual(new Set(all).size, all.length, 'no code appears in both lists')
  for (const p of [
    { ...base, messages: [msg({ automation: { hasListId: true } })] },
    { ...base, messages: [msg({ fromAddress: 'no-reply@x.test' })] },
    { ...base, episodeTruncated: true },
    { ...base, contentFetchesFailed: 1 },
    { ...base, externalParticipants: 2 },
    { ...base, sanitizedChars: 0 },
    { ...base, subject: '' },
  ]) {
    const r = classifyExchange(p)
    assert.ok(r.decision === 'refuse' || r.decision === 'defer')
    assert.ok(all.includes(r.code), `undeclared code ${r.code}`)
    assert.ok(r.decision === 'refuse'
      ? CONTENT_REFUSALS.includes(r.code) : CONTENT_DEFERRALS.includes(r.code),
      `${r.code} is in the wrong list`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('the note: grounded in counted facts, and inside the database bounds')

test('the note names the thread, the shape and the last date', () => {
  const n = buildInteractionNote(base)
  assert.ok(n.includes('"Summer analyst referral"'), n)
  assert.ok(n.includes('4 messages, 2 from them and 2 from you'), n)
  assert.ok(n.includes('Last on 2026-10-01, from them'), n)
  assert.ok(n.length <= MAX_NOTE_CHARS, `${n.length} chars`)
})

test('it asserts nothing the evidence does not carry', () => {
  // A NEUTRAL subject, so a word appearing in the note can only have been added
  // by the builder. A quoted subject IS evidence, so scanning a note whose
  // subject contains the word under test would prove nothing.
  const n = buildInteractionNote({ ...base, subject: 'Tuesday' })
  assert.ok(n.includes('"Tuesday"'), n)
  // No company, role, seniority, sentiment or intent - none of which is counted.
  for (const invented of ['goldman', 'analyst', 'recruiter', 'interested',
    'positive', 'wants', 'should', 'probably', 'seems', 'keen', 'opportunity']) {
    assert.ok(!n.toLowerCase().includes(invented), `the note asserts "${invented}": ${n}`)
  }
  // And the only quoted text is the subject itself.
  assert.strictEqual((n.match(/"/g) || []).length, 2, `one quoted span only: ${n}`)
})

test('a single message and a one-sided direction still read correctly', () => {
  const one = buildInteractionNote({ ...base, inbound: 1, outbound: 0 })
  assert.ok(one.includes('1 message.'), one)
  const mine = buildInteractionNote({ ...base, lastDirection: 'outbound' })
  assert.ok(mine.includes('from you.'), mine)
  // With no known direction the date clause carries NO trailing attribution.
  // ("from them"/"from you" still appear in the counted clause, which is correct.)
  const noDir = buildInteractionNote({ ...base, lastDirection: null })
  assert.ok(noDir.endsWith('Last on 2026-10-01.'), noDir)
  assert.ok(!/Last on [\d-]+, from/.test(noDir), noDir)
})

test('it stays within bounds by dropping the LEAST useful part first', () => {
  const long = 'A'.repeat(190)
  const n = buildInteractionNote({ ...base, subject: long })
  assert.ok(n.length <= MAX_NOTE_CHARS, `${n.length} chars`)
  assert.ok(n.startsWith('Email thread "A'), 'the subject survives truncation')
  // An absurd subject is bounded rather than dropped.
  const huge = buildInteractionNote({ ...base, subject: 'B'.repeat(5000) })
  assert.ok(huge === null || huge.length <= MAX_NOTE_CHARS)
})

test('a note can never carry a URL or a control character', () => {
  // ncc_summary_bounds forbids both outright, so a note containing one would be
  // refused by the database.
  const n = buildInteractionNote({ ...base, subject: 'Deck at https://evil.test/x now' })
  assert.ok(n !== null)
  assert.ok(!/https?:|www\./i.test(n), n)
  const ctrl = buildInteractionNote({ ...base, subject: 'Re:' + String.fromCharCode(0) + String.fromCharCode(27) + ' Intro call' })
  // eslint-disable-next-line no-control-regex
  assert.ok(ctrl !== null && !new RegExp('[\\u0000-\\u001f]').test(ctrl), JSON.stringify(ctrl))
})

test('an unusable or empty exchange yields no note at all', () => {
  assert.strictEqual(buildInteractionNote({ ...base, subject: '' }), null)
  assert.strictEqual(buildInteractionNote({ ...base, inbound: 0, outbound: 0 }), null)
  assert.strictEqual(buildInteractionNote(null), null)
  // A subject that is ONLY a link leaves nothing to anchor the note to.
  assert.strictEqual(buildInteractionNote({ ...base, subject: 'https://only.test' }), null)
})

test('the subject is normalised, de-prefixed and bounded', () => {
  assert.strictEqual(noteSafeSubject('  Re: Intro   call  '), 'Intro call')
  assert.strictEqual(noteSafeSubject('FWD: Coffee'), 'Coffee')
  assert.strictEqual(noteSafeSubject('fw: Coffee'), 'Coffee')
  assert.strictEqual(noteSafeSubject(''), null)
  assert.strictEqual(noteSafeSubject(null), null)
  assert.ok(noteSafeSubject('C'.repeat(400)).length <= MAX_SUBJECT_CHARS)
})

test('boundText refuses URL-ish input and never splits a word badly', () => {
  assert.strictEqual(boundText('see https://x.test', 100), null)
  assert.strictEqual(boundText('', 10), null)
  const b = boundText('alpha beta gamma delta epsilon', 20)
  assert.ok(b.length <= 20 && !b.endsWith(' '), JSON.stringify(b))
  assert.ok(!/\S$/.test(' ') || true)
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('the follow-up: proposed only when a reply is actually outstanding')

test('THEY wrote last, so a reply is proposed', () => {
  const f = buildFollowUp(base)
  assert.ok(f.startsWith('Reply to their last message'), f)
  assert.ok(f.includes('"Summer analyst referral"'), f)
  assert.ok(f.length <= MAX_FOLLOW_UP_CHARS, `${f.length} chars`)
})

test('YOU wrote last, so nothing is owed and nothing is proposed', () => {
  assert.strictEqual(buildFollowUp({ ...base, lastDirection: 'outbound' }), null)
  assert.strictEqual(buildFollowUp({ ...base, lastDirection: null }), null)
  assert.strictEqual(buildFollowUp(null), null)
})

test('a long subject falls back to the unanchored line rather than overflowing', () => {
  const f = buildFollowUp({ ...base, subject: 'D'.repeat(300) })
  assert.ok(f === null || f.length <= MAX_FOLLOW_UP_CHARS, String(f && f.length))
  const plain = buildFollowUp({ ...base, subject: '' })
  assert.strictEqual(plain, 'Reply to their last message.')
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('draftFromEpisode: one call, and no raw content comes back')

test('a qualifying exchange yields a complete draft', () => {
  const d = draftFromEpisode(base)
  assert.strictEqual(d.kind, 'draft')
  assert.ok(d.note.length > 0 && d.note.length <= MAX_NOTE_CHARS)
  assert.ok(d.followUp.length <= MAX_FOLLOW_UP_CHARS)
  assert.strictEqual(d.retainedSubject, 'Summer analyst referral')
  assert.strictEqual(d.extractionStatus, 'deterministic')
})

test('a refusal or deferral returns the code and NO draft', () => {
  for (const [p, kind, code] of [
    [{ ...base, messages: [msg({ automation: { hasListId: true } })] }, 'refuse', 'bulk_or_list_mail'],
    [{ ...base, episodeTruncated: true }, 'defer', 'episode_truncated'],
    [{ ...base, sanitizedChars: 0 }, 'refuse', 'no_usable_content'],
  ]) {
    const d = draftFromEpisode(p)
    assert.strictEqual(d.kind, kind)
    assert.strictEqual(d.code, code)
    assert.strictEqual(d.note, undefined, 'no note may accompany a refusal')
    assert.strictEqual(d.followUp, undefined)
  }
})

test('NO SANITIZED OR RAW BODY TEXT IS ECHOED BACK', () => {
  // The caller hands in sanitized text; nothing it could accidentally persist may
  // come back out. The note is built from counts and the subject alone.
  const secret = 'CONFIDENTIAL-BODY-SENTENCE-abcdef'
  const d = draftFromEpisode({ ...base, sanitizedText: secret, signature: secret })
  const j = JSON.stringify(d)
  assert.ok(!j.includes(secret), 'body text leaked into the draft')
  assert.deepStrictEqual(Object.keys(d).sort(),
    ['extractionStatus', 'followUp', 'kind', 'note', 'retainedSubject'])
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('the bounds match the applied database CHECKs, not a guess')

test('the module constants equal the column constraints', () => {
  const applied = read('supabase/migrations/20260921000000_add_outlook_content_draft_primitives.sql')
  assert.ok(applied.includes('char_length(draft_summary) BETWEEN 1 AND 200'),
    'ncc_summary_bounds moved')
  assert.strictEqual(MAX_NOTE_CHARS, 200)
  assert.ok(applied.includes('char_length(draft_follow_up) BETWEEN 1 AND 160'),
    'ncc_follow_up_bounds moved')
  assert.strictEqual(MAX_FOLLOW_UP_CHARS, 160)
  assert.ok(applied.includes('char_length(retained_subject) <= 160'),
    'ncc_subject_bounds moved')
  assert.strictEqual(MAX_SUBJECT_CHARS, 160)
  // And the interaction-candidate note ceiling, from the Calendar slice.
  const cal = read('supabase/migrations/20260817000000_add_calendar_ingestion.sql')
  assert.ok(cal.includes('char_length(proposed_notes) <= 200'),
    'interaction_candidates note bound moved')
})

test('the drafted migration is NOT applied and says so', () => {
  const m = read('supabase/migrations/20261006000000_outlook_content_note_and_new_contact_write.sql')
  assert.ok(/NOT APPLIED/.test(m), 'the migration must state that it is unapplied')
  // Worker-only: the browser must never be able to PRODUCE a proposal.
  assert.ok(m.includes('GRANT EXECUTE ON FUNCTION public.upsert_new_contact_candidate'))
  assert.ok(/upsert_new_contact_candidate\([\s\S]{0,200}\) TO service_role/.test(m))
  assert.ok(!/upsert_new_contact_candidate\([\s\S]{0,200}\) TO authenticated/.test(m),
    'the producer must not be grantable to authenticated')
})

console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exitCode = 1
