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
// WHY STEP 3 RETURNS 501 RATHER THAN RUNNING.
// The pass itself is implemented and tested (shared/outlookMetadataPass.js), but it
// has nowhere to put its output yet, and that is a real gap rather than an oversight:
// `upsert_email_candidate` LOOKS provider-neutral - it accepts p_source 'outlook' -
// but its lease check reads `gmail_sync_state JOIN google_connections`, and it writes
// `email_candidate_refs`, whose connection_id references `google_connections`. Given a
// Microsoft connection id it therefore returns 'unknown_connection'. Writing Outlook
// suggestions needs its own RPC against `outlook_candidate_refs`, which is a forward
// migration and a separate reviewed slice.
//
// So when both flags are on, this endpoint answers 501 `not_implemented` with
// `reason: 'no_outlook_candidate_write_path'`. It deliberately does NOT reserve a
// lease, call Microsoft, or touch the database: a run that quietly discarded its own
// output would look like success while importing nothing.
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
  return json(501, {
    error: 'not_implemented',
    reason: 'no_outlook_candidate_write_path',
  })
}
