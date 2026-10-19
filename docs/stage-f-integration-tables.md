# Stage F: drop the retired integration tables — execution plan

## Status (2026-10-19): prepared, NOT executed

This is a Draft PR and a plan. Nothing here has been deployed or applied:
- `delete-account` in Production is still **v69**, which runs the old Google cleanup.
- Migration `20261019180000_drop_integration_tables.sql` is **pending**.
- Every integration table and its rows are still in Production.

Each step below needs its own authorization.

**Irreversible.** Step 2 deletes tables and the rows in them, including the proposed notes kept in settled suggestions. **Nothing in this plan exports, backs up or copies those rows**, on purpose. Whether a provider backup exists, and for how long, is **not established**, and this plan does not assume one. Once Step 2 commits, treat the rows as gone.

## What is deleted, what survives, what is shared

### Deleted by the migration (19 tables, 5 functions)

| Group | Objects | Production rows (Stage D evidence, counts only) |
|---|---|---|
| Suggestion records | `interaction_candidates`, `new_contact_candidates` | 27 and 3, all settled (accepted, dismissed or withdrawn). Some interaction suggestions still hold a **proposed note**: a Calendar event title (≤200 chars) or an Outlook drafted summary (≤2,000 chars). |
| Sign-in attempts | `microsoft_oauth_states`, `google_oauth_states` | 1 expired, non-pilot Microsoft state, **deliberately in scope**; 0 Google |
| Connections and tokens | `google_connections`, `google_tokens`, `google_connection_capabilities`, `microsoft_connections`, `microsoft_tokens` | 0 |
| Sync state and references | `gmail_sync_state`, `google_calendar_sync_state`, `google_calendar_event_refs`, `email_candidate_refs`, `outlook_sync_state`, `outlook_subscriptions`, `outlook_candidate_refs`, `outlook_round_messages`, `outlook_conversation_progress`, `outlook_thread_recovery` | 0 |
| Functions | `run_google_local_cleanup(uuid)`, `outlook_sync_state_consume_wake()`, `outlook_unpaired_valid(jsonb)`, `expire_pending_email_context(integer)`, `expire_pending_outlook_context(integer)` | — |

Each table's own indexes, constraints, RLS policies, grants and triggers go with it. This includes the trigger `outlook_sync_state_consume_wake` on `outlook_sync_state`.

### Must survive, unchanged

- **Every saved contact and interaction.** That includes interactions accepted from a suggestion, which are ordinary rows.
- **`interactions.source` and its CHECK `interactions_source_check`.** Saved records keep their "Google Calendar" and "Outlook" labels.

### Shared application objects that stay

- **Tables:** `profiles`, `pro_trials`, `subscriptions`, `checkout_operations`, `stripe_webhook_events`.
- **Functions:** `handle_new_user`, `activate_trial_on_confirmation`, `start_my_pro_trial`, `get_my_pro_access_status`, `claim_checkout_operation`, `finalize_checkout_operation`, `claim_webhook_event`, `mark_webhook_event`.
- **Triggers:** the `auth.users` triggers `on_auth_user_created` and `on_email_confirmed`, and every trigger on a retained table.

### Remaining dependencies, checked

These were checked from the catalog and the code, and the migration re-checks them as it runs:
- No foreign key from a retained table points at an integration table. The integration tables point *at* `auth.users`, `contacts` and `interactions`; those constraints are dropped with them.
- No view, sequence, publication or scheduled job references them. Stage D removed the only job, and Vault is empty.
- No retained function body references them.
- The AI functions (`ai-chat`, `ai-paste-email`, `ai-parse-contact`, `ai-map-csv`, `ai-categorize-contacts`) read only contacts and interactions.

**The one live caller is `delete-account` v69.** It runs `runGoogleLocalCleanup`, which reads `google_connections`/`google_tokens` and calls `run_google_local_cleanup`. That is why Step 1 comes first.

## What the PR contains

- **`supabase/migrations/20261019180000_drop_integration_tables.sql`** (new, forward only; no applied migration is edited).
  - **Guards:** it refuses, before dropping anything, if any of these is true:
    - a connection, token, sync or reference table holds rows;
    - a suggestion is pending or deferred;
    - a sign-in state has not expired;
    - a `cron.job` command names integration objects;
    - any object outside the 19 tables depends on one of them.
  - **Drops:** the 19 tables with `DROP TABLE IF EXISTS`, children before parents, then the 5 functions by exact signature. **No CASCADE anywhere.**
  - **Verifies before commit:** nothing in scope remains, the seven application tables exist, and `interactions_source_check` still allows `outlook` and `google_calendar`.
  - **Idempotent:** safe to re-run.
- **`supabase/functions/delete-account/index.ts`:** the Google cleanup step and its three imports are removed. The flow is now: authenticate → admin client → delete contacts → delete the auth user. While the integration tables exist, `ON DELETE CASCADE` removes their rows for that user; after Stage F there are none.
- **Removed shared helpers:** `shared/googleCleanup.js`, `googleOauthHelpers.js` and `googleTokenCrypto.js`, whose only remaining importer was `delete-account`.
- **Tests:**
  - Removed: the six files that tested only those helpers.
  - Trimmed: the checks of them in mixed files.
  - New static checks: `delete-account` references no integration object, makes no RPC call and imports no shared helper.
  - The migration-order scan now ends with `20261019180000`.
  - Local harnesses: see "Local evidence".
- **Untouched:** the published privacy page and the historical consent record `src/lib/outlookDisclosure.js`. No Vercel or provider setting changes. #24 and #92.

## Operational sequence

The order is not interchangeable. Each step needs its own authorization, and each stops on any mismatch.

### Step 0 — Preconditions (read-only)

1. **Pinned head.** Work from the reviewed PR head, in a clean checkout. `supabase migration list --linked` shows **exactly one** pending version, `20261019180000`.
2. **Deployed functions.** The function list shows `delete-account` **v69** (verify_jwt true), the five AI functions and the three billing functions, each at its recorded version.
3. **Counts only, read-only.**
   - Every connection, token, sync, subscription and reference table is at 0.
   - 0 suggestions are pending or deferred, and 0 sign-in states are unexpired.
   - `interaction_candidates` 27, `new_contact_candidates` 3, `microsoft_oauth_states` 1 (expired).
   - Any difference from these numbers means **stop and report**. It may be legitimate, but it is not the reviewed scope.
4. **No scheduled job; Vault empty.**
5. **Baseline digests**, reporting match or mismatch and row counts only, never content or digest values:
   - membership-and-content digest of each retained table: contacts 492, interactions 16, profiles 13, pro_trials 6, subscriptions 2, checkout_operations 1, stripe_webhook_events 26 at the last read;
   - interactions per `source` label;
   - each retained function (signature, md5 of body, ACL, security, config);
   - triggers, policies, indexes, constraints and grants on retained tables;
   - the `auth.users` triggers;
   - migration history.

### Step 1 — Deploy the new `delete-account` (BEFORE the migration)

```
npx supabase functions deploy delete-account --project-ref jzybxhvgnksrwxfivdwt --use-api
```

Run it from the pinned head. `config.toml` keeps `[functions.delete-account] verify_jwt = true`.

**Verify:**
- The function list shows a new `delete-account` version with verify_jwt **true**. Every other function is unchanged.
- `functions download delete-account` matches the pinned head byte for byte. The bundle has one file, `index.ts`, and imports no shared helper.
- **A repository edit does not change Production.** Only this deploy does, and only the downloaded bundle proves it.
- **Optional, owner-run:** sign up a throwaway account, add a contact, and delete the account from Settings. No real account is deleted for this.

**Why first:**
- v69 calls `run_google_local_cleanup` and reads `google_connections`/`google_tokens`, so the new code removes the only live caller before the objects disappear.
- If the order slips, account deletion still works: v69's cleanup error is ignored by its wrapper. The harness proves this ("OLD delete-account … after the migration"). The order is still required so nothing deployed calls a missing object.

**Recovery:** redeploy `delete-account` from `e41719213425271234855c05bf4f2e61dbcc3060`. Before the migration, both versions delete accounts correctly.

### Step 2 — Apply the migration (only after Step 1 is verified)

```
supabase db push --linked
```

Run from the pinned head, after re-confirming the single pending version.

**Atomicity** (as established for Stage D):
- CLI 2.109.0 sends the file and its history INSERT as one pgconn batch closed by a single Sync, so it runs as one transaction.
- Any refusal or error leaves Production unchanged, with no version recorded.
- **There is no retry without a new authorization.**

**Verify** read-only, against the Step 0 baseline:
- History gained only `20261019180000`.
- 0 of the 19 tables and 0 of the 5 functions remain, and no trigger, policy or index of theirs remains.
- Every retained table's membership-and-content digest and count is unchanged, and so are the per-label interaction counts.
- Every retained function, trigger, policy, index, constraint and grant is unchanged, and so are the `auth.users` triggers.
- `interactions_source_check` is unchanged.

**Recovery limits:**
- **A refused or failed run:** nothing to recover.
- **A committed run is irreversible.** The table structure could only be re-created, empty, by a new forward migration. The deleted rows can't be re-created, including the 27 settled suggestions with their proposed notes, the 3 new-contact records and the expired sign-in state. They could come back only from a backup, and **none is known to exist or assumed**. This plan creates none, because that would copy the notes.

### Step 3 — Merge the PR

Merging deploys the frontend through Vercel. The bundle is functionally unchanged, because this PR touches no frontend source. No backend deploys on merge; Step 1 already deployed `delete-account`.

**Verify:** the Production deployment succeeded.

### Step 4 — Privacy wording (a separate PR, after Step 2 is verified)

The published page (#113) describes records that **will no longer exist after Step 2**. It must not be changed before then: it would claim records are gone while they still exist.

These passages become stale:

| Section | Published wording (now true) | Why stale after Step 2 |
|---|---|---|
| What Funnl stores | "Records left from retired connections … A small number of records from them remain for now" | No such records remain |
| Third parties: Supabase | "The records left from retired connections, described below, are stored there too." | Nothing left to store |
| Third parties: Anthropic | "The records left from retired connections are not sent to Anthropic." | Still true, but describes records that no longer exist |
| Retired connections | "Records that remain for now", listing settled suggestion records (with the proposed-note sentence) and "one expired Outlook sign-in attempt" | All deleted |
| Retired connections | "These records are not used for anything … deleting your account deletes yours. Funnl intends to remove the rest in a later cleanup and has not yet set a date." | The cleanup happened. A dated statement is needed. |
| Limited Use | "…nor what remains of either…" | Nothing remains in Funnl's database; the backup caveat still applies |
| Your rights | "removes your contacts, interactions, and your records left from the retired connections" | No such records |

**Still accurate after Step 2, and must stay:**
- **Keys:** the shared server keys bullet. Key destruction is a separate decision.
- **Backups:** deleting from the database does not remove copies that may exist in backups.
- **Authorization:** the provider app-access pages.
- **Anthropic:** its terms.
- **Paste-email:** its paragraph.

**Tests:** `tests/privacy-policy-retired-integrations.test.js` pins the present wording, and must change with it.

**Warning: no test will flag the stale wording.** Its checks read migration *text*, which stays in the repository, so they keep passing after Step 2. Treat the wording PR as part of finishing Stage F.

**Historical evidence to keep:**
- **`src/lib/outlookDisclosure.js` and its version identifiers** stay unchanged.
- **The prior erasure discrepancy** stays recorded, not rewritten. The previously published Outlook wording said settling a suggestion erased its summary, but `proposed_notes` was never erased by accept, dismiss or invalidate. It is recorded in PR #113 and here.
- **After Step 2 the notes themselves are gone.** The record of the discrepancy is not.

## Kept separate, not part of this plan

- **Key destruction.** `MICROSOFT_TOKEN_ENCRYPTION_KEY_V1`, `GOOGLE_TOKEN_ENCRYPTION_KEY_V1` and `OUTLOOK_FINGERPRINT_HMAC_KEY_V1` are untouched. After Step 2 nothing in the database is encrypted or fingerprinted with them, but destroying them is its own decision.
- **Google provider retirement.** It is blocked on the Google account's 2-step verification. No provider registration, grant or setting changes here.
- **Vercel settings.**

## Local evidence

**`node tests/local/stage-f-integration-tables.mjs`: 59/59.**

Setup:
- Postgres 17.6.1.140, GoTrue v2.192.0 and PostgREST v14.14, with every earlier migration (the Stage D state) and the CLI history table.
- Five synthetic users, each with:
  - saved contacts;
  - interactions labelled manual, Outlook and Google Calendar;
  - settled suggestions with proposed notes (one accepted and linked to its saved interaction);
  - a settled new-contact record.
- One user also has an expired Microsoft sign-in state.
- The migration is applied as `db push` does: the file plus its history row, one transaction.

Results:
- **Before:**
  - **Old `delete-account`** (the deployed helper, loaded from git) deletes an account completely.
  - **New `delete-account`** deletes an account completely; the cascade removes its suggestions and sign-in state.
- **Refusals,** each failing on its own message and changing nothing (rows, objects, grants, history), with the exact start state restored when only the synthetic condition is removed:
  - a pending suggestion;
  - an unexpired sign-in state;
  - a connection row;
  - a scheduled job naming an integration function;
  - a view depending on an integration table.
- **Forced late failure:** a view calls the last dropped function. All 19 table drops and four function drops have run when `DROP FUNCTION` refuses. Everything rolls back: all tables with their rows, functions, triggers, policies, indexes, grants and history.
- **Success:**
  - The 19 tables, 5 functions and the wake trigger are gone, along with their indexes and policies.
  - The seven application tables have identical rows, and per-label interaction counts are identical.
  - Retained functions, triggers, policies, indexes, constraints, grants, column grants, schema grants, `auth.users` triggers, cron and Vault are identical.
  - One history row is recorded.
- **After:**
  - The dropped table and RPC return 404 through the API, while contacts still read.
  - **Old `delete-account`** (out-of-order safety) still deletes the account: its cleanup reports an error its wrapper ignores.
  - **New `delete-account`** deletes the account.
  - The bystander is unchanged throughout.
  - A new signup still gets its profile and trial rows.
- **Re-run:** the body runs again with no change.

Other harnesses:
- **`node tests/local/integration-backend-retirement.mjs`** (Stage D): 39/39. It now applies only the migrations before its own, and loads the old helper from git history.
- **`node tests/local/settings-retired-browser.mjs`:** 18/18 on the post-Stage-F schema. Its synthetic connection rows are seeded only while those tables exist.
