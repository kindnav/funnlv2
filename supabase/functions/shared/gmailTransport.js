// Email integration — Phase E2A: Gmail metadata transport adapter (pure, DI).
//
// Cross-runtime (Node + Deno). No imports except the E1 contract validator. This
// module builds Gmail API REQUESTS and normalizes SYNTHETIC responses into the exact
// E1 NormalizedMessage contract. It makes NO real network call in this phase: the
// caller injects the transport functions. It never logs, never returns provider ids,
// addresses, subjects, tokens, cursors, or raw responses.
//
// PRIVACY INVARIANT: only an allowlist of metadata headers survives normalization.
// Bodies, snippets, payload body data, HTML, attachments, and any non-allowlisted
// header are discarded during normalization and never stored or logged. If a response
// carries payload body DATA (i.e. we somehow got more than metadata), the message is
// REJECTED fail-closed (its thread becomes incomplete) rather than parsed.
//
// COMPLETENESS: the adapter never decides eligibility (that is E1's job). It flags
// threads it could not fully/safely fetch (cap exhaustion, truncation, malformed
// message, cursor gap) as INCOMPLETE. The future worker must exclude incomplete
// threads from the eligible set (partitionForClassifier) and must not advance the
// durable cursor while the run is incomplete.

import { classifyNormalizedMessage } from './emailProviderContract.js'

// ── Google scope (DORMANT — never added to any live/default OAuth scope in E2A) ──
// The metadata scope is the least-privileged read scope. gmail.metadata forbids the
// `q` search parameter, so the initial bounded import needs gmail.readonly (a
// RESTRICTED scope → OAuth verification + annual CASA). This constant is documented
// here for the future capability-aware OAuth phase and is NOT wired to any request.
export const GMAIL_METADATA_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata'
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

// ── Hard caps (bounded transport; fail closed above) ─────────────────────────────
export const INITIAL_WINDOW_DAYS = 90        // recommended initial lookback (see doc §Initial import)
export const MAX_PAGES = 20                  // list/history pages per run
export const MAX_RESULTS_PER_PAGE = 100      // Gmail allows up to 500; kept conservative
export const MAX_MESSAGES = 2000             // hard ceiling across all pages in a run
export const MAX_CONVERSATIONS = 1000        // distinct threads per run
export const MAX_RESPONSE_BYTES = 5_000_000  // 5 MB per page response; over → thread(s) incomplete
export const PAGE_TOKEN_MAX_LEN = 4096
export const HISTORY_ID_MAX_LEN = 256
export const SUBJECT_INPUT_MAX = 998         // matches emailProviderContract MAX_SUBJECT_INPUT

// ── Metadata header allowlist (exact set E1 needs; everything else discarded) ─────
// Lowercased for case-insensitive matching.
export const METADATA_HEADER_ALLOWLIST = Object.freeze([
  'from', 'to', 'cc', 'date', 'message-id',
  'auto-submitted', 'x-auto-response-suppress', 'precedence',
  'list-id', 'list-unsubscribe', 'subject',
])

// PRIVACY NOTE: `snippet` is ALWAYS returned by Gmail even in metadata mode — it is not
// a rejection, but it is never read; it is simply never copied into the normalized output
// (enforced structurally by the header allowlist below). Body DATA presence anywhere in
// the payload IS a fail-closed rejection (payloadCarriesBodyData → 'unexpected_body').

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}
const PROTO_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype'])

// Convert Gmail internalDate (epoch ms as string|number) → ISO-8601 UTC instant.
export function internalDateToIso(internalDate) {
  if (typeof internalDate !== 'string' && typeof internalDate !== 'number') return null
  const ms = Number(internalDate)
  if (!Number.isFinite(ms) || ms < 0 || ms > 4102444800000) return null // sane 1970..2100 bound
  // toISOString() yields an ISO-8601 UTC instant with .fffZ millisecond precision,
  // which E1's isIsoUtcInstant accepts and its numeric sort orders correctly.
  return new Date(ms).toISOString()
}

// Case-insensitive single-header lookup within an allowlisted headers array.
function pickHeader(headers, nameLower) {
  for (const h of headers) {
    if (h && typeof h.name === 'string' && h.name.toLowerCase() === nameLower) {
      return typeof h.value === 'string' ? h.value : ''
    }
  }
  return ''
}
function hasHeader(headers, nameLower) {
  for (const h of headers) {
    if (h && typeof h.name === 'string' && h.name.toLowerCase() === nameLower) return true
  }
  return false
}

// ALL values for a header name (case-insensitive). Security-sensitive automation
// evidence (Precedence, Auto-Submitted) can appear multiple times; we must not let a
// convenient duplicate hide the automated one, so these are resolved across ALL values.
function pickAllHeaders(headers, nameLower) {
  const out = []
  for (const h of headers) {
    if (h && typeof h.name === 'string' && h.name.toLowerCase() === nameLower && typeof h.value === 'string') {
      out.push(h.value)
    }
  }
  return out
}

// Auto-Submitted: ANY non-'no' occurrence marks the message automated (cannot be
// bypassed by an added `Auto-Submitted: no`).
export function resolveAutoSubmitted(values) {
  if (!Array.isArray(values) || values.length === 0) return null
  let sawNo = false
  for (const v of values) {
    const n = normalizeAutoSubmitted(v)
    if (n === null) continue
    if (n !== 'no') return n
    sawNo = true
  }
  return sawNo ? 'no' : null
}

// Precedence: ANY bulk/list/junk occurrence wins (cannot be bypassed by an added
// `Precedence: normal`).
export function resolvePrecedence(values) {
  if (!Array.isArray(values) || values.length === 0) return null
  let sawOther = false
  for (const v of values) {
    const n = normalizePrecedence(v)
    if (n === null) continue
    if (n === 'bulk' || n === 'list' || n === 'junk') return n
    sawOther = true
  }
  return sawOther ? 'other' : null
}

// Allowlisted Auto-Submitted → controlled enum (E1 AutomationFacts).
export function normalizeAutoSubmitted(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const v = value.trim().toLowerCase().split(';')[0].trim()
  if (v === 'no') return 'no'
  if (v === 'auto-generated') return 'auto-generated'
  if (v === 'auto-replied') return 'auto-replied'
  return 'other'
}
// Allowlisted Precedence → controlled enum.
export function normalizePrecedence(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const v = value.trim().toLowerCase()
  if (v === 'bulk') return 'bulk'
  if (v === 'list') return 'list'
  if (v === 'junk') return 'junk'
  return 'other'
}

// Folder/direction hint from label membership only (never header content).
export function folderHintFromLabels(labelIds) {
  if (!Array.isArray(labelIds)) return 'unknown'
  if (labelIds.includes('SENT')) return 'sent'
  if (labelIds.includes('INBOX')) return 'inbox'
  return 'unknown'
}

/**
 * Normalize ONE raw Gmail message (metadata format) into an E1 NormalizedMessage,
 * or return a controlled fail-closed reason. Only allowlisted headers survive.
 * @param {unknown} raw
 * @returns {{ ok: true, message: object } | { ok: false, code: string }}
 */
export function normalizeGmailMessage(raw) {
  if (!isPlainObject(raw)) return { ok: false, code: 'not_object' }
  for (const k of PROTO_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) return { ok: false, code: 'prototype_pollution' }
  }
  const id = raw.id
  const threadId = raw.threadId
  if (typeof id !== 'string' || id.length === 0 || id.length > 1024) return { ok: false, code: 'missing_ids' }
  if (typeof threadId !== 'string' || threadId.length === 0 || threadId.length > 1024) return { ok: false, code: 'missing_ids' }

  const payload = raw.payload
  if (!isPlainObject(payload)) return { ok: false, code: 'no_headers' }

  // Fail closed if we somehow received body DATA (more than metadata).
  if (payloadCarriesBodyData(payload)) return { ok: false, code: 'unexpected_body' }

  const rawHeaders = Array.isArray(payload.headers) ? payload.headers : null
  if (!rawHeaders) return { ok: false, code: 'no_headers' }

  const timestampIso = internalDateToIso(raw.internalDate)
  if (!timestampIso) return { ok: false, code: 'bad_internal_date' }

  const from = pickHeader(rawHeaders, 'from')
  const to = pickHeader(rawHeaders, 'to')
  const cc = pickHeader(rawHeaders, 'cc')
  const subject = pickHeader(rawHeaders, 'subject')

  // Length guards (E1 also enforces, but fail closed early).
  if (from.length > SUBJECT_INPUT_MAX || to.length > SUBJECT_INPUT_MAX ||
      cc.length > SUBJECT_INPUT_MAX || subject.length > SUBJECT_INPUT_MAX) {
    return { ok: false, code: 'oversized_header' }
  }

  const message = {
    provider: 'gmail',
    providerMessageKey: id,
    providerConversationKey: threadId,
    timestampIso,
    fromAddress: from,
    toAddresses: to ? [to] : [],   // single raw header value; E1 splits the mailbox-list
    ccAddresses: cc ? [cc] : [],
    subject,                       // transient; E1 sanitizes/persists only after eligibility
    automation: {
      // Resolved across ALL occurrences so a duplicate header cannot hide automation.
      autoSubmitted: resolveAutoSubmitted(pickAllHeaders(rawHeaders, 'auto-submitted')),
      precedence: resolvePrecedence(pickAllHeaders(rawHeaders, 'precedence')),
      hasListId: hasHeader(rawHeaders, 'list-id'),
      hasListUnsubscribe: hasHeader(rawHeaders, 'list-unsubscribe'),
      hasAutoResponseSuppress: hasHeader(rawHeaders, 'x-auto-response-suppress'),
    },
    folderHint: folderHintFromLabels(raw.labelIds),
  }

  // Defense-in-depth: the normalized object must pass the E1 privacy/structural
  // validator (rejects any prohibited key, bad provider/key/timestamp/addresses).
  if (classifyNormalizedMessage(message) !== null) return { ok: false, code: 'contract_rejected' }
  return { ok: true, message }
}

// True if the payload (or any nested part) carries actual body DATA (not just size).
function payloadCarriesBodyData(node, depth = 0) {
  if (!isPlainObject(node) || depth > 20) return false
  if (isPlainObject(node.body) && typeof node.body.data === 'string' && node.body.data.length > 0) return true
  if (Array.isArray(node.parts)) {
    for (const p of node.parts) {
      if (payloadCarriesBodyData(p, depth + 1)) return true
    }
  }
  return false
}

/**
 * Normalize a batch of raw Gmail messages: dedup by id, collect normalized messages,
 * and flag threads that could not be safely/fully fetched as INCOMPLETE. A message
 * that fails closed marks its thread incomplete (when its threadId is readable).
 * @param {unknown[]} rawList
 * @param {{ threadTruncatedKeys?: string[], pageTruncated?: boolean }} [opts]
 * @returns {{ messages: object[], incompleteConversationKeys: string[], hadUnreadable: boolean,
 *             counts: { input:number, normalized:number, duplicates:number, discarded:number },
 *             byDiscardCode: Record<string,number> }}
 */
export function normalizeGmailBatch(rawList, opts = {}) {
  const list = Array.isArray(rawList) ? rawList : []
  const messages = []
  const seen = new Set()
  const incomplete = new Set()
  const byDiscardCode = Object.create(null)
  let duplicates = 0
  let discarded = 0
  let hadUnreadable = false

  // Threads the caller already knows are truncated (e.g. a get() 404 or a page that
  // hit the byte cap mid-thread) start incomplete.
  for (const t of (Array.isArray(opts.threadTruncatedKeys) ? opts.threadTruncatedKeys : [])) {
    if (typeof t === 'string' && t.length > 0) incomplete.add(t)
  }

  for (const raw of list) {
    let res
    try {
      res = normalizeGmailMessage(raw)
    } catch {
      // A throwing getter/proxy (adversarial input) must fail CLOSED, never crash the
      // batch. We cannot trust any field on such an object (reading threadId might also
      // throw), so it is unattributable: mark the whole run unreadable → incomplete.
      discarded += 1
      hadUnreadable = true
      byDiscardCode.unreadable = (byDiscardCode.unreadable || 0) + 1
      continue
    }
    if (!res.ok) {
      discarded += 1
      byDiscardCode[res.code] = (byDiscardCode[res.code] || 0) + 1
      // If we can read a threadId, that thread is now incomplete (missing/garbled msg).
      let tid = null
      try { tid = isPlainObject(raw) && typeof raw.threadId === 'string' ? raw.threadId : null } catch { tid = null }
      if (tid) incomplete.add(tid); else hadUnreadable = true
      continue
    }
    const key = res.message.providerMessageKey
    if (seen.has(key)) { duplicates += 1; continue } // deterministic cross-page/run dedup
    seen.add(key)
    messages.push(res.message)
  }

  return {
    messages,
    incompleteConversationKeys: [...incomplete],
    hadUnreadable,
    counts: { input: list.length, normalized: messages.length, duplicates, discarded },
    byDiscardCode,
  }
}

/**
 * Split normalized messages so the E1 classifier only ever sees COMPLETE threads.
 * Messages whose thread is incomplete are withheld (they can never become eligible),
 * and the run is complete only when nothing was withheld and no transport error
 * occurred. This is how "incomplete conversations cannot emit eligible" is enforced
 * at the transport→classifier boundary WITHOUT modifying E1.
 * @param {{ messages: object[], incompleteConversationKeys: string[], hadUnreadable?: boolean }} batch
 * @param {{ transportError?: boolean }} [opts]
 * @returns {{ classifierMessages: object[], withheldConversationKeys: string[], complete: boolean }}
 */
export function partitionForClassifier(batch, opts = {}) {
  const incomplete = new Set(Array.isArray(batch?.incompleteConversationKeys) ? batch.incompleteConversationKeys : [])
  const msgs = Array.isArray(batch?.messages) ? batch.messages : []
  const classifierMessages = msgs.filter((m) => !incomplete.has(m.providerConversationKey))
  return {
    classifierMessages,
    withheldConversationKeys: [...incomplete],
    // An unattributable/unreadable item (batch.hadUnreadable) or a transport error makes
    // the run incomplete even if every attributable thread looked clean.
    complete: incomplete.size === 0 && batch?.hadUnreadable !== true && opts.transportError !== true,
  }
}

// ── Request builders (server-derived parameters ONLY; reject caller-controlled) ──

const FORBIDDEN_REQUEST_KEYS = Object.freeze([
  'userId', 'user_id', 'connectionId', 'connection_id', 'googleSub', 'sub',
  'accessToken', 'refreshToken', 'token', 'q', 'query', 'label', 'labelIds',
  'timeWindow', 'window', 'historyId', 'cursor', 'headers', 'metadataHeaders',
])

// Throw if a params object carries any caller-controllable operational key.
function assertNoForbiddenKeys(params) {
  if (!isPlainObject(params)) throw new Error('invalid_params')
  for (const k of PROTO_KEYS) {
    if (Object.prototype.hasOwnProperty.call(params, k)) throw new Error('prototype_pollution')
  }
  for (const k of FORBIDDEN_REQUEST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(params, k)) throw new Error('forbidden_request_param')
  }
}

function boundedMaxResults(n) {
  const v = Number.isInteger(n) ? n : MAX_RESULTS_PER_PAGE
  return Math.min(Math.max(v, 1), MAX_RESULTS_PER_PAGE)
}
function validPageToken(t) {
  return t === undefined || t === null ||
    (typeof t === 'string' && t.length > 0 && t.length <= PAGE_TOKEN_MAX_LEN && /^[\x21-\x7E]+$/.test(t))
}

/**
 * Initial bounded import list request. The `q` is CONSTRUCTED from the bounded window
 * (never accepted from a caller). `afterEpochSec` comes from reserved server state.
 * @param {{ afterEpochSec: number, maxResults?: number, pageToken?: string }} p
 * @returns {{ method:'GET', path:string, query:Record<string,string> }}
 */
export function buildInitialListRequest(p) {
  assertNoForbiddenKeys(p)
  const after = p.afterEpochSec
  if (!Number.isInteger(after) || after < 0 || after > 4102444800) throw new Error('invalid_window')
  if (!validPageToken(p.pageToken)) throw new Error('invalid_page_token')
  const query = {
    // Server-constructed query: bounded recency, exclude chats. No user input.
    q: `after:${after} -in:chats`,
    maxResults: String(boundedMaxResults(p.maxResults)),
    includeSpamTrash: 'false',
  }
  if (p.pageToken) query.pageToken = p.pageToken
  return { method: 'GET', path: '/gmail/v1/users/me/messages', query }
}

/**
 * Incremental History API request (after initial import). startHistoryId comes from
 * reserved sync-state, never a caller.
 * @param {{ startHistoryId: string, maxResults?: number, pageToken?: string }} p
 */
export function buildHistoryRequest(p) {
  assertNoForbiddenKeys(p)
  if (typeof p.startHistoryId !== 'string' || p.startHistoryId.length === 0 ||
      p.startHistoryId.length > HISTORY_ID_MAX_LEN || !/^[0-9]+$/.test(p.startHistoryId)) {
    throw new Error('invalid_history_id')
  }
  if (!validPageToken(p.pageToken)) throw new Error('invalid_page_token')
  const query = {
    startHistoryId: p.startHistoryId,
    historyTypes: 'messageAdded',
    maxResults: String(boundedMaxResults(p.maxResults)),
  }
  if (p.pageToken) query.pageToken = p.pageToken
  return { method: 'GET', path: '/gmail/v1/users/me/history', query }
}

/**
 * Metadata-only get request for one message id (from reserved list/history results).
 * Requests format=metadata and ONLY the allowlisted headers.
 * @param {{ messageId: string }} p
 */
export function buildGetMetadataRequest(p) {
  assertNoForbiddenKeys(p)
  if (typeof p.messageId !== 'string' || p.messageId.length === 0 || p.messageId.length > 1024 ||
      !/^[A-Za-z0-9_-]+$/.test(p.messageId)) {
    throw new Error('invalid_message_id')
  }
  return {
    method: 'GET',
    path: `/gmail/v1/users/me/messages/${p.messageId}`,
    query: {
      format: 'metadata',
      // metadataHeaders repeated per allowlisted header — nothing else is requested.
      metadataHeaders: METADATA_HEADER_ALLOWLIST.slice(),
    },
  }
}

/**
 * Recommended initial lookback window start (epoch seconds) for a given "now".
 * @param {number} nowMs
 * @param {number} [windowDays]
 */
export function initialWindowStartEpochSec(nowMs, windowDays = INITIAL_WINDOW_DAYS) {
  const days = Number.isInteger(windowDays) && windowDays > 0 ? windowDays : INITIAL_WINDOW_DAYS
  return Math.floor((nowMs - days * 86_400_000) / 1000)
}

// Enforce per-run accumulation caps. Returns a controlled reason when a cap is hit
// (the run must stop, mark incomplete, and NOT advance the cursor), else null.
export function checkRunCaps({ pages, messages, conversations, pageBytes }) {
  if (Number.isFinite(pageBytes) && pageBytes > MAX_RESPONSE_BYTES) return 'response_too_large'
  if (Number.isInteger(pages) && pages > MAX_PAGES) return 'max_pages_exceeded'
  if (Number.isInteger(messages) && messages > MAX_MESSAGES) return 'max_messages_exceeded'
  if (Number.isInteger(conversations) && conversations > MAX_CONVERSATIONS) return 'max_conversations_exceeded'
  return null
}

// ── Capability scope helper (DORMANT — for the future capability-aware OAuth phase) ──
// Pure predicate: does a granted-scope string include a usable Gmail read scope?
// gmail.readonly implies metadata access; gmail.metadata is metadata-only. This is NOT
// called by any Edge Function in E2A and no live/default OAuth request requests either
// scope. It exists so the future Gmail-connect callback can validate the returned grant
// the same way grantedScopesIncludeCalendar does today.
export function grantedScopesIncludeGmail(scopeString) {
  if (typeof scopeString !== 'string' || scopeString.length === 0) return false
  const scopes = scopeString.split(' ').filter(Boolean)
  return scopes.includes(GMAIL_READONLY_SCOPE) || scopes.includes(GMAIL_METADATA_SCOPE)
}
