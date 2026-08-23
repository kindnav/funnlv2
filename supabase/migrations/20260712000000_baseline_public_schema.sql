-- Baseline: custom public schema as it existed IMMEDIATELY BEFORE the first tracked
-- migration (20260713075431_add_activation_milestones).
--
-- WHY THIS EXISTS
--   profiles, contacts, interactions, handle_new_user(), and the on_auth_user_created
--   trigger were created MANUALLY in the Supabase dashboard before the migration system
--   existed, so no migration file ever created them. Every later migration only ALTERs
--   or references these objects. Without this baseline, a from-migrations rebuild (a
--   Supabase Preview Branch or `supabase db reset`) fails at the first ALTER of a table
--   that was never created. This file makes the migration history replayable from an
--   empty project.
--
-- HOW IT WAS RECONSTRUCTED
--   From a read-only, schema-only inspection of the production catalog (no row data),
--   defined as: current production public schema MINUS every object/column/constraint
--   introduced by the tracked migrations 20260713075431 … 20260816000000. It therefore
--   contains ONLY the original manual objects and their original constraints/RLS/
--   policies/grants. Columns and constraints added later are intentionally absent so the
--   later migrations add them without collision.
--
-- ⚠️ PRODUCTION LEDGER TREATMENT (do NOT execute this file against production)
--   These objects ALREADY EXIST in production. This file must NEVER be run there.
--   After merge, its version is recorded in the ledger via a separately-authorized
--   `supabase migration repair --status applied 20260712000000` — SQL is not executed.
--   This file only ever runs on fresh/preview/local databases.
--
-- Fidelity notes:
--   - No IF NOT EXISTS: on a fresh project this must fail loudly, never mask drift.
--   - Grants reproduce the observed Supabase default-privilege pattern (ALL to
--     anon/authenticated/service_role); security is enforced by RLS, not by withholding
--     grants. This differs from the newer hardened migrations by design — it mirrors how
--     these tables were actually created.
--   - handle_new_user() here is the PRE-pro_trials body (profiles insert only). Migration
--     20260727000000 later CREATE OR REPLACEs it to also seed pro_trials; that replace
--     preserves the EXECUTE ACL left by 20260713185900, so the final function + grants
--     match production exactly.
--   - The on_auth_user_created trigger is NOT recreated by any later migration, so the
--     definition below is the exact production trigger.


-- ── 1. profiles ───────────────────────────────────────────────────────────────

CREATE TABLE public.profiles (
  id           uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  updated_at   timestamptz DEFAULT now(),
  ai_enabled   boolean     NOT NULL DEFAULT false,
  email        text
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.profiles TO anon, authenticated, service_role;

CREATE POLICY "profiles_select"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "profiles_insert"
  ON public.profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

CREATE POLICY "profiles_update"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (
    (auth.uid() = id)
    AND (ai_enabled = (SELECT p.ai_enabled FROM public.profiles p WHERE p.id = auth.uid()))
  );

CREATE POLICY "profiles_delete"
  ON public.profiles FOR DELETE
  USING (auth.uid() = id);


-- ── 2. contacts ───────────────────────────────────────────────────────────────

CREATE TABLE public.contacts (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  name              text        NOT NULL,
  company           text,
  role              text,
  how_met           text,
  email             text,
  linkedin_url      text,
  tags              text[],
  relationship_type text,
  relationship_note text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.contacts TO anon, authenticated, service_role;

CREATE POLICY "Users can view their own contacts"
  ON public.contacts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own contacts"
  ON public.contacts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own contacts"
  ON public.contacts FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own contacts"
  ON public.contacts FOR DELETE
  USING (auth.uid() = user_id);


-- ── 3. interactions ───────────────────────────────────────────────────────────
-- NOTE: interactions.type is NULLABLE with NO CHECK constraint — the 6-value enum
-- (Coffee chat / Email / Event / Call / Message / Other) is enforced in the app only.
-- This matches production exactly; do not add a CHECK here.

CREATE TABLE public.interactions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id       uuid        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  type             text,
  interaction_date date        NOT NULL,
  notes            text,
  follow_up_date   date,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.interactions ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.interactions TO anon, authenticated, service_role;

CREATE POLICY "Users can view their own interactions"
  ON public.interactions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own interactions"
  ON public.interactions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own interactions"
  ON public.interactions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own interactions"
  ON public.interactions FOR DELETE
  USING (auth.uid() = user_id);


-- ── 4. handle_new_user() + on_auth_user_created (baseline, pre-pro_trials) ─────
-- SECURITY DEFINER, empty search_path, fully-qualified. Body inserts ONLY the profile
-- row (pro_trials does not exist until 20260727000000). Function creation grants EXECUTE
-- to PUBLIC by default plus Supabase default privileges to anon/authenticated/
-- service_role; migration 20260713185900 later revokes PUBLIC/anon/authenticated,
-- leaving postgres + service_role — matching production.

CREATE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, ai_enabled, display_name, updated_at)
  VALUES (new.id, new.email, false, null, now())
  ON CONFLICT (id) DO NOTHING;
  RETURN new;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
