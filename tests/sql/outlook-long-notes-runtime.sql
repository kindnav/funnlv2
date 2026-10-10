-- DISPOSABLE DATABASE ONLY. Apply the repo migrations first (20261010120000 included).
-- The reviewed interaction note may run to 10,000 characters, with paragraphs, line breaks
-- and tabs, through BOTH acceptance RPCs; exactly that text is saved into interactions.notes;
-- a note over the limit, or carrying another control character, is refused with no write;
-- the provider-draft columns keep their 200-character bound; acceptance stays idempotent and
-- ownership- and expiry-checked. Everything rolls back.
BEGIN;
DO $$
DECLARE
  u1   uuid := '11111111-1111-1111-1111-111111111111';
  u2   uuid := '22222222-2222-2222-2222-222222222222';
  c1   uuid;
  cand uuid;
  cand2 uuid;
  ncc  uuid;
  ncc2 uuid;
  res  jsonb;
  NL   text := pg_catalog.chr(10);
  TAB  text := pg_catalog.chr(9);
  para text;
  long_note text;
  saved text;
  n_before integer;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', u1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u1::text)::text, true);

  DELETE FROM public.interaction_candidates WHERE user_id IN (u1, u2);
  DELETE FROM public.new_contact_candidates WHERE user_id IN (u1, u2);
  DELETE FROM public.interactions WHERE user_id IN (u1, u2);
  DELETE FROM public.contacts WHERE user_id IN (u1, u2);
  INSERT INTO public.contacts (user_id, name, email) VALUES (u1, 'Long Note Contact', 'long@example.test') RETURNING id INTO c1;

  -- A 9,999-character note: paragraphs separated by blank lines, a tabbed list, trailing text.
  para := repeat('Talked through the summer analyst process and what the desk actually values. ', 20);
  long_note := para || NL || NL || 'Next steps:' || NL || TAB || '- send the CV by Friday' || NL || TAB || '- confirm the markets track' || NL || NL || para;
  long_note := long_note || repeat('x', 9999 - char_length(long_note));
  ASSERT char_length(long_note) = 9999, char_length(long_note)::text;
  ASSERT long_note ~ pg_catalog.chr(9) AND long_note ~ pg_catalog.chr(10), 'the fixture carries a tab and line breaks';

  -- ── interaction candidate: accepted with the long multiline note, saved exactly ──────────
  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, status, source_last_state, context_expires_at, proposed_notes)
  VALUES (u1, c1, 'outlook', repeat('a', 64), 'Email', current_date - 1, 'pending', 'active', now() + interval '30 days', 'Short draft.')
  RETURNING id INTO cand;
  res := public.accept_interaction_candidate(cand, 'Email', current_date - 1, long_note, NULL, NULL);
  ASSERT res ->> 'result' = 'accepted', 'long multiline note refused: ' || res::text;
  SELECT i.notes INTO saved FROM public.interactions i WHERE i.user_id = u1 AND i.contact_id = c1;
  ASSERT saved = long_note, 'the saved note differs from the reviewed note (len ' || char_length(saved) || ')';
  ASSERT char_length(saved) = 9999, 'not truncated';
  -- idempotent: accepting again creates nothing and says so
  res := public.accept_interaction_candidate(cand, 'Email', current_date - 1, long_note, NULL, NULL);
  ASSERT res ->> 'result' = 'already_accepted', res::text;
  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u1) = 1, 'idempotent';
  -- with a kept next step the note is saved, then the step appended - full text preserved
  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, status, source_last_state, context_expires_at, proposed_notes)
  VALUES (u1, c1, 'outlook', repeat('b', 64), 'Email', current_date, 'pending', 'active', now() + interval '30 days', 'Short draft.')
  RETURNING id INTO cand2;
  res := public.accept_interaction_candidate(cand2, 'Email', current_date, long_note, 'Chase on Friday.', NULL);
  ASSERT res ->> 'result' = 'accepted', res::text;
  SELECT i.notes INTO saved FROM public.interactions i WHERE i.user_id = u1 AND i.contact_id = c1 AND i.interaction_date = current_date;
  ASSERT saved = long_note || NL || NL || 'Next step: Chase on Friday.', 'note + next step preserved';

  -- ── boundary: 10,000 accepted, 10,001 refused with NO write ──────────────────────────────
  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, status, source_last_state, context_expires_at)
  VALUES (u1, c1, 'outlook', repeat('c', 64), 'Email', current_date - 2, 'pending', 'active', now() + interval '30 days')
  RETURNING id INTO cand;
  n_before := (SELECT count(*) FROM public.interactions WHERE user_id = u1);
  res := public.accept_interaction_candidate(cand, 'Email', current_date - 2, repeat('y', 10001), NULL, NULL);
  ASSERT res ->> 'result' = 'invalid_notes', '10,001 must be refused: ' || res::text;
  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u1) = n_before, 'a refusal writes nothing';
  ASSERT (SELECT status FROM public.interaction_candidates WHERE id = cand) = 'pending', 'and the candidate stays pending';
  res := public.accept_interaction_candidate(cand, 'Email', current_date - 2, repeat('y', 10000), NULL, NULL);
  ASSERT res ->> 'result' = 'accepted', '10,000 exactly is accepted: ' || res::text;

  -- ── ownership and expiry still gate acceptance ───────────────────────────────────────────
  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, status, source_last_state, context_expires_at)
  VALUES (u1, c1, 'outlook', repeat('d', 64), 'Email', current_date, 'pending', 'active', now() - interval '1 minute')
  RETURNING id INTO cand;
  res := public.accept_interaction_candidate(cand, 'Email', current_date, long_note, NULL, NULL);
  ASSERT res ->> 'result' <> 'accepted', 'an expired candidate must not be accepted: ' || res::text;
  PERFORM set_config('request.jwt.claim.sub', u2::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u2::text)::text, true);
  res := public.accept_interaction_candidate(cand2, 'Email', current_date, long_note, NULL, NULL);
  ASSERT res ->> 'result' <> 'accepted', 'another user cannot accept: ' || res::text;
  PERFORM set_config('request.jwt.claim.sub', u1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u1::text)::text, true);

  -- ── new-contact proposal: long multiline note through its RPC, saved exactly ─────────────
  INSERT INTO public.new_contact_candidates
    (user_id, source, status, person_fingerprint, episode_fingerprint, key_version, proposed_email, proposed_name,
     proposed_name_evidence, proposed_name_confidence, draft_summary, proposed_interaction_date, proposed_type, context_expires_at)
  VALUES (u1, 'outlook', 'pending', repeat('e', 64), repeat('f', 64), 1, 'newperson@example.test', 'New Person',
          'explicit_signature', 'high', 'Short draft.', current_date, 'Email', now() + interval '30 days')
  RETURNING id INTO ncc;
  res := public.accept_new_contact_candidate(ncc, 'New Person', p_interaction_notes => long_note);
  ASSERT res ->> 'result' = 'accepted', 'new-contact long note refused: ' || res::text;
  SELECT i.notes INTO saved FROM public.interactions i JOIN public.contacts c ON c.id = i.contact_id
   WHERE c.user_id = u1 AND c.name = 'New Person';
  ASSERT saved = long_note, 'new-contact note preserved exactly';
  res := public.accept_new_contact_candidate(ncc, 'New Person', p_interaction_notes => long_note);
  ASSERT res ->> 'result' <> 'accepted', 'idempotent: ' || res::text;
  ASSERT (SELECT count(*) FROM public.contacts WHERE user_id = u1 AND name = 'New Person') = 1;

  -- ── new-contact boundary and control characters ──────────────────────────────────────────
  INSERT INTO public.new_contact_candidates
    (user_id, source, status, person_fingerprint, episode_fingerprint, key_version, proposed_email, proposed_name,
     proposed_name_evidence, proposed_name_confidence, draft_summary, proposed_interaction_date, proposed_type, context_expires_at)
  VALUES (u1, 'outlook', 'pending', repeat('1', 64), repeat('2', 64), 1, 'second@example.test', 'Second Person',
          'explicit_signature', 'high', 'Short draft.', current_date, 'Email', now() + interval '30 days')
  RETURNING id INTO ncc2;
  n_before := (SELECT count(*) FROM public.contacts WHERE user_id = u1);
  res := public.accept_new_contact_candidate(ncc2, 'Second Person', p_interaction_notes => repeat('z', 10001));
  ASSERT res ->> 'result' = 'invalid_notes', '10,001 refused: ' || res::text;
  res := public.accept_new_contact_candidate(ncc2, 'Second Person', p_interaction_notes => 'fine' || pg_catalog.chr(1) || 'not fine');
  ASSERT res ->> 'result' = 'invalid_notes', 'a non-whitespace control character is still refused: ' || res::text;
  res := public.accept_new_contact_candidate(ncc2, 'Second' || NL || 'Person', p_interaction_notes => 'ok');
  ASSERT res ->> 'result' = 'invalid_name', 'other fields still reject line breaks: ' || res::text;
  res := public.accept_new_contact_candidate(ncc2, 'Second Person', p_company => 'Acme' || TAB || 'Inc', p_interaction_notes => 'ok');
  ASSERT res ->> 'result' = 'invalid_company', 'other fields still reject tabs: ' || res::text;
  ASSERT (SELECT count(*) FROM public.contacts WHERE user_id = u1) = n_before, 'refusals wrote no contact';
  ASSERT (SELECT status FROM public.new_contact_candidates WHERE id = ncc2) = 'pending';
  res := public.accept_new_contact_candidate(ncc2, 'Second Person', p_interaction_notes => repeat('z', 10000));
  ASSERT res ->> 'result' = 'accepted', '10,000 exactly accepted: ' || res::text;

  -- ── the provider-draft columns are NOT widened ───────────────────────────────────────────
  BEGIN
    INSERT INTO public.interaction_candidates
      (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, status, source_last_state, context_expires_at, proposed_notes)
    VALUES (u1, c1, 'outlook', repeat('9', 64), 'Email', current_date, 'pending', 'active', now() + interval '30 days', repeat('q', 201));
    RAISE EXCEPTION 'draft column accepted 201';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── catalog: one overload each, grants unchanged ─────────────────────────────────────────
  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'accept_interaction_candidate') = 1;
  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'accept_new_contact_candidate') = 1;
  ASSERT has_function_privilege('authenticated', 'public.accept_interaction_candidate(uuid, text, date, text, text, date)', 'EXECUTE');
  ASSERT NOT has_function_privilege('anon', 'public.accept_interaction_candidate(uuid, text, date, text, text, date)', 'EXECUTE');
  ASSERT has_function_privilege('authenticated', 'public.accept_new_contact_candidate(uuid, text, text, text, text, text, text[], text, text, boolean, text, date, text, date)', 'EXECUTE');
  ASSERT NOT has_function_privilege('anon', 'public.accept_new_contact_candidate(uuid, text, text, text, text, text, text[], text, text, boolean, text, date, text, date)', 'EXECUTE');
  ASSERT NOT has_function_privilege('service_role', 'public.accept_new_contact_candidate(uuid, text, text, text, text, text, text[], text, text, boolean, text, date, text, date)', 'EXECUTE');
  ASSERT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=""'] FROM pg_proc p WHERE p.oid = 'public.accept_interaction_candidate(uuid, text, date, text, text, date)'::regprocedure);
  ASSERT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=""'] FROM pg_proc p WHERE p.oid = 'public.accept_new_contact_candidate(uuid, text, text, text, text, text, text[], text, text, boolean, text, date, text, date)'::regprocedure);
END $$;
ROLLBACK;
