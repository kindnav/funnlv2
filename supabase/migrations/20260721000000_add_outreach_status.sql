-- Add outreach_status field to interactions.
-- Tracks whether a contact responded to a message, call, or email.
-- Nullable text — not a Postgres enum so values can evolve without a migration.
-- Valid values: awaiting_response | responded | meeting_booked | no_response | declined
--
-- DO NOT apply this migration to production without explicit approval from Naveen.
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS outreach_status text;
