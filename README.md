# Funnl

Funnl is a networking CRM for students recruiting for internships and jobs. Students meet many contacts — recruiters, alumni, founders — but track them poorly. Funnl fixes that: log who you meet, record every conversation, set follow-up dates, and come back to see what needs attention.

**Live at [getfunnl.com](https://getfunnl.com)**

---

## Core product loop

Log who you meet → log every interaction and conversation → write notes and set follow-up dates → come back and see what needs attention.

---

## Stack

- **React + Vite** — JavaScript only, no TypeScript
- **Tailwind CSS v4** — custom design tokens in `src/index.css`
- **Supabase** — PostgreSQL database + auth (Row Level Security on all tables)
- **React Router v7** — client-side routing
- **Vercel** — production hosting, auto-deploys from `main`
- **PostHog** — product analytics (behavior only, no contact content)
- **Cloudflare DNS** — domain management for getfunnl.com

---

## Local setup

**1. Clone and install**

```
git clone https://github.com/kindnav/funnlv2.git
cd funnlv2
npm install
```

**2. Create `.env` in the project root**

```
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
VITE_POSTHOG_KEY=your_posthog_project_api_key
VITE_POSTHOG_HOST=https://us.i.posthog.com
```

Never commit `.env`. The Supabase anon key and PostHog project key are safe to use in the browser; the Supabase service-role key and Anthropic API key must never go here (they live in Supabase Edge Function secrets).

**3. Run**

```
npm run dev      # local dev server at localhost:5173
npm run lint     # lint check
npm run build    # production build
```

---

## Deployment

```
local review branch → GitHub PR → merge to main → Vercel production auto-deploy
```

Only pushes to `main` trigger a Vercel deployment. Non-main branches do not generate preview deployments (configured in `vercel.json`).

---

## Project reference

See [CLAUDE.md](CLAUDE.md) for the full project reference: schema, design system, analytics events, feature status, build phases, AI architecture, and working-style notes.
