-- Follow-up completion metadata.
--
-- Adds three nullable columns to interactions that persist the completion
-- record for recently-completed follow-ups and support Undo.
--
-- follow_up_previous_date  — the date that was cleared when Done was tapped;
--                            restored verbatim by Undo.
-- follow_up_completed_at   — UTC timestamp when the follow-up was marked done;
--                            used to bucket rows into the Recently Completed group
--                            (within 7 local calendar days) and to sort them.
-- follow_up_completion_method — which action completed the follow-up:
--                               'mark_done' (Done button) or
--                               'log_result' (Log Result flow in ContactDetail).
--
-- Invariants:
--   * All three columns are null for open follow-ups.
--   * All three are populated together on completion.
--   * Undo clears all three and restores follow_up_date.
--   * Any action that sets a new active follow_up_date must clear all three.
--
-- Existing RLS on the interactions table continues to protect these columns.
-- No row-level security changes are required.
-- Existing rows remain valid with null values; no backfill is needed.
--
-- DO NOT apply to remote production without explicit approval from Naveen.

ALTER TABLE public.interactions
  ADD COLUMN IF NOT EXISTS follow_up_completed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS follow_up_previous_date  date,
  ADD COLUMN IF NOT EXISTS follow_up_completion_method text;

-- Named constraint so the file is safely re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'interactions_follow_up_completion_method_check'
      AND conrelid = 'public.interactions'::regclass
  ) THEN
    ALTER TABLE public.interactions
      ADD CONSTRAINT interactions_follow_up_completion_method_check
      CHECK (follow_up_completion_method IN ('mark_done', 'log_result'));
  END IF;
END $$;
