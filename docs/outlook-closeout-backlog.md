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

| # | Item | Kind | Evidence / what closes it |
|---|---|---|---|
| A1 | **Second-account acceptance has not passed.** | Open, deferred by owner | No distinct, tester-controlled mailbox exists today. Closes only with S0–S6 in `docs/outlook-second-account-acceptance.md`, including tester recognition at A1. Until then, nothing is demonstrated about more than one account: connecting, syncing, suggestions, acceptance or isolation. |
| A2 | **Unexplained drop in pilot rows on 2026-10-13.** Between 18:15:21Z and 19:35:35Z: interaction candidates 29 → 27, candidate refs 5 → 4, interactions 15 → 13. | Open | Reported to the owner at the time and never explained. Ruled out: a scope effect, the pause, PR #91 (no DML). A contact deletion during test setup would cascade to exactly these counts, but that is an **unverified hypothesis**. Closes when the owner confirms whether they deleted a contact in that window; otherwise investigate before inviting anyone, since an unexplained deletion path would be a data-loss defect. |
| A3 | **The failed-connection notice tells admin-approval users to "try again".** | Verified defect, fix ready | Draft PR #95 (copy only, conditional sentence). Needs approval and merge, then a website deploy. Only the website changes; no function or migration. |

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

1. Finish Outlook closeout: A2 and A3 now; A1 when a mailbox exists.
2. **Paste-email capture**, reusing the existing extraction and review process.
3. The UI refresh.
4. Marketing.

The browser extension is deferred.
