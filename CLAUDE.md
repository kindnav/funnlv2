# Funnl — Complete Project Reference

Keep this file current. When we make a durable decision, finish a feature, change the schema, or shift the plan — update this file. A new session should be able to read this and understand the project's current state without re-explanation.

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
- **Supabase** — PostgreSQL + auth; credentials in `.env` (never commit `.env`)
- **React Router v7** — client-side routing
- **Vercel** — deployed; connected to GitHub (kindnav/funnlv2), auto-deploys on push to main. `vercel.json` at project root rewrites all routes to `index.html` so React Router handles SPA routing without 404s on direct URL access.

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
| **Real email / SMTP** | ✅ Resend connected via Supabase custom SMTP; sending from noreply@getfunnl.com; getfunnl.com verified on Cloudflare. Confirmation emails deliver reliably. |
| **Email confirmation landing page** | ✅ `/welcome` — clean success screen (checkmark, "You're all set", "Continue to sign in" button). No sidebar. Accessible to logged-out users. Supabase redirect URLs must point here once deployed. |
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

## Known future work / tech debt

### ✅ DONE — Real email / SMTP
Resend is connected via Supabase custom SMTP. Sending from `noreply@getfunnl.com`. Domain `getfunnl.com` verified on Cloudflare. Confirmation emails deliver reliably.

### ⚠️ Before deploying to getfunnl.com
**Supabase redirect URLs** — once the app is deployed, update two settings in Supabase dashboard so confirmation emails land on the real welcome page:
1. **Project Settings → General → Site URL** → `https://getfunnl.com`
2. **Project Settings → Authentication → URL Configuration → Redirect URLs** → add `https://getfunnl.com/welcome`

Without this, confirmation links will still redirect to localhost. The `/welcome` page is already built and waiting.

### Before real launch (required)
2. **User profile (display name + school)** — sidebar shows email username + "Funnl user". Add a `profiles` Supabase table + settings screen so users can set a real name.

### Before wider sharing (important)
3. **Google OAuth sign-in** — design shows a "Continue with Google" button; deliberately omitted. Requires Google Cloud project + Supabase OAuth config.
4. **Sidebar Pipeline counts** — Target firms / Recruiters / Alumni show no counts yet. Wire by adding count queries to `Sidebar.jsx` or passing down from `ContactsPage`.
5. **Tag filter wiring (sidebar → contacts)** — change Pipeline `Link` hrefs to `/contacts?tag=target+firm` etc. `ContactsPage` already handles the param.

### Layer 2 (next major phase)
6. **Follow-ups screen** — `/followups` is a "coming soon" stub. Needs: grouping by overdue/today/upcoming, Snooze, Mark done actions, and "going cold" detection logic.

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
