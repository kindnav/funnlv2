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
// THE COMPLETION AND CURSOR CONTRACT - the part that is easiest to get wrong.
//
// A stored @odata.deltaLink is a claim: "everything before this point has been
// ingested; next time, start after it." If that claim is false, the messages it
// skipped are lost for good, because a delta stream never offers them again.
//
// So this pass exposes cursors through ONE gate, `commitReady`, and withholds the
// values entirely when it is false. Five things clear the gate, and any one of them
// closing it is enough to withhold every cursor:
//
//   folder_incomplete       a folder never reached its deltaLink.
//   messages_dropped        the per-run message ceiling truncated a page.
//   conversations_dropped   the in-memory conversation ceiling discarded threads.
//   episode_truncated       a thread exceeded MAX_EPISODE_MESSAGES and was shortened,
//                           so a suggestion from it would rest on a partial view.
//   plan_truncated          MAX_PLAN_ENTRIES discarded episodes that had qualified.
//
// WHY THE GATE IS WHOLE-RUN AND NOT PER FOLDER. A conversation can span Inbox and
// Sent Items, and the conversation, episode and plan ceilings are applied AFTER the
// two folders are merged. An episode discarded at the plan stage may therefore have
// been drawn from Inbox messages that Inbox's own cursor already covers, so
// committing Inbox alone would lose it. Either the whole run is committable or none
// of it is - including the case where Inbox finishes cleanly and Sent Items does not.
//
// A DEFECT THIS REPLACED, worth recording because the ordering looked harmless: a
// final page can BOTH carry a deltaLink and push the run past MAX_MESSAGES_PER_RUN.
// The cursor used to be honoured first, so such a run reported itself complete and
// handed back a cursor while having silently dropped the overflow.
//
// CONTINUATION IS NOT IMPLEMENTED, AND MUST BE DESIGNED BEFORE THIS IS OPERATIONAL.
// Withholding the cursor is the SAFE failure, not a working one. A mailbox large
// enough to exceed these ceilings will never become commit-ready under the current
// design: every run restarts from the same stored cursor (or from scratch), reads the
// same first MAX_MESSAGES_PER_RUN messages, hits the same ceiling, and commits
// nothing - so it makes no progress, forever. That is correct in the sense that it
// loses nothing, and useless in the sense that it imports nothing.
//
// Making it work needs a DURABLE CONTINUATION design, which is deliberately out of
// scope here and must be reviewed on its own: somewhere to persist partial progress
// within a delta stream (an intermediate nextLink is opaque and time-limited, so it
// is not obviously safe to store), a way to resume mid-stream across runs, and a
// decision about what a user is shown while a first import is still in progress.
// Until that exists, the worker endpoint must stay disabled - which it is, twice
// over, and it answers 501 rather than running.
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

/**
 * Why a run is NOT commit-ready. Controlled set; safe to log.
 *
 * Each of these means work was dropped or left unfinished, so no delta cursor from
 * this run may be stored: a cursor says "everything up to here has been ingested",
 * and that would be false.
 */
export const INCOMPLETE_REASONS = Object.freeze([
  'folder_incomplete',        // a folder never reached its deltaLink
  'messages_dropped',         // the per-run message ceiling truncated a page
  'conversations_dropped',    // the in-memory conversation ceiling discarded threads
  'episode_truncated',        // a thread had more messages than MAX_EPISODE_MESSAGES
  'plan_truncated',           // MAX_PLAN_ENTRIES discarded qualified episodes
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
  let droppedMessages = 0

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
      if (entries.size >= MAX_MESSAGES_PER_RUN) {
        // The in-memory map is full. Counting this is the whole point: a silently
        // dropped message plus an advanced cursor is permanent data loss.
        droppedMessages += 1
        continue
      }
      if (!entries.has(m.providerMessageKey)) {
        entries.set(m.providerMessageKey, { message: m, extra: norm.extras.get(m.providerMessageKey) })
      }
    }
    for (const r of norm.removals) removals.push(r)
    for (const [code, n] of Object.entries(norm.byDiscardCode)) {
      discards[code] = (discards[code] || 0) + n
    }
    messages += norm.counts.input

    // ORDER MATTERS, and the previous order was wrong. A final page can BOTH carry
    // an @odata.deltaLink and push the run past MAX_MESSAGES_PER_RUN. Honouring the
    // cursor first meant a run that had already truncated a page reported itself
    // complete and handed back a cursor - storing it would have skipped every
    // dropped message forever. A cap breach now outranks the cursor.
    const overCap = checkRunCaps({ pages, messages })
    if (overCap) { stop = overCap; break }
    if (page.complete) { deltaLink = page.deltaLink; stop = 'complete'; break }
    if (!page.nextLink) {
      // Neither a nextLink nor a deltaLink: the stream said nothing about how to
      // continue. Treat it as malformed rather than as finished, so the cursor is
      // not advanced on a guess.
      stop = 'malformed_response'
      break
    }
    link = page.nextLink
  }

  // A folder is complete only if it reached a cursor AND dropped nothing. The cursor
  // itself is withheld in every other case, so a caller cannot store one by mistake.
  const complete = stop === 'complete' && deltaLink !== null && droppedMessages === 0
  return {
    folder,
    entries,
    removals,
    discards,
    deltaLink: complete ? deltaLink : null,
    complete,
    stop,
    pages,
    messages,
    droppedMessages,
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
  const truncated = new Set()
  const dropped = new Set()

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
      if (byConversation.size >= MAX_CONVERSATIONS_PER_RUN) {
        // A whole thread discarded. Counted, not swallowed: the run must not then
        // claim it ingested everything.
        dropped.add(key)
        continue
      }
      list = []
      byConversation.set(key, list)
    }
    if (list.length >= MAX_EPISODE_MESSAGES) {
      // The thread is kept but SHORTENED, so any suggestion built from it would rest
      // on a partial view of the exchange.
      truncated.add(key)
      continue
    }
    list.push(e)
  }

  return {
    byConversation,
    // Counted per CONVERSATION, not per discarded message: a 60-message thread is one
    // truncated conversation, which is what a reader needs to know.
    truncatedConversations: truncated.size,
    droppedConversations: dropped.size,
  }
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
      // MUST be copied. The commit gate sums this across folders to decide
      // 'messages_dropped'; omitting it made that reason unreachable, so a run that
      // had truncated a page could report only 'folder_incomplete' and understate
      // what was actually lost.
      droppedMessages: res.droppedMessages,
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

  // ── COMMIT READINESS ──────────────────────────────────────────────────────
  // One gate, for the whole run, because a delta cursor is a claim about what has
  // been INGESTED - not about what was fetched. Every condition below means some
  // relevant work was dropped or left unfinished, and in each case advancing any
  // cursor would skip that work permanently.
  //
  // The gate is deliberately whole-run rather than per folder. A conversation can span
  // both folders, and the conversation, episode and plan ceilings are applied AFTER the
  // folders are merged, so a thread discarded at the plan stage may have been drawn
  // from Inbox messages that Inbox's own cursor already covers. Committing Inbox alone
  // would therefore lose it. So: either the whole run is committable, or none of it is.
  const foldersComplete = GRAPH_FOLDERS.every((f) => folders[f].complete === true)
  const droppedMessages = GRAPH_FOLDERS
    .reduce((n, f) => n + (folders[f].droppedMessages || 0), 0)
  const planTruncated = Number.isInteger(plan.skipped.plan_cap_reached)
    ? plan.skipped.plan_cap_reached
    : 0

  const incompleteReasons = []
  if (!foldersComplete) incompleteReasons.push('folder_incomplete')
  if (droppedMessages > 0) incompleteReasons.push('messages_dropped')
  if (grouped.droppedConversations > 0) incompleteReasons.push('conversations_dropped')
  if (grouped.truncatedConversations > 0) incompleteReasons.push('episode_truncated')
  if (planTruncated > 0) incompleteReasons.push('plan_truncated')
  const commitReady = incompleteReasons.length === 0

  return {
    stage: PASS_STAGE,
    connectionId: connection.connectionId,

    // THE GATE. A caller must read this before anything else.
    commitReady,
    incompleteReasons,

    // The cursors, and the ONLY place they are exposed. They are absent unless the run
    // is committable, so a caller cannot store one by reaching past the gate. The
    // per-folder records below carry `reachedCursor` as a boolean for diagnostics and
    // deliberately do NOT carry the value.
    cursors: commitReady
      ? Object.freeze(Object.fromEntries(GRAPH_FOLDERS.map((f) => [f, folders[f].deltaLink])))
      : null,

    folders: Object.fromEntries(GRAPH_FOLDERS.map((f) => [f, {
      stop: folders[f].stop,
      complete: folders[f].complete,
      reachedCursor: typeof folders[f].deltaLink === 'string' && folders[f].deltaLink.length > 0,
      pages: folders[f].pages,
      requests: folders[f].requests,
      droppedMessages: folders[f].droppedMessages || 0,
      contentFetches: folders[f].contentFetches,
    }])),

    // Removed/deleted provider items, as fingerprint-free provider keys. The caller
    // decides whether to invalidate anything; this pass does not.
    removals,
    plan: plan.entries,
    skipped: plan.skipped,
    discards,
    truncatedConversations: grouped.truncatedConversations,
    droppedConversations: grouped.droppedConversations,
    droppedMessages,
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
  if (!isPlainObject(result)) return { stage: PASS_STAGE, commit_ready: false }
  const byKind = Object.create(null)
  for (const e of Array.isArray(result.plan) ? result.plan : []) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1
  }
  const folders = Object.create(null)
  for (const f of GRAPH_FOLDERS) {
    const r = result.folders?.[f]
    folders[f] = r
      ? {
          stop: r.stop,
          complete: r.complete === true,
          reached_cursor: r.reachedCursor === true,
          pages: r.pages,
          requests: r.requests,
          dropped_messages: r.droppedMessages ?? 0,
        }
      : null
  }
  return {
    stage: PASS_STAGE,
    // First, because it is the only field that decides whether a cursor may be stored.
    commit_ready: result.commitReady === true,
    incomplete_reasons: Array.isArray(result.incompleteReasons) ? result.incompleteReasons : [],
    folders,
    conversations: result.conversations ?? 0,
    dropped_conversations: result.droppedConversations ?? 0,
    truncated_conversations: result.truncatedConversations ?? 0,
    dropped_messages: result.droppedMessages ?? 0,
    plan_entries: Array.isArray(result.plan) ? result.plan.length : 0,
    plan_by_kind: byKind,
    skipped: result.skipped ?? {},
    discards: result.discards ?? {},
    removals: Array.isArray(result.removals) ? result.removals.length : 0,
    totals: result.totals ?? null,
  }
}
