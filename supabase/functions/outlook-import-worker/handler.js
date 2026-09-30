// outlook-import-worker — the entry point for the bounded Inbox/Sent metadata pass.
//
// DORMANT, AND DORMANT IN A WAY THAT CANNOT BE MISREAD.
//
// Two independent flags must BOTH be exactly the string 'true' before this endpoint
// does anything: OUTLOOK_INTEGRATION_ENABLED (the whole integration, shared with the
// OAuth functions) and OUTLOOK_IMPORT_WORKER_ENABLED (this endpoint alone). Neither is
// set in any environment. Anything else - unset, 'TRUE', '1', 'yes', whitespace - is
// off, matching the fail-safe predicate used everywhere else in this project.
//
// ORDER OF CHECKS, AND WHY.
//   1. Dormancy first, before authorisation. A disabled endpoint must not become an
//      oracle for whether a worker secret is correct.
//   2. Worker authorisation second: POST only, a >= 32-character shared secret
//      compared in constant time. A user JWT grants no authority here.
//   3. Only then would a run happen.
//
// WHY STEP 3 STILL RETURNS 501 RATHER THAN RUNNING.
//
// The run itself is now implemented and verified: shared/outlookImportRun.js reserves
// the lease, runs the metadata pass, writes pending suggestions through
// upsert_outlook_interaction_candidate, and advances the encrypted cursors only after
// every write succeeded on a commit-ready pass. It is exercised end to end against a
// real local Postgres through PostgREST by tests/local/outlook-first-suggestion.mjs.
//
// What is missing is a way for a DEPLOYED function to obtain a Graph access token.
// `microsoft_tokens` holds ciphertext and a nonce; turning that into a usable token
// needs the token-encryption key (which does not exist in any environment) and a
// refresh exchange against an Entra application (which does not exist at all). So a
// deployed run has no credential to present, and this endpoint answers 501
// `not_implemented` with `reason: 'no_token_access_path'`.
//
// THE MANUAL TRIGGER IS LOCAL, DELIBERATELY. The milestone this slice delivers is
// demonstrable by running tests/local/outlook-first-suggestion.mjs, which supplies
// fixture Microsoft responses and an injected token to the same run module this
// endpoint would call. Nothing about that path reaches a real mailbox.
//
// PREVIOUS BLOCKER, NOW CLEARED - recorded so the change of reason is visible:
// `upsert_email_candidate` LOOKS provider-neutral (it accepts p_source 'outlook') but
// its lease fence reads `gmail_sync_state JOIN google_connections` and it writes
// `email_candidate_refs`, whose connection_id references `google_connections`. A
// Microsoft connection id therefore returned 'unknown_connection'. Migration
// 20260930000000 adds the Outlook equivalent, fenced on `outlook_sync_state` and
// recording provenance in `outlook_candidate_refs`. It is UNAPPLIED.
//
// A THIRD BLOCKER REMAINS: NO CONTINUATION DESIGN. The pass refuses to hand back a
// cursor whenever work was dropped or left unfinished, which is the safe failure but
// not a working one - a mailbox past the per-run ceilings restarts from the same
// cursor every run, hits the same ceiling, commits nothing, and makes no progress
// forever. Durable continuation must be designed and reviewed before this endpoint
// becomes operational: where partial progress inside a delta stream is persisted (an
// intermediate nextLink is opaque and time-limited, so storing one is not obviously
// safe), how a run resumes mid-stream, and what a user sees while a first import is
// still incomplete.
//
// WHAT THIS FILE NEVER DOES: no Microsoft Graph request, no Supabase client, no
// Anthropic call, no scheduling. A test asserts each of those by scanning this source
// and by driving the handler with a fetch that fails the test if it is ever called.

import { authorizeWorkerRequest } from '../shared/workerAuth.js'

/** Fail-safe: anything but the exact string is off. */
export function flagEnabled (raw) {
  return raw === 'true'
}

export const WORKER_FLAGS = Object.freeze([
  'OUTLOOK_INTEGRATION_ENABLED',
  'OUTLOOK_IMPORT_WORKER_ENABLED',
])

/** Every response this endpoint can produce. Controlled; safe to log. */
export const WORKER_CODES = Object.freeze([
  'not_enabled', 'method_not_allowed', 'worker_not_configured', 'unauthorized',
  'not_implemented',
])

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
 * @param {Request} req
 * @param {{ integrationEnabled?:string|null, workerEnabled?:string|null,
 *           workerSecret?:string|null }} env values read by the caller, never here,
 *        so this function is pure enough to drive in a test.
 */
export async function handleOutlookImportWorker (req, env) {
  const e = env || {}

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

  // 3. There is no write path for an Outlook suggestion yet. Refuse loudly.
  // A deployed run has no way to obtain a Graph access token. Refusing loudly is the
  // point: a run that quietly did nothing would look like success.
  return json(501, {
    error: 'not_implemented',
    reason: 'no_token_access_path',
  })
}
