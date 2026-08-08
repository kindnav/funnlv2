-- Target firms list for Target Firm Coverage.
--
-- Adds a text[] column to profiles that persists the set of company names
-- a user is actively recruiting for. Used by the Dashboard Target Firm Coverage
-- card and the Settings Target Firms editor.
--
-- target_firms  — array of display-normalized firm name strings.
--                 Default is an empty array so existing rows are unaffected.
--                 PostgreSQL text[] handles arbitrary Unicode firm names.
--
-- Constraint profiles_target_firms_max_count — hard limit of 20 firms per user,
--   enforced in the database so the application-level limit (FIRM_LIST_MAX_COUNT)
--   and the database constraint always agree.
--
-- No backfill is needed — existing rows get the column with value '{}'.
-- No RLS changes are needed — the existing UPDATE policy already guards this column.
-- No trigger changes are needed — handle_new_user inserts with DEFAULT which
--   resolves to '{}' for the new column.
--
-- DO NOT apply to remote production without explicit approval from Naveen.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS target_firms text[] NOT NULL DEFAULT '{}';

-- Named constraint so the file is safely re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_target_firms_max_count'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_target_firms_max_count
      CHECK (cardinality(target_firms) <= 20);
  END IF;
END $$;
