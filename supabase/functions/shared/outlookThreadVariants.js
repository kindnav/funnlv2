// RING VARIANTS for a thread and its messages, computed where the raw keys are in hand.
//
// WHY THIS MODULE EXISTS, and why the run cannot do without it. A key rotation changes the
// conversation fingerprint and every message fingerprint, because all of them are HMACs under
// the same key. A fingerprint cannot be re-hashed, and `outlookRoundState` deliberately converts
// the raw Graph keys to fingerprints and never persists them - so at write time the run holds
// values it cannot translate between eras.
//
// REPRODUCED, and this is the defect that settles the design: a later segment's EPISODE aliases
// do NOT locate the previous segment once the anchor changes. Through the real reader, a settled
// segment written under era 1 came back as `covered_fingerprints: []` when asked with episode
// aliases alone, and through the real producer the same replay answered `created` instead of
// `exists_terminal` - a duplicate suggestion for an exchange the reviewer had already accepted.
// With the thread's conversation ring variants supplied, the same reader returned the coverage
// and named the variant it matched. Episode aliases identify ONE anchor, not a continuing
// thread.
//
// WHERE THE RAW KEYS COME FROM, both of them, with no new request and no new column:
//   * the CONVERSATION key from the recovery envelope GET, which already fetches it to learn
//     the conversation id and now hands it back in memory;
//   * each MESSAGE key by decrypting the handle the round already stored for it - the same
//     `decryptCursor` the recovery path uses.
// Nothing here is persisted or logged. The keys live for the length of one invocation.

import { computeFingerprintSet, MAX_KEYRING_KEYS } from './emailFingerprint.js'
import {
  buildConversationFingerprintFields, buildMessageFingerprintFields,
} from './outlookRoundState.js'
import { buildEpisodeFingerprintFields } from './outlookParticipants.js'

/** Every ring variant of one thread's fingerprint, current key first. */
export async function conversationVariants (p) {
  const { connectionId, conversationKey, keyRing } = p || {}
  if (typeof conversationKey !== 'string' || conversationKey.length === 0) return []
  const set = await computeFingerprintSet(
    buildConversationFingerprintFields({ connectionId, conversationKey }), keyRing)
  return set.lookupFingerprints.map((l) => l.fingerprint)
}

/**
 * Every ring variant of one episode anchor, under BOTH contact forms.
 *
 * `buildEpisodeFingerprintFields` tags the slot `episode:<contactId>` or
 * `episode:new-contact`, so the SAME thread anchored on the SAME message hashes differently
 * before and after the person became a contact. A legacy proposal accepted while they were a
 * stranger is on record under the new-contact form while a worker now in known-contact mode
 * computes the other, so both forms are offered for lookup. Bounded: two forms times the ring.
 */
export async function episodeVariants (p) {
  const { connectionId, conversationKey, firstMessageKey, contactId, keyRing } = p || {}
  if (typeof conversationKey !== 'string' || typeof firstMessageKey !== 'string') return []
  const out = []
  for (const form of [contactId ?? null, null]) {
    if (out.length > 0 && form === null && contactId === null) break
    const set = await computeFingerprintSet(buildEpisodeFingerprintFields({
      connectionId, conversationKey, firstMessageKey, contactId: form,
    }), keyRing)
    for (const l of set.lookupFingerprints) {
      if (!out.includes(l.fingerprint)) out.push(l.fingerprint)
    }
  }
  return out
}

/**
 * Attach ring variants to each message of a segment, keyed by the raw provider key.
 *
 * `messageFingerprint` stays the CURRENT-key value - that is what a write claims -
 * and `fingerprintVariants` carries every value it may already be on record under.
 *
 * @param {{ connectionId:string, conversationKey:string, keyRing:object,
 *           messages:Array<{providerMessageKey:string}> }} p
 */
export async function withMessageVariants (p) {
  const { connectionId, conversationKey, keyRing, messages } = p || {}
  const list = Array.isArray(messages) ? messages : []
  const out = []
  for (const m of list) {
    const key = m?.providerMessageKey
    if (typeof key !== 'string' || key.length === 0 || typeof conversationKey !== 'string') {
      out.push(m)
      continue
    }
    const set = await computeFingerprintSet(
      buildMessageFingerprintFields({ connectionId, conversationKey, messageKey: key }), keyRing)
    out.push({
      ...m,
      messageFingerprint: set.writeFingerprint,
      fingerprintVariants: set.lookupFingerprints.map((l) => l.fingerprint),
    })
  }
  return out
}

/**
 * The episode fingerprint for ONE SEGMENT, anchored on the segment's own first message.
 *
 * WHY IT CANNOT BE THE THREAD'S ANCHOR. Recovery completes the thread from Outlook and anchors
 * on its first message, so every segment of a thread would compute the SAME episode value - and
 * `interaction_candidates.source_fingerprint` is unique per user, so the second segment could
 * not be inserted at all. Reproduced through the handler: a thread that continued after the
 * reviewer decided produced a second write carrying the FIRST segment's fingerprint.
 *
 * A segment is therefore identified by where IT starts. That is also why a later segment cannot
 * be found by episode aliases - its anchor is a different message - and why the thread lookup
 * has to go through the conversation fingerprint's ring variants instead.
 *
 * @returns {{ write: string, lookups: string[] }}
 */
export async function segmentEpisodeFingerprint (p) {
  const { connectionId, conversationKey, firstMessageKey, contactId, keyRing } = p || {}
  const set = await computeFingerprintSet(buildEpisodeFingerprintFields({
    connectionId, conversationKey, firstMessageKey, contactId: contactId ?? null,
  }), keyRing)
  const lookups = await episodeVariants({
    connectionId, conversationKey, firstMessageKey, contactId: contactId ?? null, keyRing,
  })
  return { write: set.writeFingerprint, lookups }
}

/**
 * What a write should CLAIM, and what it should offer for COMPARISON. The two are different and
 * conflating them is a defect in both directions.
 *
 *   claim   - one value per message: the one it is ALREADY on record under when the thread has
 *             seen it before, otherwise the current-key value. Keeping the stored value stable
 *             means a thread's coverage does not drift era by era.
 *   aliases - every variant of every message in the segment, for the producer to recognise a
 *             hint recorded under a retired key. NEVER stored: storing aliases would record an
 *             era's worth of values as coverage.
 *
 * @param {Array<object>} segment messages carrying messageFingerprint + fingerprintVariants
 * @param {Set<string>} covered the thread's stored coverage
 */
export function resolveClaim (segment, covered) {
  const set = covered instanceof Set ? covered : new Set()
  const claim = new Set()
  const aliases = new Set()
  for (const m of Array.isArray(segment) ? segment : []) {
    const variants = [m?.messageFingerprint, ...(Array.isArray(m?.fingerprintVariants) ? m.fingerprintVariants : [])]
      .filter((v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v))
    if (variants.length === 0) continue
    for (const v of variants) aliases.add(v)
    // The value already on record wins, so a replay after a rotation produces the same claim
    // the settled row holds and the producer's subset test still answers `exists_terminal`.
    claim.add(variants.find((v) => set.has(v)) ?? variants[0])
  }
  return { claim: [...claim].sort(), aliases: [...aliases].sort() }
}

export { MAX_KEYRING_KEYS }
