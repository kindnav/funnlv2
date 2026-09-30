-- Outlook — persist a refreshed access token (and a rotated refresh token).
--
-- WHY THIS EXISTS. The applied schema can CREATE a token row
-- (finalize_microsoft_connection, at connect time) but has no way to UPDATE one. A
-- worker that refreshes an expired access token must be able to store the result, or
-- every run would refresh again from scratch and a rotated refresh token would be lost
-- the moment Microsoft issued one - which would break the connection permanently,
-- because Microsoft invalidates the old refresh token when it rotates.
--
-- THE ROTATION RULE THIS ENCODES. Microsoft MAY return a new refresh token on a
-- refresh and may equally omit it. So the refresh pair is OPTIONAL here:
--   * both p_refresh_ct and p_refresh_nonce given -> the stored refresh token is
--     replaced;
--   * both NULL -> the stored refresh token is LEFT ALONE, because the existing one is
--     still valid;
--   * exactly one given -> refused as 'invalid_refresh_pair'. A half-written pair
--     cannot be decrypted, and the table's own CHECK would reject it anyway; refusing
--     here makes the reason legible instead of surfacing a constraint error.
--
-- LEASE FENCING, the same shape as upsert_outlook_interaction_candidate and
-- invalidate_outlook_candidates_by_fingerprint: both `outlook_sync_state` rows are
-- locked FOR SHARE first, then the run must own BOTH of them with a live lease.
-- A worker whose lease expired must not still be rewriting credentials - another run
-- may already have refreshed them, and the later write would clobber a newer token.
--
-- SCOPE. It writes exactly two things: the token row for one connection, and that
-- connection's token_expires_at. It never touches scopes, status, needs_reauth,
-- consent, cursors, candidates, contacts or interactions. It cannot create a token row
-- (a connection with no row is a broken connection, not something to paper over).
--
-- GRANTS. service_role only. Per the FUTURE RULE recorded in 20260922175616 the revoke
-- names PUBLIC, anon AND authenticated explicitly, because this project's default
-- privileges would otherwise grant all three at CREATE time. A user must never be able
-- to write a credential.
--
-- NO PLAINTEXT EVER REACHES THIS FUNCTION. It takes ciphertext and nonces that the
-- caller produced with the token-encryption key; the database has no key and cannot
-- read a token.
--
-- NOT APPLIED. Do not run against Production without explicit approval.

CREATE OR REPLACE FUNCTION public.rotate_microsoft_access_token(
  p_connection_id    uuid,
  p_run_id           uuid,
  p_access_ct        text,
  p_access_nonce     text,
  p_refresh_ct       text,
  p_refresh_nonce    text,
  p_key_version      smallint,
  p_token_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid     uuid;
  v_leaseok boolean;
  v_n       integer;
BEGIN
  -- ── shape validation, before any lock ─────────────────────────────────────
  IF p_access_ct IS NULL OR length(p_access_ct) = 0
     OR p_access_nonce IS NULL OR length(p_access_nonce) = 0 THEN
    RETURN jsonb_build_object('result', 'invalid_access_pair');
  END IF;
  IF (p_refresh_ct IS NULL) <> (p_refresh_nonce IS NULL) THEN
    RETURN jsonb_build_object('result', 'invalid_refresh_pair');
  END IF;
  IF p_key_version IS NULL OR p_key_version < 1 THEN
    RETURN jsonb_build_object('result', 'invalid_key_version');
  END IF;
  IF p_token_expires_at IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_expiry');
  END IF;

  -- ── lease fence: the run must own BOTH folders ────────────────────────────
  PERFORM 1 FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id FOR SHARE;

  SELECT c.user_id INTO v_uid
  FROM public.microsoft_connections c WHERE c.id = p_connection_id;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('result', 'unknown_connection');
  END IF;

  SELECT count(*) = 2 AND bool_and(s.sync_run_id = p_run_id
                                   AND s.sync_status = 'running'
                                   AND s.sync_lease_until IS NOT NULL
                                   AND s.sync_lease_until > now())
    INTO v_leaseok
  FROM public.outlook_sync_state s
  WHERE s.connection_id = p_connection_id;
  IF v_leaseok IS NOT TRUE THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;

  -- ── write the new access token; replace the refresh token only if given ───
  UPDATE public.microsoft_tokens t
     SET access_token_ciphertext  = p_access_ct,
         access_token_nonce       = p_access_nonce,
         refresh_token_ciphertext = COALESCE(p_refresh_ct, t.refresh_token_ciphertext),
         refresh_token_nonce      = COALESCE(p_refresh_nonce, t.refresh_token_nonce),
         key_version              = p_key_version,
         token_expires_at         = p_token_expires_at,
         updated_at               = now()
   WHERE t.connection_id = p_connection_id
     AND t.user_id = v_uid;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    -- No token row. A connection without one cannot be refreshed into existence.
    RETURN jsonb_build_object('result', 'no_token_row');
  END IF;

  UPDATE public.microsoft_connections
     SET token_expires_at = p_token_expires_at,
         updated_at       = now()
   WHERE id = p_connection_id;

  RETURN jsonb_build_object(
    'result', 'rotated',
    'refresh_replaced', p_refresh_ct IS NOT NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_microsoft_access_token(
  uuid, uuid, text, text, text, text, smallint, timestamptz
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rotate_microsoft_access_token(
  uuid, uuid, text, text, text, text, smallint, timestamptz
) TO service_role;


-- ══════════════════════════════════════════════════════════════════════════════
--  POST-APPLY VERIFICATION (read-only; run manually after `db push`)
-- ══════════════════════════════════════════════════════════════════════════════
--   SELECT proname, prosecdef, proconfig, proacl
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND proname = 'rotate_microsoft_access_token';
--   -- expect prosecdef = t, proconfig = {search_path=}, and
--   --        {postgres=X/postgres,service_role=X/postgres}
--
--   -- applying this wrote nothing
--   SELECT count(*) FROM public.microsoft_tokens;   -- unchanged (0 in Production)
