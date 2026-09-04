// Phase E1 — provider-neutral normalized email-message contract.
//
// Pure, cross-runtime (Node + Deno). No imports, no I/O, no network, no DB, no secrets.
// This module defines the ONLY shape the deterministic email classifier consumes.
// Provider raw-response adapters (Gmail/Outlook) are deferred to E2/E3; they will emit
// this shape. The classifier never sees a raw provider response.
//
// PRIVACY INVARIANT (enforced by assertSafeNormalizedMessage below): a normalized
// message NEVER carries a body, body preview, HTML, snippet, attachments, inline
// content, tracking data, or a complete raw provider response. Only metadata facts the
// classifier needs are allowed. The transient `subject` is an input-only field, capped
// and control-stripped; it is never logged, fingerprinted, or persisted before a
// conversation qualifies (see emailConversationClassifier + the E1 design doc).

// Bounded input limits — fail closed above these (defensive, not a product rule).
export const MAX_SUBJECT_INPUT = 998        // RFC 5322 line length; sanitized further downstream
export const MAX_RECIPIENTS = 200           // per header; conversations are capped far lower by policy
export const MAX_ADDR_LEN = 320             // RFC 5321 max email length
export const MAX_KEY_LEN = 1024             // provider message/conversation id ceiling

// Providers recognized by the classifier. Transport is not implemented here.
export const EMAIL_PROVIDERS = Object.freeze(['gmail', 'outlook'])

// Allowlisted automation-header FACTS (booleans / small controlled enums), never raw
// header values. Adapters map provider headers to these; the classifier reads only these.
export const AUTOMATION_FACT_KEYS = Object.freeze([
  'autoSubmitted',        // 'no' | 'auto-generated' | 'auto-replied' | 'other' | null
  'precedence',           // 'bulk' | 'list' | 'junk' | 'other' | null
  'hasListId',            // boolean
  'hasListUnsubscribe',   // boolean
  'hasAutoResponseSuppress', // boolean
])

// Direction hints an adapter may provide from the folder it read (inbox vs sent).
export const FOLDER_HINTS = Object.freeze(['inbox', 'sent', 'unknown'])

/**
 * @typedef {Object} AutomationFacts
 * @property {('no'|'auto-generated'|'auto-replied'|'other'|null)} autoSubmitted  Allowlisted Auto-Submitted classification.
 * @property {('bulk'|'list'|'junk'|'other'|null)} precedence  Allowlisted Precedence classification.
 * @property {boolean} hasListId               List-ID header present.
 * @property {boolean} hasListUnsubscribe      List-Unsubscribe header present.
 * @property {boolean} hasAutoResponseSuppress X-Auto-Response-Suppress header present.
 */

/**
 * @typedef {Object} NormalizedMessage
 * The provider-independent message the classifier consumes. Metadata only.
 * @property {('gmail'|'outlook')} provider
 * @property {string} providerMessageKey      Opaque provider message id (gmail id | outlook internetMessageId/id).
 * @property {string} providerConversationKey Opaque thread/conversation id (gmail threadId | outlook conversationId).
 * @property {string} timestampIso            RFC3339/ISO 8601 UTC instant of the message.
 * @property {string} fromAddress             Raw From mailbox header value (parsed downstream; may be malformed).
 * @property {string[]} toAddresses           Raw To header mailbox-list values (parsed downstream).
 * @property {string[]} ccAddresses           Raw Cc header mailbox-list values (parsed downstream).
 * @property {string} subject                 TRANSIENT input subject (unsanitized here); capped/sanitized only after eligibility. Never persisted/logged pre-qualification.
 * @property {AutomationFacts} automation      Allowlisted automation facts (never raw header values).
 * @property {('inbox'|'sent'|'unknown')} folderHint  Which folder the adapter read this from.
 *
 * PROHIBITED (never present): body, bodyPreview, snippet, html, textBody, attachments,
 * inlineImages, trackingPixels, rawHeaders, rawResponse, labels beyond the allowlist.
 */

// Keys that must NEVER appear on a normalized message (defense-in-depth privacy guard).
export const PROHIBITED_KEYS = Object.freeze([
  'body', 'bodyPreview', 'uniqueBody', 'snippet', 'html', 'htmlBody', 'textBody',
  'text', 'preview', 'attachments', 'inlineImages', 'inline', 'trackingPixels',
  'rawHeaders', 'headers', 'rawResponse', 'raw', 'internetMessageHeaders', 'mimeContent',
])

const OWN_PROTO_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype'])

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Fail-closed structural + privacy validation of a normalized message. Returns a
 * controlled reason code string on rejection, or null when the shape is acceptable.
 * NEVER throws and NEVER echoes any field value — only a controlled code.
 * @param {unknown} m
 * @returns {(null|'not_object'|'prototype_pollution'|'prohibited_content'|'bad_provider'|'bad_key'|'bad_timestamp'|'bad_addresses'|'oversized')}
 */
export function classifyNormalizedMessage(m) {
  if (!isPlainObject(m)) return 'not_object'
  for (const k of OWN_PROTO_KEYS) {
    if (Object.prototype.hasOwnProperty.call(m, k)) return 'prototype_pollution'
  }
  for (const k of PROHIBITED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(m, k)) return 'prohibited_content'
  }
  if (!EMAIL_PROVIDERS.includes(m.provider)) return 'bad_provider'
  if (typeof m.providerMessageKey !== 'string' || m.providerMessageKey.length === 0 || m.providerMessageKey.length > MAX_KEY_LEN) return 'bad_key'
  if (typeof m.providerConversationKey !== 'string' || m.providerConversationKey.length === 0 || m.providerConversationKey.length > MAX_KEY_LEN) return 'bad_key'
  if (typeof m.timestampIso !== 'string' || !isIsoUtcInstant(m.timestampIso)) return 'bad_timestamp'
  if (typeof m.fromAddress !== 'string' || m.fromAddress.length > MAX_SUBJECT_INPUT) return 'bad_addresses'
  if (!isBoundedStringArray(m.toAddresses) || !isBoundedStringArray(m.ccAddresses)) return 'bad_addresses'
  if (typeof m.subject !== 'string' || m.subject.length > MAX_SUBJECT_INPUT) return 'oversized'
  return null
}

/** True when a value is an array of strings within recipient/length bounds. */
export function isBoundedStringArray(a) {
  if (!Array.isArray(a) || a.length > MAX_RECIPIENTS) return false
  for (const s of a) {
    if (typeof s !== 'string' || s.length > MAX_SUBJECT_INPUT) return false
  }
  return true
}

/**
 * Conservative ISO-8601 UTC instant check (fails closed). Accepts a `Z` or +00:00
 * offset only; the classifier never trusts local-offset ambiguity for ordering.
 * @param {string} s
 * @returns {boolean}
 */
export function isIsoUtcInstant(s) {
  if (typeof s !== 'string' || s.length < 20 || s.length > 40) return false
  // YYYY-MM-DDTHH:MM:SS(.fff)?(Z|+00:00)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|\+00:00)$/.test(s)) return false
  const t = Date.parse(s)
  return Number.isFinite(t)
}
