// One Outlook import run, end to end: reserve a lease, do the metadata pass, write
// the pending suggestions, then release - advancing the encrypted folder cursors only
// if all of that succeeded.
//
// THE ORDER IS THE CONTRACT, and it is the reason this module exists rather than the
// steps being inlined somewhere:
//
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
// dedupe fingerprint makes the retry idempotent.
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

import { GRAPH_FOLDERS } from './outlookGraphTransport.js'
import { runOutlookMetadataPass, summarizePass } from './outlookMetadataPass.js'

/** Lease length and due interval for one manual run. Bounded by the RPC's own checks. */
export const LEASE_SECONDS = 120
export const DUE_AFTER_SECONDS = 900

/** Backoff requested when a run releases incomplete. */
export const RETRY_BACKOFF_SECONDS = 300

/** Every outcome a run can report. Controlled; safe to log. */
export const RUN_OUTCOMES = Object.freeze([
  'none_due',            // nothing was due; no lease taken
  'committed',           // suggestions written (or already present) and cursors advanced
  'incomplete',          // pass dropped or did not finish work; nothing committed
  'write_failed',        // a candidate write was refused; nothing committed
  'reserve_failed',      // the reservation RPC itself failed
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

  const release = (status, complete, cursors, errorCode) => rpc('release_outlook_sync_lease', {
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

  let pass
  let context
  try {
    context = await loadRunContext(connectionId)
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
      deps,
    })
  } catch {
    // The lease must never be left held. The message is deliberately not read: it can
    // contain a URL or an address.
    await release('error', false, null, 'pass_failed')
    return { outcome: 'released_error', connectionId }
  }

  // ── 3. an incomplete pass writes NOTHING and advances NOTHING ──────────────
  if (pass.commitReady !== true) {
    await release('idle', false, null, null)
    return {
      outcome: 'incomplete',
      connectionId,
      incompleteReasons: pass.incompleteReasons,
      written: 0,
      summary: summarizePass(pass),
    }
  }

  // ── 4. write the suggestions FIRST ─────────────────────────────────────────
  const { writable, skipped } = partitionPlan(pass.plan)
  const results = Object.create(null)
  let allAccepted = true
  let firstRefusal = null

  for (const entry of writable) {
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
    if (!writeAccepted(code)) {
      allAccepted = false
      if (firstRefusal === null) firstRefusal = code
    }
  }

  if (!allAccepted) {
    // Release as incomplete: no cursor, so the same mail is read again next run and the
    // fingerprint dedupe makes that retry idempotent.
    await release('idle', false, null, null)
    return {
      outcome: 'write_failed',
      connectionId,
      refusal: firstRefusal,
      writeResults: results,
      skipped,
      written: 0,
      summary: summarizePass(pass),
    }
  }

  // ── only now: encrypt and advance the cursors ──────────────────────────────
  const cursors = {}
  for (const folder of GRAPH_FOLDERS) {
    const link = pass.cursors?.[folder]
    if (typeof link !== 'string' || link.length === 0) continue
    cursors[folder] = await encryptCursor(link)
  }
  const released = await release('idle', true, cursors, null)

  return {
    outcome: 'committed',
    connectionId,
    written: writable.length,
    writeResults: results,
    skipped,
    cursorsAdvanced: released?.error ? false : Object.keys(cursors).length,
    summary: summarizePass(pass),
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
    written: Number.isInteger(result.written) ? result.written : 0,
    write_results: result.writeResults ?? {},
    entry_skipped: result.skipped ?? {},
    incomplete_reasons: Array.isArray(result.incompleteReasons) ? result.incompleteReasons : [],
    refusal: typeof result.refusal === 'string' ? result.refusal : null,
    cursors_advanced: Number.isInteger(result.cursorsAdvanced) ? result.cursorsAdvanced : 0,
    pass: result.summary ?? null,
  }
}
