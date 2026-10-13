# Outlook second-account acceptance

**Status (2026-10-13): NOT PASSED. Not started.** Blocked on the one-owner fix (Draft PR #97).

The cohort rollout is complete:
- both allowlists hold the pilot and one second Funnl account;
- the server value digest is `05e42217…7d847516`;
- the rebuilt website serves exactly those two members and the published notice version
  `ol-disc-6f904c3f7313353acbbc39e1edf2e278`.

The acceptance test has not passed. The first attempt used a school mailbox, and Microsoft stopped
it at "Need admin approval". No connection was created.

## Launch scope

Funnl supports **invited** Microsoft mailboxes whose organisation permits user consent, plus
eligible personal Outlook accounts. School and work accounts whose organisation requires admin
approval are unsupported, pending future institutional approval. Funnl does not promise universal
school-email compatibility.

## Prerequisite: one Funnl owner per Microsoft account (Draft PR #97)

Before #97, two Funnl users could connect the **same** Microsoft account. That was reproduced on
disposable infrastructure against the function Production runs:
- the second connection's subscription setup got a 409 and deleted the first connection's Graph
  subscription;
- notifications then reached only the second connection, and each renewal deleted the other's
  subscription;
- the same mailbox would also be read into two Funnl accounts.

#97 makes the database refuse that atomically, with `account_in_use`. **Acceptance starts only
after #97's migration is applied** (and, for the accurate message, its website and callback
changes are deployed). Until then, a wrong account choice at Microsoft could disturb the pilot.

## Who and what

| Requirement | How it is met |
|---|---|
| A distinct Funnl user | The second Funnl account already on both allowlists (id-hash prefix `157ec62550b8`). It is not the pilot. **No allowlist change is needed.** A *different* Funnl user would need a new, separately authorised change to both allowlists. |
| A distinct Microsoft account | Any personal Outlook.com / Hotmail / Live account, or an organisational account whose tenant lets users consent. Not the pilot's, and not the school account that was refused. "Distinct" is checked on the provider identity (tenant id + object id), not on the address text. |
| Current disclosure | Connect from Settings on `www.getfunnl.com`. The page shows the published notice, and the server refuses any other version. |

## Staged verification

Each stage has a gate checked with the read-only queries in `scripts/outlook-acceptance/`. A
failed gate **stops** the test and is diagnosed before anything else happens. The operator never
invokes the worker manually, resets anything or clears cursors. Times are recorded; message
content is never read.

**S0 — Preconditions (operator).**
- #97's migration is applied.
- The pilot is healthy: recent runs `committed` or `none_due`, no error codes.
- `pilot-preservation.sql` is captured as the baseline.
- `second-account-acceptance.sql` shows 0 connections for the second account.

**S1 — Connect (owner).**
1. Use a private/incognito window or a separate browser profile, so no pilot or Microsoft session
   is present.
2. Sign in to `https://www.getfunnl.com` as the second Funnl account.
3. Open **Settings → Outlook**, read the disclosure, tick the acknowledgement, select **Connect**.
4. At Microsoft, sign in with the new account and confirm the address shown before continuing.
   - If Microsoft says "Need admin approval", stop: that organisation does not permit consent, and
     the attempt does not count.
   - If Funnl says the account is already connected to a different Funnl account, stop: wrong
     account.

**Gate A1:** exactly one connection for the second account:
- `active`, not `needs_reauth`;
- scopes exactly `Mail.Read User.Read offline_access openid email profile`;
- consent version equal to the version then published;
- `holders_of_this_microsoft_identity = 1`, `distinct_microsoft_account_from_pilot = true`;
- the account type (personal or work) recorded as observed.

**S2 — Automatic initial synchronisation (no action).** The new connection is reserved by the
normal cron tick. **Gate:**
- both folders have a committed cursor and a `last_success_at` after `connected_at`, with no
  error code;
- the subscription is `active`;
- a cron run report for that time shows `committed`.

The first round may create suggestions from mail that already existed. That is allowed, but it is
not the acceptance exchange. Record the S2 candidate list as the baseline.

**S3 — A fresh two-way exchange, Funnl closed (owner).** Close every Funnl tab. Another real person
and the account owner each write at least once, in either order, in a new thread. Nothing to or from
the pilot's mailbox, and no test generator. The owner reports only the time of the first and last
message.

**S4 — Observe candidate creation (operator polls; no fixed wait).** **Gate:** a second-account
candidate that is
- created after the last S3 message;
- whose coverage window (`coverage_from_at..coverage_through_at`, message times) falls within the
  reported S3 window;
- produced while Funnl was closed, by an automatic run: a cron run report with
  `proposals_written >= 1`, or a notification wake followed by a folder `last_success_at` before
  the candidate's creation (notification-kicked run reports are not retained).

If no such candidate appears within about 30 minutes, stop and diagnose:
- folder errors;
- whether the exchange really was two-way;
- screening (newsletter or automatic-reply headers).

**S5 — Review and accept (owner).** Open Funnl as the second account, review the suggestion in
Suggestions, and accept it. **Gate A3:**
- the candidate is accepted;
- an accepted `source='outlook'` interaction exists under the second account only;
- for a new contact, the contact exists under the second account only.

**S6 — Isolation and pilot preservation (operator).**
- **Gate A4:** every isolation counter is 0.
- **Gate A5:** the pilot's `must_not_alter` digests are unchanged from S0. Cursors, run times,
  token expiry and wake metadata may advance normally.

Only when S1–S6 all pass is "a second account works end to end" recorded as demonstrated, **and
only for the account type actually used**. A personal account passing demonstrates nothing about
organisational accounts, and the reverse is also true.

## Disclosure findings (investigated, not assumed)

### Richer metadata DOES require a new disclosure

Workstream B would propose company, role and how-you-met for new contacts, with evidence.
Published notice paragraph 14 says:

> "Funnl will not guess a company, a job title, how you met, a LinkedIn profile or a tag — those
> fields are left blank for you to fill in if you want them."

`/privacy` says the same ("start blank … Funnl does not store a company or job title it
inferred").

B contradicts both. It therefore needs:
- new notice text, which means a new fingerprint and version, and a three-way cutover: browser,
  server `OUTLOOK_DISCLOSURE_VERSION`, and all three worker requirements;
- re-consent by every connected account;
- a `/privacy` update.

What Anthropic receives would not change: B reads the same message text and signature. Only the
output fields would change.

### Administrator-consent wording: an accuracy issue to fix on its own

Notice paragraph 4 ends:

> "Neither requires administrator consent by default, but a work or school tenant can be
> configured to require an administrator to approve the app, and then you may not be able to
> consent for yourself."

`/privacy` says "None of these scopes requires administrator consent by default".

This is true of Microsoft's per-permission metadata, but misleading in practice. Microsoft's
recommended organisational consent policy, the default for new tenants, does **not** let users
approve `Mail.Read`.

**Smallest correction.** Replace that last sentence of paragraph 4 with:

> "With a personal Microsoft account you approve them yourself. A work or school organisation can
> require an administrator to approve an app that reads mail — Microsoft's recommended setting for
> organisations does — and then you cannot connect it until an administrator approves Funnl."

Make the same correction to the `/privacy` sentence.

**Consent-version consequences.**
- The `/privacy` sentence is not part of the notice fingerprint. Correcting it alone changes no
  version and needs no re-consent.
- The notice sentence **is** part of the fingerprint. Changing it derives a new
  `ol-disc-…` version, which needs:
  - the usual ordered publication: website first, then the server variable, the three worker
    requirements and the worker redeploy, together;
  - during the window between them, runs for every connection are refused with
    `background_consent_missing`, and nothing is lost: cursors hold and resume;
  - a same-account re-consent (an OAuth update; never a disconnect) by every connected account.
- **Timing:** today only the pilot is connected. Publishing the correction **before** S1 means only
  the pilot re-consents, and the second account connects under the corrected text. Publishing after
  acceptance means both accounts re-consent. Folding it into B's later publication would leave a
  known inaccuracy in place for an unknown period, so it is not recommended.

## Admin-approval refusal message (Draft PR #95)

#95 adds one conditional sentence to the failed-connection notice. It is conditional because the
callback cannot reliably tell an admin-approval refusal from any other failure. That behaviour is
kept. #97 separately adds an accurate notice for the one refusal the database *can* identify
(`account_in_use`).
