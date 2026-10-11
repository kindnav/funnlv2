# Later interactions inside a settled Outlook thread

## 1. What was wrong

Episode identity is an HMAC over five slots, built in `outlookParticipants.js`: provider,
connection, a tagged contact id, the conversation key, and the **first message key**. The anchor
is the conversation's earliest eligible message, and `outlookConversationRecovery.js`
deliberately completes the thread from Outlook before writing in a delta round so that anchor is
the same in every round.

One consequence of that was never intended. Once the reviewer accepted or dismissed, the
producer found that single fingerprint, saw a non-pending row, and answered `exists_terminal`.
Because `exists_terminal` is in `WRITE_OK` the round still reported success and the cursor still
advanced, so **every later exchange in that thread was discarded in silence.** The previous
proof asserted it as intended behaviour: "Round 3: the thread continues. The producer answers
`exists_terminal` and writes nothing."

Acceptance and dismissal settle **an exchange**, not every future exchange in the thread.

## 2. How a later exchange is distinguished from mail already logged

A thread is a sequence of **segments**. Each settled segment records the keyed fingerprints of
the messages its stored draft represented. The thread's covered set is the union over its
settled segments, and a message is new exactly when its fingerprint is absent from that set.

**Coverage is set membership, never a timestamp comparison.** A high-water timestamp gets two
cases wrong, and neither is hypothetical:

| Case | What a timestamp watermark does | What a fingerprint set does |
|---|---|---|
| **Two messages at the same instant** — a send and its Sent Items copy, a burst, a provider that truncates to the second | Cannot tell which of the two was summarized, so a genuinely new message at the boundary reads as covered | Distinguishes them, because their fingerprints differ |
| **Delayed discovery** — a message moved into the folder, delivered out of order, or surfaced by a delta page in a later round | Its timestamp is behind the watermark while the message has never been seen, so unseen mail is classified as covered and lost | It is new, because its fingerprint is not in the set |

A sorting tie-break does not fix this. It makes the *order* deterministic; it does not record
*which* message was summarized.

`coverage_through_at` is retained too, but it is used for exactly one thing: the floor for a
bounded recovery listing. Nothing consults it to decide coverage.

## 3. What state is retained

Four columns on `public.outlook_candidate_refs`, which is already Outlook's own provenance row,
exactly one per candidate, worker-only, and never deleted except with the candidate, the
connection or the user. `interaction_candidates` is shared with Gmail and is not the place for an
Outlook thread concept.

| Column | What it holds |
|---|---|
| `conversation_fingerprint` | the thread's durable identity. **Contact-independent**, which is what lets coverage survive the new-contact transition |
| `covered_message_fingerprints` | the messages this segment's stored draft represented, at most 50 |
| `coverage_from_at` | the EARLIEST instant among them. A pending segment being refreshed must re-list its own earlier messages, and only the span start reaches them |
| `coverage_through_at` | the latest instant among them, for the recovery floor only |
| `coverage_source` | `draft` or `legacy_baseline`, so an initialized row can never be mistaken for a drafted one |

All four are refused as a half-written claim by `ocr_coverage_together`: the set, the instant and
the provenance arrive together or not at all, and a coverage set always requires its thread.

And one new table, `public.outlook_thread_recovery`: **one row per thread**, holding
`earliest_unpaired_at` - the earliest instant of an uncovered message this connection has seen
and could not pair. It exists for the one case no column can serve, because that case has no
candidate to hang state on. RLS on, no policy, worker-only, cascading from the connection.

No new category of data. The conversation fingerprint and the message fingerprints are the same
keyed one-way values the round already computes, and no body, header, subject, address or
Microsoft identifier is stored. What is new is a **timestamp per thread** and a **span** per
segment, which the disclosure in section 8 now names.

**Growth is bounded but not pruned.** Each segment adds at most 50 fingerprints, about 3 KB.
A thread with a hundred settled segments would hold roughly 300 KB of provenance. No pruning is
implemented, because no demonstrated requirement needs it. If a thread ever exceeds 50 uncovered
messages in one segment the write defers `segment_too_large` rather than truncating its proof.

## 3a. Key rotation changes every fingerprint, not just the anchor

Verified against the real builders: rotating the HMAC key changes the **conversation**
fingerprint and **every message** fingerprint, because all of them are HMACs under the same key.
Coverage written before a rotation is therefore stored under values the current key can never
reproduce. Left alone, a replay would read as entirely new mail and duplicate a settled
exchange, and a thread would look untouched and duplicate its own pending segment.

The mechanism reused is the existing bounded key ring (`computeFingerprintSet`,
`MAX_KEYRING_KEYS` = 5), which already hashes the same fields under the current key and every
accepted prior key. Three consequences, each proven:

- **Coverage decisions test any variant.** A message is already summarized if *any* of its ring
  variants is in the stored set.
- **A write claims only current-key values.** The variants are for lookup; claiming an old-key
  value would record coverage under a key being retired.
- **The thread key migrates forward on touch.** The reader matches any variant and reports
  *which* one it found; the producer looks the row up by that variant and rewrites it to the
  current value, so a thread cannot fall out of the bounded ring.

Coverage needs no variant *parameter* on the producers. A flat set of every variant cannot
answer a per-message question - "every message is settled" and "one message has a variant that
happens to be settled" would be indistinguishable - so the worker resolves each message to the
value it is already on record under before passing it, and the plain subset test still holds.
That was the second design; the first one was wrong in exactly that way.

## 4. Identity while a segment is pending

**One pending segment per thread, keeping the identity it was created under.** Whatever the
worker computes as the current anchor, a write for a thread that already has a pending segment
lands on that row. Re-anchoring would turn a late-discovered earlier message or a rotated key
into a second suggestion for one exchange.

Proven through a refresh, a replay, a key-rotation variant and a late-discovered earlier
message, each landing on the same row.

## 5. Coverage describes the draft actually stored

Coverage moves in the same statement as the draft, and only when a draft is carried. The
producers already turn their draft columns on one test — did this call carry a note — and
coverage now turns on the same test:

- **Created** segment: the refs row is linked, then coverage is written in the same transaction.
  A created segment that carried no draft records no coverage.
- **Refreshed** segment: coverage is rewritten only alongside a new draft. A **metadata-only
  refresh** (the consent gate closed, a body fetch failed) leaves the stored draft *and* its
  coverage exactly as they were.
- **Rejected** write: nothing is written at all.

### The concurrent decision

The reviewer accepts or dismisses while the worker holds a draft describing both the
just-settled messages and newer mail. Storing it would duplicate what is already logged;
discarding it would lose the new mail. Neither happens: the producer compares the incoming
coverage against the thread's settled coverage and answers

| Overlap | Result |
|---|---|
| incoming entirely settled | `exists_terminal` — a replay |
| incoming entirely new | `created` or `refreshed` |
| **partial** | `coverage_moved` |

`coverage_moved` is **not** in `WRITE_OK`, so the existing machinery stops the loop, forfeits the
cursor and re-reads the conversation next round, which then drafts only the genuinely new part.
No new retry mechanism was added.

## 6. Bounded recovery for the segment

The recovery listing is one page per folder, capped at `MAX_RECOVERY_MESSAGES_PER_FOLDER` (25),
and it explicitly refuses `@odata.nextLink`: a thread with more history than that in one folder
reports truncated and is abandoned. **Anchoring a segment on a recent message does not change
that**, because the request still asks for the whole conversation.

So the listing now takes an optional lower bound. Two details are not cosmetic:

- **The property differs per folder.** `outlookMessageNormalize` reads `sentDateTime` for an
  outbound message and `receivedDateTime` for an inbound one, so filtering Sent Items on
  `receivedDateTime` would filter on a different clock than the fold and the ordering use.
- **There is still no `$orderby`.** Graph rejects a filter and an orderby on different
  properties, which is why the shipped request has none, and adding one would break it.

**The floor is the least of everything that can reach back**: anything this round has seen, the
pending segment's own span start, and the durable unpaired hint. The settled coverage instant
bounds the lookback - it is what keeps a long thread inside one page - but it cannot be the floor
on its own. With no settled coverage there is no floor and the request is byte-identical to the
one that shipped.

### The case that forced the durable hint

Reproduced, not hypothesized. Settled coverage ends at 10:00. An unseen **outbound** at 09:00
arrives in round A, whose floor is correctly 09:00 - but its reply does not exist yet, so nothing
is written and the round's working records are erased on completion. The **inbound reply** at
11:00 arrives in round B, whose floor was the coverage instant, 10:00. The 09:00 half was never
re-listed, in that round or any later one, because the delta will not show it again either.

Round A now records `earliest_unpaired_at = 09:00`; round B reads it and lists from 09:00. The
hint **lowers only** - a hint that rose could exclude a half it had already seen - and it is a
floor hint and nothing else, never read to decide coverage. Holding it longer than strictly
needed costs a wider listing window and nothing more, and that window is still one bounded page
per folder.

**Coverage is never claimed for context lost during recovery.** When the widened window
overflows, recovery reports `recovery_truncated` and returns no entry, so no write happens and
no coverage is recorded - a suggestion is never built on a view the worker could not assemble.

Budget checks, request counts, the page cap and resumability are untouched. A tenant that
rejects the added clause answers 400, which is already reported as `recovery_unsupported` and
settled rather than retried — the same posture `conversationId eq` has.

## 7. Legacy rows: forward-only, never inferred

A settled segment written before this feature has no coverage set, and its coverage **cannot** be
reconstructed. The reviewer's date is editable and is a date rather than a message, and the
handles that named the messages were erased with the round.

So nothing is inferred. The coverage read reports `settled_without_coverage` for such a thread —
found by the legacy whole-thread episode key the worker still computes — and the worker records
an explicit **baseline**: the messages of that thread it can currently see, marked covered, with
`coverage_source = 'legacy_baseline'`. No suggestion is produced from them. A row that already
carries coverage is never rewritten, so a baseline can be attempted twice with no effect.

**What a baseline actually absorbs, corrected.** An earlier version of this document said the
cost was "at most one exchange per legacy thread". That was wrong. A baseline marks **every
message visible when it runs** as covered, which on a long thread can be **several exchanges** -
proven in the runtime file with a twelve-message legacy thread covering three exchanges, all
absorbed, no suggestion produced. **That does not establish the beyond-page-cap case**: twelve
messages fit inside one bounded recovery page, so a legacy thread whose history exceeds
`MAX_RECOVERY_MESSAGES_PER_FOLDER` is still undemonstrated, and so is a baseline for a genuine
pre-feature new-contact proposal built from the real two anchor forms rather than a hand-made
row. Only mail arriving *after* the baseline becomes a segment.

That is the price of never duplicating an interaction the reviewer has already accepted, and it
is paid once per legacy thread. It is also why the baseline is recorded as
`coverage_source = 'legacy_baseline'`: a row initialized this way can never be mistaken for one
a draft produced.

**A legacy new-contact proposal whose person is now a contact** resolves too. Its coverage sits
on the proposal's own provenance row, and the known-contact producer finds it by the conversation
fingerprint, which is contact-independent. Proven in the runtime file.

The alternative — baseline the thread as *empty* — would suggest the whole thread again and
duplicate the accepted note. It is not recommended, and it is not implemented.

Existing accepted threads are therefore **not** permanently disabled: they work from their first
baseline onward.

## 8. Disclosure — exact changes, and the cutover they force

### 8a. `/privacy`, the provenance bullet

The published sentence already says "so the same **exchange** is not suggested twice", which stays
accurate. What is not disclosed is the **retained coverage state** and the **later-exchange
behaviour**. Replace the provenance bullet's first sentence:

> one-way keyed fingerprints (with the key version) of the conversation and of the person, so the
> same exchange is not suggested twice.

with:

> one-way keyed fingerprints (with the key version) of the conversation, of the person, and of
> the individual messages a suggestion was drawn from, together with the times of the first and
> last of those messages, so the same exchange is not suggested twice and a later exchange in the
> same thread can be recognised as new. Accepting or dismissing a suggestion settles that
> exchange; if you and the same person exchange messages again in that thread, Funnl prepares a
> new suggestion for the new messages only, and the interaction you already accepted is never
> changed. Where Funnl has seen a message it could not yet pair with a reply, it also keeps the
> time of the earliest such message for that conversation, so the two halves can still be
> brought together when the reply arrives in a later check. These times are stored against your
> account; none of them is a message, an address or a subject line.

The rest of the bullet is unchanged, including "Funnl does not store Microsoft message or
conversation identifiers, mailbox addresses, or subject lines in these provenance records", which
remains true: a message **fingerprint** is not a message identifier.

### 8b. The just-in-time notice — this is the expensive one

The notice currently says:

> ... and one-way fingerprints of the exchange, so the same **conversation** is not suggested
> twice.

Under segments that is **wrong**: the same conversation can be suggested again, for a later
exchange. Replace that clause with:

> ... and one-way fingerprints of the exchange and of the messages it was drawn from, so the same
> exchange is not suggested twice. A later exchange in the same thread is prepared as a new
> suggestion for the new messages only.

**This moves the derived consent version.** The version is a digest of the whole notice, so
changing the text changes `DISCLOSURE_FINGERPRINT`, and all three worker consent requirements
plus the server's `OUTLOOK_DISCLOSURE_VERSION` must move to the same new value in one cutover,
with pilot re-consent. There is no honest way to avoid it: leaving the sentence as it stands
would publish a claim the feature contradicts.

**If you want to pay re-consent once**, batch this notice change with the next one.

### 8c. Ordered cutover

Not interchangeable:

1. Review and approve the 8a and 8b wording.
2. **Apply migration `20261011000000`.** Behaviour is unchanged until a caller passes coverage,
   so this is safe ahead of everything else.
3. **Publish 8a and 8b together**, and set `/privacy` "Last updated" to the publication date.
4. **Derive the new notice version** from the shipped notice, and carry that one value into the
   browser constant, the server `OUTLOOK_DISCLOSURE_VERSION`, and **all three** worker consent
   requirements. Never one alone.
5. **Deploy the worker** from merged main.
6. **Pilot re-consents through the SAME-ACCOUNT OAuth update path.** Not
   disconnect/reconnect. Verified from the catalog in the runtime file:
   `finalize_microsoft_connection` upserts `ON CONFLICT (user_id) DO UPDATE` and returns the
   same connection id, refuses a different Microsoft account outright (`different_account`)
   rather than swapping it, writes the new `consent_policy_version` onto that existing row, and
   deletes nothing. So the connection identity, the cursors, the coverage and the recovery
   hints all survive.

   **Disconnect would destroy them.** `outlook_sync_state`, `outlook_candidate_refs` and
   `outlook_thread_recovery` all cascade from the connection, so a disconnect/reconnect cycle
   would erase every cursor and every dedup reference and the thread history would restart from
   a legacy baseline. That is asserted from the catalog, which is why this step names the
   update path and nothing else.

   Until the pilot re-consents the background gate fails closed and the worker reads nothing -
   the designed posture, not an outage.
7. Watch the first continuation of a real thread, and the first legacy baseline.

**Rollback.** Revert the worker and leave the four columns in place. They are additive and
nullable, every producer parameter defaults to NULL, and with no coverage passed the producers
behave exactly as the applied versions. No stored note, candidate or interaction is touched by
the migration or by a rollback.

## 9. What is demonstrated, and what is not

**Demonstrated against the real functions and a disposable database**
(`tests/sql/outlook-thread-segments-runtime.sql`, 15 sections): a settled exchange stays settled
and its interaction and reviewed note are untouched; a later two-way exchange becomes a new
pending suggestion; a replay is `exists_terminal`; messages sharing an instant are distinguished;
a late-discovered older message is new; one pending segment per thread survives a refresh, a
replay, a rotated key and delayed discovery; a metadata-only refresh and a rejected write advance
no coverage; a concurrent dismissal yields `coverage_moved` and the new mail is then written;
the new-contact transition keeps its coverage; a legacy thread refuses to guess and then works
from its baseline; the lease fence refuses every new path; the constraints refuse half-written
coverage; the acceptance RPCs are untouched.

**Demonstrated at the module boundary**: coverage decisions
(`tests/outlook-thread-segments.test.js`, 17 tests) and bounded segment recovery against a fake
mailbox that honours `$filter`, `$top` and `nextLink`
(`tests/outlook-conversation-recovery.test.js`) — including that a thread with 30 historical
inbox messages is abandoned `recovery_truncated` without a floor and recovers with one.

**Demonstrated as text** (`tests/outlook-thread-segments-migration.test.js`, 15 tests): both
producers are byte-identical to the applied versions apart from marked blocks, with the single
tolerated exception of a trailing comma, pinned explicitly and proven to be the only difference.

### Not demonstrated

- **The run-level orchestration is still not wired.** This is the remaining work, and the
  design question that was blocking it is now RESOLVED, so what is left is mechanical rather
  than open. The six call sites in `outlookImportRun.js`:

  1. call `get_outlook_thread_coverage` once per page with each thread's
     `{cfp, cfps, efp, efps}`;
  2. call `baseline_outlook_thread_coverage` for a thread reporting `settled_without_coverage`,
     and leave that thread alone for the rest of the round;
  3. pass `recoveryFloorIso(...)` into `recoverConversation` as `sinceIso`;
  4. build the message list for `decideSegment` from `stored.handles` plus
     `recovery.extraHandles`;
  5. apply `decideSegment`, filter the content handles to the segment, and attach
     `segmentCoverage` plus `matched_conversation_fingerprint`;
  6. call `record_outlook_thread_recovery` with the unpaired pairs when a thread has uncovered
     mail it could not pair, and let the coverage write resolve them.

### The design question that was open, and its answer

**How can the run obtain ring variants at all?** `outlookRoundState` deliberately converts the
raw Graph conversation and message keys to fingerprints and the run never persists the raw keys
- that is a stated privacy property, not an oversight. So at write time the run holds
fingerprints, and a fingerprint cannot be re-hashed under another key.

Three facts resolve it without any new column:

- **Message variants are computable.** Every message the content pass reads has a handle
  carrying its *encrypted* provider id, and the run already decrypts those (`decryptCursor`, as
  the recovery path does). So the run can recover the raw key and compute the full ring variant
  set for exactly the messages it is about to draft from.
- **Thread lookup does not need conversation variants.** `outlook_conversation_progress`
  already persists `episode_lookup_fingerprints`, which is the current anchor under every ring
  key. The reader and both producers therefore match a thread on
  `conversation_fingerprint = ANY(cfps) OR episode_fingerprint = ANY(efps)`, and `efps` is
  durable round state the run already has. The bounded episode lookup added for the legacy
  case is the same mechanism.
- **The model request is inspectable.** The handler harness in
  `tests/outlook-two-sided-rounds.test.js` already intercepts `ANTHROPIC_MESSAGES_URL` in its
  injected fetch, so asserting that a request carries the intended segment's context and not
  the settled history needs no new harness.

Until the wiring lands the worker passes no coverage and **Production behaviour is exactly
today's**, because every producer parameter defaults to NULL. The end-to-end demonstration
through the real handler, the model-request inspection, and the composed rotation contract are
therefore **not** carried by this PR.
- Whether a tenant accepts the added `$filter` clause. The 400 path is handled; the owner-run
  check establishes the fact, as it did for `conversationId eq`.
- Real-mail behaviour, which only the pilot answers.

### Pre-existing, re-confirmed

Three older SQL proofs (`outlook-content-draft`, `outlook-pilot-reservation`,
`outlook-user-rpc-grants`) assume a clean slate and fail when run after other files in one
alphabetical sequence; each passes alone. `gmail-retention` fails alone and is unrelated. This
file cleans up after itself, which the older ones do not — adding that teardown is what stopped
it from making `outlook-token-rotation` fail on leftover state.
