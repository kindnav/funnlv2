# Funnl — Complete Project Reference

Keep this file current. When we make a durable decision, finish a feature, change the schema, or shift the plan — update this file. A new session should be able to read this and understand the project's current state without re-explanation.

---

## Current status

**Funnl is a live, deployed, multi-user MVP.** The full sign-up → email confirmation → sign-in → app flow works end to end.

- Live at **https://getfunnl.com** (www redirects to it)
- Deployed on Vercel, auto-deploys on push to `main`
- Real email via Resend — confirmation emails send reliably from `noreply@getfunnl.com`
- Supabase URL configuration set: Site URL = `https://getfunnl.com`, Redirect URLs include `/welcome` and `/**`
- **Not yet shared with real students** — email deliverability (spam folder issue) needs to be resolved first; see Task 1 in Known future work

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
| **Layer 3** | 🔵 Later | AI assistant (Claude API) — reads logged data, answers questions, drafts messages, finds opportunities |

The data schema (notes as freeform text, tags/skills as text arrays) was deliberately designed to feed Layer 3.

---

## Tech stack

- **Vite + React — JavaScript only, no TypeScript**
- **Tailwind CSS v4** — custom tokens in `src/index.css` using `@theme {}` block (not a config file)
- **Supabase** — PostgreSQL + auth; credentials in `.env` (never commit `.env`). URL config: Site URL = `https://getfunnl.com`, Redirect URLs include `https://getfunnl.com/welcome` and `https://getfunnl.com/**`.
- **React Router v7** — client-side routing
- **Vercel** — live at `https://getfunnl.com`. Connected to GitHub (kindnav/funnlv2), auto-deploys on push to `main`. Env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) set in Vercel project settings. `vercel.json` at project root rewrites all routes to `index.html` so direct URL visits don't 404.
- **Cloudflare DNS** — two CNAME records pointing `getfunnl.com` and `www.getfunnl.com` to Vercel, set to DNS-only (grey cloud). `www` redirects to apex. Domain also used for Resend email verification (SPF + DKIM records present, DMARC pending — see Task 1).

---

## Key file structure

```
src/
  components/
    Sidebar.jsx            Shared left nav: logo, user card, nav links, pipeline section, sign out
    ContactListItem.jsx    Contact card in the 2-column grid (avatar tile, tags, skills, how-met footer)
    AddContactDrawer.jsx   Right-side slide-in drawer for adding a contact; Escape/backdrop closes; scroll locked
  pages/
    DashboardPage.jsx      Landing screen after login: stats, follow-ups due, recent contacts
    ContactsPage.jsx       Contacts grid + search + URL-based tag filter (?tag=recruiter)
    ContactDetailPage.jsx  Full contact profile: two-column (details + AI placeholder / interaction timeline)
    SignInPage.jsx         Dark split-screen: sign-in mode + sign-up mode + email-confirmation pending state
    WelcomePage.jsx        Email-confirmation landing page at /welcome — no sidebar, accessible to logged-out users
  lib/
    supabase.js            Supabase client, reads VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from .env
  App.jsx                  Auth gating, shared layout (Sidebar + main scroll area), all routes
  index.css                Tailwind import + @theme design tokens + @keyframes (slide-in-right, fade-in)
  main.jsx                 React entry; wraps App in BrowserRouter
index.html                 Google Fonts link tags (Plus Jakarta Sans, Space Grotesk, JetBrains Mono)
CLAUDE.md                  This file — project reference, keep current
```

---

## Routes

| Path | Component | Notes |
|---|---|---|
| `/` | DashboardPage | Landing screen after login |
| `/contacts` | ContactsPage | Grid + search + filter; `?tag=recruiter` drives filter pills |
| `/contacts/:id` | ContactDetailPage | Full profile + interaction timeline |
| `/followups` | FollowUpsPage | Real data — overdue/today/upcoming buckets; Snooze/Mark done are Layer 2 |
| `/ai` | FunnlAIPage | Styled coming-soon; non-interactive chat UI; Layer 3 placeholder |
| `/welcome` | WelcomePage | Email-confirmation landing; no sidebar; accessible to logged-out users |

---

## Database schema

**Row Level Security is ON for both tables and has been verified with a two-user isolation test.**

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
| `tags` | text[] | Optional — relationship labels e.g. ["recruiter", "target firm"] |
| `skills` | text[] | Optional — technical abilities e.g. ["python", "excel"]. Distinct from tags. Added early for Layer 3 AI. |
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

The contacts page filter pills use `useSearchParams`. Active tag is stored as `?tag=recruiter` in the URL. **Sidebar Pipeline links are not yet wired** — they currently go to `/contacts`. To wire them: change each `Link`'s `to` prop to `/contacts?tag=target+firm` etc. ContactsPage already handles this, no code change needed there.

---

## What's built vs. coming soon

| Feature | Status |
|---|---|
| Sign in / sign up with email confirmation | ✅ |
| Add / edit / delete contacts | ✅ |
| Log / edit / delete interactions with notes | ✅ |
| Follow-up dates on interactions | ✅ (stored; displayed on dashboard and detail page) |
| Search contacts by name, company, role, tag | ✅ |
| Filter contacts by tag (URL-based) | ✅ |
| Dashboard with real stats + follow-up list | ✅ |
| Add contact drawer (slide-in, Escape closes, scroll locked) | ✅ |
| Per-user data isolation (RLS, two-user verified) | ✅ |
| Follow-ups screen (`/followups`) | ✅ Real data — shows all interactions with a follow_up_date, bucketed into Overdue / Today / Upcoming with correct local-timezone date logic. Snooze and Mark done are Layer 2. |
| Funnl AI screen (`/ai`) | ✅ Styled coming-soon screen — chat UI aesthetic, non-interactive input bar (`cursor-not-allowed`), example prompts (visual only), Layer 3 description. |
| Empty states (all screens) | ✅ Contacts zero-state has icon + "Start building your network" CTA; search/filter no-results has icon + clear-filters link; all other screens handled. |
| **Full dark redesign** | ✅ **Complete** — all 8 screens restyled to the Funnl design system (dark palette, Space Grotesk/Jakarta Sans/JetBrains Mono, shared sidebar). |
| **Robustness pass** | ✅ Error handling on all Supabase reads (dashboard, contact detail, follow-ups); local-timezone date logic consistent app-wide (sidebar badge, dashboard, contact detail, follow-ups all agree); avatar helpers extracted to `src/lib/avatarUtils.js`; AddContactDrawer rejects whitespace-only names and uses safe scroll-lock cleanup. |
| **Real email / SMTP** | ✅ Resend connected via Supabase custom SMTP; sending from noreply@getfunnl.com; getfunnl.com verified on Cloudflare. |
| **Email confirmation landing page** | ✅ `/welcome` — success screen (checkmark, "You're all set", "Continue to sign in"). No sidebar. Accessible logged-out. Supabase redirect URLs configured to point here. |
| **Deployed to production** | ✅ Live at getfunnl.com on Vercel. DNS on Cloudflare. Env vars set. SPA routing via vercel.json. Full sign-up → confirm → sign-in flow works end to end. |
| Rule-based reminders / cold alerts | 🔵 Layer 2 |
| AI assistant and smart features | 🔵 Layer 3 |

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
- [ ] **2. Mobile responsiveness** — done in 6 sub-steps below. Navigation decision: **bottom tab bar** (not hamburger). Desktop sidebar stays exactly as-is. `md` breakpoint (768px) is the switch point throughout.
  - [x] **2a. Mobile navigation** — done. `BottomNav.jsx` created: fixed bottom bar, `md:hidden`, 4 tabs (Home/Contacts/Follow-ups/Funnl AI), follow-up badge (capped at 9+), `env(safe-area-inset-bottom)` for iPhone. Sidebar outer div: `hidden md:flex flex-col`. App.jsx: BottomNav imported, `pb-16 md:pb-0` on main, `<BottomNav />` in authenticated layout.
  - [ ] **2b. Dashboard** — 3-col stat grid → single column; 2-col body (follow-ups + recent contacts) → stacked single column.
  - [ ] **2c. Contacts page** — 2-col contact card grid → single column on mobile; AddContactDrawer full-width on mobile (currently fixed 452px).
  - [ ] **2d. Contact detail page** — 2-col layout (details + interactions) → single column; hero card tweaks for narrow screens.
  - [ ] **2e. Auth screens** — SignInPage fix `px-[88px]` padding on mobile (collapses content on small screens); right panel already `hidden lg:flex` so that's fine.
  - [ ] **2f. Final pass** — FollowUps, AI, Welcome, ResetPassword screens; overall padding/spacing polish at 375px.

### Phase 2 — Should-fix before wider push
- [ ] **3. Search skills** — add skills to the contact search filter in `ContactsPage.jsx` (or remove "skill" from placeholder). One-liner.
- [ ] **4. LinkedIn URL https://** — auto-prepend `https://` when saving/displaying LinkedIn URLs so they don't break as relative links.
- [ ] **5. Settings button dead-end** — disable the Settings button in `Sidebar.jsx` with `cursor-not-allowed` + visual "coming soon" state instead of a silent dead-end click.
- [ ] **6. Pipeline sidebar links** — wire "Target firms," "Recruiters," "Alumni" links to `/contacts?tag=target+firm` etc. `ContactsPage` already handles the param; one-line fix per link.
- [ ] **7. ContactsPage error/empty-state collision** — on fetch failure, the error banner and "Start building your network" empty state both appear. Error state should suppress the page body.

### Phase 3 — Minor cleanups
- [ ] **8. Misplaced import in ContactDetailPage.jsx** — move `import { getAvatarColor, getInitials }` to the top of the file with the other imports.
- [ ] **9. Post-save confirmation** — brief success feedback after logging an interaction (toast or inline message) instead of the form silently closing.
- [ ] **10. "Try Funnl AI" CTA wording** — reconsider the sidebar CTA that implies live AI functionality when the destination is a coming-soon screen.

---

## Known future work / tech debt

### ⚠️ Task 1 — Email deliverability (do BEFORE inviting real students)
Confirmation emails currently land in recipients' spam/junk folders. Must be resolved before sharing widely, or students won't find their confirmation email and won't be able to sign in.

**Fixes, in order of impact:**
1. **Add DMARC DNS record in Cloudflare** — Resend listed this as optional during domain verification and it was skipped. SPF and DKIM are already in place; DMARC completes email authentication and is the highest-impact fix. Add a `TXT` record for `_dmarc.getfunnl.com` with value `v=DMARC1; p=none; rua=mailto:navbir12345@gmail.com` (start with `p=none` to monitor, not block).
2. **Domain warm-up** — Deliverability improves naturally over days/weeks as legitimate mail is sent and opened. Nothing to do; just takes time.
3. **Train Gmail** — Marking test emails "Not spam" in Gmail helps train filters for other Gmail users.

This is a DNS/configuration task, not a code change.

### Task 2 — /welcome confirmation UX (polish, not a blocker)
Currently, clicking the email confirmation link auto-logs the user in and drops them directly on the dashboard, skipping `/welcome`. The desired behavior is: land on the standalone `/welcome` page (no sidebar, no app shell), show the "You're all set" confirmation, then have the user click "Continue to sign in" and sign in manually.

**Why it matters:** the `/welcome` page was built for this moment, but Supabase's default behavior creates a session immediately on confirmation click, so the app's auth gate sees a logged-in user and renders the full dashboard instead.

**How to fix when ready:** In `WelcomePage.jsx`, call `supabase.auth.signOut()` on mount (before rendering), then show the page. This clears the auto-created session so the user arrives logged-out and signs in fresh. Small, self-contained change — revisit as a standalone task.

### Before real launch (required)
1. **User profile (display name + school)** — sidebar shows email username + "Funnl user". Add a `profiles` Supabase table + settings screen so users can set a real name.

### Before wider sharing (important)
2. **Google OAuth sign-in** — design shows a "Continue with Google" button; deliberately omitted. Requires Google Cloud project + Supabase OAuth config.
3. **Sidebar Pipeline counts** — Target firms / Recruiters / Alumni show no counts yet. Wire by adding count queries to `Sidebar.jsx` or passing down from `ContactsPage`.
4. **Tag filter wiring (sidebar → contacts)** — change Pipeline `Link` hrefs to `/contacts?tag=target+firm` etc. `ContactsPage` already handles the param.

### Layer 2 (next major phase)
5. **Follow-ups enhancements** — `/followups` shows real data. Still needed: Snooze, Mark done actions, and "going cold" detection logic.

### Monetization — thinking only, do NOT build yet

**Timing:** Don't build billing until you have 20–50 active returning users and understand which features they value enough to pay for. Building billing with zero users and unproven retention is premature and will slow down first-user acquisition.

**The right trigger to revisit:** someone asks how to pay for it, or costs start to matter.

**Likely model when ready:**
- Free tier: up to 50 contacts, unlimited interactions — gets students in the door
- Pro tier (~$5–8/month or $40/year): unlimited contacts + AI features (Layer 3)

Students will pay for concrete time-savings during recruiting season (AI-drafted follow-ups, "who to contact next"). They won't pay for storage. The contact limit is a natural converting forcing function — active students recruiting across multiple firms will hit 50 contacts.

### AI sequencing — wait until after first users

Do NOT start Layer 3 before getting real user data. Reasons:
1. You don't know what questions students will actually ask — don't build answers to hypothetical questions
2. Every interaction logged in Layer 1 is training data for Layer 3; more data = better AI
3. Claude API costs money per query; don't pay that before users are retained and potentially paying
4. Real users will tell you exactly which AI feature matters most — watch what they search for, what they can't find, what they complain about

**Sequence:** first cohort → watch usage → ask directly "if AI could help you with one thing here, what would it be?" → build that specific thing, not the full brainstorm list.

### PWA / mobile app (future — do NOT build yet)
The bottom-tab mobile design was deliberately chosen because it translates naturally to a native app later. Planned progression:
1. **PWA "Add to Home Screen"** — add a web app manifest, service worker, and correct viewport meta tags so the app can be installed on iOS/Android home screens. Relatively small amount of work.
2. **iOS/Android app via Capacitor** — wrap the React web app in a Capacitor shell to publish to the App Store / Play Store. Capacitor lets you ship a real native app from the same codebase. The bottom tab bar and mobile-first layouts built during the responsiveness pass are the right foundation for this.

Do not start either of these until the web app is stable and has real users.

### Layer 3 — AI integration (Claude API — do NOT build until user initiates)

**Confirmed by user:**
- **Smart contact saving** — user pastes freeform text ("Met Priya Sharma, Goldman recruiter at the Career Fair, knows Python") → Claude infers and fills all form fields in AddContactDrawer. Transform the add experience from a form into an AI-first input.
- **AI assistant / chatbot** — answers plain-English questions about the user's network.

**Brainstormed ideas (not yet approved, to discuss when Layer 3 begins):**
- **Draft outreach messages** — "write a follow-up email to Priya based on our coffee chat" — Claude reads interaction notes and drafts it
- **Smart note enhancement** — after logging raw notes, Claude flags commitments made, suggests follow-up actions
- **Semantic network search** — search by concept ("who can intro me to PE") not just keyword
- **Weekly AI digest** — Claude-generated summary of the week's activity + recommended next actions
- **Smart tagging / skill inference** — Claude infers tags and skills from freeform notes; user confirms
- **Business card / LinkedIn parsing** — paste a LinkedIn URL or bio and Claude fills the add-contact form
- **Relationship temperature scoring** — Claude rates which contacts are warm vs. going cold based on content and timing, feeds into Layer 2
- **Opportunity detection** — Claude flags contacts who mentioned open roles, internships, or referral offers in notes

**Why the current data structure supports all of this:** notes are freeform text Claude can read directly; tags and skills are structured arrays Claude can generate and query; per-user RLS ensures Claude only ever sees one user's data.
