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
- `outlook-worker-tick` exists and is **inactive**.
- `OUTLOOK_IMPORT_WORKER_ENABLED` is absent. Stage C already removed the integration client secrets and the worker secret.
- There are 0 Microsoft connections and 0 Google connections.
- Record a baseline:
  - per-table row counts;
  - the md5 of every retained function body and its ACL;
  - the Vault entry **names** only, never values;
  - the `delete-account` version.

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
3. Verify with read-only queries:
   - `outlook-worker-tick` is absent from `cron.job`;
   - the two worker Vault names are absent, and every other name is unchanged;
   - 0 public functions carry any of the 48 names;
   - every retained function has an identical md5 and ACL to the baseline;
   - row counts and triggers are unchanged.

The migration also verifies itself and rolls back entirely if any check fails.

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

`node tests/local/integration-backend-retirement.mjs` runs Postgres, GoTrue and PostgREST with every migration applied, using synthetic users. It drives the real `googleCleanup.js` through supabase-js in `delete-account`'s order. It covers:

- deletion before the migration;
- the migration's exact effects;
- unchanged rows, triggers and retained functions;
- a dropped RPC returning 404;
- both expiry helpers still running;
- deletion after the migration;
- an untouched bystander;
- an idempotent re-apply.

## Still pending, outside this plan

- Google provider retirement, blocked until 2-step verification is on.
- Key destruction (A7).
- The `vercel.json` rewrites.
- Docs.
- Stage E: privacy wording.
- Stage F: dropping the integration tables, including the expired non-pilot Microsoft OAuth state.
