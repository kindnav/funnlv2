// Outlook durable continuation — the ROUND accumulator, pure.
//
// WHAT PROBLEM THIS SOLVES. Two-sidedness is a property of a whole exchange, and hosted
// Edge Functions cannot read a whole mailbox in one invocation (150s idle timeout, 150s
// wall on the free plan). So the halves of one conversation can arrive in different
// pages, different invocations, and different folders. Memory does not survive an
// invocation and a delta stream cannot be rewound, so the recognition state has to be
// written down. This module decides exactly WHAT gets written down, and it is the only
// place that decision is made.
//
// WHAT IS WRITTEN DOWN, and nothing else: keyed one-way fingerprints, a key version, two
// timestamps, bounded counts, Funnl's own contact id, and controlled codes. No body, no
// header, no subject, no mailbox address, no display name, and NO Microsoft message or
// conversation identifier. `outlookMetadataPass.js` keeps provider keys in memory only;
// here they are converted to fingerprints before anything leaves the process.
//
// THE TRICK THAT MAKES THAT POSSIBLE. The episode fingerprint is an HMAC over the
// episode's FIRST message key, so it cannot be recomputed later from a fingerprint of
// that key. Instead each page computes the episode fingerprint for the earliest eligible
// message it has actually seen - while the raw key is still in memory - and stores the
// RESULT. A later page or invocation that finds an even earlier message recomputes and
// replaces it. Deciding "earlier" needs an ordering pair that survives in storage, which
// is (timestamp, messageKeyFingerprint).
//
// DELIBERATE DIVERGENCE FROM qualifyEpisode, recorded because it is real. qualifyEpisode
// breaks a timestamp tie on the raw providerMessageKey; this breaks it on the message-key
// fingerprint, because the raw key is gone on resume. The property that matters is not
// "identical to the in-memory path" but STABILITY: one set of messages must always yield
// one episode fingerprint, however the round was split. Tests assert that stability
// directly, and assert full agreement with the in-memory path when no two messages in a
// conversation share a timestamp.
//
// A SECOND DIVERGENCE, and why it is the safer answer. groupByConversation marks a
// conversation truncated when it holds more than MAX_EPISODE_MESSAGES ENTRIES, because
// its in-memory map cannot hold more. This accumulator has no such limit on what it
// sees, so it taints only when the messages that would actually FEED a suggestion
// (eligible plus deferred) exceed that bound. It therefore never claims an
// incompleteness it does not have, and never claims completeness it has not earned.
//
// PURE. No I/O, no clock, no secrets, no database. The caller hands in the key ring and
// ships the contributions; this module only computes.

import {
  evaluateMessage,
  MAX_EPISODE_MESSAGES,
  PERSON_FP_SENTINEL,
  buildPersonFingerprintFields,
  buildEpisodeFingerprintFields,
} from './outlookParticipants.js'
import { computeFingerprintSet } from './emailFingerprint.js'

/**
 * How long an abandoned round's state may sit before it is ignored and deleted. Not a
 * retention promise about anything a user sees: it is the bound on worker scratch state,
 * which is also erased the moment a new round touches the connection.
 */
export const ROUND_TTL_SECONDS = 86_400

/**
 * Per-ROUND ceilings. These are bounds, not progress guarantees - a mailbox past them
 * ends its round incomplete rather than committing a cursor it has not earned. They are
 * far above the per-INVOCATION caps in outlookGraphTransport (20 pages, 500 messages),
 * which is the point: continuation is what lets a round exceed one invocation's share.
 *
 * They are mirrored as constants inside record_outlook_page_progress, and a test pins the
 * two together so they cannot drift apart.
 */
export const MAX_PAGES_PER_ROUND = 200
export const MAX_MESSAGES_PER_ROUND = 10_000
export const MAX_CONVERSATIONS_PER_ROUND = 2_000

/** Why a conversation can never become a suggestion in this round. Controlled set. */
export const ROUND_TAINT_CODES = Object.freeze([
  'ambiguous_counterparties', 'ambiguous_contact', 'automation_facts_incomplete',
  'mixed_counterparties', 'episode_truncated',
])

/** Why a finalized conversation produced no plan entry. Controlled set; safe to log. */
export const ROUND_SKIP_CODES = Object.freeze([
  ...ROUND_TAINT_CODES,
  'no_eligible_messages',   // nothing in the thread ever qualified
  'not_two_sided',          // one side only, across the whole round
  'invalid_timestamp',      // a stored timestamp could not be read as a local date
])

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * ISO timestamps are compared as strings here and as `timestamptz` in Postgres, so they
 * must be canonical first: '...T00:00:00Z' and '...T00:00:00.000Z' are the same instant
 * but different strings, and an ordering that disagreed with the database's would pick a
 * different "first message" on resume than it did in memory.
 */
export function canonicalIso (iso) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Canonical fields for a CONVERSATION fingerprint: the durable identity of one thread,
 * independent of which messages of it have been seen.
 *
 * Domain-separated from the episode and person fingerprints by the tag in the contactId
 * slot. Every slot is length-prefixed, so no value can forge a slot boundary and no two
 * kinds of fingerprint can collide.
 */
export function buildConversationFingerprintFields (p) {
  if (!isPlainObject(p)) throw new Error('invalid_fingerprint_input')
  const { connectionId, conversationKey } = p
  for (const v of [connectionId, conversationKey]) {
    if (typeof v !== 'string' || v.length === 0) throw new Error('invalid_fingerprint_input')
  }
  return {
    provider: 'outlook',
    accountNamespace: connectionId,
    contactId: 'conversation:',
    conversationKey,
    firstMessageKey: PERSON_FP_SENTINEL,
  }
}

/**
 * Canonical fields for a MESSAGE-KEY fingerprint. Used for one thing only: an ordering
 * tie-break that still works after the provider key itself is gone.
 */
export function buildMessageFingerprintFields (p) {
  if (!isPlainObject(p)) throw new Error('invalid_fingerprint_input')
  const { connectionId, conversationKey, messageKey } = p
  for (const v of [connectionId, conversationKey, messageKey]) {
    if (typeof v !== 'string' || v.length === 0) throw new Error('invalid_fingerprint_input')
  }
  return {
    provider: 'outlook',
    accountNamespace: connectionId,
    contactId: 'message:',
    conversationKey,
    firstMessageKey: messageKey,
  }
}

/**
 * Fold ONE page's entries into per-conversation contributions.
 *
 * A contribution describes only what THIS page saw. Merging it with what earlier pages
 * saw is `record_outlook_page_progress`'s job, and the merge rules there mirror the
 * within-page rules here exactly.
 *
 * @param {object} p
 * @param {Iterable<{message:object, extra?:object}>} p.entries
 * @param {Set<string>} p.selfSet
 * @param {Map} p.contactIndex
 * @param {string} p.connectionId
 * @param {object} p.keyRing
 * @param {{computeFingerprintSet?:Function}} [p.deps]
 * @returns {Promise<{contributions:Array<object>, counts:object}>}
 */
export async function foldPage (p) {
  const { entries, selfSet, contactIndex, connectionId, keyRing, deps } = p || {}
  if (typeof connectionId !== 'string' || connectionId.length === 0) {
    throw new Error('connection_id_required')
  }
  const fpSet = typeof deps?.computeFingerprintSet === 'function'
    ? deps.computeFingerprintSet
    : computeFingerprintSet

  const list = entries instanceof Map ? [...entries.values()] : (Array.isArray(entries) ? entries : [])
  const counts = { eligible: 0, deferred: 0, excluded: 0, unkeyed: 0 }

  // conversationKey -> in-progress contribution plus the raw bits needed to finish it.
  const byConversation = new Map()

  for (const e of list) {
    const message = e?.message
    const conversationKey = message?.providerConversationKey
    const messageKey = message?.providerMessageKey
    if (typeof conversationKey !== 'string' || conversationKey.length === 0
        || typeof messageKey !== 'string' || messageKey.length === 0) {
      // Without a conversation key there is nothing to accumulate against, and without a
      // message key no fingerprint can be computed. Counted, not silently dropped.
      counts.unkeyed += 1
      continue
    }

    const res = evaluateMessage({ message, extra: e?.extra, selfSet, contactIndex })
    if (res.outcome === 'excluded') {
      // Newsletters, bounces, self-only and cc-only mail. qualifyEpisode ignores these
      // rather than tainting, and so does this: they are not evidence of anything, and
      // creating a row for one would persist a fingerprint for a thread that can never
      // produce a suggestion.
      counts.excluded += 1
      continue
    }

    let slot = byConversation.get(conversationKey)
    if (slot === undefined) {
      slot = {
        conversationKey,
        taint: null,
        inbound: 0,
        outbound: 0,
        messages: 0,
        firstIso: null,
        firstFp: null,
        firstMessageKey: null,
        firstContactId: null,
        firstCounterparty: null,
        lastIso: null,
        counterparties: new Set(),
        contactIds: new Set(),
      }
      byConversation.set(conversationKey, slot)
    }
    slot.messages += 1

    if (res.outcome === 'deferred') {
      // A deferral anywhere in a conversation taints the whole episode: we must not
      // quietly summarize the subset we happened to understand.
      counts.deferred += 1
      if (slot.taint === null) slot.taint = res.code
      continue
    }

    counts.eligible += 1
    const iso = canonicalIso(message.timestampIso)
    if (iso === null) {
      // A message whose timestamp cannot be read cannot be ordered, and the proposed
      // date is derived from these timestamps. Taint rather than guess.
      if (slot.taint === null) slot.taint = 'automation_facts_incomplete'
      continue
    }

    slot.counterparties.add(res.counterparty)
    slot.contactIds.add(res.contactId ?? '')
    if (res.direction === 'inbound') slot.inbound += 1
    else slot.outbound += 1
    if (slot.lastIso === null || iso > slot.lastIso) slot.lastIso = iso

    const msgFp = (await fpSet(
      buildMessageFingerprintFields({ connectionId, conversationKey, messageKey }), keyRing,
    )).writeFingerprint

    // EARLIEST WINS, on exactly the pair the database merge compares.
    const isEarlier = slot.firstIso === null
      || iso < slot.firstIso
      || (iso === slot.firstIso && msgFp < slot.firstFp)
    if (isEarlier) {
      slot.firstIso = iso
      slot.firstFp = msgFp
      slot.firstMessageKey = messageKey
      slot.firstContactId = res.contactId ?? null
      slot.firstCounterparty = res.counterparty
    }
  }

  const contributions = []
  for (const slot of byConversation.values()) {
    // Within-page disagreement is decided here; across-page disagreement is decided by
    // the same two rules inside record_outlook_page_progress.
    if (slot.taint === null && slot.counterparties.size > 1) slot.taint = 'mixed_counterparties'
    if (slot.taint === null && slot.contactIds.size > 1) slot.taint = 'ambiguous_contact'
    if (slot.taint === null && slot.messages > MAX_EPISODE_MESSAGES) slot.taint = 'episode_truncated'

    const conversationFingerprint = (await fpSet(
      buildConversationFingerprintFields({ connectionId, conversationKey: slot.conversationKey }),
      keyRing,
    )).writeFingerprint

    const contribution = {
      cfp: conversationFingerprint,
      pfp: null,
      efp: null,
      elookup: null,
      first_fp: null,
      first_at: null,
      last_at: slot.lastIso,
      contact_id: null,
      key_version: null,
      inbound: slot.inbound,
      outbound: slot.outbound,
      messages: slot.messages,
      taint: slot.taint,
    }

    if (slot.firstMessageKey !== null) {
      const episode = await fpSet(buildEpisodeFingerprintFields({
        connectionId,
        conversationKey: slot.conversationKey,
        firstMessageKey: slot.firstMessageKey,
        contactId: slot.firstContactId,
      }), keyRing)
      const person = await fpSet(
        buildPersonFingerprintFields({ connectionId, email: slot.firstCounterparty }), keyRing)
      contribution.efp = episode.writeFingerprint
      contribution.elookup = (episode.lookupFingerprints ?? []).map((l) => l.fingerprint)
      contribution.pfp = person.writeFingerprint
      contribution.first_fp = slot.firstFp
      contribution.first_at = slot.firstIso
      contribution.contact_id = slot.firstContactId
      contribution.key_version = episode.writeKeyVersion
    }

    contributions.push(contribution)
  }

  // Deterministic order, so a fixture produces one payload and a diff is readable.
  contributions.sort((a, b) => a.cfp.localeCompare(b.cfp))
  return { contributions, counts }
}

/**
 * Turn the round's accumulated conversation records into a plan.
 *
 * Shape-compatible with `planEpisodes`, so the write loop in outlookImportRun is
 * unchanged - EXCEPT that `counterparty` and `displayName` are always null, because
 * neither is stored. Both are needed only to propose a BRAND NEW contact, which this
 * pass still always defers (it does not read the automation headers), so nothing that
 * can be written is missing.
 *
 * @param {object} p
 * @param {Array<object>} p.conversations  rows from list_outlook_round_conversations
 * @param {(iso:string)=>string|null} p.localDateFor  bound to the user's time zone
 */
export function finalizeRound (p) {
  const { conversations, localDateFor } = p || {}
  if (typeof localDateFor !== 'function') throw new Error('local_date_required')
  const rows = Array.isArray(conversations) ? conversations : []
  const entries = []
  const skipped = Object.create(null)
  const bump = (code) => { skipped[code] = (skipped[code] || 0) + 1 }
  for (const r of rows) {
    const one = finalizeConversation(r, localDateFor)
    if (one.entry === null) bump(one.skip)
    else entries.push(one.entry)
  }
  return { entries, skipped }
}

/**
 * The same decision for ONE accumulated conversation.
 *
 * Separate from finalizeRound because the run has to walk the rows one at a time: the
 * suggestions of a finished round are written one bounded RPC at a time, and an
 * invocation that runs out of budget mid-batch must be able to say exactly how far it
 * got. Reproduced before this existed: a hard stop after 6 of 40 writes left the next
 * invocation re-listing all 40 and starting again at the first entry, forever.
 *
 * Returns the plan entry, or the controlled code saying why there is none. Either way
 * the caller may advance its write cursor past this conversation - a skip is a decision,
 * not unfinished work.
 *
 * @param {object} r  one row from list_outlook_round_conversations
 * @param {(iso:string)=>string|null} localDateFor  bound to the user's time zone
 * @returns {{entry: object, skip: null}|{entry: null, skip: string}}
 */
export function finalizeConversation (r, localDateFor) {
  if (typeof localDateFor !== 'function') throw new Error('local_date_required')
  const bump = (code) => ({ entry: null, skip: code })
  {
    if (!isPlainObject(r)) return bump('no_eligible_messages')
    const taint = typeof r.taint === 'string' && r.taint.length > 0 ? r.taint : null
    if (taint !== null) return bump(ROUND_TAINT_CODES.includes(taint) ? taint : 'no_eligible_messages')

    const efp = typeof r.efp === 'string' ? r.efp : null
    const pfp = typeof r.pfp === 'string' ? r.pfp : null
    if (efp === null || pfp === null) return bump('no_eligible_messages')

    const inbound = Number.isInteger(r.inbound) ? r.inbound : 0
    const outbound = Number.isInteger(r.outbound) ? r.outbound : 0
    // The whole reason this state is persisted: the two halves may have arrived in
    // different pages, invocations or folders, and only the accumulated counts can say
    // whether the exchange was ever two-sided.
    if (inbound === 0 || outbound === 0) return bump('not_two_sided')

    const proposedDate = localDateFor(r.last_at)
    if (proposedDate === null) return bump('invalid_timestamp')

    const contactId = typeof r.contact_id === 'string' && r.contact_id.length > 0 ? r.contact_id : null
    return { skip: null, entry: Object.freeze({
      // Carried so the caller can advance its write cursor past this conversation. It is a
      // keyed fingerprint, never logged.
      conversationFingerprint: typeof r.cfp === 'string' ? r.cfp : null,
      kind: contactId ? 'known_contact_interaction' : 'new_contact_suggestion',
      contactId,
      // Not stored, and not needed: only a new-contact proposal would use them, and this
      // pass always defers those.
      counterparty: null,
      displayName: null,
      proposedType: 'Email',
      proposedDate,
      inbound,
      outbound,
      messageCount: Number.isInteger(r.messages) ? r.messages : inbound + outbound,
      episodeFingerprint: efp,
      episodeLookupFingerprints: Array.isArray(r.elookup)
        ? r.elookup.filter((f) => typeof f === 'string')
        : [],
      personFingerprint: pfp,
      keyVersion: Number.isInteger(r.key_version) ? r.key_version : null,
    }) }
  }
}

/**
 * The ONLY shape of round progress that may be logged.
 *
 * Counts, flags and controlled codes. Never a fingerprint, a ciphertext, a round id or a
 * connection id - a fingerprint in particular is a stable per-user identifier for one
 * exchange, so logging it would build a durable record of who someone talks to.
 */
export function summarizeRoundProgress (folders) {
  const out = Object.create(null)
  for (const [folder, f] of Object.entries(isPlainObject(folders) ? folders : {})) {
    out[folder] = {
      resumed: f?.resumed === true,
      pages: Number.isInteger(f?.pages) ? f.pages : 0,
      messages: Number.isInteger(f?.messages) ? f.messages : 0,
      page_seq: Number.isInteger(f?.pageSeq) ? f.pageSeq : 0,
      folder_complete: f?.folderComplete === true,
      messages_dropped: Number.isInteger(f?.messagesDropped) ? f.messagesDropped : 0,
      conversations_dropped: Number.isInteger(f?.conversationsDropped) ? f.conversationsDropped : 0,
      // Whether a resume position exists, never the position itself.
      has_next_link: f?.hasNextLink === true,
      has_pending_delta: f?.hasPendingDelta === true,
    }
  }
  return out
}
