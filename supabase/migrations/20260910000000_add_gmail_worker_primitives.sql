-- Email integration — Phase E2B: Gmail worker + capability service primitives.
--
-- SCOPE (E2B only): four ADDITIVE RPCs the capability-aware Gmail OAuth callback, the
-- bounded Gmail worker, and the user-facing Gmail "Disconnect" control need. Three are
-- service-role only; the fourth is the user's own off switch. Adds NO table, NO column,
-- NO scheduler, NO Cron, NO webhook, NO live OAuth scope, NO Gmail API call, NO UI, and
-- NO secret. It is INTENTIONALLY NOT DEPLOYED / NOT APPLIED to production by this phase.
-- Production Gmail access remains blocked behind Privacy-Policy + Google restricted-scope
-- verification (human gates).
--
-- WHY THESE FOUR:
--   1. upsert_google_capability — E2A created google_connection_capabilities but left it
--      with NO writer. The Gmail OAuth callback needs a hardened, ownership-verified way
--      to create/update ONLY the Gmail capability row (and the worker needs it to flip
--      Gmail to needs_reauth) WITHOUT touching the Calendar capability.
--   2. reserve_due_gmail_connection — the worker must process EXACTLY ONE reserved
--      connection per invocation (never an all-user sweep). It picks one due row and claims
--      its lease with a GUARDED upsert whose WHERE clause re-checks lease expiry, then
--      verifies ROW_COUNT = 1, so two concurrent workers can never take the same
--      connection. (A row lock cannot be used here: the due query LEFT JOINs the sync-state
--      table so never-synced connections are visible, and Postgres forbids FOR UPDATE on
--      the nullable side of an outer join.)
--   3. invalidate_email_candidates_by_fingerprint — reconciliation for Gmail
--      messageDeleted / label-removal. NOTE: the E2A reconcile_email_episode takes a
--      KEEP-set and invalidates everything for the connection that is not in it, which is
--      correct for a FULL bounded window scan but catastrophic for an INCREMENTAL run that
--      only observed a few threads. This RPC is the precise inverse: it invalidates ONLY
--      the explicitly listed fingerprints, so an incremental run can never invalidate a
--      candidate it did not actually observe as removed.
--   4. disconnect_my_gmail — the USER's own off switch, and the only function here granted
--      to authenticated. A restricted mailbox scope must be revocable by the person who
--      granted it, in one click, without collateral damage: it disables ONLY the caller's
--      Gmail capability, erases every pending Gmail suggestion and its retained subject,
--      and drops the Gmail cursor so a later reconnect starts a fresh bounded import. It
--      never touches the Calendar capability, the shared Google connection, or the stored
--      refresh token, and it never calls out to Google (Google has no per-scope revocation,
--      and revoking the shared token would break Calendar — the UI says so plainly).
--
-- Every function: SECURITY DEFINER, SET search_path = '', fully-qualified objects, no
-- dynamic SQL, controlled codes only. EXECUTE is revoked from PUBLIC/anon everywhere;
-- RPCs 1-3 are granted to service_role only and RPC 4 to authenticated only (it derives
-- the caller from auth.uid() and accepts NO arguments, so it can only ever affect the
-- caller's own rows). No function returns a token, address, subject, or raw provider
-- payload. (reserve_* returns the internal history cursor because only service_role can
-- execute it and the worker requires it; it never reaches a client.)


-- ── RPC 1: upsert_google_capability ───────────────────────────────────────────
-- Create or update ONE capability row for (connection, product), verifying that the
-- supplied user actually owns the connection. Other products are never touched, so a
-- Gmail write can never disable Calendar (and vice-versa).
CREATE OR REPLACE FUNCTION public.upsert_google_capability(
  p_connection_id uuid,
  p_user_id       uuid,
  p_product       text,
  p_status        text,
  p_granted       boolean,
  p_needs_reauth  boolean,
  p_result_code   text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF p_product IS NULL OR p_product NOT IN ('calendar', 'gmail') THEN
    RETURN jsonb_build_object('result', 'invalid_product');
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'needs_reauth', 'revoked', 'disabled') THEN
    RETURN jsonb_build_object('result', 'invalid_status');
  END IF;
  IF p_result_code IS NOT NULL AND char_length(p_result_code) > 100 THEN
    RETURN jsonb_build_object('result', 'invalid_result_code');
  END IF;

  -- Ownership: the connection must exist AND belong to the supplied user. A mismatch is
  -- refused outright (a Gmail consent can never attach a capability to another account).
  SELECT c.user_id INTO v_owner
  FROM public.google_connections c
  WHERE c.id = p_connection_id;

  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('result', 'unknown_connection');
  END IF;
  IF v_owner <> p_user_id THEN
    RETURN jsonb_build_object('result', 'owner_mismatch');
  END IF;

  INSERT INTO public.google_connection_capabilities
    (connection_id, user_id, product, status, granted, needs_reauth, last_result_code,
     last_success_at, updated_at)
  VALUES
    (p_connection_id, p_user_id, p_product, p_status, COALESCE(p_granted, false),
     COALESCE(p_needs_reauth, false), p_result_code,
     CASE WHEN p_status = 'active' AND COALESCE(p_granted, false) THEN now() ELSE NULL END,
     now())
  ON CONFLICT (connection_id, product) DO UPDATE
    SET status           = EXCLUDED.status,
        granted          = EXCLUDED.granted,
        needs_reauth     = EXCLUDED.needs_reauth,
        last_result_code = EXCLUDED.last_result_code,
        -- Only advance last_success_at on a genuinely usable capability; never clear a
        -- previous success timestamp just because this write is a failure marker.
        last_success_at  = CASE
                             WHEN EXCLUDED.status = 'active' AND EXCLUDED.granted THEN now()
                             ELSE public.google_connection_capabilities.last_success_at
                           END,
        updated_at       = now();

  RETURN jsonb_build_object('result', 'ok');
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_google_capability(uuid, uuid, text, text, boolean, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_google_capability(uuid, uuid, text, text, boolean, boolean, text)
  TO service_role;


-- ── RPC 2: reserve_due_gmail_connection ───────────────────────────────────────
-- Atomically reserve EXACTLY ONE due Gmail connection and claim its lease. Returns the
-- reserved connection, a fresh run id, and the internal cursor state, or result
-- 'none_due'. The single-row LIMIT guarantees no all-user sweep is possible.
--
-- ATOMICITY: the candidate SELECT is deliberately NOT row-locked. A never-synced
-- connection has no gmail_sync_state row at all, so it sits on the nullable side of a
-- LEFT JOIN where PostgreSQL forbids FOR UPDATE. Exactly-one-winner is instead
-- guaranteed by the GUARDED UPSERT below — the identical mechanism already proven in
-- claim_gmail_sync_lease: its ON CONFLICT ... WHERE clause only fires when no live lease
-- exists, so if two workers select the same connection only one gets ROW_COUNT = 1 and
-- the loser returns 'none_due' without side effects.
--
-- DUE definition (all must hold):
--   * the gmail capability is active, granted, and not awaiting reauth;
--   * the connection itself is active;
--   * no other run currently holds a live lease;
--   * any retry backoff (next_attempt_at) has elapsed;
--   * an incomplete previous run is retried after its backoff (bounded: 10 tries, >= 5 min
--     apart); otherwise the connection is due once per p_due_after_seconds;
--   * the connection has NEVER synced (no sync-state row, or last_synced_at IS NULL) —
--     a newly connected Gmail account is therefore IMMEDIATELY due — or its last sync is
--     older than p_due_after_seconds.
CREATE OR REPLACE FUNCTION public.reserve_due_gmail_connection(
  p_lease_seconds    integer,
  p_due_after_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conn uuid;
  v_uid  uuid;
  v_run  uuid;
  v_hist text;
  v_init boolean;
  v_n    integer;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid_lease_seconds';
  END IF;
  IF p_due_after_seconds IS NULL OR p_due_after_seconds < 0 OR p_due_after_seconds > 2592000 THEN
    RAISE EXCEPTION 'invalid_due_after';
  END IF;

  -- Pick exactly ONE due candidate. A capability with no sync-state row yet is
  -- immediately due (first sync). Oldest-synced first, never-synced before all others.
  SELECT cap.connection_id, cap.user_id
    INTO v_conn, v_uid
  FROM public.google_connection_capabilities cap
  JOIN public.google_connections conn ON conn.id = cap.connection_id
  LEFT JOIN public.gmail_sync_state s ON s.connection_id = cap.connection_id
  WHERE cap.product = 'gmail'
    AND cap.status = 'active'
    AND cap.granted IS TRUE
    AND cap.needs_reauth IS FALSE
    AND conn.status = 'active'
    AND (s.connection_id IS NULL
         OR ((s.sync_status <> 'running'
              OR s.sync_lease_until IS NULL
              OR s.sync_lease_until < now())
             AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= now())
             AND (s.last_synced_at IS NULL
                  -- An INCOMPLETE run (cursor held) is retried after its backoff rather
                  -- than waiting a full cadence: up to 10 consecutive retries, never
                  -- sooner than 5 minutes after the previous attempt even if a caller
                  -- released without a backoff. After 10 the daily cadence applies.
                  OR (s.last_run_complete IS NOT TRUE
                      AND s.retry_count < 10
                      AND s.last_synced_at < now() - interval '5 minutes')
                  OR s.last_synced_at < now() - make_interval(secs => p_due_after_seconds))))
  ORDER BY s.last_synced_at ASC NULLS FIRST, cap.connection_id ASC
  LIMIT 1;

  IF v_conn IS NULL THEN
    RETURN jsonb_build_object('result', 'none_due');
  END IF;

  v_run := pg_catalog.gen_random_uuid();

  -- Claim the lease in the same transaction. The guarded upsert is the same contract as
  -- claim_gmail_sync_lease: it only wins when no live lease exists.
  INSERT INTO public.gmail_sync_state
    (connection_id, user_id, sync_status, sync_lease_until, sync_run_id, updated_at)
  VALUES
    (v_conn, v_uid, 'running', now() + make_interval(secs => p_lease_seconds), v_run, now())
  ON CONFLICT (connection_id) DO UPDATE
    SET sync_status      = 'running',
        sync_lease_until = now() + make_interval(secs => p_lease_seconds),
        sync_run_id      = v_run,
        updated_at       = now()
    WHERE public.gmail_sync_state.sync_status <> 'running'
       OR public.gmail_sync_state.sync_lease_until IS NULL
       OR public.gmail_sync_state.sync_lease_until < now();

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    -- Another run claimed it between the select and the upsert; report nothing reserved.
    RETURN jsonb_build_object('result', 'none_due');
  END IF;

  SELECT s.history_id, s.initial_import_done
    INTO v_hist, v_init
  FROM public.gmail_sync_state s
  WHERE s.connection_id = v_conn;

  RETURN jsonb_build_object(
    'result', 'reserved',
    'connection_id', v_conn,
    'run_id', v_run,
    'history_id', v_hist,
    'initial_import_done', COALESCE(v_init, false)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_due_gmail_connection(integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_due_gmail_connection(integer, integer)
  TO service_role;


-- ── RPC 3: invalidate_email_candidates_by_fingerprint ─────────────────────────
-- Invalidate ONLY the explicitly listed pending candidates for this connection (Gmail
-- messageDeleted / label-removal reconciliation) and erase their retained context. A
-- terminal candidate is never touched and never resurrected. Run-fenced with the same
-- deterministic lock order as upsert_email_candidate (gmail_sync_state FOR SHARE first).
CREATE OR REPLACE FUNCTION public.invalidate_email_candidates_by_fingerprint(
  p_connection_id uuid,
  p_run_id        uuid,
  p_fingerprints  text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid     uuid;
  v_leaseok boolean;
  v_n       integer;
BEGIN
  IF p_fingerprints IS NULL OR pg_catalog.array_length(p_fingerprints, 1) IS NULL THEN
    RETURN jsonb_build_object('result', 'noop', 'invalidated', 0);
  END IF;
  -- Bounded input: a single reconciliation call can never be handed an unbounded list.
  IF pg_catalog.array_length(p_fingerprints, 1) > 500 THEN
    RETURN jsonb_build_object('result', 'invalid_fingerprint_set');
  END IF;
  PERFORM 1 FROM pg_catalog.unnest(p_fingerprints) f WHERE f !~ '^[0-9a-f]{64}$';
  IF FOUND THEN
    RETURN jsonb_build_object('result', 'invalid_fingerprint');
  END IF;

  SELECT (s.sync_run_id = p_run_id
          AND s.sync_status = 'running'
          AND s.sync_lease_until IS NOT NULL
          AND s.sync_lease_until > now()),
         c.user_id
    INTO v_leaseok, v_uid
  FROM public.gmail_sync_state s
  JOIN public.google_connections c ON c.id = s.connection_id
  WHERE s.connection_id = p_connection_id
  FOR SHARE OF s;

  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('result', 'unknown_connection');
  END IF;
  IF v_leaseok IS NOT TRUE THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;

  UPDATE public.interaction_candidates ic
    SET status = 'invalidated',
        retained_subject = NULL,
        context_expires_at = NULL,
        updated_at = now()
  FROM public.email_candidate_refs r
  WHERE r.candidate_id = ic.id
    AND r.connection_id = p_connection_id
    AND ic.user_id = v_uid
    AND ic.status = 'pending'
    AND ic.source_fingerprint = ANY (p_fingerprints);

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('result', 'invalidated', 'invalidated', v_n);
END;
$$;

REVOKE ALL ON FUNCTION public.invalidate_email_candidates_by_fingerprint(uuid, uuid, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invalidate_email_candidates_by_fingerprint(uuid, uuid, text[])
  TO service_role;


-- ── RPC 4: disconnect_my_gmail ────────────────────────────────────────────────
-- The USER's own Gmail off switch, and the ONLY function in this migration callable by
-- authenticated. Takes NO arguments: the caller is derived solely from auth.uid(), so it
-- is structurally impossible to aim it at another account.
--
-- It performs exactly four things, all scoped to the caller:
--   1. Disables ONLY the 'gmail' capability row (status 'disabled', granted false).
--   2. Erases every PENDING Gmail suggestion and its retained subject.
--   3. Drops the Gmail cursor/lease row so a later reconnect begins a fresh BOUNDED
--      initial import rather than resuming a stale history id.
--   4. Leaves the Calendar capability, the google_connections row, and the encrypted
--      refresh token untouched.
--
-- It deliberately does NOT call Google. Google has no per-scope revocation, and the
-- refresh token is shared with Calendar, so revoking it here would silently break a
-- working Calendar connection. The UI tells the user they may also remove Funnl's access
-- from their Google Account page.
--
-- A lease held by an in-flight worker run is NOT waited on: the capability row is disabled
-- immediately (so the next reservation can never pick this connection up) and the delete of
-- the sync-state row blocks only for as long as that single run's row lock, after which the
-- stale run's run-ID fencing makes every later write a no-op.
CREATE OR REPLACE FUNCTION public.disconnect_my_gmail()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid    uuid;
  v_conn   uuid;
  v_caps   integer := 0;
  v_cands  integer := 0;
BEGIN
  v_uid := (SELECT auth.uid());
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('result', 'unauthorized');
  END IF;

  SELECT c.id INTO v_conn
  FROM public.google_connections c
  WHERE c.user_id = v_uid;

  IF v_conn IS NULL THEN
    -- Nothing connected: idempotent success, never an error the UI must explain.
    RETURN jsonb_build_object('result', 'not_connected');
  END IF;

  -- 1. Gmail capability only. 'calendar' is never matched by this predicate.
  UPDATE public.google_connection_capabilities
    SET status           = 'disabled',
        granted          = false,
        needs_reauth     = false,
        last_result_code = 'user_disconnected',
        updated_at       = now()
  WHERE connection_id = v_conn
    AND user_id       = v_uid
    AND product       = 'gmail';
  GET DIAGNOSTICS v_caps = ROW_COUNT;

  -- 2. Erase pending Gmail suggestions + their retained subjects. Terminal candidates
  --    (accepted/dismissed) are never touched: accepted interactions are the user's data.
  UPDATE public.interaction_candidates
    SET status             = 'invalidated',
        retained_subject   = NULL,
        context_expires_at = NULL,
        updated_at         = now()
  WHERE user_id = v_uid
    AND source  = 'gmail'
    AND status  = 'pending';
  GET DIAGNOSTICS v_cands = ROW_COUNT;

  -- 3. Drop the cursor/lease so a reconnect starts a fresh bounded import.
  DELETE FROM public.gmail_sync_state WHERE connection_id = v_conn;

  RETURN jsonb_build_object(
    'result', 'disconnected',
    'capability_rows', v_caps,
    'candidates_invalidated', v_cands
  );
END;
$$;

REVOKE ALL ON FUNCTION public.disconnect_my_gmail() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.disconnect_my_gmail() TO authenticated;
