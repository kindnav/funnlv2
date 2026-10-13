# Outlook second-account acceptance

**Status (2026-10-13): NOT PASSED.**

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

## Who and what

| Requirement | How it is met |
|---|---|
| A distinct Funnl user | The second Funnl account already on both allowlists (id-hash prefix `157ec62550b8`). It is not the pilot. **No allowlist change is needed.** A *different* Funnl user would need a new, separately authorised change to both allowlists. |
| A distinct Microsoft mailbox | Any personal Outlook.com / Hotmail / Live mailbox, or an organisational mailbox whose tenant lets users consent. It must **not** be the pilot's mailbox, and not the school mailbox that was refused. |
| Current disclosure | Connect from Settings on `www.getfunnl.com`. The page shows the published notice, and the server refuses any other version. |

### Why the mailbox must be checked before consenting

Nothing in the database stops two Funnl users connecting the **same** Microsoft mailbox.
`finalize_microsoft_connection` compares only against the caller's own existing account, and
`microsoft_connections` is unique on `user_id` only.

If the second account connected the pilot's mailbox:
- that mail would be read into a second Funnl account;
- the second connection's subscription setup, on a 409 conflict, lists and deletes subscriptions
  matching Funnl's notification URL for that mailbox, which can remove the pilot's subscription.

Until a structural guard exists, onboarding must prevent this in practice. Acceptance checks it
(A1 `distinct_microsoft_account_from_pilot`, `same_mailbox_on_any_other_user`).

## Onboarding steps (for the person testing)

1. Use a **private/incognito window**, or a separate browser profile, so neither the pilot's
   Funnl session nor any Microsoft session is present.
2. Sign in at `https://www.getfunnl.com` as the second Funnl account.
3. Open **Settings → Outlook**. Read the disclosure, tick the acknowledgement and select
   **Connect**.
4. At Microsoft's account picker, sign in with the **new** mailbox. Confirm the address shown is
   not the pilot's mailbox before continuing.
5. Microsoft shows the permission list. Accept it. If it says "Need admin approval" instead, stop:
   that mailbox's organisation does not permit consent and the attempt does not count.
6. Back in Funnl, Settings should show Outlook as connected to the new mailbox. **Close Funnl.**
7. Create a **genuine** two-way exchange in the new mailbox. Another real person and the mailbox
   owner each write at least once, in either order, after step 6. Use no test generator, and no
   message to or from the pilot's mailbox.
8. Keep Funnl closed for at least 20 minutes after the last message (a change notification or
   the routine check, about every 15 minutes, should pick it up).
9. Open Funnl as the second account, go to Suggestions, review the suggestion and **accept** it.
10. Tell the operator. They run the instrument below and the pilot preservation check.

The operator never invokes the worker manually, resets anything or clears cursors during the test.

## Acceptance criteria

All must hold, measured with `scripts/outlook-acceptance/second-account-acceptance.sql` (read-only; booleans, counts, codes,
timestamps).

- **A1 — Connected under the current disclosure.** Exactly one connection for the second
  account, with:
  - status `active`, `needs_reauth` false;
  - scopes exactly `Mail.Read User.Read offline_access openid email profile`;
  - consent version `ol-disc-6f904c3f7313353acbbc39e1edf2e278`;
  - `distinct_microsoft_account_from_pilot = true`, `distinct_mailbox_address_from_pilot = true`,
    `same_mailbox_on_any_other_user = false`.
  - The account type (personal or work) is recorded as observed. Neither is assumed.
- **A2 — Automatic synchronisation while Funnl is closed.**
  - Both folders have a committed cursor and a `last_success_at` after connection, with no error
    code.
  - The subscription is `active`.
  - At least one suggestion for the second account was created **after** the exchange, by an
    automatic run (cron tick or notification-kicked run).
  - The cron run reports in `net._http_response` show `committed` with `proposals_written >= 1`
    at the matching time. A notification-kicked run's report is not retained, so then the
    evidence is the suggestion's creation time against the folder `last_success_at`.
- **A3 — Reviewed and accepted.**
  - At least one accepted `source='outlook'` interaction under the second account.
  - The suggestion is in an accepted state.
  - For a new contact, the contact exists under the second account only.
- **A4 — Account isolation.** Every A4 counter is 0:
  - no candidate, interaction or accepted contact of the second account references another
    user's contact;
  - no provenance ref's user differs from its candidate's user;
  - no pilot row is attached to a second-account contact.
- **A5 — Pilot preservation.** Across the whole test, `scripts/outlook-acceptance/pilot-preservation.sql` `must_not_alter`
  digests are unchanged: identity, consent, saved interactions, contacts, settled interaction and
  new-contact candidates. Cursors, run timestamps, token expiry and wake metadata may advance
  normally and are not failures.

Only when A1–A5 all hold is "a second account works end to end" recorded as demonstrated, and
only for the account type actually used. A personal mailbox passing does not demonstrate an
organisational mailbox, and vice versa.

## Known gaps, recorded and not fixed here

1. **Same-mailbox guard.** See above. A small, separately reviewed change should refuse
   finalisation when the Microsoft account is already connected to another Funnl user, before
   invitations go beyond this one test account.
2. **Disclosure wording.** The notice and `/privacy` say none of the scopes "requires
   administrator consent by default". That is true of Microsoft's per-permission metadata, but
   Microsoft's recommended organisational policy does not let users consent to `Mail.Read`.
   Rewording changes the notice version and needs a re-consent cutover, so it should travel with
   the next planned notice publication rather than force one alone.
3. **Admin-approval refusal message.** Draft PR #95 adds one conditional sentence to the
   failed-connection notice. Copy only; it is not deployed.
