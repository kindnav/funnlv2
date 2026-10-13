# Outlook second-account acceptance

**Status (2026-10-13): NOT PASSED. Not started. BLOCKED** until BOTH of these are complete in
Production:
1. the one-owner fix (Draft PR #97), rolled out in full: migration, website and callback;
2. the administrator-consent wording cutover (Draft PR #98) through its step C7: published,
   server variable and worker moved together, pilot re-consented, synchronisation resumed.

The second account then consents once, under the corrected notice
`ol-disc-1b6906af498ccff0f1e3292027ca0539`.

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
after #97 is fully live**: the migration, the website and the callback. Until then, a wrong account
choice at Microsoft could disturb the pilot. Its rollout packet is `docs/outlook-one-owner-rollout.md`.

## Prerequisite: the corrected disclosure (Draft PR #98)

The notice and `/privacy` said the permissions need no administrator consent "by default". #98
corrects one sentence in each, deriving the new version `ol-disc-1b6906af…`. Its cutover
(`docs/outlook-admin-consent-wording-cutover.md`) has the pilot re-consent once.

Running acceptance first would make the second account consent under text known to be
inaccurate, and then consent again.

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
- consent version `ol-disc-1b6906af498ccff0f1e3292027ca0539` (the corrected notice);
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
only for the account type actually used**.

## What a pass is evidence of

The query records `account_type` and `tenant_is_consumers_msa` for the connection. They decide
what may be claimed:

| Connected account | May be recorded as | May NOT be claimed |
|---|---|---|
| Personal (`account_type=personal`, tenant = the consumers tenant `9188040d-…`) | "a second **personal** Outlook account works end to end" | anything about work or school accounts, any organisation's consent policy, or IU |
| Organisational (`account_type=work`, a non-consumers tenant whose policy let the user consent) | "a second account in an organisation that **permits user consent** works end to end" | that organisations in general work, that admin-approval tenants work, or that IU works |

Organisations that require admin approval stay **unsupported** under the launch scope. No pass of
either kind changes that.

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

### Administrator-consent wording: corrected in Draft PR #98

The "no administrator consent by default" sentence is replaced in both the notice and
`/privacy` by the owner-reviewed sentence, checked against current Microsoft documentation.
The exact text, the derived version `ol-disc-1b6906af498ccff0f1e3292027ca0539` and the ordered
cutover are in #98 and `docs/outlook-admin-consent-wording-cutover.md`.

## Admin-approval refusal message (Draft PR #95)

#95 adds one conditional sentence to the generic failed-connection notice (`?outlook=error`). It
is conditional because the callback cannot reliably tell an admin-approval refusal from any other
failure. That behaviour is kept.

#97 separately adds an accurate notice for the one refusal the database *can* identify
(`?outlook=in_use`); the generic notice and its hint never show for it. #95 and #97 merge cleanly
in either order (#95's tests live in their own file).
