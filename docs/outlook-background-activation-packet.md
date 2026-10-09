# Outlook background sync — owner packet: disclosure wording and ordered activation

Status: **for owner review. Nothing in this packet has been done.** Draft PR #76 holds the
code; Production is unchanged (no migration applied, no function deployed, no wording
published, no version configured, no subscription created, no schedule active, no
invocation made). This packet exists so that each of those steps can be approved and
performed in order, with its verification named before the next begins.

The two source documents it draws from, and defers to on detail:
`docs/outlook-content-disclosure-draft.md` section F (the wording) and
`docs/outlook-background-sync-plan.md` sections 3 and 6 (the plan and its evidence rules).

---

## 1. The milestone this packet reaches

**A fresh two-way exchange automatically produces an editable suggestion while Funnl is
closed, and acceptance saves the reviewed contact and interaction.**

Concretely, for the one pilot account: the user exchanges mail with someone (either side
may write first); within minutes, with Funnl closed, a suggestion is waiting under
Suggestions — an interaction for a contact already in Funnl, or a contact-plus-interaction
for someone new, with both sides' context; the user reviews and edits it; pressing Accept
saves the contact and/or interaction with the user's values; nothing is saved before that.

Everything up to acceptance is already proven against fixtures, real handlers, a real
Postgres and a real browser (PR #76). What this packet adds is the live-provider evidence
that only the pilot mailbox can give, taken in the order below.

---

## 2. The exact disclosure wording (for approval)

Three insertions into the published Outlook disclosure. The text is reproduced here
exactly as it would be published; the full rationale is section F of the draft.

### 2a. Under "What Funnl would keep" — one new bullet

> a record of the mail-change subscription Funnl holds with Microsoft for your mailbox: the
> identifier Microsoft assigns it, when it expires, when Microsoft last signalled a change,
> how many signals have arrived, and a one-way hash of the secret Funnl uses to recognise
> Microsoft's signals; plus, on the connection itself, the time and kind of the most recent
> signal. A signal tells Funnl only that your mailbox changed; Funnl does not store the
> message identifier it carries.

### 2b. Under "How a read runs" — two sentences

> Funnl asks Microsoft to notify its servers when new mail arrives, and starts a check
> within a few minutes of that signal; it also checks about every fifteen minutes in case
> a signal was missed. Checks run on Funnl's servers whether or not Funnl is open; nothing
> runs in your browser.

### 2c. In the just-in-time notice, offline_access paragraph — one sentence

> Funnl also asks Microsoft to tell its servers when new mail arrives, so a check can run
> within minutes while Funnl is closed.

### 2d. What the owner is asked to decide about the wording

| Decision | Recommendation |
|---|---|
| Where the subscription bullet goes | Under "What Funnl would keep": it is a stored record with an identifier. |
| "within minutes" | Keep. Measured target 5 min p95 / 2 min median; Microsoft documents its own delivery as under a minute on average, three at most. |
| "about every fifteen minutes" | Keep; it is the routine interval (`DUE_AFTER_SECONDS` = 900) and the only fallback claim made. |
| Anything else the notice should say | Nothing proposed. No new data category is read; no message content is stored by this slice. |

**What is deliberately not in the wording:** any claim that Funnl reads Sent Items
specifically (the mailbox-wide subscription covers Inbox and Sent Items; the sent-draft
case is verified live below, not asserted), and any claim about future workstreams.

---

## 3. The ordered activation — each step with its gate

Nothing below is interchangeable. Each step names what is verified before the next
begins, and who performs it.

| # | Step | Performed by | Verified before moving on |
|---|---|---|---|
| 1 | **Apply migration `20261009000000`** (`supabase db push --linked`, one pending migration) | owner, CLI | `reserve_due_outlook_connection` one overload, service_role only; `record_outlook_change_notification`, `_batch`, `record_outlook_subscription_state` service_role only; `get_my_outlook_sync_status()` authenticated only; `cron.job` `outlook-worker-tick` present with `active = false`; `outlook_subscriptions` RLS on; `outlook_sync_state.wake_cutoff_at` present. The migration's own comments carry the queries. |
| 2 | **Merge PR #76; deploy `outlook-notifications` (new) and `outlook-import-worker`** from merged main with `--use-api`; `verify_jwt=false` for both from `config.toml` | owner, CLI | Downloaded function sources byte-identical to main. Worker flag still absent: nothing runs. |
| 3 | **Vault secrets** `outlook_worker_url` (`https://<ref>.supabase.co/functions/v1/outlook-import-worker`) and `outlook_worker_secret` (the existing `OUTLOOK_WORKER_SECRET`, not rotated) by hidden input | owner, SQL editor | Both names present in `vault.decrypted_secrets`; values never displayed. |
| 4 | **Publish the approved wording** (section 2 above) at `/privacy` and in `src/lib/outlookDisclosure.js`; update `DISCLOSURE_FINGERPRINT` to the new text | owner approval, then a PR | `verifyDisclosureIntegrity()` true; `computeDisclosureVersion()` yields a **new** `ol-disc-<32 hex>`; record it in the plan. |
| 5 | **Carry that ONE value everywhere, in one cutover**: the server secret `OUTLOOK_DISCLOSURE_VERSION`; and in `outlookContentConsent.js` all three of `REQUIRED_CONTENT_CONSENT_VERSION`, `REQUIRED_THIRD_PARTY_CONSENT_VERSION`, `REQUIRED_BACKGROUND_CONSENT_VERSION`; redeploy the worker | owner | The three constants and the secret equal the derived version. Why all three: each is compared to the digest of the whole notice; a requirement left behind closes body reading or Anthropic processing for the account that just re-consented (proven in `tests/outlook-background-consent-cutover.test.js`). Until this step the background gate is simply **closed** (`background_consent_not_configured`): no subscription, no read. |
| 6 | **Fresh pilot consent**: Settings → Disconnect Outlook, then reconnect under the new notice | pilot | `microsoft_connections.consent_policy_version` equals the new version. Recorded consent is never edited in place. |
| 7 | **Bootstrap invocation**: set `OUTLOOK_IMPORT_WORKER_ENABLED=true` (executes nothing by itself), tick still inactive, run ONE invocation by the existing hidden-input PowerShell pattern | owner | A **reserved** run: `run.outcome` `committed` (or `continued`), `run.subscription.action = create`, `outcome = created`, and an `outlook_subscriptions` row with `status = 'active'`, `expires_at` about three days out. **`none_due` proves nothing** — no connection was reserved, no subscription step ran; if the connection is not due yet, wait until it is and invoke once more. This is where Microsoft validates the deployed endpoint — **live fact 1**. |
| 8 | **Listener verification** — no manual invocation: the endpoint kicks the worker after recording a signal, and the flag is on | owner observes, pilot acts | (a) Another account sends a message to the pilot mailbox: `wake_count` increments and `last_wake_at` is set — **live fact 2**; within about a minute `outlook_sync_state.run_started_at` is after `last_wake_at` and the signal is consumed (`wake_requested_at` cleared) by a complete release. (b) The pilot **sends an existing draft** from the mailbox: `wake_count` increments again and a run follows the same way — **live fact 3**. If a signal is recorded but no run follows, diagnose the kick (flag, secret, `not_enabled` in the worker log) before activating anything. |
| 9 | **Activate the tick**: `SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'outlook-worker-tick'), active := true);` | owner | `cron.job.active = true`; Settings' automation line now reads that automatic checks are on. |
| 10 | **Live acceptance — the milestone**: with Funnl closed, a fresh two-way exchange; a suggestion appears within the target; the pilot edits and accepts it in Funnl | pilot | The suggestion is editable and carries both sides' context; acceptance saves the contact and/or interaction with the reviewed values; latency recorded by the SQL in plan section 2 (`created_at` against `last_wake_at`). |

### Rollback at any point after step 7

1. `SELECT cron.alter_job(<jobid>, active := false);` — stops scheduled execution.
2. Unset `OUTLOOK_IMPORT_WORKER_ENABLED` — every tick and every kick answers `503 not_enabled`
   and runs nothing; the pilot's connection, tokens and cursors are untouched.
3. The Graph subscription keeps posting until it expires (at most three days from its last
   renewal): the endpoint records harmless timestamps and counts and kicks a worker that
   refuses. To silence the endpoint too, unset `OUTLOOK_INTEGRATION_ENABLED` (503; Microsoft
   retries up to four hours, then drops). Nothing deletes the subscription at Microsoft; a
   later re-enable renews or recreates it.
4. Consent is not rolled back: a published notice stays published, and the three
   requirements stay at the new version.

---

## 4. Evidence: what is already demonstrated, and what only the pilot can show

**Independently demonstrated** (fixtures shaped as Microsoft documents, real handlers, the
real worker, a real Postgres, a real browser): durable acknowledgement of notifications;
wake-ups surviving continued rounds; the subscription step inside the reserved run; the
consent gates closed while unconfigured and across the cutover; the queue refreshing without
disturbing review work; Settings' status; acceptance saving the reviewer's values. See the
PR #76 description for the current numbers.

**Only the live steps can establish** (plan section 3): the validation handshake for the
deployed URL (step 7); an inbound message producing a signal and an automatic run (step 8a);
the pilot sending an existing draft producing a signal and an automatic run (step 8b);
lifecycle events, if any, recorded by kind.

---

## 5. Boundaries that stay in force

- Single-account pilot restriction; Google Calendar off the UI.
- Review before save: no contact or interaction is written without the user pressing Accept.
- `OUTLOOK_WORKER_SECRET` is never shown, pasted or rotated by any step here.
- No message content is stored by this slice; the signal's message identifier is not kept.

---

## 6. Subsequent product workstreams (not in this packet)

Named here so the milestone above is not confused with them; completion criteria are in
plan section 7.

- **Detailed conversation notes** — the note states the concrete facts of the exchange,
  each traceable to the text; a larger character cap is a consequence, not the deliverable.
- **Broader evidence-backed metadata** — company, role, how-met proposed only with an
  evidence code and confidence; low confidence is never written.
- **School / Education** — a contact field, draft contract, card, CSV import and disclosure.
- **Later interactions within an accepted thread** — a reply after acceptance becomes a new
  pending suggestion for the same contact rather than `exists_terminal`.
