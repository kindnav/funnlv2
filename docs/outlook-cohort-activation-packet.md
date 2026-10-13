# Outlook cohort — the wording to approve, and the ordered activation

**Nothing in this file is published, applied, deployed or configured.** No consent version has
been chosen. The implementation it describes is a Draft PR against `main` `c2e524f`; the pilot
is live and unchanged on worker **v57** under notice version
`ol-disc-e1107c0221c89ded0b6a2134df848eea`.

Design, capacity and the test plan: `docs/outlook-cohort-rollout-plan.md`.

---

## 1. The wording to approve

Two edits. Both are needed because the published text says something that stops being true the
moment a second account is invited, and one of them moves the derived consent version.

### 1a. The just-in-time notice — replace paragraph 2

It currently reads:

> Access is restricted to one designated Funnl-controlled test account. Funnl's servers refuse a
> connection request from any other account.

Proposed replacement:

> Access is restricted to a small number of invited accounts. Funnl's servers refuse a
> connection request from any account that has not been invited, and an invitation can be
> withdrawn: if that happens, Funnl stops checking your mailbox and nothing of yours is
> deleted — your connection, everything Funnl has already matched and every suggestion you
> accepted stay exactly as they are, and you can disconnect whenever you want to.

**What each clause is accountable to**

| Wording | What it describes |
|---|---|
| "a small number of invited accounts" | `OUTLOOK_PILOT_USER_ID` holding up to **10** ids, enforced in the parser **and** in `reserve_due_outlook_connection` |
| "refuse a connection request from any account that has not been invited" | `outlook-oauth-start` returning `403 not_in_pilot` |
| "an invitation can be withdrawn … Funnl stops checking your mailbox" | the reservation never selects an uninvited account, so the next run does nothing for it |
| "nothing of yours is deleted … stay exactly as they are" | removal writes nothing: no cursor advanced or cleared, no candidate, no conversation state |
| "you can disconnect whenever you want to" | the Settings card keeps the status and the Disconnect control for a removed-but-connected account |

**This moves the derived consent version.** The version is a digest of the whole notice, so
editing paragraph 2 changes `DISCLOSURE_FINGERPRINT` and therefore
`OUTLOOK_DISCLOSURE_VERSION`. **No new value is chosen here, deliberately** — it is derived from
the approved text, once, at publication, and then carried into the browser constant, the server
variable and **all three** worker requirements in one commit. Picking it before the wording is
approved would mean deriving it twice.

### 1b. `/privacy` — the pilot-only framing

The section is titled "Outlook connection (not yet available)" and opens "**Outlook is not
generally available.**" Both stay true in substance for a small invited cohort, but the sentence
needs to stop implying a single test account. Proposed: keep the title, and replace the opening
with:

> **Outlook is not generally available.** It is being tested with a small number of invited
> accounts. Nothing below happens unless you are invited and explicitly connect Outlook from
> Settings, and you can disconnect at any time.

The rest of the section is unchanged, and the "Last updated" date moves in the publishing commit
as the date guard requires.

---

## 2. The ordered activation

Twelve steps. Each has a gate, and **execution is paused across the cutover** for the same
reason as the thread-segments rollout: between the worker deploy and the version alignment the
deployed worker would be running against a notice whose text no longer matches its requirements.

| # | Step | Gate |
|---|---|---|
| 0 | **Approve §1a and §1b** | Your explicit approval of the exact text. Nothing below starts without it. |
| 1 | Run the repository checks on the pinned head | Everything in §3 green, including the two-eligible/one-excluded proofs. |
| 2 | **PAUSE — you authorize this explicitly.** `SELECT cron.alter_job(1, active := false);` then `scripts/outlook-worker-flag.ps1 disable` | Verify **both**: `cron.job` shows `active = false`, and the flag helper reports ABSENT (verified). UNVERIFIED is not absent. |
| 3 | **Let in-flight runs release naturally** | Every `outlook_sync_state` row `sync_status <> 'running'` and `sync_lease_until` null or past. **Do not force a lease** - a mid-round run releases itself, and forcing it is how a round loses work. |
| 3a | **Capture the stable baseline, once quiescent** | Connection identity, both committed cursors, the provenance refs and the pending-wake count, as **digests or in-database comparisons** - no identifier, ciphertext or mailbox content printed. Read twice a minute apart and get the same digest. **Pending wakes are recorded, never required to be zero**, and nothing clears them. |
| 4 | **Apply migration `20261013000000` only** | `supabase migration list --linked` shows exactly one pending first. Then verify: exactly **one** `reserve_due_outlook_connection` exists; it is `(integer, integer, uuid, uuid[])`, SECURITY DEFINER, empty `search_path`; `service_role` may execute and `anon`, `authenticated` and PUBLIC may not. **Migration before worker deploy, without exception** - the new worker sends `p_pilot_user_ids`. |
| 5 | Merge the PR pinned to its verified head | Vercel Production READY for the exact merge SHA, confirmed through **Vercel's own API** - a GitHub deployment record is not evidence about Vercel, and its absence means unknown rather than failed. |
| 6 | **Deploy `outlook-import-worker` only**, from clean merged main | Download the deployed source into an isolated directory and verify complete import-closure **file-set and byte equality** against merged main, CRLF/LF the only normalisation. Execution still paused. |
| 7 | Publish the approved §1a/§1b wording, **derive** the new version | The published page and notice match §1 word for word; the date is the publication date; `verifyDisclosureIntegrity()` passes. |
| 8 | Carry that one value into the browser constant, `OUTLOOK_DISCLOSURE_VERSION` and **all three** worker requirements, in one commit | All five read the same value. Verify the server variable by **digest**: `supabase secrets list --output json` returns each secret's SHA-256, so compare against `sha256(expected)` - name presence proves nothing. |
| 9 | **Redeploy `outlook-import-worker`** so its closure carries the new requirements | Byte-equality check again. Still paused. |
| 10 | **The pilot re-consents** via the same-account OAuth update in Settings | Stored `consent_policy_version` equals the new value, **and** connection id, both cursors and the provenance refs match the step-3a baseline exactly - only the consent digest moves. Never a disconnect: the sync state, candidate refs and thread-recovery rows all cascade from the connection. |
| 11 | **RESUME** — flag first, then cron | Flag PRESENT (verified), then `cron.alter_job(1, active := true)` and re-read `active = true`. Then observe one **automatic** run through completion: advancing attempt **and** success timestamps, folders complete, leases released. `none_due` is not evidence. |
| 12 | **Invite the first cohort member** — add one id to both variables | That account connects from Settings, reads the notice, consents, and completes one two-way exchange with Funnl closed. Then re-verify the pilot's records against their pinned digests. Add remaining members **2–3 at a time**. |

**Rollback at any step:** remove the id from both variables (nothing of that account's is
deleted, and its connection stays valid), or `cron.alter_job(1, active := false)` then the
worker flag off for a full stop. The migration is **never** reversed: `(integer, integer, uuid,
uuid[])` serves a three-argument caller through its default, so an older worker keeps working.
Cursors are never cleared, and `reset_outlook_round` is not a replay mechanism.

---

## 3. What must be green before step 2

- `outlook-pilot-gate` — cohort parsing on both sides from one table of cases, the two-eligible
  and one-excluded runs through the real run module, malformed lists, and removal-then-re-add
- `outlook-consent-ui`, `outlook-disconnect-ui`, `outlook-sync-status-ui` — the card's behaviour
  for an invited viewer, for a removed-but-connected viewer, and for everybody else
- `outlook-core-scans` — the migration order, with the cohort migration last
- `tests/local/outlook-cohort-reservation.mjs` — the real function on a real database: the
  excluded account never reserved, empty/over-cap/NULL-bearing sets, the single-id and both-null
  compatibility paths, ordering, lease and backoff, one overload, the ACL, per-account
  subscriptions and wake routing, and RLS on every worker-only table
- the full repository suite, `npm run lint` at its pre-existing baseline, and `npm run build`

---

## 4. What this activation does **not** include

Tick rate, reservation batch size, a per-account rate limiter, an admin surface, a queue, richer
evidence-backed metadata, School/Education. Each is a separate workstream, and none of them is
needed for a second person to connect.
