// THE PRODUCER: turning a page's selected messages into protected handles the
// checkpoint can commit.
//
// The envelope pass has the Graph id, the folder and the timestamp in hand while
// a page is being folded. This module converts each one into the shape
// record_outlook_page_progress accepts:
//
//     { cfp, mfp, mid_ct, mid_nonce, key_version, folder, sent_at }
//
// and nothing else. No subject, no address, no display name, no body.
//
// ── THE CONSENT RULE, AND WHY IT APPLIES *HERE* ──────────────────────────────
// Storing a reference that lets Funnl re-read a message later is itself beyond
// what the envelope-only disclosure describes. The live pilot account agreed
// that Funnl may see who a message was between, when, and which folder - not
// that Funnl may keep a durable key to the message itself.
//
// So the content gate is checked HERE, in the producer, not only at the point of
// reading a body. With the gate closed this module emits an EMPTY array, the
// checkpoint stores no handles, and the import keeps exactly its current
// envelope-only behaviour. That is the whole reason it returns a reason code
// alongside the handles: the run logs why it produced none.
//
// ── WHAT IS PROTECTED, AND HOW ───────────────────────────────────────────────
//   * The id is ENCRYPTED with the injected sealer, which the caller has already
//     bound to the connection's key ring. This module never sees key material.
//   * The DEDUPE key is the message fingerprint the fold already computed - a
//     keyed HMAC, so it is deterministic (an AES-GCM ciphertext is not, its
//     nonce being random per call) and not reversible to an address.
//   * Ids are CASE-SENSITIVE, per Microsoft: "Immutable identifiers, like all
//     identifiers in Microsoft Graph, are case-sensitive." Nothing here
//     lowercases, trims or normalizes one.

import { contentPermissions } from './outlookContentConsent.js'

/** Mirrors the ciphertext CHECK on outlook_round_messages. */
export const MAX_HANDLE_CIPHERTEXT_CHARS = 1024
/** Mirrors the nonce CHECK. */
export const MAX_HANDLE_NONCE_CHARS = 64

export const PRODUCER_SKIPS = Object.freeze([
  'content_consent_missing',   // the gate is closed; no handle may be stored
  'no_selected_messages',      // the page contributed nothing to summarize
  'unusable_message_id',       // the provider id failed its shape check
  'missing_fingerprint',       // the fold did not supply one
  'ciphertext_too_large',      // the sealed id exceeded the column bound
  'seal_failed',               // encryption itself failed
])

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const FP_RE = /^[0-9a-f]{64}$/
const GRAPH_FOLDERS = new Set(['inbox', 'sentitems'])

/**
 * Conservative shape check for a Graph message id, mirroring
 * outlookGraphTransport.isUsableGraphId. Duplicated rather than imported so this
 * module stays independent of the transport.
 */
export function isUsableMessageId (id) {
  if (typeof id !== 'string') return false
  if (id.length === 0 || id.length > 1024) return false
  return /^[A-Za-z0-9_\-=+/.:]+$/.test(id) && !id.includes('..')
}

/**
 * Codes that mean a handle this page was REQUIRED to produce could not be produced.
 *
 * These are NOT the same as a malformed selection. A message that failed its own
 * shape checks was never a candidate for retrieval - the fold had nothing usable to
 * offer. But a message that passed every check and then failed to SEAL, or sealed to
 * something the column will not hold, is a message the page meant to make
 * retrievable and did not. Checkpointing such a page would commit a resume position
 * past an exchange that can no longer be summarized: the conversation row says six
 * messages, the handles say five, and nothing afterwards can tell that the sixth was
 * lost rather than never offered.
 *
 * So the page fails instead, and the previous checkpoint stands.
 */
export const HANDLE_FAILURES = Object.freeze(['seal_failed', 'ciphertext_too_large'])

/**
 * Build the handle array for ONE page.
 *
 * @param {object} p
 * @param {Array} p.selected   [{ cfp, mfp, messageId, folder, sentAtIso }] - the
 *                             messages this page contributed to a qualifying
 *                             conversation, with the id still in plaintext.
 * @param {string|null} p.consentVersion  microsoft_connections.consent_policy_version
 * @param {object} [p.requiredConsent]    injected only by tests
 * @param {Function} p.seal    async (plaintext) => { ciphertext, nonce, keyVersion }
 * @returns {Promise<{handles: Array, skipped: object, reason: string|null,
 *                    failure: string|null}>}
 *          `handles` is ready to pass as p_messages. `skipped` counts controlled
 *          codes. `reason` is set when the WHOLE page produced none. `failure` is set
 *          when a REQUIRED handle could not be produced - see HANDLE_FAILURES - and
 *          the caller must then NOT checkpoint the page.
 */
export async function buildMessageHandles (p) {
  const skipped = Object.create(null)
  const bump = (c) => { skipped[c] = (skipped[c] || 0) + 1 }
  if (!isPlainObject(p)) {
    return { handles: [], skipped, reason: 'no_selected_messages', failure: null }
  }

  // ── THE GATE, before a single id is sealed ───────────────────────────────
  const perms = contentPermissions(p.consentVersion, p.requiredConsent ?? {})
  if (!perms.body) {
    // Not an error and not a failure of the page: the import simply stays
    // envelope-only. The caller records the reason and carries on.
    // WITH THE GATE CLOSED THERE IS NO SUCH THING AS A FAILED HANDLE: none was
    // required, so `failure` stays null and the page checkpoints exactly as the
    // envelope-only import always has.
    return {
      handles: [], skipped, reason: 'content_consent_missing', consent: perms, failure: null,
    }
  }

  const selected = Array.isArray(p.selected) ? p.selected : []
  if (selected.length === 0) {
    return {
      handles: [], skipped, reason: 'no_selected_messages', consent: perms, failure: null,
    }
  }
  if (typeof p.seal !== 'function') throw new Error('seal_not_injected')

  const handles = []
  const seenFp = new Set()
  for (const m of selected) {
    if (!isPlainObject(m)) { bump('no_selected_messages'); continue }
    if (typeof m.mfp !== 'string' || !FP_RE.test(m.mfp)) { bump('missing_fingerprint'); continue }
    if (typeof m.cfp !== 'string' || !FP_RE.test(m.cfp)) { bump('missing_fingerprint'); continue }
    if (!GRAPH_FOLDERS.has(m.folder)) { bump('unusable_message_id'); continue }
    if (typeof m.sentAtIso !== 'string' || m.sentAtIso.length === 0) {
      // sent_at is NOT NULL on the table and the selection orders by it, so a
      // message without one cannot be ranked and is skipped rather than stored
      // with a guessed timestamp.
      bump('unusable_message_id'); continue
    }
    if (!isUsableMessageId(m.messageId)) { bump('unusable_message_id'); continue }
    // Within one page, the same message must be offered once: the checkpoint
    // dedupes on the fingerprint anyway, but sealing twice costs two AES calls
    // and two different ciphertexts for the same id.
    if (seenFp.has(m.mfp)) continue
    seenFp.add(m.mfp)

    // ── FROM HERE ON, A FAILURE FAILS THE PAGE ───────────────────────────
    // Every shape check above has passed, so this message IS one the page must
    // make retrievable. `continue` here used to drop it and hand back a shorter
    // array that the caller checkpointed - committing a resume position past an
    // exchange that could no longer be summarized in full, with nothing afterwards
    // able to tell the loss from a message never offered.
    let sealed
    try {
      sealed = await p.seal(m.messageId)
    } catch {
      // The thrown value is not read: it could carry the plaintext id.
      bump('seal_failed')
      return { handles: [], skipped, reason: null, consent: perms, failure: 'seal_failed' }
    }
    if (!isPlainObject(sealed)
        || typeof sealed.ciphertext !== 'string' || sealed.ciphertext.length === 0
        || typeof sealed.nonce !== 'string' || sealed.nonce.length === 0) {
      bump('seal_failed')
      return { handles: [], skipped, reason: null, consent: perms, failure: 'seal_failed' }
    }
    if (sealed.ciphertext.length > MAX_HANDLE_CIPHERTEXT_CHARS
        || sealed.nonce.length > MAX_HANDLE_NONCE_CHARS) {
      // Refused rather than truncated: a truncated ciphertext will not decrypt,
      // and storing one would turn a summarizable exchange into a permanent
      // fetch failure.
      bump('ciphertext_too_large')
      return {
        handles: [], skipped, reason: null, consent: perms, failure: 'ciphertext_too_large',
      }
    }

    handles.push({
      cfp: m.cfp,
      mfp: m.mfp,
      mid_ct: sealed.ciphertext,
      mid_nonce: sealed.nonce,
      key_version: Number.isInteger(sealed.keyVersion) ? sealed.keyVersion : 1,
      folder: m.folder,
      sent_at: m.sentAtIso,
    })
  }

  return {
    handles,
    skipped,
    reason: handles.length === 0 ? 'no_selected_messages' : null,
    consent: perms,
    failure: null,
  }
}

/**
 * The only shape of producer output that may be logged: counts and controlled
 * codes. Never an id, a ciphertext, a fingerprint or a consent version.
 */
export function summarizeProducer (out) {
  const skipped = isPlainObject(out?.skipped) ? out.skipped : {}
  const clean = Object.create(null)
  for (const [k, v] of Object.entries(skipped)) {
    if (PRODUCER_SKIPS.includes(k) && Number.isInteger(v)) clean[k] = v
  }
  return {
    handles: Array.isArray(out?.handles) ? out.handles.length : 0,
    skipped: clean,
    reason: PRODUCER_SKIPS.includes(out?.reason) ? out.reason : null,
    failure: HANDLE_FAILURES.includes(out?.failure) ? out.failure : null,
    content_allowed: out?.consent?.body === true,
  }
}
