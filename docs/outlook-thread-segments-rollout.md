# Thread segments — rollout packet

**Nothing here is published, applied or deployed.** This is the packet to review before any of
it is. The reviewed behaviour it describes is frozen at the PR #85 head named below; the only
changes after that head are documentation and the owner-run check script.

Design, evidence and the defect record live in `docs/outlook-thread-segments.md`. This file is
the operational companion: the one provider fact still open, the exact wording to approve, and
the ordered steps.

---

## 1. The one provider fact still open

**What is unverified:** whether this tenant actually applies the conversation-lookup filter —
both the `conversationId eq` clause and the per-folder instant window the narrowed retry adds.

**Why HTTP 200 is not the answer.** A silently ignored `$filter` returns 200 with a perfectly
plausible body. An empty `value` array proves nothing either: it is what an ignored filter
returns for a thread with no messages in that folder, and what an accepted filter returns too.

**What establishes it.** `scripts/outlook-filter-check.mjs` prints the exact requests, built by
this head's own `buildConversationLookupRequest`, with its headers, projection and bounds
unmodified:

| | |
|---|---|
| `$top` | 25 (`MAX_RECOVERY_MESSAGES_PER_FOLDER`) — one page per folder |
| `$select` | `id,conversationId,receivedDateTime,sentDateTime,isDraft,subject,from,sender,toRecipients,ccRecipients` |
| `Prefer` | `IdType="ImmutableId"` |
| filter property | Inbox → `receivedDateTime`; Sent Items → `sentDateTime` |
| `$orderby` | never sent |

The script makes **no network call, reads no credential and writes no file**. It prints to the
terminal only.

**Response order is deliberately not asserted and is not an activation requirement.** The
recovery path never sends `$orderby` and refuses `@odata.nextLink` rather than depending on
order, so a check that pinned ordering would be testing a request the worker never makes.

### The handoff — this needs you

Graph Explorer requires an interactive Microsoft sign-in as the pilot mailbox. I did not sign
in and will not: entering credentials is outside what I do, and the page's app shell did not
load in this environment either. Everything short of the sign-in is prepared.

```
# 1. prints the two positive-control requests
node scripts/outlook-filter-check.mjs --conversation <conversationId>

# 2. re-run with four instants read from step 1's own output
node scripts/outlook-filter-check.mjs --conversation <conversationId> \
     --inbox-received <ISO> --inbox-sent <ISO> \
     --sent-sent <ISO>      --sent-received <ISO>
```

Pick a thread with messages in **both** folders. Run each printed GET in Graph Explorer signed
in as the pilot mailbox, with `Mail.Read` consented.

**Report only this.** No URLs, bodies, addresses or identifiers — not in chat, not in any
durable log:

```
A-inbox      status ___  count ___  ids match? Y/N  nextLink? Y/N
A-sentitems  status ___  count ___  ids match? Y/N  nextLink? Y/N
B-inbox      status ___  count ___  chosen message present? Y/N
C-inbox      status ___  count ___  chosen message present? Y/N   (must be N)
B-sentitems  status ___  count ___  chosen message present? Y/N
C-sentitems  status ___  count ___  chosen message present? Y/N   (must be N)
D-inbox      status ___  count ___  present? Y/N   (or NOT AVAILABLE)
D-sentitems  status ___  count ___  present? Y/N   (or NOT AVAILABLE)
```

Verdict — all must hold: `positive_control_non_empty`, `window_complete`,
`conversation_ids_match`, `inclusive_boundary`, `exclusion_works`,
`inbox_property_is_received`, `sent_property_is_sent`. The last two are only demonstrable when
a message's two instants differ; where they do not, the script says NOT AVAILABLE and that is
what should be reported rather than a claim.

A **400** means the tenant refuses the filter shape. That path is handled, but it **blocks**
this rollout: without the narrowed window a long legacy thread can never be completed.

---

## 2. Disclosure wording — for your review, unpublished

The currently published text describes neither the retained coverage state nor the
later-exchange behaviour, and the notice's claim that "the same **conversation** is not
suggested twice" is contradicted by this feature. Both must change together.

### 2a. `/privacy` — replace the provenance bullet's first sentence

Replace:

> one-way keyed fingerprints (with the key version) of the conversation and of the person, so
> the same exchange is not suggested twice.

with:

> one-way keyed fingerprints (with the key version) of the conversation, of the person, and of
> the individual messages a suggestion was drawn from, together with the times of the first and
> last of those messages, so the same exchange is not suggested twice and a later exchange in
> the same thread can be recognised as new. Accepting or dismissing a suggestion settles that
> exchange; if you and the same person exchange messages again in that thread, Funnl prepares a
> new suggestion for the new messages only, and the interaction you already accepted is never
> changed.
>
> For a thread that was already in your mailbox before Funnl started tracking it this way,
> Funnl cannot tell which of its older messages you have already logged. Rather than guess, it
> records a **starting point** for that thread: the messages it can see at that moment are
> marked as already accounted for and **no suggestion is made from them**, and only mail after
> that point becomes a suggestion. That costs one exchange on such a thread, once. What is kept
> is a list of up to fifty message fingerprints for the thread, the fixed time that starting
> point was set, and the earliest and latest times of everything it has since accounted for —
> that span can widen as older messages reappear, but the starting point itself never moves.
>
> Where Funnl has seen a message it could not yet pair with a reply, it also keeps a short list
> for that conversation of those messages' fingerprints and the time of each — at most
> twenty-five — so the two halves can still be brought together when the reply arrives in a
> later check, and so each entry can be removed once its message has been accounted for.
>
> These fingerprints and times are stored against your account; none of them is a message, an
> address or a subject line.

The rest of the bullet is unchanged, including "Funnl does not store Microsoft message or
conversation identifiers, mailbox addresses, or subject lines in these provenance records",
which remains true: a message **fingerprint** is not a message identifier.

### 2b. The just-in-time notice — replace one clause

The notice currently says:

> … and one-way fingerprints of the exchange, so the same **conversation** is not suggested
> twice.

Replace that clause with:

> … and one-way fingerprints of the exchange and of the messages it was drawn from, so the same
> exchange is not suggested twice. A later exchange in the same thread is prepared as a new
> suggestion for the new messages only. For a thread already in your mailbox, Funnl records a
> starting point and makes no suggestion from what it finds there, so one exchange on such a
> thread is recorded as history rather than offered to you.

### 2c. What each sentence is accountable to

| Wording | What it describes |
|---|---|
| "fingerprints … of the individual messages a suggestion was drawn from" | `outlook_candidate_refs.covered_message_fingerprints` |
| "the times of the first and last of those messages" | `coverage_from_at`, `coverage_through_at` |
| "marked as already accounted for and no suggestion is made from them" | the thread-level baseline — messages absorbed that produced **no** suggestion |
| "a list of up to fifty message fingerprints" | `outlook_thread_recovery.baseline_fingerprints`, bounded at 50 |
| "the fixed time that starting point was set … never moves" | `baseline_boundary_at`, set once |
| "the earliest and latest times of everything it has since accounted for — that span can widen" | `baseline_from_at` / `baseline_through_at` |
| "at most twenty-five … fingerprints and the time of each" | `outlook_thread_recovery.unpaired`, bounded at `MAX_UNPAIRED_HINT_PAIRS` = 25 |
| "costs one exchange on such a thread, once" | the forward-only initialization cost |

### 2d. This moves the consent version

The notice version is a digest of the whole notice, so changing the text changes
`DISCLOSURE_FINGERPRINT`. **One value, derived once, carried everywhere in a single cutover:**
the browser constant, the server's `OUTLOOK_DISCLOSURE_VERSION`, and **all three** independent
worker requirements in `outlookContentConsent.js` (body, Anthropic, background). Moving one
alone is the hazard the cutover exists to prevent, and the gate fails closed while any of them
is unconfigured or malformed.

---

## 3. The ordered rollout

Not interchangeable. Each step has a gate; stop on any failure.

| # | Step | Gate |
|---|---|---|
| 0 | **Owner-run filter check** (§1) | Every boolean holds. A 400 stops the rollout. |
| 1 | Approve the wording in §2 | Your explicit approval of the exact text. |
| 2 | **Apply migration `20261011000000` only** | `supabase migration list --linked` shows exactly one pending first. Afterwards verify: the five coverage columns and their CHECKs on `outlook_candidate_refs`; `outlook_thread_recovery` with RLS on and no user policy; the four worker RPCs present with one overload each, SECURITY DEFINER, `service_role`-only; both producers at 19 and 20 arguments; **the two acceptance RPCs unchanged**. |
| 3 | Merge PR #85 pinned to the reviewed head | Vercel build READY. The frontend bundle is functionally unchanged by this PR. |
| 4 | **Deploy only `outlook-import-worker`** from merged main | Download the deployed source and verify file-set equality and byte equality with the complete import closure (normalise CRLF). |
| 5 | Publish the approved wording, derive the new version | The published page matches §2 exactly; the date is the publication date. |
| 6 | Carry that one version into browser + server + all three worker requirements | All five read the same value. No partial cutover. |
| 7 | Pilot re-consents via the **same-account OAuth update** | The connection row's `consent_policy_version` is the new value, and its id, cursors and dedup references are unchanged. |
| 8 | Live acceptance (§4) | As defined below. |

**Migration before worker deployment, without exception.** This head's worker calls
`get_outlook_thread_coverage`; against a database without the migration it refuses the round
with `coverage_read_failed` and commits nothing. That is a fact about ordering, not a defect —
it is also why the legacy gates had to drive the *shipped* worker from a git worktree to
produce genuine pre-feature rows at all.

**Re-consent is an UPDATE, never a disconnect.** Disconnecting cascades the deletion of the
connection, its tokens, cursors, sync state and candidate references — which would destroy the
coverage this feature depends on and re-import the mailbox from scratch. The same-account OAuth
update path preserves connection identity, cursors and dedup references; that is verified in
`tests/sql/outlook-thread-segments-runtime.sql` section 20.

---

## 4. Live acceptance

On the pilot account, with the cron tick running and Funnl closed:

1. A thread whose exchange has already been **accepted** receives a further two-way exchange —
   one message each way.
2. Within one tick window, Funnl **automatically** prepares **exactly one** editable suggestion
   for that thread, drawn from the new messages only.
3. Open it: the draft describes the **new** exchange. The previously accepted interaction and
   its reviewed note are visibly unchanged.
4. Accept it. The contact now has **two** interactions: the first exactly as it was, and a
   second carrying the new note.

Not met if: no suggestion appears; more than one appears for the one exchange; the draft
mentions the earlier exchange; or the first interaction's note has changed in any way.

---

## 5. Limitations, stated

1. **The ordering constraint above** — the worker cannot run against a database without the
   migration.
2. **A long legacy thread's pre-feature `outlook_candidate_refs` row is never initialized.** It
   cannot be located: no conversation fingerprint, and its episode anchor is the first message
   of an exchange a long back-catalogue hides, which no bounded window reaches. It is left
   exactly as the shipped worker wrote it. The thread works again through the thread-level
   baseline, which later segments are decided against.
3. **One exchange on such a thread is absorbed rather than suggested.** That is the approved
   forward-only policy and it is disclosed in §2; the next exchange is captured normally.
4. **The provider fact in §1 is open** until the owner-run check passes.
5. **Real-mail writing quality** remains under observation, as it has been since the detailed
   notes rollout. This feature changes which messages are drafted from, not how the note reads.

---

## 6. Rollback

| If | Then |
|---|---|
| The worker misbehaves after step 4 | Supabase dashboard → Edge Functions → `outlook-import-worker` → Deployment history → activate the previous version. Coverage rows already written stay; the previous worker ignores them, because every producer parameter this adds defaults to NULL. |
| The feature must be stopped entirely | `cron.alter_job(1, active := false)`, then `scripts/outlook-worker-flag.ps1 disable`. Both are reversible and neither touches stored data. |
| Something is wrong with the wording after step 5 | Republish the previous text and move the one version back across all five places together. Pilot re-consents again. |

**Do not reverse the migration.** Narrowing or dropping the coverage columns would destroy the
record of which messages have been summarized, and a thread whose coverage is gone is a thread
that will suggest an accepted exchange a second time. The columns are additive and nullable;
leaving them in place with the previous worker is inert and is the supported rollback.

---

## 7. What has not changed

The reviewed runtime and migration behaviour is frozen at the head this packet was written
against. Verify before acting on any step:

```
git log --oneline -1
git diff --stat <reviewed-head> HEAD -- supabase/
```

That diff must be empty. Documentation, the owner-run check script and the test harness are the
only things permitted to move after review.
