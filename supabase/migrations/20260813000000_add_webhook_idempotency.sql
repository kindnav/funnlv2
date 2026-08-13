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
-- Adds two mechanisms for robust Stripe webhook processing:
--
-- 1. stripe_webhook_events (deduplication table)
--    Provides true idempotency — prevents double-processing of duplicate webhook
--    deliveries. Stripe may deliver the same event more than once. Without this
--    table, a retry of a DB-failed event would run the handler logic twice.
--
-- 2. last_stripe_event_at column on subscriptions (ordering guard)
--    Prevents older lifecycle events from overwriting newer subscription state.
--    Stripe does not guarantee delivery order for events that fire in quick
--    succession (e.g. subscription.updated followed by subscription.updated).
--    By recording the timestamp of the most-recently applied event, we can
--    reject an older event that arrives late.
--
-- OUT-OF-ORDER STRATEGY: "persist latest applied event timestamp"
-- ════════════════════════════════════════════════════════════════
-- Strategy chosen: record last_stripe_event_at on subscriptions and reject
-- incoming events with an older created timestamp.
--
-- Why this strategy over "fetch current Stripe state":
--   - No additional Stripe API call per webhook (lower latency, no rate-limit risk)
--   - Simpler error surface — no network hop inside the webhook handler
--   - Stripe events carry a reliable created timestamp (Unix epoch, set by Stripe)
--   - Sufficient for the actual out-of-order scenarios we face (rapid consecutive
--     subscription.updated events from status changes, renewals, cancellations)
--   - "Fetch current state" is preferred when idempotency of individual fields
--     matters (e.g. partial updates) — not needed here since we overwrite all fields
--
-- DEDUPLICATION STRATEGY
-- ══════════════════════
-- INSERT ... ON CONFLICT DO NOTHING on stripe_webhook_events before any DB writes.
-- If the event_id already exists in the table, the conflict is caught and the
-- handler returns 200 immediately — the event was already processed.
--
-- Status column lifecycle:
--   processing → set at INSERT (event received, handler started)
--   processed  → set when all DB writes succeed
--   failed     → set when a DB write fails after the event was already inserted
--   ignored    → set for events that are valid but intentionally skipped
--                (unhandled type, price mismatch, informational-only)
--
-- A 'failed' event in this table means Stripe will retry (because the handler
-- returned 500), and the next delivery will conflict on event_id and be skipped.
-- This is intentional: the edge case of "first delivery failed, second delivery
-- would succeed" is handled by fixing the root cause (DB issue) and manually
-- retrying from the Stripe dashboard, not by letting both deliveries race.
--
-- VERIFICATION AFTER RUNNING (read-only checks, do not modify production):
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'stripe_webhook_events';  -- true
--   SELECT has_table_privilege('service_role','public.stripe_webhook_events','INSERT');  -- true
--   SELECT has_table_privilege('authenticated','public.stripe_webhook_events','INSERT'); -- false
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'subscriptions' AND column_name = 'last_stripe_event_at';

-- ── 1. stripe_webhook_events ──────────────────────────────────────────────────

CREATE TABLE public.stripe_webhook_events (
  event_id          text        PRIMARY KEY,                     -- Stripe evt_xxx ID
  event_type        text        NOT NULL,
  stripe_created_at timestamptz NOT NULL,                        -- Stripe event created timestamp
  status            text        NOT NULL DEFAULT 'processing',
  processed_at      timestamptz,                                 -- when status → processed/failed/ignored
  failure_code      text,                                        -- controlled code when status = failed
  created_at        timestamptz NOT NULL DEFAULT now(),          -- when our handler first saw this event

  CONSTRAINT stripe_webhook_events_status_check CHECK (
    status IN ('processing', 'processed', 'failed', 'ignored')
  )
);

-- Only stripe-webhook Edge Function (service_role) may read or write this table.
-- No authenticated user access — this is purely internal webhook machinery.
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.stripe_webhook_events FROM PUBLIC;
REVOKE ALL ON TABLE public.stripe_webhook_events FROM anon;
REVOKE ALL ON TABLE public.stripe_webhook_events FROM authenticated;
GRANT ALL ON TABLE public.stripe_webhook_events TO service_role;

-- Partial index for querying recent unresolved events (monitoring/alerting queries).
CREATE INDEX stripe_webhook_events_unresolved_idx
  ON public.stripe_webhook_events (stripe_created_at DESC)
  WHERE status IN ('processing', 'failed');

-- ── 2. Add last_stripe_event_at to subscriptions ─────────────────────────────
--
-- Records the created timestamp of the most-recently applied Stripe event for
-- this subscription. Any incoming subscription lifecycle event with an older
-- created timestamp is rejected and acknowledged as 200 (already surpassed).
--
-- NULL means no event has been applied yet (normal for the initial checkout.session.completed
-- upsert which runs before any subscription events arrive).

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS last_stripe_event_at timestamptz;

-- Index to support quick comparisons in the webhook handler.
CREATE INDEX subscriptions_last_stripe_event_idx
  ON public.subscriptions (user_id, last_stripe_event_at);
