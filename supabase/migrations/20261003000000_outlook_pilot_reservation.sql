-- Outlook — let the RESERVATION itself be limited to one designated pilot account.
--
-- WHY THIS EXISTS. `reserve_due_outlook_connection` had no user predicate: it took
-- whichever active, consented connection was DUE, for ANY user. Two consequences were
-- reproduced against a real Postgres through the real worker handler
-- (tests/local/outlook-worker-token-access.mjs):
--
--   1. SIDE EFFECTS FOR AN EXCLUDED USER. The run could only learn whose connection it
--      had been handed AFTER loading the run context - and that load decrypts their
--      tokens, and for an EXPIRED access token refreshes it at Microsoft's token
--      endpoint and persists the result through rotate_microsoft_access_token. So a
--      user outside the pilot had a real provider call made on their behalf and their
--      stored credentials rewritten, before anything refused them. Measured:
--        {"outcome":"not_in_pilot","tokenEndpointCalls":1,"tokenGrant":"refresh_token",
--         "accessTokenRewritten":true,"expiryRewritten":true,"foldersLeased":2}
--
--   2. THE PILOT COULD BE STARVED. The ordering is
--      `min(last_success_at) ASC NULLS FIRST, c.id ASC`. A connection that has never
--      succeeded sorts FIRST and - because being refused is not succeeding - keeps
--      sorting first for ever. A refusal backs it off by RETRY_BACKOFF_SECONDS (300s)
--      and nothing more, so it returns to the head of the queue every five minutes.
--      One excluded connection therefore consumes whole invocations indefinitely, and
--      at a five-minute cadence it takes every one of them. Measured over three
--      invocations: committed, NOT_IN_PILOT, none_due.
--
-- No application-side check can fix either one, because the choice is made here.
--
-- WHAT THIS CHANGES: one optional parameter and one conjunct in the WHERE clause.
--
--   p_pilot_user_id IS NULL      -> selection is EXACTLY as before, for every user.
--                                   This is the shape every existing caller and test
--                                   uses, and the behaviour to keep while no pilot is
--                                   configured.
--   p_pilot_user_id IS NOT NULL  -> only that user's due connection can be reserved.
--                                   Nobody else's row is read, leased, refreshed or
--                                   written, and nobody else can take the pilot's turn.
--
-- The result also now reports `user_id`, so the caller can verify the owner of what it
-- was given WITHOUT loading the run context first. That is what moves enforcement
-- ahead of the token refresh and the rotation write.
--
-- WHY A DROP AND NOT A REPLACE. CREATE OR REPLACE cannot add a parameter - it would
-- create a second function - and keeping the 2-argument one alongside a 3-argument one
-- with a DEFAULT makes every 2-argument call ambiguous
-- (`function reserve_due_outlook_connection(integer, integer) is not unique`). So the
-- old signature is dropped and the new one carries the default, which keeps every
-- existing 2-argument call working, positional or named. A dropped function loses its
-- ACL, so the REVOKE/GRANT pair is restated below - without it the new function would
-- be EXECUTE-able by PUBLIC, which is how a service-role-only RPC accidentally becomes
-- callable by `authenticated`.
--
-- NOT CHANGED, deliberately: the DUE definition, the ordering, the guarded upsert, the
-- `ROW_COUNT = 2` both-folder fence, the serialization_failure rollback, and the
-- initial-import flags in the result. The body below is the applied one with the single
-- conjunct added and `user_id` added to the returned object.
--
-- VERIFY AFTER APPLYING:
--   SELECT p.pronargs, pg_get_function_arguments(p.oid), p.prosecdef, p.proconfig
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'reserve_due_outlook_connection';
--   -- expect exactly ONE row: 3 args, the third `p_pilot_user_id uuid DEFAULT NULL`,
--   --        prosecdef = t, proconfig = {search_path=}
--   SELECT has_function_privilege('authenticated',
--     'public.reserve_due_outlook_connection(integer,integer,uuid)', 'EXECUTE');
--   -- expect false

DROP FUNCTION IF EXISTS public.reserve_due_outlook_connection(integer, integer);

CREATE FUNCTION public.reserve_due_outlook_connection(
  p_lease_seconds     integer,
  p_due_after_seconds integer,
  -- NULL means "any user", which is the pre-pilot behaviour. A non-NULL value is the
  -- ONE account whose due connection may be reserved.
  p_pilot_user_id     uuid DEFAULT NULL
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
  v_n    integer;
  v_inbox_done boolean;
  v_sent_done  boolean;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid_lease_seconds';
  END IF;
  IF p_due_after_seconds IS NULL OR p_due_after_seconds < 0 OR p_due_after_seconds > 2592000 THEN
    RAISE EXCEPTION 'invalid_due_after';
  END IF;

  SELECT c.id, c.user_id
    INTO v_conn, v_uid
  FROM public.microsoft_connections c
  WHERE c.status = 'active'
    AND c.needs_reauth IS FALSE
    AND c.consented_at IS NOT NULL
    -- THE PILOT PREDICATE. The only addition. With NULL it is a no-op, so the
    -- selection is byte-for-byte the previous one.
    AND (p_pilot_user_id IS NULL OR c.user_id = p_pilot_user_id)
    AND NOT EXISTS (
      SELECT 1 FROM public.outlook_sync_state s
      WHERE s.connection_id = c.id
        AND ((s.sync_status = 'running' AND s.sync_lease_until IS NOT NULL AND s.sync_lease_until >= now())
             OR (s.next_retry_at IS NOT NULL AND s.next_retry_at > now())))
    AND (
      NOT EXISTS (SELECT 1 FROM public.outlook_sync_state s WHERE s.connection_id = c.id)
      OR EXISTS (
        SELECT 1 FROM public.outlook_sync_state s
        WHERE s.connection_id = c.id
          AND (s.last_success_at IS NULL
               OR (s.last_run_complete IS NOT TRUE
                   AND s.retry_count < 10
                   AND (s.last_attempt_at IS NULL OR s.last_attempt_at < now() - interval '5 minutes'))
               OR s.last_success_at < now() - make_interval(secs => p_due_after_seconds))))
  ORDER BY (SELECT min(s.last_success_at) FROM public.outlook_sync_state s WHERE s.connection_id = c.id) ASC NULLS FIRST,
           c.id ASC
  LIMIT 1;

  IF v_conn IS NULL THEN
    RETURN jsonb_build_object('result', 'none_due');
  END IF;

  v_run := pg_catalog.gen_random_uuid();

  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, sync_run_id, sync_lease_until, run_started_at, last_attempt_at, updated_at)
  VALUES
    (v_conn, v_uid, 'inbox',     'running', v_run, now() + make_interval(secs => p_lease_seconds), now(), now(), now()),
    (v_conn, v_uid, 'sentitems', 'running', v_run, now() + make_interval(secs => p_lease_seconds), now(), now(), now())
  ON CONFLICT (connection_id, folder) DO UPDATE
    SET sync_status      = 'running',
        sync_run_id      = v_run,
        sync_lease_until = now() + make_interval(secs => p_lease_seconds),
        run_started_at   = now(),
        last_attempt_at  = now(),
        updated_at       = now()
    WHERE public.outlook_sync_state.sync_status <> 'running'
       OR public.outlook_sync_state.sync_lease_until IS NULL
       OR public.outlook_sync_state.sync_lease_until < now();

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN
    -- Another run claimed at least one folder between the select and the upsert.
    -- Roll back any partial claim so no row is left leased to a run that never ran.
    RAISE EXCEPTION 'reservation_lost' USING ERRCODE = 'serialization_failure';
  END IF;

  SELECT bool_and(CASE WHEN s.folder = 'inbox'     THEN s.initial_import_done ELSE true END),
         bool_and(CASE WHEN s.folder = 'sentitems' THEN s.initial_import_done ELSE true END)
    INTO v_inbox_done, v_sent_done
  FROM public.outlook_sync_state s
  WHERE s.connection_id = v_conn;

  RETURN jsonb_build_object(
    'result', 'reserved',
    'connection_id', v_conn,
    -- The OWNER of what was just reserved. Reported so the caller can refuse a
    -- connection that is not the pilot's before it loads anything, rather than after
    -- the context load has already refreshed a token at Microsoft and stored it.
    'user_id', v_uid,
    'run_id', v_run,
    'inbox_initial_import_done', COALESCE(v_inbox_done, false),
    'sentitems_initial_import_done', COALESCE(v_sent_done, false)
  );
EXCEPTION
  WHEN serialization_failure THEN
    RETURN jsonb_build_object('result', 'none_due');
END;
$$;

-- A dropped function takes its ACL with it, so this is not redundant: without it the
-- new function is EXECUTE-able by PUBLIC.
REVOKE ALL ON FUNCTION public.reserve_due_outlook_connection(integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_due_outlook_connection(integer, integer, uuid) TO service_role;
