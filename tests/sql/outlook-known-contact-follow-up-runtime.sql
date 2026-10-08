-- THE KNOWN-CONTACT NEXT STEP, proven against a real Postgres with every migration
-- applied - including the UNAPPLIED 20261008000000, which this file exercises.
--
-- WHAT IS PROVEN HERE, by executing the real functions rather than reading them:
--
--   1. THE OLD ARGUMENT SHAPE STILL WORKS. The 10-argument call the deployed worker
--      makes creates a candidate exactly as the applied definition does, with every
--      draft column NULL.
--   2. THE NEW FIELDS PERSIST. The 13-argument call stores the note, the next step, the
--      evidence paired with a draft_summary, and the provenance.
--   3. A NEW SUCCESSFUL DRAFT REPLACES THE STEP - and CLEARS it when the new draft has
--      none. The row never pairs one draft's summary with another's step.
--   4. A METADATA-ONLY REFRESH PRESERVES the drafted context, all of it.
--   5. INVALID VALUES ARE REFUSED with controlled codes, not trimmed and not thrown: an
--      over-long step, a step carrying a URL, a step without a note, evidence outside
--      the pair, evidence without a note, a note with a URL beside evidence, a bad
--      extraction status.
--   6. A STALE LEASE IS REFUSED for the new shape as for the old.
--   7. EXACTLY ONE OVERLOAD of each changed function exists, with the intended grants:
--      the producer is service_role-only, the accept RPC is authenticated-only.
--   8. ACCEPTANCE SAVES THE REVIEWER'S APPROVED VALUES ONCE: the edited step inside the
--      note, the chosen date in follow_up_date; a cleared step saves the note alone;
--      the 4-argument call still works; a second accept is idempotent; the candidate's
--      draft columns are erased.
--   9. ONE IDENTITY FOR A CONTINUING EXCHANGE. The worker writes a continuing thread under
--      the SAME episode fingerprint in every round (outlookImportRun.js completes a delta
--      round's thread from Outlook before writing). The producer then REFRESHES the one
--      pending row; a key-rotation variant of the anchor (a lookup fingerprint) finds the
--      same row; after the reviewer decides, a repeat is exists_terminal and resurrects
--      nothing; and a DIFFERENT thread with the same person is created.
--
-- HOW TO BUILD THE DATABASE THIS NEEDS: tests/sql/_bootstrap-disposable-db.sql, then
-- every migration in supabase/migrations, in filename order.
--
-- WHAT THIS DOES NOT PROVE. It runs as the privileged `postgres` role, so it proves the
-- function bodies, the constraints and the catalog - not RLS or PostgREST. The accept
-- RPC reads auth.uid(), so this file sets BOTH claim forms to impersonate the owner,
-- which is the mechanism PostgREST uses but not a proof that a real session maps to
-- it. It says nothing about PRODUCTION, where 20261008000000 is UNAPPLIED.
\set ON_ERROR_STOP on

-- ══ fixtures ═══════════════════════════════════════════════════════════════
DO $$
DECLARE
  u    uuid := '44444444-4444-4444-4444-444444444444';
  conn uuid := '55555555-5555-5555-5555-555555555555';
  run  uuid := '66666666-6666-6666-6666-666666666666';
BEGIN
  DELETE FROM public.outlook_candidate_refs    WHERE user_id = u;
  DELETE FROM public.interaction_candidates    WHERE user_id = u;
  DELETE FROM public.interactions              WHERE user_id = u;
  DELETE FROM public.contacts                  WHERE user_id = u;
  DELETE FROM public.outlook_sync_state        WHERE connection_id = conn;
  DELETE FROM public.microsoft_connections     WHERE user_id = u;
  INSERT INTO auth.users (id, email) VALUES (u, 'follow-up@getfunnl.test') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, email) VALUES (u, 'follow-up@getfunnl.test') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.microsoft_connections
    (id, user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, needs_reauth, consented_at, consent_policy_version)
  VALUES
    (conn, u, 'acct-fu', '9188040d-6c67-4c5b-b112-36a304b66dad', 'personal',
     'followup@outlook.test', ARRAY['Mail.Read','User.Read','offline_access'],
     'active', false, now(), 'ol-disc-e3e2b1714b453c2904e3ed08cb232097');
  -- BOTH folder rows leased to the same live run: the fence the producer checks.
  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, sync_run_id, sync_lease_until,
     run_started_at, last_attempt_at, updated_at)
  VALUES
    (conn, u, 'inbox',     'running', run, now() + interval '7 minutes', now(), now(), now()),
    (conn, u, 'sentitems', 'running', run, now() + interval '7 minutes', now(), now(), now());
  INSERT INTO public.contacts (user_id, name, email) VALUES (u, 'Ava Recruiter', 'ava@bank.test');
END $$;

-- ══ 7. the catalog: one overload each, the intended grants ═══════════════════
DO $$
DECLARE n int; a int;
BEGIN
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'upsert_outlook_interaction_candidate';
  ASSERT n = 1, 'exactly ONE upsert_outlook_interaction_candidate must exist, found ' || n;
  SELECT pronargs INTO a FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'upsert_outlook_interaction_candidate';
  ASSERT a = 13, 'the producer takes 13 arguments, found ' || a;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'accept_interaction_candidate';
  ASSERT n = 1, 'exactly ONE accept_interaction_candidate must exist, found ' || n;
  SELECT pronargs INTO a FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'accept_interaction_candidate';
  ASSERT a = 6, 'the accept RPC takes 6 arguments, found ' || a;
  ASSERT has_function_privilege('service_role',
    'public.upsert_outlook_interaction_candidate(uuid,uuid,uuid,text,text,smallint,text,date,text[],text,text,text,text)', 'EXECUTE'),
    'the producer must be executable by service_role';
  ASSERT NOT has_function_privilege('authenticated',
    'public.upsert_outlook_interaction_candidate(uuid,uuid,uuid,text,text,smallint,text,date,text[],text,text,text,text)', 'EXECUTE'),
    'the producer must NOT be executable by authenticated';
  ASSERT NOT has_function_privilege('anon',
    'public.upsert_outlook_interaction_candidate(uuid,uuid,uuid,text,text,smallint,text,date,text[],text,text,text,text)', 'EXECUTE'),
    'the producer must NOT be executable by anon';
  ASSERT has_function_privilege('authenticated',
    'public.accept_interaction_candidate(uuid,text,date,text,text,date)', 'EXECUTE'),
    'the accept RPC must be executable by authenticated';
  ASSERT NOT has_function_privilege('anon',
    'public.accept_interaction_candidate(uuid,text,date,text,text,date)', 'EXECUTE'),
    'the accept RPC must NOT be executable by anon';
  ASSERT (SELECT prosecdef FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
           WHERE ns.nspname = 'public' AND p.proname = 'upsert_outlook_interaction_candidate'),
    'the producer stays SECURITY DEFINER';
  ASSERT (SELECT prosecdef FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
           WHERE ns.nspname = 'public' AND p.proname = 'accept_interaction_candidate'),
    'the accept RPC stays SECURITY DEFINER';
END $$;

-- ══ 1. the OLD argument shape: the deployed worker's call ════════════════════
DO $$
DECLARE
  u uuid := '44444444-4444-4444-4444-444444444444'; conn uuid := '55555555-5555-5555-5555-555555555555';
  run uuid := '66666666-6666-6666-6666-666666666666'; cid uuid; res jsonb; r public.interaction_candidates%ROWTYPE;
BEGIN
  SELECT id INTO cid FROM public.contacts WHERE user_id = u AND email = 'ava@bank.test';
  res := public.upsert_outlook_interaction_candidate(
    conn, run, cid, repeat('1', 64), repeat('2', 64), 1::smallint, 'Email', DATE '2026-10-01', NULL,
    'She put your name forward for the insight week and asked for a short call about credit.');
  ASSERT res->>'result' = 'created', 'the 10-argument call must still create: ' || res::text;
  SELECT * INTO r FROM public.interaction_candidates WHERE id = (res->>'candidate_id')::uuid;
  ASSERT r.proposed_notes LIKE 'She put your name forward%', 'the note is stored';
  ASSERT r.draft_follow_up IS NULL AND r.draft_summary IS NULL AND r.summary_evidence IS NULL AND r.extraction_status IS NULL,
    'the old shape leaves every draft column NULL - byte-for-byte the applied behaviour';
  ASSERT r.status = 'pending';
  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u) = 0, 'NO interaction before acceptance';
END $$;

-- ══ 2. the NEW fields persist ════════════════════════════════════════════════
DO $$
DECLARE
  u uuid := '44444444-4444-4444-4444-444444444444'; conn uuid := '55555555-5555-5555-5555-555555555555';
  run uuid := '66666666-6666-6666-6666-666666666666'; cid uuid; res jsonb; r public.interaction_candidates%ROWTYPE;
BEGIN
  SELECT id INTO cid FROM public.contacts WHERE user_id = u AND email = 'ava@bank.test';
  res := public.upsert_outlook_interaction_candidate(
    conn, run, cid, repeat('3', 64), repeat('4', 64), 1::smallint, 'Email', DATE '2026-10-02', NULL,
    'They offered a short call next week about the credit desk.',
    'Send your availability for next week.', 'explicit_body', 'ai_extracted');
  ASSERT res->>'result' = 'created', 'the 13-argument call must create: ' || res::text;
  SELECT * INTO r FROM public.interaction_candidates WHERE id = (res->>'candidate_id')::uuid;
  ASSERT r.proposed_notes = 'They offered a short call next week about the credit desk.';
  ASSERT r.draft_follow_up = 'Send your availability for next week.', 'THE NEXT STEP IS STORED - this was the omission';
  ASSERT r.draft_summary = r.proposed_notes, 'draft_summary carries the same text when evidence is supplied';
  ASSERT r.summary_evidence = 'explicit_body', 'the evidence is stored';
  ASSERT r.extraction_status = 'ai_extracted', 'the provenance is stored';
  ASSERT (SELECT count(*) FROM public.outlook_candidate_refs WHERE user_id = u) = 2, 'one provenance ref per candidate';
END $$;

-- ══ 3. a NEW successful draft replaces the step; with no step it CLEARS it ═══
DO $$
DECLARE
  u uuid := '44444444-4444-4444-4444-444444444444'; conn uuid := '55555555-5555-5555-5555-555555555555';
  run uuid := '66666666-6666-6666-6666-666666666666'; cid uuid; res jsonb; r public.interaction_candidates%ROWTYPE;
BEGIN
  SELECT id INTO cid FROM public.contacts WHERE user_id = u AND email = 'ava@bank.test';
  -- A new draft WITH a different step replaces the step.
  res := public.upsert_outlook_interaction_candidate(
    conn, run, cid, repeat('3', 64), repeat('4', 64), 1::smallint, 'Email', DATE '2026-10-03', NULL,
    'They confirmed Thursday at three for the call about the credit desk.',
    'Prepare three questions about the desk before Thursday.', 'explicit_body', 'ai_extracted');
  ASSERT res->>'result' = 'refreshed', 'same episode refreshes: ' || res::text;
  SELECT * INTO r FROM public.interaction_candidates WHERE id = (res->>'candidate_id')::uuid;
  ASSERT r.draft_follow_up = 'Prepare three questions about the desk before Thursday.', 'the step is REPLACED';
  ASSERT r.proposed_notes LIKE 'They confirmed Thursday%' AND r.draft_summary = r.proposed_notes, 'and the note with it';
  ASSERT r.proposed_interaction_date = DATE '2026-10-03';
  -- A new draft WITHOUT a step clears the obsolete one.
  res := public.upsert_outlook_interaction_candidate(
    conn, run, cid, repeat('3', 64), repeat('4', 64), 1::smallint, 'Email', DATE '2026-10-04', NULL,
    'They thanked you for the questions and said they will be in touch.',
    NULL, 'explicit_body', 'ai_extracted');
  ASSERT res->>'result' = 'refreshed';
  SELECT * INTO r FROM public.interaction_candidates WHERE id = (res->>'candidate_id')::uuid;
  ASSERT r.draft_follow_up IS NULL, 'A NEW DRAFT WITH NO NEXT STEP MUST CLEAR THE OLD ONE - a COALESCE kept it';
  ASSERT r.proposed_notes LIKE 'They thanked you%' AND r.draft_summary = r.proposed_notes AND r.summary_evidence = 'explicit_body',
    'summary and evidence belong to the same draft';
  ASSERT r.extraction_status = 'ai_extracted';
END $$;

-- ══ 4. a METADATA-ONLY refresh preserves the drafted context ═════════════════
DO $$
DECLARE
  u uuid := '44444444-4444-4444-4444-444444444444'; conn uuid := '55555555-5555-5555-5555-555555555555';
  run uuid := '66666666-6666-6666-6666-666666666666'; cid uuid; res jsonb; r public.interaction_candidates%ROWTYPE;
BEGIN
  SELECT id INTO cid FROM public.contacts WHERE user_id = u AND email = 'ava@bank.test';
  -- Put a full draft back first.
  res := public.upsert_outlook_interaction_candidate(
    conn, run, cid, repeat('3', 64), repeat('4', 64), 1::smallint, 'Email', DATE '2026-10-04', NULL,
    'They thanked you for the questions and said they will be in touch.',
    'Follow up if nothing arrives by the end of the week.', 'subject_only', 'ai_extracted');
  ASSERT res->>'result' = 'refreshed';
  -- The 10-argument shape (no content read) ...
  res := public.upsert_outlook_interaction_candidate(
    conn, run, cid, repeat('3', 64), repeat('4', 64), 1::smallint, 'Email', DATE '2026-10-05', NULL);
  ASSERT res->>'result' = 'refreshed', res::text;
  SELECT * INTO r FROM public.interaction_candidates WHERE id = (res->>'candidate_id')::uuid;
  ASSERT r.proposed_notes LIKE 'They thanked you%', 'the note is preserved';
  ASSERT r.draft_follow_up = 'Follow up if nothing arrives by the end of the week.', 'the step is preserved';
  ASSERT r.summary_evidence = 'subject_only' AND r.draft_summary = r.proposed_notes, 'the evidence pair is preserved';
  ASSERT r.extraction_status = 'ai_extracted', 'the provenance is preserved';
  ASSERT r.proposed_interaction_date = DATE '2026-10-05', 'the date still refreshes';
  -- ... and the 13-argument shape with every draft argument NULL (a closed gate) is the same.
  res := public.upsert_outlook_interaction_candidate(
    conn, run, cid, repeat('3', 64), repeat('4', 64), 1::smallint, 'Email', DATE '2026-10-06', NULL,
    NULL, NULL, NULL, NULL);
  ASSERT res->>'result' = 'refreshed';
  SELECT * INTO r FROM public.interaction_candidates WHERE id = (res->>'candidate_id')::uuid;
  ASSERT r.draft_follow_up = 'Follow up if nothing arrives by the end of the week.'
     AND r.summary_evidence = 'subject_only' AND r.extraction_status = 'ai_extracted' AND r.proposed_notes LIKE 'They thanked you%',
    'a no-content refresh preserves everything, whichever call shape made it';
END $$;

-- ══ 5. invalid values are refused with controlled codes ═════════════════════
DO $$
DECLARE
  u uuid := '44444444-4444-4444-4444-444444444444'; conn uuid := '55555555-5555-5555-5555-555555555555';
  run uuid := '66666666-6666-6666-6666-666666666666'; cid uuid; res jsonb; before int;
BEGIN
  SELECT id INTO cid FROM public.contacts WHERE user_id = u AND email = 'ava@bank.test';
  SELECT count(*) INTO before FROM public.interaction_candidates WHERE user_id = u;
  -- an over-long step
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('7', 64), repeat('8', 64), 1::smallint, 'Email', DATE '2026-10-01', NULL,
    'A note.', repeat('x', 161), 'explicit_body', 'ai_extracted');
  ASSERT res->>'result' = 'invalid_follow_up', 'over-long step: ' || res::text;
  -- a step carrying a URL
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('7', 64), repeat('8', 64), 1::smallint, 'Email', DATE '2026-10-01', NULL,
    'A note.', 'See https://example.invalid/x', 'explicit_body', 'ai_extracted');
  ASSERT res->>'result' = 'invalid_follow_up', 'URL in step: ' || res::text;
  -- a step without a note
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('7', 64), repeat('8', 64), 1::smallint, 'Email', DATE '2026-10-01', NULL,
    NULL, 'A step for nothing.', NULL, NULL);
  ASSERT res->>'result' = 'invalid_follow_up', 'step without note: ' || res::text;
  -- evidence outside the pair
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('7', 64), repeat('8', 64), 1::smallint, 'Email', DATE '2026-10-01', NULL,
    'A note.', NULL, 'guessed', 'ai_extracted');
  ASSERT res->>'result' = 'invalid_evidence', 'bad evidence: ' || res::text;
  -- evidence without a note
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('7', 64), repeat('8', 64), 1::smallint, 'Email', DATE '2026-10-01', NULL,
    NULL, NULL, 'explicit_body', NULL);
  ASSERT res->>'result' = 'invalid_evidence', 'evidence without note: ' || res::text;
  -- a note with a URL beside evidence (it would be stored as draft_summary, which forbids URLs)
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('7', 64), repeat('8', 64), 1::smallint, 'Email', DATE '2026-10-01', NULL,
    'Read www.example.invalid first.', NULL, 'explicit_body', 'ai_extracted');
  ASSERT res->>'result' = 'invalid_evidence', 'URL in note beside evidence: ' || res::text;
  -- a bad extraction status
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('7', 64), repeat('8', 64), 1::smallint, 'Email', DATE '2026-10-01', NULL,
    'A note.', NULL, NULL, 'guessed');
  ASSERT res->>'result' = 'invalid_extraction_status', 'bad extraction status: ' || res::text;
  -- an over-long note is still refused as before
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('7', 64), repeat('8', 64), 1::smallint, 'Email', DATE '2026-10-01', NULL,
    repeat('y', 201), NULL, NULL, NULL);
  ASSERT res->>'result' = 'invalid_notes', 'over-long note: ' || res::text;
  ASSERT (SELECT count(*) FROM public.interaction_candidates WHERE user_id = u) = before, 'a refused write stores nothing';
END $$;

-- ══ 6. a stale lease is refused, for the new shape as for the old ════════════
DO $$
DECLARE
  u uuid := '44444444-4444-4444-4444-444444444444'; conn uuid := '55555555-5555-5555-5555-555555555555';
  other uuid := '77777777-7777-7777-7777-777777777777'; cid uuid; res jsonb;
BEGIN
  SELECT id INTO cid FROM public.contacts WHERE user_id = u AND email = 'ava@bank.test';
  res := public.upsert_outlook_interaction_candidate(conn, other, cid, repeat('9', 64), repeat('a', 64), 1::smallint, 'Email', DATE '2026-10-01', NULL,
    'A note.', 'A step.', 'explicit_body', 'ai_extracted');
  ASSERT res->>'result' = 'stale_run', 'a run that does not hold the lease must be refused: ' || res::text;
  res := public.upsert_outlook_interaction_candidate(conn, other, cid, repeat('9', 64), repeat('a', 64), 1::smallint, 'Email', DATE '2026-10-01', NULL, 'A note.');
  ASSERT res->>'result' = 'stale_run', 'and for the old shape too: ' || res::text;
END $$;

-- ══ 8. acceptance saves the reviewer's approved values, once ═════════════════
-- BOTH claim forms are set on purpose: the disposable image's auth.uid() reads the
-- singular `request.jwt.claim.sub`; PostgREST v14 in Production sets the JSON form.
SELECT set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);
SELECT set_config('request.jwt.claims', json_build_object('sub', '44444444-4444-4444-4444-444444444444')::text, false);

DO $$
DECLARE
  u uuid := '44444444-4444-4444-4444-444444444444'; cand uuid; res jsonb; iid uuid;
  saved public.interactions%ROWTYPE; row public.interaction_candidates%ROWTYPE;
  NL text := pg_catalog.chr(10);
BEGIN
  -- The candidate from section 4 carries a drafted step. The reviewer EDITS it and picks a date.
  SELECT id INTO cand FROM public.interaction_candidates WHERE user_id = u AND source_fingerprint = repeat('3', 64);
  res := public.accept_interaction_candidate(cand, 'Email', DATE '2026-10-06', 'They thanked you for the questions.',
    'Chase them on Friday if nothing has arrived.', DATE '2026-10-10');
  ASSERT res->>'result' = 'accepted', 'accept with an edited step and a chosen date: ' || res::text;
  iid := (res->>'interaction_id')::uuid;
  SELECT * INTO saved FROM public.interactions WHERE id = iid;
  ASSERT saved.notes = 'They thanked you for the questions.' || NL || NL || 'Next step: Chase them on Friday if nothing has arrived.',
    'the EDITED step is saved inside the note, after a blank line: ' || saved.notes;
  ASSERT saved.follow_up_date = DATE '2026-10-10', 'the CHOSEN date is saved';
  ASSERT saved.type = 'Email' AND saved.interaction_date = DATE '2026-10-06' AND saved.source = 'outlook';
  SELECT * INTO row FROM public.interaction_candidates WHERE id = cand;
  ASSERT row.status = 'accepted' AND row.interaction_id = iid;
  ASSERT row.draft_follow_up IS NULL AND row.draft_summary IS NULL AND row.summary_evidence IS NULL,
    'the draft columns are erased at acceptance (terminal_draft_erased)';
  -- ONCE: a second accept is idempotent and creates nothing.
  res := public.accept_interaction_candidate(cand, 'Email', DATE '2026-10-06', 'x', 'y', DATE '2026-10-11');
  ASSERT res->>'result' = 'already_accepted', 'idempotent: ' || res::text;
  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u) = 1, 'exactly one interaction';
  ASSERT (SELECT notes FROM public.interactions WHERE id = iid) LIKE '%Chase them on Friday%', 'and the first approval stands';
END $$;

DO $$
DECLARE
  u uuid := '44444444-4444-4444-4444-444444444444'; cand uuid; res jsonb; saved public.interactions%ROWTYPE;
BEGIN
  -- The candidate from section 1 (no drafted step). The reviewer CLEARS the step and picks no date.
  SELECT id INTO cand FROM public.interaction_candidates WHERE user_id = u AND source_fingerprint = repeat('1', 64);
  res := public.accept_interaction_candidate(cand, NULL, NULL, NULL, NULL, NULL);
  ASSERT res->>'result' = 'accepted', 'accept with a cleared step: ' || res::text;
  SELECT * INTO saved FROM public.interactions WHERE id = (res->>'interaction_id')::uuid;
  ASSERT saved.notes LIKE 'She put your name forward%' AND saved.notes NOT LIKE '%Next step%', 'a cleared step saves the note alone';
  ASSERT saved.follow_up_date IS NULL, 'no date is invented';
  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u) = 2;
END $$;

DO $$
DECLARE
  u uuid := '44444444-4444-4444-4444-444444444444'; conn uuid := '55555555-5555-5555-5555-555555555555';
  run uuid := '66666666-6666-6666-6666-666666666666'; cid uuid; res jsonb; cand uuid; saved public.interactions%ROWTYPE;
BEGIN
  SELECT id INTO cid FROM public.contacts WHERE user_id = u AND email = 'ava@bank.test';
  -- A fresh candidate, then the 4-ARGUMENT accept call the browser makes today.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('b', 64), repeat('c', 64), 1::smallint, 'Email', DATE '2026-10-07', NULL,
    'A short note.', 'A step the old caller never sends.', 'explicit_body', 'ai_extracted');
  ASSERT res->>'result' = 'created';
  cand := (res->>'candidate_id')::uuid;
  res := public.accept_interaction_candidate(cand, 'Email', DATE '2026-10-07', 'A short note.');
  ASSERT res->>'result' = 'accepted', 'the 4-argument call still works: ' || res::text;
  SELECT * INTO saved FROM public.interactions WHERE id = (res->>'interaction_id')::uuid;
  ASSERT saved.notes = 'A short note.' AND saved.follow_up_date IS NULL,
    'the old call saves the note alone - the drafted step is never read back from the row';
  -- An over-long approved step is refused, and nothing is saved.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, repeat('d', 64), repeat('e', 64), 1::smallint, 'Email', DATE '2026-10-07', NULL,
    'Another note.', NULL, NULL, 'ai_extracted');
  cand := (res->>'candidate_id')::uuid;
  res := public.accept_interaction_candidate(cand, 'Email', DATE '2026-10-07', 'Another note.', repeat('z', 161), NULL);
  ASSERT res->>'result' = 'invalid_follow_up', 'an over-long approved step is refused: ' || res::text;
  ASSERT (SELECT status FROM public.interaction_candidates WHERE id = cand) = 'pending', 'and the candidate stays pending';
  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u) = 3, 'three accepted, nothing more';
END $$;

-- ══ 9. ONE identity for a continuing exchange: refresh, never a second proposal ═══
-- The claims from section 8 are still set: the accept call below reads auth.uid().
DO $$
DECLARE
  u uuid := '44444444-4444-4444-4444-444444444444'; conn uuid := '55555555-5555-5555-5555-555555555555';
  run uuid := '66666666-6666-6666-6666-666666666666'; cid uuid; res jsonb; cand uuid; again uuid;
  efp text := repeat('e', 64); pfp text := repeat('f', 64);
  rotated text := repeat('0', 63) || 'e';     -- the same anchor under a later key version
  other text := repeat('1', 63) || 'e';       -- a different thread with the same person
  pending_rows integer;
BEGIN
  SELECT id INTO cid FROM public.contacts WHERE user_id = u AND email = 'ava@bank.test';

  -- Round 1: the thread's first two messages.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, efp, pfp, 1::smallint, 'Email', DATE '2026-10-01', NULL,
    'They offered a short call next week.', 'Send your availability.', 'explicit_body', 'ai_extracted');
  ASSERT res->>'result' = 'created', 'round 1: ' || res::text;
  cand := (res->>'candidate_id')::uuid;

  -- Round 2: the exchange continued (one more message each way). The SAME identity, a
  -- later date, a fresh draft from the whole thread.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, efp, pfp, 1::smallint, 'Email', DATE '2026-10-03', NULL,
    'They confirmed Thursday at three.', 'Prepare two questions about the desk.', 'explicit_body', 'ai_extracted');
  ASSERT res->>'result' = 'refreshed', 'round 2 REFRESHES: ' || res::text;
  ASSERT (res->>'candidate_id')::uuid = cand, 'the same row';
  SELECT count(*) INTO pending_rows FROM public.interaction_candidates WHERE user_id = u AND source_fingerprint = efp;
  ASSERT pending_rows = 1, 'ONE pending row for the exchange, not two: ' || pending_rows;
  ASSERT (SELECT proposed_interaction_date FROM public.interaction_candidates WHERE id = cand) = DATE '2026-10-03', 'moved to the latest message';
  ASSERT (SELECT draft_follow_up FROM public.interaction_candidates WHERE id = cand) = 'Prepare two questions about the desk.', 'the newer draft replaced the step';
  ASSERT (SELECT status FROM public.interaction_candidates WHERE id = cand) = 'pending';

  -- A rotated key: the write fingerprint differs, the lookup fingerprint is the SAME anchor
  -- under the earlier key version, and it finds the row. Lookup fingerprints are rotation
  -- variants of one anchor - not a way to match a different first message.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, rotated, pfp, 2::smallint, 'Email', DATE '2026-10-04', ARRAY[efp],
    'Still the same exchange.', NULL, NULL, 'ai_extracted');
  ASSERT res->>'result' = 'refreshed' AND (res->>'candidate_id')::uuid = cand, 'a key-rotation variant refreshes, never creates: ' || res::text;

  -- The reviewer decides (accepts). From here the exchange is terminal.
  res := public.accept_interaction_candidate(cand, 'Email', DATE '2026-10-04', 'They confirmed Thursday at three.', NULL, NULL);
  ASSERT res->>'result' = 'accepted', 'accept: ' || res::text;

  -- Round 3: the thread continues. The producer answers exists_terminal and writes nothing:
  -- the same conversation is not suggested twice.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, efp, pfp, 1::smallint, 'Email', DATE '2026-10-06', NULL,
    'They sent the dial-in.', 'Join on time.', 'explicit_body', 'ai_extracted');
  ASSERT res->>'result' = 'exists_terminal', 'a decided exchange is never resurrected: ' || res::text;
  ASSERT (res->>'candidate_id')::uuid = cand;
  SELECT count(*) INTO pending_rows FROM public.interaction_candidates WHERE user_id = u AND source_fingerprint = efp;
  ASSERT pending_rows = 1, 'still one row';
  ASSERT (SELECT status FROM public.interaction_candidates WHERE id = cand) = 'accepted', 'and it stays decided';
  ASSERT (SELECT draft_follow_up FROM public.interaction_candidates WHERE id = cand) IS NULL, 'the terminal row takes no new draft';

  -- A NEW thread with the SAME person: a different first message is a different identity,
  -- and IS proposed. Nothing about the person is suppressed - only the decided conversation.
  res := public.upsert_outlook_interaction_candidate(conn, run, cid, other, pfp, 1::smallint, 'Email', DATE '2026-10-07', NULL,
    'A new conversation with the same person.', NULL, NULL, 'ai_extracted');
  ASSERT res->>'result' = 'created', 'a new thread with the same person is proposed: ' || res::text;
  again := (res->>'candidate_id')::uuid;
  ASSERT again <> cand;
  ASSERT (SELECT status FROM public.interaction_candidates WHERE id = again) = 'pending';
  ASSERT (SELECT contact_id FROM public.interaction_candidates WHERE id = again) = cid, 'for the same contact';
END $$;

SELECT set_config('request.jwt.claim.sub', NULL, false);
SELECT set_config('request.jwt.claims', NULL, false);

SELECT 'outlook-known-contact-follow-up-runtime: all assertions passed' AS result;
