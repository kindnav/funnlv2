-- ─────────────────────────────────────────────────────────────────────────────
--  Gmail pilot retention blockers — whole-Google disconnect context erasure +
--  bounded, index-backed pending-context expiry.
--
--  Forward-only. No applied migration is edited. No table is created, dropped, or
--  renamed. No new column. No client-facing grant changes. No scheduler here (the
--  Cron job lives in its own later migration so it can be the LAST rollout step).
--
--  Blocker 1 — whole-Google/Calendar disconnect left pending Gmail context behind.
--    `disconnect_my_gmail()` erases pending Gmail suggestions and their retained
--    subjects, but the whole-Google path (google-oauth-disconnect and delete-account
--    via shared/googleCleanup.js) deleted `google_oauth_states` + `google_connections`
--    with two independent client calls and never touched `interaction_candidates`.
--    The cascade from `google_connections` removes tokens, capabilities, the Gmail
--    cursor and `email_candidate_refs`, but a pending Gmail candidate (and its
--    `retained_subject`) is keyed to the USER, not the connection, so it survived.
--    Fix: ONE service-only SECURITY DEFINER RPC does all three steps in a single
--    transaction, so the local state can never be left half-cleaned.
--
--  Blocker 2 — `expire_pending_email_context()` was an unbounded all-user sweep with
--    no ordering, no lock-skip, and no supporting index. It is replaced (DROP + CREATE,
--    never CREATE OR REPLACE with a different signature, which would leave the old
--    overload behind) by a bounded, deterministic, SKIP LOCKED, index-backed batch
--    function that returns controlled counts only.
--
--  Blocker 3 — tombstone retention is a DECISION, not a schema change: the minimal
--    terminal candidate row + its one-way HMAC `source_fingerprint` persist until the
--    contact or the account is deleted (existing ON DELETE CASCADE FKs). Nothing in
--    this migration deletes a candidate row. See tests/gmail-retention-invariants.test.js.
-- ─────────────────────────────────────────────────────────────────────────────


-- ══════════════════════════════════════════════════════════════════════════════
--  1. Partial index backing the bounded expiry scan
-- ══════════════════════════════════════════════════════════════════════════════
-- Only PENDING rows that still carry a context deadline are indexed, ordered by the
-- deadline then id (the deterministic batch order below). Every row the expiry
-- function processes has its `context_expires_at` set to NULL, so it LEAVES the
-- index: the backlog drains and the index stays tiny. Terminal rows (accepted /
-- dismissed / invalidated) never carry a deadline and are never indexed here.

CREATE INDEX IF NOT EXISTS interaction_candidates_pending_context_expiry_idx
  ON public.interaction_candidates (context_expires_at, id)
  WHERE status = 'pending' AND context_expires_at IS NOT NULL;


-- ══════════════════════════════════════════════════════════════════════════════
--  2. Bounded pending-context expiry (replaces the unbounded zero-arg version)
-- ══════════════════════════════════════════════════════════════════════════════
-- Contract (service_role / scheduler only):
--   * touches ONLY rows with status = 'pending' AND context_expires_at <= now();
--   * erases `retained_subject` and `context_expires_at`, bumps `updated_at`;
--   * never changes `status`, `source_fingerprint`, `contact_id`, `interaction_id`,
--     or any accepted interaction — the suggestion stays pending (without its
--     subject preview) and the dedup tombstone is untouched;
--   * never inspects, calls, or references Gmail or any provider;
--   * processes at most p_batch_size rows (1..5000, default 500) in deterministic
--     (context_expires_at, id) order;
--   * FOR UPDATE SKIP LOCKED: two overlapping executions never block on or double-
--     process the same row; each just takes the next unlocked slice;
--   * idempotent: a processed row no longer matches the predicate;
--   * returns controlled codes/counts only — never a subject, id list, or user id.
--
-- The zero-arg overload must be DROPPED first: a CREATE OR REPLACE with a new
-- signature would silently create a second function and leave the unbounded one
-- callable (the E2A lesson).

DROP FUNCTION IF EXISTS public.expire_pending_email_context();

CREATE FUNCTION public.expire_pending_email_context(p_batch_size integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n    integer := 0;
  v_more boolean := false;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 5000 THEN
    RETURN jsonb_build_object('result', 'invalid_batch_size');
  END IF;

  WITH due AS (
    SELECT id
    FROM public.interaction_candidates
    WHERE status = 'pending'
      AND context_expires_at IS NOT NULL
      AND context_expires_at <= now()
    ORDER BY context_expires_at, id
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.interaction_candidates ic
    SET retained_subject   = NULL,
        context_expires_at = NULL,
        updated_at         = now()
  FROM due
  WHERE ic.id = due.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- Informational: is there a remaining backlog for the next run? (Rows locked by a
  -- concurrent batch also count — harmless; the next scheduled run drains them.)
  SELECT EXISTS (
    SELECT 1 FROM public.interaction_candidates
    WHERE status = 'pending'
      AND context_expires_at IS NOT NULL
      AND context_expires_at <= now()
  ) INTO v_more;

  RETURN jsonb_build_object(
    'result',     'ok',
    'expired',    v_n,
    'batch_size', p_batch_size,
    'more',       v_more
  );
END;
$$;

REVOKE ALL ON FUNCTION public.expire_pending_email_context(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_pending_email_context(integer) TO service_role;


-- ══════════════════════════════════════════════════════════════════════════════
--  3. Atomic whole-Google local cleanup (service_role only)
-- ══════════════════════════════════════════════════════════════════════════════
-- Called by shared/googleCleanup.js (google-oauth-disconnect and delete-account) with
-- the user id the Edge Function derived from the VERIFIED JWT — never from a request
-- body. It is callable only by service_role, so a browser can never aim it at anyone.
--
-- One transaction, three steps, all scoped to p_user_id:
--   1. Every PENDING Gmail suggestion becomes 'invalidated' with `retained_subject`
--      and `context_expires_at` erased. The row and its `source_fingerprint` remain
--      (dedup tombstone). Terminal candidates, accepted interactions, Calendar
--      candidates, and manual interactions are never matched by the predicate.
--   2. `google_oauth_states` rows are deleted.
--   3. The `google_connections` row is deleted; the existing ON DELETE CASCADE
--      removes `google_tokens`, `google_connection_capabilities` (calendar AND gmail),
--      `gmail_sync_state`, `google_calendar_sync_state`, `google_calendar_event_refs`,
--      and `email_candidate_refs` exactly as the two-call version did before.
--
-- Provider revocation is NOT here: the Edge Function still revokes at Google on a
-- best-effort basis BEFORE calling this, and a revoke failure never prevents this
-- local cleanup (that invariant is enforced and tested in googleCleanup.js).
-- Idempotent: with nothing to clean it returns counts of zero, never an error.

CREATE FUNCTION public.run_google_local_cleanup(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cands  integer := 0;
  v_states integer := 0;
  v_conns  integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_user');
  END IF;

  -- 1. Erase pending Gmail context first (same transaction as the deletes below).
  UPDATE public.interaction_candidates
    SET status             = 'invalidated',
        retained_subject   = NULL,
        context_expires_at = NULL,
        updated_at         = now()
  WHERE user_id = p_user_id
    AND source  = 'gmail'
    AND status  = 'pending';
  GET DIAGNOSTICS v_cands = ROW_COUNT;

  -- 2. Pending OAuth handshakes.
  DELETE FROM public.google_oauth_states WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_states = ROW_COUNT;

  -- 3. The connection (cascades tokens / capabilities / cursors / provider refs).
  DELETE FROM public.google_connections WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_conns = ROW_COUNT;

  RETURN jsonb_build_object(
    'result',                       'cleaned',
    'connections_deleted',          v_conns,
    'oauth_states_deleted',         v_states,
    'gmail_candidates_invalidated', v_cands
  );
END;
$$;

REVOKE ALL ON FUNCTION public.run_google_local_cleanup(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_google_local_cleanup(uuid) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
--  Post-apply verification (run read-only after `db push`; expected results):
--    SELECT indexname FROM pg_indexes WHERE tablename = 'interaction_candidates'
--      AND indexname = 'interaction_candidates_pending_context_expiry_idx';   -- 1 row
--    SELECT proname, pg_get_function_identity_arguments(oid) FROM pg_proc
--      WHERE proname = 'expire_pending_email_context';                         -- exactly 1 row: (p_batch_size integer)
--    SELECT has_function_privilege('authenticated', 'public.run_google_local_cleanup(uuid)', 'EXECUTE');  -- false
--    SELECT has_function_privilege('anon', 'public.expire_pending_email_context(integer)', 'EXECUTE');    -- false
--    SELECT count(*) FROM public.interaction_candidates WHERE source = 'gmail';  -- unchanged (0 while dormant)
-- ─────────────────────────────────────────────────────────────────────────────
