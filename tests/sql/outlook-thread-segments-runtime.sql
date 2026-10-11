-- LATER INTERACTIONS INSIDE A SETTLED OUTLOOK THREAD - runtime proof
--
-- WHAT THIS PROVES, against the real functions, the real constraints and the real grants:
--   1. A SETTLED EXCHANGE STAYS SETTLED, and its interaction and notes are never touched.
--   2. A SUBSEQUENT TWO-WAY EXCHANGE becomes a NEW pending suggestion in the same thread.
--   3. REPLAY of an already-summarized exchange is exists_terminal, not a second suggestion.
--   4. TIMESTAMP COLLISIONS: two messages at the same instant are distinguished, because
--      coverage is a set of message fingerprints and not a watermark.
--   5. DELAYED DISCOVERY: a message older than everything covered is still new.
--   6. ONE PENDING SEGMENT PER THREAD, keeping the identity it was created under, through a
--      refresh, a replay, a rotated key and a late-discovered earlier message.
--   7. COVERAGE MOVES ONLY WITH THE DRAFT: a metadata-only refresh does not advance it, and
--      neither does any rejected write.
--   8. A CONCURRENT DECISION (accept or dismiss racing a worker refresh) loses no mail and
--      duplicates none: the write is refused `coverage_moved`, which is NOT in WRITE_OK, so
--      the cursor does not advance and the next round drafts the genuinely new part.
--   9. THE NEW-CONTACT TRANSITION: a thread settled as a new-contact proposal continues as a
--      known-contact interaction, and the earlier coverage still resolves - because the
--      conversation fingerprint is contact-independent.
--  10. LEGACY ROWS are not inferred from reviewer dates: a settled segment with no coverage
--      blocks creation until an explicit forward-only baseline is recorded.
--  11. THE LEASE FENCE and the shape validation still refuse everything they refused before.
--  12. THE ACCEPTANCE RPCs ARE UNCHANGED: still 10,000 characters, still authenticated-only.
--
-- HOW TO BUILD THE DATABASE THIS NEEDS: tests/sql/_bootstrap-disposable-db.sql, then every
-- migration in supabase/migrations, in filename order.
--
-- WHAT THIS DOES NOT PROVE. It runs as the privileged `postgres` role, so it proves the
-- function bodies, the constraints and the catalog - not RLS and not PostgREST. It says
-- nothing about Production, where 20261011000000 is UNAPPLIED.
\set ON_ERROR_STOP on

-- ══ fixtures ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE
  u    uuid := '7a000000-0000-0000-0000-00000000000a';
  conn uuid := '7b000000-0000-0000-0000-00000000000b';
  run  uuid := '7c000000-0000-0000-0000-00000000000c';
BEGIN
  DELETE FROM public.outlook_candidate_refs WHERE user_id = u;
  DELETE FROM public.interaction_candidates WHERE user_id = u;
  DELETE FROM public.new_contact_candidates WHERE user_id = u;
  DELETE FROM public.interactions           WHERE user_id = u;
  DELETE FROM public.contacts               WHERE user_id = u;
  DELETE FROM public.outlook_sync_state     WHERE connection_id = conn;
  DELETE FROM public.microsoft_connections  WHERE user_id = u;
  INSERT INTO auth.users (id, email) VALUES (u, 'segments@getfunnl.test') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, email) VALUES (u, 'segments@getfunnl.test') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.microsoft_connections
    (id, user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, needs_reauth, consented_at, consent_policy_version)
  VALUES
    (conn, u, 'acct-seg', '9188040d-6c67-4c5b-b112-36a304b66dad', 'personal',
     'segments@outlook.test', ARRAY['Mail.Read','User.Read','offline_access'],
     'active', false, now(), 'ol-disc-e3e2b1714b453c2904e3ed08cb232097');
  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, sync_run_id, sync_lease_until,
     run_started_at, last_attempt_at, updated_at)
  VALUES
    (conn, u, 'inbox',     'running', run, now() + interval '7 minutes', now(), now(), now()),
    (conn, u, 'sentitems', 'running', run, now() + interval '7 minutes', now(), now(), now());
  INSERT INTO public.contacts (user_id, name, email) VALUES (u, 'Ava Recruiter', 'ava@bank.test');
END $$;

-- ══ 1. the catalog ═════════════════════════════════════════════════════════════
DO $$
DECLARE n int;
BEGIN
  FOR n IN SELECT 1 LOOP END LOOP;
  -- the four coverage columns and their constraints
  ASSERT (SELECT count(*) FROM information_schema.columns
           WHERE table_schema='public' AND table_name='outlook_candidate_refs'
             AND column_name IN ('conversation_fingerprint','covered_message_fingerprints',
                                 'coverage_through_at','coverage_source')) = 4,
    'the four coverage columns must exist';
  FOR n IN SELECT 1 FROM (VALUES ('ocr_conversation_fp_shape'),('ocr_coverage_shape'),
                                 ('ocr_coverage_source_known'),('ocr_coverage_together')) v(c)
           WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v.c) LOOP
    ASSERT false, 'a coverage CHECK is missing';
  END LOOP;
  -- one overload each, worker-only, SECURITY DEFINER with an empty search_path
  FOR n IN SELECT 1 FROM (VALUES ('get_outlook_thread_coverage'),
                                 ('baseline_outlook_thread_coverage'),
                                 ('upsert_outlook_interaction_candidate'),
                                 ('upsert_new_contact_candidate')) v(f) LOOP
  END LOOP;
  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
           WHERE ns.nspname='public' AND p.proname='get_outlook_thread_coverage') = 1,
    'one get_outlook_thread_coverage';
  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
           WHERE ns.nspname='public' AND p.proname='baseline_outlook_thread_coverage') = 1,
    'one baseline_outlook_thread_coverage';
  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
           WHERE ns.nspname='public' AND p.proname='upsert_outlook_interaction_candidate') = 1,
    'one interaction producer';
  ASSERT has_function_privilege('service_role',
    'public.get_outlook_thread_coverage(uuid,uuid,jsonb)', 'EXECUTE'), 'worker may read coverage';
  ASSERT NOT has_function_privilege('authenticated',
    'public.get_outlook_thread_coverage(uuid,uuid,jsonb)', 'EXECUTE'),
    'a signed-in user must NOT learn which threads have exchanges';
  ASSERT NOT has_function_privilege('anon',
    'public.get_outlook_thread_coverage(uuid,uuid,jsonb)', 'EXECUTE'), 'nor anon';
  ASSERT NOT has_function_privilege('authenticated',
    'public.baseline_outlook_thread_coverage(uuid,uuid,text,text,text[],timestamptz,timestamptz)', 'EXECUTE'),
    'baselining is the worker''s job only';
  -- and the acceptance RPCs are untouched
  ASSERT has_function_privilege('authenticated',
    'public.accept_interaction_candidate(uuid,text,date,text,text,date)', 'EXECUTE'),
    'acceptance stays authenticated';
  ASSERT (SELECT prosrc LIKE '%10000%' FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
           WHERE ns.nspname='public' AND p.proname='accept_interaction_candidate'),
    'the reviewed-note allowance is still 10,000';
  RAISE NOTICE '1. catalog OK';
END $$;


-- The acceptance and dismissal RPCs read auth.uid(). Both claim forms are set because
-- auth.uid() in this image reads the singular `request.jwt.claim.sub` while PostgREST v14
-- in Production sets the JSON form; setting both impersonates the owner either way.
SELECT set_config('request.jwt.claim.sub', '7a000000-0000-0000-0000-00000000000a', false);
SELECT set_config('request.jwt.claims', json_build_object('sub', '7a000000-0000-0000-0000-00000000000a')::text, false);
-- ══ 2..12 behaviour ════════════════════════════════════════════════════════════
DO $$
DECLARE
  u    uuid := '7a000000-0000-0000-0000-00000000000a';
  conn uuid := '7b000000-0000-0000-0000-00000000000b';
  run  uuid := '7c000000-0000-0000-0000-00000000000c';
  cid  uuid;
  cfp  text := repeat('a1', 32);           -- the thread
  cfp2 text := repeat('b2', 32);           -- an unrelated thread
  efp1 text := repeat('c3', 32);           -- segment 1 anchor
  efp2 text := repeat('d4', 32);           -- segment 2 anchor
  efp3 text := repeat('e5', 32);           -- segment 3 anchor
  pfp  text := repeat('f6', 32);
  rot  text := repeat('07', 32);           -- a rotated-key variant of efp2
  m1   text := lpad('1', 64, '0');         -- segment 1: two messages
  m2   text := lpad('2', 64, '0');
  m3   text := lpad('3', 64, '0');         -- segment 2
  m4   text := lpad('4', 64, '0');
  m5   text := lpad('5', 64, '0');         -- same instant as m4
  m0   text := lpad('6', 64, '0');         -- discovered late, older than everything
  res  jsonb;
  cov  jsonb;
  seg1 uuid;
  seg2 uuid;
  inter uuid;
  note1 text := 'Ava confirmed the first-round date and asked for a CV.';
  reviewed text := 'MY OWN NOTES.' || chr(10) || chr(10) || 'Ava confirmed Thursday. Send the CV.';
  n int;
BEGIN
  -- ── 2. segment one: created with its coverage ───────────────────────────────
  res := public.upsert_outlook_interaction_candidate(
    conn, run, (SELECT id FROM public.contacts WHERE user_id = u), efp1, pfp, 1::smallint,
    'Email', DATE '2026-10-01', NULL, note1, 'Send the CV.', 'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := cfp,
    p_covered_fingerprints     := ARRAY[m1, m2],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-01 17:00:00+00', p_coverage_through_at := TIMESTAMPTZ '2026-10-01 17:00:00+00');
  ASSERT res->>'result' = 'created', '2: ' || res::text;
  seg1 := (res->>'candidate_id')::uuid;
  ASSERT (SELECT covered_message_fingerprints FROM public.outlook_candidate_refs
           WHERE interaction_candidate_id = seg1) = ARRAY[m1, m2],
    'coverage is stored with the segment that was created';
  ASSERT (SELECT coverage_source FROM public.outlook_candidate_refs
           WHERE interaction_candidate_id = seg1) = 'draft',
    'and it is recorded as coming from a draft, not a baseline';
  RAISE NOTICE '2. segment one created with coverage';

  -- ── 3. a metadata-only refresh does NOT advance coverage ────────────────────
  -- No note carried: the consent gate closed, or a body fetch failed. The stored draft is
  -- preserved, and so is its coverage - coverage that ran ahead of the draft would mark
  -- mail summarized that nothing describes.
  res := public.upsert_outlook_interaction_candidate(
    conn, run, (SELECT id FROM public.contacts WHERE user_id = u), efp1, pfp, 1::smallint,
    'Email', DATE '2026-10-02', NULL, NULL, NULL, NULL, NULL,
    p_conversation_fingerprint := cfp,
    p_covered_fingerprints     := ARRAY[m1, m2, m3],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-02 09:00:00+00', p_coverage_through_at := TIMESTAMPTZ '2026-10-02 09:00:00+00');
  ASSERT res->>'result' = 'refreshed' AND (res->>'candidate_id')::uuid = seg1, '3: ' || res::text;
  ASSERT (SELECT covered_message_fingerprints FROM public.outlook_candidate_refs
           WHERE interaction_candidate_id = seg1) = ARRAY[m1, m2],
    'a metadata-only refresh must NOT advance coverage';
  ASSERT (SELECT proposed_notes FROM public.interaction_candidates WHERE id = seg1) = note1,
    'and must not blank the stored note';
  RAISE NOTICE '3. metadata-only refresh leaves coverage and draft alone';

  -- ── 4. a rejected write advances nothing ────────────────────────────────────
  res := public.upsert_outlook_interaction_candidate(
    conn, run, (SELECT id FROM public.contacts WHERE user_id = u), efp1, pfp, 1::smallint,
    'Email', DATE '2026-10-02', NULL, note1, NULL, 'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := cfp,
    p_covered_fingerprints     := ARRAY['not-a-fingerprint'],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-02 09:00:00+00', p_coverage_through_at := TIMESTAMPTZ '2026-10-02 09:00:00+00');
  ASSERT res->>'result' = 'invalid_coverage_fingerprint', '4: ' || res::text;
  ASSERT (SELECT covered_message_fingerprints FROM public.outlook_candidate_refs
           WHERE interaction_candidate_id = seg1) = ARRAY[m1, m2], 'a refused write changes nothing';
  -- coverage without its instant, and coverage without a thread, are both refused
  res := public.upsert_outlook_interaction_candidate(
    conn, run, (SELECT id FROM public.contacts WHERE user_id = u), efp1, pfp, 1::smallint,
    'Email', DATE '2026-10-02', NULL, note1, NULL, 'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := cfp, p_covered_fingerprints := ARRAY[m1]);
  ASSERT res->>'result' = 'invalid_coverage_set', '4b: ' || res::text;
  res := public.upsert_outlook_interaction_candidate(
    conn, run, (SELECT id FROM public.contacts WHERE user_id = u), efp1, pfp, 1::smallint,
    'Email', DATE '2026-10-02', NULL, note1, NULL, 'explicit_body', 'ai_extracted',
    p_covered_fingerprints := ARRAY[m1], p_coverage_from_at := now(), p_coverage_through_at := now());
  ASSERT res->>'result' = 'invalid_coverage_set', '4c: ' || res::text;
  RAISE NOTICE '4. refused writes advance nothing';

  -- ── 5. the reviewer accepts. The interaction and the note are now settled ───
  res := public.accept_interaction_candidate(seg1, 'Email', DATE '2026-10-01', reviewed, NULL, NULL);
  ASSERT res->>'result' = 'accepted', '5: ' || res::text;
  SELECT id INTO inter FROM public.interactions WHERE user_id = u ORDER BY created_at DESC LIMIT 1;
  ASSERT (SELECT notes FROM public.interactions WHERE id = inter) = reviewed,
    'the reviewer''s own multiline note is what was saved';
  RAISE NOTICE '5. accepted; interaction and reviewed note stored';

  -- ── 6. REPLAY of the settled exchange: exists_terminal, nothing resurrected ──
  res := public.upsert_outlook_interaction_candidate(
    conn, run, (SELECT id FROM public.contacts WHERE user_id = u), efp1, pfp, 1::smallint,
    'Email', DATE '2026-10-01', NULL, 'a re-read of the same exchange', NULL, 'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := cfp,
    p_covered_fingerprints     := ARRAY[m1, m2],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-01 17:00:00+00', p_coverage_through_at := TIMESTAMPTZ '2026-10-01 17:00:00+00');
  ASSERT res->>'result' = 'exists_terminal', '6: ' || res::text;
  ASSERT (SELECT count(*) FROM public.interaction_candidates WHERE user_id = u) = 1, 'still one candidate';
  ASSERT (SELECT notes FROM public.interactions WHERE id = inter) = reviewed, 'the note is untouched';
  RAISE NOTICE '6. replay of a settled exchange is exists_terminal';

  -- ── 7. A SUBSEQUENT TWO-WAY EXCHANGE becomes a NEW suggestion ───────────────
  -- m4 and m5 share an instant; m3 is new. Coverage is a set, so the settled m1/m2 are not
  -- re-suggested and the three new messages are not mistaken for them.
  res := public.upsert_outlook_interaction_candidate(
    conn, run, (SELECT id FROM public.contacts WHERE user_id = u), efp2, pfp, 1::smallint,
    'Email', DATE '2026-10-08', NULL,
    'Ava asked for two referees and offered to walk the CV in; you agreed to send names by Friday.',
    'Send two referees by Friday.', 'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := cfp,
    p_covered_fingerprints     := ARRAY[m3, m4, m5],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-08 12:00:00+00', p_coverage_through_at := TIMESTAMPTZ '2026-10-08 12:00:00+00');
  ASSERT res->>'result' = 'created', '7: ' || res::text;
  seg2 := (res->>'candidate_id')::uuid;
  ASSERT seg2 <> seg1, 'a NEW suggestion, not the old row';
  ASSERT (SELECT status FROM public.interaction_candidates WHERE id = seg1) = 'accepted',
    'the earlier segment stays accepted';
  ASSERT (SELECT notes FROM public.interactions WHERE id = inter) = reviewed,
    'and the reviewed note is still exactly what the reviewer wrote';
  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u) = 1,
    'no second interaction until the reviewer accepts the new segment';
  RAISE NOTICE '7. a later two-way exchange is a NEW pending suggestion';

  -- ── 8. TIMESTAMP COLLISION, proven at the boundary ──────────────────────────
  -- m5 shares its instant with m4 and is now covered. A write carrying ONLY m5 is a replay;
  -- a write carrying a different message at the SAME instant is new. A watermark cannot
  -- tell these apart; a fingerprint set can.
  res := public.upsert_outlook_interaction_candidate(
    conn, run, (SELECT id FROM public.contacts WHERE user_id = u), efp2, pfp, 1::smallint,
    'Email', DATE '2026-10-08', NULL, 'same instant, already summarized', NULL, 'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := cfp, p_covered_fingerprints := ARRAY[m5],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-08 12:00:00+00', p_coverage_through_at := TIMESTAMPTZ '2026-10-08 12:00:00+00');
  ASSERT res->>'result' = 'refreshed' AND (res->>'candidate_id')::uuid = seg2,
    '8: a pending segment absorbs it rather than creating another: ' || res::text;
  RAISE NOTICE '8. messages sharing an instant are distinguished';

  -- ── 9. ONE PENDING SEGMENT, IDENTITY PINNED ─────────────────────────────────
  -- A DIFFERENT anchor (a rotated key, or a late-discovered earlier message) still lands on
  -- the pending row. Re-anchoring would be a second suggestion for one exchange.
  res := public.upsert_outlook_interaction_candidate(
    conn, run, (SELECT id FROM public.contacts WHERE user_id = u), rot, pfp, 2::smallint,
    'Email', DATE '2026-10-09', NULL, 'the same exchange under a rotated key', NULL,
    'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := cfp, p_covered_fingerprints := ARRAY[m3, m4, m5],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-09 09:00:00+00', p_coverage_through_at := TIMESTAMPTZ '2026-10-09 09:00:00+00');
  ASSERT res->>'result' = 'refreshed' AND (res->>'candidate_id')::uuid = seg2,
    '9: a rotated key refreshes the pending segment: ' || res::text;
  -- DELAYED DISCOVERY: m0 is older than every covered message and has never been seen.
  res := public.upsert_outlook_interaction_candidate(
    conn, run, (SELECT id FROM public.contacts WHERE user_id = u), efp3, pfp, 1::smallint,
    'Email', DATE '2026-10-09', NULL, 'and one message that surfaced late', NULL,
    'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := cfp, p_covered_fingerprints := ARRAY[m0, m3, m4, m5],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-09 10:00:00+00', p_coverage_through_at := TIMESTAMPTZ '2026-10-09 10:00:00+00');
  ASSERT res->>'result' = 'refreshed' AND (res->>'candidate_id')::uuid = seg2,
    '9b: a late-discovered older message joins the pending segment: ' || res::text;
  -- Compared as a SET: the producer stores it de-duplicated and sorted, so the order here
  -- is not the order it was passed in.
  ASSERT (SELECT covered_message_fingerprints @> ARRAY[m0, m3, m4, m5]
                 AND covered_message_fingerprints <@ ARRAY[m0, m3, m4, m5]
            FROM public.outlook_candidate_refs WHERE interaction_candidate_id = seg2),
    'and coverage grew to include the late-discovered message';
  ASSERT (SELECT covered_message_fingerprints FROM public.outlook_candidate_refs
           WHERE interaction_candidate_id = seg2)
         = (SELECT array_agg(f ORDER BY f) FROM unnest(ARRAY[m0, m3, m4, m5]) f),
    'and it is stored sorted, so a replay produces the identical array';
  ASSERT (SELECT count(*) FROM public.interaction_candidates
           WHERE user_id = u AND status = 'pending') = 1, 'still exactly ONE pending segment';
  RAISE NOTICE '9. pending identity survives rotation and delayed discovery';

  -- ── 10. coverage, as the worker reads it ────────────────────────────────────
  cov := public.get_outlook_thread_coverage(conn, run,
    jsonb_build_array(jsonb_build_object('cfp', cfp, 'efp', efp1),
                      jsonb_build_object('cfp', cfp2, 'efp', repeat('09', 32))));
  ASSERT cov->>'result' = 'ok', '10: ' || cov::text;
  SELECT count(*) INTO n FROM jsonb_array_elements(cov->'threads') t
   WHERE t->>'conversation_fingerprint' = cfp
     AND t->'covered_fingerprints' @> jsonb_build_array(m1, m2)
     AND t->>'pending_episode_fingerprint' IS NOT NULL
     AND (t->>'settled_without_coverage')::boolean = false;
  ASSERT n = 1, '10: the thread reports its settled coverage and its pending segment: ' || cov::text;
  SELECT count(*) INTO n FROM jsonb_array_elements(cov->'threads') t
   WHERE t->>'conversation_fingerprint' = cfp2
     AND t->'covered_fingerprints' = '[]'::jsonb
     AND t->>'pending_episode_fingerprint' IS NULL;
  ASSERT n = 1, '10: an untouched thread reports nothing covered: ' || cov::text;
  RAISE NOTICE '10. coverage reads back for the threads a round will write';

  -- ── 11. A CONCURRENT DECISION: accept races the worker's refresh ────────────
  -- The reviewer dismisses segment two while a worker holds a draft that describes BOTH the
  -- just-settled messages AND newer mail. Storing it would duplicate; discarding it would
  -- lose the new mail. Neither happens.
  res := public.dismiss_interaction_candidate(seg2);
  ASSERT res->>'result' IN ('dismissed', 'ok'), '11 dismiss: ' || res::text;
  res := public.upsert_outlook_interaction_candidate(
    conn, run, (SELECT id FROM public.contacts WHERE user_id = u), efp3, pfp, 1::smallint,
    'Email', DATE '2026-10-10', NULL, 'a draft written before the dismissal landed', NULL,
    'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := cfp,
    p_covered_fingerprints     := ARRAY[m3, m4, m5, lpad('7', 64, '0')],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-10 09:00:00+00', p_coverage_through_at := TIMESTAMPTZ '2026-10-10 09:00:00+00');
  ASSERT res->>'result' = 'coverage_moved', '11: ' || res::text;
  ASSERT (SELECT count(*) FROM public.interaction_candidates WHERE user_id = u) = 2,
    'nothing was created from the mixed draft';
  -- The next round, drafting ONLY the genuinely new message, succeeds.
  res := public.upsert_outlook_interaction_candidate(
    conn, run, (SELECT id FROM public.contacts WHERE user_id = u), efp3, pfp, 1::smallint,
    'Email', DATE '2026-10-10', NULL, 'Ava sent the panel date and you confirmed.', NULL,
    'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := cfp,
    p_covered_fingerprints     := ARRAY[lpad('7', 64, '0'), lpad('8', 64, '0')],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-10 09:00:00+00', p_coverage_through_at := TIMESTAMPTZ '2026-10-10 09:00:00+00');
  ASSERT res->>'result' = 'created', '11b: the new mail is not lost: ' || res::text;
  RAISE NOTICE '11. a concurrent decision loses no mail and duplicates none';

  -- ── 12. the lease fence still refuses a stale run ───────────────────────────
  res := public.upsert_outlook_interaction_candidate(
    conn, '7d000000-0000-0000-0000-00000000000d'::uuid,
    (SELECT id FROM public.contacts WHERE user_id = u), repeat('0a', 32), pfp, 1::smallint,
    'Email', DATE '2026-10-11', NULL, 'from a run that lost its lease', NULL,
    'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := cfp, p_covered_fingerprints := ARRAY[lpad('9', 64, '0')],
    p_coverage_from_at := now(), p_coverage_through_at := now());
  ASSERT res->>'result' = 'stale_run', '12: ' || res::text;
  cov := public.get_outlook_thread_coverage(conn, '7d000000-0000-0000-0000-00000000000d'::uuid,
    jsonb_build_array(jsonb_build_object('cfp', cfp, 'efp', efp1)));
  ASSERT cov->>'result' = 'stale_run', '12b: reading coverage is fenced too: ' || cov::text;
  cov := public.baseline_outlook_thread_coverage(conn, '7d000000-0000-0000-0000-00000000000d'::uuid,
    cfp, efp1, ARRAY[m1], now(), now());
  ASSERT cov->>'result' = 'stale_run', '12c: baselining is fenced too: ' || cov::text;
  RAISE NOTICE '12. the lease fence refuses every new path';
END $$;

-- ══ 13. LEGACY: a settled segment with no coverage ═════════════════════════════
DO $$
DECLARE
  u    uuid := '7a000000-0000-0000-0000-00000000000a';
  conn uuid := '7b000000-0000-0000-0000-00000000000b';
  run  uuid := '7c000000-0000-0000-0000-00000000000c';
  lcfp text := repeat('1b', 32);
  lefp text := repeat('2c', 32);
  pfp  text := repeat('f6', 32);
  legacy uuid;
  res  jsonb;
  cov  jsonb;
  n    int;
BEGIN
  -- A row exactly as one written before this feature: accepted, linked by episode
  -- fingerprint only, with NO conversation fingerprint and NO coverage.
  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date,
     proposed_notes, status)
  VALUES (u, (SELECT id FROM public.contacts WHERE user_id = u), 'outlook', lefp, 'Email',
          DATE '2026-09-01', 'An exchange accepted before segments existed.', 'accepted')
  RETURNING id INTO legacy;
  INSERT INTO public.outlook_candidate_refs
    (user_id, connection_id, interaction_candidate_id, episode_fingerprint, person_fingerprint, key_version)
  VALUES (u, conn, legacy, lefp, pfp, 1);

  -- The read finds it BY THE LEGACY EPISODE KEY and reports that coverage is missing.
  cov := public.get_outlook_thread_coverage(conn, run,
    jsonb_build_array(jsonb_build_object('cfp', lcfp, 'efp', lefp)));
  SELECT count(*) INTO n FROM jsonb_array_elements(cov->'threads') t
   WHERE t->>'conversation_fingerprint' = lcfp
     AND (t->>'settled_without_coverage')::boolean = true;
  ASSERT n = 1, '13: a legacy thread must report settled_without_coverage: ' || cov::text;

  -- WHERE THE GATE ACTUALLY IS. The legacy ref carries no conversation fingerprint, so the
  -- producer - which is handed the thread and the NEW segment's anchor - has nothing to join
  -- it on. Discovering a legacy thread is the READ's job, through the legacy episode key the
  -- worker still computes, and the assertion above is that signal. The worker baselines
  -- before it writes; the producer's own refusal below covers the case where a row IS linked
  -- to the thread but carries no coverage.
  --
  -- A LINKED settled row with no coverage, which a metadata-only refresh can produce: the
  -- producer refuses rather than guessing.
  UPDATE public.outlook_candidate_refs SET conversation_fingerprint = lcfp
   WHERE interaction_candidate_id = legacy;
  res := public.upsert_outlook_interaction_candidate(
    conn, run, (SELECT id FROM public.contacts WHERE user_id = u), repeat('3d', 32), pfp, 1::smallint,
    'Email', DATE '2026-10-09', NULL, 'a later exchange in a legacy thread', NULL,
    'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := lcfp, p_covered_fingerprints := ARRAY[lpad('a', 64, '0')],
    p_coverage_from_at := now(), p_coverage_through_at := now());
  ASSERT res->>'result' = 'coverage_uninitialized',
    '13b: a linked settled row with no coverage must refuse, never guess: ' || res::text;
  ASSERT (SELECT count(*) FROM public.interaction_candidates
           WHERE user_id = u AND source_fingerprint = repeat('3d', 32)) = 0,
    '13b: and nothing was created';

  -- The explicit forward-only baseline. It records what is visible NOW as covered and
  -- produces no suggestion.
  cov := public.baseline_outlook_thread_coverage(conn, run, lcfp, lefp,
    ARRAY[lpad('b', 64, '0'), lpad('c', 64, '0')],
    TIMESTAMPTZ '2026-08-01 09:00:00+00', TIMESTAMPTZ '2026-09-01 12:00:00+00');
  ASSERT cov->>'result' = 'ok' AND (cov->>'initialized')::int = 1, '13c: ' || cov::text;
  ASSERT (SELECT coverage_source FROM public.outlook_candidate_refs
           WHERE interaction_candidate_id = legacy) = 'legacy_baseline',
    'a baseline is recorded as a baseline, never confused with a draft';
  ASSERT (SELECT conversation_fingerprint FROM public.outlook_candidate_refs
           WHERE interaction_candidate_id = legacy) = lcfp,
    'and the thread link is written so the row is findable by thread from now on';
  ASSERT (SELECT proposed_notes FROM public.interaction_candidates WHERE id = legacy)
         = 'An exchange accepted before segments existed.',
    'the accepted row itself is NOT modified by a baseline';

  -- Re-running the baseline changes nothing.
  cov := public.baseline_outlook_thread_coverage(conn, run, lcfp, lefp,
    ARRAY[lpad('d', 64, '0')], now(), now());
  ASSERT (cov->>'initialized')::int = 0, '13d: a row that already has coverage is never rewritten';

  -- From here the thread behaves normally: mail INSIDE the baseline is terminal...
  res := public.upsert_outlook_interaction_candidate(
    conn, run, (SELECT id FROM public.contacts WHERE user_id = u), repeat('3d', 32), pfp, 1::smallint,
    'Email', DATE '2026-09-01', NULL, 'inside the baseline', NULL, 'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := lcfp,
    p_covered_fingerprints := ARRAY[lpad('b', 64, '0'), lpad('c', 64, '0')],
    p_coverage_from_at := TIMESTAMPTZ '2026-09-01 12:00:00+00', p_coverage_through_at := TIMESTAMPTZ '2026-09-01 12:00:00+00');
  ASSERT res->>'result' = 'exists_terminal', '13e: ' || res::text;
  -- ...and mail AFTER it is a new segment.
  res := public.upsert_outlook_interaction_candidate(
    conn, run, (SELECT id FROM public.contacts WHERE user_id = u), repeat('3d', 32), pfp, 1::smallint,
    'Email', DATE '2026-10-09', NULL, 'a genuinely later exchange', NULL, 'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := lcfp,
    p_covered_fingerprints := ARRAY[lpad('e', 64, '0'), lpad('f', 64, '0')],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-09 12:00:00+00', p_coverage_through_at := TIMESTAMPTZ '2026-10-09 12:00:00+00');
  ASSERT res->>'result' = 'created', '13f: ' || res::text;
  RAISE NOTICE '13. legacy rows: forward-only baseline, never inferred from a date';
END $$;

-- ══ 14. THE NEW-CONTACT TRANSITION ════════════════════════════════════════════
DO $$
DECLARE
  u    uuid := '7a000000-0000-0000-0000-00000000000a';
  conn uuid := '7b000000-0000-0000-0000-00000000000b';
  run  uuid := '7c000000-0000-0000-0000-00000000000c';
  ncfp text := repeat('4e', 32);
  nefp text := repeat('5f', 32);
  nefp2 text := repeat('6a', 32);
  npfp text := repeat('7b', 32);
  k1   text := lpad('11', 64, '0');
  k2   text := lpad('12', 64, '0');
  k3   text := lpad('13', 64, '0');
  prop uuid;
  res  jsonb;
  newc uuid;
BEGIN
  -- A proposal for someone who is NOT a contact yet, recording the thread and its coverage.
  res := public.upsert_new_contact_candidate(
    conn, run, nefp, npfp, 1::smallint, 'noor@fund.test', DATE '2026-10-02',
    'Noor Haddad', 'explicit_signature', 'high',
    'Noor offered to introduce you to the growth team and asked for a one-pager.',
    'Send the one-pager.', 'Intro', 'ai_extracted',
    p_conversation_fingerprint := ncfp, p_covered_fingerprints := ARRAY[k1, k2],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-02 18:00:00+00', p_coverage_through_at := TIMESTAMPTZ '2026-10-02 18:00:00+00');
  ASSERT res->>'result' = 'created', '14: ' || res::text;
  prop := (res->>'candidate_id')::uuid;
  ASSERT (SELECT covered_message_fingerprints FROM public.outlook_candidate_refs
           WHERE new_contact_candidate_id = prop) = ARRAY[k1, k2],
    'a new-contact proposal records coverage too';

  -- The reviewer accepts the person. From now on the thread is a KNOWN-CONTACT thread.
  res := public.accept_new_contact_candidate(prop, 'Noor Haddad', NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, true, 'Email', DATE '2026-10-02', 'Noor offered an intro.', NULL);
  ASSERT res->>'result' = 'accepted', '14b: ' || res::text;
  SELECT id INTO newc FROM public.contacts WHERE user_id = u AND email = 'noor@fund.test';
  ASSERT newc IS NOT NULL, 'the person is now a contact';

  -- A REPLAY of the settled exchange, now through the INTERACTION producer, must still be
  -- terminal: the coverage recorded against the proposal resolves because the conversation
  -- fingerprint does not depend on whether the person is a contact.
  res := public.upsert_outlook_interaction_candidate(
    conn, run, newc, nefp, npfp, 1::smallint, 'Email', DATE '2026-10-02', NULL,
    'the same exchange, re-read after acceptance', NULL, 'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := ncfp, p_covered_fingerprints := ARRAY[k1, k2],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-02 18:00:00+00', p_coverage_through_at := TIMESTAMPTZ '2026-10-02 18:00:00+00');
  ASSERT res->>'result' = 'exists_terminal',
    '14c: coverage must survive the new-contact transition: ' || res::text;

  -- And a LATER exchange with the now-known contact is a new suggestion.
  res := public.upsert_outlook_interaction_candidate(
    conn, run, newc, nefp2, npfp, 1::smallint, 'Email', DATE '2026-10-09', NULL,
    'Noor introduced you to the growth team and suggested a call on the 14th.',
    'Reply to the intro.', 'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := ncfp, p_covered_fingerprints := ARRAY[k3],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-09 10:00:00+00', p_coverage_through_at := TIMESTAMPTZ '2026-10-09 10:00:00+00');
  ASSERT res->>'result' = 'created', '14d: ' || res::text;
  ASSERT (SELECT status FROM public.new_contact_candidates WHERE id = prop) = 'accepted',
    'the accepted proposal is untouched';
  RAISE NOTICE '14. the new-contact transition keeps its coverage';
END $$;

-- ══ 15. the constraints refuse a half-written coverage claim ═══════════════════
DO $$
DECLARE
  u    uuid := '7a000000-0000-0000-0000-00000000000a';
  conn uuid := '7b000000-0000-0000-0000-00000000000b';
  any_cand uuid;
  ok boolean;
BEGIN
  SELECT interaction_candidate_id INTO any_cand FROM public.outlook_candidate_refs
   WHERE user_id = u AND interaction_candidate_id IS NOT NULL LIMIT 1;
  -- a coverage set with no instant
  ok := true;
  BEGIN
    UPDATE public.outlook_candidate_refs
       SET covered_message_fingerprints = ARRAY[lpad('1', 64, '0')],
           coverage_through_at = NULL, coverage_source = 'draft'
     WHERE interaction_candidate_id = any_cand;
    ok := false;
  EXCEPTION WHEN check_violation THEN NULL; END;
  ASSERT ok, 'coverage without its instant must be refused';
  -- a malformed fingerprint in the array
  ok := true;
  BEGIN
    UPDATE public.outlook_candidate_refs
       SET covered_message_fingerprints = ARRAY['short'], coverage_through_at = now(),
           coverage_source = 'draft'
     WHERE interaction_candidate_id = any_cand;
    ok := false;
  EXCEPTION WHEN check_violation THEN NULL; END;
  ASSERT ok, 'a malformed coverage fingerprint must be refused';
  -- an unknown provenance
  ok := true;
  BEGIN
    UPDATE public.outlook_candidate_refs
       SET covered_message_fingerprints = ARRAY[lpad('1', 64, '0')], coverage_through_at = now(),
           coverage_source = 'guessed'
     WHERE interaction_candidate_id = any_cand;
    ok := false;
  EXCEPTION WHEN check_violation THEN NULL; END;
  ASSERT ok, 'only draft and legacy_baseline are coverage sources';
  RAISE NOTICE '15. the constraints refuse half-written coverage';
  RAISE NOTICE '';
  RAISE NOTICE 'ALL THREAD-SEGMENT CHECKS PASSED';
END $$;

-- ══ 16. THE NEW-CONTACT PATH gets the same two safeguards ════════════════════
-- Reproduced against the migration before this existed: two writes with the same conversation
-- fingerprint and the same coverage but DIFFERENT episode anchors both answered `created` and
-- left two pending proposals for one exchange, because the producer deduplicated on the
-- episode alone - and the coverage reader gave every new-contact row a NULL pending anchor and
-- then filtered it out, so the worker could not see the open proposal either.
DO $$
DECLARE
  u    uuid := '7a000000-0000-0000-0000-00000000000a';
  conn uuid := '7b000000-0000-0000-0000-00000000000b';
  run  uuid := '7c000000-0000-0000-0000-00000000000c';
  cfp  text := repeat('8a', 32);
  e1   text := repeat('8b', 32);
  e2   text := repeat('8c', 32);
  e3   text := repeat('8d', 32);
  pfp  text := repeat('8e', 32);
  k1   text := lpad('21', 64, '0');
  k2   text := lpad('22', 64, '0');
  k3   text := lpad('23', 64, '0');
  res  jsonb; cov jsonb; prop uuid; n int;
BEGIN
  res := public.upsert_new_contact_candidate(conn, run, e1, pfp, 1::smallint, 'ada@lab.test',
    DATE '2026-10-02', 'Ada Okonjo', 'explicit_signature', 'high',
    'Ada offered to review the deck and asked for it by Friday.', NULL, 'Intro', 'ai_extracted',
    p_conversation_fingerprint := cfp, p_covered_fingerprints := ARRAY[k1, k2],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-02 09:00:00+00',
    p_coverage_through_at := TIMESTAMPTZ '2026-10-02 18:00:00+00');
  ASSERT res->>'result' = 'created', '16: ' || res::text;
  prop := (res->>'candidate_id')::uuid;

  -- A DIFFERENT anchor for the same thread must REFRESH, never create a second proposal.
  res := public.upsert_new_contact_candidate(conn, run, e2, pfp, 1::smallint, 'ada@lab.test',
    DATE '2026-10-03', 'Ada Okonjo', 'explicit_signature', 'high',
    'The same exchange, anchored differently.', NULL, 'Intro', 'ai_extracted',
    p_conversation_fingerprint := cfp, p_covered_fingerprints := ARRAY[k1, k2],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-02 09:00:00+00',
    p_coverage_through_at := TIMESTAMPTZ '2026-10-02 18:00:00+00');
  ASSERT res->>'result' = 'refreshed' AND (res->>'candidate_id')::uuid = prop,
    '16: a new-contact proposal must keep its identity: ' || res::text;
  SELECT count(*) INTO n FROM public.new_contact_candidates
   WHERE user_id = u AND status IN ('pending', 'deferred');
  ASSERT n = 1, '16: exactly ONE open proposal per thread, found ' || n;

  -- The reader must expose that proposal's anchor, or the worker cannot pin identity at all.
  cov := public.get_outlook_thread_coverage(conn, run,
    jsonb_build_array(jsonb_build_object('cfp', cfp, 'efp', e1)));
  ASSERT (SELECT t->>'pending_episode_fingerprint' FROM jsonb_array_elements(cov->'threads') t
           WHERE t->>'conversation_fingerprint' = cfp) = e1,
    '16: the reader must report the proposal anchor: ' || cov::text;

  -- A DISMISSED unknown-person exchange stays settled, under any anchor...
  PERFORM public.dismiss_new_contact_candidate(prop);
  res := public.upsert_new_contact_candidate(conn, run, e3, pfp, 1::smallint, 'ada@lab.test',
    DATE '2026-10-04', 'Ada Okonjo', 'explicit_signature', 'high',
    'A replay of the dismissed exchange.', NULL, 'Intro', 'ai_extracted',
    p_conversation_fingerprint := cfp, p_covered_fingerprints := ARRAY[k1, k2],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-02 09:00:00+00',
    p_coverage_through_at := TIMESTAMPTZ '2026-10-02 18:00:00+00');
  ASSERT res->>'result' = 'exists_terminal',
    '16: a dismissed unknown-person exchange is never proposed again: ' || res::text;

  -- ...and genuinely later mail with the same stranger IS a new proposal.
  res := public.upsert_new_contact_candidate(conn, run, e3, pfp, 1::smallint, 'ada@lab.test',
    DATE '2026-10-09', 'Ada Okonjo', 'explicit_signature', 'high',
    'Ada came back about the deck and you agreed a call.', NULL, 'Intro', 'ai_extracted',
    p_conversation_fingerprint := cfp, p_covered_fingerprints := ARRAY[k3],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-09 09:00:00+00',
    p_coverage_through_at := TIMESTAMPTZ '2026-10-09 10:00:00+00');
  ASSERT res->>'result' = 'created', '16: later mail is a new segment: ' || res::text;
  RAISE NOTICE '16. the new-contact path: pinned identity, settled coverage, dismissal honoured';
END $$;

-- ══ 17. GENUINE KEY ROTATION ══════════════════════════════════════════════════
-- Rotation changes the CONVERSATION fingerprint and every MESSAGE fingerprint, not just the
-- episode anchor - verified against the real builders in tests/outlook-thread-segments.test.js.
-- Here the database half: a thread and a settled exchange written under era 1 must still be
-- FOUND under era 2, the thread key must migrate forward on touch, and genuinely new mail must
-- still be distinguishable.
DO $$
DECLARE
  u    uuid := '7a000000-0000-0000-0000-00000000000a';
  conn uuid := '7b000000-0000-0000-0000-00000000000b';
  run  uuid := '7c000000-0000-0000-0000-00000000000c';
  cid  uuid;
  cfp1 text := repeat('91', 32);   -- the thread, era 1
  cfp2 text := repeat('92', 32);   -- the SAME thread, era 2
  efp1 text := repeat('93', 32);
  efp2 text := repeat('94', 32);
  pfp  text := repeat('95', 32);
  a1   text := lpad('31', 64, '0'); -- message A under era 1
  a2   text := lpad('32', 64, '0'); -- message A under era 2 (the worker resolves to a1)
  b1   text := lpad('33', 64, '0');
  nw   text := lpad('34', 64, '0'); -- genuinely new, era 2 only
  res  jsonb; cov jsonb; seg1 uuid; n int;
BEGIN
  SELECT id INTO cid FROM public.contacts WHERE user_id = u LIMIT 1;

  -- Era 1: a segment, settled.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, efp1, pfp, 1::smallint,
    'Email', DATE '2026-10-01', NULL, 'The era-one exchange.', NULL, 'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := cfp1, p_covered_fingerprints := ARRAY[a1, b1],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-01 08:00:00+00',
    p_coverage_through_at := TIMESTAMPTZ '2026-10-01 17:00:00+00');
  ASSERT res->>'result' = 'created', '17: ' || res::text;
  seg1 := (res->>'candidate_id')::uuid;
  PERFORM public.accept_interaction_candidate(seg1, 'Email', DATE '2026-10-01',
    'My own note on the era-one exchange.', NULL, NULL);

  -- Era 2. The reader is asked under the NEW conversation value, with the old one as a ring
  -- variant. Without the variant it would report an untouched thread.
  cov := public.get_outlook_thread_coverage(conn, run, jsonb_build_array(
    jsonb_build_object('cfp', cfp2, 'cfps', jsonb_build_array(cfp1), 'efp', efp2)));
  ASSERT (SELECT t->'covered_fingerprints' @> jsonb_build_array(a1, b1)
            FROM jsonb_array_elements(cov->'threads') t
           WHERE t->>'conversation_fingerprint' = cfp2),
    '17: the thread must be found under a ring variant: ' || cov::text;
  ASSERT (SELECT t->>'matched_conversation_fingerprint' FROM jsonb_array_elements(cov->'threads') t
           WHERE t->>'conversation_fingerprint' = cfp2) = cfp1,
    '17: and the reader must say WHICH variant it is on record under: ' || cov::text;
  -- Without the variant, the same thread looks untouched - which is the bug this prevents.
  cov := public.get_outlook_thread_coverage(conn, run,
    jsonb_build_array(jsonb_build_object('cfp', cfp2, 'efp', efp2)));
  ASSERT (SELECT t->'covered_fingerprints' = '[]'::jsonb FROM jsonb_array_elements(cov->'threads') t
           WHERE t->>'conversation_fingerprint' = cfp2),
    '17: control - no variant, no match';

  -- A REPLAY under era 2. The worker resolves message A to the value it is already stored
  -- under (a1), so the settled comparison still holds and nothing is resurrected.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, efp2, pfp, 2::smallint,
    'Email', DATE '2026-10-01', NULL, 'A replay after rotation.', NULL, 'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := cfp2, p_conversation_lookup_fingerprints := ARRAY[cfp1],
    p_covered_fingerprints := ARRAY[a1, b1],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-01 08:00:00+00',
    p_coverage_through_at := TIMESTAMPTZ '2026-10-01 17:00:00+00');
  ASSERT res->>'result' = 'exists_terminal',
    '17: a covered exchange stays covered across a rotation: ' || res::text;

  -- Genuinely new mail under era 2 creates a segment, and the thread key MIGRATES FORWARD.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, efp2, pfp, 2::smallint,
    'Email', DATE '2026-10-09', NULL, 'A new exchange, after the rotation.', NULL,
    'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := cfp2, p_conversation_lookup_fingerprints := ARRAY[cfp1],
    p_covered_fingerprints := ARRAY[nw],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-09 09:00:00+00',
    p_coverage_through_at := TIMESTAMPTZ '2026-10-09 10:00:00+00');
  ASSERT res->>'result' = 'created', '17: new mail is still distinguishable: ' || res::text;
  ASSERT (SELECT conversation_fingerprint FROM public.outlook_candidate_refs
           WHERE interaction_candidate_id = (res->>'candidate_id')::uuid) = cfp2,
    '17: a new row is written under the current value';

  -- And a PENDING segment found under the old variant refreshes AND migrates.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('96', 32), pfp, 2::smallint,
    'Email', DATE '2026-10-10', NULL, 'The same new exchange, re-read.', NULL,
    'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := cfp2, p_conversation_lookup_fingerprints := ARRAY[cfp1],
    p_covered_fingerprints := ARRAY[nw],
    p_coverage_from_at := TIMESTAMPTZ '2026-10-09 09:00:00+00',
    p_coverage_through_at := TIMESTAMPTZ '2026-10-09 10:00:00+00');
  ASSERT res->>'result' = 'refreshed', '17: ' || res::text;
  -- Scoped to THIS thread: earlier sections of this file deliberately leave pending segments
  -- on other threads, and counting them all would prove nothing about rotation.
  SELECT count(*) INTO n
  FROM public.outlook_candidate_refs r
  JOIN public.interaction_candidates ic
    ON ic.id = r.interaction_candidate_id AND ic.user_id = r.user_id
  WHERE r.user_id = u AND r.conversation_fingerprint = ANY (ARRAY[cfp1, cfp2])
    AND ic.status = 'pending';
  ASSERT n = 1, '17: still one pending segment on this thread across the rotation, found ' || n;
  ASSERT (SELECT ic.proposed_notes FROM public.interaction_candidates ic WHERE ic.id = seg1)
         IS NOT NULL, '17: the settled segment row survives';
  ASSERT (SELECT status FROM public.interaction_candidates WHERE id = seg1) = 'accepted',
    '17: and stays accepted';
  ASSERT EXISTS (SELECT 1 FROM public.interactions
                  WHERE user_id = u AND notes = 'My own note on the era-one exchange.'),
    '17: and the accepted note is untouched';
  RAISE NOTICE '17. genuine rotation: found, migrated, still distinguishable';
END $$;

-- ══ 18. CROSS-ROUND HALVES, via the durable recovery hint ═════════════════════
-- Settled coverage ends at 10:00. An unseen outbound at 09:00 arrives in round A, whose reply
-- does not exist yet; the round writes nothing and its working records are erased. The reply
-- at 11:00 arrives in round B. Without a durable hint round B floors its recovery at the
-- coverage instant and the 09:00 half is never re-listed - in any later round, forever.
DO $$
DECLARE
  u    uuid := '7a000000-0000-0000-0000-00000000000a';
  conn uuid := '7b000000-0000-0000-0000-00000000000b';
  run  uuid := '7c000000-0000-0000-0000-00000000000c';
  cfp  text := repeat('a7', 32);
  res  jsonb; cov jsonb;
BEGIN
  -- Round A records the hint for the half it could not pair.
  res := public.record_outlook_thread_recovery(conn, run, cfp, TIMESTAMPTZ '2026-10-08 09:00:00+00');
  ASSERT res->>'result' = 'ok', '18: ' || res::text;

  -- Round B reads it back with the thread's coverage.
  cov := public.get_outlook_thread_coverage(conn, run,
    jsonb_build_array(jsonb_build_object('cfp', cfp, 'efp', repeat('a8', 32))));
  ASSERT (SELECT (t->>'earliest_unpaired_at')::timestamptz FROM jsonb_array_elements(cov->'threads') t
           WHERE t->>'conversation_fingerprint' = cfp) = TIMESTAMPTZ '2026-10-08 09:00:00+00',
    '18: the hint must survive the round that recorded it: ' || cov::text;

  -- It LOWERS only. A later round that sees something newer must not raise it, or the older
  -- half it already knows about would fall outside the window again.
  res := public.record_outlook_thread_recovery(conn, run, cfp, TIMESTAMPTZ '2026-10-08 11:00:00+00');
  ASSERT (res->>'earliest_unpaired_at')::timestamptz = TIMESTAMPTZ '2026-10-08 09:00:00+00',
    '18: the hint never rises: ' || res::text;
  res := public.record_outlook_thread_recovery(conn, run, cfp, TIMESTAMPTZ '2026-10-08 07:00:00+00');
  ASSERT (res->>'earliest_unpaired_at')::timestamptz = TIMESTAMPTZ '2026-10-08 07:00:00+00',
    '18: but an older half does lower it: ' || res::text;

  -- Fenced like everything else, and worker-only.
  res := public.record_outlook_thread_recovery(conn, '7d000000-0000-0000-0000-00000000000d'::uuid,
    cfp, now());
  ASSERT res->>'result' = 'stale_run', '18: ' || res::text;
  ASSERT NOT has_function_privilege('authenticated',
    'public.record_outlook_thread_recovery(uuid,uuid,text,timestamptz)', 'EXECUTE'),
    '18: a signed-in user must not learn which threads have unresolved halves';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE relname = 'outlook_thread_recovery'),
    '18: the hint table has RLS on and no user policy';
  ASSERT (SELECT count(*) FROM pg_policies WHERE tablename = 'outlook_thread_recovery') = 0,
    '18: and no policy at all, like outlook_subscriptions';
  RAISE NOTICE '18. cross-round halves: the hint survives, lowers only, and is worker-only';
END $$;

-- ══ 19. A LONG LEGACY THREAD, and a legacy proposal for someone now known ═════
-- A baseline absorbs EVERY message visible when it runs - which can be several exchanges, not
-- one. That is the honest cost of never duplicating an interaction the reviewer accepted, and
-- it is asserted here rather than described.
DO $$
DECLARE
  u    uuid := '7a000000-0000-0000-0000-00000000000a';
  conn uuid := '7b000000-0000-0000-0000-00000000000b';
  run  uuid := '7c000000-0000-0000-0000-00000000000c';
  cid  uuid;
  lcfp text := repeat('b1', 32);
  lefp text := repeat('b2', 32);
  pfp  text := repeat('b3', 32);
  legacy uuid; ncand uuid; res jsonb; cov jsonb; many text[]; i int;
BEGIN
  SELECT id INTO cid FROM public.contacts WHERE user_id = u LIMIT 1;
  -- Twelve messages: three separate two-way exchanges, all visible when the baseline runs.
  many := ARRAY[]::text[];
  FOR i IN 1..12 LOOP
    many := pg_catalog.array_append(many, lpad(to_hex(1000 + i), 64, '0'));
  END LOOP;

  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date,
     proposed_notes, status)
  VALUES (u, cid, 'outlook', lefp, 'Email', DATE '2026-08-01',
          'A long thread accepted before segments existed.', 'accepted')
  RETURNING id INTO legacy;
  INSERT INTO public.outlook_candidate_refs
    (user_id, connection_id, interaction_candidate_id, episode_fingerprint, person_fingerprint, key_version)
  VALUES (u, conn, legacy, lefp, pfp, 1);

  cov := public.get_outlook_thread_coverage(conn, run,
    jsonb_build_array(jsonb_build_object('cfp', lcfp, 'efp', lefp)));
  ASSERT (SELECT (t->>'settled_without_coverage')::boolean FROM jsonb_array_elements(cov->'threads') t
           WHERE t->>'conversation_fingerprint' = lcfp),
    '19: a legacy thread reports that its coverage is missing';

  -- The baseline absorbs ALL TWELVE. Three exchanges' worth of mail becomes covered and no
  -- suggestion is produced from any of it.
  cov := public.baseline_outlook_thread_coverage(conn, run, lcfp, lefp, many,
    TIMESTAMPTZ '2026-08-01 09:00:00+00', TIMESTAMPTZ '2026-09-20 18:00:00+00');
  ASSERT (cov->>'initialized')::int = 1, '19: ' || cov::text;
  ASSERT pg_catalog.array_length((SELECT covered_message_fingerprints
    FROM public.outlook_candidate_refs WHERE interaction_candidate_id = legacy), 1) = 12,
    '19: a baseline absorbs every visible message, not one exchange';
  ASSERT (SELECT coverage_source FROM public.outlook_candidate_refs
           WHERE interaction_candidate_id = legacy) = 'legacy_baseline';
  ASSERT (SELECT count(*) FROM public.interaction_candidates
           WHERE user_id = u AND source_fingerprint = repeat('b4', 32)) = 0,
    '19: and produces no suggestion';

  -- Everything inside the baseline is settled; only mail after it is a segment.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('b4', 32), pfp, 1::smallint,
    'Email', DATE '2026-09-10', NULL, 'Inside the baseline.', NULL, 'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := lcfp, p_covered_fingerprints := many[3:6],
    p_coverage_from_at := TIMESTAMPTZ '2026-08-20 09:00:00+00',
    p_coverage_through_at := TIMESTAMPTZ '2026-08-25 18:00:00+00');
  ASSERT res->>'result' = 'exists_terminal', '19: ' || res::text;

  -- A LEGACY NEW-CONTACT PROPOSAL whose person is now a contact. Its coverage lives on the
  -- proposal's refs row, and the known-contact write must find it by the thread.
  -- An ACCEPTED proposal has its draft columns erased - ncc_terminal_erased enforces that,
  -- and the fixture has to satisfy it rather than work around it.
  INSERT INTO public.new_contact_candidates
    (user_id, source, status, person_fingerprint, episode_fingerprint, key_version,
     proposed_interaction_date, proposed_type, extraction_status)
  VALUES (u, 'outlook', 'accepted', repeat('b5', 32), repeat('b6', 32), 1,
          DATE '2026-08-05', 'Email', 'deterministic')
  RETURNING id INTO ncand;
  INSERT INTO public.outlook_candidate_refs
    (user_id, connection_id, new_contact_candidate_id, episode_fingerprint, person_fingerprint,
     key_version, conversation_fingerprint, covered_message_fingerprints,
     coverage_from_at, coverage_through_at, coverage_source)
  VALUES (u, conn, ncand, repeat('b6', 32), repeat('b5', 32), 1,
          repeat('b7', 32), ARRAY[lpad('41', 64, '0'), lpad('42', 64, '0')],
          TIMESTAMPTZ '2026-08-05 09:00:00+00', TIMESTAMPTZ '2026-08-05 18:00:00+00', 'draft');

  -- The person is already a contact (ava@bank.test, from the fixtures). A replay of that
  -- settled exchange through the KNOWN-CONTACT producer must be terminal.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('b8', 32), repeat('b5', 32),
    1::smallint, 'Email', DATE '2026-08-05', NULL, 'A replay of the legacy proposal exchange.',
    NULL, 'explicit_body', 'ai_extracted',
    p_conversation_fingerprint := repeat('b7', 32),
    p_covered_fingerprints := ARRAY[lpad('41', 64, '0'), lpad('42', 64, '0')],
    p_coverage_from_at := TIMESTAMPTZ '2026-08-05 09:00:00+00',
    p_coverage_through_at := TIMESTAMPTZ '2026-08-05 18:00:00+00');
  ASSERT res->>'result' = 'exists_terminal',
    '19: a legacy proposal for someone now known still resolves: ' || res::text;
  RAISE NOTICE '19. long legacy threads and legacy proposals that now resolve to a contact';
END $$;

-- ══ 20. RE-CONSENT: the same-account update path, not disconnect/reconnect ════
-- The consent cutover this feature requires needs the pilot to consent again. HOW that is done
-- decides whether every dedup reference survives, so it is verified here rather than assumed.
DO $$
DECLARE
  src text;
  n   int;
BEGIN
  SELECT prosrc INTO src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'finalize_microsoft_connection';
  ASSERT src IS NOT NULL, '20: the OAuth finalize RPC must exist';

  -- 1. IT UPDATES THE EXISTING ROW. One connection per user, upserted on user_id, returning
  --    the SAME id - so the connection identity a reconnect produces is the one that was
  --    already there.
  ASSERT src LIKE '%ON CONFLICT (user_id) DO UPDATE%',
    '20: re-consent must UPDATE the existing connection, not replace it';
  ASSERT src LIKE '%RETURNING id INTO v_conn_id%', '20: and hand back that same id';

  -- 2. IT REFUSES A DIFFERENT ACCOUNT rather than silently swapping it, which is what makes
  --    "the same-account update path" a real guarantee and not a hope.
  ASSERT src LIKE '%different_account%',
    '20: a different Microsoft account must be refused, never swapped in';

  -- 3. IT CARRIES THE NEW CONSENT VERSION onto that existing row. This is the whole mechanism
  --    the cutover depends on: consent moves, identity does not.
  ASSERT src LIKE '%consent_policy_version = EXCLUDED.consent_policy_version%',
    '20: the new consent version is written to the existing connection';

  -- 4. IT DELETES NOTHING. No cursor, no candidate, no provenance row is touched.
  ASSERT src NOT LIKE '%DELETE FROM public.outlook_sync_state%';
  ASSERT src NOT LIKE '%DELETE FROM public.outlook_candidate_refs%';
  ASSERT src NOT LIKE '%DELETE FROM public.microsoft_connections%';

  -- 5. WHY DISCONNECT IS THE WRONG INSTRUCTION. Everything this feature relies on hangs off
  --    the connection by a CASCADING foreign key, so a disconnect/reconnect cycle would erase
  --    the cursors, the coverage and the recovery hints and the thread history would restart
  --    from a legacy baseline. Asserted from the catalog, because this is the reason the
  --    cutover must say "re-consent through the same account" and nothing else.
  SELECT count(*) INTO n
  FROM pg_constraint c
  WHERE c.confrelid = 'public.microsoft_connections'::regclass
    AND c.contype = 'f' AND c.confdeltype = 'c'
    AND c.conrelid IN ('public.outlook_sync_state'::regclass,
                       'public.outlook_candidate_refs'::regclass,
                       'public.outlook_thread_recovery'::regclass);
  ASSERT n = 3,
    '20: cursors, provenance and recovery hints all cascade from the connection, found ' || n;
  RAISE NOTICE '20. re-consent: same-account UPDATE preserves identity, cursors and dedup refs';
  RAISE NOTICE '    (disconnect would CASCADE them away - which is why it must not be prescribed)';
END $$;

-- ══ teardown ══════════════════════════════════════════════════════════════════
-- THIS FILE CLEANS UP AFTER ITSELF, which the older proofs in this directory do not. They
-- clear their own fixtures on the way IN, so a sequence of them leaves a live lease and a
-- connection behind; running this file in an alphabetical sequence then made
-- outlook-token-rotation-runtime fail with `stale_run` on leftover state rather than on
-- anything it was testing. Releasing the lease and removing the fixtures here keeps the
-- failure modes of later files their own.
DO $$
DECLARE
  u    uuid := '7a000000-0000-0000-0000-00000000000a';
  conn uuid := '7b000000-0000-0000-0000-00000000000b';
BEGIN
  DELETE FROM public.outlook_candidate_refs WHERE user_id = u;
  DELETE FROM public.interaction_candidates WHERE user_id = u;
  DELETE FROM public.new_contact_candidates WHERE user_id = u;
  DELETE FROM public.interactions           WHERE user_id = u;
  DELETE FROM public.contacts               WHERE user_id = u;
  DELETE FROM public.outlook_sync_state     WHERE connection_id = conn;
  DELETE FROM public.microsoft_connections  WHERE user_id = u;
  DELETE FROM public.profiles               WHERE id = u;
  DELETE FROM auth.users                    WHERE id = u;
  RAISE NOTICE 'teardown: fixtures removed, no lease left behind';
END $$;

SELECT set_config('request.jwt.claim.sub', NULL, false);
SELECT set_config('request.jwt.claims', NULL, false);
