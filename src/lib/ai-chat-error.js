// Frontend error normalizer for supabase.functions.invoke() results.
//
// @supabase/supabase-js v2: a non-2xx Edge Function response returns
//   { data: null, error: FunctionsHttpError }
// where FunctionsHttpError.context is the parsed JSON body.
//
// Our Edge Function body shape on errors:
//   { error: { code, message, retryable, request_id } }
//
// This module extracts that shape defensively, handles older plain-string
// errors, and never exposes raw stack traces, provider bodies, or secrets.

const DEFAULT_ERROR = {
  code: 'internal_error',
  message: 'Something went wrong — please try again.',
  retryable: true,
  request_id: null,
}

/**
 * Extracts a normalized, safe structured error from a supabase.functions.invoke() result.
 *
 * Priority order:
 * 1. Structured { code, message, retryable, request_id } from fnError.context.error
 *    (FunctionsHttpError from a non-2xx Edge Function response).
 * 2. Same shape from data.error (defensive: shouldn't appear on HTTP 200, but handled).
 * 3. Legacy plain-string error from fnError.context.error or data.error.
 * 4. Generic FunctionsHttpError with no parseable body — returns safe default.
 * 5. No error detected — returns null.
 *
 * @param {any} fnError - The error returned by invoke() (FunctionsHttpError or null)
 * @param {any} data    - The data returned by invoke() (may be null on error)
 * @returns {{ code: string, message: string, retryable: boolean, request_id: string|null }|null}
 */
export function extractInvokeError(fnError, data) {
  // Check both possible locations for the error payload.
  const bodyError = fnError?.context?.error ?? data?.error

  // Structured error object with a code field (our canonical error shape).
  if (bodyError && typeof bodyError === 'object' && typeof bodyError.code === 'string') {
    return {
      code: bodyError.code || DEFAULT_ERROR.code,
      message: typeof bodyError.message === 'string' && bodyError.message
        ? bodyError.message
        : DEFAULT_ERROR.message,
      retryable: bodyError.retryable !== false,  // default true when field is absent
      request_id: typeof bodyError.request_id === 'string' ? bodyError.request_id : null,
    }
  }

  // Legacy plain-string error (older Edge Function builds before structured errors).
  if (typeof bodyError === 'string' && bodyError) {
    return { code: DEFAULT_ERROR.code, message: bodyError, retryable: true, request_id: null }
  }
  if (typeof data?.error === 'string' && data.error) {
    return { code: DEFAULT_ERROR.code, message: data.error, retryable: true, request_id: null }
  }

  // Generic FunctionsHttpError with no parseable structured body.
  if (fnError) {
    return { ...DEFAULT_ERROR }
  }

  return null
}
