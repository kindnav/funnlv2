# Outlook content processing — disclosure wording, DRAFT for owner review

**Status: NOT APPROVED. NOT PUBLISHED. NOT IN EFFECT.**

Nothing here is published. The PUBLISHED policy at /privacy and the PUBLISHED consent
text are still the envelope-only ones (`ol-disc-81fe8944fd2be59ac3c059c229b4d28e`), and
that version was configured as the server's `OUTLOOK_DISCLOSURE_VERSION` in Production
— the pilot account connected under it and completed a real mailbox import.

`src/pages/PrivacyPage.jsx` and `src/lib/outlookDisclosure.js` on THIS BRANCH now carry
the content-release wording as unpublished draft changes, which is a different thing
from the live pages. What keeps the release closed is not the wording: it is
`REQUIRED_CONTENT_CONSENT_VERSION` and `REQUIRED_THIRD_PARTY_CONSENT_VERSION`, both
`null`, so the server reads no body and calls no third party whatever any connection
recorded. See section 0 of `docs/outlook-privacy-consent-readiness.md` for the three
values kept apart.

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
   does it) is set on **three** values: the server's `OUTLOOK_DISCLOSURE_VERSION`,
   which currently holds the envelope-only version, and both worker consent
   constants, which are `null`;
4. the account disconnects and reconnects.

The full staged plan is section E.

---

## A. The complete just-in-time notice (the Settings card, before Connect)

**This is the WHOLE list, not an addition to it.** The earlier revision proposed
"paragraphs to add to the existing eleven", which would have left the published
text self-contradictory: three of those eleven state the opposite of what the
content release does. A reader of a notice that both promises and denies body
reading has not been informed of anything, and a consent version derived from such
a text would be worthless. So what follows replaces
`OUTLOOK_DISCLOSURE_PARAGRAPHS` in full, and the digest is derived from it.

### What the published text says today that can no longer stand

| Published paragraph | What it says | Why it must change |
|---|---|---|
| 5 | "reads message envelopes only ... does not fetch message bodies or attachments, and sends nothing to Anthropic or any other AI service" | **Directly contradicted.** The content release reads bodies and sends a minimized fragment to Anthropic. |
| 6 | "this pilot proposes no new contacts" | **Directly contradicted.** Proposing a contact for someone not yet tracked is the point of the release. |
| 7 | "No subject line, summary or message text is kept" | **Directly contradicted.** The summary and a bounded subject are kept; the message text is not. |
| 8 | the 24-hour working records | **Extended, not contradicted.** Still true; the encrypted message references are a new kind of working record and must be named. |
| 9 | disconnect deletes the working records | **Extended.** The message references go with them. |
| 10 | "A read already under way may finish using access it had already obtained" | **Already correct and kept verbatim.** This is the in-flight acknowledgement; it was right before the content release and is right after it. |
| 1-4, 11 | optional, single test account, the six scopes, Microsoft's broader grant, the policy pointer | **Unchanged.** No scope changes: `Mail.Read` already permitted body reading, which is exactly why paragraph 4 says so. |

### The proposed paragraphs

**Quoted from `src/lib/outlookDisclosure.js` verbatim** — these are the exact strings
the card renders and the exact strings the version is derived from. Generated from the
array rather than retyped, so the two cannot drift.

Derived version: **`ol-disc-7a258d82788f6a21b18b954852e881bb`**

1. Connecting Outlook is optional. Funnl works fully without it.

2. Access is restricted to one designated Funnl-controlled test account. Funnl’s servers refuse a connection request from any other account.

3. You would grant six Microsoft scopes. Two of them read data, and both are read-only: Mail.Read (“Read user mail”) and User.Read (“Sign in and read user profile”). Three are the standard sign-in scopes openid, profile and email. The sixth, offline_access, grants no new access of its own — it is what lets Funnl keep using those two read permissions while you are not using the app, so a read can run without asking you to sign in again.

4. Microsoft grants those two more broadly than Funnl uses them. Mail.Read is granted at the mailbox level: it would technically permit reading message bodies and attachments anywhere in your mailbox. User.Read permits your profile and basic company information; Funnl asks it for three fields and uses them only to record which mailbox is connected. Neither requires administrator consent by default, but a work or school tenant can be configured to require an administrator to approve the app, and then you may not be able to consent for yourself.

5. Funnl reads message envelopes — who sent each message, who it was addressed to, the subject, the times, which conversation it belongs to and whether it is a draft — from your Inbox and Sent Items. Where you and one other person have both written in the same exchange, Funnl also reads the text of those messages, so it can draft a short summary of what was discussed. It does not read one-sided exchanges, does not read attachments, and does not act on newsletters, mailing lists, automated notifications or automatic replies. Funnl can never send, reply, delete, move or change anything in your mailbox, and does not read your Microsoft contacts, calendars, files or your organisation’s directory.

6. For one exchange Funnl reads at most six messages: the most recent ones, with up to two from each side kept back so a reply from either of you is always included. Each message is trimmed to 4,000 characters and at most 12,000 characters are used across the whole exchange, so where messages are long fewer than six are used and the oldest are left out. Funnl reads the current message rather than the quoted history below it, and removes tracking markup and hidden characters first. The other person’s signature block is kept, up to 600 characters, because it is the only place a name is reliably stated; your own signature is not sent anywhere. The subject line is trimmed to 160 characters.

7. To write the summary, Funnl sends that cleaned text to Anthropic, the company that provides Funnl’s AI. Anthropic receives the message text, the subject, the date, and a label saying which side wrote each message — you and the other person are labelled only as USER and CONTACT rather than by address. When Funnl is proposing someone who is not yet one of your contacts, it also sends the display name your mail provider shows for that person, because that name is what the proposal is for.

8. This is not anonymous, and Funnl does not claim it is. The message text and the signature block are what the two of you wrote, so they can contain names, employers, phone numbers or anything else either of you put in an email. Assume the extract can identify the people in the exchange.

9. What Funnl does check for is email addresses. Before the request is sent it looks for your address, the other person’s address, and anything else in the request shaped like an email address or a credential; if it finds one the request is withheld and the exchange is set aside with no summary, rather than sent anyway. The request is also built from a fixed template with no field for your Microsoft account or tenant details, Microsoft message or conversation identifiers, authorisation tokens, attachments or raw headers, so none of those is added to it.

10. What that check cannot do is clean up the message itself. An email domain, a company name, a phone number or anything else written in the message or the signature can remain in what Anthropic receives, and Funnl makes no attempt to strip it out. Funnl does not scan the request for those, and adding a redaction step is not part of this release.

11. Anthropic’s published policy for its API is to delete inputs and outputs from its systems within 30 days of receiving or generating them. Three things can extend that: where its automated systems flag something as violating its usage policy, the inputs and outputs may be kept for up to 2 years and the resulting trust-and-safety classification scores for up to 7 years; it may keep data where the law requires it, or as necessary to act on usage-policy violations; and a customer can negotiate different terms, including zero retention. Funnl has no zero-retention agreement with Anthropic, so this is not zero-retention processing.

12. A suggestion keeps the summary, the suggested next step, the subject line, the contact, the date, the type (Email) and one-way fingerprints of the exchange, so the same conversation is not suggested twice. The message text itself is discarded once the summary is written — it is not saved to Funnl’s database and not written to any log. The fingerprints are pseudonymous but are stored against your account, so they are personal data about you; they cannot be turned back into a message, an address or a subject line.

13. When the other person is not already one of your contacts, Funnl will propose adding them. The proposed email address comes from the message itself and the proposed name from the name your mail provider shows for the sender or from their signature. Funnl will not guess a company, a job title, how you met, a LinkedIn profile or a tag — those fields are left blank for you to fill in if you want them.

14. Nothing enters your network until you accept it. Funnl stores the suggestion so it is still waiting when you come back. Before accepting you can edit the name, the company, the role, how you met, the relationship, the tags, the summary, the interaction type, the date and the follow-up date. The email address is the one exception: it is taken from the message itself and shown read-only — it is the one part of the proposal Funnl did not infer, and it is what identifies the person.

15. You accept, edit or dismiss a suggestion — there is no deferral option. Accepting creates the contact and the first interaction together. You can also choose to save the contact without logging the conversation — the interaction is a checkbox you can clear. Dismissing a suggestion creates neither and deletes the draft.

16. Where an exchange is unclear, Funnl sets it aside rather than guessing: more than one other person involved, a message Funnl could not read, a message whose headers your provider did not return, or a summary that did not come back usable. In those cases you get no suggestion for that exchange and nothing is written — never a suggestion with an empty note.

17. While a read is in progress Funnl keeps working records, one per conversation it is part-way through, and — once you have agreed to body reading — an encrypted reference to each message it has selected, so it can read them once both folders have been examined. Those references are encrypted with the same key as the synchronisation state and hold no subject, address, name or body.

18. They belong to that single read, which becomes unusable 24 hours after it starts. Becoming unusable is not the same as being erased: they are actually removed when a later read starts, when a read completes, when a read is reset, or when you disconnect. Waiting, or looking at the progress of a read, removes nothing — so if a read is abandoned and none of those happens, its working records stay stored.

19. A suggestion you never act on carries a 30-day review window, and what that window does depends on which button you press. After it passes, Funnl will not let you accept the suggestion: it tells you the suggestion has expired and takes it off the list on screen. But it stays stored, still waiting, and comes back the next time the page loads — so accepting is not a way to clear an expired suggestion.

20. Dismissing it does work, and is not refused by that window. Dismissing marks the suggestion dismissed and erases the drafted summary, the suggested next step and any proposed email address and name in the same step. Nothing acts on the deadline on its own, so an expired suggestion stays stored until you dismiss it, disconnect, delete the contact it refers to, or delete your Funnl account.

21. You can disconnect at any time from this screen. That deletes the connection, the stored Microsoft authorisation, the mailbox synchronisation state, the working records, the message references and the provenance records, and invalidates any suggestion you have not reviewed. An invalidated suggestion is not deleted: it keeps the contact, the date and its fingerprint so the same exchange is not suggested again, and it goes when you delete that contact or your Funnl account.

22. Disconnecting removes Funnl’s copy of the authorisation, so Funnl has nothing left to start a new read with. A read already under way may finish using access it had already obtained. Disconnecting does not withdraw the permission at Microsoft — to do that, remove Funnl from the permissions page of your Microsoft account.

23. Funnl’s Privacy Policy sets all of this out in full, including what is kept and when it is deleted.

### For the owner to confirm

- **Anthropic is named**, with the 30-day window and its exception stated plainly. It
  must never be described as zero-retention.
- **What Anthropic does and does not receive** is stated specifically because
  `assertRequestMinimization` enforces it at runtime: no token, no Microsoft
  account/tenant/message/conversation id, no raw address, no attachment, no raw
  header — participants are pseudonymous labels, and even the recipient domain is
  withheld.
- **No scope change.** `Mail.Read` already permitted body reading; paragraph 4 has
  always said so. What changes is what Funnl *does* with a permission it already had,
  which is precisely why fresh consent is required rather than a new scope.
- **No accuracy claim.** It is "a short summary", editable.
- **The in-flight read is acknowledged**, and the sentence that does it is one that
  was already published. `disconnect_my_outlook` deletes the connection row
  immediately; it does not wait for or cancel a worker invocation that already holds
  a lease. Nothing can be written afterwards — every later RPC finds no connection —
  but a Graph request already issued completes.
- **The optional interaction is disclosed** (paragraph 10). The review card offers it
  as a checkbox, and `accept_new_contact_candidate` takes `p_create_interaction`.
- **Three paragraphs are replaced, not supplemented.** See the table above. Adding
  without replacing would publish a notice that contradicts itself.

## B. Privacy policy section (the Outlook subsection of `/privacy`)

To **replace** the "what Funnl reads" sentences in the Outlook subsection. The
rest — scopes, deletion, the pilot framing — stays as published on October 5,
2026. Anthropic must also be added to the policy's existing third-party list.

> **What Funnl reads from your Outlook mailbox.** With your permission, Funnl
> reads the envelope of messages in your Inbox and Sent Items — the sender and
> recipients, the date, the subject and the folder — and, for exchanges where both
> you and one other person have written, the text of up to six of those messages.
> It chooses the six most recent, keeping up to two from each side back so a reply
> from either of you is always among them. Each message is trimmed to 4,000
> characters and the whole exchange to 12,000, so where messages are long fewer
> than six are used and the oldest are left out. Funnl reads the current message
> rather than the quoted history below it. It keeps the other person's signature
> block, up to 600 characters, because that is where a name is reliably stated;
> your own is not sent. Funnl does not read attachments, does not read one-sided
> exchanges, and does not act on newsletters, mailing lists or automated mail.
>
> **Who else sees it.** To draft a summary, the cleaned message text is sent to
> Anthropic, which provides Funnl's AI. Anthropic receives the message text, the
> subject, the date and a label for which side wrote each message — the two of you are
> labelled only USER and CONTACT rather than by address. When Funnl is proposing
> someone who is not yet one of your contacts, it also sends **the display name your
> mail provider shows for that person**, because that name is what the proposal is for.
>
> **This is not anonymous, and Funnl does not claim it is.** The message text and the
> signature block are what the two of you wrote, so they can contain names, employers,
> phone numbers or anything else either of you put in an email. Assume the extract can
> identify the people in the exchange.
>
> **What is checked, and what is not.** Before the request is sent, Funnl's code looks
> for **email addresses**: your own, the other person's, and anything else in the
> request shaped like an email address or a credential. If it finds one the request is
> **withheld** — the exchange is set aside with no summary rather than sent anyway.
> Separately, the request is built from a fixed template with **no field for** Microsoft
> account, tenant, message or conversation identifiers, authorization tokens,
> attachments or raw headers, so none of those is added as request metadata.
>
> **That check does not clean the message.** An email domain, a company name, a phone
> number or anything else written in the message or the signature **can remain** in what
> Anthropic receives. Funnl does not scan for those and makes no attempt to remove them,
> and adding a redaction step is not part of this release.
>
> Anthropic's published policy for its API is to delete inputs and outputs within 30
> days of receipt or generation. Where its automated systems flag something as
> violating its usage policy, inputs and outputs may be kept up to 2 years and
> trust-and-safety classification scores up to 7 years; it may also keep data where
> the law requires it, or as necessary to act on usage-policy violations. Funnl has no
> zero-retention agreement with Anthropic, so this is not zero-retention processing.
>
> **What Funnl keeps.** The message text is discarded once the summary is written:
> it is not stored in Funnl's database and not written to any log. What is stored
> is the suggestion — the summary, the suggested next step, the subject line, the
> proposed date, the proposed email address and name for a person who is not yet
> one of your contacts, and one-way fingerprints that let Funnl recognise the same
> exchange again. In this release the company, role, how-you-met, LinkedIn and tag
> fields **start blank** and are stored only if the reviewer fills them in: the columns
> exist and the import does not write to them, so Funnl stores no company or job title
> it inferred. While a sync round is in progress Funnl also stores encrypted
> references to the specific messages it has selected, so it can read them once
> both folders have been examined. Those references are deleted when the sync
> finishes, when it is restarted, when a later sync replaces it, or when you
> disconnect Outlook or delete your account. A sync stops being usable 24 hours
> after it starts, but **that deadline on its own does not delete anything**: if a
> sync is abandoned part-way and never runs again, its references stay until one
> of those events happens. All of this is pseudonymous data associated with your
> connected account, not anonymous data.
>
> **A stored suggestion is not part of your network.** This is the distinction
> that matters, and it is worth being exact about. Funnl does store the
> suggestion — that is how it is still waiting when you come back to it. But it
> sits in a review queue as a draft: it is not among your contacts, your
> interactions or your follow-ups, and is not visible to Funnl's AI assistant.
> **A contact and an interaction are created only when you accept them**, and only
> with the values you have approved — and you accept, edit or dismiss a suggestion;
> there is no deferral option, and neither review card has one. Every proposed field is
> editable except the
> email address, which is taken from the message and shown read-only. For someone new
> you may save the contact **without** logging the conversation, by clearing the
> interaction checkbox. Dismissing a suggestion creates neither and deletes the
> draft.
>
> **How long proposals last.** A suggestion carries a 30-day review window, and what
> that window does depends on which button you press.
>
> **Accepting an expired suggestion is refused.** Funnl will not let you accept it: it
> will not turn the suggestion into a contact or an interaction, and tells you it has
> expired. The row is taken off the list you are looking at, but that is a change to
> what is on your screen and not to what is stored — it is still in Funnl's database,
> still pending, and it reappears the next time the page loads. So acceptance is
> **not** a way to clear an expired suggestion.
>
> **Dismissing an expired suggestion does work, and does clear it.** Dismissal is not
> refused by the review window. It marks the suggestion dismissed and **erases the
> drafted context** in the same step: the summary, the suggested next step and, for a
> proposed contact, the proposed email address and name. What remains is the terminal
> record and its one-way fingerprint, so the same exchange is not suggested again.
>
> **Nothing happens on its own.** An expired suggestion's summary and subject stay
> stored until you dismiss it, disconnect Outlook, delete the contact it belongs to, or
> delete your account.
> Accepting an unexpired suggestion turns it into your own contact and interaction, which stay
> until you delete them or delete your account. Disconnecting Outlook deletes the
> credentials, the sync state, the working records and the message references, so
> Funnl has nothing left to start a new read with. A read already under way may finish
> using access it had already obtained. A suggestion you already accepted stays,
> because it is now your own data.

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
- They are **bounded**: six per exchange and 4,000 per round. Which six is chosen
  deliberately - ranked newest first, with up to two slots per folder reserved and
  the rest filled by overall recency - so the latest message is always kept and a
  two-sided exchange still reads as two-sided even when one side dominates by
  volume.
- The round ceiling is measured on **the set that would result**, not on the
  arithmetic of what arrived. A page is refused only when storing it would
  genuinely take the round past 4,000 stored references; a repeat of a reference
  already held, or a newer message that displaces an older selected one, causes no
  growth and is not refused. The earlier draft of this function added the incoming
  count to the stored count before de-duplication and selection, so at exactly
  4,000 it refused both of those cases - stalling a busy round precisely when the
  newest reply arrived. Both cases are reproduced and now pass in
  `tests/sql/outlook-round-retrieval-runtime.sql`; genuine growth still refuses
  **before** any checkpoint, conversation merge or reference write, which is what
  stops a cursor advancing past mail whose references were dropped.
- They are **worker-only**: row-level security on, every role but the service role
  revoked, and no user-facing read path.
- They are removed by **every round-lifecycle delete** - a completed round's
  release, a reset, and either path that supersedes a round - and cascade away on
  **disconnect** and on **account deletion**, through a narrow cascading foreign
  key to the accumulator row they belong to. All of those are proven in
  `tests/sql/outlook-round-retrieval-runtime.sql`, and the completed-round case is
  also observed end to end in `tests/local/outlook-content-flow.mjs`: after a
  successful round the table is empty, and on a round deliberately left unfinished
  the references are still there and still decrypt.
- **Reaching the 24-hour round deadline deletes nothing.** An expired round is
  refused rather than erased, and no sweep is scheduled, so an abandoned
  connection's references persist until the next run supersedes the round, a
  reset runs, or the account disconnects. Asserted in the same test, and the
  policy paragraph above says so rather than implying the deadline cleans up.

Why immutable identifiers specifically: Graph's default ids change when a message
is moved, so an id recorded on page one can be dead by the time the round
finalizes. The `Prefer: IdType="ImmutableId"` opt-in makes them stable across
folder moves within the mailbox. They still change if the user moves the message
to an archive mailbox or exports and re-imports it — in which case the fetch
fails and Funnl sets the exchange aside rather than guessing.

---

## C2. What the 30-day window actually does, and what it does not

The earlier draft said a pending proposal "expires 30 days after it is created and
is then no longer offered". **Neither half was fully true when that was written**, and
the wording above now says only what is enforced.

### What is enforced, in the database

- `accept_new_contact_candidate` reads `context_expires_at` and returns `expired` once
  it has passed. It always did.
- `accept_interaction_candidate` **now does too** — it did not before. An earlier
  version of this packet claimed both acceptance RPCs refused an expired suggestion;
  that claim came from a grep for the `'expired'` result token whose two matches were
  both inside `defer_candidate`, a different function. The interaction path never read
  the column. Reproduced against a disposable Postgres: an Outlook candidate 40 days
  past its deadline answered `accepted` and created an interaction.

  The guard is **Outlook-scoped** and added by `CREATE OR REPLACE` in the unapplied
  forward migration — no applied migration is edited, and replacing in place preserves
  the function's ACL. It is scoped because Calendar and Gmail candidates carry NULL in
  that column by design, so an unscoped rule would refuse every Calendar suggestion
  ever made. For an Outlook row NULL fails closed, since every writer sets it. And it
  sits **after** every terminal-status check, because acceptance erases the column to
  NULL and a guard placed earlier would answer `expired` for a row that had already
  been accepted. All of that is proven in
  `tests/sql/outlook-accept-expiry-runtime.sql`.

- The review surface treats `expired` as settled and takes the row off the list on
  screen. Before this round the interaction card had no entry for `expired` at all, so
  the answer fell through to a generic "Something went wrong — please try again": the
  row could never be accepted, retrying could not help, and it stayed on the list
  indefinitely.

### What is **not** enforced, and must be said plainly

- **Nothing is scheduled to delete anything.** `expire_pending_outlook_context` exists
  and is bounded, and erases the drafted text of expired candidates — but no cron job,
  no worker and no request calls it. Its only mentions outside its own definition are
  in a revoke-list comment. So an expired suggestion's summary and subject **remain
  stored** until it is accepted, dismissed, invalidated by a disconnect, or deleted
  with the contact or the account.
- **Taking a row off the list is not a database change.** The review surface removes it
  from component state only. The row stays `pending` in the database and **reappears on
  the next page load**. That is why the wording distinguishes what is on screen from
  what is stored: three different things could be meant by "no longer offered" — hidden
  in the current view, marked terminal in the database, or deleted — and only the first
  happens on expiry today.
- **The queue does not filter on expiry.** Neither read adds a
  `context_expires_at > now()` predicate, and it could not easily: that column is
  deliberately excluded from the columns `authenticated` may select. So an expired
  suggestion is still listed on a fresh load; it simply cannot be accepted.

This is why the policy paragraph promises a **refusal**, says expired is not the same
as erased, and says the row comes back on reload. **A scheduled sweep is a
prerequisite for claiming automatic deletion. It does not exist, is not added in this
change, and is listed as an unattended-operation requirement rather than described
here as though it were already true.**

---

## C3. A note on how the provider bounds were verified

Two of the bound claims in the table below were **written before they were true**, and
both were caught by an independent re-run of the same test file rather than by the
tests as first written. That is worth recording, because it says something about what
a passing suite does and does not establish.

The first round added one AbortController across headers and body, `readJsonBounded`
and `redirect: 'manual'` to the SUCCESS path, tested all three, and wrote the claim as
though it covered the whole call. It did not cover the **non-200** path: the timer was
cleared on the line above the error-body read, and that read was an unbounded
`res.json()` wrapped in a try/catch. A 400 that stalled its body hung with no deadline
in force; one that streamed 4,100,048 bytes was buffered whole. The tests passed
because they only ever exercised a 200.

The second was the same shape. Retries were bounded by `MAX_RETRIES`,
`MAX_TOTAL_RETRY_DELAY_MS` and a per-attempt timeout - all of which are real bounds,
and none of which knows how much of the INVOCATION is left. With 25 seconds
available, attempts started at 0, 50,000 and 100,000 ms.

Both are now fixed and both reproductions are in the suite. The unbounded reader was
**deleted** rather than repaired, so there is no longer one in the module for a later
caller to reach for. And the per-attempt deadline is now injectable - defaulting to
the shipped constant, passed by no production caller - so a stall test proves the
bound in milliseconds instead of waiting out a real 20- or 30-second abort, which is
what made these tests cheap enough to keep.

---

## D. Every factual claim above, and where it was checked

The wording was revised AFTER the path was built, and each number in it was read
off the implementation rather than remembered. This table is here so a reviewer
can check the prose against the code without reading the code.

| Claim | Where it comes from | Checked by |
|---|---|---|
| at most six messages per exchange | `MAX_EPISODE_MESSAGES = 6` (sanitizer), `c_handles_per_conv = 6` (SQL), `MAX_FETCH_PER_CONVERSATION = 6` (pass) | `outlook-content-pass.test.js` ("at most six bodies are fetched"); the 7-message selection case in the retrieval SQL suite |
| the most recent, two per side reserved | `rn_folder <= c_handles_reserved_per_folder` then filler by `rn_all` | the 7-message and one-sided-volume cases in the retrieval SQL suite |
| 4,000 characters per message | `MAX_TEXT_CHARS = 4_000` | `outlook-content-sanitizer.test.js` |
| 12,000 characters per exchange, oldest dropped | `MAX_EPISODE_CHARS = 12_000`; `boundEpisodeContent` sorts newest-first before keeping | `outlook-content-sanitizer.test.js` |
| the other person's signature is kept, up to 600 | `MAX_SIGNATURE_CHARS = 600`; the pass passes `signature` only for `direction === 'inbound'` | `outlook-content-pass.test.js`, `outlook-draft-contract.test.js` |
| subject trimmed to 160 | `MAX_SUBJECT_CHARS = 160`, matching `ncc_subject_bounds` | `outlook-content-sanitizer.test.js` |
| the current message, not the quoted history | the sanitizer prefers Graph's `uniqueBody` when non-empty | `outlook-content-sanitizer.test.js` |
| no address or identifier reaches Anthropic | `assertRequestMinimization` at runtime, against the self and counterparty addresses | `outlook-content-pass.test.js`; and over real HTTP in `outlook-content-flow.mjs`, which inspects the captured request body |
| the message text is not stored or logged | the pass returns no body field; `summarizePassResult` emits counts and codes only | `outlook-content-pass.test.js` (the result-shape and log-shape assertions) |
| the suggestion IS stored, and expires in 30 days | `context_expires_at = now() + interval '30 days'` on both candidate writes | `outlook-content-slice-runtime.sql` |
| a stored suggestion is not in the network | `contacts` and `interactions` are written only by `accept_new_contact_candidate` / `accept_interaction_candidate` | `outlook-content-flow.mjs` counts both tables after a full run: one seeded contact, zero interactions |
| accepting creates both, or neither | one transaction; any failure after the contact insert rolls it back | `outlook-content-slice-runtime.sql`; `outlook-content-flow.mjs` |
| the references are encrypted, and the id is never stored | sealed with the cursor key ring before the checkpoint | `outlook-content-flow.mjs` decrypts all four back on an unfinished round, and greps every column for the plaintext |
| the references do not outlive the round | cascading FK to the accumulator row, deleted by every round-lifecycle path | the retrieval SQL suite; `outlook-content-flow.mjs` |
| the 24-hour deadline deletes nothing by itself | two different deadlines, and only one has a sweep: the 30-day CANDIDATE expiry (`expire_pending_outlook_context`) updates `interaction_candidates` and `new_contact_candidates` and touches `outlook_round_messages` nowhere, and nothing at all is scheduled against the 24-hour `round_expires_at` | asserted in the retrieval SQL suite |
| a page is refused only on genuine growth | the projected-retained-set computation, before any write | the two no-growth cases and the growth control in the retrieval SQL suite |
| disconnect may leave one read in flight | `disconnect_my_outlook` deletes the connection row and neither waits for nor cancels a held lease | read directly from the function; the consequence (no write lands) follows from every RPC refusing an absent connection |
| at most six messages, two reserved per side | `c_handles_per_conv` / `c_handles_reserved_per_folder` | the 7-message and one-sided-volume cases in the retrieval SQL suite |
| automated mail is screened out before any proposal | `bulkListReason` + `nonHumanReason`, on the headers the content read returns | `outlook-content-corrections.test.js` — Auto-Submitted, X-Auto-Response-Suppress, no-reply senders, delivery failures, out-of-office, calendar notifications, List-Id, List-Unsubscribe, Precedence, plus the positive control |
| a message whose headers were not returned yields no proposal | `requiresScreening` + `automation_unverified` | same suite: zero model calls, no proposal |
| never a suggestion with an empty note on the content release | `planContentWrite` keys on `consentOpen` | same suite: the three codes that used to write one now write nothing |
| the interaction is optional | `p_create_interaction` on the accept RPC; a checkbox on the card | `outlook-new-contact-review.test.js`; the browser harness renders and uses the checkbox |
| an expired suggestion cannot be accepted | `context_expires_at` checked in BOTH accept RPCs — the interaction one only as of this round | `outlook-accept-expiry-runtime.sql`: the reproduction (40 days past, `accepted`, an interaction created), the refusal, the unexpired acceptance with the user's edits, unchanged Calendar and Gmail behaviour, unchanged `already_accepted` idempotency, and the preserved ACL, `search_path`, SECURITY DEFINER and single overload |
| an expired suggestion is taken off the CURRENT VIEW, not deleted | the `expired` outcome in both review maps sets `removeFromQueue`, which filters component state only | `outlook-new-contact-review.test.js` (exhaustive code-map check). The row stays `pending` in the database and returns on reload — stated in section C2 rather than glossed |
| nothing is scheduled to erase an expired draft | `expire_pending_outlook_context` has no caller | grepped; stated as a blocker, not as behaviour |
| the provider calls are bounded in time and size, and refuse redirects | one AbortController across headers and body, `readJsonBounded`, `redirect: 'manual'` | `outlook-content-corrections.test.js` — headers-then-stall, oversized streamed bodies, redirects, and budget-admitted retries, on both the Anthropic and the Graph path |
| **the NON-200 Graph body is bounded too** | the controller is held until the error body is read, and `MAX_ERROR_BODY_BYTES` (64 KiB) applies to it | same suite. This was NOT true when the claim was first written: the timer was cleared before the error body was read, and that read was an unbounded `res.json()`. A stalled 400 hung with no deadline; an oversized one buffered 4,100,048 bytes. Both reproduced and now refused. |
| Graph error classification is unchanged by that bound | the token is still recovered and `classifyFailure` still decides | same suite — `syncStateNotFound`, `resyncRequired`, `syncStateNotSupported` and `synchronizationStateExpired` still answer `cursor_invalid` on both 400 and 410; an ordinary 400 is still `bad_request`; a malformed error body still classifies on status alone |
| a redirect's body is never read | the 3xx is refused before the body is touched | same suite — the fixture fails the test if `body` or `json()` is reached, and `Location` is never read |
| **Graph retries respect the invocation budget** | `budgetAllows` threaded `summarizeOneConversation` → `makeMessageFetcher` → `executeGraphRequest`, checked before the first attempt, before backoff-plus-next-attempt, and again after the backoff | same suite. Also NOT true when first claimed: with 25s available the loop started attempts at 0, 50,000 and 100,000 ms and spent 120s, because the only bounds consulted were its own. Proven through the real stage wiring, not by calling the transport directly. |
| a caller with no budget is unaffected | `budgetAllows` defaults to "yes" | same suite — the OAuth callback and the identity probe are single requests in short-lived handlers and pass none |
| a failed required handle does not advance the page | `HANDLE_FAILURES` → `handle_production_failed`, checked before the checkpoint | same suite: the second of two encryptions failing writes nothing, and the retry retains both |
| every proposal is reachable | the proposals queue's own keyset cursor and refill | the browser harness reaches proposal 21 |
| Anthropic's retention window | Anthropic's published commercial data-retention article (privacy.claude.com, "How long do you store personal data") — 30 days normally; up to 2 years for inputs/outputs flagged by automated usage-policy enforcement and up to 7 years for the resulting trust-and-safety classification scores; longer where law requires or to act on violations; different under a negotiated agreement | **Not a code claim.** Read from that article while preparing this packet. Funnl holds no zero-retention agreement. The owner must re-read it at publication, since Anthropic can change it without Funnl knowing |

The one item on that list that is **not** verifiable from this repository is
Anthropic's retention window. It is quoted from their published terms and should
be re-read at publication rather than trusted from this document.

---

## What the owner is being asked to decide

1. **Approve, revise or reject** the section A and section B wording.
2. **Confirm that Anthropic may receive minimized message text at all**, on the
   terms described. If not, the body-reading gate can still be opened on its own
   and the summary path stays off — the two gates are independent precisely so
   this choice exists.
3. Confirm the pilot account will **disconnect and reconnect** to give fresh
   consent, and that both gates stay closed until it does.

---

## E. The staged plan, in three separable groups

Grouped because the requirements differ in kind, and bundling them is how a
publication decision quietly becomes an unattended-operation decision. **Nothing
below has been done.** Each group's gate must hold before the next begins.

### E1. Publication requirements — what must be true before the wording goes live

| # | Step | Gate |
|---|---|---|
| 1 | Owner approves the section A paragraphs and the section B policy text | Sign-off on the exact text, not the summary of it |
| 2 | Re-read Anthropic's retention article and confirm the figures in paragraph 7 still match | Anthropic can change it without Funnl knowing; the packet's figures were read once, while preparing it |
| 3 | Replace `OUTLOOK_DISCLOSURE_PARAGRAPHS` in `src/lib/outlookDisclosure.js` with the approved fifteen, and the Outlook section of `src/pages/PrivacyPage.jsx` with the section B text | Published text byte-identical to what was approved. Three published paragraphs are **replaced**, not supplemented — see the table in section A |
| 4 | Set the policy `Last updated` date to the actual New York publication date | Same rule applied on 5 October |
| 5 | **Merge the PR into `main`** | This is also the **frontend deployment**: `vercel.json` sets `git.deploymentEnabled` to `{ main: true, "*": false }`, so merging triggers a Production Vercel build automatically and no separate frontend step exists. Wait for READY before step 6 |
| 6 | Read the derived version from the published paragraphs — `computeDisclosureVersion()`, not typed by hand | One `ol-disc-…` value, copied from its output |

At the end of E1 the wording is live and the gates are still closed: every constant
below is still `null`, so the published notice describes a capability nothing can yet
exercise. That ordering is deliberate — a consent version cannot be derived from text
that is not published.

### E2. Live-pilot requirements — what must be true before one real mailbox is read

| # | Step | Gate |
|---|---|---|
| 7 | Apply the two unapplied migrations | `supabase migration list --linked` shows exactly two pending. Afterwards verify the new RPC signatures, the preserved `accept_interaction_candidate` ACL, and that `authenticated` has no EXECUTE on either producer |
| 8 | Set **three** values to the version from step 6: the server's `OUTLOOK_DISCLOSURE_VERSION` (read by `outlook-oauth-start`, which stamps it into the OAuth state), and the worker's `REQUIRED_CONTENT_CONSENT_VERSION` and `REQUIRED_THIRD_PARTY_CONSENT_VERSION` | **All three, before the reconnect.** The start function stamps the state with whatever it is configured with; the worker compares the stored value against its two constants. A reconnect done while the server still carries the old version records the old version, and no later configuration change can upgrade it in place — the only remedy is another disconnect and reconnect |
| 9 | Configure `ANTHROPIC_API_KEY` for `outlook-import-worker` | Present. On its own it opens nothing: both gates are still checked against the connection's recorded version |
| 10 | Deploy `outlook-import-worker` | Deployed files byte-compared against merged `main`. `outlook-oauth-start` also needs redeploying if step 8 changed its configuration |
| 11 | Pilot **disconnects**, then **reconnects**, reading the new notice | A connection row whose `consent_policy_version` equals the step-6 value. Treat the connection as unverified until a row is actually finalized |
| 12 | Check the connection is due under its retry backoff | If not due, report when it becomes due and stop |
| 13 | **One** authorized worker invocation, using the secret the owner already holds, supplied through a hidden input — never echoed, never pasted into chat, never logged, and **not rotated** | `OUTLOOK_IMPORT_WORKER_ENABLED` set immediately before and unset in a `finally`, then **verified off by name**. The secret's unreadability from this environment is not a blocker: the owner holds it and supplies it directly |

### E3. Unattended-operation requirements — what must be true before it runs on a schedule

Deliberately last, and **out of scope for the current change**. No scheduler and no
retention framework is added here.

| # | Requirement | Why it gates unattended running, not the pilot |
|---|---|---|
| 14 | A scheduled caller for `expire_pending_outlook_context` | Until it exists, an expired suggestion's summary and subject stay stored indefinitely. A supervised pilot can resolve its own suggestions by hand; an unattended one accumulates them. **The policy must not claim automatic deletion before this exists** — and it does not |
| 15 | A scheduled worker trigger | Every invocation so far is manual and authorized one at a time. A schedule removes the human from each one |
| 16 | Operational visibility on the deferral report | `content.deferred` already reports every reason. Unattended running needs somewhere that report is actually read, or a silent stall looks like a quiet success |

### The pilot checklist — what the one invocation must demonstrate

In order, with the state checked after each:

1. **Useful notes on existing contacts.** At least one `interaction_candidates` row
   for a known contact whose `proposed_notes` describes what was discussed — not the
   subject line, not a count. Read it and judge it.
2. **An unknown-person proposal carrying both records.** One `new_contact_candidates`
   row with a `proposed_email` from the message envelope, a name with its evidence,
   and a `draft_summary` — the contact and the interaction offered together.
3. **Edit and accept.** Change fields on each kind of card, accept once, and confirm
   the saved `contacts` / `interactions` rows carry the edited values and not the
   proposal's. Confirm the email came from the envelope and could not be edited.
4. **Dismiss.** Dismiss a suggestion of each kind and confirm **no** contact and
   **no** interaction were created, and the candidate is terminal.
5. **Disconnect cleanup.** Disconnect and confirm the connection, tokens, sync state,
   working records and message references are gone, unreviewed suggestions are
   invalidated, and the records accepted in step 3 **survive** — they are the user's
   own data now.
6. **The worker flag is OFF.** Verified by name, not inferred from the absence of
   activity.

Stop at the first step that does not hold. Steps 3, 5, 7, 8, 9, 10 and 13 are each
separately authorized; approving the wording authorizes none of them.
