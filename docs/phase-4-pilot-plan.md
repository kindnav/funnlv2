# Funnl Pilot Plan — Phase 4

A 10–20 student controlled pilot before any wider sharing. Read this before inviting anyone.

---

## Objective

Determine whether Funnl creates enough value for actively-recruiting students to return after their first session. The pilot is not a growth exercise — it is a learning exercise. Success means answering three questions:

1. Do students complete the core loop (add contact → log interaction → set follow-up) without help?
2. Do they come back within 7 days without being prompted?
3. What is the single most common point of confusion or friction?

---

## Target group

**Who to invite:** 10–20 students who are actively recruiting right now for internships or full-time roles in finance, consulting, VC, PE, or competitive tech. They must have had at least 3 real networking conversations in the past 30 days. This is the user for whom the pain of losing track is concrete and immediate.

**Who to exclude:** Students who are not actively recruiting, students in academic programs with no networking component, students who only use LinkedIn DMs and have no in-person conversations to track.

**Where to find them:** Finance/consulting/VC clubs, your own college network, career fairs, personal warm intros. Aim for diversity across school type and target industry.

**How to approach:** Personal message, not a mass email. Explain what the product does in one sentence and ask if they have 20 minutes to try it and give honest feedback.

---

## Core tasks for pilot users

Give each pilot user these tasks in their first session, in order. Do not explain how to do them — observe whether they can figure it out.

1. Add the 3 most recent people you've networked with (name, company, how you met, at least one tag).
2. Log the conversation you had with one of them (type, date, a few notes).
3. Set a follow-up date for that same person.
4. Visit the Dashboard and the Follow-ups screen.

If they reach task 4 without help, the core activation loop works. Note every place they hesitated, clicked the wrong thing, or asked a question.

---

## Primary funnel

```
Visited /signup
    ↓
user_signed_up (signup request succeeded, confirmation email sent)
    ↓
email_confirmed (clicked the link, Supabase confirmed the session)
    ↓
first_contact_added (logged their first contact)
    ↓
interaction_logged (logged their first conversation)
    ↓
followup_set (set their first follow-up date)
    ↓
[Return visit within 7 days]
```

Each step is a PostHog funnel stage. Measure the drop-off at each step.

---

## Activation definition

**A user is activated when all three of the following are true (tracked in profiles table):**

- Added 5 or more contacts (`activation_five_contacts_at` is non-null)
- Logged at least 1 interaction (`activation_first_interaction_at` is non-null)
- Set at least 1 follow-up date (`activation_first_followup_at` is non-null)

**Activation_completed_at** is the timestamp of the final milestone. A user who finishes the first session with all three steps done counts as activated in that session.

**Target for pilot:** 70%+ of users who finish session 1 reach activation. If the rate is below 50%, there is an onboarding problem to fix before wider sharing.

---

## Retention definition

**Day 7 retention:** Did the user open the app at least once in the 7 days following their signup date?

In PostHog: use the Retention insight with cohort event = `user_signed_up` (or `email_confirmed`), return event = any pageview, 7-day window.

**Target for pilot:** at least 50% of activated users return within 7 days without a direct prompt from you. If fewer than 3 of 10 activated users return on their own, the product is not yet creating a habit loop.

**Minimum signal for decision:** You need at least 5 activated users with a 7-day observation window before this number means anything. Do not read retention from users who signed up fewer than 7 days ago.

---

## Feedback and bug process

**During the session:**
- Use the observation checklist in `docs/pilot-feedback-guide.md`.
- Do not fix bugs live. Note them and keep the session moving.
- Ask questions from the non-leading question list in the feedback guide.

**After the session:**
- File any bugs in a running list with the severity rating from the feedback guide.
- Do not build every feature request. Apply the "would 3+ users independently ask for this without prompting?" rule before putting anything on the roadmap.

**Bug triage cycle:**
- Blockers (P0): fix immediately, before the next session
- Major (P1): fix before wider sharing
- Minor (P2): add to backlog
- Feature requests: record with frequency count, revisit after 10+ sessions

---

## Interview questions

Ask these after the session, not during. The goal is to understand motivation and habit, not to collect feature requests.

**Value questions:**
- Walk me through what you were doing before to keep track of the people you were networking with.
- When you finished the session today, what felt most useful?
- Is there a moment in the last 30 days where you wish you had had this?

**Friction questions:**
- Was there anything that confused you or didn't work the way you expected?
- Was there a point where you weren't sure what to do next?
- Is there anything you expected to see that wasn't there?

**Return-intent questions:**
- If I gave you access to this for free for the next month, would you actually use it during recruiting season?
- What would need to be true for you to open this every time you come back from a networking conversation?
- What would make you recommend this to a friend who's also recruiting?

**Open-ended close:**
- Anything else on your mind?

---

## Founder checklist

Before the first pilot session:

- [ ] Confirm the app builds cleanly (`npm run build` passes)
- [ ] Confirm email confirmation works end-to-end (test with a real email address)
- [ ] Confirm iCloud / Outlook delivery issue is resolved or has a documented workaround
- [ ] Set `ai_enabled = false` for all pilot users (default is already false)
- [ ] Have the feedback guide open during the session
- [ ] Have PostHog open to Live Events view so you can watch events fire in real time

After each session:

- [ ] Record observations in the feedback log before sleeping (memory decays fast)
- [ ] Triage any bugs using the severity system
- [ ] Update the funnel numbers in PostHog
- [ ] Send a 2-line thank-you note to the pilot user

After 5 sessions:

- [ ] Review the funnel: where is the biggest drop-off?
- [ ] Review friction themes: what are the top 3 recurring confusion points?
- [ ] Decide: fix and continue, or pause to rebuild a specific flow?

---

## Decision rules

**Continue inviting users when:**
- Activation rate is above 60%
- No Blocker-severity bugs are outstanding
- Email confirmation is working in Gmail and the relevant email provider for your cohort

**Pause and fix when:**
- More than 2 users in a row fail the same task without help
- A Blocker bug is reported
- Email confirmation is broken

**Consider a pivot when (after 10+ sessions):**
- Fewer than 3 of 10 activated users return in 7 days without prompting
- The value question produces the same answer as "I'd just use a spreadsheet"
- No user independently mentions the Follow-ups screen as useful

**Do not interpret individual sessions as signal.** One user who struggles with tag entry is noise. Three users who all struggle with the same step are a pattern. Wait for 5+ sessions before changing any flow.
