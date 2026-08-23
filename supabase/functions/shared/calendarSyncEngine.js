// Google Calendar manual sync engine — Phase C1 (source-only, undeployed).
//
// Pure, cross-runtime (Node + Deno), fully dependency-injected so the entire
// orchestration is unit-testable in the plain-Node runner with NO Deno globals,
// NO network, and NO database. The Deno Edge Function (index.ts) is a thin shell
// that builds real deps (Supabase clients, fetch, Web Crypto, env) and calls
// runCalendarSync(deps).
//
// SYNC MODEL (C1): bounded rolling reconciliation, NOT sync tokens.
//   - Primary calendar only, previous WINDOW_DAYS through invocation time.
//   - Completed events only; singleEvents=true; showDeleted=true; orderBy=startTime.
//   - Fixed query across all pages; page tokens only from the preceding Google page.
//   - No caller-supplied user/calendar/window/token/query options.
//
// WHY SYNC TOKENS ARE DEFERRED (google_calendar_sync_state.sync_token stays NULL):
//   1. syncToken is incompatible with the restricted parameters we rely on
//      (timeMin/timeMax/orderBy) — Google rejects the combination.
//   2. syncToken has a 410 Gone / full-resync lifecycle that must be handled
//      before it is safe to depend on.
//   3. Change-only (incremental) sync does NOT independently re-surface an
//      unchanged FUTURE event merely because its end time has since passed — but a
//      rolling "completed in the last 90 days" scan does. Correctness first.
//   Fingerprint uniqueness (UNIQUE(user_id, source_fingerprint)) makes overlapping
//   rolling scans idempotent, so re-scanning the window is safe. An incremental
//   optimization layer comes only after manual sync is proven.
//
// SECURITY: this module returns values and calls injected deps; it NEVER logs, and
// callers must log only the aggregate/controlled fields in the returned result.

import {
  evaluateEvent,
} from './calendarRelevance.js'
import {
  parseEventTiming,
  originalOccurrence,
} from './calendarTime.js'
import {
  computeCandidateFingerprint,
} from './calendarFingerprint.js'

// ── Hard caps / constants (bounded resource use) ──────────────────────────────
export const WINDOW_DAYS = 90
export const MAX_PAGES = 20
export const MAX_RESULTS_PER_PAGE = 100      // conservative; Google allows up to 2500
export const MAX_EVENTS = 2000               // hard ceiling across all pages
export const MAX_PAGE_BYTES = 5_000_000      // 5 MB per page response
export const WALLCLOCK_BUDGET_MS = 60_000    // whole-run budget
export const LEASE_SECONDS = 120             // > per-run budget; renewed each page
export const TOKEN_REFRESH_SKEW_MS = 120_000 // refresh when < 2 min to expiry
export const PAGE_TOKEN_MAX_LEN = 4096
export const SUMMARY_MAX = 200               // matches interaction_candidates.proposed_notes cap
export const FALLBACK_SUMMARY = 'Google Calendar event'
export const CALENDAR_ID = 'primary'
export const GOOGLE_CALENDAR_EVENTS_ENDPOINT =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events'

// ── Small pure validators/builders ────────────────────────────────────────────

const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
// A Google timed dateTime carries an explicit offset (Z or ±HH:MM); the DATE part
// before 'T' is the event's offset-local calendar date. Used to derive the proposed
// interaction date WITHOUT a UTC conversion that could shift the date.
const RFC3339_OFFSET_RE = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
// A Google page token is OPAQUE. It is percent-encoded by URLSearchParams, so a broad
// charset is injection-safe; we only fail closed on whitespace/control chars/empties
// and enforce a length bound (avoids an unnecessarily narrow regex rejecting valid tokens).
const PAGE_TOKEN_RE = /^[\x21-\x7E]+$/

export function isRfc3339Utc(s) {
  return typeof s === 'string' && RFC3339_RE.test(s)
}

/**
 * The offset-local calendar date (YYYY-MM-DD) implied by a Google timed dateTime.
 * For '2026-08-01T23:00:00-04:00' this is '2026-08-01' — the event's own local date,
 * derived from its explicit offset WITHOUT a UTC conversion (which could shift it to
 * the next/previous day). Returns null when no explicit offset is present (fail closed
 * — the correct date cannot be determined).
 */
export function datePartOfRfc3339(dt) {
  if (typeof dt !== 'string') return null
  const m = RFC3339_OFFSET_RE.exec(dt)
  return m ? m[1] : null
}

export function isValidPageToken(t) {
  return typeof t === 'string' && t.length > 0 && t.length <= PAGE_TOKEN_MAX_LEN && PAGE_TOKEN_RE.test(t)
}

function clampMaxResults(n) {
  const v = Number.isInteger(n) ? n : MAX_RESULTS_PER_PAGE
  return Math.min(Math.max(v, 1), MAX_RESULTS_PER_PAGE)
}

/**
 * Build the Google Calendar v3 primary-events list URL with the FIXED C1 query.
 * The access token is NEVER placed in the URL (Authorization header only).
 * Throws on an invalid window or a malformed page token (fail closed).
 */
export function buildEventsListUrl({ timeMinIso, timeMaxIso, maxResults, pageToken }) {
  if (!isRfc3339Utc(timeMinIso) || !isRfc3339Utc(timeMaxIso)) throw new Error('invalid_time_window')
  const p = new URLSearchParams()
  p.set('timeMin', timeMinIso)
  p.set('timeMax', timeMaxIso)
  p.set('singleEvents', 'true')
  p.set('showDeleted', 'true')
  p.set('orderBy', 'startTime')
  p.set('maxResults', String(clampMaxResults(maxResults)))
  if (pageToken !== null && pageToken !== undefined) {
    if (!isValidPageToken(pageToken)) throw new Error('invalid_page_token')
    p.set('pageToken', pageToken)
  }
  return `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}?${p.toString()}`
}

/**
 * Validate one events.list JSON page. Fail closed on non-object, non-array items,
 * or a malformed nextPageToken. Returns { ok, items, nextPageToken }.
 */
export function parseEventsPage(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'not_object' }
  const items = json.items
  if (items !== undefined && !Array.isArray(items)) return { ok: false, reason: 'items_not_array' }
  let next = null
  if (json.nextPageToken !== undefined && json.nextPageToken !== null) {
    if (!isValidPageToken(json.nextPageToken)) return { ok: false, reason: 'bad_next_token' }
    next = json.nextPageToken
  }
  return { ok: true, items: items ?? [], nextPageToken: next }
}

/**
 * Sanitize a candidate note from an event summary: whitespace-normalized, capped.
 * Missing/blank summary yields a neutral deterministic fallback (never invented
 * from event content). Only the summary is ever used — never description,
 * location, Meet links, attachments, or attendee data.
 */
export function sanitizeSummary(raw) {
  if (typeof raw !== 'string') return FALLBACK_SUMMARY
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return FALLBACK_SUMMARY
  return collapsed.length > SUMMARY_MAX ? collapsed.slice(0, SUMMARY_MAX) : collapsed
}

/**
 * Whether the stored access token should be refreshed now (expired or near expiry).
 * Unknown/unparseable expiry → refresh (fail safe).
 */
export function shouldRefreshToken(tokenExpiresAtIso, nowMs, skewMs = TOKEN_REFRESH_SKEW_MS) {
  if (typeof tokenExpiresAtIso !== 'string' || tokenExpiresAtIso.length === 0) return true
  const t = Date.parse(tokenExpiresAtIso)
  if (Number.isNaN(t)) return true
  return nowMs >= t - skewMs
}

/**
 * Strictly validate a Google token-refresh response body. Fail closed.
 * refresh_token is OPTIONAL (Google usually omits it on refresh).
 */
export function validateRefreshResponse(json) {
  if (!json || typeof json !== 'object') return { ok: false }
  const accessToken = json.access_token
  const expiresIn = json.expires_in
  if (typeof accessToken !== 'string' || accessToken.length === 0) return { ok: false }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return { ok: false }
  const refreshToken = typeof json.refresh_token === 'string' && json.refresh_token.length > 0
    ? json.refresh_token
    : null
  return { ok: true, accessToken, refreshToken, expiresIn }
}

function occurrenceRefFields(occ) {
  return occ.kind === 'datetime'
    ? { original_occurrence_at: occ.value, original_occurrence_date: null }
    : { original_occurrence_at: null, original_occurrence_date: occ.value }
}

function timingRefFields(timing) {
  if (timing.kind === 'timed') {
    return {
      event_start_at: timing.startAt.toISOString(),
      event_end_at: timing.endAt.toISOString(),
      event_start_date: null,
      event_end_date: null,
      event_timezone: timing.timezone ?? null,
    }
  }
  return {
    event_start_at: null,
    event_end_at: null,
    event_start_date: timing.startDate,
    event_end_date: timing.endDate,
    event_timezone: null,
  }
}

/**
 * Build the per-occurrence plan for one Google event:
 *   { skip:true, reason } — event is not actionable and not reconcilable
 *   { googleEventId, occurrence, candidates:[upsertArgs...], keepFingerprints:[...], reconcile:true }
 *
 * Reconcile-with-empty-keep covers: cancelled/deleted occurrence, user-declined,
 * and completed events with no (or fewer) definitive matches — invalidating any
 * previously-pending candidate for that occurrence that is no longer justified.
 * Throws only on a malformed single event (caller counts it as skipped).
 *
 * @param {object} args includes event, connectedEmail, contacts, now, fallbackTimeZone,
 *   subtle, googleSub, connectionId, runId, userId, calendarId
 */
export async function buildOccurrencePlan(args) {
  const {
    event, connectedEmail, contacts, now, fallbackTimeZone = 'UTC',
    subtle, googleSub, connectionId, runId, userId, calendarId = CALENDAR_ID,
  } = args

  const googleEventId = typeof event?.id === 'string' && event.id.length > 0 ? event.id : null
  if (!googleEventId) throw new Error('missing_event_id')

  const occ = originalOccurrence(event)

  // Cancelled / deleted: reconcile-only (invalidate pending for this occurrence).
  // If the occurrence identity cannot be derived we cannot key reconciliation — skip.
  // NOTE (C1 safety): this scan is TIME-BOUNDED (timeMin/timeMax, no syncToken), so
  // Google only returns events it can place in the window — which requires start /
  // originalStartTime. A cancelled event that appears here therefore carries occurrence
  // timing, making this branch effectively unreachable in C1. It fails closed by
  // SKIPPING (never invalidating), so it can never invalidate the wrong candidate; the
  // bare-cancellation / event-ID-only fallback is deferred to the incremental
  // (syncToken) phase where cancellations can arrive without timing.
  if (event.status === 'cancelled') {
    if (!occ.ok) return { skip: true, reason: 'cancelled_no_occurrence' }
    return {
      googleEventId, occurrence: occ.occurrence, candidates: [], keepFingerprints: [], reconcile: true,
    }
  }

  const ev = evaluateEvent({ event, connectedEmail, contacts, now, fallbackTimeZone })

  // Future / not-yet-completed events never produced candidates → nothing to do.
  if (ev.reason === 'not_completed') return { skip: true, reason: 'not_completed' }
  // Malformed timing/event → skip and count (safely attributable to this event).
  if (ev.reason === 'invalid_timing' || ev.reason === 'invalid_event' || ev.reason === 'invalid_now') {
    return { skip: true, reason: ev.reason }
  }
  if (!occ.ok) return { skip: true, reason: 'invalid_occurrence' }

  const timing = parseEventTiming(event)
  if (!timing.ok) return { skip: true, reason: 'invalid_timing' }

  // Proposed interaction date: for all-day use the inclusive start date; for timed use
  // the event's OFFSET-LOCAL date (from its RFC3339 offset), never a UTC conversion.
  // Fail closed if a timed dateTime lacks an explicit offset (date undeterminable).
  let proposedDate
  if (timing.kind === 'allday') {
    proposedDate = timing.startDate
  } else {
    proposedDate = datePartOfRfc3339(event?.start?.dateTime)
    if (!proposedDate) return { skip: true, reason: 'undeterminable_date' }
  }
  const notes = sanitizeSummary(event.summary)
  const icalUid = typeof event.iCalUID === 'string' && event.iCalUID.length > 0 ? event.iCalUID : null
  const occFields = occurrenceRefFields(occ.occurrence)
  const timeFields = timingRefFields(timing)

  const candidates = []
  const keepFingerprints = []
  for (const c of ev.candidates) {
    const fp = await computeCandidateFingerprint({
      source: 'google_calendar',
      googleSub,
      calendarId,
      googleEventId,
      occurrence: occ.occurrence,
      contactId: c.contactId,
    }, subtle)
    keepFingerprints.push(fp)
    candidates.push({
      p_connection_id: connectionId,
      p_calendar_id: calendarId,
      p_run_id: runId,
      p_user_id: userId,
      p_contact_id: c.contactId,
      p_google_sub: googleSub,
      p_google_event_id: googleEventId,
      p_ical_uid: icalUid,
      p_source_fingerprint: fp,
      p_proposed_type: c.proposedType,
      p_proposed_interaction_date: proposedDate,
      p_proposed_notes: notes,
      p_source_last_state: 'active',
      p_original_occurrence_at: occFields.original_occurrence_at,
      p_original_occurrence_date: occFields.original_occurrence_date,
      p_event_start_at: timeFields.event_start_at,
      p_event_end_at: timeFields.event_end_at,
      p_event_start_date: timeFields.event_start_date,
      p_event_end_date: timeFields.event_end_date,
      p_event_timezone: timeFields.event_timezone,
    })
  }
  // candidates may be empty (no/ambiguous match, declined) → reconcile still runs.
  return { googleEventId, occurrence: occ.occurrence, candidates, keepFingerprints, reconcile: true }
}

// ── Controlled response helper ────────────────────────────────────────────────
function resp(status, body) { return { status, body } }

/**
 * Full orchestration, dependency-injected. Returns { status, body }.
 * `deps` must provide (all async unless noted):
 *   method: string
 *   getUser(): { userId } | null
 *   loadConnection(userId): { connection:{id,google_sub,google_email,status,token_expires_at},
 *                             tokenRow:{access_token_ciphertext,access_token_nonce,
 *                                       refresh_token_ciphertext,refresh_token_nonce} } | null
 *   loadContacts(userId): [{ id, email }]
 *   decrypt(ct, nonce): plaintext
 *   encrypt(plaintext): { ciphertext, nonce }
 *   refreshAccessToken(refreshPlaintext): { status, json }   // POST token endpoint
 *   fetchEventsPage({ accessToken, url }): { status, json, bytes? }
 *   rpc: { claimLease(connId), renewLease(connId,runId), releaseLease(connId,runId,status,errorCode,complete),
 *          upsertCandidate(args), reconcileOccurrence({...}), storeRefreshedToken({...}), markNeedsReauth(connId,sub) }
 *   now(): Date
 *   subtle: SubtleCrypto
 *   log(obj): void   // aggregate/controlled fields only
 */
export async function runCalendarSync(deps) {
  const log = deps.log || (() => {})
  const t0 = deps.now().getTime()

  if (deps.method === 'OPTIONS') return resp(204, null)
  if (deps.method !== 'POST') return resp(405, { error: 'method_not_allowed' })

  const auth = await deps.getUser()
  if (!auth || !auth.userId) return resp(401, { error: 'unauthorized' })
  const userId = auth.userId

  let conn
  try {
    conn = await deps.loadConnection(userId)
  } catch {
    log({ event: 'calendar_sync', code: 'connection_lookup_failed' })
    return resp(500, { error: 'internal_error' })
  }
  if (!conn || !conn.connection) return resp(409, { error: 'not_connected' })
  if (conn.connection.status === 'revoked') return resp(409, { error: 'not_connected' })
  if (conn.connection.status === 'needs_reauth') return resp(409, { error: 'reauth_required' })

  const connId = conn.connection.id
  const googleSub = conn.connection.google_sub

  let runId
  try {
    runId = await deps.rpc.claimLease(connId)
  } catch {
    log({ event: 'calendar_sync', code: 'lease_claim_error' })
    return resp(500, { error: 'internal_error' })
  }
  if (!runId) return resp(409, { error: 'sync_in_progress' })

  // release() returns whether the release actually committed for THIS run. The Phase A
  // release RPC is run-ID fenced, so it returns false when the lease was reclaimed by a
  // newer run — in which case a "completed" claim would be untruthful. Error-path
  // callers ignore the return (they already hold the primary error).
  let released = false
  let releaseCommitted = false
  const release = async (status, errorCode, complete) => {
    if (released) return releaseCommitted
    released = true
    try {
      const r = await deps.rpc.releaseLease(connId, runId, status, errorCode, complete)
      releaseCommitted = (r === true)
    } catch { releaseCommitted = false }
    return releaseCommitted
  }

  // Refresh helper: returns { accessToken } | { needsReauth:true } | { transient:true } | { hardError }
  async function refreshCredentials() {
    const tr = conn.tokenRow || {}
    if (!tr.refresh_token_ciphertext || !tr.refresh_token_nonce) return { needsReauth: true }
    let refreshPlain
    try {
      refreshPlain = await deps.decrypt(tr.refresh_token_ciphertext, tr.refresh_token_nonce)
    } catch { return { hardError: 'token_decrypt_failed' } }
    let res
    try { res = await deps.refreshAccessToken(refreshPlain) } catch { return { transient: true } }
    const status = res?.status ?? 0
    if (status === 400 || status === 401) {
      if (res?.json?.error === 'invalid_grant') return { needsReauth: true }
      return { hardError: 'token_refresh_rejected' }
    }
    if (status === 429 || status >= 500 || status === 0) return { transient: true }
    if (status !== 200) return { transient: true }
    const v = validateRefreshResponse(res.json)
    if (!v.ok) return { hardError: 'malformed_token_response' }
    let encAccess, encRefresh
    try {
      encAccess = await deps.encrypt(v.accessToken)
      encRefresh = v.refreshToken ? await deps.encrypt(v.refreshToken) : null
    } catch { return { hardError: 'token_encrypt_failed' } }
    const expiresAt = new Date(deps.now().getTime() + v.expiresIn * 1000).toISOString()
    let ok
    try {
      ok = await deps.rpc.storeRefreshedToken({
        connectionId: connId,
        expectedGoogleSub: googleSub,
        accessCt: encAccess.ciphertext,
        accessNonce: encAccess.nonce,
        refreshCt: encRefresh ? encRefresh.ciphertext : null,   // null → RPC preserves BOTH existing refresh values
        refreshNonce: encRefresh ? encRefresh.nonce : null,
        keyVersion: 1,
        tokenExpiresAt: expiresAt,
      })
    } catch { return { hardError: 'token_persist_failed' } }
    if (!ok) return { hardError: 'token_persist_failed' }
    return { accessToken: v.accessToken }
  }

  try {
    // ── Access token: decrypt current, refresh if expired/near-expiry ──────────
    let accessToken = null
    let didRefresh = false
    const nowMs = deps.now().getTime()
    if (shouldRefreshToken(conn.connection.token_expires_at, nowMs)) {
      const r = await refreshCredentials()
      if (r.needsReauth) {
        try { await deps.rpc.markNeedsReauth(connId, googleSub) } catch { /* best-effort */ }
        await release('error', 'reauth_required', false)
        return resp(409, { error: 'reauth_required' })
      }
      if (r.transient) { await release('error', 'provider_unavailable', false); return resp(503, { error: 'provider_unavailable' }) }
      if (r.hardError) { await release('error', r.hardError, false); return resp(502, { error: 'provider_error' }) }
      accessToken = r.accessToken
      didRefresh = true
    } else {
      try {
        accessToken = await deps.decrypt(conn.tokenRow.access_token_ciphertext, conn.tokenRow.access_token_nonce)
      } catch { await release('error', 'token_decrypt_failed', false); return resp(500, { error: 'internal_error' }) }
    }

    const contacts = await deps.loadContacts(userId)
    const connectedEmail = conn.connection.google_email

    // ── Fixed rolling window (server-computed; never caller-supplied) ──────────
    const runStart = deps.now()
    const timeMaxIso = runStart.toISOString()
    const timeMinIso = new Date(runStart.getTime() - WINDOW_DAYS * 86_400_000).toISOString()

    let pageToken = null
    let pages = 0
    let eventsSeen = 0
    let candidatesWritten = 0
    let invalidated = 0
    let skipped = 0
    let retried401 = false
    const seenTokens = new Set()   // repeated page token ⇒ stop (controlled, incomplete)

    for (;;) {
      if (pages >= MAX_PAGES) { await release('error', 'max_pages_exceeded', false); return resp(200, incomplete()) }
      if (deps.now().getTime() - t0 > WALLCLOCK_BUDGET_MS) { await release('error', 'time_budget_exceeded', false); return resp(200, incomplete()) }

      if (pages > 0) {
        let renewed
        try { renewed = await deps.rpc.renewLease(connId, runId) } catch { renewed = false }
        if (!renewed) { await release('error', 'lease_lost', false); return resp(409, { error: 'sync_in_progress' }) }
      }

      let url
      try { url = buildEventsListUrl({ timeMinIso, timeMaxIso, maxResults: MAX_RESULTS_PER_PAGE, pageToken }) }
      catch { await release('error', 'request_build_failed', false); return resp(422, { error: 'invalid_request' }) }

      let page
      try { page = await deps.fetchEventsPage({ accessToken, url }) } catch { await release('error', 'provider_unreachable', false); return resp(503, { error: 'provider_unavailable' }) }
      let status = page?.status ?? 0

      // Exactly one refresh+retry after a Calendar 401 (only if we have not already refreshed).
      if (status === 401 && !retried401 && !didRefresh) {
        retried401 = true
        const r = await refreshCredentials()
        if (r.needsReauth) {
          try { await deps.rpc.markNeedsReauth(connId, googleSub) } catch { /* best-effort */ }
          await release('error', 'reauth_required', false); return resp(409, { error: 'reauth_required' })
        }
        if (r.transient) { await release('error', 'provider_unavailable', false); return resp(503, { error: 'provider_unavailable' }) }
        if (r.hardError) { await release('error', r.hardError, false); return resp(502, { error: 'provider_error' }) }
        accessToken = r.accessToken; didRefresh = true
        try { page = await deps.fetchEventsPage({ accessToken, url }) } catch { await release('error', 'provider_unreachable', false); return resp(503, { error: 'provider_unavailable' }) }
        status = page?.status ?? 0
      }

      if (status === 401) { try { await deps.rpc.markNeedsReauth(connId, googleSub) } catch { /* */ } await release('error', 'reauth_required', false); return resp(409, { error: 'reauth_required' }) }
      if (status === 429) { await release('error', 'provider_rate_limited', false); return resp(429, { error: 'provider_rate_limited' }) }
      if (status >= 500) { await release('error', 'provider_unavailable', false); return resp(503, { error: 'provider_unavailable' }) }
      if (status !== 200) { await release('error', 'provider_error', false); return resp(502, { error: 'provider_error' }) }
      if (typeof page.bytes === 'number' && page.bytes > MAX_PAGE_BYTES) { await release('error', 'response_too_large', false); return resp(502, { error: 'provider_error' }) }

      const parsed = parseEventsPage(page.json)
      if (!parsed.ok) { await release('error', 'malformed_response', false); return resp(502, { error: 'provider_error' }) }
      pages += 1

      for (const event of parsed.items) {
        if (eventsSeen >= MAX_EVENTS) { await release('error', 'max_events_exceeded', false); return resp(200, incomplete()) }
        eventsSeen += 1
        let plan
        try {
          plan = await buildOccurrencePlan({
            event, connectedEmail, contacts, now: runStart, fallbackTimeZone: 'UTC',
            subtle: deps.subtle, googleSub, connectionId: connId, runId, userId, calendarId: CALENDAR_ID,
          })
        } catch { skipped += 1; continue }   // malformed single event → skip, attributable
        if (plan.skip) { skipped += 1; continue }

        // Upsert kept candidates, then reconcile the occurrence's keep-set. A DB
        // error here is NOT event-attributable → stop the run (partial, incomplete).
        try {
          for (const cand of plan.candidates) { await deps.rpc.upsertCandidate(cand); candidatesWritten += 1 }
          const inv = await deps.rpc.reconcileOccurrence({
            p_connection_id: connId,
            p_calendar_id: CALENDAR_ID,
            p_run_id: runId,
            p_user_id: userId,
            p_google_sub: googleSub,
            p_google_event_id: plan.googleEventId,
            p_original_occurrence_at: plan.occurrence.kind === 'datetime' ? plan.occurrence.value : null,
            p_original_occurrence_date: plan.occurrence.kind === 'date' ? plan.occurrence.value : null,
            p_keep_fingerprints: plan.keepFingerprints,
          })
          invalidated += (typeof inv === 'number' ? inv : 0)
        } catch {
          await release('error', 'candidate_write_failed', false)
          return resp(200, incomplete())
        }
      }

      pageToken = parsed.nextPageToken
      if (!pageToken) break
      // Google returning a token we have already followed indicates a broken/hostile
      // pagination cursor; stop controlled+incomplete rather than loop (also bounded by MAX_PAGES).
      if (seenTokens.has(pageToken)) { await release('error', 'repeated_page_token', false); return resp(200, incomplete()) }
      seenTokens.add(pageToken)
    }

    // Completion is truthful only when nothing was skipped AND the run-ID-fenced release
    // actually committed (a reclaimed lease returns false). A skipped (unparseable) event
    // could leave a stale pending candidate un-reconciled, so it does not count as a
    // fully-complete run.
    const runComplete = (skipped === 0)
    const releasedOk = await release('idle', null, runComplete)
    if (!runComplete || !releasedOk) {
      const code = !releasedOk ? 'release_unconfirmed' : 'completed_with_skips'
      log({ event: 'calendar_sync', code, pages, events_seen: eventsSeen, candidates_written: candidatesWritten, candidates_invalidated: invalidated, events_skipped: skipped, duration_ms: deps.now().getTime() - t0 })
      return resp(200, {
        status: 'incomplete', pages, events_seen: eventsSeen,
        candidates_written: candidatesWritten, candidates_invalidated: invalidated, events_skipped: skipped,
      })
    }
    const body = {
      status: 'completed', pages, events_seen: eventsSeen,
      candidates_written: candidatesWritten, candidates_invalidated: invalidated, events_skipped: skipped,
    }
    log({ event: 'calendar_sync', code: 'completed', pages, events_seen: eventsSeen, candidates_written: candidatesWritten, candidates_invalidated: invalidated, events_skipped: skipped, duration_ms: deps.now().getTime() - t0 })
    return resp(200, body)

    function incomplete() {
      log({ event: 'calendar_sync', code: 'incomplete', pages, events_seen: eventsSeen, candidates_written: candidatesWritten, candidates_invalidated: invalidated, events_skipped: skipped, duration_ms: deps.now().getTime() - t0 })
      return {
        status: 'incomplete', pages, events_seen: eventsSeen,
        candidates_written: candidatesWritten, candidates_invalidated: invalidated, events_skipped: skipped,
      }
    }
  } catch {
    await release('error', 'internal_error', false)
    log({ event: 'calendar_sync', code: 'internal_error', duration_ms: deps.now().getTime() - t0 })
    return resp(500, { error: 'internal_error' })
  }
}
