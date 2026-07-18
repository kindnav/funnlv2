# PostHog Pilot Dashboard — Setup Instructions

Manual instructions for building 10 insights during the pilot. Each insight specifies where to click, which events to use, and what decision it supports. Build them in PostHog before the first pilot session so you can observe in real time.

All insights live in PostHog → Insights. Create a Dashboard named "Funnl Pilot" and pin each insight to it.

---

## 1 — Acquisition funnel

**Purpose:** Measure how many visitors who start signing up complete email confirmation.

**How to build:**
- Insight type: Funnel
- Steps (in order):
  1. `signup_started` — User arrived at the signup form
  2. `user_signed_up` — Signup request succeeded, confirmation email sent
  3. `email_confirmed` — User clicked the confirmation link (fires on WelcomePage)
- Unique users: Yes (each user counted once per step)
- Time window: Rolling 30 days
- Breakdown: None for the pilot cohort; add "browser" later if drop-off is unexpectedly high

**What it tells you:** Drop-off between steps 1–2 indicates signup form friction. Drop-off between steps 2–3 indicates email delivery or spam problems. Both are pre-activation blockers.

**Decision it supports:** Before inviting more users, confirm step 2→3 conversion is above 75%. If it falls below 50%, the email deliverability problem is not resolved.

---

## 2 — Confirmation conversion rate

**Purpose:** Track the specific rate at which signup-confirmed users reach the welcome page successfully.

**How to build:**
- Insight type: Trend
- Series A: `user_signed_up` — unique users, rolling 7 days
- Series B: `email_confirmed` — unique users, rolling 7 days
- Chart type: Line (to watch the ratio over time as pilot progresses)
- No breakdown

**What it tells you:** If Series B / Series A drops below 0.7, confirmation emails are landing in spam more than the Gmail test suggested, or users are giving up before clicking.

**Decision it supports:** Determines whether to expand the pilot or fix deliverability first.

---

## 3 — Activation funnel

**Purpose:** Measure how many confirmed users complete the full core loop.

**How to build:**
- Insight type: Funnel
- Steps (in order):
  1. `email_confirmed`
  2. `first_contact_added` (this event fires only once per user, when their contact count reaches 1)
  3. `interaction_logged`
  4. `followup_set`
- Unique users: Yes
- Time window: 7 days from first step (activation that does not happen in session 1 rarely happens)
- Breakdown: None

**What it tells you:** The biggest drop-off point identifies the hardest onboarding step. If most drop between `first_contact_added` and `interaction_logged`, the hand-off from contact detail to the interaction form is unclear. If most drop between `interaction_logged` and `followup_set`, the follow-up date field is not discoverable.

**Decision it supports:** Where to focus the next UX improvement. If step 3→4 conversion is below 60%, add a visible prompt to set a follow-up date after logging the first interaction.

---

## 4 — Time to activation

**Purpose:** Understand how long it takes from confirmation to full activation.

**How to build:**
- Insight type: Funnel
- Same 4 steps as Insight 3
- Enable "Conversion time" view (toggle in funnel settings)
- Chart type: Time to convert histogram

**What it tells you:** If median time-to-activation is under 15 minutes, students complete the core loop in a single session. If it exceeds 30 minutes, the loop is too long or too complex for a first visit.

**Decision it supports:** If median time is high, shorten the activation definition or add in-app prompts that guide users faster.

---

## 5 — Weekly active users (WAU)

**Purpose:** Track how many distinct users are using the product each week.

**How to build:**
- Insight type: Trend
- Event: All events (PostHog built-in `$pageview` works here, or use `interaction_logged` as a proxy for active sessions)
- Unique users: Yes
- Aggregation: Weekly
- Chart type: Bar

**What it tells you:** WAU is the baseline retention signal. If WAU is flat or growing after week 2 of the pilot, students are returning. If it collapses after week 1, the product is not forming a habit.

**Decision it supports:** The go/no-go signal for expanding beyond the pilot cohort.

---

## 6 — Follow-up loop

**Purpose:** Measure how often users are completing the full follow-up cycle (log → follow-up date → mark done or log result).

**How to build:**
- Insight type: Trend
- Series A: `followup_set` — total events, rolling 7 days
- Series B: `followup_completed` — total events, rolling 7 days
- Filter on `followup_completed`: no filter needed (method property is for debugging; either 'mark_done' or 'log_result' counts)
- Chart type: Bar

**What it tells you:** If Series B / Series A is below 0.3, users are setting follow-up dates but not closing the loop. This could mean: follow-up dates are in the future (expected), or users are forgetting to come back and mark them done.

**Decision it supports:** Whether to prioritize email reminders or in-app nudges as the next feature after the pilot.

---

## 7 — CSV adoption

**Purpose:** Understand how often users are importing existing contacts vs. adding manually.

**How to build:**
- Insight type: Trend
- Series A: `contact_added` — total events (not unique), rolling 14 days
- Series B: `csv_import_used` — total events, rolling 14 days
- No breakdown

**What it tells you:** If Series B fires for more than 30% of users, CSV import is a meaningful onboarding path. If it never fires, either students don't have existing contact spreadsheets, or they can't find the import feature.

**Decision it supports:** Whether to make CSV import more prominent (e.g., surface it earlier in onboarding) or whether manual add is sufficient for the pilot cohort.

---

## 8 — AI adoption

**Purpose:** Track usage of the two AI features among Pro-enabled users.

**How to build:**
- Insight type: Trend
- Series A: `ai_fill_used` — total events, rolling 7 days
- Series B: `ai_assistant_used` — total events, rolling 7 days
- Chart type: Line

**What it tells you:** Both features are currently limited to `ai_enabled = true` users (manually granted). During the pilot, AI access is off by default. This insight is a placeholder — it becomes meaningful when Pro access is granted to pilot users as a test.

**Decision it supports:** Whether AI features drive enough engagement to prioritize Layer D (Stripe billing) after the pilot.

---

## 9 — 7-day retention

**Purpose:** The core retention signal — do activated users return within 7 days?

**How to build:**
- Insight type: Retention
- Cohort event: `email_confirmed` (or `first_contact_added` if you prefer activation-moment anchoring)
- Return event: `interaction_logged` (this is the strongest signal — they came back and used the product's core value, not just opened the app)
- Time window: 7 days
- Grouping: Weekly cohorts

**What it tells you:** The percentage of users who return to log a second interaction within 7 days. This is the core retention signal for a relationship-maintenance tool — if students are actually maintaining relationships, they should be logging conversations regularly.

**Target:** 40%+ Day-7 retention on `interaction_logged`. If below 25%, the habit loop is not forming.

**Decision it supports:** The single most important signal for whether the product works. If 7-day retention on interaction_logged is strong, expand the pilot. If it is weak, run interviews before building any new features.

---

## 10 — Error monitoring

**Purpose:** Surface unhandled render crashes during the pilot.

**How to build:**
- Insight type: Trend
- Event: `$exception` (PostHog system event, fired automatically by `trackError()` in the ErrorBoundary)
- Total events, rolling 7 days
- Breakdown: None (the exception message is not surfaced in properties by design — `componentStack` is excluded)
- Chart type: Bar

**What it tells you:** Any bar above zero means a user hit an unhandled render crash. Even one crash during the pilot is worth investigating immediately — a student who hits the ErrorBoundary is unlikely to return.

**Decision it supports:** Immediate: find and fix the crash before the next session. If errors spike, cross-reference with session times in Live Events to identify which user was affected and reach out.

---

## Live Events — use this during sessions

PostHog left sidebar → Activity → Live Events.

During a pilot session, open Live Events and watch events fire in real time as the user interacts with the product. You will see:
- `email_confirmed` the moment they click the link
- `first_contact_added` when they add their first contact
- `interaction_logged` with the interaction_type property
- `followup_set` when they pick a follow-up date

This replaces the need to ask "did it work?" — you can see the events fire and know the core loop completed.

---

## Dashboard refresh cadence

| Cadence | What to check |
|---|---|
| During each session | Live Events |
| After each session | Acquisition funnel, Activation funnel |
| Weekly | WAU, 7-day retention, Follow-up loop |
| After 10 sessions | All 10 insights, full pilot decision review |
