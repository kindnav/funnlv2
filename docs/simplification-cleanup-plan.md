# Simplification cleanup: plan and Production packets

Owner direction (2026-10-14): a functionality and codebase cleanup, not a UI overhaul. Keep the
current visual style and layouts. Retire Outlook + Suggestions, dormant Calendar sync and the
unused Gmail path, safely and in order. Preserve contacts, School, interactions and history,
follow-ups, search, CSV import, paste-email, Ask AI, authentication, privacy protections and
Pro/subscription/billing access.

Nothing in this document has been executed in Production. Each **Production action** below needs
its own explicit approval.

## 1. What P1 (this PR) does

| Change | Why | Behaviour |
|---|---|---|
| One **Log interaction** field component (`InteractionFormFields`) used by both the desktop inline form and the phone sheet; exactly one container mounted per breakpoint (`useMediaQuery(MD_UP)`) | Two copies of the same fields were both mounted, one hidden by CSS. On desktop the hidden sheet's focus trap and Escape handler were live, and it held the shared follow-up-date ref. | **Fixed on desktop:** Tab no longer gets stuck in Notes; "Create a follow-up" focuses the visible follow-up date (it went to an invisible input); every field now has a programmatic label. **Unchanged:** fields, outreach rules, saving, Log Result, Escape-to-close, the phone sheet. |
| Remove `CONTACT_AI_ENABLED` and `shouldShowContactAI` | A permanently-off flag for a never-built slot | None |
| Remove the unused `AI_WEEKLY_INSIGHT_ENABLED` constant (its safety note is kept as prose) | Unreferenced | None |
| Remove lint-proven unused imports and variables: `ImportContactsModal` (`dbDupMap` / `doneStats` written but never read, the `importableCount` memo, `useMemo`), `CommandPalette`, `SignInPage`, `ContactsPage`, `ContactDetailPage` | Dead | None |

**Proof:**
- `tests/local/log-interaction-browser.mjs` runs in a real browser with real Postgres, GoTrue and PostgREST: 15 checks.
  - On unchanged main, 6 fail. This reproduces the defect.
  - On this branch, all 15 pass.
- `tests/log-interaction-form.test.js` pins the contracts. It passes on this branch and fails against main's source.
- `npm test` passes in full.

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

**Stops:** the every-minute tick, worker runs, Graph subscription renewal, and reading mail.

**Keeps:**
- the connection, tokens, subscription row, cursors and pending suggestions (0 today);
- accepted contacts and interactions;
- the Settings card (status + Disconnect) and Suggestions UI;
- `/privacy`;
- the consent version.

| Step | Command (owner session) | Verify (read-only, counts/names only) |
|---|---|---|
| 0. Baseline | none | `SELECT jobname, schedule, active FROM cron.job;` · `SELECT count(*) FROM cron.job_run_details WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'outlook-worker-tick') AND start_time > now() - interval '10 minutes';` · `SELECT max(last_attempt_at), max(last_success_at) FROM public.outlook_sync_state;` · contact and interaction counts |
| 1. Deactivate the tick | `SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'outlook-worker-tick'), active := false);` | `active = false` |
| 2. Remove the worker flag | `.\scripts\outlook-worker-flag.ps1 disable` (it verifies ABSENT itself) | `.\scripts\outlook-worker-flag.ps1 status` → ABSENT (names only) |
| 3. Observe ≥ 60 min | none | 0 new `cron.job_run_details` rows for the job; `outlook_sync_state.last_attempt_at` not advancing. A Microsoft notification may still arrive and record a wake-up, but no read runs without the flag (the worker answers 503 `not_enabled`). |
| 4. Observe ≤ 3 days | none | `outlook_subscriptions.expires_at` passes without renewal; contact and interaction counts unchanged |

**Rollback** (before any deletion):
1. `.\scripts\outlook-worker-flag.ps1 enable`
2. `SELECT cron.alter_job(<jobid>, active := true);`
3. The next run recreates the subscription.

**Not touched:** credentials, connection records, tables, functions, Vault secrets, the consent version.

## 4. Deferred stages (each a separate approval, in this order)

| Stage | Content | Precondition |
|---|---|---|
| B. Hide | Remove the Suggestions rail item, Review tab, `/suggestions` route, dashboard entry and pending badges. Settings keeps the Outlook card (status and Disconnect) while a connection exists. | Packet A verified (stage 3 at least) |
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
