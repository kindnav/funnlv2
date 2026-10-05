-- Runtime verification for migration 20261003000000_outlook_pilot_reservation.sql
--
-- HOW TO BUILD THE DATABASE THIS NEEDS: tests/sql/_bootstrap-disposable-db.sql
--
-- WHAT THIS PROVES, AND WHAT IT DOES NOT.
-- It runs as the privileged `postgres` role, so it proves the function BODY: which
-- connection the reservation chooses, what it reports, and that the both-folder lease
-- fence still decides the claim. It does NOT prove that a deployed request is switched
-- to `service_role`, nor that `authenticated` is refused EXECUTE - a privileged role
-- bypasses exactly those checks. The grants are asserted separately at the end by
-- interrogating the catalogue, and the HTTP path is covered by
-- tests/local/outlook-worker-token-access.mjs.
--
-- THIS IS NOT A BROWSER-TO-DATABASE END-TO-END TEST: no JWT, no PostgREST, no browser.
--
-- THE CENTRAL CASES:
--   * with NO pilot argument the selection is unchanged - an all-user sweep still picks
--     whichever connection is due, which is the behaviour to keep while no pilot is
--     configured;
--   * with a pilot argument ONLY that user's due connection can be reserved, and an
--     excluded connection is left with NO folder rows at all - not leased and released,
--     never touched;
--   * THE STARVATION CASE: an excluded connection that has never succeeded sorts first
--     under `min(last_success_at) ASC NULLS FIRST`, so without the argument it is taken
--     ahead of the pilot's every time; with the argument the pilot is reserved instead;
--   * a pilot who has nothing due reports `none_due` rather than falling back to
--     somebody else;
--   * the result reports `user_id`, which is what lets the caller refuse before loading
--     anything;
--   * the both-folder guarded upsert is unchanged: a live lease on ONE folder blocks the
--     claim, and leaves no half-claimed row.

\set ON_ERROR_STOP on

DO $$
DECLARE
  pilot    uuid := '11111111-1111-1111-1111-111111111111';
  other    uuid := '22222222-2222-2222-2222-222222222222';
  c_pilot  uuid;
  c_other  uuid;
  res      jsonb;
  n        integer;
BEGIN
  -- ── fixtures: two active, consented, never-run connections ────────────────
  DELETE FROM public.outlook_sync_state;
  DELETE FROM public.microsoft_connections WHERE user_id IN (pilot, other);

  -- The EXCLUDED one first, so that if ids were the tie-breaker it would win it too.
  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version)
  VALUES (other, 'acct-other', 'consumers', 'personal', 'other@example.test',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(), 'v1')
  RETURNING id INTO c_other;

  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version)
  VALUES (pilot, 'acct-pilot', 'consumers', 'personal', 'pilot@example.test',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(), 'v1')
  RETURNING id INTO c_pilot;

  -- ════ 1. NO pilot argument: the previous behaviour, unchanged ═════════════
  -- Both are due and neither has succeeded, so NULLS FIRST leaves the id as the
  -- tie-breaker. Whichever is chosen, the point is that an excluded user's connection
  -- IS eligible - that is the behaviour being preserved for the no-pilot case.
  res := public.reserve_due_outlook_connection(600, 0);
  IF res->>'result' <> 'reserved' THEN
    RAISE EXCEPTION 'no-pilot call did not reserve: %', res;
  END IF;
  IF (res->>'user_id')::uuid NOT IN (pilot, other) THEN
    RAISE EXCEPTION 'no-pilot call reported an unexpected owner: %', res;
  END IF;
  RAISE NOTICE 'no pilot argument: reserved, owner reported = %', res->>'user_id';

  -- Hand both back so the next case starts clean.
  DELETE FROM public.outlook_sync_state;

  -- ════ 2. THE STARVATION CASE ══════════════════════════════════════════════
  -- Give the PILOT a completed history and leave the excluded one with none. The order
  -- is `min(last_success_at) ASC NULLS FIRST`, so the excluded connection - which has
  -- never succeeded, and being refused is not succeeding - sorts ahead of the pilot for
  -- ever. Without the argument it is taken every time the pilot is not newer.
  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, last_success_at, last_run_complete,
     initial_import_done)
  VALUES (c_pilot, pilot, 'inbox',     'idle', now() - interval '2 days', true, true),
         (c_pilot, pilot, 'sentitems', 'idle', now() - interval '2 days', true, true);

  res := public.reserve_due_outlook_connection(600, 0);
  IF (res->>'user_id')::uuid <> other THEN
    RAISE EXCEPTION 'the starvation case did not reproduce: expected the excluded '
                    'connection to be chosen first, got %', res;
  END IF;
  RAISE NOTICE 'STARVATION REPRODUCED: with no pilot argument the EXCLUDED connection '
               'is chosen ahead of the pilot whose last success is 2 days old';

  -- Release what that call claimed, exactly as a refused run would, with the real
  -- 300-second backoff. The excluded connection is then not due for five minutes - and
  -- becomes due again afterwards, for ever, because it still has no success.
  PERFORM public.release_outlook_sync_lease(
    c_other, (res->>'run_id')::uuid, 'idle', 'not_in_pilot', false,
    NULL, NULL, NULL, NULL, NULL, false, 300);

  -- ════ 3. WITH the pilot argument: only the pilot is reachable ═════════════
  -- Clear the backoff so the excluded connection is due again. This is the case that
  -- matters: both due, the excluded one sorting first, and it must still not be chosen.
  UPDATE public.outlook_sync_state SET next_retry_at = NULL WHERE user_id = other;

  res := public.reserve_due_outlook_connection(600, 0, pilot);
  IF res->>'result' <> 'reserved' THEN
    RAISE EXCEPTION 'the pilot was not reserved: %', res;
  END IF;
  IF (res->>'connection_id')::uuid <> c_pilot OR (res->>'user_id')::uuid <> pilot THEN
    RAISE EXCEPTION 'the wrong connection was reserved: %', res;
  END IF;
  RAISE NOTICE 'with the pilot argument: the PILOT is reserved although the excluded '
               'connection sorts first';

  -- And the excluded connection was not merely refused later - the reservation left it
  -- alone. Its rows exist only because case 2 claimed and released them; nothing in
  -- case 3 re-leased it.
  SELECT count(*) INTO n FROM public.outlook_sync_state
   WHERE user_id = other AND sync_status = 'running';
  IF n <> 0 THEN
    RAISE EXCEPTION 'the excluded connection was leased by the pilot call (% rows)', n;
  END IF;

  -- ════ 4. A pilot with nothing due does NOT fall back to anyone else ═══════
  -- The pilot now holds a live lease from case 3; the excluded connection is due.
  res := public.reserve_due_outlook_connection(600, 0, pilot);
  IF res->>'result' <> 'none_due' THEN
    RAISE EXCEPTION 'expected none_due for a busy pilot, got %', res;
  END IF;
  RAISE NOTICE 'a pilot with nothing due reports none_due, not somebody else';

  -- ════ 5. An UNKNOWN pilot reserves nothing ════════════════════════════════
  res := public.reserve_due_outlook_connection(
    600, 0, '33333333-3333-3333-3333-333333333333'::uuid);
  IF res->>'result' <> 'none_due' THEN
    RAISE EXCEPTION 'an unknown pilot reserved something: %', res;
  END IF;

  -- ════ 6. The BOTH-FOLDER fence is unchanged ═══════════════════════════════
  -- A live lease on ONE folder must block the claim and leave no half-claimed row.
  DELETE FROM public.outlook_sync_state;
  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, sync_run_id, sync_lease_until)
  VALUES (c_pilot, pilot, 'sentitems', 'running',
          pg_catalog.gen_random_uuid(), now() + interval '5 minutes');

  res := public.reserve_due_outlook_connection(600, 0, pilot);
  IF res->>'result' <> 'none_due' THEN
    RAISE EXCEPTION 'a connection with one live folder lease was reserved: %', res;
  END IF;
  SELECT count(*) INTO n FROM public.outlook_sync_state
   WHERE connection_id = c_pilot AND folder = 'inbox';
  IF n <> 0 THEN
    RAISE EXCEPTION 'a partial claim was left behind on inbox';
  END IF;
  RAISE NOTICE 'the both-folder fence still blocks a half-available connection';

  -- ════ 7. A non-pilot STATUS still excludes, with the argument present ═════
  -- The pilot predicate narrows; it must not widen. A connection belonging to the
  -- designated user that is not consented stays ineligible.
  DELETE FROM public.outlook_sync_state;
  UPDATE public.microsoft_connections SET status = 'revoked' WHERE id = c_pilot;
  res := public.reserve_due_outlook_connection(600, 0, pilot);
  IF res->>'result' <> 'none_due' THEN
    RAISE EXCEPTION 'a revoked connection was reserved for the pilot: %', res;
  END IF;
  UPDATE public.microsoft_connections SET status = 'active', needs_reauth = true
   WHERE id = c_pilot;
  res := public.reserve_due_outlook_connection(600, 0, pilot);
  IF res->>'result' <> 'none_due' THEN
    RAISE EXCEPTION 'a needs_reauth connection was reserved for the pilot: %', res;
  END IF;
  RAISE NOTICE 'the pilot predicate narrows and never widens';

  -- Leave no rows behind: other runtime files assert an empty
  -- microsoft_connections as their own precondition, so these tests must be
  -- order-independent.
  DELETE FROM public.outlook_sync_state;
  DELETE FROM public.microsoft_connections WHERE user_id IN (pilot, other);

  RAISE NOTICE 'outlook-pilot-reservation: all assertions passed';
END $$;

-- ── the signature and its privileges ────────────────────────────────────────
DO $$
DECLARE
  n       integer;
  args    text;
  secdef  boolean;
  cfg     text[];
BEGIN
  SELECT count(*) INTO n
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public' AND p.proname = 'reserve_due_outlook_connection';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected exactly ONE reserve_due_outlook_connection, found % - an '
                    'overload would make every 2-argument call ambiguous', n;
  END IF;

  SELECT pg_get_function_arguments(p.oid), p.prosecdef, p.proconfig
    INTO args, secdef, cfg
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public' AND p.proname = 'reserve_due_outlook_connection';

  IF args NOT LIKE '%p_pilot_user_id uuid DEFAULT NULL%' THEN
    RAISE EXCEPTION 'the pilot argument must be optional, so every existing '
                    '2-argument call still works: %', args;
  END IF;
  IF secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'the reservation must stay SECURITY DEFINER';
  END IF;
  IF cfg IS NULL OR NOT EXISTS (
       SELECT 1 FROM unnest(cfg) AS c(v)
        WHERE c.v IN ('search_path=', 'search_path=""')) THEN
    RAISE EXCEPTION 'search_path must stay pinned empty, got %', cfg;
  END IF;

  -- A dropped function loses its ACL. Without the restated REVOKE the recreated one
  -- would be EXECUTE-able by PUBLIC, which is how a service-role-only RPC silently
  -- becomes callable by a signed-in user.
  IF has_function_privilege('authenticated',
       'public.reserve_due_outlook_connection(integer,integer,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can EXECUTE the reservation';
  END IF;
  IF has_function_privilege('anon',
       'public.reserve_due_outlook_connection(integer,integer,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can EXECUTE the reservation';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.reserve_due_outlook_connection(integer,integer,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot EXECUTE the reservation';
  END IF;

  RAISE NOTICE 'outlook-pilot-reservation: signature and privileges verified';
END $$;
