// The first Outlook import pass: Inbox and Sent Items METADATA only.
//
// WHAT THIS SLICE DOES
// Reads the envelope of messages in the two well-known folders, applies the
// deterministic rules that already exist, groups what survives into
// conversation-episodes, deduplicates them, and produces a bounded PLAN: for each
// episode, the fingerprints and the few envelope-derived facts a suggestion would
// be built from. That is "the evidence needed to prepare a suggestion".
//
// WHAT IT DELIBERATELY DOES NOT DO - each of these is asserted by a test, not just
// promised here:
//   * NO message body. Stage 2 (`buildMessageContentRequest`) is never called; the
//     only request builders used are the delta and follow-link ones, which request
//     `DISCOVERY_SELECT` and nothing else.
//   * NO Anthropic call, and no draft text. Nothing here imports
//     outlookDraftContract.js or outlookContentSanitizer.js.
//   * NO database write. This module takes no Supabase client and performs no RPC.
//     It returns a plan; deciding what to persist is the next slice's problem.
//   * NO contact or interaction is created. A plan entry is a proposal, and the
//     review-before-save rule means only a user action may turn one into a record.
//   * NO scheduling. Nothing here runs itself; there is no cron and no timer.
//
// CONSEQUENCE OF HAVING NO BODY: automation facts live in message headers, which the
// discovery projection does not request, so every entry arrives with
// `automationFactsComplete: false`. `evaluateMessage` fails closed on that - it
// DEFERS anything that would become a brand-new contact suggestion. So a
// metadata-only pass can confirm interactions with people the user already tracks,
// and can only ever DEFER a new person until a later slice reads the headers. That
// is a property of the design, not a bug, and the plan reports it as a first-class
// count rather than hiding it.
//
// BOUNDS. The page and message caps are enforced through the transport's own
// checkRunCaps (MAX_PAGES_PER_RUN, MAX_MESSAGES_PER_RUN), so they are never
// redefined here; MAX_MESSAGES_PER_RUN is also read directly to bound the in-memory
// entry map. Two further caps below
// bound the in-memory grouping, because a plan is held in memory and must not grow
// with the mailbox.
//
// CROSS-USER SAFETY. The pass is given ONE connection's identity, ONE contact index
// and ONE key ring, all by the caller. It never queries for them, so there is no
// path by which another user's contact or another connection's cursor could enter.
// The fingerprints are namespaced on `connectionId`, so even an identical
// conversation in two accounts produces different values.

import {
  GRAPH_FOLDERS,
  MAX_MESSAGES_PER_RUN,
  buildFolderDeltaRequest,
  buildFollowLinkRequest,
  checkRunCaps,
  executeGraphRequest as defaultExecuteGraphRequest,
  isCursorInvalid,
  readDeltaPage,
} from './outlookGraphTransport.js'
import { normalizeGraphPage } from './outlookMessageNormalize.js'
import {
  MAX_EPISODE_MESSAGES,
  buildSelfIdentitySet,
  indexContactsByEmail,
  qualifyEpisode,
  computeEpisodeFingerprints as defaultComputeEpisodeFingerprints,
} from './outlookParticipants.js'

export const PASS_STAGE = 'metadata'

/** A plan is held in memory, so it is capped independently of the mailbox. */
export const MAX_CONVERSATIONS_PER_RUN = 400
export const MAX_PLAN_ENTRIES = 200

/** Why an episode produced no plan entry. Controlled set; safe to log. */
export const SKIP_CODES = Object.freeze([
  'no_eligible_messages', 'self_only', 'cc_only', 'bulk_or_list', 'non_human_message',
  'malformed_addresses', 'ambiguous_counterparties', 'ambiguous_contact',
  'mixed_counterparties', 'not_two_sided', 'automation_facts_incomplete',
  'conversation_cap_reached', 'plan_cap_reached',
])

/** Why a run stopped early. Controlled set; safe to log. */
export const STOP_CODES = Object.freeze([
  'complete', 'max_pages_exceeded', 'max_messages_exceeded', 'cursor_invalid',
  'transport_failure', 'malformed_response',
])

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The local calendar date of a message, in the user's zone.
 *
 * `interaction_candidates.proposed_interaction_date` is a DATE, and the user reads it
 * as "the day I spoke to them". Deriving it from the UTC instant would put a late
 * evening exchange on the wrong day for most of the world, so the zone is required
 * from the caller rather than defaulted silently.
 */
export function localDateFor (iso, timeZone) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const zone = typeof timeZone === 'string' && timeZone.length > 0 ? timeZone : 'UTC'
  let parts
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d)
  } catch {
    // An unusable zone must not silently become a different day: fall back to UTC,
    // which is at least a stated, deterministic choice.
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d)
  }
  const get = (t) => parts.find((p) => p.type === t)?.value ?? ''
  const out = `${get('year')}-${get('month')}-${get('day')}`
  return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null
}

/**
 * Read one folder's delta stream, bounded.
 *
 * Follows `@odata.nextLink` until the stream ends with an `@odata.deltaLink`, a cap is
 * hit, or a request fails. A run that did NOT reach a deltaLink returns
 * `deltaLink: null` and `complete: false`, so a caller cannot mistake a truncated
 * pass for a finished one and advance the durable cursor.
 *
 * @param {object} p
 * @param {'inbox'|'sentitems'} p.folder
 * @param {string|null} [p.startLink]  a previously stored deltaLink, or null for a
 *                                     first pass. Validated by the transport.
 * @param {string} p.accessToken
 * @param {{executeGraphRequest?:Function, fetchImpl:Function, sleepImpl?:Function, now?:Function}} p.deps
 * @param {{pagesUsed?:number, messagesUsed?:number}} [p.used] counts already spent by
 *        an earlier folder in the SAME run, so the caps are per run, not per folder.
 */
export async function readFolderMetadata (p) {
  const { folder, startLink = null, accessToken, deps, used } = p || {}
  if (!GRAPH_FOLDERS.includes(folder)) throw new Error('invalid_folder')
  if (!isPlainObject(deps) || typeof deps.fetchImpl !== 'function') {
    throw new Error('fetch_not_injected')
  }
  const exec = typeof deps.executeGraphRequest === 'function'
    ? deps.executeGraphRequest
    : defaultExecuteGraphRequest

  let pages = Number.isInteger(used?.pagesUsed) ? used.pagesUsed : 0
  let messages = Number.isInteger(used?.messagesUsed) ? used.messagesUsed : 0

  const entries = new Map()      // providerMessageKey -> { message, extra }
  const removals = []
  const discards = Object.create(null)
  let link = typeof startLink === 'string' && startLink.length > 0 ? startLink : null
  let deltaLink = null
  let stop = 'complete'
  let requests = 0

  for (;;) {
    const capCode = checkRunCaps({ pages: pages + 1, messages })
    if (capCode) { stop = capCode; break }

    let request
    try {
      request = link === null
        ? buildFolderDeltaRequest({ folder })
        : buildFollowLinkRequest({ link })
    } catch {
      stop = 'malformed_response'
      break
    }

    requests += 1
    const res = await exec({
      request,
      accessToken,
      fetchImpl: deps.fetchImpl,
      sleepImpl: deps.sleepImpl,
      now: deps.now,
    })
    pages += 1

    if (!res.ok) {
      // An expired or unusable delta cursor is not a failure of this run: it means the
      // stored cursor must be discarded and the next run must start over. Either way
      // this run does NOT advance the cursor.
      stop = isCursorInvalid(res.code) ? 'cursor_invalid'
        : res.code === 'malformed_response' ? 'malformed_response'
          : 'transport_failure'
      break
    }

    const page = readDeltaPage(res.json)
    if (!page.ok) { stop = 'malformed_response'; break }

    const norm = normalizeGraphPage(page.items, folder)
    for (const m of norm.messages) {
      if (entries.size >= MAX_MESSAGES_PER_RUN) break
      if (!entries.has(m.providerMessageKey)) {
        entries.set(m.providerMessageKey, { message: m, extra: norm.extras.get(m.providerMessageKey) })
      }
    }
    for (const r of norm.removals) removals.push(r)
    for (const [code, n] of Object.entries(norm.byDiscardCode)) {
      discards[code] = (discards[code] || 0) + n
    }
    messages += norm.counts.input

    const overCap = checkRunCaps({ pages, messages })
    if (page.complete) { deltaLink = page.deltaLink; stop = 'complete'; break }
    if (overCap) { stop = overCap; break }
    if (!page.nextLink) {
      // Neither a nextLink nor a deltaLink: the stream said nothing about how to
      // continue. Treat it as malformed rather than as finished, so the cursor is
      // not advanced on a guess.
      stop = 'malformed_response'
      break
    }
    link = page.nextLink
  }

  return {
    folder,
    entries,
    removals,
    discards,
    deltaLink,
    complete: stop === 'complete' && deltaLink !== null,
    stop,
    pages,
    messages,
    requests,
    contentFetches: 0,          // structural: this pass never reads a body
  }
}

/**
 * Group entries into conversation-episodes, deterministically.
 *
 * Ordering is by conversation key so a plan is reproducible regardless of the order
 * pages arrived in, and each episode's messages are capped at MAX_EPISODE_MESSAGES
 * (the same bound qualifyEpisode applies) so one enormous thread cannot dominate.
 */
export function groupByConversation (entries) {
  const source = entries instanceof Map ? [...entries.values()] : (Array.isArray(entries) ? entries : [])
  const byConversation = new Map()
  let truncatedConversations = 0

  const ordered = source.slice().sort((a, b) => {
    const ak = String(a?.message?.providerConversationKey ?? '')
    const bk = String(b?.message?.providerConversationKey ?? '')
    if (ak !== bk) return ak.localeCompare(bk)
    const at = String(a?.message?.timestampIso ?? '')
    const bt = String(b?.message?.timestampIso ?? '')
    if (at !== bt) return at.localeCompare(bt)
    return String(a?.message?.providerMessageKey ?? '').localeCompare(String(b?.message?.providerMessageKey ?? ''))
  })

  for (const e of ordered) {
    const key = e?.message?.providerConversationKey
    if (typeof key !== 'string' || key.length === 0) continue
    let list = byConversation.get(key)
    if (list === undefined) {
      if (byConversation.size >= MAX_CONVERSATIONS_PER_RUN) continue
      list = []
      byConversation.set(key, list)
    }
    if (list.length >= MAX_EPISODE_MESSAGES) { truncatedConversations += 1; continue }
    list.push(e)
  }

  return { byConversation, truncatedConversations }
}

/**
 * Turn grouped conversations into a bounded plan.
 *
 * Each plan entry carries ONLY what a suggestion is built from, and nothing a log may
 * see: no body (there is none), no header, no Microsoft message or conversation id -
 * the provider keys are replaced by the keyed fingerprints computed from them, so the
 * plan cannot be used to look a message back up in the mailbox.
 *
 * @param {object} p
 * @param {Map<string, Array>} p.byConversation
 * @param {Set<string>} p.selfSet
 * @param {Map} p.contactIndex
 * @param {string} p.connectionId
 * @param {object} p.keyRing
 * @param {string} p.timeZone
 * @param {{computeEpisodeFingerprints?:Function}} [p.deps]
 */
export async function planEpisodes (p) {
  const { byConversation, selfSet, contactIndex, connectionId, keyRing, timeZone, deps } = p || {}
  if (typeof connectionId !== 'string' || connectionId.length === 0) {
    throw new Error('connection_id_required')
  }
  const fingerprints = typeof deps?.computeEpisodeFingerprints === 'function'
    ? deps.computeEpisodeFingerprints
    : defaultComputeEpisodeFingerprints

  const entries = []
  const skipped = Object.create(null)
  const bump = (code) => { skipped[code] = (skipped[code] || 0) + 1 }
  const conversations = byConversation instanceof Map ? [...byConversation.entries()] : []

  for (const [, group] of conversations) {
    if (entries.length >= MAX_PLAN_ENTRIES) { bump('plan_cap_reached'); continue }

    const q = qualifyEpisode({ entries: group, selfSet, contactIndex })
    if (!q.ok) { bump(q.code); continue }

    const proposedDate = localDateFor(q.lastTimestampIso, timeZone)
    if (proposedDate === null) { bump('malformed_addresses'); continue }

    const fp = await fingerprints(q, { connectionId, keyRing })
    entries.push(Object.freeze({
      kind: q.kind,                    // known_contact_interaction | new_contact_suggestion
      contactId: q.contactId,          // null for a proposed new person
      // Envelope-derived, and the only permitted source for a proposed address.
      counterparty: q.counterparty,
      displayName: q.displayName,
      proposedType: 'Email',
      proposedDate,
      inbound: q.inbound,
      outbound: q.outbound,
      messageCount: q.messageKeys.length,
      // computeFingerprintSet's own shape: the value written under the CURRENT key,
      // plus one lookup value per accepted key so a key rotation cannot create a
      // duplicate suggestion for an episode already recorded under an older key.
      episodeFingerprint: fp.episode.writeFingerprint,
      episodeLookupFingerprints: (fp.episode.lookupFingerprints ?? []).map((l) => l.fingerprint),
      personFingerprint: fp.person.writeFingerprint,
      keyVersion: fp.episode.writeKeyVersion,
    }))
  }

  return { entries, skipped }
}

/**
 * The whole pass for one connection: both folders, then one plan.
 *
 * The caps are shared across folders, so a run cannot read MAX_PAGES_PER_RUN pages of
 * Inbox and then another MAX_PAGES_PER_RUN of Sent Items.
 *
 * @param {object} p
 * @param {{connectionId:string, primaryEmail:string, aliases?:string[], timeZone?:string}} p.connection
 * @param {{inbox?:string|null, sentitems?:string|null}} [p.cursors] stored deltaLinks
 * @param {string} p.accessToken
 * @param {Array<{id:string, email:string, user_id?:string}>} p.contacts
 * @param {string} p.userId  required; contacts are filtered to this owner
 * @param {object} p.keyRing
 * @param {object} p.deps
 */
export async function runOutlookMetadataPass (p) {
  const { connection, cursors, accessToken, contacts, userId, keyRing, deps } = p || {}
  if (!isPlainObject(connection) || typeof connection.connectionId !== 'string') {
    throw new Error('connection_required')
  }
  // REQUIRED, not optional. indexContactsByEmail filters on `c.user_id !== userId`,
  // so an absent owner would index NOTHING and every known contact would silently
  // become an unknown one. Failing loudly is the safe reading of that.
  if (typeof userId !== 'string' || userId.length === 0) throw new Error('user_id_required')

  const selfSet = buildSelfIdentitySet(connection.primaryEmail, connection.aliases)
  const contactIndex = indexContactsByEmail(contacts, userId)

  const folders = {}
  let pagesUsed = 0
  let messagesUsed = 0
  const merged = new Map()
  const removals = []
  const discards = Object.create(null)

  for (const folder of GRAPH_FOLDERS) {
    const res = await readFolderMetadata({
      folder,
      startLink: cursors?.[folder] ?? null,
      accessToken,
      deps,
      used: { pagesUsed, messagesUsed },
    })
    pagesUsed = res.pages
    messagesUsed = res.messages
    folders[folder] = {
      stop: res.stop,
      complete: res.complete,
      // The cursor is returned ONLY when the stream actually finished. A caller that
      // stores it on an incomplete run would skip messages forever.
      deltaLink: res.complete ? res.deltaLink : null,
      pages: res.pages,
      requests: res.requests,
      contentFetches: res.contentFetches,
    }
    for (const [k, v] of res.entries) if (!merged.has(k)) merged.set(k, v)
    for (const r of res.removals) removals.push(r)
    for (const [code, n] of Object.entries(res.discards)) discards[code] = (discards[code] || 0) + n
  }

  const grouped = groupByConversation(merged)
  const plan = await planEpisodes({
    byConversation: grouped.byConversation,
    selfSet,
    contactIndex,
    connectionId: connection.connectionId,
    keyRing,
    timeZone: connection.timeZone,
    deps,
  })

  const runComplete = GRAPH_FOLDERS.every((f) => folders[f].complete === true)

  return {
    stage: PASS_STAGE,
    connectionId: connection.connectionId,
    folders,
    runComplete,
    // Removed/deleted provider items, as fingerprint-free provider keys. The caller
    // decides whether to invalidate anything; this pass does not.
    removals,
    plan: plan.entries,
    skipped: plan.skipped,
    discards,
    truncatedConversations: grouped.truncatedConversations,
    conversations: grouped.byConversation.size,
    totals: { pages: pagesUsed, messagesSeen: messagesUsed, contentFetches: 0 },
  }
}

/**
 * The ONLY shape of a pass result that may be logged.
 *
 * Counts and controlled codes, never an address, subject, display name, provider key
 * or fingerprint. A fingerprint is excluded deliberately: it is a stable per-user
 * identifier for one exchange, so logging it would build a durable record of who
 * someone talks to.
 */
export function summarizePass (result) {
  if (!isPlainObject(result)) return { stage: PASS_STAGE, ok: false }
  const byKind = Object.create(null)
  for (const e of Array.isArray(result.plan) ? result.plan : []) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1
  }
  const folders = Object.create(null)
  for (const f of GRAPH_FOLDERS) {
    const r = result.folders?.[f]
    folders[f] = r ? { stop: r.stop, complete: r.complete === true, pages: r.pages, requests: r.requests } : null
  }
  return {
    stage: PASS_STAGE,
    run_complete: result.runComplete === true,
    folders,
    conversations: result.conversations ?? 0,
    truncated_conversations: result.truncatedConversations ?? 0,
    plan_entries: Array.isArray(result.plan) ? result.plan.length : 0,
    plan_by_kind: byKind,
    skipped: result.skipped ?? {},
    discards: result.discards ?? {},
    removals: Array.isArray(result.removals) ? result.removals.length : 0,
    totals: result.totals ?? null,
  }
}
