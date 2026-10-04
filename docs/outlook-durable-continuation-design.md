# Outlook durable continuation — design, and the one decision it cannot make for you

Status: **design + implementation, dormant.** Nothing here is applied, deployed or
enabled. The worker stays off behind two flags. Read the DECISION section before
approving anything: the minimal design needs one product answer and one edit to the
published Privacy Policy, and neither is made here.

---

## 1. The runtime limit this exists to fix

The worker currently awaits the entire import before it answers. That is not survivable
on hosted Supabase Edge Functions. From the current official docs
(https://supabase.com/docs/guides/functions/limits, read 2026-09-30):

| Limit | Value | What it does to us |
|---|---|---|
| Request Idle Timeout | **150 s** | "If an Edge Function doesn't send a response before the timeout, 504 Gateway Timeout will be returned." A long import answers nothing. |
| Maximum Duration | **150 s free / 400 s paid** | The instance is killed mid-run. |
| Maximum CPU Time | **2 s** | Per request, excluding async I/O. Our work is almost entirely I/O, so this is not the binding limit — but it is why no bulk in-memory crunching may be added. |
| Maximum Memory | **256 MB** | Why the plan and the conversation map are capped, and why the accumulator moved to the database. |

**Background tasks do not remove the wall limit.** From
https://supabase.com/docs/guides/functions/background-tasks (same date):
`EdgeRuntime.waitUntil(promise)` keeps the instance alive until the promise settles, but
"The maximum duration is capped based on the wall-clock, CPU, and memory limits. The
function will shut down when it reaches one of these limits." So `waitUntil` buys the
ability to answer early — it does not buy a longer run, and it is **not** used as a way to
exceed the wall clock anywhere in this design.

**The plan is not established.** `npx supabase projects list` and `npx supabase orgs list`
both succeed read-only and neither output carries a plan or tier field. So the budget is
sized for the **conservative case: 150 s wall, 150 s idle**, and it stays correct (merely
pessimistic) if the project turns out to be paid.

**The 420-second lease is not an execution budget.** `LEASE_SECONDS = 420` is a *database*
lease: it stops a second run touching the same connection. It is deliberately longer than
any single invocation may live. The two deadlines are independent and both are enforced:

* the **lease deadline**, anchored to when its RPC ran, renewed per stage (unchanged);
* the **invocation deadline**, anchored to handler entry, new here.

A consequence worth stating plainly: `CONTEXT_WORST_MS` is 285 s, which is larger than the
whole conservative wall limit. The worst-case context load (13 contact pages + probe + 3
reads + a token refresh, each at its 15 s ceiling) therefore cannot fit in one free-plan
invocation. That worst case is a ceiling, not a typical cost — locally the same load runs
in well under a second — but it is a real remaining ceiling and is listed as one in §7.

---

## 2. What durable continuation has to preserve

A delta stream is forward-only. Three things follow, and they drive every choice below.

1. **`@odata.nextLink` is the only way back into a stream mid-round.** It is opaque and
   time-limited. It is stored **byte-for-byte unchanged**, encrypted with the same
   AES-256-GCM cursor path the committed `deltaLink` already uses, and it is never parsed,
   never logged, never trimmed and never rebuilt.
2. **`@odata.deltaLink` is a claim**, not a bookmark: "everything before this is
   ingested." It is committed only when the round is complete *and* every qualifying
   suggestion for that round is already written. Until then it is held as a **pending**
   ciphertext in its own columns and the committed cursor is untouched.
3. **A conversation is not confined to a page, an invocation or a folder.** Two-sidedness
   is a property of the whole exchange. If the halves land in different invocations, the
   worker must still be able to recognise them — otherwise it either publishes from a
   partial view or skips the exchange, and both are forbidden.

Point 3 is what forces persistent state. There is no version of this that avoids it:
memory does not survive an invocation, and a stream cannot be rewound to re-derive it.

---

## 3. The checkpoint, field by field

Two records. Both are service-role only, RLS on, no grant to `authenticated`, and both are
scoped to **one round** and erased when the round commits.

### 3a. Folder progress — new columns on `outlook_sync_state`

| Column | Why |
|---|---|
| `round_id uuid` | The identity of the in-flight round. A new round means the old accumulators are ignored, whatever happened to them. |
| `next_link_ciphertext` / `next_link_nonce` / `next_link_key_version` | Microsoft's opaque `nextLink`, unchanged and encrypted. |
| `pending_delta_ciphertext` / `pending_delta_nonce` | The folder's `deltaLink`, staged but **not** committed. Moves into `delta_link_ciphertext` only when the whole round commits. |
| `round_pages` / `round_messages` | The per-**round** ceilings, so continuation cannot become an unbounded crawl. |
| `round_page_seq` | Makes the per-page checkpoint RPC idempotent under retry. |
| `round_started_at` / `round_expires_at` | A partial round is not allowed to sit forever. |

No message, address, subject or identifier is added here. The committed-cursor columns and
the lease columns are unchanged.

### 3b. Conversation progress — `outlook_conversation_progress`

One row per in-flight conversation of the current round. This is the new persistent
record, and it is the reason for the DECISION section.

| Column | Kind | Why it is needed |
|---|---|---|
| `conversation_fingerprint` | keyed one-way HMAC (64 hex) + `key_version` | Recognise the same thread across pages, invocations and both folders. **Not** Microsoft's `conversationId`. |
| `person_fingerprint` | keyed one-way HMAC | Detect `mixed_counterparties` across invocations by comparing fingerprints. Means **no mailbox address is stored**. |
| `episode_fingerprint`, `episode_lookup_fingerprints` | keyed one-way HMAC | The dedupe key the suggestion is written under. Computed while the raw first-message key was in memory; only the *result* is kept — see below. |
| `first_message_fingerprint` | keyed one-way HMAC | Deterministic tie-break when two messages share a timestamp, so the episode fingerprint is stable however the round was split. |
| `first_seen_at`, `last_seen_at` | timestamps | `last_seen_at` becomes `proposed_interaction_date`, which a committed suggestion already retains. `first_seen_at` decides which message is "first". |
| `contact_id` | Funnl's own id | The matched contact. Funnl data, not Microsoft data. |
| `inbound_count`, `outbound_count`, `message_count` | bounded counts | Two-sidedness across invocations. |
| `taint_code` | controlled enum | `mixed_counterparties`, `ambiguous_contact`, `episode_truncated`, … A tainted conversation produces no suggestion. |
| `expires_at` | timestamp | Round-scoped retention bound. |

**Why a fingerprint of the first message key, and not the key.** The episode fingerprint is
an HMAC over `(provider, connectionId, contactId, conversationKey, firstMessageKey)`. It
cannot be recomputed later from a fingerprint of those inputs. So each invocation computes
the episode fingerprint *for the earliest eligible message it has actually seen*, while
that raw key is in memory, and stores the **result**. A later invocation that finds an even
earlier message recomputes and replaces it. Deciding "earlier" needs an ordering pair that
survives in storage, which is `(first_seen_at, first_message_fingerprint)`. The outcome is
that **no Microsoft message id or conversation id is ever written to a table**, which is
what the published policy says about provenance records and what this record now also
honours.

**Deliberate divergence, recorded.** `qualifyEpisode` breaks a timestamp tie on the raw
`providerMessageKey`; the accumulator breaks it on the message-key fingerprint, because the
raw key is not available on resume. The property that matters is not "identical to the
in-memory path" but **stability**: the same set of messages must yield the same episode
fingerprint however the round was split across invocations. Tests assert that stability
directly, and assert full agreement with the in-memory path when no two messages in a
conversation share a timestamp.

### What is deliberately NOT persisted

* no message body, HTML, MIME, preview or header collection — there is still no column
  anywhere that could hold one;
* no subject line;
* no mailbox address, and no display name (both are only needed for a *new-contact*
  suggestion, which this pass still always defers because it does not read headers);
* no Microsoft message id, conversation id, account id or tenant id;
* no `nextLink` or `deltaLink` in plaintext.

---

## 4. How a round runs

```
invocation 1..n:
  reserve both folder leases            (unchanged)
  load context                          (unchanged) -> decrypts committed cursors
                                        AND any saved nextLink
  for each folder, while the invocation budget allows:
      read one page                     (Graph)
      fold the page into conversation records        (pure, in memory)
      ONE atomic RPC: record_outlook_page_progress
          - fences on BOTH folder leases
          - upserts the conversation records
          - stores the new encrypted nextLink, or the pending deltaLink + complete flag
          - bumps round_pages / round_messages / round_page_seq
      renew the lease if the next page could outlast it   (unchanged guard)
  if the budget is exhausted and the round is unfinished:
      release WITHOUT any cursor, outcome 'continued'
  if both folders reached a deltaLink and nothing was dropped:
      finalize the accumulator rows -> plan
      write every qualifying suggestion (unchanged RPC, unchanged fence)
      only then release WITH the pending deltas as the committed cursors,
      clearing the round's progress and accumulators in the same statement
```

**Atomicity is what makes a crash safe.** The page's accumulator updates and the page's
`nextLink` commit in one RPC, so a kill either takes both or neither. On resume the worker
continues from the stored `nextLink`, which is strictly *after* the last committed page, so
no page is applied twice. `round_page_seq` additionally makes a re-sent RPC a no-op,
covering a network retry after a commit.

**A premature candidate is impossible** because the write loop is unchanged and still runs
only after the commit gate passes — and the gate now also requires that every folder of the
*round* reached its `deltaLink`.

**Controlled restart.** If Graph rejects a saved `nextLink` (expired, or state
invalidated), the run calls `reset_outlook_round`: the saved `nextLink`, the pending deltas
and the round's accumulators are discarded under the lease, and the outcome is
`restart_required`. The **committed** cursor is untouched, so the next round restarts from
the last point that was genuinely ingested — not from scratch, and nothing is skipped.

---

## 5. The invocation budget

| Constant | Value | Why |
|---|---|---|
| `HOSTED_WALL_MS` | 150 000 | The documented free-plan maximum duration, and also the idle timeout. Used because the plan could not be read. |
| `INVOCATION_SAFETY_MS` | 30 000 | Cold start, TLS, and the part of the request the worker does not time. |
| `INVOCATION_BUDGET_MS` | 120 000 | `HOSTED_WALL_MS − INVOCATION_SAFETY_MS`, measured from **handler entry**. |
| `PAGE_ADMIT_FLOOR_MS` | 25 000 | A page is admitted only if the budget can cover this (or the slowest page seen so far, whichever is larger) **plus** the checkpoint and release reserves. |
| `CHECKPOINT_RESERVE_MS` | 20 000 | The per-page progress RPC. |

`PAGE_WORST_MS` (140 s) is deliberately **not** used for admission: reserving it would
admit no pages at all on a 120 s budget. The budget is therefore a best-effort stop, and
the *guarantee* comes from elsewhere — every page is checkpointed atomically, so a hard
platform kill loses at most the page in flight and can never advance a cursor. That is
stated here rather than implied, because a budget described as a guarantee is worse than
one described honestly.

### 5a. The budget covers the WHOLE invocation, not just the page loop

The first version of this design checked the budget in one place: the page loop. Two stages
ran outside it entirely, and both were reproduced before being fixed.

**The context load.** It ran before the only check. A 200 s load against a 120 s budget
returned a **200 `continued`** having read no mail and saved no checkpoint — and on the real
platform the instance was already killed at 150 s mid-load, leaving the lease held until it
expired. Now: the invocation deadline is passed into `loadRunContext`, which checks it
between its bounded steps — per contact page, and before the token stage. A load that cannot
finish stops at a **step boundary**, releases the lease, and reports
`context_budget_exhausted`. That makes it **bounded, not resumable** — see §7.1.

**Finalisation.** Writing a finished round's suggestions is one bounded RPC each, and the
loop had no budget check. Reproduced: 40 qualifying conversations spent **800 s** against a
120 s budget; with the platform stopping the instance after six, six valid pending
suggestions existed, the round was still saved, both cursors were correctly NULL — and
because nothing recorded those six, the next invocation re-listed all 40 and **began again
at the first entry**. A batch larger than one invocation could never finish.

Now the round carries a `round_write_cursor`: the last conversation **dealt with** (written,
or deliberately skipped — a skip is a decision, not unfinished work). `list_outlook_round_conversations`
takes `p_after`, so finalisation resumes rather than restarting, and the budget is checked
before each write with enough held back for the write, the cursor update and the release.
`advance_outlook_round_write_cursor` is lease-fenced on both folders and **monotone**, so a
late or duplicated call cannot rewind it.

**The cursor still does not move until every intended write is confirmed.** A batch that is
unfinished — out of budget, truncated, or holding an unprocessed row — releases without a
cursor and reports `continued`.

**A deliberate trade-off, stated.** The write cursor is persisted **once per invocation**,
after the loop, rather than after every write. One extra round trip per invocation instead
of per suggestion. The cost of a hard stop before it lands is re-writing rows that are
already there, which the candidate upsert answers `refreshed`: bounded rework, never a lost
or duplicated suggestion. A test exercises exactly that.

**`continued` versus `budget_exhausted`.** An invocation that saved progress says
`continued` (200). One that could do **nothing** — no page checkpointed, no suggestion
written, no cursor advanced — says `budget_exhausted` and does **not** answer 200, because
that is a no-progress loop an operator has to see rather than a healthy partial.

The budget is driven by an injected clock, so its behaviour is tested with a virtual clock
rather than by hoping a local Deno reproduces a hosted timeout.

---

## 6. DECISION — what this design will not choose for you

### D1. The published Privacy Policy does not currently cover this record.

`/privacy` → "What Funnl would keep" is an exhaustive, bounded list. It names connection
details, the encrypted authorization, "a per-folder synchronization position … plus
timestamps, retry state and short result codes", the draft fields, the new-contact fields,
and "one-way keyed fingerprints (with the key version) of the conversation and of the
person, so the same exchange is not suggested twice."

The fingerprint bullet is the closest fit, and it is **scoped to provenance records** — its
stated purpose is deduplication. `outlook_conversation_progress` is a different record with
a different purpose (recognising an exchange that is still being read) and its own
lifetime. Every *field kind* in it is already disclosed somewhere — keyed fingerprints, a
key version, timestamps, counts, controlled codes — but the record itself is not named, and
the policy's bullet for synchronization state says "position", not "partial conversation
state".

**So: one bullet must be added to the published policy before Outlook can be enabled.** A
proposed wording is in `docs/outlook-privacy-consent-readiness.md`. This branch does not
touch `src/pages/PrivacyPage.jsx`, and the live policy is unchanged.

### D2. Does conversation-recognition state survive the round that created it?

This is the product decision, and it is not made here.

* **Round-scoped (what is implemented).** Accumulators are erased when the round commits,
  and expire if a round is abandoned. Nothing is retained between rounds. This satisfies
  the stated requirement exactly: a two-sided exchange split across **pages, invocations,
  or Inbox and Sent Items** is recognised, because all of those happen inside one round.
* **What round-scoped cannot do.** If you email someone today and they reply next week, the
  two halves fall in *different rounds*. The later round sees a one-sided continuation of a
  thread whose earlier half it no longer remembers, so it produces no suggestion. Nothing
  is lost or skipped — no cursor moves past an unprocessed message — but that exchange is
  simply never suggested.
* **The alternative** is to keep per-conversation state *between* rounds. That is what
  would make the reply-next-week case work, and it is a materially different retention
  posture: a durable, growing record of how many conversations a user has, when each was
  last active, and which of them involve a tracked contact. It needs a retention window, a
  deletion path, an answer for what disconnecting does to it, and a policy bullet that says
  so.

**The decision to make: is Outlook's product promise "suggest exchanges that complete
within one sync round" (round-scoped, minimal retention) or "suggest exchanges however long
the reply takes" (cross-round retention, a new retained history)?** The second is the
better product and the heavier privacy commitment. It is not a choice an implementation
should make quietly, so the minimal one is implemented and this is written down instead.

---

### D2 as a decision sheet — the concrete proposal to approve or reject

Nothing below is implemented. `outlook_conversation_progress` is round-scoped today and
this branch does not change that. This is here so the decision can be made on specifics
rather than in the abstract.

**The gap, stated once.** You email someone on the 1st. That round completes, commits its
cursors, and erases its recognition state. They reply on the 8th. The round that reads the
reply sees one inbound message in a thread it no longer remembers, so the exchange is
one-sided as far as the worker can tell and **no suggestion is ever made**. Nothing is
skipped and no cursor passes unprocessed mail — the exchange is simply never surfaced.
For a networking tool whose whole point is "you emailed them, they replied, log it", that
is the common case, not an edge case.

**Minimum retained fields** — one row per conversation that has been seen at all, and
nothing else would be added:

| Field | Why it is the minimum |
|---|---|
| `user_id`, `connection_id` | Ownership and cascade on delete. |
| `conversation_fingerprint` + `key_version` | The only way to recognise the thread again. Keyed one-way HMAC; **not** Microsoft's `conversationId`. |
| `person_fingerprint` | Detect a thread that changes counterparty without storing an address. |
| `contact_id` (nullable) | Funnl's own id, so the later half can be attached to the right person. |
| `inbound_seen`, `outbound_seen` (booleans) | **Booleans, not counts.** Two-sidedness is all that is needed across rounds; a running message count would be a measure of how much someone emails, which is more than the question requires. |
| `first_seen_at`, `last_seen_at` | The proposed interaction date, and the basis for expiry. |
| `episode_fingerprint`, `first_message_fingerprint` | So the suggestion is written under a stable dedupe key and a tombstone still suppresses it. |
| `expires_at` | The retention window below, enforced in the row rather than only in code. |

Deliberately **not** added: message counts per round, a per-message history, any subject,
address, display name or Microsoft identifier, and anything resembling a timeline of when
a user was active.

**Proposed retention period: 90 days from `last_seen_at`, rolling.** The reasoning, not a
round number: it spans a recruiting cycle, so an email in early September can still pair
with a reply in November; it is short enough that an abandoned thread disappears within
one season; and it matches the longest follow-up horizon the product itself suggests. A
row is deleted when it expires, when its exchange becomes a suggestion (the provenance
record then carries the dedupe key), or on disconnect. **Alternatives worth rejecting
explicitly:** 30 days (misses the common "replied three weeks later" case, so it buys
little over round-scoped); 1 year (a year-long record of who someone corresponds with,
for a feature that only needs to pair two halves).

**Deletion on disconnect.** `run_microsoft_local_cleanup()` must **delete** these rows, in
the same statement that deletes the connection, tokens and sync state — not empty them.
They are worker recognition state, not user content: there is nothing in them a user would
want back, and the `ON DELETE CASCADE` from `microsoft_connections(id, user_id)` already in
the table definition gives this for free. That must be asserted by the disconnect runtime
test, alongside the existing DELETED-vs-EMPTIED assertions, before enablement. Account
deletion is covered by the `auth.users` cascade.

**Exact privacy wording for review.** To be added as one bullet inside the existing
`What Funnl would keep` list — replacing the round-scoped bullet proposed for D1, not
joining it:

> *to recognize a reply that arrives later:* for each conversation Funnl has looked at, a
> record holding only one-way keyed fingerprints (with the key version) of the
> conversation, the person and the first message, whether each side has replied, the first
> and last times Funnl saw a message in it, and which of your contacts it matches. It
> holds no message content, subject, email address or Microsoft identifier, and it exists
> so that an email you send and a reply that arrives weeks later are recognized as one
> exchange. Funnl deletes it 90 days after the last message it saw in that conversation,
> when the exchange becomes a suggestion, or when you disconnect Outlook — whichever comes
> first.

**What approving this costs.** One migration (the new columns plus a cleanup path), a
change to `run_microsoft_local_cleanup`, something to enforce expiry — and note that the
existing `expire_pending_outlook_context` is **already unscheduled**, which is open item 5
in `docs/outlook-privacy-consent-readiness.md` §7; a second unscheduled expiry job would
make that gap worse rather than adding a new one. And a published policy change, which
means the `/privacy` edit cannot be deferred past it.

**What rejecting it costs.** Outlook only ever suggests exchanges whose two halves land in
the same sync round. That should then be said plainly in the product copy, because a user
who sees some conversations suggested and not others will otherwise read it as a bug.

---

## 7. Remaining ceilings after this slice

1. **ENABLEMENT BLOCKER — the context load is bounded but NOT resumable.**
   `CONTEXT_WORST_MS` is 285 s against a 120 s budget. The load now checks the invocation
   deadline between its bounded steps, so it stops at a step boundary, gives the lease back
   and reports `context_budget_exhausted` instead of being killed mid-load with the lease
   held. But it keeps **no partial state**: the next invocation starts the same load from
   the beginning. So a connection whose real context load exceeds the budget —
   realistically, one approaching `MAX_CONTACTS_LOADED` while the database is slow — will
   answer `budget_exhausted` every time and **never import anything**. It cannot corrupt
   anything and it cannot progress.

   Fixing it means making the load itself resumable (persisting the contact index across
   invocations, or matching against the database rather than loading it), which is a
   different slice. **Until then the hosted runtime limit is addressed for the import loop
   and finalisation, and NOT addressed for context preparation.** `budget_exhausted` is
   deliberately not a 200 so this is visible rather than silent.
2. **An invalid committed `deltaLink`** (as opposed to a saved `nextLink`) still has no
   restart. The run reports incomplete and retries the same cursor. Clearing it means a full
   re-import, which is its own product question (what the user is shown during one).
3. **Per-round ceilings are bounds, not progress guarantees.** A mailbox large enough to
   exceed `MAX_PAGES_PER_ROUND` still ends a round incomplete. The bound is far above the
   old 20-page per-invocation ceiling, but it is a bound.
4. **No scheduler.** Nothing invokes the worker. Continuation only continues if something
   calls it again.
5. **Entra is not set up**, no client secret, token-encryption key or fingerprint HMAC key
   exists anywhere, and the published `Mail.Read`-only text still diverges from the draft
   disclosure's `Mail.Read + User.Read`.
6. **#54's `outlook-content-draft-runtime.sql` is still outdated** and remains a pre-merge
   blocker on its own branch.
