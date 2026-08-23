-- ── Migration: add_checkout_session_singleflight ──────────────────────────────
--
-- DO NOT APPLY in this task. Local + unapplied. Generated via
--   npx supabase migration new add_checkout_session_singleflight
--
-- PREREQUISITE: 20260812000000_add_subscriptions.sql applied (subscriptions table).
--
-- PURPOSE
-- ═══════
-- Durable, cross-instance single-flight protection for Stripe Checkout Session
-- creation. React `createActionGuard()` only protects ONE mounted component; it does
-- nothing across tabs, devices, sessions, or direct authenticated function calls.
-- Without a server-side guard, two concurrent create-checkout-session invocations can
-- both observe "no active subscription" and create TWO Stripe Checkout Sessions,
-- both of which can be paid, producing duplicate billing that the one-row-per-user
-- subscriptions table cannot represent.
--
-- DESIGN — one row per user in `checkout_operations`, mutated through two
-- SECURITY DEFINER RPCs:
--
--   claim_checkout_operation(user, price, allow_create, stale_seconds)
--     Atomically decides what a caller may do:
--       {result:'reuse',   checkout_url, operation_id}   — an unexpired ready session
--                                                            for this price already
--                                                            exists; reuse its URL,
--                                                            no Stripe call.
--       {result:'claimed', operation_id, claim_token}    — this caller owns creation;
--                                                            it (and only it) calls
--                                                            Stripe using operation_id
--                                                            as the idempotency key.
--       {result:'in_progress'}                           — another instance is creating
--                                                            (recent), or lost a race →
--                                                            caller returns 409/503,
--                                                            NO Stripe call.
--       {result:'blocked_no_reuse'}                      — allow_create=false and no
--                                                            reusable session (used for
--                                                            'incomplete' subscription
--                                                            state).
--
--     Concurrency: a fresh INSERT ... ON CONFLICT (user_id) DO NOTHING means the FIRST
--     concurrent first-timer wins ('claimed'); the loser sees a recent 'creating' row
--     and gets 'in_progress'. Exactly one Stripe call.
--
--     Crash-safety: `operation_id` is persisted BEFORE any Stripe call and is the
--     Stripe Idempotency-Key. If Stripe creates the session but the Edge Function
--     crashes before finalize, the row stays 'creating'; after `stale_seconds` the next
--     request CAS-reclaims it, REUSING THE SAME operation_id (so Stripe returns the
--     already-created session) and rotating only the opaque ownership `claim_token`.
--     A new operation_id is generated ONLY when starting a genuinely new operation
--     (previous op failed / expired / different price) — never during stale recovery
--     of the same operation.
--
--   finalize_checkout_operation(user, claim_token, state, session_id, url, expires_at)
--     Token-validated finalize. UPDATE requires claim_token match AND state='creating',
--     so (a) a reclaimed old owner cannot finalize (its token was rotated), and (b) a
--     terminal row ('ready'/'failed') can never be finalized twice.
--
-- IDEMPOTENCY-KEY PRIVACY: operation_id is a server-generated opaque UUID. It contains
-- no user_id, email, or other identifier. The Edge Function builds the Stripe key as
-- `checkout-op-<operation_id>` — no PII.
--
-- VERIFICATION AFTER RUNNING (read-only):
--   SELECT relrowsecurity FROM pg_class WHERE relname='checkout_operations';                       -- true
--   SELECT has_table_privilege('authenticated','public.checkout_operations','SELECT');             -- false
--   SELECT has_table_privilege('service_role','public.checkout_operations','INSERT');              -- true
--   SELECT has_function_privilege('service_role','public.claim_checkout_operation(uuid,text,text,integer)','EXECUTE');   -- true
--   SELECT has_function_privilege('authenticated','public.claim_checkout_operation(uuid,text,text,integer)','EXECUTE');  -- false
--   SELECT has_function_privilege('service_role','public.finalize_checkout_operation(uuid,uuid,text,text,text,timestamptz)','EXECUTE'); -- true
--
-- CHECKOUT MODE (p_mode) — set by the backend from the subscription-status policy:
--   'reuse_or_create'  (status none)                 reuse an unexpired ready session if present, else create.
--   'reuse_only'       (status incomplete)           reuse an unexpired ready session ONLY; never create → blocked_no_reuse.
--   'fresh_only'       (status canceled/incomplete_expired)  NEVER reuse an old ready session (it may be a completed/obsolete
--                                                    payment attempt); always start a genuinely new operation atomically.
--   (block statuses never reach this RPC — the backend returns 409 first.)
--
-- SAME- vs DIFFERENT-PRICE stale recovery: a stale 'creating' row for the SAME configured
-- price retains its operation_id (so the Stripe idempotency key is reused and Stripe returns
-- the same session); a stale 'creating' row for a DIFFERENT price mints a NEW operation_id +
-- token and clears stored session fields (reusing the key with different params is invalid).

-- ── 1. checkout_operations table ────────────────────────────────────────────────
CREATE TABLE public.checkout_operations (
  user_id            uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  price_id           text        NOT NULL,                          -- non-sensitive product discriminator
  operation_id       uuid        NOT NULL DEFAULT gen_random_uuid(),-- opaque Stripe idempotency seed (no PII)
  claim_token        uuid        NOT NULL DEFAULT gen_random_uuid(),-- rotating ownership token
  stripe_session_id  text,                                          -- set after Stripe returns
  checkout_url       text,                                          -- validated URL, kept for reuse
  state              text        NOT NULL DEFAULT 'creating',       -- creating | ready | failed
  expires_at         timestamptz,                                   -- Stripe session expires_at
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT checkout_operations_state_check CHECK (state IN ('creating','ready','failed'))
);

ALTER TABLE public.checkout_operations ENABLE ROW LEVEL SECURITY;

-- Internal machinery: only the Edge Function (service_role) may touch it.
REVOKE ALL ON TABLE public.checkout_operations FROM PUBLIC;
REVOKE ALL ON TABLE public.checkout_operations FROM anon;
REVOKE ALL ON TABLE public.checkout_operations FROM authenticated;
GRANT ALL ON TABLE public.checkout_operations TO service_role;

-- ── 2. claim_checkout_operation() ───────────────────────────────────────────────
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
BEGIN
  IF p_mode NOT IN ('reuse_or_create','reuse_only','fresh_only') THEN
    RAISE EXCEPTION 'invalid_checkout_mode';
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
  SELECT state, price_id, checkout_url, operation_id, claim_token, expires_at, updated_at
  INTO   v_state, v_price, v_url, v_op, v_token, v_expires, v_updated
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

-- ── 3. finalize_checkout_operation() ────────────────────────────────────────────
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
  RETURN v_rows > 0;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finalize_checkout_operation(uuid, uuid, text, text, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.finalize_checkout_operation(uuid, uuid, text, text, text, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION public.finalize_checkout_operation(uuid, uuid, text, text, text, timestamptz) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.finalize_checkout_operation(uuid, uuid, text, text, text, timestamptz) TO service_role;
