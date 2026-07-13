-- Add nullable activation milestone timestamps to profiles.
--
-- null means the milestone has not been reached.
-- Timestamps are written by the app via conditional update (WHERE col IS NULL)
-- so each milestone records exactly once across concurrent tabs and browsers.
--
-- RLS: no changes needed.
-- - SELECT policy (auth.uid() = id) already allows reading these columns.
-- - UPDATE policy WITH CHECK only constrains ai_enabled; these columns are freely
--   writable by users on their own row, which is what the app requires.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS activation_five_contacts_at     timestamptz,
  ADD COLUMN IF NOT EXISTS activation_first_interaction_at  timestamptz,
  ADD COLUMN IF NOT EXISTS activation_first_followup_at    timestamptz,
  ADD COLUMN IF NOT EXISTS activation_completed_at         timestamptz;

-- ── Backfill existing users ───────────────────────────────────────────────────
--
-- Without backfill, existing activated users would have null columns on their
-- next dashboard visit. The app's recordMilestones function would then attempt
-- conditional updates and fire false activation_step_completed PostHog events.
-- Populated timestamps prevent that: recordMilestones checks the column value
-- first and skips the update (and the event) when it is already non-null.
--
-- PostHog events are not sent from SQL; the backfill is safe.

-- Milestone 1: timestamp of the user's 5th contact (chronologically)
UPDATE public.profiles p
SET activation_five_contacts_at = (
  SELECT created_at
  FROM public.contacts
  WHERE user_id = p.id
  ORDER BY created_at ASC
  LIMIT 1 OFFSET 4          -- 0-indexed: OFFSET 4 = 5th row
)
WHERE p.activation_five_contacts_at IS NULL
  AND (
    SELECT COUNT(*) FROM public.contacts WHERE user_id = p.id
  ) >= 5;

-- Milestone 2: earliest interaction created_at
UPDATE public.profiles p
SET activation_first_interaction_at = (
  SELECT MIN(created_at)
  FROM public.interactions
  WHERE user_id = p.id
)
WHERE p.activation_first_interaction_at IS NULL
  AND EXISTS (
    SELECT 1 FROM public.interactions WHERE user_id = p.id
  );

-- Milestone 3: earliest created_at among interactions that have a follow_up_date
UPDATE public.profiles p
SET activation_first_followup_at = (
  SELECT MIN(created_at)
  FROM public.interactions
  WHERE user_id = p.id
    AND follow_up_date IS NOT NULL
)
WHERE p.activation_first_followup_at IS NULL
  AND EXISTS (
    SELECT 1 FROM public.interactions
    WHERE user_id = p.id AND follow_up_date IS NOT NULL
  );

-- Milestone 4: activation_completed_at = latest of the three step timestamps,
-- set only when all three are present (all steps were completed)
UPDATE public.profiles
SET activation_completed_at = GREATEST(
  activation_five_contacts_at,
  activation_first_interaction_at,
  activation_first_followup_at
)
WHERE activation_completed_at IS NULL
  AND activation_five_contacts_at     IS NOT NULL
  AND activation_first_interaction_at IS NOT NULL
  AND activation_first_followup_at    IS NOT NULL;
