# Simplification cleanup: plan and Production packets

Owner direction (2026-10-14): a functionality and codebase cleanup, not a UI overhaul. Keep the
current visual style and layouts. Retire Outlook + Suggestions, dormant Calendar sync and the
unused Gmail path, safely and in order. Preserve contacts, School, interactions and history,
follow-ups, search, CSV import, paste-email, Ask AI, authentication, privacy protections and
Pro/subscription/billing access.

Each **Production action** below needed its own explicit approval. The plan as written (sections 1-4)
is preserved; what was executed is recorded in this status table.

## Status (2026-10-19)

| Stage | Status |
|---|---|
| P1 (#107) | Merged and deployed. |
| Packet A: stop Outlook processing | **Executed 2026-10-16.** Evidence: `C:\Users\nkindra\FunnlOps\packet-a\20261016T014818Z`. |
| B. Hide Suggestions (#108) | Merged and deployed. |
| C. Credentials | **Executed 2026-10-19.** Secrets unset; Outlook disconnected; Google local cleanup; Microsoft consent and Entra secret removed. Evidence: `C:\Users\nkindra\FunnlOps\stage-c\20261019T000148Z`. **Google provider actions remain blocked** until the Google account has 2-step verification. |
| D. Undeploy + remove source | **Done 2026-10-19.** Frontend in #109 and #110; backend in #111, after the 9 functions were undeployed and migration `20261019000000` was applied. See `docs/stage-d-backend-retirement.md`. The obsolete `vercel.json` OAuth rewrites and the operational docs follow in a separate PR. |
| E. Policy | Pending; needs owner-approved wording. |
| F. Schema | Pending. It will drop the integration tables, including the one expired non-pilot Microsoft OAuth state. |

Also pending: destroying the three integration keys (a separate decision).

The step-by-step packets below are historical. Their scripts (for example `scripts/outlook-worker-flag.ps1`) were removed after use, and they must not be re-run.

## 1. What P1 (this PR) does

| Change | Why | Behaviour |
|---|---|---|
| One **Log interaction** field component (`InteractionFormFields`) used by both the desktop inline form and the phone sheet; exactly one container mounted per breakpoint (`useMediaQuery(MD_UP)`) | Two copies of the same fields were both mounted, one hidden by CSS. On desktop the hidden sheet's focus trap and Escape handler were live, and it held the shared follow-up-date ref. | **Fixed on desktop:** Tab no longer gets stuck in Notes; "Create a follow-up" focuses the visible follow-up date (it went to an invisible input); every field now has a programmatic label. **Unchanged:** fields, outreach rules, saving, Log Result, Escape-to-close, the phone sheet. |
| Remove `CONTACT_AI_ENABLED` and `shouldShowContactAI` | A permanently-off flag for a never-built slot | None |
| Remove the unused `AI_WEEKLY_INSIGHT_ENABLED` constant (its safety note is kept as prose) | Unreferenced | None |
| Remove lint-proven unused imports and variables: `ImportContactsModal` (`dbDupMap` / `doneStats` written but never read, the `importableCount` memo, `useMemo`), `CommandPalette`, `SignInPage`, `ContactsPage`, `ContactDetailPage` | Dead | None |

**Proof:**
- `tests/local/log-interaction-browser.mjs` runs in a real browser with real Postgres, GoTrue and PostgREST: 24 checks, all passing on this branch.
  - The first 15 run on unchanged main fail 6 times, reproducing the defect.
  - The last 9 cover an unsaved draft (note, date, follow-up, outreach on and status) carried across desktop, phone and desktop again: one form rendered at each width, the phone scroll lock set then cleared, and one interaction saved with the draft's values.
- `tests/log-interaction-form.test.js` pins the contracts. It passes on this branch and fails against main's source.
- `npm test` passes in full.

**Deployment.** Merging P1 into `main` **may deploy the frontend to Production**:
- `vercel.json` enables Git deployments for `main`;
- the current Production deployment was built by Vercel from a main merge (`3115d18`);
- no deployment hold was found (read-only, 2026-10-14).

No Edge Function, migration or secret is deployed by a merge.

## 2. Inventory: repository vs Production (read-only, 2026-10-14)

| Area | Deployed in Production | In repository | Running? |
|---|---|---|---|
| Outlook | `outlook-import-worker` v67, `outlook-notifications` v19, `outlook-oauth-start` v50, `outlook-oauth-callback` v52; cron `outlook-worker-tick` active every minute | yes | **Yes**: 1 connection, 1 active Graph subscription |
| Suggestions (UI) | Live bundle has `VITE_OUTLOOK_REVIEW_ENABLED=true` and `VITE_CALENDAR_INGESTION_ENABLED=true` | yes | Shown; only Outlook produces items; 0 pending now |
| Google Calendar | `google-oauth-start` v51, `google-oauth-callback` v51, `google-oauth-disconnect` v50, `google-calendar-sync` v49 | yes | No: connection UI off (`VITE_CALENDAR_CONNECTION_ENABLED` unset), no scheduler, nothing invokes sync. 1 connection and 1 token still stored |
| Gmail | `gmail-oauth-start` v49 (refuses unless `GMAIL_INTEGRATION_ENABLED='true'`) | yes, plus `gmail-sync-worker`, which is **not deployed** | No: 0 rows |
| Shared code paste-email needs | `ai-paste-email` imports `shared/outlookContentSanitizer.js`, `shared/outlookDraftContract.js`, `shared/boundedJson.js` | yes | **Keep** |
| Shared code delete-account needs | `delete-account` imports `googleCleanup.js`, `googleOauthHelpers.js`, `googleTokenCrypto.js` | yes | **Keep** until no Google data exists |

Removing the source of a function that is still deployed would make main differ from Production.
Each removal below is therefore paired with a Production undeploy, approved separately.

## 3. Production packet A: stop Outlook processing (prepared, NOT executed)

**Goal:** no further Outlook processing.

- **Stops:** the per-minute tick, worker runs (scheduled or notification-kicked) and Graph
  subscription renewal.
- **Kept by this packet** (it deletes nothing; users can still Disconnect or delete their account,
  see S5):
  - the connection, tokens, subscription row, committed cursors and pending suggestions;
  - accepted contacts and interactions;
  - the Settings card (status and Disconnect) and the Suggestions UI;
  - `/privacy` and the consent version.
- **Never:** force, steal or clear a lease or round, or run the worker by hand.

**How it is enforced.** The worker refuses (503 `not_enabled`) before reading any row unless
`OUTLOOK_IMPORT_WORKER_ENABLED` is present, so the flag is the stop. Disabling the cron job first
stops new scheduled ticks. A Microsoft notification can still kick the worker until the flag is
removed. After that, a notification may still arrive and record a wake-up, but it starts nothing.

**Reporting.** Every query below returns counts, booleans, timestamps or md5 digests only. No
identifiers, addresses or content are printed. The per-row digest lists are written to a local
file for comparison, never to chat.

### Steps

**S0. Preconditions (read-only).**

```sql
SELECT count(*) AS matching, bool_and(active) AS all_active, min(schedule) AS schedule
FROM cron.job WHERE jobname = 'outlook-worker-tick';
```

**Gate:** `matching = 1` exactly. 0 or more than 1 means STOP and report; do not guess which job.
`scripts/outlook-worker-flag.ps1 status` must report PRESENT, or the deviation is recorded.

**S1. Disable the tick.**

```sql
SELECT cron.alter_job(j.jobid, active := false)
FROM cron.job j WHERE j.jobname = 'outlook-worker-tick'
  AND (SELECT count(*) FROM cron.job WHERE jobname = 'outlook-worker-tick') = 1;
```

Then re-run the S0 query. **Gate:** `matching = 1`, `all_active = false`.

**S2. Disable the worker flag.** Run `.\scripts\outlook-worker-flag.ps1 disable`, which itself
requires ABSENT. Then **independently** run `.\scripts\outlook-worker-flag.ps1 status` in a
separate invocation.

**Gate:** ABSENT (names only). UNVERIFIED or UNKNOWN is not ABSENT: STOP. The rollback is
available.

**S3. Quiescence: let existing work release naturally.** Poll every few minutes, no fixed wait:

```sql
SELECT count(*) FILTER (WHERE sync_status = 'running')                           AS running_folders,
       count(*) FILTER (WHERE sync_lease_until > now())                          AS live_leases,
       count(*) FILTER (WHERE sync_run_id IS NOT NULL)                           AS held_run_tokens,
       count(*) FILTER (WHERE round_id IS NOT NULL)                              AS open_rounds,
       count(*) FILTER (WHERE round_id IS NOT NULL AND round_expires_at <= now()) AS expired_open_rounds
FROM public.outlook_sync_state;
```

**Gate:** `running_folders = 0`, `live_leases = 0`, `held_run_tokens = 0` and `open_rounds = 0`.

- **Already met:** a run that was in flight at S1/S2 releases its lease on its own when it
  finishes. If it holds, continue to S4.
- **Not met:** if a folder stays `running`, a run token stays held after its lease has expired, or
  a round stays open, nothing can finish it while the flag is absent. **Do not force it.**
  - Take the rollback (re-enable the flag and the tick).
  - Let the scheduled worker complete or expire the round itself (an expired round is discarded
    and restarts from the committed cursor).
  - Re-run the packet from S0 at a quiet moment.
  - Record which counter blocked it.

**S4. Stable baseline (only after S3 passes).** Captured twice, a few minutes apart.

**What must be equal, and what may change.** Equality between the two captures, and later in S5,
applies only to **processing and renewal evidence**: the processing digest and the subscription
identity/renewal digest below. Notification and wake observations are recorded alongside,
preserved, never cleared, and **may change**, because Microsoft can keep notifying after the
stop. Protected records are compared separately (below).

Who writes the subscription row (from `20261009000000`, the only migration that writes
`outlook_subscriptions`):
- **Only the worker** (`record_outlook_subscription_state`, fenced on its run) sets or renews
  `subscription_id`, `client_state_hash`, `expires_at`, `renewed_at` and `last_error_code`, and
  can also set `status`.
- **The notification endpoint** (`record_outlook_change_notification`) never touches those
  identity/renewal columns. On a lifecycle event it sets `status` to `removed`
  (`subscriptionRemoved`) or `reauthorize` (`reauthorizationRequired`), stamps
  `last_lifecycle_event` / `last_lifecycle_at`, and increments `notifications_received` /
  `last_notification_at`. A `missed` event stamps the lifecycle fields without changing `status`.
  Every accepted notification also records a wake-up on `microsoft_connections`.

Baseline values:

- **Processing digest per folder:**
  `md5(string_agg(concat_ws('|', folder, sync_status, last_attempt_at, last_success_at,
  run_started_at, last_run_complete, retry_count, md5(coalesce(delta_link_ciphertext,'')),
  round_id IS NULL), ',' ORDER BY folder))` over `outlook_sync_state`. **Must be equal.**
- **Subscription identity/renewal digest (worker-owned):**
  `md5(concat_ws('|', md5(coalesce(subscription_id,'')), coalesce(client_state_hash,''),
  expires_at, renewed_at, last_error_code))` over `outlook_subscriptions` (`client_state_hash` is
  already a SHA-256 digest). **Must be equal.**
  Also record `expires_at` as a timestamp. `status` is deliberately NOT in this digest.
- **Subscription status**, recorded as a value (`active`, `reauthorize`, `removed` or `failed`),
  together with `last_lifecycle_event` and `last_lifecycle_at`.
- **Notification and wake observations**, recorded SEPARATELY, preserved and never cleared; they
  may change:
  - `notifications_received`, `last_notification_at` from `outlook_subscriptions`;
  - `wake_requested_at`, `wake_source`, `wake_count`, `last_wake_at` from `microsoft_connections`.
- **Protected existing records**, as per-row digests keyed by `md5(id::text)` and written to a
  local file:
  - `interactions` where `source IN ('outlook','google_calendar')`, row digest over `contact_id`,
    `type`, `interaction_date`, `md5(notes)`, `follow_up_date`, `outreach_status`,
    `follow_up_completed_at`;
  - `contacts` referenced by `new_contact_candidates.accepted_contact_id`;
  - `interaction_candidates` and `new_contact_candidates` in status `accepted`, with `status`,
    `accepted_contact_id` / `accepted_interaction_id` / `interaction_id` presence.
- **Context only, not a gate:** global contact and interaction counts and the pending-suggestion
  count.

**S5. Verify no subsequent processing.** Run at least once, at any later time; no mandatory wait.

- **The tick did not run:** `SELECT count(*) FROM cron.job_run_details WHERE jobid = (SELECT jobid
  FROM cron.job WHERE jobname = 'outlook-worker-tick') AND start_time > <S1 time>;` is `0`.
- **The processing digest equals the baseline.** No new attempt, run, cursor movement or round.
  Any difference **blocks**.
- **The subscription identity/renewal digest equals the baseline.** No renewal or re-creation
  (`subscription_id`, `expires_at`, `renewed_at`, `last_error_code` unmoved). Any difference
  **blocks**.
- **A difference is not proof of its cause.** Worker activity is one possible cause. Disconnect and
  account deletion are others (below). A blocking difference is investigated, never assumed.
- **Subscription status:** unchanged, or changed only by an explained lifecycle transition:
  - **Explained** means all of the following:
    - the new status is `removed` with `last_lifecycle_event = 'subscriptionRemoved'`, or
      `reauthorize` with `last_lifecycle_event = 'reauthorizationRequired'`;
    - `last_lifecycle_at` is later than the baseline capture;
    - `notifications_received` increased;
    - the identity/renewal digest is still equal.
  - **Blocks:** any other transition, for example to `active` or `failed`, a status change with no
    matching lifecycle record, or a lifecycle record later overwritten by `missed` so the cause can
    no longer be shown. Investigate before continuing; do not "fix" the row.
  - An explained `removed` or `reauthorize` is a Microsoft-side lifecycle outcome, not
    processing. It needs no action, and the subscription is left for S6.
- **Notification and wake observations may have changed.** Increases show that Microsoft still
  notifies, not that Funnl processed anything: the processing digest is the evidence for that.
  Record the new values; do not clear them.
- **Protected records:** every baseline row still exists with the same digest. **Any difference
  blocks** completing Packet A until it is investigated.
  - Possible causes include a user deleting a row or its contact in the app (contacts cascade), a
    user action such as completing, snoozing or editing a follow-up, note or outreach status, and
    account deletion.
  - Record a cause only where existing evidence supports it; otherwise mark it **unresolved**.
    Packet A is not complete while any cause is unresolved.
  - An unchanged processing digest is evidence against a worker run. It does not by itself explain
    a protected-record difference.

  New contacts and interactions created by normal use are expected and are not compared.
- **Rows removed by Disconnect or account deletion.** Both stay available to users during
  Packet A. Neither is an exception to the checks above.
  - **Disconnect** runs `disconnect_my_outlook`, which calls `run_microsoft_local_cleanup`
    (`20260921000000`).
    - Invalidated: pending Outlook `interaction_candidates`, and pending or deferred
      `new_contact_candidates` (their draft fields are cleared).
    - Deleted: `microsoft_oauth_states` and the user's `microsoft_connections` row.
    - Removed with the connection (`ON DELETE CASCADE`): `microsoft_tokens`,
      `outlook_sync_state` (both folders), `outlook_subscriptions`, `outlook_candidate_refs`,
      `outlook_conversation_progress`, `outlook_round_messages` and `outlook_thread_recovery`.
    - Not touched: contacts, interactions and accepted suggestions. Its updates filter on
      pending/deferred status, and none of those tables references the connection.
  - **Account deletion** (`delete-account`) deletes all of the user's contacts (their
    interactions cascade), then the auth user, which removes the user's remaining rows. **Accepted
    contacts and interactions are not preserved**, and Packet A makes no preservation promise for
    them.
  - Either one removes the connection and its subscription and folder rows, so both digests above
    differ. **That still blocks.** Missing rows alone do not show who removed them, or that no
    worker ran beforehand.
  - Record Disconnect or account deletion as the cause only where existing evidence supports it;
    otherwise the cause is **unresolved**. No logging or schema is added for this.
- **Pending suggestions:** none can be created (the producers run only in the worker). An existing
  pending one may be accepted or dismissed by the user. That is user activity and is recorded.

**S6. Later observation (NOT a prerequisite for stage B).** Without renewal, Microsoft lets the
subscription lapse at `expires_at` (at most 3 days). Record its final status when it does.
Stage B (hiding Suggestions) may proceed as soon as S5 passes.

### Rollback

Available until stage C deletes credentials.

1. Run `.\scripts\outlook-worker-flag.ps1 enable`, which verifies PRESENT.
2. Re-activate the tick:

   ```sql
   SELECT cron.alter_job(j.jobid, active := true)
   FROM cron.job j WHERE j.jobname = 'outlook-worker-tick';
   ```

3. Re-run the S0 query.

The next run renews or recreates the subscription. Committed cursors were never moved, so nothing
is skipped.

Rollback only re-enables processing. It does **not** restore a connection, tokens, suggestions or
records removed by Disconnect or account deletion. Reconnecting or restoring any of them needs
separate authorization.

**Not touched by this packet:** credentials, connection records, tables, functions, Vault secrets,
the consent version, pending suggestions.

## 4. Deferred stages (each a separate approval, in this order)

| Stage | Content | Precondition |
|---|---|---|
| B. Hide | Remove the Suggestions rail item, Review tab, `/suggestions` route, dashboard entry and pending badges. Settings keeps the Outlook card (status and Disconnect) while a connection exists. | Packet A S5 passed (subscription expiry, S6, is not required) |
| C. Credentials (irreversible) | The pilot account disconnects Outlook in Settings; Google is disconnected through `google-oauth-disconnect` (revokes at Google); the owner removes Funnl at account.microsoft.com. | Owner approval; before and after proof that contacts and interactions are unchanged |
| D. Undeploy + remove source | Undeploy the Outlook, Google and Gmail functions; delete their source, Outlook/Google/Gmail-only shared modules (computed by import closure; `outlookContentSanitizer`, `outlookDraftContract` and `boundedJson` stay for paste-email), tests and docs; remove `[functions.*]` config, Vault secrets and cron in a **forward** migration. Remove the Settings cards and the Calendar connection UI. | Stage C done |
| E. Policy | Replace the Outlook, Gmail and Calendar sections of `/privacy` with a short "discontinued" paragraph and a new date. | Owner-approved wording |
| F. Schema | A new forward migration drops the integration tables. Applied migrations are never edited. `interactions.source` keeps `outlook` / `google_calendar` for history. | Stage D done |

**Gmail note.** `gmail-sync-worker` is in the repository but not deployed. Its exclusive modules
(by import closure) are:
- `shared/gmailWorker.js`
- `shared/gmailHistory.js`
- `shared/emailConversationClassifier.js`

Six test files also cover the deployed `gmail-oauth-start`, Google functions and published Gmail
wording, so Gmail is removed as one unit in stage D rather than in part now.

## 5. Billing: main vs Production (read-only finding, 2026-10-14)

The three deployed billing functions were downloaded and compared byte for byte (CRLF
normalised) with Draft PR #24's head `697dae1` and with main:

- **All 11 deployed files are identical to #24's head.** These are `create-checkout-session` v61
  (4 files), `stripe-webhook` v62 (5 files), `create-billing-portal-session` v57 (1 file) and
  `shared/boundedFetch.js`.
- **Only `shared/subscriptionStatusPolicy.js` is on main**, and it is identical to the deployed copy.
- **Live `verify_jwt`** (`stripe-webhook` false, the other two true) matches #24's
  `config.toml`; `create-checkout-session` takes the default.

**Proposed reconciliation (separate Draft PR, separate approval).**
- **Scope:** bring onto main exactly those 10 server files, their `config.toml` entries and their
  existing tests from `697dae1`.
- **Excluded:** no frontend billing change, no `VITE_BILLING_ENABLED` change, no redeploy (live
  already equals the source), and nothing else from #24.
- **Proof:** a byte-equality check between main's closures and the downloaded live functions,
  before and after.

#24 itself stays untouched.
