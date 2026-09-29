// The just-in-time Outlook disclosure, and the binding between its TEXT and its
// VERSION.
//
// THE PROBLEM THIS SOLVES
// `outlook-oauth-start` records `consent_policy_version` as durable evidence of
// what a user agreed to, and `finalize_microsoft_connection` copies it onto the
// connection. A UI that sent a hardcoded version string without displaying the
// matching text would manufacture that evidence: the row would name a document
// the user never saw.
//
// So the version is not a constant that happens to sit near the text. It is
// bound to the text by a fingerprint computed over the exact paragraphs this
// module exports, and `verifyDisclosureIntegrity()` recomputes it. Editing a
// single character without updating DISCLOSURE_FINGERPRINT makes the check fail,
// which disables the consent control. A test asserts that.
//
// NOT PUBLISHED, NOT APPROVED. This wording is a draft derived from
// docs/outlook-privacy-consent-readiness.md. It is inert while
// VITE_OUTLOOK_CONNECTION_ENABLED is off, and the server refuses to mint a state
// unless OUTLOOK_DISCLOSURE_VERSION is configured to match. Both must be
// approved together before either is enabled.
//
// SEPARATE FROM THE PUBLISHED PRIVACY POLICY. The conditional Outlook section
// already live at /privacy names Mail.Read only. This disclosure names two
// permissions. That discrepancy is unresolved and blocks consent collection; see
// docs/outlook-privacy-consent-readiness.md.

/**
 * Stable prefix. The version itself is NOT this string: see below.
 */
export const DISCLOSURE_VERSION_PREFIX = 'outlook-disclosure-draft'

/**
 * The exact text shown before any redirect. Every paragraph rendered by the
 * card comes from this array, and nothing else is shown as disclosure.
 */
export const OUTLOOK_DISCLOSURE_PARAGRAPHS = Object.freeze([
  'Connecting Outlook is optional. Funnl works fully without it.',
  'You would grant two Microsoft permissions, both read-only. Mail.Read ("Read user mail") lets Funnl read messages in your Inbox and Sent Items. User.Read ("Sign in and read user profile") lets Funnl identify which mailbox you connected.',
  'Microsoft describes User.Read as allowing an app to read the signed-in user’s full profile and basic company information. Funnl asks it for three fields only — your account id, your mail address and your user principal name — and uses them only to record and display which mailbox is connected. The permission permits more than Funnl requests, which is why both are stated here.',
  'Mail.Read is mailbox-wide: it would technically allow reading message bodies and attachments anywhere in your mailbox. Funnl reads only Inbox and Sent Items, and never opens attachments.',
  'Funnl can never send, reply, delete, move or change anything in your mailbox. It does not read your Microsoft contacts, calendars or files, and it does not read your organisation’s directory, your colleagues or your manager.',
  'What Funnl would do with this: suggest networking contacts and draft interaction notes from relevant conversations. Nothing is saved as a contact or logged as an interaction until you review it and choose to accept it. You can edit or dismiss every suggestion.',
  'Disconnecting is not built yet. Until it is, do not connect an account you would need to disconnect: there is currently no way to remove the connection, the stored authorisation or the synchronisation state from this screen.',
])

/**
 * Fingerprint of the paragraphs above. Any edit changes it.
 *
 * FNV-1a over the newline-joined text: deterministic, dependency-free and
 * synchronous, which matters because the consent control is disabled unless the
 * check passes at render time. This is an integrity check against accidental
 * drift between text and version, NOT a security primitive.
 */
export const DISCLOSURE_FINGERPRINT = 'f09284dc'

/** @param {readonly string[]} paragraphs */
export function disclosureFingerprint (paragraphs) {
  const text = (Array.isArray(paragraphs) ? paragraphs : []).join('\n')
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * True only when the paragraphs still match the fingerprint the version was
 * declared against. False disables the consent control: a version whose text
 * has drifted is not evidence of anything.
 */
export function verifyDisclosureIntegrity (
  paragraphs = OUTLOOK_DISCLOSURE_PARAGRAPHS,
  fingerprint = DISCLOSURE_FINGERPRINT,
) {
  return disclosureFingerprint(paragraphs) === fingerprint
}

/**
 * The version identifier sent to the server as `consentPolicyVersion`.
 *
 * DERIVED FROM THE TEXT, not declared alongside it. An earlier revision used a
 * fixed string, which left a real hole: edit the paragraphs, update
 * DISCLOSURE_FINGERPRINT to match, and the integrity check passes again while
 * the version stays the same - so one recorded consent_policy_version could
 * describe two different documents. Because the fingerprint is part of the
 * version, any text change necessarily produces a different version, and the
 * server's exact-string comparison then refuses the stale one.
 *
 * Shape: <prefix>-<8 hex>. 32 characters, no whitespace or control characters,
 * so it satisfies the microsoft_oauth_states consent_policy_version CHECK
 * (1..40 chars, no whitespace/control).
 */
export function computeDisclosureVersion (
  paragraphs = OUTLOOK_DISCLOSURE_PARAGRAPHS,
  prefix = DISCLOSURE_VERSION_PREFIX,
) {
  return `${prefix}-${disclosureFingerprint(paragraphs)}`
}

export const OUTLOOK_DISCLOSURE_VERSION = computeDisclosureVersion()
