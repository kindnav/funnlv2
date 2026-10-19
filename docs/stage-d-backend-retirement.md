# Stage D: integration backend retirement — execution plan

This retires the Outlook, Google Calendar and Gmail backend. It is a cleanup, not a redesign.
Integration **tables and their rows stay until Stage F**, including the one expired non-pilot
Microsoft OAuth state. Account deletion keeps working at every step.

Each operational step below needs its own authorization. The PR itself changes only the repository.

## Status (2026-10-19): executed

Each step was separately authorized. Evidence (sanitized: names, versions, digests and counts only)
is in `C:\Users\nkindra\FunnlOps\stage-d\20261019T031210Z` (`SUMMARY.txt`).

| Step | Result |
|---|---|
| 1. Undeploy the 9 functions | **Done 03:14–03:15Z.** One at a time, each target absent afterwards, every other function identical in version and bundle. 9 functions remain: 5 AI, `delete-account`, 3 billing. Re-confirmed at 15:41Z and 15:47Z. |
| 2. Migration `20261019000000` | **Applied 15:46:42Z** via `db push` (CLI 2.109.0) from `a8fa5e6`. History +1. Job gone. Vault: only the two worker entries removed, leaving it empty. 48 RPCs gone; each of the 13 remaining functions identical. 26 tables and 12 triggers identical. 15 protected records = P0. |
| 3. Merge #111 | **Merged `a801a3e`.** Production deployment succeeded, and the live JS is byte-identical to the previous bundle. |

**Still open:**
- the five `vercel.json` OAuth rewrites: removed in the follow-up routes/docs PR, with `/api` excluded from the SPA fallback (see "Retired API addresses" below). Hosted verification comes after merge;
- Google provider retirement (blocked until the Google account has 2-step verification);
- destruction of the three keys;
- Stage E (privacy wording);
- Stage F (tables).

## Retired API addresses (`/api/*-oauth-*`)

**Before this change (Production, checked read-only on 2026-10-19):**
- `vercel.json` forwarded the five addresses to Supabase. With the functions undeployed, all five returned **HTTP 404 with JSON `{"code":"NOT_FOUND","message":"Requested function was not found"}`**.
- Any other unknown `/api/...` path (and `/api` itself) fell through to the catch-all `/(.*)`, so it returned the **app's HTML shell with status 200**.

**This change:**
- The five rewrites are removed.
- The SPA fallback becomes `{"source": "/((?!api(?:/|$)).*)", "destination": "/index.html"}`. Its destination and the `git.deploymentEnabled` setting are unchanged.
- No middleware, function, legacy `routes` or custom 410 response is added.

**Why this pattern:**
- The lookahead `(?!api(?:/|$))` excludes `/api` and `/api/...` but not paths like `/apiary`.
- The unnamed group keeps the compiled destination exactly `/index.html`. Vercel's named-parameter form (`/:path(...)`) compiles to `/index.html?path=$1`: a named parameter that the destination does not use is appended as a query.

**Validated with Vercel's own routing library.** This used `@vercel/routing-utils` 6.6.0, installed temporarily outside the repository; the evidence is in `C:\Users\nkindra\FunnlOps\stage-d\routes-validation-*`.
- `rewritesSchema`: valid.
- `getTransformedRoutes`: compiles to `[{handle: filesystem}, {src: "^(?:/((?!api(?:/|$)).*))$", dest: "/index.html", check: true}]`.

Resolving paths through that compiled table, with a static-file check against a build of this branch, gives:

| Path | Result |
|---|---|
| The five retired addresses, with and without query strings | No match, so **expected platform 404** |
| `/api`, `/api/`, `/api/unknown-route`, `/api?x=1` | No match, so **expected platform 404** |
| `/`, `/signin`, `/settings`, `/privacy`, `/contacts`, a contact-detail path, `/suggestions`, `/apiary` | Rewritten to `/index.html` |
| Built assets (`/assets/*.js`, `/assets/*.css`, `/favicon.svg`) | Served by the filesystem phase, before any rewrite |

**Static repository checks:** `tests/vercel-routes.test.js` pins the same paths and the retained calls. Account deletion (`supabase.functions.invoke('delete-account')`) and paste-email (`invoke('ai-paste-email')`) call Supabase directly, and no `src` file calls an `/api/` address. That test is a small model of these rules, **not** Vercel's router.

**Hosted behaviour is not yet verified.** The library above is Vercel's parser and route compiler, not its edge network. What a deployed site actually returns for `/api/...` (the body and headers of the platform 404, and how query strings are handled) can only be checked after a deployment. This branch's automatic preview requires Vercel login, so the check is planned read-only on Production after merge:
- each retired address, `/api` and `/api/...` should return 404;
- app paths and `/apiary` should return 200 HTML;
- assets should return 200.

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
- **Out of #111's scope, handled in the follow-up routes/docs PR:**
  - `vercel.json` rewrites for the five `/api/*-oauth-*` paths: see "Retired API addresses" above.
  - `scripts/outlook-worker-flag.ps1`, its offline test and the synthetic CLI behind it: removed. No retained workflow uses them.
  - Docs that describe the retired workflows: kept as historical records, each with a retirement banner.

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
