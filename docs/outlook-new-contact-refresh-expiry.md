# The new-contact refresh defect — what it is, and the migration-only rollout

> **Historical record - integration retired 2026-10-19.** Funnl retired its Outlook, Google Calendar and Gmail integrations in Stage D: the UI was removed (#109, #110), the Edge Functions were undeployed and their source removed (#111), and migration `20261019000000` dropped their RPCs, cron job and Vault entries. Everything below is kept unchanged as the record of what was built, decided, consented to and done; its instructions, commands and rollback steps no longer apply and must not be run. Current state: `docs/stage-d-backend-retirement.md`.

**Nothing here is applied, deployed or published.** The change is one unapplied migration on
the branch `fix/outlook-new-contact-refresh-expiry`. Production is unchanged: the pilot is
live on `outlook-import-worker` v57 under notice version
`ol-disc-e1107c0221c89ded0b6a2134df848eea`, the cron tick is active, and the worker flag is
present.

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

Two unapplied migrations exist across two branches:

| Version | File | Branch | What it replaces |
|---|---|---|---|
| `20261013060000` | `preserve_new_contact_context_deadline.sql` | `fix/outlook-new-contact-refresh-expiry` | `upsert_new_contact_candidate` |
| `20261013120000` | `outlook_cohort_reservation.sql` | `feat/outlook-cohort-gate` (PR #90) | `reserve_due_outlook_connection` |

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

If PR #90 is merged first instead, the order reverses and this fix becomes the second
migration — still correct, but then the single-pending check belongs to that rollout rather
than this one. Either way the check is the gate.

---

## 5. The rollout — migration only

No Edge Function is deployed. No frontend change. No secret, flag, cron job or disclosure
version moves. Execution does **not** need to be paused: the function is replaced in place by
`CREATE OR REPLACE`, so a run in flight either used the old definition or uses the new one, and
both answer the same way to everything except a refresh — which, before this, could only fail.

| # | Step | Gate |
|---|---|---|
| 0 | Merge the PR pinned to its verified head | Vercel Production READY for the exact merge SHA, confirmed through **Vercel's own API** (the frontend is unchanged, but a push to `main` still builds). |
| 1 | `supabase migration list --linked` | **Exactly one** pending migration, and it is `20261013060000`. If two are pending, stop — see §4. |
| 2 | Capture the pre-apply baseline, read-only | Digests only: the function's definition, signature and ACL; the `ncc_context_ceiling` definition; and the counts of `new_contact_candidates` by status. No identifier, note or ciphertext printed. |
| 3 | `supabase db push --linked` | Applies that one file. |
| 4 | Verify, read-only (the queries are written out in the migration's header) | exactly **one** `upsert_new_contact_candidate` overload with the 20-argument signature; `prosecdef = true`; `proconfig = {search_path=}`; `service_role` may execute and `anon`, `authenticated` and PUBLIC may not; the function body no longer contains the expiry assignment; `ncc_context_ceiling` unchanged; and the status counts from step 2 identical, since the migration contains no DML. |
| 5 | Watch one real refresh | A pilot thread whose new-contact proposal is still pending receives another message. Expect the run to commit and its cursors to advance, where before it reported `write_failed`. Read the run's own counters; do not reset a round or clear a cursor to provoke it. |

**Rollback.** Re-apply the `upsert_new_contact_candidate` definition from
`20261011000000_outlook_thread_segments.sql` unchanged. That restores the defect, so the only
reason to do it is a fault traced to this change itself. Nothing stored needs undoing: the
migration writes no row, so there is no data to reverse, and no cursor, candidate, provenance
row or accepted interaction is touched by applying or reverting it.

---

## 6. What this does not fix

- A folder that is **currently** stuck re-reading the same page catches up on its next round
  after the fix is applied; nothing needs replaying, and `reset_outlook_round` is not a replay
  mechanism and is not used here.
- Any proposal whose window has already passed stays expired. Accepting an expired suggestion
  is refused, exactly as `/privacy` describes, and this change does not alter that.
- The interaction producer's renewable window (see §1) is left as it is.
