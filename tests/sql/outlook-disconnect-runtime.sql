-- What does disconnect actually remove, and what does it only empty?
--
-- Runs on a DISPOSABLE LOCAL Postgres. Never against Production.
--
-- This assumes nothing about the applied schema's cascades. It seeds two users,
-- each with a connection, encrypted tokens, sync cursors, an unconsumed OAuth
-- state, a pending suggested interaction, a pending suggested new contact and
-- the mail-derived links between them, then calls the user-facing
-- disconnect_my_outlook() AS ONE OF THEM and counts what survives everywhere.
--
-- The answer it proves is NOT uniform, and the UI copy must match it:
--   DELETED   the connection, the encrypted access and refresh tokens, the
--             sync cursors and leases, unconsumed OAuth states, and the links
--             from a suggestion back to a mail item.
--   EMPTIED   pending suggestions. The rows REMAIN with status 'invalidated'
--             and every proposed field, draft and retained subject NULLed.
--             They are not deleted, and describing them as deleted is wrong.
--   KEPT      contacts and interactions the user already saved. Disconnecting
--             a mailbox does not delete their CRM.
--
-- What it deliberately does NOT claim: nothing here revokes Funnl's grant at
-- Microsoft. This is a local teardown only. Withdrawing the grant itself is
-- done by the user at Microsoft, or by an upstream revocation call that does
-- not exist in this branch.
--
-- HOW TO BUILD THE DATABASE THIS NEEDS: tests/sql/_bootstrap-disposable-db.sql
--
-- WHAT THIS PROVES, AND WHAT IT DOES NOT - stated precisely, because the
-- difference matters.
--
-- It runs as the PRIVILEGED `postgres` role and simulates the caller with
-- set_config('request.jwt.claim.sub', ...). So it proves the function bodies,
-- the cascades, the constraints and the catalog facts (grants, SECURITY DEFINER,
-- pinned search_path, volatility). It does NOT prove that a real request is
-- switched to the `authenticated` role, that the EXECUTE grant is what admits
-- it, or that the same role is denied direct table access - because a privileged
-- role bypasses exactly those checks.
--
-- THIS IS NOT A BROWSER-TO-DATABASE END-TO-END TEST, and must not be described
-- as one. There is no JWT, no PostgREST, no Kong, no supabase-js and no browser
-- in this file. The role switching, the grant enforcement over HTTP and the
-- table-access denial are covered separately by
-- tests/local/outlook-rpc-postgrest.mjs, which drives real HTTP through real
-- PostgREST and states its own remaining limits.
--
-- It also checks the authorisation shape: the RPC derives the user from
-- auth.uid() and refuses when there is no session, so a caller cannot
-- disconnect someone else's account by passing an id.

DO $$
DECLARE
  u1     uuid := '11111111-1111-1111-1111-111111111111';
  u2     uuid := '22222222-2222-2222-2222-222222222222';
  conn1  uuid;
  conn2  uuid;
  c1     uuid;
  c2     uuid;
  ic1    uuid;
  ic2    uuid;
  nc1    uuid;
  nc2    uuid;
  tbl    record;
  v      jsonb;
  n      integer;
BEGIN
  -- ── seed two users, each fully connected ─────────────────────────────────
  DELETE FROM public.microsoft_connections WHERE user_id IN (u1, u2);
  DELETE FROM public.microsoft_oauth_states WHERE user_id IN (u1, u2);

  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version)
  VALUES (u1, 'acct-1', 'consumers', 'personal', 'u1@example.test',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(), 'v1')
  RETURNING id INTO conn1;

  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version)
  VALUES (u2, 'acct-2', 'consumers', 'personal', 'u2@example.test',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(), 'v1')
  RETURNING id INTO conn2;

  INSERT INTO public.microsoft_tokens
    (connection_id, user_id, access_token_ciphertext, access_token_nonce,
     refresh_token_ciphertext, refresh_token_nonce, key_version)
  VALUES (conn1, u1, 'act1', 'an1', 'rct1', 'rn1', 1),
         (conn2, u2, 'act2', 'an2', 'rct2', 'rn2', 1);

  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, delta_link_ciphertext, delta_link_nonce, delta_key_version)
  VALUES (conn1, u1, 'inbox', 'd1', 'dn1', 1),
         (conn1, u1, 'sentitems', 'd2', 'dn2', 1),
         (conn2, u2, 'inbox', 'd3', 'dn3', 1);

  INSERT INTO public.microsoft_oauth_states
    (state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce, key_version,
     return_origin, integration_type, consented_at, consent_policy_version, expires_at)
  VALUES (repeat('a', 64), u1, 'ct', 'n', 1, 'https://www.getfunnl.com', 'outlook',
          now(), 'v1', now() + interval '10 minutes'),
         (repeat('b', 64), u2, 'ct', 'n', 1, 'https://www.getfunnl.com', 'outlook',
          now(), 'v1', now() + interval '10 minutes');

  -- ── PENDING SUGGESTIONS, for BOTH users ──────────────────────────────────
  -- Seeded to the real CHECK constraints, so these are the same shape the
  -- importer would produce: an open candidate must actually carry its context.
  DELETE FROM public.contacts WHERE user_id IN (u1, u2);

  INSERT INTO public.contacts (user_id, name) VALUES (u1, 'Seed One') RETURNING id INTO c1;
  INSERT INTO public.contacts (user_id, name) VALUES (u2, 'Seed Two') RETURNING id INTO c2;

  -- suggested interactions against a contact the user already has
  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, proposed_notes, status, source_last_state,
     retained_subject, context_expires_at, draft_summary, draft_follow_up,
     summary_evidence, extraction_status)
  VALUES (u1, c1, 'outlook', repeat('e', 64), 'Email', current_date,
          'Proposed notes', 'pending', 'active',
          'A retained subject', now() + interval '7 days',
          'A drafted summary', 'A drafted follow up', 'explicit_body', 'deterministic')
  RETURNING id INTO ic1;
  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, proposed_notes, status, source_last_state,
     retained_subject, context_expires_at, draft_summary, draft_follow_up,
     summary_evidence, extraction_status)
  VALUES (u2, c2, 'outlook', repeat('f', 64), 'Email', current_date,
          'Proposed notes', 'pending', 'active',
          'A retained subject', now() + interval '7 days',
          'A drafted summary', 'A drafted follow up', 'explicit_body', 'deterministic')
  RETURNING id INTO ic2;

  -- suggested NEW contacts, not yet saved
  INSERT INTO public.new_contact_candidates
    (user_id, source, status, person_fingerprint, episode_fingerprint, key_version,
     proposed_type, extraction_status, proposed_email, proposed_name,
     proposed_name_evidence, proposed_name_confidence, proposed_interaction_date,
     retained_subject, draft_summary, context_expires_at)
  VALUES (u1, 'outlook', 'pending', repeat('c', 64), repeat('d', 64), 1,
          'Email', 'deterministic', 'lead1@example.test', 'Lead One',
          'explicit_signature', 'high', current_date,
          'A retained subject', 'A drafted summary', now() + interval '7 days')
  RETURNING id INTO nc1;
  INSERT INTO public.new_contact_candidates
    (user_id, source, status, person_fingerprint, episode_fingerprint, key_version,
     proposed_type, extraction_status, proposed_email, proposed_name,
     proposed_name_evidence, proposed_name_confidence, proposed_interaction_date,
     retained_subject, draft_summary, context_expires_at)
  VALUES (u2, 'outlook', 'pending', repeat('7', 64), repeat('8', 64), 1,
          'Email', 'deterministic', 'lead2@example.test', 'Lead Two',
          'explicit_signature', 'high', current_date,
          'A retained subject', 'A drafted summary', now() + interval '7 days')
  RETURNING id INTO nc2;

  -- the mail-derived linkage: which message each suggestion came from
  INSERT INTO public.outlook_candidate_refs
    (user_id, connection_id, interaction_candidate_id, new_contact_candidate_id,
     episode_fingerprint, person_fingerprint, key_version)
  VALUES (u1, conn1, ic1, NULL, repeat('1', 64), repeat('2', 64), 1),
         (u1, conn1, NULL, nc1, repeat('3', 64), repeat('4', 64), 1),
         (u2, conn2, ic2, NULL, repeat('5', 64), repeat('6', 64), 1),
         (u2, conn2, NULL, nc2, repeat('9', 64), repeat('0', 64), 1);

  -- ── precondition: everything is present for BOTH users ───────────────────
  ASSERT (SELECT count(*) FROM public.microsoft_connections WHERE user_id = u1) = 1;
  ASSERT (SELECT count(*) FROM public.microsoft_tokens WHERE user_id = u1) = 1;
  ASSERT (SELECT count(*) FROM public.outlook_sync_state WHERE user_id = u1) = 2;
  ASSERT (SELECT count(*) FROM public.microsoft_oauth_states WHERE user_id = u1) = 1;

  ASSERT (SELECT count(*) FROM public.interaction_candidates
          WHERE user_id = u1 AND status = 'pending') = 1;
  ASSERT (SELECT count(*) FROM public.new_contact_candidates
          WHERE user_id = u1 AND status = 'pending') = 1;
  ASSERT (SELECT count(*) FROM public.outlook_candidate_refs WHERE user_id = u1) = 2;

  -- ── 1. no session: the RPC refuses ───────────────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v := public.disconnect_my_outlook();
  ASSERT v ->> 'result' = 'unauthorized', 'anonymous disconnect not refused: ' || v::text;
  ASSERT (SELECT count(*) FROM public.microsoft_connections WHERE user_id = u1) = 1,
         'an unauthorised call deleted something';

  -- ── 2. disconnect AS u1 ──────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', u1::text, true);
  v := public.disconnect_my_outlook();
  ASSERT v ->> 'result' = 'disconnected', 'disconnect failed: ' || v::text;

  -- ── 3. exactly what was removed for u1 ───────────────────────────────────
  SELECT count(*) INTO n FROM public.microsoft_connections WHERE user_id = u1;
  ASSERT n = 0, 'CONNECTION survived disconnect';

  SELECT count(*) INTO n FROM public.microsoft_tokens WHERE user_id = u1;
  ASSERT n = 0, 'ENCRYPTED TOKENS survived disconnect';

  SELECT count(*) INTO n FROM public.outlook_sync_state WHERE user_id = u1;
  ASSERT n = 0, 'SYNC CURSORS / LEASES survived disconnect';

  SELECT count(*) INTO n FROM public.microsoft_oauth_states WHERE user_id = u1;
  ASSERT n = 0, 'UNCONSUMED OAUTH STATES survived disconnect';

  -- ── 3b. pending suggestions: INVALIDATED and EMPTIED, not deleted ────────
  -- Stated separately because it differs from the four deletions above, and
  -- any description of disconnect must say this rather than claim the
  -- suggestions are deleted. Each row survives as a provenance shell: the
  -- status becomes 'invalidated' and every proposed field, draft and retained
  -- subject is NULLed, so no mail-derived content remains. The schema enforces
  -- the emptying independently - ncc_terminal_erased and
  -- interaction_candidates_terminal_draft_erased forbid a non-pending row from
  -- holding that content at all.
  SELECT count(*) INTO n FROM public.interaction_candidates WHERE user_id = u1;
  ASSERT n = 1, 'the suggested interaction should REMAIN as a shell, not be deleted';
  ASSERT (SELECT status FROM public.interaction_candidates WHERE user_id = u1) = 'invalidated',
         'the pending suggested interaction was not invalidated';
  ASSERT (SELECT retained_subject IS NULL AND draft_summary IS NULL
                 AND draft_follow_up IS NULL AND summary_evidence IS NULL
                 AND context_expires_at IS NULL AND deferred_until IS NULL
          FROM public.interaction_candidates WHERE user_id = u1),
         'MAIL-DERIVED CONTENT survived on the suggested interaction';

  SELECT count(*) INTO n FROM public.new_contact_candidates WHERE user_id = u1;
  ASSERT n = 1, 'the suggested contact should REMAIN as a shell, not be deleted';
  ASSERT (SELECT status FROM public.new_contact_candidates WHERE user_id = u1) = 'invalidated',
         'the pending suggested contact was not invalidated';
  ASSERT (SELECT proposed_email IS NULL AND proposed_name IS NULL
                 AND proposed_company IS NULL AND proposed_role IS NULL
                 AND proposed_how_met IS NULL AND proposed_linkedin_url IS NULL
                 AND draft_summary IS NULL AND draft_follow_up IS NULL
                 AND retained_subject IS NULL AND context_expires_at IS NULL
          FROM public.new_contact_candidates WHERE user_id = u1),
         'MAIL-DERIVED CONTENT survived on the suggested contact';

  -- the LINK back to the message is deleted outright, so a surviving shell
  -- cannot be traced to a mail item: outlook_candidate_refs cascades from the
  -- connection.
  SELECT count(*) INTO n FROM public.outlook_candidate_refs WHERE user_id = u1;
  ASSERT n = 0, 'the MAIL-TO-SUGGESTION LINKAGE survived disconnect';

  -- and nothing was promoted: disconnect must never save a suggestion
  ASSERT (SELECT count(*) FROM public.contacts WHERE user_id = u1) = 1,
         'disconnect created or removed a saved contact';
  ASSERT (SELECT accepted_contact_id IS NULL AND accepted_interaction_id IS NULL
          FROM public.new_contact_candidates WHERE user_id = u1),
         'disconnect linked a suggestion to a saved record';

  -- ── 3c. nothing else is left behind anywhere ────────────────────────────
  -- A named list of tables only proves what it names. This sweeps EVERY
  -- user-scoped table in the schema, so an Outlook table added later that
  -- disconnect forgets to clear fails here instead of going unnoticed.
  --
  -- Four tables are excluded, deliberately rather than conveniently:
  --   contacts, interactions          the user's own CRM. Disconnecting a
  --                                   mailbox must NOT delete saved records,
  --                                   and their survival is asserted below.
  --   interaction_candidates,         the emptied shells, asserted in 3b.
  --   new_contact_candidates
  FOR tbl IN
    SELECT c.table_name AS name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'user_id'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name NOT IN ('contacts', 'interactions',
                               'interaction_candidates', 'new_contact_candidates')
    ORDER BY c.table_name
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id = $1', tbl.name)
      INTO n USING u1;
    ASSERT n = 0, format('%s still holds %s row(s) for the disconnected user', tbl.name, n);
  END LOOP;

  -- ── 4. the other user is untouched ───────────────────────────────────────
  ASSERT (SELECT count(*) FROM public.microsoft_connections WHERE user_id = u2) = 1,
         'disconnect crossed user boundaries (connection)';
  ASSERT (SELECT count(*) FROM public.microsoft_tokens WHERE user_id = u2) = 1,
         'disconnect crossed user boundaries (tokens)';
  ASSERT (SELECT count(*) FROM public.outlook_sync_state WHERE user_id = u2) = 1,
         'disconnect crossed user boundaries (sync state)';
  ASSERT (SELECT count(*) FROM public.microsoft_oauth_states WHERE user_id = u2) = 1,
         'disconnect crossed user boundaries (oauth states)';

  ASSERT (SELECT status FROM public.interaction_candidates WHERE user_id = u2) = 'pending',
         'disconnect invalidated ANOTHER user''s suggested interaction';
  ASSERT (SELECT draft_summary IS NOT NULL FROM public.interaction_candidates WHERE user_id = u2),
         'disconnect erased ANOTHER user''s suggestion content';
  ASSERT (SELECT status FROM public.new_contact_candidates WHERE user_id = u2) = 'pending',
         'disconnect invalidated ANOTHER user''s suggested contact';
  ASSERT (SELECT proposed_email IS NOT NULL FROM public.new_contact_candidates WHERE user_id = u2),
         'disconnect erased ANOTHER user''s suggestion content';
  ASSERT (SELECT count(*) FROM public.outlook_candidate_refs WHERE user_id = u2) = 2,
         'disconnect removed ANOTHER user''s mail linkage';

  -- ── 5. disconnecting again is a clean no-op, not an error ────────────────
  v := public.disconnect_my_outlook();
  ASSERT v ->> 'result' = 'not_connected', 'second disconnect: ' || v::text;

  -- ── 6. grant model: the user calls it, the service role cannot ───────────
  ASSERT has_function_privilege('authenticated', 'public.disconnect_my_outlook()', 'EXECUTE'),
         'authenticated lost EXECUTE on disconnect';
  ASSERT NOT has_function_privilege('anon', 'public.disconnect_my_outlook()', 'EXECUTE'),
         'anon gained EXECUTE on disconnect';
  ASSERT NOT has_function_privilege('service_role', 'public.disconnect_my_outlook()', 'EXECUTE'),
         'service_role must NOT hold EXECUTE (20260922175616 revoked it)';

  -- ── 7. SECURITY DEFINER with a pinned search_path ────────────────────────
  ASSERT (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'disconnect_my_outlook'),
         'disconnect is no longer SECURITY DEFINER';
  ASSERT (SELECT array_to_string(p.proconfig, ',') LIKE '%search_path=%'
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'disconnect_my_outlook'),
         'disconnect lost its pinned search_path';

  DELETE FROM public.interaction_candidates WHERE user_id IN (u1, u2);
  DELETE FROM public.new_contact_candidates WHERE user_id IN (u1, u2);
  DELETE FROM public.contacts WHERE user_id IN (u1, u2);
  DELETE FROM public.microsoft_connections WHERE user_id IN (u1, u2);
  DELETE FROM public.microsoft_oauth_states WHERE user_id IN (u1, u2);

  RAISE NOTICE 'OUTLOOK DISCONNECT RUNTIME: ALL ASSERTIONS PASSED';
END $$;
