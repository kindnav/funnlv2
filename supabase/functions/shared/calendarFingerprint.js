// Stable per-(event-occurrence, contact) fingerprint for Calendar candidates.
//
// Pure, cross-runtime (Node + Deno). Uses only TextEncoder + Web Crypto SubtleCrypto,
// both present in Node 20+ and Deno. No browser imports, no Supabase, no I/O.
//
// The fingerprint is the deterministic dedup key stored on interaction_candidates
// (UNIQUE(user_id, source_fingerprint)). It includes contact_id so a single group
// event occurrence with three matched contacts yields three DISTINCT fingerprints
// -> three coexisting candidate rows. It is version-prefixed so the scheme can
// evolve without silent collisions.

export const FINGERPRINT_VERSION = 'v1';

const encoder = new TextEncoder();

/**
 * Byte-length-prefixed encoding of one field: "<utf8ByteLength>:<value>".
 * Prefixing by exact UTF-8 byte length makes field boundaries unambiguous even
 * when a value itself contains a ':' or the delimiter — a decoder reads N bytes,
 * so "ab"+"c" can never collide with "a"+"bc".
 * @param {string} value
 * @returns {string}
 */
export function lengthPrefixedField(value) {
  const s = String(value);
  const byteLength = encoder.encode(s).length;
  return `${byteLength}:${s}`;
}

/**
 * Build the typed occurrence token used inside the fingerprint.
 * Timed occurrences and all-day occurrences are namespaced with distinct type
 * prefixes so a date and a datetime that render similarly can never collide:
 *   { kind: 'datetime', value: '2026-08-17T15:00:00.000Z' } -> 'datetime:2026-08-17T15:00:00.000Z'
 *   { kind: 'date',     value: '2026-08-17' }               -> 'date:2026-08-17'
 * @param {{kind: 'datetime'|'date', value: string}} occurrence
 * @returns {string}
 */
export function occurrenceToken(occurrence) {
  if (!occurrence || (occurrence.kind !== 'datetime' && occurrence.kind !== 'date')) {
    throw new Error('invalid_occurrence');
  }
  if (typeof occurrence.value !== 'string' || occurrence.value.length === 0) {
    throw new Error('invalid_occurrence_value');
  }
  return `${occurrence.kind}:${occurrence.value}`;
}

/**
 * Deterministic canonical input string for the fingerprint hash.
 * Fixed field order, each field length-prefixed. Pure and synchronous so tests
 * can assert boundary-collision resistance without hashing.
 *
 * @param {{
 *   version?: string,
 *   source: string,
 *   googleSub: string,
 *   calendarId: string,
 *   googleEventId: string,
 *   occurrence: {kind: 'datetime'|'date', value: string},
 *   contactId: string,
 * }} fields
 * @returns {string}
 */
export function fingerprintInput(fields) {
  if (!fields || typeof fields !== 'object') throw new Error('invalid_fingerprint_fields');
  const ordered = {
    version: fields.version ?? FINGERPRINT_VERSION,
    source: fields.source,
    googleSub: fields.googleSub,
    calendarId: fields.calendarId,
    googleEventId: fields.googleEventId,
    occurrence: occurrenceToken(fields.occurrence),
    contactId: fields.contactId,
  };
  const order = ['version', 'source', 'googleSub', 'calendarId', 'googleEventId', 'occurrence', 'contactId'];
  for (const key of order) {
    const v = ordered[key];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`invalid_fingerprint_field:${key}`);
    }
  }
  return order.map((key) => lengthPrefixedField(ordered[key])).join('');
}

/**
 * Compute the lowercase 64-char SHA-256 hex fingerprint for the given fields.
 * Async because SubtleCrypto.digest is async. subtle is injectable for tests.
 *
 * @param {Parameters<typeof fingerprintInput>[0]} fields
 * @param {SubtleCrypto} [subtle]
 * @returns {Promise<string>}
 */
export async function computeCandidateFingerprint(fields, subtle = globalThis.crypto?.subtle) {
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('subtle_crypto_unavailable');
  }
  const data = encoder.encode(fingerprintInput(fields));
  const digest = await subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
