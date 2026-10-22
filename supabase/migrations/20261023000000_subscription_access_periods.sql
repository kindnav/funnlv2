-- Subscription access by authoritative Stripe periods (forward only; no applied migration is edited).
--
-- PROBLEM. get_my_pro_access_status() granted Pro for any row whose status was 'active' or 'past_due',
-- forever: a row whose renewal or cancellation was never synced kept granting Pro indefinitely, and a
-- failed renewal ('past_due') granted Pro for as long as Stripe kept retrying.
--
-- RULES (owner-approved 2026-10-22). Access is decided from timestamps Stripe itself reported, evaluated
-- against the DATABASE clock - never the browser, and never "whenever the next webhook arrives":
--   active, renewing (cancel_at_period_end = false): Pro until current_period_end + 7 days. Within a
--       paid period this is plain paid access; after the period end the renewal outcome is not yet
--       known here, so it is treated exactly like a failed renewal (7 days from the renewal moment),
--       then Free. A missing renewal webhook therefore cannot grant Pro indefinitely.
--   active, cancel_at_period_end = true: Pro until current_period_end, then Free (a scheduled
--       cancellation is not a renewal, so there is no grace).
--   past_due / unpaid (a renewal payment failed): Pro until grace_started_at + 7 days, then Free until
--       the subscription is active again. grace_started_at is the renewal moment Stripe reported - the
--       unpaid period's current_period_start - set ONCE when the subscription first becomes past_due or
--       unpaid and kept while it stays unpaid, so payment retries, duplicate or out-of-order events,
--       repeated failures and even later renewal cycles cannot restart it. It is cleared when the
--       subscription is no longer unpaid (payment succeeded, or it ended).
--   canceled, incomplete, incomplete_expired, trialing, paused, none, unknown: no subscription access.
-- Permanent Pro (profiles.ai_enabled) and the automatic signup trial (pro_trials) are unchanged.
--
-- The same rule is implemented in JavaScript (supabase/functions/shared/subscriptionStatusPolicy.js,
-- used by every AI function); a local parity test evaluates both on identical inputs at the cutoffs.
--
-- STALE WRITES. Stripe never reactivates a canceled or incomplete_expired subscription, so for the SAME
-- subscription id a write that would move such a row back to a live status is ignored (row unchanged).
-- A different subscription id (a new subscription replacing an ended one) is written normally.
--
-- ROLLOUT: apply this migration, then deploy stripe-webhook (it starts writing current_period_start),
-- create-checkout-session, the AI functions, and finally merge the frontend.

-- ── 1. Columns ─────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS current_period_start timestamptz;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS grace_started_at     timestamptz;

-- ── 2. Guard + grace anchor, enforced for every writer ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.subscriptions_access_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- A canceled / incomplete_expired subscription never comes back to life in Stripe: a write that would
  -- revive the SAME subscription is a stale or out-of-order update. Keep the row exactly as it is.
  IF TG_OP = 'UPDATE'
     AND OLD.stripe_subscription_id IS NOT DISTINCT FROM NEW.stripe_subscription_id
     AND OLD.status IN ('canceled', 'incomplete_expired')
     AND NEW.status NOT IN ('canceled', 'incomplete_expired') THEN
    RETURN OLD;
  END IF;

  IF NEW.status IN ('past_due', 'unpaid') THEN
    -- Keep the first anchor for this subscription while it stays unpaid; otherwise anchor to the
    -- renewal moment Stripe reported. Any value a caller sends is ignored.
    IF TG_OP = 'UPDATE'
       AND OLD.stripe_subscription_id IS NOT DISTINCT FROM NEW.stripe_subscription_id
       AND OLD.status IN ('past_due', 'unpaid')
       AND OLD.grace_started_at IS NOT NULL THEN
      NEW.grace_started_at := OLD.grace_started_at;
    ELSE
      NEW.grace_started_at := NEW.current_period_start;
    END IF;
  ELSE
    NEW.grace_started_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.subscriptions_access_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS subscriptions_access_guard ON public.subscriptions;
CREATE TRIGGER subscriptions_access_guard
  BEFORE INSERT OR UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.subscriptions_access_guard();

-- ── 3. The decision: until when does this subscription grant Pro? (NULL = it does not) ─────────────
-- Pure function of its arguments (IMMUTABLE): no table read and no clock, so it can be tested at exact
-- cutoffs. Access holds while now() < the returned instant.
CREATE OR REPLACE FUNCTION public.subscription_access_until(
  p_status               text,
  p_current_period_end   timestamptz,
  p_cancel_at_period_end boolean,
  p_grace_started_at     timestamptz
)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_status = 'active' AND coalesce(p_cancel_at_period_end, false) THEN p_current_period_end
    WHEN p_status = 'active' THEN p_current_period_end + interval '7 days'
    WHEN p_status IN ('past_due', 'unpaid') THEN p_grace_started_at + interval '7 days'
    ELSE NULL
  END
$$;
REVOKE EXECUTE ON FUNCTION public.subscription_access_until(text, timestamptz, boolean, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.subscription_access_until(text, timestamptz, boolean, timestamptz) TO authenticated, service_role;

-- ── 4. get_my_pro_access_status: the 20260812000000 body, with the subscription rule replaced ───────
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
  v_sub_grace_started  timestamptz;
  v_sub_until          timestamptz;
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

  -- Subscription gate
  SELECT status, current_period_end, cancel_at_period_end, grace_started_at
  INTO v_sub_status, v_sub_period_end, v_sub_cancel_eop, v_sub_grace_started
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

  -- [20261023] Subscription access is bounded by Stripe's reported period and the failed-renewal grace.
  v_sub_until  := public.subscription_access_until(v_sub_status, v_sub_period_end, v_sub_cancel_eop, v_sub_grace_started);
  v_sub_active := v_sub_until IS NOT NULL AND v_now < v_sub_until;

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
    'subscription_active',     v_sub_active,
    'subscription_status',     COALESCE(v_sub_status, 'none'),
    'subscription_period_end', v_sub_period_end,
    'cancel_at_period_end',    COALESCE(v_sub_cancel_eop, false),
    -- [20261023] When subscription access ends (NULL when the subscription grants none).
    'subscription_access_until', CASE WHEN v_sub_active THEN v_sub_until END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_pro_access_status() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_my_pro_access_status() FROM PUBLIC, anon;
