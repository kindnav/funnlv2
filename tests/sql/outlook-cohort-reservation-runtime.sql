-- THE COHORT RESERVATION, against the real function on a real database.
--
-- Two eligible users and a third who is NOT invited, all three with an active, consented,
-- due connection. What must hold:
--   * the excluded account is never RESERVED - not reserved-then-rejected, which would take
--     its lease, stamp last_attempt_at and move wake_cutoff_at for an account nobody may
--     import, and would consume a scheduling slot the invited accounts need;
--   * eligibility is decided in SQL, so a worker bug cannot widen it;
--   * an empty set invites nobody, an over-long or NULL-bearing set is an error, and the
--     pre-cohort single-id and both-null contracts still behave as they did;
--   * the lease and backoff rules are untouched;
--   * exactly ONE function of this name exists, and only service_role may execute it.
--
-- Run by tests/local/outlook-cohort-reservation.mjs, as `postgres`, after every migration.
-- Every assertion RAISES on failure, so a silent pass is not possible.

\set ON_ERROR_STOP on

BEGIN;

-- ── fixtures ───────────────────────────────────────────────────────────────────
-- Three accounts. A and B are invited; C is not. Everything else about them is identical,
-- so any difference in what the reservation does is the eligibility rule and nothing else.
CREATE TEMP TABLE t_ids (label text primary key, user_id uuid, conn_id uuid);
INSERT INTO t_ids VALUES
  ('A', '00000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-00000000000a'),
  ('B', '00000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-00000000000b'),
  ('C', '00000000-0000-4000-8000-00000000000c', '10000000-0000-4000-8000-00000000000c');

DO $fix$
DECLARE
  r record;
  v_consent text := 'ol-disc-' || repeat('e', 32);
BEGIN
  FOR r IN SELECT * FROM t_ids ORDER BY label LOOP
    INSERT INTO auth.users (id, email, email_confirmed_at, created_at, updated_at)
    VALUES (r.user_id, r.label || '@cohort.test', now(), now(), now())
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.microsoft_connections
      (id, user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes, status,
       needs_reauth, consented_at, consent_policy_version)
    VALUES (r.conn_id, r.user_id, 'acct-' || r.label, 'consumers', 'personal',
            r.label || '@cohort.test',
            ARRAY['Mail.Read', 'User.Read', 'offline_access'], 'active',
            false, now(), v_consent);

    -- Due: a last success well past DUE_AFTER_SECONDS, completed, no backoff, no lease.
    INSERT INTO public.outlook_sync_state
      (connection_id, user_id, folder, sync_status, initial_import_done,
       last_success_at, last_attempt_at, last_run_complete)
    VALUES
      (r.conn_id, r.user_id, 'inbox',     'idle', true, now() - interval '2 hours', now() - interval '2 hours', true),
      (r.conn_id, r.user_id, 'sentitems', 'idle', true, now() - interval '2 hours', now() - interval '2 hours', true);
  END LOOP;
END
$fix$;

-- Helper: reserve with a given eligible set and report which label came back.
CREATE OR REPLACE FUNCTION pg_temp.who (p_ids uuid[])
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v jsonb;
  v_label text;
BEGIN
  v := public.reserve_due_outlook_connection(60, 900, NULL, p_ids);
  IF v->>'result' <> 'reserved' THEN RETURN v->>'result'; END IF;
  SELECT ti.label INTO v_label FROM t_ids ti WHERE ti.conn_id = (v->>'connection_id')::uuid;
  RETURN COALESCE(v_label, 'UNKNOWN:' || (v->>'connection_id'));
END
$$;

-- Helper: hand a reserved connection back, idle and complete, with no backoff.
CREATE OR REPLACE FUNCTION pg_temp.release (p_label text, p_success boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.outlook_sync_state s
     SET sync_status = 'idle', sync_run_id = NULL, sync_lease_until = NULL,
         last_run_complete = true,
         last_success_at = CASE WHEN p_success THEN now() ELSE s.last_success_at END,
         next_retry_at = NULL, retry_count = 0
   WHERE s.connection_id = (SELECT conn_id FROM t_ids ti WHERE ti.label = p_label);
END
$$;

CREATE OR REPLACE FUNCTION pg_temp.must (p_ok boolean, p_what text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', p_what; END IF;
  RAISE NOTICE '  ok   %', p_what;
END
$$;

-- ══ 1. the excluded account is never reserved ══════════════════════════════════
DO $t1$
DECLARE
  a uuid := (SELECT user_id FROM t_ids ti WHERE ti.label = 'A');
  b uuid := (SELECT user_id FROM t_ids ti WHERE ti.label = 'B');
  seen text[] := '{}';
  got  text;
  i    int;
BEGIN
  RAISE NOTICE '1. eligibility is decided in SQL';
  -- Ten reservations in a row, releasing each time. C is due throughout and must never
  -- appear - not once, not after the invited accounts become un-due.
  FOR i IN 1..10 LOOP
    got := pg_temp.who(ARRAY[a, b]);
    IF got IN ('A', 'B') THEN
      seen := seen || got;
      PERFORM pg_temp.release(got);
    END IF;
  END LOOP;
  PERFORM pg_temp.must(NOT ('C' = ANY (seen)), 'the excluded account is never reserved');
  PERFORM pg_temp.must('A' = ANY (seen) AND 'B' = ANY (seen),
    'both invited accounts are reserved across repeated calls');
  -- And nothing was written for C: no lease, no attempt stamp, no wake cutoff.
  PERFORM pg_temp.must((SELECT bool_and(sync_status = 'idle' AND sync_lease_until IS NULL
                                        AND wake_cutoff_at IS NULL
                                        AND last_attempt_at < now() - interval '1 hour')
                          FROM public.outlook_sync_state
                         WHERE connection_id = (SELECT conn_id FROM t_ids ti WHERE ti.label = 'C')),
    'the excluded account has no lease, no fresh attempt stamp and no wake cutoff');
END
$t1$;

-- ══ 2. an empty set invites nobody; a malformed set is an error ════════════════
DO $t2$
DECLARE
  a uuid := (SELECT user_id FROM t_ids ti WHERE ti.label = 'A');
  v jsonb;
  caught text;
BEGIN
  RAISE NOTICE '2. fail-closed and malformed sets';
  v := public.reserve_due_outlook_connection(60, 900, NULL, ARRAY[]::uuid[]);
  PERFORM pg_temp.must(v->>'result' = 'none_due', 'an EMPTY eligible set reserves nobody');

  BEGIN
    v := public.reserve_due_outlook_connection(60, 900, NULL, ARRAY[a, NULL]::uuid[]);
    caught := 'no error';
  EXCEPTION WHEN others THEN caught := SQLERRM;
  END;
  PERFORM pg_temp.must(caught = 'invalid_pilot_user_ids',
    'a NULL member is rejected rather than silently ignored');

  BEGIN
    v := public.reserve_due_outlook_connection(60, 900, NULL,
           (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 11)));
    caught := 'no error';
  EXCEPTION WHEN others THEN caught := SQLERRM;
  END;
  PERFORM pg_temp.must(caught = 'too_many_pilot_users',
    'a set over the cap of ten is rejected in SQL, not just in the application');
END
$t2$;

-- ══ 3. the pre-cohort contracts still hold ═════════════════════════════════════
DO $t3$
DECLARE
  c uuid := (SELECT user_id FROM t_ids ti WHERE ti.label = 'C');
  v jsonb;
  label text;
BEGIN
  RAISE NOTICE '3. single-id and both-null compatibility';
  -- The single-id path, which is what a worker deployed before this migration sends.
  v := public.reserve_due_outlook_connection(60, 900, c, NULL);
  SELECT t.label INTO label FROM t_ids t WHERE t.conn_id = (v->>'connection_id')::uuid;
  PERFORM pg_temp.must(v->>'result' = 'reserved' AND label = 'C',
    'the single-id argument still narrows to exactly that account');
  PERFORM pg_temp.release('C');
  UPDATE public.outlook_sync_state SET last_success_at = now() - interval '2 hours',
         last_attempt_at = now() - interval '2 hours', wake_cutoff_at = NULL
   WHERE connection_id = (SELECT conn_id FROM t_ids ti WHERE ti.label = 'C');

  -- The SET wins when both are given, so a stale scalar cannot widen the cohort.
  -- A was served during section 1, so make it due again first: the point here is which
  -- argument decides eligibility, not who happens to be due.
  UPDATE public.outlook_sync_state
     SET last_success_at = now() - interval '2 hours', last_attempt_at = now() - interval '2 hours',
         sync_status = 'idle', sync_lease_until = NULL, wake_cutoff_at = NULL,
         last_run_complete = true, next_retry_at = NULL
   WHERE connection_id = (SELECT ti.conn_id FROM t_ids ti WHERE ti.label = 'A');
  v := public.reserve_due_outlook_connection(60, 900, c,
         ARRAY[(SELECT user_id FROM t_ids ti WHERE ti.label = 'A')]);
  SELECT t.label INTO label FROM t_ids t WHERE t.conn_id = (v->>'connection_id')::uuid;
  PERFORM pg_temp.must(label = 'A', 'the SET takes precedence over the scalar');
  PERFORM pg_temp.release('A');

  -- Both null keeps the documented pre-cohort behaviour: whoever is due. B has not been
  -- served since the fixtures were written, so it is the one that is due here.
  v := public.reserve_due_outlook_connection(60, 900, NULL, NULL);
  PERFORM pg_temp.must(v->>'result' = 'reserved',
    'both-null still reserves whoever is due, as the proofs and harnesses rely on');
  SELECT t.label INTO label FROM t_ids t WHERE t.conn_id = (v->>'connection_id')::uuid;
  PERFORM pg_temp.release(label);
END
$t3$;

-- ══ 4. ordering, leases and backoff are untouched ══════════════════════════════
DO $t4$
DECLARE
  a uuid := (SELECT user_id FROM t_ids ti WHERE ti.label = 'A');
  b uuid := (SELECT user_id FROM t_ids ti WHERE ti.label = 'B');
  ca uuid := (SELECT conn_id FROM t_ids ti WHERE ti.label = 'A');
  cb uuid := (SELECT conn_id FROM t_ids ti WHERE ti.label = 'B');
  v jsonb;
  label text;
BEGIN
  RAISE NOTICE '4. ordering, lease and backoff';
  -- Reset both to due, with A unserved for longer than B.
  UPDATE public.outlook_sync_state SET sync_status = 'idle', sync_lease_until = NULL,
         sync_run_id = NULL, next_retry_at = NULL, retry_count = 0, last_run_complete = true,
         wake_cutoff_at = NULL,
         last_success_at = now() - interval '3 hours', last_attempt_at = now() - interval '3 hours'
   WHERE connection_id = ca;
  UPDATE public.outlook_sync_state SET sync_status = 'idle', sync_lease_until = NULL,
         sync_run_id = NULL, next_retry_at = NULL, retry_count = 0, last_run_complete = true,
         wake_cutoff_at = NULL,
         last_success_at = now() - interval '1 hour', last_attempt_at = now() - interval '1 hour'
   WHERE connection_id = cb;
  UPDATE public.microsoft_connections SET wake_requested_at = NULL WHERE id IN (ca, cb);

  label := pg_temp.who(ARRAY[a, b]);
  PERFORM pg_temp.must(label = 'A', 'the longest-unserved invited account is reserved first');

  -- A now holds a live lease. The next call must take B, not A again: a lease is not
  -- bypassed by eligibility.
  label := pg_temp.who(ARRAY[a, b]);
  PERFORM pg_temp.must(label = 'B', 'a live lease on one account does not block the other');

  -- With both leased, there is nothing to reserve.
  PERFORM pg_temp.must(pg_temp.who(ARRAY[a, b]) = 'none_due',
    'two leased accounts leave nothing due - no double reservation');

  -- Release both, then put B in a failure backoff and give A a pending wake.
  PERFORM pg_temp.release('A', false);
  PERFORM pg_temp.release('B', false);
  UPDATE public.outlook_sync_state SET next_retry_at = now() + interval '20 minutes'
   WHERE connection_id = cb;
  UPDATE public.microsoft_connections SET wake_requested_at = now() WHERE id = ca;
  label := pg_temp.who(ARRAY[a, b]);
  PERFORM pg_temp.must(label = 'A', 'a signalled account is reserved, and a backoff is respected');
  PERFORM pg_temp.must((SELECT wake_cutoff_at IS NOT NULL FROM public.outlook_sync_state
                         WHERE connection_id = ca LIMIT 1),
    'the wake cutoff is stamped when the round starts');
  PERFORM pg_temp.release('A');

  -- B is still inside its backoff, so even as the only eligible account it is not reserved.
  PERFORM pg_temp.must(pg_temp.who(ARRAY[b]) = 'none_due',
    'a backoff is not bypassed by being the only eligible account');
  UPDATE public.outlook_sync_state SET next_retry_at = NULL WHERE connection_id = cb;
  PERFORM pg_temp.must(pg_temp.who(ARRAY[b]) = 'B', 'and it is reservable once the backoff passes');
  PERFORM pg_temp.release('B');
END
$t4$;

-- ══ 5. one function, and only service_role may execute it ══════════════════════
DO $t5$
DECLARE
  n int;
BEGIN
  RAISE NOTICE '5. resolution and grants';
  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'reserve_due_outlook_connection';
  PERFORM pg_temp.must(n = 1,
    'exactly ONE reserve_due_outlook_connection exists, so PostgREST has nothing to choose');

  PERFORM pg_temp.must(
    -- Postgres stores `SET search_path = ''` as search_path="" on this version, so the
    -- assertion is on the SETTING rather than on one spelling of it.
    (SELECT p.prosecdef
            AND array_to_string(p.proconfig, ',') IN ('search_path=', 'search_path=""')
       FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'reserve_due_outlook_connection'),
    'it is SECURITY DEFINER with an empty search_path');

  PERFORM pg_temp.must(
    (SELECT has_function_privilege('service_role',
       'public.reserve_due_outlook_connection(integer,integer,uuid,uuid[])', 'EXECUTE')),
    'service_role may execute it');
  PERFORM pg_temp.must(
    (SELECT NOT has_function_privilege('anon',
       'public.reserve_due_outlook_connection(integer,integer,uuid,uuid[])', 'EXECUTE')),
    'anon may NOT - the DROP and CREATE did not re-open it');
  PERFORM pg_temp.must(
    (SELECT NOT has_function_privilege('authenticated',
       'public.reserve_due_outlook_connection(integer,integer,uuid,uuid[])', 'EXECUTE')),
    'authenticated may NOT either');
  PERFORM pg_temp.must(
    (SELECT array_position(p.proacl::text[], 'PUBLIC=X/postgres') IS NULL
       FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'reserve_due_outlook_connection'),
    'and PUBLIC is absent from the explicit ACL');
END
$t5$;

-- ══ 6. per-account isolation of the state the worker writes ════════════════════
DO $t6$
DECLARE
  ca uuid := (SELECT conn_id FROM t_ids ti WHERE ti.label = 'A');
  cb uuid := (SELECT conn_id FROM t_ids ti WHERE ti.label = 'B');
  ua uuid := (SELECT user_id FROM t_ids ti WHERE ti.label = 'A');
  ub uuid := (SELECT user_id FROM t_ids ti WHERE ti.label = 'B');
  n int;
BEGIN
  RAISE NOTICE '6. isolation and per-account subscriptions';
  -- Reserving A touches only A's rows.
  UPDATE public.outlook_sync_state SET last_success_at = now() - interval '3 hours',
         sync_status = 'idle', sync_lease_until = NULL, last_run_complete = true
   WHERE connection_id IN (ca, cb);
  PERFORM pg_temp.who(ARRAY[ua]);
  SELECT count(*) INTO n FROM public.outlook_sync_state
   WHERE connection_id = cb AND (sync_status <> 'idle' OR sync_lease_until IS NOT NULL);
  PERFORM pg_temp.must(n = 0, 'reserving one account leaves the other account''s rows alone');
  PERFORM pg_temp.release('A');

  -- One subscription row per connection, each with its own id and client-state hash.
  INSERT INTO public.outlook_subscriptions
    (connection_id, user_id, subscription_id, client_state_hash, status, expires_at)
  VALUES (ca, ua, 'sub-A', repeat('a', 64), 'active', now() + interval '3 days'),
         (cb, ub, 'sub-B', repeat('b', 64), 'active', now() + interval '3 days');
  SELECT count(*) INTO n FROM public.outlook_subscriptions WHERE connection_id = ca;
  PERFORM pg_temp.must(n = 1, 'account A has exactly one subscription row');
  SELECT count(*) INTO n FROM public.outlook_subscriptions WHERE connection_id = cb;
  PERFORM pg_temp.must(n = 1, 'and so does account B, independently');

  -- A notification for one subscription wakes THAT connection only.
  PERFORM public.record_outlook_change_notification('sub-A', repeat('a', 64), 'change');
  PERFORM pg_temp.must(
    (SELECT wake_requested_at IS NOT NULL FROM public.microsoft_connections WHERE id = ca)
    AND (SELECT wake_requested_at IS NULL FROM public.microsoft_connections WHERE id = cb),
    'a notification wakes only the connection whose subscription it names');
  UPDATE public.microsoft_connections SET wake_requested_at = NULL WHERE id = ca;

  -- The worker-only tables are RLS-on with no user policy, for every one of them.
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('outlook_sync_state', 'outlook_candidate_refs',
                       'outlook_thread_recovery', 'outlook_subscriptions');
  PERFORM pg_temp.must(n = 0, 'no user-facing policy exists on any worker-only table');
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relrowsecurity
     AND c.relname IN ('outlook_sync_state', 'outlook_candidate_refs',
                       'outlook_thread_recovery', 'outlook_subscriptions');
  PERFORM pg_temp.must(n = 4, 'and RLS is enabled on all four');
END
$t6$;

ROLLBACK;
