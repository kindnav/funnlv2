-- Runtime verification for the Gmail pilot retention blockers.
--
-- RUN ONLY AGAINST A DISPOSABLE LOCAL SUPABASE STACK (after `supabase db reset`):
--   docker cp tests/sql/gmail-retention-runtime.sql supabase_db_<project>:/tmp/
--   docker exec supabase_db_<project> psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/gmail-retention-runtime.sql
-- NEVER run this against a linked/Production database: it inserts synthetic auth users
-- and rows, then deletes them. Every assertion RAISEs on failure (psql exits non-zero).
-- Not discovered by tests/run-all.js (only *.test.js is); it complements the static
-- suite tests/gmail-retention-invariants.test.js.
--
-- Fixture legend (all synthetic, all deleted at the end):
--   U1 = the disconnecting user      U2 = a bystander with IDENTICAL data (isolation)
--   per user: 1 contact, Google connection (calendar + gmail capabilities, tokens,
--   gmail cursor, calendar cursor, 1 pending oauth state), candidates:
--     G_PEND  gmail pending  (subject + 30-day deadline)          → must be invalidated
--     G_EXP   gmail pending  (subject, deadline in the PAST)       → expiry target
--     G_ACC   gmail accepted (linked interaction)                  → untouched
--     G_DIS   gmail dismissed                                      → untouched
--     C_PEND  calendar pending                                     → untouched
--     C_ACC   calendar accepted (linked interaction)               → untouched
--   interactions: manual, calendar-accepted, gmail-accepted        → untouched

\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

BEGIN;

-- ── Fixtures ──────────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('a1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rt-u1@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('a2000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rt-u2@example.invalid', 'x', now(), '{}', '{}', now(), now());

CREATE TEMP TABLE fx (u text, uid uuid, contact uuid, conn uuid, g_pend uuid, g_exp uuid, g_acc uuid, g_dis uuid, c_pend uuid, c_acc uuid, i_manual uuid, i_cal uuid, i_gmail uuid);
INSERT INTO fx (u, uid) VALUES ('U1', 'a1000000-0000-4000-8000-000000000001'), ('U2', 'a2000000-0000-4000-8000-000000000002');

DO $$
DECLARE r record; v_contact uuid; v_conn uuid; v_im uuid; v_ic uuid; v_ig uuid;
        v_gp uuid; v_ge uuid; v_ga uuid; v_gd uuid; v_cp uuid; v_ca uuid; fp text;
BEGIN
  FOR r IN SELECT * FROM fx LOOP
    INSERT INTO public.contacts (user_id, name) VALUES (r.uid, 'Synthetic ' || r.u) RETURNING id INTO v_contact;
    INSERT INTO public.google_connections (user_id, google_sub, google_email, scopes, status)
      VALUES (r.uid, 'sub-' || r.u, r.u || '@example.invalid', ARRAY['https://www.googleapis.com/auth/calendar.readonly','https://www.googleapis.com/auth/gmail.readonly'], 'active') RETURNING id INTO v_conn;
    INSERT INTO public.google_tokens (connection_id, access_token_ciphertext, access_token_nonce, refresh_token_ciphertext, refresh_token_nonce)
      VALUES (v_conn, 'ct', 'n', 'rct', 'rn');
    INSERT INTO public.google_connection_capabilities (connection_id, user_id, product, status, granted)
      VALUES (v_conn, r.uid, 'calendar', 'active', true), (v_conn, r.uid, 'gmail', 'active', true);
    INSERT INTO public.gmail_sync_state (connection_id, user_id, history_id) VALUES (v_conn, r.uid, '12345');
    INSERT INTO public.google_calendar_sync_state (connection_id) VALUES (v_conn);
    INSERT INTO public.google_oauth_states (state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce, return_origin, integration_type, expires_at)
      VALUES (repeat(lower(substr(r.u, 2, 1)), 64), r.uid, 'c', 'n', 'https://www.getfunnl.com', 'gmail', now() + interval '10 minutes');

    INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes, source)
      VALUES (v_contact, r.uid, 'Coffee chat', current_date, 'manual note', 'manual') RETURNING id INTO v_im;
    INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes, source)
      VALUES (v_contact, r.uid, 'Event', current_date, 'calendar note', 'google_calendar') RETURNING id INTO v_ic;
    INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes, source)
      VALUES (v_contact, r.uid, 'Email', current_date, 'gmail note', 'gmail') RETURNING id INTO v_ig;

    fp := repeat('a', 63);
    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, status, retained_subject, context_expires_at)
      VALUES (r.uid, v_contact, 'gmail', fp || '1', 'Email', current_date, 'pending', 'Re: pending subject', now() + interval '30 days') RETURNING id INTO v_gp;
    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, status, retained_subject, context_expires_at)
      VALUES (r.uid, v_contact, 'gmail', fp || '2', 'Email', current_date, 'pending', 'Re: expired subject', now() - interval '1 day') RETURNING id INTO v_ge;
    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, status, interaction_id)
      VALUES (r.uid, v_contact, 'gmail', fp || '3', 'Email', current_date, 'accepted', v_ig) RETURNING id INTO v_ga;
    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, status)
      VALUES (r.uid, v_contact, 'gmail', fp || '4', 'Email', current_date, 'dismissed') RETURNING id INTO v_gd;
    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, status, proposed_notes)
      VALUES (r.uid, v_contact, 'google_calendar', fp || '5', 'Event', current_date, 'pending', 'Calendar: Coffee') RETURNING id INTO v_cp;
    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, status, interaction_id)
      VALUES (r.uid, v_contact, 'google_calendar', fp || '6', 'Event', current_date, 'accepted', v_ic) RETURNING id INTO v_ca;
    INSERT INTO public.email_candidate_refs (candidate_id, user_id, connection_id, provider, source_fingerprint)
      VALUES (v_gp, r.uid, v_conn, 'gmail', fp || '1'), (v_ge, r.uid, v_conn, 'gmail', fp || '2'), (v_ga, r.uid, v_conn, 'gmail', fp || '3'), (v_gd, r.uid, v_conn, 'gmail', fp || '4');
    INSERT INTO public.google_calendar_event_refs (candidate_id, user_id, connection_id, google_sub, google_event_id, original_occurrence_date, event_start_date, event_end_date)
      VALUES (v_cp, r.uid, v_conn, 'sub-' || r.u, 'evt-p', current_date, current_date, current_date + 1),
             (v_ca, r.uid, v_conn, 'sub-' || r.u, 'evt-a', current_date, current_date, current_date + 1);

    UPDATE fx SET contact = v_contact, conn = v_conn, g_pend = v_gp, g_exp = v_ge, g_acc = v_ga, g_dis = v_gd,
                  c_pend = v_cp, c_acc = v_ca, i_manual = v_im, i_cal = v_ic, i_gmail = v_ig WHERE uid = r.uid;
  END LOOP;
END $$;

\echo == fixtures loaded

-- ── A. Grants: browser roles are refused; service_role may call ───────────────
DO $$
BEGIN
  PERFORM 1 WHERE has_function_privilege('authenticated', 'public.run_google_local_cleanup(uuid)', 'EXECUTE');
  IF FOUND THEN RAISE EXCEPTION 'A1 authenticated may execute run_google_local_cleanup'; END IF;
  PERFORM 1 WHERE has_function_privilege('anon', 'public.run_google_local_cleanup(uuid)', 'EXECUTE');
  IF FOUND THEN RAISE EXCEPTION 'A2 anon may execute run_google_local_cleanup'; END IF;
  PERFORM 1 WHERE has_function_privilege('authenticated', 'public.expire_pending_email_context(integer)', 'EXECUTE');
  IF FOUND THEN RAISE EXCEPTION 'A3 authenticated may execute expire_pending_email_context'; END IF;
  PERFORM 1 WHERE has_function_privilege('anon', 'public.expire_pending_email_context(integer)', 'EXECUTE');
  IF FOUND THEN RAISE EXCEPTION 'A4 anon may execute expire_pending_email_context'; END IF;
  IF NOT has_function_privilege('service_role', 'public.run_google_local_cleanup(uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'A5'; END IF;
  IF NOT has_function_privilege('service_role', 'public.expire_pending_email_context(integer)', 'EXECUTE') THEN RAISE EXCEPTION 'A6'; END IF;
END $$;
-- Actual denial as the browser role (not just the catalog answer).
SAVEPOINT sp_a;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.run_google_local_cleanup('a1000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'A7 authenticated was NOT denied run_google_local_cleanup';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.expire_pending_email_context(10);
    RAISE EXCEPTION 'A8 authenticated was NOT denied expire_pending_email_context';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
ROLLBACK TO SAVEPOINT sp_a;
\echo == A grants/denials ok

-- ── B. Browser SELECT cannot see fingerprint / context deadline / user id ──────
SAVEPOINT sp_b;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM source_fingerprint FROM public.interaction_candidates LIMIT 1;
    RAISE EXCEPTION 'B1 authenticated can SELECT source_fingerprint';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM context_expires_at FROM public.interaction_candidates LIMIT 1;
    RAISE EXCEPTION 'B2 authenticated can SELECT context_expires_at';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM 1 FROM public.email_candidate_refs LIMIT 1;
    RAISE EXCEPTION 'B3 authenticated can SELECT email_candidate_refs';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM 1 FROM public.gmail_sync_state LIMIT 1;
    RAISE EXCEPTION 'B4 authenticated can SELECT gmail_sync_state';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
ROLLBACK TO SAVEPOINT sp_b;
\echo == B browser column/table denial ok

-- ── C. Bounded expiry ─────────────────────────────────────────────────────────
DO $$
DECLARE r jsonb; n int;
BEGIN
  r := public.expire_pending_email_context(0);
  IF r->>'result' <> 'invalid_batch_size' THEN RAISE EXCEPTION 'C0 batch 0 accepted: %', r; END IF;
  r := public.expire_pending_email_context(5001);
  IF r->>'result' <> 'invalid_batch_size' THEN RAISE EXCEPTION 'C0b batch 5001 accepted: %', r; END IF;

  -- batch of 1 → exactly one of the two expired rows (U1/U2) is processed, more = true
  r := public.expire_pending_email_context(1);
  IF r->>'result' <> 'ok' OR (r->>'expired')::int <> 1 OR (r->>'more')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'C1 %', r; END IF;
  -- next batch drains the rest; more = false
  r := public.expire_pending_email_context(500);
  IF r->>'result' <> 'ok' OR (r->>'expired')::int <> 1 OR (r->>'more')::boolean IS NOT FALSE THEN RAISE EXCEPTION 'C2 %', r; END IF;
  -- idempotent
  r := public.expire_pending_email_context();
  IF (r->>'expired')::int <> 0 OR (r->>'batch_size')::int <> 500 THEN RAISE EXCEPTION 'C3 %', r; END IF;

  -- expired rows: still pending, subject + deadline erased, fingerprint intact
  SELECT count(*) INTO n FROM public.interaction_candidates ic JOIN fx ON ic.id = fx.g_exp
   WHERE ic.status = 'pending' AND ic.retained_subject IS NULL AND ic.context_expires_at IS NULL AND ic.source_fingerprint = repeat('a', 63) || '2';
  IF n <> 2 THEN RAISE EXCEPTION 'C4 expired rows wrong (n=%)', n; END IF;
  -- unexpired pending row untouched
  SELECT count(*) INTO n FROM public.interaction_candidates ic JOIN fx ON ic.id = fx.g_pend
   WHERE ic.status = 'pending' AND ic.retained_subject = 'Re: pending subject' AND ic.context_expires_at IS NOT NULL;
  IF n <> 2 THEN RAISE EXCEPTION 'C5 unexpired pending changed'; END IF;
  -- terminal rows, calendar rows, interactions untouched
  SELECT count(*) INTO n FROM public.interaction_candidates ic JOIN fx ON ic.id IN (fx.g_acc, fx.g_dis, fx.c_pend, fx.c_acc)
   WHERE ic.updated_at > now() - interval '1 second' AND ic.updated_at <> ic.created_at;
  IF n <> 0 THEN RAISE EXCEPTION 'C6 terminal/calendar rows touched'; END IF;
  SELECT count(*) INTO n FROM public.interactions i JOIN fx ON i.user_id = fx.uid;
  IF n <> 6 THEN RAISE EXCEPTION 'C7 interactions changed'; END IF;
END $$;
\echo == C bounded expiry ok

-- C8. Index-backed plan (must not seq-scan the whole candidates table).
CREATE OR REPLACE FUNCTION pg_temp.plan_lines() RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE l text;
BEGIN
  FOR l IN EXECUTE $q$
    EXPLAIN SELECT id FROM public.interaction_candidates
    WHERE status = 'pending' AND context_expires_at IS NOT NULL AND context_expires_at <= now()
    ORDER BY context_expires_at, id LIMIT 500 FOR UPDATE SKIP LOCKED $q$
  LOOP RETURN NEXT l; END LOOP;
END $$;
SET LOCAL enable_seqscan = off;   -- tiny fixture table; force the planner to prove the index is USABLE
DO $$
DECLARE plan text;
BEGIN
  SELECT string_agg(l, E'\n') INTO plan FROM pg_temp.plan_lines() l;
  IF plan !~ 'interaction_candidates_pending_context_expiry_idx' THEN
    RAISE EXCEPTION 'C8 expiry scan is not index-backed: %', plan;
  END IF;
END $$;
RESET enable_seqscan;
\echo == C8 index-backed plan ok

-- Snapshot the bystander AFTER expiry (which legitimately touched U2's expired row) and
-- BEFORE the whole-Google cleanup of U1: D8 proves the cleanup changed nothing of U2's.
CREATE TEMP TABLE snap_u2 AS
  SELECT ic.* FROM public.interaction_candidates ic JOIN fx ON fx.uid = ic.user_id AND fx.u = 'U2';
CREATE TEMP TABLE snap_u2_ix AS
  SELECT i.* FROM public.interactions i JOIN fx ON fx.uid = i.user_id AND fx.u = 'U2';

-- ── D. Whole-Google cleanup (U1 only) ─────────────────────────────────────────
DO $$
DECLARE r jsonb; n int; u1 uuid; u2 uuid;
BEGIN
  SELECT uid INTO u1 FROM fx WHERE u = 'U1';
  SELECT uid INTO u2 FROM fx WHERE u = 'U2';

  r := public.run_google_local_cleanup(NULL);
  IF r->>'result' <> 'invalid_user' THEN RAISE EXCEPTION 'D0 %', r; END IF;

  r := public.run_google_local_cleanup(u1);
  IF r->>'result' <> 'cleaned' OR (r->>'connections_deleted')::int <> 1 OR (r->>'oauth_states_deleted')::int <> 1
     OR (r->>'gmail_candidates_invalidated')::int <> 2 THEN RAISE EXCEPTION 'D1 %', r; END IF;

  -- D2 pending Gmail rows: invalidated, subject + deadline NULL, fingerprint intact, refs GONE (cascade, as before)
  SELECT count(*) INTO n FROM public.interaction_candidates ic JOIN fx ON fx.u='U1' AND ic.id IN (fx.g_pend, fx.g_exp)
   WHERE ic.status = 'invalidated' AND ic.retained_subject IS NULL AND ic.context_expires_at IS NULL
     AND ic.source_fingerprint IN (repeat('a',63)||'1', repeat('a',63)||'2');
  IF n <> 2 THEN RAISE EXCEPTION 'D2 pending gmail not erased/invalidated (n=%)', n; END IF;

  -- D3 terminal gmail rows untouched (accepted keeps its interaction link)
  SELECT count(*) INTO n FROM public.interaction_candidates ic JOIN fx ON fx.u='U1' AND ic.id IN (fx.g_acc, fx.g_dis)
   WHERE (ic.id = fx.g_acc AND ic.status='accepted' AND ic.interaction_id = fx.i_gmail)
      OR (ic.id = fx.g_dis AND ic.status='dismissed');
  IF n <> 2 THEN RAISE EXCEPTION 'D3 terminal gmail rows changed'; END IF;

  -- D4 calendar candidates untouched (pending stays pending with its notes; accepted keeps link)
  SELECT count(*) INTO n FROM public.interaction_candidates ic JOIN fx ON fx.u='U1' AND ic.id IN (fx.c_pend, fx.c_acc)
   WHERE (ic.id = fx.c_pend AND ic.status='pending' AND ic.proposed_notes='Calendar: Coffee')
      OR (ic.id = fx.c_acc AND ic.status='accepted' AND ic.interaction_id = fx.i_cal);
  IF n <> 2 THEN RAISE EXCEPTION 'D4 calendar candidates changed'; END IF;

  -- D5 all three interactions (manual, calendar, gmail) untouched
  SELECT count(*) INTO n FROM public.interactions i WHERE i.user_id = u1;
  IF n <> 3 THEN RAISE EXCEPTION 'D5 interactions changed (n=%)', n; END IF;
  SELECT count(*) INTO n FROM public.interactions i WHERE i.user_id = u1 AND i.notes IN ('manual note','calendar note','gmail note');
  IF n <> 3 THEN RAISE EXCEPTION 'D5b interaction content changed'; END IF;

  -- D6 connection + cascades gone exactly as before
  SELECT count(*) INTO n FROM public.google_connections WHERE user_id = u1; IF n <> 0 THEN RAISE EXCEPTION 'D6 connection remains'; END IF;
  SELECT count(*) INTO n FROM public.google_tokens t JOIN fx ON t.connection_id = fx.conn AND fx.u='U1'; IF n <> 0 THEN RAISE EXCEPTION 'D6 tokens remain'; END IF;
  SELECT count(*) INTO n FROM public.google_connection_capabilities WHERE user_id = u1; IF n <> 0 THEN RAISE EXCEPTION 'D6 capabilities remain'; END IF;
  SELECT count(*) INTO n FROM public.gmail_sync_state WHERE user_id = u1; IF n <> 0 THEN RAISE EXCEPTION 'D6 gmail cursor remains'; END IF;
  SELECT count(*) INTO n FROM public.google_calendar_sync_state s JOIN fx ON s.connection_id = fx.conn AND fx.u='U1'; IF n <> 0 THEN RAISE EXCEPTION 'D6 calendar cursor remains'; END IF;
  SELECT count(*) INTO n FROM public.email_candidate_refs WHERE user_id = u1; IF n <> 0 THEN RAISE EXCEPTION 'D6 email refs remain'; END IF;
  SELECT count(*) INTO n FROM public.google_calendar_event_refs WHERE user_id = u1; IF n <> 0 THEN RAISE EXCEPTION 'D6 calendar refs remain'; END IF;
  SELECT count(*) INTO n FROM public.google_oauth_states WHERE user_id = u1; IF n <> 0 THEN RAISE EXCEPTION 'D6 oauth states remain'; END IF;

  -- D7 the tombstones (all six candidate rows) still exist for U1
  SELECT count(*) INTO n FROM public.interaction_candidates WHERE user_id = u1; IF n <> 6 THEN RAISE EXCEPTION 'D7 candidate rows deleted (n=%)', n; END IF;

  -- D8 U2 completely untouched (byte-for-byte snapshot compare)
  IF EXISTS (SELECT * FROM snap_u2 EXCEPT SELECT ic.* FROM public.interaction_candidates ic WHERE ic.user_id = u2)
     OR EXISTS (SELECT ic.* FROM public.interaction_candidates ic WHERE ic.user_id = u2 EXCEPT SELECT * FROM snap_u2) THEN
    RAISE EXCEPTION 'D8 U2 candidates changed';
  END IF;
  IF EXISTS (SELECT * FROM snap_u2_ix EXCEPT SELECT i.* FROM public.interactions i WHERE i.user_id = u2)
     OR EXISTS (SELECT i.* FROM public.interactions i WHERE i.user_id = u2 EXCEPT SELECT * FROM snap_u2_ix) THEN
    RAISE EXCEPTION 'D8 U2 interactions changed';
  END IF;
  SELECT count(*) INTO n FROM public.google_connections WHERE user_id = u2; IF n <> 1 THEN RAISE EXCEPTION 'D8 U2 connection gone'; END IF;
  SELECT count(*) INTO n FROM public.email_candidate_refs WHERE user_id = u2; IF n <> 4 THEN RAISE EXCEPTION 'D8 U2 refs changed'; END IF;
  SELECT count(*) INTO n FROM public.google_oauth_states WHERE user_id = u2; IF n <> 1 THEN RAISE EXCEPTION 'D8 U2 oauth state gone'; END IF;

  -- D9 idempotent: second call is a clean zero, not an error
  r := public.run_google_local_cleanup(u1);
  IF r->>'result' <> 'cleaned' OR (r->>'connections_deleted')::int <> 0 OR (r->>'gmail_candidates_invalidated')::int <> 0 THEN RAISE EXCEPTION 'D9 %', r; END IF;

  -- D10 a random uuid (no such user) is a clean zero as well
  r := public.run_google_local_cleanup(gen_random_uuid());
  IF r->>'result' <> 'cleaned' OR (r->>'connections_deleted')::int <> 0 THEN RAISE EXCEPTION 'D10 %', r; END IF;
END $$;
\echo == D whole-Google cleanup ok

-- ── E. Gmail-only disconnect (U2, as the user) still behaves as before ────────
SAVEPOINT sp_e;
DO $$
DECLARE r jsonb; n int; u2 uuid;
BEGIN
  SELECT uid INTO u2 FROM fx WHERE u = 'U2';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u2::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  r := public.disconnect_my_gmail();
  PERFORM set_config('role', 'postgres', true);
  IF r->>'result' <> 'disconnected' OR (r->>'capability_rows')::int <> 1 OR (r->>'candidates_invalidated')::int <> 2 THEN RAISE EXCEPTION 'E1 %', r; END IF;
  -- gmail capability disabled, calendar untouched, connection + tokens + calendar cursor remain
  SELECT count(*) INTO n FROM public.google_connection_capabilities WHERE user_id = u2 AND product='gmail' AND status='disabled' AND granted=false; IF n <> 1 THEN RAISE EXCEPTION 'E2'; END IF;
  SELECT count(*) INTO n FROM public.google_connection_capabilities WHERE user_id = u2 AND product='calendar' AND status='active' AND granted=true; IF n <> 1 THEN RAISE EXCEPTION 'E3 calendar capability changed'; END IF;
  SELECT count(*) INTO n FROM public.google_connections WHERE user_id = u2; IF n <> 1 THEN RAISE EXCEPTION 'E4 connection removed by gmail-only disconnect'; END IF;
  SELECT count(*) INTO n FROM public.gmail_sync_state WHERE user_id = u2; IF n <> 0 THEN RAISE EXCEPTION 'E5 gmail cursor remains'; END IF;
  SELECT count(*) INTO n FROM public.google_calendar_sync_state s JOIN fx ON s.connection_id = fx.conn AND fx.u='U2'; IF n <> 1 THEN RAISE EXCEPTION 'E6 calendar cursor removed'; END IF;
  -- pending gmail invalidated with subject erased; fingerprint + refs kept (refs survive: connection still exists)
  SELECT count(*) INTO n FROM public.interaction_candidates ic JOIN fx ON fx.u='U2' AND ic.id IN (fx.g_pend, fx.g_exp)
   WHERE ic.status='invalidated' AND ic.retained_subject IS NULL AND ic.context_expires_at IS NULL AND ic.source_fingerprint LIKE 'aaa%';
  IF n <> 2 THEN RAISE EXCEPTION 'E7'; END IF;
  SELECT count(*) INTO n FROM public.email_candidate_refs WHERE user_id = u2; IF n <> 4 THEN RAISE EXCEPTION 'E8 refs deleted by gmail-only disconnect'; END IF;
  SELECT count(*) INTO n FROM public.interactions WHERE user_id = u2; IF n <> 3 THEN RAISE EXCEPTION 'E9 interactions changed'; END IF;
  SELECT count(*) INTO n FROM public.interaction_candidates ic JOIN fx ON fx.u='U2' AND ic.id IN (fx.c_pend, fx.c_acc, fx.g_acc, fx.g_dis)
   WHERE ic.retained_subject IS NULL AND ic.status IN ('pending','accepted','dismissed'); IF n <> 4 THEN RAISE EXCEPTION 'E10 terminal/calendar rows changed'; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_e;
\echo == E gmail-only disconnect ok

-- ── F. Calendar accept / dismiss still work (U2, as the user) ─────────────────
SAVEPOINT sp_f;
DO $$
DECLARE r jsonb; n int; u2 uuid; cp uuid;
BEGIN
  SELECT uid, c_pend INTO u2, cp FROM fx WHERE u = 'U2';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u2::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  r := public.dismiss_interaction_candidate(cp);
  PERFORM set_config('role', 'postgres', true);
  IF r->>'result' <> 'dismissed' THEN RAISE EXCEPTION 'F1 %', r; END IF;
  SELECT count(*) INTO n FROM public.interaction_candidates WHERE id = cp AND status='dismissed' AND source_fingerprint = repeat('a',63)||'5';
  IF n <> 1 THEN RAISE EXCEPTION 'F2 dismiss did not keep the fingerprint'; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_f;
SAVEPOINT sp_f2;
DO $$
DECLARE r jsonb; n int; u2 uuid; cp uuid;
BEGIN
  SELECT uid, c_pend INTO u2, cp FROM fx WHERE u = 'U2';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u2::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  r := public.accept_interaction_candidate(cp, 'Event', current_date, 'accepted note');
  PERFORM set_config('role', 'postgres', true);
  IF r->>'result' <> 'accepted' THEN RAISE EXCEPTION 'F3 %', r; END IF;
  SELECT count(*) INTO n FROM public.interaction_candidates ic JOIN public.interactions i ON i.id = ic.interaction_id
   WHERE ic.id = cp AND ic.status='accepted' AND i.source='google_calendar' AND i.notes='accepted note' AND ic.source_fingerprint = repeat('a',63)||'5';
  IF n <> 1 THEN RAISE EXCEPTION 'F4 accept did not create the interaction / keep the fingerprint'; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_f2;
\echo == F calendar accept/dismiss ok

-- ── G. Cross-user forgery: a user cannot act on another user's rows ───────────
SAVEPOINT sp_g;
DO $$
DECLARE r jsonb; n int; u1 uuid; u2 uuid; cp2 uuid;
BEGIN
  SELECT uid INTO u1 FROM fx WHERE u = 'U1';
  SELECT uid, c_pend INTO u2, cp2 FROM fx WHERE u = 'U2';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u1::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  r := public.dismiss_interaction_candidate(cp2);        -- U1 tries to dismiss U2's candidate
  PERFORM set_config('role', 'postgres', true);
  SELECT count(*) INTO n FROM public.interaction_candidates WHERE id = cp2 AND status = 'pending';
  IF n <> 1 OR r->>'result' <> 'not_found' THEN RAISE EXCEPTION 'G1 cross-user dismiss succeeded: %', r; END IF;
  -- U1 (no connection now) calling disconnect_my_gmail is a clean not_connected, and U2 is untouched
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u1::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  r := public.disconnect_my_gmail();
  PERFORM set_config('role', 'postgres', true);
  IF r->>'result' <> 'not_connected' THEN RAISE EXCEPTION 'G2 %', r; END IF;
  SELECT count(*) INTO n FROM public.google_connection_capabilities WHERE user_id = u2 AND status='active'; IF n <> 2 THEN RAISE EXCEPTION 'G3 U2 capabilities changed'; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_g;
\echo == G cross-user isolation ok

-- ── H. Tombstone content + cascades ───────────────────────────────────────────
DO $$
DECLARE n int; u1 uuid; u2 uuid; c2 uuid;
BEGIN
  SELECT uid INTO u1 FROM fx WHERE u = 'U1';
  SELECT uid, contact INTO u2, c2 FROM fx WHERE u = 'U2';
  -- H1 a terminal tombstone holds no subject / deadline; the only provider-derived value is the 64-hex fingerprint
  SELECT count(*) INTO n FROM public.interaction_candidates WHERE user_id = u1 AND status <> 'pending'
     AND (retained_subject IS NOT NULL OR context_expires_at IS NOT NULL);
  IF n <> 0 THEN RAISE EXCEPTION 'H1 tombstone carries context'; END IF;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='interaction_candidates'
     AND column_name ~ '(message|thread|history|header|snippet|body|attachment|address|sender|recipient|token|raw)';
  IF n <> 0 THEN RAISE EXCEPTION 'H1b provider column on interaction_candidates'; END IF;
  -- H2 contact deletion removes the contact's tombstones and refs (U2 still has refs)
  SELECT count(*) INTO n FROM public.email_candidate_refs WHERE user_id = u2; IF n <> 4 THEN RAISE EXCEPTION 'H2 precondition'; END IF;
  DELETE FROM public.contacts WHERE id = c2;
  SELECT count(*) INTO n FROM public.interaction_candidates WHERE user_id = u2; IF n <> 0 THEN RAISE EXCEPTION 'H2 candidates survived contact deletion'; END IF;
  SELECT count(*) INTO n FROM public.email_candidate_refs WHERE user_id = u2; IF n <> 0 THEN RAISE EXCEPTION 'H2 refs survived contact deletion'; END IF;
  SELECT count(*) INTO n FROM public.interactions WHERE user_id = u2; IF n <> 0 THEN RAISE EXCEPTION 'H2 interactions survived contact deletion'; END IF;
  -- H3 account deletion removes every owned tombstone/fingerprint (U1 still has its 6 tombstones)
  SELECT count(*) INTO n FROM public.interaction_candidates WHERE user_id = u1; IF n <> 6 THEN RAISE EXCEPTION 'H3 precondition'; END IF;
  DELETE FROM auth.users WHERE id = u1;
  SELECT count(*) INTO n FROM public.interaction_candidates WHERE user_id = u1; IF n <> 0 THEN RAISE EXCEPTION 'H3 candidates survived account deletion'; END IF;
  SELECT count(*) INTO n FROM public.contacts WHERE user_id = u1; IF n <> 0 THEN RAISE EXCEPTION 'H3 contacts survived'; END IF;
  SELECT count(*) INTO n FROM public.profiles WHERE id = u1; IF n <> 0 THEN RAISE EXCEPTION 'H3 profile survived'; END IF;
END $$;
\echo == H tombstone content + cascades ok

-- ── Teardown: everything synthetic is removed ─────────────────────────────────
DELETE FROM auth.users WHERE id IN ('a1000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002');
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.interaction_candidates; IF n <> 0 THEN RAISE EXCEPTION 'teardown: candidates remain'; END IF;
  SELECT count(*) INTO n FROM public.google_connections; IF n <> 0 THEN RAISE EXCEPTION 'teardown: connections remain'; END IF;
  SELECT count(*) INTO n FROM public.email_candidate_refs; IF n <> 0 THEN RAISE EXCEPTION 'teardown: refs remain'; END IF;
  SELECT count(*) INTO n FROM auth.users WHERE email LIKE 'rt-u%@example.invalid'; IF n <> 0 THEN RAISE EXCEPTION 'teardown: users remain'; END IF;
END $$;
COMMIT;
\echo == ALL RUNTIME CHECKS PASSED
