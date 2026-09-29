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
 * Version identifier sent to the server as `consentPolicyVersion`.
 * Must equal the server's OUTLOOK_DISCLOSURE_VERSION, which is unset today.
 */
export const OUTLOOK_DISCLOSURE_VERSION = 'outlook-disclosure-draft-1'

/**
 * The exact text shown before any redirect. Every paragraph rendered by the
 * card comes from this array, and nothing else is shown as disclosure.
 */
export const OUTLOOK_DISCLOSURE_PARAGRAPHS = Object.freeze([
  'Connecting Outlook is optional. Funnl works fully without it, and you can disconnect at any time.',
  'You would grant two Microsoft permissions, both read-only. Mail.Read ("Read user mail") lets Funnl read messages in your Inbox and Sent Items. User.Read ("Sign in and read user profile") lets Funnl identify which mailbox you connected.',
  'Microsoft describes User.Read as allowing an app to read the signed-in user’s full profile and basic company information. Funnl asks it for three fields only — your account id, your mail address and your user principal name — and uses them only to record and display which mailbox is connected. The permission permits more than Funnl requests, which is why both are stated here.',
  'Mail.Read is mailbox-wide: it would technically allow reading message bodies and attachments anywhere in your mailbox. Funnl reads only Inbox and Sent Items, and never opens attachments.',
  'Funnl can never send, reply, delete, move or change anything in your mailbox. It does not read your Microsoft contacts, calendars or files, and it does not read your organisation’s directory, your colleagues or your manager.',
  'What Funnl would do with this: suggest networking contacts and draft interaction notes from relevant conversations. Nothing is saved as a contact or logged as an interaction until you review it and choose to accept it. You can edit or dismiss every suggestion.',
  'You can disconnect Outlook at any time from Settings. Disconnecting deletes your Microsoft connection, your stored authorisation and the synchronisation state.',
])

/**
 * Fingerprint of the paragraphs above. Any edit changes it.
 *
 * FNV-1a over the newline-joined text: deterministic, dependency-free and
 * synchronous, which matters because the consent control is disabled unless the
 * check passes at render time. This is an integrity check against accidental
 * drift between text and version, NOT a security primitive.
 */
export const DISCLOSURE_FINGERPRINT = '1f0d100b'

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
