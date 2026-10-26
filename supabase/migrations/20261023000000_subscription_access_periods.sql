-- Subscription access from verified Stripe payment evidence (forward only; no applied migration is edited).
--
-- PROBLEM. get_my_pro_access_status() granted Pro for any row whose status was 'active' or 'past_due',
-- forever: a row whose renewal or cancellation was never synced kept granting Pro, and a failed renewal
-- kept Pro for as long as Stripe retried. Status is a mutable snapshot; it is not proof of payment.
--
-- APPROVED POLICY (2026-10-22): a failed renewal keeps Pro for 7 days from the FIRST failed renewal
-- payment, then Free until payment succeeds; retries, duplicates and repeated failures for the same
-- unpaid renewal never restart it. Permanent Pro and the automatic signup trial are unchanged.
--
-- EVIDENCE MODEL. Access for an evidence-based row (evidence_version = 1) comes only from facts Stripe
-- reported about INVOICES of the bound subscription and customer, merged by apply_subscription_evidence():
--   paid_through              the latest period end covered by a verified PAID invoice. Only ever grows.
--   last_paid_invoice_id/_created   the newest paid invoice seen. A failure for this invoice, or for an
--                             older one, is ignored - so a stale or delayed failure cannot reopen a paid one.
--   failed_invoice_id/_created      the OLDEST renewal invoice with a verified failure in the current
--                             unpaid stretch (an "unpaid stretch" runs from the first failed renewal until
--                             recovery).
--   latest_failed_invoice_id/_created   the NEWEST renewal invoice with a verified failure in it.
--   grace_started_at          the earliest verified failure time in the stretch (the Stripe-generated
--                             timestamp of an invoice.payment_failed event). It only moves EARLIER (a
--                             delayed first failure), never later. A later unpaid cycle joins the stretch
--                             and never restarts it. RECOVERY = a verified PAID invoice that is the newest
--                             failed renewal or newer; paying an older one while a newer renewal is still
--                             unpaid does not end the stretch. An initial purchase (billing_reason
--                             subscription_create) never gets grace. After a genuine recovery, a later
--                             failure starts a new stretch with its own grace.
-- Every merge is monotonic, so the result does not depend on which concurrent handler reaches the
-- database first: an older handler released after newer evidence was applied cannot lower paid_through,
-- move the anchor later, clear it, or revive a paid invoice's failure. Status writes cannot touch these
-- columns (the trigger restores them unless the write comes from apply_subscription_evidence).
--
-- ACCESS (subscription_access_until; access holds while now() < the result, on the database clock):
--   status not in (active, past_due, unpaid)       -> none (canceled, incomplete, incomplete_expired,
--                                                     trialing, paused, none, unknown)
--   evidence_version = 1 (rows written after this migration):
--       greatest(paid_through, grace_started_at + 7 days when a failure is outstanding)
--       An 'active' status alone grants nothing beyond paid_through: if a renewal's outcome has not been
--       reported, the account is Free after the paid period until evidence arrives (no invented payment).
--   evidence_version = 0 (rows that existed before this migration, until their FIRST write afterwards):
--       active -> current_period_end (the period Stripe reported before the migration; no extra
--       allowance); otherwise none. The first write of any kind converts the row to evidence_version 1
--       with paid_through = that same value, so access at the moment of conversion is unchanged and
--       nothing BEYOND the pre-migration period is granted without a verified paid invoice. (A new
--       period end in a later status snapshot is not payment evidence.)
--
-- STALE STATUS WRITES. For the SAME subscription id: a canceled / incomplete_expired row never returns to
-- a live status, and a live row never returns to 'incomplete'. A different subscription id starts fresh
-- (its evidence columns are cleared) - except that an ENDED subscription (canceled / incomplete_expired)
-- never replaces another subscription's row: a delayed write for an old subscription cannot erase the
-- current one's evidence.
--
-- ROLLOUT: deploy stripe-webhook FIRST (until this migration exists its writes fail with 5xx and Stripe
-- redelivers, so no invoice evidence is consumed and lost), then apply this migration, then deploy
-- the AI functions and create-checkout-session, then merge. See the PR for the full sequence.

-- ── 1. Columns ─────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS current_period_start      timestamptz;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS paid_through              timestamptz;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS last_paid_invoice_id      text;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS last_paid_invoice_created timestamptz;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS failed_invoice_id         text;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS failed_invoice_created    timestamptz;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS latest_failed_invoice_id      text;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS latest_failed_invoice_created timestamptz;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS grace_started_at          timestamptz;
-- Existing rows are 0 (legacy rule until their first evidence); every row inserted afterwards is 1.
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS evidence_version smallint NOT NULL DEFAULT 0;
ALTER TABLE public.subscriptions ALTER COLUMN evidence_version SET DEFAULT 1;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_evidence_version_check CHECK (evidence_version IN (0, 1));

-- ── 2. Trigger: status guards; evidence columns writable only through the evidence merge ─────────────
CREATE OR REPLACE FUNCTION public.subscriptions_access_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_evidence_write boolean := coalesce(current_setting('funnl.evidence_write', true), '') = 'on';
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.stripe_subscription_id IS DISTINCT FROM NEW.stripe_subscription_id THEN
    -- An ended subscription never replaces another one (a delayed write for an old subscription).
    IF NEW.status IN ('canceled', 'incomplete_expired') THEN
      RETURN OLD;
    END IF;
    -- A different subscription: nothing proven about the old one applies to it.
    NEW.paid_through := NULL; NEW.last_paid_invoice_id := NULL; NEW.last_paid_invoice_created := NULL;
    NEW.failed_invoice_id := NULL; NEW.failed_invoice_created := NULL; NEW.grace_started_at := NULL;
    NEW.latest_failed_invoice_id := NULL; NEW.latest_failed_invoice_created := NULL;
    NEW.evidence_version := 1;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Stripe never revives a canceled / incomplete_expired subscription, and never returns a live one to
    -- 'incomplete': such a write for the same subscription is stale. Keep the stored status.
    IF (OLD.status IN ('canceled', 'incomplete_expired') AND NEW.status NOT IN ('canceled', 'incomplete_expired'))
       OR (OLD.status <> 'incomplete' AND NEW.status = 'incomplete') THEN
      NEW.status := OLD.status;
    END IF;
    IF NOT v_evidence_write THEN
      -- Only apply_subscription_evidence() may change billing evidence.
      NEW.paid_through := OLD.paid_through; NEW.last_paid_invoice_id := OLD.last_paid_invoice_id;
      NEW.last_paid_invoice_created := OLD.last_paid_invoice_created; NEW.failed_invoice_id := OLD.failed_invoice_id;
      NEW.failed_invoice_created := OLD.failed_invoice_created; NEW.grace_started_at := OLD.grace_started_at;
      NEW.latest_failed_invoice_id := OLD.latest_failed_invoice_id; NEW.latest_failed_invoice_created := OLD.latest_failed_invoice_created;
      NEW.evidence_version := OLD.evidence_version;
      IF OLD.evidence_version = 0 THEN
        -- First write to a pre-migration row: keep exactly the access it had, require evidence beyond it.
        NEW.evidence_version := 1;
        NEW.paid_through := CASE WHEN OLD.status = 'active' THEN OLD.current_period_end END;
      END IF;
    END IF;
  ELSIF NOT v_evidence_write THEN
    NEW.paid_through := NULL; NEW.last_paid_invoice_id := NULL; NEW.last_paid_invoice_created := NULL;
    NEW.failed_invoice_id := NULL; NEW.failed_invoice_created := NULL; NEW.grace_started_at := NULL;
    NEW.latest_failed_invoice_id := NULL; NEW.latest_failed_invoice_created := NULL;
    NEW.evidence_version := 1;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.subscriptions_access_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS subscriptions_access_guard ON public.subscriptions;
CREATE TRIGGER subscriptions_access_guard
  BEFORE INSERT OR UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.subscriptions_access_guard();

-- ── 3. apply_subscription_evidence: the one monotonic merge (service role only) ──────────────────────
-- p_kind 'paid':   p_paid_period_end = the period end the paid invoice covers.
-- p_kind 'failed': p_failed_at = the Stripe timestamp of that failure; renewal invoices only.
-- The caller (stripe-webhook) has re-fetched the invoice from Stripe and verified it belongs to
-- p_subscription_id and p_customer_id; the row must be bound to exactly that subscription and customer.
CREATE OR REPLACE FUNCTION public.apply_subscription_evidence(
  p_user_id          uuid,
  p_subscription_id  text,
  p_customer_id      text,
  p_kind             text,
  p_invoice_id       text,
  p_invoice_created  timestamptz,
  p_paid_period_end  timestamptz,
  p_failed_at        timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r       public.subscriptions%ROWTYPE;
  v_clear boolean;
BEGIN
  IF p_kind NOT IN ('paid', 'failed') OR p_invoice_id IS NULL OR p_invoice_created IS NULL
     OR (p_kind = 'paid' AND p_paid_period_end IS NULL) OR (p_kind = 'failed' AND p_failed_at IS NULL) THEN
    RAISE EXCEPTION 'invalid_evidence';
  END IF;

  SELECT * INTO r FROM public.subscriptions WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR r.stripe_subscription_id IS DISTINCT FROM p_subscription_id OR r.stripe_customer_id IS DISTINCT FROM p_customer_id THEN
    RETURN jsonb_build_object('result', 'not_bound');
  END IF;

  PERFORM set_config('funnl.evidence_write', 'on', true);
  IF r.evidence_version = 0 THEN
    -- A pre-migration row: its reported period is its starting paid_through (same rule as the trigger).
    r.paid_through := CASE WHEN r.status = 'active' THEN r.current_period_end END;
  END IF;

  IF p_kind = 'paid' THEN
    -- Recovery only from payment evidence: the newest failed renewal paid, or a newer invoice paid.
    v_clear := r.failed_invoice_id IS NOT NULL
               AND (p_invoice_id = r.latest_failed_invoice_id OR p_invoice_created > r.latest_failed_invoice_created);
    UPDATE public.subscriptions SET
      evidence_version          = 1,
      paid_through              = greatest(r.paid_through, p_paid_period_end),
      last_paid_invoice_id      = CASE WHEN r.last_paid_invoice_created IS NULL OR p_invoice_created >= r.last_paid_invoice_created THEN p_invoice_id ELSE r.last_paid_invoice_id END,
      last_paid_invoice_created = greatest(r.last_paid_invoice_created, p_invoice_created),
      failed_invoice_id             = CASE WHEN v_clear THEN NULL ELSE r.failed_invoice_id END,
      failed_invoice_created        = CASE WHEN v_clear THEN NULL ELSE r.failed_invoice_created END,
      latest_failed_invoice_id      = CASE WHEN v_clear THEN NULL ELSE r.latest_failed_invoice_id END,
      latest_failed_invoice_created = CASE WHEN v_clear THEN NULL ELSE r.latest_failed_invoice_created END,
      grace_started_at              = CASE WHEN v_clear THEN NULL ELSE r.grace_started_at END
    WHERE user_id = p_user_id;
    PERFORM set_config('funnl.evidence_write', 'off', true);
    RETURN jsonb_build_object('result', 'applied');
  END IF;

  -- 'failed': a failure for an invoice already paid, or older than the newest paid invoice, is stale.
  IF r.last_paid_invoice_created IS NOT NULL
     AND (p_invoice_id = r.last_paid_invoice_id OR p_invoice_created <= r.last_paid_invoice_created) THEN
    PERFORM set_config('funnl.evidence_write', 'off', true);
    RETURN jsonb_build_object('result', 'ignored_paid');
  END IF;
  UPDATE public.subscriptions SET
    evidence_version       = 1,
    paid_through           = r.paid_through,
    -- Within one unpaid stretch: widen [oldest, newest] failed renewal; keep the EARLIEST failure time.
    failed_invoice_id             = CASE WHEN r.failed_invoice_id IS NULL OR p_invoice_created < r.failed_invoice_created THEN p_invoice_id ELSE r.failed_invoice_id END,
    failed_invoice_created        = CASE WHEN r.failed_invoice_id IS NULL THEN p_invoice_created ELSE least(r.failed_invoice_created, p_invoice_created) END,
    latest_failed_invoice_id      = CASE WHEN r.failed_invoice_id IS NULL OR p_invoice_created > r.latest_failed_invoice_created THEN p_invoice_id ELSE r.latest_failed_invoice_id END,
    latest_failed_invoice_created = CASE WHEN r.failed_invoice_id IS NULL THEN p_invoice_created ELSE greatest(r.latest_failed_invoice_created, p_invoice_created) END,
    grace_started_at              = CASE WHEN r.failed_invoice_id IS NULL THEN p_failed_at ELSE least(r.grace_started_at, p_failed_at) END
  WHERE user_id = p_user_id;
  PERFORM set_config('funnl.evidence_write', 'off', true);
  RETURN jsonb_build_object('result', 'applied');
END;
$$;
REVOKE EXECUTE ON FUNCTION public.apply_subscription_evidence(uuid, text, text, text, text, timestamptz, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.apply_subscription_evidence(uuid, text, text, text, text, timestamptz, timestamptz, timestamptz) TO service_role;

-- ── 4. The decision: until when does this subscription grant Pro? (NULL = it does not) ─────────────
-- Pure function of its arguments (no table read, no clock) so it can be tested at exact cutoffs.
CREATE OR REPLACE FUNCTION public.subscription_access_until(
  p_status             text,
  p_evidence_version   smallint,
  p_current_period_end timestamptz,
  p_paid_through       timestamptz,
  p_failed_invoice_id  text,
  p_grace_started_at   timestamptz
)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_status IS NULL OR p_status NOT IN ('active', 'past_due', 'unpaid') THEN NULL
    WHEN coalesce(p_evidence_version, 0) = 0 THEN CASE WHEN p_status = 'active' THEN p_current_period_end END
    ELSE greatest(p_paid_through,
                  CASE WHEN p_failed_invoice_id IS NOT NULL THEN p_grace_started_at + interval '7 days' END)
  END
$$;
REVOKE EXECUTE ON FUNCTION public.subscription_access_until(text, smallint, timestamptz, timestamptz, text, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.subscription_access_until(text, smallint, timestamptz, timestamptz, text, timestamptz) TO authenticated, service_role;

-- ── 5. get_my_pro_access_status: the 20260812000000 body, with the subscription rule replaced ───────
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
  v_sub_version        smallint;
  v_sub_paid_through   timestamptz;
  v_sub_failed_inv     text;
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
  SELECT status, current_period_end, cancel_at_period_end, evidence_version, paid_through, failed_invoice_id, grace_started_at
  INTO v_sub_status, v_sub_period_end, v_sub_cancel_eop, v_sub_version, v_sub_paid_through, v_sub_failed_inv, v_sub_grace_started
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

  -- [20261023] Subscription access comes from verified payment evidence (see subscription_access_until).
  v_sub_until  := public.subscription_access_until(v_sub_status, v_sub_version, v_sub_period_end, v_sub_paid_through, v_sub_failed_inv, v_sub_grace_started);
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
    -- [20261023] When subscription access ends (NULL when the subscription grants none), and whether a
    -- failed renewal is currently in its grace window.
    'subscription_access_until', CASE WHEN v_sub_active THEN v_sub_until END,
    'payment_grace_active',      v_sub_active AND v_sub_failed_inv IS NOT NULL AND v_sub_grace_started + interval '7 days' > v_now
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_pro_access_status() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_my_pro_access_status() FROM PUBLIC, anon;
