-- Adds an optional School to each contact (e.g. "Indiana University"), so a student can find
-- every contact from one school. Nullable, no default, no backfill: existing contacts are
-- untouched and simply have no school until the user adds one.
--
-- Matches the neighbouring free-text columns (company, role, how_met): plain text, no length
-- CHECK. Access is unchanged - contacts' row-level security policies and table grants apply to
-- the new column automatically.
--
-- ORDER: this must be applied BEFORE the website that writes `school` is published, and before
-- ai-chat is deployed (it selects the column). Rollback: leave the column in place; dropping it
-- would destroy what users entered.

ALTER TABLE public.contacts ADD COLUMN school text;

COMMENT ON COLUMN public.contacts.school IS 'Optional school, college or university the contact attends or attended.';
