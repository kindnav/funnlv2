-- ═══════════════════════════════════════════════════════════════════════════════
--  Outlook permission contract: add delegated User.Read
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHY
-- ---
-- The Outlook callback must resolve the connected mailbox address before it can
-- satisfy microsoft_connections.ms_email (NOT NULL). id_token claims are not a
-- sufficient source: Microsoft guarantees neither that `email` is present nor that
-- `preferred_username` is mail-shaped, and a work/school UPN is frequently not a
-- routable mailbox. The address therefore comes from Graph GET /me.
--
-- Per Microsoft's 'Get user' reference, GET /me requires a DELEGATED permission
-- (application permissions are not supported on /me at all), and the least
-- privileged one is User.Read for BOTH work/school and personal Microsoft accounts.
-- Mail.Read does not grant it.
--
-- 20260921000000 excluded User.Read from the connection allowlist and from the
-- finalization RPC's normalization, so finalize_microsoft_connection returned
-- forbidden_scope for the very permission the flow needs. That migration is already
-- applied and is NOT edited; this is a forward migration.
--
-- id, mail and userPrincipalName are DEFAULT properties of the user resource, so
-- the $select used by the callback narrows the response without requiring any
-- additional privilege.
--
-- SCOPE OF THIS CHANGE
-- --------------------
--   * the connection CHECK allowlist gains exactly 'User.Read';
--   * the RPC normalizes 'user.read' and its Graph-prefixed spelling to 'User.Read';
--   * an ACTIVE connection must now hold User.Read as well as Mail.Read, because a
--     connection that could not resolve its own ms_email is not a working one;
--   * everything else is unchanged: atomic single-use state consumption under
--     FOR UPDATE, the same-account reconnect rule, SECURITY DEFINER with
--     SET search_path = '', the service-role-only EXECUTE grant, and every other
--     refusal (invalid_state, unknown_state, state_consumed, state_expired,
--     user_mismatch, invalid_account_type, invalid_email, invalid_scopes,
--     forbidden_scope, missing_mail_read, refresh_token_required, account_mismatch).
--
-- STILL FORBIDDEN, and asserted by tests: User.ReadWrite, User.ReadBasic.All,
-- User.Read.All, Directory.Read.All, Mail.ReadWrite, Mail.Send, Mail.ReadBasic,
-- MailboxSettings.*, Files.*, Contacts.*, Calendars.*, .default and every *.All.
--
-- SAFETY: microsoft_connections holds zero rows (Outlook is dormant and no OAuth
-- flow has ever completed), so tightening the active-connection requirement cannot
-- invalidate existing data. The CHECK is replaced rather than added to, because a
-- second overlapping allowlist CHECK would be harder to reason about.
--
-- NOT APPLIED to Production by this branch.
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Connection scope allowlist: add User.Read ─────────────────────────────
ALTER TABLE public.microsoft_connections
  DROP CONSTRAINT IF EXISTS microsoft_connections_scopes_allowlist;
ALTER TABLE public.microsoft_connections
  ADD CONSTRAINT microsoft_connections_scopes_allowlist
  CHECK (pg_catalog.array_length(scopes, 1) BETWEEN 1 AND 8
         AND scopes <@ ARRAY['Mail.Read', 'User.Read', 'offline_access', 'openid', 'email', 'profile']::text[]);

-- ── 2. An active connection needs BOTH Mail.Read and User.Read ───────────────
-- Mail.Read to read messages; User.Read because the connection's own ms_email is
-- resolved from GET /me and cannot be obtained without it.
ALTER TABLE public.microsoft_connections
  DROP CONSTRAINT IF EXISTS microsoft_connections_active_requires_mail_read;
ALTER TABLE public.microsoft_connections
  ADD CONSTRAINT microsoft_connections_active_requires_mail_read
  CHECK (status <> 'active'
         OR ('Mail.Read' = ANY (scopes) AND 'User.Read' = ANY (scopes)));

COMMENT ON CONSTRAINT microsoft_connections_scopes_allowlist ON public.microsoft_connections IS
  'Canonical delegated permissions only: Mail.Read + User.Read + minimal identity/offline scopes.';

-- ── 3. Finalization RPC: normalize User.Read, require it for active ──────────
-- CREATE OR REPLACE with the IDENTICAL signature, so the existing ACL is
-- preserved; the REVOKE/GRANT below is re-asserted anyway so the grant model is
-- explicit in this migration rather than inherited silently.
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
    -- MailboxSettings.*, Files.*, Contacts.*, Calendars.*, .default, *.All, User.Read, …)
    -- refuses activation. Broader permissions are never stored "as granted".
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

  -- 5. Connection + tokens (consent evidence copied from the state row).
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

COMMIT;
