// GENUINE KEY ROTATION, through the real fingerprint builders and a real key ring.
//
// WHY THIS SUITE IS SEPARATE. Rotation does not only change the episode anchor. It changes the
// CONVERSATION fingerprint and EVERY MESSAGE fingerprint, because all of them are HMACs under
// the same key. Coverage written before a rotation is therefore stored under values the current
// key can never reproduce - so a replay would read as entirely new mail and duplicate a settled
// exchange, and a thread would look untouched and duplicate its own pending segment.
//
// Nothing here is simulated: the fields come from outlookRoundState's own builders, the hashing
// from emailFingerprint.computeFingerprintSet, and the ring is a real current-plus-accepted
// ring of the kind the worker already carries.
//
// Run with: node tests/outlook-thread-rotation.test.js
import assert from 'node:assert'
import {
  buildConversationFingerprintFields, buildMessageFingerprintFields,
} from '../supabase/functions/shared/outlookRoundState.js'
import { buildEpisodeFingerprintFields } from '../supabase/functions/shared/outlookParticipants.js'
import { computeFingerprintSet, MAX_KEYRING_KEYS } from '../supabase/functions/shared/emailFingerprint.js'
import {
  uncoveredMessages, coverageForSegment, messageVariants, decideSegment, normalizeCoverage,
} from '../supabase/functions/shared/outlookThreadSegments.js'

let passed = 0, failed = 0
async function test (name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

const CONN = '11111111-1111-1111-1111-111111111111'
const CONV = 'AAQkADconv-rotation-1'
const K1 = { keyBytes: new Uint8Array(32).fill(7), keyVersion: 1 }
const K2 = { keyBytes: new Uint8Array(32).fill(9), keyVersion: 2 }
const K3 = { keyBytes: new Uint8Array(32).fill(11), keyVersion: 3 }
const ERA1 = { current: K1 }
const ERA2 = { current: K2, accepted: [K1] }
const ERA3 = { current: K3, accepted: [K2, K1] }

/** One message as the worker would carry it: the write value plus its ring variants. */
async function message (messageKey, ring, timestampIso, direction) {
  const set = await computeFingerprintSet(
    buildMessageFingerprintFields({ connectionId: CONN, conversationKey: CONV, messageKey }), ring)
  return {
    messageFingerprint: set.writeFingerprint,
    fingerprintVariants: set.lookupFingerprints.map((l) => l.fingerprint),
    timestampIso,
    direction,
  }
}
const conversationFp = async (ring) => computeFingerprintSet(
  buildConversationFingerprintFields({ connectionId: CONN, conversationKey: CONV }), ring)

console.log('\nrotation changes every fingerprint, not just the anchor')

await test('the conversation, episode and message fingerprints all move when the key rotates', async () => {
  const c1 = await conversationFp(ERA1)
  const c2 = await conversationFp(ERA2)
  assert.notStrictEqual(c1.writeFingerprint, c2.writeFingerprint, 'the conversation key moves')
  const m1 = await message('msg-a', ERA1, '2026-10-05T08:00:00Z', 'inbound')
  const m2 = await message('msg-a', ERA2, '2026-10-05T08:00:00Z', 'inbound')
  assert.notStrictEqual(m1.messageFingerprint, m2.messageFingerprint, 'the message key moves')
  const e1 = await computeFingerprintSet(buildEpisodeFingerprintFields({
    connectionId: CONN, conversationKey: CONV, firstMessageKey: 'msg-a', contactId: 'c' }), ERA1)
  const e2 = await computeFingerprintSet(buildEpisodeFingerprintFields({
    connectionId: CONN, conversationKey: CONV, firstMessageKey: 'msg-a', contactId: 'c' }), ERA2)
  assert.notStrictEqual(e1.writeFingerprint, e2.writeFingerprint, 'and so does the episode anchor')
  // The era-2 ring reproduces the era-1 value as a LOOKUP variant. That is the whole mechanism.
  assert.ok(m2.fingerprintVariants.includes(m1.messageFingerprint),
    'the ring reproduces the old value as a variant')
  assert.ok(c2.lookupFingerprints.some((l) => l.fingerprint === c1.writeFingerprint))
})

console.log('\na covered exchange stays covered across a rotation')

await test('REPLAY after rotation: both covered messages stay covered, the new one does not', async () => {
  // Era 1: two messages summarized, coverage stored as their era-1 values.
  const a1 = await message('msg-a', ERA1, '2026-10-05T08:00:00Z', 'inbound')
  const b1 = await message('msg-b', ERA1, '2026-10-05T09:00:00Z', 'outbound')
  const stored = new Set(coverageForSegment([a1, b1]).fingerprints)

  // Era 2: the same two messages hash differently, plus one genuinely new.
  const a2 = await message('msg-a', ERA2, '2026-10-05T08:00:00Z', 'inbound')
  const b2 = await message('msg-b', ERA2, '2026-10-05T09:00:00Z', 'outbound')
  const c2 = await message('msg-c', ERA2, '2026-10-09T10:00:00Z', 'inbound')
  assert.ok(!stored.has(a2.messageFingerprint),
    'the current value is genuinely absent from the stored set - the problem is real')

  const un = uncoveredMessages([a2, b2, c2], stored)
  assert.strictEqual(un.length, 1, 'exactly the new message is uncovered')
  assert.strictEqual(un[0].messageFingerprint, c2.messageFingerprint)
})

await test('without the variants the same replay reads as entirely new mail', async () => {
  // The control. Strip the variants and every message looks new, which is the duplicate
  // suggestion this mechanism prevents.
  const a1 = await message('msg-a', ERA1, '2026-10-05T08:00:00Z', 'inbound')
  const b1 = await message('msg-b', ERA1, '2026-10-05T09:00:00Z', 'outbound')
  const stored = new Set(coverageForSegment([a1, b1]).fingerprints)
  const a2 = await message('msg-a', ERA2, '2026-10-05T08:00:00Z', 'inbound')
  const b2 = await message('msg-b', ERA2, '2026-10-05T09:00:00Z', 'outbound')
  const bare = [a2, b2].map((m) => ({ ...m, fingerprintVariants: [] }))
  assert.strictEqual(uncoveredMessages(bare, stored).length, 2, 'both would be re-suggested')
})

await test('a PENDING segment still refreshes after a rotation instead of duplicating', async () => {
  const a1 = await message('msg-a', ERA1, '2026-10-05T08:00:00Z', 'inbound')
  const b1 = await message('msg-b', ERA1, '2026-10-05T09:00:00Z', 'outbound')
  const pendingAnchor = (await computeFingerprintSet(buildEpisodeFingerprintFields({
    connectionId: CONN, conversationKey: CONV, firstMessageKey: 'msg-a', contactId: 'c' }), ERA1)).writeFingerprint
  const a2 = await message('msg-a', ERA2, '2026-10-05T08:00:00Z', 'inbound')
  const b2 = await message('msg-b', ERA2, '2026-10-05T09:00:00Z', 'outbound')
  const d = decideSegment({
    messages: [a2, b2],
    coverage: normalizeCoverage({
      pending_episode_fingerprint: pendingAnchor,
      pending_covered_fingerprints: coverageForSegment([a1, b1]).fingerprints,
    }),
  })
  assert.strictEqual(d.action, 'refresh_pending')
  assert.strictEqual(d.episodeFingerprint, pendingAnchor,
    'the write lands on the row the pending segment already has')
})

console.log('\ntwo rotations, and the ring bound')

await test('a message summarized two rotations ago is still covered while its key is accepted', async () => {
  const a1 = await message('msg-a', ERA1, '2026-10-05T08:00:00Z', 'inbound')
  const stored = new Set(coverageForSegment([a1]).fingerprints)
  const a3 = await message('msg-a', ERA3, '2026-10-05T08:00:00Z', 'inbound')
  assert.strictEqual(uncoveredMessages([a3], stored).length, 0,
    'the era-1 value is still reachable through the era-3 ring')
  assert.ok(a3.fingerprintVariants.length === 3, 'current plus two accepted keys')
})

await test('the variant set is bounded by the key ring, not by history', async () => {
  const a3 = await message('msg-a', ERA3, '2026-10-05T08:00:00Z', 'inbound')
  assert.ok(messageVariants(a3).length <= MAX_KEYRING_KEYS,
    `at most ${MAX_KEYRING_KEYS} values per message`)
  // And a ring larger than the bound is refused by the existing helper, not by new code.
  await assert.rejects(() => computeFingerprintSet(
    buildMessageFingerprintFields({ connectionId: CONN, conversationKey: CONV, messageKey: 'm' }),
    { current: K1, accepted: [K2, K3, { keyBytes: new Uint8Array(32).fill(13), keyVersion: 4 },
                              { keyBytes: new Uint8Array(32).fill(15), keyVersion: 5 },
                              { keyBytes: new Uint8Array(32).fill(17), keyVersion: 6 }] }),
    /keyring_too_large/)
})

await test('a write CLAIMS only current-key values, so the stored set does not grow per era', async () => {
  const a2 = await message('msg-a', ERA2, '2026-10-05T08:00:00Z', 'inbound')
  const claim = coverageForSegment([a2])
  assert.deepStrictEqual(claim.fingerprints, [a2.messageFingerprint],
    'one value per message, the current one - never the whole variant set')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
