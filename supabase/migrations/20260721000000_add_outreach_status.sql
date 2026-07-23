-- Add outreach_status field to interactions.
-- Tracks whether a contact responded to a message, call, or email.
-- Nullable text — not a Postgres enum so values can evolve without a migration.
-- Valid values: awaiting_response | responded | meeting_booked | no_response | declined
--
-- DO NOT apply this migration to production without explicit approval from Naveen.

ALTER TABLE public.interactions
  ADD COLUMN IF NOT EXISTS outreach_status text;

-- Named constraint added in a guarded DO block so re-running this file is safe
-- (e.g., if the column already existed from a manual ALTER on the same schema).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'interactions_outreach_status_check'
      AND conrelid = 'public.interactions'::regclass
  ) THEN
    ALTER TABLE public.interactions
      ADD CONSTRAINT interactions_outreach_status_check
      CHECK (outreach_status IN (
        'awaiting_response',
        'responded',
        'meeting_booked',
        'no_response',
        'declined'
      ));
  END IF;
END $$;
