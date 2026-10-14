# Outlook closeout: backlog audit (2026-10-14)

**The integration is NOT complete merely because the pilot works.**

What is demonstrated: one personal mailbox (the pilot) syncing unattended under the current notice,
with the one-owner guard and the corrected disclosure live.

What is not demonstrated: a second, independent account end to end, or any organisational account.

Every item below is one of:
- **Verified fact**: read from Production or the code, with the evidence named;
- **Open**: not established;
- **Decision**: an owner choice, not a defect.

## A. Launch-blocking before inviting anyone beyond the pilot

Status 2026-10-14: A2 and A3 are closed. **A1 remains open** and deferred, so inviting anyone beyond the pilot stays blocked.

| # | Item | Kind | Evidence / what closes it |
|---|---|---|---|
| A1 | **Second-account acceptance has not passed.** | Open, deferred by owner | No distinct, tester-controlled mailbox exists today. Closes only with S0–S6 in `docs/outlook-second-account-acceptance.md`, including tester recognition at A1. Until then, nothing is demonstrated about more than one account: connecting, syncing, suggestions, acceptance or isolation. |
| A2 | ~~Unexplained drop in pilot rows on 2026-10-13~~ **Explained by owner confirmation (2026-10-14).** Between 18:15:21Z and 19:35:35Z: interaction candidates 29 → 27, candidate refs 5 → 4, interactions 15 → 13. | Closed: owner confirmation | The owner confirmed deleting a test contact in that window. That is **consistent with** the observed cascades: deleting a contact removes its interactions and interaction candidates by `ON DELETE CASCADE`, and their provenance refs with them. This is **owner confirmation, not independent audit evidence**: Funnl keeps no deletion log, and no record shows which contact was deleted or by whom. No defect was found, and no code path other than a contact deletion was identified for these counts. |
| A3 | ~~The failed-connection notice tells admin-approval users to "try again".~~ **Fixed.** | Closed | PR #95 merged as `5135258` on 2026-10-14 (copy only). The live site (`index-NkrFlT1k.js`) serves the conditional sentence, keeps #97's account-in-use notice, and still uses `ol-disc-1b6906af…`. |

## B. Disclosed limits: decide, do not hide

These are true, published in `/privacy`, and not defects against what Funnl claims. Each is a
decision for the owner before wider launch.

| # | Limit | Kind | Evidence |
|---|---|---|---|
| B1 | **No scheduled retention sweep.** An expired pending suggestion keeps its summary and subject until dismissed, disconnected, its contact deleted or the account deleted. An abandoned read's working records stay until a later read, a reset, a complete release or a disconnect. | Decision | Measured in `docs/outlook-privacy-consent-readiness.md` (45 days past the deadline, still `pending`). Published: "Nothing happens on its own". |
| B2 | **Disconnect does not revoke Funnl's grant at Microsoft and does not delete the Graph subscription.** | Decision | `disconnect_my_outlook` is database-only, with no network call (verified 2026-10-14). The user removes Funnl at myapps; the subscription lapses at its expiry (about 3 days, requested lifetime). Notifications for it match nothing and are ignored. |
| B3 | **Admin-approval tenants are unsupported** (IU included). | Decision (launch scope) | Microsoft's recommended organisational policy excludes `Mail.Read` from user consent. |
| B4 | **Notification-triggered run reports are not retained** (cron run reports are). | Decision (observability) | Acceptance S4 must infer those runs from folder times. Retaining them would be an observability change, not a privacy one. |

## C. Verification still owed, not yet known to be defects

| # | Item | Kind |
|---|---|---|
| C1 | **Generated-note quality on real pilot mail.** Evidence so far is four synthetic exchanges. Reading naturally generated pilot notes against their source for detail, attribution and unsupported claims is outstanding. | Open |
| C2 | **A `missed` lifecycle event is recorded on the pilot's subscription.** Delta synchronisation should cover missed notifications, and runs since then are healthy. This is an observation to confirm, not a known fault. | Open |
| C3 | **The removed second connection's subscription at Microsoft.** Expected to lapse by about 2026-10-17 00:11Z. Inferred, not observed; no Graph request may be made to check it. | Open (expected harmless) |

## D. Features (not defects; each needs its own decision and disclosure)

| # | Feature | Status | Note |
|---|---|---|---|
| D1 | **Richer metadata** (workstream B): company, role, how-you-met, with evidence codes | Not started | **Needs a new disclosure.** Notice paragraph 14 promises Funnl will not guess these. That means a new version, a three-way cutover and re-consent by every connection. |
| D2 | **School / Education** (workstream C): an `education` contact field, draft contract, card, CSV import, disclosure | Not started | Migration plus disclosure. |

Already delivered, and not to be re-listed as backlog: detailed AI notes (2,000 characters);
later exchanges within an accepted thread (thread segments); the cohort gate; one owner per
Microsoft account; the corrected administrator-consent notice.

## E. Housekeeping

- **Draft PR #92** (records PR #91 and corrects digest labels) is still open and untouched. Close or
  merge it separately. It edits `CLAUDE.md`, so expect a trivial rebase against #96.
- **Draft PRs #23 and #24** (Pro trial, Stripe) are unrelated to Outlook and untouched.

## Next product work (owner order)

1. Outlook closeout is finished:
   - A3 is fixed (#95 merged `5135258`);
   - A2 is explained by owner confirmation;
   - A1 stays deferred until a mailbox exists.

   Outlook is a live, limited, optional integration for eligible mailboxes, not a main Funnl feature. No further invitations.
2. **Paste-email capture** - DONE, live 2026-10-14 (CLAUDE.md "Paste an email (Pro)").
   The contact School field followed, live 2026-10-14.
3. The UI refresh - only when the owner explicitly initiates it.
4. Marketing.

The browser extension is deferred.
