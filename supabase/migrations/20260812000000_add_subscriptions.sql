-- ── Migration: add_subscriptions ─────────────────────────────────────────────
--
-- PREREQUISITE: migration 20260727000000_add_pro_trials.sql must be applied first.
--   That migration creates the pro_trials table and the initial
--   get_my_pro_access_status() RPC. This migration adds the subscriptions table
--   and replaces the RPC with an updated version that incorporates Stripe
--   subscription status into the can_use_pro entitlement check.
--
-- DEPLOYMENT ORDER:
--   1. Apply this migration (creates table, updates RPC)
--   2. Add STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET to Supabase secrets
--   3. Deploy Edge Functions: create-checkout-session, stripe-webhook,
--      and the four updated AI functions (ai-chat, ai-parse-contact,
--      ai-map-csv, ai-categorize-contacts)
--   4. Register stripe-webhook URL in Stripe dashboard
--   5. Deploy frontend
--
-- VERIFICATION AFTER RUNNING:
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'subscriptions';  -- true
--   SELECT has_table_privilege('authenticated','public.subscriptions','SELECT');   -- true
--   SELECT has_table_privilege('authenticated','public.subscriptions','INSERT');   -- false
--   SELECT has_table_privilege('authenticated','public.subscriptions','UPDATE');   -- false
--   SELECT has_table_privilege('authenticated','public.subscriptions','DELETE');   -- false
--   SELECT has_table_privilege('service_role','public.subscriptions','INSERT');    -- true
--   -- Test RPC returns new fields:
--   SELECT public.get_my_pro_access_status();

-- ── 1. subscriptions table ────────────────────────────────────────────────────
--
-- One row per user, created by the stripe-webhook Edge Function on first Stripe
-- event. Writable only by the webhook via service_role. Authenticated users
-- get SELECT-only so they can read their own subscription row via RLS.
--
-- status mirrors Stripe subscription statuses. 'none' is the initial placeholder
-- (only present while the customer row exists but the subscription hasn't been
-- activated yet - practically not seen since we only create rows on webhook events).
-- cancel_at_period_end: user cancelled but Pro continues until current_period_end.

CREATE TABLE public.subscriptions (
  user_id                  uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id       text        NOT NULL,
  stripe_subscription_id   text,
  status                   text        NOT NULL DEFAULT 'none',
  current_period_end       timestamptz,
  cancel_at_period_end     boolean     NOT NULL DEFAULT false,
  price_id                 text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subscriptions_status_check CHECK (
    status IN ('none','active','past_due','canceled','incomplete',
               'incomplete_expired','trialing','unpaid','paused')
  )
);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Hardened ACL: matches pro_trials pattern.
-- No direct INSERT/UPDATE/DELETE for any authenticated user — all writes are
-- done by the stripe-webhook Edge Function using the service_role key.
REVOKE ALL ON TABLE public.subscriptions FROM PUBLIC;
REVOKE ALL ON TABLE public.subscriptions FROM anon;
REVOKE ALL ON TABLE public.subscriptions FROM authenticated;
GRANT SELECT ON TABLE public.subscriptions TO authenticated;
GRANT ALL    ON TABLE public.subscriptions TO service_role;

-- RLS policy: users can only read their own subscription row.
-- Uses subquery form (SELECT auth.uid()) rather than direct call for performance.
CREATE POLICY "subscriptions_select_own"
  ON public.subscriptions FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- Index to support webhook lookups by stripe_customer_id (subscription events
-- carry customer ID but not user_id — the webhook uses this to find the user).
CREATE UNIQUE INDEX subscriptions_stripe_customer_id_idx
  ON public.subscriptions(stripe_customer_id);


-- ── 2. Updated get_my_pro_access_status() RPC ─────────────────────────────────
--
-- Replaces the function created in migration 20260727000000_add_pro_trials.sql.
-- Added fields: subscription_active, subscription_status, subscription_period_end,
--   cancel_at_period_end (from subscriptions table).
-- Changed: can_use_pro = permanent_pro OR trial_active OR subscription_active.
-- All existing fields and their semantics are unchanged — backward-compatible.
--
-- SECURITY INVOKER: runs as the calling user, so RLS on subscriptions applies
-- (authenticated users can SELECT only their own row).

CREATE OR REPLACE FUNCTION public.get_my_pro_access_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user_id            uuid;
  v_ai_enabled         boolean;
  v_trial_exists       boolean := false;
  v_started_at         timestamptz;
  v_ends_at            timestamptz;
  v_sub_status         text;
  v_sub_period_end     timestamptz;
  v_sub_cancel_eop     boolean;
  v_now                timestamptz;
  v_permanent_pro      boolean;
  v_eligible           boolean;
  v_active             boolean;
  v_expired            boolean;
  v_sub_active         boolean;
  v_days_rem           int;
  v_can_use            boolean;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  v_now := now();

  -- Permanent Pro gate
  SELECT ai_enabled INTO v_ai_enabled
  FROM public.profiles
  WHERE id = v_user_id;

  -- Trial gate
  SELECT started_at, ends_at INTO v_started_at, v_ends_at
  FROM public.pro_trials
  WHERE user_id = v_user_id;
  v_trial_exists := FOUND;

  -- Subscription gate (LEFT JOIN semantics via maybeSingle — NULL if no row)
  SELECT status, current_period_end, cancel_at_period_end
  INTO v_sub_status, v_sub_period_end, v_sub_cancel_eop
  FROM public.subscriptions
  WHERE user_id = v_user_id;

  -- Classify each path
  v_permanent_pro := COALESCE(v_ai_enabled, false);
  v_eligible      := v_trial_exists AND v_started_at IS NULL;
  v_active        := v_trial_exists
                     AND v_started_at IS NOT NULL
                     AND v_ends_at IS NOT NULL
                     AND v_ends_at > v_now;
  v_expired       := v_trial_exists
                     AND v_started_at IS NOT NULL
                     AND v_ends_at IS NOT NULL
                     AND v_ends_at <= v_now;

  -- Subscription is active during Stripe's dunning window (past_due = retrying).
  v_sub_active    := COALESCE(v_sub_status IN ('active', 'past_due'), false);

  IF v_active THEN
    v_days_rem := CEIL(EXTRACT(EPOCH FROM (v_ends_at - v_now)) / 86400.0)::int;
  ELSE
    v_days_rem := 0;
  END IF;

  -- Unified entitlement: any one path grants Pro access.
  v_can_use := v_permanent_pro OR v_active OR v_sub_active;

  RETURN jsonb_build_object(
    -- Existing fields (unchanged — all callers depend on these)
    'permanent_pro',           v_permanent_pro,
    'trial_eligible',          v_eligible,
    'trial_active',            v_active,
    'trial_expired',           v_expired,
    'days_remaining',          v_days_rem,
    'ends_at',                 v_ends_at,
    'server_now',              v_now,
    'can_use_pro',             v_can_use,
    -- New fields added by this migration
    'subscription_active',     v_sub_active,
    'subscription_status',     COALESCE(v_sub_status, 'none'),
    'subscription_period_end', v_sub_period_end,
    'cancel_at_period_end',    COALESCE(v_sub_cancel_eop, false)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_pro_access_status() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_my_pro_access_status() FROM PUBLIC, anon;
