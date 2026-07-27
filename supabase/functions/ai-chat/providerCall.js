// Provider call orchestration, configuration constants, retry logic, and safe
// diagnostic log builders. Plain JavaScript (no TypeScript annotations) so Node
// test files can import directly without transpilation. Imported by index.ts (Deno).

import { parseProviderResponse } from './parseProviderResponse.js'

// ── Model ─────────────────────────────────────────────────────────────────────

export const MODEL = 'claude-sonnet-5'

// ── Primary attempt configuration ─────────────────────────────────────────────
//
// Funnl AI is an interactive networking assistant, not a long-running reasoning
// agent. Returning a dependable visible answer is more valuable than spending
// hidden tokens on adaptive thinking.
//
// Claude Sonnet 5 enables adaptive thinking by default. Disabling it explicitly
// reserves the entire max_tokens allowance for visible text and keeps latency
// predictable. If evaluations later show that adaptive thinking materially
// improves answer quality without hurting reliability or latency, it can be
// re-enabled here.
//
// Do not add temperature, top_p, top_k, or manual budget_tokens.

export const PRIMARY_MAX_TOKENS = 2048
export const PRIMARY_THINKING = { type: 'disabled' }
export const PRIMARY_EFFORT = 'high'

// ── Fallback attempt configuration ────────────────────────────────────────────
//
// The fallback runs only when the primary returns HTTP 200 with no usable visible
// text — an unusual condition with thinking disabled. Medium effort varies the
// provider-side execution without changing the inference mode.
//
// Justification for keeping the fallback: with thinking disabled, a blank
// HTTP-200 response indicates a transient provider-side issue rather than a
// budget exhaustion problem. A single fallback with different effort provides an
// alternative execution path. The remaining-time guard (MIN_FALLBACK_TIME_MS)
// ensures it only runs when meaningful time remains.

export const FALLBACK_MAX_TOKENS = 2048
export const FALLBACK_THINKING = { type: 'disabled' }
export const FALLBACK_EFFORT = 'medium'

// ── Timing constants ──────────────────────────────────────────────────────────
//
// REQUEST_DEADLINE_MS — hard cap for the complete Edge Function invocation, measured
//                        from requestEntryMs (recorded at handler entry, before auth,
//                        DB, and context work). The 125-second application deadline
//                        leaves 25 seconds of safety below the Supabase documented
//                        150-second request-idle timeout. When requestEntryMs is not
//                        provided by the caller, this constant is not used — only the
//                        per-attempt timeout applies (backward-compatible for tests).
// PRIMARY_ATTEMPT_TIMEOUT_MS — maximum per-attempt AbortSignal deadline. The actual
//                        timeout for any given attempt is bounded:
//                          min(PRIMARY_ATTEMPT_TIMEOUT_MS, remainingRequestMs)
//                        where remainingRequestMs = REQUEST_DEADLINE_MS − elapsed_from_entry.
//                        90 s was chosen to accommodate large-context follow-up requests —
//                        a design judgment based on max_tokens and typical provider
//                        throughput, not a confirmed production measurement.
// MIN_FALLBACK_TIME_MS — minimum remaining full-request budget required before starting
//                        any attempt (primary or fallback). An attempt that cannot
//                        realistically complete within REQUEST_DEADLINE_MS is not started;
//                        the user receives an immediate provider_timeout instead.
//
// Worst-case total from handler entry: pre-provider work + primary attempt + optional
// fallback ≤ REQUEST_DEADLINE_MS (125 s). The per-attempt bound guarantees this.

export const REQUEST_DEADLINE_MS = 125_000
export const PRIMARY_ATTEMPT_TIMEOUT_MS = 90_000
export const MIN_FALLBACK_TIME_MS = 20_000

// ── Retry decision ────────────────────────────────────────────────────────────

/**
 * Returns true when a blank provider reply warrants a single fallback attempt.
 *
 * With thinking disabled, a blank HTTP-200 response is unusual and typically
 * indicates a transient provider-side issue rather than thinking-budget exhaustion.
 * The retry conditions remain the same because the signal (HTTP 200 + no visible
 * text) is meaningful regardless of the cause.
 *
 * Never retried:
 *   - Non-200 HTTP responses: these indicate provider-level failures unrelated
 *     to blank-reply exhaustion (rate-limit, overload, server error, auth).
 *   - Successful replies: parseError is null, so this function is not called.
 *   - Refusals: the model produces a visible text block declining the request;
 *     parseProviderResponse extracts it as a reply (parseError = null), so
 *     this function is not called.
 *   - Timeouts: AbortError breaks the loop immediately, before any retry.
 *   - Auth / DB / context failures: handled before any provider call.
 */
export function shouldRetryForBlankReply(providerStatus, parseError, stop_reason, contentBlockTypes) {
  if (providerStatus !== 200) return false
  if (parseError !== 'empty_provider_response') return false
  if (stop_reason === 'max_tokens') return true
  const types = Array.isArray(contentBlockTypes) ? contentBlockTypes : []
  if (types.length === 0) return true
  if (types.every(t => t === 'thinking' || t === 'redacted_thinking')) return true
  return false
}

// ── Safe diagnostic log builders ──────────────────────────────────────────────

/**
 * Builds a structured, loggable metadata object for a single provider attempt.
 *
 * Contains ONLY controlled metadata. Never contains: prompt text, system prompt
 * content, response text, contact names, emails, companies, roles, tags, notes,
 * URLs, interaction data, serialized network context, or provider response text.
 *
 * `replyPresent` must be pre-computed by the caller as:
 *   typeof parsedReply === 'string' && parsedReply.trim().length > 0
 * This means a non-blank visible reply exists — not merely that a value is non-null.
 */
export function buildAttemptLog({
  requestId, attempt, model, max_tokens, thinking_mode, effort,
  providerStatus, providerRequestId, stop_reason, contentBlockTypes,
  usage, durationMs, contextPass, replyPresent,
  remainingRequestMsAtAttemptStart, attemptTimeoutMs,
}) {
  return {
    event: 'ai_chat_provider_attempt',
    request_id: requestId ?? null,
    attempt: typeof attempt === 'number' ? attempt : null,
    model: model ?? null,
    max_tokens: typeof max_tokens === 'number' ? max_tokens : null,
    thinking_mode: thinking_mode ?? null,
    effort: effort ?? null,
    provider_status: typeof providerStatus === 'number' ? providerStatus : null,
    provider_request_id: providerRequestId ?? null,
    stop_reason: stop_reason ?? null,
    content_block_types: Array.isArray(contentBlockTypes) ? contentBlockTypes : [],
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? null,
    duration_ms: typeof durationMs === 'number' ? durationMs : null,
    context_pass: contextPass ?? null,
    reply_present: replyPresent === true,
    remaining_request_ms_at_attempt_start: typeof remainingRequestMsAtAttemptStart === 'number' ? remainingRequestMsAtAttemptStart : null,
    attempt_timeout_ms: typeof attemptTimeoutMs === 'number' ? attemptTimeoutMs : null,
  }
}

/**
 * Builds a safe loggable summary for the completed request.
 * Never contains user data. The `success` field means a non-blank visible
 * reply was returned to the caller.
 *
 * Timing fields (all null when not available):
 *   pre_provider_ms      — requestStart − requestEntryMs: time spent on pre-provider
 *                          work (auth, DB query, context build) before the first
 *                          provider call. Null when requestEntryMs not provided.
 *   provider_duration_ms — finalMs − requestStart: time spent inside runProviderAttempts
 *                          across all attempts (the provider stage only).
 *   total_duration_ms    — finalMs − requestEntryMs: full Edge Function invocation
 *                          duration from handler entry to completion. Null when
 *                          requestEntryMs not provided.
 *
 * `timeout_source` distinguishes why a provider_timeout occurred:
 *   'attempt_deadline'   — an AbortController fired during a provider call
 *   'request_deadline'   — remaining full-request budget (REQUEST_DEADLINE_MS) was
 *                          exhausted before the attempt could start
 *   null                 — no timeout (success or a different error code)
 */
export function buildRequestSummaryLog({ requestId, success, attempts, finalErrorCode, timeoutSource, preProviderMs, providerDurationMs, totalDurationMs }) {
  return {
    event: 'ai_chat_request_complete',
    request_id: requestId ?? null,
    success: success === true,
    attempts: typeof attempts === 'number' ? attempts : null,
    final_error_code: finalErrorCode ?? null,
    timeout_source: timeoutSource ?? null,
    pre_provider_ms: typeof preProviderMs === 'number' ? preProviderMs : null,
    provider_duration_ms: typeof providerDurationMs === 'number' ? providerDurationMs : null,
    total_duration_ms: typeof totalDurationMs === 'number' ? totalDurationMs : null,
  }
}

// ── Signal factory ────────────────────────────────────────────────────────────

/**
 * Creates an AbortSignal that fires after timeoutMs milliseconds.
 * Returns the signal and a clearTimer function that cancels the scheduled abort.
 *
 * Always call clearTimer after the fetch resolves or rejects — the finally block
 * in runProviderAttempts guarantees this. Not calling clearTimer would leave a
 * pending timer that aborts the signal after the attempt already completed.
 */
export function makeSignal(timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    clearTimer: () => clearTimeout(timer),
  }
}

// ── Attempt configurations ────────────────────────────────────────────────────

const ATTEMPT_CONFIGS = [
  { max_tokens: PRIMARY_MAX_TOKENS, thinking: PRIMARY_THINKING, effort: PRIMARY_EFFORT },
  { max_tokens: FALLBACK_MAX_TOKENS, thinking: FALLBACK_THINKING, effort: FALLBACK_EFFORT },
]

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_API_VERSION = '2023-06-01'

// ── Provider attempt orchestration ────────────────────────────────────────────

/**
 * Runs the primary provider call and at most one fallback attempt.
 *
 * All I/O dependencies are injectable so this function's full control flow can
 * be tested with synchronous mocks — no real HTTP or timers in unit tests.
 *
 * Timing model (full-invocation deadline):
 *   - Before EVERY attempt: remainingRequestMs = REQUEST_DEADLINE_MS − (now − requestEntryMs).
 *     If remainingRequestMs < MIN_FALLBACK_TIME_MS, return provider_timeout immediately
 *     without starting a call that cannot realistically complete.
 *   - Attempt timeout: min(PRIMARY_ATTEMPT_TIMEOUT_MS, remainingRequestMs) — bounds every
 *     provider call within the full-invocation application deadline.
 *   - When requestEntryMs is not provided: deadline check is skipped; each attempt receives
 *     PRIMARY_ATTEMPT_TIMEOUT_MS (backward-compatible behavior for legacy callers/tests).
 *   - Total wall time from requestEntryMs ≤ REQUEST_DEADLINE_MS (125 s).
 *
 * Non-retried conditions (break immediately, no fallback):
 *   - AbortError (timeout): return provider_timeout.
 *   - Non-200 HTTP (429, 529, other): return provider_rate_limited /
 *     provider_unavailable / provider_error respectively.
 *   - Refusal with visible text: parsed reply is returned as success.
 *   - Both attempts exhausted or shouldRetryForBlankReply returns false.
 *
 * @param {object} params
 * @param {string}      params.systemPrompt    Full system prompt (includes network context)
 * @param {Array}       params.messages        Validated conversation message array
 * @param {string}      params.requestId       Unique request identifier for logging
 * @param {number|null} params.passUsed        Context budget pass used (for logging)
 * @param {number}      params.requestStart    ms timestamp recorded in index.ts immediately
 *                                             before this function is called. Used as providerStartMs
 *                                             for timing metrics: pre_provider_ms (requestStart −
 *                                             requestEntryMs) and provider_duration_ms (finalMs −
 *                                             requestStart).
 * @param {string}      params.anthropicApiKey Anthropic API key (from Supabase secrets)
 * @param {number}     [params.requestEntryMs] ms timestamp recorded at Edge Function entry
 *                                             (before auth, DB, and context work). When provided:
 *                                             all attempt timeouts are bounded by REQUEST_DEADLINE_MS;
 *                                             pre_provider_ms and total_duration_ms are computed.
 *                                             Omit for legacy/test callers — deadline check skipped.
 * @param {Function}   [params.fetchImpl]      async (url, init) => Response; defaults to global fetch
 * @param {Function}   [params.now]            () => number (ms); defaults to Date.now
 * @param {Function}   [params.makeSignalFn]   (ms) => { signal, clearTimer }; defaults to makeSignal
 * @param {Function}   [params.logAttempt]     (data) => void; receives attempt log object
 * @param {Function}   [params.logSummary]     (data) => void; receives summary log object
 *
 * @returns {Promise<
 *   { ok: true,  reply: string, truncated: boolean, attempts: number } |
 *   { ok: false, errorCode: string, attempts: number }
 * >}
 */
export async function runProviderAttempts({
  systemPrompt,
  messages,
  requestId,
  passUsed,
  requestStart,
  requestEntryMs,
  anthropicApiKey,
  fetchImpl,
  now,
  makeSignalFn,
  logAttempt,
  logSummary,
}) {
  const _fetch = fetchImpl ?? fetch
  const _now = now ?? (() => Date.now())
  const _makeSignal = makeSignalFn ?? makeSignal
  const _logAttempt = logAttempt ?? ((data) => console.log(JSON.stringify(data)))
  const _logSummary = logSummary ?? ((data) => console.log(JSON.stringify(data)))

  let finalReply = null
  let finalTruncated = false
  let finalErrorCode = null
  let finalTimeoutSource = null
  let attempts = 0

  try {
    for (let i = 0; i < ATTEMPT_CONFIGS.length; i++) {
      const config = ATTEMPT_CONFIGS[i]

      // Compute remaining full-request budget from Edge Function entry.
      // When requestEntryMs is provided, this ensures the total invocation —
      // including pre-provider work (auth, DB, context) — stays within
      // REQUEST_DEADLINE_MS. When omitted (legacy/test callers without deadline
      // tracking), remainingRequestMs is null and the budget check is skipped.
      const remainingRequestMs = typeof requestEntryMs === 'number'
        ? REQUEST_DEADLINE_MS - (_now() - requestEntryMs)
        : null

      // Do not begin an attempt if the remaining full-request budget is already
      // too small to make a meaningful attempt. This guards against pathologically
      // slow pre-provider work (auth or DB latency) that has consumed most of the
      // application deadline before any provider call is made.
      if (remainingRequestMs !== null && remainingRequestMs < MIN_FALLBACK_TIME_MS) {
        finalErrorCode = 'provider_timeout'
        finalTimeoutSource = 'request_deadline'
        break
      }

      // Per-attempt abort deadline: bounded by the remaining full-request budget
      // when tracking a deadline, otherwise the configured maximum.
      // min() guarantees that even a slow provider call cannot push the total
      // invocation past REQUEST_DEADLINE_MS.
      const attemptTimeoutMs = remainingRequestMs !== null
        ? Math.min(PRIMARY_ATTEMPT_TIMEOUT_MS, remainingRequestMs)
        : PRIMARY_ATTEMPT_TIMEOUT_MS

      attempts++
      const attemptStart = _now()
      const { signal, clearTimer } = _makeSignal(attemptTimeoutMs)

      // clearTimer is called in the finally block of the inner try so the abort
      // timer is always cancelled — whether the fetch resolves, rejects, or throws.
      let fetchErr = null
      let anthropicRes = null
      try {
        anthropicRes = await _fetch(ANTHROPIC_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicApiKey,
            'anthropic-version': ANTHROPIC_API_VERSION,
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: config.max_tokens,
            thinking: config.thinking,
            output_config: { effort: config.effort },
            system: systemPrompt,
            messages,
          }),
          signal,
        })
      } catch (err) {
        fetchErr = err
      } finally {
        clearTimer()
      }

      const durationMs = _now() - attemptStart

      if (fetchErr) {
        _logAttempt(buildAttemptLog({
          requestId, attempt: attempts, model: MODEL,
          max_tokens: config.max_tokens,
          thinking_mode: config.thinking.type,
          effort: config.effort,
          providerStatus: null,
          providerRequestId: null,
          stop_reason: null,
          contentBlockTypes: [],
          usage: null,
          durationMs,
          contextPass: passUsed,
          replyPresent: false,
          remainingRequestMsAtAttemptStart: remainingRequestMs,
          attemptTimeoutMs,
        }))
        // A timeout aborts this attempt immediately. Do not start the fallback —
        // AbortError indicates the per-attempt deadline fired, not a blank reply.
        if (fetchErr.name === 'AbortError') {
          finalErrorCode = 'provider_timeout'
          finalTimeoutSource = 'attempt_deadline'
          break
        }
        // Unexpected network-level error — propagate to index.ts outer handler.
        throw fetchErr
      }

      const providerRequestId = anthropicRes.headers.get('x-request-id')

      // Non-2xx responses are not blank-reply failures and must not trigger the
      // fallback. The root cause (rate limit, overload, bad request) is unrelated
      // to visible-text exhaustion.
      if (!anthropicRes.ok) {
        _logAttempt(buildAttemptLog({
          requestId, attempt: attempts, model: MODEL,
          max_tokens: config.max_tokens,
          thinking_mode: config.thinking.type,
          effort: config.effort,
          providerStatus: anthropicRes.status,
          providerRequestId,
          stop_reason: null,
          contentBlockTypes: [],
          usage: null,
          durationMs,
          contextPass: passUsed,
          replyPresent: false,
          remainingRequestMsAtAttemptStart: remainingRequestMs,
          attemptTimeoutMs,
        }))
        if (anthropicRes.status === 429) finalErrorCode = 'provider_rate_limited'
        else if (anthropicRes.status === 529) finalErrorCode = 'provider_unavailable'
        else finalErrorCode = 'provider_error'
        break
      }

      const anthropicData = await anthropicRes.json()
      const { reply: parsedReply, stop_reason, truncated: isTruncated, error: parseError } =
        parseProviderResponse(anthropicData)
      const contentBlockTypes = (anthropicData?.content ?? []).map(b => b?.type)
      const usage = anthropicData?.usage

      // reply_present: a non-blank visible reply exists in this response.
      // typeof check guards against null; trim() guards against whitespace-only strings
      // that parseProviderResponse may have already rejected, but is harmless to double-check.
      const replyPresent = typeof parsedReply === 'string' && parsedReply.trim().length > 0

      _logAttempt(buildAttemptLog({
        requestId, attempt: attempts, model: MODEL,
        max_tokens: config.max_tokens,
        thinking_mode: config.thinking.type,
        effort: config.effort,
        providerStatus: 200,
        providerRequestId,
        stop_reason: stop_reason ?? null,
        contentBlockTypes,
        usage,
        durationMs,
        contextPass: passUsed,
        replyPresent,
        remainingRequestMsAtAttemptStart: remainingRequestMs,
        attemptTimeoutMs,
      }))

      if (replyPresent) {
        // Non-blank visible text — return it. Truncated partial responses (text
        // present but stop_reason=max_tokens) are still useful and are returned
        // rather than discarded. The truncated flag lets the frontend note this.
        finalReply = parsedReply
        finalTruncated = isTruncated
        break
      }

      // No usable text. Retry only on the first attempt when conditions are
      // consistent with a retriable blank reply (transient provider-side issue).
      if (attempts >= 2 || !shouldRetryForBlankReply(200, parseError, stop_reason, contentBlockTypes)) {
        finalErrorCode = 'empty_provider_response'
        break
      }
      // Continue to fallback config (loop iteration i + 1).
    }
  } finally {
    // Summary log fires once regardless of how the loop exits — normal completion,
    // break, or unexpected throw. Even a throw leaves useful diagnostic data.
    //
    // Timing metrics (all null when requestEntryMs not provided):
    //   pre_provider_ms      — time from Edge Function entry to first provider call
    //   provider_duration_ms — time inside runProviderAttempts (provider stage only)
    //   total_duration_ms    — full invocation duration from Edge Function entry
    const finalMs = _now()
    _logSummary(buildRequestSummaryLog({
      requestId,
      success: finalReply !== null,
      attempts,
      finalErrorCode,
      timeoutSource: finalTimeoutSource,
      preProviderMs: typeof requestEntryMs === 'number' ? requestStart - requestEntryMs : null,
      providerDurationMs: finalMs - requestStart,
      totalDurationMs: typeof requestEntryMs === 'number' ? finalMs - requestEntryMs : null,
    }))
  }

  if (finalReply !== null) {
    return { ok: true, reply: finalReply, truncated: finalTruncated, attempts }
  }
  return { ok: false, errorCode: finalErrorCode ?? 'empty_provider_response', attempts }
}
