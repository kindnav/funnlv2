-- Account deletion <-> Checkout coordination (forward only; no applied migration is edited).
--
-- PROBLEM. delete-account must cancel billing before deleting an account, but Checkout creation runs
-- independently: a create-checkout-session call can be between "claimed" and "Stripe returned a session"
-- (state 'creating', no session id yet), or can start AFTER delete-account looked at billing. Either way a
-- payable Checkout Session could exist that deletion never saw. Separately, starting a new operation
-- overwrote a still-payable 'ready' session id, so it could not be found later.
--
-- DESIGN (durable, database-enforced; no SELECT-then-act and no in-memory lock):
--   1. public.account_deletion_fences: one row per user while deletion is in progress. Written by
--      begin_account_deletion() under a per-user transaction-scoped advisory lock. The row is the durable
--      state; the lock only makes "write the fence" and "claim a checkout" mutually exclusive.
--   2. claim_checkout_operation() takes the SAME lock first and refuses every mode with
--      {result:'account_deleting'} while a fence younger than FENCE_TTL exists. The currently deployed
--      create-checkout-session treats an unknown result as 'claim_bad_payload' -> 503 with NO Stripe
--      call, so the refusal is safe before that function is ever redeployed.
--   3. begin_account_deletion() returns the checkout state read under the lock: a 'creating' operation is
--      reported (it is NOT "no billing"), and every session id that may still be payable is returned.
--   4. public.checkout_session_history: when claim starts a new operation over a 'ready' row whose
--      session has not expired, the old session id is kept here so deletion can still expire it.
--
-- FENCE_TTL is 15 minutes: far longer than one delete-account invocation (platform wall clock 150 s), so
-- a deletion never outlives its own fence; if deletion is refused (account kept), Checkout becomes
-- available again after the TTL. A successful deletion removes the fence with the account (CASCADE).
--
-- ROLLOUT: apply this migration BEFORE deploying the delete-account that calls begin_account_deletion.
-- No create-checkout-session redeploy is required for safety.

-- ── 1. Tables ────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.account_deletion_fences (
  user_id    uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.account_deletion_fences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_deletion_fences FROM PUBLIC;
REVOKE ALL ON TABLE public.account_deletion_fences FROM anon;
REVOKE ALL ON TABLE public.account_deletion_fences FROM authenticated;
GRANT  ALL ON TABLE public.account_deletion_fences TO service_role;

CREATE TABLE IF NOT EXISTS public.checkout_session_history (
  user_id           uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_session_id text        NOT NULL,
  expires_at        timestamptz,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, stripe_session_id)
);
ALTER TABLE public.checkout_session_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.checkout_session_history FROM PUBLIC;
REVOKE ALL ON TABLE public.checkout_session_history FROM anon;
REVOKE ALL ON TABLE public.checkout_session_history FROM authenticated;
GRANT  ALL ON TABLE public.checkout_session_history TO service_role;

-- ── 2. begin_account_deletion(user) ─────────────────────────────────────────────────────────────────
-- Writes (or refreshes) the fence and reports, under the same lock, what Checkout state exists.
-- Returns {fenced, checkout_state: none|creating|ready|failed, creating_age_seconds, sessions: [ids]}.
CREATE OR REPLACE FUNCTION public.begin_account_deletion(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state    text;
  v_session  text;
  v_updated  timestamptz;
  v_sessions jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_user';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('funnl:billing:' || p_user_id::text, 0));

  INSERT INTO public.account_deletion_fences (user_id, started_at) VALUES (p_user_id, now())
  ON CONFLICT (user_id) DO UPDATE SET started_at = now();

  SELECT state, stripe_session_id, updated_at INTO v_state, v_session, v_updated
  FROM public.checkout_operations WHERE user_id = p_user_id FOR UPDATE;

  SELECT coalesce(jsonb_agg(DISTINCT s ORDER BY s), '[]'::jsonb) INTO v_sessions
  FROM (
    SELECT v_session AS s WHERE v_session IS NOT NULL
    UNION
    SELECT h.stripe_session_id FROM public.checkout_session_history h
    WHERE h.user_id = p_user_id AND (h.expires_at IS NULL OR h.expires_at > now())
  ) x;

  RETURN jsonb_build_object(
    'fenced', true,
    'checkout_state', coalesce(v_state, 'none'),
    'creating_age_seconds', CASE WHEN v_state = 'creating' THEN floor(extract(epoch FROM (now() - v_updated)))::bigint END,
    'sessions', v_sessions
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.begin_account_deletion(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.begin_account_deletion(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.begin_account_deletion(uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.begin_account_deletion(uuid) TO service_role;

-- ── 3. claim_checkout_operation: the 20260815003056 body, with three marked additions ─────────────────
CREATE OR REPLACE FUNCTION public.claim_checkout_operation(
  p_user_id       uuid,
  p_price_id      text,
  p_mode          text    DEFAULT 'reuse_or_create',
  p_stale_seconds integer DEFAULT 120
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state     text;
  v_price     text;
  v_url       text;
  v_op        uuid;
  v_token     uuid;
  v_expires   timestamptz;
  v_updated   timestamptz;
  v_new_op    uuid;
  v_new_tok   uuid;
  v_rows      integer;
  v_may_reuse boolean;
  v_now       timestamptz := now();
  v_session   text;  -- [deletion fence] the session id a new operation would overwrite
BEGIN
  IF p_mode NOT IN ('reuse_or_create','reuse_only','fresh_only') THEN
    RAISE EXCEPTION 'invalid_checkout_mode';
  END IF;

  -- [deletion fence] Serialize with begin_account_deletion() and refuse every mode while a fence exists.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('funnl:billing:' || p_user_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.account_deletion_fences f
             WHERE f.user_id = p_user_id AND f.started_at > v_now - interval '15 minutes') THEN
    RETURN jsonb_build_object('result','account_deleting');
  END IF;

  -- ── reuse_only (status incomplete): reuse an existing ready session, else blocked.
  -- Never inserts and never creates a new operation.
  IF p_mode = 'reuse_only' THEN
    SELECT state, price_id, checkout_url, operation_id, expires_at
    INTO   v_state, v_price, v_url, v_op, v_expires
    FROM   public.checkout_operations
    WHERE  user_id = p_user_id;
    IF FOUND
       AND v_state = 'ready' AND v_price = p_price_id
       AND v_url IS NOT NULL AND v_expires IS NOT NULL AND v_expires > v_now THEN
      RETURN jsonb_build_object('result','reuse','checkout_url',v_url,'operation_id',v_op);
    END IF;
    RETURN jsonb_build_object('result','blocked_no_reuse');
  END IF;

  -- Modes that may create: reuse_or_create (may reuse) and fresh_only (must NOT reuse).
  v_may_reuse := (p_mode = 'reuse_or_create');

  -- First-timer fast path: atomic INSERT. The first of N concurrent callers wins.
  v_new_op  := gen_random_uuid();
  v_new_tok := gen_random_uuid();
  INSERT INTO public.checkout_operations (user_id, price_id, operation_id, claim_token, state, created_at, updated_at)
  VALUES (p_user_id, p_price_id, v_new_op, v_new_tok, 'creating', v_now, v_now)
  ON CONFLICT (user_id) DO NOTHING;
  IF FOUND THEN
    RETURN jsonb_build_object('result','claimed','operation_id',v_new_op,'claim_token',v_new_tok);
  END IF;

  -- Row already exists — read it.
  SELECT state, price_id, checkout_url, operation_id, claim_token, expires_at, updated_at, stripe_session_id
  INTO   v_state, v_price, v_url, v_op, v_token, v_expires, v_updated, v_session
  FROM   public.checkout_operations
  WHERE  user_id = p_user_id;

  -- Reuse an unexpired ready session for the same price — ONLY for reuse_or_create.
  -- fresh_only never reuses (a ready row may be a completed/obsolete payment attempt).
  IF v_may_reuse
     AND v_state = 'ready'
     AND v_price = p_price_id
     AND v_url IS NOT NULL
     AND v_expires IS NOT NULL
     AND v_expires > v_now THEN
    RETURN jsonb_build_object('result','reuse','checkout_url',v_url,'operation_id',v_op);
  END IF;

  -- Another instance is actively creating (recent) — retryable, no Stripe call.
  -- Preserves single-flight for both reuse_or_create AND fresh_only.
  IF v_state = 'creating' AND v_now - v_updated <= make_interval(secs => p_stale_seconds) THEN
    RETURN jsonb_build_object('result','in_progress');
  END IF;

  -- Stale 'creating' (crashed handler): CAS-reclaim.
  IF v_state = 'creating' AND v_now - v_updated > make_interval(secs => p_stale_seconds) THEN
    IF v_price = p_price_id THEN
      -- SAME price: retain operation_id (reuse the Stripe idempotency key), rotate token.
      v_new_tok := gen_random_uuid();
      UPDATE public.checkout_operations
      SET    claim_token = v_new_tok, updated_at = v_now
      WHERE  user_id = p_user_id AND state = 'creating' AND updated_at = v_updated;  -- CAS
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows > 0 THEN
        RETURN jsonb_build_object('result','claimed','operation_id',v_op,'claim_token',v_new_tok);
      END IF;
    ELSE
      -- DIFFERENT price: mint a NEW operation_id (never reuse a key across params),
      -- new token, and clear stored session fields — atomically.
      v_new_op  := gen_random_uuid();
      v_new_tok := gen_random_uuid();
      UPDATE public.checkout_operations
      SET    operation_id = v_new_op, claim_token = v_new_tok, price_id = p_price_id,
             state = 'creating', stripe_session_id = NULL, checkout_url = NULL,
             expires_at = NULL, updated_at = v_now
      WHERE  user_id = p_user_id AND state = 'creating' AND updated_at = v_updated;  -- CAS
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows > 0 THEN
        RETURN jsonb_build_object('result','claimed','operation_id',v_new_op,'claim_token',v_new_tok);
      END IF;
    END IF;
    RETURN jsonb_build_object('result','in_progress');  -- lost the reclaim race
  END IF;

  -- [deletion fence] Keep a still-payable session id before a new operation overwrites it.
  IF v_session IS NOT NULL AND (v_expires IS NULL OR v_expires > v_now) THEN
    INSERT INTO public.checkout_session_history (user_id, stripe_session_id, expires_at)
    VALUES (p_user_id, v_session, v_expires)
    ON CONFLICT (user_id, stripe_session_id) DO NOTHING;
  END IF;

  -- Terminal ('failed'), or 'ready' not reused (expired, different price, or fresh_only):
  -- start a genuinely NEW operation (fresh operation_id + token). CAS on the read
  -- claim_token so two concurrent callers cannot both create — one wins, other in_progress.
  v_new_op  := gen_random_uuid();
  v_new_tok := gen_random_uuid();
  UPDATE public.checkout_operations
  SET    operation_id = v_new_op, claim_token = v_new_tok, price_id = p_price_id,
         state = 'creating', stripe_session_id = NULL, checkout_url = NULL,
         expires_at = NULL, updated_at = v_now
  WHERE  user_id = p_user_id AND claim_token = v_token AND state = v_state;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows > 0 THEN
    RETURN jsonb_build_object('result','claimed','operation_id',v_new_op,'claim_token',v_new_tok);
  END IF;
  -- Row changed underneath us — safe retryable fallback.
  RETURN jsonb_build_object('result','in_progress');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_checkout_operation(uuid, text, text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_checkout_operation(uuid, text, text, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_checkout_operation(uuid, text, text, integer) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_checkout_operation(uuid, text, text, integer) TO service_role;
