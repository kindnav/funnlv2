// Outlook DURABLE CONTINUATION — the four cases this slice exists to make safe.
//
// WHAT IS ACTUALLY DEMONSTRATED HERE, against controlled fixtures and a virtual clock:
//   1. an import that needs MORE THAN ONE INVOCATION and more than the 20-page
//      per-invocation ceiling;
//   2. a relevant two-sided exchange whose halves land in DIFFERENT INVOCATIONS;
//   3. a CRASH after a checkpoint, and a retry that neither re-applies nor skips a page;
//   4. a SAVED continuation token that Microsoft rejects.
//
// And in every one of them: no premature candidate, no skipped mail, exactly one pending
// suggestion once the round completes, and no contact or interaction written at all.
//
// WHY A VIRTUAL CLOCK. The invocation budget exists because hosted Edge Functions have a
// 150s request idle timeout and a 150s wall clock on the free plan. Local Deno enforces
// neither, so waiting for a real timeout would prove nothing - the deadline is driven by
// an injected clock and asserted directly. The REAL database path is covered separately by
// tests/sql/outlook-durable-continuation-runtime.sql and by
// tests/local/outlook-worker-token-access.mjs against real PostgREST.

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
   // the version these fixtures' connections consented under; injected as the background requirement

let passed = 0, failed = 0
const pending = []
function test (name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { passed += 1; console.log(`  ✓ ${name}`) },
        (e) => { failed += 1; console.log(`  ✗ ${name}`); console.log(`    ${e.message}`) },
      ))
      return
    }
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
  }
}

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const MIGRATION = read('supabase/migrations/20261002000000_outlook_durable_continuation.sql')
const DESIGN = read('docs/outlook-durable-continuation-design.md')
const POLICY = read('src/pages/PrivacyPage.jsx')
const READINESS = read('docs/outlook-privacy-consent-readiness.md')


/**
 * A mailbox with many pages per folder, exactly one qualifying message in each folder, and
 * those two placed so they fall in DIFFERENT invocations.
 *
 * Filler messages are from the user to the user, which every rule excludes as `self_only`,
 * so they create no conversation record - but they are still counted as READ, which is what
 * makes the no-skipped-mail assertion meaningful.
 */

/** Everything the run needs, with no real database and no Microsoft. */


/**
 * One connection, many invocations. The store and the call log persist across them, which
 * is the whole point: invocation N+1 must find what invocation N wrote.
 */

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n1. an import that needs several invocations and more than 20 pages')
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n2. the invocation deadline, driven by an injected clock')
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n3. a crash after a checkpoint')
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n4. a saved continuation token that Microsoft rejects')
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n5. the WHOLE invocation is budgeted, not only the page loop')
// ══════════════════════════════════════════════════════════════════════════════

/**
 * A mailbox with `n` qualifying conversations, all on one page per folder, so the round
 * finishes immediately and the expensive part is FINALISATION.
 */

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n6. finalising a large batch spans invocations instead of restarting')
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n7. the accumulator read-back is PAGED, and truncation is whole-round')
// ══════════════════════════════════════════════════════════════════════════════


/**
 * Put the store in the state a FINISHED round leaves behind: both folders complete with
 * a staged cursor, and `n` accumulator rows waiting to be finalised.
 *
 * Seeded directly rather than through Graph pages because these tests are about
 * finalisation, and 450 qualifying conversations would otherwise need 450 fixture
 * messages to say nothing extra.
 */

/** A round that is already finished needs no Graph page at all. */

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n8. a round expires AS ONE UNIT, and a new one can always start')
// ══════════════════════════════════════════════════════════════════════════════

/** A harness whose store shares the test's virtual clock, so expiry is controllable. */

test('the design records the expiry rule, its cost and its remaining limit', () => {
  assert.ok(DESIGN.includes('5d. A round expires as ONE unit'))
  // All three reproduced failures, named.
  assert.ok(DESIGN.includes('It could get stuck'))
  assert.ok(DESIGN.includes('It could skip mail'))
  assert.ok(DESIGN.includes('The two folders could disagree'))
  // The rule itself.
  assert.ok(DESIGN.includes('One deadline per round'))
  assert.ok(DESIGN.includes('Records have no deadline of their own'))
  assert.ok(DESIGN.includes('discarded as a unit'))
  // Honest about what it costs and what it does not fix.
  assert.ok(DESIGN.includes('Can a long import still make progress'))
  assert.ok(DESIGN.includes('re-reading pages from the committed cursor'))
  assert.ok(DESIGN.includes('The remaining limit, stated'))
  // And the thing that must stay open.
  assert.ok(DESIGN.includes('D2 as a decision sheet'),
    'the cross-round privacy decision must stay open')
})

// ══════════════════════════════════════════════════════════════════════════════
console.log('\nthe fingerprint is stable however the round was split')
// ══════════════════════════════════════════════════════════════════════════════


/** The same normalization the transport does, so the fold sees what it sees in a run. */

// The inbound halves come from Inbox and the outbound half from Sent Items, because the
// folder is what decides direction when the sender is the user.

/** Fold a list of page-groups through the store and read the accumulated record back. */

// ══════════════════════════════════════════════════════════════════════════════
console.log('\nwhat is written down, and what is not')
// ══════════════════════════════════════════════════════════════════════════════

test('the accumulator table has no column that could hold content', () => {
  const table = /CREATE TABLE IF NOT EXISTS public\.outlook_conversation_progress[\s\S]*?\n\);/
    .exec(MIGRATION)[0]
  for (const forbidden of ['body', 'html', 'mime', 'snippet', 'preview', 'subject',
    'header', 'email', 'address', 'display_name', 'message_id', 'conversation_id',
    'provider_message', 'provider_conversation']) {
    assert.ok(!table.toLowerCase().includes(forbidden),
      `outlook_conversation_progress must have no ${forbidden} column`)
  }
  // Every provider-derived column is a fingerprint, and each has a shape CHECK.
  for (const fp of ['conversation_fingerprint', 'person_fingerprint', 'episode_fingerprint',
    'first_message_fingerprint']) {
    assert.ok(table.includes(fp), fp)
  }
  assert.ok(/ocp_conv_fp_shape\s+CHECK \(conversation_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/.test(table))
})

test('the nextLink is stored encrypted, and the pending delta is never the committed one', () => {
  assert.ok(/next_link_ciphertext\s+text/.test(MIGRATION))
  assert.ok(/pending_delta_ciphertext\s+text/.test(MIGRATION))
  // Mutually exclusive: a folder is either mid-stream or finished, never both.
  assert.ok(/oss_round_position_exclusive[\s\S]*?next_link_ciphertext IS NULL OR pending_delta_ciphertext IS NULL/.test(MIGRATION))
  // The pending cursor is promoted ONLY by a complete release.
  assert.ok(/round bookkeeping, new in 20261002000000/.test(MIGRATION))
  assert.ok(/pending_delta_ciphertext\s+= CASE WHEN v_complete THEN NULL ELSE s\.pending_delta_ciphertext END/.test(MIGRATION))
})

test('all four new RPCs are service_role only', () => {
  for (const fn of ['record_outlook_page_progress', 'read_outlook_round_progress',
    'list_outlook_round_conversations', 'reset_outlook_round']) {
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([\\s\\S]*?\\)\\s*FROM PUBLIC, anon, authenticated;`).test(MIGRATION),
      `${fn} must revoke from PUBLIC, anon AND authenticated`)
    assert.ok(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([\\s\\S]*?\\)\\s*TO service_role;`).test(MIGRATION),
      `${fn} must be granted to service_role only`)
  }
  assert.ok(/REVOKE ALL ON TABLE public\.outlook_conversation_progress FROM authenticated;/.test(MIGRATION))
  assert.ok(/ENABLE ROW LEVEL SECURITY/.test(MIGRATION))
  assert.ok(!/CREATE POLICY[\s\S]*outlook_conversation_progress/.test(MIGRATION),
    'worker state gets no policy for authenticated')
})

test('every checkpoint is fenced on BOTH folder leases', () => {
  const fn = /CREATE OR REPLACE FUNCTION public\.record_outlook_page_progress[\s\S]*?\n\$\$;/.exec(MIGRATION)[0]
  assert.ok(/FOR SHARE/.test(fn), 'the deterministic lock order must be taken first')
  assert.ok(/IF v_n <> 2 THEN[\s\S]{0,120}stale_run/.test(fn),
    'anything short of both folder leases must be stale_run')
  assert.ok(/sync_lease_until > now\(\)/.test(fn))
  // And the position update re-checks the lease, raising rather than half-applying.
  assert.ok(/lease_lost_during_checkpoint/.test(fn))
})

// ══════════════════════════════════════════════════════════════════════════════
console.log('\nthe policy and the decision are recorded, not decided')
// ══════════════════════════════════════════════════════════════════════════════

test('the live policy is UNCHANGED, and does not claim to cover this record', () => {
  // The published "What Funnl would keep" list is exhaustive. It does not name
  // per-conversation progress, and this branch must not pretend otherwise by editing it.
  for (const notThere of ['outlook_conversation_progress', 'conversation progress',
    'partial conversation state', 'continuation']) {
    assert.ok(!POLICY.toLowerCase().includes(notThere.toLowerCase()),
      `the live policy must not be edited here (found: ${notThere})`)
  }
  // What it DOES already say, which is why the field KINDS are covered even though the
  // record is not.
  assert.ok(POLICY.includes('one-way keyed fingerprints'))
  assert.ok(POLICY.includes('per-folder synchronization position'))
})

test('the design names the decision instead of making it', () => {
  assert.ok(/### D1\./.test(DESIGN), 'the policy gap must be D1')
  assert.ok(/### D2\./.test(DESIGN), 'the retention question must be D2')
  assert.ok(/one bullet must be added to the published policy/.test(DESIGN))
  assert.ok(/Round-scoped \(what is implemented\)/.test(DESIGN))
  assert.ok(/reply next week/.test(DESIGN),
    'the case round-scoped state cannot serve must be stated plainly')
  assert.ok(/not a choice an implementation[\s\S]{0,40}make quietly/.test(DESIGN))
  // And the runtime facts it is sized against, with the plan honestly unknown.
  assert.ok(/150 s free \/ 400 s paid/.test(DESIGN))
  assert.ok(/plan is not established/i.test(DESIGN))
  assert.ok(/Background tasks do not remove the wall limit/.test(DESIGN))
})

test('the design records that the WHOLE invocation is budgeted, and what still is not', () => {
  // The two stages that used to run outside the budget, and the honest verdict on each.
  assert.ok(DESIGN.includes('5a. The budget covers the WHOLE invocation'))
  assert.ok(DESIGN.includes('having read no mail and saved no checkpoint'),
    'the context-load reproduction must be recorded')
  assert.ok(DESIGN.includes('800 s'),
    'the finalisation reproduction must be recorded with its real number')
  assert.ok(DESIGN.includes('began again'))
  assert.ok(DESIGN.includes('at the first entry'))
  // The context load was listed as an enablement blocker on the strength of a ceiling.
  // It is now MEASURED, so the design must carry the numbers rather than the claim - and
  // must not quietly drop the limits the measurement does not cover.
  assert.ok(DESIGN.includes('sum of per-call timeout ceilings'),
    'the 285s figure must be explained as a ceiling, not a path')
  assert.ok(DESIGN.includes('245-268 ms') || DESIGN.includes('245–268 ms'),
    'the measured cost at the supported maximum must be recorded')
  assert.ok(DESIGN.includes('What was NOT measured: hosted latency'),
    'the measurement must state what it cannot cover')
  assert.ok(DESIGN.includes('6.7 s per call'),
    'the hosted threshold that would exhaust the budget must be stated')
  // The multiplier must be DERIVED, not asserted: 120,000 ms over 18 calls is ~6.7 s a
  // call against a measured ~14 ms, which is ~450-500x - an earlier draft said 25x.
  assert.ok(DESIGN.includes('450–500×') || DESIGN.includes('450-500x'),
    'the per-call slowdown multiplier must be the derived one')
  assert.ok(!DESIGN.includes('25× worse') && !DESIGN.includes('25x worse'),
    'the superseded 25x figure must be gone')
  assert.ok(DESIGN.includes('120,000 ms / 18 calls'),
    'the derivation must be shown so the arithmetic is checkable')
  assert.ok(DESIGN.includes('The residual, stated honestly'),
    'the liveness residual must stay visible')
  assert.ok(DESIGN.includes('Supported capacity'),
    'the supported account size must be stated')
  // And the trade-off in persisting the write cursor once per invocation is stated.
  assert.ok(DESIGN.includes('once per invocation'))
  assert.ok(DESIGN.includes('bounded rework, never a lost'))
})

test('the design records the measured read-back size and the whole-round gate', () => {
  assert.ok(DESIGN.includes('5b. The accumulator read-back is paged'))
  // The numbers that forced paging, not an estimate.
  assert.ok(DESIGN.includes('1,204,055 bytes'))
  assert.ok(DESIGN.includes('262,144 bytes'))
  assert.ok(DESIGN.includes('4.6'))
  assert.ok(DESIGN.includes('clamps'), 'the SQL must be recorded as clamping, not defaulting')
  assert.ok(DESIGN.includes('same ordered write cursor'))
  // And the regression, named as one.
  assert.ok(DESIGN.includes('5c. A shortened exchange forfeits'))
  assert.ok(DESIGN.includes('committed both cursors past an exchange it had discarded'))
  assert.ok(DESIGN.includes('cannot be a check on the page in hand'))
  assert.ok(DESIGN.includes('round_truncated_episodes'))
})

test('the cross-round decision sheet names fields, retention, deletion and wording', () => {
  // The owner has to be able to decide on specifics, not in the abstract.
  assert.ok(DESIGN.includes('D2 as a decision sheet'))
  assert.ok(DESIGN.includes('Minimum retained fields'))
  assert.ok(DESIGN.includes('Booleans, not counts'),
    'the minimum must be argued, not just listed')
  assert.ok(DESIGN.includes('90 days from'))
  assert.ok(DESIGN.includes('Alternatives worth rejecting'))
  assert.ok(DESIGN.includes('Deletion on disconnect'))
  assert.ok(DESIGN.includes('Exact privacy wording for review'))
  // It must still be a PROPOSAL: nothing implemented, and the live policy untouched.
  assert.ok(DESIGN.includes('Nothing below is implemented'))
  assert.ok(!MIGRATION.includes('inbound_seen'),
    'the cross-round fields must NOT be implemented by this branch')
  // Checked on a phrase unique to the PROPOSAL. '90 days' alone appears in the live
  // policy already - for Gmail's initial lookback window, which is unrelated.
  assert.ok(POLICY.includes('looks back roughly 90 days'),
    'sanity: the unrelated Gmail lookback is what the live policy says about 90 days')
  for (const proposed of ['whether each side has replied',
    'after the last message it saw', 'recognize a reply that arrives later']) {
    assert.ok(!POLICY.includes(proposed),
      `the proposed retention wording must not be published: ${proposed}`)
  }
  // The readiness packet must point at it, so the decision is not buried in a design doc.
  assert.ok(READINESS.includes('decision sheet'))
  assert.ok(READINESS.includes('expire_pending_outlook_context'),
    'approving it would add a second expiry path while the first is unscheduled')
})
test('the migration says the accumulator is round-scoped and promises nothing more', () => {
  assert.ok(/ROUND-SCOPED/.test(MIGRATION))
  assert.ok(/No\s*\n?-- scheduler is introduced and no retention window is promised/.test(MIGRATION)
    || /no retention window is promised/.test(MIGRATION))
  assert.ok(/does NOT\s*\n?-- yet name this record/.test(MIGRATION)
    || /does NOT[\s\S]{0,80}name this record/.test(MIGRATION))
})

// Explicit provider rejections only: these are fixtures, not a claim that the pilot's
// currently valid cursors have expired. Both folders form one atomic round.

test('forward reset migration changes only the marked cursor-clearing block', () => {
  // Line endings are normalized on both sides: a checkout with autocrlf carries CRLF in one
  // file and LF in the other, and the comparison is about the SQL, not the newline bytes.
  const lf = (t) => t.replace(/\r\n/g, '\n')
  const forward = lf(read('supabase/migrations/20261010050349_recover_rejected_outlook_delta_cursors.sql'))
  const migration = lf(MIGRATION)
  const start = 'CREATE OR REPLACE FUNCTION public.reset_outlook_round('
  const old = migration.slice(migration.indexOf(start), migration.indexOf('\n\n\n-- ', migration.indexOf(start))).trim()
  const body = forward.slice(forward.indexOf(start)).replace(/         -- >>> committed-delta recovery[\s\S]*?         -- <<< committed-delta recovery\n/, '').trim()
  assert.equal(body, old)
})

await Promise.all(pending)
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
