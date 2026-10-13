# Outlook beyond one pilot account — the smallest slice to a small cohort

**Nothing here is applied, deployed, published or un-gated.** This is the inspection and the
plan to review before any of that. Inspected at `main` `c2e524f` with the pilot live on worker
**v57**, notice version `ol-disc-e1107c0221c89ded0b6a2134df848eea`.

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

**Fairness is implemented, not accidental.** The reservation orders by
`(wake_requested_at IS NULL) ASC, min(last_success_at) ASC NULLS FIRST, c.id ASC`
(migration `20261009000000`, around line 390): a signalled account jumps the queue, then the
**longest-unserved** account goes next, with the id only as a tie-break. No account can starve,
and the pilot filter is a single `AND (p_pilot_user_id IS NULL OR c.user_id = p_pilot_user_id)` —
passing `NULL` makes it serve whoever is due, which is exactly the multi-user behaviour.

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
account's initial import finish before inviting the next. That is a process decision, not code,
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

**S3 — nothing else.** Specifically **not** in this slice: tick rate, reservation batch size, a
per-account rate limiter, admin UI for the cohort, richer metadata, School/Education.

---

## 7. The checks that must pass before a cohort connects

Ordered. Each is a check, not a hope.

1. **Unit, on the parsing** — one id behaves exactly as today; a list admits each member; junk,
   empty, `*`, `true`, a bare comma, a too-long list and a non-uuid member all yield **nobody**;
   the frontend predicate and the server predicate agree on every case. Extends
   `tests/outlook-pilot-gate.test.js` and the consent-UI suite.
2. **Two-account handler proof, through the real worker** — extends the existing
   `tests/outlook-two-sided-rounds.test.js` harness with a second connection: both due, each
   reserved in turn, and assert the **fairness order** (longest-unserved first, a signalled account
   first), that neither account's cursors, candidates, refs or recovery rows are touched by the
   other's round, and that one account's failure backoff does not block the other.
3. **Isolation at the database, with two real users** — on the disposable Postgres harness: user B
   cannot see or write user A's candidates, refs or recovery rows; the producers refuse a
   cross-account episode; the person fingerprints for the same counterparty in two accounts differ.
4. **Subscription per account** — two connections, two subscription rows, renewal only within the
   24 h window, and a notification for one connection recording a wake on **that** connection only.
5. **Consent** — a cohort member who has not consented under the published notice is refused with
   `background_consent_missing` before any read; one who has is admitted. (Already true; assert it
   with two connections.)
6. **The wording check** — the published notice and `/privacy` no longer claim a single account,
   the derived version matches the published text, `verifyDisclosureIntegrity()` passes, and the
   served bundle is verified after publication the way the last two publications were.
7. **Capacity rehearsal, measured not assumed** — with the cohort invited but before inviting the
   last member, record `wake_age_seconds` across the first 50 signalled runs and compare against
   the existing 5 min p95 / 2 min median **target** (still unmeasured; it does not become
   established by this exercise).
8. **A real second account end to end** — one invited person connects from Settings, reads the
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
