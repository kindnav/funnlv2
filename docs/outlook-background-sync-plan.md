# Outlook background sync — implementation plan and completion criteria

Status: **implemented in a Draft PR, nothing applied or deployed** (base `main` =
`f1c95bc7e01532f4fe9465b5faa5f8341b8827fa`, the PR #75 merge).

The product goal this serves: Funnl removes manual networking data entry. It detects a
meaningful two-way exchange whichever person started it, prepares a contact-plus-interaction
or interaction proposal with both sides' context, and lets the user review before anything is
saved. The manual PowerShell pilot proved the pipeline; it was never the user experience.
This slice makes the pipeline run on its own and makes its output discoverable.

## 1. What this slice adds

| Piece | Where | What it does |
|---|---|---|
| Change-notification subscription | `supabase/functions/shared/outlookSubscriptions.js`, worker step in `outlookImportRun.js` | One Graph subscription per connection on `me/messages` / `created` (covers Inbox and Sent Items; Microsoft documents no Sent Items-specific path). Created on the first run under the lease, renewed when under 24 h remain or Microsoft asks for reauthorization, recreated when removed. 3-day lifetime (documented ceiling 10,080 min). ClientState: 32 random bytes; **only its SHA-256 is stored**. |
| Notification endpoint | `supabase/functions/outlook-notifications/` (`verify_jwt=false`) | Answers Microsoft's validation handshake (200 text/plain, decoded token). Parses a batch to subscription id + clientState + kind only (never `resourceData`). Database matches id and hash; a match records a **durable wake-up** on the connection. Answers 202 within the 3-second window, then kicks the worker off the response path (`EdgeRuntime.waitUntil`). Refusals (unknown id, wrong hash, inactive connection, malformed) are acknowledged and dropped — no retry storm, no wake-up. |
| Wake-up + eligibility | migration `20261009000000` | `microsoft_connections.wake_requested_at/wake_source/wake_count/last_wake_at`. `reserve_due_outlook_connection` treats a pending wake-up as due **now**; lease exclusivity and `next_retry_at` backoff still apply. A trigger on `outlook_sync_state` clears a wake-up only when a run that STARTED AFTER it completes — so a signal arriving during a run stays pending. The routine 900 s interval remains as the catch-up. |
| Schedule | same migration | pg_cron `outlook-worker-tick`, every minute, `net.http_post` to the worker with `Authorization: Bearer <vault outlook_worker_secret>` and the URL from Vault `outlook_worker_url`. **Created inactive**; posts nothing until both Vault secrets exist. The worker itself refuses `not_enabled` while its flag is off. |
| Settings sync status | `get_my_outlook_sync_status()`, `src/components/OutlookSyncStatus.jsx`, `src/lib/outlookSyncStatus.js` | Last successful sync, current activity (live lease / scheduled retry / error / idle), reconnect instruction when `needs_reauth`, listener state and renewal, pending count. Server clock for relative times. Refreshed every 60 s while visible. |
| Discoverability | `Sidebar.jsx`, `BottomNav.jsx`, `usePendingSuggestionCount.js`, `pendingSuggestions.js` | A Suggestions rail item (desktop) and Review tab (mobile) with a pending badge, gated exactly like the route (`SUGGESTION_REVIEW_ENABLED`). |
| Queue refresh | `SuggestionsPage.jsx` | A bounded head-count poll of both pending queues every 30 s while the tab is visible, plus on visibility change; a changed count reloads the first page and announces an increase. No realtime channel. |

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

## 3. Rollout dependencies (operational)

1. Apply `20261009000000` (adds `pg_cron`, `pg_net`; the job is inactive).
2. Deploy `outlook-notifications` (new) and `outlook-import-worker` from merged main.
3. Owner stores two Vault secrets by hidden input: `outlook_worker_url`
   (`https://<ref>.supabase.co/functions/v1/outlook-import-worker`) and
   `outlook_worker_secret` (the existing `OUTLOOK_WORKER_SECRET` value; not rotated).
4. Set `OUTLOOK_IMPORT_WORKER_ENABLED=true`; the first run creates the subscription, which
   validates the deployed endpoint.
5. Activate the tick: `SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname =
   'outlook-worker-tick'), active := true);`
6. Live acceptance test: a fresh two-way exchange with the pilot mailbox produces a
   reviewable proposal while Funnl is closed, without PowerShell; the user accepts it in
   Funnl; `wake_age_seconds` and the SQL above record the latency.

## 4. Known limitations of this slice

- A Graph subscription outlives a disconnect until it expires (≤3 days): the database row
  is gone, so its notifications answer `unknown_subscription` and nothing runs; the
  reconnect path clears the duplicate at Microsoft (409 → list → delete ours → create).
- Without content consent no handles are stored and no proposal is drafted; the wake-up
  still triggers a delta read.
- Subscription metadata and background processing need a disclosure review before
  rollout — see `docs/outlook-content-disclosure-draft.md`, section F (draft wording).
- The browser harness simulates arrival by inserting a pending row; it does not run the
  worker. The worker step and the notification endpoint are proven through their real
  handlers with simulated Microsoft answers, and the eligibility/consumption rules against
  a real Postgres. Live-provider evidence comes only from the controlled pilot.

## 5. Next workstreams, with completion criteria (not in this slice)

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
