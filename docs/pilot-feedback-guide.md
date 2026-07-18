# Pilot Feedback Guide

How to run a pilot session and collect useful signal. Read before the first session.

---

## The most important rule

Do not fix bugs, explain features, or build feature requests during a session. Your job in a pilot session is to watch and listen, not to teach or sell. The moment you step in and help, you stop learning whether the product works on its own.

The second most important rule: write up observations the same day. Memory of a session decays fast.

---

## Before the session

- [ ] Have the product open on the user's device, not yours
- [ ] Open PostHog → Activity → Live Events on a separate device or window
- [ ] Have this guide open for reference
- [ ] Tell the user: "I'm not going to help you — I want to watch how you use it naturally. There are no wrong answers. If something doesn't make sense, that's useful feedback."

---

## 5-minute observation checklist

Track these during the session by making a quick note each time you observe one:

**Hesitation moments** — user pauses, looks around the screen, or moves the cursor without clicking. Note which element or page they were on.

**Unexpected clicks** — user clicks something that does not do what they expected, or clicks an area that is not interactive. Note what they clicked and what they expected.

**Tab changes / back navigation** — user leaves a page mid-task. Note what they were trying to do when they left.

**Questions asked** — write down the exact words. "How do I...?" and "Where is...?" questions point directly to missing affordances or confusing labels.

**Moments of delight** — anything where the user says "oh that's nice" or pauses to read something with interest. Note what triggered it.

**Task completion** — mark each of the 4 core tasks (from the pilot plan) as completed or not. Note at which step they got stuck, if any.

---

## Non-leading questions (ask during, if needed)

These questions are designed to surface behavior without suggesting what you think they should do.

- "What were you trying to do there?"
- "What did you expect to happen when you clicked that?"
- "What were you looking for on this screen?"
- "What does this label / button mean to you?"
- "Is this what you expected to see?"

**Do not ask:** "Did you notice the [feature]?" or "What do you think of the [feature]?" — these lead the user toward your assumptions.

---

## Post-session questions

Ask these after the 4 core tasks are done. Take notes; do not summarize or paraphrase what the user says.

**Value questions:**
- Before today, how were you keeping track of the people you were networking with?
- After using this for the last 20 minutes, what felt most useful?
- Is there a moment in the past month where having this would have helped you?

**Friction questions:**
- Was there anything that confused you or didn't work the way you expected?
- Was there a moment where you weren't sure what to do next?
- Is there anything you expected to find that wasn't there?

**Return-intent questions:**
- If you had access to this for the next 3 months of recruiting, would you actually use it?
- What would make you open this after your next coffee chat?
- What would make you recommend this to a friend who's also recruiting?

**Open-ended close:**
- Anything else?

---

## Severity system

Rate every piece of feedback before logging it. This prevents minor UX preferences from crowding out real problems.

| Severity | Label | Definition | Action |
|---|---|---|---|
| P0 | **Blocker** | User cannot complete a core task. Product is unusable for that task. | Fix before the next session. |
| P1 | **Major** | User completes the task but with significant friction — confusion, wrong path, or visible frustration. | Fix before wider sharing. |
| P2 | **Minor** | Friction or confusion that does not stop task completion. Cosmetic or copy issue. | Add to backlog. |
| P3 | **Feature request** | User asks for something the product does not do. | Log with a frequency counter. |

**Examples:**
- User cannot find the "Log interaction" form — P0 (task blocked)
- User saves a contact without any tags because they didn't notice the tag field — P1 (friction on a key feature)
- User notices a typo in a label — P2
- User asks "can I set recurring reminders?" — P3 (log it, do not build it yet)

---

## The feature request rule

After every session, you will have a list of things users said they wanted. Do not build any of them until this test passes:

**Would at least 3 different users ask for this feature independently, without prompting from you?**

One user asking for calendar sync is noise. Three users independently asking for it is signal. Apply this rule before adding anything to the roadmap. Until you have 5+ sessions, every feature request is noise — you do not have enough sample size to distinguish a pattern from a coincidence.

Log every request with a count. After 10 sessions, sort by count and review.

---

## After the session

**Immediately:**
1. Write 3–5 bullet points of raw observations while they are fresh.
2. Triage every friction point with a severity rating.
3. Note the single most important thing you learned.

**Filing format (keep a running log):**

```
Session [N] — [date]
User: [descriptor, not name — e.g. "finance junior, had 8 networking chats this month"]

Task completion: [which of the 4 tasks completed / not]

Hesitations: [list with screen/element context]
Unexpected clicks: [list]
Questions asked: [verbatim]

Friction (P0/P1/P2/P3): [list with ratings]
Feature requests: [list]

Most important learning: [one sentence]
```

Do not use this log for analytics — PostHog handles quantitative tracking. This log is for qualitative patterns you cannot capture with events.
