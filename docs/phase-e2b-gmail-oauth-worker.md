# Phase E2B — Capability-aware Gmail OAuth & bounded background worker (design)

Wires the dormant E1 classifier + E2A schema/adapter into a **production-ready but still
disabled** Gmail integration: capability-aware OAuth, a private bounded synchronization
worker, and a minimal Settings → Integrations presentation behind a new off-by-default
flag.

**Nothing in this phase is live.** It ships an **unapplied** migration, **undeployed** Edge
Functions, and UI that cannot execute. No Google OAuth configuration was changed, no secret
created, no flag enabled, no mailbox accessed, and no Gmail API call made — not even once,
by anything, including the test suite. Calendar is untouched; **Calendar C2A (background
Calendar scheduling) remains a separate future phase** and is deliberately not implied by
any copy here.

Base: `origin/main` = `6300835` (verified clean, ledger 16, three Gmail tables empty).

---

## Modules

| File | Role |
|---|---|
| `supabase/migrations/20260910000000_add_gmail_worker_primitives.sql` | 4 additive RPCs — **merged in PR-A (#40) and applied to Production** (ledger 17) |
| `supabase/functions/shared/gmailOauth.js` | Pure capability-aware OAuth decision layer |
| `supabase/functions/shared/gmailHistory.js` | Pure History aggregation + reconciliation resolution |
| `supabase/functions/shared/gmailWorker.js` | Pure bounded run orchestration (DI) |
| `supabase/functions/shared/workerAuth.js` | Constant-time worker-secret authorization |
| `supabase/functions/gmail-oauth-start/index.ts` | New Edge shell (**not deployed**) |
| `supabase/functions/gmail-sync-worker/index.ts` | New private Edge shell (**not deployed**) |
| `supabase/functions/google-oauth-callback/index.ts` | 4 surgical edits; Calendar path unchanged |
| `src/lib/gmailConnection.js` | Pure flag + classification + copy helpers (**PR-C**) |
| `src/components/GmailConnectionCard.jsx` | Primary integration card (**PR-C**) |
| `src/pages/SettingsPage.jsx` | Integrations section (Gmail primary, Calendar secondary) (**PR-C**) |

Tests: `gmail-oauth-capability` (26), `gmail-history-reconcile` (21), `gmail-worker` (48),
`gmail-worker-auth` (26), `gmail-worker-primitives-migration` (31), `gmail-connection-ui`
(44), `gmail-transport` (34, E2A suite extended). Full suite 5639/5639 across 140 suites.

---

## 1. Dormancy — what makes this inert

Three independent runtime gates, each sufficient on its own (the fourth — the unapplied migration — was consumed by PR-A):

| Gate | Where | Effect when unset |
|---|---|---|
| `VITE_GMAIL_CONNECTION_ENABLED` | build-time, frontend | No card, no query, no OAuth request |
| `GMAIL_INTEGRATION_ENABLED` | Edge secret, `gmail-oauth-start` | 503 `gmail_not_enabled` before auth |
| `GMAIL_WORKER_SECRET` | Edge secret, `gmail-sync-worker` | 503 `worker_not_configured` |
| ~~migration unapplied~~ | Postgres | **Applied in PR-A (#40).** The four RPCs now exist but nothing calls them: no function is deployed, no capability row exists, and `disconnect_my_gmail()` is a `not_connected` no-op for every user |

Plus: the two new Edge Functions are **not deployed**, and **no scheduler, Cron job, or
webhook invokes the worker**. A run can only begin when a human both creates the worker
secret and calls the endpoint with it. `GMAIL_INTEGRATION_ENABLED` is also checked by the
worker (after the secret, so it is not probeable): unsetting it pauses every run without
rotating the secret.

The frontend flag is fail-safe and exact-match: enabled **only** on the string `'true'`.
`'TRUE'`, `'True'`, `'1'`, `'yes'`, `' true '`, boolean `true`, `null` and `undefined` all
resolve to disabled. Verified in the built bundle: the flag compiles to
`gmailConnectionEnabled(void 0)` → `false`, so every Gmail branch is unreachable. The card
source still ships (the same dormant-but-shipped shape as the existing Calendar card);
being present in the bundle is not being executable.

---

## 2. Capability-aware OAuth

One Google identity, one refresh token, **independent** per-product capabilities.

- `gmail.readonly` is requested **only** from `gmail-oauth-start`, only on an explicit user
  action. `GOOGLE_OAUTH_SCOPES` (the Calendar set) is never touched — asserted by test, and
  `google-oauth-start/index.ts` contains no Gmail reference at all.
- `gmail-oauth-start` is a **separate function** from `google-oauth-start` specifically so
  the Calendar flow cannot regress.
- `include_granted_scopes=true` makes the request incremental: an existing Calendar grant is
  preserved rather than replaced.
- State is a 256-bit CSPRNG token whose SHA-256 hash alone is persisted, expiring (10 min),
  consumed atomically (single conditional UPDATE, so a replay loses the race), bound to the
  user, the validated return origin, the encrypted PKCE verifier, and
  `integration_type='gmail'`. Equivalent in strength to an HMAC-signed state: nothing
  guessable, nothing reusable, nothing the browser can forge.
- **`sub` verification:** with an existing connection, the returned Google `sub` MUST match.
  A mismatch is rejected with **zero mutation** (no capability, no token, no connection
  write) and a best-effort revoke of the *new* credential only. A different Google account
  can never take over an existing connection.
- **A newly returned combined-scope refresh token is required.** Gmail activation needs all
  of: a verified authenticated Funnl user, a valid consumed Gmail-bound OAuth state, a
  verified Google identity, the same `sub` as any existing connection, `gmail.readonly` in
  the scopes Google actually returned, and a **new** usable refresh token from this
  exchange. The consent URL requests `access_type=offline` + `prompt=consent`, so Google is
  *expected* to issue one; that is requested behavior, not a guarantee, and the missing-token
  branch is kept defensively: if it is absent the consent fails closed with
  `missing_refresh_token` and **zero** connection/token/capability mutation (only the
  one-time state consumption has already happened). Gmail is never activated on an older
  Calendar-only refresh credential, and a same-account failure revokes nothing. On a persist
  failure the new credential is revoked **only when there was no pre-existing connection** —
  never a credential Calendar may still be using.
- Only the **Gmail** capability row is created/updated, via `upsert_google_capability`,
  which verifies connection ownership before any mutation.

### Scope loss vs. dead credential

| Signal | Classification | Effect |
|---|---|---|
| refresh response omits `gmail.readonly` | `scope_revoked` | Gmail → `needs_reauth`. **Calendar untouched.** |
| Google returns `error: invalid_grant` | `invalid_grant` | Connection-wide failure |
| 5xx / timeout / malformed / unknown | `provider_error` | **Transient.** Capability stays active; retry later |

That third row matters: an earlier draft mapped *everything* that was not `invalid_grant` to
a Gmail reauth, which would have forced users to reconnect after a single provider blip.
Fixed, with tests covering `provider_error`, an unknown reason, a missing reason, and a null
result.

### Revocation rule (review correction)

Google's revoke endpoint acts on the user's grant for this client, and the official
documentation guarantees only that revoking an access token also revokes *its* refresh
token — it gives no guarantee that other refresh tokens the app already holds for the same
account survive. With granular consent a user can add Gmail to the account Calendar already
uses and untick the mailbox scope; the original draft revoked the just-issued token on that
rejection, which could have silently killed the stored refresh token Calendar depends on.
Now a rejected Gmail consent revokes the new token **only** when there is no existing
connection at all, or the token provably belongs to a *different* Google account (sub
mismatch, decided before the scope check). A same-account rejection mutates nothing and
revokes nothing; the unused new grant is harmless.

### Shared token & concurrent refresh

One refresh token serves both capabilities. A successful Gmail consent replaces it with the
newly returned token covering the combined scopes (`prompt=consent` requests re-consent so
Google is expected to issue one; if it does not, the consent fails closed as above) via
`include_granted_scopes=true`; `google_connections.scopes` is set to the scopes
Google actually echoed, so the Calendar card's "granted" indicator stays truthful even if
the user had meanwhile withdrawn Calendar in their Google account. The Calendar sync and
the Gmail worker both refresh through `store_refreshed_google_token`, which is guarded by
the expected `google_sub` and never half-writes the refresh pair. Two concurrent refreshes
can at worst store the slightly older of two *valid* access tokens (Google issues no new
refresh token on refresh), which only makes the next refresh happen a little sooner. The
Gmail worker reuses a stored access token while it is comfortably valid, so it rarely
refreshes at all.

Controlled codes only. Nothing logs a token, authorization code, email address, Google
`sub`, raw response, or OAuth state payload.

### Existing callback limitation (documented, deliberately not changed here)

The shared `google-oauth-callback` reads Google's token-exchange and userinfo responses
with `tokenRes.json()` / `userinfoRes.json()` — unbounded buffering inherited from the
Calendar implementation, in the part of the handler that runs *before* the Gmail/Calendar
branch. The E2B worker path is fully bounded (`readBoundedStream` everywhere, including its
own token refresh); this pre-branch read is the one remaining unbounded provider read.

It is **not** rewritten in PR-B because that code is the live Calendar OAuth path: any change
to it needs its own review and an end-to-end Calendar regression proof, which would widen
this backend PR beyond its Gmail scope. The exposure is narrow: the handler only reaches
those reads after a state row minted by our own `oauth-start` functions is atomically
consumed, and the only upstream that can answer is Google's token and userinfo endpoints over
TLS, whose responses are a few hundred bytes. **Follow-up (separately scoped):** switch both
reads to `readBoundedStream` with a small hard cap (16 KB is ample), keep the identical
control flow, and re-run the Calendar connect / reconnect / replace-account / disconnect
regression before deploying.

### Return banners

The Gmail flow uses a distinct `?gmail=connected|error` param; Calendar keeps
`?google=...`. The callback decides the error target from the resolved state row
(`isGmailFlow`), so a failed Gmail consent can never surface as a Calendar error, or vice
versa. Failures *before* the state row is resolved fall back to the canonical Calendar error
target — at that point the integration is genuinely unknowable.

---

## 3. Private bounded worker

`gmail-sync-worker` is **not user-callable**. Platform JWT verification is intentionally disabled for this private worker endpoint because user JWTs grant no authority. The endpoint instead requires a separate high-entropy worker secret, compares it in constant time, exposes no CORS path, and calls only service-role RPCs.

- `timingSafeEqualStr` folds the length difference into the accumulator and runs a
  fixed-span loop with no early return (asserted by reading the loop body in a test).
- Bearer parsing is bounded (≤ 8192 chars) and strict (`/^Bearer [A-Za-z0-9._\-+/=]+$/`,
  case-sensitive scheme).
- POST only → 405. Missing/short secret → 503 (fails closed, never open).
- A JWT-shaped bearer is rejected like any other wrong secret.

**Exactly one connection per invocation.** `reserve_due_gmail_connection` has a single-row
`LIMIT`; there is no loop over users and no sweep. Atomicity comes from a **guarded upsert**
whose `ON CONFLICT … WHERE` re-checks lease expiry, followed by a `ROW_COUNT = 1` check —
the mechanism already proven in `claim_gmail_sync_lease`. A row lock is not usable here: the
due query LEFT JOINs `gmail_sync_state` so never-synced connections are visible, and
Postgres forbids `FOR UPDATE` on the nullable side of an outer join. Verified locally: 8
concurrent reservations → exactly 1 winner.

A never-synced connection has no sync-state row and is therefore **immediately due**
(verified: `reserve_due_gmail_connection` → `reserved`).

Lease, run-ID fencing, renew and release reuse the E2A contracts unchanged. A stale run can
neither renew, release, nor advance another run's cursor.

### Caps (`CAPS` in `gmailWorker.js`)

| Cap | Value |
|---|---|
| pages per invocation | 20 |
| messages per page | 100 |
| messages per run | 2 000 |
| conversations per run | 1 000 |
| decoded metadata bytes per message | 131 072 |
| bytes per list page | 1 048 576 |
| decoded bytes per run | 5 000 000 |
| runtime budget | 60 000 ms |
| concurrency | 4 (slice-based; never an unbounded `Promise.all`) |
| prior-key fingerprint lookups | 5 |
| per-request deadline | 15 000 ms, clipped to the remaining run budget (AbortSignal on every provider call) |
| bytes per thread listing (`threads.get?format=minimal`) | 1 048 576 |
| bytes per `users.getProfile` | 16 384 |
| reconciliation fingerprints per thread | 20 000 computed; invalidated in RPC chunks of 500 |
| incomplete-run retry (DB predicate) | after backoff (300 s / 900 s), ≥ 5 min apart, max 10 consecutive, then daily |
| lease | 120 s |
| due interval | 86 400 s |
| initial window | 90 days |

Justification: page/message/conversation/byte caps bound provider traffic and memory per
run (a student mailbox's 90-day window fits comfortably; anything larger is simply
resumed next run). The 60 s budget keeps the run well inside the Edge wall-clock limit and
the 120 s lease; the per-request deadline guarantees a hung connection cannot consume the
budget silently. Concurrency 4 keeps a run well under Gmail's per-user quota. The
reconciliation ceiling is the point beyond which enumerating (contacts × boundaries) stops
being a cheap HMAC loop; past it the run is marked incomplete rather than guessing.

Caps are enforced by the **caller**, before adapter normalization — obligation (2) from
PR-B. All provider responses are read with the existing `readBoundedStream` (Content-Length
pre-check, byte counting, stream cancel on cap, fail-closed on UTF-8 error) — obligation
(1). `.json()` and `.text()` are never called on a provider response, including the token
exchange; asserted by a test that strips comments first.

### Cursor advancement

`historyId` is passed to `release` as `complete ? advanceHistoryId : null`. Partial,
malformed, capped, interrupted or indeterminate runs advance **nothing** and emit **no**
`eligible` result.

**Truthful boundary for the initial import (review correction).** Before the bounded list,
the worker calls `users.getProfile` and takes its `historyId` as the boundary. Every change
after that instant is delivered by the next incremental run; changes between the profile
call and the end of the list are replayed once, idempotently. Without this (the original
E2B draft), a completed initial import released with `historyId = null`, so
`initial_import_done` became true while `history_id` stayed NULL — and every later run
would have re-imported the 90-day window forever, never reaching the History path. The
expired-cursor resync establishes its boundary the same way.

---

## 4. History & reconciliation — obligation (3)

| Situation | Handling |
|---|---|
| first run / no cursor | `getProfile.historyId` boundary, then bounded 90-day metadata-only import |
| `messageAdded` | whole thread re-read (`threads.get?format=minimal`) → classified with full context |
| `messageDeleted` | whole thread re-read → remaining episodes kept, the rest invalidated |
| `labelsAdded` TRASH/SPAM | scope exit → treated exactly like a deletion |
| `labelsRemoved` TRASH/SPAM | restored into scope → thread re-read and re-evaluated |
| `labelsRemoved` INBOX (archiving) | **not** an event; must never invalidate |
| 404 on `startHistoryId` | `history_cursor_expired` → bounded resync with a fresh profile boundary |
| 404 on `threads.get` | the thread is gone: nothing remains, every plausible boundary is invalidated |
| unreadable thread listing / withheld thread | **never reconciled** (keep-set unknowable); run incomplete, cursor held |

**The request must ask for all four history types.** `users.history.list` *filters* to
the `historyTypes` requested. The E2A builder asked for `messageAdded` only, which means
that in production no deletion or label record would ever have reached the worker and the
whole reconciliation path was unreachable — the unit fixtures hand-wrote deletion records
the real API would never have returned. Corrected in review; the transport test now pins
all four types.

**Whole-thread context.** Prior runs retain no metadata (by design), so an incremental run
cannot classify a delta in isolation: a reply added today to a message synced yesterday
would never qualify on its own, and a thread whose only event is a removal has no messages
to classify at all (the original draft silently `continue`d past exactly that case — the
mainline deletion scenario). Every changed thread is therefore re-listed with
`threads.get?format=minimal` (ids + labels only; messages already in TRASH/SPAM are not
"remaining"), its remaining messages are fetched through the normal metadata path, and the
whole thread is classified.

`SCOPE_EXIT_LABELS = ['TRASH','SPAM']`. Archiving is explicitly **not** a removal — a test
asserts this, because treating it as one would silently delete legitimate suggestions.

**The lookup problem and its solution.** `email_candidate_refs` intentionally stores no
thread or message id (provider provenance must not be retainable). So reconciliation cannot
look a candidate up by thread. Instead, fingerprints are **recomputed deterministically**
over `(threadId, contactId, boundaryKey)` where boundaries are the union of remaining and
removed keys, and the resulting set is handed to
`invalidate_email_candidates_by_fingerprint`.

That RPC is a **positive list**, not a keep-set. E2A's `reconcile_email_episode` takes a
keep-set and invalidates everything for the connection outside it — correct for a full
window scan, catastrophic for an incremental run that observed three threads. The positive
list makes it structurally impossible for an incremental run to invalidate a candidate it
did not observe as removed. Bounded to 500 hex-validated fingerprints per call (the worker
chunks, never truncates), run-fenced, same `FOR SHARE OF s` lock order as
`upsert_email_candidate`, and it erases retained context on invalidation.

**Which contacts?** Classification names the contacts whose episodes still qualify. When it
names none — the thread is fully deleted, or the contact's own message was the one removed —
the candidate's contact is unknowable without stored provider identifiers, so every contact
of the user is enumerated. Fingerprints that never existed are no-ops in the positive-list
RPC; the enumeration is bounded by the 20 000-per-thread ceiling above.

---

## 5. Candidate generation — reuse, not reimplementation

E1's classifier, E2A's schema/RPCs, the HMAC key ring, and the E2A adapter are wired
together; none of their logic is duplicated. Preserved exactly:

- user-scoped exact contact matching; ambiguous contact → reject
- CC-only exclusion; automation/list filtering; quiet period
- HMAC-SHA256 fingerprints only, with bounded prior-key lookup for rotation dedup
- idempotent upserts
- subject retained **only after qualification**, sanitized, ≤ 160 chars; erased on accept,
  dismiss, invalidation, or 30-day expiry
- no provider identifier ever reaches the browser
- **suggestions only — the worker never creates an interaction** (asserted by test)

Google token handling reuses `shouldRefreshToken`, `validateRefreshResponse` and
`store_refreshed_google_token` verbatim, so refresh-preservation and the expected-`sub`
account guard are identical to Calendar's. (An earlier draft called that RPC with an
incomplete argument set; a test now pins all eight parameters.)

---

## 6. User-facing presentation (PR-C — not part of the backend PR-B)

> The Settings card described here ships in the separate frontend PR-C behind
> `VITE_GMAIL_CONNECTION_ENABLED`. It is documented here so the backend contracts (the seven
> column-granted capability fields, the `?gmail=` return param, `disconnect_my_gmail()`) are
> read against their consumer.

**Gmail is the primary card.** It leads the Integrations section at a larger type size;
Calendar drops below a de-emphasized "Also available" subheading and keeps its existing copy.
Each card is independently flag-gated, so with both flags off the section does not exist.

**No manual sync.** There is deliberately no "Sync now" control, and no disguised equivalent
("Refresh now", "Check now") — a test forbids all three plus any sync-wired `onClick`.
Connected sources are checked automatically in the background; the UI only ever **reports**
freshness, in coarse buckets ("Checked just now", "Checked 3 hours ago", "Checked
yesterday"), never an exact timestamp, and never the future even under clock skew.

The section-level promise names **Gmail only**, because Calendar background scheduling is
C2A and must not be implied.

Freshness comes from the capability row's `last_success_at`. The browser reads only the
seven column-granted capability fields and never touches `gmail_sync_state` or
`email_candidate_refs` — no cursor, history id, fingerprint or retained subject can reach
it. The card's query is pinned by a test against the exact grant list.

Copy states plainly, in every state: headers only, never message contents; only people
already in your contacts; every match is a suggestion you approve, nothing is logged for
you.

### Disconnect

`disconnect_my_gmail()` is the user's own off switch and the only RPC in this migration
granted to `authenticated`. Zero-arg, `auth.uid()`-derived, so it cannot be aimed at another
account. It:

1. disables **only** the `gmail` capability (`status='disabled'`, `granted=false`,
   `last_result_code='user_disconnected'`);
2. invalidates every **pending** Gmail suggestion and erases its retained subject and
   context expiry;
3. deletes the `gmail_sync_state` row so a reconnect starts a fresh bounded import;
4. leaves the Calendar capability, the `google_connections` row, the encrypted refresh
   token, and all accepted interactions untouched.

It does **not** call Google. Google has no per-scope revocation and the refresh token is
shared with Calendar, so revoking it would silently break a working Calendar connection. The
dialog says exactly that and points the user at their Google Account's third-party access
page. **This is a real limitation, not an oversight** — it belongs in the Privacy Policy
language.

Verified on the disposable local stack: Calendar stayed `active/granted`; the pending Gmail
candidate became `invalidated` with its subject erased; the accepted Gmail candidate and the
pending Calendar candidate were untouched; a second user's identical data was completely
unaffected; the call is idempotent and returns `not_connected` for a user with no
connection; and afterwards `reserve_due_gmail_connection` returns `none_due` for that
connection.

---

## 7. Verification performed (local only)

- Full suite **5613/5613** across 140 suites. Lint exit 0 (warnings pre-existing).
  Production build clean. `git diff --check` clean.
- Disposable local stack only (`supabase db reset` / `db lint`). **`--linked` was never
  used.** Synthetic fixtures only; all removed afterwards; the stack was destroyed with its
  volumes.
- `supabase db lint`: 3 pre-existing warnings, **none** in the four new functions.
- Grant denial verified per function: `authenticated` is denied
  `reserve_due_gmail_connection`, `upsert_google_capability`, and
  `invalidate_email_candidates_by_fingerprint`; `anon` is denied `disconnect_my_gmail`.
- 8-way concurrent reservation → exactly 1 winner.
- No real credential value appears in any source file, test, doc, commit, or log.

### Production-readiness review (2026-09-12, commits after `9455472`)

- Catalog: all four E2B functions `SECURITY DEFINER`, `search_path=''`, owner postgres;
  effective EXECUTE: `anon` false everywhere, `authenticated` true only for
  `disconnect_my_gmail`, `service_role` true for the worker/callback RPCs; exactly the seven
  intended capability columns are SELECT-granted to `authenticated`; no table-level
  privilege for `anon`/`authenticated` on the three Gmail tables; RLS on; composite
  `(connection_id, user_id)` FKs present on all three; 17 migrations after a clean replay;
  `db lint` clean for every new function.
- Query plans at 400 users / 2 000 candidates: reservation 0.27 ms (seq scan over 400
  capability rows — a partial index on `(product, status)` is a future optimisation, not
  needed at pilot scale); invalidation and dedup use `interaction_candidates_fingerprint_unique
  (user_id, source_fingerprint)`; the browser capability query uses the user index.
- Genuine multi-session concurrency: 8 separate `psql` processes against 100 due
  connections → 7 distinct winners + 1 `none_due` (two sessions chose the same candidate,
  one lost the guarded upsert — documented, harmless); against exactly one due connection →
  exactly 1 winner.
- Predicate: incomplete run not due during backoff; due again ≥ 5 min after backoff;
  not due under the 5-min floor; not due at `retry_count = 10` until the daily cadence;
  a complete release resets `retry_count` and is not due inside the cadence.
- Fencing: a stale run's renew and release both return false and leave `history_id`
  untouched; the live run's release advances it.
- `invalidate_email_candidates_by_fingerprint`: refuses without a live lease; ignores
  terminal rows; another user's identical fingerprint untouched; idempotent; 501 entries
  and non-hex refused.
- `disconnect_my_gmail`: Calendar capability stays `active/granted`; every pending Gmail
  candidate invalidated with subject erased; the accepted one untouched; the other user's
  row untouched; cursor row deleted; connection still active; not reservable afterwards.

---

## 8. Zero-breakage rollout — PR split and order

This branch mixes schema, a modified shared callback, new Edge Functions, shared worker
code and frontend. Ship it as **three PRs, backend first**, each independently inert:

| PR | Contents | Why it is safe alone |
|---|---|---|
| **1 — Migration** | `20260910000000_add_gmail_worker_primitives.sql` + its invariant test | Four additive RPCs; no table/column/policy change; nothing calls them yet. `disconnect_my_gmail()` is callable by `authenticated` but is a no-op (`not_connected`) for every user because no Gmail capability row exists. |
| **2 — Backend** | `gmailOauth.js`, `gmailHistory.js`, `gmailWorker.js`, `workerAuth.js`, `gmailTransport.js` (history-types fix + 2 builders), `gmail-oauth-start`, `gmail-sync-worker`, the `google-oauth-callback` edits, `config.toml`, their tests, the E2A/E2B docs | `gmail-oauth-start` answers 503 without `GMAIL_INTEGRATION_ENABLED`; the worker answers 503 without `GMAIL_WORKER_SECRET`; the callback's Gmail branch is reachable only through a state row with `integration_type='gmail'`, which only `gmail-oauth-start` mints. The `gmailTransport` change alters a request no deployed code sends. |
| **3 — Frontend** | `gmailConnection.js`, `GmailConnectionCard.jsx`, `SettingsPage.jsx`, `GoogleConnectionCard.jsx`, `gmail-connection-ui` test | Compiles to `gmailConnectionEnabled(void 0) === false`; no query, no invoke, no route. |

**Order (every step keeps Gmail off):**

1. Merge PR 1. Apply with `supabase db push --linked` after `supabase migration list --linked`
   shows exactly one pending migration. Catalog-verify: four functions, definer +
   `search_path=''`, grants as in §7, seven capability columns granted, tables still empty.
2. Merge PR 2. Deploy **`google-oauth-callback` first** (its Gmail branch is dead without a
   Gmail state row), then `gmail-oauth-start`, then `gmail-sync-worker`. Do **not** set any
   Gmail secret yet.
3. **Regression-test Calendar OAuth** end to end on the new callback: connect, reconnect
   same account, replace account, disconnect. `google-oauth-start` is byte-identical and the
   Calendar branch of the callback is unchanged, but this deploy is the only step that
   touches a live Calendar path.
4. Add `GMAIL_WORKER_SECRET` (≥ 32 chars, CSPRNG) and `EMAIL_FINGERPRINT_KEY_V1` if absent.
   Gmail is still off: `GMAIL_INTEGRATION_ENABLED` unset ⇒ both functions answer 503.
5. Clear the human gates (§9 below): Privacy Policy, consent screen, restricted-scope
   verification, CASA.
6. Merge PR 3 (frontend). Still off: `VITE_GMAIL_CONNECTION_ENABLED` unset.
7. Preview: a protected Preview with `VITE_GMAIL_CONNECTION_ENABLED=true`,
   `GMAIL_INTEGRATION_ENABLED=true`, a non-production Google client, and a throwaway
   Google account only.
8. One separately authorized, bounded real-mailbox validation (owner's account): consent,
   capability row, first worker invocation by hand with the secret, one suggestion, accept,
   dismiss, disconnect, reconnect. Watch logs for codes only.
9. Enable Gmail for a limited rollout: `GMAIL_INTEGRATION_ENABLED=true` in Production and
   the frontend flag for the limited build.
10. Only after worker validation: add scheduling (a scheduled function or external cron
    holding the secret; one connection per invocation, so the schedule is the throughput).

**Races this order prevents.** *Frontend-first:* a visible Connect button that hits an
undeployed/unconfigured `gmail-oauth-start` — the flag order forbids it. *Callback-first
without the migration:* a Gmail consent would reach `upsert_google_capability` before it
exists; PR 1 must be applied before PR 2 is deployed (the branch itself makes this
impossible only if step 1 precedes step 2 — hence the order). *Flag-before-secret:* enabling
`GMAIL_INTEGRATION_ENABLED` before the worker secret lets users consent while no run can ever
start; harmless but confusing — set the secret first (step 4 before step 9).
*Worker-before-callback deploy:* impossible to hurt (no capability rows exist), but keep the
listed order so the callback regression test happens before any Gmail path is reachable.

---

## 9. Owner checklist — human gates before any real Gmail access

**Do not perform any of these without deciding to roll Gmail out.** Each is a deliberate
human action this phase did not take.

### A. Before requesting verification

1. **Privacy Policy replacement language** — `/privacy` must state, before any user sees a
   Gmail consent screen:
   - Funnl requests `https://www.googleapis.com/auth/gmail.readonly`.
   - Funnl reads **message metadata only** (From, To, Cc, Subject, Date, Message-ID, and
     automation headers) and **never** message bodies, snippets, attachments, or raw MIME.
   - Metadata is used for one purpose: suggesting interactions with people already in the
     user's contacts. It is not used for advertising, is not sold, and is not transferred to
     third parties.
   - A qualifying email's **subject line** is retained for up to **30 days** so the user can
     recognize the suggestion, then erased — and erased immediately on accept, dismiss, or
     invalidation.
   - Message and thread identifiers are **not** retained; matching uses keyed HMAC
     fingerprints.
   - How to disconnect (Settings → Integrations → Disconnect) **and** that Google-side
     removal requires the user's Google Account third-party access page, because Google
     issues one authorization per account.
   - Data deletion on disconnect and on account deletion.
2. **Google Cloud consent screen** — app name, support email, logo, home page, and the
   Privacy Policy URL, all matching the verified domain `getfunnl.com`.
3. **Scope justification** — document why `gmail.readonly` and not `gmail.metadata`: the
   bounded initial import needs `q`-filtered search, which Google forbids under
   `gmail.metadata`. Include the 90-day window and every cap from §3.
4. **Demo video** — consent screen, the Settings card, a suggestion being accepted, and the
   disconnect flow.

### B. Verification & security assessment

5. **Restricted-scope verification** — `gmail.readonly` is a *restricted* scope. Expect
   Google OAuth app verification; allow weeks, not days.
6. **CASA assessment** — restricted-scope apps generally require a CASA (Cloud Application
   Security Assessment) tier appropriate to the data handled, renewed annually, at the
   developer's cost. Confirm the current tier and fee with Google's own documentation before
   committing to a launch date. Budget for it.
7. Confirm against **official Google documentation only** (not blog posts) that nothing in
   the scope or History-API behavior assumed in §2–§4 has changed.

### C. Production configuration (in this order)

8. **Redirect URI** — add the production callback to the Google OAuth client. It must match
   `GOOGLE_OAUTH_CALLBACK_URL` exactly.
9. **Secrets** — all server-side Supabase Edge secrets. **Never** `VITE_*`:

   | Secret | Where | Notes |
   |---|---|---|
   | `GMAIL_INTEGRATION_ENABLED` | Edge | exactly `true` to permit a consent |
   | `GMAIL_WORKER_SECRET` | Edge | ≥ 32 chars, CSPRNG, unique to this endpoint |
   | `EMAIL_FINGERPRINT_KEY_V1` | Edge | already required by E1/E2A |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Edge | existing |
   | `GOOGLE_TOKEN_ENCRYPTION_KEY_V1` | Edge | existing |
   | `GOOGLE_OAUTH_CALLBACK_URL` | Edge | existing |

   `VITE_GMAIL_CONNECTION_ENABLED` is the **only** Gmail value that may appear in Vercel
   frontend env, and it is a non-secret UI flag.
10. **Apply the migration** — `supabase db push --linked` (confirm exactly one pending
    migration first with `supabase migration list --linked`).
11. **Deploy the Edge Functions** — `google-oauth-callback` (modified) must go out **with or
    before** `gmail-oauth-start`, then `gmail-sync-worker`.
12. **Scheduler** — this phase creates none. Decide the invocation mechanism (a Supabase
    scheduled function or an external cron holding the worker secret) and remember each
    invocation processes exactly one connection, so the schedule determines throughput.

### D. Ordered test plan

13. **Synthetic** — already done locally (§7). Nothing further required.
14. **Preview** — with a non-production Google client and a throwaway Google account:
    consent, capability row written, a suggestion appears, accept and dismiss erase the
    subject, disconnect behaves as §6.
15. **One real account (yours)** — in production, flag on for your account only. Watch the
    worker logs for `reply_present`, cap hits, and `provider_*` codes. Confirm no body,
    snippet, address, subject, or identifier appears in any log line.
16. **Rollout** — enable the frontend flag only after 14 and 15 pass, and only after
    verification/CASA clear. Calendar C2A stays a separate phase.

### E. Rollback

- Frontend: unset `VITE_GMAIL_CONNECTION_ENABLED`, redeploy. The card disappears; no Gmail
  query or OAuth request can occur.
- Worker: delete `GMAIL_WORKER_SECRET`. The endpoint answers 503 and no run can start.
- Consent: unset `GMAIL_INTEGRATION_ENABLED`. No new Gmail consent can begin.
- Edge Functions: Supabase dashboard → Deployment history → activate the previous version.
- The migration is additive; no down-migration is required to stop Gmail, because the three
  secrets above already stop it.

---

## 10. Explicitly not in this phase

Scheduler/Cron, webhooks, Gmail push notifications, Outlook, Calendar background scheduling
(C2A), a suggestions inbox redesign, any real OAuth configuration, any applied migration,
any deployed function, any created secret, any enabled flag, and any Gmail API call.
