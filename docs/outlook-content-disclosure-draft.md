# Outlook content processing — disclosure wording, DRAFT for owner review

**Status: NOT APPROVED. NOT PUBLISHED. NOT IN EFFECT.**

Nothing here is live. `src/pages/PrivacyPage.jsx` and `src/lib/outlookDisclosure.js`
are untouched, so the published policy still says Funnl reads envelopes only and
the live consent text is still the envelope-only one
(`ol-disc-81fe8944fd2be59ac3c059c229b4d28e`).

**This revision describes the processing actually being implemented**, which is
different from, and more than, the earlier draft of this file described. The
earlier draft was written for a note built from the subject line and message
counts. That approach was rejected on the grounds that it does not answer the
complaint it was meant to fix — an accepted interaction with no context — so the
wording below covers reading what was actually said, and sending a minimized
fragment of it to Anthropic to summarize.

---

## Two gates, and they are separate

Both are server-side, both key on
`microsoft_connections.consent_policy_version`, and both are **closed right now**
(`supabase/functions/shared/outlookContentConsent.js`):

| Gate | Constant | Covers |
|---|---|---|
| Body reading | `REQUIRED_CONTENT_CONSENT_VERSION` = `null` | fetching and reading message text inside Funnl |
| Third-party processing | `REQUIRED_THIRD_PARTY_CONSENT_VERSION` = `null` | sending a minimized fragment to Anthropic |

They are deliberately independent. Reading a body inside Funnl's own
infrastructure and handing part of someone else's email to another company are
different things to agree to, and they have different consequences. **Body-only
is a coherent intermediate state**: the exchange may be read, but nothing leaves,
and the model path is skipped rather than quietly used.

A connection must match the required version **exactly** — these are content
digests, so there is no ordering and no "near enough". The live pilot connection
therefore fails closed on both until it **disconnects and reconnects**, because
`consent_policy_version` is copied out of the OAuth state at finalization and
cannot be upgraded in place.

Four things must happen, in order, before either gate opens:

1. the owner approves wording (this document, or a revision);
2. the approved paragraphs are published in `src/lib/outlookDisclosure.js` and the
   Outlook section of `src/pages/PrivacyPage.jsx`;
3. the derived version (`ol-disc-` + the first 32 hex of SHA-256 over the
   paragraphs joined by `\n`, exactly as `computeDisclosureVersion()` already
   does it) is set on the relevant constant;
4. the account reconnects.

---

## A. Just-in-time consent text (the Settings card, before Connect)

Paragraphs to **add** to the existing eleven. The existing eleven are unchanged;
adding paragraphs changes the derived version, which is the mechanism that makes
the old consent stale. That is intended.

> Funnl will read the text of messages in exchanges where you and one other
> person have both written, so it can draft a short summary of what was
> discussed. Funnl does not read exchanges where only one side has written, and
> does not read attachments.

> For one exchange Funnl reads at most six messages, and at most 4,000 characters
> of each. It reads the current message rather than the quoted history below it,
> and it removes signatures, tracking markup and hidden characters before using
> the text.

> To write the summary, Funnl sends that cleaned text to Anthropic, the company
> that provides Funnl's AI. Anthropic receives the message text, the subject, the
> date, and a label saying which side wrote each message. It does not receive
> your email address, the other person's email address, your Microsoft account
> details, or any Funnl identifier. Under Anthropic's standard commercial terms
> this data is deleted within 30 days. There is an exception: material that
> Anthropic's automated policy enforcement flags may be kept for up to two years,
> and safety classification scores for up to seven years. This is not
> zero-retention processing.

> Funnl keeps the summary, the subject line, the date, and a one-way fingerprint
> that lets it recognise the same exchange again. **The message text itself is
> discarded once the summary is written** — it is not saved to Funnl's database
> and not written to any log.

> When the other person is not already one of your contacts, Funnl will propose
> adding them. The proposed email address comes from the message itself and the
> proposed name from the name your mail provider shows for the sender. Funnl will
> not guess a company or a job title.

> Nothing is saved until you press Accept. You can edit every proposed field
> first, including the summary and the suggested next step. Pressing Accept on a
> proposed contact creates the contact and the first interaction together;
> dismissing it saves neither.

> Funnl will not act on newsletters, mailing lists, automated notifications, or
> messages from no-reply addresses. Where an exchange is unclear — more than one
> other person involved, or Funnl could not read all of it — Funnl sets it aside
> rather than guessing.

> You can disconnect Outlook at any time. Disconnecting stops any further
> reading, and deletes the stored credentials, the sync state and the working
> records — including the stored references Funnl uses to find the messages. A
> suggestion you have already accepted stays, because it is now your own contact
> and interaction.

### For the owner to confirm

- **Anthropic is named.** The earlier draft deliberately avoided this because the
  model path was not being built. It is being built now, so it must be disclosed,
  and the 30-day window and its exception must be stated plainly. It must never
  be described as zero-retention.
- **What Anthropic does and does not receive** is stated specifically, because
  `shared/outlookDraftContract.js` enforces it at runtime
  (`assertRequestMinimization`): no token, no Microsoft account/tenant/message/
  conversation id, no raw address, no attachment, no raw header — participants
  are pseudonymous labels, and even the recipient domain is withheld.
- **No accuracy claim.** It is "a short summary", editable.
- **No upstream revocation claim.** Disconnect is local; it does not withdraw the
  grant at Microsoft. That limit is already in the live wording and is kept.

---

## B. Privacy policy section (the Outlook subsection of `/privacy`)

To **replace** the "what Funnl reads" sentences in the Outlook subsection. The
rest — scopes, deletion, the pilot framing — stays as published on October 5,
2026. Anthropic must also be added to the policy's existing third-party list.

> **What Funnl reads from your Outlook mailbox.** With your permission, Funnl
> reads the envelope of messages in your Inbox and Sent Items — the sender and
> recipients, the date, the subject and the folder — and, for exchanges where both
> you and one other person have written, the text of up to six of those messages.
> Funnl does not read attachments, does not read one-sided exchanges, and does not
> act on newsletters, mailing lists or automated mail.
>
> **Who else sees it.** To draft a summary, the cleaned message text is sent to
> Anthropic, which provides Funnl's AI. Anthropic receives the message text, the
> subject, the date and a label for which side wrote each message, and does not
> receive email addresses, Microsoft account details or Funnl identifiers. Under
> Anthropic's standard commercial terms the data is deleted within 30 days;
> material flagged by automated policy enforcement may be kept up to two years and
> safety classification scores up to seven years. This is not zero-retention
> processing.
>
> **What Funnl keeps.** The message text is discarded once the summary is written:
> it is not stored in Funnl's database and not written to any log. What is stored
> is the summary, the suggested next step, the subject line, the proposed date,
> the proposed email address and name for a person who is not yet one of your
> contacts, and one-way fingerprints that let Funnl recognise the same exchange
> again. While a sync round is in progress Funnl also stores encrypted references
> to the specific messages it has selected, so it can read them once both folders
> have been examined; those references are deleted with the round, and when you
> disconnect. All of this is pseudonymous data associated with your connected
> account, not anonymous data.
>
> **Nothing is saved automatically.** Every suggestion is a draft you review. A
> contact and an interaction are created only when you press Accept, and only with
> the values you have approved. A suggestion you dismiss creates neither.
>
> **How long proposals last.** A pending proposal expires 30 days after it is
> created and is then no longer offered. Accepting it turns it into your own
> contact and interaction, which stay until you delete them or delete your
> account. Disconnecting Outlook deletes the credentials, the sync state, the
> working records and the message references; a proposal you already accepted
> stays, because it is now your own data.

**The `Last updated` date must be set to the actual New York publication date**,
the same rule applied on October 5.

---

## C. What the stored message references actually are

Called out separately because it is the one genuinely new category of stored data
and the policy paragraph above summarises it in one sentence.

During a sync round Funnl stores, per selected exchange, up to six **encrypted
Microsoft Graph immutable message identifiers**
(`public.outlook_round_messages`). These exist because the decision to summarize
an exchange can only be taken once *both* Inbox and Sent Items have been
examined, which may span pages, invocations and hours — so the messages have to
be findable again afterwards.

- They are **encrypted at rest** with the same key ring as the sync cursors; the
  plaintext identifier never reaches the table, a log, or any read path other than
  the worker holding the key.
- They carry **no subject, no address, no name and no body** — nothing describing
  what a message said or who it was with.
- They are **bounded**: six per exchange, 4,000 per round.
- They are **worker-only**: row-level security on, every role but the service role
  revoked, and no user-facing read path.
- They **die with the round** and cascade away on disconnect and on account
  deletion, both proven in `tests/sql/outlook-round-retrieval-runtime.sql`.

Why immutable identifiers specifically: Graph's default ids change when a message
is moved, so an id recorded on page one can be dead by the time the round
finalizes. The `Prefer: IdType="ImmutableId"` opt-in makes them stable across
folder moves within the mailbox. They still change if the user moves the message
to an archive mailbox or exports and re-imports it — in which case the fetch
fails and Funnl sets the exchange aside rather than guessing.

---

## What the owner is being asked to decide

1. **Approve, revise or reject** the section A and section B wording.
2. **Confirm that Anthropic may receive minimized message text at all**, on the
   terms described. If not, the body-reading gate can still be opened on its own
   and the summary path stays off — the two gates are independent precisely so
   this choice exists.
3. Confirm the pilot account will **disconnect and reconnect** to give fresh
   consent, and that both gates stay closed until it does.
4. Note the remaining implementation work recorded in the PR description. This
   wording is written for the finished behaviour so it can be reviewed once,
   rather than twice.
