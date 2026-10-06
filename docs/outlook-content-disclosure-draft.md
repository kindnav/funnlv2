# Outlook content processing — disclosure wording, DRAFT for owner review

**Status: NOT APPROVED. NOT PUBLISHED. NOT IN EFFECT.**

Nothing in this file is live. `src/pages/PrivacyPage.jsx` and
`src/lib/outlookDisclosure.js` are untouched by the PR that adds this document,
so the published policy still says Funnl reads envelopes only, and the live
consent text is still the envelope-only one
(`ol-disc-81fe8944fd2be59ac3c059c229b4d28e`).

The server-side gate that enforces this is already in place and **closed**:
`REQUIRED_CONTENT_CONSENT_VERSION` in
`supabase/functions/shared/outlookContentConsent.js` is `null`, so
`contentProcessingAllowed()` answers `content_consent_not_configured` for every
connection, including the live pilot's. No body can be read until all four of
the following have happened, in order:

1. the owner approves wording (this document, or a revision of it);
2. the approved paragraphs are published in `src/lib/outlookDisclosure.js` and
   the corresponding section of `src/pages/PrivacyPage.jsx`;
3. the derived version (`ol-disc-` + the first 32 hex of the SHA-256 over the
   paragraphs joined by `\n`, exactly as `computeDisclosureVersion()` already
   does it) is set as `REQUIRED_CONTENT_CONSENT_VERSION`;
4. the pilot account **disconnects and reconnects**, which is what records the
   new version against the connection.

Step 4 is not a formality. `consent_policy_version` is copied out of the OAuth
state at finalization, so the only way a connection comes to carry the new
version is a fresh consent. An existing connection cannot be upgraded in place,
and this PR does not add a way to do that.

---

## What changes, in one paragraph

Today Funnl reads only the envelope of each message: who it was between, when it
was sent, and which folder it was in. The change is that Funnl would also read
the **text of the messages in a two-sided exchange**, in order to write the first
draft of a note for you — and, when the other person is not yet in your Funnl,
to propose adding them. It would still never save anything without you pressing
Accept.

---

## A. Just-in-time consent text (the Settings card, before Connect)

These are the paragraphs to ADD to the existing eleven. The existing eleven are
unchanged. Adding paragraphs changes the derived version, which is the mechanism
that makes old consent stale — that is intended.

> Funnl will read the text of messages in exchanges where you and one other
> person have both written. It uses that text to draft a short note about the
> exchange, which you can edit before saving.

> Funnl reads at most six messages from one exchange, and at most 4,000
> characters of each. It does not read attachments, and it does not read
> exchanges where only one side has written.

> The message text is used while the draft is being prepared and is then
> discarded. It is not saved to Funnl's database and it is not written to any
> log. What is kept is the draft note you see, the subject line of the exchange,
> the date, and a one-way fingerprint that lets Funnl recognise the same exchange
> again without storing the message.

> When the other person is not already one of your contacts, Funnl will propose
> adding them. The proposed email address comes from the message itself, and the
> proposed name comes from the name your mail provider shows for the sender.
> Funnl will not guess a company or a job title from the message.

> Nothing is saved until you press Accept. You can edit every proposed field
> first, including the note. Pressing Accept on a proposed contact creates the
> contact and the first interaction together; dismissing it saves neither.

> Funnl will not act on newsletters, mailing lists, automated notifications, or
> messages from no-reply addresses. Where an exchange is unclear — more than one
> other person is involved, or Funnl could not read all of it — Funnl will set it
> aside rather than guess.

> You can disconnect Outlook at any time. Disconnecting stops any further
> reading, and deletes the stored credentials, the sync state and the working
> records. A suggestion you have already accepted stays, because it is now your
> own contact and interaction.

### Deliberate omissions, for the owner to confirm

- **No claim about a third-party model.** This slice drafts the note
  **deterministically**, from counted facts and the subject line — no message text
  is sent to Anthropic or anywhere else. `outlookDraftContract.js` exists and is
  tested, but it is NOT wired. If and when it is, that needs its **own** wording
  and its own fresh consent, because it adds a third party and a 30-day retention
  window (see section C).
- **No claim that the draft is accurate.** It is explicitly "the first draft of a
  note", editable.
- **No claim of upstream revocation.** Disconnect is local; it does not withdraw
  the grant at Microsoft. That limit is already in the live wording and is kept.

---

## B. Privacy policy section (the Outlook subsection of `/privacy`)

To REPLACE the existing "what Funnl reads" sentences in the Outlook subsection.
The rest of that subsection — scopes, retention, deletion, the pilot framing —
stays as published on October 5, 2026.

> **What Funnl reads from your Outlook mailbox.** With your permission, Funnl
> reads the envelope of messages in your Inbox and Sent Items — the sender and
> recipients, the date, the subject, and the folder — and the text of messages in
> exchanges where both you and one other person have written. Funnl does not read
> attachments. Funnl does not read exchanges where only one side has written, and
> does not act on newsletters, mailing lists or automated mail.
>
> **What Funnl keeps.** Message text is read while a draft is prepared and then
> discarded; it is not stored in Funnl's database and not written to any log.
> What is stored is the draft note, the subject line, the proposed date, the
> proposed email address and name for a person who is not yet one of your
> contacts, and one-way fingerprints that let Funnl recognise the same exchange
> again. Those stored proposals are pseudonymous records associated with your
> connected account, not anonymous data.
>
> **Nothing is saved automatically.** Every suggestion is a draft you review. A
> contact and an interaction are created only when you press Accept, and only
> with the values you have approved. A suggestion you dismiss creates neither.
>
> **How long proposals last.** A pending proposal expires 30 days after it is
> created and is then no longer offered. Accepting it turns it into your own
> contact and interaction, which stay until you delete them or delete your
> account. Disconnecting Outlook deletes the credentials, the sync state and the
> working records; a proposal you already accepted stays, because it is now your
> own data.

**The `Last updated` date must be set to the actual New York publication date**,
the same rule applied on October 5.

---

## C. If the model-drafted note is enabled later — NOT part of this

Recorded here so it is not forgotten, and so nobody assumes the wording above
covers it. It does not.

Wiring `outlookDraftContract.js` would mean sending a fragment of another
person's email to Anthropic. Anthropic's standard commercial retention deletes
inputs and outputs within 30 days, with a documented exception: content flagged
by automated Usage Policy enforcement may be retained up to 2 years, and
trust-and-safety classification scores up to 7 years. This is **not** zero
retention and must never be described as such. That requires:

- a named third-party recipient in the policy's third-party list;
- the 30-day window and its exception stated plainly;
- a further disclosure version, and a further fresh consent;
- an `ANTHROPIC_API_KEY` in the Edge Function secrets, which does not exist for
  this function today.

---

## What the owner is being asked to decide

1. **Approve, revise or reject** the section A and section B wording.
2. Confirm the **deterministic-only** scope for this step — that is, that no
   message text leaves Funnl's own infrastructure yet.
3. Confirm that the pilot account will **disconnect and reconnect** to give fresh
   consent, and that content stays off until it does.
4. Note the open architectural question in the PR description: the round
   accumulator currently persists no subject and no address, so the content note
   cannot yet be produced at the point where suggestions are written. That is a
   separate decision from this wording, and this wording does not depend on how
   it is resolved.
