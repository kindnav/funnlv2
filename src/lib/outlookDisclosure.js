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
// NOT PUBLISHED, NOT APPROVED. This wording is the content-release draft in
// docs/outlook-content-disclosure-draft.md section A, awaiting owner approval.
//
// THREE DIFFERENT VALUES, AND THEY ARE NOT INTERCHANGEABLE. Earlier notes in this
// branch said OUTLOOK_DISCLOSURE_VERSION was "unset in every environment", which was
// wrong and contradicted the project's own history:
//
//   1. OUTLOOK_DISCLOSURE_VERSION, server-side, read by outlook-oauth-start and
//      stamped into the OAuth state. It WAS configured in Production for the
//      envelope-only text (ol-disc-81fe8944fd2be59ac3c059c229b4d28e): the pilot
//      connected under it and completed a real import, which that function would
//      have refused with config_missing otherwise. Its CURRENT value has not been
//      read from this branch and is not asserted here either way.
//   2. The version derived below, from THIS text. It is new, and is configured
//      nowhere.
//   3. REQUIRED_CONTENT_CONSENT_VERSION and REQUIRED_THIRD_PARTY_CONSENT_VERSION in
//      supabase/functions/shared/outlookContentConsent.js, both null. These are what
//      gate body reading and the third-party call, and while they are null the server
//      performs neither - whatever any connection recorded, and whatever (1) is set
//      to.
//
// So this file decides what a user is TOLD. (3) decides what the server will DO, and
// it currently does neither.
//
// SEPARATE FROM THE PUBLISHED PRIVACY POLICY, AND NARROWER THAN IT.
// The Outlook section at /privacy is the full account. This is the short version
// shown at the moment of the decision, so it summarises rather than repeats: the
// same facts, fewer words, and a pointer to the policy for the rest. It must never
// say LESS than the published policy about what happens to the user's mail, which
// is why it names the mailbox-wide reach of Mail.Read, what User.Read permits,
// what offline_access actually does, what is read from the mailbox, what leaves it
// for Anthropic and on what retention terms, the account-linked fingerprints, the
// review-before-save rule, and the limits of disconnect. Implementation detail
// belongs in the policy, not here: a consent screen nobody reads protects nobody.
//
// THE PUBLISHED/DISCLOSED DIVERGENCE IS RESOLVED IN THIS REVISION. The published
// /privacy section previously named Mail.Read alone while this named two scopes;
// both now describe the same six requested scopes (openid, profile, email,
// offline_access, Mail.Read, User.Read), with offline_access stated as continuing
// access rather than as a third thing to read. Publication is still a separate,
// owner-approved step: nothing here publishes or alters the live page.
//
// THIS REVISION COVERS THE CONTENT RELEASE, and three of the eleven envelope-only
// paragraphs are REPLACED rather than supplemented, because they state the opposite
// of what it does:
//
//   * "reads message envelopes only ... sends nothing to Anthropic" -> paragraph 5,
//     which states what is read from a two-sided exchange;
//   * "this pilot proposes no new contacts" -> paragraph 9, which describes the
//     proposal;
//   * "No subject line, summary or message text is kept" -> paragraph 8, which
//     states what IS kept and that the message text is not.
//
// Adding to them without removing them would publish a notice that both promises
// and denies body reading, and a version derived from such a text would be
// evidence of nothing. The in-flight acknowledgement is unchanged and deliberately
// kept verbatim: it was correct before this release and is correct after it.
//
// NO SCOPE CHANGE. Mail.Read already permitted body reading - paragraph 4 has
// always said so. What changes is what Funnl DOES with a permission it already
// had, which is exactly why fresh consent is required rather than a new scope.
//
// RETENTION WORDING IS MEASURED. tests/sql/outlook-pilot-retention-runtime.sql
// verifies that a round deadline does NOT delete working records, that an expired
// suggestion stays pending without a scheduled sweep, and that disconnect leaves
// the invalidated suggestion row in place still carrying its contact, date and
// fingerprint. tests/sql/outlook-accept-expiry-runtime.sql verifies that an expired
// Outlook suggestion cannot be accepted. The paragraphs below say exactly that and
// no more - in particular paragraph 12 states that waiting removes nothing, because
// no sweep is scheduled.
//
// ANTHROPIC'S RETENTION FIGURES ARE NOT VERIFIABLE FROM THIS REPOSITORY. Paragraph 7
// quotes its published commercial data-retention policy, read while this text was
// prepared. Anthropic can change it without Funnl knowing, so it must be re-read at
// publication - recorded as a publication step in the disclosure draft.

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
  'Access is restricted to one designated Funnl-controlled test account. Funnl’s servers '
    + 'refuse a connection request from any other account.',
  'You would grant six Microsoft scopes. Two of them read data, and both are read-only: '
    + 'Mail.Read (“Read user mail”) and User.Read (“Sign in and read user profile”). Three '
    + 'are the standard sign-in scopes openid, profile and email. The sixth, offline_access, '
    + 'grants no new access of its own — it is what lets Funnl keep using those two read '
    + 'permissions while you are not using the app, so a read can run without asking you to '
    + 'sign in again.',
  'Microsoft grants those two more broadly than Funnl uses them. Mail.Read is granted at '
    + 'the mailbox level: it would technically permit reading message bodies and attachments '
    + 'anywhere in your mailbox. User.Read permits your profile and basic company '
    + 'information; Funnl asks it for three fields and uses them only to record which mailbox '
    + 'is connected. Neither requires administrator consent by default, but a work or school '
    + 'tenant can be configured to require an administrator to approve the app, and then you '
    + 'may not be able to consent for yourself.',
  'Funnl reads message envelopes — who sent each message, who it was addressed to, the '
    + 'subject, the times, which conversation it belongs to and whether it is a draft — from '
    + 'your Inbox and Sent Items. Where you and one other person have both written in the '
    + 'same exchange, Funnl also reads the text of those messages, so it can draft a short '
    + 'summary of what was discussed. It does not read one-sided exchanges, does not read '
    + 'attachments, and does not act on newsletters, mailing lists, automated notifications '
    + 'or automatic replies. Funnl can never send, reply, delete, move or change anything in '
    + 'your mailbox, and does not read your Microsoft contacts, calendars, files or your '
    + 'organisation’s directory.',
  'For one exchange Funnl reads at most six messages: the most recent ones, with up to '
    + 'two from each side kept back so a reply from either of you is always included. Each '
    + 'message is trimmed to 4,000 characters and at most 12,000 characters are used across '
    + 'the whole exchange, so where messages are long fewer than six are used and the oldest '
    + 'are left out. Funnl reads the current message rather than the quoted history below it, '
    + 'and removes tracking markup and hidden characters first. The other person’s signature '
    + 'block is kept, up to 600 characters, because it is the only place a name is reliably '
    + 'stated; your own signature is not sent anywhere. The subject line is trimmed to 160 '
    + 'characters.',
  'To write the summary, Funnl sends that cleaned text to Anthropic, the company that '
    + 'provides Funnl’s AI. Anthropic receives the message text, the subject, the date, and a '
    + 'label saying which side wrote each message — you and the other person are labelled '
    + 'only as USER and CONTACT rather than by address. When Funnl is proposing someone who '
    + 'is not yet one of your contacts, it also sends the display name your mail provider '
    + 'shows for that person, because that name is what the proposal is for.',
  'This is not anonymous, and Funnl does not claim it is. The message text and the '
    + 'signature block are what the two of you wrote, so they can contain names, employers, '
    + 'phone numbers or anything else either of you put in an email. Assume the extract can '
    + 'identify the people in the exchange.',
  'What Funnl does check for is email addresses. Before the request is sent it looks over '
    + 'the whole request — the message text included — for your address, the other person’s '
    + 'address, and anything else shaped like an email address, a Bearer token or a JWT-like '
    + 'string. If it finds one the request is withheld and the exchange is set aside with no '
    + 'summary, rather than sent anyway. The request is also built from a fixed template with '
    + 'no field for your Microsoft account or tenant details, Microsoft message or '
    + 'conversation identifiers, authorisation tokens, attachments or raw headers, so none of '
    + 'those is added to it.',
  'What that check cannot do is recognise everything that identifies a person. An email '
    + 'domain on its own, a company name, a phone number or anything else written in the '
    + 'message or the signature can remain in what Anthropic receives: those are not shapes '
    + 'Funnl looks for, and it makes no attempt to strip them out. Adding a redaction step is '
    + 'not part of this release.',
  'Anthropic’s published policy for its API is to delete inputs and outputs from its '
    + 'systems within 30 days of receiving or generating them. Three things can extend that: '
    + 'where its automated systems flag something as violating its usage policy, the inputs '
    + 'and outputs may be kept for up to 2 years and the resulting trust-and-safety '
    + 'classification scores for up to 7 years; it may keep data where the law requires it, '
    + 'or as necessary to act on usage-policy violations; and a customer can negotiate '
    + 'different terms, including zero retention. Funnl has no zero-retention agreement with '
    + 'Anthropic, so this is not zero-retention processing.',
  'A suggestion keeps the summary, the suggested next step, the subject line, the '
    + 'contact, the date, the type (Email) and one-way fingerprints of the exchange, so the '
    + 'same conversation is not suggested twice. The message text itself is discarded once '
    + 'the summary is written — it is not saved to Funnl’s database and not written to any '
    + 'log. The fingerprints are pseudonymous but are stored against your account, so they '
    + 'are personal data about you; they cannot be turned back into a message, an address or '
    + 'a subject line.',
  'When the other person is not already one of your contacts, Funnl will propose adding '
    + 'them. The proposed email address comes from the message itself and the proposed name '
    + 'from the name your mail provider shows for the sender or from their signature. Funnl '
    + 'will not guess a company, a job title, how you met, a LinkedIn profile or a tag — '
    + 'those fields are left blank for you to fill in if you want them.',
  'Nothing enters your network until you accept it. Funnl stores the suggestion so it is '
    + 'still waiting when you come back. Before accepting you can edit the name, the company, '
    + 'the role, how you met, the relationship, the tags, the summary, the interaction type, '
    + 'the date and the follow-up date. The email address is the one exception: it is taken '
    + 'from the message itself and shown read-only — it is the one part of the proposal Funnl '
    + 'did not infer, and it is what identifies the person.',
  'You accept, edit or dismiss a suggestion — there is no deferral option. Accepting '
    + 'creates the contact and the first interaction together. You can also choose to save '
    + 'the contact without logging the conversation — the interaction is a checkbox you can '
    + 'clear. Dismissing a suggestion creates neither and deletes the draft.',
  'Where an exchange is unclear, Funnl sets it aside rather than guessing: more than one '
    + 'other person involved, a message Funnl could not read, a message whose headers your '
    + 'provider did not return, or a summary that did not come back usable. In those cases '
    + 'you get no suggestion for that exchange and nothing is written — never a suggestion '
    + 'with an empty note.',
  'While a read is in progress Funnl keeps working records, one per conversation it is '
    + 'part-way through, and — once you have agreed to body reading — an encrypted reference '
    + 'to each message it has selected, so it can read them once both folders have been '
    + 'examined. Those references are encrypted with the same key as the synchronisation '
    + 'state and hold no subject, address, name or body.',
  'They belong to that single read, which becomes unusable 24 hours after it starts. '
    + 'Becoming unusable is not the same as being erased: they are actually removed when a '
    + 'later read starts, when a read completes, when a read is reset, or when you '
    + 'disconnect. Waiting, or looking at the progress of a read, removes nothing — so if a '
    + 'read is abandoned and none of those happens, its working records stay stored.',
  'A suggestion you never act on carries a 30-day review window, and what that window '
    + 'does depends on which button you press. After it passes, Funnl will not let you accept '
    + 'the suggestion: it tells you the suggestion has expired and takes it off the list on '
    + 'screen. But it stays stored, still waiting, and comes back the next time the page '
    + 'loads — so accepting is not a way to clear an expired suggestion.',
  'Dismissing it does work, and is not refused by that window. Dismissing marks the '
    + 'suggestion dismissed and erases the drafted summary, the suggested next step and any '
    + 'proposed email address and name in the same step. Nothing acts on the deadline on its '
    + 'own, so an expired suggestion stays stored until you dismiss it, disconnect, delete '
    + 'the contact it refers to, or delete your Funnl account.',
  'You can disconnect at any time from this screen. That deletes the connection, the '
    + 'stored Microsoft authorisation, the mailbox synchronisation state, the working '
    + 'records, the message references and the provenance records, and invalidates any '
    + 'suggestion you have not reviewed. An invalidated suggestion is not deleted: it keeps '
    + 'the contact, the date and its fingerprint so the same exchange is not suggested again, '
    + 'and it goes when you delete that contact or your Funnl account.',
  'Disconnecting removes Funnl’s copy of the authorisation, so Funnl has nothing left to '
    + 'start a new read with. A read already under way may finish using access it had already '
    + 'obtained. Disconnecting does not withdraw the permission at Microsoft — to do that, '
    + 'remove Funnl from the permissions page of your Microsoft account.',
  'Funnl’s Privacy Policy sets all of this out in full, including what is kept and when '
    + 'it is deleted.',
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
// THE CONTENT RELEASE. The previous value, 81fe8944fd2be59ac3c059c229b4d28e,
// identified the envelope-only text. That one WAS published and WAS configured as the
// server's OUTLOOK_DISCLOSURE_VERSION in Production: the pilot account connected under
// it and completed a real mailbox import, which could not have happened otherwise -
// outlook-oauth-start refuses to mint a state unless the configured value matches the
// text it shows. It is deliberately NOT kept as an accepted alternative here: the two
// documents say opposite things about body reading, so that connection must disconnect
// and reconnect rather than be treated as having agreed to this one.
export const DISCLOSURE_FINGERPRINT = 'e3e2b1714b453c2904e3ed08cb232097'

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
