// Frontend error normalizer for supabase.functions.invoke() results.
//
// @supabase/supabase-js v2: a non-2xx Edge Function response throws
//   FunctionsHttpError where fnError.context is the raw fetch Response object
//   (body NOT yet consumed). Parsing requires await fnError.context.json().
//
// Our Edge Function body shape on errors:
//   { error: { code, message, retryable, request_id } }
//
// This module extracts that shape defensively, normalizes unknown codes against
// the known-codes allowlist, and never exposes raw stack traces, provider
// bodies, or secrets.

import { FunctionsHttpError, FunctionsRelayError, FunctionsFetchError } from '@supabase/supabase-js'

// Canonical set of error codes produced by the ai-chat Edge Function.
// Any code not in this set is normalized to 'internal_error' so the frontend
// always sees a known, typesafe value regardless of Edge Function version.
const KNOWN_CODES = new Set([
  'unauthorized',
  'invalid_request',
  'pro_required',
  'internal_error',
  'network_data_failed',
  'context_too_large',
  'provider_rate_limited',
  'provider_timeout',
  'provider_unavailable',
  'provider_error',
  'empty_provider_response',
])

const DEFAULT_ERROR = {
  code: 'internal_error',
  message: 'Something went wrong — please try again.',
  retryable: true,
  request_id: null,
}

function normalizeCode(code) {
  if (typeof code === 'string' && KNOWN_CODES.has(code)) return code
  return DEFAULT_ERROR.code
}

function buildFromStructured(obj) {
  if (!obj || typeof obj !== 'object' || typeof obj.code !== 'string') return null
  return {
    code: normalizeCode(obj.code),
    message: typeof obj.message === 'string' && obj.message
      ? obj.message
      : DEFAULT_ERROR.message,
    // retryable defaults true when the field is absent (safe for network glitches)
    retryable: obj.retryable !== false,
    request_id: typeof obj.request_id === 'string' ? obj.request_id : null,
  }
}

/**
 * Extracts a normalized, safe structured error from a supabase.functions.invoke() result.
 *
 * Priority order:
 * 1. FunctionsHttpError (non-2xx response): parse body via await context.json(),
 *    extract structured { code, message, retryable, request_id } from body.error.
 * 2. FunctionsRelayError / FunctionsFetchError (network-level failures): retryable
 *    internal_error — no body to parse.
 * 3. Structured error in data.error (defensive: shouldn't appear on HTTP 200,
 *    but handled for forward compatibility).
 * 4. Legacy plain-string error in data.error (older Edge Function builds).
 * 5. Any remaining fnError with no parseable body: safe retryable default.
 * 6. No error condition: returns null.
 *
 * Error codes are validated against the canonical allowlist — unknown codes
 * normalize to 'internal_error'.
 *
 * @param {any} fnError - The error thrown by invoke() (FunctionsHttpError or null)
 * @param {any} data    - The data returned by invoke() (may be null on error)
 * @returns {Promise<{ code: string, message: string, retryable: boolean, request_id: string|null }|null>}
 */
export async function extractInvokeError(fnError, data) {
  // Case 1: FunctionsHttpError — non-2xx response from the Edge Function.
  // context is a raw Response object; must await .json() to read the body.
  if (fnError instanceof FunctionsHttpError) {
    try {
      const body = await fnError.context.json()
      const structured = buildFromStructured(body?.error)
      if (structured) return structured
      // Body parsed but no recognized error shape — fall through to defaults below.
    } catch {
      // Body was not JSON (e.g. a proxy error page) — use safe default.
    }
    return { ...DEFAULT_ERROR }
  }

  // Case 2: FunctionsRelayError / FunctionsFetchError — network-level failure.
  // No response body to parse; always retryable.
  if (fnError instanceof FunctionsRelayError || fnError instanceof FunctionsFetchError) {
    return { ...DEFAULT_ERROR }
  }

  // Case 3: Structured error carried in data.error (defensive path).
  if (data?.error && typeof data.error === 'object') {
    const structured = buildFromStructured(data.error)
    if (structured) return structured
  }

  // Case 4: Legacy plain-string error in data.error.
  if (typeof data?.error === 'string' && data.error) {
    return { code: DEFAULT_ERROR.code, message: data.error, retryable: true, request_id: null }
  }

  // Case 5: Some other fnError with no parseable body.
  if (fnError) {
    return { ...DEFAULT_ERROR }
  }

  // Case 6: No error.
  return null
}
