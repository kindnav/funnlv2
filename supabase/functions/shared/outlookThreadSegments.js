// THREAD SEGMENTS - later interactions inside a thread whose earlier exchange is settled.
//
// THE GAP THIS CLOSES. Episode identity is an HMAC anchored on the thread's FIRST message
// (outlookParticipants.buildEpisodeFingerprintFields), and outlookConversationRecovery
// deliberately completes the thread from Outlook before writing so that anchor is stable
// in every round. One consequence was never intended: once the reviewer accepts or
// dismisses, the producer finds that one fingerprint, sees a non-pending row and answers
// `exists_terminal`. Because `exists_terminal` is in WRITE_OK the round still succeeds and
// the cursor still advances, so every later exchange in that thread was discarded in
// silence. tests/sql/outlook-known-contact-follow-up-runtime.sql asserted exactly that
// ("Round 3: the thread continues ... writes nothing").
//
// Acceptance and dismissal settle AN EXCHANGE, not every future exchange in the thread. A
// thread is therefore a sequence of SEGMENTS: each one a two-way exchange that gets its own
// suggestion, its own editable draft and its own interaction on acceptance. Earlier
// interactions and the reviewer's notes are never touched again.
//
// WHY COVERAGE IS A SET OF MESSAGE FINGERPRINTS AND NOT A TIMESTAMP. A high-water timestamp
// cannot answer the only question that matters - "have we already summarized THIS message".
// Two failures are not hypothetical:
//
//   EQUAL TIMESTAMPS. Two messages can carry the same instant (a send and its own copy in
//   Sent Items, a burst, a provider that truncates to the second). With a timestamp
//   watermark one of them is indistinguishable from the other, so a genuinely new message
//   at the boundary is read as already covered. A sorting tie-break does not help: it makes
//   the ORDER deterministic, it does not record which of the two was summarized.
//
//   DELAYED DISCOVERY. A message can be discovered after a later one - moved into the
//   folder, delivered out of order, or surfaced by a delta page that arrives in a later
//   round. Its timestamp is BEHIND the watermark while the message itself has never been
//   seen. A timestamp comparison classifies unseen mail as covered, which loses it in
//   silence - the exact failure this module exists to prevent.
//
// So coverage is membership in a set of keyed message fingerprints, which
// outlookRoundState already computes for every message (buildMessageFingerprintFields).
// Nothing here compares timestamps to decide coverage. Timestamps are used for ONE thing:
// choosing the anchor of a new segment and the floor for bounded recovery, both of which
// are orderings, not coverage claims.
//
// WHAT IS STORED, and it is the smallest state that proves the distinction: per settled
// segment, the fingerprints of the messages that segment's stored draft represented. The
// union over a thread's settled segments is its covered set. No body, no header, no
// subject, no address, no Microsoft identifier - the same keyed one-way fingerprints the
// provenance records already hold.
//
// IDENTITY IS PINNED WHILE A SEGMENT IS PENDING. A pending segment keeps the episode
// fingerprint it was created under, whatever the current earliest uncovered message is.
// Recomputing it would move identity when a message is discovered late or a key rotates,
// and a moved identity is a second suggestion for one exchange. The anchor is chosen ONCE,
// when the segment is created.

/** An eligible segment may represent at most this many messages, so coverage stays bounded. */
export const MAX_SEGMENT_COVERAGE = 50

/**
 * A recovery hint may hold at most this many unpaired messages for one thread.
 *
 * The SAME bound record_outlook_thread_recovery enforces on p_unpaired - a larger array is
 * refused as invalid_unpaired - and the same bound it truncates a merged row to, keeping the
 * OLDEST pairs, because the oldest is the one a recovery window has to reach.
 */
export const MAX_UNPAIRED_HINT_PAIRS = 25

const FP_RE = /^[0-9a-f]{64}$/

const isFp = (v) => typeof v === 'string' && FP_RE.test(v)

/**
 * Every fingerprint this message may be stored under: the current-key value first, then the
 * accepted prior keys. ROTATION CHANGES MESSAGE FINGERPRINTS, so a covered set written before
 * a rotation holds values the current key will never reproduce - and testing only the current
 * value would read a settled exchange as entirely new mail.
 *
 * The variants come from the existing bounded key ring (computeFingerprintSet /
 * MAX_KEYRING_KEYS), so this adds no new key, no new algorithm and no unbounded growth.
 */
export function messageVariants (m) {
  const out = []
  const push = (v) => { if (isFp(v) && !out.includes(v)) out.push(v) }
  push(m?.messageFingerprint)
  for (const v of Array.isArray(m?.fingerprintVariants) ? m.fingerprintVariants : []) push(v)
  return out
}

/**
 * Normalize a coverage record read from the database into the shape the decisions below
 * expect. Unknown and malformed values are dropped rather than trusted: a fingerprint that
 * is not a fingerprint cannot prove coverage of anything.
 *
 * @param {object} [raw] one thread's coverage as `get_outlook_thread_coverage` returns it
 * @returns {{ covered: Set<string>, pending: {episodeFingerprint:string, covered:Set<string>}|null,
 *             settledWithoutCoverage: boolean, coverageThroughIso: string|null }}
 */
export function normalizeCoverage (raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const covered = new Set()
  for (const f of Array.isArray(r.covered_fingerprints) ? r.covered_fingerprints : []) {
    if (isFp(f)) covered.add(f)
  }
  // THE THREAD-LEVEL BASELINE IS COVERED. It names messages a bounded window absorbed for a
  // thread whose settled coverage could not be established at all; absorbing them is exactly
  // the claim that they must not be drafted again.
  const threadBaseline = new Set()
  for (const f of Array.isArray(r.thread_baseline_fingerprints)
    ? r.thread_baseline_fingerprints : []) {
    if (isFp(f)) { threadBaseline.add(f); covered.add(f) }
  }
  let pending = null
  if (isFp(r.pending_episode_fingerprint)) {
    const pc = new Set()
    for (const f of Array.isArray(r.pending_covered_fingerprints) ? r.pending_covered_fingerprints : []) {
      if (isFp(f)) pc.add(f)
    }
    pending = { episodeFingerprint: r.pending_episode_fingerprint, covered: pc }
  }
  // TRUE when the thread has at least one settled segment that carries NO coverage set.
  // That is a row written before this feature existed; its coverage cannot be reconstructed
  // from the reviewer's date (the reviewer may edit it, and it is a date, not a message), so
  // it is initialized explicitly and forward-only. See decideSegment.
  const settledWithoutCoverage = r.settled_without_coverage === true
  const iso = (v) => (typeof v === 'string' && v.length > 0 ? v : null)
  // The latest covered instant, from EITHER source: a settled segment's span end or the
  // thread baseline's. It is what floors the next recovery window, so taking only one of them
  // would send the window back over mail that is already absorbed.
  const throughCandidates = [iso(r.coverage_through_at), iso(r.thread_baseline_through_at)]
    .filter((t) => t !== null)
  return {
    covered,
    pending,
    settledWithoutCoverage,
    // The baseline, visible on its own: coverage that no draft describes.
    threadBaseline,
    threadBaselineThroughIso: iso(r.thread_baseline_through_at),
    // THE START OF CONTINUOUS KNOWLEDGE for a thread whose history cannot be located. Below
    // it, a message may belong to the pre-feature accepted exchange and must not be drafted;
    // at or above it, everything was absorbed, covered, or genuinely new. Null for every
    // thread that never needed a narrowed window, so ordinary delayed discovery is untouched.
    threadBaselineFromIso: iso(r.thread_baseline_from_at),
    coverageThroughIso: throughCandidates.length === 0
      ? null
      : throughCandidates.reduce((hi, t) => (t.localeCompare(hi) > 0 ? t : hi),
        throughCandidates[0]),
    // The pending segment's own span start. A refresh must re-list the segment's EARLIER
    // messages or it would redraft from a truncated view of its own exchange.
    pendingFromIso: iso(r.pending_coverage_from_at),
    // The durable hint: the earliest uncovered message this connection saw for the thread and
    // could not pair. Survives completed rounds, which is the only reason the cross-round
    // case can be assembled at all.
    earliestUnpairedIso: iso(r.earliest_unpaired_at),
    // WHICH conversation value the thread is actually on record under. Passed back to the
    // producer as its lookup, so a row written under a retired key is found - and then
    // rewritten to the current value, migrating the thread key forward on touch.
    matchedConversationFingerprint: isFp(r.matched_conversation_fingerprint)
      ? r.matched_conversation_fingerprint
      : null,
  }
}

/**
 * Deterministic order: timestamp, then message fingerprint. The fingerprint is the
 * tie-break because the raw provider key is gone once a round resumes from storage - the
 * same reason outlookRoundState breaks its tie there. This decides ORDER only; coverage is
 * never decided by it.
 */
export function orderMessages (messages) {
  return (Array.isArray(messages) ? messages.slice() : []).sort((a, b) => {
    const t = String(a?.timestampIso ?? '').localeCompare(String(b?.timestampIso ?? ''))
    return t !== 0 ? t : String(a?.messageFingerprint ?? '').localeCompare(String(b?.messageFingerprint ?? ''))
  })
}

/**
 * Which of these messages has this thread not already summarized?
 *
 * Set membership, nothing else. A message whose fingerprint is absent from the covered set
 * is new - including one whose timestamp is older than everything already covered.
 */
export function uncoveredMessages (messages, covered) {
  const set = covered instanceof Set ? covered : new Set()
  return orderMessages(messages).filter((m) => {
    const variants = messageVariants(m)
    if (variants.length === 0) return false
    // ANY variant counts as covered. A message summarized before a key rotation is stored
    // under the old key, and the current key will never reproduce that value.
    return !variants.some((v) => set.has(v))
  })
}

/**
 * Decide what the worker should do with one conversation.
 *
 * @param {object} p
 * @param {Array<{messageFingerprint:string, timestampIso:string, direction:'inbound'|'outbound'}>} p.messages
 *        every message of the thread this invocation can see - delta plus recovery
 * @param {object} [p.coverage] the thread's coverage, as normalizeCoverage returns it
 * @returns {{action:'baseline', messages:Array}
 *          |{action:'nothing_new'}
 *          |{action:'refresh_pending', episodeFingerprint:string, segment:Array}
 *          |{action:'new_segment', segment:Array, anchor:object}
 *          |{action:'defer', code:string}}
 */
export function decideSegment (p) {
  const messages = Array.isArray(p?.messages) ? p.messages : []
  const cov = p?.coverage && typeof p.coverage === 'object' && p.coverage.covered instanceof Set
    ? p.coverage
    : normalizeCoverage(p?.coverage)

  const usable = orderMessages(messages).filter((m) => isFp(m?.messageFingerprint))
  if (usable.length === 0) return { action: 'defer', code: 'no_fingerprinted_messages' }

  // LEGACY FIRST. A thread with a settled segment but no coverage set predates this
  // feature. Guessing its coverage from the reviewer's date would be exactly the inference
  // this design refuses, so the thread is given an explicit forward-only baseline - the
  // messages visible now are recorded as covered, and NO suggestion is produced from them.
  // Only mail that arrives after the baseline becomes a segment. This is reported, not
  // silent, and it is the one place coverage is recorded without a draft behind it.
  if (cov.settledWithoutCoverage) return { action: 'baseline', messages: usable }

  const segment = uncoveredMessages(usable, cov.covered)
  if (segment.length === 0) return { action: 'nothing_new' }
  if (segment.length > MAX_SEGMENT_COVERAGE) return { action: 'defer', code: 'segment_too_large' }

  // A PENDING SEGMENT KEEPS ITS IDENTITY. Whatever is now earliest, the write goes to the
  // fingerprint the pending row already has, so a refresh, a replay, a rotated key and a
  // late-discovered earlier message all land on one row instead of creating a second
  // suggestion for one exchange.
  if (cov.pending !== null) {
    return { action: 'refresh_pending', episodeFingerprint: cov.pending.episodeFingerprint, segment }
  }

  return { action: 'new_segment', segment, anchor: segment[0] }
}

/**
 * The floor for ONE MORE bounded attempt, after an unbounded listing came back truncated.
 *
 * WHY A SEPARATE FUNCTION. The ordinary floor refuses to exist without settled coverage, on
 * purpose: completing a one-sided thread means finding a half that may be OLDER than anything
 * this round saw, and a floor would hide it. That reasoning holds for the FIRST attempt. It
 * does not hold once the provider has answered "there is more of this thread than one page" -
 * at that point an unwindowed request cannot succeed however many times it is made, and the
 * choice is between a bounded window and losing the exchange for good.
 *
 * WHAT IT IS MADE OF, and nothing else: instants the run legitimately holds.
 *   * the earliest message THIS ROUND stored for the thread;
 *   * the pending segment's own span start, so a refresh re-lists its whole exchange;
 *   * the durable unpaired hint, so a half discovered in an earlier round is still reachable.
 * It is NEVER derived from a reviewer's date, and it claims no membership: it only narrows a
 * listing. What the narrowed listing actually returns is what gets claimed.
 *
 * @returns {string|null} an ISO instant to filter at or after, or null if nothing is known
 */
export function truncatedRetryFloorIso (p) {
  const iso = (v) => (typeof v === 'string' && v.length > 0 ? v : null)
  const seen = (Array.isArray(p?.messages) ? p.messages : [])
    .map((m) => iso(m?.timestampIso))
    .filter((t) => t !== null)
    .sort()
  const candidates = [seen[0] ?? null, iso(p?.pendingFromIso), iso(p?.earliestUnpairedIso)]
    .filter((t) => t !== null)
  if (candidates.length === 0) return null
  return candidates.reduce((lo, t) => (t.localeCompare(lo) < 0 ? t : lo), candidates[0])
}

/**
 * The lower bound for a bounded recovery listing of this thread.
 *
 * WHY A FLOOR IS NEEDED AT ALL. The recovery listing is one page per folder, capped at
 * MAX_RECOVERY_MESSAGES_PER_FOLDER and explicitly refusing @odata.nextLink: a thread with
 * more history than that in one folder reports truncated and is given up on. Anchoring a
 * segment on a recent message does not change that - the listing still asks for the WHOLE
 * conversation. Filtering the listing to the segment's own window is what makes a fresh
 * exchange in a long thread reachable.
 *
 * WHY THE FLOOR IS THE MINIMUM AND NOT THE WATERMARK. Asking only for mail at or after the
 * coverage watermark would hide a message that was discovered late - the delayed-discovery
 * case above - because its timestamp sits behind the watermark. The floor is therefore the
 * EARLIEST of the watermark and anything this round has actually seen for the thread, so a
 * late-discovered message pulls the window back far enough to assemble the exchange it
 * belongs to. With no coverage at all there is no floor: the whole thread is wanted.
 *
 * @returns {string|null} an ISO instant to filter at or after, or null for no filter
 */
export function recoveryFloorIso (p) {
  const iso = (v) => (typeof v === 'string' && v.length > 0 ? v : null)
  const through = iso(p?.coverageThroughIso)
  // NO SETTLED COVERAGE MEANS NO FLOOR. A first pass, or a thread nobody has decided, wants
  // the whole conversation - which is the request that shipped. `truncatedRetry` is the ONE
  // exception, and it is not a first pass: the unbounded attempt has already been made and
  // came back carrying @odata.nextLink, so asking for the whole conversation again would
  // give the same answer. See truncatedRetryFloorIso.
  if (through === null) return p?.truncatedRetry === true ? truncatedRetryFloorIso(p) : null

  const seen = (Array.isArray(p?.messages) ? p.messages : [])
    .map((m) => iso(m?.timestampIso))
    .filter((t) => t !== null)
    .sort()

  // THE LEAST OF EVERYTHING THAT CAN REACH BACK. The settled instant bounds the lookback -
  // it is what keeps a long thread inside one bounded page - but it must not be the floor on
  // its own. Reproduced: settled coverage to 10:00, an unseen outbound at 09:00 read in one
  // round and its reply at 11:00 in the next; a floor of 10:00 excluded the 09:00 half and
  // the exchange could never be assembled, in any later round, forever.
  const candidates = [through, seen[0] ?? null, iso(p?.pendingFromIso), iso(p?.earliestUnpairedIso)]
    .filter((t) => t !== null)
  return candidates.reduce((lo, t) => (t.localeCompare(lo) < 0 ? t : lo), candidates[0])
}

/**
 * The coverage a write should record: the fingerprints of the messages the segment
 * represents, and the latest instant among them.
 *
 * The caller passes this to the producer, which stores it IN THE SAME STATEMENT as the
 * draft and only when a draft is actually carried - so a metadata-only refresh or a
 * rejected write leaves coverage exactly where it was.
 */
export function coverageForSegment (segment) {
  const ordered = orderMessages(segment).filter((m) => isFp(m?.messageFingerprint))
  if (ordered.length === 0) return { fingerprints: [], fromIso: null, throughIso: null }
  // The CURRENT-key value only. The variants exist for lookup, never for the claim: claiming
  // an old-key value would record coverage under a key that is being retired.
  const fingerprints = [...new Set(ordered.map((m) => m.messageFingerprint))].sort()
  // BOTH ENDS of the span. The earliest is what a later refresh of this same segment uses as
  // its recovery floor, so it has to be stored rather than re-derived from messages that the
  // round will have erased.
  return {
    fingerprints,
    fromIso: ordered[0].timestampIso ?? null,
    throughIso: ordered[ordered.length - 1].timestampIso ?? null,
  }
}

/**
 * Every value the segment's messages may ALREADY be stored under, for the producer's
 * settled-coverage comparison.
 *
 * A write CLAIMS only current-key values (coverageForSegment). The comparison that decides
 * `exists_terminal` versus `created` has to reach the old-key values too, or a replay after a
 * rotation would be classified as entirely new and duplicate a settled exchange. Bounded by
 * the key ring, so at most MAX_KEYRING_KEYS values per message.
 */
export function coverageLookupFingerprints (segment) {
  const out = new Set()
  for (const m of Array.isArray(segment) ? segment : []) {
    for (const v of messageVariants(m)) out.add(v)
  }
  return [...out].sort()
}

/**
 * Split a segment at a thread's start of continuous knowledge.
 *
 * `older` is of UNKNOWN membership - it predates anything this connection ever absorbed or
 * covered for the thread, so it may be part of an accepted exchange whose coverage was never
 * recorded. It is absorbed, never drafted. `drafted` is the rest, decided by the ordinary
 * rules.
 *
 * With no floor nothing is split: that is every thread whose history is locatable.
 *
 * @returns {{ older: Array<object>, drafted: Array<object> }}
 */
export function splitAtKnowledgeFloor (segment, floorIso) {
  const list = Array.isArray(segment) ? segment : []
  if (typeof floorIso !== 'string' || floorIso.length === 0) {
    return { older: [], drafted: list }
  }
  // COMPARED AS INSTANTS, not as strings. The floor comes back from Postgres as
  // `...+00:00` while a Graph envelope carries `...Z`, and at equal times '+' sorts BELOW
  // 'Z' - so a string comparison would call an older message newer. Coverage is still set
  // membership; this is only the knowledge boundary.
  const floor = Date.parse(floorIso)
  if (!Number.isFinite(floor)) return { older: [], drafted: list }
  const older = []
  const drafted = []
  for (const m of list) {
    const t = Date.parse(typeof m?.timestampIso === 'string' ? m.timestampIso : '')
    // A message with no usable instant cannot be shown to be at or after the floor, so it is
    // treated as unknown rather than assumed new.
    if (!Number.isFinite(t) || t < floor) older.push(m)
    else drafted.push(m)
  }
  return { older, drafted }
}

/**
 * The instant to remember when a thread has uncovered mail this round could NOT pair.
 *
 * Recorded durably, because the round's own working records are erased when it completes and
 * the next round's delta will not show the message again. It is a floor hint only: it widens a
 * later recovery listing and is never read to decide coverage.
 *
 * @returns {string|null} the earliest uncovered instant, or null if nothing is uncovered
 */
export function unpairedHintIso (messages, covered) {
  const un = uncoveredMessages(messages, covered)
  if (un.length === 0) return null
  const t = un[0].timestampIso
  return typeof t === 'string' && t.length > 0 ? t : null
}

/**
 * Is a two-way exchange present in THIS segment?
 *
 * The product rule is unchanged - a suggestion needs communication in both directions -
 * and it is applied to the segment rather than the thread. A thread that was answered once
 * does not make every later one-sided message a suggestion.
 */
export function segmentIsTwoSided (segment) {
  const list = Array.isArray(segment) ? segment : []
  return list.some((m) => m?.direction === 'inbound') && list.some((m) => m?.direction === 'outbound')
}
