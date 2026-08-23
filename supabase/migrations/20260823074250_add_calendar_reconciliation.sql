-- Google integration — Phase C1: occurrence reconciliation RPC (service-role only).
--
-- WHY: the Phase A RPCs can CREATE/refresh candidates (upsert_calendar_candidate)
-- but none can INVALIDATE a previously-suggested candidate that is no longer
-- justified — e.g. its event/occurrence was cancelled or deleted, the user or the
-- matched contact later declined, the contact was removed from the event, or the
-- match became ambiguous. The C1 sync engine computes, per processed occurrence, the
-- definitive set of fingerprints that SHOULD remain, then calls this RPC to
-- invalidate any PENDING candidate for that occurrence whose fingerprint is not in
-- that keep-set. A cancelled/deleted occurrence passes an EMPTY keep-set, so all its
-- pending candidates are invalidated.
--
-- INVARIANTS:
--   - Run-ID/lease fenced: only the run currently owning an unexpired lease may act;
--     the sync-state row is locked FOR SHARE FIRST (same lock order as
--     upsert_calendar_candidate) so a concurrent claim/renew/release blocks until this
--     transaction commits. A stalled/reclaimed run cannot invalidate newer data.
--   - Ownership verified: the connection belongs to the user AND matches google_sub.
--   - Only status='pending' rows are touched — accepted/dismissed/invalidated are
--     NEVER changed and non-pending rows are NEVER resurrected.
--   - Invalidated candidates + their event_refs REMAIN (status flips to
--     'invalidated'); this tombstone is what prevents re-suggestion, since
--     upsert_calendar_candidate never resurrects a non-pending row.
--   - Group events retain multiple fingerprints (all kept fingerprints survive).
--   - Short transaction, no external calls, no dynamic SQL.
--
-- This migration adds ONLY this RPC. It does not touch tables, other RPCs, sync-token
-- advancement, or completion metadata (release_calendar_sync_lease already records
-- last_run_complete / last_synced_at for a successful run). NOT DEPLOYED by this phase.

CREATE OR REPLACE FUNCTION public.reconcile_calendar_occurrence(
  p_connection_id            uuid,
  p_calendar_id              text,
  p_run_id                   uuid,
  p_user_id                  uuid,
  p_google_sub               text,
  p_google_event_id          text,
  p_original_occurrence_at   timestamptz,
  p_original_occurrence_date date,
  p_keep_fingerprints        text[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_lease integer;
  v_n     integer;
  v_keep  text[] := COALESCE(p_keep_fingerprints, ARRAY[]::text[]);
BEGIN
  -- Validate controlled inputs.
  IF p_calendar_id IS NULL OR p_calendar_id <> 'primary' THEN
    RAISE EXCEPTION 'invalid_calendar_id';
  END IF;
  -- Exactly one occurrence key must be present (mirrors the event_refs XOR).
  IF (p_original_occurrence_at IS NOT NULL) = (p_original_occurrence_date IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_occurrence_key';
  END IF;
  -- Every supplied keep fingerprint must have the canonical SHA-256 shape.
  IF EXISTS (
    SELECT 1 FROM unnest(v_keep) AS fp WHERE fp !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'invalid_keep_fingerprint';
  END IF;

  -- Run-ID fencing WITH a row lock (FIRST lock; consistent order). FOR SHARE
  -- conflicts with the FOR-NO-KEY-UPDATE lock taken by claim/renew/release UPDATEs.
  SELECT 1 INTO v_lease
  FROM public.google_calendar_sync_state
  WHERE connection_id    = p_connection_id
    AND calendar_id      = p_calendar_id
    AND sync_run_id      = p_run_id
    AND sync_status      = 'running'
    AND sync_lease_until IS NOT NULL
    AND sync_lease_until > now()
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_or_unowned_run';
  END IF;

  -- Connection must belong to the user AND match the supplied Google account.
  PERFORM 1 FROM public.google_connections
  WHERE id = p_connection_id AND user_id = p_user_id AND google_sub = p_google_sub;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connection_ownership_mismatch';
  END IF;

  -- Invalidate ONLY pending candidates for this exact (connection, event, occurrence)
  -- whose fingerprint is not in the keep-set. IS NOT DISTINCT FROM matches the NULL
  -- half of the occurrence XOR. accepted/dismissed/invalidated rows are excluded by
  -- the status filter and are never modified or resurrected.
  UPDATE public.interaction_candidates AS c
    SET status     = 'invalidated',
        updated_at = now()
  WHERE c.status = 'pending'
    AND c.user_id = p_user_id
    AND NOT (c.source_fingerprint = ANY (v_keep))
    AND c.id IN (
      SELECT r.candidate_id
      FROM public.google_calendar_event_refs AS r
      WHERE r.connection_id = p_connection_id
        AND r.google_event_id = p_google_event_id
        AND r.original_occurrence_at   IS NOT DISTINCT FROM p_original_occurrence_at
        AND r.original_occurrence_date IS NOT DISTINCT FROM p_original_occurrence_date
    );

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_calendar_occurrence(
  uuid, text, uuid, uuid, text, text, timestamptz, date, text[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_calendar_occurrence(
  uuid, text, uuid, uuid, text, text, timestamptz, date, text[]
) TO service_role;
