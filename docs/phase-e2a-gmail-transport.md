# Phase E2A — Gmail metadata transport & capability foundation (design)

Backend-only, **dormant** foundation for turning real Gmail relationship conversations
into source-neutral Suggestions via the merged E1 classifier. This phase adds an
**additive, unapplied** migration and **pure** adapter code. It ships **no** Edge
Function, scheduler, webhook, live OAuth scope, Gmail API call, UI, feature flag, or
secret. Production Gmail access stays blocked behind human gates (Privacy Policy +
Google restricted-scope verification/CASA). Calendar is untouched and independent.

## Modules
- `supabase/migrations/20260907000000_add_gmail_transport_foundation.sql` — additive schema + service-role RPCs (NOT applied).
- `supabase/functions/shared/gmailTransport.js` — pure DI Gmail request builders + metadata-only normalization to the E1 contract (no network).
- Tests: `tests/gmail-transport.test.js` (27), `tests/gmail-migration-invariants.test.js` (22).

## 1. Gmail adapter contract & hard caps
The adapter builds requests and normalizes **synthetic** responses; the caller injects
all transport. Output feeds E1's `classifyEmailMessages` unchanged.

| Cap | Value | Purpose |
|---|---|---|
| `INITIAL_WINDOW_DAYS` | 90 | Initial bounded lookback (see §2) |
| `MAX_PAGES` | 20 | list/history pages per run |
| `MAX_RESULTS_PER_PAGE` | 100 | conservative page size |
| `MAX_MESSAGES` | 2000 | hard ceiling across a run |
| `MAX_CONVERSATIONS` | 1000 | distinct threads per run |
| `MAX_RESPONSE_BYTES` | 5 MB | per-page byte cap → over ⇒ thread(s) incomplete |

`normalizeGmailMessage(raw)` → a valid E1 `NormalizedMessage` **or** a controlled
fail-closed code (`not_object`, `prototype_pollution`, `missing_ids`, `no_headers`,
`unexpected_body`, `bad_internal_date`, `oversized_header`, `contract_rejected`). It:
- maps `id→providerMessageKey`, `threadId→providerConversationKey`, `internalDate→timestampIso` (UTC, ms precision);
- extracts **only** the metadata header allowlist (From, To, Cc, Date, Message-ID, Auto-Submitted, X-Auto-Response-Suppress, Precedence, List-Id, List-Unsubscribe, Subject);
- derives `folderHint` from label membership only (SENT/INBOX);
- **fails closed** if payload (or any nested part) carries body **data** (`unexpected_body`) — i.e. more than metadata;
- passes the normalized object through E1's `classifyNormalizedMessage` as a defense-in-depth privacy gate.
Subject is **transient**: it rides on the normalized message for E1 qualification only; retention happens later (§ retained context), never in logs.

**Never requested or retained:** body, snippet, payload body data, HTML, attachments,
raw messages, tracking pixels, arbitrary headers. `snippet` (always returned by Gmail)
is simply never read/copied out.

**Request safety.** Builders (`buildInitialListRequest`, `buildHistoryRequest`,
`buildGetMetadataRequest`) accept **server-derived** params only and throw
`forbidden_request_param` on any caller-controllable key (userId, connectionId, sub,
token, `q`, query, label, window, historyId/cursor, pageToken-as-arbitrary, metadataHeaders).
The `q` is **constructed** from the bounded window (`after:<epoch> -in:chats`), never accepted.
`buildGetMetadataRequest` requests `format=metadata` + exactly the allowlisted `metadataHeaders`.

## 2. Initial import + History API behavior
- **Initial bounded import (recommended 90 days).** Rationale: matches the Calendar
  engine's proven 90-day window and E1's relationship-maintenance framing (recent,
  actionable relationships), while never attempting a full-mailbox ingest. Owner may
  tune; it is a single documented constant.
- **Incremental sync (History API).** After the initial import completes, subsequent
  runs use `users.history.list?startHistoryId=<cursor>&historyTypes=messageAdded` (paged via
  `pageToken`). The durable `history_id` cursor advances **atomically with a complete run
  only** (`release_gmail_sync_lease` advances it iff `p_run_complete AND p_history_id IS NOT NULL`).
  **E2A processes `messageAdded` only, which is sufficient for E2A's create/refresh-only
  behavior. It is NOT sufficient for truthful reconciliation:** per the official Gmail API,
  deletions and label changes are reported under separate history types (`messageDeleted`,
  `labelAdded`, `labelRemoved`). **E2B MUST additionally process `messageDeleted` (and any
  label-removal that removes a message from the synced scope) and invalidate the affected
  pending candidates via `reconcile_email_episode` before any real rollout** — otherwise a
  suggestion could persist for a deleted/removed conversation.
- **Expired/invalid cursor → bounded recovery.** A `404`/invalid `startHistoryId` must
  **not** trigger an unbounded full-mailbox rescan. Recovery re-runs the **bounded 90-day
  initial import** and re-establishes a fresh cursor. (The worker that performs this is
  E2B; E2A provides the cursor semantics and caps.)
- **Completeness at the transport→E1 boundary.** The adapter never decides eligibility.
  It flags threads it could not fully/safely fetch (cap exhaustion, truncation, a
  discarded/garbled message, cursor gap) as **incomplete**. `partitionForClassifier`
  withholds every incomplete thread's messages from E1 (so they can **never** become
  `eligible`) and reports `complete=false` (so the worker must **not** advance the cursor).
  Intentional automation filtering alone never marks a thread incomplete — an automated
  message normalizes fine; E1 filters it while the thread stays complete.
- **Dedup.** `normalizeGmailBatch` dedups by `providerMessageKey` across overlapping
  pages/runs deterministically.

## 3. Database schema / RLS / RPC design (additive, unapplied)
- **Source/integration constraints widened** (drop+re-add named CHECKs; existing data
  preserved): `interaction_candidates.source` and `interactions.source` gain `gmail`,`outlook`;
  `google_oauth_states.integration_type` gains `gmail`.
- **`google_connection_capabilities`** — per `(connection, product)` capability
  (`calendar`|`gmail`), status (`active`|`needs_reauth`|`revoked`|`disabled`), `granted`,
  `needs_reauth`, `last_success_at`, `last_result_code` (controlled). RLS on; authenticated
  read **only own** rows and a **safe column subset** (no id/connection_id/token/cursor);
  writes service-role only. UNIQUE(connection, product).
- **`gmail_sync_state`** — per-connection Gmail cursor + lease (history_id,
  initial_import_done, lease/run-id/status, last_run_complete, retry_count, next_attempt_at).
  RLS on, **no authenticated grant/policy** (cursor never leaks). UNIQUE(connection);
  running-requires-lease CHECK.
- **`email_candidate_refs`** — one durable episode ref per candidate. RLS on, **no
  anon/authenticated grant/policy**, service-role only. Stores **HMAC** `source_fingerprint`
  (`^[0-9a-f]{64}$`) + `key_version` + coarse provenance. Stores **no** raw message/thread/
  history id, address, subject, body, preview, recipient list, or provider response. No
  reversible opaque reference is stored (E2A does not need reversible retrieval → omitted).
- **`interaction_candidates` retained context** — `retained_subject` (≤160) +
  `context_expires_at` (30-day pending TTL).
- **Service-role RPCs** (all SECURITY DEFINER, `search_path=''`, fully-qualified, no
  dynamic SQL, controlled codes, documented lock order): `claim/renew/release_gmail_sync_lease`
  (cursor advances on complete only), `upsert_email_candidate` (lock `gmail_sync_state FOR
  SHARE` first, run-fenced, dedup via UNIQUE(user, fingerprint), retained_subject +30d),
  `reconcile_email_episode` (invalidate non-kept pending + erase context), `expire_pending_email_context`.
- **User RPCs** (authenticated) `accept_/dismiss_interaction_candidate` were re-created to
  be **source-aware** (interaction inherits candidate.source: gmail→`gmail`) and to **erase
  retained email context** on resolution, leaving only the HMAC tombstone. The accepted
  interaction receives **only the user-reviewed note** — `retained_subject` is never copied in.

## 4. Google identity / capability / token semantics
- `google_connections` stays the **one identity + encrypted refresh-token owner** per user.
  Refresh tokens are **never duplicated per capability**; Gmail and Calendar share the one
  connection's tokens but are **independent capabilities**.
- **Lost Gmail scope → Gmail capability `needs_reauth`** (Calendar unaffected). **Lost
  Calendar scope → Calendar `needs_reauth`** (Gmail unaffected). An **invalid/revoked shared
  refresh credential** is a connection-wide failure; the capability rows explain which
  products are affected. (Runtime-verified locally: a gmail capability at `needs_reauth`
  coexists with a `calendar` capability at `active`.)
- The existing `finalizeGoogleConnection` already enforces: valid identity
  (`sub`+verified email), a refresh token **required** for a different account, refresh
  preserved **only** for the same account, atomic persistence, old-account revoke only
  **after** the new connection is stored. E2A reuses this unchanged. The future
  Gmail-connect callback must additionally: reject a returned `sub` that differs from the
  connection's stored `sub` (never overwrite a different account under "add Gmail"), and
  retain the existing encrypted refresh token when Google omits a new one.
- Dormant helper `grantedScopesIncludeGmail` validates a returned Gmail grant the same way
  `grantedScopesIncludeCalendar` does today. It is **not** wired to any live scope; no
  `gmail.readonly`/`gmail.metadata` is added to any default/live OAuth request in E2A.

**Scope note (compliance-relevant):** `gmail.metadata` forbids the `q` search parameter,
so the bounded initial import's date-scoped query needs `gmail.readonly` — a **restricted**
scope (OAuth verification + annual CASA). This is a human/console/legal gate, recorded in
`docs/gmail-privacy-readiness.md`.

## 5. Privacy & retention enforcement
- Metadata-only normalization + E1 validator gate; body-data presence fails closed.
- `retained_subject` stored **only** for an eligible pending suggestion (≤160, sanitized by
  E1's `sanitizeSubjectPreview`), **never** in logs/analytics/fingerprints/errors/status.
- 30-day pending TTL (`expire_pending_email_context`); immediate erase on accept/dismiss/
  invalidate (verified locally). Only the HMAC tombstone (`source_fingerprint` +
  `email_candidate_refs`) survives, for dedup.
- Provider ids/addresses/subjects/tokens/cursors never reach `authenticated` (RLS + column
  grants; verified locally that sync-state/refs are unreadable and `source_fingerprint` is
  not selectable by clients).

## 6. Controlled result codes & logging
- Adapter discard/incomplete codes: `not_object`, `prototype_pollution`, `missing_ids`,
  `no_headers`, `unexpected_body`, `bad_internal_date`, `oversized_header`, `contract_rejected`;
  cap codes: `response_too_large`, `max_pages_exceeded`, `max_messages_exceeded`,
  `max_conversations_exceeded`.
- RPC result codes: `created`/`refreshed`/`invalid_*`/`stale_run`/`unknown_connection`/
  `contact_not_owned`/`reconciled`, plus the existing review codes.
- The module never logs; it returns codes + aggregate counts only — never an address,
  subject, message/thread id, token, cursor, fingerprint, or raw response.

## 7. Outlook decision (future phase — not in E2A)
Use **Mode 2**: request `internetMessageHeaders` under strict byte caps, keep only the
allowlisted automation facts, immediately discard the rest. Keep Microsoft OAuth, tokens,
capabilities, cursors, and tables isolated under a `microsoft_*` stack. Feed both providers
into the same E1 normalized contract. (`Mail.ReadBasic` can read `internetMessageHeaders`
per MS docs — verify on a real E3 test account.)

## 8. Future rollout (backend-first; report-only, not executed)
1. Schema/capability/reference/sync-state migration PR → merge → **exact** production apply.
2. Production catalog/RLS/grant verification.
3. Dormant Gmail transport/worker PR → deploy with Gmail scope still unavailable.
4. Privacy-Policy approval; Google OAuth restricted-scope verification + CASA readiness.
5. Gmail scope + capability-aware OAuth rollout (incremental auth; never widen Gmail during
   ordinary Calendar login/reconnect).
6. Protected Preview of Settings→Integrations; one explicitly authorized test mailbox;
   one bounded initial import; accuracy/privacy/integrity review.
7. Background scheduler rollout; gradual production UI enablement; Outlook afterward.
**Forward-fix/disable:** disable the scheduler/worker to halt sync instantly; never edit an
applied migration, never `migration repair`, never drop provenance, never force-push main,
never broadly enable Gmail before validation.

## 9. Owner decisions / human blockers
- Confirm 90-day initial window and daily-with-jitter cadence (scheduler is E2B/C2-style).
  **[Owner: approved — 90-day window and `gmail.readonly` intended scope.]**
- `gmail.readonly` (needed because `gmail.metadata` forbids the date-scoped `q`) requires
  Google **OAuth app verification**; a restricted-scope app is **likely** also subject to an
  **annual CASA** review — treat CASA as a **conditional/likely** requirement needing human
  (legal + Google console) confirmation, not a definitive engineering conclusion.
- Rewrite the Privacy Policy before any Gmail scope (see readiness doc).
- **`outlook` in the widened CHECK constraints (kept, with justification):** E2A admits
  `outlook` in the source/provider constraints and the upsert even though no Outlook code
  exists. This is deliberate and **harmless** — no code path produces `outlook`, and every
  write goes through RPCs that validate the value — and it is **consistent** with the
  already-merged E1 provider-neutral contract (`EMAIL_PROVIDERS = ['gmail','outlook']`).
  Owner may instead prefer to defer `outlook` to the Outlook phase; if so, remove it via a
  correction migration **before anything is applied**. (No functional effect either way.)
- Confirm the "add Gmail must never overwrite a different `google_sub`" rule for the future
  Gmail-connect callback.
