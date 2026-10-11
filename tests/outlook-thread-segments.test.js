// THREAD SEGMENTS - the decisions that let a settled thread carry a later exchange.
//
// The two cases this suite exists for are the ones a timestamp watermark gets wrong:
// messages that share an instant, and a message discovered after a later one. Both are
// proven here against the real module, with no database and no provider.
//
// Run with: node tests/outlook-thread-segments.test.js
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  MAX_SEGMENT_COVERAGE, normalizeCoverage, orderMessages, uncoveredMessages,
  decideSegment, recoveryFloorIso, coverageForSegment, segmentIsTwoSided, unpairedHintIso,
  MAX_UNPAIRED_HINT_PAIRS,
} from '../supabase/functions/shared/outlookThreadSegments.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'supabase/functions/shared/outlookThreadSegments.js'), 'utf8')

let passed = 0, failed = 0
function test (name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

// Distinct, well-formed fingerprints. The shape matters: the module refuses anything that
// is not 64 lowercase hex, because a value that is not a fingerprint proves nothing.
const fp = (n) => String(n).padStart(2, '0').repeat(32).slice(0, 64)
const A = fp(1), B = fp(2), C = fp(3)
const msg = (f, iso, direction = 'inbound') => ({ messageFingerprint: f, timestampIso: iso, direction })

console.log('\ncoverage is set membership, never a timestamp comparison')

test('TWO MESSAGES AT THE SAME INSTANT: the covered one is covered, the other is new', () => {
  // The failure a watermark cannot avoid. Both carry 2026-10-06T09:00:00Z; A was
  // summarized, B never was. A timestamp comparison calls both covered (or both new).
  const messages = [msg(A, '2026-10-06T09:00:00Z'), msg(B, '2026-10-06T09:00:00Z', 'outbound')]
  const out = uncoveredMessages(messages, new Set([A]))
  assert.deepStrictEqual(out.map((m) => m.messageFingerprint), [B],
    'exactly the unsummarized message of the pair is new')
  // And the decision follows: a new segment, not "nothing new".
  const d = decideSegment({ messages, coverage: { covered_fingerprints: [A] } })
  assert.strictEqual(d.action, 'new_segment')
  assert.deepStrictEqual(d.segment.map((m) => m.messageFingerprint), [B])
})

test('DELAYED DISCOVERY: a message older than everything covered is still new', () => {
  // B and C are covered and are LATER than A. A has only just been discovered - moved into
  // the folder, or surfaced by a delta page in a later round. Its timestamp is behind the
  // watermark; it has never been summarized.
  const messages = [
    msg(A, '2026-10-01T08:00:00Z'),
    msg(B, '2026-10-05T08:00:00Z'),
    msg(C, '2026-10-05T09:00:00Z', 'outbound'),
  ]
  const covered = new Set([B, C])
  assert.deepStrictEqual(uncoveredMessages(messages, covered).map((m) => m.messageFingerprint), [A],
    'an unseen older message is new, not covered')
  const d = decideSegment({ messages, coverage: { covered_fingerprints: [B, C] } })
  assert.strictEqual(d.action, 'new_segment', 'it must not be silently discarded')
  assert.strictEqual(d.anchor.messageFingerprint, A, 'and it anchors the segment it belongs to')
})

test('the module decides coverage with no reference to time at all', () => {
  // Same set of fingerprints, timestamps shuffled: the coverage answer cannot move.
  const covered = new Set([A, B])
  const one = uncoveredMessages([msg(A, '2026-01-01T00:00:00Z'), msg(C, '2026-12-31T00:00:00Z')], covered)
  const two = uncoveredMessages([msg(A, '2026-12-31T00:00:00Z'), msg(C, '2026-01-01T00:00:00Z')], covered)
  assert.deepStrictEqual(one.map((m) => m.messageFingerprint), [C])
  assert.deepStrictEqual(two.map((m) => m.messageFingerprint), [C])
})

test('a malformed fingerprint proves nothing and is not treated as coverage', () => {
  const cov = normalizeCoverage({ covered_fingerprints: ['nope', '', null, 'ABCD', A] })
  assert.deepStrictEqual([...cov.covered], [A], 'only well-formed fingerprints survive')
  const d = decideSegment({ messages: [msg(B, '2026-10-06T09:00:00Z')], coverage: { covered_fingerprints: ['nope'] } })
  assert.strictEqual(d.action, 'new_segment', 'a junk covered set does not suppress a real message')
})

console.log('\na pending segment keeps the identity it was created under')

test('a late-discovered EARLIER message refreshes the pending row, it does not re-anchor', () => {
  // The pending segment was created anchored on B. A is discovered afterwards and is
  // earlier. Recomputing the anchor here would produce a second suggestion for one
  // exchange, so the write must go to the fingerprint the pending row already carries.
  const pendingFp = fp(9)
  const d = decideSegment({
    messages: [msg(A, '2026-10-05T07:00:00Z'), msg(B, '2026-10-05T08:00:00Z'), msg(C, '2026-10-05T09:00:00Z', 'outbound')],
    coverage: { pending_episode_fingerprint: pendingFp, pending_covered_fingerprints: [B, C] },
  })
  assert.strictEqual(d.action, 'refresh_pending')
  assert.strictEqual(d.episodeFingerprint, pendingFp, 'identity is the pending row\'s, not the new earliest')
  assert.deepStrictEqual(d.segment.map((m) => m.messageFingerprint), [A, B, C],
    'and the refreshed draft represents the whole uncovered exchange')
})

test('a replay of exactly what is pending still refreshes the same row', () => {
  const pendingFp = fp(9)
  const messages = [msg(B, '2026-10-05T08:00:00Z'), msg(C, '2026-10-05T09:00:00Z', 'outbound')]
  for (let i = 0; i < 3; i++) {
    const d = decideSegment({ messages, coverage: { pending_episode_fingerprint: pendingFp, pending_covered_fingerprints: [B, C] } })
    assert.strictEqual(d.action, 'refresh_pending')
    assert.strictEqual(d.episodeFingerprint, pendingFp, 'every replay lands on one row')
  }
})

test('a pending segment co-exists with settled coverage without re-suggesting it', () => {
  const pendingFp = fp(9)
  const d = decideSegment({
    messages: [msg(A, '2026-10-01T08:00:00Z'), msg(B, '2026-10-05T08:00:00Z'), msg(C, '2026-10-05T09:00:00Z', 'outbound')],
    coverage: { covered_fingerprints: [A], pending_episode_fingerprint: pendingFp, pending_covered_fingerprints: [B] },
  })
  assert.strictEqual(d.action, 'refresh_pending')
  assert.deepStrictEqual(d.segment.map((m) => m.messageFingerprint), [B, C],
    'the settled half stays settled; the pending segment grows')
})

console.log('\nthe remaining decisions')

test('everything covered is NOTHING NEW - the settled thread stays quiet', () => {
  const d = decideSegment({
    messages: [msg(A, '2026-10-05T08:00:00Z'), msg(B, '2026-10-05T09:00:00Z', 'outbound')],
    coverage: { covered_fingerprints: [A, B] },
  })
  assert.strictEqual(d.action, 'nothing_new')
})

test('a settled segment with NO coverage set asks for a forward-only baseline', () => {
  // A row written before this feature. Its coverage is not inferred from the reviewer's
  // date - it is initialized explicitly from what is visible now, and produces no
  // suggestion.
  const d = decideSegment({
    messages: [msg(A, '2026-10-05T08:00:00Z'), msg(B, '2026-10-05T09:00:00Z', 'outbound')],
    coverage: { settled_without_coverage: true },
  })
  assert.strictEqual(d.action, 'baseline')
  assert.deepStrictEqual(d.messages.map((m) => m.messageFingerprint), [A, B])
})

test('a segment larger than the coverage bound defers instead of truncating its proof', () => {
  const many = Array.from({ length: MAX_SEGMENT_COVERAGE + 1 }, (_, i) =>
    msg(fp(i + 10).slice(0, 64), `2026-10-05T08:${String(i).padStart(2, '0')}:00Z`))
  // Distinct fingerprints are required for the bound to be the thing under test.
  const distinct = many.map((m, i) => ({ ...m, messageFingerprint: (i + 1).toString(16).padStart(64, '0') }))
  const d = decideSegment({ messages: distinct, coverage: { covered_fingerprints: [] } })
  assert.strictEqual(d.action, 'defer')
  assert.strictEqual(d.code, 'segment_too_large')
})

test('no fingerprinted messages at all is a deferral, not an empty suggestion', () => {
  assert.deepStrictEqual(decideSegment({ messages: [{ timestampIso: '2026-10-05T08:00:00Z' }] }),
    { action: 'defer', code: 'no_fingerprinted_messages' })
  assert.deepStrictEqual(decideSegment({}), { action: 'defer', code: 'no_fingerprinted_messages' })
})

console.log('\nordering, recovery floor, and what a write records')

test('order is timestamp then fingerprint, so a tie is still deterministic', () => {
  const shuffled = [msg(C, '2026-10-05T09:00:00Z'), msg(A, '2026-10-05T08:00:00Z'), msg(B, '2026-10-05T08:00:00Z')]
  assert.deepStrictEqual(orderMessages(shuffled).map((m) => m.messageFingerprint), [A, B, C])
  // Reversed input, same answer.
  assert.deepStrictEqual(orderMessages(shuffled.slice().reverse()).map((m) => m.messageFingerprint), [A, B, C])
})

test('the recovery floor is the EARLIEST of the watermark and anything seen this round', () => {
  // A late-discovered message must pull the listing window back far enough to assemble the
  // exchange it belongs to. Filtering at the watermark alone would hide it.
  assert.strictEqual(
    recoveryFloorIso({ messages: [msg(A, '2026-10-01T08:00:00Z')], coverageThroughIso: '2026-10-05T09:00:00Z' }),
    '2026-10-01T08:00:00Z', 'the older seen message wins')
  assert.strictEqual(
    recoveryFloorIso({ messages: [msg(A, '2026-10-09T08:00:00Z')], coverageThroughIso: '2026-10-05T09:00:00Z' }),
    '2026-10-05T09:00:00Z', 'otherwise the watermark')
  assert.strictEqual(recoveryFloorIso({ messages: [], coverageThroughIso: '2026-10-05T09:00:00Z' }),
    '2026-10-05T09:00:00Z', 'nothing seen yet: the watermark')
  assert.strictEqual(recoveryFloorIso({ messages: [msg(A, '2026-10-01T08:00:00Z')] }), null,
    'no coverage: no floor, the whole thread is wanted')
})

test('a write records the segment\'s fingerprints, sorted and unique, and BOTH ends of its span', () => {
  const seg = [msg(C, '2026-10-05T09:00:00Z'), msg(A, '2026-10-05T08:00:00Z'), msg(A, '2026-10-05T08:00:00Z')]
  const c = coverageForSegment(seg)
  assert.deepStrictEqual(c.fingerprints, [A, C].sort(), 'unique and ordered, so a replay produces the same array')
  assert.strictEqual(c.throughIso, '2026-10-05T09:00:00Z', 'the latest instant in the segment')
  // BOTH ends. The earliest is what a later refresh of this same segment floors its recovery
  // at, so it has to be stored rather than re-derived from messages the round has erased.
  assert.strictEqual(c.fromIso, '2026-10-05T08:00:00Z', 'and the earliest')
  assert.deepStrictEqual(coverageForSegment([]), { fingerprints: [], fromIso: null, throughIso: null })
})

test('the unpaired hint is the earliest UNCOVERED instant, and null when nothing is uncovered', () => {
  const messages = [msg(A, '2026-10-08T09:00:00Z', 'outbound'), msg(B, '2026-10-08T11:00:00Z')]
  assert.strictEqual(unpairedHintIso(messages, new Set()), '2026-10-08T09:00:00Z')
  assert.strictEqual(unpairedHintIso(messages, new Set([A])), '2026-10-08T11:00:00Z',
    'a covered message does not hold the hint down')
  assert.strictEqual(unpairedHintIso(messages, new Set([A, B])), null)
})

test('CROSS-ROUND HALVES: the floor takes the least of everything that can reach back', () => {
  const through = '2026-10-08T10:00:00Z'
  // The reported case. Settled coverage ends at 10:00. Round A sees an unseen outbound at
  // 09:00; its reply arrives at 11:00 in round B, by which time round A's working records are
  // erased. Flooring at the coverage instant excludes the 09:00 half - forever, in every
  // later round, because the delta will not show it again either.
  const roundB = { messages: [msg(B, '2026-10-08T11:00:00Z')], coverageThroughIso: through }
  assert.strictEqual(recoveryFloorIso(roundB), through, 'without a durable hint the gap is real')
  assert.strictEqual(recoveryFloorIso({ ...roundB, earliestUnpairedIso: '2026-10-08T09:00:00Z' }),
    '2026-10-08T09:00:00Z', 'the hint reaches the earlier half')
  // A pending refresh must re-list its OWN earlier messages or it redrafts from a truncated
  // view of the exchange it already represents.
  assert.strictEqual(recoveryFloorIso({ ...roundB, pendingFromIso: '2026-10-08T07:30:00Z' }),
    '2026-10-08T07:30:00Z', 'the pending span start reaches its own context')
  // The settled instant still bounds the lookback when nothing reaches further back, which is
  // what keeps a long thread inside one bounded page.
  assert.strictEqual(recoveryFloorIso({ messages: [msg(C, '2026-10-08T13:00:00Z')], coverageThroughIso: through }),
    through)
  assert.strictEqual(recoveryFloorIso({ messages: [msg(C, '2026-10-08T13:00:00Z')] }), null,
    'and no settled coverage still means the whole thread')
})

test('normalizeCoverage carries the pending span and the durable hint through', () => {
  const cov = normalizeCoverage({
    covered_fingerprints: [A], coverage_through_at: '2026-10-08T10:00:00Z',
    pending_episode_fingerprint: fp(9), pending_covered_fingerprints: [B],
    pending_coverage_from_at: '2026-10-08T07:30:00Z',
    earliest_unpaired_at: '2026-10-08T09:00:00Z',
  })
  assert.strictEqual(cov.pendingFromIso, '2026-10-08T07:30:00Z')
  assert.strictEqual(cov.earliestUnpairedIso, '2026-10-08T09:00:00Z')
  const bare = normalizeCoverage({})
  assert.strictEqual(bare.pendingFromIso, null)
  assert.strictEqual(bare.earliestUnpairedIso, null)
})

test('the two-way rule applies to the SEGMENT, not to the thread', () => {
  assert.strictEqual(segmentIsTwoSided([msg(A, '2026-10-05T08:00:00Z'), msg(B, '2026-10-05T09:00:00Z', 'outbound')]), true)
  assert.strictEqual(segmentIsTwoSided([msg(A, '2026-10-05T08:00:00Z'), msg(B, '2026-10-05T09:00:00Z')]), false,
    'a later one-sided message in an answered thread is not a suggestion')
  assert.strictEqual(segmentIsTwoSided([]), false)
})

console.log('\nwhat the module is not allowed to be')

test('it stores and compares fingerprints only - no body, subject, address or provider id', () => {
  const code = SRC.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  for (const banned of ['subject', 'bodyPreview', 'emailAddress', 'conversationId', 'providerMessageKey', 'ciphertext']) {
    assert.ok(!code.includes(banned), `must not handle ${banned}`)
  }
  assert.ok(!/fetch\(|supabase|createClient/.test(code), 'pure: no transport, no database')
})

test('coverage is never decided by a timestamp comparison anywhere in the code', () => {
  // uncoveredMessages is the only coverage decision, and it must use set membership.
  // Comments stripped first: the next function's JSDoc documents a timestampIso field and a
  // naive slice swallowed it. The claim is about the CODE.
  const slice = SRC.slice(SRC.indexOf('export function uncoveredMessages'), SRC.indexOf('export function decideSegment'))
  const fn = slice.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.ok(/set\.has\(/.test(fn), 'membership is the test')
  assert.ok(!/timestampIso/.test(fn.replace(/orderMessages\(messages\)/g, '')),
    'the coverage filter itself reads no timestamp')
})

test('the hint-pair bound is ONE number, shared with the function that enforces it', () => {
  // The run trims to this; record_outlook_thread_recovery REFUSES a larger array and
  // truncates a merged row to the same size. Two copies would drift, and the drift is not
  // graceful: every hint write would come back invalid_unpaired, which stops the round.
  assert.strictEqual(MAX_UNPAIRED_HINT_PAIRS, 25)
  const MIG = readFileSync(join(ROOT,
    'supabase/migrations/20261011000000_outlook_thread_segments.sql'), 'utf8')
  const fn = MIG.slice(MIG.indexOf('FUNCTION public.record_outlook_thread_recovery('))
  const one = fn.slice(0, fn.indexOf('$fn$;') + 5)
  assert.ok(one.includes('jsonb_array_length(p_unpaired) > ' + MAX_UNPAIRED_HINT_PAIRS),
    'the function refuses more pairs than the module sends')
  assert.ok(one.includes('LIMIT ' + MAX_UNPAIRED_HINT_PAIRS),
    'and truncates a merged row to the same bound')
  assert.ok(one.includes('- ' + MAX_UNPAIRED_HINT_PAIRS + ', 0) INTO v_dropped'),
    'and measures what it shed against the same bound')
  const RUN = readFileSync(join(ROOT, 'supabase/functions/shared/outlookImportRun.js'), 'utf8')
  assert.ok(/pairs\.length >= MAX_UNPAIRED_HINT_PAIRS/.test(RUN),
    'the run trims to the shared constant, not to a literal')
  assert.ok(!/\.slice\(0, 25\)/.test(RUN),
    'and no literal 25 survives in the run')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
