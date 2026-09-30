-- Runtime verification for migration
-- 20260929000000_outlook_connection_status_rpc.sql
--
-- Runs on a DISPOSABLE LOCAL Postgres that already has the Outlook migrations
-- applied, so it exercises the real forward-migration ordering. Never run
-- against Production.
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
-- The point of this RPC is to let the browser ask "is my mailbox connected?"
-- without a service-role key and without a table grant. So the things worth
-- proving are: it answers for the CALLER only, it answers nothing at all
-- without a session, it exposes no secret, and it cannot write.

DO $$
DECLARE
  u1    uuid := '11111111-1111-1111-1111-111111111111';
  u2    uuid := '22222222-2222-2222-2222-222222222222';
  v     jsonb;
  k     text;
  n     integer;
  allowed text[] := ARRAY['result', 'mailbox', 'account_type', 'status',
                          'needs_reauth', 'connected_at',
                          'consent_policy_version', 'scopes'];
BEGIN
  DELETE FROM public.microsoft_connections WHERE user_id IN (u1, u2);

  -- ── 1. no session: refuses, and reads nothing ────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v := public.get_my_outlook_connection();
  ASSERT v ->> 'result' = 'unauthorized', 'anonymous read not refused: ' || v::text;
  ASSERT NOT (v ? 'mailbox'), 'a refusal leaked a mailbox address';

  -- ── 2. signed in, nothing connected ──────────────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', u1::text, true);
  v := public.get_my_outlook_connection();
  ASSERT v ->> 'result' = 'not_connected', 'unconnected user: ' || v::text;
  ASSERT NOT (v ? 'mailbox'), 'not_connected leaked a mailbox address';

  -- ── 3. connected: the fields the card needs ──────────────────────────────
  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version)
  VALUES (u1, 'acct-1', 'consumers', 'personal', 'u1@example.test',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(),
          'ol-disc-00000000000000000000000000000000');
  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version)
  VALUES (u2, 'acct-2', 'consumers', 'personal', 'u2@example.test',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(),
          'ol-disc-00000000000000000000000000000000');

  v := public.get_my_outlook_connection();
  ASSERT v ->> 'result' = 'connected', 'connected user: ' || v::text;
  ASSERT v ->> 'mailbox' = 'u1@example.test', 'wrong mailbox returned';
  ASSERT v ->> 'status' = 'active';
  ASSERT (v ->> 'needs_reauth')::boolean = false;
  ASSERT v ->> 'consent_policy_version' = 'ol-disc-00000000000000000000000000000000',
         'the recorded consent version is not reported back';
  ASSERT v -> 'scopes' @> '["Mail.Read","User.Read"]'::jsonb,
         'granted scopes are not reported';
  ASSERT v ->> 'connected_at' IS NOT NULL;

  -- ── 4. it answers for the CALLER, never for whoever asks ─────────────────
  -- The function takes no arguments, so there is nothing to pass; this proves
  -- the identity actually switches with the session rather than being fixed.
  PERFORM set_config('request.jwt.claim.sub', u2::text, true);
  v := public.get_my_outlook_connection();
  ASSERT v ->> 'mailbox' = 'u2@example.test',
         'the RPC did not follow the caller identity';
  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
          WHERE nsp.nspname = 'public' AND p.proname = 'get_my_outlook_connection'
            AND p.pronargs = 0) = 1,
         'the status RPC must take NO arguments, so no caller can name a user';

  -- ── 5. no secret is exposed ──────────────────────────────────────────────
  -- Asserted as an allowlist rather than a list of forbidden words, so a field
  -- added later is rejected until it is reviewed and named here.
  PERFORM set_config('request.jwt.claim.sub', u1::text, true);
  v := public.get_my_outlook_connection();
  FOR k IN SELECT jsonb_object_keys(v) LOOP
    ASSERT k = ANY (allowed),
           format('the status RPC returned an unreviewed field: %s', k);
  END LOOP;
  ASSERT NOT (v ? 'id') AND NOT (v ? 'ms_account_id') AND NOT (v ? 'ms_tenant_id')
         AND NOT (v ? 'token_expires_at'),
         'the status RPC exposed connection internals';

  -- ── 6. it cannot write ───────────────────────────────────────────────────
  SELECT count(*) INTO n FROM public.microsoft_connections;
  PERFORM public.get_my_outlook_connection();
  ASSERT (SELECT count(*) FROM public.microsoft_connections) = n,
         'a read changed the row count';
  ASSERT (SELECT p.provolatile FROM pg_proc p JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
          WHERE nsp.nspname = 'public' AND p.proname = 'get_my_outlook_connection') = 's',
         'the status RPC is not STABLE';

  -- ── 7. grants: the user calls it; anon and the service role cannot ───────
  ASSERT has_function_privilege('authenticated', 'public.get_my_outlook_connection()', 'EXECUTE'),
         'authenticated cannot read its own connection status';
  ASSERT NOT has_function_privilege('anon', 'public.get_my_outlook_connection()', 'EXECUTE'),
         'anon gained EXECUTE on the status RPC';
  ASSERT NOT has_function_privilege('service_role', 'public.get_my_outlook_connection()', 'EXECUTE'),
         'service_role must NOT hold EXECUTE (the 20260922175616 FUTURE RULE)';

  -- ── 8. SECURITY DEFINER with a pinned search_path ────────────────────────
  ASSERT (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
          WHERE nsp.nspname = 'public' AND p.proname = 'get_my_outlook_connection'),
         'the status RPC is not SECURITY DEFINER';
  ASSERT (SELECT array_to_string(p.proconfig, ',') LIKE '%search_path=%'
          FROM pg_proc p JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
          WHERE nsp.nspname = 'public' AND p.proname = 'get_my_outlook_connection'),
         'the status RPC has no pinned search_path';

  -- ── 9. the TABLE grant was not widened to get here ───────────────────────
  -- Stated carefully. There is no TABLE-level grant for `authenticated`, which this
  -- asserts. That is NOT the same as "the browser cannot read the table": a
  -- COLUMN-level grant already exposes the non-secret columns, and a select naming
  -- only those returns 200 through PostgREST. So this RPC is a preferred contract,
  -- not a necessity - see the migration header, which records the correction.
  ASSERT NOT has_table_privilege('authenticated', 'public.microsoft_connections', 'SELECT'),
         'a TABLE-level grant appeared; this RPC exists so one is not needed';
  -- And the columns that must stay unreadable, whatever else changes.
  ASSERT NOT has_column_privilege('authenticated', 'public.microsoft_connections', 'id', 'SELECT'),
         'the connection id became readable by the browser';
  ASSERT NOT has_column_privilege('authenticated', 'public.microsoft_connections', 'ms_account_id', 'SELECT'),
         'the Microsoft account id became readable by the browser';
  ASSERT NOT has_column_privilege('authenticated', 'public.microsoft_connections', 'token_expires_at', 'SELECT'),
         'token metadata became readable by the browser';

  DELETE FROM public.microsoft_connections WHERE user_id IN (u1, u2);

  RAISE NOTICE 'OUTLOOK CONNECTION STATUS RUNTIME: ALL ASSERTIONS PASSED';
END $$;
