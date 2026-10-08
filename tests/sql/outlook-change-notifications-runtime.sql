-- NEAR-REAL-TIME WAKE-UPS AND THE SUBSCRIPTION RECORD, proven against a real Postgres with
-- every migration applied - including the UNAPPLIED 20261009000000, which this file is about.
--
-- WHAT IS PROVEN HERE, by executing the real functions:
--
--   1. SCHEMA AND GRANTS: the subscription table exists with RLS on and no privilege for anon
--      or authenticated; one overload each of the new functions; worker RPCs service_role-only,
--      the status RPC authenticated-only.
--   2. A WAKE-UP MAKES A CONNECTION DUE NOW. A connection that synced successfully a minute
--      ago is NOT due on the 900-second routine interval; after an accepted notification it
--      IS, and the reservation reports when the signal arrived.
--   3. LEASES STILL EXCLUDE. A second reservation while a run is in progress answers none_due.
--   4. A SIGNAL DURING A RUN SURVIVES THE RUN. It is not cleared by that run's complete
--      release; the next reservation picks it up; THAT run's complete release clears it.
--   5. BACKOFF IS RESPECTED: a pending wake-up does not bypass next_retry_at.
--   6. THE NOTIFICATION RPC: unknown subscription, wrong clientState hash, inactive connection
--      and invalid kind are refused without any wake-up; lifecycle events update the
--      subscription state (reauthorize, removed) and 'missed' wakes the connection.
--   7. THE SUBSCRIPTION WRITE is fenced on the run id; a renewal keeps created_at and stamps
--      renewed_at; a new identity restarts the lifetime; invalid shapes are refused.
--   8. THE STATUS RPC answers real state for the signed-in user only.
--   9. DISCONNECT CASCADES: the local cleanup deletes the subscription record with the connection.
--  10. THE SCHEDULE exists, is INACTIVE, reads both secrets from Vault, and embeds no secret.
--  11. THE BATCH RPC the endpoint calls answers every item in order; a mixed batch answers
--      each item for itself; an unknown kind or an oversized batch raises.
--  12. THE ROUND CUTOFF: a signal that arrives while a round is PAUSED in finalisation is
--      NOT consumed when a later invocation completes that round (its lease is newer than
--      the signal, but its discovery is not); the next FRESH round consumes it. Reproduced
--      against the real worker in tests/local/outlook-worker-token-access.mjs.
--
-- Separate DO blocks are deliberate where ORDER IN TIME matters: now() is fixed within one
-- transaction, and the wake-up/run-start comparison needs distinct instants.
--
-- HOW TO BUILD THE DATABASE THIS NEEDS: tests/sql/_bootstrap-disposable-db.sql, then every
-- migration in supabase/migrations, in filename order. Says nothing about Production, where
-- 20261009000000 is UNAPPLIED.
\set ON_ERROR_STOP on

-- ══ fixtures ═══════════════════════════════════════════════════════════════
DO $$
DECLARE
  u    uuid := '47474747-4747-4747-4747-474747474747';
  u2   uuid := '48484848-4848-4848-4848-484848484848';
  conn uuid := '58585858-5858-5858-5858-585858585858';
BEGIN
  DELETE FROM public.outlook_candidate_refs    WHERE user_id IN (u, u2);
  DELETE FROM public.interaction_candidates    WHERE user_id IN (u, u2);
  DELETE FROM public.new_contact_candidates    WHERE user_id IN (u, u2);
  DELETE FROM public.contacts                  WHERE user_id IN (u, u2);
  DELETE FROM public.microsoft_connections     WHERE user_id IN (u, u2);
  INSERT INTO auth.users (id, email) VALUES (u, 'wake@getfunnl.test'), (u2, 'other@getfunnl.test') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, email) VALUES (u, 'wake@getfunnl.test'), (u2, 'other@getfunnl.test') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.microsoft_connections
    (id, user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, needs_reauth, consented_at, consent_policy_version)
  VALUES
    (conn, u, 'acct-wake', '9188040d-6c67-4c5b-b112-36a304b66dad', 'personal',
     'wake@outlook.test', ARRAY['Mail.Read','User.Read','offline_access'],
     'active', false, now(), 'ol-disc-e3e2b1714b453c2904e3ed08cb232097');
  -- Both folders synced completely ONE MINUTE AGO: not due on the routine interval.
  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, initial_import_done, last_success_at, last_attempt_at, last_run_complete, updated_at)
  VALUES
    (conn, u, 'inbox',     'idle', true, now() - interval '60 seconds', now() - interval '60 seconds', true, now()),
    (conn, u, 'sentitems', 'idle', true, now() - interval '60 seconds', now() - interval '60 seconds', true, now());
END $$;

-- ══ 1. schema and grants ═══════════════════════════════════════════════════
DO $$
DECLARE n int;
BEGIN
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.outlook_subscriptions'::regclass), 'RLS must be on';
  ASSERT NOT has_table_privilege('anon', 'public.outlook_subscriptions', 'SELECT'), 'anon must not read subscriptions';
  ASSERT NOT has_table_privilege('authenticated', 'public.outlook_subscriptions', 'SELECT'), 'authenticated must not read subscriptions';
  ASSERT has_table_privilege('service_role', 'public.outlook_subscriptions', 'SELECT'), 'the worker reads through service_role';
  FOR n IN SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
            WHERE s.nspname = 'public' AND p.proname = 'reserve_due_outlook_connection' LOOP
    ASSERT n = 1, 'exactly ONE reserve_due_outlook_connection, found ' || n;
  END LOOP;
  ASSERT has_function_privilege('service_role', 'public.reserve_due_outlook_connection(integer,integer,uuid)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated', 'public.reserve_due_outlook_connection(integer,integer,uuid)', 'EXECUTE');
  ASSERT has_function_privilege('service_role', 'public.record_outlook_change_notification(text,text,text)', 'EXECUTE');
  ASSERT NOT has_function_privilege('anon', 'public.record_outlook_change_notification(text,text,text)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated', 'public.record_outlook_change_notification(text,text,text)', 'EXECUTE');
  ASSERT has_function_privilege('service_role',
    'public.record_outlook_subscription_state(uuid,uuid,text,text,text,text,text,timestamptz,text)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated',
    'public.record_outlook_subscription_state(uuid,uuid,text,text,text,text,text,timestamptz,text)', 'EXECUTE');
  ASSERT has_function_privilege('authenticated', 'public.get_my_outlook_sync_status()', 'EXECUTE');
  ASSERT NOT has_function_privilege('anon', 'public.get_my_outlook_sync_status()', 'EXECUTE');
  ASSERT NOT has_function_privilege('service_role', 'public.get_my_outlook_sync_status()', 'EXECUTE');
  -- The new wake columns are NOT in the authenticated column grant on connections.
  ASSERT NOT has_column_privilege('authenticated', 'public.microsoft_connections', 'wake_requested_at', 'SELECT'), 'wake columns stay server-side';
END $$;

-- ══ 2a. not due on the routine interval, so first create the subscription record through a run ══
DO $$
DECLARE
  u uuid := '47474747-4747-4747-4747-474747474747'; conn uuid := '58585858-5858-5858-5858-585858585858';
  res jsonb; run uuid;
BEGIN
  res := public.reserve_due_outlook_connection(420, 900, u);
  ASSERT res->>'result' = 'none_due', 'a minute after a complete sync nothing is due: ' || res::text;
  -- Due with a zero interval - the way a first worker run would be - to obtain a lease.
  res := public.reserve_due_outlook_connection(420, 0, u);
  ASSERT res->>'result' = 'reserved', 'reservable with a zero interval: ' || res::text;
  ASSERT res->'wake_requested_at' = 'null'::jsonb, 'no wake-up yet: ' || res::text;
  run := (res->>'run_id')::uuid;
  -- A stale run id is refused.
  res := public.record_outlook_subscription_state(conn, pg_catalog.gen_random_uuid(), 'active', 'sub-one', 'me/messages', 'created',
    '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', now() + interval '3 days', NULL);
  ASSERT res->>'result' = 'stale_run', 'a run that does not hold the lease cannot record: ' || res::text;
  -- Invalid shapes are refused with controlled codes.
  res := public.record_outlook_subscription_state(conn, run, 'bogus', NULL, NULL, NULL, NULL, NULL, NULL);
  ASSERT res->>'result' = 'invalid_status', res::text;
  res := public.record_outlook_subscription_state(conn, run, 'active', NULL, NULL, NULL, NULL, NULL, NULL);
  ASSERT res->>'result' = 'invalid_subscription', 'active needs an id, a hash and an expiry: ' || res::text;
  res := public.record_outlook_subscription_state(conn, run, 'active', 'sub-one', 'me/messages', 'created', 'not-a-hash', now() + interval '3 days', NULL);
  ASSERT res->>'result' = 'invalid_subscription', 'the hash must be 64 hex: ' || res::text;
  -- The real record.
  res := public.record_outlook_subscription_state(conn, run, 'active', 'sub-one', 'me/messages', 'created',
    '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', now() + interval '3 days', NULL);
  ASSERT res->>'result' = 'recorded', res::text;
  ASSERT (SELECT status FROM public.outlook_subscriptions WHERE connection_id = conn) = 'active';
  -- Complete release: both folders idle, round erased, and (nothing to clear yet) no wake-up.
  ASSERT public.release_outlook_sync_lease(conn, run, 'idle', NULL, true, NULL, NULL, NULL, NULL, NULL, true, NULL), 'release';
  ASSERT (SELECT count(*) FROM public.outlook_sync_state WHERE connection_id = conn AND sync_status = 'idle' AND last_run_complete) = 2;
  ASSERT (SELECT wake_requested_at FROM public.microsoft_connections WHERE id = conn) IS NULL;
END $$;

-- ══ 2b. a notification makes the connection due NOW ════════════════════════
DO $$
DECLARE
  u uuid := '47474747-4747-4747-4747-474747474747'; conn uuid := '58585858-5858-5858-5858-585858585858';
  res jsonb;
BEGIN
  res := public.reserve_due_outlook_connection(420, 900, u);
  ASSERT res->>'result' = 'none_due', 'still not due on the routine interval: ' || res::text;
  res := public.record_outlook_change_notification('sub-one', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'change');
  ASSERT res->>'result' = 'accepted', 'a matching notification is accepted: ' || res::text;
  ASSERT (SELECT wake_requested_at FROM public.microsoft_connections WHERE id = conn) IS NOT NULL, 'the wake-up is recorded';
  ASSERT (SELECT wake_source FROM public.microsoft_connections WHERE id = conn) = 'change';
  ASSERT (SELECT wake_count FROM public.microsoft_connections WHERE id = conn) = 1;
  ASSERT (SELECT notifications_received FROM public.outlook_subscriptions WHERE connection_id = conn) = 1;
  -- A duplicate delivery coalesces: still ONE pending wake-up (a timestamp), count 2.
  res := public.record_outlook_change_notification('sub-one', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'change');
  ASSERT res->>'result' = 'accepted';
  ASSERT (SELECT wake_count FROM public.microsoft_connections WHERE id = conn) = 2;
END $$;

DO $$
DECLARE
  u uuid := '47474747-4747-4747-4747-474747474747'; conn uuid := '58585858-5858-5858-5858-585858585858';
  res jsonb; run uuid; again jsonb;
BEGIN
  res := public.reserve_due_outlook_connection(420, 900, u);
  ASSERT res->>'result' = 'reserved', 'the wake-up makes it due without waiting 900 seconds: ' || res::text;
  ASSERT res->'wake_requested_at' <> 'null'::jsonb, 'and the reservation reports when the signal arrived: ' || res::text;
  run := (res->>'run_id')::uuid;
  -- ══ 3. a second reservation while this run holds the lease: none_due ══
  again := public.reserve_due_outlook_connection(420, 0, u);
  ASSERT again->>'result' = 'none_due', 'the lease excludes an overlapping run: ' || again::text;
  -- Park the run id for the next blocks.
  PERFORM set_config('test.run_a', run::text, false);
END $$;

-- ══ 4. a signal DURING the run survives that run's complete release ═════════
DO $$
DECLARE res jsonb;
BEGIN
  PERFORM pg_sleep(0.05);
  res := public.record_outlook_change_notification('sub-one', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'change');
  ASSERT res->>'result' = 'accepted', 'a notification during a run is still accepted: ' || res::text;
END $$;

DO $$
DECLARE
  conn uuid := '58585858-5858-5858-5858-585858585858'; run uuid := current_setting('test.run_a')::uuid;
  started timestamptz;
BEGIN
  SELECT min(run_started_at) INTO started FROM public.outlook_sync_state WHERE connection_id = conn;
  ASSERT (SELECT wake_requested_at FROM public.microsoft_connections WHERE id = conn) > started, 'the signal postdates the run start';
  ASSERT public.release_outlook_sync_lease(conn, run, 'idle', NULL, true, NULL, NULL, NULL, NULL, NULL, true, NULL);
  ASSERT (SELECT wake_requested_at FROM public.microsoft_connections WHERE id = conn) IS NOT NULL,
    'a signal that arrived during the run is NOT consumed by that run';
END $$;

DO $$
DECLARE
  u uuid := '47474747-4747-4747-4747-474747474747'; conn uuid := '58585858-5858-5858-5858-585858585858';
  res jsonb; run uuid;
BEGIN
  PERFORM pg_sleep(0.05);
  res := public.reserve_due_outlook_connection(420, 900, u);
  ASSERT res->>'result' = 'reserved', 'the surviving signal makes the next run due: ' || res::text;
  run := (res->>'run_id')::uuid;
  ASSERT public.release_outlook_sync_lease(conn, run, 'idle', NULL, true, NULL, NULL, NULL, NULL, NULL, true, NULL);
  ASSERT (SELECT wake_requested_at FROM public.microsoft_connections WHERE id = conn) IS NULL,
    'a signal that predates the run IS consumed by its complete release';
  ASSERT (SELECT last_wake_at FROM public.microsoft_connections WHERE id = conn) IS NOT NULL, 'the last signal time is kept for measurement';
  res := public.reserve_due_outlook_connection(420, 900, u);
  ASSERT res->>'result' = 'none_due', 'and nothing is due again until the routine interval: ' || res::text;
END $$;

-- ══ 4b. an INCOMPLETE release keeps the signal (the run did not finish the mailbox) ═══
DO $$
DECLARE
  u uuid := '47474747-4747-4747-4747-474747474747'; conn uuid := '58585858-5858-5858-5858-585858585858';
  res jsonb; run uuid;
BEGIN
  res := public.record_outlook_change_notification('sub-one', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'change');
  ASSERT res->>'result' = 'accepted';
END $$;
DO $$
DECLARE
  u uuid := '47474747-4747-4747-4747-474747474747'; conn uuid := '58585858-5858-5858-5858-585858585858';
  res jsonb; run uuid;
BEGIN
  PERFORM pg_sleep(0.05);
  res := public.reserve_due_outlook_connection(420, 900, u);
  ASSERT res->>'result' = 'reserved', res::text;
  run := (res->>'run_id')::uuid;
  -- `continued`: idle, NOT complete, no backoff.
  ASSERT public.release_outlook_sync_lease(conn, run, 'idle', NULL, false, NULL, NULL, NULL, NULL, NULL, false, NULL);
  ASSERT (SELECT wake_requested_at FROM public.microsoft_connections WHERE id = conn) IS NOT NULL,
    'an interrupted run does not consume the signal';
  -- The continuation is due right away, as before (incomplete, retry_count < 10, attempt old enough is not
  -- required because the wake-up alone makes it due).
  res := public.reserve_due_outlook_connection(420, 900, u);
  ASSERT res->>'result' = 'reserved', 'the continuation is due: ' || res::text;
  run := (res->>'run_id')::uuid;
  ASSERT public.release_outlook_sync_lease(conn, run, 'idle', NULL, true, NULL, NULL, NULL, NULL, NULL, true, NULL);
  ASSERT (SELECT wake_requested_at FROM public.microsoft_connections WHERE id = conn) IS NULL;
END $$;

-- ══ 5. backoff is respected: a wake-up does not bypass next_retry_at ═══════
DO $$
DECLARE
  u uuid := '47474747-4747-4747-4747-474747474747'; conn uuid := '58585858-5858-5858-5858-585858585858';
  res jsonb;
BEGIN
  res := public.record_outlook_change_notification('sub-one', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'change');
  ASSERT res->>'result' = 'accepted';
  UPDATE public.outlook_sync_state SET next_retry_at = now() + interval '1 hour', retry_count = 1, last_error_code = 'graph_failed'
   WHERE connection_id = conn AND folder = 'inbox';
  res := public.reserve_due_outlook_connection(420, 900, u);
  ASSERT res->>'result' = 'none_due', 'inside a backoff the wake-up waits: ' || res::text;
  UPDATE public.outlook_sync_state SET next_retry_at = NULL, retry_count = 0, last_error_code = NULL WHERE connection_id = conn;
  res := public.reserve_due_outlook_connection(420, 900, u);
  ASSERT res->>'result' = 'reserved', 'and is honoured once the backoff passes: ' || res::text;
  ASSERT public.release_outlook_sync_lease(conn, (res->>'run_id')::uuid, 'idle', NULL, true, NULL, NULL, NULL, NULL, NULL, true, NULL);
END $$;

-- ══ 6. the notification RPC refuses what it must, and records lifecycle events ═══
DO $$
DECLARE
  conn uuid := '58585858-5858-5858-5858-585858585858';
  res jsonb; wake_before timestamptz; n_before integer; raised boolean := false;
BEGIN
  SELECT wake_requested_at INTO wake_before FROM public.microsoft_connections WHERE id = conn;
  SELECT notifications_received INTO n_before FROM public.outlook_subscriptions WHERE connection_id = conn;
  ASSERT wake_before IS NULL, 'clean slate';
  res := public.record_outlook_change_notification('sub-unknown', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'change');
  ASSERT res->>'result' = 'unknown_subscription', res::text;
  res := public.record_outlook_change_notification('sub-one', '5f0a024a77aca6976bdb7e9495cf0e39999edf8499de4374e02391f0d0dac3bb', 'change');
  ASSERT res->>'result' = 'client_state_mismatch', 'a wrong clientState is refused: ' || res::text;
  res := public.record_outlook_change_notification('sub-one', 'zzz', 'change');
  ASSERT res->>'result' = 'client_state_mismatch', 'a malformed hash is refused: ' || res::text;
  ASSERT (SELECT wake_requested_at FROM public.microsoft_connections WHERE id = conn) IS NULL, 'NO wake-up from a refused notification';
  ASSERT (SELECT notifications_received FROM public.outlook_subscriptions WHERE connection_id = conn) = n_before, 'and nothing counted';
  BEGIN
    res := public.record_outlook_change_notification('sub-one', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'deleted');
  EXCEPTION WHEN OTHERS THEN raised := true;
  END;
  ASSERT raised, 'an unknown kind is an exception, not a wake-up';
  -- An inactive connection: refused, no wake-up.
  UPDATE public.microsoft_connections SET needs_reauth = true WHERE id = conn;
  res := public.record_outlook_change_notification('sub-one', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'change');
  ASSERT res->>'result' = 'connection_inactive', res::text;
  ASSERT (SELECT wake_requested_at FROM public.microsoft_connections WHERE id = conn) IS NULL;
  UPDATE public.microsoft_connections SET needs_reauth = false WHERE id = conn;
  -- Lifecycle: reauthorizationRequired marks the subscription and wakes the connection.
  res := public.record_outlook_change_notification('sub-one', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'reauthorizationRequired');
  ASSERT res->>'result' = 'accepted', res::text;
  ASSERT (SELECT status FROM public.outlook_subscriptions WHERE connection_id = conn) = 'reauthorize';
  ASSERT (SELECT last_lifecycle_event FROM public.outlook_subscriptions WHERE connection_id = conn) = 'reauthorizationRequired';
  ASSERT (SELECT wake_source FROM public.microsoft_connections WHERE id = conn) = 'reauthorizationRequired';
  -- missed: wake, status unchanged.
  res := public.record_outlook_change_notification('sub-one', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'missed');
  ASSERT res->>'result' = 'accepted';
  ASSERT (SELECT status FROM public.outlook_subscriptions WHERE connection_id = conn) = 'reauthorize';
  ASSERT (SELECT wake_source FROM public.microsoft_connections WHERE id = conn) = 'missed';
  -- subscriptionRemoved: marked removed; the next run recreates it.
  res := public.record_outlook_change_notification('sub-one', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'subscriptionRemoved');
  ASSERT res->>'result' = 'accepted';
  ASSERT (SELECT status FROM public.outlook_subscriptions WHERE connection_id = conn) = 'removed';
END $$;

-- ══ 7. renewal keeps the lifetime start; a new identity restarts it ═════════
DO $$
DECLARE
  u uuid := '47474747-4747-4747-4747-474747474747'; conn uuid := '58585858-5858-5858-5858-585858585858';
  res jsonb; run uuid; created0 timestamptz;
BEGIN
  res := public.reserve_due_outlook_connection(420, 900, u);   -- due: the lifecycle wake-ups above
  ASSERT res->>'result' = 'reserved', res::text;
  run := (res->>'run_id')::uuid;
  SELECT created_at INTO created0 FROM public.outlook_subscriptions WHERE connection_id = conn;
  -- Renewal of the SAME id: created_at unchanged, renewed_at stamped, status back to active.
  res := public.record_outlook_subscription_state(conn, run, 'active', 'sub-one', 'me/messages', 'created',
    '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', now() + interval '3 days', NULL);
  ASSERT res->>'result' = 'recorded';
  ASSERT (SELECT created_at FROM public.outlook_subscriptions WHERE connection_id = conn) = created0, 'renewal keeps created_at';
  ASSERT (SELECT renewed_at FROM public.outlook_subscriptions WHERE connection_id = conn) IS NOT NULL, 'renewal stamps renewed_at';
  ASSERT (SELECT status FROM public.outlook_subscriptions WHERE connection_id = conn) = 'active';
  -- A NEW identity (recreated): created_at restarts, the old id no longer matches.
  res := public.record_outlook_subscription_state(conn, run, 'active', 'sub-two', 'me/messages', 'created',
    '5f0a024a77aca6976bdb7e9495cf0e39999edf8499de4374e02391f0d0dac3bb', now() + interval '3 days', NULL);
  ASSERT res->>'result' = 'recorded';
  ASSERT (SELECT created_at FROM public.outlook_subscriptions WHERE connection_id = conn) >= created0;
  ASSERT (SELECT subscription_id FROM public.outlook_subscriptions WHERE connection_id = conn) = 'sub-two';
  res := public.record_outlook_change_notification('sub-one', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'change');
  ASSERT res->>'result' = 'unknown_subscription', 'the superseded id is unknown: ' || res::text;
  -- A failed creation is recordable too (no identity), and a failed row cannot be 'active'.
  res := public.record_outlook_subscription_state(conn, run, 'failed', NULL, 'me/messages', 'created', NULL, NULL, 'bad_request');
  ASSERT res->>'result' = 'recorded';
  ASSERT (SELECT last_error_code FROM public.outlook_subscriptions WHERE connection_id = conn) = 'bad_request';
  -- Restore an active record for the remaining sections.
  res := public.record_outlook_subscription_state(conn, run, 'active', 'sub-two', 'me/messages', 'created',
    '5f0a024a77aca6976bdb7e9495cf0e39999edf8499de4374e02391f0d0dac3bb', now() + interval '3 days', NULL);
  ASSERT public.release_outlook_sync_lease(conn, run, 'idle', NULL, true, NULL, NULL, NULL, NULL, NULL, true, NULL);
END $$;

-- ══ 8. the status RPC, as the signed-in user ═══════════════════════════════
SELECT set_config('request.jwt.claim.sub', '47474747-4747-4747-4747-474747474747', false);
SELECT set_config('request.jwt.claims', json_build_object('sub', '47474747-4747-4747-4747-474747474747')::text, false);
DO $$
DECLARE res jsonb; u uuid := '47474747-4747-4747-4747-474747474747'; cid uuid;
BEGIN
  res := public.get_my_outlook_sync_status();
  ASSERT res->>'result' = 'connected', res::text;
  ASSERT res->>'activity' = 'idle', 'idle after a complete release: ' || res::text;
  ASSERT (res->>'last_run_complete')::boolean, res::text;
  ASSERT (res->>'wake_pending')::boolean = false, res::text;
  ASSERT res->'subscription'->>'status' = 'active', res::text;
  ASSERT (res->>'pending_suggestions')::integer = 0, res::text;
  ASSERT (res->>'schedule_active')::boolean = false, 'the tick is inactive, and the card is told so: ' || res::text;
  ASSERT res->>'last_success_at' IS NOT NULL;
  -- A pending Outlook suggestion is counted; a wake-up shows as pending.
  INSERT INTO public.contacts (user_id, name, email) VALUES (u, 'Ava Recruiter', 'ava@bank.test') RETURNING id INTO cid;
  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, status, source_last_state, context_expires_at, proposed_notes)
  VALUES (u, cid, 'outlook', repeat('a', 64), 'Email', current_date, 'pending', 'active', now() + interval '30 days', 'A note.');
  res := public.record_outlook_change_notification('sub-two', '5f0a024a77aca6976bdb7e9495cf0e39999edf8499de4374e02391f0d0dac3bb', 'change');
  ASSERT res->>'result' = 'accepted';
  res := public.get_my_outlook_sync_status();
  ASSERT (res->>'pending_suggestions')::integer = 1, res::text;
  ASSERT (res->>'wake_pending')::boolean = true, res::text;
  ASSERT res->>'last_wake_at' IS NOT NULL;
  -- A failed last check with a scheduled retry is reported as such, from the row.
  UPDATE public.outlook_sync_state SET last_error_code = 'graph_failed', next_retry_at = now() + interval '20 minutes', sync_status = 'error'
   WHERE connection_id = '58585858-5858-5858-5858-585858585858' AND folder = 'inbox';
  res := public.get_my_outlook_sync_status();
  ASSERT res->>'activity' = 'retry_scheduled', res::text;
  ASSERT res->>'last_error_code' = 'graph_failed', res::text;
  UPDATE public.outlook_sync_state SET last_error_code = NULL, next_retry_at = NULL, sync_status = 'idle'
   WHERE connection_id = '58585858-5858-5858-5858-585858585858';
END $$;
-- Another signed-in user sees NOT connected, never this user's state.
SELECT set_config('request.jwt.claim.sub', '48484848-4848-4848-4848-484848484848', false);
SELECT set_config('request.jwt.claims', json_build_object('sub', '48484848-4848-4848-4848-484848484848')::text, false);
DO $$
DECLARE res jsonb;
BEGIN
  res := public.get_my_outlook_sync_status();
  ASSERT res->>'result' = 'not_connected', res::text;
END $$;
SELECT set_config('request.jwt.claim.sub', NULL, false);
SELECT set_config('request.jwt.claims', NULL, false);
DO $$
DECLARE res jsonb;
BEGIN
  res := public.get_my_outlook_sync_status();
  ASSERT res->>'result' = 'unauthorized', res::text;
END $$;

-- ══ 9. disconnect cascades to the subscription record ══════════════════════
DO $$
DECLARE u uuid := '47474747-4747-4747-4747-474747474747'; conn uuid := '58585858-5858-5858-5858-585858585858'; res jsonb;
BEGIN
  ASSERT (SELECT count(*) FROM public.outlook_subscriptions WHERE connection_id = conn) = 1;
  res := public.run_microsoft_local_cleanup(u);
  ASSERT (res->>'connections_deleted')::integer = 1, res::text;
  ASSERT (SELECT count(*) FROM public.outlook_subscriptions WHERE connection_id = conn) = 0, 'the subscription record is gone with the connection';
  res := public.record_outlook_change_notification('sub-two', '5f0a024a77aca6976bdb7e9495cf0e39999edf8499de4374e02391f0d0dac3bb', 'change');
  ASSERT res->>'result' = 'unknown_subscription', 'a late notification for a disconnected mailbox is refused: ' || res::text;
END $$;

-- ══ 10. the schedule: present, INACTIVE, secrets from Vault, nothing embedded ═══
DO $$
DECLARE j record;
BEGIN
  SELECT * INTO j FROM cron.job WHERE jobname = 'outlook-worker-tick';
  ASSERT FOUND, 'the tick job exists';
  ASSERT j.active IS FALSE, 'the tick job is created INACTIVE';
  ASSERT j.schedule = '* * * * *', j.schedule;
  ASSERT position('vault.decrypted_secrets' in j.command) > 0, 'secrets come from Vault at run time';
  ASSERT position('outlook_worker_secret' in j.command) > 0 AND position('outlook_worker_url' in j.command) > 0;
  ASSERT position('Bearer ' in j.command) > 0;
  ASSERT position('supabase.co' in j.command) = 0, 'no URL is embedded';
  ASSERT (SELECT count(*) FROM vault.decrypted_secrets WHERE name IN ('outlook_worker_secret', 'outlook_worker_url')) = 0,
    'this database holds neither secret';
END $$;

-- ══ 11. the batch RPC: one round trip, one answer per item, in order ═══════
DO $$
DECLARE
  u uuid := '47474747-4747-4747-4747-474747474747'; conn uuid := '58585858-5858-5858-5858-585858585858';
  res jsonb; run uuid; raised boolean := false;
BEGIN
  -- A fresh connection with an active subscription (the previous sections disconnected).
  INSERT INTO public.microsoft_connections
    (id, user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes, status, needs_reauth, consented_at, consent_policy_version)
  VALUES (conn, u, 'acct-wake-2', '9188040d-6c67-4c5b-b112-36a304b66dad', 'personal', 'wake@outlook.test',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', false, now(), 'ol-disc-e3e2b1714b453c2904e3ed08cb232097');
  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, initial_import_done, last_success_at, last_attempt_at, last_run_complete)
  VALUES (conn, u, 'inbox', 'idle', true, now() - interval '60 seconds', now() - interval '60 seconds', true),
         (conn, u, 'sentitems', 'idle', true, now() - interval '60 seconds', now() - interval '60 seconds', true);
  res := public.reserve_due_outlook_connection(420, 0, u);
  run := (res->>'run_id')::uuid;
  res := public.record_outlook_subscription_state(conn, run, 'active', 'sub-batch', 'me/messages', 'created',
    '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', now() + interval '3 days', NULL);
  ASSERT res->>'result' = 'recorded';
  ASSERT public.release_outlook_sync_lease(conn, run, 'idle', NULL, true, NULL, NULL, NULL, NULL, NULL, true, NULL);

  -- A MIXED batch: accepted, unknown subscription, wrong hash - one call, three answers, in order.
  res := public.record_outlook_change_notification_batch(jsonb_build_array(
    jsonb_build_object('subscription_id', 'sub-batch', 'client_state_hash', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'kind', 'change'),
    jsonb_build_object('subscription_id', 'sub-nope',  'client_state_hash', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'kind', 'change'),
    jsonb_build_object('subscription_id', 'sub-batch', 'client_state_hash', '5f0a024a77aca6976bdb7e9495cf0e39999edf8499de4374e02391f0d0dac3bb', 'kind', 'change')));
  ASSERT jsonb_array_length(res->'results') = 3, res::text;
  ASSERT res->'results'->0->>'result' = 'accepted', res::text;
  ASSERT res->'results'->1->>'result' = 'unknown_subscription', res::text;
  ASSERT res->'results'->2->>'result' = 'client_state_mismatch', res::text;
  ASSERT (SELECT wake_count FROM public.microsoft_connections WHERE id = conn) = 1, 'exactly the accepted item woke the connection';
  -- Redelivery of the same batch: safe - the same answers, one more count, still one pending signal.
  res := public.record_outlook_change_notification_batch(jsonb_build_array(
    jsonb_build_object('subscription_id', 'sub-batch', 'client_state_hash', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'kind', 'change')));
  ASSERT res->'results'->0->>'result' = 'accepted';
  ASSERT (SELECT wake_count FROM public.microsoft_connections WHERE id = conn) = 2;
  -- An empty batch is fine; an unknown kind or a non-array raises (the endpoint allowlists kinds first).
  res := public.record_outlook_change_notification_batch('[]'::jsonb);
  ASSERT jsonb_array_length(res->'results') = 0;
  BEGIN
    res := public.record_outlook_change_notification_batch(jsonb_build_array(
      jsonb_build_object('subscription_id', 'sub-batch', 'client_state_hash', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'kind', 'deleted')));
  EXCEPTION WHEN OTHERS THEN raised := true; END;
  ASSERT raised, 'an unknown kind raises';
  raised := false;
  BEGIN
    res := public.record_outlook_change_notification_batch('{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN raised := true; END;
  ASSERT raised, 'a non-array raises';
  ASSERT has_function_privilege('service_role', 'public.record_outlook_change_notification_batch(jsonb)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated', 'public.record_outlook_change_notification_batch(jsonb)', 'EXECUTE');
  -- Clear the signal for section 12 by running a complete round.
  res := public.reserve_due_outlook_connection(420, 900, u);
  ASSERT res->>'result' = 'reserved', res::text;
  ASSERT public.release_outlook_sync_lease(conn, (res->>'run_id')::uuid, 'idle', NULL, true, NULL, NULL, NULL, NULL, NULL, true, NULL);
  ASSERT (SELECT wake_requested_at FROM public.microsoft_connections WHERE id = conn) IS NULL;
END $$;

-- ══ 12. the round cutoff: a signal during a PAUSED round survives the resuming invocation ══
-- Run A starts a round (fresh reservation stamps the cutoff), discovers, and pauses.
DO $$
DECLARE
  u uuid := '47474747-4747-4747-4747-474747474747'; conn uuid := '58585858-5858-5858-5858-585858585858';
  res jsonb; run uuid;
BEGIN
  res := public.reserve_due_outlook_connection(420, 0, u);
  ASSERT res->>'result' = 'reserved', res::text;
  run := (res->>'run_id')::uuid;
  ASSERT (SELECT count(*) FROM public.outlook_sync_state WHERE connection_id = conn AND wake_cutoff_at IS NOT NULL) = 2,
    'a fresh reservation stamps the cutoff on both rows';
  PERFORM set_config('test.cutoff_a', (SELECT min(wake_cutoff_at)::text FROM public.outlook_sync_state WHERE connection_id = conn), false);
  -- Discovery happened in this invocation: the round is adopted (what record_outlook_page_progress does).
  UPDATE public.outlook_sync_state SET round_id = pg_catalog.gen_random_uuid(), round_started_at = now()
   WHERE connection_id = conn;
  -- Finalisation pauses: an INCOMPLETE release keeps the round.
  ASSERT public.release_outlook_sync_lease(conn, run, 'idle', NULL, false, NULL, NULL, NULL, NULL, NULL, false, NULL);
  ASSERT (SELECT count(*) FROM public.outlook_sync_state WHERE connection_id = conn AND round_id IS NOT NULL) = 2, 'the round is kept';
END $$;
-- New mail is signalled AFTER A's discovery.
DO $$
DECLARE res jsonb;
BEGIN
  PERFORM pg_sleep(0.05);
  res := public.record_outlook_change_notification('sub-batch', '62207479fd613eb0b98cbf40beb4094334d057dce0f64e2a2fea096114be246e', 'change');
  ASSERT res->>'result' = 'accepted';
END $$;
-- Run B resumes the SAME round (lease newer than the signal) and completes it.
DO $$
DECLARE
  u uuid := '47474747-4747-4747-4747-474747474747'; conn uuid := '58585858-5858-5858-5858-585858585858';
  res jsonb; run uuid; wake timestamptz;
BEGIN
  PERFORM pg_sleep(0.05);
  SELECT wake_requested_at INTO wake FROM public.microsoft_connections WHERE id = conn;
  res := public.reserve_due_outlook_connection(420, 900, u);
  ASSERT res->>'result' = 'reserved', 'the paused round (and the signal) make it due: ' || res::text;
  run := (res->>'run_id')::uuid;
  ASSERT (SELECT min(run_started_at) FROM public.outlook_sync_state WHERE connection_id = conn) > wake, 'B''s lease is newer than the signal';
  ASSERT (SELECT min(wake_cutoff_at)::text FROM public.outlook_sync_state WHERE connection_id = conn) = current_setting('test.cutoff_a'),
    'resuming a round keeps the cutoff of the reservation that started it';
  ASSERT public.release_outlook_sync_lease(conn, run, 'idle', NULL, true, NULL, NULL, NULL, NULL, NULL, true, NULL);
  ASSERT (SELECT wake_requested_at FROM public.microsoft_connections WHERE id = conn) IS NOT NULL,
    'THE DEFECT, fixed: completing the OLD round does not consume a signal newer than its discovery';
END $$;
-- Run C: a FRESH round (round_id NULL after the complete release) stamps a new cutoff after the
-- signal, reads the mail, and its complete release consumes the signal.
DO $$
DECLARE
  u uuid := '47474747-4747-4747-4747-474747474747'; conn uuid := '58585858-5858-5858-5858-585858585858';
  res jsonb; run uuid;
BEGIN
  PERFORM pg_sleep(0.05);
  res := public.reserve_due_outlook_connection(420, 900, u);
  ASSERT res->>'result' = 'reserved', 'the surviving signal makes the fresh round due: ' || res::text;
  run := (res->>'run_id')::uuid;
  ASSERT (SELECT min(wake_cutoff_at)::text FROM public.outlook_sync_state WHERE connection_id = conn) <> current_setting('test.cutoff_a'),
    'a fresh round stamps a new cutoff';
  ASSERT (SELECT min(wake_cutoff_at) FROM public.outlook_sync_state WHERE connection_id = conn)
         >= (SELECT wake_requested_at FROM public.microsoft_connections WHERE id = conn), 'and it is after the signal';
  ASSERT public.release_outlook_sync_lease(conn, run, 'idle', NULL, true, NULL, NULL, NULL, NULL, NULL, true, NULL);
  ASSERT (SELECT wake_requested_at FROM public.microsoft_connections WHERE id = conn) IS NULL, 'consumed by the round that read it';
  res := public.reserve_due_outlook_connection(420, 900, u);
  ASSERT res->>'result' = 'none_due', res::text;
  -- Leave nothing behind.
  PERFORM public.run_microsoft_local_cleanup(u);
END $$;

SELECT 'outlook-change-notifications-runtime: all assertions passed' AS result;
