// DETAILED AI INTERACTION NOTES, over concrete networking exchanges.
//
// WHAT IS EXERCISED: the real prompt, the real request builder, the real response parser and
// the real independent validator, against model responses shaped exactly as the schema asks
// for them. Each fixture is a networking exchange of the kind the pilot mailbox actually sees
// - a multi-topic referral conversation, an exchange carrying commitments and named dates, a
// two-line thank-you, and one where the model over-reaches past what the messages state.
//
// WHAT IS NOT EXERCISED: the model itself. These are FIXTURES. They prove what the pipeline
// does with a response of a given shape and length - that a detailed note survives validation
// intact, that an over-long one is refused rather than trimmed, that an invented or unsupported
// detail is refused where the rules can see it. They are NOT evidence that the model writes
// good notes, and nothing here measures note quality. That evidence can only come from live
// exchanges after the rollout in docs/outlook-detailed-ai-notes.md.
//
// NO REAL PERSON, ADDRESS, COMPANY OR MESSAGE APPEARS IN THIS FILE.
//
// Run with: node tests/outlook-detailed-notes.test.js
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  BOUNDS, DRAFT_MAX_TOKENS, DRAFT_FAILURE_CODES, SYSTEM_CONTRACT,
  buildDraftRequest, validateDraftResponse, parseDraftPayload,
  interactionDraftSchema, newContactSchema, MAX_REQUEST_CHARS, MAX_RESPONSE_CHARS,
} from '../supabase/functions/shared/outlookDraftContract.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const FORWARD = read('supabase/migrations/20261010180000_detailed_ai_interaction_notes.sql')

let passed = 0, failed = 0
function test (name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

const DATES = ['2026-10-08', '2026-10-09']
const ctx = (mode) => ({ mode, allowedDates: DATES })
const draft = (over = {}) => ({
  result: 'interaction_draft', summary: 'A note.', summary_evidence: 'explicit_body',
  follow_up: null, interaction_date: DATES[0], ...over,
})
const proposal = (over = {}) => ({
  result: 'new_contact_suggestion', name: 'Priya Nair', name_evidence: 'explicit_signature',
  name_confidence: 'high', summary: 'A note.', summary_evidence: 'explicit_body',
  follow_up: null, interaction_date: DATES[0], ...over,
})

// ── the fixtures: four concrete exchanges, written as the model is asked to write them ──────
// 1. MULTI-TOPIC. A referral conversation covering three subjects, an offer, a piece of
//    concrete advice, two named dates and one open question. 1,012 characters.
const MULTI_TOPIC = 'Priya is on the analyst programme team and offered to put your '
  + 'application in front of the programme lead before the 24 October internal deadline, '
  + 'which is earlier than the public one. She said the screening call is competency-based '
  + 'rather than technical and advised preparing two examples of working under a deadline, '
  + 'because that is what the panel scores hardest. On the desk choice she was clear that '
  + 'markets suits the modelling work you described better than coverage, and that coverage '
  + 'intake is smaller this year. She also mentioned the spring insight week as a fallback if '
  + 'the summer cohort closes, and said she could introduce you to someone on the credit desk '
  + 'once you decide. You agreed to send an updated CV by Friday and to confirm the track. '
  + 'Left open: whether the insight week application can run in parallel with the summer one, '
  + 'which she said she would check with the programme lead.'
// 2. COMMITMENTS AND DATES. Shorter, but every sentence is a commitment or a date.
const COMMITMENTS = 'Ben confirmed the growth fund will post the summer analyst role on '
  + '3 November and committed to flagging your application to the hiring manager when it '
  + 'does. He asked you to send a one-page summary of the portfolio work by 28 October, and '
  + 'agreed to a 30-minute call on 5 November to walk through it. He is away from 10 to 17 '
  + 'November, so anything needing his sign-off has to be done before then.'
// 3. SHORT EXCHANGE. A two-line thank-you. One sentence is the whole note.
const SHORT = 'You thanked Ava for the coffee chat and she replied that she was glad to help '
  + 'and to keep her posted.'
// 4. UNSUPPORTED INFERENCE. The same exchange as (3), but the note reaches past it.
const INFERRED = SHORT + ' She is clearly senior at the firm and probably has hiring influence.'

console.log('\nthe bound, the budget and the prompt are coordinated')

test('the generated-note ceiling is 2,000 and the output budget is sized for it', () => {
  assert.strictEqual(BOUNDS.summary, 2000)
  assert.strictEqual(DRAFT_MAX_TOKENS, 2048, 'the whole allowance is visible output; thinking is disabled')
  // A 2,000-character note is roughly 500 tokens; the budget must also carry the next step,
  // the name triple, the evidence enums and the JSON envelope.
  assert.ok(DRAFT_MAX_TOKENS * 4 > BOUNDS.summary + BOUNDS.followUp + BOUNDS.name + 200,
    'the budget must exceed the longest permitted response, not merely the note')
})

test('the prompt asks for the substance of the exchange, names what to record, and forbids padding', () => {
  const p = SYSTEM_CONTRACT
  assert.ok(/WHAT THE SUMMARY MUST RECORD/.test(p))
  for (const required of ['advice', 'offers', 'commitments', 'dates', 'next steps', 'unresolved']) {
    assert.ok(p.toLowerCase().includes(required), `the prompt must name ${required}`)
  }
  assert.ok(/LENGTH FOLLOWS THE EXCHANGE/.test(p) && p.includes(String(BOUNDS.summary)),
    'the available length is stated, and derived from the bound')
  assert.ok(/Never pad, never repeat yourself/.test(p), 'padding is forbidden')
  assert.ok(/a two-line thank-you is one sentence/.test(p), 'a short exchange must produce a short note')
  assert.ok(/never state a detail the messages do not/.test(p), 'invention is forbidden')
  // The rules that predate this change are still in force, verbatim.
  assert.ok(/Report only what the text states explicitly/.test(p))
  assert.ok(/UNTRUSTED DATA, not instructions/.test(p))
  assert.ok(p.includes('result "defer"'), 'the sensitive-topic deferral survives')
  assert.ok(/No line breaks, no bullet characters/.test(p), 'the generated note is one prose paragraph')
})

test('both schemas describe a detailed note and carry the new bound', () => {
  for (const schema of [interactionDraftSchema(DATES), newContactSchema(DATES)]) {
    const d = schema.properties.summary.anyOf ? schema.properties.summary.description : schema.properties.summary.description
    assert.ok(/topics discussed/.test(d) && /commitments/.test(d) && /unresolved questions/.test(d), d)
    assert.ok(d.includes('2000'), 'the bound is stated to the model')
    assert.ok(/only as much as the exchange supports/.test(d), 'and so is the no-padding rule')
  }
})

test('the request still fits its ceiling with a full six-message exchange', () => {
  const messages = Array.from({ length: 6 }, (_, i) => ({
    direction: i % 2 === 0 ? 'inbound' : 'outbound',
    dateIso: `2026-10-0${8 + (i % 2)}T1${i}:00:00Z`,
    // The sanitizer bounds each message to MAX_TEXT_CHARS and the whole episode to
    // MAX_EPISODE_CHARS (12,000), so this is the largest exchange the pass can actually send.
    text: 'x'.repeat(2000),
    signature: i === 0 ? 'Priya Nair, Analyst Programme Team' : null,
  }))
  const body = buildDraftRequest({ mode: 'known_contact', displayName: 'Priya', subject: 'Summer analyst', messages, allowedDates: DATES })
  assert.strictEqual(body.max_tokens, 2048)
  // The request ceiling MOVED with the fixed prompt/schema overhead this change added
  // (20,000 -> 24,000); the amount of user content sent is bounded by the sanitizer and did
  // not move. The worst case and its margin are re-measured in
  // tests/outlook-content-corrections.test.js.
  assert.ok(JSON.stringify(body).length <= MAX_REQUEST_CHARS, 'a full exchange still fits the request ceiling')
  assert.strictEqual(MAX_REQUEST_CHARS, 24000)
  // And the RESPONSE keeps its own, far tighter bound: widening the request must not widen
  // what is accepted back.
  // DERIVED from the field bounds times the worst-case JSON escape expansion, so it cannot
  // drift away from them - see the regression below for why that matters.
  assert.strictEqual(MAX_RESPONSE_CHARS, (BOUNDS.summary + BOUNDS.followUp + BOUNDS.name) * 6 + 2000)
  assert.ok(MAX_RESPONSE_CHARS < MAX_REQUEST_CHARS, 'and must not simply inherit the request ceiling')
})

console.log('\nconcrete exchanges: a detailed note survives validation intact')

test('MULTI-TOPIC: a 1,000-character note covering topics, advice, an offer, dates and an open question validates unchanged', () => {
  assert.ok(MULTI_TOPIC.length > 800 && MULTI_TOPIC.length < BOUNDS.summary, MULTI_TOPIC.length)
  assert.ok(MULTI_TOPIC.length > 4 * 200, 'this note needs more than four times the old ceiling')
  const r = validateDraftResponse(draft({ summary: MULTI_TOPIC, follow_up: 'Send the updated CV by Friday and confirm the markets track.' }), ctx('known_contact'))
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  assert.strictEqual(r.draft.summary, MULTI_TOPIC, 'carried through byte for byte - never trimmed')
  assert.strictEqual(r.draft.summary.length, MULTI_TOPIC.length)
  // and the same note through the new-contact shape
  const n = validateDraftResponse(proposal({ summary: MULTI_TOPIC }), ctx('new_contact'))
  assert.strictEqual(n.ok, true, JSON.stringify(n))
  assert.strictEqual(n.suggestion.summary, MULTI_TOPIC)
})

test('COMMITMENTS AND DATES: the note keeps every date and commitment it was given', () => {
  const r = validateDraftResponse(draft({ summary: COMMITMENTS }), ctx('known_contact'))
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  for (const fact of ['3 November', '28 October', '5 November', '10 to 17']) {
    assert.ok(r.draft.summary.includes(fact), `${fact} must survive`)
  }
  assert.ok(COMMITMENTS.length > 200, 'this note could not have existed under the old 200-character ceiling')
})

test('SHORT EXCHANGE: a one-sentence note is valid - the bound is a ceiling, not a target', () => {
  const r = validateDraftResponse(draft({ summary: SHORT }), ctx('known_contact'))
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  assert.strictEqual(r.draft.summary, SHORT)
  assert.ok(SHORT.length < 200, 'and it stays short')
  // A single character is still a note; only the empty string is refused.
  assert.strictEqual(validateDraftResponse(draft({ summary: 'x' }), ctx('known_contact')).ok, true)
  assert.strictEqual(validateDraftResponse(draft({ summary: '' }), ctx('known_contact')).code, 'empty_string')
})

test('UNSUPPORTED INFERENCE: the rules that can see an over-reach still refuse it', () => {
  // What the code CAN refuse: a sensitive inference, a URL, an address, control characters.
  // What it CANNOT refuse is a plausible-sounding unsupported sentence like INFERRED - that is
  // the prompt's job and the reviewer's, and this test records the limit honestly rather than
  // pretending the validator catches it.
  assert.strictEqual(validateDraftResponse(draft({ summary: INFERRED }), ctx('known_contact')).ok, true,
    'a plausible unsupported sentence passes the validator - only the prompt and the reviewer guard it')
  const sensitive = validateDraftResponse(draft({ summary: SHORT + ' She also mentioned her visa status is unresolved.' }), ctx('known_contact'))
  assert.strictEqual(sensitive.ok, false); assert.strictEqual(sensitive.code, 'sensitive_inference')
  const url = validateDraftResponse(draft({ summary: SHORT + ' See https://example.invalid/role for the posting.' }), ctx('known_contact'))
  assert.strictEqual(url.ok, false); assert.strictEqual(url.code, 'url_in_text')
  const broken = validateDraftResponse(draft({ summary: 'Topic one.' + String.fromCharCode(10) + 'Topic two.' }), ctx('known_contact'))
  assert.strictEqual(broken.ok, false); assert.strictEqual(broken.code, 'control_characters')
})

test('the boundary: 2,000 is accepted, 2,001 is REFUSED and never trimmed', () => {
  const at = validateDraftResponse(draft({ summary: 'y'.repeat(2000) }), ctx('known_contact'))
  assert.strictEqual(at.ok, true); assert.strictEqual(at.draft.summary.length, 2000)
  const over = validateDraftResponse(draft({ summary: 'y'.repeat(2001) }), ctx('known_contact'))
  assert.strictEqual(over.ok, false); assert.strictEqual(over.code, 'too_long')
  const overNcc = validateDraftResponse(proposal({ summary: 'y'.repeat(2001) }), ctx('new_contact'))
  assert.strictEqual(overNcc.ok, false); assert.strictEqual(overNcc.code, 'too_long')
})

console.log('\na response cut off by the output budget is named, and stores nothing')

test('unparseable JSON that stopped on max_tokens is model_truncated, not unparseable_json', () => {
  assert.ok(DRAFT_FAILURE_CODES.includes('model_truncated'))
  const cut = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"result":"interaction_draft","summary":"Priya offered to put your applicat' }] }
  const r = parseDraftPayload(cut)
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'model_truncated')
  // An ordinary malformed response is still reported as such.
  const junk = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json at all' }] }
  assert.strictEqual(parseDraftPayload(junk).code, 'unparseable_json')
  // A complete response that happened to stop on max_tokens still parses.
  const whole = { stop_reason: 'max_tokens', content: [{ type: 'text', text: JSON.stringify(draft({ summary: COMMITMENTS })) }] }
  const ok = parseDraftPayload(whole)
  assert.strictEqual(ok.ok, true); assert.strictEqual(ok.stopReason, 'max_tokens')
  assert.strictEqual(ok.parsed.summary, COMMITMENTS)
})

console.log('\nthe response ceiling counts SERIALIZED characters, so it is sized for JSON escaping')

// REPRODUCED BEFORE THE FIX. The first response ceiling was 8,000, reasoned from the DECODED
// field bounds (2,000 + 160 + 120 is under 2,600) and then applied to the serialized text. A
// provider that emits fully-escaped JSON writes every non-ASCII character as a six-character
// escape, so this exact note - 2,000 valid characters, inside every field bound once decoded -
// serialized to 12,127 characters and was refused `malformed_response`: a correct note thrown
// away by a bound that measured the wrong thing.
const BS = String.fromCharCode(92)
const escapeNonAscii = (t) => t.split('').map((ch) => (ch.charCodeAt(0) < 128
  ? ch : BS + 'u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))).join('')
const JA_NOTE = '夏期アナリスト採用について話しました。'.repeat(200).slice(0, 2000)

test('a valid 2,000-character non-ASCII note emitted as fully-escaped JSON parses and validates - both schemas', () => {
  assert.strictEqual(JA_NOTE.length, 2000)
  const cases = [
    ['known_contact', draft({ summary: JA_NOTE }), (v) => v.draft],
    ['new_contact', proposal({ summary: JA_NOTE, name: 'ナイル', follow_up: '資料を金曜日までに送る。' }), (v) => v.suggestion],
  ]
  for (const [mode, payload, pick] of cases) {
    const serialized = escapeNonAscii(JSON.stringify(payload))
    assert.ok(serialized.length > 12000, `${mode}: the fixture must actually be escaped (${serialized.length})`)
    assert.ok(serialized.length <= MAX_RESPONSE_CHARS, `${mode}: ${serialized.length} serialized characters must fit the ceiling`)
    const r = parseDraftPayload({ stop_reason: 'end_turn', content: [{ type: 'text', text: serialized }] })
    assert.strictEqual(r.ok, true, `${mode}: parse refused it as ${r.code}`)
    const v = validateDraftResponse(r.parsed, ctx(mode))
    assert.strictEqual(v.ok, true, `${mode}: ${v.code}`)
    // THE DECODED LIMIT IS WHAT COUNTS, and it is unchanged: 2,000 characters of real text.
    assert.strictEqual(pick(v).summary, JA_NOTE)
    assert.strictEqual(pick(v).summary.length, 2000)
  }
})

test('the worst case the field bounds permit still fits, and a genuinely oversized response is still refused', () => {
  // Every character of every free-text field escaped: the ceiling is derived to admit exactly this.
  const worst = (BOUNDS.summary + BOUNDS.followUp + BOUNDS.name) * 6
  assert.ok(MAX_RESPONSE_CHARS > worst, `${MAX_RESPONSE_CHARS} must exceed the ${worst}-character worst case`)
  assert.ok(MAX_RESPONSE_CHARS - worst >= 1000, 'with room for keys, enums and provider whitespace')
  // And the bound still bites: a response past it is refused rather than buffered and parsed.
  const huge = '{"result":"interaction_draft","summary":"' + 'x'.repeat(MAX_RESPONSE_CHARS) + '"}'
  assert.strictEqual(parseDraftPayload({ stop_reason: 'end_turn', content: [{ type: 'text', text: huge }] }).code, 'malformed_response')
  // A decoded note past the FIELD bound is still refused by the validator, escaped or not.
  const overField = escapeNonAscii(JSON.stringify(draft({ summary: JA_NOTE + '。' })))
  const r = parseDraftPayload({ stop_reason: 'end_turn', content: [{ type: 'text', text: overField }] })
  assert.strictEqual(r.ok, true, 'it is within the serialized ceiling')
  assert.strictEqual(validateDraftResponse(r.parsed, ctx('known_contact')).code, 'too_long', 'but over the decoded field bound')
})

console.log('\nthe database path carries the same number, and nothing else moved')

test('the forward migration widens exactly three CHECKs and both producer bounds', () => {
  assert.strictEqual((FORWARD.match(/BETWEEN 1 AND 2000/g) || []).length, 2, 'draft_summary on both tables')
  assert.ok(FORWARD.includes('char_length(proposed_notes) <= 2000'))
  assert.ok(FORWARD.includes('char_length(v_notes) > 2000') && FORWARD.includes('char_length(v_sum) > 2000'))
  // Unchanged rules, restated in the widened CHECKs and the producer bodies.
  assert.strictEqual((FORWARD.match(/char_length\(v_follow\) > 160/g) || []).length, 2, 'the follow-up bound is untouched in both producers')
  assert.ok(FORWARD.includes('char_length(v_subj) > 160'))
  assert.ok((FORWARD.match(/!~ '\[\[:cntrl:\]\]'/g) || []).length >= 2, 'the control-character rule stays on both summary columns')
  assert.ok((FORWARD.match(/!~\* '\(https\?:\|www\\\.\)'/g) || []).length >= 2, 'so does the URL rule')
  // The acceptance RPCs are NOT part of this migration: they already allow 10,000.
  assert.ok(!/accept_interaction_candidate|accept_new_contact_candidate/.test(FORWARD),
    'the acceptance path needs no change and must not be re-issued here')
  assert.ok(!/DROP COLUMN|ADD COLUMN|CREATE TABLE/.test(FORWARD), 'no schema shape change')
  assert.strictEqual((FORWARD.match(/CREATE OR REPLACE FUNCTION/g) || []).length, 2, 'exactly the two producers')
})

test('both producer bodies are identical to the applied ones apart from the marked note bound', () => {
  const stripMarked = (t) => t.replace(/[ \t]*-- >>> detailed notes[\s\S]*?-- <<< detailed notes\n/g, '')
  const fnBody = (text, name) => {
    const i = text.indexOf(`FUNCTION public.${name}(`)
    assert.ok(i > 0, name)
    return text.slice(i, text.indexOf('$$;', i) + 3)
  }
  const nextI = stripMarked(fnBody(FORWARD, 'upsert_outlook_interaction_candidate'))
  const prevI = fnBody(read('supabase/migrations/20261008000000_outlook_known_contact_follow_up_provenance.sql'), 'upsert_outlook_interaction_candidate')
    .replace(/  -- The note, checked against interaction_candidates_proposed_notes_check[\s\S]*?  END IF;\n/, '')
  assert.strictEqual(nextI, prevI, 'the interaction producer changed only inside the marked block')

  const nextN = stripMarked(fnBody(FORWARD, 'upsert_new_contact_candidate'))
  const prevN = fnBody(read('supabase/migrations/20261006000000_outlook_content_note_and_new_contact_write.sql'), 'upsert_new_contact_candidate')
    .replace(/  v_sum := NULLIF\(pg_catalog\.btrim\(COALESCE\(p_draft_summary, ''\)\), ''\);\n  IF v_sum IS NOT NULL[\s\S]*?  END IF;\n/, '')
  assert.strictEqual(nextN, prevN, 'the new-contact producer changed only inside the marked block')
})

test('signatures and worker-only grants are restated exactly', () => {
  const sigI = 'uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text'
  const sigN = 'uuid, uuid, text, text, smallint, text, date, text, text, text, text, text, text, text'
  for (const [name, sig] of [['upsert_outlook_interaction_candidate', sigI], ['upsert_new_contact_candidate', sigN]]) {
    assert.ok(FORWARD.includes(`REVOKE ALL ON FUNCTION public.${name}(\n  ${sig}\n) FROM PUBLIC, anon, authenticated;`), `${name} revoke`)
    assert.ok(FORWARD.includes(`GRANT EXECUTE ON FUNCTION public.${name}(\n  ${sig}\n) TO service_role;`), `${name} grant`)
  }
})

test('the reviewer can always edit and save the longest generated note', () => {
  // The generated ceiling must stay inside the reviewed ceiling, or a draft could arrive that
  // the editor refuses to save - the one combination that would strand a suggestion.
  const cal = read('src/lib/calendarReview.js')
  const ncc = read('src/lib/newContactReview.js')
  assert.ok(/REVIEW_NOTES_MAX = 10000/.test(cal) && /notes: 10000/.test(ncc))
  assert.ok(BOUNDS.summary < 10000, 'the generated note fits the reviewed allowance with room to edit')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
