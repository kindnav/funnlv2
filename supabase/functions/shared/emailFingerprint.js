// Phase E1 — versioned HMAC-SHA256 fingerprint for email suggestion candidates.
//
// Pure, cross-runtime. No module-level secret, no env access, no logging, no network.
// The HMAC key is DEPENDENCY-INJECTED (raw bytes) so E1 carries no real secret; the
// real key arrives as an Edge secret in a later phase. The output is exactly 64 lowercase
// hex chars → satisfies the existing interaction_candidates.source_fingerprint CHECK
// (^[0-9a-f]{64}$) while being KEYED (irreversible) unlike the unkeyed Calendar SHA-256.
//
// Logical inputs (all required, all committed into the MAC):
//   format version, key version, provider, account namespace (connection/account),
//   contact id, provider conversation key, first qualifying message key of the episode.
// The episode boundary is the FIRST QUALIFYING MESSAGE KEY — never a bare date — so
// two episodes of the same conversation get distinct fingerprints deterministically.
//
// Canonical encoding is length-prefixed per field, so no field value can forge a field
// boundary (collision resistance). Rotating the key/version yields new fingerprints for
// new candidates without recomputing existing stored ones (store keyVersion alongside).

export const FINGERPRINT_VERSION = 'e1'
export const FINGERPRINT_HEX_LEN = 64
export const REQUIRED_FIELDS = Object.freeze([
  'provider', 'accountNamespace', 'contactId', 'conversationKey', 'firstMessageKey',
])
export const MAX_FIELD_LEN = 1024

const encoder = new TextEncoder()

/**
 * Length-prefixed canonical field: "<utf8ByteLength>:<value>". The byte-length prefix
 * makes boundaries unambiguous so no value can inject a separator collision.
 * @param {string} value
 * @returns {string}
 */
export function lengthPrefixedField(value) {
  if (typeof value !== 'string') throw new Error('invalid_fingerprint_field_type')
  if (value.length > MAX_FIELD_LEN) throw new Error('fingerprint_field_too_long')
  return `${encoder.encode(value).length}:${value}`
}

/**
 * Deterministic canonical input string committed by the HMAC. Fails closed on any
 * missing/blank/oversized field. Never returns or throws the field VALUES.
 * @param {Record<string,unknown>} fields
 * @param {number} keyVersion
 * @returns {string}
 */
export function fingerprintInput(fields, keyVersion) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('invalid_fingerprint_fields')
  if (!Number.isInteger(keyVersion) || keyVersion < 1) throw new Error('invalid_key_version')
  for (const k of REQUIRED_FIELDS) {
    const v = fields[k]
    if (typeof v !== 'string' || v.length === 0) throw new Error(`invalid_fingerprint_field:${k}`)
  }
  const parts = [
    lengthPrefixedField(FINGERPRINT_VERSION),
    lengthPrefixedField(String(keyVersion)),
    ...REQUIRED_FIELDS.map((k) => lengthPrefixedField(fields[k])),
  ]
  return parts.join('|')
}

/**
 * Compute the 64-char lowercase-hex keyed fingerprint.
 * @param {Record<string,unknown>} fields
 * @param {{ subtle?: SubtleCrypto, keyBytes: Uint8Array, keyVersion: number }} deps
 * @returns {Promise<string>} 64 lowercase hex characters
 */
export async function computeEmailFingerprint(fields, deps = {}) {
  const { subtle = globalThis.crypto?.subtle, keyBytes, keyVersion } = deps
  if (!subtle || typeof subtle.importKey !== 'function' || typeof subtle.sign !== 'function') {
    throw new Error('subtle_unavailable')
  }
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length === 0) throw new Error('invalid_hmac_key')
  const input = fingerprintInput(fields, keyVersion) // also validates keyVersion
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await subtle.sign('HMAC', key, encoder.encode(input))
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Bounded key ring — one current write key plus a small set of accepted prior read keys.
export const MAX_KEYRING_KEYS = 5

/**
 * Produce the write fingerprint (under the CURRENT key) and the lookup fingerprints (under
 * the current key AND every accepted prior key) for one candidate. The DB layer must, in a
 * single transaction guarded by the source_fingerprint UNIQUE constraint, check whether ANY
 * lookupFingerprint already exists for this user before inserting under writeFingerprint —
 * so a key rotation never produces a duplicate candidate for the same historical episode.
 * Terminal historical fingerprints are NEVER rewritten merely because a key rotated: this
 * helper only computes values; it does not mutate storage.
 *
 * @param {Record<string,unknown>} fields
 * @param {{ current: { keyBytes: Uint8Array, keyVersion: number },
 *           accepted?: Array<{ keyBytes: Uint8Array, keyVersion: number }>,
 *           subtle?: SubtleCrypto }} keyRing
 * @returns {Promise<{ writeFingerprint: string, writeKeyVersion: number,
 *                     lookupFingerprints: Array<{ keyVersion: number, fingerprint: string }> }>}
 */
export async function computeFingerprintSet(fields, keyRing = {}) {
  const { current, accepted = [], subtle } = keyRing
  if (!current || typeof current !== 'object') throw new Error('invalid_keyring_current')
  if (!Array.isArray(accepted)) throw new Error('invalid_keyring_accepted')
  const ring = [current, ...accepted]
  if (ring.length > MAX_KEYRING_KEYS) throw new Error('keyring_too_large')
  const seenVersions = new Set()
  for (const k of ring) {
    if (!k || typeof k !== 'object') throw new Error('invalid_keyring_key')
    if (!Number.isInteger(k.keyVersion) || k.keyVersion < 1) throw new Error('invalid_key_version')
    if (seenVersions.has(k.keyVersion)) throw new Error('duplicate_key_version')
    seenVersions.add(k.keyVersion)
    if (!(k.keyBytes instanceof Uint8Array) || k.keyBytes.length === 0) throw new Error('invalid_hmac_key')
  }
  const lookupFingerprints = []
  for (const k of ring) {
    const fingerprint = await computeEmailFingerprint(fields, { subtle, keyBytes: k.keyBytes, keyVersion: k.keyVersion })
    lookupFingerprints.push({ keyVersion: k.keyVersion, fingerprint })
  }
  return {
    writeFingerprint: lookupFingerprints[0].fingerprint,
    writeKeyVersion: current.keyVersion,
    lookupFingerprints,
  }
}
