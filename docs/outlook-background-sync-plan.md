# Outlook background sync — implementation plan, activation plan and completion criteria

Status: **PR #76 merged 2026-10-09 (`4bc50c8`); migration applied; both functions deployed; Vault
secrets present; wording published (version `ol-disc-6d1ddd67f51d5b3bfd8d3801c50271a7`); server secret and all three worker
requirements cut over to it, worker redeployed; pilot re-consent, bootstrap, listener verification and
activation still pending** (base `main` =
`f1c95bc7e01532f4fe9465b5faa5f8341b8827fa`, the PR #75 merge).

The product goal this serves: Funnl removes manual networking data entry. It detects a
meaningful two-way exchange whichever person started it, prepares a contact-plus-interaction
or interaction proposal with both sides' context, and lets the user review before anything is
saved. The manual PowerShell pilot proved the pipeline; it was never the user experience.
This slice makes the pipeline run on its own and makes its output discoverable.

## 1. What this slice adds

| Piece | Where | What it does |
|---|---|---|
| Change-notification subscription | `supabase/functions/shared/outlookSubscriptions.js`, worker step in `outlookImportRun.js` | One Graph subscription per connection on `me/messages` / `created`. Microsoft documents message subscriptions at two levels: the whole mailbox (`/me/messages`) and a single folder (`/me/mailFolders('{id}')/messages`, the Inbox being the documented example) - so a folder-level Sent Items subscription is possible. The mailbox-wide resource is chosen because ONE subscription then covers Inbox **and** Sent Items (a reply the user sends and a message the user receives both wake processing); whether it does in fact fire for a sent draft is a live fact the activation plan verifies, not an assumption. Created on the first run under the lease, renewed when under 24 h remain or Microsoft asks for reauthorization, recreated when removed. 3-day lifetime (documented ceiling 10,080 min). ClientState: 32 random bytes; **only its SHA-256 is stored**. |
| Notification endpoint | `supabase/functions/outlook-notifications/` (`verify_jwt=false`) | Answers Microsoft's validation handshake (200 text/plain, decoded token). Parses a batch to subscription id + clientState + kind only (never `resourceData`). **One** database call per POST (`record_outlook_change_notification_batch`) matches id and hash and records a durable wake-up. The whole ingress path — body read and persistence — is raced against a 2.5 s budget. **202 only when every item got a definitive answer** (accepted, or refused for a reason a retry cannot change); **503** when the batch could not be durably recorded (port failure, unknown shape, budget exhausted), which Microsoft retries; redelivery is idempotent. Kicks the worker off the response path after persistence. |
| Wake-up + eligibility | migration `20261009000000` | `microsoft_connections.wake_requested_at/wake_source/wake_count/last_wake_at`. `reserve_due_outlook_connection` treats a pending wake-up as due **now**; lease exclusivity and `next_retry_at` backoff still apply. A trigger clears a wake-up only when a completed round's **discovery** covered it: the cutoff is `outlook_sync_state.wake_cutoff_at`, stamped by the reservation that **starts** a round and carried through every invocation that resumes it — a signal that arrives while finalisation is paused survives the completing invocation and makes the next fresh round due. The routine 900 s interval remains as the catch-up. |
| Schedule | same migration | pg_cron `outlook-worker-tick`, every minute, `net.http_post` to the worker with `Authorization: Bearer <vault outlook_worker_secret>` and the URL from Vault `outlook_worker_url`. **Created inactive**; posts nothing until both Vault secrets exist. |
| Consent gate for unattended operation | `outlookContentConsent.js` (`REQUIRED_BACKGROUND_CONSENT_VERSION`, null today), run gate in `outlookImportRun.js` | **Closed while unconfigured:** with the requirement null, every run is released untouched with `background_consent_not_configured` - no subscription request, no delta read, no body - because nobody can have consented to wording that is not published. Once set, a connection whose recorded `consent_policy_version` differs is released with `background_consent_missing`, before any read and before any subscription request; one that matches proceeds. Recorded consent is never upgraded in place; the account reconnects under the new disclosure. Proven through the real run in `tests/outlook-background-consent-cutover.test.js`. |
| Settings sync status | `get_my_outlook_sync_status()`, `OutlookSyncStatus.jsx`, `outlookSyncStatus.js` | Last successful sync, current activity (live lease / scheduled retry / error / idle), **"A check is due"** whenever mail is signalled or the last round was incomplete (never "Up to date" then), reconnect instruction when `needs_reauth`, listener state, and an activation line that follows the cron job's own `active` flag — no automatic-check promise while it is off. Server clock for relative times. |
| Discoverability | `Sidebar.jsx`, `BottomNav.jsx`, `usePendingSuggestionCount.js` | A Suggestions rail item (desktop) and Review tab (mobile) with a pending badge, gated exactly like the route; the badge polls the pending counts every 30 s while visible, so arrivals are noticed from any page. |
| Queue refresh without losing work | `SuggestionsPage.jsx`, `pendingSuggestions.js` | The page polls the pending **signature** (ids + `updated_at` of both queues) every 30 s while visible and on visibility change; a difference is merged card by card: arrivals inserted in queue order, a refreshed proposal swapped in under a new key, a resolution elsewhere removed — unless that card is **busy** (editing, confirming a dismissal, mid-accept), in which case the update is **held** and applied when the card frees up, and the banner says so. Loaded pages past the first are untouched. No realtime channel. |

Unchanged and relied on: the delta pipeline, cursors, token handling, leases, consent gates,
two-way qualification either way round, cross-round recovery and balanced context,
screening, minimization, deduplication (refresh / `exists_terminal`), the pilot restriction,
review-before-save, and the disconnect cleanup (the subscription record cascades with the
connection).

## 2. Latency target, and how it is measured

**Target (near-real-time, not instant):** a qualifying reply that lands in the mailbox
becomes a reviewable proposal within **5 minutes at p95** and **2 minutes median** (an **unmeasured pilot target**, not a user-facing promise; measured only after activation, over the first 50 signalled runs) while
Funnl is closed, measured over the first 50 signalled runs of the controlled pilot.

Budget behind the target: Microsoft documents message notification latency as under 1
minute on average, 3 minutes maximum; the kick starts the worker within seconds of the
202; the scheduled tick is the ≤60 s fallback; a bounded run with a few conversations
completes in well under a minute.

**Measurement, from persisted data only:**

1. `run.wake_age_seconds` in every worker response — seconds between the recorded wake-up
   (`wake_requested_at`) and the run's reservation. Measures signal → run start.
2. In the database, signal → proposal:
   ```sql
   SELECT c.last_wake_at,
          min(ic.created_at) FILTER (WHERE ic.created_at >= c.last_wake_at) AS first_proposal_after,
          extract(epoch FROM min(ic.created_at) FILTER (WHERE ic.created_at >= c.last_wake_at) - c.last_wake_at) AS seconds
   FROM public.microsoft_connections c
   LEFT JOIN public.interaction_candidates ic ON ic.user_id = c.user_id AND ic.source = 'outlook'
   GROUP BY c.id, c.last_wake_at;
   ```
   (and the same against `new_contact_candidates`).
3. `outlook_subscriptions.last_notification_at` vs `notifications_received`: whether
   Microsoft delivered at all, and how often.

What is NOT measured by Funnl: Microsoft's own delivery delay before the POST arrives.
That is bounded by Microsoft's documented maximum only.

## 3. What is fixture evidence and what is live-provider evidence

Everything verified in this PR runs against **simulated Microsoft answers** — notification
payloads shaped as documented, 201/200/404/409/400 subscription responses, delta pages — and
against the real handlers, the real worker, a real Postgres and a real browser. None of it
shows what Microsoft Graph actually does for this tenant. Live-provider evidence comes only
from the activation plan below, and the plan records each live fact as it is established:

- the endpoint validation handshake succeeds for the deployed URL (step E);
- a message arriving in **Inbox** produces a notification that wakes an automatic run (step F);
- the user **sending an existing draft** (a message created in Sent Items) produces a
  notification that wakes a run — the mailbox-wide subscription is expected to cover it
  (Microsoft also documents folder-level subscriptions, so a Sent Items-only subscription
  would be an alternative if it did not), and this is checked rather than assumed (step F). Note: creating or editing a draft also
  creates a message (in Drafts); such notifications wake a run that finds nothing to do,
  because the normalizer drops drafts. That is a cost, not a correctness issue, and the
  wake counters will show it;
- lifecycle events, if any, are recorded with their kind (`last_lifecycle_event`).

## 4. Rollout dependencies (operational)

1. Apply `20261009000000` (adds `pg_cron`, `pg_net`; the job is inactive).
2. Deploy `outlook-notifications` (new) and `outlook-import-worker` from merged main.
3. Owner stores two Vault secrets through the Supabase dashboard's Vault form (Integrations
   -> Vault -> Add new secret), exactly named `outlook_worker_url`
   (`https://<ref>.supabase.co/functions/v1/outlook-import-worker`) and
   `outlook_worker_secret` (the existing `OUTLOOK_WORKER_SECRET` value; not rotated).
   Verified by names only: `SELECT name FROM vault.secrets WHERE name IN (...)`. No script in
   this repository handles these values.
4. Disclosure publication and fresh consent (section 6).
5. Bootstrap invocation and listener verification (section 6).
6. Activate the tick.

## 5. Known limitations of this slice

- A Graph subscription outlives a disconnect until it expires (≤3 days): the database row
  is gone, so its notifications answer `unknown_subscription` and nothing runs; the
  reconnect path clears the duplicate at Microsoft (409 → list → delete ours → create).
- Without content consent no handles are stored and no proposal is drafted; the wake-up
  still triggers a delta read.
- The notification kick shares `OUTLOOK_WORKER_SECRET` with the scheduled tick.
- A refreshed proposal never replaces a card the reviewer has changed. The update is held,
  the banner and the card say so, and the reviewer's values stay until acceptance, dismissal,
  or the explicit choice "Use newer draft" on that card. "Done editing" closes the fields and
  keeps the values. A card with no changes takes the update as soon as it is free (fields
  closed, no confirmation open, no accept in flight).
- A transient failure of the full-row fetch after the signature poll noticed a change is
  retried on the next poll: the signature checkpoint advances only after the changed rows
  were applied or held.

## 6. Activation plan — the exact steps, in order, nothing interchangeable

Nothing below is done by this PR. Each step names what is verified before the next.

**A. Disclosure publication (owner-approved).** Wording in
`docs/outlook-content-disclosure-draft.md` section F: one "What Funnl would keep" bullet
(the subscription record), one "How a read runs" sentence (automatic reads on a signal
and on a schedule), one just-in-time-notice sentence. Publish the policy text at `/privacy`
and the notice paragraph in `src/lib/outlookDisclosure.js`.

**B. Disclosure-version derivation.** `OUTLOOK_DISCLOSURE_VERSION` is computed from the
notice paragraphs (`computeDisclosureVersion()`), so the new paragraph yields a **new**
`ol-disc-<32 hex>` value; `verifyDisclosureIntegrity()` refuses the control until
`DISCLOSURE_FINGERPRINT` matches the new text. Record the new value in this plan.
**Recorded 2026-10-09:** the published notice derives to `ol-disc-6d1ddd67f51d5b3bfd8d3801c50271a7` (fingerprint `6d1ddd67f51d5b3bfd8d3801c50271a7`).

**C. Server and worker version updates — ONE new value, carried everywhere.** Every
disclosure version is the digest of the ENTIRE notice, and each requirement compares the
stored version to it by exact equality. A connection that reconnects under the changed
notice records the new version; any requirement left at the old one then fails for that
very connection. So the approved value from step B goes, in the same cutover, into:

1. the browser: `OUTLOOK_DISCLOSURE_VERSION` in `src/lib/outlookDisclosure.js` derives it
   from the published paragraphs once `DISCLOSURE_FINGERPRINT` is updated to the new text;
2. the server: the `OUTLOOK_DISCLOSURE_VERSION` secret read by `outlook-oauth-start`, so the
   same value is stamped into new consents (and the control refuses to mint a state until
   the two agree);
3. the worker, all three requirements in `outlookContentConsent.js`:
   `REQUIRED_CONTENT_CONSENT_VERSION`, `REQUIRED_THIRD_PARTY_CONSENT_VERSION` and
   `REQUIRED_BACKGROUND_CONSENT_VERSION`. They remain three independent checks (body
   reading, Anthropic processing, unattended operation) and a later decision may move one
   alone — a notice change is not that decision. Raising only the background requirement
   would open unattended operation while closing body reading and the model path for the
   re-consented account (`tests/outlook-background-consent-cutover.test.js`, "the hazard").

Redeploy `outlook-import-worker`. From then on a connection consented under an older
version is released with `background_consent_missing` — no read, no subscription — until it
reconnects; until this step, with the requirement still null, every run is released with
`background_consent_not_configured` the same way. **Nothing in this PR chooses or
configures the new value**; it is derived from the approved wording, after approval.

**D. Fresh pilot consent.** The pilot disconnects (Settings → Disconnect Outlook) and
reconnects under the new notice. Verify `microsoft_connections.consent_policy_version`
equals the new value. Recorded consent is never edited in place.

**E. Bootstrap window (controlled, authorized separately).** The worker flag
`OUTLOOK_IMPORT_WORKER_ENABLED` is an Edge Function secret, absent until here. It is enabled
for this window only, with the tick still inactive: `scripts/outlook-worker-flag.ps1 status`
(expect `ABSENT (verified)`; `UNVERIFIED` means the inventory could not be read and nothing
proceeds), then `enable` (expect `PRESENT (verified)`; setting the flag executes nothing; an
unverified enable is cleaned up and reported, or reported `UNKNOWN`). ONE
invocation by the existing run-once PowerShell pattern - which removes the flag in its
`finally`, so run `status` afterwards and expect `ABSENT`; if the pattern used does not remove
it, run `disable`. The subscription is created only inside a RESERVED run, so the proof is
`run.outcome` `committed` (or `continued`) **and** `run.subscription.action = create`,
`outcome = created`, **and** an `outlook_subscriptions` row with `status = 'active'` and
`expires_at` about three days out. **`none_due` proves nothing** - no connection was reserved
and no subscription step ran; if the connection's last attempt is under `DUE_AFTER_SECONDS` =
900 s old, wait until it is due and invoke once more (re-enabling the flag the same way). This
is where Microsoft validates the deployed endpoint (first live fact).

**F. Listener-verification window (authorized separately).** No manual invocation inside it:
the endpoint kicks the worker after recording a signal, and with the flag present the worker
runs by itself. Open the window with `scripts/outlook-worker-flag.ps1 enable` (`PRESENT`) and
confirm `SELECT active FROM cron.job WHERE jobname = 'outlook-worker-tick'` is `false`.

Take a **baseline** of the persistent fields before any signal, and wait for any run in
progress to finish first (both folders `idle`, lease NULL):

```sql
SELECT folder, sync_status, sync_lease_until, last_attempt_at, last_success_at, last_run_complete
  FROM public.outlook_sync_state s JOIN public.microsoft_connections c ON c.id = s.connection_id
 WHERE c.user_id = '<pilot user id>' ORDER BY folder;
SELECT wake_requested_at, wake_count, last_wake_at FROM public.microsoft_connections WHERE user_id = '<pilot user id>';
```

Then, for an inbound message sent to the pilot mailbox from another account, the **persistent
evidence** is: `wake_count` greater than the baseline and `last_wake_at` set (the endpoint accepted the
signal; `wake_count` need only be GREATER than the baseline - a draft or a retry can add more
than one); on both folder rows `last_attempt_at` and `last_success_at` later than the baseline,
`last_run_complete = true`, `sync_status = 'idle'`, `sync_lease_until` NULL (the kicked run
ran to completion and released its lease); `wake_requested_at` NULL again (consumed by the
run it woke). A completed run clears `run_started_at`, so that column is not part of the
proof. **Wait for the run to finish** and take a fresh baseline, then repeat by **sending an
existing draft** from the pilot mailbox (Sent Items): the same evidence must follow. Only
after both signals are evidenced does activation continue.

If a signal is recorded but no run follows (`wake_requested_at` stays set, `last_attempt_at`
unchanged), the kick is the thing to diagnose - flag state, `not_enabled` answers in the
worker's function log, the Vault names - and nothing is activated. If verification fails or
stops: `scripts/outlook-worker-flag.ps1 disable` (`ABSENT`); kicks then answer `503
not_enabled`, and recorded wake-ups stay pending for the first run after a later re-enable.
Close the window with `disable` unless step G is authorized immediately (say which).

**G. Activate.** `scripts/outlook-worker-flag.ps1 enable` (unattended operation needs the
flag), then `SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname =
'outlook-worker-tick'), active := true);` Then the live acceptance test: with Funnl closed, a
fresh two-way exchange produces a reviewable proposal within the target; the user accepts
it in Funnl; `wake_age_seconds` and the SQL above record the latency.

**Rollback — stopping both triggers.**
1. `SELECT cron.alter_job(<jobid>, active := false);` stops scheduled execution.
2. `scripts/outlook-worker-flag.ps1 disable`: every tick and every kick answers `503 not_enabled`
   and runs nothing; the pilot's connection, tokens and cursors are untouched.
3. The Graph subscription keeps posting notifications until it expires (≤3 days from its
   last renewal): the endpoint records wake-ups (harmless timestamps/counts) and kicks a
   worker that refuses. To stop the endpoint too, unset `OUTLOOK_INTEGRATION_ENABLED`: the
   endpoint answers 503, Microsoft retries for up to 4 hours then drops, and the
   subscription expires on its own. Nothing deletes it at Microsoft — a later run (if ever
   re-enabled) would renew or recreate it.
4. A re-enable later recreates the subscription if it expired (`planSubscriptionAction`:
   expired → create).

## 7. Next workstreams, with completion criteria (not in this slice)

**A. Detailed conversation notes.** *Status 2026-10-10: IN PROGRESS, prepared and unapplied.*
Two separate things, and only one of them has shipped:

- **The user-written reviewed note — DEPLOYED** (`20261010120000`): both editors, client
  validation and both acceptance RPCs accept up to 10,000 characters with paragraphs, line
  breaks and tabs, saved exactly into `interactions.notes`.
- **The AI-generated draft — PREPARED, NOT APPLIED.** `docs/outlook-detailed-ai-notes.md` and
  migration `20261010180000` raise the generated-note ceiling from 200 to 2,000 characters
  across the prompt, schema, output budget, validator, three column CHECKs and both producer
  RPCs, and instruct the model to record the topics, advice, offers, commitments, named dates,
  next steps and open questions the messages state. Every note tested is a FIXTURE: the
  evidence is that a detailed note survives the whole path intact, not that the model writes a
  good one. Nothing is applied, deployed or published; the policy wording and the ordered
  rollout await owner approval.

This item is done when the drafted note states the concrete facts
of the exchange — who offered what, dates and places named, commitments made, the next
step — each traceable to the message text (evidence codes extended to name what each fact
rests on), with the reviewer able to see and edit the whole of it on the card and in the
saved interaction. Raising the summary ceiling (today 200 characters) is a consequence of
that, not the deliverable: a longer vague note does not complete this item, and a new cap
alone is not a completion criterion. The draft contract bounds, the column limit (migration
with a marker-strip diff) and the privacy wording move together with the content change.
Verified through the real handler against the model contract and in the browser harness.

**B. Broader metadata extraction.** Done when: company, role and how-met are proposed for a
new contact only with an evidence code and confidence, start blank unless `high`, are
shown as editable fields on the card, and the privacy "What Funnl would keep" list names
them as stored-when-inferred. Verified by handler tests for each evidence path and a SQL
proof that low-confidence values are never written.

**C. School / Education.** Done when: an `education` field exists on contacts (migration),
the draft contract may propose it with evidence, the card and contact detail show and edit
it, CSV import maps common headers to it, and the disclosure/policy name it.

**D. Later interaction episodes within an accepted thread.** Done when: a reply that arrives
after the user accepted an exchange produces a *new* pending interaction suggestion for the
same contact (a new episode anchored on the first message after the accepted one) rather
than `exists_terminal`, without resurrecting the accepted row, with the episode boundary
rule stated in the design doc and proven through the real handler across rounds and in SQL.

**E. Multi-account / beyond the pilot.** Done when the pilot restriction is lifted by a
separate decision with its own privacy review; not started.
