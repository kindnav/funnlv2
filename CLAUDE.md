# Funnl — Complete Project Reference

Keep this file current. When we make a durable decision, finish a feature, change the schema, or shift the plan — update this file. A new session should be able to read this and understand the project's current state without re-explanation.

---

## Current status

**Funnl is a live, deployed, multi-user MVP.** The full sign-up → email confirmation → sign-in → app flow works end to end.

- Live at **https://www.getfunnl.com** (getfunnl.com redirects to www)
- Deployed on Vercel, auto-deploys on push to `main`
- Resend.com is the transactional email provider (existing, connected via Supabase SMTP). Resend sending domain is `getfunnl.com` (Verified); DKIM at `resend._domainkey.getfunnl.com`, SPF and return-path MX at `send.getfunnl.com` — all verified. Gmail delivery reaches Primary inbox. iCloud places in Junk (unresolved — not a DNS failure). Outlook not yet tested. See Task 1 in Known future work.
- Supabase URL configuration: Site URL = `https://www.getfunnl.com`; Redirect URLs include `/welcome` and `/**`. Confirm signup template applied 2026-07-13.
- **Not yet shared with real students** — iCloud Junk placement and Outlook test still pending; see Task 1 in Known future work

---

## What Funnl is

Funnl is a **networking CRM for students** recruiting for internships and jobs. Students meet many contacts (recruiters, alumni, founders, other students) but track them poorly — spreadsheets or nothing. Relationships go cold. Funnl fixes that.

**Core loop:** Log who you meet → log every interaction and conversation → write notes and set follow-up dates → come back and see what needs attention.

**Critical framing:** Funnl is a **relationship-maintenance tool, NOT a sales pipeline.** The mental model is "don't lose track of people you've met." This distinction matters for every feature decision.

---

## Three-layer product plan

| Layer | Status | Description |
|---|---|---|
| **Layer 1** | ✅ Built | Core CRM: add/edit/delete contacts, log interactions, write notes, search, dashboard |
| **Layer 2** | 🔵 Next | Rule-based follow-up reminders, "going cold" flags based on days since last interaction |
| **Layer 3** | ✅ Built (A/B/C/D) | AI Pro feature (paid tier). Layers A (gate), B (contact from text), C (AI assistant chat) all done. Layer D (Stripe billing) built on branch `review/stripe-checkout` — awaiting deployment. See "AI Pro feature — build plan" section. |

The data schema (notes as freeform text, tags/skills as text arrays) was deliberately designed to feed Layer 3.

---

## Tech stack

- **Vite + React — JavaScript only, no TypeScript**
- **Tailwind CSS v4** — custom tokens in `src/index.css` using `@theme {}` block (not a config file)
- **Supabase** — PostgreSQL + auth; credentials in `.env` (never commit `.env`). URL config: Site URL = `https://www.getfunnl.com`, Redirect URLs include `https://www.getfunnl.com/welcome` and `https://www.getfunnl.com/**`. Signup confirmation uses `emailRedirectTo: 'https://www.getfunnl.com/welcome'` (set explicitly in `handleSignUp` in `SignInPage.jsx`). Setup guide: `docs/auth-email-setup.md`.
- **React Router v7** — client-side routing
- **Vercel** — live at `https://www.getfunnl.com`. Connected to GitHub (kindnav/funnlv2), auto-deploys on push to `main`. Env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST`) set in Vercel project settings. `vercel.json` at project root rewrites all routes to `index.html` so direct URL visits don't 404. `git.deploymentEnabled` is set to `{ "main": true, "*": false }` — only `main` generates a Vercel deployment; non-main branches do not create preview deployments.
- **PostHog** — product analytics. Project API key in `VITE_POSTHOG_KEY` (public/client-side key — safe to expose in frontend, unlike Anthropic/service-role keys). US region, host `https://us.i.posthog.com`. DOM autocapture is disabled. `$pageview` and `$pageleave` remain enabled automatically; product events are explicitly captured. Wrapper at `src/lib/analytics.js`.
- **Cloudflare DNS** — two CNAME records pointing `getfunnl.com` and `www.getfunnl.com` to Vercel, set to DNS-only (grey cloud). `getfunnl.com` redirects to `www.getfunnl.com`; www serves the application. Resend sending domain is `getfunnl.com`; DKIM TXT at `resend._domainkey.getfunnl.com` verified. Custom return-path subdomain `send.getfunnl.com`: SPF and return-path MX verified. No root SPF record exists or should be added. DMARC at `_dmarc.getfunnl.com` with `p=none`.

---

## Key file structure

```
src/
  components/
    ErrorBoundary.jsx      Global React error boundary mounted in main.jsx (wraps BrowserRouter). Catches all render crashes; shows Reload/Sign-out fallback; reports via trackError(error). Sign out: awaits supabase.auth.signOut(), then window.location.assign('/signin') in finally so the boundary state resets on full reload.
    Sidebar.jsx            Shared left nav (desktop only, hidden md:flex): logo, user card → /settings, nav links, YOUR TAGS dynamic section (top 8 user-tags by count, links to ?tag= filter), sign out. Fetches profile + tag counts on every route change.
    BottomNav.jsx          Mobile bottom tab bar (md:hidden): Home/Contacts/Follow-ups/Funnl AI, follow-up badge
    ContactListItem.jsx    Contact card in the 2-column grid (avatar tile, tags, relationship_type + how-met footer)
    AddContactDrawer.jsx   Right-side slide-in drawer for adding a contact; full-width on mobile, 452px on desktop; Escape/backdrop closes; scroll locked
    ImportContactsModal.jsx  3-step CSV import modal (upload → map → confirm). Two-pass header detection (Pass 1: header:false arrays → detectHeaderRow() finds real header, skipping preamble rows; Pass 2: reconstruct keyed objects from header row onward). Handles LinkedIn Connections exports (preamble + 'URL' column value-sniffed → linkedin_url when values contain linkedin.com). Shows teal detection banner in Step 2. Pro users get ai-map-csv Edge Function call on unresolved columns only (deterministic mappings take precedence). transformRow() applies the final assignment to all rows.
  pages/
    DashboardPage.jsx      Landing screen after login: stats, follow-ups due, recent contacts
    ContactsPage.jsx       Contacts directory/table + search (name/company/role/tag) + URL-based tag filter (?tag=recruiter) + view toggle (directory/table, persisted to localStorage funnl_contacts_view). Table view has sortable columns (Name, Company, Role, Relationship) and Log Interaction hover-reveal button per row. Directory view is default.
    ContactDetailPage.jsx  Full contact profile: two-column on desktop, stacked on mobile
    LandingPage.jsx        Public marketing page at /; visible to logged-out users only; 11 sections; 3 tracked CTAs (nav/hero/bottom)
    SettingsPage.jsx       Account-card layout: display name input + Save; read-only email + joined date; sign out. Desktop only for v1.
    SignInPage.jsx         Dark split-screen: sign-in mode + sign-up mode + email-confirmation pending state + forgot/reset-sent modes. Route-synchronized: /signin opens sign-in mode, /signup opens sign-up mode. After successful sign-in, navigate('/', { replace: true }) fires immediately to prevent blank screen at /signin. Module-level constants welcomeRedirectUrl and resetRedirectUrl use import.meta.env.PROD to target www.getfunnl.com in production and window.location.origin in dev. Pending state has Resend confirmation email button with 60-second client cooldown, loading state, and success/error feedback (supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: welcomeRedirectUrl } })).
    WelcomePage.jsx        Email-confirmation landing page at /welcome — no sidebar, accessible to logged-out users. On mount: calls supabase.auth.getSession(), checks email_confirmed_at, identifies user via identifyUser(), fires email_confirmed, then writes the localStorage flag (funnl_confirmed_<userId>). Sign-out on continue.
    ResetPasswordPage.jsx  Password recovery page at /reset-password — no sidebar, handles Supabase recovery link
    PrivacyPage.jsx        Plain-language privacy policy at /privacy — no sidebar, accessible logged-out and logged-in
  lib/
    supabase.js            Supabase client, reads VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from .env
    avatarUtils.js         getAvatarColor(name) and getInitials(name) — single source of truth for avatar colors
    analytics.js           PostHog wrapper: initAnalytics(), identifyUser(), track(), resetAnalytics(), trackError(error)
    csvHeaderDetect.js     Pure CSV header-detection utilities (no React/Supabase deps — safe to import in Node test files). Exports: normalizeHeader, HEADER_MAP, scoreHeaderRow, detectHeaderRow (two-pass; scans first 30 rows, returns -1 if no valid header found), isLinkedInExport (checks for First Name + Last Name + Connected On), buildInitialAssignment. Used by ImportContactsModal.jsx and tests/csv-header-detect.test.js.
    pro-trial-helpers.js   Pure Pro trial helpers (no React/Supabase deps — safe to import in Node test files). Exports: isTrialActive(trial, now), computeTrialStatus(trial, now). Used by ai.js (which re-exports them) and tests/pro-trial.test.js.
    pro-access-status.js   Frontend wrapper for get_my_pro_access_status() RPC. Export: getProAccessStatus() → server-authoritative status object or null on error. Used by ai.js, Sidebar, FunnlAIPage, SettingsPage, WelcomePage. Never call new Date() for access decisions — use this instead.
tests/
  csv-header-detect.test.js  27 zero-dependency Node.js tests for csvHeaderDetect.js. Run with: node tests/csv-header-detect.test.js. Covers fixtures A–F (LinkedIn preamble, clean CSV, BOM, misleading preamble, value whitespace, unrecognizable file) plus edge cases.
  App.jsx                  Auth gating, shared layout (Sidebar + main + BottomNav), all routes
  index.css                Tailwind import + @theme design tokens + @keyframes (slide-in-right, fade-in)
  main.jsx                 React entry; wraps App in ErrorBoundary + BrowserRouter; calls initAnalytics()
index.html                 Google Fonts link tags (Plus Jakarta Sans, Space Grotesk, JetBrains Mono)
CLAUDE.md                  This file — project reference, keep current
docs/
  auth-email-setup.md      Operational guide: audit existing Resend.com config, DNS authentication (SPF/DKIM/DMARC — values from Resend only), Supabase URL config, apply email template, deliverability diagnosis (Gmail + Outlook tests, header inspection), Leaked Password Protection, handle_new_user migration CLI workflow
  phase-4-pilot-plan.md    Pilot objective, target group, core session tasks, primary funnel, activation/retention definitions, feedback process, interview questions, founder checklist, decision rules
  posthog-pilot-dashboard.md  Setup instructions for 12 PostHog insights: signup funnel, confirmation conversion trend, official activation funnel (email_confirmed → activation_completed), activation milestone diagnostic, first core-loop diagnostic, time to activation, WAU (Core product activity Action), follow-up loop, CSV adoption, AI adoption, 7-day retention (activation_completed cohort, 30%/25% thresholds), error monitoring
  pilot-feedback-guide.md  5-minute observation checklist, non-leading questions, post-session questions, severity system (P0–P3), feature request frequency rule
supabase/
  templates/
    confirm-signup.html    Custom HTML email template for signup confirmation. MUST be pasted into Supabase → Auth → Email Templates → Confirm signup. Uses {{ .ConfirmationURL }} for the confirmation link.
```

---

## Routes

**Logged-out tree (unauthenticated users in `App.jsx`):**

| Path | Component | Notes |
|---|---|---|
| `/` | LandingPage | Public marketing page; 11 sections; 3 CTAs tracked via `landing_cta_clicked` |
| `/signin` | SignInPage | Sign-in mode (auto-detected from pathname) |
| `/signup` | SignInPage | Sign-up mode (auto-detected from pathname) |
| `/welcome` | WelcomePage | Email-confirmation landing; no sidebar |
| `/reset-password` | ResetPasswordPage | Password recovery; handles Supabase recovery link |
| `/privacy` | PrivacyPage | Plain-language privacy policy |
| `*` | — | Redirects to `/signin` |

**Authenticated tree (logged-in users in `App.jsx`):**

| Path | Component | Notes |
|---|---|---|
| `/` | DashboardPage | Landing screen after login; activation checklist shown until all 3 steps complete |
| `/contacts` | ContactsPage | Directory/table view + search + filter; `?tag=recruiter` drives filter pills; view toggle persists to `localStorage` |
| `/contacts/:id` | ContactDetailPage | Full profile + interaction timeline |
| `/followups` | FollowUpsPage | Real data — overdue/today/upcoming buckets; Mark Done, Snooze, Log Result complete |
| `/ai` | FunnlAIPage | Working AI chat for Pro users; locked state for non-Pro |
| `/settings` | SettingsPage | Display name + sign out; reads/writes `profiles` table |
| `/welcome` | WelcomePage | Email-confirmation landing; no sidebar; accessible while authenticated |
| `/reset-password` | ResetPasswordPage | Password recovery; no sidebar; accessible while authenticated |
| `/privacy` | PrivacyPage | Plain-language privacy policy; accessible while authenticated |
| `/signin`, `/signup` | — | Defensive redirects to `/` — prevents blank screen if auth state updates while on these paths |
| `*` | — | Defensive redirect to `/` |

---

## Analytics (PostHog)

**Key principle:** track BEHAVIOR only — never contact content (no names, companies, notes, emails, or any user-typed data goes to PostHog).

**Identification:** `posthog.identify(userId, { email })` called on every sign-in via `onAuthStateChange` in App.jsx. Links all events to the user so their journey is traceable in the PostHog dashboard.

**Events tracked:**

| Event | Where it fires | Properties | Purpose |
|---|---|---|---|
| `user_signed_up` | SignInPage after signUp() | none | Signup funnel step 2 — signup request succeeded, confirmation email sent |
| `first_contact_added` | AddContactDrawer after insert (count===1) | none | First-contact UX diagnostic |
| `contact_added` | AddContactDrawer after insert | `{ via_ai_fill, has_tags, has_relationship_type }` — booleans only | Overall usage |
| `interaction_logged` | ContactDetailPage handleLogInteraction | `{ interaction_type, has_follow_up, has_notes }` — controlled enum + booleans | Core value / retention signal |
| `followup_set` | ContactDetailPage handleLogInteraction (when followUpDate set) | none | Feature usage |
| `followup_completed` | FollowUpsPage handleDone / ContactDetailPage handleLogInteraction (via Log Result) | `{ method: 'mark_done'\|'log_result' }` — via `completeFollowUp` `deps.method`; Mark Done → `'mark_done'`, Log Result → `'log_result'` | Core loop closure |
| `followup_snoozed` | FollowUpsPage handleSnooze | `{ option: 'tomorrow'\|'three_days'\|'one_week'\|'custom' }` — controlled enum only | Feature usage |
| `csv_import_used` | ImportContactsModal handleImport | `{ contacts_imported: number, ai_assisted: boolean }` | Feature usage |
| `ai_assistant_used` | FunnlAIPage sendMessage on success | none | AI feature usage |
| `ai_assistant_failed` | FunnlAIPage sendMessage or retryMessage on any error path | `{ code: controlledErrorCode, retryable: boolean }` — no prompt text, no contact data | AI reliability diagnostic |
| `ai_contact_link_clicked` | FunnlAIPage anchor renderer — when user clicks a validated contact link in an AI reply | `{ source: 'ai_response' }` — no contact ID, no name | AI contact link engagement |
| `ai_fill_used` | AddContactDrawer handleAIParse on success | `{ fields_filled: number }` | AI feature usage |
| `landing_cta_clicked` | LandingPage — all three CTA buttons | `{ location: 'nav'\|'hero'\|'bottom' }` | Acquisition / landing page conversion |
| `signup_started` | SignInPage on mount when mode === 'signup' | none | Signup funnel step 1 — user arrived at the signup form |
| `activation_checklist_viewed` | DashboardPage on mount when checklist is shown | none | Onboarding engagement |
| `activation_step_completed` | DashboardPage recordMilestones — once per step, idempotent | `{ step: 'five_contacts'\|'first_interaction'\|'first_followup' }` | Phase 2A activation tracking |
| `activation_completed` | DashboardPage recordMilestones — once when all 3 steps done | `{ contacts_count: number }` | Canonical durable activation event — fires once when all three profiles milestones are set (5 contacts + 1 interaction + 1 follow-up) |
| `email_confirmed` | WelcomePage on mount — fires after `supabase.auth.getSession()` confirms `email_confirmed_at` is set | none | Signup funnel step 3 / activation funnel anchor |
| `user_signed_in` | SignInPage `handleSignIn` after `signInWithPassword` succeeds | none | Acquisition funnel — sign-in step |
| `csv_mapping_completed` | ImportContactsModal Step 2 "Next →" button — fires once per unique mapping state, not on every Back/Confirm navigation | `{ mapping_mode: 'deterministic'\|'ai_assisted'\|'manual', detected_format: 'linkedin'\|'generic', contact_count: number, inferred_tags_enabled: boolean, inferred_relationships_enabled: boolean }` | CSV import funnel — mapping step completed |
| `csv_mapping_failed` | ImportContactsModal handleFile on parse error | `{ reason: 'no_header'\|'no_data_rows'\|'malformed_csv'\|'empty_file'\|'unknown' }` — controlled enum | CSV import error diagnostic |
| `post_import_action_clicked` | ImportContactsModal done screen CTAs | `{ action: 'log_recent_outreach'\|'view_contacts'\|'dismiss' }` — controlled enum | Post-import activation path |
| `outreach_status_changed` | ContactDetailPage handleLogInteraction (new) and handleSaveInteraction (edit) when outreach status is set or cleared | `{ status: 'awaiting_response'\|'responded'\|'meeting_booked'\|'no_response'\|'declined'\|'cleared', context: 'new_interaction'\|'edit_interaction' }` — controlled enum | Outreach response tracking |
| `pro_trial_started` | WelcomePage.jsx — fires after `get_my_pro_access_status()` confirms `trial_active=true`, with localStorage deduplication keyed by user ID | none | Trial activation (best-effort, once per browser per user ID; another browser/device may fire it again — PostHog deduplicates by distinct_id in funnel views) |
| `ai_chat_reset` | FunnlAIPage.jsx — when user clicks "Start new chat" or when `invalid_request` error auto-suggests a reset | `{ source: 'user_action'\|'ai_error_recovery' }` — controlled enum | AI chat session management; measures how often users need to reset due to error vs voluntary |
| `checkout_started` | SettingsPage.jsx + FunnlAIPage.jsx — before invoking `create-checkout-session` | `{ source: 'settings'\|'ai_page' }` — controlled enum | Checkout funnel — initiated |
| `checkout_creation_failed` | SettingsPage.jsx + FunnlAIPage.jsx — when `create-checkout-session` returns an error | `{ source: 'settings'\|'ai_page' }` — controlled enum | Checkout funnel — failed before redirect |
| `checkout_returned` | SettingsPage.jsx — on mount when `?checkout=` param is present | `{ result: 'success'\|'cancelled' }` — controlled enum | Checkout funnel — user returned from Stripe |
| `subscription_access_confirmed` | SettingsPage.jsx — after polling loop confirms `can_use_pro` | none | Checkout funnel — Pro access verified after return |
| `subscription_confirmation_timed_out` | SettingsPage.jsx — after polling loop exhausts all attempts (~22.5s) without confirmation | none | Checkout funnel — webhook delayed; user shown retry |
| `billing_portal_opened` | SettingsPage.jsx — after `create-billing-portal-session` returns a URL | `{ source: 'settings' }` — controlled enum | Subscription management — billing portal session started |

**Deduplication note — `email_confirmed`:** Uses a `localStorage` flag keyed by user ID (`funnl_confirmed_<userId>`) to prevent re-fires on refresh or repeat visits to `/welcome`. This flag is per-browser: if the user confirms on one device and later visits `/welcome` on a different device or browser, the event may fire a second time on that device. PostHog deduplicates by distinct_id (user ID) across browsers for funnel purposes, so this cross-browser re-fire does not inflate unique-user counts in funnel reports. Raw event counts may appear slightly elevated.

**Deduplication note — `pro_trial_started`:** Uses a separate `localStorage` flag (`funnl_trial_started_<userId>`) keyed by user ID. Same per-browser semantics as `email_confirmed`: best-effort deduplication, not exact-once per user globally. Another browser or device may fire the event again. Fires only after `get_my_pro_access_status()` confirms `trial_active=true` — never driven by `start_my_pro_trial().started_now`. Use unique distinct_id counts (not raw event counts) in PostHog for funnel analysis.

**PostHog error reporting (separate from the 21 custom product events):** `trackError(error)` in `src/lib/analytics.js` calls `posthog.captureException(error)`. This fires the PostHog system event `$exception` — it is NOT one of Funnl's 21 custom product events and must not be counted as such. It is called from `ErrorBoundary.componentDidCatch` on unhandled render crashes. Funnl deliberately omits React's `componentStack`; PostHog may collect the error name, message, and stack as diagnostic exception data. This diagnostic collection is disclosed in the privacy policy. Safely no-ops when `VITE_POSTHOG_KEY` is absent.

**What PostHog tracks automatically (no code needed):** pageviews, session start/end, returning users, browser/device/country.

**Key signals to build in PostHog:**
- **Signup funnel** (Insights → Funnel): `signup_started` → `user_signed_up` → `email_confirmed`
- **Official activation funnel** (Insights → Funnel): `email_confirmed` → `activation_completed`
- **First core-loop diagnostic** (Insights → Funnel): `email_confirmed` → `first_contact_added` → `interaction_logged` → `followup_set` — UX diagnostic only, not the activation definition
- **WAU** (Insights → Trend): unique users performing the Core product activity Action (contact_added / csv_import_used / interaction_logged / followup_set / followup_completed / followup_snoozed), weekly. Excludes pageviews and sign-ins.
- **Day-7 retention** (Insights → Retention): cohort event = `activation_completed`; return event = Core product activity Action when supported, otherwise `interaction_logged` as the documented proxy. Target 30%+; warning below 25%; do not interpret before 5 eligible activated users have passed Day 7.
- **Live verification:** PostHog left sidebar → Activity → Live events. Do an action; event appears within seconds.
- See `docs/posthog-pilot-dashboard.md` for complete setup instructions for all 12 insights.

**PostHog project API key** (`VITE_POSTHOG_KEY`) is intentionally public — safe in frontend code. It can only send events in, not read data. Completely different from Anthropic API key and Supabase service-role key (those must stay in Supabase secrets, never in frontend).

---

## Database schema

**Row Level Security is ON for all three tables and has been verified with a two-user isolation test.**

### `contacts`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Auto-generated PK |
| `user_id` | uuid | FK → auth.users, default auth.uid() |
| `name` | text NOT NULL | Required |
| `company` | text | Optional |
| `role` | text | Optional |
| `how_met` | text | Optional |
| `email` | text | Optional |
| `linkedin_url` | text | Optional |
| `tags` | text[] | Optional — relationship labels e.g. ["recruiter", "target firm"]. Drives the sidebar YOUR TAGS section and ContactsPage ?tag= filter. |
| `relationship_type` | text | Optional — preset select: Mentor, Collaborator, Referral path, Potential employer, Connector, Other. |
| `relationship_note` | text | Optional — freeform "why this person matters" note. |
| `created_at` | timestamptz | Auto-set |

### `interactions`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Auto-generated PK |
| `contact_id` | uuid | FK → contacts.id **ON DELETE CASCADE** |
| `user_id` | uuid | FK → auth.users, default auth.uid() |
| `type` | text | One of: Coffee chat, Email, Event, Call, Message, Other |
| `interaction_date` | date NOT NULL | |
| `notes` | text | Freeform — the heart of the app |
| `follow_up_date` | date | Optional — drives dashboard and sidebar badge |
| `outreach_status` | text | Optional — one of: awaiting_response \| responded \| meeting_booked \| no_response \| declined. Named CHECK constraint `interactions_outreach_status_check`. Migration applied to production 2026-07-24. |
| `follow_up_completed_at` | timestamptz | Nullable — set to current UTC timestamp when a follow-up is marked Done or completed via Log Result. Cleared to NULL on Undo or Snooze. Used by `/followups` to classify rows into the "Recently Completed" section (within 7 local calendar days). Migration applied to production 2026-07-29. |
| `follow_up_previous_date` | date | Nullable — stores the original `follow_up_date` value at the moment of completion, so Undo can restore it exactly. Cleared to NULL on Undo or Snooze. Migration applied to production 2026-07-29. |
| `follow_up_completion_method` | text | Nullable — one of `mark_done` \| `log_result`. Named CHECK constraint `interactions_follow_up_completion_method_check`. Records how the follow-up was completed. Cleared to NULL on Undo or Snooze. Migration applied to production 2026-07-29. |
| `created_at` | timestamptz | Auto-set |

**Relationship:** one contact → many interactions. Deleting a contact cascades to delete all their interactions.

**Follow-up completion lifecycle:**
- **Mark Done / Log Result (complete):** `follow_up_date → null`, `follow_up_completed_at → now()`, `follow_up_previous_date → previous follow_up_date`, `follow_up_completion_method → 'mark_done' | 'log_result'`. All four fields updated atomically in one DB update. Row then appears in "Recently Completed" section on `/followups` for 7 local calendar days.
- **Undo:** `follow_up_date → restored from follow_up_previous_date`, `follow_up_completed_at → null`, `follow_up_previous_date → null`, `follow_up_completion_method → null`. Row returns to its previous open state.
- **Snooze / Nudge:** `follow_up_date → new date`, all three completion fields cleared to null. Snooze on a completed row removes it from Recently Completed and puts it back as an open upcoming follow-up.
- **Analytics:** `track('followup_completed', { method: 'mark_done' | 'log_result' })` fires on success only, after DB update. No analytics for Undo.
- **Method allowlist:** `completeFollowUp` accepts `mark_done` or `log_result`. Any invalid or missing method defaults safely to `mark_done` before the DB update and before analytics.

### `profiles`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK, FK → auth.users ON DELETE CASCADE |
| `email` | text | Copied from auth.users on signup by trigger — used to identify users when granting Pro access |
| `display_name` | text | Optional — shown in sidebar |
| `ai_enabled` | boolean | Default false — flip to true in Supabase to grant Pro/AI access |
| `updated_at` | timestamptz | Set on every save |
| `activation_five_contacts_at` | timestamptz | Nullable — set when user reaches 5 contacts. Written with `WHERE col IS NULL` for idempotent deduplication. |
| `activation_first_interaction_at` | timestamptz | Nullable — set on first logged interaction. Same idempotent write. |
| `activation_first_followup_at` | timestamptz | Nullable — set on first follow-up date set. Same idempotent write. |
| `activation_completed_at` | timestamptz | Nullable — set when all three activation steps are complete. Same idempotent write. |

**Applied migrations:**
- `supabase/migrations/20260713075431_add_activation_milestones.sql` — adds the four activation timestamp columns above to `profiles`, with backfill SQL for existing users. Applied to production 2026-07-13.
- `supabase/migrations/20260713185900_harden_handle_new_user.sql` — revokes EXECUTE on `public.handle_new_user()` from `PUBLIC`, `anon`, and `authenticated`. Applied to production 2026-07-13 via `supabase db push`. Post-migration verification: PUBLIC absent from explicit ACL; `anon` and `authenticated` effective execute = false; trigger `on_auth_user_created` still enabled; function owner, SECURITY DEFINER, and search_path unchanged. Requires a real signup/profile creation test to confirm trigger path is unaffected.
- `supabase/migrations/20260721000000_add_outreach_status.sql` — adds nullable `outreach_status text` column to `public.interactions` with named CHECK constraint `interactions_outreach_status_check` (five allowed values). Applied to production 2026-07-24 via `supabase db push --linked`. Column verified: text, nullable YES, no default. Constraint verified: correct five-value check, NULL permitted. Existing 5 interaction rows unaffected (all `outreach_status = NULL`). RLS and all four ownership policies verified unchanged.
- `supabase/migrations/20260729000000_add_followup_completion.sql` — adds nullable `follow_up_completed_at timestamptz`, `follow_up_previous_date date`, and `follow_up_completion_method text` columns to `public.interactions`, with named CHECK constraint `interactions_follow_up_completion_method_check` (allowed values: `mark_done`, `log_result`). Applied to production 2026-07-29. Powers the "Recently Completed" section, Undo, and completion-method tracking on `/followups`.
- `supabase/migrations/20260727000000_add_pro_trials.sql` — creates `public.pro_trials` table with explicit REVOKE/GRANT hardening (no INSERT/UPDATE/DELETE for authenticated), updates `handle_new_user()` to also create a trial eligibility row on signup (auto-confirmed accounts start trial immediately; normal flow starts with NULL/NULL), adds `on_email_confirmed` DB trigger (`AFTER UPDATE OF email_confirmed_at ON auth.users`) that activates the trial on the NULL→non-NULL transition, and creates two RPCs: `start_my_pro_trial()` (SECURITY DEFINER, recovery mechanism only) and `get_my_pro_access_status()` (SECURITY INVOKER, server-authoritative entitlement using DB clock). All functions use `SET search_path = ''` with fully qualified object names. **NOT YET APPLIED to production** — branch `review/pro-trial-7-days`, Draft PR #23 pending. Do not apply without explicit approval.

**Pro trial production rollout order (do not deviate):**
  1. Apply only this migration: `supabase db push --linked` (verify one pending migration first with `supabase migration list --linked`)
  2. Run verification checklist in migration file comments (table, RLS, ACL, triggers, functions, sign-up test)
  3. Deploy all four AI Edge Functions (ai-chat, ai-parse-contact, ai-map-csv, ai-categorize-contacts) — they now query `pro_trials` via shared helper
  4. Merge the frontend PR into main; wait for Vercel READY
  5. Test: new signup → email confirmation → trial active, AI access works
  6. Test: existing permanent-Pro users (`ai_enabled=true`) still have access; badge shows PRO not DAYS LEFT
  **Never deploy frontend before migration is applied — `get_my_pro_access_status()` RPC does not exist until migration runs.**

The original schema (contacts, interactions, profiles, RLS policies, triggers) was created manually in Supabase before the migration system was set up — no baseline migration file exists for it (known limitation).

**Profile rows are auto-created on signup via a Postgres trigger** (`on_auth_user_created` on `auth.users`). The trigger function `public.handle_new_user()` runs `SECURITY DEFINER` (bypasses RLS) and inserts a row with `id`, `email`, `ai_enabled=false`, `display_name=null` the moment a new user signs up. `ON CONFLICT (id) DO NOTHING` makes it safe if a row somehow already exists.  
After migration `20260727000000_add_pro_trials.sql` is applied, `handle_new_user()` also inserts a `pro_trials` row with `started_at = NULL, ends_at = NULL` on every new signup.

**To grant Pro access to a user:** `UPDATE profiles SET ai_enabled = true WHERE email = 'their@email.com';` in the Supabase SQL editor.

Settings page `upsert()` still works — now it always UPDATES an existing row (never needs to INSERT). Existing accounts were backfilled with `email` and profile rows via a one-time SQL migration.

RLS: UPDATE policy prevents users from changing `ai_enabled` on their own row. The `school` column was dropped earlier. Sidebar falls back to email username / "Funnl user" if `display_name` is null.

### `pro_trials` (pending migration `20260727000000_add_pro_trials.sql`)
| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid | PK, FK → auth.users ON DELETE CASCADE |
| `started_at` | timestamptz | Nullable — NULL until email confirmed (set by `on_email_confirmed` trigger or recovery RPC) |
| `ends_at` | timestamptz | Nullable — NULL until started; always = started_at + 7 days when set |
| `created_at` | timestamptz | Auto-set on INSERT |

**Trial active when:** `started_at IS NOT NULL AND ends_at IS NOT NULL AND now() < ends_at`  
**Effective Pro =** `profiles.ai_enabled = true` (permanent) **OR** active trial — checked by the shared helper.  
**Constraint:** `pro_trials_dates_consistent` — both NULL (eligible) or both set (started/expired), ends_at > started_at.  
**RLS:** SELECT only for authenticated using `(SELECT auth.uid()) = user_id` subquery form. `REVOKE ALL FROM PUBLIC, anon`; `REVOKE INSERT/UPDATE/DELETE FROM authenticated`. All writes go through SECURITY DEFINER functions only.

**Trial activation paths (in priority order):**
1. `handle_new_user()` trigger — for auto-confirmed accounts (OAuth, admin-created), starts the trial immediately.
2. `on_email_confirmed` DB trigger (`AFTER UPDATE OF email_confirmed_at ON auth.users`, function `activate_trial_on_confirmation()`) — primary path for normal signup; fires when `email_confirmed_at` transitions NULL → non-NULL. `WHERE started_at IS NULL` guard prevents resetting an existing trial.
3. `start_my_pro_trial()` RPC — idempotent reconciliation step only. Called from `WelcomePage.jsx` before reading status. Covers the case where a confirmed user's eligible row still has `started_at IS NULL` (e.g., trigger did not fire due to transient infrastructure issues). Limitations: only updates existing rows, does not create missing rows, cannot backfill pre-migration users or extend existing trials. Note: a PostgreSQL trigger failure aborts the confirmation transaction — the scenario this RPC covers is a confirmed account with an unactivated eligible row, not a trigger that ran silently.

**`get_my_pro_access_status()` RPC** — SECURITY INVOKER (uses DB clock `now()`, not browser `Date()`). Returns: `permanent_pro, trial_eligible, trial_active, trial_expired, days_remaining, ends_at, server_now, can_use_pro`. Called by: `src/lib/pro-access-status.js` → `src/lib/ai.js` (canUseAI, getTrialStatus), Sidebar, FunnlAIPage, SettingsPage, WelcomePage. Never use browser `new Date()` for access decisions.

**`start_my_pro_trial()` RPC** — SECURITY DEFINER, callable by authenticated only. Guards: caller authenticated + email_confirmed_at IS NOT NULL. Atomic `WHERE started_at IS NULL` guard. Returns `{ started_now, started_at, ends_at, server_now }`. Idempotent reconciliation step — only updates existing eligible rows, does not create missing rows or extend trials. `started_now` value is not used for UI or analytics (use `get_my_pro_access_status()` instead). Note: a PostgreSQL trigger failure aborts the enclosing confirmation transaction; the scenario this RPC covers is a confirmed user with an unactivated eligible row.

**`activate_trial_on_confirmation()` trigger function** — SECURITY DEFINER, executed by `on_email_confirmed` trigger only. `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` — not callable directly.

**Server-side seam** — `supabase/functions/shared/pro-entitlement.js` exports `evaluateProEntitlement(profile, trial, now)` (pure) and `loadProEntitlement(supabaseAdmin, userId)` (DI-injectable). All four Edge Functions import this; no duplicated entitlement code. Stripe-ready: update this file for Layer D.

**Design constraints (permanent — do not change without Naveen's approval):**
- `ai_enabled` is NEVER set to true for trial users. Trial access is entirely in `pro_trials`.
- Permanent Pro (`ai_enabled = true`) is preserved regardless of trial state.
- No backfill of existing users — only accounts created after the migration get a trial row.
- Frontend access decisions always use `get_my_pro_access_status()` RPC — never `new Date()` comparisons.
- `src/lib/pro-trial-helpers.js` contains pure `isTrialActive()` and `computeTrialStatus()` functions — no Supabase imports — safe to unit-test in Node.js. Re-exported from `src/lib/ai.js` for backward compatibility.

---

## Design system

Every authenticated screen uses the same shell: fixed 248px sidebar (`Sidebar.jsx`) + scrollable `bg-surface` content area. All new screens must follow these tokens exactly.

### Fonts
| Class | Family | Used for |
|---|---|---|
| `font-sans` | Plus Jakarta Sans 400–800 | All UI text — the default |
| `font-display` | Space Grotesk 500–700 | Page h1 titles, logo wordmark, large stat numbers |
| `font-mono` | JetBrains Mono 400–600 | Section eyebrow labels, tag/skill chips, metadata |

### Color tokens (defined in `src/index.css @theme` → Tailwind utilities)
| Token | Hex | Used for |
|---|---|---|
| `bg-base` | `#060608` | Root background |
| `bg-surface` | `#0B0B0E` | Main content area |
| `bg-sidebar` | `#100F14` | Sidebar |
| `bg-card` | `#141419` | Cards and panels |
| `bg-elevated` | `#1A1A21` | Raised elements, secondary buttons |
| `bg-input` | `#131318` | Form inputs |
| `text-hi` / `bg-hi` | `#F4F3F8` | Primary text; white button fill |
| `text-mid` | `#A0A0AD` | Secondary text, idle nav labels |
| `text-muted` | `#9A9AA5` | Body/description text |
| `text-low` | `#6C6C78` | Low-emphasis, icon strokes, placeholder icons |
| `text-lower` | `#54545E` | Disabled, helper text |
| `text-accent` / `bg-accent` | `#8B7CFF` | Brand accent: links, active nav, accent icons |
| `text-success` / `bg-success` | `#2FD4B6` | Done/complete states |
| `text-warning` / `bg-warning` | `#FFB84D` | Follow-ups due (amber) |
| `bg-warning-deep` | `#F5A623` | Recruiters pipeline dot, deep amber |
| `text-danger` / `bg-danger` | `#FF6B8A` | Overdue, errors, delete actions |
| `text-tag` | `#B4A8FF` | Tag pill text |
| `text-skill` | `#9EA0AD` | Skill chip text |

### Primary gradient (brand)
`bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)]` — logo tiles, primary buttons, active icon glow

### Borders (arbitrary Tailwind values)
- Subtle: `border-[rgba(255,255,255,0.06)]`
- Default: `border-[rgba(255,255,255,0.07)]`
- Strong: `border-[rgba(255,255,255,0.09)]`

### Active nav item
`bg-[rgba(108,92,255,0.14)] text-hi shadow-[inset_0_0_0_1px_rgba(139,124,255,0.18)]`

### Spacing scale
Stick to `4 · 8 · 12 · 16 · 24 · 32px` (Tailwind gap-1 through gap-8)

### Border radius scale
- `rounded-lg` (8px) — small chips, icon tiles
- `rounded-xl` (12px) — inputs, user cards
- `rounded-2xl` (16px) — cards and panels
- `rounded-[18px]` or `rounded-[20px]` — hero cards, modal overlays
- `rounded-full` — tags, badges, filter pills

### CSS animations (in `src/index.css`)
- `slide-in-right 0.25s ease-out` — AddContactDrawer slides in from right
- `fade-in 0.2s ease-out` — backdrop fades in

### Contact avatar colors
Derived deterministically from contact name using a hash → 6-color palette (purple, teal, pink-orange, blue, amber, lavender). Same contact always gets the same color. Single source of truth: `src/lib/avatarUtils.js` — import `getAvatarColor` and `getInitials` from there in any new component that needs them.

---

## Filter state: URL-based tag filtering

The contacts page filter pills use `useSearchParams`. Active tag is stored as `?tag=recruiter` in the URL. **Sidebar YOUR TAGS section is dynamic** — queries the user's own contacts, counts tag occurrences in JS, sorts by count descending, caps at top 8. Each tag links to `/contacts?tag=<tag>`. Active tag is highlighted. Empty state shows a quiet one-line message. ContactsPage handles the param unchanged.

---

## What's built vs. coming soon

| Feature | Status |
|---|---|
| Sign in / sign up with email confirmation | ✅ |
| Add / edit / delete contacts | ✅ Delete on detail page (existing inline confirmation). Trash icon on contact cards: hover-reveal only (opacity-0 + pointer-events-none by default — not tappable on mobile). Clicking card trash opens a confirmation modal (Cancel / Yes delete). Detail page delete unchanged. |
| Delete all contacts | ✅ De-emphasized button at bottom of contacts list (only shown when contacts exist). Two-step guard: (1) modal shows exact count, (2) user must type "delete all contacts" exactly before the delete button enables. Scoped two ways: `.eq('user_id', user.id)` in query + RLS enforces `auth.uid() = user_id` at the database level. ON DELETE CASCADE handles interactions automatically. |
| Log / edit / delete interactions with notes | ✅ |
| Follow-up dates on interactions | ✅ (stored; displayed on dashboard and detail page) |
| Search contacts by name, company, role, tag | ✅ |
| Filter contacts by tag (URL-based) | ✅ |
| **Contacts table/spreadsheet view** | ✅ View toggle (directory / table) in ContactsPage search bar. Table view has sortable columns: Name, Company, Role, Relationship. Tags column shown but not sortable (multi-value). Log Interaction hover-reveal button per row navigates to contact detail with `openInteractionForm: true`. View preference persisted to `localStorage` (`funnl_contacts_view`). Directory view is default. |
| Dashboard with real stats + follow-up list | ✅ |
| Add contact drawer (slide-in, Escape closes, scroll locked) | ✅ |
| Per-user data isolation (RLS, two-user verified) | ✅ |
| Follow-ups screen (`/followups`) | ✅ Real data — shows all interactions with a follow_up_date, bucketed into Overdue / Today / Upcoming with correct local-timezone date logic. Mark Done, Snooze/Reschedule, Log Result all complete (Phase 3). |
| Funnl AI screen (`/ai`) | ✅ Working AI chat UI. Pro users get full multi-turn chat backed by Edge Function `ai-chat` (claude-sonnet-5). Non-Pro users see a locked state. react-markdown renders assistant replies. |
| Empty states (all screens) | ✅ Contacts zero-state has icon + "Start building your network" CTA; search/filter no-results has icon + clear-filters link; all other screens handled. |
| **Full dark redesign** | ✅ **Complete** — all 8 screens restyled to the Funnl design system (dark palette, Space Grotesk/Jakarta Sans/JetBrains Mono, shared sidebar). |
| **Robustness pass** | ✅ Error handling on all Supabase reads (dashboard, contact detail, follow-ups); local-timezone date logic consistent app-wide (sidebar badge, dashboard, contact detail, follow-ups all agree); avatar helpers extracted to `src/lib/avatarUtils.js`; AddContactDrawer rejects whitespace-only names and uses safe scroll-lock cleanup. |
| **Real email / SMTP** | ⚠️ Resend.com is the existing provider, connected via Supabase custom SMTP. DKIM/SPF/return-path MX verified; confirmation template installed; Gmail reaches Primary inbox. iCloud lands in Junk (unresolved — not DNS). Outlook untested. Universal inbox delivery not verified. See `docs/auth-email-setup.md`. |
| **Email confirmation landing page** | ✅ `/welcome` — success screen. No sidebar. Accessible logged-out and logged-in (always renders outside app shell). Code passes `emailRedirectTo: 'https://www.getfunnl.com/welcome'` in both `handleSignUp` and `handleResend`. Supabase Redirect URL allowlist not independently verified from code — confirm in dashboard. |
| **Deployed to production** | ✅ Live at getfunnl.com on Vercel. DNS on Cloudflare. Env vars set. SPA routing via vercel.json. Full sign-up → confirm → sign-in flow works end to end. |
| **Mobile responsiveness** | ✅ BottomNav (4 tabs, follow-up badge, iPhone safe-area). Sidebar hidden on mobile. All 6 pages responsive at 375px. AddContactDrawer full-width on mobile. |
| **Pre-rollout quality pass** | ✅ Password reset flow, LinkedIn URL normalization, error/empty-state collision fixed, import order fixed, interaction logged confirmation. |
| **Settings page** | ✅ `/settings` — account-card layout: display name (editable, saves to `profiles` table), email + joined date (read-only), sign out. School field removed from UI and table. |
| **CSV importer** | ✅ Import button on Contacts page opens a 3-step modal (upload → map → confirm). Mapping step: **pool-at-top UI** — unassigned columns shown prominently at the top as clickable chips ("click to place"); clicking a chip opens a field picker (1 click to assign). Field-first assignment also available via + Add on each field row. `normalizeHeader()` normalizes separators before lookup (first_name / first-name / first.name all match one HEADER_MAP entry). HEADER_MAP pruned of false-positive generic entries. Multiple columns combine in chip order (e.g. First Name + Last Name → "John Smith"). "— not assigned" placeholder on empty fields. Picker uses fixed-position viewport coords (not absolute) so scrollable container can't clip it. Tags: comma-separated cell values split into arrays. relationship_type and relationship_note are mappable fields. All-or-nothing bulk insert. `csv_import_used` event gains `ai_assisted: boolean` property. Known limitations: no duplicate detection, CSV-only, no cell-level editing. **Smart import (Pro):** after upload, Pro users get one `ai-map-csv` Edge Function call on unresolved columns only (deterministic alias mappings take precedence and cannot be overridden by AI); the returned assignment pre-populates Step 2 with an "AI auto-mapped N columns" banner; user reviews/adjusts before importing; non-Pro users see unchanged manual mapping flow with a soft "Pro tip" upgrade banner at the top of Step 2 (informational only — does not block mapping); AI failure silently falls back to rule-based mapping. `relationship_note` ("Why they matter") is a mappable field; common notes column names auto-map via HEADER_MAP ('notes', 'note', 'comments', 'comment', 'memo', 'additional notes', 'general notes' — 'description' and 'details' excluded as ambiguous); multiple columns mapped to relationship_note join with ' | ' separator. **LinkedIn Connections export:** two-pass header detection (PR #15) skips the 2-line preamble LinkedIn prepends before the real header; 'URL' column value-sniffed → linkedin_url when sample values contain linkedin.com; teal detection banner shown in Step 2; tested against real LinkedIn exports. Phase B (split jammed combined columns, e.g. "John Smith, Goldman, analyst" in one cell) deferred — see Known future work. |
| **Skills removed → relationship intent** | ✅ `skills` column dropped. `relationship_type` (preset select: Mentor/Collaborator/Referral path/Potential employer/Connector/Other) and `relationship_note` (freeform "why this person matters") added to contacts table, all forms, detail page, importer, and AI context. AI Fill extracts `relationship_note` from freeform text but never auto-selects `relationship_type` (deliberate user choice). |
| **Dynamic sidebar YOUR TAGS** | ✅ Replaced hardcoded Pipeline section (Target firms/Recruiters/Alumni) with live user-tag groups. Queries contacts table on each nav change, counts tag occurrences in JS, sorts by count desc, caps at top 8. Deterministic dot colors per tag. Active tag highlighted. Empty state: "Tags you add to contacts will appear here." |
| **Product analytics (PostHog)** | ✅ 25 events total (8 core + 2 Phase 1 + 3 Phase 2A + 2 Phase 3 + 2 Phase 4 + 4 Pilot + 1 AI reliability + 1 Pro trial + 1 AI contact link + 1 AI chat reset). Core: user_signed_up, first_contact_added, contact_added, interaction_logged, followup_set, csv_import_used, ai_assistant_used, ai_fill_used. Phase 1: landing_cta_clicked, signup_started. Phase 2A: activation_checklist_viewed, activation_step_completed, activation_completed. Phase 3: followup_completed, followup_snoozed. Phase 4: email_confirmed, user_signed_in. Pilot: csv_mapping_completed, csv_mapping_failed, post_import_action_clicked, outreach_status_changed. AI reliability: ai_assistant_failed. Pro trial: pro_trial_started. AI contact link: ai_contact_link_clicked (added in grounding/readable/contact-links branch). AI chat reset: ai_chat_reset (added in PR #21 followup-history hotfix). DOM autocapture disabled; $pageview and $pageleave remain enabled. Behavior only — no contact content. Users identified by Supabase ID. |
| **Privacy policy** | ✅ `/privacy` — plain-language page covering data stored, all third parties (Supabase, Anthropic, PostHog, Resend, Vercel), analytics disclosure, user rights, contact email. Linked from sign-in page and settings. Accessible logged-out. |
| **Phase 1 — Public landing page** | ✅ `LandingPage.jsx` at `/` for logged-out users. 11 sections: nav, hero with annotated product mock, marquee ticker, problem statement, feature rows (01–03), Funnl AI section, who-it's-for grid, comparison table, privacy note, final CTA, footer. `/signin` and `/signup` as separate routes, mode auto-detected from pathname. Post-sign-in `navigate('/', { replace: true })` prevents blank screen. All product claims verified against actual functionality. |
| **Phase 2A — Guided activation checklist** | ✅ Three-step checklist on DashboardPage: (1) add or import 5 contacts, (2) log the first conversation, (3) schedule the first follow-up. Milestones stored as four nullable `timestamptz` columns on `profiles` (the fourth records overall activation completion). Written with `WHERE col IS NULL` conditional updates for idempotent deduplication across tabs and sessions. Backfill included in migration `20260713075431_add_activation_milestones.sql`. CSV import button accessible from dashboard in addition to contacts page. |
| **Vercel main-only deployments** | ✅ `vercel.json` `git.deploymentEnabled: { main: true, "*": false }`. Preview deployments disabled for all non-main branches. |
| Rule-based reminders / cold alerts | 🔵 Layer 2 |
| **Phase 2B — Guided first-contact-to-interaction handoff** | ✅ After the first manual contact add from the Dashboard (`contactCount === 0`), navigates to that contact's detail page with Router state `{ openInteractionForm: true }`. ContactDetailPage reads this state on mount, calls `setShowForm(true)`, then immediately clears the state via `navigate(pathname, { replace: true, state: {} })` so refresh and Back do not reopen it. Scroll-into-view effect handles mobile: fires after both `showForm` becomes true AND `loading` becomes false (ref is null during the loading screen). `AddContactDrawer` now returns the new contact's `id` via `.select('id').single()` and passes it to `onSuccess?.(newContact?.id ?? null)`. Existing Phase 2A milestone tracking untouched. |
| **Phase 3 — Complete follow-up loop** | ✅ Done — Mark Done, Snooze/Reschedule, Log Result on `/followups`. Badge synchronization via `funnl:followups-changed` custom event. try/finally ensures savingId clears. Row-match verification via `.select('id').single()`. Log Result carries `sourceFollowUpId` Router state → ContactDetailPage clears old follow-up after new interaction saves. Partial-failure path preserved. |
| **Phase 4 — Pilot analytics and launch playbooks** | 🔵 In progress — `email_confirmed` + `user_signed_in` added. Pilot plan, PostHog dashboard guide, and feedback guide created in `docs/`. |
| **Pilot: Robust CSV parsing + per-contact AI category inference** | ✅ (branch review/pilot-csv-intelligence-outreach-status; `ai-categorize-contacts` Edge Function deployed to production 2026-07-24) Two-pass header detection logic extracted to `src/lib/csvHeaderDetect.js`; HEADER_MAP enhanced with 'display name', 'current employer', 'title', 'categories', 'groups' aliases; 'profile link' intentionally excluded from HEADER_MAP (too generic — only mapped to linkedin_url when value-sniffed in ImportContactsModal); SCORE_EXTRA extended with location/twitter/city/state/country/industry as score-only columns (not assigned). `__parsed_extra` defensive filter in `indexedHeaders`. **AI inference runs during import (2-step flow):** `ImportContactsModal` is a 2-step flow (upload → map → done, no per-contact review step). `ai-map-csv` handles column header mapping only. `ai-categorize-contacts` Edge Function accepts minimized contact context (row_id, company, role, how_met, existing_tags, existing_relationship_type — names, emails, LinkedIn URLs, and freeform relationship notes excluded) and returns per-contact `suggested_tags` + `suggested_relationship_type` + `confidence`; batched at 20 contacts per call with max 2 concurrent batches; called inside `handleImport()` before the DB insert (non-blocking to UX — progress bar shown); **only `confidence === 'high'` suggestions are auto-applied**; medium/low discarded silently. Stale-request guard (inferenceRunIdRef) cancels in-flight AI when another import is started. Silent fallback if AI call fails — contacts land with CSV data. Pro users see an "Automatically organize contacts with AI" checkbox (enabled by default) to opt out. AI suggests at most 5 tags per contact (per-run cap); final merged tag list stored in contacts has no total-count cap. **Tag splitting:** `splitTagsFromCsv()` in `src/lib/contactCategorization.js` splits on commas, semicolons, pipes, carriage returns, and newlines — accepts string or array. `transformRow()` in `ImportContactsModal` uses it so CSV cells like `"alumni; investment banking; technology"` become 3 separate tags. `mergeContactTags()` also calls `splitTagsFromCsv` on all four sources (csvTags, existingTags, aiTags, customTags) so any source may be a delimited string or an array. 37 tests in tests/csv-header-detect.test.js + 62 tests in tests/ai-helpers.test.js + 33 tests in tests/theme.test.js = 132 tests total. |
| **Pilot: Post-import activation handoff** | ✅ (branch review/pilot-csv-intelligence-outreach-status) Done screen in ImportContactsModal now shows "What would you like to do next?" panel. "Log recent outreach" (primary) opens a **contact chooser** — a searchable list of the just-imported contacts — and navigates to the selected contact with `openInteractionForm: true` Router state; NOT auto-navigated to the first contact. "View all contacts" (secondary) goes to /contacts. Footer "Done" demoted to ghost close link. `post_import_action_clicked` event fires on each CTA with `{ action: 'log_recent_outreach'\|'view_contacts'\|'dismiss' }`. |
| **Pilot: Outreach response status** | ✅ (branch review/pilot-csv-intelligence-outreach-status, migration applied 2026-07-24) Migration `20260721000000_add_outreach_status.sql` adds `outreach_status text` to interactions with named CHECK constraint `interactions_outreach_status_check`. Applied and verified in production. ContactDetailPage: Email/Message log form shows an explicit opt-in checkbox ("This was outreach I sent", unchecked by default); if checked, a status select appears (default "Awaiting response") with helper "Track the response manually. Automatic inbox syncing is not enabled." (Funnl does NOT read Gmail or any inbox); Call/Other shows a direct status select with the same helper label; Coffee chat/Event hide outreach tracking entirely. Edit form: Email/Message shows checkbox+select; Call/Other shows direct select; Coffee chat/Event shows nothing. Timeline rows show colored `OutreachStatusBadge` beside interaction type when set. Latest outreach status shown in details card (derived from loaded interactions — no N+1 query). `outreach_status_changed` event fires with `{ status: enum\|'cleared', context: 'new_interaction'\|'edit_interaction' }`. |
| **Pilot: Light / Dark / System theme** | ✅ (branch review/pilot-csv-intelligence-outreach-status) `src/lib/theme.js` manages persistence and application. Default theme is **dark** (not system). `getTheme()` validates stored values and falls back to dark. `applyTheme()` always sets an explicit `data-theme` attribute (including `data-theme="system"`) and sets `color-scheme` via JS. `initTheme()` called before React render in `main.jsx`. Settings page has System/Light/Dark toggle that takes effect instantly. **Pre-paint inline script** in `index.html` (before React executes) reads localStorage and stamps `data-theme` + `colorScheme` to prevent light→dark or dark→light flash on page load. **Theme-aware border tokens**: `--color-line-1/2/3` added to `@theme` in `index.css`; overridden in dark and light theme blocks; all 92 `border-[rgba(255,255,255,0.06/07/09)]` arbitrary-value usages across 15 files replaced with `border-line-1/2/3` token classes. Note: accent-opacity and backdrop arbitrary RGBA values (e.g. `bg-[rgba(139,124,255,0.14)]`) are not yet token-based; their visual impact is minimal in light mode (accent hue already works on both themes). |

---

## Working style

**The user (Naveen) is a software beginner. Always:**
- Explain each step in plain language before doing it
- Pause and ask for approval before: installing packages, running commands, committing, pushing
- After each major step, explain what happened and what success looks like
- Explain errors in beginner terms before fixing them
- Keep things as simple as possible — no extra libraries, patterns, or features without explicit approval
- Default to simple-but-slightly-less-powerful over complex-but-more-capable

**Git rule:** Commit and push only at the end of a completed, tested step. Never push broken or half-finished code. Use short, clear commit messages. Always include Co-Authored-By line.

**GitHub:** https://github.com/kindnav/funnlv2 — username: kindnav, main branch

---

## Pre-rollout readiness review (2026-07-04)

A full code review was done before first-student rollout. Honest verdict: close but two things must be fixed first.

### ⚠️ MUST FIX before ANY users

**1. Password reset — no recovery path exists.**
`SignInPage.jsx` has no forgot-password link. If a student forgets their password, they have no way to recover — they can't re-register (email already exists in Supabase) and there's no reset flow. Supabase has a built-in `supabase.auth.resetPasswordForEmail()` that sends a magic link; the UI just needs a "Forgot password?" link that calls it, then a recovery page to accept the new password. Small, self-contained fix.

**2. Mobile responsiveness — the app is desktop-only right now.**
The layout (`flex h-screen` + fixed 248px sidebar + hardcoded grid layouts) is completely broken on phones. Students will open the link on their phone. The sign-in page is usable on mobile; the authenticated app is not. AddContactDrawer is `w-[452px]` fixed — overflows on any phone screen. Dashboard/contacts/detail pages all use multi-column grids that collapse to unusable widths. Fixing this requires: collapsing or hiding the sidebar on mobile, switching page grids to `grid-cols-1`, and making the drawer full-width on small screens. This is the largest single piece of work before wider rollout.

### Should fix soon (small, after first few users)

- **Search includes "skill" in placeholder but doesn't search skills** (`ContactsPage.jsx` line 98): Either add `c.skills?.some(s => s.toLowerCase().includes(q))` to the filter, or remove "skill" from the placeholder. One-liner.
- **LinkedIn URLs without `https://` create broken links**: Users saving `linkedin.com/in/foo` get a relative href that goes nowhere. Auto-prepend `https://` if the value doesn't start with `http`.
- **Settings button has no handler** (`Sidebar.jsx` line 183): Clicking it does nothing. Should be removed or visually disabled with `cursor-not-allowed` + "Coming soon" tooltip until a settings screen exists.
- **Pipeline sidebar links don't filter** (`Sidebar.jsx` lines 164–175): "Target firms," "Recruiters," "Alumni" all link to `/contacts` with no `?tag=` param. One-line fix each: add `?tag=target+firm`, `?tag=recruiter`, `?tag=alumni`.
- **ContactsPage error + empty state show simultaneously**: On fetch failure, `contacts` stays `[]` so the error banner AND "Start building your network" empty state both appear. Fetch error should suppress the rest of the page body.

### Minor / later

- Import out-of-order in `ContactDetailPage.jsx` (line 11): works fine, cosmetic lint issue only.
- No post-save confirmation toast after logging an interaction: form closes silently. Fine for v1.
- "Try Funnl AI" CTA in sidebar leads to coming-soon page: not a dead-end since the page explains this, but sets higher expectations than it delivers.

---

## Pre-rollout fix plan

Tracked here so progress survives across sessions. Mark each item `[x]` when done and committed.

### Phase 1 — Must-fix before any student gets the link
- [x] **1. Password reset** — done. `ResetPasswordPage.jsx` handles the recovery link. `SignInPage.jsx` gained 'forgot' + 'reset-sent' modes and a success banner on return. `/reset-password` reachable logged-out and logged-in. On success: `updateUser` → navigate('/') with `{ state: { passwordReset: true } }` → `signOut`. Test on getfunnl.com; verify `https://getfunnl.com/**` is in Supabase Redirect URLs.
- [x] **2. Mobile responsiveness** — complete. Bottom tab bar navigation, all 6 pages mobile-friendly, AddContactDrawer full-width, all backdrops fixed. Desktop unchanged.
  - [x] **2a. Mobile navigation** — done. `BottomNav.jsx` created: fixed bottom bar, `md:hidden`, 4 tabs (Home/Contacts/Follow-ups/Funnl AI), follow-up badge (capped at 9+), `env(safe-area-inset-bottom)` for iPhone. Sidebar outer div: `hidden md:flex flex-col`. App.jsx: BottomNav imported, `pb-16 md:pb-0` on main, `<BottomNav />` in authenticated layout.
  - [x] **2b. Dashboard** — done. Stat grid: `grid-cols-3` → `grid-cols-1 md:grid-cols-3`. Body: `grid-cols-[1.25fr_1fr]` → `grid-cols-1 md:grid-cols-[1.25fr_1fr]`. Page padding: `px-4 py-6 md:px-9 md:py-8`. Backdrop: `inset-0 md:left-[248px]` (full-screen on mobile).
  - [x] **2c. Contacts page** — done. Card grid: `grid-cols-2` → `grid-cols-1 md:grid-cols-2`. Page padding: `px-4 py-6 md:px-9 md:py-8`. Backdrop: `inset-0 md:left-[248px]`. AddContactDrawer: `w-full md:w-[452px]` (full-width on mobile).
  - [x] **2d. Contact detail page** — done. Body grid: `grid-cols-1 md:grid-cols-[1fr_1.35fr]`. Hero: `flex-col md:flex-row` so avatar+buttons stack on mobile. Edit form: `grid-cols-1 md:grid-cols-2`. Page padding: `px-4 py-6 md:px-9 md:py-8`.
  - [x] **2e. Auth screens** — done. All three `px-[88px]` panels (sign-in, pending, reset-sent) changed to `px-6 md:px-[88px]`. Right panel `hidden lg:flex` was already fine.
  - [x] **2f. Final pass** — done. FollowUpsPage: `px-4 py-6 md:px-9 md:py-8`, error state `p-6 md:p-12`. FunnlAIPage: header/main/bottom-bar padding reduced on mobile. WelcomePage and ResetPasswordPage already used `p-6` — no changes needed.

### Phase 2 — Should-fix before wider push
- [x] **3. Search skills** — done. Added `c.skills?.some(s => s.toLowerCase().includes(q))` to search filter in `ContactsPage.jsx`.
- [x] **4. LinkedIn URL https://** — done. `normalizeUrl()` helper added in `AddContactDrawer.jsx` and `ContactDetailPage.jsx`; auto-prepends `https://` if URL doesn't start with `http`.
- [x] **5. Settings button dead-end** — done. Button is now a real `<Link to="/settings">` with active-state highlight. Full `SettingsPage.jsx` built at `/settings`: display name, school, save with 3-second confirmation, sign out.
- [x] **6. Pipeline sidebar links** — done. "Target firms" → `/contacts?tag=target+firm`, "Recruiters" → `/contacts?tag=recruiter`, "Alumni" → `/contacts?tag=alumni`.
- [x] **7. ContactsPage error/empty-state collision** — done. `fetchError` now shows a proper centered error card with "Try again" button; suppresses search bar, filter pills, and contact grid.

### Phase 3 — Minor cleanups
- [x] **8. Misplaced import in ContactDetailPage.jsx** — done. `import { getAvatarColor, getInitials }` moved to line 4 with the other imports.
- [x] **9. Post-save confirmation** — done. Green "Interaction logged" banner appears for 3 seconds after a successful save; fades automatically.
- [x] **10. "Try Funnl AI" CTA wording** — done. Sidebar promo card copy updated: "Ask anything...get instant answers" → "Coming in Layer 3 — log interactions now to power it." Button: "Try Funnl AI" → "See what's coming".

---

## Dead-end UI audit (2026-07-04)

Full review of every interactive element before first-student rollout. Only 3 issues found — the rest of the app is clean.

| # | Element | Location | Status | Decision |
|---|---|---|---|---|
| 1 | **User account card chevron** | `Sidebar.jsx` — the card below the logo | Plain `<div>` with a ↓ chevron icon. Looks like a profile dropdown trigger, does nothing on click. | ✅ Fixed — card is now a `<Link to="/settings">` with subtle hover border |
| 2 | **Settings page** | `Sidebar.jsx` — Settings button | Correctly disabled + "SOON" badge. Needs a real minimal page. | ✅ Fixed — `/settings` built with display name + school + sign out. Settings button wired as active Link. |
| 3 | **AI page "BETA" badge + subtitle** | `FunnlAIPage.jsx` header | "BETA" implies functional; subtitle "Ask anything about your network" implies it works now. Contradicts the body which correctly says "coming." | ✅ Fixed — badge → "SOON", subtitle → "Coming in Layer 3 — keep logging interactions" |

**Everything else:** all nav links, pipeline links, contact cards, drawers, forms, error states, and empty-state CTAs work correctly or are properly disabled.

**Settings storage decision:** Use a `profiles` Supabase table (`id UUID`, `display_name TEXT`, RLS on). Queryable and the right foundation for Layer 3 AI. `school` column was added initially and later dropped. Mobile access: Settings is desktop-only for v1 (sidebar hidden on mobile, no BottomNav tab). Acceptable since setting a display name is a one-time action done from a laptop.

---

## Known future work / tech debt

### ⚠️ Task 1 — Email deliverability (do BEFORE inviting real students)

**Verified as of 2026-07-13:**
- Resend sending domain `getfunnl.com` Verified; DKIM at `resend._domainkey.getfunnl.com`, SPF and return-path MX at `send.getfunnl.com` — all pass
- Confirm signup template applied; subject set
- Gmail delivery: reaches **Primary inbox** ✓
- `emailRedirectTo` wired in `SignInPage.jsx` for both `handleSignUp` and `handleResend`

**Still open:**
- iCloud: confirmation email lands in **Junk** — root cause unknown; DNS is not the failure point (SPF/DKIM pass). Possible causes: domain/IP reputation, content filtering, Apple's proprietary scoring. Try sending more legitimate mail, check Resend Logs for any spam signals, or test with a plain-text fallback.
- Outlook: not yet tested — create a fresh Outlook address and run the signup flow; inspect headers.
- Leaked password protection: the "Check passwords against known breached passwords" setting requires Supabase Pro plan. Current plan has not been confirmed to include it — check Supabase → Auth → Password Protection; if the toggle is absent, the current plan does not support it.
- New signup test after the `harden_handle_new_user` migration: confirm `profiles` row is created correctly.
- Domain warm-up: deliverability improves naturally over days/weeks as legitimate mail is sent and opened.

See `docs/auth-email-setup.md` for the full checklist.

### Task 2 — /welcome and /reset-password routing ✅ Fixed 2026-07-13
`App.jsx` now uses React Router `useLocation` to detect these paths before either session branch. Both pages always render full-screen without the `Sidebar`/`BottomNav` shell, regardless of session state. `WelcomePage.jsx` already calls `supabase.auth.signOut()` when the user clicks "Continue to sign in" — no further change needed there.

### Before real launch (required)
1. ~~**User profile (display name)**~~ — ✅ Done. `profiles` table + `/settings` page built. Sidebar shows saved display name. School field was removed from both the UI and the table.

### Before wider sharing (important)
2. **Google OAuth sign-in** — design shows a "Continue with Google" button; deliberately omitted. Requires Google Cloud project + Supabase OAuth config.
3. ~~**Sidebar Pipeline counts**~~ — ✅ Done (superseded). Replaced the entire hardcoded Pipeline section with the dynamic YOUR TAGS section: user's own tags, live counts, capped at 8, active-tag highlight.
4. ~~**Tag filter wiring (sidebar → contacts)**~~ — ✅ Done. Dynamic YOUR TAGS links use `?tag=` params; ContactsPage handles them unchanged.
5. **CSV importer — known limitations (future improvements):**
   - **No duplicate detection** — importing the same file twice creates duplicate contacts. Detecting duplicates (by name+company, or email) is a future improvement.
   - **CSV only** — `.xlsx` and other formats not supported yet. Users must export to CSV first.
   - **Smart import Phase B — jammed combined columns** — a single column containing combined data ("John Smith, Goldman, analyst") cannot be split across fields by the current AI mapping. Phase A (header name mapping) is done. Phase B would add split-template detection: AI infers the split pattern from sample values, code applies it to all rows — no per-row AI calls. Deferred until real-user CSVs confirm this is a common pattern. The `transformRow` seam in `ImportContactsModal.jsx` is where this will plug in.

### Layer 2 (next major phase)
5. **Follow-ups enhancements** — `/followups` shows real data. Still needed: Snooze, Mark done actions, and "going cold" detection logic.

### Monetization — thinking only, do NOT build yet

**Timing:** Don't build billing until you have 20–50 active returning users and understand which features they value enough to pay for. Building billing with zero users and unproven retention is premature and will slow down first-user acquisition.

**The right trigger to revisit:** someone asks how to pay for it, or costs start to matter.

**Likely model when ready:**
- Free tier: up to 50 contacts, unlimited interactions — gets students in the door
- Pro tier (~$5–8/month or $40/year): unlimited contacts + AI features (Layer 3)

Students will pay for concrete time-savings during recruiting season (AI-drafted follow-ups, "who to contact next"). They won't pay for storage. The contact limit is a natural converting forcing function — active students recruiting across multiple firms will hit 50 contacts.

### AI sequencing — decision made to build

**Decision made (2026-07-05):** Building Layer 3 now, starting with the Pro gate plumbing and "Contact from text" as the first feature. Original reasoning for waiting (no users, unproven retention) was valid, but the build sequence is designed to be low-risk: Layer A is infrastructure (no user-facing AI yet), Layer B is contained and verifiable (fields are visibly right or wrong), and the Pro gate bounds cost to enabled users only.

For the full plan, see **"AI Pro feature — build plan"** section below.

### PWA / mobile app (future — do NOT build yet)
The bottom-tab mobile design was deliberately chosen because it translates naturally to a native app later. Planned progression:
1. **PWA "Add to Home Screen"** — add a web app manifest, service worker, and correct viewport meta tags so the app can be installed on iOS/Android home screens. Relatively small amount of work.
2. **iOS/Android app via Capacitor** — wrap the React web app in a Capacitor shell to publish to the App Store / Play Store. Capacitor lets you ship a real native app from the same codebase. The bottom tab bar and mobile-first layouts built during the responsiveness pass are the right foundation for this.

Do not start either of these until the web app is stable and has real users.

### AI roadmap & access control (vision + brainstorm — see build plan section for what to actually build)

#### Why this is future, not now

Zero users and no retention data. Building AI features (and their gating) before knowing which ones students actually want means building against guesses. AI features are the most expensive things to build and rebuild — both in engineering time and per-call API cost.

**Sequence:** validate retention with the core product → watch what users search for, struggle with, and ask about → ask directly "if AI could help you with one thing here, what would it be?" → build exactly that, not the full brainstorm list.

Every interaction logged now is training data for Layer 3. More data → better AI. Don't rush it.

---

#### AI vision — features to build after real users

**1. AI-assisted CSV import** *(Phase A done — Phase B deferred)*

Phase A (smart header mapping) is built: after upload, the `ai-map-csv` Edge Function (Haiku, one call per import) sees headers + 3 sample rows and returns an improved column assignment. Pro users see an "AI auto-mapped N columns" banner on the mapping step; they review and adjust before importing. Non-Pro users are unaffected.

Phase B (jammed combined columns — "John Smith, Goldman, analyst" in one cell) is deferred until real-user CSVs confirm it's common. When ready:
- AI sees sample values from the problematic column, returns a split template (e.g. [name, company, role])
- Code applies the template to all rows — no per-row AI calls
- The `transformRow` seam in `ImportContactsModal.jsx` is where this plugs in
- Present a confirmation step so the user can review before committing

This is the AI upgrade to the plain CSV importer — not a replacement of it.

**2. Smart contact saving** *(confirmed)*

User pastes freeform text ("Met Priya Sharma, Goldman recruiter at the Career Fair, knows Python") → Claude infers and fills all form fields in AddContactDrawer. Transforms the add experience from a form into an AI-first input.

**3. AI enrichment throughout the app** *(brainstormed — validate before building any of these)*

- **Smart tag/skill inference** — Claude infers tags and skills from freeform notes; user confirms
- **Relationship summaries** — plain-English summary of a contact's history and current status
- **"Who to follow up with"** — Claude reads interaction dates and notes, surfaces the contacts most worth a nudge
- **Draft outreach messages** — "write a follow-up email to Priya based on our coffee chat" — Claude reads notes and drafts it
- **Semantic search** — search by concept ("who can intro me to PE") not just keyword
- **Opportunity detection** — Claude flags contacts who mentioned open roles, internships, or referral offers in notes
- **Relationship temperature scoring** — rates contacts warm vs. going cold based on content and timing, feeds into Layer 2
- **Weekly AI digest** — Claude-generated summary of the week's activity + recommended next actions
- **Business card / LinkedIn parsing** — paste a LinkedIn URL or bio, Claude fills the add-contact form

**Why the current data structure supports all of this:** notes are freeform text Claude can read directly; tags and skills are structured arrays Claude can generate and query; per-user RLS ensures Claude only ever sees one user's data.

---

#### Access control & cost protection — design decision (recorded, not built)

AI features cost real money per API call. They must be gated to control who can use them and prevent runaway cost.

**Rejected approach — shared password/secret to unlock AI:**
A shared secret leaks. One user shares it, it's effectively public. It can't be revoked per-person, and gives no visibility into who is using what. Do not do this.

**Chosen approach — per-user `ai_enabled` flag in the database:**
- Add an `ai_enabled` boolean column to the `profiles` table, default `false`
- Every AI feature checks this flag before calling the Claude API
- Access is granted by flipping a specific user's flag to `true` directly in Supabase
- Individual revocation: flip it back to `false`
- No self-granting: users can't set their own flag (RLS ensures they can only read it, not write it)
- Full visibility: can see in Supabase exactly who has access

**SQL when ready (do not run yet):**
```sql
ALTER TABLE profiles ADD COLUMN ai_enabled boolean NOT NULL DEFAULT false;
```

**Later refinement — per-user usage limits:**
Once the flag is in place, add a usage counter (e.g. `ai_calls_this_month int DEFAULT 0`, reset monthly via a cron job or Edge Function) so even authorized users can't accidentally run up the bill. Caps can be per-tier if monetization is live.

**Connection to monetization:** the `ai_enabled` flag is the natural "Pro" gate. When billing is ready, the payment flow flips the flag. Until then, it's flipped manually. See the Monetization section above for timing guidance — don't build billing until there are 20–50 retained users.

---

## Startup audit — July 2026

External audit conducted July 12, 2026 against commit `05db542`. Full document: `FUNNL_STARTUP_AUDIT.md`.

### Verdict

Funnl is a real, usable MVP — more polished than most early student projects. The main problem is no longer "build the CRM." It is that Funnl has no convincing path from cold visitor → activated, returning user. The product stores networking work; it does not yet consistently create the next valuable networking action.

### Strategic wedge

Stop targeting "students who network." Start targeting **students actively recruiting into relationship-driven careers (finance, consulting, VC, PE, competitive tech) who already have 15–100 real contacts.** These users feel the pain acutely, are reachable through clubs, and are seasonal — which creates urgency.

Recommended positioning:
> **Turn networking conversations into follow-ups that lead somewhere.**
> Funnl helps students recruiting for competitive roles remember every conversation, follow up at the right time, and see who to contact next.

### Launch blockers (must fix before pilot users)

| # | Issue | File | Status |
|---|---|---|---|
| 1 | No public landing page | `App.jsx` — wildcard renders `SignInPage` for logged-out users | ✅ **Fixed — Phase 1.** `LandingPage.jsx` at `/` for logged-out users. |
| 2 | Follow-up loop is incomplete | `FollowUpsPage.jsx` — display only, no Done/Snooze/Log | ✅ **Fixed — Phase 3.** Mark Done, Snooze, Log Result all complete. |
| 3 | No Pro path to purchase or test | `FunnlAIPage.jsx` — locked state has no price or waitlist | 🔵 **Not yet built.** |
| 4 | Email deliverability (spam) | Documented in Known future work → Task 1 | ⚠️ **Partially verified** — DNS/DKIM/SPF verified; Gmail Primary ✓; iCloud Junk unresolved; Outlook untested. |

### Prioritized backlog (from audit — updated status)

| # | What | Impact | Effort | Status |
|---|---|---|---|---|
| 1 | Public landing page (screenshots, differentiation, pricing test, CTA) | 5 | 2 | ✅ Done — Phase 1 |
| 2 | Guided activation: contacts → log interaction → set follow-up | 5 | 3 | ✅ Done — Phase 2A |
| 3 | Mark done / snooze / log-result on follow-ups | 5 | 3 | ✅ Done — Phase 3 |
| 4 | Fix email deliverability / add Google OAuth | 5 | 2 | ⚠️ Partially verified — Gmail ✓, iCloud Junk unresolved, Outlook untested |
| 5 | Run concierge pilot with 10 qualified students | 5 | 2 | 🔵 Not started |
| 6 | Weekly reminder email + overdue notifications | 5 | 3 | 🔵 Not started |
| 7 | Fix activation analytics (CSV-first users currently missed) | 4 | 2 | 🔵 Partially — 5 events added |
| 8 | Pro pricing test + early-access CTA (no billing yet) | 4 | 1 | 🔵 Not started |
| 9 | Duplicate detection during CSV import | 4 | 2 | 🔵 Not started |
| 10 | Self-service data export + account deletion | 3 | 3 | 🔵 Not started |

### Explicitly do NOT build now

- Native mobile app / PWA
- University administration portal
- Complex relationship scoring
- Calendar or email integrations
- More open-ended AI features
- Paid billing (Stripe) — validate demand first

### Days 1–14 immediate focus (updated status)

| # | Item | Status |
|---|---|---|
| 1 | Fix email confirmation deliverability | ⚠️ DNS/template verified; Gmail Primary ✓; iCloud Junk unresolved; Outlook untested |
| 2 | Build public landing page | ✅ **Done — Phase 1** |
| 3 | Remove "Join your peers already using Funnl" copy (overclaims traction) | ✅ **Done — Phase 1** |
| 4 | Add CSV import CTA to empty-state dashboard | ✅ **Done — Phase 2A** |
| 5 | Guide new users through contact → interaction → follow-up in one session | ✅ **Done — Phase 2A + Phase 2B.** Phase 2A: three-step checklist + durable milestone tracking. Phase 2B: first contact add navigates to the contact's detail page with the interaction form pre-opened. |
| 6 | Add Done, Snooze, Log Result to follow-ups page | ✅ **Done — Phase 3** |
| 7 | Fix activation analytics to capture CSV-first users | 🔵 Partially — 5 new events added; CSV-first path improvement TBD |
| 8 | Add Pro price + early-access interest button (no billing, just a tracked CTA) | 🔵 Not yet built |

---

## AI Pro feature — build plan

**Status: actively building.** Decision made 2026-07-05. AI is Funnl's paid "Pro" tier differentiator. Built in four layers so each is proven before the next is added.

### Build layers

| Layer | Name | Status | Description |
|---|---|---|---|
| **A** | Plumbing + Pro gate | ✅ Done | `ai_enabled` column + RLS fix. `src/lib/ai.js` canUseAI() Stripe-ready gate. Edge Functions `ai-parse-contact` and `ai-map-csv` deployed. Gate tested: 403 for non-Pro, 200 for Pro. |
| **B** | Contact from text | ✅ Done | AI Fill section added to AddContactDrawer. Pro-gated (hidden for non-Pro). Textarea → Parse → fields fill with purple highlight. Manual edits clear the highlight. Follow-up suggestion shown as reminder. Never auto-saves. |
| **C** | AI Assistant | ✅ Done | Working chat UI on /ai (FunnlAIPage.jsx). Edge Function `ai-chat` deployed (claude-sonnet-5). Loads all contacts + interactions per call. Multi-turn conversation works. System prompt STYLE section: prose-first, no reflexive bullets/bolding, warm mentor voice. react-markdown renders assistant replies (bold/lists clean, raw HTML disabled). Typebox redesigned: pill shape, focus glow, send button with press feel. Pro-gated; non-Pro sees locked state. All stale "coming soon" copy updated across Sidebar, Dashboard, ContactDetail. **Reliability overhaul (branch review/ai-chat-reliability, PR #18, 2026-07-26):** Confirmed defective path fixed — HTTP 200 from Anthropic with thinking-only content caused `.find(b => b.type === 'text')` to return undefined, producing an empty reply. Now: `parseProviderResponse.js` collects ALL text blocks, skips thinking blocks, joins with `\n\n`, classifies max_tokens truncation. `normalizeMessages.js` validates and bounds conversation history (MAX_MESSAGES=20, MAX_MESSAGE_CHARS=4000, MAX_TOTAL_CONVERSATION_CHARS=20000, role alternation, strips INITIAL_MESSAGE). Structured error contract `{ error: { code, message, retryable, request_id } }` on all error paths; `{ reply, request_id, truncated? }` on success. Context budget: two-pass deterministic (MAX_NETWORK_CONTEXT_CHARS=80000, MAX_INTERACTIONS_PER_CONTACT=3 then 1). Prompt-injection delimiters around network data. DB query failures return `network_data_failed`. Frontend: inline error with Retry/Dismiss per message, aria-live, failed prompt kept visible, `ai_assistant_failed` analytics event. Not yet deployed — deployment pending. |
| **D** | Stripe billing | 🔵 Later | Replace manual `ai_enabled` flag with real subscription check. canUseAI() is the seam. |

---

### Architecture — how AI calls work securely

The Anthropic API key must **never** be in frontend code — anything in the browser is visible to anyone who opens DevTools. Solution: **Supabase Edge Functions**.

```
React (browser)  →  Supabase Edge Function (server)  →  Anthropic API (Claude)
```

An Edge Function is a small server-side function that runs on Supabase's infrastructure, not in the browser. It holds the API key as a Supabase secret (never leaves the server), verifies the caller's Supabase auth token, enforces the Pro gate, and returns results to the browser.

Frontend calls it via: `supabase.functions.invoke('function-name', { body: { ... } })` — the Supabase client automatically attaches the user's auth token.

**Why Edge Functions over Vercel API routes or a separate backend:**
- Already using Supabase for auth + DB — no new vendor
- Edge Functions can read the DB directly (with the service-role key) for authoritative Pro-gate checks
- Secret management lives in one place (Supabase dashboard)
- Deploy with `npx supabase functions deploy` — no new platform to learn

---

### Pro gate — Stripe-ready design

**One function: `canUseAI(userId)` in `src/lib/ai.js`**

Every AI feature in the app calls this function — nothing reads `ai_enabled` directly. That's the seam.

- **Today:** reads `ai_enabled` from the `profiles` table. Grant access by setting `ai_enabled = true` for a user in Supabase manually.
- **Future (Stripe, Layer D):** same function, reads Stripe subscription status instead. Every AI feature becomes Stripe-gated automatically — no feature-level code changes.

`ai_enabled` is enforced at two independent levels:
1. **Frontend** — cosmetic only. Hides the UI or shows a "Pro feature" prompt.
2. **Edge Function (server-side)** — authoritative. The function re-checks `ai_enabled` using the service-role key. A manipulated client request is still blocked here.

**RLS protection:** the profiles UPDATE policy must be updated to prevent users from setting their own `ai_enabled = true`. Without this fix, any user can self-grant via the Supabase client. See Layer A SQL.

---

### Security rules — permanent, apply to every AI feature

1. Anthropic API key only in Supabase secrets — never in `.env`, never committed to the repo, never in any frontend file
2. Edge Function verifies caller's JWT before every AI call — unauthenticated requests rejected immediately
3. Edge Function re-checks `ai_enabled` server-side — the frontend check is cosmetic only, never relied upon for enforcement
4. Only the current user's data passes to Claude — never another user's contacts or interactions. Respect user scoping the same way RLS does.
5. `ai_enabled` is RLS-protected — users cannot self-grant via UPDATE (see Layer A SQL)

---

### Model selection

| Feature | Model | Why |
|---|---|---|
| Layer B — Contact from text | `claude-haiku-4-5-20251001` | Simple field extraction; very fast + cheap (~$0.0004/call) |
| Layer C — AI Assistant | `claude-sonnet-5` | Reasoning over contact history; needs more capability |

---

### What must be set up before building Layer A

These are one-time setup steps, not code changes:

1. **Anthropic API key** — generate at console.anthropic.com. Store it as a **Supabase secret** (Supabase dashboard → Edge Functions → Secrets, name it `ANTHROPIC_API_KEY`). Never put it in `.env` or the repo.
2. **Supabase CLI** — required to create and deploy Edge Functions. Install with `npm install -g supabase` or use `npx supabase`. Must be logged in (`supabase login`) and linked to the project (`supabase link`).
3. **SQL** — run the `ai_enabled` column addition + updated RLS policy (see Layer A spec).

---

### Layer A spec — Plumbing + Pro gate

**Step 1: SQL (run in Supabase SQL Editor)**

```sql
-- 1. Add the Pro gate column to profiles
ALTER TABLE profiles ADD COLUMN ai_enabled boolean NOT NULL DEFAULT false;

-- 2. Fix the profiles UPDATE policy to prevent self-granting.
--    The existing policy lets users update their own row freely — that includes ai_enabled.
--    This replacement allows updating display_name etc. but locks ai_enabled in place.
--    First: find the exact policy name in Supabase → Authentication → Policies → profiles table,
--    then drop and recreate it.
DROP POLICY IF EXISTS "<existing_update_policy_name>" ON profiles;

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id AND
    ai_enabled IS NOT DISTINCT FROM (SELECT ai_enabled FROM profiles WHERE id = auth.uid())
  );
```

**Step 2: `src/lib/ai.js` — the Stripe-ready gate**

```js
import { supabase } from './supabase'

// Stripe-ready seam: every AI feature calls this. Never read ai_enabled directly.
// To gate by Stripe later, replace this function body — no feature code changes needed.
export async function canUseAI(userId) {
  const { data } = await supabase
    .from('profiles')
    .select('ai_enabled')
    .eq('id', userId)
    .maybeSingle()
  return data?.ai_enabled === true
}
```

**Step 3: `supabase/functions/ai-parse-contact/index.ts` — Edge Function**

Responsibilities:
- Verify caller JWT → extract user ID
- Read `ai_enabled` for that user via service-role key (authoritative)
- If `ai_enabled = false`: return `{ error: 'Pro feature' }` with HTTP 403
- Build Claude prompt, call Anthropic API (`claude-haiku-4-5-20251001`)
- Return structured JSON: `{ name, company, role, email, linkedin_url, how_met, tags, skills, follow_up_suggestion }`
- Only ever uses data belonging to the calling user

**Step 4: Test the gate**
- Test with a non-Pro user: Edge Function should return 403
- Set `ai_enabled = true` for your account in Supabase: function should return parsed JSON
- Verify in the browser Network tab that no API key appears in any request

---

### Layer B spec — Contact from text

**File:** `AddContactDrawer.jsx`

**UI change:** Add an "AI Fill" section at the top of the drawer, above the existing form fields.

```
┌─────────────────────────────────────────────┐
│  AI Fill  (Pro)                             │
│  ┌─────────────────────────────────────┐   │
│  │ Paste anything about this person…   │   │
│  └─────────────────────────────────────┘   │
│  [Parse with AI]                           │
├─────────────────────────────────────────────┤
│  Name *          [            ]             │
│  Company         [            ]             │
│  Role            [            ]             │
│  ...existing form fields...                 │
└─────────────────────────────────────────────┘
```

**Flow:**
1. User types or pastes freeform text into the textarea (e.g. "Met Priya Sharma at career fair, Goldman analyst, knows Python + financial modeling, follow up in 2 weeks")
2. Clicks "Parse with AI" — button shows spinner
3. Frontend calls `supabase.functions.invoke('ai-parse-contact', { body: { text } })`
4. Edge Function calls Claude, returns `{ name: "Priya Sharma", company: "Goldman Sachs", ... }`
5. Form fields fill in with the parsed values (visually highlighted so user can see what AI filled)
6. User reviews every field, edits anything wrong, then clicks Save — same as always
7. **Never auto-saves.** AI fills the form; human reviews + confirms.

**Non-Pro users:** The AI Fill section is not rendered. No upgrade prompt yet (no Stripe path exists). Will revisit when Layer D is built.

**Claude prompt (inside Edge Function):**
```
Parse the following text about a person into contact fields.
Return ONLY valid JSON. Only extract fields explicitly mentioned — do not invent anything.
If a field is not mentioned, omit it from the JSON entirely.

Fields to extract:
- name (string)
- company (string)
- role (string)
- email (string — only if an actual email address is stated)
- linkedin_url (string — only if a URL or linkedin.com link is stated)
- how_met (string — e.g. "Career fair", "Coffee chat")
- tags (array of strings — relationship labels like ["recruiter", "target firm"])
- skills (array of strings — technical abilities like ["Python", "Excel"])
- follow_up_suggestion (string — only if a timeframe is mentioned, e.g. "2 weeks")

Text: "<user input>"
```

---

### Layer C spec — AI Assistant

**Screen:** replaces the coming-soon placeholder at `/ai`. Full working chat UI.

**Architecture:** new Edge Function `ai-chat`. Same secure pattern as `ai-parse-contact`: verifies JWT, re-checks `ai_enabled` server-side (Pro gate), loads current user's contacts + interactions from DB via service-role key, builds a structured context string, calls Claude with system prompt + context + conversation history, returns the assistant's response. Frontend maintains conversation history in component state; no chat persistence to DB yet (future).

**Data loading:** loads ALL of the current user's contacts and interactions per call. Correct for student scale (dozens to low hundreds of contacts). A retrieval/embeddings approach (semantic search over a vector store) is the future upgrade if a user ever has too much data to send at once — do NOT build that now; it's over-engineering for this scale.

**Security:** Edge Function loads data using service-role key scoped to `user_id = authenticated user`. One user's data never reaches another user's AI call.

**Model:** `claude-sonnet-5` — capable enough for multi-turn reasoning over contact data. Meaningfully more expensive than Haiku (roughly $0.05–$0.10/message depending on network size). Pro gate bounds who can call it.

**Persona:** knowledgeable thinking partner for exploring your network — NOT an authority handing down verdicts. Primary job is helping the user explore and understand their data. Advice is secondary and offered humbly ("here's what I notice; you know these people better than I do"). Acknowledges it only sees logged data, not full human context — defers to user judgment on genuine judgment calls. Still substantive and honest: surfaces patterns, flags overdue follow-ups and cold contacts, notes habits worth improving (about behavior/patterns, not character; said once, not preachy). Answers from provided data only — says "I don't see that in your Funnl data" rather than inventing. Politely declines off-topic questions and redirects (on-topic guardrail).

**Conversation:** single session, no saved history. Fresh each page load. Multi-thread history is future work.

**Future work (do NOT build now):**
- Proactive insights scattered through the app (e.g. "3 contacts going cold" banner on dashboard) — reactive assistant first, proactive later
- Retrieval/embeddings for very large networks (hundreds+ contacts) — not needed at student scale
- Saved conversation history / multiple chat threads
- Streaming responses (currently waits for full response before displaying)

---

### Layer C reliability spec — ai-chat Edge Function (branch review/ai-chat-reliability, PR #18)

**Confirmed defective path:** HTTP 200 from Anthropic where the `content` array contains NO usable text block (empty array, thinking-only, whitespace-only, or missing) → the original `.find(b => b.type === 'text')` returned `undefined` → `reply = undefined` → returned `{ reply: '' }` → frontend `if (data?.reply)` treated it as falsy → "No response received" shown. Now produces `{ error: { code: 'empty_provider_response', ... } }` instead.

**Important clarification:** `.find()` scans the entire array, so a thinking block BEFORE a text block is NOT a failure condition — `.find()` would still locate the later text block. The defective condition is specifically when no text block exists at all. The exact provider response body from the historical incident was not captured, so it cannot be proven which specific input (thinking-only, empty, missing, etc.) triggered that individual failure. The fix addresses all usable-text-absent cases. A thinking block appearing before a text block is handled correctly by both the old and new code.

**Module: `supabase/functions/ai-chat/parseProviderResponse.js`**
- Collects ALL text blocks (not just first); skips `type: 'thinking'` blocks; joins with `\n\n`
- `stop_reason === 'max_tokens'` → `truncated: true` (reported to frontend, shown as note to user)
- Error output: `{ reply: null, stop_reason, truncated: false, error: 'empty_provider_response' }`
- Success output: `{ reply: string, stop_reason, truncated: bool, error: null }`

**Module: `supabase/functions/ai-chat/normalizeMessages.js`**
- Validates every message: role must be `user|assistant`, content must be non-blank string ≤ MAX_MESSAGE_CHARS
- **Rejects** (returns `invalid_request`) any conversation starting with an assistant role — INITIAL_MESSAGE is now marked `localOnly: true` on the frontend and filtered out by `buildProviderMessages()` before invoke; a leading assistant role arriving at the Edge Function indicates a frontend bug and is rejected defensively rather than silently stripped
- Trims oldest user+assistant pairs until total chars ≤ MAX_TOTAL_CONVERSATION_CHARS
- Caps at MAX_MESSAGES, then validates strict role alternation, then validates ends with user
- Returns `{ messages: Array|null, errorCode: 'invalid_request'|null }`

| Constant | Value | Purpose |
|---|---|---|
| `MAX_MESSAGES` | 20 | Hard cap on conversation turns sent to provider |
| `MAX_MESSAGE_CHARS` | 4000 | Per-message size ceiling |
| `MAX_TOTAL_CONVERSATION_CHARS` | 20000 | Total char budget before oldest pairs are trimmed |

**Context budget (`supabase/functions/ai-chat/helpers.js`)**
- **Three-pass** budget strategy (was two-pass):
  - Pass 1: MAX_INTERACTIONS_PER_CONTACT=3 per contact (full detail)
  - Pass 2: 1 interaction per contact (reduced)
  - Pass 3: compact one-line-per-contact index — every contact appears, no interaction bodies; aggregate metadata only (count, last date, overdue flag)
  - `tooLarge: true` only when even the compact pass exceeds MAX_NETWORK_CONTEXT_CHARS=80,000
- Field truncation applied to ALL fields: `truncFreeText()` for free-text (name, company, role, how_met, notes, relationship_note, email, tags), `truncEnum()` for controlled-enum strings (type, relationship_type, outreach_status), `safeDate()` for dates (validates YYYY-MM-DD, returns '' for invalid)
- Tags capped at 10 per contact
- Output shape: `{ context: string, tooLarge: boolean, passUsed: 1|2|3|null }` (`passUsed` for testability; null when tooLarge)
- Timezone-aware: `resolveToday(timezone)` replaces `getLocalToday()`. Edge Function receives user's IANA timezone from `rawBody.timezone` (sent by frontend via `Intl.DateTimeFormat().resolvedOptions().timeZone`). Falls back to UTC for missing or invalid timezone. Resolves overdue follow-up comparisons to the user's calendar day, not the server's UTC clock.
- Prompt-injection isolation: DATA SAFETY preamble + `=== BEGIN/END NETWORK DATA ===` delimiters
- Does not mutate source arrays

**Request timeout:** 45 seconds (increased from 25s). Rationale: at max context (80,000 chars network + 20,000 chars history) and max output (2,048 tokens), claude-sonnet-5 at ~80 tok/s needs ~25.6s for output alone plus input processing. 25s was too low; 45s provides headroom. Supabase Edge Function wall-clock limit is ≥150s (free tier). **Provisional** — not verified against production traffic. Adjust if smoke testing reveals legitimate requests being aborted.

**Structured error contract (every error path in index.ts):**
```
{ error: { code: string, message: string, retryable: boolean, request_id: string } }
```

11 canonical error codes enforced as an allowlist in both the Edge Function and `src/lib/ai-chat-error.js` — unknown codes normalize to `internal_error`:

| Error code | HTTP | Retryable | Trigger |
|---|---|---|---|
| `unauthorized` | 401 | false | Missing or invalid auth header |
| `invalid_request` | 400 | false | Bad messages shape |
| `pro_required` | 403 | false | ai_enabled = false or profile row absent |
| `internal_error` | 500 | true | Unexpected exception or profile DB query error |
| `network_data_failed` | 503 | true | Contacts/interactions DB query error |
| `context_too_large` | 413 | false | Network context > 80,000 chars even after compact pass |
| `provider_rate_limited` | 429 | true | Anthropic 429 (rate limit) |
| `provider_timeout` | 504 | true | AbortController 45s timeout fired |
| `provider_unavailable` | 503 | true | Anthropic 529 (overloaded) |
| `provider_error` | 502 | true | Other non-2xx Anthropic response |
| `empty_provider_response` | 502 | true | No text block in response content |

Note: profile DB query failure → `internal_error` (retryable), NOT `pro_required` — a transient DB issue must not permanently lock the user out.

**Success response:** `{ reply: string, request_id: string, truncated?: true }`

**Privacy-safe logging (only these fields, never prompt/response/contact text):**
`requestId`, `providerStatus` (HTTP status), `providerRequestId` (Anthropic's `x-request-id` header), `stop_reason`, content block types array, `error.name` for unexpected exceptions.

**Frontend changes (`src/pages/FunnlAIPage.jsx`):**
- INITIAL_MESSAGE marked `localOnly: true` — it is a frontend UI greeting, never meant for the provider
- `buildProviderMessages()` (from `ai-chat-conversation.js`) replaces the local function — filters `localOnly` and `error` messages before invoke
- Sends `timezone: Intl.DateTimeFormat().resolvedOptions().timeZone` in the request body
- `extractInvokeError` is now async (awaited); FunctionsHttpError.context is a raw Response parsed via `await fnError.context.json()`
- Retry button shown only when `isRetryEligible(messages, i)` — failed message must be the last in the array (prevents stale retries after successful later turns)
- Errors are inline per-message (not a separate error state) — failed prompt stays visible
- `aria-live="polite" role="status"` container for screen reader accessibility
- Dismiss button — removes failed message and restores text to input
- Truncated response shows note: "Response may be cut short — feel free to ask a follow-up."
- `track('ai_assistant_failed', { code, retryable })` on every error path — no user content

**Frontend error normalizer (`src/lib/ai-chat-error.js`):**
- `extractInvokeError(fnError, data)` is **async** — parses `FunctionsHttpError.context` (raw Response) via `await fnError.context.json()`; handles `FunctionsRelayError`, `FunctionsFetchError`, legacy plain-string errors, and generic errors
- Error code allowlist (11 codes) enforced — unknown codes normalize to `internal_error`
- Returns `Promise<{ code, message, retryable, request_id }|null>`

**Frontend conversation helpers (`src/lib/ai-chat-conversation.js`):**
- `buildProviderMessages(msgs)` — filters `localOnly` and `error` messages, maps to `{ role, content }` only
- `isRetryEligible(messages, index)` — returns `true` only if `index === messages.length - 1` (failed message is the last message, guaranteeing valid provider sequence on retry)

**Test totals after overhaul: 272 total (37 csv-header + 62 ai-helpers + 33 theme + 15 parse-provider-response + 18 normalize-messages + 19 ai-chat-error + 67 ai-chat + 21 ai-chat-conversation)**

**Deployment status:** Edge Function and frontend NOT yet deployed. Deployment is a separate step — and the **order matters**. (PR #18 merged and deployed; see below for subsequent hotfix.)

**Compatibility matrix:**

| Frontend version | Edge Function version | Result |
|---|---|---|
| **New** (localOnly filter) | **Old** | ✅ Compatible — provider messages start with `user`; old function accepts them; `timezone` field ignored; old `{ reply }` shape handled by `if (!data?.reply)` |
| **New** (localOnly filter) | **New** | ✅ Compatible — full structured error contract, timezone validated, `request_id` flows through |
| **Old** (sends INITIAL_MESSAGE as assistant) | **New** | ❌ **Incompatible** — old frontend sends INITIAL_MESSAGE as the first message with `role: 'assistant'`; new Edge Function rejects any leading assistant role with `invalid_request`; all Pro AI requests break immediately |

**Required deployment order (frontend first):**

1. Merge PR #18 → Vercel auto-deploys new frontend from `main` (wait for build to complete)
2. Smoke test: new frontend vs old Edge Function — confirm AI still works for Pro users
3. `npx supabase functions deploy ai-chat --linked` — deploys new Edge Function
4. Smoke test: new frontend vs new Edge Function — confirm structured errors, retry, timezone
5. If Edge Function smoke test fails: redeploy previous Edge Function version from Supabase dashboard (Functions → Deployment history)

**Rollback procedure:**
- Edge Function failure: Supabase dashboard → Edge Functions → `ai-chat` → Deployment history → activate previous version. Frontend stays on new version (compatible with old Edge Function per the matrix above).
- Frontend failure (unlikely — it is backward-compatible): revert commit on `main` and push; Vercel redeploys within minutes.

---

### Layer C hotfix — complex prompt failure (branch review/ai-chat-complex-prompt-hotfix)

**Production symptom (support ref e14696ba-a8ca-4a24-b5a9-0889f4c4d796):** Complex network-analysis prompts (e.g., "compile a list of people who fit these criteria from my network") returned "AI did not return a response — please try again" while short simple prompts succeeded. The failure was consistent with a specific class of provider response, not a random fluke.

**Root cause (strongest evidence-backed diagnosis — production logs not directly accessible via API):** Strongest evidence-backed diagnosis: Claude Sonnet 5 enables adaptive thinking by default, and the previous 2,048-token output allowance covered both thinking and visible text. The repeatable simple-versus-complex failure pattern and `empty_provider_response` code are consistent with complex prompts exhausting the visible-response budget. The original provider stop reason and block types were not recoverable, so the exact historical response shape is unconfirmed.

**Fix: two-attempt provider loop with bounded fallback**

New module `supabase/functions/ai-chat/providerCall.js` (plain JS, importable from Node tests without transpilation) exports:

| Export | Value | Purpose |
|---|---|---|
| `MODEL` | `'claude-sonnet-5'` | Model identifier |
| `PRIMARY_MAX_TOKENS` | `4096` | Full budget for visible text (thinking disabled) |
| `PRIMARY_THINKING` | `{ type: 'disabled' }` | Disables adaptive thinking — all tokens go to visible output |
| `PRIMARY_EFFORT` | `'high'` | Full quality on primary attempt |
| `FALLBACK_MAX_TOKENS` | `4096` | Same budget — all goes to visible text |
| `FALLBACK_THINKING` | `{ type: 'disabled' }` | Thinking also disabled on fallback |
| `FALLBACK_EFFORT` | `'medium'` | Different execution path from primary |
| `OVERALL_TIMEOUT_MS` | `60_000` | Hard cap for the entire request (all attempts) |
| `PRIMARY_ATTEMPT_TIMEOUT_MS` | `45_000` | Per-attempt AbortSignal deadline |
| `MIN_FALLBACK_TIME_MS` | `10_000` | Minimum remaining ms before fallback may start |
| `shouldRetryForBlankReply(...)` | pure fn | Retry decision — see conditions below |
| `buildAttemptLog(...)` | pure fn | Safe structured log for one provider attempt |
| `buildRequestSummaryLog(...)` | pure fn | Safe structured log for completed request |
| `makeSignal(ms)` | fn | Creates `{ signal, clearTimer }` — injectable in tests |
| `runProviderAttempts({...})` | async fn | Full orchestration — primary + bounded fallback |

**Attempt 1 (primary):** `model: 'claude-sonnet-5', thinking: { type: 'disabled' }, output_config: { effort: 'high' }, max_tokens: 4096`. Thinking disabled reserves the full 4096-token budget for visible text.

**Attempt 2 (fallback — only when retry is warranted):** `thinking: { type: 'disabled' }, output_config: { effort: 'medium' }, max_tokens: 4096`. Medium effort provides a different provider-side execution path from the primary attempt.

**Per-attempt AbortSignals — bounded fallback time.** Each attempt gets its own `AbortController` with `PRIMARY_ATTEMPT_TIMEOUT_MS = 45s`. Before the fallback starts, the elapsed time is checked: `remaining = OVERALL_TIMEOUT_MS - elapsed`. If `remaining < MIN_FALLBACK_TIME_MS (10s)`, the fallback is skipped and `provider_timeout` is returned immediately — prevents starting a call that cannot realistically complete. Fallback timeout = `min(remaining, PRIMARY_ATTEMPT_TIMEOUT_MS)`. Total wall time ≤ `OVERALL_TIMEOUT_MS (60s)`.

**`runProviderAttempts` orchestration** (extracted to `providerCall.js`, fully injectable for testing):
- Parameters: `{ systemPrompt, messages, requestId, passUsed, requestStart, anthropicApiKey, fetchImpl, now, makeSignalFn, logAttempt, logSummary }`
- Returns: `{ ok: true, reply, truncated, attempts }` or `{ ok: false, errorCode, attempts }`
- `fetchImpl`, `now`, `makeSignalFn` default to production globals; injecting them enables real orchestration unit tests without module mocking
- `index.ts` calls it with only the required args (all four injectable deps use production defaults)

**Retry conditions (`shouldRetryForBlankReply`):** Retry is allowed ONLY when ALL of:
1. Anthropic returned HTTP 200 (not a rate-limit, server error, or overload)
2. `parseProviderResponse` returned `parseError === 'empty_provider_response'` (no usable text)
3. One of: `stop_reason === 'max_tokens'` (budget exhausted) OR content array is empty OR every block is `thinking`/`redacted_thinking` (thinking-only response)
4. This is the first attempt (caller enforces the two-attempt maximum)

**Never retried:** non-200 HTTP responses; refusals (model produces a visible text block declining the request, so `parseError` is null); auth / DB / context-budget failures (handled before any provider call); timeout (AbortError stops the loop immediately).

**`reply_present` definition:** `typeof parsedReply === 'string' && parsedReply.trim().length > 0` — guards against whitespace-only strings that parseProviderResponse filtered but that are technically non-null.

**Analytics:** `ai_assistant_used` fires exactly once after the final successful reply, regardless of how many attempts were needed. `ai_assistant_failed` fires exactly once if the entire operation (all attempts) fails.

**Privacy-safe diagnostic logging** (two structured JSON events per request, safe to surface in any logging system):

`ai_chat_provider_attempt` — emitted after each provider call (regardless of success/failure):
- `event`, `request_id`, `attempt` (1 or 2), `model`, `max_tokens`, `thinking_mode`, `effort`
- `provider_status` (HTTP status or null if aborted), `provider_request_id` (Anthropic's `x-request-id`)
- `stop_reason`, `content_block_types` (array of block type strings), `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `duration_ms`
- `context_pass` (1/2/3 — which network context pass was used), `reply_present` (boolean — non-blank visible text present)
- **Never contains:** prompt text, system prompt, contact names, emails, companies, roles, tags, notes, URLs, network context text, or provider response text

`ai_chat_request_complete` — emitted once in a `finally` block regardless of outcome:
- `event`, `request_id`, `success` (boolean), `attempts` (1 or 2), `final_error_code` (null on success), `total_duration_ms`

**Timeout:** 60 s overall hard cap. Per-attempt signal fires at 45 s. Remaining-time guard prevents starting fallback with < 10 s left. PROVISIONAL — adjust after production smoke tests.

**`index.ts` changes:** imports only `runProviderAttempts` from `providerCall.js`. Records `requestStart = Date.now()` before the call. Delegates all provider orchestration to `runProviderAttempts`. Maps `result.ok` / `result.errorCode` to the 11 canonical HTTP error responses.

**Test totals after hotfix: 353 total (37 csv-header + 62 ai-helpers + 33 theme + 15 parse-provider-response + 18 normalize-messages + 19 ai-chat-error + 67 ai-chat + 21 ai-chat-conversation + 81 ai-chat-provider)**

**Test totals after grounding/readable/contact-links branch (after Codex corrections + multiline Markdown tests): 408 total (37 csv-header + 62 ai-helpers + 33 theme + 15 parse-provider-response + 18 normalize-messages + 19 ai-chat-error + 72 ai-chat + 21 ai-chat-conversation + 81 ai-chat-provider + 37 sanitize-reply + 9 contact-link-validator + 4 extract-children-text)**

`tests/ai-chat-provider.test.js` — 81 tests: constants (10), `makeSignal` (1), `shouldRetryForBlankReply` (16), `buildAttemptLog` (22), `buildRequestSummaryLog` (11), `runProviderAttempts` orchestration (21 — all real control-flow paths covered: primary success, multi-block join, thinking+text, truncation, fallback trigger, fallback success, refusal, 429/529/400, primary timeout, insufficient remaining time, both attempts fail, call count cap, timer cleanup, log fire counts, privacy guarantees).

**Deployment status:** NOT yet deployed. Branch `review/ai-chat-complex-prompt-hotfix`. Draft PR targeting `main`. Do not deploy until explicit approval. Only `ai-chat` Edge Function needs deployment — no frontend changes, no schema changes, no migrations.

**Deployment steps (when approved):**
1. Merge PR → Vercel auto-deploys (frontend unchanged, but Vercel still builds)
2. `npx supabase functions deploy ai-chat --project-ref jzybxhvgnksrwxfivdwt --use-api` — deploys new Edge Function
3. Smoke test: simple prompt (verify works), complex network-analysis prompt (verify non-empty response)
4. If complex prompt still fails: check Supabase dashboard Edge Function logs for `ai_chat_provider_attempt` events — `attempt`, `stop_reason`, `content_block_types`, and `reply_present` will show which attempt produced text (or didn't)
5. Rollback (current production version: 9): Supabase dashboard → Edge Functions → `ai-chat` → Deployment history → activate version 9

---

### Layer C quality pass — grounding, readable answers, contact links (branch review/ai-grounding-readable-contact-links)

**What this adds (no schema changes, no migrations, no new Edge Functions):**

**Part C — Stronger grounding in SYSTEM_PROMPT:** Explicit rules that the model must never invent contacts, companies, roles, interactions, or any detail not in the data. Distinguishes observation from inference. Removes the need for users to preface questions with "don't make things up." No repetitive disclaimers after the first relevant mention.

**Part D — Readable answer standard in SYSTEM_PROMPT:** Direct answer first. ≤250 words for normal replies. Short paragraphs (≤3 sentences). Bullet points only for 3+ contacts/items. No large intro/outro paragraphs. No tables by default. No excessive headings. No italics.

**Part E — Absolute no em dash rule:** `SYSTEM_PROMPT` instructs the model to never use U+2014. `sanitizeAssistantReply()` in `supabase/functions/ai-chat/sanitizeReply.js` replaces any em dash with ` - ` as a final-output safety net using `/[ \t]*—[ \t]*/g` (absorbs surrounding horizontal whitespace — spaces and tabs only, not newlines — to prevent double spaces while preserving Markdown paragraph breaks and list-item newlines). Also replaces horizontal-whitespace-surrounded en dashes (U+2013) used as sentence punctuation via `/[ \t]+–[ \t]+/g`; range en dashes (no surrounding whitespace) and all normal hyphens are preserved. Leading/trailing horizontal whitespace from a boundary em dash is trimmed after replacement.

**Part F — Safe clickable contact names:**
- `supabase/functions/ai-chat/helpers.js`: All three context passes now include `Contact ID: <uuid>` on the `[N]` header line so the model can reference IDs.
- `SYSTEM_PROMPT`: Contact link format instruction — first mention of a stored contact → `[Exact Name](/contacts/<exact-id>)`, link only first mention, IDs only from network data.
- `supabase/functions/ai-chat/sanitizeReply.js` `sanitizeContactLinks(markdown, allowedContacts)`: Server-side validation and canonicalization — UUID must be in current user's contacts, label must case-insensitively match stored name, and the contact must not have already been linked in this reply (first-mention-only, enforced by a `Set`). On success the returned link is **canonical**: stored-name casing + lowercase UUID path, regardless of how the model wrote either. An invalid first attempt (wrong label, unknown UUID, query param, fragment, etc.) does NOT consume the first-mention opportunity. All other links become plain text. Applied before `sanitizeAssistantReply`. Handles one level of balanced parens in URLs.
- `index.ts`: Imports both sanitizers; applies `sanitizeContactLinks` then `sanitizeAssistantReply` to `result.reply` before returning the success response. Passes `allowedContacts` array (id + name only) from the DB query.
- `src/lib/contactLinkValidator.js`: Frontend-only validator `isValidContactLink(href)` — accepts only `/contacts/<lowercase-uuid>` format (lowercase hex UUIDs only). The server independently validates model-produced links via `CONTACT_PATH_RE` in `sanitizeReply.js` (accepts mixed-case UUIDs from the model, outputs canonical lowercase). The two validators use coordinated route rules but are separate functions — `contactLinkValidator.js` is not imported by the Edge Function.
- `src/lib/extractChildrenText.js`: Pure helper — recursively extracts visible text from React children (strings, numbers, arrays, nested React element objects) without importing React. Used by the anchor renderer to generate accurate `aria-label` values. Safe to unit-test in plain Node.js.
- `src/pages/FunnlAIPage.jsx`: `Link` from react-router-dom and `extractChildrenText` imported. Anchor renderer: `/contacts/<uuid>` hrefs → `<Link>` with `aria-label` built from `extractChildrenText(children)` (falls back to "Open contact details" when text cannot be extracted), `onClick` analytics, `text-accent underline` styling; all other hrefs → `<span>` (raw HTML remains disabled).

**Part G — Analytics:** `ai_contact_link_clicked` event fires on each validated contact link click with `{ source: 'ai_response' }` only — no contact ID, no name.

**Part H — Response contract unchanged:** `{ reply, request_id, truncated? }` on success; 11-code error contract unchanged.

**New files:**
- `supabase/functions/ai-chat/sanitizeReply.js` — `sanitizeContactLinks`, `sanitizeAssistantReply`
- `src/lib/contactLinkValidator.js` — frontend-only `isValidContactLink` (lowercase-UUID only; coordinates with but does not share code with the Edge Function's `CONTACT_PATH_RE`)
- `src/lib/extractChildrenText.js` — `extractChildrenText`
- `tests/sanitize-reply.test.js` — 37 tests (updated + expanded after Codex corrections + multiline Markdown tests)
- `tests/contact-link-validator.test.js` — 9 tests (updated + expanded after Codex corrections)
- `tests/extract-children-text.test.js` — 4 tests

**Modified files:** `helpers.js`, `index.ts` (SYSTEM_PROMPT + sanitizer imports), `FunnlAIPage.jsx`, `tests/ai-chat.test.js` (2 header-format fixes + 5 new context tests)

**Test totals: 408 total** (see breakdown in test-totals line above)

**Deployment status:** Merged as PR #20 (2026-07-27). Production ai-chat v11. Frontend live at main SHA 4b60a93.

---

### Layer C followup-history hotfix — multi-turn conversation failure (branch review/ai-chat-followup-history-hotfix)

**Production symptom (support ref 04b0e67f-deb8-49f3-98d0-b32264e8fd90):** Complex first prompts (e.g. "identify contacts for VC introductions") succeeded. The user's short follow-up ("do not include indiana students") returned HTTP 400 in ~545 ms with `Invalid or missing messages`. Retry also returned HTTP 400. Both failures were on ai-chat version 11.

**Root cause:** `normalizeMessages.js` used a single `MAX_MESSAGE_CHARS = 4,000` for both user and assistant messages. Provider output is capped at 4,096 tokens (~5-20 chars/token = up to ~20,000 chars for a long response). A long assistant reply displayed fine in the browser, but when the user sent a follow-up, `buildProviderMessages()` included the full assistant response as conversation history. The Edge Function rejected it as `> 4,000 chars` → HTTP 400 → the follow-up was permanently blocked. Retry sent the same invalid history → same failure.

**Why the complex first prompt succeeded:** The first prompt had no conversation history (only a single user message, well under 4,000 chars). The failure was in the follow-up, not the original request.

**Fix:** Role-specific message limits — `normalizeMessages.js` now applies distinct limits per role:

| Constant | Value | Applied to |
|---|---|---|
| `MAX_USER_MESSAGE_CHARS` | 8,000 | All user messages — returns `prompt_too_long` if exceeded |
| `MAX_ASSISTANT_HISTORY_CHARS` | 20,000 | Assistant history — shortened deterministically if exceeded (never rejected) |
| `MAX_TOTAL_CONVERSATION_CHARS` | 40,000 | Entire conversation — oldest complete user+assistant pairs trimmed |
| `MAX_MESSAGES` | 20 | Unchanged |

**Assistant history shortening:** When an assistant response exceeds 20,000 chars in provider history, `shortenAssistantForHistory()` trims it deterministically: keeps the first half + `\n[Previous assistant response shortened for conversation history]\n` + the last half. The full response remains visible in the browser — only the copy sent as provider history is shortened. Surrogate pair boundaries are respected. Exported for independent testing.

**Prompt-too-long error:** New canonical error code `prompt_too_long` (HTTP 400, retryable: false). Message: "Your message is too long — please shorten it and try again". Added to `KNOWN_CODES` in `ai-chat-error.js`. Dismiss restores the original text to the input so the user can shorten it. No "Start new chat" is shown — editing the prompt alone can fix it. User prompts are never silently truncated.

**Retry button fix:** `isRetryEligible()` in `ai-chat-conversation.js` now requires `msg.error.retryable === true`. Non-retryable errors (`invalid_request`, `prompt_too_long`, `pro_required`, `context_too_large`) no longer show Retry — resending the identical request cannot succeed.

**Start new chat:** `FunnlAIPage.jsx` has a "Start new chat" action that resets the conversation to `[INITIAL_MESSAGE]`, clears loading/input, and fires `ai_chat_reset` with `{ source: 'user_action' | 'ai_error_recovery' }`. The button appears in the header once the user has sent a message. For `invalid_request` errors (conversation-history failures where editing alone cannot help), "Start new chat" also appears inline in the error area. No database changes; conversation history is session-only.

**Stale-request protection (Codex correction, not a production-observed race):** `FunnlAIPage.jsx` uses a per-component-instance request gate (`src/lib/ai-chat-request-gate.js`). Each `sendMessage()` and `retryMessage()` call acquires a unique token via `gate.begin()`, which implicitly invalidates any prior in-flight token. `startNewChat()` calls `gate.invalidate()` synchronously before resetting state. Every post-await branch in both functions (success, error, catch, finally) checks `gate.isCurrent(token)` before mutating state or firing analytics. A stale request — one whose token was invalidated by a reset or newer send — returns early at its first stale check without touching messages, loading, or analytics. The gate is a plain value object with no React dependencies, making it independently unit-testable. The underlying Supabase invoke call is not physically cancelled (no safe AbortSignal path); its stale completion is silently discarded.

**Pre-trim role sequence validation (Codex correction):** `normalizeMessages()` previously validated strict alternation and ends-with-user only after trimming. This allowed a malformed sequence (e.g. two consecutive user messages) to become valid if trimming removed the malformed portion from the front. Now: strict alternation and ends-with-user are validated on the complete original `validated` array immediately after per-message validation and the leading-role check, before any history trimming. An invalid original sequence always returns an error regardless of whether trimming could have hidden it.

**Diagnostic role counts (Codex correction):** `rawAssistantCount` in `index.ts` was computed as `rawMsgCount - rawUserCount`, which incorrectly counted messages with invalid or missing roles as assistant messages. Changed to an explicit `rawMessages.filter(m => m?.role === 'assistant').length` count.

**Privacy-safe validation diagnostics:** `normalizeMessages()` returns a `validationReason` string alongside `errorCode` on failure. Controlled enum values: `messages_not_array`, `messages_empty`, `invalid_message_shape`, `invalid_role`, `blank_content`, `user_message_too_long`, `invalid_role_sequence`, `leading_assistant`, `conversation_not_user_terminated`, `conversation_empty_after_normalization`. These are never included in HTTP response bodies — only used for internal logging. `index.ts` logs the `ai_chat_message_validation_failed` event with: `event`, `request_id`, `validation_reason`, `message_count`, `user_message_count`, `assistant_message_count`, `max_user_message_chars`, `max_assistant_message_chars`, `total_chars`. No message content, no contact data. Both `user_message_count` and `assistant_message_count` use explicit role matching (not subtraction).

**Updated invalid_request message:** `index.ts` returns "Conversation history could not be processed — please start a new chat" (was "Invalid or missing messages") for `invalid_request` validation failures.

**Files changed (corrective commit):**
- `src/lib/ai-chat-request-gate.js` — NEW: pure `createRequestGate()` helper
- `src/pages/FunnlAIPage.jsx` — request gate integrated in `sendMessage`, `retryMessage`, `startNewChat`
- `supabase/functions/ai-chat/normalizeMessages.js` — pre-trim alternation + ends-with-user validation (steps 4–5 in new order); post-trim checks remain as defensive invariants (step 8)
- `supabase/functions/ai-chat/index.ts` — explicit `rawAssistantCount` calculation
- `tests/ai-chat-request-gate.test.js` — NEW: 13 tests for token lifecycle and FunnlAIPage control flow invariants
- `tests/normalize-messages.test.js` — 3 new tests: over-budget malformed sequence regression, over-budget trailing-assistant regression, historical oversized user message

**Files changed (initial commit — 5b89f01):**
- `supabase/functions/ai-chat/normalizeMessages.js` — role-specific limits, `shortenAssistantForHistory`, `validationReason`, exported constants renamed
- `supabase/functions/ai-chat/index.ts` — `prompt_too_long` error path, privacy-safe diagnostic log, updated `invalid_request` message
- `src/lib/ai-chat-conversation.js` — `isRetryEligible` requires `retryable === true`
- `src/lib/ai-chat-error.js` — `prompt_too_long` added to `KNOWN_CODES`
- `src/pages/FunnlAIPage.jsx` — `startNewChat` function, header button, inline "Start new chat" for `invalid_request`
- `tests/normalize-messages.test.js` — updated imports/constants, 22 new tests (regression, shortening, diagnostics)
- `tests/ai-chat-conversation.test.js` — 7 new retry-eligibility tests

**Test totals: 453 total across 13 suites (37 csv-header + 62 ai-helpers + 33 theme + 15 parse-provider-response + 43 normalize-messages + 19 ai-chat-error + 72 ai-chat + 28 ai-chat-conversation + 81 ai-chat-provider + 37 sanitize-reply + 9 contact-link-validator + 4 extract-children-text + 13 ai-chat-request-gate)**

After second-pass Codex corrections (branch `review/pro-trial-7-days`): **562 total across 15 suites** (37 csv-header + 62 ai-helpers + 33 theme + 15 parse-provider-response + 43 normalize-messages + 19 ai-chat-error + 72 ai-chat + 28 ai-chat-conversation + 117 ai-chat-provider + 37 sanitize-reply + 9 contact-link-validator + 4 extract-children-text + 13 ai-chat-request-gate + 36 pro-trial + 37 pro-entitlement). All 562 pass.

After third-pass Codex corrections (branch `review/pro-trial-7-days`): **586 total across 17 suites** (37 csv-header + 62 ai-helpers + 33 theme + 15 parse-provider-response + 43 normalize-messages + 19 ai-chat-error + 72 ai-chat + 28 ai-chat-conversation + 117 ai-chat-provider + 37 sanitize-reply + 9 contact-link-validator + 4 extract-children-text + 13 ai-chat-request-gate + 36 pro-trial + 38 pro-entitlement + 11 pro-access-status + 12 pro-ui-status). All 586 pass.

**Deployment status:** Deployed as PR #21 (2026-07-27). Production ai-chat v12. Frontend live at main SHA `030e315`. Rollback: Edge Function — Supabase dashboard → ai-chat → Deployment history → activate version 11.

---

### Layer C timeout hotfix — follow-up request timeout (branch review/ai-chat-followup-timeout-hotfix)

**Production symptom (support ref 4aeabfa7-8afc-4b46-8cd0-ae380bcfbb88):** Complex first prompt succeeded; immediate follow-up ("include Indiana University students too, but put them in a separate section and explain which stored facts make each person a potential user") returned `provider_timeout` in ~45 s. NOT the previous `Invalid messages` failure from PR #21 — normalization passed and the provider path was reached.

**What is confirmed:** The frontend received `provider_timeout`. The deployed Edge Function had `PRIMARY_ATTEMPT_TIMEOUT_MS = 45,000` (an AbortController deadline). The code does not retry on timeout — one attempt, then a structured error.

**What is inferred (not confirmed):** The complex multi-turn follow-up likely exceeded the 45 s per-attempt deadline. The exact provider-side duration, token counts, and whether the abort fired at precisely 45 s are not confirmed — Supabase Edge Function logs are not accessible programmatically and were not captured at the time of failure.

**Fix overview:**

**1. `PRIMARY_MAX_TOKENS` reduced from 4096 → 2048** — aligns with the ≤250-word readable-answer standard; makes worst-case output latency more predictable.

**2. `PRIMARY_ATTEMPT_TIMEOUT_MS` increased from 45,000 → 90,000** — the core fix, giving the provider substantially more wall time before abort.

**3. `OVERALL_TIMEOUT_MS` replaced with `REQUEST_DEADLINE_MS = 125,000`** — architectural correction. The prior `OVERALL_TIMEOUT_MS = 120,000` was measured from `requestStart`, which is captured AFTER auth + DB + context work. It therefore only covered the provider stage, not the full invocation. The new `REQUEST_DEADLINE_MS = 125,000` is measured from `requestEntryMs` (captured at the very start of the Edge Function handler, before auth), covering the full invocation. The 25,000 ms safety margin below the 150 s Supabase wall-clock limit is provisional — actual pre-provider overhead should be validated from `pre_provider_ms` in production logs once deployed.

**4. `MIN_FALLBACK_TIME_MS` increased from 10,000 → 20,000** — ensures a blank-reply fallback attempt has realistic time to complete.

**Full constant table:**

| Constant | Old | New | Notes |
|---|---|---|---|
| `PRIMARY_MAX_TOKENS` | 4096 | 2048 | Aligns with ≤250-word readable-answer standard |
| `FALLBACK_MAX_TOKENS` | 4096 | 2048 | Consistent with primary |
| `PRIMARY_ATTEMPT_TIMEOUT_MS` | 45,000 | 90,000 | Core fix: per-attempt abort deadline |
| `OVERALL_TIMEOUT_MS` | 60,000 | (removed) | Replaced by REQUEST_DEADLINE_MS — see below |
| `REQUEST_DEADLINE_MS` | (new) | 125,000 | Full-invocation deadline from `requestEntryMs` (handler entry, before auth). Covers auth + DB + context + all provider attempts. 25s below 150s platform limit — provisional |
| `MIN_FALLBACK_TIME_MS` | 10,000 | 20,000 | Minimum remaining budget to start a blank-reply fallback |

**Deadline architecture (`providerCall.js`):**
- `REQUEST_DEADLINE_MS = 125,000` is measured from `requestEntryMs` (passed from `index.ts`), not from `requestStart`
- Before every attempt: `remainingRequestMs = REQUEST_DEADLINE_MS - (now() - requestEntryMs)`
- Per-attempt signal: `min(PRIMARY_ATTEMPT_TIMEOUT_MS, remainingRequestMs)` — budget-bounded
- If `remainingRequestMs < MIN_FALLBACK_TIME_MS` before any attempt: skip immediately, return `provider_timeout` with `timeout_source: 'request_deadline'`
- AbortError from a provider call → `timeout_source: 'attempt_deadline'`
- When `requestEntryMs` is not provided: deadline check is skipped; each attempt gets full `PRIMARY_ATTEMPT_TIMEOUT_MS` (backward-compatible)

**Diagnostic metrics (three separate values):**
- `pre_provider_ms`: `requestStart - requestEntryMs` — time from handler entry until provider orchestration begins (auth + DB + context)
- `provider_duration_ms`: `finalMs - requestStart` — time spent inside provider orchestration only
- `total_duration_ms`: `finalMs - requestEntryMs` — elapsed time from handler entry through provider orchestration completion. Includes pre-provider and provider work; excludes final reply sanitization and response serialization (the small amount of work that runs after `runProviderAttempts` returns).

Note: `total_duration_ms` meaning changed from the prior version (where it measured only the provider stage from `requestStart`). All three fields appear in the `ai_chat_request_complete` log event.

**New attempt log fields:**
- `remaining_request_ms_at_attempt_start` — budget remaining when each attempt started
- `attempt_timeout_ms` — the AbortController deadline actually used for that attempt

**`timeout_source` field (new):**
- `'attempt_deadline'` — AbortController fired during the provider call
- `'request_deadline'` — full-invocation budget exhausted before attempt started
- `null` — no timeout (success, or error from a non-timeout cause)

**Files changed:**
- `supabase/functions/ai-chat/providerCall.js` — removed `OVERALL_TIMEOUT_MS`, added `REQUEST_DEADLINE_MS`; full deadline architecture; `buildAttemptLog` gains `remainingRequestMsAtAttemptStart` + `attemptTimeoutMs`; `buildRequestSummaryLog` gains `timeoutSource` + `providerDurationMs`; `total_duration_ms` meaning changed (now from `requestEntryMs`); `runProviderAttempts` accepts `requestEntryMs`
- `supabase/functions/ai-chat/index.ts` — `requestEntryMs = Date.now()` at handler entry; `requestStart = Date.now()` just before `runProviderAttempts`; both passed to `runProviderAttempts`
- `supabase/functions/ai-chat/normalizeMessages.js` — updated comment referencing `PRIMARY_MAX_TOKENS = 2,048`
- `tests/ai-chat-provider.test.js` — import updated (`OVERALL_TIMEOUT_MS` → `REQUEST_DEADLINE_MS`); `makeSteppingNow` helper added; constant tests updated; 4 new `buildAttemptLog` tests; 7 new `buildRequestSummaryLog` tests; N5 and N6 rewritten for new deadline architecture; P1–P15 deadline regression tests added

**Test totals: 479 total across 13 suites (37 csv-header + 62 ai-helpers + 33 theme + 15 parse-provider-response + 43 normalize-messages + 19 ai-chat-error + 72 ai-chat + 28 ai-chat-conversation + 117 ai-chat-provider + 37 sanitize-reply + 9 contact-link-validator + 4 extract-children-text + 13 ai-chat-request-gate)**

**No frontend behavior changes. No schema changes. No migrations. No other Edge Functions.**

**Compatibility:** `requestEntryMs` is an optional parameter in `runProviderAttempts`. When omitted: deadline check is skipped, each attempt gets full `PRIMARY_ATTEMPT_TIMEOUT_MS`, `pre_provider_ms` and `total_duration_ms` are null — backward-compatible with all existing callers and tests.

**Deployment status:** Deployed as PR #22 (2026-07-27). Production ai-chat v13. Frontend at merge SHA 5281c58. Authenticated smoke test passed: both complex first prompt and immediate follow-up returned non-empty answers with no timeout. Rollback: Edge Function — Supabase dashboard → ai-chat → Deployment history → activate version 12.

**Deployment notes:**
- PR #22 contains no frontend behavior changes.
- Merging to main triggers the configured Vercel production build even when no frontend source changed.
- The generated frontend bundle is functionally unchanged.
- The ai-chat fix becomes active only after the Supabase Edge Function is separately deployed.
- Edge Function command: `npx supabase functions deploy ai-chat --project-ref jzybxhvgnksrwxfivdwt --use-api`

**Smoke test (when approved):**
1. Simple prompt → confirm non-empty reply
2. Complex first prompt (e.g., "identify contacts for VC introductions") → confirm non-empty reply
3. Follow-up turn (e.g., "include Indiana University students too in a separate section") → confirm non-empty reply (this is the previously-failing scenario)
4. Check Supabase Edge Function logs for `ai_chat_request_complete` — verify `pre_provider_ms`, `provider_duration_ms`, and `total_duration_ms` are all present; verify `timeout_source` is null on success; verify `total_duration_ms` is below 125,000

**Rollback:** Supabase dashboard → Edge Functions → `ai-chat` → Deployment history → activate version 12 (current production). Frontend bundle is functionally unchanged either way.

---

### Layer D spec — Stripe billing (branch review/stripe-checkout)

**Status: reliability pass complete; partially deployed at older versions.** All code is on branch `review/stripe-checkout` (Draft PR #24). Deployment state is a **mix** — see the per-component table in `docs/pr24-body.md` (verified via read-only `supabase functions list` on 2026-08-14). Summary:
- Migration `20260812000000_add_subscriptions.sql` IS applied to production (subscriptions table exists, RPC works, data live). The migration-history ledger has a gap (shows as local-only in `supabase migration list --linked`); **required repair** before the next `db push`: `supabase migration repair --status applied 20260812000000 --linked` — DO NOT run without explicit approval.
- Migration `20260813000000_add_webhook_idempotency.sql` is NOT applied. (Now also adds the R3/R6 failure codes and the R6 partial unique index `subscriptions_stripe_subscription_id_uniq`.)
- Migration `20260815003056_add_checkout_session_singleflight.sql` (R1: `checkout_operations` + claim/finalize RPCs) is NOT applied. **After the ledger repair, a `db push` dry run shows exactly TWO pending migrations** (`20260813000000` and `20260815003056`) — no longer "exactly one".
- `create-checkout-session` (v2) and `stripe-webhook` (v4, `verify_jwt=false`) ARE deployed but at **older versions** predating this branch's rewrites. Redeploy `stripe-webhook` only after `20260813000000`, and `create-checkout-session` only after `20260815003056`. The older live checkout function has NO durable single-flight, no checkout modes, and blocks only active/past_due.
- **Checkout modes (R1):** `claim_checkout_operation` takes `p_mode` — `reuse_or_create` (none), `reuse_only` (incomplete), `fresh_only` (canceled/incomplete_expired: never reuse an old completed session), `block` (active/past_due/trialing/unpaid/paused/unknown never reach the RPC). Same-price stale recovery retains `operation_id`; different-price mints a new one.
- **Canonical status policy** lives at `supabase/functions/shared/subscriptionStatusPolicy.js` (Edge-safe); `src/lib/subscriptionStatusPolicy.js` is a thin re-export (one implementation).
- **Vercel PR Preview:** merging/pushing this PR auto-builds a Vercel PR **Preview** (NOT production). "Nothing deployed to production" is accurate; the branch frontend is not on `www.getfunnl.com`.
- `ai-chat` (v17), `ai-parse-contact` (v6), `ai-map-csv` (v6), `ai-categorize-contacts` (v5) ARE deployed with subscription-aware entitlement checks.
- `create-billing-portal-session` is NOT deployed; frontend Stripe UI is NOT merged/deployed. Awaiting rollout approval.
- **Duplicate-subscription protection is server-side** (`checkout_operations` single-flight, R1) + the shared status policy (R2) — NOT the React `createActionGuard` (which only protects one mounted component). That protection is live only after `20260815003056` is applied and the function redeployed.

**Migration-history repair command (documented, do not run without approval):**
```
npx supabase migration repair --status applied 20260812000000 --linked
```
Run only after verifying `supabase migration list --linked` still shows `20260812000000` as local-only.

**Design decisions (permanent — do not change without approval):**
- Stripe TEST mode only. Going live is a separate later step.
- The frontend uses NO Stripe credentials, and this implementation uses NO publishable key at all (no Stripe.js in the browser). The required Stripe secrets (secret key, price ID, webhook secret) live in Supabase Edge Function secrets only — never in `VITE_` env vars, Vercel env vars, or `.env`. The price ID is read from `STRIPE_PRO_PRICE_ID` by the Edge Function server-side. Stripe secret key (`STRIPE_SECRET_KEY`) and webhook secret (`STRIPE_WEBHOOK_SECRET`) are Supabase secrets — never in any file or repo.
- Users subscribe from the locked surface directly (FunnlAIPage or SettingsPage) — shared `handleSubscribe()` calls `create-checkout-session` Edge Function → redirects to Stripe hosted Checkout.
- `past_due` counts as Pro (access preserved during Stripe's dunning window; only revoked on `subscription.deleted`).
- Cancel-at-period-end: Pro continues until `current_period_end`, then `subscription.deleted` fires and Pro is revoked.
- `subscriptions` table: authenticated users SELECT-only on their own row. All writes go through the webhook (service-role only). Users cannot self-grant Pro.
- Unified Pro access: `can_use_pro = permanent_pro OR trial_active OR subscription_active` — enforced in one RPC + `shared/pro-entitlement.js`. All four AI Edge Functions inherit it automatically.

**Stripe credentials (TEST mode) — the required secrets live in Supabase Edge Function secrets, never in the repo. Read exact values from the Stripe dashboard.**

This implementation uses NO Stripe publishable key — it never runs Stripe.js in the browser; it only redirects to Stripe-hosted Checkout/Portal URLs returned by the Edge Functions. The publishable key is not a secret and is not required. Required secrets:
- `STRIPE_SECRET_KEY` — secret key, server-side only, never in repo.
- `STRIPE_PRO_PRICE_ID` — the Pro price ID (read server-side only).
- `STRIPE_WEBHOOK_SECRET` — added after the webhook is registered in Stripe.
- No frontend `VITE_STRIPE_*` variables are needed.
- Webhook URL: `https://jzybxhvgnksrwxfivdwt.supabase.co/functions/v1/stripe-webhook`

  Note: exact key and price-ID values are intentionally NOT stored in this repo. They live only in Supabase Edge Function secrets (and the Stripe dashboard). Do not paste them back into any committed file.

**New files:**
- `supabase/migrations/20260812000000_add_subscriptions.sql` — creates `public.subscriptions` table, updates `get_my_pro_access_status()` RPC with subscription fields. **PREREQUISITE:** `20260727000000_add_pro_trials.sql` must be applied first.
- `supabase/functions/create-checkout-session/index.ts` — thin POST-only wrapper (405 otherwise): authenticates the caller, builds the service-role client + real Stripe session creator, and delegates to `runCheckoutOrchestration()`. The browser `attemptId` is non-authoritative (ignored for dedup). Reads price from `STRIPE_PRO_PRICE_ID` env only; sets `client_reference_id` + `subscription_data[metadata][user_id]`; returns `{ url }` only.
- `supabase/functions/create-checkout-session/checkoutOrchestrator.js` — NEW (R1). Injectable `runCheckoutOrchestration()` with the real control flow: durable subscription gating via the shared status policy, atomic `claim_checkout_operation` (reuse/in_progress/blocked_no_reuse/claimed), one Stripe call using the opaque operation-UUID idempotency key, URL validation, token-safe `finalize_checkout_operation`. Unit-tested in `tests/checkout-orchestration.test.js`.
- `supabase/functions/create-checkout-session/checkoutHelpers.js` — pure helpers: `isValidUUID`, `buildCheckoutIdempotencyKey(operationId)` (opaque `checkout-op-<uuid>`, **no PII**), `isValidCheckoutUrl`. Unit-tested in `tests/checkout-helpers.test.js`.
- `supabase/functions/shared/subscriptionStatusPolicy.js` — NEW (R2, relocated in R7). Canonical shared status policy (checkoutMode ∈ reuse_or_create/reuse_only/fresh_only/block, grantsAccess, uiState) imported by the checkout Edge Function via `../shared/…`. `src/lib/subscriptionStatusPolicy.js` is a thin frontend re-export (`export *`). One implementation. `tests/subscription-status-policy.test.js`.
- `supabase/functions/create-checkout-session/checkoutHelpers.js` — adds `validateStripeSession(session, nowSec)` (R3): a session is only finalizable/reusable when it has a non-empty id, a valid checkout URL, and a FUTURE `expires_at`.
- `src/lib/accountSwitch.js` — NEW (R5). Pure `isAccountSwitch(prevUid,newUid)` + `isStaleGeneration(captured,current)` used by FunnlAIPage's real `onAuthStateChange` account-switch handling. `tests/account-switch.test.js`.
- `supabase/migrations/20260815003056_add_checkout_session_singleflight.sql` — NEW (R1, NOT applied). `checkout_operations` table + `claim_checkout_operation()` / `finalize_checkout_operation()` SECURITY DEFINER RPCs (service_role-only, `SET search_path=''`, opaque claim-token ownership, terminal rows can't re-finalize).
- `supabase/functions/stripe-webhook/index.ts` — manual HMAC-SHA256 signature verification via `crypto.subtle` (no external Stripe SDK). 5-minute replay protection. Handles: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`. All DB writes via service-role client. **Deployed with `verify_jwt = false`** (set in `supabase/config.toml` `[functions.stripe-webhook]`) — Stripe POSTs carry no Supabase JWT. Security is provided by Stripe HMAC-SHA256 signature verification: missing `stripe-signature` → 400, bad signature → 400, event older than 5 minutes → 400. Not open — authenticated via Stripe signature instead of Supabase JWT. All DB write failures return 500 (forces Stripe retry). `resolveUserId` 3-step chain: metadata.user_id → subscription row by subscription_id → subscription row by customer_id. Unknown ownership on entitlement-changing events → 500 (retry). Price validated against `STRIPE_PRO_PRICE_ID` env var; mismatch → 200 (ignored, not our product).
- `supabase/functions/stripe-webhook/webhookHelpers.js` — NEW. `isValidUUID`, `extractPriceId`, `SUBSCRIPTION_STATUS_SEMANTICS` (all 8 Stripe statuses with grantsAccess/isTerminal/description), `statusGrantsAccess`, `unixToIso`, `shouldRetryOnMissingOwnership`. Zero deps, unit-tested in `tests/webhook-helpers.test.js`.
- `supabase/migrations/20260813000000_add_webhook_idempotency.sql` — NEW design (NOT applied). Creates `stripe_webhook_events` deduplication table (INSERT ON CONFLICT DO NOTHING on event_id PK) + adds `last_stripe_event_at` to subscriptions for out-of-order protection. Strategy: persist latest applied event timestamp (avoids extra Stripe API call). Apply before deploying idempotency-aware webhook version.
- `supabase/functions/create-billing-portal-session/index.ts` — NEW (NOT deployed). POST-only. Resolves `stripe_customer_id` server-side from subscriptions table — never from browser. Returns `{ url }` only. SETUP REQUIRED IN STRIPE DASHBOARD before use (Billing Portal must be configured at dashboard.stripe.com/settings/billing/portal).
- `src/lib/checkoutPolling.js` — NEW. Pure polling helper for checkout-return Pro-status confirmation. `POLL_DELAYS_MS = [1500, 3000, 6000, 12000]` (22.5s total). `getNextPollDelay(attempt)`. `runCheckoutPolling({ refreshFn, hasAccessFn, signal, delayFn })` returns `'confirmed' | 'timeout' | 'aborted'`. Zero deps, unit-tested in `tests/checkout-polling.test.js`.

**Updated shared files:**
- `supabase/functions/shared/pro-entitlement.js` — `evaluateProEntitlement` signature changed from `(profile, trial, now)` to `(profile, trial, subscription, now)`. Priority 2 added: `subscription.status 'active'|'past_due'` → `reason: 'subscription'`. `loadProEntitlement` now runs 3 concurrent queries (profiles + pro_trials + subscriptions). Returns `subscriptionError` + `_subscriptionErrorCode`.
- All four AI Edge Functions (`ai-parse-contact`, `ai-map-csv`, `ai-categorize-contacts`, `ai-chat`) — updated to destructure `subscription` from `loadProEntitlement` and pass it as 3rd arg to `evaluateProEntitlement`.
- `src/lib/pro-ui-status.js` — `classifyProStatus()` now returns 6 states: `'unavailable' | 'permanent' | 'subscribed' | 'trial' | 'expired' | 'non_pro'`. Checks `subscription_active === true` after permanent and before trial.
- `src/pages/SettingsPage.jsx` — reads `?checkout=success/cancelled` from URL on mount (URL cleaned immediately via `navigate`). Checkout return: bounded polling via `runCheckoutPolling` — shows "Confirming subscription…" during poll, "✓ You're on Funnl Pro — welcome!" on confirmed, "Payment processing — check again" with Retry button on timeout (22.5s total). Subscribe button in Pro Access card for expired/non_pro states, fires `checkout_started` + `checkout_creation_failed` analytics, sends `{ attemptId: crypto.randomUUID() }` to create-checkout-session for idempotency. Subscribed state shows "Renews DATE" or "Cancels DATE" depending on `cancel_at_period_end`, plus "Manage billing →" button that opens Stripe Customer Portal via `create-billing-portal-session` Edge Function and fires `billing_portal_opened` analytics. `handleSubscribe()` calls `create-checkout-session` Edge Function.
- `src/pages/FunnlAIPage.jsx` — `isProUser` includes `subscribed`. Subscribe button in locked state. `proBadge` shows `PRO` for subscribed users.

**`subscriptions` table schema:**
| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid | PK, FK → auth.users ON DELETE CASCADE |
| `stripe_customer_id` | text | Unique index — used by webhook to look up user from customer events |
| `stripe_subscription_id` | text | Nullable — set after checkout.session.completed |
| `status` | text | One of: active, past_due, canceled, incomplete, trialing |
| `current_period_end` | timestamptz | Nullable — next renewal date |
| `cancel_at_period_end` | boolean | Default false — set true when user cancels, Pro continues until period end |
| `price_id` | text | Nullable — Stripe price ID for the active subscription |
| `created_at` | timestamptz | Auto-set |
| `updated_at` | timestamptz | Updated by webhook on every event |

**RLS:** SELECT only for authenticated using `(SELECT auth.uid()) = user_id`. `REVOKE ALL FROM PUBLIC, anon`; `REVOKE INSERT/UPDATE/DELETE FROM authenticated`. All writes go through service-role webhook only.

**Updated `get_my_pro_access_status()` RPC:** now queries `subscriptions` and returns 4 new fields: `subscription_active boolean`, `subscription_status text`, `subscription_period_end timestamptz`, `cancel_at_period_end boolean`. `can_use_pro = permanent_pro OR trial_active OR subscription_active`.

**Manual steps required before deployment (in order):**
1. Migration `20260812000000_add_subscriptions.sql` IS already applied to production — skip the SQL run. **Required: repair the migration ledger** so future `supabase db push` runs do not re-attempt it: `npx supabase migration repair --status applied 20260812000000 --linked` (verify it still shows as local-only in `supabase migration list --linked` first). Verify: `subscription_active` appears in `get_my_pro_access_status()` output.
2. Add `STRIPE_SECRET_KEY` and `STRIPE_PRO_PRICE_ID` to Supabase Edge Function secrets. Read the exact price-ID value from the Stripe dashboard — it is intentionally not stored in this repo.
3. No frontend env vars are needed for Stripe — all Stripe credentials live in Supabase Edge Function secrets only. (`VITE_STRIPE_PUBLISHABLE_KEY` and `VITE_STRIPE_PRICE_ID` are NOT used by the frontend.)
4. Deploy Edge Functions: `npx supabase functions deploy create-checkout-session --linked`, `npx supabase functions deploy stripe-webhook --linked`, `npx supabase functions deploy create-billing-portal-session --linked`. Also redeploy all four AI Edge Functions (they now call 3-query `loadProEntitlement`).
5. Register webhook endpoint `https://jzybxhvgnksrwxfivdwt.supabase.co/functions/v1/stripe-webhook` in Stripe dashboard → Developers → Webhooks. Select events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`. Copy the `whsec_...` signing secret.
6. Add `STRIPE_WEBHOOK_SECRET` (the `whsec_...` value) to Supabase Edge Function secrets.
7. Configure the Stripe Customer Portal at dashboard.stripe.com/settings/billing/portal. Enable it, set return URL to `https://www.getfunnl.com/settings`, configure cancellation/payment-method options.
8. Merge frontend PR into `main`; wait for Vercel READY.

**Test plan (Stripe TEST mode, do before merging to main):**
- New signup → trial active, AI access works
- Trial expiry simulation → locked state shows Subscribe button
- Click Subscribe from SettingsPage and FunnlAIPage → `checkout_started` event fires → redirects to Stripe Checkout
- Complete with test card `4242 4242 4242 4242` → returns to `?checkout=success` → "Confirming subscription…" shown during poll → "✓ You're on Funnl Pro" on confirmation
- Slow webhook scenario: use Stripe test-clock to delay webhook → timeout state shows "Payment processing — check again" + Retry button
- Subscription active → AI access works; Settings shows "Manage billing →" button
- Click "Manage billing →" → `billing_portal_opened` fires → Stripe Customer Portal opens
- Cancel subscription in portal → `cancel_at_period_end=true` → "Cancels DATE" shown, Pro continues until period end
- `subscription.deleted` fires at period end → access revoked, locked state shown
- Already-subscribed user clicks Subscribe again → 409 returned (no double session)
- Invalid `attemptId` (missing or not UUID) → 400 from Edge Function
- Permanent Pro user (`ai_enabled=true`) unaffected by any subscription state
- Webhook signature failure (tampered body) → 400 rejected
