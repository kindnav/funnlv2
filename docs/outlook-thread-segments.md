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

| column | what it is |
|---|---|
| `unpaired` | a bounded list of `{fp, at}` PAIRS - the message fingerprint and the instant of each uncovered message this connection has seen and could not pair. At most `MAX_UNPAIRED_HINT_PAIRS` = 25 per thread; over the bound the OLDEST pairs are kept, because the oldest is what a recovery window has to reach, and what was shed is reported as `dropped` rather than silently lost. |
| `earliest_unpaired_at` | derived from `unpaired`, for the recovery floor |

It holds the fingerprints and not just the instant because the hint must be **resolved**: the
coverage write that covers a pair deletes it, in the same transaction. A hint that was only an
instant could only ever be LOWERED, which was reproduced as harmful - the window kept reaching
back over settled history until the single bounded page overflowed and the thread was abandoned
`recovery_truncated`. It exists for the one case no column can serve, because that case has no
candidate to hang state on. RLS on, no policy, worker-only, cascading from the connection.

No new category of data. The conversation fingerprint and the message fingerprints are the same
keyed one-way values the round already computes, and no body, header, subject, address or
Microsoft identifier is stored. What is new is a **span** per segment and, per thread, a
**bounded list of message fingerprints with their instants** for mail still waiting to be
paired - which the disclosure in section 8 now names.

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
- **A write claims ONE value per message**: the value it is already on record under when the
  thread has seen that message before, and the current-key value otherwise. Keeping the stored
  value stable is what makes a replay after a rotation produce the same claim the settled row
  holds, so the producer's subset test still answers `exists_terminal`.
- **The thread key migrates forward on touch.** The reader matches any variant and reports
  *which* one it found; the producer looks the row up by that variant and rewrites it to the
  current value, so a thread cannot fall out of the bounded ring.

**Coverage takes a second, separate set - and the earlier claim that it needed none was
wrong.** Reproduced: a recovery hint recorded under era 1 survived a coverage write under era 2
*forever*, because cleanup compared the hint's fingerprint only against the **stored claim**.
The two things are different and the producers now keep them apart:

| parameter | what it is | stored? |
|---|---|---|
| `p_covered_fingerprints` | what the write **claims** - one value per message | yes |
| `p_covered_lookup_fingerprints` | every variant those messages may be on record under, read to recognise a rotated hint | **never** |

The original observation still holds for the claim: a flat set of every variant cannot answer a
per-message question - "every message is settled" and "one message has a variant that happens to
be settled" would be indistinguishable - so the worker resolves each message to one value before
passing it, and the plain subset test is unchanged. What was wrong was concluding from that that
no comparison set was needed anywhere.

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
hint is a floor hint and nothing else, never read to decide coverage. Holding it longer than
strictly needed costs a wider listing window and nothing more, and that window is still one
bounded page per folder.

**Both conclusions of "one-sided" record it, and only one of them used to.** A thread can be
called one-sided in two places: by the segment decision, and - for a half first seen in a delta
round - by **recovery**, which answers `not_two_sided` and returns no entry. Reproduced through
the real handler: that second path returned before the segment block ran, so round 1 saw one
outbound message, recovery confirmed one-sided, and the hint table stayed **empty**. Both paths
now go through one `recordUnpairedHint` helper, and a failure to write the hint stops the round
without committing rather than passing the conversation.

**The hint is resolved, not merely lowered.** An earlier revision only ever lowered it, which
was reproduced as harmful: once the half was covered the window still reached back over settled
history, the single bounded page overflowed and the thread was abandoned
`recovery_truncated`. So the hint records *which* messages are unpaired, and the coverage write
that covers them deletes those pairs in the same transaction - comparing against the **aliases**,
not the stored claim, which is the defect named in 3a.

**At the bound it sheds the newest pair, never the oldest, and says so.** `MAX_UNPAIRED_HINT_PAIRS`
= 25, one number shared by the module, the run and the function that enforces it. Truncating by
fingerprint was reproduced as harmful: 25 recent low-sorting pairs evicted an older,
lexically higher one, which silently raised the floor while the call still answered `ok`. The
merge now orders by instant, so the survivors are the pairs a window has to reach, and `dropped`
is measured **before** the merge and returned - after it the row holds only survivors and a
count reads zero.

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
> changed. Where Funnl has seen a message it could not yet pair with a reply, it also keeps a
> short list for that conversation of those messages' fingerprints and the time of each - at
> most twenty-five of them - so the two halves can still be brought together when the reply
> arrives in a later check, and so each entry can be removed once its message has been
> accounted for. These fingerprints and times are stored against your account; none of them is
> a message, an address or a subject line.

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

Two kinds of evidence appear below and they are not interchangeable:

- **REAL DATABASE EXECUTION** - the run module driving the real functions over real PostgREST
  against the project's own Postgres image, with every migration applied in order. The
  answers are the functions' own.
- **MOCKED CONTRACT** - the run module driving an in-memory model of those functions. Fast,
  and useful for control flow, but a model is a *reading* of the SQL and a reading can be
  wrong. This one was: it keyed the tombstone check on the exact episode fingerprint while
  the real function matches any lookup alias, so it answered `created` where the real
  function answers `exists_terminal` - and that hid a defect that lost mail. The model now
  carries a guard for exactly that behaviour, and nothing is claimed on its evidence alone
  that the real functions have not also been asked.

### REAL DATABASE EXECUTION: `tests/local/outlook-thread-segments-flow.mjs`

36 checks. The run module, the real producer and acceptance RPCs, real PostgREST, controlled
Graph and Anthropic fixtures. Not part of `npm test`, which stays dependency-free; it builds
and tears down its own containers.

| Group | Demonstrated |
|---|---|
| Rotation, known contact | A first exchange is proposed and ACCEPTED through the real acceptance RPC with a reviewer-edited note. The key is rotated with the previous key still accepted. A later two-way exchange produces exactly ONE new pending suggestion, drafted from the later exchange; coverage reaches four messages; a replay refreshes that one row; the accepted interaction and its note are byte-identical (length and digest compared). |
| Rotation, unknown person | The same through `upsert_new_contact_candidate` and `accept_new_contact_candidate`, which also makes the person a contact - so the later exchange crosses the anchor-form transition and the key change at once. |
| Legacy initialization | The pre-feature proposal is written by the **shipped worker**, loaded from a git worktree at `main`, against a database with this migration HELD BACK - then accepted through the real acceptance RPC. The migration is applied to the database that already holds those rows. Both anchor forms are present, and one accepted proposal's person is now a contact. Through the handler the threads are BASELINED (`coverage_baselined`, `coverage_source = 'legacy_baseline'`, no suggestion, no model call), and only mail arriving after the baseline becomes a suggestion. |
| Legacy history beyond the page cap | A GENUINE long legacy thread, for the known-contact path AND for a person who became a contact when their proposal was accepted. The original candidate is written by the shipped worker with the migration withheld and accepted through the real acceptance RPC; the thread then holds `MAX_RECOVERY_MESSAGES_PER_FOLDER + 5` inbound messages of back-catalogue in one folder, with the fixture honouring the conversation clause, the per-folder instant window, `$top` and `@odata.nextLink`. One unwindowed listing overflows; ONE windowed retry completes the thread; the continuation is absorbed explicitly (coverage naming exactly the two messages the window returned); a replay refreshes rather than duplicates; and a second continuation in a later completed round is captured exactly once. Neither the back-catalogue nor the accepted exchange reaches the model in either round. |
| Rotation composed with a decision during drafting | The reviewer ACCEPTS (and, separately, DISMISSES) between the coverage read and the producer write, staged by a hook on the real RPC call. The real producer answers `coverage_moved`, which is not in `WRITE_OK`: no cursor advances and nothing is written. The next attempt - same page, cursor never moved - captures the genuinely new exchange ONCE, the decided row is still the decided row, and the model is sent only the new exchange. |

**The model request is inspected, not assumed**, in every group: the captured Anthropic body
must contain both halves of the intended exchange, must not contain any settled or baselined
message, and must contain no address.

### REAL DATABASE EXECUTION: `tests/sql/outlook-thread-segments-runtime.sql`

20 sections on a fresh database with every migration applied in filename order: a settled
exchange stays settled and its interaction and reviewed note are untouched; a later two-way
exchange becomes a new pending suggestion; a replay is `exists_terminal`; messages sharing an
instant are distinguished; a late-discovered older message is new; one pending segment per
thread survives a refresh, a replay, a rotated key and delayed discovery; a metadata-only
refresh and a rejected write advance no coverage; a concurrent dismissal yields
`coverage_moved` and the new mail is then written; the new-contact transition keeps its
coverage; a legacy thread refuses to guess and then works from its baseline; genuine rotation
is found, migrated forward and still distinguishable; the hint is recorded, merged, partially
resolved and fully removed; long legacy threads and legacy proposals whose person is now a
contact; re-consent as a same-account UPDATE preserves identity, cursors and dedup
references; the lease fence refuses every new path; the constraints refuse half-written
coverage; the acceptance RPCs are untouched.

### MOCKED CONTRACT: `tests/outlook-two-sided-rounds.test.js`

53 tests through the real handler against the in-memory producer model, including the seven
checkpoint-1 demonstrations (D1-D7) and a guard that the model applies the episode-alias
tombstone the real function applies. Its value is breadth and speed over control flow; the
behaviour it models is also asked of the real functions above.

### Module boundary and migration text

Coverage decisions (`tests/outlook-thread-segments.test.js`, 21 tests, including that the
hint-pair bound is one shared number); genuine rotation against the real fingerprint builders
and real key rings (`tests/outlook-thread-rotation.test.js`); the identity step and its reuse
(`tests/outlook-conversation-recovery.test.js`, 33 tests), including that a resolved key makes
recovery skip its own envelope GET and that a one-sided settlement carries the key back;
migration text controls (`tests/outlook-thread-segments-migration.test.js`, 19 tests): both
producers byte-identical to the applied versions apart from marked blocks with one tolerated
trailing comma pinned explicitly, the hint merge shedding the newest pair rather than the
oldest, and the comparison aliases reaching no stored column.

### Why the earlier Gate 2 proved nothing

It created the original candidate with THIS branch's worker AFTER the migration, so the thread
already had `coverage_source = 'draft'` coverage and a conversation fingerprint. The legacy path
was never on trial, and the defect below sat underneath it.

### Defects reproduced and fixed

Each was reproduced first - the first three against the real functions, which is how they were
found at all - and the fix is what the evidence above now holds.

1. **A rotated hint lived forever.** Cleanup compared against the stored claim, so a hint from
   era 1 survived a coverage write in era 2. Fixed with `p_covered_lookup_fingerprints` - see
   3a.
2. **The hint bound silently raised the recovery floor.** Truncating 25 pairs by fingerprint
   shed an older, lexically higher pair while answering `ok`. The merge now orders by instant
   and reports `dropped`, measured before the merge.
3. **Episode aliases do not locate a continuing thread** once its anchor changes. Fixed by
   looking the thread up through the conversation fingerprint's ring variants, and by
   anchoring each segment on its own first message.
4. **A genuinely one-sided thread recorded no hint**, because recovery concluded it and
   returned before the segment block - see section 6.
5. **The segment's handle pre-read forfeited the whole round**, so one thread's transient
   failure blocked every other thread in it. It is now the retryable deferral the vocabulary
   already had.
6. **COVERAGE WAS ASKED FOR BEFORE THE THREAD'S IDENTITY WAS KNOWN.** The per-page batch read
   matches on the current conversation fingerprint and the round's episode aliases; after a
   rotation neither finds a row written under a retired key. Reproduced against the real
   producer: coverage read empty, so there was no floor, recovery re-listed the WHOLE thread,
   the segment took the thread's first message as its anchor, the settled exchange went to
   the model again, and the producer answered `exists_terminal` while the round COMMITTED -
   the new exchange never suggested, and the delta would not deliver it again. Fixed by
   resolving the thread's raw key first - the same envelope GET recovery makes, which recovery
   now reuses rather than repeating - and re-asking that one thread's coverage with its ring
   variants. Only when the ring carries more than one key: with a single key, which is
   Production today, rotation cannot have happened, the batch answer stands and not one extra
   request is made.
7. **The claim was resolved against the settled set alone.** Reproduced against the real
   producer: a reviewer accepted while the worker was drafting the same rotated thread, so
   every message claimed its current-key value, the overlap with the retired-key coverage
   acceptance then settled was invisible, the producer fell through to the episode dedup and
   answered `exists_terminal` - in `WRITE_OK` - so the round committed and the new exchange
   was lost. The claim now resolves against every value the thread is on record under,
   **settled and pending**, so the overlap is visible and the producer answers
   `coverage_moved`: the cursor is forfeited and the next attempt drafts only the new part.
8. **A LONG legacy thread could never log another interaction, and committed anyway.** Its
   refs row has no conversation fingerprint, so the coverage read cannot find it; with no
   settled instant `recoveryFloorIso` offers no floor, which is deliberate - a first pass must
   be able to find a half OLDER than anything this round saw. With no floor the one bounded page
   per folder is spent on the back-catalogue, the page returns `@odata.nextLink`, recovery
   settles `recovery_truncated` and the round COMMITS. Reproduced against the real functions for
   both continuations: `entry_skipped { recovery_truncated: 2 }`, `cursors_advanced: 2`, nothing
   recovered, nothing written. Permanent.

   Fixed with ONE more bounded attempt (`truncatedRetryFloorIso`): when the unbounded listing
   comes back truncated, the listing is asked again, once, windowed to a floor made only of
   instants the run already holds - the earliest message this round stored, the pending
   segment's own span start, the durable unpaired hint. Never a reviewer's date, never a larger
   page, and never more than one retry: a second truncation settles exactly as the first did.
   The window cannot reach the accepted exchange, because it starts at what this round saw, and
   what it returns is claimed explicitly by the write that follows. `recovery_retries` is
   reported so the bound is measurable rather than asserted, and the truncated answer carries
   the conversation key back so the retry makes no second envelope GET.

   **The limit, stated:** the pre-feature refs row itself stays uninitialized. It cannot be
   LOCATED - no conversation fingerprint, and its episode anchor is the first message of an
   exchange the back-catalogue hides, which no bounded window reaches. Nothing pretends
   otherwise; it is left exactly as the shipped worker wrote it. What makes the thread work
   again is that the continuation gets its own coverage row under the thread's conversation
   fingerprint, and every later segment is decided from that.

9. **A genuine SHORT legacy row was never found.** It has no conversation fingerprint, so it is
   matched only on its own episode anchor - the thread's first message, which a delta round
   never delivered. Reproduced with a proposal written by the shipped worker: the thread
   looked brand new, mail that was already a logged interaction was summarized again, and the
   accepted exchange went to the model a second time. Fixed with one bounded extra coverage
   read, taken only when the thread appears to have no coverage AND recovery supplied older
   mail, using the thread's first message under BOTH contact forms across the ring. The
   baseline is given the same set - without that the known-contact thread initialized and the
   accepted-proposal thread did not, because the form the worker computes now is not the form
   an older proposal was written under.

10. **A failed identity resolution was unreportable.** The run emitted `identity_unresolved`,
    which is not in `DEFERRAL_CLASS`, so `sanitizeContentReport` DROPPED it: the round stopped
    without committing and the report said nothing about why. It is now `fetch_failed` - "a
    transient Graph failure, or a moved message", which is exactly what it is, and retryable.
    A control in `tests/outlook-content-stall.test.js` now scans every literal the run passes
    to `bumpDeferral`, in any call shape, and fails if one is outside the vocabulary; a second
    control shows the sanitized output keeping `fetch_failed` and still dropping an unknown
    code.

### Not demonstrated

- Whether a tenant accepts the added `$filter` clause. The 400 path is handled; the owner-run
  Graph Explorer check establishes the fact, as it did for `conversationId eq`.
- Real Microsoft and real Anthropic. Every provider response is a local fixture built from the
  documented contract.
- The browser, Kong, supabase-js and GoTrue. Review writes go straight to PostgREST with a
  locally minted JWT.
- Real-mail behaviour, which only the pilot answers.

### Pre-existing, re-confirmed

Three older SQL proofs (`outlook-content-draft`, `outlook-pilot-reservation`,
`outlook-user-rpc-grants`) assume a clean slate and fail when run after other files in one
sequence; each passes alone, re-confirmed on a fresh database during this work.
`outlook-change-notifications` and `outlook-content-draft` also fail under a
`createdb`+`pg_restore` shortcut, because pg_cron's objects do not come through the dump -
both pass on a database the migrations were applied to directly. `gmail-retention` fails
alone with `{"result": "unauthorized"}` and is unrelated: it fails identically with this
migration excluded, checked explicitly.

Three existing SQL proofs pinned the producer's old arity and were updated to the new
signature, which is what those pins exist for: `outlook-candidate-write-runtime`,
`outlook-detailed-notes-runtime` and `outlook-known-contact-follow-up-runtime` (now 19
arguments).
