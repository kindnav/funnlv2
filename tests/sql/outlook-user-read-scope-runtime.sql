-- Runtime verification for migration 20260928000000_outlook_add_user_read_scope.sql
--
-- Runs on a DISPOSABLE LOCAL Postgres that has had 20260921000000 and
-- 20260922175616 applied first, so it exercises the real forward-migration
-- ordering. Never run against Production.
--
-- Proves, against the real CHECK constraints and the real RPC:
--   * canonical User.Read is now PERMITTED, in both spellings;
--   * an active connection must hold BOTH Mail.Read and User.Read;
--   * broader or unrelated user permissions are STILL refused;
--   * every pre-existing refusal still fires, and a refusal never consumes state.

DO $$
DECLARE
  u1     uuid := '11111111-1111-1111-1111-111111111111';
  h      text;
  v      jsonb;
  v_raw  text;
  ok     boolean;
BEGIN
  -- ── fixtures ───────────────────────────────────────────────────────────────
  DELETE FROM public.microsoft_connections WHERE user_id = u1;
  DELETE FROM public.microsoft_oauth_states WHERE user_id = u1;

  -- ── 1. CHECK: the allowlist now admits User.Read ───────────────────────────
  BEGIN
    INSERT INTO public.microsoft_connections
      (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
       status, consented_at, consent_policy_version)
    VALUES (u1, 'a1', 'consumers', 'personal', 'a@b.test',
            ARRAY['Mail.Read','User.Read','offline_access','openid','email','profile'],
            'active', now(), 'v1');
    ok := true;
  EXCEPTION WHEN check_violation THEN ok := false;
  END;
  ASSERT ok, 'CHECK rejected the canonical Mail.Read + User.Read set';
  DELETE FROM public.microsoft_connections WHERE user_id = u1;

  -- ── 2. CHECK: an ACTIVE connection without User.Read is refused ────────────
  BEGIN
    INSERT INTO public.microsoft_connections
      (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
       status, consented_at, consent_policy_version)
    VALUES (u1, 'a1', 'consumers', 'personal', 'a@b.test',
            ARRAY['Mail.Read','offline_access'], 'active', now(), 'v1');
    ok := false;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  ASSERT ok, 'CHECK accepted an ACTIVE connection without User.Read';

  -- ── 3. CHECK: an ACTIVE connection without Mail.Read is still refused ──────
  BEGIN
    INSERT INTO public.microsoft_connections
      (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
       status, consented_at, consent_policy_version)
    VALUES (u1, 'a1', 'consumers', 'personal', 'a@b.test',
            ARRAY['User.Read','offline_access'], 'active', now(), 'v1');
    ok := false;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  ASSERT ok, 'CHECK accepted an ACTIVE connection without Mail.Read';

  -- ── 4. CHECK: broader user permissions are still refused ───────────────────
  FOREACH v_raw IN ARRAY ARRAY['User.ReadWrite','User.ReadBasic.All','User.Read.All',
                               'Directory.Read.All','Mail.ReadWrite','Mail.Send',
                               'Mail.ReadBasic','MailboxSettings.Read','Files.Read',
                               'Contacts.Read','Calendars.Read']
  LOOP
    BEGIN
      INSERT INTO public.microsoft_connections
        (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
         status, consented_at, consent_policy_version)
      VALUES (u1, 'a1', 'consumers', 'personal', 'a@b.test',
              ARRAY['Mail.Read','User.Read', v_raw], 'active', now(), 'v1');
      ok := false;
    EXCEPTION WHEN check_violation THEN ok := true;
    END;
    ASSERT ok, 'CHECK accepted forbidden scope ' || v_raw;
  END LOOP;

  -- ── 5. RPC: User.Read normalizes, in both documented spellings ─────────────
  INSERT INTO public.microsoft_oauth_states
    (state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce,
     key_version, return_origin, integration_type, consented_at,
     consent_policy_version, expires_at)
  VALUES (repeat('a', 64), u1, 'ct', 'nonce', 1, 'https://www.getfunnl.com',
          'outlook', now(), 'v1', now() + interval '10 minutes')
  RETURNING state_hash INTO h;

  v := public.finalize_microsoft_connection(
         h, NULL, 'acct-1', 'consumers', 'personal', 'a@b.test',
         ARRAY['https://graph.microsoft.com/Mail.Read', 'USER.READ',
               ' offline_access ', 'OpenID', 'email', 'profile'],
         now() + interval '1 hour', 'act', 'an', 'rct', 'rn', 1::smallint);
  ASSERT v ->> 'result' = 'stored', 'User.Read not accepted: ' || v::text;
  ASSERT (SELECT scopes FROM public.microsoft_connections WHERE user_id = u1)
         @> ARRAY['Mail.Read','User.Read'],
         'normalized scopes missing Mail.Read + User.Read';
  ASSERT (SELECT consumed_at FROM public.microsoft_oauth_states WHERE state_hash = h)
         IS NOT NULL, 'state not consumed on success';

  DELETE FROM public.microsoft_connections WHERE user_id = u1;
  DELETE FROM public.microsoft_oauth_states WHERE user_id = u1;

  -- ── 5b. RPC: the GRAPH-PREFIXED User.Read spelling also normalizes ────────
  -- Case 5 exercised the unprefixed 'USER.READ'. Microsoft may return either the
  -- bare permission name or the full Graph resource URI, so both must reduce to
  -- the single canonical 'User.Read' the allowlist stores.
  INSERT INTO public.microsoft_oauth_states
    (state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce,
     key_version, return_origin, integration_type, consented_at,
     consent_policy_version, expires_at)
  VALUES (repeat('c', 64), u1, 'ct', 'nonce', 1, 'https://www.getfunnl.com',
          'outlook', now(), 'v1', now() + interval '10 minutes')
  RETURNING state_hash INTO h;

  v := public.finalize_microsoft_connection(
         h, NULL, 'acct-1', 'consumers', 'personal', 'a@b.test',
         ARRAY['https://graph.microsoft.com/Mail.Read',
               'https://graph.microsoft.com/User.Read',
               'offline_access', 'openid', 'email', 'profile'],
         now() + interval '1 hour', 'act', 'an', 'rct', 'rn', 1::smallint);
  ASSERT v ->> 'result' = 'stored',
         'Graph-prefixed User.Read not accepted: ' || v::text;
  ASSERT (SELECT scopes FROM public.microsoft_connections WHERE user_id = u1)
         @> ARRAY['Mail.Read','User.Read'],
         'Graph-prefixed User.Read did not normalize to canonical User.Read';
  -- and the prefixed spelling must NOT be stored verbatim
  ASSERT NOT ((SELECT scopes FROM public.microsoft_connections WHERE user_id = u1)
              @> ARRAY['https://graph.microsoft.com/User.Read']),
         'the raw Graph URI was stored instead of the canonical name';

  DELETE FROM public.microsoft_connections WHERE user_id = u1;
  DELETE FROM public.microsoft_oauth_states WHERE user_id = u1;

  -- ── 6. RPC: missing User.Read is refused, and the state SURVIVES ───────────
  INSERT INTO public.microsoft_oauth_states
    (state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce,
     key_version, return_origin, integration_type, consented_at,
     consent_policy_version, expires_at)
  VALUES (repeat('b', 64), u1, 'ct', 'nonce', 1, 'https://www.getfunnl.com',
          'outlook', now(), 'v1', now() + interval '10 minutes')
  RETURNING state_hash INTO h;

  v := public.finalize_microsoft_connection(
         h, NULL, 'acct-1', 'consumers', 'personal', 'a@b.test',
         ARRAY['Mail.Read', 'offline_access'],
         now() + interval '1 hour', 'act', 'an', 'rct', 'rn', 1::smallint);
  ASSERT v ->> 'result' = 'missing_user_read', 'expected missing_user_read: ' || v::text;
  ASSERT (SELECT consumed_at FROM public.microsoft_oauth_states WHERE state_hash = h)
         IS NULL, 'a refusal consumed the state';

  -- ── 7. RPC: missing Mail.Read still refused, state survives ────────────────
  v := public.finalize_microsoft_connection(
         h, NULL, 'acct-1', 'consumers', 'personal', 'a@b.test',
         ARRAY['User.Read', 'offline_access'],
         now() + interval '1 hour', 'act', 'an', 'rct', 'rn', 1::smallint);
  ASSERT v ->> 'result' = 'missing_mail_read', 'expected missing_mail_read: ' || v::text;
  ASSERT (SELECT consumed_at FROM public.microsoft_oauth_states WHERE state_hash = h)
         IS NULL, 'a refusal consumed the state';

  -- ── 8. RPC: broader/unrelated permissions still forbidden_scope ────────────
  FOREACH v_raw IN ARRAY ARRAY['User.ReadWrite','User.ReadBasic.All','User.Read.All',
                               'Directory.Read.All','Mail.ReadWrite','Mail.Send',
                               'Mail.ReadBasic','MailboxSettings.ReadWrite',
                               'Files.Read','Contacts.Read','Calendars.ReadWrite',
                               'https://graph.microsoft.com/.default','.default',
                               'https://graph.microsoft.com/User.ReadWrite']
  LOOP
    v := public.finalize_microsoft_connection(
           h, NULL, 'acct-1', 'consumers', 'personal', 'a@b.test',
           ARRAY['Mail.Read', 'User.Read', v_raw],
           now() + interval '1 hour', 'act', 'an', 'rct', 'rn', 1::smallint);
    ASSERT v ->> 'result' = 'forbidden_scope', v_raw || ' accepted: ' || v::text;
    ASSERT (SELECT consumed_at FROM public.microsoft_oauth_states WHERE state_hash = h)
           IS NULL, v_raw || ' consumed the state';
  END LOOP;

  -- ── 9. Pre-existing refusals are intact ────────────────────────────────────
  v := public.finalize_microsoft_connection(
         'not-a-hash', NULL, 'acct-1', 'consumers', 'personal', 'a@b.test',
         ARRAY['Mail.Read','User.Read'], now() + interval '1 hour',
         'act', 'an', 'rct', 'rn', 1::smallint);
  ASSERT v ->> 'result' = 'invalid_state', 'invalid_state lost: ' || v::text;

  v := public.finalize_microsoft_connection(
         repeat('9', 64), NULL, 'acct-1', 'consumers', 'personal', 'a@b.test',
         ARRAY['Mail.Read','User.Read'], now() + interval '1 hour',
         'act', 'an', 'rct', 'rn', 1::smallint);
  ASSERT v ->> 'result' = 'unknown_state', 'unknown_state lost: ' || v::text;

  v := public.finalize_microsoft_connection(
         h, NULL, 'acct-1', 'consumers', 'bogus-type', 'a@b.test',
         ARRAY['Mail.Read','User.Read'], now() + interval '1 hour',
         'act', 'an', 'rct', 'rn', 1::smallint);
  ASSERT v ->> 'result' = 'invalid_account_type', 'invalid_account_type lost: ' || v::text;

  -- ── 10. Grant model unchanged: service_role only ───────────────────────────
  ASSERT has_function_privilege('service_role',
    'public.finalize_microsoft_connection(text,uuid,text,text,text,text,text[],timestamptz,text,text,text,text,smallint)',
    'EXECUTE'), 'service_role lost EXECUTE';
  ASSERT NOT has_function_privilege('authenticated',
    'public.finalize_microsoft_connection(text,uuid,text,text,text,text,text[],timestamptz,text,text,text,text,smallint)',
    'EXECUTE'), 'authenticated gained EXECUTE';
  ASSERT NOT has_function_privilege('anon',
    'public.finalize_microsoft_connection(text,uuid,text,text,text,text,text[],timestamptz,text,text,text,text,smallint)',
    'EXECUTE'), 'anon gained EXECUTE';

  -- ── 11. SECURITY DEFINER + empty search_path preserved ─────────────────────
  ASSERT (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'finalize_microsoft_connection'),
         'function is no longer SECURITY DEFINER';
  ASSERT (SELECT 'search_path=' = ANY (p.proconfig) OR array_to_string(p.proconfig, ',') LIKE '%search_path=%'
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'finalize_microsoft_connection'),
         'function lost its pinned search_path';

  DELETE FROM public.microsoft_connections WHERE user_id = u1;
  DELETE FROM public.microsoft_oauth_states WHERE user_id = u1;

  RAISE NOTICE 'OUTLOOK USER.READ RUNTIME: ALL ASSERTIONS PASSED';
END $$;
