-- 20261014000000_outlook_one_owner_per_microsoft_account.sql
--
-- ONE DEFECT: two Funnl users could connect the SAME Microsoft account.
--
-- WHAT WAS WRONG. `finalize_microsoft_connection` compared the incoming Microsoft identity
-- only with the CALLER'S OWN existing connection (step 4, "same-account rule"), and
-- `microsoft_connections` is unique on `user_id` alone. Nothing refused a second Funnl user
-- presenting a Microsoft account another Funnl user already had connected.
--
-- WHY IT MATTERS. Both connections then hold delegated tokens for the same Microsoft user
-- and the same app, so:
--   * the same mailbox is read into two Funnl accounts;
--   * Graph answers 409 to the second connection's subscription create (documented: a
--     duplicate changeType + resource for that user and app). `createFresh` in
--     outlookSubscriptions.js then lists that user's subscriptions, deletes every one at
--     Funnl's notification URL - the FIRST connection's included - and creates its own. The
--     first connection's row still says `active` with a subscription id Microsoft no longer
--     has, so its change notifications stop; at its next renewal the PATCH 404s, it
--     recreates, 409s, and deletes the second connection's subscription in turn.
-- Reproduced on disposable infrastructure before this migration, with the real finalize
-- function, the real subscription module and the real subscription-state and notification
-- RPCs over real PostgREST, against a Graph fixture that models the documented 409:
-- tests/local/outlook-one-owner.mjs.
--
-- WHAT THIS MIGRATION DOES.
--   1. Refuses to run if any Microsoft account is ALREADY connected to more than one Funnl
--      user. It deletes and disconnects nothing; such rows must be resolved deliberately
--      first. (Production, checked read-only 2026-10-13: one connection, no duplicates.)
--   2. Adds the unique index `microsoft_connections_ms_identity_unique` on
--      (lower(ms_tenant_id) or '', lower(ms_account_id)): tenant id + object id, the pair
--      Microsoft documents as identifying a user. The mailbox address is deliberately NOT
--      part of it: it is display text and can change or differ by alias.
--   3. Re-issues `finalize_microsoft_connection` with the body copied VERBATIM from
--      20260928000000_outlook_add_user_read_scope.sql (the latest definition), plus blocks
--      fenced by `-- >>> 20261014` / `-- <<< 20261014`:
--        * a cross-user check returning the new controlled result `account_in_use`;
--        * the connection INSERT wrapped so a unique_violation on THIS index (a concurrent
--          race) returns the same `account_in_use`; any other unique violation re-raises.
--      A refusal returns before any write and before the state is consumed (the state then
--      expires, like every other refusal). Same-user, same-account permission updates are
--      unchanged: the caller's own row is excluded from the check. Signature, SECURITY
--      DEFINER, search_path and grants are unchanged and restated.
--   tests/outlook-one-owner-scan.test.js strips the fenced blocks and requires the rest to
--   equal the applied definition byte for byte.
--
-- REFUSAL BEFORE ANY SUBSCRIPTION INTERFERENCE. Subscriptions are created only by the worker
-- for an EXISTING connection, inside its reserved run. A refused finalize writes no
-- connection, so no run can be reserved for it and no subscription request is made.
--
-- ROLLOUT ORDER. This migration first (the deployed callback treats `account_in_use` like
-- any other refusal: the generic error redirect). Then the website, which understands the
-- new `in_use` result. Then `outlook-oauth-callback`, which starts sending it.
-- ROLLBACK. Re-issue the 20260928 definition and drop the index. Nothing else changes.

DO $guard$
DECLARE
  v_dupes integer;
BEGIN
  SELECT count(*) INTO v_dupes
    FROM (SELECT 1
            FROM public.microsoft_connections
           GROUP BY COALESCE(pg_catalog.lower(ms_tenant_id), ''), pg_catalog.lower(ms_account_id)
          HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'outlook_one_owner_duplicates: % Microsoft account(s) are connected to more than one Funnl user. This migration deletes and disconnects nothing; resolve them deliberately, then apply it.', v_dupes;
  END IF;
END
$guard$;

CREATE UNIQUE INDEX microsoft_connections_ms_identity_unique
  ON public.microsoft_connections
  ((COALESCE(pg_catalog.lower(ms_tenant_id), '')), (pg_catalog.lower(ms_account_id)));

CREATE OR REPLACE FUNCTION public.finalize_microsoft_connection(
  p_state_hash         text,
  p_expected_user_id   uuid,       -- optional cross-check (e.g. the signed-in session); NULL = trust the state
  p_ms_account_id      text,
  p_ms_tenant_id       text,
  p_account_type       text,
  p_ms_email           text,
  p_scopes             text[],     -- raw granted scopes as returned by Microsoft (normalized here)
  p_token_expires_at   timestamptz,
  p_access_ct          text,
  p_access_nonce       text,
  p_refresh_ct         text,
  p_refresh_nonce      text,
  p_key_version        smallint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state     public.microsoft_oauth_states%ROWTYPE;
  v_uid       uuid;
  v_existing  text;
  v_conn_id   uuid;
  v_raw       text;
  v_norm      text;
  v_scopes    text[] := ARRAY[]::text[];
  v_n         integer;
  -- >>> 20261014 one owner per Microsoft account
  v_constraint text;
  -- <<< 20261014
BEGIN
  -- 1. Locate and lock the single-use state (Outlook only).
  IF p_state_hash IS NULL OR p_state_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'invalid_state');
  END IF;
  SELECT * INTO v_state
  FROM public.microsoft_oauth_states
  WHERE state_hash = p_state_hash AND integration_type = 'outlook'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unknown_state'); END IF;
  IF v_state.consumed_at IS NOT NULL THEN RETURN jsonb_build_object('result', 'state_consumed'); END IF;
  IF v_state.expires_at <= now() THEN RETURN jsonb_build_object('result', 'state_expired'); END IF;
  IF p_expected_user_id IS NOT NULL AND p_expected_user_id <> v_state.user_id THEN
    RETURN jsonb_build_object('result', 'state_user_mismatch');
  END IF;
  IF v_state.consented_at IS NULL OR v_state.consent_policy_version IS NULL THEN
    RETURN jsonb_build_object('result', 'consent_missing');
  END IF;
  v_uid := v_state.user_id;

  -- 2. Provider identity + token material.
  IF p_ms_account_id IS NULL OR char_length(p_ms_account_id) NOT BETWEEN 1 AND 256 THEN
    RETURN jsonb_build_object('result', 'invalid_account');
  END IF;
  IF p_account_type IS NULL OR p_account_type NOT IN ('personal', 'work') THEN
    RETURN jsonb_build_object('result', 'invalid_account_type');
  END IF;
  IF p_ms_email IS NULL OR char_length(p_ms_email) NOT BETWEEN 3 AND 320 THEN
    RETURN jsonb_build_object('result', 'invalid_email');
  END IF;
  IF p_refresh_ct IS NULL OR p_refresh_nonce IS NULL THEN
    RETURN jsonb_build_object('result', 'refresh_token_required');
  END IF;

  -- 3. Scope normalization + permission contract.
  IF p_scopes IS NULL OR pg_catalog.array_length(p_scopes, 1) IS NULL THEN
    RETURN jsonb_build_object('result', 'missing_mail_read');
  END IF;
  IF pg_catalog.array_length(p_scopes, 1) > 16 THEN
    RETURN jsonb_build_object('result', 'invalid_scopes');
  END IF;
  FOREACH v_raw IN ARRAY p_scopes LOOP
    IF v_raw IS NULL THEN RETURN jsonb_build_object('result', 'invalid_scopes'); END IF;
    v_norm := pg_catalog.lower(pg_catalog.btrim(v_raw));
    IF char_length(v_norm) = 0 OR char_length(v_norm) > 200 THEN
      RETURN jsonb_build_object('result', 'invalid_scopes');
    END IF;
    -- Documented equivalent spelling: the Graph resource URI prefix.
    IF v_norm LIKE 'https://graph.microsoft.com/%' THEN
      v_norm := pg_catalog.substr(v_norm, char_length('https://graph.microsoft.com/') + 1);
    END IF;
    v_norm := CASE v_norm
      WHEN 'mail.read'      THEN 'Mail.Read'
      -- Added 20260928000000: Graph GET /me (mailbox address resolution) requires
      -- delegated User.Read. It is the documented LEAST-PRIVILEGED permission for
      -- /me for BOTH work/school and personal Microsoft accounts. Only the exact
      -- canonical spelling and its Graph-prefixed form are accepted; User.ReadWrite,
      -- User.ReadBasic.All, User.Read.All and Directory.* remain forbidden_scope.
      WHEN 'user.read'      THEN 'User.Read'
      WHEN 'offline_access' THEN 'offline_access'
      WHEN 'openid'         THEN 'openid'
      WHEN 'email'          THEN 'email'
      WHEN 'profile'        THEN 'profile'
      ELSE NULL END;
    -- Anything outside the canonical allowlist (Mail.ReadWrite*, Mail.Send*, Mail.ReadBasic,
    -- MailboxSettings.*, Files.*, Contacts.*, Calendars.*, .default, *.All,
    -- User.ReadWrite, User.ReadBasic.All, User.Read.All, Directory.*, ...) refuses
    -- activation. Broader permissions are never stored "as granted".
    -- NOTE: this copied comment previously listed User.Read as forbidden. As of
    -- this migration canonical User.Read is PERMITTED, and is required for an
    -- ACTIVE connection; only its broader variants remain forbidden_scope.
    IF v_norm IS NULL THEN RETURN jsonb_build_object('result', 'forbidden_scope'); END IF;
    IF NOT (v_norm = ANY (v_scopes)) THEN v_scopes := pg_catalog.array_append(v_scopes, v_norm); END IF;
  END LOOP;
  IF NOT ('Mail.Read' = ANY (v_scopes)) THEN
    RETURN jsonb_build_object('result', 'missing_mail_read');
  END IF;
  -- Added 20260928000000: an ACTIVE connection is only written after the mailbox
  -- address is resolved from Graph GET /me, which is impossible without delegated
  -- User.Read. Recording a connection whose own ms_email could not have been
  -- resolved would record a permission set that cannot work.
  IF NOT ('User.Read' = ANY (v_scopes)) THEN
    RETURN jsonb_build_object('result', 'missing_user_read');
  END IF;

  -- 4. Same-account rule: an existing connection may only be refreshed by the SAME
  --    Microsoft account. A different account must disconnect first (never silent swap).
  SELECT c.ms_account_id INTO v_existing
  FROM public.microsoft_connections c
  WHERE c.user_id = v_uid
  FOR UPDATE;
  IF v_existing IS NOT NULL AND v_existing <> p_ms_account_id THEN
    RETURN jsonb_build_object('result', 'different_account');
  END IF;

  -- >>> 20261014 ONE FUNNL OWNER PER MICROSOFT ACCOUNT.
  -- 4b. A Microsoft account (tenant + object id, the identity Microsoft guarantees; never the
  --     mailbox address text) may be connected to at most ONE Funnl user. Two connections on
  --     one Microsoft account would read the same mail into two Funnl accounts, and each
  --     connection's subscription setup deletes the other's Graph subscription (a 409 on the
  --     duplicate makes it list and delete every subscription at Funnl's notification URL for
  --     that Microsoft user). This check gives the ordinary case a clean answer; the unique
  --     index microsoft_connections_ms_identity_unique is what makes it hold under
  --     concurrency, and its violation is mapped to the same answer below. The caller's own
  --     row is excluded, so a same-user, same-account permission update is unaffected.
  --     Nothing about the other connection is read into the result.
  IF EXISTS (
    SELECT 1
      FROM public.microsoft_connections c
     WHERE c.user_id <> v_uid
       AND COALESCE(pg_catalog.lower(c.ms_tenant_id), '') = COALESCE(pg_catalog.lower(p_ms_tenant_id), '')
       AND pg_catalog.lower(c.ms_account_id) = pg_catalog.lower(p_ms_account_id)
  ) THEN
    RETURN jsonb_build_object('result', 'account_in_use');
  END IF;
  -- <<< 20261014
  -- 5. Connection + tokens (consent evidence copied from the state row).
  -- >>> 20261014 the unique index decides a concurrent race; the loser gets account_in_use.
  BEGIN
  -- <<< 20261014
  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes, status,
     needs_reauth, consented_at, consent_policy_version, last_result_code,
     last_success_at, token_expires_at, updated_at)
  VALUES
    (v_uid, p_ms_account_id, p_ms_tenant_id, p_account_type, p_ms_email, v_scopes, 'active',
     false, v_state.consented_at, v_state.consent_policy_version, 'connected',
     now(), p_token_expires_at, now())
  ON CONFLICT (user_id) DO UPDATE
    SET ms_tenant_id           = EXCLUDED.ms_tenant_id,
        account_type           = EXCLUDED.account_type,
        ms_email               = EXCLUDED.ms_email,
        scopes                 = EXCLUDED.scopes,
        status                 = 'active',
        needs_reauth           = false,
        consented_at           = EXCLUDED.consented_at,
        consent_policy_version = EXCLUDED.consent_policy_version,
        last_result_code       = 'reconnected',
        last_success_at        = now(),
        token_expires_at       = EXCLUDED.token_expires_at,
        updated_at             = now()
  RETURNING id INTO v_conn_id;
  -- >>> 20261014
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'microsoft_connections_ms_identity_unique' THEN
      RETURN jsonb_build_object('result', 'account_in_use');
    END IF;
    RAISE;
  END;
  -- <<< 20261014

  INSERT INTO public.microsoft_tokens
    (connection_id, user_id, access_token_ciphertext, access_token_nonce,
     refresh_token_ciphertext, refresh_token_nonce, key_version, token_expires_at, updated_at)
  VALUES
    (v_conn_id, v_uid, p_access_ct, p_access_nonce, p_refresh_ct, p_refresh_nonce,
     COALESCE(p_key_version, 1), p_token_expires_at, now())
  ON CONFLICT (connection_id) DO UPDATE
    SET access_token_ciphertext  = EXCLUDED.access_token_ciphertext,
        access_token_nonce       = EXCLUDED.access_token_nonce,
        refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
        refresh_token_nonce      = EXCLUDED.refresh_token_nonce,
        key_version              = EXCLUDED.key_version,
        token_expires_at         = EXCLUDED.token_expires_at,
        updated_at               = now();

  -- 6. Consume the state ONLY now (same transaction as the writes above).
  UPDATE public.microsoft_oauth_states
    SET consumed_at = now()
  WHERE id = v_state.id AND consumed_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'state_consume_failed';   -- rolls back the connection/token writes
  END IF;

  RETURN jsonb_build_object('result', 'stored', 'connection_id', v_conn_id);
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_microsoft_connection(
  text, uuid, text, text, text, text, text[], timestamptz, text, text, text, text, smallint
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_microsoft_connection(
  text, uuid, text, text, text, text, text[], timestamptz, text, text, text, text, smallint
) TO service_role;
