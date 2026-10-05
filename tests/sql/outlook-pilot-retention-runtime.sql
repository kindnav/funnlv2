-- Runtime verification for the RETENTION CLAIMS made in the published Outlook privacy
-- section and in the just-in-time disclosure.
--
-- WHY THIS FILE EXISTS. The policy and the consent notice make four factual claims about
-- when Outlook-derived records go away. Each is cheap to get wrong in prose and each is
-- checkable, so each is checked here rather than asserted:
--
--   1. A round's DEADLINE makes its working records unusable. It does NOT delete them,
--      and `read_outlook_round_progress` does not delete them either - it reports
--      `round_expired` and leaves the rows in place. Deletion needs a LATER action.
--   2. Without a scheduled sweep an expired suggestion stays PENDING and visible. The
--      sweep that exists invalidates rather than deletes. For a pilot row it finds no
--      BODY TEXT, SUBJECT, SUMMARY, FOLLOW-UP or NOTES to erase - those columns are
--      never written by the envelope-only write path. That is NOT the same as the row
--      holding nothing derived from the mail: the contact it names, the proposed date
--      and the fingerprints are all computed FROM message envelopes and remain
--      personal data. The absent schedule is therefore a real retention limit, just
--      not a message-text one.
--   3. DISCONNECT removes the connection, the credentials, the sync state, the working
--      records and the provenance refs - but the invalidated suggestion row SURVIVES,
--      still carrying contact_id, the proposed date and the episode fingerprint. It must
--      not be described as empty, or as gone.
--   4. The two remaining deletion claims are real: deleting the related CONTACT removes
--      the suggestion row, and deleting the ACCOUNT removes it. Both run by cascade.
--
-- HOW TO BUILD THE DATABASE THIS NEEDS: tests/sql/_bootstrap-disposable-db.sql, then every
-- migration in supabase/migrations.
--
-- WHAT THIS DOES NOT PROVE. It runs as the privileged `postgres` role, so it proves the
-- function bodies and the cascades, not RLS or role separation. There is no JWT, no
-- PostgREST, no browser and no mailbox here. It says nothing about PRODUCTION, where the
-- forward migrations are unapplied: the disconnect result must be re-verified there before
-- the cleanup wording is relied on.

\set ON_ERROR_STOP on

-- ══ 1. the deadline does not delete, and reading does not delete ════════════
DO $$
DECLARE
  u    uuid := '11111111-1111-1111-1111-111111111111';
  c    uuid;
  r    uuid := pg_catalog.gen_random_uuid();
  run  uuid := pg_catalog.gen_random_uuid();
  res  jsonb;
  n    integer;
BEGIN
  DELETE FROM public.outlook_conversation_progress;
  DELETE FROM public.microsoft_connections WHERE user_id = u;

  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version)
  VALUES (u, 'acct-1', 'consumers', 'personal', 'pilot@example.test',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(), 'v1')
  RETURNING id INTO c;

  -- A round whose single deadline passed two days ago.
  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, sync_run_id, sync_lease_until,
     round_id, round_started_at, round_expires_at, round_page_seq)
  VALUES (c, u, 'inbox',     'running', run, now() + interval '10 minutes',
          r, now() - interval '3 days', now() - interval '2 days', 0),
         (c, u, 'sentitems', 'running', run, now() + interval '10 minutes',
          r, now() - interval '3 days', now() - interval '2 days', 0);

  INSERT INTO public.outlook_conversation_progress
    (connection_id, user_id, round_id, conversation_fingerprint, person_fingerprint,
     inbound_count, outbound_count, message_count, first_seen_at, last_seen_at)
  VALUES (c, u, r, repeat('a', 64), repeat('b', 64), 1, 1, 2,
          now() - interval '3 days', now() - interval '3 days');

  -- (a) time alone. No call of any kind.
  SELECT count(*) INTO n FROM public.outlook_conversation_progress WHERE connection_id = c;
  IF n <> 1 THEN
    RAISE EXCEPTION 'the deadline deleted a working record on its own (% rows left) - the '
                    'policy wording assumes it does not', n;
  END IF;

  -- (b) reading the progress. Reports expiry; must still not delete.
  res := public.read_outlook_round_progress(c, run);
  IF res->>'result' <> 'ok' OR (res->>'round_expired') <> 'true' THEN
    RAISE EXCEPTION 'expected result=ok with round_expired=true, got %', res;
  END IF;
  SELECT count(*) INTO n FROM public.outlook_conversation_progress WHERE connection_id = c;
  IF n <> 1 THEN
    RAISE EXCEPTION 'read_outlook_round_progress deleted a working record (% left)', n;
  END IF;

  -- (c) a checkpoint for the SAME expired round is refused and deletes nothing.
  res := public.record_outlook_page_progress(
    c, run, 'inbox', r, 1, 'CT-next', 'NONCE', NULL, NULL, 1::smallint, false, 1, 0,
    '[]'::jsonb, 86400);
  IF res->>'result' <> 'round_expired' THEN
    RAISE EXCEPTION 'expected round_expired from a checkpoint on an expired round, got %', res;
  END IF;
  SELECT count(*) INTO n FROM public.outlook_conversation_progress WHERE connection_id = c;
  IF n <> 1 THEN RAISE EXCEPTION 'a refused checkpoint deleted a working record'; END IF;

  -- (d) an INCOMPLETE release - what a crash or a refusal does - also leaves it.
  PERFORM public.release_outlook_sync_lease(
    c, run, 'idle', 'some_error', false, NULL, NULL, NULL, NULL, NULL, false, 300);
  SELECT count(*) INTO n FROM public.outlook_conversation_progress WHERE connection_id = c;
  IF n <> 1 THEN
    RAISE EXCEPTION 'an incomplete release deleted the working record; the pilot-end '
                    'checklist assumes it does not';
  END IF;

  RAISE NOTICE '1. the deadline, a progress read, a refused checkpoint and an incomplete '
               'release all leave the working record PHYSICALLY PRESENT';
END $$;

-- ══ 2. what DOES delete a working record ════════════════════════════════════
DO $$
DECLARE
  u   uuid := '11111111-1111-1111-1111-111111111111';
  c   uuid;
  r   uuid;
  run uuid;
  nr  uuid;
  n   integer;
  res jsonb;
BEGIN
  -- (a) the next read beginning, i.e. a checkpoint under a NEW round id.
  SELECT id INTO c FROM public.microsoft_connections WHERE user_id = u;
  r   := pg_catalog.gen_random_uuid();
  run := pg_catalog.gen_random_uuid();
  nr  := pg_catalog.gen_random_uuid();
  DELETE FROM public.outlook_conversation_progress;
  UPDATE public.outlook_sync_state
     SET sync_status = 'running', sync_run_id = run,
         sync_lease_until = now() + interval '10 minutes',
         round_id = r, round_started_at = now() - interval '3 days',
         round_expires_at = now() - interval '2 days', round_page_seq = 0,
         next_retry_at = NULL
   WHERE connection_id = c;
  INSERT INTO public.outlook_conversation_progress
    (connection_id, user_id, round_id, conversation_fingerprint)
  VALUES (c, u, r, repeat('a', 64));

  res := public.record_outlook_page_progress(
    c, run, 'inbox', nr, 1, 'CT-next', 'NONCE', NULL, NULL, 1::smallint, false, 1, 0,
    jsonb_build_array(jsonb_build_object('cfp', repeat('c', 64))), 86400);
  IF res->>'result' <> 'recorded' THEN
    RAISE EXCEPTION 'a checkpoint under a new round should be recorded, got %', res;
  END IF;
  SELECT count(*) INTO n FROM public.outlook_conversation_progress
   WHERE connection_id = c AND round_id = r;
  IF n <> 0 THEN
    RAISE EXCEPTION 'the next read did not erase the superseded round (% rows)', n;
  END IF;
  RAISE NOTICE '2a. the NEXT read erases the superseded round''s working records';

  -- (b) reset_outlook_round.
  DELETE FROM public.outlook_conversation_progress;
  r := pg_catalog.gen_random_uuid();
  UPDATE public.outlook_sync_state
     SET round_id = r, round_started_at = now(), round_expires_at = now() + interval '1 day',
         round_page_seq = 0, next_link_ciphertext = NULL, next_link_nonce = NULL,
         next_link_key_version = NULL
   WHERE connection_id = c;
  INSERT INTO public.outlook_conversation_progress
    (connection_id, user_id, round_id, conversation_fingerprint)
  VALUES (c, u, r, repeat('a', 64));
  res := public.reset_outlook_round(c, run, 'cursor_rejected');
  IF res->>'result' <> 'reset' THEN
    RAISE EXCEPTION 'expected reset, got %', res;
  END IF;
  SELECT count(*) INTO n FROM public.outlook_conversation_progress WHERE connection_id = c;
  IF n <> 0 THEN RAISE EXCEPTION 'reset left % working records', n; END IF;
  RAISE NOTICE '2b. reset_outlook_round erases them';

  -- (c) a COMPLETE release.
  r := pg_catalog.gen_random_uuid();
  UPDATE public.outlook_sync_state
     SET sync_status = 'running', sync_run_id = run,
         sync_lease_until = now() + interval '10 minutes',
         round_id = r, round_started_at = now(),
         round_expires_at = now() + interval '1 day'
   WHERE connection_id = c;
  INSERT INTO public.outlook_conversation_progress
    (connection_id, user_id, round_id, conversation_fingerprint)
  VALUES (c, u, r, repeat('a', 64));
  PERFORM public.release_outlook_sync_lease(
    c, run, 'idle', NULL, true, NULL, NULL, NULL, NULL, NULL, true, NULL);
  SELECT count(*) INTO n FROM public.outlook_conversation_progress WHERE connection_id = c;
  IF n <> 0 THEN RAISE EXCEPTION 'a complete release left % working records', n; END IF;
  RAISE NOTICE '2c. a COMPLETE release erases them';
END $$;

-- ══ 3. an expired suggestion with no sweep, then the sweep, then disconnect ══
DO $$
DECLARE
  u    uuid := '11111111-1111-1111-1111-111111111111';
  c    uuid;
  run  uuid := pg_catalog.gen_random_uuid();
  ct   uuid;
  res  jsonb;
  n    integer;
  v_status text;
  v_contact uuid;
  v_date date;
  v_fp text;
  v_refs integer;
BEGIN
  DELETE FROM public.interaction_candidates WHERE user_id = u;
  DELETE FROM public.outlook_candidate_refs WHERE user_id = u;
  DELETE FROM public.contacts WHERE user_id = u;
  DELETE FROM public.outlook_conversation_progress;
  DELETE FROM public.microsoft_connections WHERE user_id = u;

  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version)
  VALUES (u, 'acct-1', 'consumers', 'personal', 'pilot@example.test',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(), 'v1')
  RETURNING id INTO c;
  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, sync_run_id, sync_lease_until)
  VALUES (c, u, 'inbox',     'running', run, now() + interval '10 minutes'),
         (c, u, 'sentitems', 'running', run, now() + interval '10 minutes');
  INSERT INTO public.contacts (user_id, name, email)
  VALUES (u, 'Ava Recruiter', 'ava@bank.test') RETURNING id INTO ct;

  -- The PILOT write: envelope-derived only, by construction.
  res := public.upsert_outlook_interaction_candidate(
    c, run, ct, repeat('e', 64), repeat('b', 64), 1::smallint, 'Email',
    current_date - 1, NULL);
  IF res->>'result' <> 'created' THEN
    RAISE EXCEPTION 'expected a created suggestion, got %', res;
  END IF;

  -- The write path stores no BODY TEXT, SUBJECT, SUMMARY, FOLLOW-UP or NOTES, so the
  -- sweep would find none of those to erase. The row still holds envelope-derived
  -- personal data - the contact, the proposed date and the fingerprints - which the
  -- sweep does not touch and which no schedule removes. Checked so the wording cannot
  -- drift into claiming the row holds nothing from the mail.
  SELECT count(*) INTO n FROM public.interaction_candidates
   WHERE user_id = u
     AND (retained_subject IS NOT NULL OR draft_summary IS NOT NULL
          OR draft_follow_up IS NOT NULL OR proposed_notes IS NOT NULL);
  IF n <> 0 THEN
    RAISE EXCEPTION 'a pilot suggestion carries message TEXT (subject, summary, follow-up or notes) in % row(s)', n;
  END IF;

  -- (a) push the deadline well past and run NO sweep.
  UPDATE public.interaction_candidates
     SET context_expires_at = now() - interval '45 days' WHERE user_id = u;
  SELECT status INTO v_status FROM public.interaction_candidates WHERE user_id = u;
  SELECT count(*) INTO n FROM public.interaction_candidates WHERE user_id = u;
  IF n <> 1 OR v_status <> 'pending' THEN
    RAISE EXCEPTION 'without a sweep an expired suggestion should remain PENDING; '
                    'rows=% status=%', n, v_status;
  END IF;
  RAISE NOTICE '3a. 45 days past its deadline and with no sweep, the suggestion is still '
               'present and still PENDING';

  -- (b) the sweep that exists but is not scheduled: invalidates, does not delete.
  res := public.expire_pending_outlook_context(500);
  IF (res->>'expired')::integer <> 1 THEN
    RAISE EXCEPTION 'expected the sweep to expire exactly one row, got %', res;
  END IF;
  SELECT count(*), max(status) INTO n, v_status
    FROM public.interaction_candidates WHERE user_id = u;
  IF n <> 1 OR v_status <> 'invalidated' THEN
    RAISE EXCEPTION 'the sweep should invalidate and keep the row; rows=% status=%',
                    n, v_status;
  END IF;
  RAISE NOTICE '3b. the sweep INVALIDATES; the row remains';

  -- (c) DISCONNECT. Working records and provenance refs go; the suggestion row stays,
  --     still carrying contact_id, the proposed date and the episode fingerprint.
  INSERT INTO public.outlook_conversation_progress
    (connection_id, user_id, round_id, conversation_fingerprint)
  VALUES (c, u, pg_catalog.gen_random_uuid(), repeat('a', 64));
  PERFORM public.run_microsoft_local_cleanup(u);

  SELECT count(*) INTO n FROM public.microsoft_connections WHERE user_id = u;
  IF n <> 0 THEN RAISE EXCEPTION 'disconnect left the connection'; END IF;
  SELECT count(*) INTO n FROM public.outlook_sync_state WHERE user_id = u;
  IF n <> 0 THEN RAISE EXCEPTION 'disconnect left sync state'; END IF;
  SELECT count(*) INTO n FROM public.outlook_conversation_progress WHERE user_id = u;
  IF n <> 0 THEN RAISE EXCEPTION 'disconnect left % working records', n; END IF;
  SELECT count(*) INTO v_refs FROM public.outlook_candidate_refs WHERE user_id = u;
  IF v_refs <> 0 THEN RAISE EXCEPTION 'disconnect left % provenance refs', v_refs; END IF;

  SELECT count(*), max(status), max(contact_id::text)::uuid,
         max(proposed_interaction_date), max(source_fingerprint)
    INTO n, v_status, v_contact, v_date, v_fp
    FROM public.interaction_candidates WHERE user_id = u;
  IF n <> 1 THEN
    RAISE EXCEPTION 'the suggestion row should SURVIVE disconnect; rows=%', n;
  END IF;
  IF v_contact IS NULL OR v_date IS NULL OR v_fp IS NULL THEN
    RAISE EXCEPTION 'the surviving row should still carry contact_id, date and '
                    'fingerprint; got contact=% date=% fp=%', v_contact, v_date, v_fp;
  END IF;
  IF length(v_fp) <> 64 THEN
    RAISE EXCEPTION 'expected a 64-character fingerprint, got %', length(v_fp);
  END IF;
  RAISE NOTICE '3c. after DISCONNECT the suggestion row SURVIVES, status=%, still '
               'carrying contact_id, the proposed date and a %-character fingerprint - '
               'so it is neither empty nor gone', v_status, length(v_fp);
END $$;

-- ══ 4. the two deletion claims the wording still makes ══════════════════════
DO $$
DECLARE
  u  uuid := '11111111-1111-1111-1111-111111111111';
  u3 uuid := '33333333-3333-3333-3333-333333333333';
  c3 uuid;
  ct uuid;
  n  integer;
BEGIN
  -- (a) deleting the related CONTACT removes the suggestion row.
  SELECT contact_id INTO ct FROM public.interaction_candidates WHERE user_id = u;
  IF ct IS NULL THEN RAISE EXCEPTION 'fixture lost its contact'; END IF;
  DELETE FROM public.contacts WHERE id = ct;
  SELECT count(*) INTO n FROM public.interaction_candidates WHERE user_id = u;
  IF n <> 0 THEN
    RAISE EXCEPTION 'deleting the contact left % suggestion rows - the policy claims it '
                    'removes them', n;
  END IF;
  RAISE NOTICE '4a. deleting the related CONTACT removes the suggestion row (cascade)';

  -- (b) deleting the ACCOUNT removes everything keyed to the user.
  --     On a THROWAWAY user, not u1: the bootstrap seeds u1 and u2 and other runtime
  --     files depend on them, so a file that deletes one is not order-independent.
  INSERT INTO auth.users (id, email)
  VALUES (u3, 'throwaway@example.test')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version)
  VALUES (u3, 'acct-3', 'consumers', 'personal', 'throwaway@example.test',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(), 'v1')
  RETURNING id INTO c3;
  INSERT INTO public.contacts (user_id, name, email)
  VALUES (u3, 'Ava Recruiter', 'ava@bank.test') RETURNING id INTO ct;
  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, status, source_last_state)
  VALUES (u3, ct, 'outlook', repeat('f', 64), 'Email', current_date,
          'pending', 'active');
  INSERT INTO public.outlook_conversation_progress
    (connection_id, user_id, round_id, conversation_fingerprint)
  VALUES (c3, u3, pg_catalog.gen_random_uuid(), repeat('a', 64));

  DELETE FROM auth.users WHERE id = u3;

  SELECT count(*) INTO n FROM public.interaction_candidates WHERE user_id = u3;
  IF n <> 0 THEN RAISE EXCEPTION 'account deletion left % suggestion rows', n; END IF;
  SELECT count(*) INTO n FROM public.outlook_conversation_progress WHERE user_id = u3;
  IF n <> 0 THEN RAISE EXCEPTION 'account deletion left % working records', n; END IF;
  SELECT count(*) INTO n FROM public.contacts WHERE user_id = u3;
  IF n <> 0 THEN RAISE EXCEPTION 'account deletion left % contacts', n; END IF;
  SELECT count(*) INTO n FROM public.microsoft_connections WHERE user_id = u3;
  IF n <> 0 THEN RAISE EXCEPTION 'account deletion left % connections', n; END IF;
  RAISE NOTICE '4b. deleting the ACCOUNT removes the suggestion rows, the working '
               'records, the contacts and the connection (cascade)';

  -- Leave nothing behind: other runtime files assert an empty
  -- microsoft_connections as their own precondition.
  DELETE FROM public.outlook_conversation_progress;
  DELETE FROM public.interaction_candidates WHERE user_id = u;
  DELETE FROM public.contacts WHERE user_id = u;
  DELETE FROM public.microsoft_connections WHERE user_id = u;
  RAISE NOTICE 'outlook-pilot-retention: all assertions passed';
END $$;
