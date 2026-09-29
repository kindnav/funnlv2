// Read a provider JSON response under a deadline that covers the BODY, with a
// hard size ceiling.
//
// WHY THIS EXISTS
// An earlier revision cleared the AbortController timer as soon as fetch
// resolved. fetch resolves when the response HEADERS arrive, so the deadline
// stopped applying exactly when the body was about to be read: a provider (or
// anything impersonating one on a hijacked route) could send headers promptly
// and then trickle or stall the body forever, pinning the request. There was
// also no ceiling on body size, so an enormous response would be buffered whole.
//
// The caller therefore keeps its AbortController alive until the body is fully
// read, and passes it here. The signal aborts the underlying stream, not just
// the header phase.
//
// NOTHING FROM THE BODY IS EVER RETURNED ON FAILURE. Callers surface controlled
// reason codes; provider bodies can contain the authorization code, tokens and
// diagnostic text, and are never logged.

/** Default ceiling for a provider JSON response. */
export const MAX_PROVIDER_BODY_BYTES = 256 * 1024

/**
 * @param {Response} res            a fetch Response whose body is still unread
 * @param {number}   maxBytes       hard ceiling; exceeding it aborts the read
 * @returns {Promise<{ok: true, value: unknown} | {ok: false, reason: string}>}
 */
export async function readJsonBounded (res, maxBytes = MAX_PROVIDER_BODY_BYTES) {
  if (!res || typeof res !== 'object') return { ok: false, reason: 'no_response' }

  // A declared length over the ceiling is refused before a byte is buffered.
  const declared = Number(res.headers?.get?.('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: 'response_too_large' }
  }

  const body = res.body
  if (!body || typeof body.getReader !== 'function') {
    // No readable stream (some test doubles, and 204s). Fall back to .json(),
    // still inside the caller's deadline.
    try {
      if (typeof res.json !== 'function') return { ok: false, reason: 'response_malformed' }
      return { ok: true, value: await res.json() }
    } catch (e) {
      // A non-abort throw from .json() means the body was not parseable.
      return { ok: false, reason: abortedReason(e, 'response_malformed') }
    }
  }

  const reader = body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        try { await reader.cancel() } catch { /* best effort */ }
        return { ok: false, reason: 'response_too_large' }
      }
      chunks.push(value)
    }
  } catch (e) {
    // An aborted read lands here: the deadline fired mid-body.
    return { ok: false, reason: abortedReason(e) }
  }

  const joined = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { joined.set(c, off); off += c.byteLength }

  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(joined)) }
  } catch {
    return { ok: false, reason: 'response_malformed' }
  }
}

function abortedReason (e, otherwise = 'response_body_unreadable') {
  const name = e && typeof e === 'object' ? e.name : ''
  return name === 'AbortError' || name === 'TimeoutError'
    ? 'response_body_timeout'
    : otherwise
}
