# Funnl — Project Notes for Claude

## What this project is

Funnl is a student networking CRM. Students log the people they meet (recruiters, alumni, founders, other students), record interactions and notes, and track follow-up dates. The goal is to replace messy spreadsheets with something fast and low-friction.

## Tech stack

- Vite + React (JavaScript only, no TypeScript)
- Tailwind CSS
- Supabase (database + auth, already connected)
- React Router v7 (client-side routing)
- Deployed later to Vercel (not yet set up)

## Three-layer product plan

1. **Layer 1 (current):** Core CRM — add/edit/delete contacts, log interactions, write notes, search, dashboard.
2. **Layer 2 (after MVP):** Rule-based follow-up reminders and "relationship going cold" flags based on dates.
3. **Layer 3 (later):** AI agent that reads logged data — summarizes notes, suggests contacts to reach out to, answers natural-language questions like "who do I know at Goldman" or "who has Python skills."

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

## KNOWN FUTURE WORK

Tasks that are intentionally deferred — not needed for MVP testing, but must be completed before real-world launch or a wider student rollout.

### 1. Real email sending (SMTP) — required before sharing beyond personal testers

Currently, sign-up confirmation emails and password-reset emails use Supabase's built-in email service. This service is rate-limited to approximately 2 emails per hour and is **not suitable for real users** — most students would never receive their confirmation email and would assume the app is broken.

**Before sharing Funnl beyond a small group of personal testers:** integrate a real email provider (e.g. Resend or Brevo) via Supabase's custom SMTP settings. This is a configuration task, not a code rewrite — the sign-up flow itself already works correctly, only the email delivery mechanism needs upgrading.

Steps when ready:
1. Create an account with an email provider (Resend is recommended — free tier, simple setup).
2. Get SMTP credentials from the provider.
3. In Supabase: Project Settings → Authentication → SMTP Settings → enter credentials.
4. Test by signing up a new account and confirming the email arrives reliably.
