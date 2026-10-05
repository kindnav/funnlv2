// One Outlook import run, end to end: reserve a lease, read as much of the current delta
// ROUND as this invocation can afford, checkpoint every page, and - only when the round is
// finished and every qualifying suggestion is written - release with the folder cursors
// advanced.
//
// A ROUND MAY SPAN SEVERAL INVOCATIONS. That is the point: hosted Edge Functions cannot
// read a large mailbox in one request, so an invocation that runs out of budget saves
// exactly where it got to and answers 'continued'.
//
// THE ORDER IS THE CONTRACT, and it is the reason this module exists rather than the
// steps being inlined somewhere:
//
//   0. before EVERY stage below - context load, first page, each page, each candidate
//      write, and the cursor-encryption/release - renew the lease if what remains would
//      not cover that
//      stage's worst case - see PAGE_WORST_MS / CONTEXT_WORST_MS / WRITE_STEP_MS /
//      RELEASE_WORST_MS. Every deadline is anchored to when its RPC STARTED, because the
//      database begins the lease then rather than when the response arrives.
//   1. reserve_due_outlook_connection          take the lease for both folders
//   2. read_outlook_round_progress             where did the last invocation get to?
//   3. runOutlookRoundSlice                    envelope only; no body, no Anthropic. ONE
//      PAGE AT A TIME, each page's fold and resume position committed together by
//      record_outlook_page_progress, and the whole loop bounded by the INVOCATION budget.
//   4. if the round is unfinished but healthy -> release WITHOUT cursors, outcome
//      'continued'. Progress is saved; the next invocation carries on.
//   5. if a SAVED nextLink was rejected -> reset_outlook_round, release WITHOUT cursors,
//      outcome 'restart_required'. The COMMITTED cursor is untouched.
//   6. if the round finished but dropped or shortened work -> release WITHOUT cursors and
//      write NO candidate at all. A truncated round has not seen the whole picture, and a
//      suggestion written from a partial view could be wrong while the cursor it travelled
//      with claimed the mail had been fully ingested.
//   7. otherwise -> upsert_outlook_interaction_candidate for every qualifying entry
//      FIRST, and only if every one of them succeeded, release WITH the pending cursors
//      promoted and run_complete = true.
//
// TWO DEADLINES, DELIBERATELY INDEPENDENT. The LEASE deadline (420s, renewed per stage)
// stops a second run touching this connection. The INVOCATION deadline (120s from handler
// entry) stops the platform killing this run mid-page: hosted Edge Functions have a 150s
// request idle timeout and a 150s wall clock on the free plan, and background tasks do not
// lift either. A lease that is still valid says nothing about whether the instance is
// about to be shut down, which is why the lease length is NOT used as an execution budget.
//
// So a cursor is never advanced past a suggestion that failed to persist. If any write
// fails the run releases as incomplete: the same mail is read again next time and the
// dedupe fingerprint makes the retry idempotent. There is no new transaction
// framework - idempotence IS the recovery mechanism.
//
// WHAT 'COMMITTED' MEANS, narrowly. Only that release_outlook_sync_lease itself
// CONFIRMED success by returning true. It returns FALSE without raising when the run
// id is null or no row matched, which is precisely the lost-lease case; an earlier
// version of this file read "no transport error" as success and reported committed
// with cursors advanced anyway. Every other ending is named separately:
//
//   continued        the invocation budget ran out mid-round; progress SAVED, no cursor
//   restart_required a saved nextLink was rejected; the round was discarded, the
//                    COMMITTED cursor kept
//   incomplete       the round dropped or did not finish work; no write attempted
//   write_failed     a write was REFUSED with a controlled code; released, no cursor
//   write_error      a write or the cursor encryption THREW; best-effort error release
//   release_failed   every intended write landed but the release did not confirm, so
//                    the cursor state is UNKNOWN and is not reported as advanced
//   released_error   the pass itself threw; the lease is released as an error
//   not_in_pilot     the reserved connection is not the designated pilot account; the
//                    lease is released and nothing is read, written or advanced
//
// PARTIAL WRITES ARE REPORTED, NOT ERASED. A run reports three numbers - intended,
// accepted and created - so "two of five landed, then one was refused" is legible.
// Claiming zero when rows exist would send a reader looking for a bug in the wrong
// place. Nothing is rolled back: the rows that landed are valid pending suggestions,
// and the next run's identical writes return 'refreshed'.
//
// WHAT THIS RUN CAN PRODUCE. Exactly one row type: a PENDING interaction suggestion
// for a contact the user already has. Entries the pass marked as a new-contact
// proposal are counted and skipped - that needs the automation facts in message
// headers, which a metadata pass does not read.
//
// WHAT IT NEVER DOES. It creates no interaction and changes no contact. Only the
// user's own accept_interaction_candidate call does that, from the review surface.
// Nothing here reads a message body, calls Anthropic, or schedules itself.
//
// INJECTED, NOT IMPORTED: the RPC caller, the cursor encryptor and the clock. That is
// what makes a run drivable against a real local Postgres with fixture Graph responses
// and no Microsoft, and it keeps key handling out of this file - `encryptCursor` is
// handed in already bound to a key.

import {
  GRAPH_FOLDERS, MAX_RETRIES, REQUEST_TIMEOUT_MS, MAX_TOTAL_RETRY_DELAY_MS,
} from './outlookGraphTransport.js'
import { TOKEN_TIMEOUT_MS } from './microsoftTokenExchange.js'
import {
  MAX_CONTACTS_LOADED, CONTACT_PAGE_SIZE, CONTEXT_STEP_MS,
} from './outlookRunContext.js'
import { localDateFor } from './outlookMetadataPass.js'
import {
  INVOCATION_BUDGET_MS, CHECKPOINT_RESERVE_MS, runOutlookRoundSlice,
} from './outlookContinuedPass.js'
import {
  ROUND_TTL_SECONDS, finalizeConversation, summarizeRoundProgress,
} from './outlookRoundState.js'
import { checkPilotUser, designatedPilotUser } from './outlookPilotGate.js'

/**
 * Lease length and due interval for one run. Bounded by the RPC's own checks, which
 * cap p_lease_seconds at 600.
 *
 * WHY RENEWAL IS REQUIRED, NOT OPTIONAL - measured from the transport's own bounds,
 * not guessed: MAX_PAGES_PER_RUN is 20, and one page request can take
 * (MAX_RETRIES + 1) * REQUEST_TIMEOUT_MS + MAX_TOTAL_RETRY_DELAY_MS =
 * 4 * 20s + 60s = 140s in the worst case. Twenty of those is 2800s, which no lease
 * the RPC will grant can cover - the ceiling is 600s. So a long run must renew or
 * lose its claim while still reading, and another run could then start on the same
 * connection.
 */
/**
 * One bounded database call. Mirrors the worker port's own deadline (endpoints.js
 * DB_TIMEOUT_MS); a test pins the two together so they cannot drift apart.
 */
export const RPC_ROUND_TRIP_MS = 15_000

/**
 * Lease length and due interval. Both are bounded by the reservation RPC, which caps
 * p_lease_seconds at 600.
 *
 * WHY 420 AND NOT 300. A fresh reservation must STRICTLY cover the longest stage that
 * follows it, which is loading the run context at CONTEXT_WORST_MS. And the lease the
 * worker can actually rely on is shorter than the number it asked for: the database
 * starts the lease when the RPC runs, not when its response arrives, so up to one round
 * trip is already gone. 300 - 15 = 285 did not strictly cover a 285s context path, and
 * a 300s renewal would not have either - the guard would have renewed forever without
 * ever clearing the margin. 420 - 15 = 405 clears every margin with room to spare.
 */
export const LEASE_SECONDS = 420
export const RENEW_SECONDS = 420
export const DUE_AFTER_SECONDS = 900

/**
 * RENEWAL IS TIME-BASED, NOT PAGE-COUNTED, and this is the correction that matters.
 *
 * The previous schedule renewed after every two NON-FINAL pages, which failed twice
 * over. A folder whose stream ended on its first page never fired the hook at all, so a
 * run with one final page per folder renewed ZERO times; and the count ignored the time
 * spent loading context and writing candidates, so the one renewal a longer run did
 * attempt arrived after the lease had already died. Both were reproduced: a slow run
 * lost its lease at 300s and had its candidate write refused `stale_run` at 485s, so a
 * run that had done all its work committed nothing.
 *
 * The rule now: BEFORE any stage that could take longer than the lease has left, renew.
 * Each margin below is the worst case for one stage, and each is <= RENEW_SECONDS, which
 * is what makes the scheme sound - a single renewal always covers the stage that follows
 * it. Nothing here is a heartbeat or a scheduler: it is one guard called at four places.
 */

/**
 * One Graph page, worst case, straight from the transport's own bounds:
 * (MAX_RETRIES + 1) attempts at REQUEST_TIMEOUT_MS plus MAX_TOTAL_RETRY_DELAY_MS of
 * honoured backoff = 4 * 20s + 60s.
 */
export const PAGE_WORST_MS = (MAX_RETRIES + 1) * REQUEST_TIMEOUT_MS + MAX_TOTAL_RETRY_DELAY_MS

/**
 * Every database call on the longest path through loadRunContext, counted rather than
 * estimated. An earlier value of 255s was a guess that left out the token refresh and
 * the rotation RPC, and a run whose context took its real worst case then lost its lease
 * mid-load and committed nothing.
 */
export const CONTEXT_DB_CALLS =
  1 +                                                    // the reserved connection
  Math.ceil(MAX_CONTACTS_LOADED / CONTACT_PAGE_SIZE) +   // the paged contact read
  1 +                                                    // the overflow probe
  1 +                                                    // outlook_sync_state (cursors)
  1 +                                                    // microsoft_tokens
  1                                                      // rotate_microsoft_access_token

/**
 * Loading the run context, worst case: every one of those calls at the port's deadline,
 * plus one token refresh at the exchange's own timeout. Derived from the constants so it
 * cannot silently fall behind them - adding a contact page or another read moves it.
 */
export const CONTEXT_WORST_MS = CONTEXT_DB_CALLS * RPC_ROUND_TRIP_MS + TOKEN_TIMEOUT_MS

/** One candidate write: a bounded RPC round trip, plus slack for local work. */
export const WRITE_STEP_MS = RPC_ROUND_TRIP_MS + 5_000

/**
 * Encrypting both cursors and calling release. The encryption is local and sub-second;
 * the release is one bounded RPC. This stage had NO guard before, so a write loop that
 * had topped itself up to just above WRITE_STEP_MS left the release with less lease than
 * it needed: reproduced, the release began with the lease already 6s dead, returned
 * false, and a run with 16 suggestions written advanced no cursor and had to redo
 * everything next time.
 */
export const RELEASE_WORST_MS = RPC_ROUND_TRIP_MS + 5_000

/**
 * One checkpoint or progress RPC, worst case. Same shape as WRITE_STEP_MS: the port's
 * own deadline plus slack for the local fold that precedes it.
 */
export const PROGRESS_STEP_MS = RPC_ROUND_TRIP_MS + 5_000

/**
 * What the FINALISATION stage must keep in hand before starting one more suggestion:
 * the write itself, the call that records how far it got, and the release.
 *
 * WHY THIS EXISTS. The write loop used to run with no reference to the invocation budget
 * at all. Reproduced: 40 qualifying conversations at one bounded RPC each spent 800s
 * against a 120s budget; with the platform stopping the instance after six, six valid
 * pending suggestions existed, the round was still saved, both cursors were correctly
 * NULL - and because nothing recorded those six, the next invocation re-listed all 40 and
 * began again at the first entry. A batch larger than one invocation could never finish.
 */
export const WRITE_STEP_RESERVE_MS = WRITE_STEP_MS + PROGRESS_STEP_MS + RELEASE_WORST_MS

/**
 * What reading the accumulator back and finalising at least one suggestion needs: the
 * list call plus one write's reserve. Below this the invocation stops before listing,
 * rather than listing and then being unable to act on it.
 */
export const FINALIZE_RESERVE_MS = PROGRESS_STEP_MS + WRITE_STEP_RESERVE_MS

/**
 * What the FINALISATION stage must keep in hand before starting one more suggestion:
 * the write itself, the call that records how far it got, and the release.
 *
 * WHY THIS EXISTS. The write loop used to run with no reference to the invocation budget
 * at all. Reproduced: 40 qualifying conversations at one bounded RPC each spent 800s
 * against a 120s budget; with the platform stopping the instance after six, six valid
 * pending suggestions existed, the round was still saved, both cursors were correctly
 * NULL - and because nothing recorded those six, the next invocation re-listed all 40 and
 * began again at the first entry. A batch larger than one invocation could never finish.
 */
/** Backoff requested when a run releases incomplete. */
export const RETRY_BACKOFF_SECONDS = 300

/**
 * Backoff when a run stopped only because its INVOCATION budget ran out. Shorter than
 * RETRY_BACKOFF_SECONDS on purpose: the round is healthy and half-read, and the sooner
 * something calls the worker again the sooner it finishes. Nothing here calls it - there
 * is still no scheduler - this only stops the connection being marked not-due for five
 * minutes when it has work waiting.
 */
export const CONTINUE_BACKOFF_SECONDS = 15

/**
 * How many of a round's conversation records are read back AT A TIME.
 *
 * NOT the round ceiling, which is what this used to be. A record serialises to about 602
 * bytes at its widest realistic shape - every fingerprint present and a lookup array
 * carrying two keys, as a key rotation in flight would - so the 2000-record round ceiling
 * is about 1.18 MiB in ONE response. The worker's own database port refuses any JSON
 * response over MAX_PROVIDER_BODY_BYTES (256 KiB), so the read-back failed outright on a
 * large round: measured and reproduced through the deployed port against 2000 real rows.
 *
 * 200 records measures 118 KiB - under half the bound, with room for a longer lookup
 * array or a wider contact id. The round ceiling of MAX_CONVERSATIONS_PER_ROUND is
 * unchanged and still enforced in record_outlook_page_progress; this is only how many
 * are carried at once, and `more_rows` means CONTINUE rather than `incomplete`.
 */
export const CONVERSATION_PAGE_SIZE = 200

/** Every outcome a run can report. Controlled; safe to log. */
export const RUN_OUTCOMES = Object.freeze([
  'none_due',            // nothing was due; no lease taken
  // COMMITTED means the release RPC itself CONFIRMED success. It is the only outcome
  // that may claim a cursor advanced.
  'committed',
  // The invocation budget ran out (or a per-invocation cap was reached) part-way through
  // a healthy round. Progress IS saved and fenced to the run that saved it; no cursor is
  // advanced and no suggestion is written. The next invocation resumes from here. This is
  // a SUCCESSFUL outcome, not a failure - it is the point of the whole slice.
  'continued',
  // The invocation budget ran out BEFORE any durable progress was possible - no page
  // checkpointed, no suggestion written, no write cursor advanced. Distinct from
  // 'continued' on purpose: 'continued' means the round moved forward and the next
  // invocation will carry on, while this means the invocation could do nothing and the
  // next one may well do nothing either. That is a no-progress loop an operator has to
  // see, so it is NOT a 200.
  'budget_exhausted',
  // A SAVED @odata.nextLink was rejected by Microsoft. The round's saved position and
  // accumulators are discarded; the COMMITTED cursor is untouched, so the next round
  // restarts from the last position that genuinely was ingested.
  'restart_required',
  'incomplete',          // the round dropped or did not finish work; nothing committed
  'write_failed',        // a candidate write was REFUSED with a controlled code
  'write_error',         // a write or the cursor encryption THREW; error release
  // Every intended write succeeded, but the release did not confirm - it returned
  // false, errored, or threw. The cursor state is therefore UNKNOWN and must not be
  // reported as advanced. The next run re-reads the same mail and the fingerprint
  // dedupe makes that idempotent.
  'release_failed',
  'reserve_failed',      // the reservation RPC itself failed
  // The run lost its lease mid-pass: a renewal returned false, meaning another run
  // owns the connection now. Nothing is committed and no cursor is claimed.
  'lease_lost',
  'released_error',      // the pass threw; the lease was released as an error
  // The reserved connection does not belong to the designated pilot account. Nothing
  // is read, written or advanced. See outlookPilotGate.js for why the reservation
  // cannot enforce this itself: it picks whichever connection is DUE, for any user.
  'not_in_pilot',
])

/**
 * Why a COMPLETE round still may not advance a cursor. Controlled; safe to log.
 *
 * Every one of these means work was dropped, shortened or could not be read back, and in
 * each case a cursor would be claiming "everything before this is ingested" when it is not.
 */
export const ROUND_INCOMPLETE_REASONS = Object.freeze([
  'folder_incomplete',        // a folder never reached its deltaLink and cannot continue
  'messages_dropped',         // a page was truncated
  'conversations_dropped',    // the per-round conversation ceiling discarded threads
  // A thread exceeded the bound a suggestion may rest on, so the round saw only part of
  // an exchange. Decided from a WHOLE-ROUND aggregate, not from the page in hand: a
  // tainted conversation on an earlier finalisation page must still stop a commit the
  // run reaches several pages later.
  'episode_truncated',
  // `plan_truncated` is gone on purpose. It used to mean `the read-back was cut short, so
  // rows may exist that were never looked at`. The read-back is now PAGED, and a page
  // saying more rows remain means continue - the run only commits once a page comes back
  // with none left, which is a stronger guarantee than the old one.
  'accumulator_unreadable',   // the round's own conversation records could not be read
  // The round's single deadline passed. It and its conversation records are discarded as
  // one unit and a new round starts from the COMMITTED cursor, which has not moved - so
  // this costs re-reading pages, and skips nothing.
  'round_expired',
  // The two folders staged their cursors under DIFFERENT key versions, which release
  // cannot record - it takes one version for both. Re-reading the round is cheaper than
  // storing a cursor that will not decrypt later.
  'pending_key_mismatch',
])

/** Why a plan entry produced no suggestion. Controlled; safe to log. */
export const ENTRY_SKIP_CODES = Object.freeze([
  'new_contact_not_supported',   // out of this slice: needs the header/content pass
  'missing_contact',             // defensive: an entry claiming a contact without one
])

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The write results that mean "the suggestion is present and pending, or deliberately
 * not resurrected". Each is a SUCCESSFUL outcome for the run: none of them leaves work
 * unpersisted, so none of them should block the cursor.
 *
 *   created         a new pending suggestion
 *   refreshed       an existing pending suggestion, dates updated in place
 *   exists_terminal a tombstone: the user already accepted or dismissed this exchange,
 *                   and it must never be suggested again
 */
export const WRITE_OK = Object.freeze(['created', 'refreshed', 'exists_terminal'])

/**
 * Did release_outlook_sync_lease actually succeed?
 *
 * It RETURNS boolean, and it returns FALSE without raising when the run id is null or
 * no row matched - which is exactly the case where the lease was lost to another run.
 * An earlier version here treated "no transport error" as success and reported
 * `committed` with cursors advanced even when the function had answered false. So
 * success is the narrow reading: no error, and the payload is literally true.
 */
export function releaseConfirmed (res) {
  return !res?.error && res?.data === true
}

/** True when a candidate-write result means the run may still commit. */
export function writeAccepted (result) {
  return WRITE_OK.includes(result)
}

/**
 * Which plan entries this slice can persist, and why the rest cannot.
 * Pure, so the decision is testable without a database.
 */
export function partitionPlan (plan) {
  const writable = []
  const skipped = Object.create(null)
  const bump = (c) => { skipped[c] = (skipped[c] || 0) + 1 }
  for (const e of Array.isArray(plan) ? plan : []) {
    if (e?.kind === 'new_contact_suggestion') { bump('new_contact_not_supported'); continue }
    if (typeof e?.contactId !== 'string' || e.contactId.length === 0) { bump('missing_contact'); continue }
    writable.push(e)
  }
  return { writable, skipped }
}

/**
 * One run.
 *
 * @param {object} p
 * @param {(name: string, args: object) => Promise<{data: any, error: any}>} p.rpc
 *        calls a Postgres function AS THE SERVICE ROLE. The three it may call are
 *        reserve_due_outlook_connection, upsert_outlook_interaction_candidate and
 *        release_outlook_sync_lease - nothing else.
 * @param {(deltaLink: string) => Promise<{ciphertext: string, nonce: string, keyVersion: number}>} p.encryptCursor
 *        already bound to a key; this module never sees key material.
 * @param {(connectionId: string) => Promise<{primaryEmail: string, aliases?: string[],
 *          timeZone?: string, userId: string, contacts: Array, cursors: object,
 *          accessToken: string, keyRing: object}>} p.loadRunContext
 *        everything the pass needs for ONE connection. Supplied by the caller so this
 *        module performs no query of its own and cannot widen its own scope.
 * @param {(ct: string, nonce: string) => Promise<string>} p.decryptCursor
 *        already bound to a key. Needed only for a SAVED @odata.nextLink: a pending
 *        deltaLink never has to be decrypted, because release takes ciphertext and the
 *        ciphertext is already in the row.
 * @param {number} [p.requestEntryMs] the clock at HANDLER ENTRY. The invocation budget is
 *        measured from here, not from the reservation, because the platform's 150s idle
 *        timeout and wall clock started before this module was reached. Omitted in tests
 *        that do not exercise the budget, in which case no invocation deadline applies.
 * @param {string} p.pilotUserId  the designated pilot account, from the function
 *        environment (OUTLOOK_PILOT_USER_ID). A reserved connection belonging to anyone
 *        else is released untouched. Absent or malformed means NOBODY is importable:
 *        the gate fails closed, by design.
 * @param {object} p.deps  passed through to the round slice (fetchImpl, etc.)
 */
export async function runOutlookImport (p) {
  const {
    rpc, encryptCursor, decryptCursor, loadRunContext, requestEntryMs, pilotUserId, deps,
  } = p || {}
  if (typeof rpc !== 'function') throw new Error('rpc_not_injected')
  if (typeof encryptCursor !== 'function') throw new Error('encrypt_cursor_not_injected')
  if (typeof decryptCursor !== 'function') throw new Error('decrypt_cursor_not_injected')
  if (typeof loadRunContext !== 'function') throw new Error('load_run_context_not_injected')

  // ── 1. reserve ─────────────────────────────────────────────────────────────
  // The clock is read BEFORE the call, because the database starts the lease when the
  // RPC runs - not when its response gets back here. Anchoring the deadline to the
  // response would overstate what is left by a whole round trip, which is exactly how a
  // run with a 285s context path lost a 300s lease it believed ran to 315s.
  const clock = typeof deps?.now === 'function' ? deps.now : Date.now

  // ── THE PILOT GATE, PART 1: before a single RPC ──────────────────────────
  // A missing or malformed designation refuses here, with NOTHING reserved and no
  // database call made at all. It also has to happen before the reservation because
  // the designation is about to be passed to it as a uuid: 'true' or '*' would not
  // narrow the selection, it would make the call fail on a cast.
  const designated = designatedPilotUser(pilotUserId)
  if (designated === null) {
    return {
      outcome: 'not_in_pilot',
      reason: 'pilot_not_configured',
      intended: 0,
      accepted: 0,
      created: 0,
      cursorsAdvanced: 0,
    }
  }

  const reserveStartedMs = clock()
  // ── THE PILOT GATE, PART 2: the reservation itself is narrowed ───────────
  // Without p_pilot_user_id the reservation takes whichever connection is DUE, for
  // ANY user - and then the run could only discover whose it was after loading the
  // context, which refreshes an expired token at Microsoft and persists the rotation.
  // Narrowing it here is what makes a non-pilot account cost zero provider calls and
  // zero writes, and what stops an excluded connection taking the pilot's turn every
  // time its backoff elapses. See migration 20261003000000.
  const reserved = await rpc('reserve_due_outlook_connection', {
    p_lease_seconds: LEASE_SECONDS,
    p_due_after_seconds: DUE_AFTER_SECONDS,
    p_pilot_user_id: designated,
  })
  if (reserved?.error || !isPlainObject(reserved?.data)) {
    return { outcome: 'reserve_failed' }
  }
  if (reserved.data.result === 'none_due') return { outcome: 'none_due' }
  if (reserved.data.result !== 'reserved') return { outcome: 'reserve_failed' }

  const connectionId = reserved.data.connection_id
  const runId = reserved.data.run_id

  // A release that THROWS must not take the run's reporting with it: the outcome is
  // then simply unknown, which is what 'release_failed' says.
  const release = async (status, complete, cursors, errorCode, backoffSeconds) => {
    try {
      return await rpc('release_outlook_sync_lease', {
        p_connection_id: connectionId,
        p_run_id: runId,
        p_status: status,
        p_error_code: errorCode ?? null,
        p_run_complete: complete,
        p_inbox_delta_ct: cursors?.inbox?.ciphertext ?? null,
        p_inbox_delta_nonce: cursors?.inbox?.nonce ?? null,
        p_sentitems_delta_ct: cursors?.sentitems?.ciphertext ?? null,
        p_sentitems_delta_nonce: cursors?.sentitems?.nonce ?? null,
        p_delta_key_version: cursors?.inbox?.keyVersion ?? cursors?.sentitems?.keyVersion ?? null,
        p_initial_done: complete,
        p_retry_backoff_seconds: complete
          ? null
          : (Number.isInteger(backoffSeconds) ? backoffSeconds : RETRY_BACKOFF_SECONDS),
      })
    } catch {
      return { data: null, error: { code: 'release_threw' } }
    }
  }

  // ── THE PILOT GATE, PART 3: verify what was handed back ──────────────────
  // Part 2 narrowed the reservation, so this should be unreachable. It is kept
  // because it is cheap and because it does not take the reservation's word for the
  // narrowing: a function that accepted p_pilot_user_id and ignored it, or an older
  // one that does not report user_id at all, would otherwise go unnoticed. Still
  // BEFORE loadRunContext, so a wrong answer costs no token refresh and no rotation.
  const reservedOwner = checkPilotUser(designated, reserved.data.user_id)
  if (!reservedOwner.ok) {
    await release('idle', false, null, reservedOwner.reason, RETRY_BACKOFF_SECONDS)
    return {
      outcome: 'not_in_pilot',
      reason: reservedOwner.reason,
      connectionId,
      intended: 0,
      accepted: 0,
      created: 0,
      cursorsAdvanced: 0,
    }
  }

  // ── the lease guard ───────────────────────────────────────────────────────
  // Anchored to when the reservation RAN, not to when it answered.
  let leaseUntilMs = reserveStartedMs + LEASE_SECONDS * 1000
  let leaseLost = false

  /**
   * Make sure at least `marginMs` of lease remains before starting the next stage,
   * renewing if it does not. A no-op when there is plenty of time left, so the common
   * case costs nothing.
   *
   * A renewal that does not confirm means another run owns the connection now, so this
   * throws and the caller stops without advancing either cursor.
   */
  const ensureLease = async (marginMs) => {
    // STRICTLY greater, not >=. With exactly `marginMs` left, a stage costing its whole
    // worst case finishes at the instant the lease expires, and the NEXT renewal then
    // arrives too late to be granted. A test caught that: a write loop refused its
    // renewal at remaining = 0 and lost a run that should have committed.
    if (leaseUntilMs - clock() > marginMs) return
    // Same anchoring as the reservation: the renewed lease starts when the RPC runs.
    const renewStartedMs = clock()
    let res
    try {
      res = await rpc('renew_outlook_sync_lease', {
        p_connection_id: connectionId,
        p_run_id: runId,
        p_lease_seconds: RENEW_SECONDS,
      })
    } catch {
      res = { data: null, error: { code: 'renew_threw' } }
    }
    // renew_outlook_sync_lease returns true only when BOTH folder rows were renewed.
    if (res?.error || res?.data !== true) {
      leaseLost = true
      throw new Error('lease_lost')
    }
    leaseUntilMs = renewStartedMs + RENEW_SECONDS * 1000
  }

  // Fired for every page, including a final one. Renews only when the lease could not
  // survive another worst-case page.
  const onPageComplete = () => ensureLease(PAGE_WORST_MS)

  // ── the INVOCATION deadline ────────────────────────────────────────────────
  // A SECOND, INDEPENDENT deadline, and the reason this slice exists. The lease deadline
  // above protects the connection from a second run; this one protects the run from the
  // platform, whose request idle timeout (150s) and wall clock started before this module
  // was reached. Anchored to handler entry for exactly that reason. When no entry time is
  // supplied there is no invocation deadline - the lease guard still applies.
  const invocationDeadlineMs = Number.isFinite(requestEntryMs)
    ? requestEntryMs + INVOCATION_BUDGET_MS
    : Number.POSITIVE_INFINITY

  /** Will `marginMs` of invocation budget still be there when this stage starts? */
  const budgetAllows = (marginMs) => invocationDeadlineMs - clock() > marginMs

  /**
   * Did THIS invocation move the round forward in a way that survives it?
   *
   * The distinction matters for one reason: an invocation that saved progress can
   * honestly say 'continued', while one that saved nothing may be in a loop that never
   * finishes, and must say so instead. Set by a committed page checkpoint, by a confirmed
   * suggestion write, and by advancing the finalisation write cursor.
   */
  let durableProgress = false

  let slice
  let context
  let roundId = null
  let progress = null
  // Whether THIS invocation found an expired round and threw it away. Reported, because
  // a round being discarded costs re-reading and a reader should be able to see it.
  let roundExpired = false
  let roundReset = null
  try {
    // Loading the context can take most of a lease on its own: a paged contact read
    // plus a token refresh. Renew first if what remains would not cover it.
    await ensureLease(CONTEXT_WORST_MS)
    // THE INVOCATION BUDGET, not just the lease. Loading the context is the longest stage
    // of a run (CONTEXT_WORST_MS = 285s) and it used to run with no reference to the
    // hosted limit at all - reproduced: a 200s load against a 120s budget answered 200
    // 'continued' having read no mail and saved no checkpoint, and on the real platform
    // was killed at 150s mid-load with the lease still held. If there is not even enough
    // budget to load and release, do not start.
    if (!budgetAllows(CONTEXT_STEP_MS + RELEASE_WORST_MS)) {
      await release('idle', false, null, 'context_budget_exhausted', CONTINUE_BACKOFF_SECONDS)
      return {
        outcome: 'budget_exhausted',
        reason: 'context_budget_exhausted',
        connectionId,
        intended: 0,
        accepted: 0,
        created: 0,
        cursorsAdvanced: 0,
      }
    }
    // The loader checks the same deadline between its own bounded steps, so a load that
    // cannot finish stops at a step boundary and gives the lease back instead of being
    // killed. It does NOT make the load resumable - see the enablement blocker in
    // docs/outlook-durable-continuation-design.md.
    context = await loadRunContext(connectionId, runId, {
      deadlineMs: invocationDeadlineMs,
      now: clock,
    })

    // ── THE PILOT GATE, PART 4: the last backstop ────────────────────────────
    // Parts 1-3 already decided this, and they ran before any token refresh or write.
    // This one differs in WHERE it gets the owner: from microsoft_connections itself,
    // via the context load, rather than from the reservation's own answer. It is the
    // only check that does not depend on that RPC being truthful.
    //
    // It is NOT the enforcement point. Reaching it with a non-pilot connection would
    // mean parts 2 and 3 both failed, and by then the load has already refreshed an
    // expired token at Microsoft - which is exactly the defect this ordering fixed.
    const pilot = checkPilotUser(designated, context.userId)
    if (!pilot.ok) {
      await release('idle', false, null, pilot.reason, RETRY_BACKOFF_SECONDS)
      return {
        outcome: 'not_in_pilot',
        reason: pilot.reason,
        connectionId,
        intended: 0,
        accepted: 0,
        created: 0,
        cursorsAdvanced: 0,
      }
    }

    // ── where did the last invocation get to? ────────────────────────────────
    await ensureLease(PROGRESS_STEP_MS)
    const progressRes = await rpc('read_outlook_round_progress', {
      p_connection_id: connectionId,
      p_run_id: runId,
    })
    if (progressRes?.error || progressRes?.data?.result !== 'ok') {
      throw Object.assign(new Error('progress_unreadable'), { reason: 'progress_unreadable' })
    }
    progress = progressRes.data.folders ?? {}

    // ── an EXPIRED round is discarded, not resumed ──────────────────────────
    // The read reports expiry honestly rather than as `no round`, because pretending
    // there was none is what made this invent a new id that every checkpoint then
    // refused with round_mismatch - forever, while the committed cursor sat untouched and
    // nothing progressed. The checkpoint now discards an expired round as a unit and
    // adopts the new id; resetting first makes that explicit rather than incidental, and
    // means the reason is recorded on the row.
    roundExpired = progressRes.data.round_expired === true
    if (roundExpired) {
      try {
        await ensureLease(PROGRESS_STEP_MS)
        const r = await rpc('reset_outlook_round', {
          p_connection_id: connectionId,
          p_run_id: runId,
          p_reason: 'round_expired',
        })
        roundReset = r?.error ? 'rpc_error' : (r?.data?.result ?? 'unknown')
      } catch {
        roundReset = 'reset_threw'
      }
    }

    // One round id for the whole round, adopted from whatever is already saved. An
    // expired round contributes nothing, so this starts a fresh one - from the COMMITTED
    // cursor, which is still true.
    const savedRoundId = roundExpired
      ? null
      : GRAPH_FOLDERS
        .map((f) => progress?.[f]?.round_id)
        .find((v) => typeof v === 'string' && v.length > 0) ?? null
    roundId = savedRoundId ?? (typeof deps?.newRoundId === 'function'
      ? deps.newRoundId()
      : crypto.randomUUID())

    // Decrypt ONLY the saved nextLinks. A cursor that will not decrypt must not silently
    // become "start this folder over": that would re-read mail and, worse, hide a key
    // problem. It is the same class of failure as an undecryptable committed cursor.
    const resume = {}
    for (const folder of GRAPH_FOLDERS) {
      const f = progress?.[folder] ?? {}
      let nextLink = null
      if (savedRoundId !== null
          && typeof f.next_link_ciphertext === 'string' && f.next_link_ciphertext.length > 0
          && typeof f.next_link_nonce === 'string' && f.next_link_nonce.length > 0) {
        try {
          nextLink = await decryptCursor(f.next_link_ciphertext, f.next_link_nonce)
        } catch {
          throw Object.assign(new Error('cursor_undecryptable'), { reason: 'cursor_undecryptable' })
        }
      }
      resume[folder] = {
        nextLink,
        pageSeq: Number.isInteger(f.page_seq) ? f.page_seq : 0,
        pages: Number.isInteger(f.pages) ? f.pages : 0,
        messages: Number.isInteger(f.messages) ? f.messages : 0,
        messagesDropped: Number.isInteger(f.messages_dropped) ? f.messages_dropped : 0,
        conversationsDropped: Number.isInteger(f.conversations_dropped) ? f.conversations_dropped : 0,
        folderComplete: f.folder_complete === true,
      }
    }

    // ── the per-page checkpoint ──────────────────────────────────────────────
    // The fold and the resume position commit in ONE call, which is what makes a hard
    // platform kill lose at most the page in flight. Microsoft's link is encrypted here
    // and never stored, logged or compared in plaintext.
    const checkpoint = async (c) => {
      await ensureLease(PROGRESS_STEP_MS)
      const link = c.folderComplete ? c.deltaLink : c.nextLink
      const sealed = await encryptCursor(link)
      const res = await rpc('record_outlook_page_progress', {
        p_connection_id: connectionId,
        p_run_id: runId,
        p_folder: c.folder,
        p_round_id: roundId,
        p_page_seq: c.pageSeq,
        p_next_link_ct: c.folderComplete ? null : sealed.ciphertext,
        p_next_link_nonce: c.folderComplete ? null : sealed.nonce,
        p_pending_delta_ct: c.folderComplete ? sealed.ciphertext : null,
        p_pending_delta_nonce: c.folderComplete ? sealed.nonce : null,
        p_key_version: sealed.keyVersion,
        p_folder_complete: c.folderComplete === true,
        p_messages_seen: c.messagesSeen,
        p_messages_dropped: c.messagesDropped ?? 0,
        p_conversations: c.conversations ?? [],
        p_round_ttl_seconds: ROUND_TTL_SECONDS,
      })
      if (res?.error) return { result: 'rpc_error' }
      const out = res?.data ?? { result: 'unknown' }
      if (out.result === 'recorded') durableProgress = true
      return out
    }

    // And again before the first Graph page, because the context load may have consumed
    // most of what was left.
    await ensureLease(PAGE_WORST_MS)
    slice = await runOutlookRoundSlice({
      connection: {
        connectionId,
        primaryEmail: context.primaryEmail,
        aliases: context.aliases,
        timeZone: context.timeZone,
      },
      committedCursors: context.cursors,
      resume,
      accessToken: context.accessToken,
      contacts: context.contacts,
      userId: context.userId,
      keyRing: context.keyRing,
      budget: {
        now: clock,
        deadlineMs: invocationDeadlineMs,
        // Keep enough budget to release the lease and answer the request.
        reserveMs: CHECKPOINT_RESERVE_MS,
      },
      checkpoint,
      deps,
      onPageComplete,
    })
  } catch (e) {
    // The lease must never be left held. A thrown message is deliberately NOT read or
    // forwarded - it can contain a URL or an address. The only thing read is whether
    // the sentinel flag was set, and a controlled reason is derived from the loader's
    // own `reason` field when it has one.
    const contextReason = typeof e?.reason === 'string' ? e.reason : null
    if (leaseLost) {
      await release('error', false, null, 'lease_lost')
      return {
        outcome: 'lease_lost',
        connectionId,
        intended: 0,
        accepted: 0,
        created: 0,
        cursorsAdvanced: 0,
      }
    }
    await release('error', false, null, contextReason ?? 'pass_failed')
    return {
      outcome: 'released_error',
      reason: contextReason,
      connectionId,
      intended: 0,
      accepted: 0,
      created: 0,
      cursorsAdvanced: 0,
    }
  }

  // The only shape of round progress that may be reported or logged: counts, flags and
  // controlled codes. No fingerprint, ciphertext, round id or connection id.
  const roundSummary = summarizeRoundProgress(Object.fromEntries(
    GRAPH_FOLDERS.map((f) => [f, {
      resumed: slice.folders[f].resumed,
      pages: slice.folders[f].roundPages,
      messages: slice.folders[f].roundMessages,
      pageSeq: slice.folders[f].pageSeq,
      folderComplete: slice.folders[f].complete,
      messagesDropped: slice.folders[f].messagesDropped,
      conversationsDropped: slice.folders[f].conversationsDropped,
      hasNextLink: slice.folders[f].complete !== true && slice.folders[f].pageSeq > 0,
      hasPendingDelta: slice.folders[f].complete === true,
    }]),
  ))
  const stops = Object.fromEntries(GRAPH_FOLDERS.map((f) => [f, slice.folders[f].stop]))
  const nothingWritten = {
    connectionId,
    roundExpired,
    roundReset,
    intended: 0,
    accepted: 0,
    created: 0,
    cursorsAdvanced: 0,
    round: roundSummary,
    stops,
  }

  // ── 3a. a SAVED nextLink was rejected: the controlled restart ──────────────
  // The round's saved position is worthless now, but the COMMITTED cursor still marks a
  // position that genuinely was ingested, so it is left exactly as it is. The next round
  // starts from there: nothing is skipped, and the pages this round had read are simply
  // read again - which the suggestion dedupe makes harmless.
  if (slice.cursorRejected?.kind === 'saved_next_link') {
    let reset = 'not_attempted'
    try {
      const r = await rpc('reset_outlook_round', {
        p_connection_id: connectionId,
        p_run_id: runId,
        p_reason: 'next_link_rejected',
      })
      reset = r?.error ? 'rpc_error' : (r?.data?.result ?? 'unknown')
    } catch {
      reset = 'reset_threw'
    }
    roundReset = reset
    await release('idle', false, null, null)
    return {
      ...nothingWritten,
      outcome: 'restart_required',
      reason: 'next_link_rejected',
      roundReset: reset,
    }
  }

  // ── 3b. out of invocation budget, round healthy: stop and say so ───────────
  // Progress is already saved, page by page, fenced to this run. NOTHING is committed and
  // no suggestion is written from a partial view.
  if (slice.roundComplete !== true && slice.continuable === true) {
    await release('idle', false, null, null, CONTINUE_BACKOFF_SECONDS)
    return { ...nothingWritten, outcome: 'continued' }
  }

  // ── 3c. the round did not finish for a reason that is not "later" ──────────
  if (slice.roundComplete !== true) {
    await release('idle', false, null, null)
    return {
      ...nothingWritten,
      outcome: 'incomplete',
      incompleteReasons: ['folder_incomplete'],
    }
  }

  // ── 3d. the round IS complete: finalise it, resumably ─────────────────────
  // The suggestions of a finished round are written one bounded RPC at a time, in
  // conversation-fingerprint order, and the round remembers how far that got. Without
  // that memory a batch bigger than one invocation restarts from its first entry every
  // time and never finishes - reproduced: a hard stop after 6 of 40 writes left 6 valid
  // pending suggestions, the round saved, both cursors correctly NULL, and the next
  // invocation beginning the same 40 again.
  if (!budgetAllows(FINALIZE_RESERVE_MS)) {
    // Not enough budget to list the accumulator AND act on even one row. The round is
    // untouched and still complete, so a later invocation finalises it.
    await release('idle', false, null, null, CONTINUE_BACKOFF_SECONDS)
    return {
      ...nothingWritten,
      outcome: durableProgress ? 'continued' : 'budget_exhausted',
      reason: durableProgress ? null : 'finalize_budget_exhausted',
    }
  }

  // Where finalisation left off WITHIN THE ROUND. NULL means none of it is done yet.
  const writeCursorBefore = GRAPH_FOLDERS
    .map((f) => progress?.[f]?.write_cursor)
    .find((v) => typeof v === 'string' && v.length > 0) ?? null

  const results = Object.create(null)
  const skipped = Object.create(null)
  const bumpSkip = (c) => { skipped[c] = (skipped[c] || 0) + 1 }
  // Counted honestly. A later failure does not erase the fact that earlier writes
  // landed, and reporting zero while rows exist would send a reader looking for a bug
  // in the wrong place.
  let accepted = 0
  let intended = 0
  let firstRefusal = null
  let threw = false
  let outOfBudget = false
  let listFailed = false
  // The last conversation DEALT WITH - written, or deliberately skipped. A skip is a
  // decision, not unfinished work, so the cursor may pass it.
  let processedThrough = null
  let rowsListed = 0
  let rowsProcessed = 0
  let pagesRead = 0
  let moreRows = false
  let roundTruncatedEpisodes = 0
  // The round's deadline passed while this run was working on it. Nothing of it may be
  // committed: its records are about to be discarded as a unit, so a cursor would be
  // claiming mail that no longer has a suggestion behind it.
  let roundDiedMidRun = false

  // ── the commit gate, for the whole ROUND ──────────────────────────────────
  // A delta cursor claims everything before it was INGESTED, so any dropped or shortened
  // work forfeits every cursor of the round - including the case where Inbox finished
  // cleanly and Sent Items did not, because a conversation can span both folders. These
  // two are known from the folder counters before anything is listed.
  const incompleteReasons = []
  if (slice.totals.messagesDropped > 0) incompleteReasons.push('messages_dropped')
  if (slice.totals.conversationsDropped > 0) incompleteReasons.push('conversations_dropped')

  try {
    let cursor = writeCursorBefore
    for (;;) {
      // Enough budget to list a page AND act on at least one row of it, or stop.
      if (!budgetAllows(FINALIZE_RESERVE_MS)) { outOfBudget = true; break }

      await ensureLease(PROGRESS_STEP_MS)
      const listed = await rpc('list_outlook_round_conversations', {
        p_connection_id: connectionId,
        p_run_id: runId,
        p_round_id: roundId,
        // ONE PAGE. The whole round in one response is about 1.18 MiB against a 256 KiB
        // port bound, which is the whole reason this is paged.
        p_limit: CONVERSATION_PAGE_SIZE,
        // RESUME POINT: only conversations after the ones already dealt with, in the same
        // fingerprint order the write cursor is kept in.
        p_after: cursor,
      })
      if (listed?.data?.result === 'round_expired') { roundDiedMidRun = true; break }
      if (listed?.error || listed?.data?.result !== 'ok') { listFailed = true; break }
      pagesRead += 1
      moreRows = listed.data.more_rows === true
      const rows = Array.isArray(listed.data.conversations) ? listed.data.conversations : []
      rowsListed += rows.length

      // THE WHOLE-ROUND TRUNCATION CHECK, and it must be whole-round. A conversation
      // whose exchange exceeded MAX_EPISODE_MESSAGES was shortened, so a suggestion from
      // it would rest on a partial view and no cursor from this round may be stored. The
      // database answers for the ENTIRE round on every page, so a tainted row on page one
      // still blocks a commit the run reaches on page five - which is precisely the
      // regression this replaced: per-row finalisation skipped the tainted conversation
      // and then committed both cursors past the work it had discarded.
      const t = listed.data.round_truncated_episodes
      if (Number.isInteger(t) && t > roundTruncatedEpisodes) roundTruncatedEpisodes = t
      if (roundTruncatedEpisodes > 0 && !incompleteReasons.includes('episode_truncated')) {
        incompleteReasons.push('episode_truncated')
      }
      // A round that cannot commit writes NOTHING, so this is checked before any write.
      if (incompleteReasons.length > 0) break

      // ── decide every row of the page FIRST, then write ────────────────────
      // Deciding is pure and cheap; writing is a bounded round trip each. Separating them
      // keeps `intended` meaning what it has always meant - how many writes are needed -
      // even when the budget stops the writing part-way. Without the pre-pass it would
      // silently become `how many we got round to`, which `accepted` already reports.
      const decisions = []
      for (const row of rows) {
        const one = finalizeConversation(row, (iso) => localDateFor(iso, context.timeZone))
        const cfp = typeof row?.cfp === 'string' ? row.cfp : null
        if (one.entry === null) {
          bumpSkip(one.skip)
          decisions.push({ cfp, entry: null })
          continue
        }
        const { writable, skipped: entrySkipped } = partitionPlan([one.entry])
        for (const [code, n] of Object.entries(entrySkipped)) {
          skipped[code] = (skipped[code] || 0) + n
        }
        decisions.push({ cfp, entry: writable[0] ?? null })
      }
      intended += decisions.filter((x) => x.entry !== null).length

      for (const { cfp, entry } of decisions) {
        if (entry === null) {
          // Skipped on purpose - a one-sided or unsupported conversation. A skip is a
          // decision, not unfinished work, so finalisation may pass it.
          rowsProcessed += 1
          if (cfp !== null) processedThrough = cfp
          continue
        }

        // THE INVOCATION BUDGET, before each write rather than once before the loop.
        // Enough must remain for the write, for recording that it happened, and for the
        // release - otherwise stop here and let a later invocation carry on.
        if (!budgetAllows(WRITE_STEP_RESERVE_MS)) { outOfBudget = true; break }
        // And the LEASE, which is a different deadline: a round's worth of round trips can
        // outlast any lease, and a write refused `stale_run` halfway through would throw
        // away a run that had otherwise succeeded.
        await ensureLease(WRITE_STEP_MS)

        const res = await rpc('upsert_outlook_interaction_candidate', {
          p_connection_id: connectionId,
          p_run_id: runId,
          p_contact_id: entry.contactId,
          p_episode_fingerprint: entry.episodeFingerprint,
          p_person_fingerprint: entry.personFingerprint,
          p_key_version: entry.keyVersion,
          p_proposed_type: entry.proposedType,
          p_proposed_date: entry.proposedDate,
          p_lookup_fingerprints: entry.episodeLookupFingerprints?.length
            ? entry.episodeLookupFingerprints
            : null,
        })
        const code = res?.error ? 'rpc_error' : (res?.data?.result ?? 'unknown')
        results[code] = (results[code] || 0) + 1
        if (writeAccepted(code)) {
          accepted += 1
          rowsProcessed += 1
          if (cfp !== null) processedThrough = cfp
          continue
        }
        if (firstRefusal === null) firstRefusal = code
        // Stop at the first refusal, and do NOT pass it: the cursor is already forfeit,
        // and the next attempt must retry this conversation rather than skip it.
        break
      }

      if (outOfBudget || firstRefusal !== null) break
      if (!moreRows || rows.length === 0) break
      // Carry on from the last conversation dealt with, which is where the write cursor
      // will be recorded too.
      cursor = processedThrough ?? cursor
    }
  } catch {
    // A renewal refusal inside the loop sets leaseLost; anything else is a thrown write.
    threw = true
  }

  if (roundDiedMidRun) {
    // The next invocation discards it and starts again from the committed cursor, which
    // has not moved. Whatever suggestions landed stay - they are valid pending rows, and
    // the dedupe makes the re-read harmless.
    await release('idle', false, null, 'round_expired', CONTINUE_BACKOFF_SECONDS)
    return {
      ...nothingWritten,
      outcome: 'incomplete',
      incompleteReasons: ['round_expired'],
      roundReset,
    }
  }

  if (listFailed) {
    await release('idle', false, null, 'progress_unreadable')
    return {
      ...nothingWritten,
      outcome: 'incomplete',
      incompleteReasons: ['accumulator_unreadable'],
    }
  }
  // Record how far finalisation got, while the lease is still held. Doing this once per
  // invocation rather than once per write keeps the round trips down; the cost of a hard
  // stop before it lands is re-writing rows that are already there, which the candidate
  // upsert answers 'refreshed' - bounded rework, never a lost or duplicated suggestion.
  let writeCursorAdvanced = false
  if (processedThrough !== null && processedThrough !== writeCursorBefore) {
    try {
      await ensureLease(PROGRESS_STEP_MS)
      const adv = await rpc('advance_outlook_round_write_cursor', {
        p_connection_id: connectionId,
        p_run_id: runId,
        p_round_id: roundId,
        p_after: processedThrough,
      })
      writeCursorAdvanced = !adv?.error && adv?.data?.result === 'advanced'
      if (writeCursorAdvanced) durableProgress = true
    } catch {
      // The lease went, or the call failed. Nothing is lost: the suggestions that landed
      // are valid, and the next invocation re-walks from the last recorded point.
      writeCursorAdvanced = false
    }
  }
  if (accepted > 0) durableProgress = true

  // EVERY intended write must be confirmed before a cursor may move, AND the round must be
  // exhausted. Three separate ways it might not be: a page said more rows remain, a row of
  // the page in hand was never processed, or the listing itself failed. Any of them means
  // there is more of this round to finalise, so no cursor moves.
  const batchComplete = !moreRows
    && !listFailed
    && !outOfBudget
    && rowsProcessed === rowsListed
  const partial = {
    connectionId,
    intended,
    accepted,
    created: results.created ?? 0,
    writeResults: results,
    skipped,
    cursorsAdvanced: 0,
    round: roundSummary,
    stops,
    roundExpired,
    roundReset,
    // How much of the round's finalisation is done, as counts only.
    finalize: {
      pages: pagesRead,
      rows: rowsListed,
      processed: rowsProcessed,
      more_rows: moreRows,
      resumed: writeCursorBefore !== null,
      cursor_advanced: writeCursorAdvanced,
      complete: batchComplete,
    },
  }

  // ── the round did not finish for a reason that forfeits every cursor ──────
  // Checked here rather than before the loop so the reasons are reported alongside
  // whatever finalisation managed to do. No write was attempted when this is non-empty.
  if (incompleteReasons.length > 0) {
    await release('idle', false, null, null)
    return { ...partial, outcome: 'incomplete', incompleteReasons, refusal: null }
  }

  if (leaseLost) {
    // The lease went while writing. Whatever landed stays and is reported; no cursor.
    await release('error', false, null, 'lease_lost')
    return { ...partial, outcome: 'lease_lost', refusal: null }
  }

  if (threw) {
    // Best effort: record the failure on the lease so the connection is not left
    // 'running' until the lease expires. A further failure here is swallowed - there is
    // nothing better to do, and the outcome already says the run did not commit.
    await release('error', false, null, 'write_failed')
    return { ...partial, outcome: 'write_error', refusal: null }
  }

  if (firstRefusal !== null) {
    // Released without a cursor, so the same mail is read again next run and the
    // fingerprint dedupe makes that retry idempotent.
    await release('idle', false, null, null)
    return { ...partial, outcome: 'write_failed', refusal: firstRefusal }
  }

  // ── finalisation ran out of invocation budget part-way ────────────────────
  // The suggestions written so far are valid pending rows, the write cursor records
  // exactly how far the batch got, and NEITHER cursor moves - every intended write must
  // be confirmed before a cursor may claim the mail was ingested. The next invocation
  // continues the batch instead of restarting it.
  if (outOfBudget || !batchComplete) {
    await release('idle', false, null, null, CONTINUE_BACKOFF_SECONDS)
    return {
      ...partial,
      outcome: durableProgress ? 'continued' : 'budget_exhausted',
      reason: durableProgress ? null : 'finalize_budget_exhausted',
      refusal: null,
    }
  }

  // Only now: encrypt and advance the cursors. Encryption can throw (a missing or
  // unusable key). That is the same class of failure as a thrown write: nothing may be
  // committed, and the lease must not be left held.
  //
  // GUARDED, because the write loop only ever guarantees enough lease for the NEXT
  // WRITE. A loop that topped itself up to just above WRITE_STEP_MS used to leave the
  // release short, so a run that had written every suggestion still advanced no cursor.
  try {
    await ensureLease(RELEASE_WORST_MS)
  } catch {
    // The lease went before the release could be attempted. Whatever landed stays and is
    // reported; no cursor is claimed.
    await release('error', false, null, 'lease_lost')
    return { ...partial, outcome: 'lease_lost', refusal: null }
  }

  // THE CURSORS ARE ALREADY CIPHERTEXT. Each folder's @odata.deltaLink was encrypted and
  // staged as a PENDING cursor by the checkpoint that read its final page - possibly in an
  // earlier invocation of this round. So the commit does not decrypt anything and does not
  // re-encrypt anything: it hands release the ciphertext that is already in the row, and
  // release promotes it. One fewer place a plaintext cursor can exist.
  let cursors = {}
  try {
    await ensureLease(PROGRESS_STEP_MS)
    const after = await rpc('read_outlook_round_progress', {
      p_connection_id: connectionId,
      p_run_id: runId,
    })
    if (after?.error || after?.data?.result !== 'ok') {
      await release('idle', false, null, 'progress_unreadable')
      return { ...partial, outcome: 'release_failed', refusal: null }
    }
    const folders = after.data.folders ?? {}
    const versions = new Set()
    for (const folder of GRAPH_FOLDERS) {
      const f = folders[folder] ?? {}
      if (typeof f.pending_delta_ciphertext !== 'string' || f.pending_delta_ciphertext.length === 0
          || typeof f.pending_delta_nonce !== 'string' || f.pending_delta_nonce.length === 0) {
        // A complete round without a staged cursor for one of its folders is a
        // contradiction. Commit nothing rather than commit half a round.
        await release('idle', false, null, 'pending_cursor_missing')
        return { ...partial, outcome: 'release_failed', refusal: null }
      }
      if (Number.isInteger(f.pending_delta_key_version)) versions.add(f.pending_delta_key_version)
      cursors[folder] = {
        ciphertext: f.pending_delta_ciphertext,
        nonce: f.pending_delta_nonce,
        keyVersion: f.pending_delta_key_version,
      }
    }
    // release takes ONE key version for both cursors. If the key rotated mid-round the two
    // ciphertexts disagree, and recording one version for both would make a cursor
    // undecryptable later. Refuse: the round is re-read, which is cheap and correct.
    if (versions.size > 1) {
      cursors = {}
      await release('idle', false, null, 'pending_key_mismatch')
      return {
        ...partial,
        outcome: 'incomplete',
        incompleteReasons: ['pending_key_mismatch'],
        refusal: null,
      }
    }
  } catch {
    if (leaseLost) {
      await release('error', false, null, 'lease_lost')
      return { ...partial, outcome: 'lease_lost', refusal: null }
    }
    await release('error', false, null, 'progress_unreadable')
    return { ...partial, outcome: 'write_error', refusal: null }
  }

  const released = await release('idle', true, cursors, null)
  if (!releaseConfirmed(released)) {
    // Every intended write landed, but the release did not confirm. The cursor state is
    // UNKNOWN, so it is not reported as advanced and this is not 'committed'. The next
    // run re-reads the same mail; the dedupe makes that harmless.
    return { ...partial, outcome: 'release_failed', refusal: null }
  }

  return {
    ...partial,
    outcome: 'committed',
    cursorsAdvanced: Object.keys(cursors).length,
  }
}
/**
 * The ONLY shape of a run result that may be logged.
 *
 * Counts and controlled codes. Never a connection id, contact id, candidate id,
 * fingerprint, address, subject, provider key, cursor value or ciphertext - a
 * fingerprint in particular is a stable per-user identifier for one exchange, so
 * logging it would build a durable record of who someone talks to.
 */
export function summarizeRun (result) {
  if (!isPlainObject(result)) return { outcome: 'released_error' }
  return {
    outcome: RUN_OUTCOMES.includes(result.outcome) ? result.outcome : 'released_error',
    // Three separate numbers, because collapsing them hides a partial failure: how
    // many writes were intended, how many the database accepted, and how many of
    // those were new rows.
    intended: Number.isInteger(result.intended) ? result.intended : 0,
    accepted: Number.isInteger(result.accepted) ? result.accepted : 0,
    created: Number.isInteger(result.created) ? result.created : 0,
    write_results: result.writeResults ?? {},
    entry_skipped: result.skipped ?? {},
    // Filtered to the controlled set, so an unexpected string can never reach a log.
    incomplete_reasons: Array.isArray(result.incompleteReasons)
      ? result.incompleteReasons.filter((r) => ROUND_INCOMPLETE_REASONS.includes(r))
      : [],
    refusal: typeof result.refusal === 'string' ? result.refusal : null,
    // A controlled context-failure reason (config_missing, refresh_failed, ...). Never
    // a provider message.
    reason: typeof result.reason === 'string' ? result.reason : null,
    cursors_advanced: Number.isInteger(result.cursorsAdvanced) ? result.cursorsAdvanced : 0,
    // Per-folder round progress: counts, flags and controlled stop codes only. Never a
    // fingerprint, a ciphertext or a round id. `round` is how a reader distinguishes
    // "nothing to do" from "half-way through a large mailbox, come back".
    round: result.round ?? null,
    stops: result.stops ?? null,
    round_reset: typeof result.roundReset === 'string' ? result.roundReset : null,
    // Whether this invocation threw away an expired round. A reader needs it: a discarded
    // round means the next one re-reads pages from the committed cursor.
    round_expired: result.roundExpired === true,
    // How much of a finished round's finalisation is done. Counts and flags only - never a
    // fingerprint, so the write cursor itself is not reported.
    finalize: result.finalize ?? null,
  }
}
