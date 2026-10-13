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
> withdrawn. Withdrawing it stops Funnl starting new checks of your mailbox, and **deletes
> nothing**: your connection, everything Funnl has already matched and every suggestion you
> accepted are all still there, and you can disconnect whenever you want to. A check that has
> already started may finish, and Microsoft may keep telling Funnl that new mail has arrived
> for a few days until that arrangement lapses — Funnl records that a message arrived and then
> does nothing with it.

**What each clause is accountable to**

| Wording | What it describes |
|---|---|
| "a small number of invited accounts" | `OUTLOOK_PILOT_USER_ID` holding up to **10** ids, enforced in the parser **and** in `reserve_due_outlook_connection` |
| "refuse a connection request from any account that has not been invited" | `outlook-oauth-start` returning `403 not_in_pilot` |
| "an invitation can be withdrawn. Withdrawing it stops Funnl starting new checks" | the reservation never selects an uninvited account, so no NEW run starts for it. Deliberately "starting new checks" rather than "stops checking": the configuration is a function-environment variable, so it takes effect for invocations after it propagates, not atomically |
| "deletes nothing … all still there" | removal writes nothing and removes nothing: no cursor advanced or cleared, no candidate, no provenance row, no conversation state, no token. It is **not** a claim that no record ever changes again - a run already under way still writes what it was reserved to write, and the wake fields below keep moving |
| "A check that has already started may finish" | a run holding a live lease completes; it was reserved while the account was still eligible, and cancelling it mid-round is how a round loses work. The lease ceiling is `LEASE_SECONDS` (420 s), which bounds how long a lease can be HELD - it is **not** a deadline by which removal has taken effect |
| "Microsoft may keep telling Funnl that new mail has arrived … Funnl records that a message arrived and then does nothing with it" | the Graph subscription is not deleted by removal, so notifications continue until it lapses (3-day lifetime, and no renewal happens because renewal needs a run). Each one still sets `wake_requested_at` and increments `wake_count`, so **wake metadata on a withdrawn account keeps changing** - which is why the notice does not promise a frozen record |
| "you can disconnect whenever you want to" | the Settings card keeps the mailbox details, the persisted history and the Disconnect control for a removed-but-connected account, and stops offering Connect and Update |

**This moves the derived consent version.** The version is a digest of the whole notice, so
editing paragraph 2 changes `DISCLOSURE_FINGERPRINT` and therefore
`OUTLOOK_DISCLOSURE_VERSION`. **No new value is chosen here, deliberately** — it is derived from
the approved text, once, at publication, and then carried into the browser constant, the server
variable and **all three** worker requirements in one commit. Picking it before the wording is
approved would mean deriving it twice.

### 1b. `/privacy` — the pilot-only framing

The section is titled "Outlook connection (not yet available)" and opens "**Outlook is not
generally available.**" The heading becomes wrong once invited accounts are using it: for them
it IS available. Proposed heading:

> Outlook connection (invited accounts only)

and the opening sentence:

> **Outlook is not generally available.** It is being tested with a small number of invited
> accounts, and an invitation can be withdrawn. Nothing below happens unless you are invited
> and explicitly connect Outlook from Settings, and you can disconnect at any time.

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
| 6 | **Deploy BOTH `outlook-oauth-start` AND `outlook-import-worker`**, from clean merged main | See the note below: deploying the worker alone leaves OAuth on the old parser, which refuses a comma-separated cohort. For EACH function: download the deployed source into its own isolated directory and verify complete import-closure **file-set and byte equality** against merged main, CRLF/LF the only normalisation. Preserve each function's JWT setting - `outlook-oauth-start` is `verify_jwt = true`, `outlook-import-worker` is `verify_jwt = false`, both declared in `config.toml`. Execution still paused. |
| 7 | Publish the approved §1a/§1b wording, **derive** the new version | The published page and notice match §1 word for word; the date is the publication date; `verifyDisclosureIntegrity()` passes. |
| 8 | Carry that one value into the browser constant, `OUTLOOK_DISCLOSURE_VERSION` and **all three** worker requirements, in one commit | All five read the same value. Verify the server variable by **digest**: `supabase secrets list --output json` returns each secret's SHA-256, so compare against `sha256(expected)` - name presence proves nothing. |
| 9 | **Redeploy `outlook-import-worker`** so its closure carries the new consent requirements | Byte-equality check again. `outlook-oauth-start` also reads the disclosure version, but from the ENVIRONMENT (`OUTLOOK_DISCLOSURE_VERSION`) rather than from a compiled constant, so it does not need a second deploy for step 8 - it picks the new value up on its next invocation. Still paused. |
| 10 | **The pilot re-consents** via the same-account OAuth update in Settings | Stored `consent_policy_version` equals the new value, **and** connection id, both cursors and the provenance refs match the step-3a baseline exactly - only the consent digest moves. Never a disconnect: the sync state, candidate refs and thread-recovery rows all cascade from the connection. |
| 11 | **RESUME** — flag first, then cron | Flag PRESENT (verified), then `cron.alter_job(1, active := true)` and re-read `active = true`. Then observe one **automatic** run through completion: advancing attempt **and** success timestamps, folders complete, leases released. `none_due` is not evidence. |
| 11a | **Record what is observed, and label it** | What has been DEMONSTRATED by then: the reservation's ordering, its lease and backoff behaviour, and the eligibility filter - all against the real function on a disposable database, plus the composed run over real PostgREST. What has NOT been measured: **throughput and latency with more than one real mailbox**. No capacity or latency figure may be reported from the synthetic proofs, and the 5 min p95 / 2 min median target stays **unmeasured** until live observations are collected by a chosen method (see the plan's §7 - a notification-kicked report is not retained anywhere, so the method has to be decided deliberately). |
| 12 | **Invite the first cohort member** — add one id to both variables | That account connects from Settings, reads the notice, consents, and completes one two-way exchange with Funnl closed. Then re-verify the pilot's records against their pinned digests. Add remaining members **2–3 at a time**. |

**Which functions actually need deploying, established by measurement rather than assumption.**
`outlook-oauth-start/index.ts` imports `checkPilotUser` from `outlookPilotGate.js`, so its
deployed bundle carries its own copy of the parser: with only the worker redeployed, OAuth would
still be running the single-uuid parser and would refuse every member of a comma-separated
cohort with `not_in_pilot` - including the existing pilot. Walking every function's complete
relative-import closure over the files this change touches gives exactly two:

| Function | Why | JWT |
|---|---|---|
| `outlook-oauth-start` | closure includes `outlookPilotGate.js` | `verify_jwt = true` |
| `outlook-import-worker` | closure includes `outlookPilotGate.js` and `outlookImportRun.js` | `verify_jwt = false` |

No other function's closure reaches either file, so the deployment scope is those two and the
scope stays minimal. `outlook-notifications` is **not** redeployed: it records a wake by
subscription id and client-state hash and has no cohort reference at all.

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
