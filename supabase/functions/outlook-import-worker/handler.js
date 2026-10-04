// outlook-import-worker — the deployed entrypoint for one bounded Outlook import run.
//
// DORMANT, AND DORMANT IN A WAY THAT CANNOT BE MISREAD.
//
// Two independent flags must BOTH be exactly the string 'true' before this endpoint
// does anything: OUTLOOK_INTEGRATION_ENABLED (the whole integration, shared with the
// OAuth functions) and OUTLOOK_IMPORT_WORKER_ENABLED (this endpoint alone). Neither is
// set in any environment, and they are set together ONLY inside a disposable local
// test. Anything else - unset, 'TRUE', '1', 'yes', whitespace - is off, matching the
// fail-safe predicate used everywhere else in this project.
//
// ORDER OF CHECKS, AND WHY.
//   1. Dormancy first, before authorisation. A disabled endpoint must not become an
//      oracle for whether a worker secret is correct.
//   2. Worker authorisation second: POST only, a >= 32-character shared secret
//      compared in constant time. A user JWT grants no authority here.
//   3. Configuration third, and it FAILS CLOSED: without the Entra client id and
//      secret, Microsoft's token endpoint, the token-encryption key and the fingerprint
//      key ring, the run is refused with `config_missing` before anything is read. A
//      half-configured deployment must not half-run.
//   4. Only then the run.
//
// WHAT THE REQUEST MAY CONTAIN: nothing. The body is never read. The caller supplies no
// user id, no connection id, no access token, no cursor and no candidate content - which
// connection runs is decided by reserve_due_outlook_connection, and everything else is
// loaded server-side by shared/outlookRunContext.js. A test asserts the body is never
// parsed.
//
// WHAT IT CAN PRODUCE: at most one PENDING interaction suggestion per qualifying
// exchange, for a contact the user ALREADY has. It creates no contact and no
// interaction - only the user's own accept_interaction_candidate call does that. It
// reads no message body, calls no AI, and schedules nothing.
//
// EVERY RESPONSE IS A CONTROLLED CODE, and none is a success-shaped no-op: a run that
// did not commit says so, and only `committed`, `none_due` and `incomplete` answer 200.
// A provider message, a token, a ciphertext, a cursor, an address, a candidate id and a
// fingerprint never appear in a response or a log.
//
// WHY THE 501 IS GONE. It said `no_token_access_path`, which was true: a deployed run
// had no way to obtain a Graph access token. It now does - the run context decrypts the
// stored token with MICROSOFT_TOKEN_ENCRYPTION_KEY_V1 and refreshes an expired one at
// Microsoft's fixed endpoint through the existing confidential-client exchange,
// persisting a rotated refresh token before the run uses it. The 501 is replaced ONLY
// because the full path actually runs; every other failure keeps its own code.
//
// PREVIOUS BLOCKER, KEPT ON THE RECORD so the change of reason is auditable: the write
// path. `upsert_email_candidate` LOOKS provider-neutral (it accepts p_source 'outlook')
// but its lease fence reads `gmail_sync_state JOIN google_connections` and it writes
// `email_candidate_refs`, whose connection_id references `google_connections`, so a
// Microsoft connection id returned 'unknown_connection'. Migration 20260930000000 added
// the Outlook equivalent, fenced on `outlook_sync_state` and recording provenance in
// `outlook_candidate_refs`.
//
// WHAT CHANGED ABOUT THE RUNTIME LIMIT. This handler used to await an entire import
// before answering, which hosted Edge Functions do not allow: the request idle timeout is
// 150s, the maximum duration is 150s on the free plan (400s paid), and background tasks
// are explicitly capped by the same wall clock. It now runs one INVOCATION'S share of a
// delta round against a budget measured from handler entry, checkpoints after every Graph
// page, and answers `continued` when the budget runs out. The 420s database lease is not
// and never was an execution budget - it stops a second run touching the connection.
//
// STILL BLOCKING ENABLEMENT, and none of it is fixed here:
//   * A PRODUCT DECISION AND A POLICY EDIT. Continuation persists per-conversation
//     recognition state (keyed fingerprints, counts, two timestamps, controlled codes -
//     no body, address, subject or provider id). The published /privacy "What Funnl would
//     keep" list does not name that record, so one bullet must be added before Outlook is
//     enabled; and whether that state may survive a sync round - which is what would let
//     a reply arriving next week be paired with its earlier half - is a product decision.
//     Both are written up as D1 and D2 in docs/outlook-durable-continuation-design.md and
//     neither is decided in code.
//   * CONTEXT PREPARATION IS BOUNDED BUT NOT RESUMABLE. CONTEXT_WORST_MS is 285s against a
//     120s budget. The load now checks the invocation deadline between its bounded steps, so
//     it stops at a step boundary and gives the lease back instead of being killed mid-load
//     holding it - but it keeps no partial state, so the next invocation repeats it from the
//     start. A connection whose real load exceeds the budget answers `budget_exhausted`
//     every time and never imports anything. So the hosted runtime limit is addressed for
//     the import loop and for finalisation, and NOT for context preparation.
//   * An invalid COMMITTED deltaLink still has no restart; only a saved nextLink does.
//   * No Entra application, client secret, token-encryption key or fingerprint HMAC key
//     exists in any environment, and none is configured here.
//   * The published /privacy Outlook section names Mail.Read only, while the branches
//     request Mail.Read AND User.Read.
//   * No scheduler. This endpoint runs only when something calls it.

import { authorizeWorkerRequest } from '../shared/workerAuth.js'
import { runOutlookImport, summarizeRun } from '../shared/outlookImportRun.js'
import {
  makeRunContextLoader, makeCursorEncryptor, makeCursorDecryptor,
} from '../shared/outlookRunContext.js'

/** Fail-safe: anything but the exact string is off. */
export function flagEnabled (raw) {
  return raw === 'true'
}

export const WORKER_FLAGS = Object.freeze([
  'OUTLOOK_INTEGRATION_ENABLED',
  'OUTLOOK_IMPORT_WORKER_ENABLED',
])

/**
 * Configuration this endpoint cannot run without. Absent any one of them the run is
 * refused before a single row is read.
 */
export const REQUIRED_CONFIG = Object.freeze([
  'clientId',        // MICROSOFT_CLIENT_ID
  'clientSecret',    // MICROSOFT_CLIENT_SECRET
  'tokenKeyB64',     // MICROSOFT_TOKEN_ENCRYPTION_KEY_V1
  'fingerprintKey',  // the HMAC key ring the episode fingerprints are keyed with
])

/** Every response code this endpoint can produce. Controlled; safe to log. */
export const WORKER_CODES = Object.freeze([
  'not_enabled', 'method_not_allowed', 'worker_not_configured', 'unauthorized',
  'config_missing', 'run_failed',
])

/**
 * Which run outcomes mean the endpoint answers 200.
 *
 * `continued` joins them because it is the DESIGNED behaviour of a large mailbox, not a
 * failure: the invocation spent its budget, saved exactly where it got to, committed no
 * cursor and wrote no suggestion. The body still says `continued`, so this is not a
 * success-shaped no-op - a caller that only reads the status code learns "the worker
 * behaved", and one that reads the body learns "come back, there is more".
 *
 * `restart_required` is deliberately NOT here. It means Microsoft rejected a saved
 * continuation token and a round's worth of reading was discarded. Nothing is corrupt and
 * nothing is lost, but work was thrown away for an external reason, and that should be
 * visible to whatever calls this rather than blending into the 200s.
 */
export const OK_OUTCOMES = Object.freeze(['committed', 'none_due', 'incomplete', 'continued'])

function json (status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      // A worker endpoint is never called from a browser.
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/**
 * Which required configuration keys are absent. Names only - a value is never read into
 * a response, so this can say what is missing without leaking what is present.
 */
export function missingConfig (config) {
  const cfg = config || {}
  return REQUIRED_CONFIG.filter((k) => {
    const v = cfg[k]
    if (typeof v === 'string') return v.length === 0
    return v === null || v === undefined
  })
}

/**
 * Map a run outcome to an HTTP status. `incomplete` and `none_due` are 200 because the
 * run behaved correctly and simply committed nothing; every failure is 503 so a caller
 * cannot mistake it for work done.
 */
export function statusForOutcome (outcome) {
  return OK_OUTCOMES.includes(outcome) ? 200 : 503
}

/**
 * @param {Request} req
 * @param {{integrationEnabled?:string|null, workerEnabled?:string|null,
 *          workerSecret?:string|null, clientId?:string|null, clientSecret?:string|null,
 *          tokenKeyB64?:string|null, fingerprintKey?:object|null, keyVersion?:number,
 *          scope?:string}} env
 *        read by the caller, never here, so this stays drivable in a test.
 * @param {{tokenUrl:string, fetchImpl?:Function, graphFetchImpl?:Function,
 *          select:Function, rpc:Function, subtle?:SubtleCrypto, now?:Function}} deps
 *        the provider endpoint and the database ports. The DEPLOYED entry passes
 *        Microsoft's fixed token URL and the project's own PostgREST; only the local
 *        harness passes fixtures, through a separate entry file that is never deployed.
 */
export async function handleOutlookImportWorker (req, env, deps) {
  const e = env || {}
  const d = deps || {}

  // THE FIRST THING, before the flags, before authorisation. The platform's 150s request
  // idle timeout and its wall clock start when the request arrives, not when the run
  // begins, so the invocation budget has to be measured from here or it overstates what is
  // left by however long the checks and the context load took.
  const requestEntryMs = typeof d.now === 'function' ? d.now() : Date.now()

  // 1. DORMANCY, before anything else.
  if (!flagEnabled(e.integrationEnabled) || !flagEnabled(e.workerEnabled)) {
    return json(503, { error: 'not_enabled' })
  }

  // 2. Worker authorisation. Never a user JWT.
  const auth = authorizeWorkerRequest({
    method: req?.method,
    authorization: req?.headers?.get?.('authorization') ?? null,
    configuredSecret: e.workerSecret ?? null,
  })
  if (!auth.ok) return json(auth.status, { error: auth.code })

  // 3. CONFIGURATION, failing closed.
  const missing = missingConfig(e)
  const noTokenUrl = typeof d.tokenUrl !== 'string' || d.tokenUrl.length === 0
  if (missing.length > 0 || noTokenUrl) {
    return json(503, {
      error: 'config_missing',
      missing: noTokenUrl ? [...missing, 'tokenUrl'] : missing,
    })
  }
  if (typeof d.select !== 'function' || typeof d.rpc !== 'function') {
    return json(503, { error: 'config_missing', missing: ['database'] })
  }

  // 4. The run. The request body is never read.
  let result
  try {
    const loadRunContext = makeRunContextLoader({
      select: d.select,
      rpc: d.rpc,
      config: {
        clientId: e.clientId,
        clientSecret: e.clientSecret,
        tokenUrl: d.tokenUrl,
        tokenKeyB64: e.tokenKeyB64,
        keyVersion: e.keyVersion,
        keyRing: e.fingerprintKey,
        scope: e.scope,
      },
      deps: { fetchImpl: d.fetchImpl, subtle: d.subtle, now: d.now },
    })
    result = await runOutlookImport({
      rpc: d.rpc,
      encryptCursor: makeCursorEncryptor({
        tokenKeyB64: e.tokenKeyB64,
        keyVersion: e.keyVersion ?? 1,
        subtle: d.subtle,
      }),
      // Needed for ONE thing: a saved @odata.nextLink from an earlier invocation of the
      // same round. A pending deltaLink is committed as ciphertext and never decrypted.
      decryptCursor: makeCursorDecryptor({
        tokenKeyB64: e.tokenKeyB64,
        subtle: d.subtle,
      }),
      loadRunContext,
      requestEntryMs,
      // The Graph fetch is separable from the token fetch so a test can fail one
      // without the other; in production both are the platform fetch.
      deps: { fetchImpl: d.graphFetchImpl ?? d.fetchImpl, now: d.now },
    })
  } catch {
    // Nothing from the thrown value is read: it can carry a URL, an address or a
    // provider message. runOutlookImport releases the lease for every failure it can
    // see, so a throw escaping it is a bug - reported as one, never as a completed run.
    return json(503, { error: 'run_failed' })
  }

  const summary = summarizeRun(result)
  return json(statusForOutcome(summary.outcome), { error: null, run: summary })
}
