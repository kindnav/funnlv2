-- Runtime verification for migration
-- 20261001000000_outlook_rotate_access_token.sql
--
-- HOW TO BUILD THE DATABASE THIS NEEDS: tests/sql/_bootstrap-disposable-db.sql
--
-- WHAT THIS PROVES, AND WHAT IT DOES NOT. It runs as the PRIVILEGED `postgres` role, so
-- it proves the function body: the two-folder lease fence, the optional refresh pair,
-- and which rows are written. It does NOT prove that a real request is switched to
-- `service_role` or that a user is refused EXECUTE - a privileged role bypasses exactly
-- those checks. Those are covered over real HTTP by
-- tests/local/outlook-worker-token-access.mjs.
--
-- THIS IS NOT A BROWSER-TO-DATABASE END-TO-END TEST, and there is no real token
-- anywhere in it: the ciphertexts below are opaque strings, because the database has no
-- key and cannot tell a real ciphertext from a placeholder.

DO $$
DECLARE
  u1    uuid := '11111111-1111-1111-1111-111111111111';
  conn  uuid;
  run1  uuid;
  run2  uuid;
  v     jsonb;
  later timestamptz := now() + interval '1 hour';
BEGIN
  DELETE FROM public.microsoft_connections WHERE user_id = u1;

  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version, token_expires_at)
  VALUES (u1, 'acct-1', 'consumers', 'personal', 'u1@example.test',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(), 'v1',
          now() - interval '10 minutes')
  RETURNING id INTO conn;

  INSERT INTO public.microsoft_tokens
    (connection_id, user_id, access_token_ciphertext, access_token_nonce,
     refresh_token_ciphertext, refresh_token_nonce, key_version, token_expires_at)
  VALUES (conn, u1, 'ACC-CT-1', 'ACC-N-1', 'REF-CT-1', 'REF-N-1', 1,
          now() - interval '10 minutes');

  v := public.reserve_due_outlook_connection(300, 900);
  ASSERT v ->> 'result' = 'reserved', 'reservation failed: ' || v::text;
  run1 := (v ->> 'run_id')::uuid;

  -- ── 1. a refresh WITHOUT rotation keeps the stored refresh token ──────────
  v := public.rotate_microsoft_access_token(
         conn, run1, 'ACC-CT-2', 'ACC-N-2', NULL, NULL, 1::smallint, later);
  ASSERT v ->> 'result' = 'rotated', v::text;
  ASSERT (v ->> 'refresh_replaced')::boolean = false, 'nothing was rotated';
  ASSERT (SELECT access_token_ciphertext FROM public.microsoft_tokens WHERE connection_id = conn) = 'ACC-CT-2';
  ASSERT (SELECT refresh_token_ciphertext FROM public.microsoft_tokens WHERE connection_id = conn) = 'REF-CT-1',
         'an omitted refresh token must NOT clear the stored one';
  ASSERT (SELECT token_expires_at FROM public.microsoft_tokens WHERE connection_id = conn) = later;
  ASSERT (SELECT token_expires_at FROM public.microsoft_connections WHERE id = conn) = later,
         'the connection expiry must track the token expiry';

  -- ── 2. a refresh WITH rotation replaces it ────────────────────────────────
  v := public.rotate_microsoft_access_token(
         conn, run1, 'ACC-CT-3', 'ACC-N-3', 'REF-CT-2', 'REF-N-2', 1::smallint, later);
  ASSERT v ->> 'result' = 'rotated', v::text;
  ASSERT (v ->> 'refresh_replaced')::boolean = true;
  ASSERT (SELECT refresh_token_ciphertext FROM public.microsoft_tokens WHERE connection_id = conn) = 'REF-CT-2';
  ASSERT (SELECT refresh_token_nonce FROM public.microsoft_tokens WHERE connection_id = conn) = 'REF-N-2';

  -- ── 3. a HALF refresh pair is refused, not half-written ───────────────────
  v := public.rotate_microsoft_access_token(
         conn, run1, 'ACC-CT-4', 'ACC-N-4', 'REF-CT-3', NULL, 1::smallint, later);
  ASSERT v ->> 'result' = 'invalid_refresh_pair', v::text;
  v := public.rotate_microsoft_access_token(
         conn, run1, 'ACC-CT-4', 'ACC-N-4', NULL, 'REF-N-3', 1::smallint, later);
  ASSERT v ->> 'result' = 'invalid_refresh_pair', v::text;
  ASSERT (SELECT access_token_ciphertext FROM public.microsoft_tokens WHERE connection_id = conn) = 'ACC-CT-3',
         'a refused call must write nothing at all';

  -- ── 4. a missing access pair, key version or expiry is refused ────────────
  v := public.rotate_microsoft_access_token(conn, run1, NULL, NULL, NULL, NULL, 1::smallint, later);
  ASSERT v ->> 'result' = 'invalid_access_pair', v::text;
  v := public.rotate_microsoft_access_token(conn, run1, 'A', 'N', NULL, NULL, 0::smallint, later);
  ASSERT v ->> 'result' = 'invalid_key_version', v::text;
  v := public.rotate_microsoft_access_token(conn, run1, 'A', 'N', NULL, NULL, 1::smallint, NULL);
  ASSERT v ->> 'result' = 'invalid_expiry', v::text;

  -- ── 5. THE FENCE: Inbox live, Sent Items stale ────────────────────────────
  UPDATE public.outlook_sync_state
     SET sync_lease_until = now() - interval '1 minute'
   WHERE connection_id = conn AND folder = 'sentitems';
  v := public.rotate_microsoft_access_token(
         conn, run1, 'ACC-CT-5', 'ACC-N-5', NULL, NULL, 1::smallint, later);
  ASSERT v ->> 'result' = 'stale_run',
         'a run holding only the Inbox lease must not rewrite credentials: ' || v::text;
  ASSERT (SELECT access_token_ciphertext FROM public.microsoft_tokens WHERE connection_id = conn) = 'ACC-CT-3';

  -- ── 6. THE FENCE: Sent Items owned by another run ─────────────────────────
  run2 := gen_random_uuid();
  UPDATE public.outlook_sync_state
     SET sync_run_id = run2, sync_lease_until = now() + interval '5 minutes'
   WHERE connection_id = conn AND folder = 'sentitems';
  v := public.rotate_microsoft_access_token(
         conn, run1, 'ACC-CT-5', 'ACC-N-5', NULL, NULL, 1::smallint, later);
  ASSERT v ->> 'result' = 'stale_run', 'split ownership must be refused: ' || v::text;
  v := public.rotate_microsoft_access_token(
         conn, run2, 'ACC-CT-5', 'ACC-N-5', NULL, NULL, 1::smallint, later);
  ASSERT v ->> 'result' = 'stale_run', 'the other run holds only one folder too: ' || v::text;

  -- ── 7. an unknown connection, and a connection with no token row ──────────
  UPDATE public.outlook_sync_state
     SET sync_run_id = run1, sync_lease_until = now() + interval '5 minutes'
   WHERE connection_id = conn;
  v := public.rotate_microsoft_access_token(
         gen_random_uuid(), run1, 'A', 'N', NULL, NULL, 1::smallint, later);
  ASSERT v ->> 'result' = 'unknown_connection', v::text;

  DELETE FROM public.microsoft_tokens WHERE connection_id = conn;
  v := public.rotate_microsoft_access_token(
         conn, run1, 'A', 'N', NULL, NULL, 1::smallint, later);
  ASSERT v ->> 'result' = 'no_token_row',
         'a connection with no token row cannot be refreshed into existence: ' || v::text;

  -- ── 8. grants: worker only ────────────────────────────────────────────────
  ASSERT has_function_privilege('service_role',
           'public.rotate_microsoft_access_token(uuid,uuid,text,text,text,text,smallint,timestamptz)',
           'EXECUTE'), 'the worker lost EXECUTE';
  ASSERT NOT has_function_privilege('authenticated',
           'public.rotate_microsoft_access_token(uuid,uuid,text,text,text,text,smallint,timestamptz)',
           'EXECUTE'), 'a user must never be able to write a credential';
  ASSERT NOT has_function_privilege('anon',
           'public.rotate_microsoft_access_token(uuid,uuid,text,text,text,text,smallint,timestamptz)',
           'EXECUTE'), 'anon gained EXECUTE on the rotation RPC';

  ASSERT (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'rotate_microsoft_access_token'),
         'the rotation RPC is not SECURITY DEFINER';
  ASSERT (SELECT array_to_string(p.proconfig, ',') LIKE '%search_path=%'
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'rotate_microsoft_access_token'),
         'the rotation RPC has no pinned search_path';

  -- ── 9. the schema still guarantees a refresh token exists ─────────────────
  -- Stated because the run-context loader has a defensive branch for its absence that
  -- the applied schema makes unreachable.
  ASSERT (SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'microsoft_tokens' AND column_name = 'refresh_token_ciphertext') = 'NO';
  ASSERT (SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'microsoft_tokens' AND column_name = 'access_token_ciphertext') = 'YES';

  DELETE FROM public.microsoft_connections WHERE user_id = u1;

  RAISE NOTICE 'OUTLOOK TOKEN ROTATION RUNTIME: ALL ASSERTIONS PASSED';
END $$;
