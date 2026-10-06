// Outlook durable continuation — one INVOCATION's share of a delta round.
//
// WHY THIS EXISTS ALONGSIDE outlookMetadataPass.js. That module reads both folders to
// completion in one go and holds every message in memory. On hosted Supabase Edge
// Functions that cannot work: the request idle timeout is 150s, the maximum duration is
// 150s on the free plan (400s paid), and background tasks are explicitly capped by the
// same wall clock. A mailbox that needs more than one invocation must therefore be able
// to stop cleanly and be picked up again - which means reading ONE page at a time and
// checkpointing after each.
//
// THE TWO DEADLINES ARE DIFFERENT THINGS, and conflating them is the mistake this file
// exists to avoid:
//   * the LEASE deadline (420s, renewed per stage) stops a SECOND run touching the same
//     connection. It is deliberately longer than any invocation may live.
//   * the INVOCATION deadline (this file) stops THIS run being killed mid-page by the
//     platform. It is anchored to handler entry and is much shorter.
// A lease that is still valid says nothing about whether the platform is about to shut
// the instance down.
//
// WHAT THE BUDGET IS, HONESTLY. PAGE_WORST_MS is 140s - one page's true worst case
// through the transport's retries. Reserving that would admit ZERO pages against a 120s
// budget, so admission uses the slowest page actually observed, floored at
// PAGE_ADMIT_FLOOR_MS. That makes the budget a best-effort stop, not a guarantee. The
// guarantee comes from somewhere else: every page is checkpointed ATOMICALLY, so a hard
// platform kill loses at most the page in flight, and can never advance a cursor or leave
// a half-applied page behind. Saying this out loud is better than implying a promise the
// budget cannot keep.
//
// CURSOR DISCIPLINE, unchanged in substance from the metadata pass:
//   * @odata.nextLink is opaque, time-limited and intra-stream. It is passed to the
//     transport byte-for-byte as Microsoft gave it, encrypted by the caller before it is
//     stored, and never parsed, trimmed, logged or rebuilt.
//   * @odata.deltaLink is a CLAIM that everything before it is ingested. A folder that
//     reaches one stages it as a PENDING cursor. Promotion to the committed cursor
//     happens only in release_outlook_sync_lease, only for a complete round whose
//     suggestions are already written.
//   * a run that stops early advances NOTHING.
//
// NO NEW JOB FRAMEWORK. There is no queue, no heartbeat, no timer and no scheduler here:
// one loop, one deadline check, one checkpoint call per page.

import {
  GRAPH_FOLDERS,
  buildFolderDeltaRequest,
  buildFollowLinkRequest,
  checkRunCaps,
  executeGraphRequest as defaultExecuteGraphRequest,
  isCursorInvalid,
  readDeltaPage,
} from './outlookGraphTransport.js'
import { normalizeGraphPage } from './outlookMessageNormalize.js'
import { buildSelfIdentitySet, indexContactsByEmail } from './outlookParticipants.js'
import { foldPage, MAX_PAGES_PER_ROUND, MAX_MESSAGES_PER_ROUND } from './outlookRoundState.js'

/**
 * The hosted limits this budget is sized against, from
 * https://supabase.com/docs/guides/functions/limits (read 2026-09-30):
 * request idle timeout 150s, maximum duration 150s free / 400s paid, max CPU 2s,
 * max memory 256MB. Background tasks do NOT lift the wall clock - the docs say the
 * function "will shut down when it reaches one of these limits".
 *
 * The project's plan could not be read: `supabase projects list` and `supabase orgs list`
 * both succeed and neither reports a plan or tier. So the conservative number is used,
 * and it stays correct - merely pessimistic - if the project turns out to be paid.
 */
export const HOSTED_WALL_MS = 150_000
export const HOSTED_IDLE_MS = 150_000

/** Cold start, TLS and the part of the request the worker does not get to time. */
export const INVOCATION_SAFETY_MS = 30_000

/** The budget, measured from HANDLER ENTRY rather than from the reservation. */
export const INVOCATION_BUDGET_MS = HOSTED_WALL_MS - INVOCATION_SAFETY_MS

/**
 * The minimum a page is assumed to cost when deciding whether to start another one.
 * Raised to the slowest page actually observed in this invocation, so a slow mailbox
 * stops earlier without needing a configured guess.
 */
export const PAGE_ADMIT_FLOOR_MS = 25_000

/** One checkpoint RPC, plus slack for the local fold that precedes it. */
export const CHECKPOINT_RESERVE_MS = 20_000

/** Why one folder stopped reading. Controlled set; safe to log. */
export const FOLDER_STOP_CODES = Object.freeze([
  'complete',              // reached its @odata.deltaLink in this round
  'already_complete',      // it had reached it in an earlier invocation
  'budget_exhausted',      // the invocation deadline would not cover another page
  'invocation_cap',        // the per-invocation page/message cap was reached
  'round_page_cap',        // the per-ROUND page ceiling was reached
  'round_message_cap',     // the per-ROUND message ceiling was reached
  'cursor_invalid',        // Microsoft rejected the link we resumed from
  'transport_failure',
  'malformed_response',
  'checkpoint_refused',    // the database would not accept the page
])

/** Stops that mean "come back and carry on", as opposed to "this round is broken". */
export const CONTINUABLE_STOPS = Object.freeze([
  'budget_exhausted', 'invocation_cap',
])

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Is there enough invocation budget left to start another page AND checkpoint it?
 *
 * Strictly greater, for the same reason the lease guard is: with exactly the reserve
 * left, a page costing its assumed worst finishes at the instant the budget runs out and
 * the checkpoint then has nothing.
 */
export function budgetAllowsPage ({ nowMs, deadlineMs, slowestPageMs = 0, reserveMs = 0 }) {
  const admit = Math.max(PAGE_ADMIT_FLOOR_MS, Number.isFinite(slowestPageMs) ? slowestPageMs : 0)
  return deadlineMs - nowMs > admit + CHECKPOINT_RESERVE_MS + reserveMs
}

/**
 * Read one folder for as long as the budget and the caps allow, checkpointing every page.
 *
 * @param {object} p
 * @param {'inbox'|'sentitems'} p.folder
 * @param {string|null} p.resumeLink   a decrypted @odata.nextLink from a previous
 *                                     invocation of THIS round, or null
 * @param {string|null} p.committedLink the committed @odata.deltaLink to start a fresh
 *                                     round from, or null for a first ever pass
 * @param {object} p.round             { pageSeq, pages, messages, folderComplete }
 * @param {Function} p.checkpoint      async; commits the fold AND the resume position
 * @param {Function} p.fold            async; (entries) => contributions
 * @param {object} p.budget            { now, deadlineMs, reserveMs }
 * @param {Function} [p.onPageComplete] the lease guard; throwing stops the read
 */
export async function readFolderContinued (p) {
  const {
    folder, resumeLink, committedLink, round, checkpoint, fold, budget, deps, accessToken,
    onPageComplete, invocation,
  } = p || {}
  if (!GRAPH_FOLDERS.includes(folder)) throw new Error('invalid_folder')
  if (!isPlainObject(deps) || typeof deps.fetchImpl !== 'function') throw new Error('fetch_not_injected')
  if (typeof checkpoint !== 'function') throw new Error('checkpoint_not_injected')
  if (typeof fold !== 'function') throw new Error('fold_not_injected')

  const exec = typeof deps.executeGraphRequest === 'function'
    ? deps.executeGraphRequest
    : defaultExecuteGraphRequest
  const now = typeof budget?.now === 'function' ? budget.now : Date.now

  // Whether the link we are about to use came from a SAVED position. It decides what an
  // 'invalid cursor' means: a rejected saved nextLink is recoverable by resetting the
  // round, while a rejected committed deltaLink is a different (and still unsolved)
  // problem, so the two are reported separately.
  const resuming = typeof resumeLink === 'string' && resumeLink.length > 0
  let link = resuming ? resumeLink : null
  let usingCommittedDelta = false
  if (!resuming && typeof committedLink === 'string' && committedLink.length > 0) {
    link = committedLink
    usingCommittedDelta = true
  }

  let pageSeq = Number.isInteger(round?.pageSeq) ? round.pageSeq : 0
  let roundPages = Number.isInteger(round?.pages) ? round.pages : 0
  let roundMessages = Number.isInteger(round?.messages) ? round.messages : 0
  let messagesDropped = 0
  let conversationsDropped = 0
  let pagesThisInvocation = 0
  let stop = null
  let complete = round?.folderComplete === true
  let linkRejected = null
  let checkpointRefusal = null
  // Handle accounting, counts and controlled codes only.
  let handlesOffered = 0
  let handlesStored = 0
  let handlesEvicted = 0
  const handleSkips = Object.create(null)
  let handleReason = null

  if (complete) {
    return {
      folder,
      stop: 'already_complete',
      complete: true,
      pagesThisInvocation: 0,
      pageSeq,
      roundPages,
      roundMessages,
      messagesDropped,
      conversationsDropped,
      linkRejected: null,
      checkpointRefusal: null,
      handlesOffered: 0,
      handlesStored: 0,
      handlesEvicted: 0,
      handleSkips: {},
      handleReason: null,
    }
  }

  for (;;) {
    // ── the INVOCATION deadline, checked before every page ───────────────────
    if (!budgetAllowsPage({
      nowMs: now(),
      deadlineMs: budget.deadlineMs,
      slowestPageMs: invocation?.slowestPageMs ?? 0,
      reserveMs: budget.reserveMs ?? 0,
    })) { stop = 'budget_exhausted'; break }

    // ── the per-ROUND ceilings ───────────────────────────────────────────────
    if (roundPages + 1 > MAX_PAGES_PER_ROUND) { stop = 'round_page_cap'; break }
    if (roundMessages >= MAX_MESSAGES_PER_ROUND) { stop = 'round_message_cap'; break }

    // ── the per-INVOCATION caps, unchanged from the transport ─────────────────
    // A second bound, independent of the clock: if the deadline logic were ever wrong, an
    // invocation still cannot read the whole mailbox. Hitting it is CONTINUABLE, not a
    // drop - the next invocation resumes from the checkpoint.
    //
    // COUNTED ACROSS BOTH FOLDERS, not per folder. Using this folder's own page count
    // would give each folder its own MAX_PAGES_PER_RUN, so an invocation could read twice
    // the cap - and the transport's caps have always been per RUN, shared, for exactly
    // that reason.
    const capCode = checkRunCaps({
      pages: (invocation?.pagesThisInvocation ?? 0) + 1,
      messages: invocation?.messagesThisInvocation ?? 0,
    })
    if (capCode) { stop = 'invocation_cap'; break }

    let request
    try {
      request = link === null
        ? buildFolderDeltaRequest({ folder })
        : buildFollowLinkRequest({ link })
    } catch {
      stop = 'malformed_response'
      break
    }

    const pageStartedMs = now()
    const res = await exec({
      request,
      accessToken,
      fetchImpl: deps.fetchImpl,
      sleepImpl: deps.sleepImpl,
      now: deps.now,
    })
    const pageMs = now() - pageStartedMs
    if (invocation && pageMs > (invocation.slowestPageMs ?? 0)) invocation.slowestPageMs = pageMs

    if (!res.ok) {
      if (isCursorInvalid(res.code)) {
        stop = 'cursor_invalid'
        // WHICH link was rejected is the whole basis of the restart decision.
        linkRejected = resuming && link === resumeLink
          ? 'saved_next_link'
          : (usingCommittedDelta ? 'committed_delta_link' : 'fresh_request')
      } else {
        stop = res.code === 'malformed_response' ? 'malformed_response' : 'transport_failure'
      }
      break
    }

    const page = readDeltaPage(res.json)
    if (!page.ok) { stop = 'malformed_response'; break }

    // A page that neither continues nor ends the stream said nothing about how to carry
    // on. Treat it as malformed rather than as finished, so no cursor moves on a guess.
    if (!page.complete && !page.nextLink) { stop = 'malformed_response'; break }

    const norm = normalizeGraphPage(page.items, folder)
    const folded = await fold(norm.messages.map((m) => ({
      message: m, extra: norm.extras.get(m.providerMessageKey),
    })))

    if (isPlainObject(folded.handles)) {
      handlesOffered += Array.isArray(folded.messages) ? folded.messages.length : 0
      for (const [code, n] of Object.entries(folded.handles.skipped ?? {})) {
        if (Number.isInteger(n)) handleSkips[code] = (handleSkips[code] || 0) + n
      }
      // The LAST page's reason wins only when nothing has been produced all folder:
      // 'content_consent_missing' on page one is the fact worth reporting, and it
      // cannot be contradicted by a later page since the gate does not change mid-run.
      if (typeof folded.handles.reason === 'string' && handlesOffered === 0) {
        handleReason = folded.handles.reason
      }
    }

    pageSeq += 1
    const checkpointRes = await checkpoint({
      folder,
      pageSeq,
      nextLink: page.complete ? null : page.nextLink,
      deltaLink: page.complete ? page.deltaLink : null,
      folderComplete: page.complete === true,
      messagesSeen: norm.counts.input,
      messagesDropped: 0,
      conversations: folded.contributions,
      // The retrieval handles for this page, committed in the SAME call as the fold
      // and the resume position. Empty whenever the content consent gate is closed,
      // which is the envelope-only path and the production default.
      messages: folded.messages ?? [],
      removals: norm.removals,
    })

    if (checkpointRes?.result === 'duplicate_page') {
      // The previous attempt's commit DID land; this is a retry of a call whose answer
      // was lost. Nothing was applied twice.
      roundPages = Number.isInteger(checkpointRes.round_pages) ? checkpointRes.round_pages : roundPages
      roundMessages = Number.isInteger(checkpointRes.round_messages) ? checkpointRes.round_messages : roundMessages
    } else if (checkpointRes?.result !== 'recorded') {
      // Anything else - stale_run, a sequence gap, a round ceiling refused in the
      // database - stops the read without advancing anything.
      stop = 'checkpoint_refused'
      checkpointRefusal = typeof checkpointRes?.result === 'string' ? checkpointRes.result : 'unknown'
      break
    } else {
      roundPages = Number.isInteger(checkpointRes.round_pages) ? checkpointRes.round_pages : roundPages + 1
      roundMessages = Number.isInteger(checkpointRes.round_messages)
        ? checkpointRes.round_messages
        : roundMessages + norm.counts.input
      conversationsDropped += Number.isInteger(checkpointRes.conversations_dropped)
        ? checkpointRes.conversations_dropped
        : 0
      // What the DATABASE actually retained, which is the only number that matters:
      // its six-message selection may keep fewer than the page offered.
      handlesStored += Number.isInteger(checkpointRes.handles_offered) ? checkpointRes.handles_offered : 0
      handlesEvicted += Number.isInteger(checkpointRes.handles_evicted) ? checkpointRes.handles_evicted : 0
    }

    pagesThisInvocation += 1
    if (invocation) {
      invocation.pagesThisInvocation = (invocation.pagesThisInvocation ?? 0) + 1
      invocation.messagesThisInvocation = (invocation.messagesThisInvocation ?? 0) + norm.counts.input
    }

    // The lease guard, after the page is safely checkpointed. Fired for EVERY page
    // including a final one: a folder whose stream ends on its first page still has to
    // give the caller a chance to notice that time has passed.
    if (typeof onPageComplete === 'function') {
      await onPageComplete({ folder, pages: pagesThisInvocation, final: page.complete === true })
    }

    if (page.complete) { complete = true; stop = 'complete'; break }

    // Only now advance the in-memory link, and only to the value Microsoft supplied.
    link = page.nextLink
    usingCommittedDelta = false
  }

  return {
    folder,
    stop,
    complete,
    pagesThisInvocation,
    pageSeq,
    roundPages,
    roundMessages,
    messagesDropped,
    conversationsDropped,
    linkRejected,
    checkpointRefusal,
    handlesOffered,
    handlesStored,
    handlesEvicted,
    handleSkips,
    handleReason,
  }
}

/**
 * One invocation's share of a round, across both folders.
 *
 * Folders are read in GRAPH_FOLDERS order and share both the invocation budget and the
 * per-invocation caps, so one folder cannot spend the whole invocation and starve the
 * other of its chance to finish. A folder that finished in an earlier invocation is
 * skipped without a request.
 *
 * @returns {Promise<object>} per-folder progress plus the round-level verdict. It does
 * NOT decide whether to commit: that needs the accumulator, which lives in the database.
 */
export async function runOutlookRoundSlice (p) {
  const {
    connection, committedCursors, resume, accessToken, contacts, userId, keyRing,
    budget, checkpoint, deps, onPageComplete,
  } = p || {}
  if (!isPlainObject(connection) || typeof connection.connectionId !== 'string') {
    throw new Error('connection_required')
  }
  // REQUIRED, not optional: indexContactsByEmail filters on the owner, so an absent one
  // would index NOTHING and every known contact would silently become an unknown person.
  if (typeof userId !== 'string' || userId.length === 0) throw new Error('user_id_required')

  const selfSet = buildSelfIdentitySet(connection.primaryEmail, connection.aliases)
  const contactIndex = indexContactsByEmail(contacts, userId)

  const fold = (entries) => foldPage({
    entries,
    selfSet,
    contactIndex,
    connectionId: connection.connectionId,
    keyRing,
    deps,
  })

  // Shared across folders, so the budget and the caps are per INVOCATION, not per folder.
  const invocation = { slowestPageMs: 0, pagesThisInvocation: 0, messagesThisInvocation: 0 }

  const folders = {}
  const removals = []
  for (const folder of GRAPH_FOLDERS) {
    const r = resume?.[folder] ?? {}
    const res = await readFolderContinued({
      folder,
      resumeLink: r.nextLink ?? null,
      committedLink: committedCursors?.[folder] ?? null,
      round: {
        pageSeq: r.pageSeq ?? 0,
        pages: r.pages ?? 0,
        messages: r.messages ?? 0,
        folderComplete: r.folderComplete === true,
      },
      checkpoint,
      fold,
      budget,
      deps,
      accessToken,
      onPageComplete,
      invocation,
    })
    folders[folder] = {
      ...res,
      resumed: typeof r.nextLink === 'string' && r.nextLink.length > 0,
      // Carried forward from earlier invocations of the same round; the checkpoint RPC
      // accumulates them in the database, these are what it reported back.
      messagesDropped: (r.messagesDropped ?? 0) + res.messagesDropped,
      conversationsDropped: (r.conversationsDropped ?? 0) + res.conversationsDropped,
    }
  }

  const roundComplete = GRAPH_FOLDERS.every((f) => folders[f].complete === true)
  const continuable = GRAPH_FOLDERS.every(
    (f) => folders[f].complete === true || CONTINUABLE_STOPS.includes(folders[f].stop))
  const cursorRejected = GRAPH_FOLDERS
    .map((f) => ({ folder: f, kind: folders[f].linkRejected }))
    .find((x) => x.kind !== null) ?? null

  return {
    connectionId: connection.connectionId,
    folders,
    roundComplete,
    // True when nothing is broken and the only reason for stopping was time or a cap.
    continuable: roundComplete ? false : continuable,
    cursorRejected,
    removals,
    totals: {
      pages: GRAPH_FOLDERS.reduce((n, f) => n + folders[f].pagesThisInvocation, 0),
      roundPages: GRAPH_FOLDERS.reduce((n, f) => n + folders[f].roundPages, 0),
      roundMessages: GRAPH_FOLDERS.reduce((n, f) => n + folders[f].roundMessages, 0),
      messagesDropped: GRAPH_FOLDERS.reduce((n, f) => n + folders[f].messagesDropped, 0),
      conversationsDropped: GRAPH_FOLDERS.reduce((n, f) => n + folders[f].conversationsDropped, 0),
      handlesStored: GRAPH_FOLDERS.reduce((n, f) => n + (folders[f].handlesStored ?? 0), 0),
      handlesEvicted: GRAPH_FOLDERS.reduce((n, f) => n + (folders[f].handlesEvicted ?? 0), 0),
    },
    // Why no handle was produced, when none was. 'content_consent_missing' here is
    // the normal, expected answer for the live pilot connection.
    handleReason: GRAPH_FOLDERS
      .map((f) => folders[f].handleReason)
      .find((r) => typeof r === 'string') ?? null,
  }
}
