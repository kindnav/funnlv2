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

const FP_RE = /^[0-9a-f]{64}$/

const isFp = (v) => typeof v === 'string' && FP_RE.test(v)

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
  const coverageThroughIso = typeof r.coverage_through_at === 'string' && r.coverage_through_at.length > 0
    ? r.coverage_through_at
    : null
  return { covered, pending, settledWithoutCoverage, coverageThroughIso }
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
  return orderMessages(messages).filter((m) => isFp(m?.messageFingerprint) && !set.has(m.messageFingerprint))
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
  const seen = (Array.isArray(p?.messages) ? p.messages : [])
    .map((m) => (typeof m?.timestampIso === 'string' ? m.timestampIso : null))
    .filter((t) => typeof t === 'string' && t.length > 0)
    .sort()
  const through = typeof p?.coverageThroughIso === 'string' && p.coverageThroughIso.length > 0
    ? p.coverageThroughIso
    : null
  if (through === null) return null
  if (seen.length === 0) return through
  return seen[0].localeCompare(through) < 0 ? seen[0] : through
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
  if (ordered.length === 0) return { fingerprints: [], throughIso: null }
  const fingerprints = [...new Set(ordered.map((m) => m.messageFingerprint))].sort()
  const throughIso = ordered[ordered.length - 1].timestampIso ?? null
  return { fingerprints, throughIso }
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
