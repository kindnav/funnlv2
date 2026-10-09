# Outlook background sync — owner packet: disclosure wording and ordered activation

Status (2026-10-09): **steps 1, 2 and 4 done; step 3 open; steps 5-10 pending.** Step 1:
migration `20261009000000` applied and catalog-verified. Step 2: PR #76 merged as `4bc50c8`
(pinned to the approved head `505523f`), `outlook-notifications` v1 and `outlook-import-worker`
v40 deployed, closures byte-identical. Step 3: the Vault on `jzybxhvgnksrwxfivdwt` still holds
no rows - the entries saved through the dashboard were not found on this project; reconciliation
of the dashboard URL is pending. Step 4: the section-2 wording is published; the published notice
derives to `ol-disc-6d1ddd67f51d5b3bfd8d3801c50271a7`. No version configured anywhere yet, no subscription, no schedule
active, no invocation made. Each remaining step is approved and performed in order.

Source documents, which this packet summarizes and defers to on detail:
`docs/outlook-content-disclosure-draft.md` section F (wording rationale) and
`docs/outlook-background-sync-plan.md` sections 2, 3 and 6 (target, evidence rules, plan).

Owner-run helper added for this packet (operator tooling only; no product code):
`scripts/outlook-worker-flag.ps1` (the worker flag: status / enable / disable, each verified
against the JSON secret inventory; exercised offline against a synthetic CLI by
`tests/local/outlook-worker-flag-helper.test.ps1`). Vault secrets are entered through the
Supabase dashboard's Vault form; no credential-handling script exists in this repository.

---

## 1. The milestone

**Automatic, editable networking suggestions while Funnl is closed.** Concretely, for the one
pilot account: the user exchanges mail with someone (either side may write first); within
minutes, with Funnl closed, a suggestion is waiting under Suggestions — an interaction for a
contact already in Funnl, or a contact-plus-interaction for someone new, carrying both sides'
context; the user reviews and edits it; pressing Accept saves the contact and/or interaction
with the user's values. Nothing is saved before that.

Everything up to acceptance is already demonstrated against fixtures shaped as Microsoft
documents, the real handlers and worker, a real Postgres and a real browser (PR #76). This
packet adds the live-provider evidence only the pilot mailbox can give, in order.

---

## 2. The exact disclosure wording (for approval)

Three insertions into the published Outlook disclosure, reproduced exactly as they would be
published.

### 2a. Under "What Funnl would keep" — one new bullet (keep)

> a record of the mail-change subscription Funnl holds with Microsoft for your mailbox: the
> identifier Microsoft assigns it, when it expires, when Microsoft last signalled a change,
> how many signals have arrived, and a one-way hash of the secret Funnl uses to recognise
> Microsoft's signals; plus, on the connection itself, the time and kind of the most recent
> signal. A signal tells Funnl only that your mailbox changed; Funnl does not store the
> message identifier it carries.

### 2b. Under "How a read runs" — two sentences

> Funnl asks Microsoft to notify its servers when new mail arrives, and aims to start a
> check within a few minutes of that signal; it also runs a routine check, normally about
> every fifteen minutes, in case a signal was missed. These checks run automatically on
> Funnl's servers while Funnl is closed; nothing runs in your browser.

### 2c. In the just-in-time notice, offline_access paragraph — one sentence

> Funnl also asks Microsoft to tell its servers when new mail arrives, so a check can start
> automatically within minutes while Funnl is closed.

### 2d. Recommendations on the open wording questions

| Question | Recommendation |
|---|---|
| Keep the subscription-storage bullet (2a)? | **Yes.** It is a stored record with an identifier; it belongs under "What Funnl would keep". |
| How to describe timing | Notification-triggered checks **aim to start within minutes**; routine checks run **normally about every fifteen minutes** (the routine interval is 900 s). Neither is promised as a guarantee. |
| Automatic while closed | Stated plainly in 2b and 2c: checks run automatically on Funnl's servers while Funnl is closed. |
| The five-minute figure | **Not in the user-facing wording.** "Five minutes at p95 / two minutes median" is an **unmeasured pilot target** (plan section 2); it is measured only after step 9, over the first 50 signalled runs, and the wording makes no numeric promise. |
| Anything else | Nothing proposed. No new category of message data is read or stored by this slice. |

Deliberately absent from the wording: any claim that Sent Items specifically is read (the
mailbox-wide subscription is expected to cover Inbox and Sent Items; the sent-draft case is
verified live in step 8, not asserted), and anything about the subsequent workstreams.

---

## 3. The corrected ordered activation

Nothing below is interchangeable. The cron job stays **inactive** until step 9 is
authorized; the worker flag is **absent** except inside the two windows named in steps 7-8.

### Step 1 — Apply migration `20261009000000`
Owner, CLI: `npx supabase migration list --linked` shows exactly one pending migration;
`npx supabase db push --linked`.
**Evidence:** `reserve_due_outlook_connection` one overload, service_role only;
`record_outlook_change_notification`, `record_outlook_change_notification_batch`,
`record_outlook_subscription_state` service_role only; `get_my_outlook_sync_status()`
authenticated only; `cron.job` row `outlook-worker-tick` with `active = false`;
`outlook_subscriptions` RLS on; `outlook_sync_state.wake_cutoff_at` present. The queries are in
the migration's own comments.

### Step 2 — Merge PR #76; deploy both functions
Owner, CLI: `npx supabase functions deploy outlook-notifications --project-ref
jzybxhvgnksrwxfivdwt --use-api` and the same for `outlook-import-worker`, from merged main
(`verify_jwt=false` for both from `config.toml`).
**Evidence:** `npx supabase functions download <name>` sources byte-identical to main. The
worker flag is absent: every tick, kick or invocation answers `503 not_enabled`.

### Step 3 — Vault secrets, through the dashboard form
Owner, in the Supabase dashboard: Integrations → Vault → "Add new secret", twice, with
exactly these names:

| Name | Value |
|---|---|
| `outlook_worker_url` | `https://jzybxhvgnksrwxfivdwt.supabase.co/functions/v1/outlook-import-worker` |
| `outlook_worker_secret` | the existing `OUTLOOK_WORKER_SECRET` value, typed into the form's secret field; **not rotated** |

The form is a private browser input: the value is not pasted into chat, not typed on a
command line, not written to a file. No script in this repository handles these values.
**Evidence (names only, nothing decrypted):**
`SELECT name FROM vault.secrets WHERE name IN ('outlook_worker_url', 'outlook_worker_secret') ORDER BY name;`
returns exactly the two names. (The inactive job still posts nothing.)

### Step 4 — Publish the approved wording
Owner approval of section 2, then a PR: `/privacy` text and the notice paragraph in
`src/lib/outlookDisclosure.js`; `DISCLOSURE_FINGERPRINT` updated to the new text.
**Evidence:** `verifyDisclosureIntegrity()` true; `computeDisclosureVersion()` yields a **new**
`ol-disc-<32 hex>`; recorded in the plan.

### Step 5 — Carry that one value everywhere, in one cutover
Owner: set the server secret `OUTLOOK_DISCLOSURE_VERSION` (`npx supabase secrets set
OUTLOOK_DISCLOSURE_VERSION=<new value> --project-ref jzybxhvgnksrwxfivdwt` — the value is a
public digest, not a credential); in `outlookContentConsent.js` set all three of
`REQUIRED_CONTENT_CONSENT_VERSION`, `REQUIRED_THIRD_PARTY_CONSENT_VERSION`,
`REQUIRED_BACKGROUND_CONSENT_VERSION` to it; redeploy `outlook-import-worker`.
**Why all three:** each is compared to the digest of the whole notice; a requirement left
behind closes body reading or Anthropic processing for the account that just re-consented
(`tests/outlook-background-consent-cutover.test.js`). Until this step the background gate is
closed (`background_consent_not_configured`): no subscription, no read.
**Evidence:** the three constants and the secret equal the derived version.

### Step 6 — Fresh pilot consent
Pilot: Settings → Disconnect Outlook, then reconnect under the new notice.
**Evidence:** `microsoft_connections.consent_policy_version` equals the new version. Recorded
consent is never edited in place.

### Step 7 — Bootstrap window (controlled, authorized separately)
The flag is enabled for this window only and disabled at its end; the cron job stays inactive.

1. `.\scripts\outlook-worker-flag.ps1 status` → `ABSENT (verified)`. The helper reads the
   JSON secret inventory; empty, malformed or failed output is reported `UNVERIFIED`, never
   absent, and the step does not proceed on it.
2. `.\scripts\outlook-worker-flag.ps1 enable` → `PRESENT (verified)`. Setting the flag executes
   nothing. If the set succeeds but is not verified, the helper removes the flag again and
   reports the verified result (exit 1), or `UNKNOWN` (exit 2) if even that cannot be
   verified - in which case check Edge Functions → Secrets in the dashboard before anything else.
3. ONE invocation by the existing run-once PowerShell pattern. **Note:** that pattern removes
   `OUTLOOK_IMPORT_WORKER_ENABLED` in its `finally`, which is right for this step (the window
   closes with the invocation) — so after it returns, run `status` and expect `ABSENT (verified)`.
   If the pattern used does not remove it, run `disable` yourself and require `ABSENT (verified)`.
4. The proof is a run that **reserved** the connection: `run.outcome` `committed` (or
   `continued`) **and** `run.subscription.action = create`, `outcome = created`, **and** an
   `outlook_subscriptions` row with `status = 'active'` and `expires_at` about three days out.
   **`none_due` proves nothing** — no connection was reserved and no subscription step ran. If
   the connection's last attempt is under 900 s old, wait until it is due and invoke once more
   (re-enable the flag for that one invocation the same way).

This is where Microsoft validates the deployed endpoint — **live fact 1**.

### Step 8 — Listener-verification window (authorized separately)
A separate, bounded window. No manual invocation inside it: once a notification is recorded,
the endpoint kicks the worker, and with the flag present the worker runs by itself.

**Open the window:** `.\scripts\outlook-worker-flag.ps1 enable` → `PRESENT (verified)`. Confirm
the cron job is still inactive: `SELECT active FROM cron.job WHERE jobname = 'outlook-worker-tick';` → `false`.

**Baseline, before any signal** (record the values):
```sql
SELECT folder, sync_status, sync_lease_until, last_attempt_at, last_success_at, last_run_complete
  FROM public.outlook_sync_state s JOIN public.microsoft_connections c ON c.id = s.connection_id
 WHERE c.user_id = '<pilot user id>' ORDER BY folder;
SELECT wake_requested_at, wake_count, last_wake_at FROM public.microsoft_connections WHERE user_id = '<pilot user id>';
```
Expect: both folders `sync_status = 'idle'`, `sync_lease_until` NULL, `wake_requested_at` NULL.
If a run is in progress (`running`, or a lease in the future), **wait for it to finish** first.

**Signal A — inbound mail.** Another account sends a message to the pilot mailbox. Within
Microsoft's documented latency (under a minute on average, three at most) and then about a
minute for the kick, re-run the two queries. **Persistent evidence of success:**
- `wake_count` **greater than** the baseline and `last_wake_at` set (the endpoint accepted the
  signal; a draft being created or a retry can add more than one) — **live fact 2**;
- on both folder rows: `last_attempt_at` later than the baseline, `last_success_at` later than
  the baseline, `last_run_complete = true`, `sync_status = 'idle'`, `sync_lease_until` NULL
  (the kicked run ran to completion and released its lease);
- `wake_requested_at` is NULL again (the signal was consumed by the run it woke).
A completed run clears `run_started_at`, so it is **not** part of the proof; the fields above
persist.

**Wait for the run to finish** (both folders `idle`, lease NULL, `last_run_complete = true`)
and take a fresh baseline before the next signal.

**Signal B — the pilot sends an existing draft** from the mailbox (Sent Items). Re-run the two
queries. Same persistent evidence: `wake_count` greater than the fresh baseline, `last_wake_at` advanced, both folder rows
attempted and succeeded after the new baseline, complete, idle, lease NULL, `wake_requested_at`
NULL — **live fact 3**. A proposal appears if the exchange qualifies.

**If a signal is recorded but no run follows** within a few minutes (`wake_requested_at` stays
set, `last_attempt_at` unchanged): the kick is the thing to diagnose — flag state (`status`),
`not_enabled` answers in the worker's function log, the Vault names — and nothing is activated.
**If verification fails or stops for any reason:** `.\scripts\outlook-worker-flag.ps1 disable`
→ `ABSENT (verified)`. If it reports `PRESENT` or `UNKNOWN` instead, the window is NOT closed:
check Edge Functions → Secrets in the dashboard and remove the flag by hand before leaving.
From then on kicks answer `503 not_enabled`; recorded wake-ups stay pending and are served by
the first run after a later re-enable.

**Close the window:** after both signals are evidenced, `.\scripts\outlook-worker-flag.ps1
disable` → `ABSENT (verified)` until step 9 is authorized. (If step 9 is authorized immediately, the flag
may instead stay present; say which in the authorization.)

### Step 9 — Activate the schedule
Owner: `.\scripts\outlook-worker-flag.ps1 enable` → `PRESENT (verified)` (unattended operation
needs the flag), then
`SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'outlook-worker-tick'), active := true);`
**Evidence:** `cron.job.active = true`; the next minute's tick posts to the worker; Settings'
automation line now says automatic checks are on.

### Step 10 — Live acceptance (the milestone)
Pilot, with Funnl closed: a fresh two-way exchange; a suggestion appears; the pilot opens
Funnl, edits and accepts it.
**Evidence:** the suggestion is editable and carries both sides' context; acceptance saves the
contact and/or interaction with the reviewed values; latency from the SQL in plan section 2
(`created_at` against `last_wake_at`). Measuring the unmeasured target (5 min p95 / 2 min
median) begins here, over the first 50 signalled runs.

### Rollback at any point after step 7
1. `SELECT cron.alter_job(<jobid>, active := false);` — stops scheduled execution.
2. `.\scripts\outlook-worker-flag.ps1 disable` → `ABSENT (verified)` — every tick, kick and
   invocation answers `503 not_enabled`; the pilot's connection, tokens and cursors are untouched.
3. The Graph subscription keeps posting until it expires (at most three days from its last
   renewal): the endpoint records harmless timestamps and counts and kicks a worker that
   refuses. To silence the endpoint too, unset `OUTLOOK_INTEGRATION_ENABLED` (503; Microsoft
   retries for up to four hours, then drops). Nothing deletes the subscription at Microsoft; a
   later re-enable renews or recreates it.
4. Consent is not rolled back: a published notice stays published, and the three requirements
   stay at the new version.

---

## 4. Evidence: demonstrated versus live

**Independently demonstrated** (PR #76): durable acknowledgement of notifications; wake-ups
surviving continued rounds; the subscription step inside the reserved run; the consent gates
closed while unconfigured and across the cutover; the queue refreshing without disturbing
review work; Settings' status; acceptance saving the reviewer's values; the content flow end
to end against a real Postgres.

**Only the live steps can establish:** the validation handshake for the deployed URL (step 7);
an inbound message producing a signal and an automatic run (step 8, signal A); a sent draft
producing a signal and an automatic run (step 8, signal B); lifecycle events, if any, recorded
by kind; and the latency figures themselves (step 10 onward).

---

## 5. Boundaries that stay in force

- Single-account pilot restriction; Google Calendar off the UI.
- Review before save: no contact or interaction is written without the user pressing Accept.
- `OUTLOOK_WORKER_SECRET` is never shown, pasted, logged or rotated by any step here; the
  flag helper prints the one flag name and a state word, never a value or digest.
- No message content is stored by this slice; the signal's message identifier is not kept.

---

## 6. Subsequent product workstreams (after the milestone)

Completion criteria are in plan section 7; listed so they are not confused with this packet.

- **Detailed conversation notes** — concrete facts of the exchange, each traceable to the
  text; a larger character cap is a consequence, not the deliverable.
- **Broader evidence-backed metadata** — company, role, how-met with an evidence code and
  confidence; low confidence is never written.
- **School / Education** — contact field, draft contract, card, CSV import, disclosure.
- **Later interactions within an accepted thread** — a reply after acceptance becomes a new
  pending suggestion rather than `exists_terminal`.
