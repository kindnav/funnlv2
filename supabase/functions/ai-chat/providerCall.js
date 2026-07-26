// Provider call configuration, retry-decision logic, and safe diagnostic helpers.
// Plain JavaScript (no TypeScript annotations) so Node.js test files can import
// directly without transpilation. Imported by index.ts (Deno).

// ── Model and inference constants ─────────────────────────────────────────────

export const MODEL = 'claude-sonnet-5'

/**
 * Primary attempt: adaptive thinking at medium effort.
 *
 * Adaptive thinking is the default for claude-sonnet-5. Setting effort: 'medium'
 * reduces the hidden thinking budget relative to the default (high), which lowers
 * the chance that thinking alone consumes the output allowance before the model
 * can emit any visible text. max_tokens 8192 gives room for both thinking tokens
 * and a full readable response — the earlier 2048 limit was too tight.
 *
 * Do not add temperature, top_p, or top_k: Sonnet 5 rejects non-default sampling.
 * Do not use manual budget_tokens: not supported on Sonnet 5.
 */
export const PRIMARY_MAX_TOKENS = 8192
export const PRIMARY_THINKING = { type: 'adaptive' }
export const PRIMARY_EFFORT = 'medium'

/**
 * Fallback attempt: thinking disabled.
 *
 * When the primary attempt returns HTTP 200 but no visible text (likely because
 * hidden thinking consumed the entire output budget), a single fallback attempt
 * runs with thinking disabled. This guarantees the model devotes its full output
 * budget to the visible response. max_tokens 4096 is sufficient for a complete
 * network-analysis answer and well within the per-request budget.
 */
export const FALLBACK_MAX_TOKENS = 4096
export const FALLBACK_THINKING = { type: 'disabled' }
export const FALLBACK_EFFORT = 'high'

/**
 * Overall wall-clock deadline in milliseconds covering all provider attempts
 * combined. Using a single shared AbortController ensures two attempts cannot
 * accidentally double the user-facing wait to 90 s.
 *
 * 60 s provides headroom for primary + fallback under normal throughput while
 * staying well within Supabase's 150 s Edge Function wall-clock limit.
 * PROVISIONAL: adjust if production smoke tests reveal legitimate requests
 * being aborted.
 */
export const PROVIDER_TIMEOUT_MS = 60_000

// ── Retry decision ────────────────────────────────────────────────────────────

/**
 * Returns true when a blank provider reply warrants a single fallback attempt.
 *
 * The fallback is permitted ONLY when all four conditions are met:
 *
 *   1. providerStatus === 200 — Anthropic accepted and processed the request.
 *      Retrying non-200 responses (rate-limited, overloaded, auth errors) is
 *      wrong: the issue is not blank-reply exhaustion.
 *
 *   2. parseError === 'empty_provider_response' — parseProviderResponse found no
 *      usable visible text. A successful reply (even a truncated one) means
 *      parseError is null, so this function is never called for successes.
 *
 *   3. stop_reason or contentBlockTypes are consistent with thinking exhaustion:
 *       - stop_reason === 'max_tokens': the combined thinking + visible budget ran
 *         out before any text was emitted.
 *       - Every content block is thinking or redacted_thinking: the model finished
 *         its reasoning phase but produced no visible output.
 *       - The content array is empty: no blocks at all.
 *
 *   4. This is the first attempt (attempt limit is enforced by the caller).
 *
 * Never retries:
 *   - Successful replies — parseError is null, so this function is not called.
 *   - Refusals — the model returns a text block declining the request;
 *     parseProviderResponse extracts that text as the reply (parseError = null),
 *     so this function is not called.
 *   - HTTP errors — providerStatus !== 200.
 *   - Auth, DB, or context failures — handled before any provider call.
 *
 * @param {number}   providerStatus    - HTTP status from the Anthropic response
 * @param {string|null} parseError     - error field from parseProviderResponse()
 * @param {string|null} stop_reason    - stop_reason from the provider response
 * @param {string[]} contentBlockTypes - array of block type strings from content
 * @returns {boolean}
 */
export function shouldRetryForBlankReply(providerStatus, parseError, stop_reason, contentBlockTypes) {
  if (providerStatus !== 200) return false
  if (parseError !== 'empty_provider_response') return false

  // Blank with max_tokens: budget exhausted by hidden thinking.
  if (stop_reason === 'max_tokens') return true

  const types = Array.isArray(contentBlockTypes) ? contentBlockTypes : []

  // Empty content array: nothing produced at all.
  if (types.length === 0) return true

  // Every block is thinking or redacted_thinking: model reasoned but never wrote visible output.
  if (types.every(t => t === 'thinking' || t === 'redacted_thinking')) return true

  return false
}

// ── Safe diagnostic log builders ──────────────────────────────────────────────

/**
 * Builds a structured, loggable metadata object for a single provider attempt.
 *
 * Contains ONLY controlled metadata. Never contains: prompt text, system prompt
 * content, contact names, emails, companies, roles, tags, notes, URLs, dates,
 * interaction content, serialized network context, or provider response text.
 *
 * Token counts and enum-like fields (stop_reason, block types, error codes) are
 * safe: they convey diagnostic signal without revealing user data.
 *
 * @param {object} params
 * @returns {object} Safe to pass directly to JSON.stringify + console.log.
 */
export function buildAttemptLog({
  requestId,
  attempt,
  model,
  max_tokens,
  thinking_mode,
  effort,
  providerStatus,
  providerRequestId,
  stop_reason,
  contentBlockTypes,
  usage,
  durationMs,
  contextPass,
  replyPresent,
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
  }
}

/**
 * Builds a safe loggable summary for the completed request.
 *
 * @param {object} params
 * @returns {object}
 */
export function buildRequestSummaryLog({
  requestId,
  success,
  attempts,
  finalErrorCode,
  totalDurationMs,
}) {
  return {
    event: 'ai_chat_request_complete',
    request_id: requestId ?? null,
    success: success === true,
    attempts: typeof attempts === 'number' ? attempts : null,
    final_error_code: finalErrorCode ?? null,
    total_duration_ms: typeof totalDurationMs === 'number' ? totalDurationMs : null,
  }
}
