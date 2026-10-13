# Outlook beyond one pilot account — the smallest slice to a small cohort

**Nothing here is applied, deployed, published or un-gated.** This is the inspection, the
implementation that came out of it, and the packet to review before any of that reaches
Production. Inspected at `main` `c2e524f` with the pilot live on worker **v57**, notice version
`ol-disc-e1107c0221c89ded0b6a2134df848eea`.

**This file has been corrected against the implementation.** Three claims in its first
revision did not survive contact with the code and are marked below where they were wrong: an
unsupported fairness claim, a reservation signature that cannot take a set, and a capacity
"check" that conflated a synthetic rehearsal with a live measurement.

The live acceptance that justifies going further: an automatic new-contact suggestion appeared
while Funnl was closed and was accepted; a later two-way exchange in the same thread produced a
distinct interaction suggestion, also accepted; the coverage sets were disjoint; both saved
interactions and every earlier record were unchanged.

**Out of scope here, deliberately, and each its own later workstream:** richer evidence-backed
metadata (company, role, LinkedIn) and School/Education. Neither is needed to let a second person
connect, and mixing them in would make this slice unreviewable.

---

## 1. Every gate that currently says "one account"

Four independent gates, in three layers. Each fails closed on its own.

| # | Gate | Where | What it does today |
|---|---|---|---|
| 1 | `VITE_OUTLOOK_CONNECTION_ENABLED` | `src/lib/outlookConnection.js:24` (`outlookConnectionEnabled`, exact string `'true'`) | hides the card entirely unless set |
| 2 | `VITE_OUTLOOK_PILOT_USER_ID` + `outlookPilotViewer()` | `src/lib/outlookConnection.js:68`, mounted at `src/pages/SettingsPage.jsx:501-505` | renders the card **only** for one viewer uuid |
| 3 | `OUTLOOK_PILOT_USER_ID` server-side | `supabase/functions/shared/outlookPilotGate.js` → `outlook-oauth-start/index.ts:104` | refuses to mint an OAuth state for anyone else (`not_in_pilot`) |
| 4 | the same variable in the worker | `outlookImportRun.js:522` (config), `:595` (the reserved connection's owner), `:723` (the context owner), and `p_pilot_user_id` passed into the reservation at `:545` | three checks plus a **database-level filter**, so a non-pilot connection is not even reserved |

`SUGGESTION_REVIEW_ENABLED` (`src/lib/suggestionReview.js`, used in `App.jsx`, `Sidebar.jsx`,
`BottomNav.jsx`, `SuggestionsEntry.jsx`) is a **separate, already-multi-user** gate: it shows the
Suggestions surface to everyone when on, and the queue itself is read with the viewer's own JWT
(`src/lib/pendingSuggestions.js:38-39`), so RLS scopes it per account with no change.

All four Outlook variables are **PRESENT** in Production today (`OUTLOOK_PILOT_USER_ID`,
`OUTLOOK_INTEGRATION_ENABLED`, `OUTLOOK_IMPORT_WORKER_ENABLED`, `OUTLOOK_DISCLOSURE_VERSION`).

**The design note worth respecting:** `outlookPilotGate.js` says in its own comment that it is
"not a feature-flag framework — one variable, one predicate, two call sites". The slice below
keeps that promise instead of replacing it.

---

## 2. Capacity and fairness — already multi-user, and the arithmetic says so

**The ordering is implemented, and it is an ordering - not a starvation guarantee.** The
reservation orders by `(wake_requested_at IS NULL) ASC, min(last_success_at) ASC NULLS FIRST,
c.id ASC` (migration `20261009000000`): a signalled account is taken first, then the
longest-unserved, with the id only as a tie-break.

**CORRECTION.** The first revision of this file said "no account can starve". Nothing
establishes that, and the ordering alone does not imply it: a continuation round can take
several consecutive slots, a notification storm on one account can keep putting it at the front
of the queue, and both of those compete with the scheduled path for the same one-invocation
minute. What the ordering does give is that an account which has waited longest is preferred
over one served recently - which makes prolonged starvation unlikely without making it
impossible. The tests below therefore exercise the cases rather than asserting the claim, and
the measured result after activation is what will say whether the cadence holds.

**The eligibility filter had to change, and that is the one migration in this slice.** The
first revision assumed a `NULL` could be swapped for a list. It cannot: the deployed
`reserve_due_outlook_connection` takes `p_pilot_user_id uuid`, so a set needs SQL. See §6.

**Capacity, measured from the constants:**

| Constant | Value | Where |
|---|---|---|
| tick schedule | every minute, **one** `net.http_post`, no loop | `cron.job` (verified: `command` contains one post, no loop construct) |
| connections reserved per invocation | **1** (`LIMIT 1`) | migration `20261009000000:393` |
| `DUE_AFTER_SECONDS` | 900 (15 min) | `outlookImportRun.js:155` |
| `LEASE_SECONDS` | 420 (7 min) | `outlookImportRun.js:153` |
| `INVOCATION_BUDGET_MS` | 120 000 (150 s wall − 30 s safety) | `outlookContinuedPass.js:73` |

So the scheduled path offers **15 reservation slots per 15-minute window**, and a steady-state
account needs **one** of them per window. A cohort of **N accounts needs N of 15 slots**, which is
why no scheduling change is required for a small cohort — and why the honest ceiling is well below
15:

- a round that needs continuation consumes **several** slots for one account;
- an **initial import** is the burst. A new connection backfills Inbox and Sent Items from nothing,
  bounded per round by `MAX_PAGES_PER_ROUND = 200`, `MAX_MESSAGES_PER_ROUND = 10 000` and
  `MAX_CONVERSATIONS_PER_ROUND = 2 000`, continuing across invocations until done;
- notification-kicked runs do **not** consume tick slots (the endpoint kicks the worker directly),
  so they help latency rather than competing for capacity.

**Recommendation: cap the cohort at 5–8 accounts and onboard 2–3 at a time**, letting each
account's initial import finish before inviting the next. The hard cap of **10** is enforced in
two places - the application parser and the reservation function - so a mis-pasted list cannot
widen it. That is a process decision, not code,
and it keeps the existing 5 min p95 / 2 min median target plausible instead of silently breaking
it. Raising the tick rate or reserving more than one connection per invocation is **not** part of
this slice; revisit only if measured `wake_age_seconds` degrades.

---

## 3. Subscriptions and renewal — per connection already

`outlookSubscriptions.js` creates **one Graph subscription per connection**
(`SUBSCRIPTION_RESOURCE = 'me/messages'`, `SUBSCRIPTION_CHANGE_TYPE = 'created'`,
`SUBSCRIPTION_LIFETIME_MS` 3 days, renewed when within `SUBSCRIPTION_RENEW_BEFORE_MS` = 24 h),
recorded through `record_outlook_subscription_state` fenced on the run id, and never fatal to the
import. `outlook_subscriptions` rows carry `connection_id`, so N accounts mean N rows.

The notification endpoint is already account-agnostic: it matches the **subscription id plus the
SHA-256 of the clientState** and records a wake on that connection. It contains no pilot
reference, which means a second account's notifications would be honoured the moment its
connection exists — the worker's own gate is what currently stops the run.

**Consequence for the cohort: renewal is per-account work on the same cadence.** Each connection
needs a run at least every ~2 days to renew before expiry, which the 15-minute due interval
satisfies many times over — unless that account is in a long failure backoff. Nothing to build;
something to watch (§6).

---

## 4. Consent enforcement — per connection, so it already generalises

The three requirements in `outlookContentConsent.js` are compared against **each connection's own
`consent_policy_version`**, so a second account that consents under the published notice satisfies
them, and one that has not is refused with `background_consent_missing` before any read. That is
the mechanism we exercised in the cutover, and it needs no change.

**But the notice itself is pilot-only, and this is the one real disclosure cost.** Paragraph 2 of
`OUTLOOK_DISCLOSURE_PARAGRAPHS` (`src/lib/outlookDisclosure.js:108`) reads:

> Access is restricted to one designated Funnl-controlled test account. Funnl's servers refuse a
> connection request from any other account.

For a cohort that sentence becomes **false**, so it must change — and because the version is
derived from the paragraph text, changing it **moves the derived version**, which means the full
one-value cutover again (browser constant + server `OUTLOOK_DISCLOSURE_VERSION` + all three worker
requirements, in one commit, with the worker redeployed) **and the existing pilot re-consenting**
through the same-account OAuth update that now exists in Settings. There is no way to open the
cohort without paying that once. Everything else about the notice stays as published.

`/privacy` carries matching pilot-only framing — the section title "Outlook connection (not yet
available)" and "**Outlook is not generally available.**" (`PrivacyPage.jsx:194-196`) — which must
be revised in the same publication, with the date moved in that commit as the date guard requires.

---

## 5. Account isolation — sound by construction, worth proving once

| Mechanism | Evidence |
|---|---|
| Fingerprints are namespaced per connection | `buildPersonFingerprintFields` requires `connectionId` and uses it as `accountNamespace` (`outlookParticipants.js`), so two accounts cannot collide or deduplicate against each other |
| Worker-only tables | `outlook_candidate_refs`, `outlook_thread_recovery`, `outlook_subscriptions`, `outlook_sync_state` all have RLS on with **no** user policy and `service_role`-only grants |
| Reviewer-visible tables | the queue reads with the viewer's JWT, so RLS scopes `interaction_candidates` / `new_contact_candidates` per account |
| Writes | every candidate write goes through the SECURITY DEFINER producers, lease-fenced on the reserving run |
| Tokens | per connection, encrypted; `outlook_sync_state` cursors are per connection and per folder |

Nothing here needs changing. It needs **one demonstration with two accounts**, because
"structurally impossible" has been wrong before in this codebase.

---

## 6. The smallest implementation slice

Three changes, all reusing what exists. No new framework, no new table, no new Edge Function, no
migration.

**S0 — the migration, because the deployed function cannot take a set.**
`reserve_due_outlook_connection` is `(integer, integer, uuid)`. Migration
`20261013000000_outlook_cohort_reservation.sql` drops that signature and re-creates it as
`(integer, integer, uuid, uuid[])`: one extra defaulted parameter, the eligibility clause
taught to use it, and everything else - the lease rules, the backoff rules, the three due
alternatives, the ordering, the wake cutoff, the row insert, the serialization handling and the
answer shape - copied verbatim, so the diff reads as exactly that change. One function, one
overload, so PostgREST has nothing to resolve between; the three-argument caller still resolves
through the default, which is what lets the migration go **before** the worker deploy. Grants
are restated for the new signature and revoked from `PUBLIC`, `anon` **and** `authenticated` by
name, because this project's default privileges re-grant EXECUTE on a newly created function.

**S1 — one variable learns to hold a short list.** `designatedPilotUser()` becomes
`designatedPilotUsers()` returning a **set** parsed from a comma-separated list of uuids, with
`checkPilotUser()` testing membership. Same variable name, same predicate, same call sites, same
fail-closed behaviour: a malformed or empty value still means **nobody**, a `*` or `true` still
parses to nothing, and the reservation keeps its database-level narrowing by passing the list (or
`NULL` only when the cohort is the whole product, which is not this slice). Cap the parsed list at
a small number — 10 — so a mis-pasted value cannot silently open the integration. The frontend
`outlookPilotViewer()` gets the same treatment against `VITE_OUTLOOK_PILOT_USER_ID`.

*Why a list rather than removing the gate:* it keeps the invitation explicit and reversible, it
keeps the two layers independent, and it is a change to one predicate rather than to the model of
who may connect.

**S2 — the disclosure and the policy stop saying "one account".** Paragraph 2 rewritten to describe
an invited group whose connection requests are refused unless invited; `/privacy` section title and
opening sentence revised; the date moved in the same commit. Then the **one-value cutover** of §4
and the pilot's re-consent.

**S3 — removal stops imports without stranding the account.** Deleting an id from the variable
is how somebody leaves the cohort. What that does, stated exactly:

- **the next run for that account refuses at the gate**, before any Microsoft call, and the
  refusal writes nothing: no cursor is advanced or cleared, no candidate is written, no
  conversation state changes. Re-adding the id resumes from where the account left off;
- **nothing is deleted.** The connection, its encrypted tokens, its cursors, its provenance
  records, its pending suggestions and every accepted interaction all stay exactly as they are;
- **the Settings card keeps working for them.** It renders the mailbox, the recorded scopes and
  consent version, the persisted sync status and **Disconnect**, plus one plain line saying
  automatic checks are not running and nothing has been deleted. What it stops offering is
  Connect and Update Outlook permissions, because consent is how a connection begins or is
  renewed and the server would refuse both;
- **propagation is not instantaneous, and this must not be promised as revocation.** The server
  reads `OUTLOOK_PILOT_USER_ID` from the function environment, so the change takes effect for
  the next invocation after the secret update propagates - seconds to a minute, not atomically.
  A run already holding a lease when the id is removed **continues to completion**: it was
  reserved while the account was still eligible, and killing it mid-round is how a round loses
  work. Its lease is up to `LEASE_SECONDS` (420 s) long;
- **notifications keep arriving until the subscription expires.** Removal does not delete the
  Graph subscription, so Microsoft keeps POSTing for up to its 3-day lifetime. Each one still
  records a wake - `wake_requested_at`, `wake_count`, `last_wake_at` change - and then the
  kicked run refuses at the gate. So **wake metadata on a removed account does continue to
  move**, and a reader must not interpret that as importing. The subscription is only removed
  by a disconnect or by expiry: no renewal happens, because renewal needs a run.

**S4 — nothing else.** Specifically **not** in this slice: tick rate, reservation batch size, a
per-account rate limiter, admin UI for the cohort, a queue, richer metadata, School/Education.

---

## 7. The checks that must pass before a cohort connects

Ordered. Each is a check, not a hope.

1. **Unit, on the parsing** — one id behaves exactly as today; a list admits each member; junk,
   empty, `*`, `true`, a bare comma, a too-long list and a non-uuid member all yield **nobody**;
   the frontend predicate and the server predicate agree on every case. Extends
   `tests/outlook-pilot-gate.test.js` and the consent-UI suite.
2. **Composed proof: the real worker, the real reservation, over real PostgREST.**
   `tests/local/outlook-cohort-composed.mjs` runs two eligible accounts and a third excluded
   one with separate mailbox fixtures, each round's RPCs going over HTTP to PostgREST against
   this project's Postgres image. It also measures what an OLD deployment answers a
   four-argument call, and proves the three-argument call still resolves **by omitting** the
   defaulted fourth argument rather than passing an explicit NULL - which is a different
   request and would not have tested the rollout order at all.
3. **Two-account handler proof, through the real worker** — extends the existing
   `tests/outlook-two-sided-rounds.test.js` harness with a second connection: both due, each
   reserved in turn, and assert the **fairness order** (longest-unserved first, a signalled account
   first), that neither account's cursors, candidates, refs or recovery rows are touched by the
   other's round, and that one account's failure backoff does not block the other.
4. **Isolation at the database, with two real users** — on the disposable Postgres harness: user B
   cannot see or write user A's candidates, refs or recovery rows; the producers refuse a
   cross-account episode; the person fingerprints for the same counterparty in two accounts differ.
5. **Subscription per account** — two connections, two subscription rows, renewal only within the
   24 h window, and a notification for one connection recording a wake on **that** connection only.
6. **Consent** — a cohort member who has not consented under the published notice is refused with
   `background_consent_missing` before any read; one who has is admitted. (Already true; assert it
   with two connections.)
7. **The wording check** — the published notice and `/privacy` no longer claim a single account,
   the derived version matches the published text, `verifyDisclosureIntegrity()` passes, and the
   served bundle is verified after publication the way the last two publications were.
8. **Capacity: a synthetic rehearsal BEFORE rollout, and a measurement AFTER it. They are not
   the same thing and must not be reported as one.**

   *Before* — synthetic, offline, no Production: the local harness reserves and releases N
   simulated due connections against the real function on the disposable database and records
   which account each slot went to. That shows the ordering and the slot arithmetic under
   continuations, repeated wakes and a backoff. It establishes **nothing** about real latency,
   because it has no Microsoft, no bodies, no model calls and no network.

   *After* — measured, and only once a cohort is actually active: `wake_age_seconds` is
   reported by the run and is the age of the signal the run answered. **Collecting the first 50
   observations is not free, and the plan's first revision implied it was.** The
   notification-kicked path discards the worker's response, so a kicked run's report is **not
   retained anywhere** - which is exactly how the October 12 failure came to have no live
   report of its cause. So the collection method has to be chosen deliberately, and the honest
   options are:
   (a) read `wake_age_seconds` from the retained **scheduled** reports only, and say so - it
   undersamples precisely the fastest path; (b) persist the field on the run's own release, a
   one-column write this slice does **not** include; or (c) read the Edge Function logs for the
   window, which this session cannot do and the owner can. Until one is chosen and run, the
   5 min p95 / 2 min median figure stays an **unmeasured target**, and no cohort rollout
   report may describe it otherwise.
9. **A real second account end to end** — one invited person connects from Settings, reads the
   notice, consents, completes a two-way exchange with Funnl closed, and accepts the suggestion;
   then the pilot account's records are re-verified unchanged against their pinned digests.

---

## 8. Rollout order, once the checks pass

1. Merge S1 behind the **unchanged** single-id value, so nothing opens on merge.
2. Publish S2's wording, derive the new version, carry it into the browser constant, the server
   variable and all three worker requirements in one commit, redeploy
   `outlook-import-worker`, verify the closure byte-for-byte.
3. Pilot re-consents via the same-account OAuth update; verify identity, cursors and refs against
   the pinned baseline, with only the consent digest moved.
4. Add the first invited uuid to both variables, redeploy only what reads them, and run check 8.
5. Add the remaining members **2–3 at a time**, letting each initial import finish.

**Rollback at every step is the same as it has been:** remove the uuid from both variables (the
account's stored data is untouched and its connection stays valid), or `cron.alter_job(1, active :=
false)` then the worker flag off for a full stop. The migration is never reversed, cursors are
never cleared, and `reset_outlook_round` is not a replay mechanism.
