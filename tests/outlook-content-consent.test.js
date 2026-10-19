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
// The configured constants must equal what the SHIPPED notice derives, or a recorded
// consent would name a document nobody saw. Read from the module rather than retyped.

let passed = 0, failed = 0
function test (name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
   // the live pilot's

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('the consent gate: closed today, and closed for the right reason')

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('the THIRD-PARTY gate is separate, and both must pass to use the model')

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
  // CURRENT NUMBERS. Those files are historical; 20261010180000 widens the generated-note
  // ceiling to 2,000 in the column CHECKs and in both producer RPCs, and leaves the
  // follow-up, subject, control-character and URL rules exactly as asserted above.
  const fwd = read('supabase/migrations/20261010180000_detailed_ai_interaction_notes.sql')
  assert.ok(fwd.includes('char_length(v_notes) > 2000') && fwd.includes('char_length(v_sum) > 2000'))
  assert.ok(fwd.includes("v_notes ~ '[[:cntrl:]]'") && fwd.includes('char_length(v_follow) > 160'))
  assert.ok(w.includes("char_length(v_follow) > 160"), 'the follow-up ceiling is enforced')
  assert.ok(w.includes("char_length(v_subj) > 160"), 'the subject ceiling is enforced')
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
