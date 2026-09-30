// One Outlook import run, end to end: reserve a lease, do the metadata pass, write
// the pending suggestions, then release - advancing the encrypted folder cursors only
// if all of that succeeded.
//
// THE ORDER IS THE CONTRACT, and it is the reason this module exists rather than the
// steps being inlined somewhere:
//
//   0. before EVERY stage below, renew the lease if what remains would not cover that
//      stage's worst case - see PAGE_WORST_MS / CONTEXT_WORST_MS / WRITE_STEP_MS
//   1. reserve_due_outlook_connection          take the lease for both folders
//   2. runOutlookMetadataPass                  envelope only; no body, no Anthropic
//   3. if NOT commitReady -> release WITHOUT cursors, run_complete = false, and write
//      NO candidate at all. A truncated pass has not seen the whole picture, and a
//      suggestion written from a partial view could be wrong while the cursor it
//      travelled with claimed the mail had been fully ingested.
//   4. if commitReady -> upsert_outlook_interaction_candidate for every qualifying
//      entry FIRST, and only if every one of them succeeded, release WITH the
//      encrypted cursors and run_complete = true.
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
//   incomplete       the pass dropped or did not finish work; no write attempted
//   write_failed     a write was REFUSED with a controlled code; released, no cursor
//   write_error      a write or the cursor encryption THREW; best-effort error release
//   release_failed   every intended write landed but the release did not confirm, so
//                    the cursor state is UNKNOWN and is not reported as advanced
//   released_error   the pass itself threw; the lease is released as an error
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
import { runOutlookMetadataPass, summarizePass } from './outlookMetadataPass.js'

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
export const LEASE_SECONDS = 300
export const RENEW_SECONDS = 300
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
 * Loading the run context, worst case: a bounded number of database reads plus at most
 * one token refresh. The contact read is paged, so it is the dominant term -
 * ceil(MAX_CONTACTS_LOADED / CONTACT_PAGE_SIZE) + 1 overflow probe + 3 other reads, each
 * bounded by the port's 15s deadline, plus TOKEN_TIMEOUT_MS for the refresh.
 */
export const CONTEXT_WORST_MS = 255_000

/** One candidate write, worst case: a single bounded RPC round trip. */
export const WRITE_STEP_MS = 20_000

/** Backoff requested when a run releases incomplete. */
export const RETRY_BACKOFF_SECONDS = 300

/** Every outcome a run can report. Controlled; safe to log. */
export const RUN_OUTCOMES = Object.freeze([
  'none_due',            // nothing was due; no lease taken
  // COMMITTED means the release RPC itself CONFIRMED success. It is the only outcome
  // that may claim a cursor advanced.
  'committed',
  'incomplete',          // the pass dropped or did not finish work; nothing committed
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
 * @param {object} p.deps  passed through to the metadata pass (fetchImpl, etc.)
 */
export async function runOutlookImport (p) {
  const { rpc, encryptCursor, loadRunContext, deps } = p || {}
  if (typeof rpc !== 'function') throw new Error('rpc_not_injected')
  if (typeof encryptCursor !== 'function') throw new Error('encrypt_cursor_not_injected')
  if (typeof loadRunContext !== 'function') throw new Error('load_run_context_not_injected')

  // ── 1. reserve ─────────────────────────────────────────────────────────────
  const reserved = await rpc('reserve_due_outlook_connection', {
    p_lease_seconds: LEASE_SECONDS,
    p_due_after_seconds: DUE_AFTER_SECONDS,
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
  const release = async (status, complete, cursors, errorCode) => {
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
        p_retry_backoff_seconds: complete ? null : RETRY_BACKOFF_SECONDS,
      })
    } catch {
      return { data: null, error: { code: 'release_threw' } }
    }
  }

  // ── the lease guard ───────────────────────────────────────────────────────
  // The reservation just granted LEASE_SECONDS, so that is when it runs out. Every
  // renewal moves the deadline; nothing else does.
  const clock = typeof deps?.now === 'function' ? deps.now : Date.now
  let leaseUntilMs = clock() + LEASE_SECONDS * 1000
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
    leaseUntilMs = clock() + RENEW_SECONDS * 1000
  }

  // Fired for every page, including a final one. Renews only when the lease could not
  // survive another worst-case page.
  const onPageComplete = () => ensureLease(PAGE_WORST_MS)

  let pass
  let context
  try {
    // Loading the context can take most of a lease on its own: a paged contact read
    // plus a token refresh. Renew first if what remains would not cover it.
    await ensureLease(CONTEXT_WORST_MS)
    context = await loadRunContext(connectionId, runId)
    // And again before the first Graph page, because the context load may have consumed
    // most of what was left.
    await ensureLease(PAGE_WORST_MS)
    pass = await runOutlookMetadataPass({
      connection: {
        connectionId,
        primaryEmail: context.primaryEmail,
        aliases: context.aliases,
        timeZone: context.timeZone,
      },
      cursors: context.cursors,
      accessToken: context.accessToken,
      contacts: context.contacts,
      userId: context.userId,
      keyRing: context.keyRing,
      deps: { ...deps, onPageComplete },
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

  // 3. An incomplete pass writes NOTHING and advances NOTHING.
  if (pass.commitReady !== true) {
    await release('idle', false, null, null)
    return {
      outcome: 'incomplete',
      connectionId,
      incompleteReasons: pass.incompleteReasons,
      intended: 0,
      accepted: 0,
      created: 0,
      cursorsAdvanced: 0,
      summary: summarizePass(pass),
    }
  }

  // 4. Write the suggestions FIRST.
  const { writable, skipped } = partitionPlan(pass.plan)
  const results = Object.create(null)
  // Counted honestly. A later failure does not erase the fact that earlier writes
  // landed, and reporting zero while rows exist would send a reader looking for a bug
  // in the wrong place.
  let accepted = 0
  let firstRefusal = null
  let threw = false

  try {
    for (const entry of writable) {
      // Before each write, not once before the loop: MAX_PLAN_ENTRIES round trips can
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
      if (writeAccepted(code)) { accepted += 1; continue }
      if (firstRefusal === null) firstRefusal = code
      // Stop at the first refusal. Continuing would pile up work that cannot be
      // committed anyway, because the cursor is already forfeit.
      break
    }
  } catch {
    // A renewal refusal inside the loop sets leaseLost; anything else is a thrown write.
    threw = true
  }

  const partial = {
    connectionId,
    intended: writable.length,
    accepted,
    created: results.created ?? 0,
    writeResults: results,
    skipped,
    cursorsAdvanced: 0,
    summary: summarizePass(pass),
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

  // Only now: encrypt and advance the cursors. Encryption can throw (a missing or
  // unusable key). That is the same class of failure as a thrown write: nothing may be
  // committed, and the lease must not be left held.
  const cursors = {}
  try {
    for (const folder of GRAPH_FOLDERS) {
      const link = pass.cursors?.[folder]
      if (typeof link !== 'string' || link.length === 0) continue
      cursors[folder] = await encryptCursor(link)
    }
  } catch {
    await release('error', false, null, 'cursor_encrypt_failed')
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
    incomplete_reasons: Array.isArray(result.incompleteReasons) ? result.incompleteReasons : [],
    refusal: typeof result.refusal === 'string' ? result.refusal : null,
    // A controlled context-failure reason (config_missing, refresh_failed, ...). Never
    // a provider message.
    reason: typeof result.reason === 'string' ? result.reason : null,
    cursors_advanced: Number.isInteger(result.cursorsAdvanced) ? result.cursorsAdvanced : 0,
    pass: result.summary ?? null,
  }
}
