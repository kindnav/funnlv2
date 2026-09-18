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
> `format=metadata` and an explicit `metadataHeaders` allowlist; Gmail's `snippet` field is
> never read, and any response carrying body data is rejected by the server. Only the
> sanitized subject line (≤160 characters) of a qualifying pending suggestion is retained, and
> it is deleted on accept, dismiss, removal from the mailbox, Gmail disconnect, or account
> deletion. Raw message and thread identifiers are not persisted in suggestions or reference
> records; dedup uses a keyed HMAC-SHA256 fingerprint, and incremental sync keeps only Gmail's
> opaque history cursor. The feature is prominent in the product's Settings and Suggestions
> screens, and the user can disconnect at any time.

### Why a narrower scope is insufficient (confirmed against Google's reference docs)
- `gmail.metadata` is **also a restricted scope** (same restricted-scope verification and
  security-assessment obligations), so choosing it would not reduce review burden.
- Google's `users.messages.list` reference states the `q` parameter "cannot be used when
  accessing the api using the gmail.metadata scope".
- Funnl bounds its **initial discovery** with a server-constructed `after:<epoch>` query
  (`q=after:<epoch> -in:chats`) so the first import covers roughly the previous 90 days and
  nothing older. Without `q`, Funnl could not enforce that same server-side bound: it would
  have to page through the mailbox's message list (which is ordered newest-first and is
  paginated, but carries no date filter) and might need to walk an arbitrarily large mailbox
  before reaching the relevant date boundary. Funnl intentionally refuses to perform an
  unbounded mailbox scan — its worker stops at fixed page/message/conversation/byte limits and
  treats a capped run as incomplete rather than continuing.
- Therefore `gmail.readonly` is required for Funnl's bounded Suggestions workflow, and Funnl
  uses it only in metadata format with an explicit header allowlist.
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
- **Service providers only:** Gmail-derived data is processed by Funnl's Supabase Edge
  Functions and stored in Funnl's Supabase database. Pending suggestions, retained subject
  previews, raw headers, identifiers, and tokens are never sent to Anthropic; an *accepted*
  suggestion becomes an ordinary interaction (type, date, user-written note, contact link) which
  the user may later send to Anthropic by using Funnl AI, under the existing AI disclosure.
  PostHog receives the account identifier/email and controlled usage events (a provider label
  only), never mailbox content or identifiers. Resend receives the account email for
  transactional mail only. Nothing goes to advertisers, brokers, or resellers.
- **No human reading** except with the user's explicit permission for support, for security
  investigation, or where the law requires it (policy language).
- **No ads / lending / credit** uses.
- **Disclosure:** the Privacy Policy's Gmail section and the Limited Use paragraph (drafted in
  this branch) state all of the above in the user's own terms.

## 9. Data retention and deletion — source-backed table

Legend — *Browser*: readable by the signed-in user's browser (RLS + column grants). *Providers*:
third-party services that can receive it. "Not enforced" = the code stores an intent but no
scheduled job runs it; the public policy therefore does **not** publish that maximum.

| Item | Processed / stored | Retention (actual) | Deleted by | Browser | Providers |
|---|---|---|---|---|---|
| Google access + refresh tokens | stored, AES-256-GCM (`google_tokens`) | while the Google connection exists | Calendar/Google disconnect, account deletion (`googleCleanup`: best-effort revoke + delete; FK cascade) | never | Google (used server-side); Supabase (storage) |
| Gmail capability row | stored (`google_connection_capabilities`) | while connected | `disconnect_my_gmail` (set `disabled`), connection deletion / account deletion (cascade) | 7 status columns only | Supabase |
| Gmail history cursor, lease, retry state, result codes | stored (`gmail_sync_state`, service-role only) | while connected | `disconnect_my_gmail` (row deleted), cascade | never | Supabase |
| Raw Gmail message / thread ids | **processed only** (worker memory during a run) | duration of one run | end of run | never | Supabase Edge runtime (transient) |
| Message timestamps, labels, mailbox address, history/page cursors, other response fields | processed; mailbox address also stored on the connection (`google_email`) | transient / while connected | end of run / connection deletion | mailbox address shown on the Settings card | Supabase |
| HMAC-SHA256 fingerprint + key version | stored (`interaction_candidates.source_fingerprint`, `email_candidate_refs`) | **lifetime of the candidate row** — no purge of terminal candidates exists | contact deletion or account deletion (FK cascade) | fingerprint column not granted to `authenticated` | Supabase |
| Retained subject preview (≤160 chars) | stored (`interaction_candidates.retained_subject`) | while the suggestion is pending; `context_expires_at` = +30 days is **recorded but not enforced** (`expire_pending_email_context` has no scheduler yet) | accept, dismiss, invalidation (deleted/TRASH/SPAM), `disconnect_my_gmail`, account deletion. **Not** cleared by the whole-Google/Calendar disconnect | yes (granted column, pending only) | Supabase; never Anthropic/PostHog/Resend |
| Pending suggestion (contact, date, type, source) | stored | until acted on | accept → interaction; dismiss; invalidation; contact/account deletion | yes | Supabase |
| Accepted / dismissed / invalidated candidate tombstone | stored (status row, subject NULL) | **lifetime of the contact/account** | contact deletion, account deletion | yes (status) | Supabase |
| Accepted interaction (type, date, user note, contact, `source='gmail'`) | stored (`interactions`) | until the user deletes it / contact / account | user action, cascade | yes | Supabase; **Anthropic when the user invokes Funnl AI** (type/date/note; never subject/ids/tokens); PostHog gets only `interaction_logged` behavior events |
| OAuth state rows (hash, encrypted PKCE, origin, integration) | stored (`google_oauth_states`) | 10-minute validity; consumed on use; stale rows swept on the next start call (>24 h) | consumption + best-effort sweep, account deletion | never | Supabase |
| Logs / controlled diagnostic codes | emitted by Edge Functions (codes and counts only) | per Supabase's function-log retention | Supabase retention | never | Supabase (logs); PostHog for frontend `$exception` diagnostics per the existing disclosure |
| Bodies, snippets, HTML, attachments, raw MIME, non-allowlisted headers | **never requested / discarded** (snippet may arrive in the response and is never read) | — | — | — | — |

### Mandatory backend corrections before the one-account Gmail pilot (not done in this branch)
1. **Whole-Google/Calendar disconnect must clear pending Gmail subjects.** `runGoogleLocalCleanup`
   deletes the connection (cascading capability, cursor, and reference rows) but never touches
   `interaction_candidates.retained_subject`. Until fixed, the policy discloses that this path
   leaves subjects until accept/dismiss/account deletion. Fix: a separately reviewed forward
   migration or an explicit invalidation step in the disconnect function.
2. **Schedule `expire_pending_email_context`.** The 30-day `context_expires_at` is stored but no
   job runs the expiry. Until a scheduler (or a worker-run hook) calls it, no 30-day maximum may
   be published. Owner/backend decision: pg_cron vs. worker-invoked vs. drop the promise.
3. **Owner/legal decision on tombstone retention.** Fingerprints and terminal candidate rows
   persist for the life of the contact/account by design (dedup). Either accept and keep the
   disclosure as written, or add a retention purge and a published maximum.

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
- [ ] Owner/backend: the three mandatory items in §9 (whole-Google disconnect subject cleanup,
  expiry scheduler, tombstone retention decision) before the mailbox pilot
- [ ] Not possible for Claude: anything requiring the Google account, the Search Console, a
  paid lab, uploading a video, or publishing the policy
