-- Account deletion <-> Checkout coordination (forward only; no applied migration is edited).
--
-- PROBLEM. delete-account must cancel billing before deleting an account, but Checkout creation runs
-- independently: a create-checkout-session call can be between "claimed" and "Stripe returned a session"
-- (state 'creating', no session id yet), or can start AFTER delete-account looked at billing. Either way a
-- Checkout Session could exist - possibly already PAID, with its webhook missing - that deletion never saw.
-- Separately, starting a new operation overwrote a recorded session id, and reclaiming or replacing an
-- unfinished operation discarded its identity, so neither could be reconciled later.
--
-- A session's expires_at only bounds whether an UNPAID session can still be paid. It says nothing about a
-- session that completed: that one started a subscription that continues. So nothing here treats expiry
-- or age as proof that billing has ended; Stripe's own session status decides (expired = never paid).
--
-- DESIGN (durable, database-enforced; no SELECT-then-act and no in-memory lock):
--   1. public.account_deletion_fences: one row per user while deletion is in progress. Written by
--      begin_account_deletion() under a per-user transaction-scoped advisory lock. claim_checkout_operation()
--      takes the SAME lock and refuses every mode with {result:'account_deleting'} while a fence younger
--      than 15 minutes exists. The deployed create-checkout-session treats an unknown result as
--      'claim_bad_payload' -> 503 with NO Stripe call, so the refusal is safe without a redeploy.
--   2. public.checkout_session_history: every session id a new operation overwrites is kept, whatever its
--      expiry, so deletion can ask Stripe what became of it.
--   3. public.checkout_unresolved_operations: when claim discards the identity of an operation that never
--      reported a session (state 'creating' replaced for a different price, or reclaimed after its Stripe
--      idempotency key may have lapsed), the operation is recorded here. Deletion cannot prove what such an
--      operation did without creating a new session, so it is refused until the owner records the outcome
--      with resolve_checkout_outcome() after checking Stripe.
--   4. checkout_operations.operation_started_at: when the current operation_id was minted. A same-price
--      reclaim reuses the idempotency key (Stripe then returns the ORIGINAL session) only while that key is
--      certainly still retained (< 23 h); otherwise the old operation is recorded as unresolved and a new
--      one is minted, instead of a replay that could silently create a second session.
--
--   5. finalize_checkout_operation() also records the session of a LATE request whose operation was
--      reclaimed, replaced or closed meanwhile (its own update no longer matches), so a session a still-
--      running request obtains from Stripe is never lost.
--   6. resolve_checkout_outcome() (the owner's support path) refreshes the fence and refuses while the
--      attempt's last claim is younger than IN_FLIGHT_BOUND (15 minutes): until then the request that
--      claimed it may still be calling Stripe. Age only establishes that the request has finished; it
--      never establishes "no session was created" - that is the owner's assertion after checking Stripe.
--
-- FENCE_TTL is 15 minutes: far longer than one delete-account invocation (platform wall clock 150 s). A
-- successful deletion removes every row here with the account (ON DELETE CASCADE).
--
-- ROLLOUT: apply this migration BEFORE deploying the delete-account that calls begin_account_deletion.
-- No create-checkout-session redeploy is required for safety.

-- ── 1. Tables and column ─────────────────────────────────────────────────────────────────────────────
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

CREATE TABLE IF NOT EXISTS public.checkout_unresolved_operations (
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation_id    uuid        NOT NULL,
  price_id        text        NOT NULL,
  last_claimed_at timestamptz NOT NULL,
  reason          text        NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, operation_id),
  CONSTRAINT checkout_unresolved_operations_reason_check CHECK (reason IN ('replaced_different_price', 'reclaimed_after_key_retention'))
);
ALTER TABLE public.checkout_unresolved_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.checkout_unresolved_operations FROM PUBLIC;
REVOKE ALL ON TABLE public.checkout_unresolved_operations FROM anon;
REVOKE ALL ON TABLE public.checkout_unresolved_operations FROM authenticated;
GRANT  ALL ON TABLE public.checkout_unresolved_operations TO service_role;

-- NULL for operations minted before this migration: treated as "key retention unknown" (never replayed).
ALTER TABLE public.checkout_operations ADD COLUMN IF NOT EXISTS operation_started_at timestamptz;

-- ── 2. begin_account_deletion(user) ─────────────────────────────────────────────────────────────────
-- Writes (or refreshes) the fence and reports, under the same lock, what Checkout state exists:
-- {fenced, checkout_state: none|creating|ready|failed, creating_age_seconds, sessions: [ids],
--  unresolved_operations: n}. `sessions` is the current session plus EVERY recorded one, regardless
-- of expiry.
CREATE OR REPLACE FUNCTION public.begin_account_deletion(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state      text;
  v_session    text;
  v_updated    timestamptz;
  v_sessions   jsonb;
  v_unresolved integer;
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
    SELECT h.stripe_session_id FROM public.checkout_session_history h WHERE h.user_id = p_user_id
  ) x;

  SELECT count(*)::integer INTO v_unresolved FROM public.checkout_unresolved_operations u WHERE u.user_id = p_user_id;

  RETURN jsonb_build_object(
    'fenced', true,
    'checkout_state', coalesce(v_state, 'none'),
    'creating_age_seconds', CASE WHEN v_state = 'creating' THEN floor(extract(epoch FROM (now() - v_updated)))::bigint END,
    'sessions', v_sessions,
    'unresolved_operations', v_unresolved
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.begin_account_deletion(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.begin_account_deletion(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.begin_account_deletion(uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.begin_account_deletion(uuid) TO service_role;

-- ── 3. resolve_checkout_outcome(user, operation, session) — the owner's support path ─────────────────
-- Run by the owner (service role, SQL editor) AFTER checking Stripe for the account's Checkout Sessions:
--   p_session_id = the session that operation created (paid or not): it is recorded in the history, so the
--                  next deletion attempt asks Stripe about it and cancels any subscription it started;
--   p_session_id = NULL: the owner has confirmed in Stripe that the operation created no session.
-- Either way the operation stops blocking deletion. If it is still the current 'creating' operation it is
-- closed as 'failed', so a late finalize from its original request cannot reopen it (that late finalize
-- still records its session in the history - see finalize below). Creates nothing.
--
-- REFUSED ('attempt_may_still_be_running') while the attempt's last claim is younger than 15 minutes: the
-- request holding that claim may still be calling Stripe (an Edge Function runs at most 150 s on the Free
-- plan, 400 s on paid plans; 15 minutes leaves wide margin). This applies to the current operation and to
-- a replaced one alike. The fence is refreshed in the same locked transaction, so no new claim can reopen
-- or reclaim the operation after this check.
CREATE OR REPLACE FUNCTION public.resolve_checkout_outcome(p_user_id uuid, p_operation_id uuid, p_session_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_removed    integer;
  v_closed     integer;
  v_last_claim timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'invalid_arguments';
  END IF;
  IF p_session_id IS NOT NULL AND (p_session_id NOT LIKE 'cs\_%' OR length(p_session_id) < 4) THEN
    RAISE EXCEPTION 'invalid_session_id';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('funnl:billing:' || p_user_id::text, 0));

  -- Fence Checkout for this account (same as begin_account_deletion), so nothing can claim after this check.
  INSERT INTO public.account_deletion_fences (user_id, started_at) VALUES (p_user_id, now())
  ON CONFLICT (user_id) DO UPDATE SET started_at = now();

  -- The attempt's last claim: a replaced attempt keeps it in the unresolved record; the current one in
  -- checkout_operations.updated_at (every claim and reclaim sets it).
  SELECT u.last_claimed_at INTO v_last_claim FROM public.checkout_unresolved_operations u
  WHERE u.user_id = p_user_id AND u.operation_id = p_operation_id;
  IF NOT FOUND THEN
    SELECT o.updated_at INTO v_last_claim FROM public.checkout_operations o
    WHERE o.user_id = p_user_id AND o.operation_id = p_operation_id AND o.state = 'creating';
  END IF;
  IF v_last_claim IS NULL THEN
    RAISE EXCEPTION 'operation_not_unresolved';
  END IF;
  IF v_last_claim > now() - interval '15 minutes' THEN
    RAISE EXCEPTION 'attempt_may_still_be_running';
  END IF;

  IF p_session_id IS NOT NULL THEN
    INSERT INTO public.checkout_session_history (user_id, stripe_session_id, expires_at)
    VALUES (p_user_id, p_session_id, NULL)
    ON CONFLICT (user_id, stripe_session_id) DO NOTHING;
  END IF;

  DELETE FROM public.checkout_unresolved_operations WHERE user_id = p_user_id AND operation_id = p_operation_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  UPDATE public.checkout_operations SET state = 'failed', updated_at = now()
  WHERE user_id = p_user_id AND operation_id = p_operation_id AND state = 'creating';
  GET DIAGNOSTICS v_closed = ROW_COUNT;
  IF v_removed = 0 AND v_closed = 0 THEN
    RAISE EXCEPTION 'operation_not_unresolved';
  END IF;
  RETURN jsonb_build_object('resolved', true, 'session_recorded', p_session_id IS NOT NULL);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.resolve_checkout_outcome(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.resolve_checkout_outcome(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.resolve_checkout_outcome(uuid, uuid, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_checkout_outcome(uuid, uuid, text) TO service_role;

-- ── 4. claim_checkout_operation: the 20260815003056 body, with marked [fence] additions ───────────────
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
  v_session   text;         -- [fence] the session id a new operation would overwrite
  v_started   timestamptz;  -- [fence] when the current operation_id was minted
BEGIN
  IF p_mode NOT IN ('reuse_or_create','reuse_only','fresh_only') THEN
    RAISE EXCEPTION 'invalid_checkout_mode';
  END IF;

  -- [fence] Serialize with begin_account_deletion() and refuse every mode while a fence exists.
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
  INSERT INTO public.checkout_operations (user_id, price_id, operation_id, claim_token, state, created_at, updated_at, operation_started_at)
  VALUES (p_user_id, p_price_id, v_new_op, v_new_tok, 'creating', v_now, v_now, v_now)
  ON CONFLICT (user_id) DO NOTHING;
  IF FOUND THEN
    RETURN jsonb_build_object('result','claimed','operation_id',v_new_op,'claim_token',v_new_tok);
  END IF;

  -- Row already exists — read it.
  SELECT state, price_id, checkout_url, operation_id, claim_token, expires_at, updated_at, stripe_session_id, operation_started_at
  INTO   v_state, v_price, v_url, v_op, v_token, v_expires, v_updated, v_session, v_started
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
    -- [fence] Replaying the same idempotency key returns the ORIGINAL session only while Stripe certainly
    -- still retains the key. Same price within that window: replay (unchanged behaviour).
    IF v_price = p_price_id AND v_started IS NOT NULL AND v_now - v_started < interval '23 hours' THEN
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
      -- DIFFERENT price, or the key may have lapsed: mint a NEW operation_id (never reuse a key across
      -- params, never replay a possibly-lapsed key), new token, and clear stored session fields — atomically.
      -- [fence] The discarded operation never reported a session: record it, so its outcome is not lost.
      v_new_op  := gen_random_uuid();
      v_new_tok := gen_random_uuid();
      UPDATE public.checkout_operations
      SET    operation_id = v_new_op, claim_token = v_new_tok, price_id = p_price_id,
             state = 'creating', stripe_session_id = NULL, checkout_url = NULL,
             expires_at = NULL, updated_at = v_now, operation_started_at = v_now
      WHERE  user_id = p_user_id AND state = 'creating' AND updated_at = v_updated;  -- CAS
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows > 0 THEN
        INSERT INTO public.checkout_unresolved_operations (user_id, operation_id, price_id, last_claimed_at, reason)
        VALUES (p_user_id, v_op, v_price, v_updated,
                CASE WHEN v_price = p_price_id THEN 'reclaimed_after_key_retention' ELSE 'replaced_different_price' END)
        ON CONFLICT (user_id, operation_id) DO NOTHING;
        RETURN jsonb_build_object('result','claimed','operation_id',v_new_op,'claim_token',v_new_tok);
      END IF;
    END IF;
    RETURN jsonb_build_object('result','in_progress');  -- lost the reclaim race
  END IF;

  -- [fence] Keep the session id a new operation is about to overwrite, whatever its expiry: a completed
  -- session started a subscription that continues after the payment page expired.
  IF v_session IS NOT NULL THEN
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
         expires_at = NULL, updated_at = v_now, operation_started_at = v_now
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

-- ── 5. finalize_checkout_operation: the 20260815003056 body, with marked [fence] additions ────────────
CREATE OR REPLACE FUNCTION public.finalize_checkout_operation(
  p_user_id      uuid,
  p_claim_token  uuid,
  p_state        text,
  p_session_id   text        DEFAULT NULL,
  p_checkout_url text        DEFAULT NULL,
  p_expires_at   timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_state NOT IN ('ready','failed') THEN
    RAISE EXCEPTION 'invalid_finalize_state';
  END IF;

  -- [fence] Same lock as claim / begin_account_deletion / resolve_checkout_outcome, taken BEFORE the row
  -- lock so the lock order is the same everywhere.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('funnl:billing:' || p_user_id::text, 0));

  UPDATE public.checkout_operations
  SET    state              = p_state,
         stripe_session_id  = CASE WHEN p_state = 'ready' THEN p_session_id   ELSE stripe_session_id END,
         checkout_url       = CASE WHEN p_state = 'ready' THEN p_checkout_url ELSE checkout_url       END,
         expires_at         = CASE WHEN p_state = 'ready' THEN p_expires_at   ELSE expires_at         END,
         updated_at         = now()
  WHERE  user_id     = p_user_id
    AND  claim_token = p_claim_token   -- ownership validation (rotated on reclaim)
    AND  state       = 'creating';     -- terminal rows can never be re-finalized

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- [fence] A late request whose operation was reclaimed, replaced or closed meanwhile still obtained a
  -- real session from Stripe: keep it, so deletion reconciles it with Stripe instead of losing it.
  IF v_rows = 0 AND p_state = 'ready' AND p_session_id IS NOT NULL THEN
    INSERT INTO public.checkout_session_history (user_id, stripe_session_id, expires_at)
    VALUES (p_user_id, p_session_id, p_expires_at)
    ON CONFLICT (user_id, stripe_session_id) DO NOTHING;
  END IF;

  RETURN v_rows > 0;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finalize_checkout_operation(uuid, uuid, text, text, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.finalize_checkout_operation(uuid, uuid, text, text, text, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION public.finalize_checkout_operation(uuid, uuid, text, text, text, timestamptz) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.finalize_checkout_operation(uuid, uuid, text, text, text, timestamptz) TO service_role;
