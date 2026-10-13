# The new-contact refresh defect — what it is, and the migration-only rollout

**APPLIED to production on 13 October 2026.** PR #91 was merged as
`28fe93a3c93f73a7f7eff88d4176aded1e0489f7`, pinned to the reviewed head `05f14e1`, and
migration `20261013060000_preserve_new_contact_context_deadline.sql` was applied with the
linked CLI. Nothing else moved: no Edge Function was deployed (`outlook-import-worker` is
still v57), the notice version is still `ol-disc-e1107c0221c89ded0b6a2134df848eea`, the cron
tick is still active and the worker flag was not touched. §5 records the rollout as it ran,
§6 the ordinary synchronization that followed it, and §7 the **live refresh and acceptance**,
observed later the same day.

---

## 1. The defect

`public.upsert_new_contact_candidate` could **never** refresh an existing new-contact
proposal. Its UPDATE branch set

```sql
context_expires_at = now() + interval '30 days'
```

while `created_at` kept the instant the proposal was first written. The table carries its own
ceiling:

```sql
CONSTRAINT ncc_context_ceiling
  CHECK (context_expires_at IS NULL OR context_expires_at <= created_at + interval '30 days')
```

The create and the refresh are **different transactions**, and `now()` is transaction-start
time, so the refreshing clock is strictly later than the creating one. The refreshed value
therefore exceeded the ceiling by exactly how long the row had existed. Microseconds are
enough. Every refresh raised:

```
23514  new row for relation "new_contact_candidates"
       violates check constraint "ncc_context_ceiling"
```

**Why it was not caught earlier:** a test that creates and refreshes inside one transaction
reads the *same* `now()`, the ceiling holds, and the defect is invisible. The proof below
drives the two writes through separate PostgREST requests on purpose, and asserts that the
second transaction's clock really is later before it claims anything.

### What it did to the product

A refresh happens when **more of an exchange arrives in a thread whose new-contact proposal
is still `pending` or `deferred`**. The producer rejected the write; the run reported
`rpc_error` and `write_failed`; and because a round that fails to write does not commit its
delta cursors, that folder **re-read the same page on every subsequent round** until the
reviewer accepted or dismissed the proposal — either of which makes the status terminal and
takes the clean `exists_terminal` path instead.

So the symptom was a stuck folder and a draft that never caught up with the conversation,
for exactly as long as a proposal sat unreviewed.

### Where it came from

The refresh branch dates from `20261006000000_outlook_content_note_and_new_contact_write.sql`
and the definition in Production is the one re-issued by
`20261011000000_outlook_thread_segments.sql`. Both are applied. Nothing about the cohort work
causes or worsens it; it was found by completing that work's composed harness.

### What is deliberately **not** being changed

`upsert_outlook_interaction_candidate` also sets `context_expires_at = now() + interval '30
days'` on its refresh branch. `interaction_candidates` has **no ceiling constraint**, so that
write succeeds and always has. Whether an interaction candidate's review window should be
renewable is a retention question, not a defect, and changing it here would alter live
behaviour that nothing is currently failing on.

---

## 2. The fix

`supabase/migrations/20261013060000_preserve_new_contact_context_deadline.sql` re-issues
`public.upsert_new_contact_candidate` with the body **copied verbatim** from the applied
definition and the expiry assignment removed — the column is simply left alone.

The 30-day review window therefore runs from **creation**, which is what the ceiling always
required and what `/privacy` already publishes: *"a pending suggestion carries a 30-day review
window."* **No published wording changes, no consent version moves, no re-consent.**

Not done, deliberately: the ceiling is not relaxed, `created_at` is not reset, retention is
not extended, no stored note is shortened, and no accepted interaction or contact is touched.
A pending row already past its deadline keeps that past deadline.

**The copy is pinned, not trusted.** `tests/outlook-refresh-expiry-scan.test.js` substitutes
the old assignment back into the new file's function text and requires the result to equal the
applied text **byte for byte**. If any other character of those ~490 lines moved, that test
fails. So the 20-argument signature, the segmentation logic, the rotation and alias handling,
the lease fence, the episode and thread deduplication, the atomic coverage and recovery-hint
updates, the validation order and every returned result code are unchanged by construction
rather than by review.

---

## 3. The evidence

`tests/local/outlook-refresh-expiry.mjs` — the real producer and the real worker over **real
PostgREST**, against this project's Postgres image with every migration applied except the
fix, so the before and the after are measured in one pass on the same durable state. Synthetic
mailbox and model fixtures; production's privacy guards left in place and asserted (no address
reaches a model request).

**Before the fix**

| Check | Result |
|---|---|
| a proposal is created with a 30-day window from creation | `created`, gap exactly `30 days` |
| the refreshing transaction's clock is strictly later | asserted, with the elapsed interval printed |
| refreshing the pending proposal | **`400` / `23514` / `ncc_context_ceiling`**, and the row unchanged by the rejected write |
| the worker's first round | `committed`, one proposal, both cursors committed |
| the worker's next round, with **fresh continuation mail** | **`write_failed`**, `rpc_error: 1`, `cursors_advanced: 0`, committed cursors exactly where round one left them, nothing written |

**After applying only the fix** — against the same durable state, with nothing reset and no
cursor cleared.

| Check | Result |
|---|---|
| one overload, `(…, text[], text[])`, SECURITY DEFINER, `search_path=`, `service_role` only | asserted; `anon` and `authenticated` refused |
| `ncc_context_ceiling` | definition read back unchanged |
| creation then a later **pending** refresh | `refreshed`, the **same** candidate id, no duplicate for the episode |
| `created_at` and `context_expires_at` | byte-identical; the draft and `updated_at` **did** move, so the comparison is not vacuous |
| the new draft and the coverage update | both present after **one** call; one provenance row, updated in place; `coverage_source = 'draft'` |
| a **deferred** proposal | `refreshed`, still deferred, `deferred_until` unmoved, `deferred_until <= context_expires_at` still true |
| an **already expired** context | `refreshed`, deadline still the same past instant, still in the past |
| a **stale lease**, and a foreign run id under a live lease | `stale_run` both times, candidate and provenance digests unchanged |
| an **accepted** proposal | `already_a_contact` (the contact now exists, so the write is refused earlier), row digest unchanged |
| a **dismissed** proposal | `exists_terminal`, row digest unchanged |
| the previously failing worker round, re-run | **`committed`**, `cursors_advanced: 2`, the proposal refreshed in place (`proposals_written: 1`) with `created_at` and the deadline unmoved and the draft carrying the later part of the exchange |

**One detail of that last row, stated rather than glossed.** The failing round had already
persisted its listed messages, so the re-run **resumed that stored round** instead of asking
Graph for the page again - the delta trace for it is empty, and it recovered the thread
through a conversation lookup (`recovered_messages: 4`, `recoveries_two_sided: 1`), read four
bodies, made one model call and wrote the proposal. That is the durable-continuation path
doing what it is for: the work the failed round had already done was not thrown away. The
page itself WAS re-listed by the failing round, under the cursors round one committed -
`[{inbox, token inbox-1, page 2}, {sentitems, token sentitems-1, page 2}]` - so the delta
fixture's token handling is exercised there rather than in the re-run.

---

## 4. Migration order — decided, not left to chance

Two migrations were in flight across two branches. **The first is now applied; the second is
not.**

| Version | File | Branch | What it replaces | State |
|---|---|---|---|---|
| `20261013060000` | `preserve_new_contact_context_deadline.sql` | merged to `main` as `28fe93a` | `upsert_new_contact_candidate` | **applied 2026-10-13** |
| `20261013120000` | `outlook_cohort_reservation.sql` | `feat/outlook-cohort-gate` (Draft PR #90) | `reserve_due_outlook_connection` | unapplied |

They are independent — different functions, no shared object — and `060000 < 120000`, so if
both are ever present in one tree `supabase db push` applies **this fix first**. The cohort
migration was renumbered from `20261013000000` to make that true; it is unapplied, so
renumbering it is safe. **No applied migration is renamed, ever.**

**The thing to avoid:** merging PR #90 before this fix is applied would put both migrations on
`main`, and a single `db push` would then carry both — applying a cohort change that is still
waiting on disclosure approval. So:

> **Apply this fix while `main` carries only this migration.** Verify with
> `supabase migration list --linked` that **exactly one** migration is pending, and that it is
> `20261013060000`, before pushing.

**That is what happened.** When this fix was applied, `main` carried only this migration: the
ledger showed one pending version, `20261013060000`, and `supabase db push --dry-run`
answered *"Would push these migrations: • 20261013060000_preserve_new_contact_context_deadline.sql"*.
The cohort migration was absent from `main` and remains on its own unmerged branch, so it is
now the only unapplied migration and it sorts after this one — a `db push` once that branch
merges applies it alone.

---

## 5. The rollout — migration only

No Edge Function is deployed. No frontend change. No secret, flag, cron job or disclosure
version moves. Execution does **not** need to be paused: the function is replaced in place by
`CREATE OR REPLACE`, so a run in flight either used the old definition or uses the new one, and
both answer the same way to everything except a refresh — which, before this, could only fail.

| # | Step | Gate | What happened |
|---|---|---|---|
| 0 | Merge the PR pinned to its verified head | Vercel Production READY for the merge SHA | **Done.** Merged as `28fe93a`; the merge tree is byte-identical to the reviewed head `05f14e1` (empty `git diff`, same migration blob `a46378ba`). Vercel: see the note below. |
| 1 | `supabase migration list --linked` | **Exactly one** pending, and it is `20261013060000` | **Done.** 34 applied, 35 local, pending `['20261013060000']`, nothing remote-only; dry run named that one file; the cohort migration absent from `main`. |
| 2 | Capture the pre-apply baseline, read-only | Digests only | **Done.** Function OID, signature, owner, security settings, ACL and definition digest; the `ncc_context_ceiling` definition; candidate counts by status as observations. |
| 3 | `supabase db push --linked` | Applies that one file | **Done**, exit 0, with the known catalog-cache error noted below. |
| 4 | Verify, read-only (the queries are in the migration header) | the whole list | **Done** — see the table below. |
| 5 | Watch one real refresh | a pilot thread whose proposal is still pending receives another message | **NOT DONE** — see §7. |

**What step 4 returned.**

| Check | Result |
|---|---|
| ledger | 35 applied, **nothing pending, nothing remote-only**, `20261013060000` recorded last |
| overloads / arguments | **1** overload, **20** arguments |
| OID | **19543, preserved** — `CREATE OR REPLACE` never drops the function |
| owner / SECURITY DEFINER / search_path | `postgres` / `true` / `search_path=""` — all unchanged |
| execute privileges | `service_role` **true**; `anon`, `authenticated`, PUBLIC **false** |
| full function definition | `md5(pg_get_functiondef(oid))` moved `8fafb833c9212cade339eaa5e7dc9e2b` → `f06b86f3aaf656ad32f281f39782ad33`, 22,886 → 25,266 characters |
| the expiry probe | reissues-expiry `true` → **`false`** |
| expiry assignments in the body | **0** non-comment `context_expires_at =` lines |
| the INSERT branch | still grants the 30-day window at creation |
| **the deployed body vs the reviewed file** | `md5(prosrc)` = **`8c227dcad03a799660008c376e5e390f`** over the body **as stored, with CRLF** — 24,237 characters, 24,317 UTF-8 bytes (40 three-byte characters). The LF-normalised body digest **`15b383d9c2a8f5e96a719c971fa284b1`** equals the reviewed file's LF-normalised body, so the deployed body is the reviewed body. |
| `ncc_context_ceiling` | definition unchanged, `convalidated = true` |
| other functions | `accept_new_contact_candidate`, `accept_interaction_candidate`, `dismiss_new_contact_candidate`, `dismiss_interaction_candidate`, `reserve_due_outlook_connection(integer,integer,uuid)`, `upsert_outlook_interaction_candidate` — **all identical digests** |
| configuration | no Edge Function deployed (`outlook-import-worker` still v57); `outlook-worker-tick` job 1, `* * * * *`, `active=true`; worker-flag secret name present and untouched |

**Two labels worth getting right, because the first report got them wrong.**
`f06b86f3aaf656ad32f281f39782ad33` is the digest of the **whole function definition**
(`pg_get_functiondef`: header plus body), which is why it is 25,266 characters and why it
differs from the file. `8c227dcad03a799660008c376e5e390f` is the digest of the **body alone**
(`prosrc`) as stored with CRLF. They are different objects; only the second is comparable to
the dollar-quoted body in the migration file, and it matches.

**The CLI's post-push error is not the apply.** `db push` exited 0 having printed
`Applying migration 20261013060000_…` and then `Finished supabase db push.`, with a
`failed to cache migrations catalog: … pgdelta-target-ca.crt ENOENT` warning in between. That
is a catalog-caching step that runs after the migration. The ledger and the catalog are what
settle whether anything applied — and they say it did. **Do not re-push on this error.**

**Vercel, stated precisely.** The merge commit carries a GitHub commit status posted by the
Vercel integration — `Vercel: success`, deployment `Avk25sPGcXzEJ2CZ4MEeGgMyr`. That is
Vercel's own report delivered through GitHub, **not** an independent query of Vercel's API;
no Vercel credential was available. For a database-only change with an unchanged frontend
bundle that was accepted rather than blocking, and it is recorded here as what it is.

**Rollback.** Re-apply the `upsert_new_contact_candidate` definition from
`20261011000000_outlook_thread_segments.sql` unchanged. That restores the defect, so the only
reason to do it is a fault traced to this change itself. Nothing stored needs undoing: the
migration writes no row, so there is no data to reverse, and no cursor, candidate, provenance
row or accepted interaction is touched by applying or reverting it.

---

## 6. Synchronization after the apply — observed, and what it does not show

A scheduled run completed at **18:15:01.391152Z** on 13 October 2026, after the apply. Both
folders advanced `last_attempt_at` **and** `last_success_at` together to that instant, with
`last_run_complete = true`, `retry_count = 0`, no `last_error_code`, the lease released and
both delta cursors present. No pending wake. That is a healthy, ordinary round.

**It is not evidence that the fixed path ran, and it is not reported as such.** Observed
counts did not move across the window (`interaction_candidates` 5 accepted / 24 dismissed,
`new_contact_candidates` 2 accepted, 5 provenance rows, 2 recovery rows). Counts are
observations, not gates: the pilot is live, so they may legitimately move at any time, and
this migration contains no DML, so nothing it did would move them.

---

## 7. The live refresh and acceptance — demonstrated 13 October 2026

A pilot thread was driven through the whole path with **scripted emails through the real
services**. What was observed, in order:

| Instant (UTC) | What the database shows |
|---|---|
| **18:26:26.448821** | the new-contact proposal is **created**, `pending`, covering **two** messages; `context_expires_at` set to **2026-11-12 18:26:26.448821** — thirty days from creation |
| **18:31:38.457294** | the **same** proposal is **refreshed**, now covering **four** messages. This is the write that could not previously succeed: it is 5 minutes 12 seconds after creation, and the old definition would have set `context_expires_at = now() + 30 days`, exceeding the ceiling by that interval and raising `23514 / ncc_context_ceiling` |
| | the generated note grew from **718** to **1,007 characters** |
| | `created_at` **unchanged**, and the original deadline **2026-11-12 18:26:26.448821 unchanged** — the window still runs from creation, which is the whole point of the fix |
| **18:34:30.197494** | the proposal is **accepted** |
| | **exactly one** interaction saved, and the digest of the refreshed note is **unchanged** by acceptance — what was reviewed is what was stored |
| | the **13** interactions present at the first-proposal checkpoint are **unchanged** |

**What this establishes: this refresh and this acceptance.** The deployed producer takes its
refresh branch on a live pending proposal, preserves `created_at` and the original deadline,
carries the later part of the exchange into the draft, and the reviewed note survives
acceptance intact.

**What it does not establish, and is not claimed:**

- **not** general note accuracy. One exchange, scripted, says nothing about how the model
  handles mail it did not expect. The outstanding note-quality check is still reading
  naturally generated pilot notes against their source exchanges.
- **not** replay behaviour. Nothing here re-delivered a message or re-ran a settled round.
- **not** cohort latency. There is still no throughput or latency measurement with more than
  one real mailbox, and the 5 min p95 / 2 min median figure remains an unmeasured target.

**One unreconciled observation, stated rather than smoothed over.** An earlier checkpoint in
this session recorded **15** interactions; by the time the first proposal was created the
count was **13**. The 13 held steady from that checkpoint through acceptance, which is what
the table above asserts. The reduction from 15 to 13 happened during setup and **has not been
explained**, so no claim is made that the earlier 15-interaction baseline was preserved. It
is a loose end, not a demonstrated deletion by anything in this change — this migration
contains no DML — and it is recorded here so it is not quietly lost.

---

## 8. What this does not fix

- A folder that is **currently** stuck re-reading the same page catches up on its next round
  after the fix is applied; nothing needs replaying, and `reset_outlook_round` is not a replay
  mechanism and is not used here.
- Any proposal whose window has already passed stays expired. Accepting an expired suggestion
  is refused, exactly as `/privacy` describes, and this change does not alter that.
- The interaction producer's renewable window (see §1) is left as it is.
