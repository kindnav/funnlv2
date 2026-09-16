// Email integration — Phase E2B: bounded Gmail sync worker core (pure, DI).
//
// Cross-runtime (Node + Deno). EVERY effect is injected (fetch, clock, RPCs, fingerprint,
// classifier), so the whole control flow is unit-testable with synthetic fixtures and the
// module performs no I/O on import. It never logs provider content and returns controlled
// codes + aggregate counts only.
//
// WHAT THIS DOES NOT DO: it does not schedule itself, does not sweep users, and does not
// decide eligibility. It processes EXACTLY ONE reserved connection per invocation, hands
// bounded metadata to the merged E1 classifier, and persists only through the hardened
// service-role RPCs. Gmail remains unreachable until a real scope + worker secret exist.
//
// BOUNDED READS: every provider response is consumed through readBoundedStream (the same
// primitive the OAuth callback uses) with an explicit byte ceiling, and only then parsed.
// `.json()` / `.text()` are NEVER called on a Gmail response, so a hostile or runaway
// payload can never be fully buffered.

import { readBoundedStream } from './googleOauthHelpers.js'
import {
  buildInitialListRequest, buildHistoryRequest, buildGetMetadataRequest,
  buildGetThreadRequest, buildGetProfileRequest,
  initialWindowStartEpochSec, normalizeGmailBatch, partitionForClassifier,
  INITIAL_WINDOW_DAYS, HISTORY_ID_MAX_LEN,
} from './gmailTransport.js'
import {
  parseHistoryPage, aggregateHistory, resolveReconciliationFingerprints, classifyHistoryStatus,
  SCOPE_EXIT_LABELS, MAX_RECONCILE_FINGERPRINTS,
} from './gmailHistory.js'
import { resolveGmailCapabilityTransition } from './gmailOauth.js'

const GMAIL_API_BASE = 'https://gmail.googleapis.com'

// ── Hard caps (C). Enforced BEFORE normalization/classification. ────────────────
export const CAPS = Object.freeze({
  maxPagesPerRun: 20,            // list/history pages
  maxMessagesPerPage: 100,       // conservative (Gmail allows far more)
  maxMessagesPerRun: 2000,       // ceiling across all pages
  maxConversationsPerRun: 1000,  // distinct threads
  maxBytesPerMessage: 131072,    // 128 KB decoded metadata for one messages.get
  maxBytesPerListPage: 1048576,  // 1 MB decoded metadata for one list/history page
  maxBytesPerRun: 5000000,       // 5 MB decoded metadata budget for the whole run
  runtimeBudgetMs: 60000,        // whole-run wall clock
  maxConcurrency: 4,             // bounded parallel messages.get
  maxPriorKeys: 5,               // bounded prior-key fingerprint lookup (matches key ring)
  requestTimeoutMs: 15000,       // per provider request; also clipped to the remaining run budget
  maxBytesPerThread: 1048576,    // 1 MB decoded for one threads.get?format=minimal listing
  maxBytesPerProfile: 16384,     // users.getProfile is a few hundred bytes
  // Reconciliation may have to enumerate (every contact x every plausible boundary) for a
  // thread whose remaining messages no longer name a contact (e.g. fully deleted). HMACs are
  // cheap; the invalidate RPC is chunked at its own 500 bound. Beyond this the run is
  // incomplete (cursor held) rather than guessing.
  maxReconcileFingerprintsPerThread: 20000,
  leaseSeconds: 120,
  dueAfterSeconds: 86400,        // daily cadence per connection
  windowDays: INITIAL_WINDOW_DAYS,
})

/**
 * Fetch a Gmail endpoint and parse it ONLY after a bounded streaming read.
 * Never calls response.json()/.text().
 * @returns {Promise<{ok:true,status:number,json:object}|{ok:false,status:number,code:string}>}
 */
export async function fetchBoundedJson({ fetchImpl, url, accessToken, maxBytes, signal }) {
  if (typeof fetchImpl !== 'function') return { ok: false, status: 0, code: 'invalid_fetch' }
  let res
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal,
    })
  } catch {
    return { ok: false, status: 0, code: 'network_error' }
  }
  const status = typeof res?.status === 'number' ? res.status : 0
  const bounded = await readBoundedStream(res?.body, {
    maxBytes,
    contentLength: res?.headers?.get ? res.headers.get('content-length') : undefined,
  })
  if (!bounded.ok) {
    // body_too_large / invalid_content_length / stream_error / missing_body / invalid_encoding
    return { ok: false, status, code: bounded.reason === 'body_too_large' ? 'response_too_large' : 'unreadable_response' }
  }
  if (status !== 200) return { ok: false, status, code: 'provider_status' }
  let json
  try { json = JSON.parse(bounded.text) } catch { return { ok: false, status, code: 'invalid_json' } }
  return { ok: true, status, json, bytes: bounded.text.length }
}

// Per-request deadline. Every provider call gets its own AbortSignal so a hung connection
// can never outlive the run budget: the timeout is the smaller of caps.requestTimeoutMs and
// the budget still remaining. Falls back to no signal when AbortController is unavailable.
function requestSignal(timeoutMs) {
  if (typeof AbortController !== 'function') return { signal: undefined, clear: () => {} }
  const ctrl = new AbortController()
  const t = setTimeout(() => { try { ctrl.abort() } catch { /* */ } }, Math.max(1, timeoutMs | 0))
  return { signal: ctrl.signal, clear: () => clearTimeout(t) }
}

// Bounded-concurrency map (no unbounded Promise.all over provider-controlled arrays).
async function mapBounded(items, limit, fn) {
  const out = []
  const n = Math.max(1, Math.min(limit | 0 || 1, 16))
  for (let i = 0; i < items.length; i += n) {
    const slice = items.slice(i, i + n)
    const settled = await Promise.all(slice.map((it) => fn(it)))
    out.push(...settled)
  }
  return out
}

function qs(query) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) { for (const one of v) p.append(k, one) } else { p.set(k, String(v)) }
  }
  return p.toString()
}
const urlFor = (req) => `${GMAIL_API_BASE}${req.path}?${qs(req.query)}`

/**
 * Run ONE bounded Gmail sync for ONE reserved connection.
 *
 * Cursor rule: `release` advances the durable history cursor ONLY when the run is
 * complete. Any cap exhaustion, malformed page, withheld thread, provider failure,
 * timeout, or reconciliation failure marks the run incomplete, so the cursor is held and
 * the range is retried next invocation.
 *
 * @param {object} deps  fully injected; see tests for the exact shape
 * @returns {Promise<{result:string, counts?:object, code?:string}>}
 */
export async function runGmailSync(deps) {
  const {
    caps = CAPS,
    now = () => Date.now(),
    fetchImpl,
    reserve, loadConnection, loadContacts, resolveAccessToken,
    classify, computeFingerprintSet, upsertCandidate, invalidateFingerprints,
    release, renew, upsertCapability, log = () => {},
  } = deps || {}

  const startedAt = now()
  const overBudget = () => (now() - startedAt) > caps.runtimeBudgetMs
  const remainingMs = () => caps.runtimeBudgetMs - (now() - startedAt)
  // Every provider request goes through here: bounded bytes AND a bounded deadline.
  const get = async (url, accessToken, maxBytes) => {
    const { signal, clear } = requestSignal(Math.min(caps.requestTimeoutMs, Math.max(1, remainingMs())))
    try { return await fetchBoundedJson({ fetchImpl, url, accessToken, maxBytes, signal }) }
    finally { clear() }
  }
  const counts = {
    pages: 0, messagesFetched: 0, conversations: 0, bytes: 0,
    candidatesCreated: 0, candidatesRefreshed: 0, invalidated: 0, withheldThreads: 0,
  }
  let complete = true
  let incompleteCode = null
  const markIncomplete = (code) => { if (complete) { complete = false; incompleteCode = code } }

  // ── 1. Reserve exactly one due connection ────────────────────────────────────
  let reserved
  try { reserved = await reserve({ leaseSeconds: caps.leaseSeconds, dueAfterSeconds: caps.dueAfterSeconds }) }
  catch { return { result: 'error', code: 'reserve_failed' } }
  if (!reserved || reserved.result !== 'reserved') return { result: 'none_due' }

  const { connection_id: connectionId, run_id: runId } = reserved
  const historyId = reserved.history_id || null
  const initialDone = reserved.initial_import_done === true
  const finish = async (status, code, advanceHistoryId, markInitialDone, backoffSeconds) => {
    try {
      await release({
        connectionId, runId, status,
        errorCode: code, runComplete: complete,
        historyId: complete ? advanceHistoryId : null,   // cursor only on a complete run
        initialDone: complete ? markInitialDone : false,
        backoffSeconds: backoffSeconds ?? null,
      })
    } catch { /* lease expiry reclaims the row; never throw out of the worker */ }
    log({ event: 'gmail_sync_complete', run_complete: complete, code: code || incompleteCode || null, counts })
    return { result: complete ? 'complete' : 'incomplete', code: code || incompleteCode || undefined, counts }
  }

  // ── 2. Load connection + owned contacts + an access token ────────────────────
  let conn, contacts, accessToken
  try {
    conn = await loadConnection(connectionId)
    if (!conn) { markIncomplete('connection_missing'); return finish('error', 'connection_missing') }
    contacts = await loadContacts(conn.userId)
    const tok = await resolveAccessToken(conn)
    if (!tok || !tok.ok) {
      // invalid_grant  = the shared refresh credential is dead  → connection-wide.
      // scope_revoked  = the Gmail grant specifically was removed → Gmail-only reauth.
      // anything else  = TRANSIENT. It must NOT flip a capability to needs_reauth, or a
      //                  single provider blip would force the user to reconnect.
      const reason = tok?.reason === 'invalid_grant'
        ? 'invalid_grant'
        : tok?.reason === 'scope_revoked' ? 'gmail_scope_revoked' : 'provider_error'
      const t = resolveGmailCapabilityTransition(reason)
      try {
        await upsertCapability({
          connectionId, userId: conn.userId, product: t.product, status: t.status,
          granted: t.granted, needsReauth: t.needsReauth, resultCode: t.resultCode,
        })
      } catch { /* controlled */ }
      markIncomplete(t.resultCode)
      return finish('error', t.resultCode)
    }
    accessToken = tok.accessToken
  } catch { markIncomplete('load_failed'); return finish('error', 'load_failed') }

  // ── 3. Decide mode. An expired cursor falls back to the BOUNDED window. ──────
  let mode = (initialDone && historyId) ? 'incremental' : 'initial'
  let removedKeysByThread = Object.create(null)
  // Threads whose REMAINING messages were fully learned this run (complete minimal listing,
  // or a 404 proving nothing remains). Only these may be reconciled: reconciling a thread we
  // could not read completely would invalidate episodes that may still qualify.
  const reconcilable = new Set()
  let latestHistoryId = historyId
  const messageRefs = new Map()        // id -> threadId (deduped across pages)
  const threads = new Set()

  const registerRef = (id, threadId) => {
    if (messageRefs.has(id)) return true
    if (messageRefs.size >= caps.maxMessagesPerRun) { markIncomplete('max_messages_exceeded'); return false }
    if (!threads.has(threadId) && threads.size >= caps.maxConversationsPerRun) {
      markIncomplete('max_conversations_exceeded'); return false
    }
    messageRefs.set(id, threadId); threads.add(threadId); return true
  }

  // Page loop shared by both modes. Caps are checked BEFORE any normalization.
  const pageLoop = async (firstRequest, onPage) => {
    let pageToken
    for (;;) {
      if (counts.pages >= caps.maxPagesPerRun) { markIncomplete('max_pages_exceeded'); return }
      if (overBudget()) { markIncomplete('runtime_budget_exceeded'); return }
      if (counts.bytes >= caps.maxBytesPerRun) { markIncomplete('max_bytes_exceeded'); return }

      let req
      try { req = firstRequest(pageToken) } catch { markIncomplete('request_build_failed'); return }
      const r = await get(urlFor(req), accessToken, caps.maxBytesPerListPage)
      counts.pages += 1
      if (!r.ok) {
        if (r.code === 'response_too_large') { markIncomplete('response_too_large'); return }
        const cls = classifyHistoryStatus(r.status)
        markIncomplete(cls.code)
        return cls
      }
      counts.bytes += r.bytes || 0
      if (counts.bytes > caps.maxBytesPerRun) { markIncomplete('max_bytes_exceeded'); return }

      const next = await onPage(r.json)
      if (next === false) return            // onPage signalled stop (already marked)
      pageToken = next || null
      if (!pageToken) return
      if (counts.pages >= caps.maxPagesPerRun) { markIncomplete('max_pages_exceeded'); return }
    }
  }

  if (mode === 'incremental') {
    const pages = []
    const cls = await pageLoop(
      (pageToken) => buildHistoryRequest({ startHistoryId: historyId, maxResults: caps.maxMessagesPerPage, pageToken: pageToken || undefined }),
      (json) => {
        const p = parseHistoryPage(json)
        if (!p.ok) { markIncomplete(p.code); return false }
        pages.push(p)
        return p.nextPageToken
      },
    )
    if (cls && cls.action === 'bounded_resync') {
      // Expired/invalid cursor: redo the BOUNDED initial window, never a full rescan.
      complete = true; incompleteCode = null
      counts.pages = 0; counts.bytes = 0
      mode = 'initial'
      latestHistoryId = null
      log({ event: 'gmail_history_cursor_expired', action: 'bounded_resync' })
    } else if (!complete) {
      return finish('error', incompleteCode, null, false, 300)
    } else {
      const agg = aggregateHistory(pages)
      if (!agg.ok) { markIncomplete(agg.code); return finish('error', agg.code, null, false, 300) }
      removedKeysByThread = agg.removedKeysByThread
      latestHistoryId = agg.latestHistoryId || historyId
      // Every changed thread is re-read as a WHOLE (ids + labels only, format=minimal):
      //   - an episode is classified over the thread's full in-scope context, not just
      //     today's delta (a reply added today to a message synced yesterday must be seen
      //     together with that message, and prior runs retain no metadata by design);
      //   - a thread with only removals must have its REMAINING messages re-classified so
      //     reconciliation keeps episodes that still qualify and invalidates the rest;
      //   - 404 means the whole thread is gone: nothing remains, everything plausible goes.
      for (const threadId of agg.affectedThreads) {
        if (overBudget()) { markIncomplete('runtime_budget_exceeded'); break }
        if (counts.bytes >= caps.maxBytesPerRun) { markIncomplete('max_bytes_exceeded'); break }
        let req
        try { req = buildGetThreadRequest({ threadId }) } catch { markIncomplete('invalid_thread_id'); break }
        const r = await get(urlFor(req), accessToken, caps.maxBytesPerThread)
        threads.add(threadId)
        if (!r.ok) {
          if (r.status === 404) { reconcilable.add(threadId); continue }   // gone: nothing remains
          markIncomplete(r.code === 'response_too_large' ? 'thread_too_large' : 'thread_fetch_failed')
          break
        }
        counts.bytes += r.bytes || 0
        const msgs = Array.isArray(r.json?.messages) ? r.json.messages : []
        let stop = false
        for (const m of msgs) {
          if (!m || typeof m.id !== 'string' || (m.threadId !== undefined && m.threadId !== threadId)) {
            markIncomplete('malformed_thread_entry'); stop = true; break
          }
          // Messages already in TRASH/SPAM are out of scope: they are not "remaining".
          const labels = Array.isArray(m.labelIds) ? m.labelIds : []
          if (labels.some((l) => SCOPE_EXIT_LABELS.includes(l))) continue
          if (!registerRef(m.id, threadId)) { stop = true; break }
        }
        if (stop) break
        reconcilable.add(threadId)
      }
    }
  }

  if (mode === 'initial') {
    // Truthful boundary: the mailbox's CURRENT history id, captured BEFORE the bounded list.
    // Every change after this instant is delivered by the next incremental run (changes
    // that land between this call and the list are simply replayed once - idempotent).
    // Without it a completed initial import would leave history_id NULL and every later run
    // would re-import the window forever, never reaching the History path at all.
    const pr = await get(urlFor(buildGetProfileRequest()), accessToken, caps.maxBytesPerProfile)
    const hid = pr.ok ? pr.json?.historyId : null
    if (typeof hid !== 'string' || hid.length === 0 || hid.length > HISTORY_ID_MAX_LEN || !/^[0-9]+$/.test(hid)) {
      if (!pr.ok) { const cls = classifyHistoryStatus(pr.status); markIncomplete(cls.code) }
      else markIncomplete('profile_malformed')
      return finish('error', incompleteCode, null, false, 300)
    }
    latestHistoryId = hid
    const afterEpochSec = initialWindowStartEpochSec(now(), caps.windowDays)
    await pageLoop(
      (pageToken) => buildInitialListRequest({ afterEpochSec, maxResults: caps.maxMessagesPerPage, pageToken: pageToken || undefined }),
      (json) => {
        const msgs = Array.isArray(json?.messages) ? json.messages : []
        if (msgs.length > caps.maxMessagesPerPage) { markIncomplete('page_over_cap'); return false }
        for (const m of msgs) {
          if (!m || typeof m.id !== 'string' || typeof m.threadId !== 'string') { markIncomplete('malformed_list_entry'); return false }
          if (!registerRef(m.id, m.threadId)) return false
        }
        return typeof json?.nextPageToken === 'string' ? json.nextPageToken : null
      },
    )
  }

  // ── 4. Metadata-only fetch, bounded per message and in concurrency ───────────
  const ids = [...messageRefs.keys()]
  const raws = await mapBounded(ids, caps.maxConcurrency, async (id) => {
    if (overBudget()) { markIncomplete('runtime_budget_exceeded'); return null }
    if (counts.bytes >= caps.maxBytesPerRun) { markIncomplete('max_bytes_exceeded'); return null }
    let req
    try { req = buildGetMetadataRequest({ messageId: id }) } catch { markIncomplete('invalid_message_id'); return null }
    const r = await get(urlFor(req), accessToken, caps.maxBytesPerMessage)
    if (!r.ok) {
      // A message we cannot read safely makes its THREAD incomplete (never eligible).
      markIncomplete(r.code === 'response_too_large' ? 'message_too_large' : 'message_fetch_failed')
      return { __truncatedThread: messageRefs.get(id) }
    }
    counts.messagesFetched += 1
    counts.bytes += r.bytes || 0
    return r.json
  })

  const truncatedThreads = raws.filter((x) => x && x.__truncatedThread).map((x) => x.__truncatedThread)
  const rawMessages = raws.filter((x) => x && !x.__truncatedThread)

  // ── 5. Normalize (adapter) then classify (E1). No logic duplicated here. ─────
  const batch = normalizeGmailBatch(rawMessages, { threadTruncatedKeys: truncatedThreads })
  const part = partitionForClassifier(batch, { transportError: !complete })
  counts.conversations = threads.size
  counts.withheldThreads = part.withheldConversationKeys.length
  if (!part.complete) markIncomplete(incompleteCode || 'incomplete_conversations')

  let classified
  try {
    classified = classify({
      messages: part.classifierMessages,
      contacts, ownedAddresses: [conn.gmailAddress], userId: conn.userId,
      accountNamespace: connectionId, now: now(),
    })
  } catch { markIncomplete('classify_failed'); return finish('error', 'classify_failed', null, false, 300) }
  if (classified && classified.complete === false) markIncomplete('classifier_incomplete')

  // ── 6. Persist eligible candidates (idempotent, key-ring deduped) ────────────
  const keepByThread = Object.create(null)
  for (const res of (classified?.results || [])) {
    if (res.outcome !== 'eligible') continue
    let fpSet
    try { fpSet = await computeFingerprintSet(res.eligible.fingerprintFields) }
    catch { markIncomplete('fingerprint_failed'); continue }
    const lookups = (fpSet.lookupFingerprints || []).slice(0, caps.maxPriorKeys).map((l) => l.fingerprint)
    ;(keepByThread[res.conversationKey] ||= []).push(fpSet.writeFingerprint, ...lookups)
    try {
      const r = await upsertCandidate({
        connectionId, runId, contactId: res.contactId, source: 'gmail',
        fingerprint: fpSet.writeFingerprint, keyVersion: fpSet.writeKeyVersion,
        proposedType: res.eligible.proposedType,
        proposedDate: res.eligible.proposedLocalDate || res.eligible.proposedInstant.slice(0, 10),
        retainedSubject: res.eligible.subjectPreview || null,
        proposedNotes: null,
        lookupFingerprints: lookups,
      })
      const code = r && typeof r === 'object' ? r.result : r
      if (code === 'created') counts.candidatesCreated += 1
      else if (code === 'refreshed') counts.candidatesRefreshed += 1
      else if (code !== 'exists_terminal') markIncomplete('upsert_rejected')
    } catch { markIncomplete('upsert_failed') }
  }

  // ── 7. Reconcile removals (messageDeleted / scope-exit labels) ───────────────
  // Which contacts could hold a candidate for this thread? Classification names them when
  // the thread's remaining messages still involve a contact. When it names NONE (the thread
  // is fully deleted, or the contact's own message was the one removed) the candidate's
  // contact is unknowable without stored provider identifiers - which are deliberately not
  // stored - so every contact of the user is enumerated. Fingerprints that never existed are
  // harmless no-ops in the positive-list RPC.
  const allContactIds = [...new Set((contacts || []).map((c) => c && c.id).filter((id) => typeof id === 'string' && id.length > 0))]
  const unreliable = new Set([...truncatedThreads, ...(part.withheldConversationKeys || [])])
  for (const [threadId, removedKeys] of Object.entries(removedKeysByThread)) {
    // Never reconcile a thread whose remaining messages were not fully read + classified.
    if (!reconcilable.has(threadId) || unreliable.has(threadId)) { markIncomplete('reconcile_skipped'); continue }
    const remainingKeys = [...messageRefs.entries()].filter(([, t]) => t === threadId).map(([id]) => id)
    const classifiedContactIds = [...new Set((classified?.results || [])
      .filter((r) => r.conversationKey === threadId && r.contactId)
      .map((r) => r.contactId))]
    const contactIds = classifiedContactIds.length > 0 ? classifiedContactIds : allContactIds
    if (contactIds.length === 0) continue
    const rec = await resolveReconciliationFingerprints({
      threadId, contactIds, remainingKeys, removedKeys,
      keepFingerprints: keepByThread[threadId] || [],
      maxFingerprints: caps.maxReconcileFingerprintsPerThread,
      computeFingerprint: async ({ conversationKey, contactId, firstMessageKey }) => {
        const s = await computeFingerprintSet({
          provider: 'gmail', accountNamespace: connectionId, contactId, conversationKey, firstMessageKey,
        })
        return s.writeFingerprint
      },
    })
    if (!rec.ok) { markIncomplete(rec.code); continue }
    if (rec.invalidate.length === 0) continue
    // The RPC accepts at most MAX_RECONCILE_FINGERPRINTS per call; chunk, never truncate.
    for (let i = 0; i < rec.invalidate.length; i += MAX_RECONCILE_FINGERPRINTS) {
      const chunk = rec.invalidate.slice(i, i + MAX_RECONCILE_FINGERPRINTS)
      try {
        const r = await invalidateFingerprints({ connectionId, runId, fingerprints: chunk })
        const code = r && typeof r === 'object' ? r.result : r
        if (code !== 'invalidated' && code !== 'noop') { markIncomplete('invalidate_rejected'); break }
        const n = r && typeof r === 'object' ? Number(r.invalidated || 0) : 0
        counts.invalidated += Number.isFinite(n) ? n : 0
      } catch { markIncomplete('invalidate_failed'); break }
    }
  }

  // ── 8. Release. Cursor advances ONLY on a complete run. ──────────────────────
  try { await renew({ connectionId, runId, leaseSeconds: caps.leaseSeconds }) } catch { /* best-effort */ }
  return finish(complete ? 'idle' : 'error', complete ? null : incompleteCode, latestHistoryId, mode === 'initial', complete ? null : 900)
}
