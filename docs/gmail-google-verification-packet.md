# Gmail — Google OAuth verification packet (prepared, not submitted)

**Status: PREPARED LOCALLY. Nothing has been submitted, configured, deployed, or enabled.**
This packet collects everything Google's restricted-scope review asks for, filled in from the
committed code and the current site, so the owner can complete the Google Cloud Console and
Privacy Policy steps deliberately. It contains no credentials, project secrets, private user
data, or mailbox data. It is not legal advice; the Privacy Policy wording it references needs
owner/legal review before publication.

Prepared: 2026-09-16 · Source of truth for behavior: `origin/main` @ `6ac06e7` (E2B PR-B merged;
Gmail Edge Functions **not deployed**; no Gmail secrets or flags).

---

## 1. What Google currently requires (verified against official sources on 2026-09-16)

Confirmed requirements are marked **[R]**; Google's recommendations or things the docs leave
unspecified are marked *[rec]*/*[unspecified]*.

### Google API Services User Data Policy — <https://developers.google.com/terms/api-services-user-data-policy> (page dated 2024-02-15)
- **[R] Limited Use.** Use of Google user data must be limited to "providing or improving
  user-facing features that are prominent in the requesting application's user interface".
  Transfers are allowed only to provide/improve those features (with consent), for security
  (e.g. abuse investigation), to comply with law, or as part of a merger/acquisition/sale with
  explicit consent. **Prohibited:** transferring or selling data to advertising platforms, data
  brokers, or information resellers; using it "for serving ads, including retargeting,
  personalized or interest-based advertising"; using it to determine credit-worthiness or for
  lending. "Don't allow humans to read the data, unless" the user affirmatively agrees to view
  specific data, or it is needed for security or legal compliance.
- **[R] Privacy policy.** Must be "accurate, comprehensive, and easily accessible" and
  "thoroughly disclose the manner in which your application accesses, uses, stores, or shares
  Google user data". Google does **not** mandate verbatim wording.
- **[R] Accurate representation / scope minimization.** "Only request access to the permissions
  necessary"; "don't attempt to 'future proof' your access".
- **[R] Restricted-scope apps** "must pass an annual security assessment and obtain a Letter
  of Assessment from a Google-designated third party".

### Restricted scope verification — <https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification> (page dated 2026-08-19)
- **[R] Privacy policy** "visible to users, hosted within the same domain as your application's
  home page", linked on the consent screen, compliant with Limited Use, and the app must not
  use data beyond what the policy discloses.
- **[R] Home page** "must be publicly accessible, and not just accessible to your site's
  logged-in users"; its relevance to the app under review must be clear; app-store/Facebook
  listings are not acceptable.
- **[R] Demo video** that "fully demonstrates how a user initiates and grants access to the
  requested scopes": the OAuth grant in English, the correct app name on the consent screen,
  the browser address bar showing the OAuth client ID, and the functionality for **each**
  requested scope.
- **[R] Scope justification:** "Describe how you will use the restricted scopes in your app and
  why more limited scopes aren't sufficient."
- **[R] Security assessment (CASA)** for "every app that requests access to Google users'
  restricted data and has the ability to access data from or through a third-party server";
  re-verified "at least every 12 months after your assessor's Letter of Assessment (LOA)
  approval date". Funnl's worker runs on Supabase (a third-party server) → **applies to Funnl**.
- Exemptions (do **not** apply to Funnl in production): personal use with known users,
  development/testing/staging, service accounts on own data, internal Workspace apps,
  domain-wide installation.

### Verification requirements (Cloud Console help) — <https://support.google.com/cloud/answer/13464321>
- **[R]** Home page "must be hosted on a verified domain you own", "must describe your app's
  functionality", "can not be only a login page", and must link the privacy policy; the privacy
  policy "should be hosted within the domain that hosts your homepage" and the link on the
  homepage and consent screen "should be same".
- **[R]** "An account listed as a project owner or editor … must verify ownership of the
  authorized domain using Google Search Console."
- **[R]** Scope justification must "include an explanation why narrower scopes would not
  work, including specifics on what functionality would not work as intended".
- **[R]** Demo video: end-to-end flow incl. the OAuth grant, "the complete OAuth Consent
  Screen" in English, and the features that use each scope.

### Branding / consent screen — <https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification> (page dated 2026-08-19)
- **[R]** Branding: app name, logo, developer contact, home page, privacy policy (optional
  terms of service). "Google requires verification of all domains that are associated with an
  application's OAuth consent screen and credentials" via Search Console, and "The Authorized
  domains section also needs to include the redirect URIs … authorized in your Web application
  OAuth client types."

### App state / audience — <https://developers.google.com/identity/protocols/oauth2/production-readiness/overview> (2026-05-22), <https://support.google.com/cloud/answer/15549945>, <https://support.google.com/cloud/answer/7454865>
- **[R]** *Testing* publishing status: only allow-listed test users, "hard cap of 100 test
  users".
- **[R]** *In production* but unverified with sensitive/restricted scopes: "unverified app
  warnings (Danger UI) will be displayed to users, and a hard cap of 100 total users applies";
  that lifetime cap "cannot be reset or changed".
- *[unspecified]* Google's pages do not publish review timelines; plan for weeks and for
  CASA to be the final step (see §9).

### Gmail scopes — <https://developers.google.com/workspace/gmail/api/auth/scopes> (2026-09-10) and <https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list>
- **[R]** `gmail.readonly` is **restricted** ("View your email messages and settings").
- **[R]** `gmail.metadata` is **also restricted** ("View your email message metadata such as
  labels and headers, but not the email body") — choosing it would **not** avoid restricted-scope
  verification or CASA.
- **[R]** `users.messages.list`: the `q` parameter "cannot be used when accessing the api using
  the gmail.metadata scope".

### Security assessment — <https://support.google.com/cloud/answer/13465431>, <https://appdefensealliance.dev/casa> (2026-06-27), <https://appdefensealliance.dev/casa/casa-tiering>
- **[R]** The assessment is "the final step of the restricted scopes review process"; Google's
  Trust and Safety team initiates contact. Two assurance levels, **AL1** and **AL2**, assigned
  "based on user count, requested scopes, and other application-specific signals"; assignment
  "may increase based on changes in your user base or data-handling practices"; "All
  applications must be revalidated every year"; once at AL2 an app stays at AL2.
- **[R]** CASA is built on OWASP ASVS; the same requirements apply at every level — only the
  assessment method differs; assessments are performed by ADA-authorized labs that the
  developer contacts directly.
- *[unspecified]* Cost and duration are not published by Google or ADA; assessors quote
  directly. Budget for a paid lab assessment and for annual renewal.

---

## 2. Consent-screen (branding) proposal

| Field | Proposed value | Notes |
|---|---|---|
| App name | `Funnl` | Must match the name users see in the app and on the home page |
| App description *(where asked)* | Funnl is a networking CRM for students. With your permission it reads Google Calendar events and Gmail message headers (never email contents) to suggest interactions you may want to record with people already in your contacts. Every suggestion is reviewed by you; nothing is logged automatically. | Plain, feature-oriented, matches the Privacy Policy |
| User support email | `navbir12345@gmail.com` | The contact already published on `/privacy` |
| Developer contact email | `navbir12345@gmail.com` | Google sends verification correspondence here — monitor it |
| App logo | The Funnl mark (ember tile with the funnel glyph used in the app header) | Owner exports a square PNG (Google's console states the size limits); must not contain Google branding |
| Application home page | `https://www.getfunnl.com` | Public landing page; describes the product; not a login page |
| Privacy policy link | `https://www.getfunnl.com/privacy` | Same domain as the home page; linked from the landing page footer and sign-in page |
| Terms of service link | *(none today)* | Optional per Google; leave blank unless one is published |
| Authorized domains | `getfunnl.com` | Covers `www.getfunnl.com` (home, privacy, redirect URI). Must be Search-Console-verified by a project owner/editor |
| User type | External | Public app |
| Publishing status at submission | In production | Verification is what removes the unverified warning / 100-user cap |

## 3. OAuth client — exact redirect URI (discovered, not guessed)

**Authorized redirect URI:** `https://www.getfunnl.com/api/google-oauth-callback`

Where it comes from in the repository:
- `supabase/functions/shared/googleOauthHelpers.js` → `EXPECTED_GOOGLE_CALLBACK_URL = 'https://www.getfunnl.com/api/google-oauth-callback'`; both start functions fail closed unless the configured `GOOGLE_OAUTH_CALLBACK_URL` equals it, and the callback sends it as `redirect_uri` on the token exchange.
- `vercel.json` rewrites `/api/google-oauth-callback` to the deployed `google-oauth-callback` Edge Function, so the branded www URL is the only URI Google ever needs.

This is the **same** redirect URI the existing Calendar connection uses. **Nothing new must be
registered for Gmail** — the Gmail consent (`gmail-oauth-start`) reuses it. If the Cloud
Console lists this URI already, no change is needed; if it does not, the Calendar flow could
not be working — check before assuming.

No JavaScript origins are needed (the browser never talks to Google directly; consent is a
top-level redirect and the callback is a server-side `form_post`).

## 4. Scopes requested and why each is necessary

| Scope | Class | When requested | Why it is necessary |
|---|---|---|---|
| `openid`, `email`, `profile` | non-sensitive | Calendar and Gmail consents | The callback verifies the Google identity (`sub`, verified email) via the userinfo endpoint before storing anything, and refuses to attach a Gmail grant to a different Google account than the one already connected |
| `https://www.googleapis.com/auth/calendar.events.readonly` | sensitive | Calendar consent only | Existing feature (already live behind its own flag): read-only event listing to suggest calendar meetings as interactions |
| `https://www.googleapis.com/auth/gmail.readonly` | **restricted** | **Gmail consent only** (`gmail-oauth-start`), never added to the Calendar consent | See §5 |

`include_granted_scopes=true` is used so a Gmail consent **adds** to an existing Calendar
grant instead of replacing it. Google combines all granted scopes into one authorization per
account — see §8.

## 5. `gmail.readonly` justification (concise, for the console text box)

> Funnl is a networking CRM for students. With the user's explicit consent, Funnl reads Gmail
> message **headers only** (From, To, Cc, Date, Subject, Message-ID, and the standard
> automated-mail headers List-Id, List-Unsubscribe, Precedence, Auto-Submitted,
> X-Auto-Response-Suppress) to detect real two-way conversations with people the user already
> tracks as contacts, and then **suggests** that conversation as an interaction the user can
> accept or dismiss. Funnl never reads message bodies, snippets, attachments, or raw messages,
> never sends mail, and never modifies the mailbox. Every message is requested with
> `format=metadata` and an explicit `metadataHeaders` allowlist; any response carrying body
> data is rejected by the server. Only the sanitized subject line (≤160 characters) of a
> qualifying pending suggestion is retained, for at most 30 days, and it is deleted on accept,
> dismiss, removal, disconnect, or expiry. No message or thread identifiers are stored; dedup
> uses a keyed HMAC fingerprint. The feature is prominent in the product's Settings and
> Suggestions screens, and the user can disconnect at any time.

### Why a narrower scope is insufficient (confirmed against Google's reference docs)
- `gmail.metadata` is **also a restricted scope** (same verification and CASA obligations), so
  it does not reduce review burden.
- The initial import must be **bounded**: Funnl lists only messages from roughly the last 90
  days using a server-constructed `q=after:<epoch> -in:chats` query. Google's
  `users.messages.list` reference states the `q` parameter "cannot be used when accessing the
  api using the gmail.metadata scope". Without `q`, a metadata-scope client would have to page
  through the entire mailbox history to find recent mail — more data, not less, and exactly the
  unbounded read Funnl is designed to avoid.
- `gmail.labels` (non-sensitive) exposes labels only, no headers — it cannot identify a
  conversation. Add-on scopes (`gmail.addons.*`) apply only inside a Gmail add-on, which Funnl is
  not.
- Funnl does not need and does not request `gmail.modify`, `gmail.send`, `gmail.compose`,
  `gmail.insert`, `gmail.settings.*`, or `mail.google.com`.

## 6. Reviewer test instructions (step-by-step, for the console "How to test" field)

Precondition for the owner: Gmail must be enabled on the review build (see §11) and the
reviewer must have a Funnl test account and a Gmail test mailbox containing a two-way thread
with one of that account's contacts.

1. Open `https://www.getfunnl.com`, click **Sign in**, sign in with the supplied test account.
2. Go to **Settings → Integrations**. Gmail is the first card; click **Connect Gmail**.
3. Google's consent screen shows app name **Funnl** and requests **"View your email messages
   and settings"** (`gmail.readonly`) plus basic profile. Grant it. You are returned to
   Settings with the banner *"Gmail connected. Funnl will start suggesting interactions
   shortly."*
4. Nothing is read in the browser. Within the sync interval (or immediately when the reviewer
   asks us to trigger the private worker), Funnl reads message headers only.
5. Open **Suggestions**. A suggestion appears for the seeded conversation, showing the contact,
   the date, and the subject line — and nothing else from the email.
6. **Accept** the suggestion, adding a note: an interaction is created that contains only your
   note; the subject line is deleted. **Dismiss** another suggestion: it disappears and its
   subject line is deleted.
7. Go back to **Settings → Integrations** and click **Disconnect** on Gmail. Read the dialog:
   it explains that pending suggestions and their subject lines are deleted, that Google Calendar
   is unaffected, and that Google's single authorization can only be fully withdrawn from the
   Google Account page. Confirm; the card returns to *Connect Gmail*.
8. (Optional) Delete the test account from Settings → the Google authorization and all data
   are removed.

## 7. Demo-video storyboard (English narration; show the address bar with the client ID during consent)

| # | Scene | What must be visible |
|---|---|---|
| 1 | Landing page `www.getfunnl.com` | Public home page, footer Privacy link |
| 2 | Sign-in | Test account |
| 3 | Settings → Integrations | Gmail card first, Calendar "Also available"; copy says headers only, never contents, suggestions you approve |
| 4 | Click Connect Gmail → Google consent | App name **Funnl**, the `gmail.readonly` permission text, the browser address bar showing `accounts.google.com` with `client_id=` in the URL |
| 5 | Return to Settings | "Gmail connected" banner; card shows *Checked just now* / freshness, no Sync-now button |
| 6 | Suggestions | The seeded conversation as a suggestion: contact, date, subject only |
| 7 | Accept with a note | Interaction created with the note; suggestion gone; subject not shown anywhere |
| 8 | Dismiss another | Gone |
| 9 | Provenance | The accepted interaction shows *source: Gmail* (no message identifiers) |
| 10 | Disconnect Gmail | The dialog with the combined-authorization explanation; card returns to Connect |
| 11 | Privacy Policy `/privacy` | Scroll the Gmail section |
| 12 | (Optional) Delete account | Confirmation; sign-in page |

## 8. Limited Use compliance — how Funnl complies

- **User-facing, prominent feature:** headers are used only to produce Suggestions in the
  Suggestions screen and the Settings card; no other use exists in code.
- **No transfer:** Gmail data is processed on Funnl's Supabase Edge Functions and stored in
  Funnl's Supabase database; it is never sent to Anthropic (AI features read only accepted
  interactions, which carry only the user's note), PostHog (behavior events carry a provider
  label only), Resend, or any advertiser/broker.
- **No human reading** except with the user's explicit permission for support, for security
  investigation, or where the law requires it (policy language).
- **No ads / lending / credit** uses.
- **Disclosure:** the Privacy Policy's Gmail section and the Limited Use paragraph (drafted in
  this branch) state all of the above in the user's own terms.

## 9. Data retention and deletion — exact behavior

| Data | Where | Retention | Deleted when |
|---|---|---|---|
| Google tokens (access/refresh) | `google_tokens`, AES-256-GCM | while connected | Calendar disconnect, account deletion (revoke best-effort + delete) |
| Gmail capability row | `google_connection_capabilities` | while connected | `disconnect_my_gmail` (disabled), Calendar disconnect / account deletion (cascade) |
| Sync cursor + lease | `gmail_sync_state` (service-role only) | while connected | `disconnect_my_gmail` (deleted), cascade |
| Suggestion (contact, date, type, source) | `interaction_candidates` | until acted on / expiry | accept → interaction; dismiss/invalidate; account deletion |
| Retained subject (≤160 chars) | `interaction_candidates.retained_subject` | ≤ 30 days | accept, dismiss, invalidation (deleted/TRASH/SPAM), Gmail disconnect, 30-day expiry job |
| HMAC fingerprint | `interaction_candidates` / `email_candidate_refs` | dedup tombstone | cascade on connection/account deletion |
| Message/thread/history identifiers | **not stored** | — | — |
| Bodies, snippets, attachments, HTML, raw MIME | **never requested** | — | — |

Known gap to close before pilot (backend follow-up, not a policy claim): if a user disconnects
**Google Calendar** (which removes the whole Google connection), pending Gmail suggestions keep
their subject line until acted on or the 30-day expiry; `disconnect_my_gmail` erases them
immediately. The policy is worded so both paths are truthful ("whichever comes first").

## 10. CASA / security assessment — status and next owner action

- **Status:** not started; not applicable until Google's restricted-scope review reaches its
  final step. Funnl **is** in scope (restricted data accessed through a third-party server).
- **What to expect:** Google's Trust & Safety team assigns AL1 or AL2 and invites the
  assessment; the owner selects an ADA-authorized lab, obtains a Letter of Assessment, and
  repeats annually. Cost is quoted by the lab; not published.
- **Owner action now:** budget for a paid annual assessment; identify one authorized lab from
  <https://appdefensealliance.dev/casa> ("Authorized Assessors"); keep this packet and the E2B
  design doc (`docs/phase-e2b-gmail-oauth-worker.md`) as the architecture evidence (bounded
  reads, encryption at rest, RLS, service-role-only tables, constant-time worker auth, no
  scheduler).
- **Do not** claim CASA/Google verification anywhere until the LOA and approval exist.

## 11. Google Cloud Console checklist — every field

**Owner-only (manual, needs the Google account that owns the project):**
- [ ] Search Console: verify `getfunnl.com` ownership with a project owner/editor account
- [ ] OAuth consent screen → Branding: app name, support email, logo upload, home page
  `https://www.getfunnl.com`, privacy policy `https://www.getfunnl.com/privacy`, authorized
  domain `getfunnl.com`, developer contact email
- [ ] Audience: External; confirm publishing status (Testing during pilot → In production
  when verified); add pilot test users while in Testing
- [ ] Data access / Scopes: add `https://www.googleapis.com/auth/gmail.readonly` (keep
  `calendar.events.readonly` and the identity scopes); paste the §5 justification; confirm no
  other Gmail scope is listed
- [ ] Clients → Web application: confirm the authorized redirect URI is exactly
  `https://www.getfunnl.com/api/google-oauth-callback` (already required by Calendar)
- [ ] Verification: upload the demo video (§7 storyboard), paste the reviewer instructions
  (§6), submit; monitor the developer contact inbox for Trust & Safety mail
- [ ] CASA: when invited, engage an authorized lab, obtain the LOA, calendar the annual renewal
- [ ] Publish the revised Privacy Policy **before** the consent screen goes live with the Gmail
  scope (the policy is drafted in this branch; legal review first)
- [ ] Supabase secrets (not in this phase): `GMAIL_INTEGRATION_ENABLED`, `GMAIL_WORKER_SECRET`
  (≥ 32 chars CSPRNG), `EMAIL_FINGERPRINT_KEY_V1`; deploy `google-oauth-callback` →
  `gmail-oauth-start` → `gmail-sync-worker` with Gmail still disabled; then the frontend PR-C
  with `VITE_GMAIL_CONNECTION_ENABLED` for the pilot build only

**Prepared by Claude (in this branch):**
- [x] Requirements research with citations (§1)
- [x] Consent-screen field values (§2), redirect URI (§3), scopes + justification (§4–5)
- [x] Reviewer instructions (§6) and demo storyboard (§7)
- [x] Limited Use, retention, and deletion explanations (§8–9)
- [x] Privacy Policy revision implemented in `src/pages/PrivacyPage.jsx` with tests
  (`tests/privacy-policy-gmail.test.js`) — **requires owner/legal review before merge/publish**
- [ ] Not possible for Claude: anything requiring the Google account, the Search Console, a
  paid lab, uploading a video, or publishing the policy
