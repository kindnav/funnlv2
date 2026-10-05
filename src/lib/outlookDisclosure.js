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
// The Outlook section at /privacy is the full account. This is the short version
// shown at the moment of the decision, so it summarises rather than repeats: the
// same facts, fewer words, and a pointer to the policy for the rest. It must never
// say LESS than the published policy about what happens to the user's mail, which
// is why it names the mailbox-wide reach of Mail.Read, what User.Read permits,
// what offline_access actually does, the envelope-only pilot read, the
// account-linked fingerprints, the review-before-save rule, and the limits of
// disconnect. Implementation detail belongs in the policy, not here: a consent
// screen nobody reads protects nobody.
//
// THE PUBLISHED/DISCLOSED DIVERGENCE IS RESOLVED IN THIS REVISION. The published
// /privacy section previously named Mail.Read alone while this named two scopes;
// both now describe the same six requested scopes (openid, profile, email,
// offline_access, Mail.Read, User.Read), with offline_access stated as continuing
// access rather than as a third thing to read. Publication is still a separate,
// owner-approved step: nothing here publishes or alters the live page.
//
// SCOPED TO THE FIRST PILOT, which reads ENVELOPES ONLY. The body reading and the
// Anthropic extract the previous revision described are not performed by any code
// on this branch: the worker issues DISCOVERY_SELECT only, and nothing in the
// Outlook path calls Anthropic. Those paragraphs were removed rather than kept as
// promises the implementation cannot keep; the published policy carries them as
// conditional on a later release.
//
// RETENTION WORDING IS MEASURED. tests/sql/outlook-pilot-retention-runtime.sql
// verifies that a round deadline does NOT delete working records, that an expired
// suggestion stays pending without a scheduled sweep, and that disconnect leaves
// the invalidated suggestion row in place still carrying its contact, date and
// fingerprint. The paragraphs below say exactly that and no more.

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
  'Access is restricted to one designated Funnl-controlled test account. Funnl’s servers refuse a connection request from any other account.',
  'You would grant six Microsoft scopes. Two of them read data, and both are read-only: Mail.Read ("Read user mail") and User.Read ("Sign in and read user profile"). Three are the standard sign-in scopes openid, profile and email. The sixth, offline_access, grants no new access of its own — it is what lets Funnl keep using those two read permissions while you are not using the app, so a read can run without asking you to sign in again.',
  'Microsoft grants those two more broadly than Funnl uses them. Mail.Read is granted at the mailbox level: it would technically permit reading message bodies and attachments anywhere in your mailbox. User.Read permits your profile and basic company information; Funnl asks it for three fields and uses them only to record which mailbox is connected. Neither requires administrator consent by default, but a work or school tenant can be configured to require an administrator to approve the app, and then you may not be able to consent for yourself.',
  'This first pilot reads message envelopes only — who sent each message, who it was addressed to, the subject, the times, which conversation it belongs to and whether it is a draft — from your Inbox and Sent Items. It does not fetch message bodies or attachments, and sends nothing to Anthropic or any other AI service. Funnl can never send, reply, delete, move or change anything in your mailbox, and does not read your Microsoft contacts, calendars, files or your organisation’s directory.',
  'Nothing is saved to your network until you approve it. Funnl proposes an interaction for someone already in your contacts, and you accept, edit, dismiss or defer it. Funnl never creates a contact or logs an interaction on its own, and this pilot proposes no new contacts.',
  'A suggestion keeps the contact, the date, the type (Email) and one-way fingerprints of the exchange, so the same conversation is not suggested twice. Those fingerprints are pseudonymous but are stored against your account, so they are personal data about you; they cannot be turned back into a message, an address or a subject line. No subject line, summary or message text is kept.',
  'While a read is in progress Funnl keeps working records of the same kind, one per conversation it is part-way through. They belong to that single read, which becomes unusable 24 hours after it starts. Becoming unusable is not the same as being erased: they are actually removed when a later read starts, when a read completes, when a read is reset, or when you disconnect. Waiting, or looking at the progress of a read, removes nothing — so if a read is abandoned and none of those happens, its working records stay stored.',
  'You can disconnect at any time from this screen. That deletes the connection, the stored Microsoft authorisation, the mailbox synchronisation state, the working records and the provenance records, and invalidates any suggestion you have not reviewed. An invalidated suggestion is not deleted: it keeps the contact, the date and its fingerprint so the same exchange is not suggested again, and it goes when you delete that contact or your Funnl account.',
  'Disconnecting removes Funnl’s copy of the authorisation, so Funnl has nothing left to start a new read with. A read already under way may finish using access it had already obtained. Disconnecting does not withdraw the permission at Microsoft — to do that, remove Funnl from the permissions page of your Microsoft account.',
  'Funnl’s Privacy Policy sets all of this out in full, including what is kept and when it is deleted.',
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
export const DISCLOSURE_FINGERPRINT = '81fe8944fd2be59ac3c059c229b4d28e'

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
