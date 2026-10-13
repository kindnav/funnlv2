-- Outlook cohort reservation: eligibility becomes a SET, decided in SQL.
--
-- WHY THIS VERSION NUMBER. It was 20261013000000 until the new-contact refresh fix
-- (20261013060000_preserve_new_contact_context_deadline.sql, branch
-- fix/outlook-new-contact-refresh-expiry) needed to apply BEFORE it. Both are unapplied, so
-- renumbering this one is safe, and renaming applied history never is: 060000 < 120000, so
-- whichever branch merges first, `db push` applies the fix first. The two are independent -
-- that one replaces a producer function, this one replaces the reservation - and nothing
-- here depends on it. If BOTH are ever pending at once, apply and verify the fix on its own
-- first; see docs/outlook-new-contact-refresh-expiry.md section 4.
--
-- WHAT THIS CHANGES, and nothing else. `reserve_due_outlook_connection` gains ONE defaulted
-- parameter, `p_pilot_user_ids uuid[]`, and its eligibility clause learns to use it. The
-- lease rules, the backoff rules, the three due alternatives, the ordering, the wake cutoff,
-- the row insert, the serialization-failure handling and the answer shape are copied
-- verbatim from 20261009000000 - the diff against that function is the parameter, the
-- argument validation, and the filter, which is what makes this reviewable.
--
-- WHY A DROP AND CREATE RATHER THAN AN OVERLOAD. Two functions of the same name with
-- different arities would leave PostgREST choosing between candidates on every call, and
-- this schema's own ledger keeps exactly one overload per worker RPC for that reason. The
-- old three-argument signature is therefore dropped and the four-argument one replaces it:
-- a caller that passes only the first three - the single-id worker deployed today - still
-- resolves, because the fourth parameter is defaulted. That is what makes the migration
-- safe to apply BEFORE the cohort worker is deployed, which is the required order.
--
-- THE ORDER IS A REQUIREMENT, AND THAT IS MEASURED. Against a database still carrying only
-- the three-argument function, a four-argument call is not quietly narrowed and the extra
-- argument is not ignored: PostgREST resolves by named arguments, finds no candidate, and
-- answers 404 PGRST202. A worker deployed ahead of this migration therefore imports NOTHING.
-- Demonstrated over real PostgREST in tests/local/outlook-cohort-composed.mjs, which runs the
-- probe BEFORE applying this file and again after.
--
-- WHY THE FILTER AND NOT A POST-HOC REJECTION. An ineligible account must never be
-- reserved: a reservation takes a lease, stamps last_attempt_at and can move wake_cutoff_at.
-- Reserving and then refusing in the worker would do all three to an account nobody may
-- import, and would consume a scheduling slot the eligible accounts need.
--
-- NOT A FEATURE-FLAG FRAMEWORK, still. One variable upstream, one predicate, one filter.
-- No new table, no registry, no admin surface.
--
-- APPLYING THIS CHANGES NO BEHAVIOUR ON ITS OWN. Until a worker sends p_pilot_user_ids, the
-- single-id path is what runs, exactly as it does today.

-- The three-argument signature from 20261009000000 goes, so exactly ONE function of this
-- name exists afterwards and PostgREST has nothing to choose between. Dropping a function
-- loses its ACL, which is why the grants are restated at the bottom.
DROP FUNCTION IF EXISTS public.reserve_due_outlook_connection(integer, integer, uuid);

CREATE FUNCTION public.reserve_due_outlook_connection(
  p_lease_seconds     integer,
  p_due_after_seconds integer,
  p_pilot_user_id     uuid   DEFAULT NULL,
  -- >>> COHORT: the eligible SET. One function, one overload, two ways to be told who is
  -- eligible - so the single-id worker deployed today keeps working while the cohort worker
  -- rolls out, and PostgREST still has exactly one candidate to resolve.
  p_pilot_user_ids    uuid[] DEFAULT NULL
  -- <<<
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conn uuid;
  v_uid  uuid;
  v_wake timestamptz;
  v_run  uuid;
  v_n    integer;
  v_inbox_done boolean;
  v_sent_done  boolean;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid_lease_seconds';
  END IF;
  -- >>> COHORT: the same ceiling the application parser enforces, restated where it cannot
  -- be bypassed. A malformed cohort is a configuration error, not a reason to import more
  -- accounts than were invited, so it RAISES rather than quietly widening.
  IF p_pilot_user_ids IS NOT NULL THEN
    IF pg_catalog.array_ndims(p_pilot_user_ids) > 1 THEN
      RAISE EXCEPTION 'invalid_pilot_user_ids';
    END IF;
    IF COALESCE(pg_catalog.array_length(p_pilot_user_ids, 1), 0) > 10 THEN
      RAISE EXCEPTION 'too_many_pilot_users';
    END IF;
    IF pg_catalog.array_position(p_pilot_user_ids, NULL::uuid) IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_pilot_user_ids';
    END IF;
  END IF;
  -- <<<
  IF p_due_after_seconds IS NULL OR p_due_after_seconds < 0 OR p_due_after_seconds > 2592000 THEN
    RAISE EXCEPTION 'invalid_due_after';
  END IF;

  SELECT c.id, c.user_id, c.wake_requested_at
    INTO v_conn, v_uid, v_wake
  FROM public.microsoft_connections c
  WHERE c.status = 'active'
    AND c.needs_reauth IS FALSE
    AND c.consented_at IS NOT NULL
    -- >>> COHORT: eligibility is decided HERE, in SQL, so an ineligible account is never
    -- reserved in the first place. Rejecting it after reservation would take its lease,
    -- stamp last_attempt_at and move wake_cutoff_at for an account nobody may import.
    --   * the SET wins when it is given, and an EMPTY set matches nobody (fail closed);
    --   * the single id is the compatibility path for the worker deployed today;
    --   * both null keeps the pre-cohort contract (whoever is due), which is what the SQL
    --     proofs and the local harnesses rely on - the worker itself never sends both null,
    --     because its own gate refuses an unconfigured cohort before it ever calls this.
    AND (CASE
           WHEN p_pilot_user_ids IS NOT NULL THEN c.user_id = ANY (p_pilot_user_ids)
           WHEN p_pilot_user_id  IS NOT NULL THEN c.user_id = p_pilot_user_id
           ELSE true
         END)
    -- <<<
    -- Never while another run holds a live lease, and never inside a failure backoff:
    -- a wake-up does not bypass either.
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
               OR s.last_success_at < now() - make_interval(secs => p_due_after_seconds)))
      -- THE ADDITION: new mail was signalled since the last complete run.
      OR c.wake_requested_at IS NOT NULL
    )
  ORDER BY (c.wake_requested_at IS NULL) ASC,
           (SELECT min(s.last_success_at) FROM public.outlook_sync_state s WHERE s.connection_id = c.id) ASC NULLS FIRST,
           c.id ASC
  LIMIT 1;

  IF v_conn IS NULL THEN
    RETURN jsonb_build_object('result', 'none_due');
  END IF;

  v_run := pg_catalog.gen_random_uuid();

  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, sync_run_id, sync_lease_until, run_started_at, last_attempt_at, updated_at, wake_cutoff_at)
  VALUES
    (v_conn, v_uid, 'inbox',     'running', v_run, now() + make_interval(secs => p_lease_seconds), now(), now(), now(), now()),
    (v_conn, v_uid, 'sentitems', 'running', v_run, now() + make_interval(secs => p_lease_seconds), now(), now(), now(), now())
  ON CONFLICT (connection_id, folder) DO UPDATE
    SET sync_status      = 'running',
        sync_run_id      = v_run,
        sync_lease_until = now() + make_interval(secs => p_lease_seconds),
        run_started_at   = now(),
        last_attempt_at  = now(),
        updated_at       = now(),
        -- A round in progress keeps the cutoff of the reservation that started it.
        wake_cutoff_at   = CASE WHEN public.outlook_sync_state.round_id IS NULL
                                THEN now()
                                ELSE COALESCE(public.outlook_sync_state.wake_cutoff_at, now()) END
    WHERE public.outlook_sync_state.sync_status <> 'running'
       OR public.outlook_sync_state.sync_lease_until IS NULL
       OR public.outlook_sync_state.sync_lease_until < now();

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN
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
    'user_id', v_uid,
    'run_id', v_run,
    'inbox_initial_import_done', COALESCE(v_inbox_done, false),
    'sentitems_initial_import_done', COALESCE(v_sent_done, false),
    'wake_requested_at', v_wake
  );
EXCEPTION
  WHEN serialization_failure THEN
    RETURN jsonb_build_object('result', 'none_due');
END;
$$;

-- RESTATED FOR THE NEW SIGNATURE, and not only for PUBLIC: this project's default
-- privileges grant EXECUTE on a newly created function to `anon` and `authenticated`, so a
-- DROP + CREATE silently re-opens it unless all three are revoked by name. That has bitten
-- this repository before.
REVOKE ALL ON FUNCTION public.reserve_due_outlook_connection(integer, integer, uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_due_outlook_connection(integer, integer, uuid, uuid[])
  TO service_role;
