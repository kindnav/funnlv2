-- DISPOSABLE DATABASE ONLY. Apply the repo migrations first (20261010180000 included).
--
-- The GENERATED note may run to 2,000 characters through both PRODUCER RPCs and is stored
-- whole; 2,001 is refused with nothing written; the control-character and URL rules are
-- unchanged; the follow-up stays bounded at 160. Both ACCEPTANCE paths then save the
-- generated note untouched when the reviewer overrides nothing, and save the reviewer's own
-- longer note when they do. Deduplication, refresh and terminal erasure are unaffected.
-- Everything rolls back.
BEGIN;
DO $$
DECLARE
  u     uuid := '11111111-1111-1111-1111-111111111111';
  conn  uuid;
  run   uuid := gen_random_uuid();
  cid   uuid;
  cand  uuid;
  ncc   uuid;
  res   jsonb;
  v     jsonb;
  NL    text := pg_catalog.chr(10);
  detailed    text;
  detailed_nc text;
  saved text;
  n_before integer;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', u::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u)::text, true);

  DELETE FROM public.microsoft_connections WHERE user_id = u;
  DELETE FROM public.interaction_candidates WHERE user_id = u;
  DELETE FROM public.new_contact_candidates WHERE user_id = u;
  DELETE FROM public.interactions WHERE user_id = u;
  DELETE FROM public.contacts WHERE user_id = u;

  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, account_type, ms_email, scopes, status, consented_at, consent_policy_version)
    VALUES (u, 'fixture-detailed', 'personal', 'u1@example.test',
            ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(), 'v1')
    RETURNING id INTO conn;
  INSERT INTO public.contacts (user_id, name, email)
    VALUES (u, 'Fixture Contact', 'contact@example.test') RETURNING id INTO cid;
  -- A LIVE RUN on both folders: the producers are fenced on it.
  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, sync_run_id, sync_lease_until, run_started_at)
    SELECT conn, u, f, 'running', run, now() + interval '7 minutes', now()
      FROM unnest(ARRAY['inbox','sentitems']) f;

  -- A detailed note of exactly 2,000 characters: one prose paragraph, no line breaks, no URL.
  detailed := 'Priya is on the analyst programme team and offered to put the application in '
    || 'front of the programme lead before the 24 October internal deadline. She said the '
    || 'screening call is competency-based rather than technical and advised preparing two '
    || 'examples of working under a deadline. On the desk choice she was clear that markets '
    || 'suits the modelling work better than coverage. Left open: whether the insight week '
    || 'can run in parallel with the summer application. ';
  detailed := detailed || repeat('Further context recorded from the exchange. ', 40);
  detailed := rtrim(substr(detailed, 1, 2000));
  detailed := detailed || repeat('x', 2000 - char_length(detailed));
  ASSERT char_length(detailed) = 2000, char_length(detailed)::text;
  ASSERT detailed !~ '[[:cntrl:]]', 'the generated note is one prose paragraph';

  -- ══ 1. the INTERACTION producer stores the whole 2,000-character note ═════════════════════
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('a', 64), repeat('b', 64),
    1::smallint, 'Email', current_date, NULL, detailed, 'Send the CV by Friday.', 'explicit_body', 'ai_extracted');
  ASSERT res ->> 'result' = 'created', 'a 2,000-character generated note was refused: ' || res::text;
  cand := (res ->> 'candidate_id')::uuid;
  SELECT proposed_notes INTO saved FROM public.interaction_candidates WHERE id = cand;
  ASSERT saved = detailed, 'proposed_notes was not stored whole (len ' || char_length(saved) || ')';
  SELECT draft_summary INTO saved FROM public.interaction_candidates WHERE id = cand;
  ASSERT saved = detailed, 'draft_summary was not stored whole';
  ASSERT (SELECT draft_follow_up FROM public.interaction_candidates WHERE id = cand) = 'Send the CV by Friday.';
  ASSERT (SELECT summary_evidence FROM public.interaction_candidates WHERE id = cand) = 'explicit_body';
  ASSERT (SELECT extraction_status FROM public.interaction_candidates WHERE id = cand) = 'ai_extracted';

  -- 2,001 is REFUSED, not trimmed, and the stored row is untouched.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('a', 64), repeat('b', 64),
    1::smallint, 'Email', current_date, NULL, detailed || 'y', NULL, 'explicit_body', 'ai_extracted');
  ASSERT res ->> 'result' = 'invalid_notes', '2,001 must be refused: ' || res::text;
  ASSERT (SELECT proposed_notes FROM public.interaction_candidates WHERE id = cand) = detailed,
    'a refusal must not disturb the stored note';

  -- The control-character and URL rules are unchanged.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('a', 64), repeat('b', 64),
    1::smallint, 'Email', current_date, NULL, 'Topic one.' || NL || 'Topic two.', NULL, 'explicit_body', 'ai_extracted');
  ASSERT res ->> 'result' = 'invalid_notes', 'a line break in a GENERATED note is still refused: ' || res::text;
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('a', 64), repeat('b', 64),
    1::smallint, 'Email', current_date, NULL, 'See https://example.invalid/role', NULL, 'explicit_body', 'ai_extracted');
  ASSERT res ->> 'result' = 'invalid_evidence', 'a URL in the note is still refused: ' || res::text;
  -- The follow-up bound did not move.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('a', 64), repeat('b', 64),
    1::smallint, 'Email', current_date, NULL, detailed, repeat('f', 161), 'explicit_body', 'ai_extracted');
  ASSERT res ->> 'result' = 'invalid_follow_up', 'the 160 follow-up bound is unchanged: ' || res::text;

  -- REFRESH keeps working, and the refreshed row carries the newer long note.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('a', 64), repeat('b', 64),
    1::smallint, 'Email', current_date, NULL, 'A shorter refreshed note.', NULL, 'explicit_body', 'ai_extracted');
  ASSERT res ->> 'result' = 'refreshed', res::text;
  ASSERT (res ->> 'candidate_id')::uuid = cand, 'the same row is refreshed, not duplicated';
  ASSERT (SELECT proposed_notes FROM public.interaction_candidates WHERE id = cand) = 'A shorter refreshed note.';
  -- put the detailed note back for the acceptance checks
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('a', 64), repeat('b', 64),
    1::smallint, 'Email', current_date, NULL, detailed, NULL, 'explicit_body', 'ai_extracted');
  ASSERT res ->> 'result' = 'refreshed', res::text;

  -- ══ 2. ACCEPTANCE saves the generated note untouched when nothing is overridden ═══════════
  res := public.accept_interaction_candidate(cand, NULL, NULL, NULL, NULL, NULL);
  ASSERT res ->> 'result' = 'accepted', 'the generated note was refused on acceptance: ' || res::text;
  SELECT i.notes INTO saved FROM public.interactions i WHERE i.user_id = u AND i.contact_id = cid;
  ASSERT saved = detailed, 'the accepted interaction must carry the whole generated note';
  ASSERT char_length(saved) = 2000, 'not truncated at acceptance';
  -- and the terminal row erased its draft, as before
  ASSERT (SELECT draft_summary IS NULL AND draft_follow_up IS NULL AND summary_evidence IS NULL
            FROM public.interaction_candidates WHERE id = cand),
    'terminal draft erasure is unchanged';

  -- The reviewer may still replace it with their own, longer note (10,000 allowance).
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('c', 64), repeat('d', 64),
    1::smallint, 'Email', current_date - 1, NULL, detailed, NULL, 'explicit_body', 'ai_extracted');
  ASSERT res ->> 'result' = 'created', res::text;
  cand := (res ->> 'candidate_id')::uuid;
  res := public.accept_interaction_candidate(cand, 'Email', current_date - 1,
    detailed || NL || NL || 'My own added paragraph.', NULL, NULL);
  ASSERT res ->> 'result' = 'accepted', res::text;
  SELECT i.notes INTO saved FROM public.interactions i
   WHERE i.user_id = u AND i.contact_id = cid AND i.interaction_date = current_date - 1;
  ASSERT saved = detailed || NL || NL || 'My own added paragraph.',
    'the reviewer''s own multiline note still overrides and is saved whole';

  -- ══ 3. the NEW-CONTACT producer and its acceptance path ══════════════════════════════════
  detailed_nc := rtrim(substr(detailed, 1, 1999)) || '.';
  ASSERT char_length(detailed_nc) <= 2000;
  res := public.upsert_new_contact_candidate(conn, run, repeat('e', 64), repeat('f', 64), 1::smallint,
    'newperson@example.test', current_date, 'New Person', 'explicit_signature', 'high',
    detailed_nc, 'Send the CV by Friday.', 'Summer analyst referral', 'ai_extracted');
  ASSERT res ->> 'result' = 'created', 'a 2,000-character generated summary was refused: ' || res::text;
  ncc := (res ->> 'candidate_id')::uuid;
  SELECT draft_summary INTO saved FROM public.new_contact_candidates WHERE id = ncc;
  ASSERT saved = detailed_nc, 'the proposal summary was not stored whole';

  n_before := (SELECT count(*) FROM public.new_contact_candidates WHERE user_id = u);
  res := public.upsert_new_contact_candidate(conn, run, repeat('1', 64), repeat('2', 64), 1::smallint,
    'second@example.test', current_date, 'Second Person', 'explicit_signature', 'high',
    repeat('z', 2001), NULL, NULL, 'ai_extracted');
  ASSERT res ->> 'result' = 'invalid_summary', '2,001 must be refused: ' || res::text;
  res := public.upsert_new_contact_candidate(conn, run, repeat('1', 64), repeat('2', 64), 1::smallint,
    'second@example.test', current_date, 'Second Person', 'explicit_signature', 'high',
    'Topic one.' || NL || 'Topic two.', NULL, NULL, 'ai_extracted');
  ASSERT res ->> 'result' = 'invalid_summary', 'a line break is still refused: ' || res::text;
  res := public.upsert_new_contact_candidate(conn, run, repeat('1', 64), repeat('2', 64), 1::smallint,
    'second@example.test', current_date, 'Second Person', 'explicit_signature', 'high',
    'See https://example.invalid/role', NULL, NULL, 'ai_extracted');
  ASSERT res ->> 'result' = 'invalid_summary', 'a URL is still refused: ' || res::text;
  ASSERT (SELECT count(*) FROM public.new_contact_candidates WHERE user_id = u) = n_before,
    'the refusals wrote no proposal';

  -- Acceptance with no override saves the generated summary whole.
  v := public.accept_new_contact_candidate(ncc, 'New Person');
  ASSERT v ->> 'result' = 'accepted', 'the generated summary was refused on acceptance: ' || v::text;
  SELECT i.notes INTO saved FROM public.interactions i JOIN public.contacts c ON c.id = i.contact_id
   WHERE c.user_id = u AND c.name = 'New Person';
  ASSERT saved = detailed_nc || pg_catalog.chr(10) || pg_catalog.chr(10) || 'Next step: Send the CV by Friday.'
      OR saved = detailed_nc,
    'the accepted proposal must carry the whole generated summary (len ' || char_length(saved) || ')';
  ASSERT char_length(saved) >= char_length(detailed_nc), 'nothing was truncated at acceptance';

  -- ══ 4. the catalog says 2,000, and nothing else moved ════════════════════════════════════
  ASSERT (SELECT pg_get_constraintdef(c.oid) LIKE '%2000%' FROM pg_constraint c
           WHERE c.conname = 'interaction_candidates_notes_len');
  ASSERT (SELECT pg_get_constraintdef(c.oid) LIKE '%2000%' AND pg_get_constraintdef(c.oid) LIKE '%cntrl%'
           FROM pg_constraint c WHERE c.conname = 'interaction_candidates_draft_summary_bounds');
  ASSERT (SELECT pg_get_constraintdef(c.oid) LIKE '%2000%' AND pg_get_constraintdef(c.oid) LIKE '%cntrl%'
           FROM pg_constraint c WHERE c.conname = 'ncc_summary_bounds');
  ASSERT (SELECT pg_get_constraintdef(c.oid) LIKE '%160%' FROM pg_constraint c
           WHERE c.conname = 'ncc_follow_up_bounds'), 'the follow-up bound is unchanged';
  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'upsert_outlook_interaction_candidate') = 1;
  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'upsert_new_contact_candidate') = 1;
  -- both producers remain worker-only
  ASSERT has_function_privilege('service_role',
    'public.upsert_outlook_interaction_candidate(uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated',
    'public.upsert_outlook_interaction_candidate(uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text)', 'EXECUTE');
  ASSERT has_function_privilege('service_role',
    'public.upsert_new_contact_candidate(uuid, uuid, text, text, smallint, text, date, text, text, text, text, text, text, text)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated',
    'public.upsert_new_contact_candidate(uuid, uuid, text, text, smallint, text, date, text, text, text, text, text, text, text)', 'EXECUTE');
  -- and the reviewed-note allowance is still the larger one
  ASSERT (SELECT pg_get_functiondef(p.oid) LIKE '%char_length(v_notes) > 10000%' FROM pg_proc p
           WHERE p.oid = 'public.accept_interaction_candidate(uuid, text, date, text, text, date)'::regprocedure);
END $$;
ROLLBACK;
