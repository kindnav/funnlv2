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
| **Layer 3** | ✅ Built (A/B/C) | AI Pro feature (paid tier). Layers A (gate), B (contact from text), C (AI assistant chat) all done. Layer D (Stripe billing) is next when user count warrants it. See "AI Pro feature — build plan" section. |

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
    ContactsPage.jsx       Contacts grid + search (name/company/role/tag/skill) + URL-based tag filter (?tag=recruiter)
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
| `/contacts` | ContactsPage | Grid + search + filter; `?tag=recruiter` drives filter pills |
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
| `followup_completed` | FollowUpsPage handleDone / ContactDetailPage handleLogInteraction (via Log Result) | `{ method: 'mark_done'\|'log_result' }` — controlled enum only | Core loop closure |
| `followup_snoozed` | FollowUpsPage handleSnooze | `{ option: 'tomorrow'\|'three_days'\|'one_week'\|'custom' }` — controlled enum only | Feature usage |
| `csv_import_used` | ImportContactsModal handleImport | `{ contacts_imported: number }` | Feature usage |
| `ai_assistant_used` | FunnlAIPage sendMessage on success | none | AI feature usage |
| `ai_fill_used` | AddContactDrawer handleAIParse on success | `{ fields_filled: number }` | AI feature usage |
| `landing_cta_clicked` | LandingPage — all three CTA buttons | `{ location: 'nav'\|'hero'\|'bottom' }` | Acquisition / landing page conversion |
| `signup_started` | SignInPage on mount when mode === 'signup' | none | Signup funnel step 1 — user arrived at the signup form |
| `activation_checklist_viewed` | DashboardPage on mount when checklist is shown | none | Onboarding engagement |
| `activation_step_completed` | DashboardPage recordMilestones — once per step, idempotent | `{ step: 'five_contacts'\|'first_interaction'\|'first_followup' }` | Phase 2A activation tracking |
| `activation_completed` | DashboardPage recordMilestones — once when all 3 steps done | `{ contacts_count: number }` | Canonical durable activation event — fires once when all three profiles milestones are set (5 contacts + 1 interaction + 1 follow-up) |
| `email_confirmed` | WelcomePage on mount — fires after `supabase.auth.getSession()` confirms `email_confirmed_at` is set | none | Signup funnel step 3 / activation funnel anchor |
| `user_signed_in` | SignInPage `handleSignIn` after `signInWithPassword` succeeds | none | Acquisition funnel — sign-in step |

**Deduplication note — `email_confirmed`:** Uses a `localStorage` flag keyed by user ID (`funnl_confirmed_<userId>`) to prevent re-fires on refresh or repeat visits to `/welcome`. This flag is per-browser: if the user confirms on one device and later visits `/welcome` on a different device or browser, the event may fire a second time on that device. PostHog deduplicates by distinct_id (user ID) across browsers for funnel purposes, so this cross-browser re-fire does not inflate unique-user counts in funnel reports. Raw event counts may appear slightly elevated.

**PostHog error reporting (separate from the 17 custom product events):** `trackError(error)` in `src/lib/analytics.js` calls `posthog.captureException(error)`. This fires the PostHog system event `$exception` — it is NOT one of Funnl's 17 custom product events and must not be counted as such. It is called from `ErrorBoundary.componentDidCatch` on unhandled render crashes. Funnl deliberately omits React's `componentStack`; PostHog may collect the error name, message, and stack as diagnostic exception data. This diagnostic collection is disclosed in the privacy policy. Safely no-ops when `VITE_POSTHOG_KEY` is absent.

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
| `created_at` | timestamptz | Auto-set |

**Relationship:** one contact → many interactions. Deleting a contact cascades to delete all their interactions.

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

The original schema (contacts, interactions, profiles, RLS policies, triggers) was created manually in Supabase before the migration system was set up — no baseline migration file exists for it (known limitation).

**Profile rows are auto-created on signup via a Postgres trigger** (`on_auth_user_created` on `auth.users`). The trigger function `public.handle_new_user()` runs `SECURITY DEFINER` (bypasses RLS) and inserts a row with `id`, `email`, `ai_enabled=false`, `display_name=null` the moment a new user signs up. `ON CONFLICT (id) DO NOTHING` makes it safe if a row somehow already exists.

**To grant Pro access to a user:** `UPDATE profiles SET ai_enabled = true WHERE email = 'their@email.com';` in the Supabase SQL editor.

Settings page `upsert()` still works — now it always UPDATES an existing row (never needs to INSERT). Existing accounts were backfilled with `email` and profile rows via a one-time SQL migration.

RLS: UPDATE policy prevents users from changing `ai_enabled` on their own row. The `school` column was dropped earlier. Sidebar falls back to email username / "Funnl user" if `display_name` is null.

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
| **Product analytics (PostHog)** | ✅ 17 events total (8 core + 2 Phase 1 + 3 Phase 2A + 2 Phase 3 + 2 Phase 4). Core: user_signed_up, first_contact_added, contact_added, interaction_logged, followup_set, csv_import_used, ai_assistant_used, ai_fill_used. Phase 1 additions: landing_cta_clicked, signup_started. Phase 2A additions: activation_checklist_viewed, activation_step_completed, activation_completed. Phase 3 additions: followup_completed, followup_snoozed. Phase 4 additions: email_confirmed (WelcomePage, localStorage-deduped per user per browser), user_signed_in (SignInPage handleSignIn). DOM autocapture disabled; $pageview and $pageleave remain enabled. Behavior only — no contact content. Users identified by Supabase ID. |
| **Privacy policy** | ✅ `/privacy` — plain-language page covering data stored, all third parties (Supabase, Anthropic, PostHog, Resend, Vercel), analytics disclosure, user rights, contact email. Linked from sign-in page and settings. Accessible logged-out. |
| **Phase 1 — Public landing page** | ✅ `LandingPage.jsx` at `/` for logged-out users. 11 sections: nav, hero with annotated product mock, marquee ticker, problem statement, feature rows (01–03), Funnl AI section, who-it's-for grid, comparison table, privacy note, final CTA, footer. `/signin` and `/signup` as separate routes, mode auto-detected from pathname. Post-sign-in `navigate('/', { replace: true })` prevents blank screen. All product claims verified against actual functionality. |
| **Phase 2A — Guided activation checklist** | ✅ Three-step checklist on DashboardPage: (1) add or import 5 contacts, (2) log the first conversation, (3) schedule the first follow-up. Milestones stored as four nullable `timestamptz` columns on `profiles` (the fourth records overall activation completion). Written with `WHERE col IS NULL` conditional updates for idempotent deduplication across tabs and sessions. Backfill included in migration `20260713075431_add_activation_milestones.sql`. CSV import button accessible from dashboard in addition to contacts page. |
| **Vercel main-only deployments** | ✅ `vercel.json` `git.deploymentEnabled: { main: true, "*": false }`. Preview deployments disabled for all non-main branches. |
| Rule-based reminders / cold alerts | 🔵 Layer 2 |
| **Phase 2B — Guided first-contact-to-interaction handoff** | ✅ After the first manual contact add from the Dashboard (`contactCount === 0`), navigates to that contact's detail page with Router state `{ openInteractionForm: true }`. ContactDetailPage reads this state on mount, calls `setShowForm(true)`, then immediately clears the state via `navigate(pathname, { replace: true, state: {} })` so refresh and Back do not reopen it. Scroll-into-view effect handles mobile: fires after both `showForm` becomes true AND `loading` becomes false (ref is null during the loading screen). `AddContactDrawer` now returns the new contact's `id` via `.select('id').single()` and passes it to `onSuccess?.(newContact?.id ?? null)`. Existing Phase 2A milestone tracking untouched. |
| **Phase 3 — Complete follow-up loop** | ✅ Done — Mark Done, Snooze/Reschedule, Log Result on `/followups`. Badge synchronization via `funnl:followups-changed` custom event. try/finally ensures savingId clears. Row-match verification via `.select('id').single()`. Log Result carries `sourceFollowUpId` Router state → ContactDetailPage clears old follow-up after new interaction saves. Partial-failure path preserved. |
| **Phase 4 — Pilot analytics and launch playbooks** | 🔵 In progress — `email_confirmed` + `user_signed_in` added. Pilot plan, PostHog dashboard guide, and feedback guide created in `docs/`. |

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
| **C** | AI Assistant | ✅ Done | Working chat UI on /ai (FunnlAIPage.jsx). Edge Function `ai-chat` deployed (claude-sonnet-5). Loads all contacts + interactions per call. Multi-turn conversation works. Extended thinking handled: `.find(b => b.type === 'text')` since claude-sonnet-5 sometimes returns a thinking block first. System prompt STYLE section: prose-first, no reflexive bullets/bolding, warm mentor voice. react-markdown renders assistant replies (bold/lists clean, raw HTML disabled). Typebox redesigned: pill shape, focus glow, send button with press feel. Pro-gated; non-Pro sees locked state. All stale "coming soon" copy updated across Sidebar, Dashboard, ContactDetail. |
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

### Layer D spec — Stripe billing (later)

When billing is ready: update `canUseAI()` to read Stripe subscription status instead of (or in addition to) `ai_enabled`. Because every AI feature calls `canUseAI()`, this is a one-place change. The `ai_enabled` column either becomes the fallback for manually-granted access or is retired. See Monetization section for timing.
