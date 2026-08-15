// Stripe HMAC-SHA256 signature verification — extracted as a plain-JS module so it
// can be imported and tested from Node.js without a Deno runtime.
//
// Stripe sends: stripe-signature: t=TIMESTAMP,v1=SIG[,v1=SIG2,...]
// Signed payload = "${timestamp}.${rawBody}"
// Expected signature = HMAC-SHA256(webhookSecret, signedPayload), hex-encoded.
// Replay protection: reject events whose timestamp is outside the tolerance window.
//
// Security: uses crypto.subtle.verify (constant-time) — never string equality.
// The key is imported for ['verify'] usage only. Multiple v1 signatures are
// supported for Stripe key rotation. Malformed hex signatures are silently skipped.
//
// Determinism for tests: `now` (seconds) and `subtle` are injectable. In production
// they default to the real wall clock and the global Web Crypto implementation
// (available as globalThis.crypto.subtle in both Deno and Node 20+).

export const DEFAULT_TOLERANCE_SECONDS = 300

/**
 * @param {string} rawBody   — exact bytes Stripe signed (request body as text)
 * @param {string} sigHeader — value of the `stripe-signature` header
 * @param {string} secret    — the webhook signing secret (whsec_...)
 * @param {object} [opts]
 * @param {() => number} [opts.now]        — current time in Unix SECONDS (injectable)
 * @param {number}       [opts.tolerance]  — max allowed skew in seconds (default 300)
 * @param {SubtleCrypto} [opts.subtle]     — Web Crypto subtle (injectable)
 * @returns {Promise<boolean>} true only when at least one v1 signature verifies
 *          AND the timestamp is within tolerance.
 */
export async function verifyStripeSignature(rawBody, sigHeader, secret, opts = {}) {
  const now       = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE_SECONDS
  const subtle    = opts.subtle ?? globalThis.crypto?.subtle

  if (typeof rawBody !== 'string' || typeof sigHeader !== 'string' || typeof secret !== 'string' || !secret) {
    return false
  }
  if (!subtle) return false

  const parts   = sigHeader.split(',')
  const tPart   = parts.find(p => p.startsWith('t='))
  const v1Parts = parts.filter(p => p.startsWith('v1='))
  if (!tPart || !v1Parts.length) return false

  const timestamp = tPart.slice(2)
  if (!timestamp || isNaN(Number(timestamp))) return false

  // Replay protection: reject timestamps outside the tolerance window (past OR future).
  const current = now()
  if (Math.abs(current - Number(timestamp)) > tolerance) return false

  const signedPayload = `${timestamp}.${rawBody}`
  const payloadBytes  = new TextEncoder().encode(signedPayload)
  const secretBytes   = new TextEncoder().encode(secret)

  // Import key for VERIFY usage — required by crypto.subtle.verify.
  const key = await subtle.importKey(
    'raw', secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['verify'],
  )

  // Check each v1 signature with constant-time crypto.subtle.verify.
  // Stripe may send multiple signatures during key rotation — match any one.
  for (const part of v1Parts) {
    const hexSig = part.slice(3)
    // Reject malformed hex: empty, odd length, or non-hex characters.
    if (!hexSig || hexSig.length % 2 !== 0) continue
    if (!/^[0-9a-fA-F]+$/.test(hexSig)) continue
    const sigBytes = new Uint8Array(hexSig.length / 2)
    for (let i = 0; i < hexSig.length; i += 2) {
      sigBytes[i / 2] = parseInt(hexSig.slice(i, i + 2), 16)
    }
    const isMatch = await subtle.verify('HMAC', key, sigBytes, payloadBytes)
    if (isMatch) return true
  }
  return false
}
