// Email integration — Phase E2B: Gmail History incremental parsing + reconciliation (pure).
//
// Cross-runtime (Node + Deno). No network, no DB, no env, no logging. Returns controlled
// codes and opaque provider KEYS only — never an address, subject, body, or raw response.
//
// WHY RECOMPUTED FINGERPRINTS (important design note):
//   email_candidate_refs deliberately stores NO thread id and NO message id, so given a
//   deleted Gmail message we cannot look its candidates up by thread. We do not need to:
//   the E1 fingerprint is DETERMINISTIC over
//     (format, keyVersion, provider, accountNamespace, contactId, conversationKey,
//      firstMessageKey)
//   so the worker can RECOMPUTE the exact fingerprint of any episode it can name. An
//   episode is named by (threadId, contactId, boundaryKey). After a change we recompute the
//   KEEP set from the thread's remaining messages, enumerate every PLAUSIBLE boundary
//   (remaining keys ∪ removed keys — the removed key matters because deleting an episode's
//   FIRST message removes exactly that boundary), and invalidate every plausible
//   fingerprint that is not in the keep set. Invalidating a fingerprint that never existed
//   is a harmless no-op: invalidate_email_candidates_by_fingerprint only touches existing
//   PENDING rows for that connection.

// Labels whose ADDITION takes a message OUT of the synchronized mail scope. Archiving
// (removing INBOX) deliberately does NOT count — an archived thread is still a real past
// conversation and must keep its suggestion. Only trash/spam remove a message from scope.
export const SCOPE_EXIT_LABELS = Object.freeze(['TRASH', 'SPAM'])

// Bounded history processing.
export const MAX_HISTORY_PAGES = 20
export const MAX_HISTORY_RECORDS = 5000
export const MAX_AFFECTED_THREADS = 500
export const MAX_BOUNDARY_KEYS_PER_THREAD = 200
export const MAX_RECONCILE_FINGERPRINTS = 500   // matches the RPC's own bound

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const p = Object.getPrototypeOf(v)
  return p === Object.prototype || p === null
}
const PROTO_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype'])
function looksPolluted(o) {
  for (const k of PROTO_KEYS) if (Object.prototype.hasOwnProperty.call(o, k)) return true
  return false
}
const okKey = (s) => typeof s === 'string' && s.length > 0 && s.length <= 1024

// Pull {id, threadId} out of a history entry's nested `message`, defensively.
function msgRef(node) {
  if (!isPlainObject(node)) return null
  const m = isPlainObject(node.message) ? node.message : null
  if (!m) return null
  if (!okKey(m.id) || !okKey(m.threadId)) return null
  return { id: m.id, threadId: m.threadId }
}
function labelList(node) {
  if (!isPlainObject(node) || !Array.isArray(node.labelIds)) return []
  return node.labelIds.filter((l) => typeof l === 'string' && l.length <= 128)
}

/**
 * Parse ONE users.history.list page into controlled change sets. Fails closed.
 * @param {unknown} raw
 * @returns {{ ok:true, added:{id:string,threadId:string}[], removed:{id:string,threadId:string}[],
 *             restored:{id:string,threadId:string}[], historyId:string|null,
 *             nextPageToken:string|null, records:number }
 *          | { ok:false, code:string }}
 */
export function parseHistoryPage(raw) {
  if (!isPlainObject(raw)) return { ok: false, code: 'not_object' }
  if (looksPolluted(raw)) return { ok: false, code: 'prototype_pollution' }

  const history = Array.isArray(raw.history) ? raw.history : []
  if (history.length > MAX_HISTORY_RECORDS) return { ok: false, code: 'history_too_large' }

  const added = []
  const removed = []
  const restored = []

  for (const h of history) {
    if (!isPlainObject(h) || looksPolluted(h)) return { ok: false, code: 'malformed_history_record' }

    for (const a of (Array.isArray(h.messagesAdded) ? h.messagesAdded : [])) {
      const r = msgRef(a); if (r) added.push(r)
    }
    // Permanent deletion removes the message from scope.
    for (const d of (Array.isArray(h.messagesDeleted) ? h.messagesDeleted : [])) {
      const r = msgRef(d); if (r) removed.push(r)
    }
    // labelsAdded TRASH/SPAM => left the synchronized scope (treated like a deletion).
    for (const la of (Array.isArray(h.labelsAdded) ? h.labelsAdded : [])) {
      const r = msgRef(la); if (!r) continue
      if (labelList(la).some((l) => SCOPE_EXIT_LABELS.includes(l))) removed.push(r)
    }
    // labelsRemoved TRASH/SPAM => restored INTO scope; must be re-evaluated, not invalidated.
    for (const lr of (Array.isArray(h.labelsRemoved) ? h.labelsRemoved : [])) {
      const r = msgRef(lr); if (!r) continue
      if (labelList(lr).some((l) => SCOPE_EXIT_LABELS.includes(l))) restored.push(r)
    }
  }

  const historyId = okKey(raw.historyId) && /^[0-9]+$/.test(raw.historyId) ? raw.historyId : null
  const nextPageToken = okKey(raw.nextPageToken) ? raw.nextPageToken : null
  return { ok: true, added, removed, restored, historyId, nextPageToken, records: history.length }
}

/**
 * Aggregate parsed pages into the work the run must perform.
 * @param {Array<ReturnType<typeof parseHistoryPage>>} pages
 * @returns {{ ok:true, affectedThreads:string[], removedKeysByThread:Record<string,string[]>,
 *             addedKeysByThread:Record<string,string[]>, latestHistoryId:string|null }
 *          | { ok:false, code:string }}
 */
export function aggregateHistory(pages) {
  const list = Array.isArray(pages) ? pages : []
  const removedByThread = Object.create(null)
  const addedByThread = Object.create(null)
  const threads = new Set()
  let latestHistoryId = null

  for (const p of list) {
    if (!p || p.ok !== true) return { ok: false, code: (p && p.code) || 'malformed_history_page' }
    for (const r of p.added.concat(p.restored)) {
      threads.add(r.threadId)
      ;(addedByThread[r.threadId] ||= []).push(r.id)
    }
    for (const r of p.removed) {
      threads.add(r.threadId)
      ;(removedByThread[r.threadId] ||= []).push(r.id)
    }
    if (p.historyId) latestHistoryId = p.historyId
  }

  if (threads.size > MAX_AFFECTED_THREADS) return { ok: false, code: 'too_many_affected_threads' }
  return {
    ok: true,
    affectedThreads: [...threads].sort(),
    removedKeysByThread: removedByThread,
    addedKeysByThread: addedByThread,
    latestHistoryId,
  }
}

/**
 * Every boundary key an episode in this thread could plausibly have had, bounded and
 * deterministic. Remaining keys cover episodes whose first message still exists; removed
 * keys cover the episode whose FIRST message was the one deleted.
 * @param {string[]} remainingKeys
 * @param {string[]} removedKeys
 * @returns {string[]}
 */
export function plausibleBoundaryKeys(remainingKeys, removedKeys) {
  const set = new Set()
  for (const k of (Array.isArray(remainingKeys) ? remainingKeys : [])) if (okKey(k)) set.add(k)
  for (const k of (Array.isArray(removedKeys) ? removedKeys : [])) if (okKey(k)) set.add(k)
  return [...set].sort().slice(0, MAX_BOUNDARY_KEYS_PER_THREAD)
}

/**
 * Decide exactly which fingerprints to invalidate for ONE affected thread.
 *
 * keepFingerprints = fingerprints of the episodes that STILL qualify after the change
 * (computed by re-classifying the thread's remaining messages through E1). Everything
 * plausible that is not kept is invalidated.
 *
 * @param {{
 *   threadId: string,
 *   contactIds: string[],
 *   remainingKeys: string[],
 *   removedKeys: string[],
 *   keepFingerprints: string[],
 *   computeFingerprint: (fields:{conversationKey:string,contactId:string,firstMessageKey:string}) => Promise<string>,
 * }} args
 * @returns {Promise<{ ok:true, invalidate:string[] } | { ok:false, code:string }>}
 */
export async function resolveReconciliationFingerprints(args) {
  const {
    threadId, contactIds, remainingKeys, removedKeys, keepFingerprints, computeFingerprint,
    // The worker chunks the invalidate RPC (500 per call), so it may allow more plausible
    // fingerprints per thread than a single RPC accepts. Default keeps the RPC bound.
    maxFingerprints = MAX_RECONCILE_FINGERPRINTS,
  } = args || {}
  if (!okKey(threadId)) return { ok: false, code: 'invalid_thread' }
  if (!Array.isArray(contactIds) || typeof computeFingerprint !== 'function') {
    return { ok: false, code: 'invalid_args' }
  }
  const cap = Number.isInteger(maxFingerprints) && maxFingerprints > 0 ? maxFingerprints : MAX_RECONCILE_FINGERPRINTS
  const keep = new Set(Array.isArray(keepFingerprints) ? keepFingerprints : [])
  const boundaries = plausibleBoundaryKeys(remainingKeys, removedKeys)
  const out = new Set()

  for (const contactId of contactIds) {
    if (typeof contactId !== 'string' || contactId.length === 0) continue
    for (const firstMessageKey of boundaries) {
      let fp
      try {
        fp = await computeFingerprint({ conversationKey: threadId, contactId, firstMessageKey })
      } catch {
        return { ok: false, code: 'fingerprint_failed' }
      }
      if (typeof fp !== 'string' || !/^[0-9a-f]{64}$/.test(fp)) return { ok: false, code: 'fingerprint_invalid' }
      if (!keep.has(fp)) out.add(fp)
      if (out.size > cap) return { ok: false, code: 'too_many_fingerprints' }
    }
  }
  return { ok: true, invalidate: [...out].sort() }
}

/**
 * Classify a Gmail history fetch failure. A 404 means the supplied startHistoryId is too
 * old/invalid: per the Gmail API a full sync is then required, which for Funnl means the
 * BOUNDED 90-day initial import — never an unbounded full-mailbox rescan.
 * @param {number} status
 * @returns {{ action:'proceed'|'bounded_resync'|'retry'|'reauth'|'fail', code:string }}
 */
export function classifyHistoryStatus(status) {
  if (status === 200) return { action: 'proceed', code: 'ok' }
  if (status === 404) return { action: 'bounded_resync', code: 'history_cursor_expired' }
  if (status === 401) return { action: 'reauth', code: 'unauthorized' }
  if (status === 403) return { action: 'reauth', code: 'forbidden_or_scope_revoked' }
  if (status === 429) return { action: 'retry', code: 'rate_limited' }
  if (status >= 500) return { action: 'retry', code: 'provider_unavailable' }
  return { action: 'fail', code: 'provider_error' }
}
