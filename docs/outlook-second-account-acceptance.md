# Outlook second-account acceptance

**Status (2026-10-14): NOT PASSED. DEFERRED, on hold by owner decision.** No second-account
acceptance evidence exists.

The test needs a Microsoft mailbox that is genuinely distinct and that the tester controls. None is
available today:
- the owner's `funnl.naveen` outlook.com mailbox is the pilot's connection, and a second Funnl
  user is correctly refused it (#97);
- the owner's IU mailbox requires administrator approval, which is unsupported under the launch
  scope.

Do not create accounts, move the pilot mailbox or change allowlists to get around this. Resuming the
gate is a separate owner decision.

Both prerequisites are now **complete in Production** (evidence below), so nothing else blocks the
gate once a suitable mailbox exists.

## Launch scope

Funnl supports **invited** Microsoft mailboxes whose organisation permits user consent, plus
eligible personal Outlook accounts. School and work accounts whose organisation requires admin
approval are unsupported, pending future institutional approval. Funnl does not promise universal
school-email compatibility.

## Prerequisites: done

### One Funnl owner per Microsoft account (PR #97): LIVE 2026-10-13

Before #97, two Funnl users could connect the same Microsoft account. On disposable
infrastructure, the second connection's subscription setup deleted the first connection's
subscription.

| Step | Evidence |
|---|---|
| Preflight | Heads pinned `54c2ed6`; 0 duplicate identities; exactly one pending migration; finalize baseline `md5(prosrc)` `e5809302…`; disposable proof 24/24 at the pinned commit |
| Migration `20261014000000` | Applied. Catalog: one overload, `md5(prosrc)` `90ecb2d60c3a22e23d758263ed5604a7` (9,680 chars), ACL `postgres` + `service_role`, valid unique index `microsoft_connections_ms_identity_unique`, 5 indexes, 0 duplicates |
| Merge | `2d7acb3` (tree identical to the reviewed head); website `index-CQRpBHcc.js` serves `in_use` |
| Callback | `outlook-oauth-callback` v49, bundle `81206e0ea83d4432`; downloaded closure identical to main (13 files); `verify_jwt=false`. No other function changed |
| Pilot | Protected data unchanged |

### Corrected administrator-consent disclosure (PR #98): CUTOVER COMPLETE 2026-10-14

| Step | Evidence |
|---|---|
| C1 pause | Cron `outlook-worker-tick` (the only job, found by name) inactive 23:36:50Z; worker flag ABSENT 23:36:55Z, verified twice |
| C2 baseline | Folders idle, no lease or round; explicit-column baseline stable across two reads 81 s apart |
| C3 publish | Merged `263c28d` 23:46:42Z. GitHub: Vercel status success plus a Production deployment record (Vercel's own API unverified: no access). Served: `index-DveDIzTi.js`, 24/24 paragraphs equal source, fingerprint `1b6906af498ccff0f1e3292027ca0539`, approved sentence in notice and `/privacy`, "Last updated: October 13, 2026" |
| C4 server variable | `OUTLOOK_DISCLOSURE_VERSION` digest equals sha256 of the new version; the other 23 secrets unchanged; bundles and timestamps unchanged |
| C5 worker | `outlook-import-worker` v66, bundle `afed9659f4852c0a`; downloaded closure identical to main (31 files); all three requirements carry the new version. Rollback target: v65 `c59372d81fadfdba` |
| C6 re-consent | Pilot same-account update about 23:57:25Z. Identity, data and settled suggestions unchanged; consent, tokens and expiry rewritten as expected |
| C7 resume | Flag PRESENT 00:01:47Z; cron active 00:01:56Z; first automatic run 00:02:00Z committed, no refusal, leases released |

Browser, server, the worker's three requirements and the pilot's stored consent all equal
`ol-disc-1b6906af498ccff0f1e3292027ca0539`.

## Historical observation, 2026-10-14. NOT acceptance

These facts were read from the Production database during an attempted S1/S2. They are recorded
because they happened, not because they satisfy any gate.

**Observed:**
- **00:10:42Z.** A connection was created for the second Funnl user under the corrected notice
  version. Its Microsoft identity was a **personal** account (Microsoft's consumers tenant),
  distinct from the pilot's: different object id and different address. No other Funnl user held
  it.
- **00:11:00Z.** The regular cron tick reserved it and committed:
  - 2 cursors advanced;
  - each folder one page, **0 messages**, no suggestions;
  - its run report says `subscription: create → created`, and its subscription row read
    `active`, expiring 2026-10-17 00:11:01Z.
- The pilot was untouched throughout: protected data and subscription identity unchanged.
- **Between about 00:13 and 00:25Z** that connection was **removed**. Its connection, tokens, sync
  state, subscription row and earlier sign-in attempts no longer exist. These effects match the
  user-initiated Disconnect RPC. **The actor and cause were not verified:** no log of who or what
  removed it was read.
- **00:25:05Z.** A new sign-in attempt was started for the second Funnl user and never completed:
  still unconsumed, nothing written. Its outcome is **unknown**, because the callback's logs were
  not available. The one-owner refusal is one possible explanation, and it is not established.

**Not established:**
- **Which Microsoft account was connected at 00:10:42.** The tester reports they did not connect a
  new, distinct mailbox. The row is deleted and its address was never recorded.
- That the identity corresponds to a usable mailbox the tester controls. The empty first sync
  cannot show that.

**The removed connection's Microsoft subscription:**
- *Directly observed:* the run report's `create → created`, and the database row
  (`active`, expiry 2026-10-17 00:11:01Z) while the connection existed.
- *Not observed:* the subscription's state at Microsoft after the removal. No Graph request was
  made, and none may be made to check it.
- *Inferred, from the code and the requested lifetime, not verified:*
  - Disconnect makes no call to Microsoft, so the subscription was probably left in place there;
  - it would lapse by about 2026-10-17 00:11Z;
  - any notification for it finds no matching row and is ignored (`unknown_subscription` in
    `record_outlook_change_notification`).

**What went wrong in reporting, and the fix below.** The operator reported "your personal mailbox
connected correctly" on the strength of the tester's message. The database facts were accurate,
but the conclusion was not: the tester had not recognised the connected mailbox. A1 now requires
that recognition.

## Who and what

| Requirement | How it is met |
|---|---|
| A distinct Funnl user | The second Funnl account already on both allowlists (id-hash prefix `157ec62550b8`). **No allowlist change is needed.** A different Funnl user would need a separately authorised change. |
| A distinct Microsoft mailbox **that the tester controls and can name** | A personal Outlook.com / Hotmail / Live account, or an organisational account whose tenant lets users consent. Not the pilot's `funnl.naveen`, not IU. "Distinct" is checked on the provider identity (tenant id + object id), and "intended" by the tester's own recognition. |
| Current disclosure | `ol-disc-1b6906af498ccff0f1e3292027ca0539`, served on `www.getfunnl.com` and required by the server and worker. |

## Staged verification

Each stage has a gate, checked with the read-only queries in `scripts/outlook-acceptance/`. A
failed gate **stops** the test and is diagnosed before anything else happens. The operator never
invokes the worker manually, resets anything or clears cursors. Times are recorded; message content
is never read.

**S0 — Preconditions (operator).**
- The pilot is healthy: recent runs `committed`/`none_due`, no refusals or folder errors.
- `pilot-preservation.sql` is captured as the baseline.
- `second-account-acceptance.sql` shows 0 connections for the second account.
- **The tester confirms, before starting, which mailbox they will connect, and that they control
  it.** It must not be `funnl.naveen` or IU. They state its address domain only.

**S1 — Connect (tester).**
1. Use a private/incognito window, with no Funnl or Microsoft session present.
2. Sign in to `https://www.getfunnl.com` as the second Funnl account.
3. Open **Settings → Outlook**, read the disclosure, tick the acknowledgement, select **Connect**.
4. At Microsoft, choose or sign in to the **named** mailbox, and read the address Microsoft shows
   before continuing.
   - If Microsoft says "Need admin approval", stop.
   - If Funnl says the account is already connected to a different Funnl account, stop.
5. Back in Settings, read the connected address the Outlook card displays.

**Gate A1:**
- **Tester recognition (required, first).** The tester confirms the address on the Settings card is
  exactly the mailbox named at S0. The operator records "recognised: yes" and the address domain,
  never the full address. If the tester does not recognise it, A1 FAILS, whatever the database
  shows. Report it as an unrecognised connection and stop.
- Exactly one connection for the second account: `active`, not `needs_reauth`.
- Stored scopes are exactly the five Microsoft reports, `openid profile email Mail.Read User.Read`,
  **and** `refresh_token_stored = true`. Microsoft does not echo `offline_access` in its scope list;
  the stored refresh token is the evidence of offline access. (The long-running pilot stores the
  same five.)
- Consent version `ol-disc-1b6906af498ccff0f1e3292027ca0539`.
- `holders_of_this_microsoft_identity = 1`, `distinct_microsoft_account_from_pilot = true`,
  `same_mailbox_on_any_other_user = false`.
- The account type (personal or work) is recorded as observed, and it must match what the tester
  named.

**S2 — Automatic initial synchronisation (no action).** The new connection is reserved by the
normal cron tick. **Gate:**
- both folders have a committed cursor and a `last_success_at` after `connected_at`, with no error;
- the subscription row is `active`;
- a cron run report for that time shows `committed`.

The first round may create suggestions from older mail. That is allowed, but it is not the
acceptance exchange. Record the S2 candidate list as the baseline.

**S3 — A fresh two-way exchange, Funnl closed (tester).** Close every Funnl tab. Another real person
and the mailbox owner each write at least once, in either order, in a new thread. Nothing to or from
the pilot's mailbox, and no test generator. The tester reports only the times of the first and last
message.

**S4 — Observe candidate creation (operator polls; no fixed wait).** **Gate:** a second-account
candidate that is
- created after the last S3 message;
- whose coverage window (`coverage_from_at..coverage_through_at`) falls within the reported S3
  window;
- produced by an automatic run while Funnl was closed: a cron report with `proposals_written >= 1`,
  or a notification wake followed by a folder `last_success_at` before the candidate's creation.

If nothing appears within about 30 minutes, stop and diagnose.

**S5 — Review and accept (tester). Gate A3:**
- the candidate is accepted;
- an accepted `source='outlook'` interaction exists under the second account only;
- for a new contact, the contact exists under the second account only.

**S6 — Isolation and pilot preservation (operator).**
- **A4:** every isolation counter is 0.
- **A5:** the pilot's `must_not_alter` digests are unchanged from S0.

Only when S1–S6 all pass is "a second account works end to end" recorded, **and only for the
account type actually used**.

## What a pass is evidence of

| Connected account | May be recorded as | May NOT be claimed |
|---|---|---|
| Personal (`account_type=personal`, consumers tenant) | "a second **personal** Outlook account works end to end" | anything about work or school accounts, any organisation's consent policy, or IU |
| Organisational (`account_type=work`, a tenant that let the user consent) | "a second account in an organisation that **permits user consent** works end to end" | that organisations in general work, that admin-approval tenants work, or that IU works |

## Disclosure findings

- **Richer metadata needs a new disclosure.** Notice paragraph 14 promises Funnl "will not guess a
  company, a job title, how you met…", and `/privacy` agrees. Workstream B would need:
  - new notice text, which means a new version and a three-way cutover;
  - re-consent by every connected account;
  - a `/privacy` update.
- **The administrator-consent wording** was corrected and published by #98 (above).

## Admin-approval refusal message (Draft PR #95)

#95 adds one conditional sentence to the generic failed-connection notice (`?outlook=error`). It is
conditional because the callback cannot reliably tell an admin-approval refusal from any other
failure. #97's `?outlook=in_use` notice is separate, and the hint never shows for it.
