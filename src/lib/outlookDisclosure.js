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
// SEPARATE FROM THE PUBLISHED PRIVACY POLICY, AND NARROWER THAN IT.
// The conditional Outlook section already live at /privacy is the full account.
// This is the short version shown at the moment of the decision, so it
// summarises rather than repeats: the same facts, fewer words. It must never say
// LESS than the published policy about what happens to the user's mail, which is
// why it names the two-step read, the absence of body storage, Anthropic and
// Anthropic's actual retention terms.
//
// ONE UNRESOLVED DIVERGENCE: the live /privacy section names Mail.Read only,
// while this names Mail.Read and User.Read. That blocks consent collection until
// the published text is revised. Nothing here publishes or alters it; see
// docs/outlook-privacy-consent-readiness.md.

import { sha256Hex } from './sha256.js'

/**
 * Stable prefix. The version itself is NOT this string: see below.
 */
// 7 characters; with the joining hyphen and 32 hex that is exactly the
// 40-character ceiling in the microsoft_oauth_states consent_policy_version CHECK.
export const DISCLOSURE_VERSION_PREFIX = 'ol-disc'

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
  'Funnl would read those two folders in two steps. First the envelope of each message — who sent it, who it was addressed to, the subject, the times, which conversation it belongs to and whether it is a draft — to decide whether the message is worth reading at all. Then, only for the messages that pass that check, the message text itself: Microsoft’s plain-text version of the body and the version that leaves out the quoted reply history, plus five headers that identify newsletters, mailing lists and automatic replies. Those five are reduced to yes/no facts and then discarded.',
  'Funnl does not store your emails. Message text is held in server memory only while a message is being processed. Funnl’s database has no column that can hold a message body, HTML, raw MIME, an attachment, a preview snippet or a collection of headers.',
  'To turn an exchange into a draft you can edit, Funnl would send Anthropic (Claude) a minimized extract: the message text, an optional signature block, a shortened subject, the direction and the date. The two people are labelled only USER and CONTACT. Email addresses, the recipient’s email domain, Microsoft account, tenant, message and conversation identifiers, authorisation tokens, attachments and raw headers are not included.',
  'Anthropic deletes API inputs and outputs within 30 days. Funnl does not have a Zero Data Retention agreement. If Anthropic’s automated systems flag content as violating their Usage Policy, Anthropic may keep those inputs and outputs for up to 2 years, and the related trust-and-safety classification scores for up to 7 years. Anthropic does not train its models on commercial API data by default, and does not offer per-record deletion to paid API customers, so Funnl cannot promise to have an individual record deleted on request.',
  'What Funnl would do with all of this: suggest networking contacts and draft interaction notes from relevant conversations. Nothing is saved as a contact or logged as an interaction until you review it and choose to accept it. You can edit or dismiss every suggestion.',
  'You can disconnect at any time from this screen. Disconnecting deletes the connection, the stored Microsoft authorisation and the mailbox synchronisation state, and empties any suggestion you have not reviewed: each becomes inactive and its proposed details and drafts are removed. Contacts and interactions you already saved are kept.',
  'Disconnecting removes Funnl’s copy of the authorisation, so Funnl has nothing left to start a new read with. A read already under way may finish using access it had already obtained. Disconnecting does not withdraw the permission at Microsoft — to do that, remove Funnl from the permissions page of your Microsoft account.',
])

/**
 * Content digest of the paragraphs above.
 *
 * WHY NOT THE EARLIER FNV-1a. That was a 32-bit non-cryptographic hash chosen
 * for being short and synchronous. Two distinct texts collide under it readily
 * - a test exhibits an actual colliding pair - so the claim that a text change
 * NECESSARILY changes the version was false: an edit could have landed on the
 * same fingerprint and kept the old version, letting one recorded
 * consent_policy_version describe two documents.
 *
 * This is SHA-256 truncated to 128 bits (32 hex characters).
 *
 * WHAT THAT ACTUALLY GUARANTEES, stated without overclaiming: finding two
 * different texts sharing a truncated digest is computationally infeasible with
 * any known method - roughly 2^64 work for a birthday collision on 128 bits -
 * not mathematically impossible. For distinguishing drafts of a consent notice,
 * including against someone deliberately trying, that is sound. It is a content
 * identifier, not a signature: it says nothing about who wrote the text.
 */
export const DIGEST_HEX_CHARS = 32

/** @param {readonly string[]} paragraphs */
export function disclosureFingerprint (paragraphs) {
  const text = (Array.isArray(paragraphs) ? paragraphs : []).join(String.fromCharCode(10))
  return sha256Hex(text).slice(0, DIGEST_HEX_CHARS)
}
/**
 * The digest the CURRENT version was declared against. Updating this is a
 * deliberate act: it records that someone reviewed the new text. Because the
 * version is derived from the same digest, updating it also changes the
 * version, so a reviewed edit can never quietly keep the old identifier.
 */
export const DISCLOSURE_FINGERPRINT = '34f8d13dc657d2d6ca6377f0c93ca427'

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
 * Shape: <prefix>-<32 hex>. Exactly 40 characters, no whitespace or control
 * characters, so it satisfies the microsoft_oauth_states consent_policy_version
 * CHECK (1..40 chars, no whitespace/control) exactly at its ceiling.
 */
export function computeDisclosureVersion (
  paragraphs = OUTLOOK_DISCLOSURE_PARAGRAPHS,
  prefix = DISCLOSURE_VERSION_PREFIX,
) {
  return `${prefix}-${disclosureFingerprint(paragraphs)}`
}

export const OUTLOOK_DISCLOSURE_VERSION = computeDisclosureVersion()
