# Stage D: integration backend retirement — execution plan

This retires the Outlook, Google Calendar and Gmail backend. It is a cleanup, not a redesign.
Integration **tables and their rows stay until Stage F**, including the one expired non-pilot
Microsoft OAuth state. Account deletion keeps working at every step.

Each operational step below needs its own authorization. The PR itself changes only the repository.

## What the PR contains

| Area | Change |
|---|---|
| Edge Function source | Removes the 10 integration functions: the 9 deployed below, plus `gmail-sync-worker`, which was never deployed. Also removes the 41 shared modules that no retained function imports. |
| `supabase/config.toml` | Removes the `[functions.*]` sections of the retired functions. `delete-account` and `ai-paste-email` keep theirs. |
| Migration `20261019000000_retire_integration_backend.sql` | Unschedules the inactive `outlook-worker-tick` cron job and deletes its two Vault entries, `outlook_worker_url` and `outlook_worker_secret`. Drops the 48 retired RPCs by exact signature, without CASCADE. Verifies the result before commit. |
| Frontend | Deletes 5 helpers whose last consumers were retired: `calendarReview`, `calendarIngestion`, `newContactReview`, `outlookConnection` and `oauthStartEndpoint`. The app never reached them, so the bundle is unaffected. |
| Tests | Removes or splits tests of retired code; every check of retained code stays. Adds `tests/local/integration-backend-retirement.mjs`. |

### Retained, with the reason

- **Untouched:** `delete-account` and its imports `shared/googleCleanup.js`, `googleOauthHelpers.js` and `googleTokenCrypto.js`. All four are byte-identical to `main`.
- **`run_google_local_cleanup`:** `delete-account` calls it while the Google tables exist.
- **`ai-paste-email`, `shared/outlookContentSanitizer.js` and `shared/outlookDraftContract.js`:** paste-email uses them.
- **`outlook_sync_state_consume_wake`** (a trigger function) and **`outlook_unpaired_valid`** (a CHECK helper): both belong to tables that are kept until Stage F.
- **`expire_pending_email_context` and `expire_pending_outlook_context`:** dormant retention helpers for rows that remain until Stage F.
- **`src/lib/outlookDisclosure.js` and `sha256.js`:** the consent record; the privacy-policy tests check against it.
- **All three encryption/HMAC keys, `MICROSOFT_CLIENT_ID`, the callback URLs, `OUTLOOK_DISCLOSURE_VERSION` and `OUTLOOK_PILOT_USER_ID`:** unchanged. Key destruction remains a separate decision (A7).
- **Out of this PR's scope, left as is:**
  - `vercel.json` rewrites for the five `/api/*-oauth-*` paths. After undeployment they return Supabase's not-found; removing them is a Vercel configuration change for separate approval.
  - `scripts/outlook-worker-flag.ps1` and its offline test. The flag it toggles is already absent, and the tool becomes moot once the worker is undeployed.
  - Docs that describe the retired workflows.

## Operational sequence

### Step 0 — Preconditions (read-only)

- The live function list shows exactly the 9 integration functions below, plus the retained ones.
- **Exactly one** `cron.job` row is named `outlook-worker-tick`, it is **inactive**, and its command reads both worker Vault names. The migration refuses to run otherwise (see Step 2), so check this first.
- `OUTLOOK_IMPORT_WORKER_ENABLED` is absent. Stage C already removed the integration client secrets and the worker secret.
- There are 0 Microsoft connections and 0 Google connections.
- `supabase migration list --linked` shows `20261019000000` as the only pending version.
- Record a baseline. Report only match or mismatch and row counts, never row content or digest values:
  - **Every public table:** a membership-and-content digest, i.e. the md5 over the sorted md5 of each row's text, plus the row count. Any added, removed or edited row changes it.
  - **The protected records:** the same digest, per table.
  - **Every public function:** signature, md5 of the body, ACL, `SECURITY DEFINER` and config.
  - **`cron.job`:** id, name, schedule, md5 of the command, active.
  - **`vault.secrets`:** the names, plus a per-row digest of every entry the migration must keep. Never values.
  - **Triggers.**
  - **`supabase_migrations.schema_migrations`:** the versions.
  - **The `delete-account` version.**

### Step 1 — Undeploy the 9 functions, one at a time

```
npx supabase functions delete <name> --project-ref jzybxhvgnksrwxfivdwt
```

In this order:
1. `outlook-notifications`
2. `outlook-import-worker`
3. `outlook-oauth-callback`
4. `outlook-oauth-start`
5. `google-calendar-sync`
6. `google-oauth-callback`
7. `google-oauth-start`
8. `google-oauth-disconnect`
9. `gmail-oauth-start`

Receivers go first, then starters. After each one, re-list the functions and confirm:
- the deleted function is gone;
- `delete-account`, the five AI functions and the billing functions are still active, each with its recorded version.
- If any version changed, compare the bundle before continuing. Stage C showed that a platform operation (a secret change) can bump every version while the bundle stays identical, so a version change alone does not prove a code change. A changed `delete-account` bundle is a stop condition.

**Account deletion:** unaffected. `delete-account` is a separate deployment, and its bundle imports none of these functions.

**Recovery:** redeploy a function from `d3f5dae`, the pre-retirement `main`. It would be inert, because its secrets were removed in Stage C.

### Step 2 — Apply the migration (only after Step 1 is complete)

1. Check `supabase migration list --linked`: exactly one pending migration, `20261019000000`.
2. Apply it from the pinned reviewed head with `supabase db push --linked`.
3. Verify with read-only queries, against the Step 0 baseline:
   - **History:** `supabase_migrations.schema_migrations` has exactly one new version, `20261019000000`.
   - **Cron:** `outlook-worker-tick` is absent from `cron.job`, and every other job is unchanged.
   - **Vault:** the two worker names are absent, and every other entry's per-row digest is unchanged.
   - **Functions:** 0 public functions carry any of the 48 names, and every other function matches the baseline exactly, including its ACL.
   - **Data:** every public table's membership-and-content digest, every protected-record digest and every trigger is unchanged.

**Atomicity, established from source rather than assumed:**
- **Single batch:** with CLI 2.109.0, `db push` runs `ApplyMigrations`, and that calls `ExecBatch` once per file (`apps/cli-go/pkg/migration/file.go`). `ExecBatch` puts every statement and the history `INSERT` into one pgconn batch (pgconn v1.14.3). The batch ends with a single `Sync`, which PostgreSQL commits, or rolls back on error, as one implicit transaction (protocol docs, extended query and pipelining).
- **On failure:** nothing from the file is kept, and no version is recorded. The file itself contains no `BEGIN`/`COMMIT`.
- **Failure modes:**
  - The cron guard refuses an active job, more than one job with that name, or an unexpected command.
  - A `DROP FUNCTION` without CASCADE refuses an unexpected dependent.
  - The final verification block refuses an incomplete result.
- **What a failure means for you:** the migration stays pending and Production is unchanged. Investigate before any retry; there is no automatic retry.

**Order:** Step 1 comes first, so nothing deployed can call a dropped RPC. Every caller is already removed from the frontend by #109/#110.

**Account deletion:**
- `run_google_local_cleanup`, the Google tables and the `auth.users` cascades are untouched.
- The local harness proves deletion before and after the migration and cascades every integration row.
- No Production account is deleted to test this.

**Recovery:**
- A dropped function can only be restored by a new forward migration that re-issues it from its latest defining migration.
- The cron job could be re-created, inactive, the same way.
- The two Vault values are not recoverable. They pointed at the retired worker, whose secret was already removed.

### Step 3 — Merge the PR

Merging deploys the frontend through Vercel. It changes no behaviour: the deleted frontend helpers were unreachable. No backend deploys on merge.

**Verify:** the Production deployment succeeded, and a bundle check finds no retired RPC names while account-deletion wiring is present.

## Local evidence

`node tests/local/integration-backend-retirement.mjs` runs Postgres, GoTrue and PostgREST with every earlier migration and the CLI's history table, using synthetic users. It applies the migration the way `db push` does: the file plus its history row, run with `psql --single-transaction -v ON_ERROR_STOP=1`. It drives the real `googleCleanup.js` through supabase-js in `delete-account`'s order. It covers:

- **Deletion before the migration**, leaving none of that user's rows.
- **Blocked last drop.** A real dependency (a synthetic view calling the last dropped function) blocks the final `DROP FUNCTION`. By then the job has been unscheduled, both Vault rows deleted and 47 functions dropped. The attempt fails on that dependency, and every digest above is identical to before: tables, auth users, Vault, cron, functions and grants, triggers and history. Removing only the blocker restores the exact start state.
- **Unexpected active job.** With the job made active (on a once-a-year schedule, so it cannot fire), the attempt fails on the cron guard and changes nothing. Restoring the job restores the exact start state.
- **The successful run:**
  - exactly one history row;
  - the job gone, and only the two Vault rows gone, with the kept entry's digest unchanged;
  - 0 of the 48 functions left;
  - every table's membership-and-content digest unchanged;
  - only Vault, cron, functions and history changed.
- **After the run:**
  - a dropped RPC returns 404, and both expiry helpers still run;
  - the protected user's rows are unchanged by the migration and then deleted cleanly;
  - the bystander's digests are unchanged throughout.
- **Re-running the body:** succeeds and changes nothing.

## Still pending, outside this plan

- Google provider retirement, blocked until 2-step verification is on.
- Key destruction (A7).
- The `vercel.json` rewrites.
- Docs.
- Stage E: privacy wording.
- Stage F: dropping the integration tables, including the expired non-pilot Microsoft OAuth state.
