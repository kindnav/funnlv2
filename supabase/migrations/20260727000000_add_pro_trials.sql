-- 7-day Funnl Pro trial for new users.
--
-- Design constraints:
--   - ai_enabled is NEVER set to true for trial users. Trial access is tracked
--     entirely in this new pro_trials table, separate from profiles.
--   - Permanent Pro access (ai_enabled = true, set manually in Supabase) is
--     preserved and takes precedence. Trial expiry has no effect on ai_enabled.
--   - Only applies to accounts created AFTER this migration runs.
--     Existing users are NOT backfilled (started_at stays NULL for any
--     pre-existing pro_trials rows that might be created retroactively).
--     Do not backfill without explicit approval.
--   - Trial starts only when email is confirmed (enforced inside start_my_pro_trial()).
--   - Trial can only be started once per user (WHERE started_at IS NULL guard).
--   - All writes go through SECURITY DEFINER functions. No INSERT/UPDATE/DELETE
--     for the authenticated role.
--
-- Apply using Supabase CLI (not the SQL Editor):
--   supabase migration list --linked          -- confirm this migration is pending
--   supabase db push --linked --dry-run       -- preview
--   supabase db push --linked                 -- apply
--
-- Post-application verification:
--   1. SELECT * FROM public.pro_trials LIMIT 5;  -- table exists
--   2. Confirm RLS is enabled: SELECT relrowsecurity FROM pg_class WHERE relname = 'pro_trials';
--   3. SELECT proname, prosrc FROM pg_proc WHERE proname = 'start_my_pro_trial';  -- function exists
--   4. Sign up a new test user → confirm profiles row created AND pro_trials row created
--      with started_at IS NULL
--   5. Confirm email → WelcomePage calls start_my_pro_trial() → verify started_at is set
--      and ends_at = started_at + 7 days

-- ── 1. Create pro_trials table ────────────────────────────────────────────────

CREATE TABLE public.pro_trials (
  user_id    uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at timestamptz,
  ends_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Structural constraint: started_at and ends_at must both be set or both be null
  CONSTRAINT pro_trials_dates_consistent
    CHECK (
      (started_at IS NULL AND ends_at IS NULL) OR
      (started_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > started_at)
    )
);

ALTER TABLE public.pro_trials ENABLE ROW LEVEL SECURITY;

-- Users can read their own trial row (needed by canUseAI() and getTrialStatus() in the frontend)
CREATE POLICY "Users can read own trial"
  ON public.pro_trials
  FOR SELECT
  USING (auth.uid() = user_id);

-- No INSERT / UPDATE / DELETE policy for authenticated — all writes via SECURITY DEFINER functions.
-- This prevents users from self-granting or extending their trial.

-- Grant SELECT to authenticated (service-role already bypasses RLS; anon does not need access)
GRANT SELECT ON public.pro_trials TO authenticated;

-- ── 2. Update handle_new_user to also create a trial eligibility row ──────────
--
-- On every new signup, create both a profiles row and a pro_trials row.
-- The pro_trials row starts with started_at = NULL (not yet active).
-- The trial only activates when the user confirms their email and
-- start_my_pro_trial() is called from WelcomePage.jsx.
--
-- Note on ACL: CREATE OR REPLACE FUNCTION preserves the existing proacl.
-- The REVOKE below was already applied by 20260713185900_harden_handle_new_user.sql.
-- Re-applying it here is defense in depth — it is idempotent.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Create profile row (idempotent)
  INSERT INTO public.profiles (id, email, ai_enabled)
  VALUES (new.id, new.email, false)
  ON CONFLICT (id) DO NOTHING;

  -- Create trial eligibility row (not yet active — started_at / ends_at both NULL)
  INSERT INTO public.pro_trials (user_id, started_at, ends_at)
  VALUES (new.id, NULL, NULL)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN new;
END;
$$;

-- Re-harden after OR REPLACE (defense in depth)
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- ── 3. Create start_my_pro_trial() SECURITY DEFINER RPC ──────────────────────
--
-- Called from WelcomePage.jsx immediately after email confirmation is verified.
-- Guards:
--   a) Caller must be authenticated (auth.uid() NOT NULL)
--   b) Caller's email must be confirmed (email_confirmed_at IS NOT NULL in auth.users)
--   c) Trial must not have been started already (WHERE started_at IS NULL)
--
-- Returns a JSON object:
--   started_now  boolean     -- true only on the call that actually started the trial
--   started_at   timestamptz -- the moment the trial started (null if no trial row)
--   ends_at      timestamptz -- when the trial expires (null if no trial row)
--   server_now   timestamptz -- server clock at call time (client sync reference)

CREATE OR REPLACE FUNCTION public.start_my_pro_trial()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id     uuid;
  v_confirmed   timestamptz;
  v_now         timestamptz;
  v_started_at  timestamptz;
  v_ends_at     timestamptz;
  v_started_now boolean;
  v_rows        int;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- Require confirmed email before activating trial
  SELECT email_confirmed_at INTO v_confirmed
  FROM auth.users
  WHERE id = v_user_id;

  IF v_confirmed IS NULL THEN
    RAISE EXCEPTION 'email_not_confirmed';
  END IF;

  v_now := now();

  -- Atomic conditional start: only updates when trial row exists with started_at IS NULL.
  -- If started_at is already set (trial was started before), this UPDATE touches 0 rows.
  UPDATE public.pro_trials
  SET started_at = v_now,
      ends_at    = v_now + INTERVAL '7 days'
  WHERE user_id    = v_user_id
    AND started_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_started_now := (v_rows > 0);

  -- Read current state (whether just started or already started)
  SELECT started_at, ends_at INTO v_started_at, v_ends_at
  FROM public.pro_trials
  WHERE user_id = v_user_id;

  RETURN jsonb_build_object(
    'started_now', v_started_now,
    'started_at',  v_started_at,
    'ends_at',     v_ends_at,
    'server_now',  v_now
  );
END;
$$;

-- Grant EXECUTE to authenticated only (anon users cannot confirm email)
GRANT EXECUTE ON FUNCTION public.start_my_pro_trial() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.start_my_pro_trial() FROM PUBLIC, anon;
