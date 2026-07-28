-- 7-day Funnl Pro trial for new users.
--
-- DESIGN CONSTRAINTS (permanent — do not change without explicit approval):
--   - ai_enabled is NEVER set to true for trial users. Trial access lives
--     entirely in pro_trials, separate from profiles.
--   - Permanent Pro (ai_enabled=true, set manually) takes precedence over trial
--     in all entitlement decisions. Trial expiry has no effect on ai_enabled.
--   - Only applies to accounts created AFTER this migration runs.
--     Existing users are NOT backfilled. Do not backfill without explicit approval.
--   - Trial activation is server-side and durable:
--       a) handle_new_user() starts the trial immediately for auto-confirmed accounts.
--       b) on_email_confirmed trigger starts the trial on the email_confirmed_at
--          transition for normal confirmation flow.
--       c) start_my_pro_trial() is an idempotent RECOVERY mechanism only.
--   - Trial activation is atomic: repeated confirmation UPDATEs cannot reset
--     or extend an already-started trial (WHERE started_at IS NULL guard).
--   - No user-controlled metadata is used for entitlement. Identity always
--     comes from auth.uid().
--   - All writes go through SECURITY DEFINER functions. No INSERT/UPDATE/DELETE
--     for the authenticated role.
--
-- PRODUCTION ROLLOUT ORDER (do not deviate):
--   1. Apply only this migration:
--        supabase migration list --linked        -- verify one pending migration
--        supabase db push --linked --dry-run     -- preview
--        supabase db push --linked               -- apply
--   2. Verify post-apply (see verification checklist below).
--   3. Deploy all four AI Edge Functions (ai-chat, ai-parse-contact, ai-map-csv,
--      ai-categorize-contacts) — they query pro_trials, which now exists.
--   4. Merge the frontend PR into main. Wait for Vercel READY.
--   5. Test: new signup, email confirmation, trial activation, AI access.
--   6. Test: existing permanent-Pro users still have access.
--   7. Retain rollback versions for all four Edge Functions.
--
-- TEMPORARY BEHAVIOR DURING ROLLOUT:
--   - After migration, before Edge deployment: permanent-Pro behavior unchanged;
--     trial rows exist but Edge Functions are not yet trial-aware.
--   - After Edge deployment, before frontend: backend recognizes trial access
--     but old UI may not display it.
--   - After frontend deployment: full feature visible.
--   - Never deploy frontend before migration is applied (pro_trials table must
--     exist before get_my_pro_access_status() RPC is callable).
--
-- POST-APPLICATION VERIFICATION CHECKLIST:
--   1. SELECT * FROM public.pro_trials LIMIT 5;  -- table exists
--   2. SELECT relrowsecurity FROM pg_class WHERE relname = 'pro_trials';  -- must be true
--   3. SELECT policyname, cmd FROM pg_policies WHERE tablename = 'pro_trials';
--      -- exactly one SELECT policy, no INSERT/UPDATE/DELETE policies
--   4a. SELECT grantee, privilege_type FROM information_schema.role_table_grants
--       WHERE table_name = 'pro_trials' ORDER BY grantee, privilege_type;
--       -- authenticated: SELECT only; anon: none; service_role: all privileges
--   4b. Verify authenticated lacks all dangerous privileges (all must return false):
--       SELECT has_table_privilege('authenticated', 'public.pro_trials', 'INSERT');
--       SELECT has_table_privilege('authenticated', 'public.pro_trials', 'UPDATE');
--       SELECT has_table_privilege('authenticated', 'public.pro_trials', 'DELETE');
--       SELECT has_table_privilege('authenticated', 'public.pro_trials', 'TRUNCATE');
--       SELECT has_table_privilege('authenticated', 'public.pro_trials', 'REFERENCES');
--       SELECT has_table_privilege('authenticated', 'public.pro_trials', 'TRIGGER');
--   4c. Verify service_role has write access (all must return true):
--       SELECT has_table_privilege('service_role', 'public.pro_trials', 'INSERT');
--       SELECT has_table_privilege('service_role', 'public.pro_trials', 'UPDATE');
--       SELECT has_table_privilege('service_role', 'public.pro_trials', 'DELETE');
--   5. SELECT proname, prosrc FROM pg_proc WHERE proname IN
--      ('handle_new_user', 'activate_trial_on_confirmation',
--       'start_my_pro_trial', 'get_my_pro_access_status');
--      -- all four functions exist
--   6. SELECT tgname, tgenabled FROM pg_trigger WHERE tgname IN
--      ('on_auth_user_created', 'on_email_confirmed');
--      -- both triggers enabled (tgenabled = 'O')
--   7. SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'handle_new_user';
--      -- prosecdef=true, proconfig includes search_path=
--   8. Sign up a test user → verify profiles row AND pro_trials row created with
--      started_at IS NULL.
--   9. Confirm email → verify pro_trials row has started_at set and
--      ends_at = started_at + 7 days.
--  10. Call get_my_pro_access_status() as the confirmed user → verify trial_active=true.


-- ── 1. Create pro_trials table ────────────────────────────────────────────────

CREATE TABLE public.pro_trials (
  user_id    uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at timestamptz,
  ends_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Structural constraint: both NULL (eligible) or both set (started/expired)
  CONSTRAINT pro_trials_dates_consistent
    CHECK (
      (started_at IS NULL AND ends_at IS NULL) OR
      (started_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > started_at)
    )
);

ALTER TABLE public.pro_trials ENABLE ROW LEVEL SECURITY;

-- ── Explicit privilege hardening for pro_trials ───────────────────────────────
-- Supabase grants INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER,
-- and MAINTAIN to authenticated on all new public tables by default. RLS does NOT
-- protect against TRUNCATE — a REVOKE ALL is required to block it.
--
-- Pattern: REVOKE ALL from every role first, then GRANT only what is needed.
-- service_role must receive an explicit GRANT ALL so Edge Functions (which use
-- the service-role key to bypass RLS) can write to the table.

REVOKE ALL ON TABLE public.pro_trials FROM PUBLIC;
REVOKE ALL ON TABLE public.pro_trials FROM anon;
REVOKE ALL ON TABLE public.pro_trials FROM authenticated;
GRANT SELECT ON TABLE public.pro_trials TO authenticated;
GRANT ALL ON TABLE public.pro_trials TO service_role;

-- RLS policy: read own row only.
-- (select auth.uid()) subquery form evaluated once per query, not per row.
CREATE POLICY "pro_trials_select_own"
  ON public.pro_trials
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- No INSERT / UPDATE / DELETE policy for authenticated.
-- All writes go through SECURITY DEFINER functions.


-- ── 2. Update handle_new_user to also create a trial row on signup ────────────
--
-- PRODUCTION FUNCTION INSPECTED 2026-07-27 before this CREATE OR REPLACE.
-- The live production function performs exactly this five-column profile insert:
--
--   INSERT INTO public.profiles (id, email, ai_enabled, display_name, updated_at)
--   VALUES (new.id, new.email, false, null, now())
--   ON CONFLICT (id) DO NOTHING;
--
-- This replacement preserves that insert exactly. Do not abbreviate or remove
-- any column. Adding the pro_trials insert is the only behavioral change.
--
-- AUTO-CONFIRMED ACCOUNTS: if email_confirmed_at is already set at INSERT time
-- (e.g., OAuth flow, dev/admin created account), the trial starts immediately.
-- Normal flow: email_confirmed_at is NULL, trial starts via on_email_confirmed trigger.
--
-- ACL NOTE: CREATE OR REPLACE preserves proacl. The hardened ACL (only postgres
-- and service_role may execute) was applied in migration 20260713185900_harden_handle_new_user.sql.
-- The REVOKE below re-applies it defensively after this OR REPLACE.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Exactly preserve the production profile insert (inspected 2026-07-27).
  -- Five columns: id, email, ai_enabled, display_name, updated_at.
  INSERT INTO public.profiles (id, email, ai_enabled, display_name, updated_at)
  VALUES (new.id, new.email, false, null, now())
  ON CONFLICT (id) DO NOTHING;

  -- Create trial row.
  -- Auto-confirmed accounts (email_confirmed_at IS NOT NULL at INSERT time)
  -- start the trial immediately so they are not disadvantaged.
  -- Normal accounts start as eligible (NULL/NULL); the on_email_confirmed trigger
  -- activates the trial when confirmation happens later.
  IF new.email_confirmed_at IS NOT NULL THEN
    INSERT INTO public.pro_trials (user_id, started_at, ends_at)
    VALUES (new.id, now(), now() + INTERVAL '7 days')
    ON CONFLICT (user_id) DO NOTHING;
  ELSE
    INSERT INTO public.pro_trials (user_id, started_at, ends_at)
    VALUES (new.id, NULL, NULL)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  RETURN new;
END;
$$;

-- Restore hardened ACL after CREATE OR REPLACE.
-- Only postgres (migration runner) and service_role should execute this trigger function.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;


-- ── 3. Trigger: activate trial on email confirmation ─────────────────────────
--
-- Fires on the auth.users row when email_confirmed_at transitions from NULL to
-- a timestamp. This is the primary activation path for normal signup flow.
--
-- Guards:
--   - Only fires when OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL
--     (exact NULL→set transition; repeated confirmation UPDATEs are no-ops)
--   - Updates only an existing row with started_at IS NULL
--     (idempotent: already-started trials are not reset or extended)
--   - Only updates the calling user's own row (WHERE user_id = NEW.id)
--   - Does not backfill rows that do not exist (pre-migration unconfirmed users
--     have no pro_trials row and receive no trial)
--
-- SECURITY: SECURITY DEFINER because this function runs inside an auth.users
-- UPDATE and needs to write to public.pro_trials.

CREATE OR REPLACE FUNCTION public.activate_trial_on_confirmation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Only act on the NULL → non-NULL transition
  IF OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL THEN
    -- Activate only an existing eligible row (started_at IS NULL).
    -- No-op if: no row exists (pre-migration user), trial already started,
    -- or trial already expired. Repeated auth updates cannot extend ends_at.
    UPDATE public.pro_trials
    SET started_at = now(),
        ends_at    = now() + INTERVAL '7 days'
    WHERE user_id     = NEW.id
      AND started_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Direct execution of this trigger function is not meaningful outside the trigger
-- mechanism. Revoke to prevent misuse.
REVOKE EXECUTE ON FUNCTION public.activate_trial_on_confirmation() FROM PUBLIC, anon, authenticated;

-- Trigger on auth.users: fires after email_confirmed_at is updated
CREATE TRIGGER on_email_confirmed
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.activate_trial_on_confirmation();


-- ── 4. get_my_pro_access_status() ─────────────────────────────────────────────
--
-- Server-authoritative entitlement and trial status for the calling user.
-- Uses the database clock (now()) — not the browser clock — for all comparisons.
-- The frontend never makes an authoritative access decision using Date().
--
-- SECURITY INVOKER: runs as the authenticated caller. The caller can read their
-- own profile and pro_trials rows via RLS SELECT policies. No elevated privilege
-- is needed.
--
-- Return shape:
--   permanent_pro  boolean       — ai_enabled = true on profiles row
--   trial_eligible boolean       — trial row exists with started_at IS NULL
--   trial_active   boolean       — trial started and ends_at > now()
--   trial_expired  boolean       — trial started and ends_at <= now()
--   days_remaining int           — calendar days left (0 when not active)
--   ends_at        timestamptz   — when trial expires (null if not started)
--   server_now     timestamptz   — database clock at call time (client sync)
--   can_use_pro    boolean       — permanent_pro OR trial_active
--
-- Priority: permanent_pro=true grants can_use_pro regardless of trial state.
-- Only non-permanent-Pro users with trial_active show trial countdown.

CREATE OR REPLACE FUNCTION public.get_my_pro_access_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user_id       uuid;
  v_ai_enabled    boolean;
  v_trial_exists  boolean := false;
  v_started_at    timestamptz;
  v_ends_at       timestamptz;
  v_now           timestamptz;
  v_permanent_pro boolean;
  v_eligible      boolean;
  v_active        boolean;
  v_expired       boolean;
  v_days_rem      int;
  v_can_use       boolean;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  v_now := now();

  -- Read profile (SECURITY INVOKER: runs as authenticated; RLS applies)
  SELECT ai_enabled INTO v_ai_enabled
  FROM public.profiles
  WHERE id = v_user_id;

  -- Read trial row (FOUND is set by the previous SELECT ... INTO)
  SELECT started_at, ends_at INTO v_started_at, v_ends_at
  FROM public.pro_trials
  WHERE user_id = v_user_id;
  v_trial_exists := FOUND;

  -- Permanent access: ai_enabled overrides everything
  v_permanent_pro := COALESCE(v_ai_enabled, false);

  -- Derive trial state using server clock
  v_eligible := v_trial_exists AND v_started_at IS NULL;
  v_active   := v_trial_exists AND v_started_at IS NOT NULL
                AND v_ends_at IS NOT NULL AND v_ends_at > v_now;
  v_expired  := v_trial_exists AND v_started_at IS NOT NULL
                AND v_ends_at IS NOT NULL AND v_ends_at <= v_now;

  -- Days remaining: ceiling division (1 ms left = 1 day displayed)
  IF v_active THEN
    v_days_rem := CEIL(EXTRACT(EPOCH FROM (v_ends_at - v_now)) / 86400.0)::int;
  ELSE
    v_days_rem := 0;
  END IF;

  v_can_use := v_permanent_pro OR v_active;

  RETURN jsonb_build_object(
    'permanent_pro',  v_permanent_pro,
    'trial_eligible', v_eligible,
    'trial_active',   v_active,
    'trial_expired',  v_expired,
    'days_remaining', v_days_rem,
    'ends_at',        v_ends_at,
    'server_now',     v_now,
    'can_use_pro',    v_can_use
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_pro_access_status() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_my_pro_access_status() FROM PUBLIC, anon;


-- ── 5. start_my_pro_trial() — idempotent recovery mechanism ──────────────────
--
-- ROLE: Recovery mechanism only. The primary trial activation paths are:
--   a) handle_new_user() for auto-confirmed accounts.
--   b) on_email_confirmed trigger for normal email confirmation flow.
--
-- Justified retention: in normal flow the on_email_confirmed trigger activates
-- the trial atomically on confirmation. This RPC is an idempotent reconciliation
-- step for confirmed users whose pro_trials row still has started_at IS NULL —
-- e.g., if the trigger did not fire due to transient infrastructure issues or
-- edge-case routing. WelcomePage.jsx calls it fire-and-forget before reading
-- authoritative status from get_my_pro_access_status().
--
-- IMPORTANT LIMITATIONS (not the primary activation mechanism):
--   - Only updates an existing eligible row (started_at IS NULL).
--     Does NOT create a missing pro_trials row.
--   - Does NOT backfill pre-migration users who have no pro_trials row.
--   - Cannot extend or restart an already-started or expired trial.
--   - Note: a PostgreSQL trigger failure aborts the enclosing transaction
--     (confirmation itself also fails in that case). The scenario this RPC
--     recovers from is a confirmed user with an eligible row that was never
--     activated — not a trigger that ran but produced incorrect data.
--
-- INVARIANTS:
--   - never resets or extends an existing trial (WHERE started_at IS NULL)
--   - requires confirmed email (email_confirmed_at IS NOT NULL in auth.users)
--   - requires authenticated caller (auth.uid() IS NOT NULL)
--   - identity always derived from auth.uid() — no caller-supplied user_id
--
-- SECURITY DEFINER: needed to read auth.users for email_confirmed_at check.

CREATE OR REPLACE FUNCTION public.start_my_pro_trial()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

  -- Atomic conditional start: only updates when no trial has been started yet.
  -- If started_at is already set (primary trigger fired), this touches 0 rows.
  UPDATE public.pro_trials
  SET started_at = v_now,
      ends_at    = v_now + INTERVAL '7 days'
  WHERE user_id    = v_user_id
    AND started_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_started_now := (v_rows > 0);

  -- Read current state (whether just started by this call or previously)
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

GRANT EXECUTE ON FUNCTION public.start_my_pro_trial() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.start_my_pro_trial() FROM PUBLIC, anon;
