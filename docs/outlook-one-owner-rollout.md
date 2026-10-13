# Rollout: one Funnl owner per Microsoft account (Draft PR #97)

**Status: prepared, NOTHING applied, merged or deployed.** Each numbered step needs its own
authorisation. Every check is read-only unless the step says otherwise. Report only digests,
counts, booleans and controlled codes.

**Order: migration → website (merge) → `outlook-oauth-callback`.** No other Edge Function is
affected. The full import closures were computed for every function:
- only `outlook-oauth-callback` contains a changed file (`handler.js`, plus the new
  `refusals.js`);
- `shared/microsoftOauthHelpers.js` is deliberately unchanged, so the worker, notifications
  and OAuth start bundles stay exactly as deployed.

No pause is needed. The migration touches only `finalize_microsoft_connection` (which the worker
never calls) and adds one index. Index creation briefly takes a SHARE lock on a one-row table.

## R0 — Preflight (read-only)

| Check | Expected |
|---|---|
| `origin/main` | `dd7eb04ab92a8ef7300698bfe7cb3d684ae75cf3` (or the PR rebased onto any newer main and re-proven) |
| PR #97 head | the pinned SHA in the PR, clean worktree |
| `npx supabase migration list --linked` | exactly ONE pending: `20261014000000_outlook_one_owner_per_microsoft_account.sql` |
| Duplicate identities, grouped by `coalesce(lower(ms_tenant_id),'')`, `lower(ms_account_id)` | 0 groups with more than one row |
| `finalize_microsoft_connection` | 1 overload, `md5(prosrc)` = `e5809302c1b467858573dd8ba9398270` |
| Index `microsoft_connections_ms_identity_unique` | absent; 4 indexes on the table |
| Deployed `outlook-oauth-callback` | closure = `main`'s 12 files (verified 2026-10-13 at v48, bundle `924ea45c757a3512`, `verify_jwt=false`) |
| Pilot | `scripts/outlook-acceptance/pilot-preservation.sql` captured as the baseline; recent ticks `none_due` or `committed`, no refusal |

## R1 — Apply the migration (authorisation 1)

From a clean checkout of the pinned PR head on Windows with `core.autocrlf=true` (the same
conditions under which every earlier migration was applied):

```
npx supabase db push --linked
```

Expect exactly one migration. The CLI's known post-push `pgdelta-target-ca.crt` cache error at
exit 0 is not an apply failure: verify the ledger and the catalog instead.

If the migration's guard raises `outlook_one_owner_duplicates`, nothing was applied. **Stop.** Do
not delete or disconnect anything to make it pass.

## R2 — Verify the catalog and preservation (read-only)

| Check | Expected (derived on a disposable database from this exact file) |
|---|---|
| Ledger | nothing pending |
| Overloads | 1 |
| `md5(prosrc)` | `90ecb2d60c3a22e23d758263ed5604a7`, 9,680 chars |
| `prosecdef` / `proconfig` / owner | `true` / `search_path=""` / `postgres` |
| `proacl` | `postgres=X/postgres,service_role=X/postgres` |
| EXECUTE | `anon` false, `authenticated` false, `service_role` true |
| Index | `CREATE UNIQUE INDEX microsoft_connections_ms_identity_unique ON public.microsoft_connections USING btree (COALESCE(lower(ms_tenant_id), ''::text), lower(ms_account_id))` |
| Indexes on the table | 5: pkey, `_user_unique`, `_id_user_key`, `_account_idx`, the new one |
| Pilot `must_not_alter` digests | unchanged from R0 |
| Connections | still 1; duplicate groups 0 |
| Next cron ticks | `none_due` or `committed`, no refusal |

From here until R4, the deployed callback treats `account_in_use` like any other refusal (the
generic error). That is safe: nothing is written either way.

## R3 — Merge #97 (authorisation 2)

Merge the pinned head and wait for the Vercel production deployment to be READY. Then check the
served bundle (read-only):
- it contains the `in_use` callback result and the account-in-use notice;
- it still derives notice version `ol-disc-6f904c3f7313353acbbc39e1edf2e278`, because #97
  changes no notice text.

## R4 — Deploy `outlook-oauth-callback` (authorisation 3)

From merged `main`:

```
npx supabase functions deploy outlook-oauth-callback --project-ref jzybxhvgnksrwxfivdwt --use-api
```

Verify:
- download the deployed function into an isolated folder; its closure must equal merged main's
  13 files byte for byte (LF-normalised), `refusals.js` included;
- `verify_jwt=false` (preserved by `config.toml`);
- the other three Outlook functions' bundle hashes are unchanged:
  - start `5c57453ea55d0e60`
  - worker `c59372d81fadfdba`
  - notifications `4d1af69a17c9c9bb`

  Version counters may move; bundles must not.

## R5 — After (read-only)

The pilot's `must_not_alter` digests are unchanged and runs are healthy. No live refusal test is
run against Production; the refusal is proven on disposable infrastructure
(`tests/local/outlook-one-owner.mjs`).

## Rollback

- **Callback:** redeploy `outlook-oauth-callback` from `dd7eb04` (its 12-file closure). The
  website copes either way: it simply never receives `in_use`.
- **Migration:** re-issue the `20260928000000` definition of `finalize_microsoft_connection` and
  `DROP INDEX public.microsoft_connections_ms_identity_unique`. No data is touched. Do this only
  if the function itself misbehaves; the index is harmless on its own.
