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
import { readFileSync, existsSync } from 'node:fs'
import {
  REQUIRED_CONTENT_CONSENT_VERSION, REQUIRED_THIRD_PARTY_CONSENT_VERSION,
  CONTENT_CONSENT_CODES, isDisclosureVersion, contentProcessingAllowed,
  thirdPartyProcessingAllowed, contentPermissions, summarizeContentConsent,
  summarizeContentPermissions,
} from '../supabase/functions/shared/outlookContentConsent.js'
// The configured constants must equal what the SHIPPED notice derives, or a recorded
// consent would name a document nobody saw. Read from the module rather than retyped.
import {
  OUTLOOK_DISCLOSURE_VERSION, verifyDisclosureIntegrity,
} from '../src/lib/outlookDisclosure.js'

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

test('the APPROVED content version is configured, and only it is allowed', () => {
  // THIS GUARD WAS INVERTED ON APPROVAL. It asserted the constant stayed null until
  // the owner approved the wording. The owner approved the 23-paragraph notice and
  // the Outlook policy at head 0096103, and approved selected body processing and
  // the disclosed minimized extract, so the constant now carries the version derived
  // from that exact text. What the guard protects has not changed: nothing but an
  // exact match opens the gate.
  assert.strictEqual(REQUIRED_CONTENT_CONSENT_VERSION,
    'ol-disc-6d1ddd67f51d5b3bfd8d3801c50271a7',
    'the configured version must be the one derived from the published text')

  // CUT OVER 2026-10-09 (activation packet step 5): the published notice (step 4) and this
  // requirement carry ONE value again. DERIVED, NOT TYPED - the constant must equal what the
  // shipped paragraphs produce, or a recorded consent would name a document nobody saw.
  assert.strictEqual(REQUIRED_CONTENT_CONSENT_VERSION, OUTLOOK_DISCLOSURE_VERSION,
    'the configured version must match the notice the card actually renders')
  assert.ok(verifyDisclosureIntegrity(), 'and the notice must pass its own integrity check')
  // The CONTENT-RELEASE consent (October 6) is now stale too: the pilot must reconnect.
  const prior = contentProcessingAllowed('ol-disc-e3e2b1714b453c2904e3ed08cb232097')
  assert.strictEqual(prior.allowed, false)
  assert.strictEqual(prior.reason, 'content_consent_stale')

  // THE LIVE PILOT'S CONSENT IS STALE, not merely different: the envelope-only text
  // says Funnl sends nothing to Anthropic. It must reconnect.
  const d = contentProcessingAllowed(ENVELOPE_ONLY)
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.reason, 'content_consent_stale')

  // And nothing else anyone might present opens it either.
  for (const v of [null, undefined, '', 'ol-disc-' + 'b'.repeat(32), 'anything',
    REQUIRED_CONTENT_CONSENT_VERSION.toUpperCase()]) {
    assert.strictEqual(contentProcessingAllowed(v).allowed, false, String(v))
  }
  // THE COMPARISON IS TRIMMED BUT CASE-SENSITIVE, and both halves matter. Incidental
  // whitespace in a stored column must not lock an account out of a consent it gave;
  // a case fold must not let a near-miss through, since these are hex digests and a
  // different case is a different string.
  assert.strictEqual(contentProcessingAllowed(REQUIRED_CONTENT_CONSENT_VERSION).allowed,
    true)
  assert.strictEqual(
    contentProcessingAllowed(' ' + REQUIRED_CONTENT_CONSENT_VERSION + ' ').allowed, true,
    'surrounding whitespace is trimmed, not treated as a mismatch')
  assert.strictEqual(
    contentProcessingAllowed(REQUIRED_CONTENT_CONSENT_VERSION.toUpperCase()).allowed,
    false, 'but the comparison is case-sensitive')
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
console.log('the THIRD-PARTY gate is separate, and both must pass to use the model')

test('both gates are configured, and the live pilot is STALE against both', () => {
  // INVERTED ON APPROVAL, like its content twin. Both constants now carry the version
  // derived from the approved 23-paragraph notice. The pilot's envelope-only consent
  // is stale against both - 'stale' rather than 'not_configured' is the whole point:
  // the gate is open in principle and that connection does not satisfy it.
  assert.strictEqual(REQUIRED_THIRD_PARTY_CONSENT_VERSION,
    'ol-disc-6d1ddd67f51d5b3bfd8d3801c50271a7')
  // Cut over with the content twin: the published notice and this requirement agree.
  assert.strictEqual(REQUIRED_THIRD_PARTY_CONSENT_VERSION, OUTLOOK_DISCLOSURE_VERSION)
  // Two constants, deliberately, even carrying the same value: they answer two
  // questions, and turning the model path off while keeping body reading must stay
  // expressible by changing one of them.
  assert.strictEqual(REQUIRED_CONTENT_CONSENT_VERSION,
    REQUIRED_THIRD_PARTY_CONSENT_VERSION)

  const p = contentPermissions(ENVELOPE_ONLY)
  assert.strictEqual(p.body, false)
  assert.strictEqual(p.bodyReason, 'content_consent_stale')
  assert.strictEqual(p.thirdParty, false)
  assert.strictEqual(p.thirdPartyReason, 'third_party_consent_stale')

  // And the approved version opens both.
  const ok = contentPermissions(REQUIRED_CONTENT_CONSENT_VERSION)
  assert.strictEqual(ok.body, true)
  assert.strictEqual(ok.thirdParty, true)
})

test('BODY-ONLY is a coherent state: read inside Funnl, send nothing out', () => {
  // Reading a body and handing a fragment of it to another company are different
  // things to agree to, so an account must be able to have agreed to one and not
  // the other. This is the state that makes the model path skippable rather than
  // silently used.
  // `thirdParty: null` is injected explicitly now. Before approval the constant was
  // null and omitting it produced the same state by default; with a real version
  // configured, omitting it would fall back to that version and the body-only case
  // would no longer be exercised at all.
  const p = contentPermissions(APPROVED, { content: APPROVED, thirdParty: null })
  assert.strictEqual(p.body, true)
  assert.strictEqual(p.bodyReason, null)
  assert.strictEqual(p.thirdParty, false, 'the third-party gate must NOT ride on the body one')
  assert.strictEqual(p.thirdPartyReason, 'third_party_consent_not_configured')
})

test('both gates open only when both versions match exactly', () => {
  const p = contentPermissions(APPROVED, { content: APPROVED, thirdParty: APPROVED })
  assert.strictEqual(p.body, true)
  assert.strictEqual(p.thirdParty, true)
  // The pilot's envelope-only consent is stale against both.
  const stale = contentPermissions(ENVELOPE_ONLY, { content: APPROVED, thirdParty: APPROVED })
  assert.strictEqual(stale.bodyReason, 'content_consent_stale')
  assert.strictEqual(stale.thirdPartyReason, 'third_party_consent_stale')
  // And a DIFFERENT approved third-party version is not satisfied by the body one.
  const other = 'ol-disc-' + 'c'.repeat(32)
  const split = contentPermissions(APPROVED, { content: APPROVED, thirdParty: other })
  assert.strictEqual(split.body, true)
  assert.strictEqual(split.thirdParty, false)
  assert.strictEqual(split.thirdPartyReason, 'third_party_consent_stale')
})

test('thirdPartyProcessingAllowed behaves exactly like its content twin', () => {
  assert.deepStrictEqual(thirdPartyProcessingAllowed(APPROVED, APPROVED), { allowed: true })
  assert.strictEqual(thirdPartyProcessingAllowed(ENVELOPE_ONLY, APPROVED).reason,
    'third_party_consent_stale')
  for (const v of [null, undefined, '', '   ', 42]) {
    assert.strictEqual(thirdPartyProcessingAllowed(v, APPROVED).reason,
      'third_party_consent_missing', String(v))
  }
  // With a version now CONFIGURED, an unrelated approved-looking string is STALE
  // rather than unconfigured. Both still refuse; the code says which it is, and that
  // distinction is what an operator reads to tell a misconfiguration from a
  // connection that simply needs to reconnect.
  assert.strictEqual(thirdPartyProcessingAllowed(APPROVED).reason,
    'third_party_consent_stale', 'a non-matching version is stale, not unconfigured')
  // Explicitly unconfigured still reports itself as such.
  assert.strictEqual(thirdPartyProcessingAllowed(APPROVED, null).reason,
    'third_party_consent_not_configured', 'and an absent required version still says so')
})

test('the logged permissions carry no version string', () => {
  const log = summarizeContentPermissions(
    contentPermissions(ENVELOPE_ONLY, { content: APPROVED, thirdParty: APPROVED }))
  assert.deepStrictEqual(log, {
    body_allowed: false, body_reason: 'content_consent_stale',
    third_party_allowed: false, third_party_reason: 'third_party_consent_stale',
  })
  assert.ok(!JSON.stringify(log).includes('ol-disc'))
  // Every reason it can emit is in the declared vocabulary.
  for (const r of [log.body_reason, log.third_party_reason]) {
    assert.ok(CONTENT_CONSENT_CODES.includes(r), r)
  }
  // An unknown reason is normalised, never echoed.
  const junk = summarizeContentPermissions({ body: false, bodyReason: 'made-up',
    thirdParty: false, thirdPartyReason: 'also-made-up' })
  assert.strictEqual(junk.body_reason, 'content_consent_not_configured')
  assert.strictEqual(junk.third_party_reason, 'third_party_consent_not_configured')
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('the bounds match the applied database CHECKs, not a guess')

test('the write RPCs enforce exactly the applied column bounds', () => {
  // The subject-and-counts note module that used to mirror these constants is
  // gone - it was rejected as a product answer. The bounds still matter, because
  // the two write RPCs validate against them, so they are asserted against the
  // APPLIED schema and the DRAFTED migration rather than against a JS constant.
  const applied = read('supabase/migrations/20260921000000_add_outlook_content_draft_primitives.sql')
  assert.ok(applied.includes('char_length(draft_summary) BETWEEN 1 AND 200'),
    'ncc_summary_bounds moved')
  assert.ok(applied.includes('char_length(draft_follow_up) BETWEEN 1 AND 160'),
    'ncc_follow_up_bounds moved')
  assert.ok(applied.includes('char_length(retained_subject) <= 160'),
    'ncc_subject_bounds moved')
  const cal = read('supabase/migrations/20260817000000_add_calendar_ingestion.sql')
  assert.ok(cal.includes('char_length(proposed_notes) <= 200'),
    'the interaction-candidate note ceiling moved')

  // And the write RPCs validate against those same numbers.
  const w = read('supabase/migrations/20261006000000_outlook_content_note_and_new_contact_write.sql')
  assert.ok(w.includes("char_length(v_notes) > 200"), 'the note ceiling is enforced')
  assert.ok(w.includes("char_length(v_sum) > 200"), 'the summary ceiling is enforced')
  assert.ok(w.includes("char_length(v_follow) > 160"), 'the follow-up ceiling is enforced')
  assert.ok(w.includes("char_length(v_subj) > 160"), 'the subject ceiling is enforced')
})

test('the superseded note module is gone, not merely unused', () => {
  // A subject-and-counts note does not answer the complaint it was built for -
  // an accepted interaction with no context - so the module and its tests were
  // removed rather than left behind for someone to wire up later.
  assert.ok(!existsSync(new URL(
    '../supabase/functions/shared/outlookContentNote.js', import.meta.url)),
    'outlookContentNote.js must be deleted')
  // And nothing imports it.
  for (const f of ['supabase/functions/shared/outlookContentConsent.js',
    'supabase/functions/outlook-import-worker/handler.js',
    'supabase/functions/shared/outlookImportRun.js']) {
    assert.ok(!read(f).includes('outlookContentNote'), `${f} still imports it`)
  }
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

test('the Outlook context window is enforced on the interaction acceptance path', () => {
  // An approval packet claimed both acceptance RPCs refused an expired suggestion.
  // Only accept_new_contact_candidate did: the claim came from a grep whose two
  // matches were both inside defer_candidate. Reproduced against real Postgres - an
  // Outlook candidate 40 days past its deadline answered 'accepted' and created an
  // interaction - and guarded in the UNAPPLIED forward migration.
  const m = read('supabase/migrations/20261006000000_outlook_content_note_and_new_contact_write.sql')
  const at = m.indexOf('CREATE OR REPLACE FUNCTION public.accept_interaction_candidate(')
  assert.ok(at > 0, 'the forward migration must replace the acceptance RPC')
  const fn = m.slice(at)

  // OUTLOOK-SCOPED, and failing closed on NULL. Calendar and Gmail carry NULL here
  // by design, so an unscoped rule would refuse every Calendar suggestion ever made.
  // Checked as substrings on one logical condition, collapsed to single spaces so
  // the assertion does not depend on where the source happens to wrap.
  const flat = fn.replace(/\s+/g, ' ')
  assert.ok(flat.includes(
    "IF v_cand.source = 'outlook' AND (v_cand.context_expires_at IS NULL"
    + ' OR v_cand.context_expires_at <= now()) THEN'),
  'the guard must be Outlook-scoped and fail closed on NULL')
  assert.ok(fn.includes("RETURN jsonb_build_object('result', 'expired')"))

  // PLACED AFTER the terminal-status checks. Acceptance erases the deadline to NULL,
  // so a guard placed earlier would answer 'expired' for an already-accepted row.
  const guardAt = fn.indexOf("v_cand.source = 'outlook'")
  for (const earlier of ["'already_accepted'", "'dismissed'", "'invalidated'",
    "'interaction_previously_deleted'"]) {
    const idx = fn.indexOf(earlier)
    assert.ok(idx > 0 && idx < guardAt,
      `${earlier} must still be decided BEFORE the expiry guard`)
  }

  // REPLACED IN PLACE, not dropped: a DROP loses the ACL and hands EXECUTE back to
  // PUBLIC unless every grant is restated.
  assert.ok(!/DROP FUNCTION[^;]*accept_interaction_candidate/.test(m),
    'the applied function must not be dropped')
  assert.ok(fn.includes("SET search_path = ''"), 'the pinned empty search_path is preserved')
  assert.ok(fn.includes('SECURITY DEFINER'))
  assert.ok(m.replace(/\s+/g, ' ').includes(
    'GRANT EXECUTE ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text)'
    + ' TO authenticated'), 'authenticated must keep EXECUTE')

  // And NO applied migration is edited to achieve it.
  const applied = read('supabase/migrations/20260921000000_add_outlook_content_draft_primitives.sql')
  assert.ok(!applied.replace(/\s+/g, ' ').includes("IF v_cand.source = 'outlook' AND (v_cand.context_expires_at"),
    'the applied migration must not carry the guard')
})

console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exitCode = 1
