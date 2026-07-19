# PostHog Pilot Dashboard — Setup Instructions

Manual instructions for building 12 insights during the pilot. Each insight specifies where to click, which events to use, and what decision it supports. Build them in PostHog before the first pilot session so you can observe in real time.

All insights live in PostHog → Insights. Create a Dashboard named "Funnl Pilot" and pin each insight to it.

---

## Important: filter every insight to the pilot period

When building each insight below, add a filter: **event date after [Phase 4 deployment date]**. In PostHog, this is the "Date range" control at the top of each insight — set the start date to the date Phase 4 was deployed to production. This prevents pre-existing confirmed accounts from inflating funnel counts.

If you have a defined pilot cohort (a list of invited user IDs or email addresses), create a PostHog Cohort (People → Cohorts → New Cohort) and add it as a filter to each insight instead of or in addition to the date filter. A cohort filter is more precise.

**About raw event deduplication:** The `email_confirmed` localStorage flag reduces repeat capture in one browser. It does not prevent a second fire from a different browser or device. A unique-users PostHog insight (person-level aggregation) counts each identified person once per step and is unaffected by cross-browser raw duplicates. However, PostHog does not delete duplicate raw events — total event counts may be slightly elevated for `email_confirmed`.

---

## Pre-flight: create the "Core product activity" Action

Before building Insights 7 and 11, create a reusable Action in PostHog.

**PostHog → Data Management → Actions → New action**

- Name: `Core product activity`
- Match type: **Any of (OR)**
- Add the following events:
  1. `contact_added`
  2. `csv_import_used`
  3. `interaction_logged`
  4. `followup_set`
  5. `followup_completed`
  6. `followup_snoozed`
- Save the Action

This Action represents a user doing meaningful product work: adding, updating, or acting on their network. It deliberately excludes pageviews, sign-ins, and session starts. Use it wherever WAU or retention is measured.

---

## 1 — Signup funnel

**Purpose:** Measure what fraction of users who start signing up complete email confirmation.

**How to build:**
- Insight type: Funnel
- Steps (in order):
  1. `signup_started` — user arrived at the signup form (first measurable event)
  2. `user_signed_up` — signup request succeeded, confirmation email sent
  3. `email_confirmed` — user clicked the link and Supabase confirmed the session
- Unique users: Yes (each person counted once per step)
- Conversion window: 7 days from step 1 (most clicks happen within minutes; 7 days covers edge cases)
- Filter: pilot period start date

**What it tells you:**
- Drop between 1→2: signup form friction or Supabase error
- Drop between 2→3: email landing in spam, or user gives up before clicking

**Decision it supports:** If step 2→3 conversion is below 75%, email deliverability is blocking acquisition. If it falls below 50%, do not invite more users until fixed.

---

## 2 — Confirmation conversion trend

**Purpose:** Watch the weekly signup-to-confirmation ratio for deliverability drift over the pilot period.

**How to build:**
- Insight type: Trend
- Series A: `user_signed_up` — unique users, rolling 7 days
- Series B: `email_confirmed` — unique users, rolling 7 days
- Chart type: Line
- Filter: pilot period start date

**What it tells you:** If Series B / Series A drops below 0.7, spam placement is worsening or users are taking longer to confirm.

**Decision it supports:** Determines whether email delivery needs attention before expanding the pilot.

---

## 3 — Official activation funnel

**Purpose:** Measure the fraction of confirmed users who reach durable activation (`activation_completed`). This is the canonical activation metric.

**How to build:**
- Insight type: Funnel
- Steps (in order):
  1. `email_confirmed`
  2. `activation_completed` — fires once in DashboardPage when all three milestone columns are set (5 contacts + 1 interaction + 1 follow-up date)
- Unique users: Yes
- Conversion window: 14 days (some users may complete across multiple sessions)
- Filter: pilot period start date

**What it tells you:** The official activation rate for the pilot cohort. A user is activated exactly when `activation_completed` fires — not before.

**Target:** 60%+ of confirmed users reach activation. If below 50%, there is a fundamental onboarding problem to fix before wider sharing.

**Decision it supports:** The primary go/no-go signal for the onboarding flow.

---

## 4 — Activation milestone diagnostic

**Purpose:** Identify which of the three activation milestones users complete most and least often, to find the biggest onboarding gap.

**How to build:**
- Insight type: Trend
- Event: `activation_step_completed`
- Aggregation: Total events (not unique — you want to see the absolute volume per step)
- Breakdown: by the `step` property
  - Values to look for: `five_contacts`, `first_interaction`, `first_followup`
- Time window: Rolling 14 days
- Chart type: Bar
- Filter: pilot period start date

**Important:** Do NOT build this as a sequential funnel. The three milestones do not have a strict required order — a user might log an interaction before they have 5 contacts, or set a follow-up date before completing their first interaction. Use a trend breakdown, not a funnel.

**What it tells you:** The milestone that fires least often is the biggest gap. If `first_followup` fires far less than `first_interaction`, the follow-up date field is not being used. If `five_contacts` fires rarely, users are stopping before the contact threshold.

**Decision it supports:** Reveals which specific step to improve — contact onboarding (raise CSV import visibility), interaction logging (make the form easier to find), or follow-up scheduling (add a prompt after interactions).

---

## 5 — First core-loop funnel

**Purpose:** Trace the step-by-step onboarding path to identify WHERE users drop off in the first session. This is a UX diagnostic — it is NOT the activation funnel.

**How to build:**
- Insight type: Funnel
- Steps (in order):
  1. `email_confirmed`
  2. `first_contact_added` (fires once per user, when contact count reaches 1)
  3. `interaction_logged`
  4. `followup_set`
- Unique users: Yes
- Conversion window: 7 days from step 1
- Filter: pilot period start date

**Important distinction:** `activation_completed` is the activation metric (Insight 3). This funnel uses lower-level events to show exactly where in the session flow users are stopping.

**What it tells you:**
- Drop between 2→3: users are not navigating from a contact card to log an interaction
- Drop between 3→4: the follow-up date field is not discoverable after logging

**Decision it supports:** Which specific UI step to fix in the next iteration.

---

## 6 — Time to activation

**Purpose:** Understand how long it takes from email confirmation to `activation_completed`.

**How to build:**
- Insight type: Funnel
- Steps:
  1. `email_confirmed`
  2. `activation_completed`
- Enable "Conversion time" view (toggle in funnel settings after building the steps)
- Chart type: Time to convert histogram
- Filter: pilot period start date

**What it tells you:** If median time is under 15 minutes, students activate in a single session. If it exceeds 30 minutes, the activation path is too long or users are returning across sessions.

**Decision it supports:** If median time is high, add in-app prompts to guide users faster, or simplify the activation path (e.g., lower the contact threshold temporarily).

---

## 7 — Weekly active users (WAU)

**Purpose:** Track how many distinct users are doing meaningful product work each week.

**How to build:**
- Insight type: Trend
- Event: **Core product activity** (the Action created in pre-flight)
- Unique users: Yes (person-level count)
- Aggregation: Weekly
- Chart type: Bar
- Filter: pilot period start date

**Important:** WAU is NOT based on `$pageview`, `user_signed_in`, or `email_confirmed`. A user who opens the app but does nothing does not count as weekly active.

**What it tells you:** WAU flat or growing after week 2 of the pilot → habit is forming. WAU collapses after week 1 → no retention, regardless of activation rate.

**Decision it supports:** The go/no-go signal for expanding beyond the pilot cohort.

---

## 8 — Follow-up loop

**Purpose:** Measure how often users are closing the follow-up cycle (set a date → mark done or log a result).

**How to build:**
- Insight type: Trend
- Series A: `followup_set` — total events, rolling 7 days
- Series B: `followup_completed` — total events, rolling 7 days (covers both `method: mark_done` and `method: log_result`)
- Chart type: Bar
- Filter: pilot period start date

**What it tells you:** If Series B / Series A is below 0.3, users are setting follow-up dates but not closing the loop. This may reflect that dates are still in the future (expected early) or that users are not returning.

**Decision it supports:** Whether email reminders or in-app nudges are the highest-priority next feature.

---

## 9 — CSV adoption

**Purpose:** Understand how often users are importing contacts vs. adding manually.

**How to build:**
- Insight type: Trend
- Series A: `contact_added` — total events (not unique), rolling 14 days
- Series B: `csv_import_used` — total events, rolling 14 days
- No breakdown
- Filter: pilot period start date

**What it tells you:** If `csv_import_used` fires for more than 30% of active users, CSV import is a meaningful onboarding path. If it never fires, either students don't have spreadsheets ready or can't find the import feature.

**Decision it supports:** Whether to surface the CSV import button earlier in onboarding.

---

## 10 — AI adoption

**Purpose:** Track usage of the two AI features among Pro-enabled users.

**How to build:**
- Insight type: Trend
- Series A: `ai_fill_used` — total events, rolling 7 days
- Series B: `ai_assistant_used` — total events, rolling 7 days
- Chart type: Line
- Filter: pilot period start date

**What it tells you:** Both features are gated to `ai_enabled = true` users (off by default). This insight is a placeholder — it becomes meaningful if Pro access is granted to any pilot users as a test.

**Decision it supports:** Whether AI features drive enough engagement to prioritize Layer D (Stripe billing) after the pilot.

---

## 11 — 7-day retention

**Purpose:** The core retention signal — do activated users return within 7 days and do something meaningful?

**How to build:**
- Insight type: Retention
- Cohort event: `activation_completed` (anchor to durable activation, not signup)
- Return event: `interaction_logged` (documented proxy for Core product activity; if PostHog Retention supports Actions, use the Core product activity Action instead)
- Retention window: 7 days
- Grouping: Weekly cohorts
- Filter: pilot period start date

**What it tells you:** The percentage of activated users who return to log at least one more interaction within 7 days. This is the core retention signal for a relationship-maintenance tool.

**Thresholds:**
- Meaningful: **30%+ Day-7 retention** — students are building a habit
- Warning: **below 25%** — the habit loop is not forming
- Do not interpret this number until at least 5 activated users have passed their 7-day window. With fewer than 5 eligible users, the percentage is noise.

**Note on unique-user counts:** PostHog Retention counts each identified person once in their cohort window. Cross-browser raw event duplicates (e.g., `email_confirmed` firing twice from different devices) do not inflate unique-user retention numbers for identified persons.

**Decision it supports:** The most important pilot signal. If Day-7 retention is strong (30%+), expand the pilot. If it is below 25%, run interviews before building any new features — the product is not yet creating a reason to return.

---

## 12 — Error monitoring

**Purpose:** Surface unhandled render crashes during the pilot.

**How to build:**
- Insight type: Trend
- Event: `$exception` (PostHog system event, fired by `posthog.captureException(error)` in `trackError()`)
- Aggregation: Total events, rolling 7 days
- Chart type: Bar
- Filter: pilot period start date

**About what `$exception` captures:** Funnl deliberately omits React's `componentStack` from the error call. PostHog may collect the error name, message, and stack as diagnostic exception data. This is disclosed in Funnl's privacy policy. `$exception` is a PostHog system event and is not included among Funnl's 17 custom product events.

**What it tells you:** Any bar above zero means at least one user hit an unhandled render crash (the ErrorBoundary). Even one crash during the pilot is worth investigating immediately — a student who hits the error screen is unlikely to return.

**Decision it supports:** Immediate: find the crash and fix it before the next session. If errors spike, cross-reference with session times in Live Events to identify which user was affected and follow up directly.

---

## Live Events — use this during sessions

PostHog left sidebar → Activity → Live Events.

During a pilot session, open Live Events on a separate device and watch events fire in real time:
- `email_confirmed` fires the moment they click the confirmation link
- `first_contact_added` fires when they add their first contact
- `interaction_logged` fires with the `interaction_type` property visible
- `followup_set` fires when they pick a follow-up date
- `activation_step_completed` fires for each milestone crossed
- `activation_completed` fires when all three milestones are done

This replaces the need to ask "did it work?" — you can see the activation signal in real time.

---

## Dashboard refresh cadence

| Cadence | What to check |
|---|---|
| During each session | Live Events |
| After each session | Signup funnel (1), Official activation funnel (3) |
| Weekly | WAU (7), 7-day retention (11), Follow-up loop (8) |
| After 5 sessions | All 12 insights; review activation milestone diagnostic (4) for biggest gap |
| After 10 sessions | Full pilot decision review against all thresholds |
