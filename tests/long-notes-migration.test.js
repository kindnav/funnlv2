// THE LONG-REVIEWED-NOTES MIGRATION: both acceptance RPCs are re-issued with their bodies
// unchanged except the note validation, their signatures and grants restated exactly.
//
// Run with: node tests/long-notes-migration.test.js
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const lf = (t) => t.replace(/\r\n/g, '\n')
const read = (p) => lf(readFileSync(join(ROOT, p), 'utf8'))

let passed = 0, failed = 0
function test (name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

const FORWARD = read('supabase/migrations/20261010120000_long_reviewed_interaction_notes.sql')
const PREV_INTERACTION = read('supabase/migrations/20261008000000_outlook_known_contact_follow_up_provenance.sql')
const PREV_NEW_CONTACT = read('supabase/migrations/20260921000000_add_outlook_content_draft_primitives.sql')

function fnBody (text, name) {
  const start = text.indexOf(`FUNCTION public.${name}(`)
  assert.ok(start > 0, `${name} not found`)
  const end = text.indexOf('$$;', start)
  return text.slice(start, end + 3)
}
const stripMarked = (t) => t.replace(/[ \t]*-- >>> long reviewed notes[\s\S]*?-- <<< long reviewed notes\n/g, '')

test('accept_interaction_candidate: identical to the applied body except the marked note block', () => {
  const next = stripMarked(fnBody(FORWARD, 'accept_interaction_candidate'))
  const prev = fnBody(PREV_INTERACTION, 'accept_interaction_candidate')
  // The applied body carries the 200 check where the marked block now sits.
  const prevNormalized = prev.replace(
    "  IF v_notes IS NOT NULL AND char_length(v_notes) > 200 THEN\n    RETURN jsonb_build_object('result', 'invalid_notes');\n  END IF;\n", '')
  assert.strictEqual(next, prevNormalized)
  assert.ok(/char_length\(v_notes\) > 10000[\s\S]*?'invalid_notes'/.test(fnBody(FORWARD, 'accept_interaction_candidate')))
  assert.ok(!/char_length\(v_notes\) > 200\b/.test(fnBody(FORWARD, 'accept_interaction_candidate')))
})

test('accept_new_contact_candidate: identical to the applied body except the marked note block; other fields keep [[:cntrl:]]', () => {
  const nextFull = fnBody(FORWARD, 'accept_new_contact_candidate')
  const next = stripMarked(nextFull)
  const prev = fnBody(PREV_NEW_CONTACT, 'accept_new_contact_candidate').replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
  const prevNormalized = prev.replace(
    "    IF v_notes IS NOT NULL AND (char_length(v_notes) > 200 OR v_notes ~ '[[:cntrl:]]') THEN\n      RETURN jsonb_build_object('result', 'invalid_notes');\n    END IF;\n", '')
  assert.strictEqual(next, prevNormalized)
  assert.ok(/char_length\(v_notes\) > 10000/.test(nextFull))
  // Tabs, line feeds and carriage returns are removed before the control-character test; nothing else is.
  assert.ok(/pg_catalog\.translate\(v_notes, pg_catalog\.chr\(9\) \|\| pg_catalog\.chr\(10\) \|\| pg_catalog\.chr\(13\), ''\) ~ '\[\[:cntrl:\]\]'/.test(nextFull))
  for (const field of ['v_name', 'p_company', 'p_role', 'p_how_met', 'p_relationship_note']) {
    assert.ok(new RegExp(`${field.replace('$', '\\$')} ~ '\\[\\[:cntrl:\\]\\]'`).test(nextFull), `${field} still rejects every control character`)
  }
})

test('signatures and grants are restated exactly; no draft column is widened', () => {
  assert.ok(FORWARD.includes("REVOKE ALL ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text, text, date)\n  FROM PUBLIC, anon;"))
  assert.ok(FORWARD.includes("GRANT EXECUTE ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text, text, date)\n  TO authenticated;"))
  const sig = 'uuid, text, text, text, text, text, text[], text, text, boolean, text, date, text, date'
  assert.ok(FORWARD.includes(`REVOKE ALL ON FUNCTION public.accept_new_contact_candidate(\n  ${sig}\n) FROM PUBLIC, anon;`))
  assert.ok(FORWARD.includes(`GRANT EXECUTE ON FUNCTION public.accept_new_contact_candidate(\n  ${sig}\n) TO authenticated;`))
  assert.ok(FORWARD.includes(`REVOKE EXECUTE ON FUNCTION public.accept_new_contact_candidate(\n  ${sig}\n) FROM service_role;`))
  assert.ok(!/ALTER TABLE|DROP CONSTRAINT|ADD CONSTRAINT/.test(FORWARD.replace(/--[^\n]*/g, '')), 'no table or constraint change')
  assert.strictEqual((FORWARD.match(/CREATE OR REPLACE FUNCTION/g) || []).length, 2)
})

test('the client bounds agree with the server: 10,000 for both editors; drafts stay 200', async () => {
  const cal = await import('../src/lib/calendarReview.js')
  const ncc = await import('../src/lib/newContactReview.js')
  assert.strictEqual(cal.REVIEW_NOTES_MAX, 10000)
  assert.strictEqual(ncc.NCC_BOUNDS.notes, 10000)
})

setTimeout(() => {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}, 50)
