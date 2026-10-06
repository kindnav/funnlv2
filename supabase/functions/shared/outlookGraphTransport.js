// Outlook PR-B — bounded, read-only Microsoft Graph transport (pure + DI).
//
// Cross-runtime (Node + Deno). NO live caller exists in this phase: `fetchImpl` is
// dependency-injected and every test supplies a fake. This module makes no request on
// import, holds no secret, and reads no environment variable.
//
// ── PERMISSION POSTURE ────────────────────────────────────────────────────────
// Every request this module can build is a READ of the signed-in user's own mail and
// is satisfied by delegated `Mail.Read` (the scope pinned by
// microsoft_connections_scopes_allowlist in 20260921000000). There is deliberately NO
// builder for: send / reply / forward / createReply, PATCH or DELETE of anything,
// move/copy, mailFolder mutation, attachments, `$value` (raw MIME), mailboxSettings,
// contacts, calendars, events, drive/files, users directory, or any /users/{id} path.
// Only `/me/...` paths are reachable. See ALLOWED_PATH_RE and the test suite.
//
// ── TWO-STAGE MINIMIZATION (the core privacy property) ────────────────────────
// DISCOVERY (`buildFolderDeltaRequest` / `buildFollowLinkRequest`) exists only to learn
// WHICH messages changed and to carry the opaque paging/delta state. It selects
// envelope metadata only — no body, no bodyPreview, no uniqueBody, and no
// internetMessageHeaders. Deterministic screening (outlookParticipants.js) runs on that
// metadata alone and decides whether a bounded per-message read is warranted.
//
// CONTENT (`buildMessageContentRequest`) is issued ONLY for messages that survived
// screening, and returns the content AND the automation headers in ONE request, so
// there is never a second header-only round trip.
//
// So a mailbox message that is a newsletter, an automated notification, a CC-only
// mention, or an exchange with nobody relevant NEVER has its body fetched at all.
//
// Headers are deliberately NOT requested on delta: Microsoft documents
// `internetMessageHeaders` as a property selected on a message GET, and building the
// automation-detection path on its surviving a delta projection would leave a provider
// behaviour unverified until the first real mailbox run. It is read where it is
// documented to work, and it is reduced to controlled booleans immediately.
//
// ── LOGGING INVARIANT ─────────────────────────────────────────────────────────
// This module never calls console.*, never returns a provider response body on an
// error path, and never returns or embeds an access token, a paging/delta URL, an
// email address, a subject, or message content in any error/result code. Paging and
// delta URLs are especially sensitive: their query strings carry opaque provider state
// tokens ($skiptoken / $deltatoken), so they are treated as opaque secrets — validated,
// passed through, never logged, never returned in a diagnostic.

// The header classifier lives with the payload contract (outlookMessageNormalize.js);
// that module imports nothing from here, so this direction introduces no cycle.
import { readJsonBounded } from './boundedJson.js'
import { automationFactsFromHeaders } from './outlookMessageNormalize.js'

export const GRAPH_ORIGIN = 'https://graph.microsoft.com'
export const GRAPH_HOST = 'graph.microsoft.com'
export const GRAPH_API_VERSION = 'v1.0'
export const GRAPH_BASE = `${GRAPH_ORIGIN}/${GRAPH_API_VERSION}`

// The single delegated scope this transport requires. Mirrors the CHECK constraint
// `microsoft_connections_active_requires_mail_read` in 20260921000000.
export const GRAPH_MAIL_READ_SCOPE = 'Mail.Read'

// The only two well-known folders a run reads. Mirrors `oss_folder_check`
// (outlook_sync_state.folder IN ('inbox','sentitems')).
export const GRAPH_FOLDERS = Object.freeze(['inbox', 'sentitems'])

// ── Bounds (fail closed above every one of these) ─────────────────────────────
export const MAX_PAGE_SIZE = 50            // Prefer: odata.maxpagesize
export const MAX_PAGES_PER_RUN = 20        // delta pages followed in one run
export const MAX_MESSAGES_PER_RUN = 500    // hard ceiling across all pages
export const MAX_CONTENT_FETCHES_PER_RUN = 120 // stage-2 body reads per run
export const MAX_RESPONSE_BYTES = 4_000_000    // one page/response ceiling

/**
 * Ceiling for a NON-200 body, which is read only to recover Graph's controlled
 * `error.code` token.
 *
 * Far below MAX_RESPONSE_BYTES on purpose. That bound exists because a successful
 * delta page legitimately carries hundreds of messages; an error payload carries a
 * code, a message and a request id. Reusing the page bound would mean buffering up
 * to 4 MB to find a token that is never more than a few dozen characters - which is
 * exactly what an oversized error body exploited: 4,100,048 bytes were read before
 * anything refused them.
 */
export const MAX_ERROR_BODY_BYTES = 64 * 1024
export const MAX_BODY_CHARS = 200_000      // raw body chars accepted before sanitizing
export const MAX_RETRIES = 3               // per request (so at most 4 attempts)
export const MAX_RETRY_AFTER_MS = 30_000   // one honored Retry-After is capped here
export const MAX_TOTAL_RETRY_DELAY_MS = 60_000 // summed sleep across all retries
export const REQUEST_TIMEOUT_MS = 20_000   // per attempt
export const MAX_FOLLOW_LINK_LEN = 8192    // nextLink/deltaLink ceiling

// ── $select allowlists (nothing outside these is ever requested) ──────────────
//
// DISCOVERY (delta): the minimum needed to decide whether a bounded per-message read
// is warranted — who the message is between, when, and whether it is a draft.
// `body`, `bodyPreview`, `uniqueBody` AND `internetMessageHeaders` are deliberately
// ABSENT. Microsoft documents internetMessageHeaders as a property you select on a
// message GET; relying on it surviving a delta projection would make the whole
// automation-detection path depend on unverified provider behaviour. It is fetched on
// the per-message GET instead, where it is documented to work.
export const DISCOVERY_SELECT = Object.freeze([
  'id',
  'conversationId',
  'receivedDateTime',
  'sentDateTime',
  'isDraft',
  'subject',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
])

// Back-compat alias: this projection is the message ENVELOPE, and the discovery stage
// is the only place it is requested.
export const ENVELOPE_SELECT = DISCOVERY_SELECT

// CONTENT (per-message GET): one bounded read that returns the content AND the headers
// together, so no second header-only round trip is ever needed. `conversationId` is
// required by the episode fingerprint contract; `internetMessageId` is NOT used by any
// contract and is therefore not requested.
export const CONTENT_SELECT = Object.freeze([
  'id',
  'conversationId',
  'receivedDateTime',
  'sentDateTime',
  'subject',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'uniqueBody',
  'body',
  'internetMessageHeaders',
])

// Exact Prefer header value that asks Graph for plain text. Graph echoes
// `Preference-Applied: outlook.body-content-type="text"` when honored, and MAY still
// return HTML (contentType:'html') — the sanitizer must tolerate that.
export const PREFER_TEXT_BODY = 'outlook.body-content-type="text"'
export const PREFER_MAX_PAGE_SIZE = (n) => `odata.maxpagesize=${n}`

// IMMUTABLE IDS, and this header is the whole mechanism.
//
// Outlook item ids are NOT stable by default: per Microsoft, "their IDs change ...
// only if the item is moved". A round can span pages, invocations and hours, so an
// id recorded on page 1 can be dead by the time the round is finalized and the
// body is fetched - the user only has to move the message.
//
// Opting in: "your application needs to send an additional HTTP header in your API
// requests: Prefer: IdType="ImmutableId"". After that "an item's immutable ID won't
// change so long as the item stays in the same mailbox ... immutable ID will NOT
// change if the item is moved to a different folder in the mailbox."
//
// IT STILL CHANGES if the user moves the item to an ARCHIVE mailbox, or exports and
// re-imports it. Those are real but bounded failure modes and they surface as a
// failed fetch, which DEFERS the conversation rather than guessing.
//
// SAFE FOR THE CURSORS WE ALREADY HAVE: "The @odata.nextLink and @odata.deltaLink
// values returned by delta queries are compatible with both ID formats, so your
// application doesn't need to re-synchronize." So adding this does not invalidate
// the committed delta links of the live pilot connection.
//
// THE HEADER IS PER REQUEST - "This header only applies to the request it is
// included with. If you want to always use immutable IDs, you must include this
// header with every API request." - so it is attached to the delta request, every
// follow-link request AND the content request. Omitting it from any one of them
// would mix id formats across a round.
export const PREFER_IMMUTABLE_ID = 'IdType="ImmutableId"'

// RFC 7240 allows several preferences in one header, comma separated, which is how
// Graph's own examples combine them.
const preferAll = (...parts) => parts.filter(Boolean).join(', ')

// Controlled result codes. These are the ONLY strings this module returns on failure.
export const GRAPH_CODES = Object.freeze([
  'ok', 'unauthorized', 'forbidden', 'not_found', 'throttled', 'server_error',
  'timeout', 'invalid_link', 'response_too_large', 'malformed_response',
  'retry_exhausted', 'cursor_invalid', 'message_gone', 'unexpected_redirect',
  'bad_request', 'transport_failure',
  // The invocation had no room for this attempt, or for the backoff plus the attempt
  // after it. Not a provider outcome: nothing was requested, or nothing further was.
  'budget_exhausted',
])

// Graph error codes that mean the stored delta state can no longer be used. Compared
// case-insensitively. A 400 can carry one of these, so the CODE is checked before the
// status is interpreted.
export const CURSOR_INVALID_ERROR_CODES = Object.freeze([
  'syncstatenotfound', 'resyncrequired', 'syncstatenotsupported', 'synchronizationstateexpired',
])

/**
 * True when a run must stop and NOT advance its stored delta cursor.
 * This module never erases, rewrites or resets a cursor: that is a stateful decision
 * belonging to the future worker, which must perform an explicitly bounded reset.
 */
export function isCursorInvalid(code) {
  return code === 'cursor_invalid'
}

/** True when one message vanished mid-run; the run continues without it. */
export function isSkippableMessageFailure(code) {
  return code === 'message_gone'
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}
const PROTO_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype'])

function assertSafeParams(p) {
  if (!isPlainObject(p)) throw new Error('invalid_params')
  for (const k of PROTO_KEYS) {
    if (Object.prototype.hasOwnProperty.call(p, k)) throw new Error('prototype_pollution')
  }
}

// ── Request builders ──────────────────────────────────────────────────────────
// Every builder returns a DESCRIPTOR. It performs no I/O. `executeGraphRequest`
// turns a descriptor into a real call using an injected fetch.

/**
 * Stage 1 — initial/again-from-scratch delta read of one well-known folder.
 * Envelope metadata only; no body is requested or returned.
 * @param {{ folder:'inbox'|'sentitems', pageSize?:number }} p
 * @returns {{ method:'GET', url:string, headers:Record<string,string>, stage:'envelope' }}
 */
export function buildFolderDeltaRequest(p) {
  assertSafeParams(p)
  if (!GRAPH_FOLDERS.includes(p.folder)) throw new Error('invalid_folder')
  const size = boundedPageSize(p.pageSize)
  const url = `${GRAPH_BASE}/me/mailFolders/${p.folder}/messages/delta` +
    `?$select=${DISCOVERY_SELECT.join(',')}`
  return {
    method: 'GET',
    url,
    headers: { Prefer: preferAll(PREFER_MAX_PAGE_SIZE(size), PREFER_IMMUTABLE_ID) },
    stage: 'envelope',
  }
}

/**
 * Stage 1 continuation — follow an opaque @odata.nextLink / @odata.deltaLink.
 * The link is VALIDATED (origin, path, no credentials, no fragment) and then treated
 * as opaque: its query string carries provider state and is never parsed or logged.
 * @param {{ link:string, pageSize?:number }} p
 * @returns {{ method:'GET', url:string, headers:Record<string,string>, stage:'envelope' }}
 */
export function buildFollowLinkRequest(p) {
  assertSafeParams(p)
  const v = validateGraphFollowLink(p.link)
  if (!v.ok) throw new Error(`invalid_link:${v.code}`)
  return {
    method: 'GET',
    url: v.url,
    headers: {
      Prefer: preferAll(PREFER_MAX_PAGE_SIZE(boundedPageSize(p.pageSize)), PREFER_IMMUTABLE_ID),
    },
    stage: 'envelope',
  }
}

/**
 * Stage 2 — content read for ONE message that already qualified on metadata alone.
 * Selects only id/body/uniqueBody and asks for text. `uniqueBody` is Graph's own
 * "this message without the quoted conversation history" projection, which is exactly
 * the current-message content the drafts feature needs.
 * @param {{ messageId:string }} p
 */
export function buildMessageContentRequest(p) {
  assertSafeParams(p)
  if (!isUsableGraphId(p.messageId)) throw new Error('invalid_message_id')
  const url = `${GRAPH_BASE}/me/messages/${encodeURIComponent(p.messageId)}` +
    `?$select=${CONTENT_SELECT.join(',')}`
  return {
    method: 'GET',
    url,
    headers: { Prefer: preferAll(PREFER_TEXT_BODY, PREFER_IMMUTABLE_ID) },
    stage: 'content',
  }
}

function boundedPageSize(n) {
  const v = Number.isInteger(n) ? n : MAX_PAGE_SIZE
  return Math.min(Math.max(v, 1), MAX_PAGE_SIZE)
}

/**
 * Graph message/folder ids are long opaque base64url-ish strings. Conservative shape
 * check — rejects control characters, whitespace, path separators and traversal.
 * @param {unknown} id
 */
export function isUsableGraphId(id) {
  if (typeof id !== 'string') return false
  if (id.length === 0 || id.length > 1024) return false
  return /^[A-Za-z0-9_\-=+/.:]+$/.test(id) && !id.includes('..')
}

// ── Follow-link validation ────────────────────────────────────────────────────
// Graph returns nextLink/deltaLink in two observed path spellings:
//   /v1.0/me/mailFolders/{id}/messages/delta?$skiptoken=...
//   /v1.0/me/mailfolders('{id}')/messages/delta?$deltatoken=...
// Both are accepted; anything else is refused. The path must end at `/messages/delta`,
// so a returned link can never redirect the run at attachments, $value, another user's
// mailbox, or a non-mail resource.
const ALLOWED_PATH_RE =
  /^\/v1\.0\/me\/mailfolders(?:\/[A-Za-z0-9_\-=+.%]+|\('[A-Za-z0-9_\-=+.%]+'\))\/messages\/delta$/i

// Paths that must never be reachable even if they somehow matched above.
const FORBIDDEN_PATH_FRAGMENT_RE =
  /(\$value|\/attachments|\/send|\/reply|\/forward|\/move|\/copy|\/users\/|\/contacts|\/calendar|\/events|\/drive|\/mailboxsettings)/i

// Control characters, DEL and whitespace smuggled into a link. Built from an escaped
// string so this source file stays pure ASCII (a class literal would embed real
// control bytes in the file itself).
// eslint-disable-next-line no-control-regex
const ILLEGAL_LINK_CHARS_RE = new RegExp('[\\u0000-\\u001F\\u007F\\s]')

/**
 * Validate an @odata.nextLink / @odata.deltaLink before it is followed.
 * Returns the ORIGINAL url string on success (opaque pass-through, never rewritten),
 * or a controlled code. NEVER echoes the link in the failure result.
 * @param {unknown} link
 * @returns {{ ok:true, url:string } | { ok:false, code:string }}
 */
export function validateGraphFollowLink(link) {
  if (typeof link !== 'string' || link.length === 0) return { ok: false, code: 'not_a_string' }
  if (link.length > MAX_FOLLOW_LINK_LEN) return { ok: false, code: 'too_long' }
  // Control characters / whitespace smuggling.
  // eslint-disable-next-line no-control-regex
  if (ILLEGAL_LINK_CHARS_RE.test(link)) return { ok: false, code: 'illegal_characters' }
  let u
  try { u = new URL(link) } catch { return { ok: false, code: 'unparseable' } }
  if (u.protocol !== 'https:') return { ok: false, code: 'not_https' }
  if (u.username !== '' || u.password !== '') return { ok: false, code: 'credentials_present' }
  if (u.hostname.toLowerCase() !== GRAPH_HOST) return { ok: false, code: 'wrong_host' }
  if (u.port !== '') return { ok: false, code: 'explicit_port' }
  if (u.hash !== '') return { ok: false, code: 'fragment_present' }
  if (FORBIDDEN_PATH_FRAGMENT_RE.test(u.pathname)) return { ok: false, code: 'forbidden_path' }
  if (!ALLOWED_PATH_RE.test(u.pathname)) return { ok: false, code: 'unexpected_path' }
  // A follow link must carry provider state; a bare delta path is not a continuation.
  if (!/[?&]\$(skiptoken|deltatoken)=/i.test(u.search)) return { ok: false, code: 'missing_state_token' }
  return { ok: true, url: link }
}

// ── Retry policy ──────────────────────────────────────────────────────────────

/** Statuses that may be retried at all. 429 and transient 5xx only. */
export function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

/**
 * Parse a Retry-After header value (delta-seconds only; an HTTP-date is ignored in
 * favour of backoff) and clamp it. Graph documents seconds for 429.
 * @param {unknown} value
 * @returns {number|null} milliseconds, or null when unusable
 */
export function parseRetryAfterMs(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const s = String(value).trim()
  if (!/^\d{1,6}$/.test(s)) return null
  const ms = Number(s) * 1000
  if (!Number.isFinite(ms) || ms < 0) return null
  return Math.min(ms, MAX_RETRY_AFTER_MS)
}

/**
 * Backoff for attempt n (0-based) when no usable Retry-After is present. Graph's
 * guidance is to honor Retry-After when given and otherwise back off exponentially.
 * Deterministic (no jitter) so the bound is provable in tests.
 */
export function backoffMs(attempt) {
  const n = Number.isInteger(attempt) && attempt >= 0 ? attempt : 0
  return Math.min(1000 * Math.pow(2, n), MAX_RETRY_AFTER_MS)
}

/**
 * Decide whether another attempt is allowed and how long to wait first.
 * Enforces BOTH the attempt cap and the cumulative delay cap, so a provider that
 * keeps answering `Retry-After: 30` can never hold a run open indefinitely.
 * @returns {{ retry:true, delayMs:number } | { retry:false, code:string }}
 */
export function planRetry({ status, retryAfterHeader, attempt, elapsedRetryMs }) {
  if (!isRetryableStatus(status)) return { retry: false, code: statusToCode(status) }
  // When the budget runs out the code still names the PROVIDER CONDITION (throttled /
  // server_error) rather than the generic 'retry_exhausted', because that is what the
  // worker needs in order to set the connection's next_retry_at sensibly. The
  // `exhausted` flag preserves the distinction for diagnostics.
  if (!Number.isInteger(attempt) || attempt >= MAX_RETRIES) {
    return { retry: false, code: statusToCode(status), exhausted: true }
  }
  const spent = Number.isFinite(elapsedRetryMs) && elapsedRetryMs > 0 ? elapsedRetryMs : 0
  const wait = parseRetryAfterMs(retryAfterHeader) ?? backoffMs(attempt)
  if (spent + wait > MAX_TOTAL_RETRY_DELAY_MS) {
    return { retry: false, code: statusToCode(status), exhausted: true }
  }
  return { retry: true, delayMs: wait }
}

/**
 * Map an HTTP status (and, when present, Graph's own error CODE) to a controlled
 * result. Never includes a provider message, body, URL or identifier.
 *
 * Stage matters: a 404/410 on a per-message GET means that one message disappeared
 * between discovery and the content read, which must NOT fail the whole run. The same
 * status on a discovery request is about the delta state itself.
 *
 * @param {{ status:number, errorCode?:string|null, stage?:'envelope'|'content' }} p
 */
export function classifyFailure({ status, errorCode, stage }) {
  // Graph can report unusable delta state with a 400 as well as a 410, so the error
  // CODE is authoritative and is checked first.
  if (typeof errorCode === 'string' &&
      CURSOR_INVALID_ERROR_CODES.includes(errorCode.trim().toLowerCase())) {
    return 'cursor_invalid'
  }
  if (status === 401) return 'unauthorized'          // token expired/revoked → reauth
  if (status === 403) return 'forbidden'             // consent or permission missing
  if (status === 404) return stage === 'content' ? 'message_gone' : 'not_found'
  if (status === 410) return stage === 'content' ? 'message_gone' : 'cursor_invalid'
  if (status === 429) return 'throttled'
  if (status === 400) return 'bad_request'
  if (typeof status === 'number' && status >= 300 && status < 400) return 'unexpected_redirect'
  if (typeof status === 'number' && status >= 500) return 'server_error'
  return 'transport_failure'
}

/** Status-only convenience wrapper (discovery stage, no provider error code). */
export function statusToCode(status) {
  return classifyFailure({ status, errorCode: null, stage: 'envelope' })
}

/**
 * Pull ONLY Graph's controlled `error.code` token out of an error payload.
 * The message, inner error, request id and every other field are discarded and never
 * returned. A non-token value (too long, or containing anything but letters) is
 * rejected so a provider string can never flow onward as a "code".
 */
export function readProviderErrorCode(json) {
  if (!isPlainObject(json)) return null
  const err = isPlainObject(json.error) ? json.error : null
  if (!err) return null
  const code = err.code
  if (typeof code !== 'string' || code.length === 0 || code.length > 64) return null
  return /^[A-Za-z_]+$/.test(code) ? code : null
}

// ── Executor (fetch-injected; no live caller in this phase) ───────────────────

/**
 * Execute one request descriptor with bounded retries.
 *
 * Returns ONLY `{ ok:true, json }` or `{ ok:false, code }`. The provider's response
 * body, headers, status text, URL and the access token never appear in the result.
 *
 * @param {object} p
 * @param {{method:string,url:string,headers:Record<string,string>}} p.request
 * @param {string} p.accessToken        Injected; never logged, never returned.
 * @param {Function} p.fetchImpl        REQUIRED. There is no default — this phase has no live caller.
 * @param {(ms:number)=>Promise<void>} [p.sleepImpl]
 * @param {()=>number} [p.now]
 * @returns {Promise<{ok:true,json:object,attempts:number}|{ok:false,code:string,attempts:number}>}
 */
export async function executeGraphRequest(p) {
  assertSafeParams(p)
  const { request, accessToken, fetchImpl, sleepImpl, now, budgetAllows } = p
  /**
   * The per-attempt deadline, INJECTABLE only so a test can prove it is in force.
   *
   * It defaults to the shipped constant and no production caller passes it, so
   * behaviour is unchanged. The seam exists because the alternative is asserting the
   * deadline by waiting for it: a stalled-body test that waits out a real 20-second
   * abort proves the same thing and costs 20 seconds every run. Same pattern as
   * `fetchImpl`, `sleepImpl` and `now`, which are injected here for the same reason.
   */
  const timeoutMs = Number.isFinite(p.timeoutMs) && p.timeoutMs > 0
    ? p.timeoutMs
    : REQUEST_TIMEOUT_MS
  if (typeof fetchImpl !== 'function') throw new Error('fetch_not_injected')
  if (typeof accessToken !== 'string' || accessToken.length === 0) throw new Error('missing_access_token')
  if (!isPlainObject(request) || request.method !== 'GET' || typeof request.url !== 'string') {
    throw new Error('invalid_request_descriptor')
  }
  // Defence in depth: the executor itself refuses any URL outside the Graph origin,
  // even if a builder were bypassed.
  if (!request.url.startsWith(`${GRAPH_BASE}/me/`)) throw new Error('forbidden_request_url')

  const clock = typeof now === 'function' ? now : Date.now
  const sleep = typeof sleepImpl === 'function' ? sleepImpl : (ms) => new Promise((r) => setTimeout(r, ms))
  /**
   * Will `marginMs` of INVOCATION budget still be there?
   *
   * No default beyond "yes", because most callers of this module have no invocation
   * deadline to respect - the OAuth callback and the identity probe are single
   * requests inside a short-lived handler. The worker always injects one.
   *
   * REPRODUCED WITHOUT IT: with 25 seconds of invocation left, the retry loop started
   * attempts at 0, 50,000 and 100,000 ms and spent 120 seconds, because the only
   * bounds it consulted were its own - MAX_RETRIES, MAX_TOTAL_RETRY_DELAY_MS and the
   * per-attempt timeout - none of which knows how long the invocation has.
   */
  const affordable = typeof budgetAllows === 'function' ? budgetAllows : () => true
  let elapsedRetryMs = 0
  let attempts = 0

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // BEFORE THE FIRST ATTEMPT TOO, not only before a retry. A request admitted on a
    // budget check made long ago must not be issued into an invocation that is about
    // to be killed: the platform would stop it mid-flight, and nothing would be
    // recorded about why.
    if (!affordable(timeoutMs)) {
      return { ok: false, code: 'budget_exhausted', attempts }
    }
    attempts += 1
    let res
    // ONE CONTROLLER FOR THE WHOLE EXCHANGE - headers AND body.
    //
    // AbortSignal.timeout was passed to fetch, which bounded the header phase; but
    // the body was then read with an unbounded `res.json()`. fetch resolves when the
    // headers arrive, so a response that answered promptly and then trickled or
    // stalled its body was unbounded in time, and one of any size was unbounded in
    // memory. The controller now stays alive through readJsonBounded, which aborts
    // the underlying stream and refuses an oversized one mid-read.
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller !== null
      ? setTimeout(() => { try { controller.abort() } catch { /* already gone */ } }, timeoutMs)
      : null
    const clearTimer = () => { if (timer !== null) clearTimeout(timer) }

    try {
      res = await fetchImpl(request.url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          ...(request.headers || {}),
        },
        // NEVER auto-follow a redirect. Graph can answer an expired delta cursor with a
        // redirect to a full resynchronization; silently following it would turn a
        // bounded incremental run into an unbounded full mailbox read. It would also
        // re-send the bearer token to whatever host the Location names. The `Location`
        // header is deliberately never read, logged or returned.
        redirect: 'manual',
        ...(controller !== null
          ? { signal: controller.signal }
          : { signal: makeTimeoutSignal(timeoutMs) }),
      })
    } catch (e) {
      clearTimer()
      // An abort is a timeout; anything else is an opaque transport failure. The
      // thrown error's message is NEVER surfaced (it can contain the URL).
      const code = e && (e.name === 'AbortError' || e.name === 'TimeoutError')
        ? 'timeout' : 'transport_failure'
      const plan = planRetry({ status: 503, retryAfterHeader: null, attempt, elapsedRetryMs })
      if (!plan.retry) return { ok: false, code, attempts }
      // The BACKOFF AND THE ATTEMPT AFTER IT must both fit what is left. Sleeping
      // first and discovering afterwards that there is no time to retry wastes the
      // remainder of the invocation on a sleep.
      if (!affordable(plan.delayMs + timeoutMs)) {
        return { ok: false, code, attempts }
      }
      elapsedRetryMs += plan.delayMs
      await sleep(plan.delayMs)
      // AND AGAIN AFTER THE BACKOFF. The sleep is the one step whose real duration
      // this module does not control - an injected sleep, a throttled timer or a
      // suspended instance can all overrun it - so what was affordable before it is
      // re-proved after it rather than assumed.
      if (!affordable(timeoutMs)) {
        return { ok: false, code: 'budget_exhausted', attempts }
      }
      continue
    }

    const status = typeof res?.status === 'number' ? res.status : 0

    // ── A REDIRECT IS REFUSED BEFORE ITS BODY IS TOUCHED ────────────────────
    // This DID need a special case, and the comment that previously stood here said
    // it did not. The reasoning was that classifyFailure already answers
    // `unexpected_redirect` for a 3xx, which is true - but it answers it only AFTER
    // the non-200 path has read the body to look for an error token. A redirect has
    // no error token worth having, and reading the body of a response we have
    // already decided not to follow is work done on behalf of whatever the
    // `Location` points at. The code returned is the same one every caller and test
    // already knows; only the reading stops.
    if (status >= 300 && status < 400) {
      clearTimer()
      return { ok: false, code: 'unexpected_redirect', attempts }
    }

    if (status === 200) {
      // The declared length first, which refuses before a byte is buffered.
      const sizeCode = checkResponseSize(res)
      if (sizeCode) { clearTimer(); return { ok: false, code: sizeCode, attempts } }
      // Then the STREAMED bytes, under the same deadline.
      const read = await readJsonBounded(res, MAX_RESPONSE_BYTES)
      clearTimer()
      if (read.ok !== true) {
        return {
          ok: false,
          code: read.reason === 'response_too_large'
            ? 'response_too_large'
            : (read.reason === 'response_body_timeout' ? 'timeout' : 'malformed_response'),
          attempts,
        }
      }
      if (!isPlainObject(read.value)) return { ok: false, code: 'malformed_response', attempts }
      return { ok: true, json: read.value, attempts }
    }
    // ── THE NON-200 BODY, UNDER THE SAME DEADLINE AND A SIZE CEILING ───────
    // The timer used to be cleared on the line above this, before the error body was
    // read at all - and that read was an unbounded `res.json()`. So a 400 that sent
    // its headers promptly and then stalled its body hung forever with no deadline
    // in force, and one that streamed 4,100,048 bytes was buffered whole against a
    // ceiling that was never applied to it. Reproduced both ways.
    //
    // The controller therefore stays alive until the error body is finished with,
    // exactly as it does for a success, and the read is bounded.
    const stage = request.stage === 'content' ? 'content' : 'envelope'
    const errRead = await readJsonBounded(res, MAX_ERROR_BODY_BYTES)
    clearTimer()

    // CLASSIFICATION IS UNCHANGED when the body is readable: the token is recovered
    // and classifyFailure decides, so a 400 or 410 carrying a dead-cursor code still
    // answers `cursor_invalid` and still stops the run without advancing anything.
    //
    // When the body is NOT readable the token is simply absent, which is the same
    // null `readErrorCode` has always produced for an unusable payload - so a
    // malformed error body classifies on status alone, as before. Only the two
    // BOUNDED failures are reported as themselves, because they say something
    // different: the response could not be read in time, or was too large to read.
    // Neither is retried: a body that stalls or floods is not a transient we should
    // ask for again.
    if (errRead.ok !== true
        && (errRead.reason === 'response_body_timeout' || errRead.reason === 'response_too_large')) {
      return {
        ok: false,
        code: errRead.reason === 'response_too_large' ? 'response_too_large' : 'timeout',
        attempts,
      }
    }
    const errorCode = errRead.ok === true ? readProviderErrorCode(errRead.value) : null
    const code = classifyFailure({ status, errorCode, stage })

    // Unusable delta state is never retried: retrying the same dead cursor cannot
    // succeed. The run stops and the caller must NOT advance the cursor.
    if (code === 'cursor_invalid' || !isRetryableStatus(status)) {
      return { ok: false, code, attempts }
    }

    const plan = planRetry({
      status,
      retryAfterHeader: readHeader(res, 'retry-after'),
      attempt,
      elapsedRetryMs,
    })
    if (!plan.retry) return { ok: false, code: plan.code, attempts }
    // The backoff plus the attempt it precedes. A Retry-After of 30 seconds is a
    // perfectly ordinary answer from Graph and a perfectly impossible one inside the
    // last ten seconds of an invocation; the PROVIDER's code is returned rather than
    // `budget_exhausted`, because the provider did answer and that answer is what the
    // caller should act on.
    if (!affordable(plan.delayMs + timeoutMs)) {
      return { ok: false, code, attempts }
    }
    elapsedRetryMs += plan.delayMs
    await sleep(plan.delayMs)
    if (!affordable(timeoutMs)) {
      return { ok: false, code: 'budget_exhausted', attempts }
    }
    void clock
  }
  return { ok: false, code: 'retry_exhausted', attempts }
}

function makeTimeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms)
    }
  } catch { /* fall through */ }
  return undefined
}

// `readErrorCode` lived here. It wrapped an UNBOUNDED res.json() in a try/catch,
// which is how the error path came to have neither a deadline nor a size ceiling.
// Deleting it rather than fixing it in place means there is no longer an unbounded
// reader in this module for a later caller to reach for: the non-200 path now uses
// readJsonBounded directly, inside the request's own controller.

function readHeader(res, name) {
  try {
    if (res && res.headers && typeof res.headers.get === 'function') return res.headers.get(name)
  } catch { /* ignore */ }
  return null
}

/** Reject an over-large response before it is parsed. */
export function checkResponseSize(res) {
  const len = readHeader(res, 'content-length')
  if (len !== null && /^\d+$/.test(String(len)) && Number(len) > MAX_RESPONSE_BYTES) {
    return 'response_too_large'
  }
  return null
}

// ── Page reading (bounded; still no live caller) ──────────────────────────────

/**
 * Read one delta page's envelope structure WITHOUT interpreting message content.
 * Returns the raw `value` array plus the (validated) continuation link, or a code.
 * The continuation link is passed through opaquely and is never logged.
 * @param {unknown} json
 * @returns {{ok:true, items:unknown[], nextLink:string|null, deltaLink:string|null, complete:boolean}
 *          |{ok:false, code:string}}
 */
export function readDeltaPage(json) {
  if (!isPlainObject(json)) return { ok: false, code: 'malformed_response' }
  const items = Array.isArray(json.value) ? json.value : null
  if (!items) return { ok: false, code: 'malformed_response' }
  if (items.length > MAX_PAGE_SIZE) return { ok: false, code: 'response_too_large' }

  const rawNext = json['@odata.nextLink']
  const rawDelta = json['@odata.deltaLink']
  let nextLink = null
  let deltaLink = null
  if (rawNext !== undefined && rawNext !== null) {
    const v = validateGraphFollowLink(rawNext)
    if (!v.ok) return { ok: false, code: 'invalid_link' }
    nextLink = v.url
  }
  if (rawDelta !== undefined && rawDelta !== null) {
    const v = validateGraphFollowLink(rawDelta)
    if (!v.ok) return { ok: false, code: 'invalid_link' }
    deltaLink = v.url
  }
  if (nextLink && deltaLink) return { ok: false, code: 'malformed_response' }
  return { ok: true, items, nextLink, deltaLink, complete: deltaLink !== null }
}

/**
 * Enforce the per-run accumulation caps. Returns a controlled reason when a cap is
 * exceeded (the run must stop, record itself INCOMPLETE and NOT advance the durable
 * delta cursor), or null when the run may continue.
 */
export function checkRunCaps({ pages, messages, contentFetches }) {
  if (Number.isInteger(pages) && pages > MAX_PAGES_PER_RUN) return 'max_pages_exceeded'
  if (Number.isInteger(messages) && messages > MAX_MESSAGES_PER_RUN) return 'max_messages_exceeded'
  if (Number.isInteger(contentFetches) && contentFetches > MAX_CONTENT_FETCHES_PER_RUN) {
    return 'max_content_fetches_exceeded'
  }
  return null
}

/**
 * Read a per-message CONTENT response: the two body projections AND the automation
 * facts derived from `internetMessageHeaders`, in one pass.
 *
 * The raw header collection is consumed transiently and NEVER returned: only the
 * allowlisted booleans/enums of the E1 AutomationFacts shape survive, so no header
 * name/value pair can reach a log, a stored draft, a fingerprint or an Anthropic
 * request. `automationComplete` says whether the collection was actually present, so
 * an ABSENT collection can never be mistaken for "no automation".
 *
 * Body text is returned raw and unsanitized for outlookContentSanitizer.js; the caller
 * must sanitize before any further use and must never persist or log it.
 *
 * @param {unknown} json
 * @param {string} expectedMessageId
 */
export function readMessageContent(json, expectedMessageId) {
  if (!isPlainObject(json)) return { ok: false, code: 'malformed_response' }
  if (typeof json.id !== 'string' || json.id !== expectedMessageId) {
    return { ok: false, code: 'malformed_response' }
  }
  const body = isPlainObject(json.body) ? json.body : null
  const unique = isPlainObject(json.uniqueBody) ? json.uniqueBody : null
  const pick = (node) => {
    if (!node) return { contentType: null, content: '' }
    const ct = typeof node.contentType === 'string' ? node.contentType.toLowerCase() : null
    const content = typeof node.content === 'string' ? node.content : ''
    return { contentType: ct === 'text' || ct === 'html' ? ct : null, content }
  }
  const b = pick(body)
  const u = pick(unique)
  if (b.content.length > MAX_BODY_CHARS || u.content.length > MAX_BODY_CHARS) {
    return { ok: false, code: 'response_too_large' }
  }
  if (b.content.length === 0 && u.content.length === 0) return { ok: false, code: 'empty_content' }

  // Headers are reduced to controlled facts HERE and the collection is dropped.
  const automation = automationFactsFromHeaders(json.internetMessageHeaders)

  return {
    ok: true,
    bodyContentType: b.contentType,
    bodyContent: b.content,
    uniqueBodyContentType: u.contentType,
    uniqueBodyContent: u.content,
    automation: automation.facts,
    automationComplete: automation.complete,
  }
}

/** True when a granted-scope list satisfies the Outlook read requirement. */
export function grantedScopesIncludeMailRead(scopes) {
  if (Array.isArray(scopes)) return scopes.includes(GRAPH_MAIL_READ_SCOPE)
  if (typeof scopes === 'string') return scopes.split(' ').filter(Boolean).includes(GRAPH_MAIL_READ_SCOPE)
  return false
}
