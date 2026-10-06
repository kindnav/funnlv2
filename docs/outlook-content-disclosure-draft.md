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

> For one exchange Funnl reads at most six messages: the most recent ones, with up
> to two from each side kept back so a reply from either of you is always included.
> Each message is trimmed to 4,000 characters, and at most 12,000 characters are
> used across the whole exchange - so where messages are long, fewer than six are
> used and the oldest are left out. Funnl reads the current message rather than the
> quoted history below it, and removes tracking markup and hidden characters first.

> A signature block is separated from the message text. The other person's
> signature is kept, up to 600 characters, because it is the only place a name is
> reliably stated; your own signature is not sent anywhere. The subject line is
> trimmed to 160 characters.

> To write the summary, Funnl sends that cleaned text to Anthropic, the company
> that provides Funnl's AI. Anthropic receives the message text, the subject, the
> date, and a label saying which side wrote each message. It does not receive
> your email address, the other person's email address, your Microsoft account
> details, or any Funnl identifier. Under Anthropic's standard commercial terms
> this data is deleted within 30 days. There is an exception: material that
> Anthropic's automated policy enforcement flags may be kept for up to two years,
> and safety classification scores for up to seven years. This is not
> zero-retention processing.

> Funnl saves the summary, the subject line, the date, and a one-way fingerprint
> that lets it recognise the same exchange again. **The message text itself is
> discarded once the summary is written** — it is not saved to Funnl's database
> and not written to any log.

> Be clear about what that means: **the suggestion itself is stored**, because
> that is how it is still there when you come back to review it. What it is not
> is part of your network. It sits in a review queue as a draft, it expires after
> 30 days if you never act on it, and it does not appear among your contacts,
> your interactions, your follow-ups or anything Funnl's AI can see.

> When the other person is not already one of your contacts, Funnl will propose
> adding them. The proposed email address comes from the message itself and the
> proposed name from the name your mail provider shows for the sender. Funnl will
> not guess a company or a job title.

> **Nothing enters your network until you press Accept.** You can edit every
> proposed field first, including the name, the summary and the suggested next
> step. Pressing Accept on a proposed contact creates the contact and the first
> interaction together, with the values you approved; dismissing it creates
> neither, and deletes the draft.

> Funnl will not act on newsletters, mailing lists, automated notifications, or
> messages from no-reply addresses. Where an exchange is unclear — more than one
> other person involved, or Funnl could not read all of it — Funnl sets it aside
> rather than guessing.

> You can disconnect Outlook at any time. Disconnecting deletes the stored
> credentials, the sync state and the working records — including the stored
> references Funnl uses to find the messages — and no new reading can start
> afterwards. **If a sync happens to be running at that moment it may finish the
> message it has already requested**, because the request is already with
> Microsoft; that text stays in memory for the rest of that run and is not saved,
> and the run cannot write anything once the connection is gone. A suggestion you
> have already accepted stays, because it is now your own contact and
> interaction.

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
- **The in-flight read is acknowledged rather than glossed.** `disconnect_my_outlook`
  deletes the connection row immediately; it does not wait for, or cancel, a
  worker invocation that already holds a lease. A Graph request already issued
  completes, and the body sits in that invocation's memory until it ends. Nothing
  is written - every subsequent RPC finds no connection and refuses, and the
  release answers false - but "disconnecting stops any further reading" on its own
  overstated it, so the sentence now says what actually happens.
- **The suggestion is stored before acceptance, and the wording now says so.** The
  earlier "nothing is saved until you press Accept" was read as covering the
  suggestion as well, which is wrong: `interaction_candidates` and
  `new_contact_candidates` rows are written by the worker. The distinction that
  matters to a reader is network membership, not storage, so that is what the
  sentence now draws.

---

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
> subject, the date and a label for which side wrote each message, and does not
> receive email addresses, Microsoft account details or Funnl identifiers. Under
> Anthropic's standard commercial terms the data is deleted within 30 days;
> material flagged by automated policy enforcement may be kept up to two years and
> safety classification scores up to seven years. This is not zero-retention
> processing.
>
> **What Funnl keeps.** The message text is discarded once the summary is written:
> it is not stored in Funnl's database and not written to any log. What is stored
> is the suggestion — the summary, the suggested next step, the subject line, the
> proposed date, the proposed email address and name for a person who is not yet
> one of your contacts, and one-way fingerprints that let Funnl recognise the same
> exchange again. While a sync round is in progress Funnl also stores encrypted
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
> sits in a review queue as a draft: it expires after 30 days if you never act on
> it, and it is not among your contacts, your interactions or your follow-ups, and
> is not visible to Funnl's AI assistant. **A contact and an interaction are
> created only when you press Accept**, and only with the values you have
> approved. Dismissing a suggestion creates neither and deletes the draft.
>
> **How long proposals last.** A pending proposal expires 30 days after it is
> created and is then no longer offered. Accepting it turns it into your own
> contact and interaction, which stay until you delete them or delete your
> account. Disconnecting Outlook deletes the credentials, the sync state, the
> working records and the message references, and stops any new reading; a sync
> already running may finish the one message it has already requested, which is
> not saved. A proposal you already accepted stays, because it is now your own
> data.

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
| Anthropic's retention window | Anthropic's published commercial terms | not a code claim; owner to re-check against the current terms at publication |

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
4. Note the remaining implementation work recorded in the PR description. This
   wording is written for the finished behaviour so it can be reviewed once,
   rather than twice.
