-- Runtime verification for migration
-- 20260930000000_outlook_interaction_candidate_write.sql
--
-- HOW TO BUILD THE DATABASE THIS NEEDS: tests/sql/_bootstrap-disposable-db.sql
--
-- WHAT THIS PROVES, AND WHAT IT DOES NOT.
-- It runs as the PRIVILEGED `postgres` role, so it proves the function body: the
-- two-folder lease fence, ownership, deduplication, and which columns are written. It
-- does NOT prove that a real request is switched to `service_role` or that a user is
-- refused EXECUTE - a privileged role bypasses exactly those checks. Those are covered
-- over real HTTP by tests/local/outlook-first-suggestion.mjs.
--
-- THIS IS NOT A BROWSER-TO-DATABASE END-TO-END TEST. There is no JWT, no PostgREST, no
-- Kong and no browser in this file.
--
-- THE CENTRAL CASE: the write must require the run to own BOTH folder leases. Inbox
-- alone is not enough, because an episode is assembled from Inbox AND Sent Items and a
-- second run may already be reading the other folder.

DO $$
DECLARE
  u1     uuid := '11111111-1111-1111-1111-111111111111';
  u2     uuid := '22222222-2222-2222-2222-222222222222';
  conn   uuid;
  c1     uuid;
  c2     uuid;
  run1   uuid;
  run2   uuid;
  v      jsonb;
  fp1    text := repeat('1', 64);
  fp2    text := repeat('2', 64);
  person text := repeat('9', 64);
BEGIN
  -- ── fixtures ──────────────────────────────────────────────────────────────
  DELETE FROM public.interaction_candidates WHERE user_id IN (u1, u2);
  DELETE FROM public.contacts WHERE user_id IN (u1, u2);
  DELETE FROM public.microsoft_connections WHERE user_id IN (u1, u2);

  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version)
  VALUES (u1, 'acct-1', 'consumers', 'personal', 'u1@example.test',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(), 'v1')
  RETURNING id INTO conn;

  INSERT INTO public.contacts (user_id, name, email)
  VALUES (u1, 'Ava', 'ava@bank.test') RETURNING id INTO c1;
  -- The SAME address, tracked by a DIFFERENT user.
  INSERT INTO public.contacts (user_id, name, email)
  VALUES (u2, 'Ava (someone else)', 'ava@bank.test') RETURNING id INTO c2;

  -- A real reservation, which claims BOTH folders under one run id.
  v := public.reserve_due_outlook_connection(120, 900);
  ASSERT v ->> 'result' = 'reserved', 'reservation failed: ' || v::text;
  run1 := (v ->> 'run_id')::uuid;
  ASSERT (SELECT count(*) FROM public.outlook_sync_state WHERE connection_id = conn) = 2,
         'a reservation must claim both folders';

  -- ── 1. the happy path, with both leases live ───────────────────────────────
  v := public.upsert_outlook_interaction_candidate(
         conn, run1, c1, fp1, person, 1::smallint, 'Email', current_date, NULL);
  ASSERT v ->> 'result' = 'created', 'a fully leased run should create: ' || v::text;
  ASSERT (SELECT count(*) FROM public.interaction_candidates
           WHERE user_id = u1 AND source = 'outlook' AND status = 'pending') = 1;
  ASSERT (SELECT count(*) FROM public.outlook_candidate_refs WHERE user_id = u1) = 1;

  -- Nothing was invented, and no interaction was created.
  ASSERT (SELECT proposed_notes IS NULL AND retained_subject IS NULL
                 AND draft_summary IS NULL AND draft_follow_up IS NULL
                 AND summary_evidence IS NULL
          FROM public.interaction_candidates WHERE user_id = u1),
         'a metadata pass must write no content';
  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u1) = 0,
         'the worker must never create an interaction';

  -- ── 2. THE CORRECTION: Inbox live, Sent Items STALE ───────────────────────
  -- Expire only the sentitems lease. An earlier version of this function checked the
  -- inbox row alone and would have admitted this write.
  UPDATE public.outlook_sync_state
     SET sync_lease_until = now() - interval '1 minute'
   WHERE connection_id = conn AND folder = 'sentitems';

  v := public.upsert_outlook_interaction_candidate(
         conn, run1, c1, fp2, person, 1::smallint, 'Email', current_date, NULL);
  ASSERT v ->> 'result' = 'stale_run',
         'a run holding only the Inbox lease must be refused: ' || v::text;
  ASSERT (SELECT count(*) FROM public.interaction_candidates WHERE user_id = u1) = 1,
         'the refused write must leave no row';

  -- ── 3. Inbox live, Sent Items owned by ANOTHER run ────────────────────────
  run2 := gen_random_uuid();
  UPDATE public.outlook_sync_state
     SET sync_lease_until = now() + interval '2 minutes',
         sync_run_id = run2
   WHERE connection_id = conn AND folder = 'sentitems';

  v := public.upsert_outlook_interaction_candidate(
         conn, run1, c1, fp2, person, 1::smallint, 'Email', current_date, NULL);
  ASSERT v ->> 'result' = 'stale_run',
         'a split-ownership run must be refused: ' || v::text;
  ASSERT (SELECT count(*) FROM public.interaction_candidates WHERE user_id = u1) = 1;

  -- And the mirror case: the OTHER run cannot write either, because it holds only
  -- sentitems.
  v := public.upsert_outlook_interaction_candidate(
         conn, run2, c1, fp2, person, 1::smallint, 'Email', current_date, NULL);
  ASSERT v ->> 'result' = 'stale_run',
         'the run holding only Sent Items must be refused too: ' || v::text;

  -- ── 4. Sent Items not claimed at all (only one state row) ─────────────────
  DELETE FROM public.outlook_sync_state WHERE connection_id = conn AND folder = 'sentitems';
  UPDATE public.outlook_sync_state
     SET sync_run_id = run1, sync_status = 'running',
         sync_lease_until = now() + interval '2 minutes'
   WHERE connection_id = conn;
  ASSERT (SELECT count(*) FROM public.outlook_sync_state WHERE connection_id = conn) = 1;

  v := public.upsert_outlook_interaction_candidate(
         conn, run1, c1, fp2, person, 1::smallint, 'Email', current_date, NULL);
  ASSERT v ->> 'result' = 'stale_run',
         'one folder row is not two live leases: ' || v::text;

  -- ── 5. restore both leases, then the remaining contract checks ────────────
  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, sync_run_id, sync_lease_until)
  VALUES (conn, u1, 'sentitems', 'running', run1, now() + interval '2 minutes');
  ASSERT (SELECT count(*) FROM public.outlook_sync_state WHERE connection_id = conn) = 2;

  -- The same episode again: refreshed in place, never duplicated.
  v := public.upsert_outlook_interaction_candidate(
         conn, run1, c1, fp1, person, 1::smallint, 'Email', current_date + 1, NULL);
  ASSERT v ->> 'result' = 'refreshed', 'a repeat must refresh: ' || v::text;
  ASSERT (SELECT count(*) FROM public.interaction_candidates WHERE user_id = u1) = 1;
  ASSERT (SELECT source_fingerprint FROM public.interaction_candidates WHERE user_id = u1) = fp1,
         'a refresh must NOT rewrite the historical fingerprint';

  -- Another user's contact, with the identical address, is refused.
  v := public.upsert_outlook_interaction_candidate(
         conn, run1, c2, fp2, person, 1::smallint, 'Email', current_date, NULL);
  ASSERT v ->> 'result' = 'contact_not_owned',
         'a contact owned by another user must be refused: ' || v::text;
  ASSERT (SELECT count(*) FROM public.interaction_candidates WHERE user_id = u2) = 0;

  -- A new-contact proposal is refused rather than invented.
  v := public.upsert_outlook_interaction_candidate(
         conn, run1, NULL, fp2, person, 1::smallint, 'Email', current_date, NULL);
  ASSERT v ->> 'result' = 'contact_required', v::text;

  -- A type the pass has no evidence for is refused.
  v := public.upsert_outlook_interaction_candidate(
         conn, run1, c1, fp2, person, 1::smallint, 'Coffee chat', current_date, NULL);
  ASSERT v ->> 'result' = 'invalid_type', v::text;

  -- A tombstone is never resurrected.
  UPDATE public.interaction_candidates SET status = 'dismissed',
         retained_subject = NULL, context_expires_at = NULL
   WHERE user_id = u1;
  v := public.upsert_outlook_interaction_candidate(
         conn, run1, c1, fp1, person, 1::smallint, 'Email', current_date, NULL);
  ASSERT v ->> 'result' = 'exists_terminal', 'a dismissed exchange must stay dismissed: ' || v::text;
  ASSERT (SELECT status FROM public.interaction_candidates WHERE user_id = u1) = 'dismissed';

  -- ── 6. grants: worker only ────────────────────────────────────────────────
  -- THE SIGNATURE GAINED A TENTH ARGUMENT (p_proposed_notes) in
  -- 20261006000000_outlook_content_note_and_new_contact_write.sql, which DROPs and
  -- re-CREATEs this function. has_function_privilege() resolves by EXACT argument
  -- list, so these three name the 10-argument form; against the old 9-argument
  -- form they raise "function does not exist" rather than failing an assertion -
  -- which is exactly how the signature change was caught.
  --
  -- These are not cosmetic. A dropped function loses its ACL, so this is what
  -- proves the REVOKE/GRANT pair was restated after the DROP.
  ASSERT has_function_privilege('service_role',
           'public.upsert_outlook_interaction_candidate(uuid,uuid,uuid,text,text,smallint,text,date,text[],text)',
           'EXECUTE'),
         'the worker lost EXECUTE';
  ASSERT NOT has_function_privilege('authenticated',
           'public.upsert_outlook_interaction_candidate(uuid,uuid,uuid,text,text,smallint,text,date,text[],text)',
           'EXECUTE'),
         'a user must never be able to manufacture a suggestion';
  ASSERT NOT has_function_privilege('anon',
           'public.upsert_outlook_interaction_candidate(uuid,uuid,uuid,text,text,smallint,text,date,text[],text)',
           'EXECUTE'),
         'anon gained EXECUTE on the write RPC';

  ASSERT (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'upsert_outlook_interaction_candidate'),
         'the write RPC is not SECURITY DEFINER';
  ASSERT (SELECT array_to_string(p.proconfig, ',') LIKE '%search_path=%'
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'upsert_outlook_interaction_candidate'),
         'the write RPC has no pinned search_path';

  -- ── teardown ──────────────────────────────────────────────────────────────
  DELETE FROM public.interaction_candidates WHERE user_id IN (u1, u2);
  DELETE FROM public.contacts WHERE user_id IN (u1, u2);
  DELETE FROM public.microsoft_connections WHERE user_id IN (u1, u2);

  RAISE NOTICE 'OUTLOOK CANDIDATE WRITE RUNTIME: ALL ASSERTIONS PASSED';
END $$;
