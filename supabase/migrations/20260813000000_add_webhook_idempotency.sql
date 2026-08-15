-- ── Migration: add_webhook_idempotency ────────────────────────────────────────
--
-- DO NOT APPLY: This migration is designed but not yet applied to production.
-- It requires deployment of the updated stripe-webhook Edge Function that reads
-- from this table. Apply the migration first, then deploy the Edge Function.
--
-- PREREQUISITE: 20260812000000_add_subscriptions.sql must be applied first.
--
-- PURPOSE
-- ═══════
-- Adds atomic idempotency for Stripe webhook processing via:
--
-- 1. stripe_webhook_events table
--    Tracks every Stripe event ID. The claim_webhook_event() function provides
--    atomic claim/retry semantics so duplicate Stripe deliveries are safely
--    deduplicated without processing an event twice.
--
-- 2. claim_webhook_event() PL/pgSQL function
--    Atomically claims an event for processing. Handles:
--      - New events    → INSERT, return {result:'claimed', claim_token:<uuid>}
--      - Duplicates    → already processed/ignored, return {result:'duplicate'}
--      - Retries       → failed events, reclaim and return {result:'claimed', ...}
--      - Stale locks   → processing row older than 5 min (crashed handler),
--                        CAS reclaim and return {result:'claimed', ...}
--                        Only one stale claimant wins (compare-and-swap on created_at).
--      - In-progress   → recent active handler, return {result:'in_progress'}
--
-- 3. mark_webhook_event() PL/pgSQL function
--    Finalizes an event's status. Validates the claim_token matches before
--    updating — prevents stale handlers (those that crashed and were reclaimed)
--    from overwriting the new handler's row. Returns TRUE on success, FALSE
--    when the token does not match (reclaimed by another handler).
--
-- OUT-OF-ORDER STRATEGY: "authoritative Stripe retrieval"
-- ════════════════════════════════════════════════════════
-- Out-of-order events are handled by fetching the current subscription state
-- from GET /v1/subscriptions/{id} before every subscription write. This avoids
-- the need for timestamp ordering (no last_stripe_event_at column).
--
-- STATUS LIFECYCLE
-- ════════════════
--   processing  → claim_webhook_event() INSERT (event received, handler started)
--   processed   → mark_webhook_event() marks after all DB writes succeed
--   failed      → mark_webhook_event() marks when a DB write fails; reclaimable
--   ignored     → mark_webhook_event() marks for valid but intentionally skipped
--                 events (unhandled type, price mismatch, informational-only)
--
-- FAILURE CODE ALLOWLIST (enforced by CHECK constraint)
-- ══════════════════════════════════════════════════════
--   missing_user_id        — checkout missing valid user_id
--   missing_ids            — checkout missing customer or subscription ID
--   config_missing         — STRIPE_SECRET_KEY or STRIPE_PRO_PRICE_ID not set
--   stripe_fetch_failed    — GET /v1/subscriptions/{id} call failed
--   ownership_lookup_failed — DB error during user_id lookup
--   owner_not_found        — no matching user found for entitlement event
--   db_write_failed        — subscriptions table upsert/update failed
--   handler_exception      — unexpected exception during event processing
--   invalid_event          — signed event has malformed ID, type, created, or data
--   invalid_status         — Stripe returned a subscription status not in allowlist
--
-- CRASH RECOVERY
-- ══════════════
-- If a handler crashes (e.g., Edge Function cold-start kill), the row stays in
-- 'processing'. The next Stripe delivery reclaims it after 5 minutes using a
-- compare-and-swap UPDATE (WHERE event_id = p_event_id AND status = 'processing'
-- AND created_at = v_created_at). Only the first concurrent reclaimer wins;
-- others see 0 rows updated and fall through to 'in_progress'.
--
-- VERIFICATION AFTER RUNNING (read-only checks, do not modify production):
--   -- Table exists with correct columns
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'stripe_webhook_events'
--     ORDER BY ordinal_position;
--   -- RLS enabled
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'stripe_webhook_events';  -- true
--   -- Only service_role may write
--   SELECT has_table_privilege('service_role','public.stripe_webhook_events','INSERT');  -- true
--   SELECT has_table_privilege('authenticated','public.stripe_webhook_events','INSERT'); -- false
--   SELECT has_table_privilege('anon','public.stripe_webhook_events','INSERT'); -- false
--   -- Functions callable only by service_role
--   SELECT has_function_privilege('service_role','public.claim_webhook_event(text,text,timestamptz)','EXECUTE'); -- true
--   SELECT has_function_privilege('authenticated','public.claim_webhook_event(text,text,timestamptz)','EXECUTE'); -- false
--   SELECT has_function_privilege('service_role','public.mark_webhook_event(text,uuid,text,text)','EXECUTE'); -- true
--   SELECT has_function_privilege('authenticated','public.mark_webhook_event(text,uuid,text,text)','EXECUTE'); -- false

-- ── 1. stripe_webhook_events ──────────────────────────────────────────────────

CREATE TABLE public.stripe_webhook_events (
  event_id          text        PRIMARY KEY,                     -- Stripe evt_xxx ID
  event_type        text        NOT NULL,
  stripe_created_at timestamptz NOT NULL,                        -- Stripe event created timestamp
  status            text        NOT NULL DEFAULT 'processing',
  claim_token       uuid        NOT NULL DEFAULT gen_random_uuid(), -- C2: ownership token for mark_webhook_event
  processed_at      timestamptz,                                 -- when status → processed/failed/ignored
  failure_code      text,                                        -- controlled code when status = 'failed'
  created_at        timestamptz NOT NULL DEFAULT now(),          -- when our handler first claimed this event

  -- C9: Status must be one of four lifecycle states.
  CONSTRAINT stripe_webhook_events_status_check CHECK (
    status IN ('processing', 'processed', 'failed', 'ignored')
  ),

  -- C9: failure_code is restricted to the documented allowlist when set.
  CONSTRAINT stripe_webhook_events_failure_code_check CHECK (
    failure_code IN (
      'missing_user_id', 'missing_ids', 'config_missing', 'stripe_fetch_failed',
      'ownership_lookup_failed', 'owner_not_found', 'db_write_failed',
      'handler_exception', 'invalid_event', 'invalid_status'
    )
  ),

  -- C9: failed status requires a failure_code; failure_code requires failed status.
  -- Enforces consistent use of both fields together.
  CONSTRAINT stripe_webhook_events_failure_consistency CHECK (
    (status = 'failed') = (failure_code IS NOT NULL)
  )
);

-- Only the stripe-webhook Edge Function (service_role) may read or write this table.
-- No authenticated user access — this is purely internal webhook machinery.
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.stripe_webhook_events FROM PUBLIC;
REVOKE ALL ON TABLE public.stripe_webhook_events FROM anon;
REVOKE ALL ON TABLE public.stripe_webhook_events FROM authenticated;
GRANT ALL ON TABLE public.stripe_webhook_events TO service_role;

-- Partial index for monitoring unresolved events (monitoring/alerting queries only).
CREATE INDEX stripe_webhook_events_unresolved_idx
  ON public.stripe_webhook_events (stripe_created_at DESC)
  WHERE status IN ('processing', 'failed');

-- ── 2. claim_webhook_event() ──────────────────────────────────────────────────
--
-- Atomically claims a Stripe event for processing.
--
-- Returns JSONB with shape:
--   {result: 'claimed',     claim_token: '<uuid>'}  → caller processes and marks
--   {result: 'duplicate'}                            → already done; return 200
--   {result: 'in_progress'}                          → active handler; return 503
--
-- C1 — CAS stale reclaim: when a processing row is older than 5 minutes, the
-- stale-reclaim UPDATE includes AND created_at = v_created_at. Only the first
-- concurrent reclaimer wins; others see 0 rows affected and fall through to
-- in_progress. This prevents two handlers both believing they have the claim.
--
-- C2 — claim_token: a fresh uuid is generated on every claim (INSERT for new
-- events, UPDATE for retries and stale reclaims). The token is returned in the
-- JSONB payload and stored in the row. mark_webhook_event() validates the token
-- before finalizing the row, ensuring that a stale handler cannot overwrite a
-- newer claimant's processing row.
--
-- Calling convention:
--   p_event_id   — Stripe event ID (e.g. 'evt_1AbcDef...')
--   p_event_type — Stripe event type (e.g. 'customer.subscription.created')
--   p_created_at — event created timestamp from Stripe payload (Unix epoch converted)
--
-- SECURITY: callable by service_role only. SECURITY DEFINER so the function
-- can bypass RLS. SET search_path = '' prevents search_path injection.

CREATE OR REPLACE FUNCTION public.claim_webhook_event(
  p_event_id   text,
  p_event_type text,
  p_created_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status      text;
  v_created_at  timestamptz;
  v_claim_token uuid;
  v_new_token   uuid;
  v_rows        integer;
BEGIN
  -- Attempt to INSERT a new 'processing' row with a fresh claim_token.
  -- ON CONFLICT DO NOTHING is a no-op if the event_id already exists.
  -- FOUND is true only on a real INSERT.
  v_new_token := gen_random_uuid();
  INSERT INTO public.stripe_webhook_events (event_id, event_type, stripe_created_at, status, claim_token, created_at)
  VALUES (p_event_id, p_event_type, p_created_at, 'processing', v_new_token, now())
  ON CONFLICT (event_id) DO NOTHING;

  IF FOUND THEN
    -- New row inserted — this handler owns processing of this event.
    RETURN jsonb_build_object('result', 'claimed', 'claim_token', v_new_token);
  END IF;

  -- Row already exists. Read its current state.
  SELECT status, created_at, claim_token
  INTO   v_status, v_created_at, v_claim_token
  FROM   public.stripe_webhook_events
  WHERE  event_id = p_event_id;

  -- Already processed or intentionally ignored — safe to acknowledge as duplicate.
  IF v_status IN ('processed', 'ignored') THEN
    RETURN jsonb_build_object('result', 'duplicate');
  END IF;

  -- Previous handler failed. Reclaim the row with a fresh claim_token.
  -- WHERE status = 'failed' ensures atomicity: if two deliveries race here,
  -- only one UPDATE wins; the other sees 0 rows and falls through to in_progress.
  IF v_status = 'failed' THEN
    v_new_token := gen_random_uuid();
    UPDATE public.stripe_webhook_events
    SET    status       = 'processing',
           claim_token  = v_new_token,
           created_at   = now(),
           processed_at = NULL,
           failure_code = NULL
    WHERE  event_id = p_event_id
      AND  status   = 'failed';

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      RETURN jsonb_build_object('result', 'claimed', 'claim_token', v_new_token);
    END IF;
    RETURN jsonb_build_object('result', 'in_progress');
  END IF;

  -- Row is in 'processing'. Check whether it is stale (crashed handler).
  -- 5-minute threshold exceeds any realistic Edge Function execution time.
  IF v_status = 'processing' AND now() - v_created_at > interval '5 minutes' THEN
    -- C1: CAS reclaim — require the exact created_at we read above.
    -- If another handler already reclaimed the row, its UPDATE will have changed
    -- created_at, so our WHERE clause will match zero rows (we lose the race).
    -- Only the first reclaimer wins and proceeds; others fall through to in_progress.
    v_new_token := gen_random_uuid();
    UPDATE public.stripe_webhook_events
    SET    claim_token = v_new_token,
           created_at  = now()
    WHERE  event_id   = p_event_id
      AND  status     = 'processing'
      AND  created_at = v_created_at;   -- C1: compare-and-swap on the exact timestamp

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      RETURN jsonb_build_object('result', 'claimed', 'claim_token', v_new_token);
    END IF;
    RETURN jsonb_build_object('result', 'in_progress');
  END IF;

  -- Row is in 'processing' and was recently created — another handler is active.
  -- Tell the caller to return 503 so Stripe retries later.
  RETURN jsonb_build_object('result', 'in_progress');
END;
$$;

-- Lock down execute permissions.
REVOKE EXECUTE ON FUNCTION public.claim_webhook_event(text, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_webhook_event(text, text, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_webhook_event(text, text, timestamptz) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_webhook_event(text, text, timestamptz) TO service_role;

-- ── 3. mark_webhook_event() ────────────────────────────────────────────────────
--
-- Finalizes a claimed event's status. Validates the claim_token before updating
-- to ensure a stale handler cannot overwrite a newer claimant's row.
--
-- C2 — token ownership: only the handler holding the matching claim_token may
-- finalize the row. A stale handler that was reclaimed by a new claimant will
-- have a different token in memory and will fail the WHERE clause, returning FALSE.
-- The new claimant's row is unaffected.
--
-- C3 — DB error surfacing: the Edge Function inspects the returned boolean.
-- FALSE means the row was NOT finalized by this call (see below). The handler
-- must treat FALSE as "claim ownership lost" and return a retryable non-2xx
-- (503) so Stripe retries; a later retry hits `duplicate` once the true owner
-- finalizes. A Supabase RPC error (not FALSE) means the DB call itself failed
-- and the caller returns 500.
--
-- HARDENING — the UPDATE additionally requires status = 'processing':
--   1. A stale handler that was reclaimed by a newer claimant holds a token that
--      no longer matches → 0 rows → FALSE. (token-ownership validation)
--   2. A row already in a terminal state ('processed'/'ignored'/'failed') can
--      NEVER be finalized a second time — even with the original matching token —
--      because status is no longer 'processing' → 0 rows → FALSE. This makes
--      finalization strictly a single processing → terminal transition.
--
-- Parameters:
--   p_event_id    — Stripe event ID to finalize
--   p_claim_token — claim_token received from claim_webhook_event(); must match row
--   p_status      — final status: 'processed', 'ignored', or 'failed'
--   p_failure_code — required when p_status = 'failed'; NULL otherwise
--
-- Returns:
--   TRUE  — row transitioned processing → terminal (this handler still owns the claim)
--   FALSE — token mismatch OR row was not in 'processing' (reclaimed, or already
--           terminal). Non-fatal at the DB layer, but the handler treats it as a
--           retryable ownership-loss condition.
--
-- SECURITY: callable by service_role only. Not callable by anon or authenticated.
-- SECURITY DEFINER to bypass RLS. SET search_path = '' prevents injection.

CREATE OR REPLACE FUNCTION public.mark_webhook_event(
  p_event_id     text,
  p_claim_token  uuid,
  p_status       text,
  p_failure_code text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.stripe_webhook_events
  SET    status       = p_status,
         failure_code = p_failure_code,
         processed_at = now()
  WHERE  event_id    = p_event_id
    AND  claim_token = p_claim_token   -- token ownership validation
    AND  status      = 'processing';   -- only a live claim may transition to terminal

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- Lock down execute permissions.
REVOKE EXECUTE ON FUNCTION public.mark_webhook_event(text, uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mark_webhook_event(text, uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.mark_webhook_event(text, uuid, text, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.mark_webhook_event(text, uuid, text, text) TO service_role;
