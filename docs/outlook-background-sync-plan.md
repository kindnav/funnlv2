# Outlook background sync — implementation plan, activation plan and completion criteria

Status: **implemented in Draft PR #76, nothing applied or deployed** (base `main` =
`f1c95bc7e01532f4fe9465b5faa5f8341b8827fa`, the PR #75 merge).

The product goal this serves: Funnl removes manual networking data entry. It detects a
meaningful two-way exchange whichever person started it, prepares a contact-plus-interaction
or interaction proposal with both sides' context, and lets the user review before anything is
saved. The manual PowerShell pilot proved the pipeline; it was never the user experience.
This slice makes the pipeline run on its own and makes its output discoverable.

## 1. What this slice adds

| Piece | Where | What it does |
|---|---|---|
| Change-notification subscription | `supabase/functions/shared/outlookSubscriptions.js`, worker step in `outlookImportRun.js` | One Graph subscription per connection on `me/messages` / `created`. Microsoft documents two message resources: the whole mailbox (`/me/messages`) and the Inbox folder (`/me/mailFolders('inbox')/messages`); there is no Sent Items-specific resource, so the mailbox-wide one is used and covers Inbox **and** Sent Items. Created on the first run under the lease, renewed when under 24 h remain or Microsoft asks for reauthorization, recreated when removed. 3-day lifetime (documented ceiling 10,080 min). ClientState: 32 random bytes; **only its SHA-256 is stored**. |
| Notification endpoint | `supabase/functions/outlook-notifications/` (`verify_jwt=false`) | Answers Microsoft's validation handshake (200 text/plain, decoded token). Parses a batch to subscription id + clientState + kind only (never `resourceData`). **One** database call per POST (`record_outlook_change_notification_batch`) matches id and hash and records a durable wake-up. The whole ingress path — body read and persistence — is raced against a 2.5 s budget. **202 only when every item got a definitive answer** (accepted, or refused for a reason a retry cannot change); **503** when the batch could not be durably recorded (port failure, unknown shape, budget exhausted), which Microsoft retries; redelivery is idempotent. Kicks the worker off the response path after persistence. |
| Wake-up + eligibility | migration `20261009000000` | `microsoft_connections.wake_requested_at/wake_source/wake_count/last_wake_at`. `reserve_due_outlook_connection` treats a pending wake-up as due **now**; lease exclusivity and `next_retry_at` backoff still apply. A trigger clears a wake-up only when a completed round's **discovery** covered it: the cutoff is `outlook_sync_state.wake_cutoff_at`, stamped by the reservation that **starts** a round and carried through every invocation that resumes it — a signal that arrives while finalisation is paused survives the completing invocation and makes the next fresh round due. The routine 900 s interval remains as the catch-up. |
| Schedule | same migration | pg_cron `outlook-worker-tick`, every minute, `net.http_post` to the worker with `Authorization: Bearer <vault outlook_worker_secret>` and the URL from Vault `outlook_worker_url`. **Created inactive**; posts nothing until both Vault secrets exist. |
| Consent gate for unattended operation | `outlookContentConsent.js` (`REQUIRED_BACKGROUND_CONSENT_VERSION`, null today), run gate in `outlookImportRun.js` | Once set, a connection whose recorded `consent_policy_version` differs is released untouched with `background_consent_missing` before any read and before any subscription request. Recorded consent is never upgraded in place; the account reconnects under the new disclosure. |
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
becomes a reviewable proposal within **5 minutes at p95** and **2 minutes median** while
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

- the endpoint validation handshake succeeds for the deployed URL (step 6);
- a message arriving in **Inbox** produces a notification that wakes a run (step 8);
- the user **sending an existing draft** (a message created in Sent Items) produces a
  notification that wakes a run — the mailbox-wide subscription is expected to cover it,
  and this is checked rather than assumed (step 8). Note: creating or editing a draft also
  creates a message (in Drafts); such notifications wake a run that finds nothing to do,
  because the normalizer drops drafts. That is a cost, not a correctness issue, and the
  wake counters will show it;
- lifecycle events, if any, are recorded with their kind (`last_lifecycle_event`).

## 4. Rollout dependencies (operational)

1. Apply `20261009000000` (adds `pg_cron`, `pg_net`; the job is inactive).
2. Deploy `outlook-notifications` (new) and `outlook-import-worker` from merged main.
3. Owner stores two Vault secrets by hidden input: `outlook_worker_url`
   (`https://<ref>.supabase.co/functions/v1/outlook-import-worker`) and
   `outlook_worker_secret` (the existing `OUTLOOK_WORKER_SECRET` value; not rotated).
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
- A refreshed proposal is applied to a card the reviewer is editing only after they finish
  editing (the typed values are then replaced by the newer draft — the banner says an
  update is waiting; accepting first keeps the typed values).

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

**C. Server and worker version updates.** Set the server-side `OUTLOOK_DISCLOSURE_VERSION`
secret to the new value (so `outlook-oauth-start` stamps it into new consents). Set
`REQUIRED_BACKGROUND_CONSENT_VERSION` in `outlookContentConsent.js` to the new value and
redeploy `outlook-import-worker`; from then on, a connection consented under an older
version is released with `background_consent_missing` — no read, no subscription — until it
reconnects. (`REQUIRED_CONTENT_CONSENT_VERSION` / `REQUIRED_THIRD_PARTY_CONSENT_VERSION`
are raised to the same value only if the content paragraphs changed; section F changes
only the background paragraph, so they stay unless the owner decides otherwise.)

**D. Fresh pilot consent.** The pilot disconnects (Settings → Disconnect Outlook) and
reconnects under the new notice. Verify `microsoft_connections.consent_policy_version`
equals the new value. Recorded consent is never edited in place.

**E. Bootstrap invocation (controlled, authorized separately).** Setting
`OUTLOOK_IMPORT_WORKER_ENABLED=true` executes nothing by itself. With the flag set and the
tick still inactive, the owner runs ONE invocation (the existing hidden-input PowerShell
pattern, `OUTLOOK_WORKER_SECRET` not shown). Expected: `run.outcome` `committed` or
`none_due` with `run.subscription.action = create`, `outcome = created`, and
`outlook_subscriptions.status = 'active'` with an `expires_at` about three days out. This
is where Microsoft validates the deployed endpoint (first live fact).

**F. Listener verification before unattended operation.** With the tick still inactive:
send a message to the pilot mailbox from another account; within Microsoft's documented
latency, `wake_count` increments and `last_wake_at` is set (the endpoint accepted a
notification); then the owner runs one invocation and observes `wake_age_seconds` and a
proposal if the exchange qualifies. Repeat by **sending an existing draft** from the pilot
mailbox (Sent Items): `wake_count` must increment again. Only after both signals are
observed does activation continue.

**G. Activate.** `SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname =
'outlook-worker-tick'), active := true);` Then the live acceptance test: with Funnl closed, a
fresh two-way exchange produces a reviewable proposal within the target; the user accepts
it in Funnl; `wake_age_seconds` and the SQL above record the latency.

**Rollback — stopping both triggers.**
1. `SELECT cron.alter_job(<jobid>, active := false);` stops scheduled execution.
2. Unset `OUTLOOK_IMPORT_WORKER_ENABLED`: every tick and every kick answers `503 not_enabled`
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

**A. Detailed notes.** Done when: the drafted note carries the concrete facts of the
exchange (who offered what, dates named, next steps) in up to 500 characters, the draft
contract bounds and evidence codes are extended accordingly, the migration raises the
column limit with a marker-strip diff, and the reviewer sees the longer note in the card
and in the saved interaction. Verified through the real handler against the model contract
and in the browser harness.

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
