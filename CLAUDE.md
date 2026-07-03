# Funnl — Project Notes for Claude

## What this project is

Funnl is a student networking CRM. Students log the people they meet (recruiters, alumni, founders, other students), record interactions and notes, and track follow-up dates. The goal is to replace messy spreadsheets with something fast and low-friction.

## Tech stack

- Vite + React (JavaScript only, no TypeScript)
- Tailwind CSS v4 (uses `@theme` block in index.css for custom tokens, not tailwind.config.js)
- Supabase (database + auth, already connected)
- React Router v7 (client-side routing)
- Deployed later to Vercel (not yet set up)

## Three-layer product plan

1. **Layer 1 (current):** Core CRM — add/edit/delete contacts, log interactions, write notes, search, dashboard.
2. **Layer 2 (after MVP):** Rule-based follow-up reminders and "relationship going cold" flags based on dates.
3. **Layer 3 (later):** AI agent — summarizes notes, suggests contacts to reach out to, answers natural-language questions like "who do I know at Goldman" or "who has Python skills."

The data schema (notes as text, tags and skills as text[]) was deliberately designed to feed Layer 3 cleanly.

## Working style (important)

The user is a beginner. Always:
- Explain each step in plain language before doing it
- Pause and ask for approval before installing packages, running setup commands, committing, or pushing
- After each major step, explain what happened and what success looks like
- Explain errors in beginner terms before fixing them
- Keep things as simple as possible — no extra libraries, patterns, or features without explicit approval

## GitHub

Repo: https://github.com/kindnav/funnlv2  
Username: kindnav  
Rule: only commit and push working code at the end of a completed, tested step.

---

## Design system (locked in — do not drift from these values)

The app uses a custom dark design system. All authenticated screens share a fixed 248px sidebar (`src/components/Sidebar.jsx`) + a scrollable content area (`bg-surface`). Do not add new screens or components without following these tokens exactly.

### Fonts (loaded via Google Fonts in index.html)

| Class | Family | Used for |
|---|---|---|
| `font-sans` | Plus Jakarta Sans (400–800) | All UI text, headings, body copy — the default |
| `font-display` | Space Grotesk (500–700) | Logo wordmark, page h1 titles, large stat numbers |
| `font-mono` | JetBrains Mono (400–600) | Section eyebrow labels, tag/skill chips, metadata |

### Color tokens (defined in `src/index.css` @theme → used as Tailwind utilities)

| Token | Hex | Used for |
|---|---|---|
| `bg-base` | `#060608` | Root page background |
| `bg-surface` | `#0B0B0E` | Main content area background |
| `bg-sidebar` | `#100F14` | Sidebar background |
| `bg-card` | `#141419` | Card and panel backgrounds |
| `bg-elevated` | `#1A1A21` | Raised elements: chips, secondary buttons, user card |
| `bg-input` | `#131318` | Form input backgrounds |
| `text-hi` / `bg-hi` | `#F4F3F8` | High-emphasis text; white button fill |
| `text-mid` | `#A0A0AD` | Secondary text, idle nav labels |
| `text-muted` | `#9A9AA5` | Body/description text |
| `text-low` | `#6C6C78` | Low-emphasis text, placeholder icons |
| `text-lower` | `#54545E` | Disabled / very muted text |
| `text-accent` / `bg-accent` | `#8B7CFF` | Brand accent: active icon stroke, links, "NEW" badge text |
| `bg-success` / `text-success` | `#2FD4B6` | Done/complete states |
| `bg-warning` / `text-warning` | `#FFB84D` | Follow-ups due (amber) |
| `bg-warning-deep` | `#F5A623` | Recruiters pipeline dot, deep amber |
| `bg-danger` / `text-danger` | `#FF6B8A` | Overdue / error states |
| `text-tag` | `#B4A8FF` | Tag pill text |
| `text-skill` | `#9EA0AD` | Skill chip text |

### Primary gradient (brand accent)
`bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)]` — logo tile, primary buttons, active icon glow

### Borders (use as arbitrary Tailwind values)
- Subtle: `border-[rgba(255,255,255,0.06)]`
- Default: `border-[rgba(255,255,255,0.07)]`
- Strong: `border-[rgba(255,255,255,0.09)]`

### Active nav item style
```
bg-[rgba(108,92,255,0.14)] text-hi shadow-[inset_0_0_0_1px_rgba(139,124,255,0.18)]
```

### Spacing scale
Stick to: `4 · 8 · 12 · 16 · 24 · 32px` (Tailwind: `gap-1 · gap-2 · gap-3 · gap-4 · gap-6 · gap-8`)

### Border radius scale
- Small: `rounded-lg` (8px) — small chips, icon tiles
- Medium: `rounded-xl` (12px) — inputs, user card
- Large: `rounded-2xl` (16px) — cards, panels
- XL: `rounded-[20px]` — full-screen card overlays
- Pill: `rounded-full` — tags, badges, status pills

### "Coming soon" screens (intentional stubs — do not add fake data)
- `/followups` — Layer 2 feature, not yet built. Shows a polished "coming soon" message.
- `/ai` — Layer 3 feature, not yet built. Same treatment.

---

## KNOWN FUTURE WORK

Tasks that are intentionally deferred — not needed for MVP testing, but must be completed before real-world launch or a wider student rollout.

### 1. Real email sending (SMTP) — required before sharing beyond personal testers

Currently, sign-up confirmation emails use Supabase's built-in email service, rate-limited to ~2 emails/hour. Not suitable for real users.

**Before sharing beyond a small group:** integrate a real email provider (e.g. Resend or Brevo) via Supabase custom SMTP. Configuration only — the sign-up flow itself already works.

Steps when ready:
1. Create account with Resend (recommended — free tier, simple).
2. Get SMTP credentials.
3. In Supabase: Project Settings → Authentication → SMTP Settings → enter credentials.
4. Test by signing up a new account.

### 2. User profile (display name + school)

The sidebar shows the email username and "Funnl user" as a placeholder. No display name or school fields exist yet. Before sharing broadly: add a `profiles` table in Supabase (`display_name`, `school`) and a settings screen where users can fill these in. The sidebar will then show real names.

### 3. Google OAuth sign-in

The sign-in screen only supports email + password. The design spec shows a "Continue with Google" button — this is a deliberate omission, not an oversight. Add when ready to streamline onboarding: requires a Google Cloud project + Supabase OAuth provider config.

### 4. Pipeline section counts in sidebar

The sidebar's Pipeline section (Target firms / Recruiters / Alumni) links to `/contacts` but shows no counts. These should show real tag-based counts from the contacts table. Deferred to the contacts-page restyle step — decide then whether the sidebar fetches its own counts or receives them from the contacts page.
