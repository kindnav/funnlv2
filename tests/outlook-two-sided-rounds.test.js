// TWO-WAY COMMUNICATION, WHICHEVER SIDE STARTED, ACROSS ROUNDS - THROUGH THE REAL WORKER.
//
// THE REQUIREMENT, stated once. A NEW-CONTACT suggestion needs two-way communication
// with the same person, regardless of who opened the thread:
//
//   1. user sends -> person replies;
//   2. person sends -> user replies.
//
// A single unanswered message must never produce one. Both halves feed the drafted
// interaction. The two halves MAY arrive in different, separately completed import
// rounds. The same two-way rule applies to an existing contact. Acceptance creates the
// contact and the interaction together, after review.
//
// WHAT IS EXECUTED: the REAL worker handler (handleOutlookImportWorker) over the real
// run, the real accumulator, conversation recovery, the real content pass with the real
// screening, the real write planner and the real provider transports - driven by one
// fixture fetch that answers every surface the run touches (Graph delta, Graph message
// envelope, Graph conversation lookup, Graph message content, the Anthropic endpoint)
// and throws on anything else. No network, no database, no browser.
//
// THE TWO CORRECTIONS pinned in sections 3b and 3c were both REPRODUCED through this
// handler before they were made: the user's one older sent message falling out of a
// newest-six selection behind seven replies, and a continuing exchange that was two-sided
// in both rounds being CREATED twice because the second round anchored its identity on
// its own opening message - and, once that was corrected, the same duplicate still being
// written whenever the required recovery was REFUSED (400, truncated page, 404). A refused
// recovery is now a reported no-write settlement (3c).
//
// THE ROUND STORE is the shared in-memory stand-in for the SQL round state and mirrors
// the applied schema's two lifecycle facts exactly: a confirmed complete release ERASES
// the accumulator (release_outlook_sync_lease, 20261002000000:1164) AND the message
// handles (20261007000000, orm_round_conv_fk cascade). So nothing a previous round stored
// is available to a later one here, and cross-round recovery can only pass by asking the
// fixture's "Outlook" - which models arrival: a message exists there from the round in
// which the delta delivered it.
//
// NO REAL IDENTIFIER, ADDRESS, BODY OR KEY APPEARS IN THIS FILE.
//
// Run with: node tests/outlook-two-sided-rounds.test.js

import assert from 'node:assert'
import { readFileSync } from 'node:fs'

let passed = 0
let failed = 0
async function test (name, fn) {
  try {
    await fn()
    console.log('  OK   ' + name)
    passed += 1
  } catch (e) {
    console.error('  FAIL ' + name)
    console.error('       ' + (e && e.message ? e.message : String(e)))
    failed += 1
  }
}

const NL = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8').split(CR).join('')

// -- invented fixtures. No real account, address, id, token or key. ----------
          // already one of the user's contacts
      // not a contact: the unknown-person path

// Four bodies, two per exchange, each side distinctive enough that the model request
// can be checked for BOTH halves from its text alone - which is all the request carries.


/**
 * One exchange with `party`: who wrote first, the two (optionally three) envelopes, their
 * folders and bodies. Ids and conversation ids are invented.
 */


/**
 * The PostgREST + RPC pair for ONE connection across as many invocations as the test
 * makes. The round store persists between invocations exactly as the tables would -
 * including erasing the accumulator AND the handles on a complete release - and the
 * committed cursors are served back from it the way the real loader reads them.
 *
 * Candidate writes are deduplicated by episode fingerprint the way the two write RPCs
 * do - a repeat answers 'refreshed' - so a re-read of the same exchange can be shown to
 * produce no second proposal.
 */


/**
 * A MAILBOX SERVED IN ROUNDS, that also answers as "Outlook" when asked about a thread.
 *
 * `rounds[folder][k]` is the page the folder answers in its (k+1)th round. A request with
 * no $deltatoken is the first round; `Rk` - the deltaLink the previous round committed -
 * is round k+1. Every page is final, so one invocation completes one round.
 *
 * ARRIVAL IS MODELLED: a message exists in Outlook from the round whose delta page carried
 * it. So in round 1 a lookup cannot find a reply that only arrives in round 2.
 */


/** Build a scenario: who the party is, which side wrote first, and how the messages are spread over rounds. */


// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('1. an unknown person is proposed WHICHEVER SIDE STARTED, when both halves are in one round')
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('2. a single unanswered message proposes nothing, in either direction')
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('3. the two halves in DIFFERENT, SEPARATELY COMPLETED rounds are recognised as one exchange')
// ═══════════════════════════════════════════════════════════════════════════════
//
// Round 1 reads the first half alone: the thread is one-sided, Outlook is asked and
// confirms there is no reply yet, nothing is written, the round completes, both cursors
// commit and the accumulator AND the handles are erased. Round 2 follows the committed
// deltaLink and reads the reply alone - a thread it does not remember - asks Outlook for
// the rest of it, gets both halves back, folds them exactly as a same-round read would,
// reads both bodies, drafts, and writes ONE suggestion under the SAME episode key the
// one-round control produced.

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('3b. BOTH SIDES survive the selection when one side wrote much more')
// ═══════════════════════════════════════════════════════════════════════════════
//
// REPRODUCED through this handler before the correction: round 1 held the user's one sent
// message and committed; round 2 brought seven newer replies; recovery qualified the
// exchange; the merged handles were sorted newest-first and cut to six - all inbound - and
// the user's own words were absent from the model request. ONE selection rule now applies
// to stored and recovered handles alike (selectBalancedHandles: the newest two per folder
// first, then recency), and the episode bound after the bodies are read reserves the
// newest two per direction the same way. The request builder refuses an oversized request
// rather than trimming it, so there is no later point at which the account turns one-sided.

/**
 * A thread of ANY shape. Each turn is [who, day, hour, body]: `who` is 'me', 'them' or an
 * invented address for a third person; the folder follows who wrote. Ids are invented.
 */

/** Run `threads` over rounds: `schedule[k]` lists the message ids whose delta page arrives in round k+1. */

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('3c. a CONTINUING exchange keeps ONE identity, whichever sides wrote between imports')
// ═══════════════════════════════════════════════════════════════════════════════
//
// REPRODUCED before the correction: round 1 - a message and the user's reply - left a
// pending proposal; round 2 - a further message and a further reply - was two-sided on its
// own, so recovery was bypassed, the episode was anchored on round 2's opening message, a
// DIFFERENT fingerprint, and the run answered created:1 instead of refreshing. Now a delta
// round completes EVERY conversation it is about to write from Outlook first, so the fold
// anchors on the thread's first message as Outlook holds it - the anchor a first pass
// produces - and the write RPC refreshes the pending row. The draft is built from the whole
// thread for the same reason.

// WHEN THE REQUIRED RECOVERY IS REFUSED. Reproduced through this handler before the
// correction, for a known and for an unknown person: round 1 created a pending suggestion;
// round 2 held further messages from both sides; recovery settled as recovery_unsupported,
// recovery_truncated or recovery_source_missing; the worker wrote the round-local view under
// a DIFFERENT fingerprint and answered created:1 again. Now a deterministic refusal is a
// reported no-write settlement: the pending suggestion and its draft stand, nothing further
// is read or drafted, and the conversation is passed under the recovery's own code. Only a
// transient failure or a budget/cap interruption keeps the conversation for the next
// invocation (section 4, last test). The three codes are produced by fixture faults - a 400,
// a page carrying @odata.nextLink, a 404 - not by the provider; what the provider actually
// answers to the filter is the owner-run Graph Explorer check.

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('4. when recovery cannot complete the exchange, it fails safely')
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('5. nothing durable was added, so disconnect has nothing new to clear')
// ═══════════════════════════════════════════════════════════════════════════════
const MIG8 = read('supabase/migrations/20261008000000_outlook_known_contact_follow_up_provenance.sql')

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('6. the write RPC: the follow-up and provenance parameters, refresh semantics, and nothing else changed')
// ═══════════════════════════════════════════════════════════════════════════════
const OLD = read('supabase/migrations/20261006000000_outlook_content_note_and_new_contact_write.sql')
function fnBody (sql, head) {
  const i = sql.indexOf(head)
  assert.ok(i >= 0, 'definition not found: ' + head)
  const s = sql.indexOf('AS $$', i)
  const e = sql.indexOf('$$;', s)
  return sql.slice(s + 'AS $$'.length, e)
}
function fnParams (sql, head) {
  const i = sql.indexOf(head)
  const seg = sql.slice(i, sql.indexOf('RETURNS', i))
  const out = []
  for (const line of seg.split(NL)) {
    const t = line.trim()
    if (t.startsWith('p_')) out.push(t.split(/\s+/)[0])
  }
  return out
}
function withoutMarkedBlocks (text) {
  const kept = []
  let skipping = false
  for (const line of text.split(NL)) {
    if (line.indexOf('-- >>> 20261008') >= 0) { skipping = true; continue }
    if (line.indexOf('-- <<< 20261008') >= 0) { skipping = false; continue }
    if (!skipping) kept.push(line)
  }
  assert.strictEqual(skipping, false, 'an unclosed 20261008 block')
  return kept
}
function normalized (lines) {
  const out = []
  for (let l of lines) {
    l = l.trimEnd()
    while (l.endsWith(',') || l.endsWith(')')) l = l.slice(0, -1).trimEnd()
    if (l.trim().length > 0) out.push(l)
  }
  return out
}
function assertSameBody (newLines, oldLines) {
  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i += 1) {
    assert.strictEqual(newLines[i], oldLines[i],
      'first difference at body line ' + (i + 1) + ': applied=' + JSON.stringify(oldLines[i]) + ' new=' + JSON.stringify(newLines[i]))
  }
}
const UPSERT = 'CREATE FUNCTION public.upsert_outlook_interaction_candidate('

await test('upsert: newest, NOT APPLIED, drops the 10-argument form, creates the 13-argument one, ACL restated', () => {
  assert.ok(MIG8.indexOf('NOT APPLIED') >= 0)
  assert.ok(MIG8.indexOf('uuid, uuid, uuid, text, text, smallint, text, date, text[], text);') >= 0, 'drops exactly the applied signature')
  assert.ok(MIG8.indexOf('CREATE OR REPLACE FUNCTION public.upsert_outlook_interaction_candidate') < 0)
  assert.deepStrictEqual(fnParams(MIG8, UPSERT), [
    'p_connection_id', 'p_run_id', 'p_contact_id', 'p_episode_fingerprint', 'p_person_fingerprint',
    'p_key_version', 'p_proposed_type', 'p_proposed_date', 'p_lookup_fingerprints', 'p_proposed_notes',
    'p_draft_follow_up', 'p_summary_evidence', 'p_extraction_status',
  ])
  assert.deepStrictEqual(fnParams(OLD, UPSERT), fnParams(MIG8, UPSERT).slice(0, 10))
  assert.ok(MIG8.indexOf('upsert_outlook_interaction_candidate(\n  uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text\n) FROM PUBLIC, anon, authenticated;') >= 0)
  assert.ok(MIG8.indexOf('upsert_outlook_interaction_candidate(\n  uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text\n) TO service_role;') >= 0)
  assert.ok(MIG8.indexOf('p_retained_subject') < 0, 'no subject on the known-contact row')
})
await test('upsert: the body is the applied body plus exactly the marked additions', () => {
  const oldLines = normalized(fnBody(OLD, UPSERT).split(NL))
  const newLines = normalized(withoutMarkedBlocks(fnBody(MIG8, UPSERT)))
  assertSameBody(newLines, oldLines)
  assert.strictEqual(newLines.length, oldLines.length)
})
await test('upsert: validation mirrors the applied CHECKs with controlled codes', () => {
  const body = fnBody(MIG8, UPSERT)
  assert.ok(body.indexOf('char_length(v_follow) > 160') >= 0)
  assert.ok(body.indexOf("'invalid_follow_up'") >= 0 && body.indexOf("'invalid_evidence'") >= 0 && body.indexOf("'invalid_extraction_status'") >= 0)
  assert.ok(body.indexOf('IF v_follow IS NOT NULL AND (v_notes IS NULL') >= 0, 'a next step without a note is refused')
  assert.ok(body.indexOf("p_summary_evidence NOT IN ('explicit_body', 'subject_only')") >= 0)
  assert.ok(body.indexOf("p_extraction_status NOT IN ('deterministic', 'ai_extracted', 'ai_failed')") >= 0)
  assert.ok(body.indexOf('SQLERRM') < 0)
})
await test('upsert REFRESH: a new draft replaces the step (clearing it when absent); a metadata-only refresh preserves everything', () => {
  const body = fnBody(MIG8, UPSERT)
  assert.ok(body.indexOf('draft_follow_up          = CASE WHEN v_notes IS NOT NULL THEN v_follow ELSE draft_follow_up END') >= 0,
    'the step turns on whether THIS call carried a note - a new draft with no step clears the old one')
  assert.ok(body.indexOf('COALESCE(v_follow, draft_follow_up)') < 0, 'COALESCE kept an obsolete step beside a new summary')
  assert.ok(body.indexOf('summary_evidence         = CASE WHEN v_notes IS NOT NULL THEN p_summary_evidence ELSE summary_evidence END') >= 0)
  assert.ok(body.indexOf('extraction_status        = CASE WHEN v_notes IS NOT NULL THEN p_extraction_status ELSE extraction_status END') >= 0)
  assert.ok(body.indexOf('proposed_notes           = COALESCE(v_notes, proposed_notes)') >= 0, 'the note itself still coalesces, as applied')
  assert.ok(body.indexOf('CASE WHEN p_summary_evidence IS NOT NULL THEN v_notes END') >= 0, 'draft_summary and its evidence move as a pair')
})

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('7. the accept RPC keeps the approved next step and the chosen date, and nothing else changed')
// ═══════════════════════════════════════════════════════════════════════════════
const ACCEPT_OLD = 'CREATE OR REPLACE FUNCTION public.accept_interaction_candidate('
const ACCEPT_NEW = 'CREATE FUNCTION public.accept_interaction_candidate('
// Exactly two lines of the applied body are replaced, named here so the diff is explicit.
const REPLACED = [
  ['    INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes, source, follow_up_date)',
    '    INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes, source)'],
  ['    VALUES (v_cand.contact_id, v_uid, v_type, v_date, v_final, v_src, p_follow_up_date)',
    '    VALUES (v_cand.contact_id, v_uid, v_type, v_date, v_notes, v_src)'],
]
await test('accept: drops the applied 4-argument form, creates the 6-argument one, authenticated-only ACL restated', () => {
  assert.ok(MIG8.indexOf('DROP FUNCTION IF EXISTS public.accept_interaction_candidate(uuid, text, date, text);') >= 0)
  assert.ok(MIG8.indexOf(ACCEPT_OLD) < 0, 'a signature change is never CREATE OR REPLACE')
  assert.deepStrictEqual(fnParams(MIG8, ACCEPT_NEW), ['p_candidate_id', 'p_override_type', 'p_override_date', 'p_override_notes', 'p_follow_up', 'p_follow_up_date'])
  assert.deepStrictEqual(fnParams(OLD, ACCEPT_OLD), fnParams(MIG8, ACCEPT_NEW).slice(0, 4))
  assert.ok(MIG8.indexOf('REVOKE ALL ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text, text, date)\n  FROM PUBLIC, anon;') >= 0)
  assert.ok(MIG8.indexOf('GRANT EXECUTE ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text, text, date)\n  TO authenticated;') >= 0)
  assert.ok(!/accept_interaction_candidate\([^)]*\)\s*TO service_role/.test(MIG8), 'never granted to service_role')
})
await test('accept: the body is the applied body plus the marked additions and exactly the two named replaced lines', () => {
  const oldLines = normalized(fnBody(OLD, ACCEPT_OLD).split(NL))
  const kept = withoutMarkedBlocks(fnBody(MIG8, ACCEPT_NEW)).map((line) => {
    for (const [replaced, original] of REPLACED) if (line === replaced) return original
    return line
  })
  const newLines = normalized(kept)
  assertSameBody(newLines, oldLines)
  assert.strictEqual(newLines.length, oldLines.length)
  // Both replacements really are in the file (so the mapping above did real work).
  for (const [replaced] of REPLACED) assert.ok(MIG8.indexOf(replaced) >= 0, 'missing: ' + replaced)
})
await test('accept: the approved step is validated, saved into the note, and the date is the reviewer\'s own', () => {
  const body = fnBody(MIG8, ACCEPT_NEW)
  assert.ok(body.indexOf("v_follow := NULLIF(pg_catalog.btrim(COALESCE(p_follow_up, '')), '')") >= 0)
  assert.ok(body.indexOf('char_length(v_follow) > 160') >= 0 && body.indexOf("'invalid_follow_up'") >= 0)
  assert.ok(body.indexOf("'Next step: ' || v_follow") >= 0, 'kept as part of the note')
  assert.ok(body.indexOf('pg_catalog.chr(10) || pg_catalog.chr(10)') >= 0, 'separated from the note by a blank line')
  assert.ok(body.indexOf('WHEN v_follow IS NULL THEN v_notes') >= 0, 'a cleared step leaves the note alone')
  assert.ok(body.indexOf('v_cand.draft_follow_up') < 0, 'the draft column is never read back at accept time - only the reviewer\'s value is saved')
  assert.ok(body.indexOf('p_follow_up_date)') >= 0, 'the date passed in is the date saved')
  assert.ok(!/p_follow_up_date\s*[+-]|interval/.test(body.replace(/^\s*--.*$/gm, '')), 'no date is derived or shifted')
  // The applied guards are still there, verbatim (the diff guard proves it; these name the ones that matter).
  for (const g of ["'already_accepted'", "'interaction_previously_deleted'", "'dismissed'", "'invalidated'", "'expired'",
    'FOR KEY SHARE', 'foreign_key_violation', 'deadlock_detected OR serialization_failure',
    'draft_summary = NULL, draft_follow_up = NULL, summary_evidence = NULL']) {
    assert.ok(body.indexOf(g) >= 0, 'guard missing: ' + g)
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('8. the planner and the review surface')
// ═══════════════════════════════════════════════════════════════════════════════
// The review card is retired (Stage D); the retained calendarReview.js helper keeps its follow-up bounds.

console.log('')

// Rejected committed tokens are fixtures, not a diagnosis of the pilot's valid cursors.

// ═══════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('9. CHECKPOINT 1 - the seven demonstrations, through the real handler and the RPC contracts')

// The settled exchange and the later one are tagged so the MODEL REQUEST can be read: the
// request for the second suggestion must carry the second exchange and must NOT carry the
// first, which a reviewer has already decided and whose note is already written.

// D7. A REQUIRED PERSISTENCE OPERATION FAILS. Each of the three new RPCs is required for a
// different reason, and none of them may be treated as best-effort: without the coverage read
// the run cannot tell a settled exchange from a new one; without the hint an unanswered half
// is lost for good; without the baseline a legacy thread would be guessed at. So each failure
// forfeits the cursor and the round is retried from where it last committed.

// ── THE OCTOBER 12 PILOT FAILURE, AT THE HANDLER ─────────────────────────────
// A real two-way exchange produced NO suggestion. The cause was established by running
// its four actual messages through the real content path OFFLINE - minimization_failed,
// categories ["address"], before the model - because the notification-kicked run's own
// report was not retained. Two causes, both present in real mail and both exercised here
// together, through the real worker:
//   * the inbound signature carried the sender's own address - and a signature is the
//     one place this product accepts a company or a title from, so it cannot be dropped;
//   * the provider display name WAS the address, which went into the request and was
//     also the fallback proposed name.
// The exchange is split across rounds, so the inbound half is recovered in round 2 - the
// same shape the pilot hit.

// The same two hazards with NO model name to fall back on: the display name must not
// become the proposed name, and nothing may be invented from the local part.

console.log((passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed')
console.log('')
if (failed > 0) process.exit(1)
