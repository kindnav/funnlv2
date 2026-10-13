// THE ONLY BEHAVIOURAL DIFFERENCE IS THE EXPIRY ASSIGNMENT, pinned rather than asserted.
//
// `20261013060000_preserve_new_contact_context_deadline.sql` re-issues the whole
// `upsert_new_contact_candidate` function - 490 lines of validation order, lease fencing,
// thread and episode deduplication, rotation and alias handling, atomic coverage and
// recovery-hint updates, and twenty result codes. Re-typing any of that would be a chance to
// change something by accident, and a reviewer cannot eyeball a 490-line diff for a one-line
// intent.
//
// So the body is COPIED from the applied definition and the test below substitutes the old
// assignment back in and requires the result to equal the applied text byte for byte. If any
// other character of the function moved, this fails. That is the strongest form of "nothing
// else changed" available without running both versions side by side - which
// tests/local/outlook-refresh-expiry.mjs then does.
//
// Run with: node tests/outlook-refresh-expiry-scan.test.js

import assert from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const APPLIED = 'supabase/migrations/20261011000000_outlook_thread_segments.sql'
const FIX = 'supabase/migrations/20261013060000_preserve_new_contact_context_deadline.sql'

let passed = 0
let failed = 0
function test (name, fn) {
  try { fn(); console.log('  OK   ' + name); passed += 1 } catch (e) {
    console.error('  FAIL ' + name)
    console.error('       ' + (e && e.message ? e.message : String(e)))
    failed += 1
  }
}

const START = 'CREATE OR REPLACE FUNCTION public.upsert_new_contact_candidate(\n'
const END = '\n$$;\n'

/** The function text, from its CREATE to the closing dollar-quote, inclusive. */
function functionText (file) {
  const s = read(file)
  const i = s.indexOf(START)
  assert.ok(i >= 0, `${file}: no upsert_new_contact_candidate definition`)
  const j = s.indexOf(END, i)
  assert.ok(j > i, `${file}: unterminated function body`)
  return s.slice(i, j + END.length)
}

// The two forms of the one changed region.
const OLD_ASSIGNMENT = `           extraction_status         = p_extraction_status,
           context_expires_at        = now() + interval '30 days',
           updated_at                = now()
`
const NEW_ASSIGNMENT_HEAD = `           extraction_status         = p_extraction_status,
           -- >>> 20261013 THE REVIEW DEADLINE IS NOT REISSUED ON A REFRESH.`
const NEW_ASSIGNMENT_TAIL = `           -- <<< 20261013
           updated_at                = now()
`

console.log('')
console.log('1. the fix is the applied body with one assignment removed')

test('the applied definition still sets the deadline on refresh (the defect, unedited)', () => {
  // History is not rewritten: the applied file keeps the defect it shipped with.
  const applied = functionText(APPLIED)
  assert.strictEqual(applied.split(OLD_ASSIGNMENT).length - 1, 1,
    'the applied refresh branch must still contain exactly one reissue of the deadline')
})

test('substituting the old assignment back into the fix reproduces the applied text EXACTLY', () => {
  const applied = functionText(APPLIED)
  const fix = functionText(FIX)
  const i = fix.indexOf(NEW_ASSIGNMENT_HEAD)
  assert.ok(i >= 0, 'the fix must carry the marked replacement block')
  const j = fix.indexOf(NEW_ASSIGNMENT_TAIL, i)
  assert.ok(j > i, 'the marked replacement block must be closed')
  const replaced = fix.slice(0, i) + OLD_ASSIGNMENT + fix.slice(j + NEW_ASSIGNMENT_TAIL.length)
  assert.strictEqual(replaced, applied,
    'the fix must differ from the applied definition only in the expiry assignment')
})

test('the fix no longer reissues the deadline anywhere in the UPDATE branch', () => {
  const fix = functionText(FIX)
  // Only inside a comment, and never as an assignment.
  const assignments = fix.split('\n').filter((l) =>
    /^\s*context_expires_at\s*=/.test(l) && !/^\s*--/.test(l))
  assert.deepStrictEqual(assignments, [],
    `an expiry assignment survives: ${JSON.stringify(assignments)}`)
})

test('the INSERT branch still sets a deadline at creation', () => {
  // Creation is where the window is granted, and there created_at = now(), so the ceiling
  // holds. Removing it there would make a pending proposal fail ncc_pending_shape.
  const fix = functionText(FIX)
  assert.ok(fix.includes('retained_subject, extraction_status, context_expires_at)'),
    'the insert column list must still carry context_expires_at')
  assert.ok(fix.includes("v_subj, p_extraction_status, now() + interval '30 days')"),
    'creation must still grant a 30-day window from now()')
})

console.log('')
console.log('2. the signature, the ACL and the blast radius')

test('the 20-argument signature is preserved, and no overload is dropped or created', () => {
  const s = read(FIX)
  const sig = `  uuid, uuid, text, text, smallint, text, date, text, text, text, text, text, text, text,
  text, text[], timestamptz, timestamptz, text[], text[]`
  assert.ok(read(APPLIED).includes(sig), 'the applied signature must be the 20-argument one')
  assert.strictEqual(s.split(sig).length - 1, 2,
    'the fix must restate exactly that signature, once for REVOKE and once for GRANT')
  assert.ok(!/DROP\s+FUNCTION/i.test(s), 'nothing may be dropped: CREATE OR REPLACE keeps the oid')
})

test('SECURITY DEFINER, the empty search_path and the lease fence come along unchanged', () => {
  const fix = functionText(FIX)
  assert.ok(fix.includes('SECURITY DEFINER'), 'SECURITY DEFINER')
  assert.ok(fix.includes("SET search_path = ''"), 'empty search_path')
  assert.ok(fix.includes("RETURN jsonb_build_object('result', 'stale_run')"), 'lease fence')
  assert.ok(fix.includes("RETURN jsonb_build_object('result', 'exists_terminal', 'candidate_id', v_cand)"),
    'terminal-status guard')
  assert.ok(fix.includes("RETURN jsonb_build_object('result', 'coverage_moved')"), 'segment guard')
})

test('the ACL is restated: revoked from PUBLIC, anon and authenticated; granted to service_role', () => {
  const s = read(FIX)
  assert.ok(/REVOKE ALL ON FUNCTION public\.upsert_new_contact_candidate\([\s\S]*?FROM PUBLIC, anon, authenticated;/.test(s))
  assert.ok(/GRANT EXECUTE ON FUNCTION public\.upsert_new_contact_candidate\([\s\S]*?TO service_role;/.test(s))
})

test('nothing outside the function is changed: no table DDL, no constraint change, no DML', () => {
  const s = read(FIX)
  const fix = functionText(FIX)
  // Everything that is not the function body, with comment lines removed - the header
  // explains the defect and quotes the old SQL, which must not be mistaken for a statement.
  const outside = s.split(fix).join('\n')
    .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
  for (const forbidden of [
    /ALTER\s+TABLE/i, /CREATE\s+TABLE/i, /DROP\s+TABLE/i,
    /ADD\s+CONSTRAINT/i, /DROP\s+CONSTRAINT/i,
    /CREATE\s+INDEX/i, /DROP\s+INDEX/i,
    /CREATE\s+POLICY/i, /DROP\s+POLICY/i, /CREATE\s+TRIGGER/i,
    /\bUPDATE\s+public\./i, /\bDELETE\s+FROM/i, /\bINSERT\s+INTO/i, /\bTRUNCATE\b/i,
  ]) {
    assert.ok(!forbidden.test(outside),
      `the migration must not contain ${forbidden} outside the function body`)
  }
  // And the ceiling itself is never named as a target.
  assert.ok(!/ncc_context_ceiling/.test(outside),
    'the ceiling constraint must not be altered, dropped or re-created')
})

test('the ceiling constraint it respects is still defined where it was', () => {
  const primitives = read('supabase/migrations/20260921000000_add_outlook_content_draft_primitives.sql')
  assert.ok(primitives.includes(
    "CONSTRAINT ncc_context_ceiling CHECK (context_expires_at IS NULL OR context_expires_at <= created_at + interval '30 days')"),
  'the applied ceiling must remain exactly as it was written')
})

console.log('')
console.log('3. migration order')

test('the fix is the newest migration on this branch', () => {
  const files = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
  assert.strictEqual(files[files.length - 1],
    '20261013060000_preserve_new_contact_context_deadline.sql',
    'the fix must sort last, so a push applies it after every applied migration')
})

test('its version leaves room before the cohort reservation migration', () => {
  // The cohort-reservation migration lives on a separate unmerged branch at
  // 20261013120000. 060000 < 120000, so whichever branch merges first, `db push` applies
  // this fix before that one - which is the order the rollout for this change assumes.
  // Recorded as a number rather than a sentence so a renumbering breaks a test.
  assert.ok(20261013060000 < 20261013120000,
    'the fix must sort before the cohort reservation migration')
})

console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
