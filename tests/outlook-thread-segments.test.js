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
  decideSegment, recoveryFloorIso, coverageForSegment, segmentIsTwoSided,
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

test('a write records the segment\'s fingerprints, sorted and unique, and its latest instant', () => {
  const seg = [msg(C, '2026-10-05T09:00:00Z'), msg(A, '2026-10-05T08:00:00Z'), msg(A, '2026-10-05T08:00:00Z')]
  const c = coverageForSegment(seg)
  assert.deepStrictEqual(c.fingerprints, [A, C].sort(), 'unique and ordered, so a replay produces the same array')
  assert.strictEqual(c.throughIso, '2026-10-05T09:00:00Z', 'the latest instant in the segment')
  assert.deepStrictEqual(coverageForSegment([]), { fingerprints: [], throughIso: null })
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

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
