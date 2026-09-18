# Gmail integration — privacy, compliance & retention readiness

**Status: engineering readiness notes + an UNSHIPPED policy draft for legal review.**
Nothing here is live. `src/pages/PrivacyPage.jsx` (the shipped policy) is **not** edited by
this phase. Production Gmail access is **blocked** until the human gates below clear.

## Why the current policy blocks Gmail
The shipped Privacy Policy states Funnl **does not read Gmail**. That claim must be removed
or accurately rewritten **before** any Gmail scope is requested in production. Requesting a
Gmail scope while the policy says otherwise is a compliance violation.

## What Gmail metadata Funnl would access, and why
Metadata-only, per the E1 classifier's needs — **never** message bodies, previews, HTML,
attachments, or full raw messages. The exact header allowlist:

| Metadata | Why it is needed |
|---|---|
| From, To, Cc | Match a message to an owned contact; determine two-way exchange direction |
| Date / internalDate | Order messages, compute the suggested interaction date |
| Message-ID / thread id | Group a conversation; dedup; episode boundary (hashed, never stored raw) |
| Auto-Submitted, X-Auto-Response-Suppress, Precedence, List-Id, List-Unsubscribe | Filter out newsletters, bulk/list mail, out-of-office and automated notifications |
| Subject | **Transient** qualification context only; a sanitized ≤160-char preview is stored **only** for an eligible pending suggestion |

## What is never retained
Bodies, body previews/snippets, HTML, attachments, tracking pixels, arbitrary/full headers,
full recipient lists, raw Gmail message/thread/history ids, access/refresh tokens, and raw
provider responses are **never stored**. Provenance is a one-way **HMAC** fingerprint plus a
coarse label; provider identifiers never reach the browser.

## Retention & erasure
- Pending suggestion context (the sanitized subject) carries a 30-day `context_expires_at`
  and is erased immediately on **accept, dismiss, invalidate, Gmail disconnect, or account
  deletion**, leaving only a minimal HMAC tombstone for deduplication. **The expiry job
  (`expire_pending_email_context`) is not yet scheduled, so the 30-day maximum is design intent,
  not enforced behavior, and the public policy does not publish it.**
- An accepted interaction contains **only the user-reviewed note** — it never inherits raw
  provider content.
- Suggestions are review-only: background sync **never** auto-creates an interaction, edits
  a contact, sends mail, or modifies a mailbox.

## Google OAuth verification & CASA (human decisions)
- The bounded initial import uses a date-scoped Gmail query (`after:<epoch>`). `gmail.metadata`
  **forbids** the `q` parameter, so the date-scoped import needs **`gmail.readonly`**.
- `gmail.readonly` is a **restricted** Google scope, so **OAuth app verification is required**.
  A restricted-scope app that stores such data is **likely** also subject to an **annual CASA
  (Cloud Application Security Assessment) third-party review** — but the exact applicability
  and tier depend on Funnl's final data-access architecture and Google's requirements at
  submission time. **This is a conditional/likely requirement needing human (legal + Google
  console) confirmation — not an engineering conclusion, and not asserted here as definitive.**
- **Alternative to weigh:** `gmail.metadata` (no `q`) avoids restricted-scope CASA but
  forces client-side date filtering over a broader history-based fetch — weaker bounding and
  more processing. Owner + legal decide the tradeoff. This is recorded, not decided here.

## Disconnect: what Funnl can and cannot withdraw (E2B finding)
A user disconnecting Gmail in Settings runs `disconnect_my_gmail()`, which disables only the
Gmail capability, erases every **pending** Gmail suggestion together with its retained
subject, and drops the Gmail cursor. Accepted interactions, the Calendar capability, and the
stored Google authorization are untouched.

**Funnl cannot withdraw the Gmail grant on Google's side.** Google issues **one**
authorization per account covering every granted scope, and offers no per-scope revocation;
revoking it would also break a working Calendar connection. So Funnl stops reading mail
immediately and locally, while the grant itself remains listed in the user's Google Account
until they remove it there. The disconnect dialog states this plainly and points the user at
their Google Account third-party access page.

**This must appear in the published policy** — it is the difference between "we stopped
reading your mail" and "Google no longer authorizes us", and users will read the Google
account page, not our code.

## Blockers before production Gmail access (all must clear)
1. Privacy Policy rewritten and approved by legal — including the disconnect limitation
   above. **Drafted and implemented in `src/pages/PrivacyPage.jsx` (branch
   `docs/gmail-human-gates`, tests in `tests/privacy-policy-gmail.test.js`); awaiting owner/legal
   review before merge.** The verification packet lives in
   `docs/gmail-google-verification-packet.md`.
2. Google OAuth verification completed for the chosen scope.
3. CASA assessment completed if `gmail.readonly` is used and required.
4. ~~Capability-aware OAuth + Settings UI shipped behind a rollout flag (later phase).~~
   **Built in E2B** (`docs/phase-e2b-gmail-oauth-worker.md`) — unapplied migration,
   undeployed functions, flag off. Still needs the deliberate rollout in that doc's §8 (PR split & order) and the human gates in §9.
5. **Backend corrections before the mailbox pilot** (found in the policy audit; see the
   verification packet §9): (a) the whole-Google/Calendar disconnect does not clear pending
   Gmail `retained_subject` values — `disconnect_my_gmail` does, the shared cleanup does not;
   (b) `expire_pending_email_context` has no scheduler, so the 30-day subject maximum is not
   enforced and is not published; (c) fingerprints/terminal candidate rows persist for the
   contact/account lifetime — owner/legal decision.
6. One authorized test-mailbox validation of accuracy + privacy before broad enablement.

---

## Earlier policy sketch (superseded by the implemented draft in `src/pages/PrivacyPage.jsx`; kept for legal comparison)
> **Google Gmail (optional connection).** If you choose to connect Gmail, Funnl reads
> **only message metadata** — sender, recipients, date, subject line, and a small set of
> headers used to recognize automated and bulk mail — to suggest interactions with contacts
> you already track. **Funnl does not read the body, attachments, or full content of your
> emails, and does not store them.** Suggestions are shown to you for review; Funnl never
> creates a record, sends email, or changes your mailbox on its own. A suggestion's subject
> line is kept only until you act on it or for at most 30 days, then deleted. Funnl does not
> keep Gmail message or thread identifiers; matching uses one-way keyed fingerprints.
>
> **Disconnecting.** You can disconnect Gmail at any time in Settings. Funnl stops reading
> your mail immediately and deletes every Gmail suggestion you have not acted on, along with
> the subject lines it was holding. Because Google issues a single authorization for your
> whole Google account, Funnl cannot withdraw Gmail access on Google's side without also
> disconnecting Google Calendar; to remove it there as well, visit the third-party access
> page of your Google Account. [Legal to reconcile with Google API Services
> User Data Policy, Limited Use requirements, and the Microsoft equivalent before Outlook.]
