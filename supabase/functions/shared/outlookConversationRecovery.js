// CONVERSATION RECOVERY - recognising the half of an exchange a PREVIOUS round read.
//
// THE REQUIREMENT. A new-contact suggestion needs two-way communication with the same
// person, whichever side started; a single unanswered message never produces one; and
// the two halves may land in DIFFERENT import rounds. The same two-way rule applies to an
// existing contact.
//
// THE GAP THIS CLOSES, demonstrated in tests/outlook-two-sided-rounds.test.js before this
// existed: round 1 reads the first half alone, writes nothing, completes, commits both
// cursors and ERASES the accumulator (release_outlook_sync_lease: "Only a confirmed,
// complete release erases the accumulator"). Round 2 reads the reply alone, in a thread
// it no longer remembers, calls it one-sided again, and nothing is ever suggested.
//
// WHY OUTLOOK IS THE SOURCE AND NOT A RECOGNITION STORE. The design's D2 sheet proposed
// keeping booleans per conversation for 90 days. Fingerprints and direction booleans
// cannot retrieve the earlier message TEXT, and both halves have to feed the draft; and
// the published notice says the working records are removed when a read completes, so
// keeping them longer is a disclosure change. Outlook already holds the earlier half.
// So, while the content stage is on, the round asks Outlook for the rest of the thread -
// for every one-sided conversation it is about to give up on AND, in a delta round, for
// every two-sided conversation it is about to write (see below) - in three bounded steps:
//
//   1. ONE envelope GET, by a handle the round already stored, to learn the
//      conversation id - which the round deliberately never persists;
//   2. ONE filtered listing per folder (Inbox, Sent Items), envelopes only, bounded;
//   3. the SAME fold the delta pages go through (foldPage), so direction, counterparty,
//      contact match, taint and the episode fingerprint come out exactly as they would
//      have had both halves arrived in one round - which is what keeps the dedupe key
//      stable and a replay a refresh rather than a second suggestion;
//   4. only if the merged exchange is two-sided and qualifies are bodies read - through
//      the unchanged content pass, with its screening and minimization.
//
// WHY ALSO A TWO-SIDED THREAD, IN A DELTA ROUND. The episode fingerprint is anchored on
// the thread's FIRST message, and the lookup fingerprints are key-rotation variants of
// that one anchor, not alternative anchors. A delta round sees only what arrived since the
// committed cursors, so a thread that continued since the last round opens, in this
// round, on a reply - and a round that was two-sided on its own used to be written under
// THAT anchor. Reproduced through the real handler: a pending proposal from round 1, one
// further message each way in round 2, and round 2 created a second proposal instead of
// refreshing the first. Completing the thread from Outlook before the write anchors it on
// the first message as Outlook holds it, which is the anchor a first pass - a read of the
// whole folder - produces. Identity then does not depend on which sides happened to write
// between imports. A first pass asks nothing extra; outlookImportRun.js decides when.
//
// WHAT IS STORED: nothing new. The recovered handles live in memory for the rest of the
// invocation. If the invocation stops before the write, the conversation is not passed
// and the next invocation recovers it again from Outlook - bounded rework, exactly the
// property the rest of the run has.
//
// WHAT IS BOUNDED: the requests per conversation (three), the messages per folder
// (MAX_RECOVERY_MESSAGES_PER_FOLDER, one page, no link following), the recoveries per
// invocation (MAX_RECOVERIES_PER_INVOCATION), and every request by the invocation budget
// and the transport's own deadline. Never a mailbox-wide listing.
//
// NO ADDRESS, SUBJECT, NAME, BODY OR PROVIDER ID LEAVES THIS MODULE in a result: outcomes
// are controlled codes and counts; the entry carries fingerprints and a contact id.

import {
  GRAPH_FOLDERS, REQUEST_TIMEOUT_MS, MAX_RECOVERY_MESSAGES_PER_FOLDER,
  buildMessageEnvelopeRequest, buildConversationLookupRequest, readConversationLookupPage,
  executeGraphRequest, isUsableGraphId,
} from './outlookGraphTransport.js'
import { normalizeGraphPage } from './outlookMessageNormalize.js'
import { foldPage, finalizeConversation, ROUND_TAINT_CODES } from './outlookRoundState.js'

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The most conversations one invocation asks Outlook about. "Come back" past it. Equal to
 * MAX_CONTENT_CONVERSATIONS_PER_INVOCATION (outlookImportRun.js), because in a delta round
 * every conversation the content stage will write is completed from Outlook first.
 */
export const MAX_RECOVERIES_PER_INVOCATION = 20
/** Budget a single recovery request is admitted on: one attempt plus slack. */
export const RECOVERY_REQUEST_ADMIT_MS = REQUEST_TIMEOUT_MS + 5_000
/**
 * Budget a recovery is admitted on by the run: ONE request's worth, exactly as the content
 * pass admits one body fetch at a time. Each of the three requests re-checks the budget
 * before it is made, so admitting on all three at once would only refuse recoveries the
 * invocation could plainly afford - reproduced: with the write reserve added, three
 * requests' worth exceeded the whole invocation budget and no recovery ever ran.
 */
export const RECOVERY_ADMIT_MS = RECOVERY_REQUEST_ADMIT_MS

/**
 * Every outcome a recovery can report. Controlled codes; counted in the content report.
 *
 *   recovered                the exchange is two-sided and qualifies; the content pass runs
 *   not_two_sided            Outlook was asked and the thread is still one-sided: settled
 *   recovery_no_handles      the round stored no handle for it, so there is nothing to ask with
 *   recovery_source_missing  the stored message no longer resolves (moved to an archive,
 *                            exported, deleted): the same id will never answer, so settled
 *   recovery_fetch_failed    a transient provider failure: RETRY next invocation
 *   recovery_unsupported     the provider refused the lookup itself (a 400): settled, and the
 *                            code is the signal that the filter is not accepted on this tenant
 *   recovery_truncated       more of the thread than one bounded page: settled
 *   recovery_mismatch        the recovered thread is not the conversation the round holds
 *   recovery_no_messages     the lookup returned nothing usable
 *   budget_exhausted         no room for the next request: RETRY next invocation
 *   plus every ROUND_TAINT_CODE the merged exchange can carry (settled)
 */
export const RECOVERY_OUTCOME_CODES = Object.freeze([
  'recovered', 'not_two_sided', 'recovery_no_handles', 'recovery_source_missing',
  'recovery_fetch_failed', 'recovery_unsupported', 'recovery_truncated', 'recovery_mismatch',
  'recovery_no_messages', 'budget_exhausted',
  ...ROUND_TAINT_CODES,
])
/** The outcomes that preserve the conversation for another invocation. Everything else settles it. */
export const RECOVERY_RETRYABLE = Object.freeze(['recovery_fetch_failed', 'budget_exhausted'])

const settled = (reason, stats) => ({ outcome: 'settled', reason, stats })
const retry = (reason, stats) => ({ outcome: 'retry', reason, stats })

/**
 * Map a transport failure on the envelope GET. A vanished message is a settled fact; a
 * transient failure is not.
 */
function envelopeFailure (code) {
  if (code === 'not_found' || code === 'message_gone') return 'recovery_source_missing'
  return 'recovery_fetch_failed'
}
/** Map a transport failure on the lookup. A 400 is the provider refusing the query shape. */
function lookupFailure (code) {
  if (code === 'bad_request') return 'recovery_unsupported'
  return 'recovery_fetch_failed'
}

/**
 * Ask Outlook for the rest of ONE one-sided conversation and decide it the way a
 * same-round read would have.
 *
 * @param {object} p
 * @param {object} p.row            the round's record (cfp, inbound, outbound, ...)
 * @param {Array<object>} p.handles the round's stored handles for this conversation, in
 *                                  the shape readConversationHandles returns
 * @param {Function} p.decryptHandle ({ciphertext, nonce}) => plaintext id
 * @param {string} p.accessToken
 * @param {object} p.deps           { fetchImpl, sleepImpl?, now?, executeGraphRequest? }
 * @param {Function} p.budgetAllows (marginMs) => boolean
 * @param {Set<string>} p.selfSet
 * @param {Map} p.contactIndex
 * @param {string} p.connectionId
 * @param {object} p.keyRing
 * @param {Function} p.produceHandles  buildMessageHandles bound to the connection
 * @param {(iso:string)=>string|null} p.localDateFor
 * @returns {Promise<{outcome:'recovered', entry:object, extraHandles:Array<object>, stats:object}
 *                  |{outcome:'settled'|'retry', reason:string, stats:object}>}
 */
export async function recoverConversation (p) {
  const {
    row, handles, decryptHandle, accessToken, deps, budgetAllows, selfSet, contactIndex,
    connectionId, keyRing, produceHandles, localDateFor,
  } = p || {}
  const stats = { envelopeFetches: 0, lookups: 0, recoveredMessages: 0, dedupedAgainstStored: 0 }
  const exec = typeof deps?.executeGraphRequest === 'function' ? deps.executeGraphRequest : executeGraphRequest
  const allows = typeof budgetAllows === 'function' ? budgetAllows : () => true
  const cfp = typeof row?.cfp === 'string' ? row.cfp : null
  if (cfp === null) return settled('recovery_mismatch', stats)

  const stored = (Array.isArray(handles) ? handles : [])
    .filter((h) => isPlainObject(h) && typeof h.midCt === 'string' && h.midCt.length > 0)
  if (stored.length === 0) return settled('recovery_no_handles', stats)

  // ── 1. the conversation id, from a message the round already holds ─────────
  if (!allows(RECOVERY_REQUEST_ADMIT_MS)) return retry('budget_exhausted', stats)
  let messageId
  try {
    messageId = await decryptHandle({ ciphertext: stored[0].midCt, nonce: stored[0].midNonce })
  } catch {
    return retry('recovery_fetch_failed', stats)
  }
  if (!isUsableGraphId(messageId)) return settled('recovery_mismatch', stats)
  let envelopeReq
  try {
    envelopeReq = buildMessageEnvelopeRequest({ messageId })
  } catch {
    return settled('recovery_mismatch', stats)
  }
  stats.envelopeFetches += 1
  const env = await exec({
    request: envelopeReq, accessToken, fetchImpl: deps?.fetchImpl, sleepImpl: deps?.sleepImpl,
    now: deps?.now, budgetAllows: allows,
  })
  if (!env?.ok) return retryOrSettle(envelopeFailure(env?.code), stats)
  const conversationId = env.json?.conversationId
  if (!isUsableGraphId(conversationId)) return settled('recovery_mismatch', stats)

  // ── 2. the thread, folder by folder, envelopes only ──────────────────────
  const entries = []
  for (const folder of GRAPH_FOLDERS) {
    if (!allows(RECOVERY_REQUEST_ADMIT_MS)) return retry('budget_exhausted', stats)
    let req
    try {
      req = buildConversationLookupRequest({ folder, conversationId, top: MAX_RECOVERY_MESSAGES_PER_FOLDER })
    } catch {
      return settled('recovery_mismatch', stats)
    }
    stats.lookups += 1
    const res = await exec({
      request: req, accessToken, fetchImpl: deps?.fetchImpl, sleepImpl: deps?.sleepImpl,
      now: deps?.now, budgetAllows: allows,
    })
    if (!res?.ok) return retryOrSettle(lookupFailure(res?.code), stats)
    const page = readConversationLookupPage(res.json)
    if (page.ok !== true) return retry('recovery_fetch_failed', stats)
    if (page.truncated) return settled('recovery_truncated', stats)
    // The SAME normalizer the delta read uses: it refuses a body it was not supposed to
    // receive, drops drafts and malformed envelopes, and attaches the folder.
    const norm = normalizeGraphPage(page.items, folder)
    for (const m of norm.messages) {
      // Only this conversation. A provider that answered a wider set must not widen the fold.
      if (m.providerConversationKey !== conversationId) continue
      entries.push({ message: m, extra: norm.extras.get(m.providerMessageKey) })
    }
  }
  if (entries.length === 0) return settled('recovery_no_messages', stats)
  stats.recoveredMessages = entries.length

  // ── 3. the same fold a same-round read would have done ───────────────────
  const folded = await foldPage({
    entries, selfSet, contactIndex, connectionId, keyRing,
    deps: { produceHandles: typeof produceHandles === 'function' ? produceHandles : undefined },
  })
  if (typeof folded.handleFailure === 'string' && folded.handleFailure.length > 0) {
    return retry('recovery_fetch_failed', stats)
  }
  const contribution = folded.contributions.find((c) => c.cfp === cfp)
  // The fingerprint is HMAC(connection, conversation key). A thread that does not fold
  // to the record the round holds is not the conversation it was asked about.
  if (!contribution) return settled('recovery_mismatch', stats)
  if (contribution.inbound === 0 || contribution.outbound === 0) return settled('not_two_sided', stats)

  // The same decision the finalisation makes for a round-held record, including the one
  // resolvable taint: an unknown counterparty whose headers the content pass must screen.
  const decided = finalizeConversation(contribution, localDateFor, { contentStageOn: true })
  if (decided.entry === null) return settled(decided.skip, stats)

  // ── 4. the handles the content pass will read bodies with ────────────────
  // Recovered messages the round ALREADY stored a handle for are not offered twice, so
  // the pass reads each body once and the stored set is the authority for those.
  const known = new Set(stored.map((h) => h.mfp).filter((m) => typeof m === 'string' && m.length > 0))
  const extraHandles = []
  for (const h of Array.isArray(folded.messages) ? folded.messages : []) {
    if (!isPlainObject(h) || h.cfp !== cfp) continue
    if (known.has(h.mfp)) { stats.dedupedAgainstStored += 1; continue }
    extraHandles.push({
      mfp: h.mfp,
      folder: h.folder === 'sentitems' ? 'sentitems' : 'inbox',
      sentAt: typeof h.sent_at === 'string' ? h.sent_at : '',
      midCt: h.mid_ct,
      midNonce: h.mid_nonce,
      keyVersion: Number.isInteger(h.key_version) ? h.key_version : 1,
    })
  }
  return { outcome: 'recovered', entry: decided.entry, extraHandles, stats }
}

function retryOrSettle (reason, stats) {
  return RECOVERY_RETRYABLE.includes(reason) ? retry(reason, stats) : settled(reason, stats)
}

/** Counts and controlled codes only - what a run may report about its recoveries. */
export function summarizeRecovery (r) {
  const s = isPlainObject(r?.stats) ? r.stats : {}
  return {
    outcome: RECOVERY_OUTCOME_CODES.includes(r?.outcome === 'recovered' ? 'recovered' : r?.reason)
      ? (r?.outcome === 'recovered' ? 'recovered' : r.reason)
      : 'recovery_mismatch',
    envelope_fetches: Number.isInteger(s.envelopeFetches) ? s.envelopeFetches : 0,
    lookups: Number.isInteger(s.lookups) ? s.lookups : 0,
    recovered_messages: Number.isInteger(s.recoveredMessages) ? s.recoveredMessages : 0,
    deduped_against_stored: Number.isInteger(s.dedupedAgainstStored) ? s.dedupedAgainstStored : 0,
  }
}
