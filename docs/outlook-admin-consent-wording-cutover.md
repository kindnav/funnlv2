# Administrator-consent wording correction: publication and cutover

**Status: prepared in a Draft PR. NOTHING published, set, paused or re-consented.** Each step
marked *authorisation* needs its own explicit approval. Checks are read-only unless stated.
Report only digests, counts, booleans and controlled codes.

## What changes

One sentence, in two places.

| | Before | After |
|---|---|---|
| Notice paragraph 4, last sentence | "Neither requires administrator consent by default, but a work or school tenant can be configured to require an administrator to approve the app, and then you may not be able to consent for yourself." | "With a personal Microsoft account you approve them yourself. A work or school organisation can require an administrator to approve an app that reads mail — Microsoft's recommended setting for organisations does — and then you cannot connect it until an administrator approves Funnl." |
| `/privacy`, "Those permissions are granted more broadly…" | "None of these scopes requires administrator consent by default, **but a work or school tenant may be configured to require an administrator to approve the app anyway**, in which case you may not be able to consent for yourself." | The same new sentence, character for character (the bold span is "A work or school organisation can require an administrator to approve an app that reads mail"). |

Everything else is byte-identical:
- the other 23 notice paragraphs (pinned by `tests/outlook-admin-consent-wording.test.js`);
- paragraph 4 up to "is connected. ";
- every other `/privacy` sentence.

**Why the sentence was wrong.** It is true of Microsoft's per-permission metadata, which lists
delegated `Mail.Read` and `User.Read` as "AdminConsentRequired: No". But it misleads in practice.
Microsoft's managed "recommended" user-consent policy, the default for new tenants, lets users
consent to delegated permissions EXCEPT a list that includes `Mail.Read`, `Mail.ReadBasic` and the
other mail permissions.

**Evidence for each clause (Microsoft Learn, read 2026-10-13):**
- "With a personal Microsoft account you approve them yourself": Graph permissions reference
  (updated 2026-09-14). "The Mail.Read delegated permission is available for consent in personal
  Microsoft accounts", and the same for `User.Read`, both "AdminConsentRequired: No".
- "A work or school organisation can require an administrator …": Configure how users consent to
  applications (updated 2026-08-04). Organisations can disable or restrict user consent.
- "Microsoft's recommended setting for organisations does": Manage app consent policies (updated
  2026-08-28), "Microsoft recommended user consent policy". It is "the default for a new tenant",
  and its exceptions list `Mail.Read`.
- "and then you cannot connect it until an administrator approves Funnl": Consent experience for
  applications. Users without the right to grant a permission "are blocked from granting consent
  … and they're told to ask their admin". Funnl cannot connect without the grant.

## The version

The notice's version is derived by the existing algorithm: the first 32 hex characters of SHA-256
over the 24 paragraphs joined by LF. The new version is

**`ol-disc-1b6906af498ccff0f1e3292027ca0539`**

The repository's function and an independent Python `hashlib` computation agree. It replaces the
published `ol-disc-6f904c3f7313353acbbc39e1edf2e278`. The three worker requirements in
`shared/outlookContentConsent.js` carry it in the same PR. They take effect only when the worker
is redeployed (C5).

**Affected Edge Functions** (complete import closures computed for every function):
**`outlook-import-worker` only** (31 files, through `shared/outlookContentConsent.js`).
`outlook-oauth-start` reads the version from the server variable `OUTLOOK_DISCLOSURE_VERSION`
and has no code change. The website changes through Vercel on merge.

## Order relative to the other work

1. **#97 (one owner per Microsoft account)** is rolled out completely first. The pilot's
   re-consent in C6 then runs through the new `finalize_microsoft_connection`, whose same-user
   update path is proven in `tests/local/outlook-one-owner.mjs`.
2. **This cutover.**
3. **Only then** the second-account acceptance (`docs/outlook-second-account-acceptance.md`), so
   the second account consents once, under the corrected text.

## C0 — Preflight (read-only)

- `origin/main` and the PR head are pinned, and the PR is rebased onto current main if main moved.
  `npm test`, lint and build pass at that head.
- The pilot is healthy: recent ticks `committed`/`none_due`, no refusal.
- Server `OUTLOOK_DISCLOSURE_VERSION` digest = sha256(`ol-disc-6f904c3f7313353acbbc39e1edf2e278`).
- The pilot's stored consent = `ol-disc-6f904c3f…`.
- Snapshots saved: `scripts/outlook-acceptance/pilot-preservation.sql` → `C0.json`, and the full
  set of secret digests (names and digests only, never values).

## C1 — Pause (*authorisation*)

- `cron.alter_job(<outlook-worker-tick jobid>, active := false)`, by job name.
- Then `scripts/outlook-worker-flag.ps1 disable`.

**Verify:** the job is inactive; `OUTLOOK_IMPORT_WORKER_ENABLED` is absent from the JSON inventory.
Notifications may keep arriving and recording wakes; the worker refuses them while the flag is
absent. **Never clear wakes.**

## C2 — Natural lease release (read-only)

Poll the folder state until no lease is in the future and no run id is held. Wait; never force.
A run already started finishes on its own. Then capture `C2.json` (pilot preservation) and the
pilot's connection run-state line.

## C3 — Publish (*authorisation*: merge the Draft PR)

**Before merging:**
- set `/privacy`'s "Last updated" to the New York date of the merge;
- update its pin in `tests/privacy-policy-outlook.test.js` and the dated comment;
- rerun the suite.

Then merge the pinned head and wait for the Vercel production deployment to be READY.

**Verify the served bundle as data** (nothing executed):
- the paragraphs parse to 24;
- the independent fingerprint is `1b6906af498ccff0f1e3292027ca0539`;
- the old value is absent;
- `/privacy` carries the new sentence and the new date, and not "administrator consent by default".

From here until C4, a NEW connection attempt is refused by `outlook-oauth-start` as `stale_version`
(browser new, server old). That is safe: nobody is connecting, and the pilot's existing
connection is untouched.

## C4 — Server variable (*authorisation*)

`npx supabase secrets set OUTLOOK_DISCLOSURE_VERSION=ol-disc-1b6906af498ccff0f1e3292027ca0539 --project-ref jzybxhvgnksrwxfivdwt`

**Verify:**
- the stored digest = sha256 of that string;
- every OTHER secret's digest is unchanged (one fingerprint over name=digest pairs);
- `OUTLOOK_IMPORT_WORKER_ENABLED` is still absent.

Setting a secret bumps every function's version counter. Bundles must not change, so verify by
bundle hash, not by counter.

## C5 — Worker redeploy (*authorisation*)

From merged `main`:

`npx supabase functions deploy outlook-import-worker --project-ref jzybxhvgnksrwxfivdwt --use-api`

**Verify:**
- the downloaded closure equals merged main's 31 files byte for byte (LF-normalised);
- the three requirements are `ol-disc-1b6906af…`;
- `verify_jwt=false`;
- the other Outlook bundles are unchanged.

The pilot's stored consent (`6f904c3f…`) no longer satisfies the worker. Any run would be refused
as `background_consent_missing`, but none can run anyway: the worker is still paused.

## C6 — Pilot same-account re-consent (owner; *authorisation*)

In Settings → Outlook, the card shows that the permissions need updating. The owner reads the
notice, ticks the acknowledgement and completes Microsoft's prompt with the **same** Microsoft
account. This is an OAuth UPDATE of the existing connection: `finalize_microsoft_connection`'s
same-user path. It is **never** a disconnect.

**Fields the update legitimately changes.** These are not failures:
- `microsoft_connections`: `consented_at`, `consent_policy_version` (→ `ol-disc-1b6906af…`),
  `last_result_code` (`reconnected`), `last_success_at`, `token_expires_at`, `updated_at`;
- `status`/`needs_reauth` re-asserted (`active`/false);
- `ms_tenant_id`, `account_type`, `ms_email` and `scopes` are rewritten from Microsoft's answer.
  They are expected to be byte-identical, and if they are not, that is reported, not assumed.
- `microsoft_tokens`: both ciphertexts, nonces, `key_version`, `token_expires_at`, `updated_at`;
- the new OAuth state row is consumed.

**Must NOT change:** the connection id, `user_id`, `ms_account_id`, `connected_at`, the wake
counters (other than real notifications), sync cursors and folder state (paused), the
subscription row, contacts, interactions, settled candidates, provenance refs and
thread-recovery rows.

**Comparison against C2:**
- `must_not_alter`: identity unchanged; saved interactions, contacts, and settled interaction and
  new-contact candidates unchanged;
- `pilot_stored_consent` CHANGES, and its new value must name `ol-disc-1b6906af…`;
- `sync_may_change` rows unchanged except connection run state (`last_result_code=reconnected`,
  the new `last_success_at` and `token_expires_at`).

## C7 — Resume (*separate authorisation*)

- `scripts/outlook-worker-flag.ps1 enable`, then `cron.alter_job(..., active := true)`.

**Verify:**
- the first tick is `committed` or `none_due`, with **no** `background_consent_missing`;
- folders are idle with no error code;
- `must_not_alter` is still equal to the post-C6 values.

## Rollback

- **Before C5:** revert the merge, which restores the notice and `/privacy`. Set the server
  variable back to `ol-disc-6f904c3f…`. Nothing else has moved.
- **After C5 but before C6:** redeploy the worker from the previous main (its 31-file closure), and
  revert the variable and the website as above. The pilot's old consent is valid again.
- **After C6:** the pilot's consent names the corrected text. Rolling back would make that
  consent stale and require re-consenting again under the old text, so prefer rolling forward.
- Never disconnect, reset, clear cursors or reverse a migration as part of rollback.
