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
--      - New events    → INSERT, return 'claimed'
--      - Duplicates    → already processed/ignored, return 'duplicate'
--      - Retries       → failed events, reclaim and return 'claimed'
--      - Stale locks   → processing row older than 5 min (crashed handler),
--                        reclaim and return 'claimed'
--      - In-progress   → recent active handler, return 'in_progress'
--
-- OUT-OF-ORDER STRATEGY: "authoritative Stripe retrieval"
-- ════════════════════════════════════════════════════════
-- Out-of-order events are handled by fetching the current subscription state
-- from GET /v1/subscriptions/{id} before every subscription write. This avoids
-- the need for timestamp ordering (no last_stripe_event_at column).
--
-- Why "authoritative retrieval" over "persist latest applied event timestamp":
--   - Stripe is always the single source of truth for subscription state
--   - Timestamp ordering can fail with clock skew or rapid same-second events
--   - One extra Stripe API call per subscription event is acceptable at student scale
--   - Simplifies the schema: no last_stripe_event_at column to maintain
--
-- STATUS LIFECYCLE
-- ════════════════
--   processing  → claim_webhook_event() INSERT (event received, handler started)
--   processed   → handler marks after all DB writes succeed
--   failed      → handler marks when a DB write fails; reclaimable on next delivery
--   ignored     → handler marks for valid but intentionally skipped events
--                 (unhandled type, price mismatch, informational-only)
--
-- CRASH RECOVERY
-- ══════════════
-- If a handler crashes (e.g., Edge Function cold-start kill), the row stays in
-- 'processing'. The next Stripe delivery reclaims it after 5 minutes by updating
-- the created_at timestamp and returning 'claimed'. The 5-minute threshold exceeds
-- any realistic handler execution time.
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
--   -- Function exists and is callable only by service_role
--   SELECT has_function_privilege('service_role','public.claim_webhook_event(text,text,timestamptz)','EXECUTE'); -- true
--   SELECT has_function_privilege('authenticated','public.claim_webhook_event(text,text,timestamptz)','EXECUTE'); -- false
--   SELECT has_function_privilege('anon','public.claim_webhook_event(text,text,timestamptz)','EXECUTE'); -- false
--   -- subscriptions table does NOT have last_stripe_event_at (this migration removed it from design)
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'subscriptions' AND column_name = 'last_stripe_event_at'; -- (0 rows)

-- ── 1. stripe_webhook_events ──────────────────────────────────────────────────

CREATE TABLE public.stripe_webhook_events (
  event_id          text        PRIMARY KEY,                     -- Stripe evt_xxx ID
  event_type        text        NOT NULL,
  stripe_created_at timestamptz NOT NULL,                        -- Stripe event created timestamp
  status            text        NOT NULL DEFAULT 'processing',
  processed_at      timestamptz,                                 -- when status → processed/failed/ignored
  failure_code      text,                                        -- controlled code when status = 'failed'
  created_at        timestamptz NOT NULL DEFAULT now(),          -- when our handler first saw/claimed this event

  CONSTRAINT stripe_webhook_events_status_check CHECK (
    status IN ('processing', 'processed', 'failed', 'ignored')
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
-- Atomically claims a Stripe event for processing. Returns one of four values:
--
--   'claimed'     → caller should process the event and mark it processed/ignored/failed
--   'duplicate'   → event already processed or ignored — caller should return 200 immediately
--   'in_progress' → a recent handler is actively processing this event — caller should
--                   return 503 so Stripe retries later
--
-- Calling convention:
--   p_event_id   — Stripe event ID (e.g. 'evt_1AbcDef...')
--   p_event_type — Stripe event type (e.g. 'customer.subscription.created')
--   p_created_at — event created timestamp from Stripe payload (Unix epoch converted to timestamptz)
--
-- SECURITY: callable by service_role only. REVOKE EXECUTE from PUBLIC/anon/authenticated
-- (see grants below). SECURITY DEFINER so the function can bypass RLS on the table.
-- SET search_path = '' prevents search_path injection.

CREATE OR REPLACE FUNCTION public.claim_webhook_event(
  p_event_id   text,
  p_event_type text,
  p_created_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status     text;
  v_created_at timestamptz;
  v_rows       integer;
BEGIN
  -- Attempt to INSERT a new 'processing' row. ON CONFLICT DO NOTHING means this is
  -- a no-op if the event_id already exists. FOUND is true only on a real INSERT.
  INSERT INTO public.stripe_webhook_events (event_id, event_type, stripe_created_at, status, created_at)
  VALUES (p_event_id, p_event_type, p_created_at, 'processing', now())
  ON CONFLICT (event_id) DO NOTHING;

  IF FOUND THEN
    -- New row inserted — this handler owns processing of this event.
    RETURN 'claimed';
  END IF;

  -- Row already exists. Read its current state.
  SELECT status, created_at
  INTO   v_status, v_created_at
  FROM   public.stripe_webhook_events
  WHERE  event_id = p_event_id;

  -- Already processed or intentionally ignored — safe to acknowledge as duplicate.
  IF v_status IN ('processed', 'ignored') THEN
    RETURN 'duplicate';
  END IF;

  -- Previous handler failed. Reclaim the row so this delivery retries processing.
  -- WHERE status = 'failed' ensures atomicity: if two Stripe deliveries race here,
  -- only one UPDATE wins; the other sees 0 rows and falls through to 'in_progress'.
  IF v_status = 'failed' THEN
    UPDATE public.stripe_webhook_events
    SET    status       = 'processing',
           created_at   = now(),
           processed_at = NULL,
           failure_code = NULL
    WHERE  event_id = p_event_id
      AND  status   = 'failed';

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN CASE WHEN v_rows > 0 THEN 'claimed' ELSE 'in_progress' END;
  END IF;

  -- Row is in 'processing' state. Check whether it is stale (crashed handler).
  -- 5-minute threshold exceeds any realistic Edge Function execution time.
  IF v_status = 'processing' AND now() - v_created_at > interval '5 minutes' THEN
    -- Stale lock. Reclaim by refreshing created_at so another delivery gets the
    -- full 5-minute window. WHERE status = 'processing' is the concurrency guard.
    UPDATE public.stripe_webhook_events
    SET    created_at = now()
    WHERE  event_id = p_event_id
      AND  status   = 'processing';

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN CASE WHEN v_rows > 0 THEN 'claimed' ELSE 'in_progress' END;
  END IF;

  -- Row is in 'processing' and was recently created — another handler is active.
  -- Tell the caller to return 503 so Stripe retries later.
  RETURN 'in_progress';
END;
$$;

-- Lock down execute permissions.
REVOKE EXECUTE ON FUNCTION public.claim_webhook_event(text, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_webhook_event(text, text, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_webhook_event(text, text, timestamptz) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_webhook_event(text, text, timestamptz) TO service_role;
