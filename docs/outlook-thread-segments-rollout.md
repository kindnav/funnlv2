# Thread segments — rollout packet

**Nothing here is published, applied or deployed.** This is the packet to review before any of
it is. The reviewed worker and migration behaviour is frozen at `91a3f33`; everything after it
is documentation and one owner-run, no-network check script.

Design, evidence and the defect record live in `docs/outlook-thread-segments.md`. This file is
the operational companion: the provider fact and its owner verification, the exact wording to
approve, and the ordered steps.

---

## 1. The provider filter — owner-verified 2026-10-12

**What was in question:** whether this tenant actually applies the conversation-lookup filter —
both the `conversationId eq` clause and the per-folder instant window the narrowed retry adds.
The result is recorded at the end of this section; the reasoning is kept because it is what the
result means.

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

**Every cutoff is reasoned about as transmitted.** The builder's formatter truncates the
fraction, so `10:00:00.900Z` goes on the wire as `10:00:00Z`. An earlier revision of the helper
described the instant it *chose* rather than the one it *sends*: with timestamps
`10:00:00.100Z` and `10:00:00.900Z` it claimed a cutoff between them and transmitted
`10:00:00Z`, below both, separating nothing. The cutoff arithmetic now calls the production
formatter and reports:

- an **exact inclusive-boundary** test only when the transmitted cutoff equals the chosen
  message's timestamp — that is, when the timestamp has no fractional part. Otherwise the
  request is reported as demonstrating **inclusion only**;
- **NOT AVAILABLE** for the property-discrimination request whenever no whole second lies
  strictly between a message's two instants after truncation.

`tests/outlook-filter-cutoffs.test.js` holds those as offline checks, including the exact
fractional case above and a valid separated-timestamp control. **The production builder is
unchanged.**

**Response order is deliberately not asserted and is not an activation requirement.** The
recovery path never sends `$orderby` and refuses `@odata.nextLink` rather than depending on
order, so a check that pinned ordering would be testing a request the worker never makes.

### The handoff — this needs you

Graph Explorer requires an interactive Microsoft sign-in as the pilot mailbox. I did not sign
in and will not. Everything short of the sign-in is prepared, and the script prints this same
sequence when run with no arguments.

**Step 0 — which account.** Open <https://developer.microsoft.com/graph/graph-explorer> and
sign in with the **same Microsoft account connected to Funnl**. If you are unsure which that
is, read it from Funnl's own Settings page (the connected-account line) rather than anywhere
else — and do not paste it into chat. Consent `Mail.Read` when asked. Nothing below needs any
other scope, and every request is a GET.

**Step 1 — one read-only query for a conversation id.** Run exactly:

```
GET https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$select=conversationId,subject&$top=10
```

Pick a thread you know received a **reply**, so it has messages in both folders, and copy its
`conversationId`.

**Step 2 — copy locally, never into chat.** In your own terminal, in this repository:

```
node scripts/outlook-filter-check.mjs --conversation <conversationId>
```

Run the two printed requests. From their results copy **four instants** — again into your
terminal, not into chat:

- from `A-inbox`: one message's `receivedDateTime` **and** its `sentDateTime`
- from `A-sentitems`: one message's `sentDateTime` **and** its `receivedDateTime`

Prefer a message whose two instants fall in **different seconds**; the discrimination step is
only possible then, and the script says NOT AVAILABLE rather than pretending otherwise. Then:

```
node scripts/outlook-filter-check.mjs --conversation <conversationId> \
     --inbox-received <ISO> --inbox-sent <ISO> \
     --sent-sent <ISO>      --sent-received <ISO>
```

**Step 3 — report only this.** Statuses, counts and booleans. No URLs, bodies, addresses or
identifiers, in chat or in any durable log:

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
`conversation_ids_match`, `inclusion_at_cutoff`, `exclusion_works`,
`inbox_property_is_received`, `sent_property_is_sent`. The last two are only demonstrable where
the script did not say NOT AVAILABLE.

A **400** means the tenant refuses the filter shape. That path is handled, but it **blocks**
this rollout: without the narrowed window a long legacy thread can never be completed.

### RESULT — PASS, owner-verified 2026-10-12

Run in Graph Explorer, owner-authenticated as the **verified pilot mailbox**, using the requests
this head's own builder prints. Browser-observed, reported by the owner:

| Request | Status | Count | Chosen message present | conversationIds match | `@odata.nextLink` |
|---|---|---|---|---|---|
| A-inbox | 200 | 1 | — | yes | none |
| A-sentitems | 200 | 1 | — | yes | none |
| B-inbox | 200 | 1 | **yes** | yes | none |
| C-inbox | 200 | 0 | no | yes | none |
| B-sentitems | 200 | 1 | **yes** | yes | none |
| C-sentitems | 200 | 0 | no | yes | none |
| D-inbox | 200 | 1 | **yes** | yes | none |
| D-sentitems | 200 | 0 | no | yes | none |

Every verdict condition is satisfied: `positive_control_non_empty` (both A counts above zero),
`window_complete` (no `@odata.nextLink` anywhere), `conversation_ids_match` (every item, both
folders), `inclusion_at_cutoff` (both B), `exclusion_works` (both C are zero, so C is below B in
both folders), `inbox_property_is_received` and `sent_property_is_sent`.

**Both B requests were exact inclusive-boundary tests:** the transmitted cutoff equalled the
chosen message's own timestamp, so the inclusive boundary itself was probed rather than mere
inclusion. **Both D requests demonstrated the expected property** — Inbox filters on
`receivedDateTime`, Sent Items on `sentDateTime`, which is exactly what the worker relies on per
folder. No request returned NOT AVAILABLE, and none returned 400.

These are the owner's browser observations, recorded as reported; no request made from this
repository ever reaches Microsoft.

**What it unblocks:** step 0 of §3 is satisfied, and the narrowed per-folder window is evidenced
as applied rather than silently ignored. **Scope: this mailbox and this tenant** — not a general
claim about Microsoft Graph. Another tenant, or a mailbox under different Exchange policy, would
need the same check before the same claim could be made. Response order remains unasserted and is
not an activation requirement.

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
> Sometimes Funnl cannot work out which of a thread's older messages it has already accounted
> for — for example a long thread that was in your mailbox before Funnl began tracking it this
> way, where the record that would identify its earlier messages is not reachable. When that
> happens, and only then, Funnl records a **starting point** for that thread instead of
> guessing: the messages it can see in that first look are marked as already accounted for and
> **no suggestion is made from any of them**, however many exchanges they contain, and only
> mail after that point becomes a suggestion. Threads whose earlier messages Funnl can still
> identify are unaffected and keep producing suggestions as normal.
>
> What is kept for a thread with a starting point is a list of up to fifty message
> fingerprints, the starting point itself — **a time taken from the messages in that first
> look, not the time Funnl happened to look** — and the earliest and latest times of everything
> it has accounted for since. That span can widen as older messages reappear; the starting
> point never moves.
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
> suggestion for the new messages only. Where Funnl cannot tell which of a thread's older
> messages it has already accounted for, it records a starting point from those messages' own
> times and makes no suggestion from anything it finds there, so some earlier mail on that
> thread is recorded as history rather than offered to you.

### 2c. What each sentence is accountable to

| Wording | What it describes |
|---|---|
| "fingerprints … of the individual messages a suggestion was drawn from" | `outlook_candidate_refs.covered_message_fingerprints` |
| "the times of the first and last of those messages" | `coverage_from_at`, `coverage_through_at` |
| "Sometimes Funnl cannot work out which of a thread's older messages it has already accounted for … and only then" | the two conditions that trigger a baseline at all: a settled candidate reachable but carrying **no** coverage set (`settled_without_coverage`), or a thread whose coverage could not be established at all and that only the narrowed retry could complete. A thread with locatable coverage, and a thread with no new mail, are never baselined. |
| "marked as already accounted for and no suggestion is made from any of them, however many exchanges they contain" | the absorbed window. It is **the whole initial visible batch**, which may span several exchanges — not one |
| "a list of up to fifty message fingerprints" | `outlook_thread_recovery.baseline_fingerprints`, bounded at 50; an over-bound union is refused, never trimmed |
| "a time taken from the messages in that first look, not the time Funnl happened to look" | `baseline_boundary_at` — the earliest **message timestamp** in the initializing window, set once and never moved. It is not a wall-clock record of when initialization ran |
| "the earliest and latest times of everything it has accounted for since … that span can widen" | `baseline_from_at` / `baseline_through_at`, which expand and decide no eligibility |
| "at most twenty-five … fingerprints and the time of each" | `outlook_thread_recovery.unpaired`, bounded at `MAX_UNPAIRED_HINT_PAIRS` = 25 |

### 2d. This moves the consent version

The notice version is a digest of the whole notice, so changing the text changes
`DISCLOSURE_FINGERPRINT`. **One value, derived once, carried everywhere in a single cutover:**
the browser constant, the server's `OUTLOOK_DISCLOSURE_VERSION`, and **all three** independent
worker requirements in `outlookContentConsent.js` (body, Anthropic, background). Moving one
alone is the hazard the cutover exists to prevent, and the gate fails closed while any of them
is unconfigured or malformed.

---

## 3. The ordered rollout — execution stays DISABLED across the cutover

Not interchangeable. Each step has a gate; stop on any failure.

**Why the pause exists.** The newly deployed worker carries the new *feature* but its three
consent requirements still name the *existing* notice version until the cutover commit. If it
were allowed to run in that state it would do segmenting, absorption and baselining under a
disclosure that does not describe any of it. So execution is switched off before the feature is
deployed and stays off until the published wording, the derived version and the pilot's stored
consent all agree.

| # | Step | Gate |
|---|---|---|
| 0 | **Owner-run filter check** (§1) | **DONE — PASS, owner-verified 2026-10-12** (figures in §1): both B exact inclusive-boundary tests, both D demonstrating the per-folder property, no 400. |
| 1 | Approve the wording in §2 | Your explicit approval of the exact text. |
| 2 | **PAUSE — you authorize this explicitly.** `SELECT cron.alter_job(1, active := false);` then `scripts/outlook-worker-flag.ps1 disable` | Verify **both**: `SELECT jobid, active FROM cron.job;` shows `active = false`, and the flag helper reports the secret ABSENT. UNVERIFIED/UNKNOWN is not absent — re-run rather than assume. |
| 3 | **Wait for in-flight runs to release.** | `SELECT connection_id, folder, sync_status, sync_lease_until FROM public.outlook_sync_state;` — every row `sync_status <> 'running'` **and** `sync_lease_until IS NULL OR sync_lease_until < now()`. Do not force a lease; a run that is mid-round releases on its own, and forcing one is how a round loses work. |
| 3a | **Capture the pre-cutover baseline — only once quiescent** (see the note below the table). The connection `id`, both `delta_link_ciphertext` cursors, and the candidate / `outlook_candidate_refs` references that step 10 must find unchanged. | Held as **digests or in-database comparisons**: no identifier, ciphertext or mailbox content is printed. Read it twice, a minute apart, and get the same digest — that is what makes it a baseline rather than a sample. |
| 4 | **Apply migration `20261011000000` only** | `supabase migration list --linked` shows exactly one pending first. Afterwards verify: the five coverage columns and their CHECKs on `outlook_candidate_refs`; `outlook_thread_recovery` with RLS on and no user policy; the four worker RPCs present with one overload each, SECURITY DEFINER, `service_role`-only; both producers at 19 and 20 arguments; **the two acceptance RPCs unchanged**. |
| 5 | Merge PR #85 pinned to the reviewed head | Vercel build READY. The frontend bundle is functionally unchanged by this PR. |
| 6 | **Deploy `outlook-import-worker`** from merged main | Execution is still disabled — re-verify step 2's two states before and after. Download the deployed source and verify file-set equality and byte equality with the complete import closure (normalise CRLF). |
| 7 | Publish the approved wording, derive the new version | The published page matches §2 exactly; the date is the publication date. |
| 8 | Carry that one version into the browser constant, `OUTLOOK_DISCLOSURE_VERSION`, and **all three** worker requirements, in one commit | All five read the same value. No partial cutover. |
| 9 | **Redeploy `outlook-import-worker`** so the deployed closure contains the new requirements | Download the deployed source again and verify byte equality with the post-cutover closure. Execution still disabled. |
| 10 | Pilot re-consents via the **same-account OAuth update** | `consent_policy_version` equals the new value, **and** the connection `id`, both `delta_link_ciphertext` cursors and the candidate/`outlook_candidate_refs` references match the step-3a baseline exactly. |
| 11 | **RESUME** — only now | Re-enable the flag, then `SELECT cron.alter_job(1, active := true);`. Resume is conditional on step 10 having passed; if stored consent does not match, the gate fails closed anyway and every run releases with `background_consent_not_configured`, but do not rely on that as the control. |
| 12 | Live acceptance (§4) | As defined below. |

**Baseline order — a correction.** An earlier version of this packet said to capture the
step-10 comparison values *before* the pause. That is wrong: while a round is in flight the
cursors are exactly what is being written, so a snapshot taken then records a value that may
change again before quiescence and the later comparison would fail for a reason that is not a
fault. The baseline is therefore captured at **step 3a** — after the pause and after every lease
has released on its own, and still before the migration, the deploy, the publication and the
re-consent, which is all the comparison needs.

**Migration before worker deployment, without exception.** This head's worker calls
`get_outlook_thread_coverage`; against a database without the migration it refuses the round
with `coverage_read_failed` and commits nothing.

**Re-consent is an UPDATE, never a disconnect.** Disconnecting cascades the deletion of the
connection, its tokens, cursors, sync state and candidate references — which would destroy the
coverage this feature depends on and re-import the mailbox from scratch. The same-account OAuth
update path preserves connection identity, cursors and dedup references; that is verified in
`tests/sql/outlook-thread-segments-runtime.sql` section 20.

---

## 4. Live acceptance

On the pilot account, after resume, with Funnl closed:

1. A thread whose exchange has already been **accepted** receives a further two-way exchange —
   one message each way.
2. Funnl **automatically** prepares **exactly one** editable suggestion for that thread, drawn
   from the new messages only.
3. Open it: the draft describes the **new** exchange. The previously accepted interaction and
   its reviewed note are visibly unchanged.
4. Accept it. The contact now has **two** interactions: the first exactly as it was, and a
   second carrying the new note.

**Latency is measured against the existing sync target, not promised per tick.** That target is
5 minutes at p95 and 2 minutes median, already recorded in `docs/outlook-background-sync-plan.md`
§2 as an **unmeasured pilot target rather than a user-facing promise**, assessed over the first
50 signalled runs using `wake_age_seconds`. A single acceptance run is one sample and settles
nothing about the distribution; this feature does not change the wake path, so the target is
inherited rather than re-established. Do not restate it as "within one cron tick".

Not met if: no suggestion appears at all; more than one appears for the one exchange; the draft
mentions the earlier exchange; or the first interaction's note has changed in any way.

---

## 5. Limitations, stated

1. **The ordering constraint** — the worker cannot run against a database without the
   migration.
2. **A long legacy thread's pre-feature `outlook_candidate_refs` row is never initialized.** It
   cannot be located: no conversation fingerprint, and its episode anchor is the first message
   of an exchange a long back-catalogue hides, which no bounded window reaches. It is left
   exactly as the shipped worker wrote it. The thread works again through the thread-level
   baseline, which later segments are decided against.
3. **Where a baseline is needed, everything in that first visible batch is absorbed rather than
   suggested — which may be several exchanges, not one.** That is the approved forward-only
   policy and it is disclosed in §2. It applies only to the two conditions in §2c; a thread
   whose earlier coverage is locatable is unaffected.
4. **The provider fact in §1 is settled for this mailbox and tenant only** (owner-verified
   2026-10-12; figures in §1). It is not a general claim about Graph: another tenant, or a
   mailbox under different Exchange policy, needs the same check.
5. **Real-mail writing quality** remains under observation, as it has been since the detailed
   notes rollout. This feature changes which messages are drafted from, not how the note reads.

---

## 6. Rollback

| If | Then |
|---|---|
| The worker misbehaves after resume | `SELECT cron.alter_job(1, active := false);` and `scripts/outlook-worker-flag.ps1 disable`, then Supabase dashboard → Edge Functions → `outlook-import-worker` → Deployment history → activate the previous version. Coverage rows already written stay; the previous worker ignores them, because every producer parameter this adds defaults to NULL. |
| The feature must be stopped without a redeploy | The same two switches alone. Both are reversible and neither touches stored data. |
| Something is wrong with the wording after step 7 | Republish the previous text and move the one version back across all five places together. Pilot re-consents again. Execution should be paused for that too. |

**Do not reverse the migration.** Narrowing or dropping the coverage columns would destroy the
record of which messages have been summarized, and a thread whose coverage is gone is a thread
that will suggest an accepted exchange a second time. The columns are additive and nullable;
leaving them in place with the previous worker is inert and is the supported rollback.

---

## 7. What has not changed

The reviewed runtime and migration behaviour is frozen at `91a3f33`. Verify before acting on
any step:

```
git diff --stat 91a3f33 HEAD -- supabase/
```

That diff must be empty. Documentation, the owner-run check script and the test harness are the
only things permitted to move after review.
