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
| `coverage_through_at` | the latest instant among them, for the recovery floor only |
| `coverage_source` | `draft` or `legacy_baseline`, so an initialized row can never be mistaken for a drafted one |

All four are refused as a half-written claim by `ocr_coverage_together`: the set, the instant and
the provenance arrive together or not at all, and a coverage set always requires its thread.

No new category of data. The conversation fingerprint and the message fingerprints are the same
keyed one-way values the round already computes, and no body, header, subject, address or
Microsoft identifier is stored.

**Growth is bounded but not pruned.** Each segment adds at most 50 fingerprints, about 3 KB.
A thread with a hundred settled segments would hold roughly 300 KB of provenance. No pruning is
implemented, because no demonstrated requirement needs it. If a thread ever exceeds 50 uncovered
messages in one segment the write defers `segment_too_large` rather than truncating its proof.

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

**The floor is the earliest of the coverage instant and anything this round has seen for the
thread**, not the coverage instant. Filtering at the watermark alone would hide a
late-discovered message whose timestamp sits behind it. With no coverage there is no floor and
the request is byte-identical to the one that shipped.

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

**What the first continuation does, stated plainly.** An exchange already sitting in the thread
at baseline time is absorbed into the baseline and is **not** suggested. Only mail arriving after
the baseline becomes a segment. That costs at most one exchange per legacy thread, and it is the
price of never duplicating an interaction the reviewer has already accepted.

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
> the individual messages a suggestion was drawn from, together with the time of the latest of
> them, so the same exchange is not suggested twice and a later exchange in the same thread can
> be recognised as new. Accepting or dismissing a suggestion settles that exchange; if you and
> the same person exchange messages again in that thread, Funnl prepares a new suggestion for the
> new messages only, and the interaction you already accepted is never changed.

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
6. **Pilot re-consents.** Until it does, the background gate fails closed and the worker reads
   nothing — which is the designed posture, not an outage.
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

- **The run-level orchestration is not wired.** `planContentWrite` passes the coverage arguments
  and `recoverConversation` accepts the floor, but nothing in `outlookImportRun.js` yet calls
  `get_outlook_thread_coverage` once per round, attaches `segmentCoverage` to the entries, calls
  `baseline_outlook_thread_coverage` when a thread reports `settled_without_coverage`, or passes
  the floor into recovery. Until that is done the worker passes no coverage and the behaviour in
  Production is exactly today's. **Cross-round halves of a later segment are therefore not yet
  proven through the real handler** — that proof belongs with the wiring.
- Whether a tenant accepts the added `$filter` clause. The 400 path is handled; the owner-run
  check establishes the fact, as it did for `conversationId eq`.
- Real-mail behaviour, which only the pilot answers.

### Pre-existing, re-confirmed

Three older SQL proofs (`outlook-content-draft`, `outlook-pilot-reservation`,
`outlook-user-rpc-grants`) assume a clean slate and fail when run after other files in one
alphabetical sequence; each passes alone. `gmail-retention` fails alone and is unrelated. This
file cleans up after itself, which the older ones do not — adding that teardown is what stopped
it from making `outlook-token-rotation` fail on leftover state.
