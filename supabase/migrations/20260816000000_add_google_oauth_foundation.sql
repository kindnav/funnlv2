-- Google integration — Phase 0A: OAuth connection foundation.
--
-- SCOPE (Phase 0A only): store the state needed to connect ONE Google Calendar
-- account to a Funnl user and hold its encrypted tokens. This migration adds NO
-- event/candidate/sync tables, NO scheduler, and NO Gmail objects.
--
-- DESIGN CONSTRAINTS (permanent — do not change without approval):
--   - One connected Google account per Funnl user (MVP): UNIQUE (user_id) on
--     google_connections.
--   - Tokens are NEVER stored on google_connections. They live only in
--     google_tokens, which authenticated users can never read (RLS on, no
--     policies, no GRANT) — service-role Edge code only.
--   - The raw OAuth state value is NEVER stored — only its SHA-256 hash. The
--     PKCE verifier is stored ENCRYPTED. States are single-use and expiring.
--   - All mutations happen server-side via the service-role key. Authenticated
--     users may SELECT only their own NON-SECRET connection status.
--   - This migration is intentionally NOT deployed by this phase.
--
-- Follows the existing hardening pattern (see 20260727000000_add_pro_trials.sql):
-- REVOKE ALL from every role, then GRANT only what is needed; service_role gets
-- GRANT ALL so Edge Functions can write.

-- ── 1. google_connections — non-secret connection status (one per user) ───────

CREATE TABLE public.google_connections (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  google_sub       text        NOT NULL,   -- Google account id ('sub'); stable identity
  google_email     text        NOT NULL,   -- connected Google address (display only)
  scopes           text[]      NOT NULL,   -- granted scopes
  status           text        NOT NULL DEFAULT 'active',
  token_expires_at timestamptz,            -- access-token expiry (advisory)
  connected_at     timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT google_connections_status_check
    CHECK (status IN ('active', 'needs_reauth', 'revoked')),
  -- MVP cardinality: at most one connected Google account per Funnl user.
  CONSTRAINT google_connections_user_unique UNIQUE (user_id)
);

CREATE INDEX google_connections_google_sub_idx
  ON public.google_connections (google_sub);

ALTER TABLE public.google_connections ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.google_connections FROM PUBLIC;
REVOKE ALL ON TABLE public.google_connections FROM anon;
REVOKE ALL ON TABLE public.google_connections FROM authenticated;
GRANT SELECT ON TABLE public.google_connections TO authenticated;
GRANT ALL    ON TABLE public.google_connections TO service_role;

-- Users may read ONLY their own connection status. No write policy — all writes
-- go through service-role Edge Functions.
CREATE POLICY "google_connections_select_own"
  ON public.google_connections
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);


-- ── 2. google_tokens — encrypted OAuth tokens (service-role ONLY) ─────────────
--
-- RLS is enabled with NO policies and NO grant to authenticated/anon, so the
-- authenticated role can never read a token row. Only service_role (which
-- bypasses RLS and holds GRANT ALL) may touch this table. Tokens must never be
-- selected from the frontend.

CREATE TABLE public.google_tokens (
  connection_id            uuid        PRIMARY KEY
                                       REFERENCES public.google_connections(id) ON DELETE CASCADE,
  access_token_ciphertext  text        NOT NULL,
  access_token_nonce       text        NOT NULL,
  refresh_token_ciphertext text,
  refresh_token_nonce      text,
  key_version              smallint    NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- Refresh ciphertext + nonce are both-null or both-set.
  CONSTRAINT google_tokens_refresh_pair_check
    CHECK (
      (refresh_token_ciphertext IS NULL AND refresh_token_nonce IS NULL) OR
      (refresh_token_ciphertext IS NOT NULL AND refresh_token_nonce IS NOT NULL)
    )
);

ALTER TABLE public.google_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.google_tokens FROM PUBLIC;
REVOKE ALL ON TABLE public.google_tokens FROM anon;
REVOKE ALL ON TABLE public.google_tokens FROM authenticated;
GRANT ALL  ON TABLE public.google_tokens TO service_role;
-- Intentionally NO GRANT and NO POLICY for authenticated: unreadable by clients.


-- ── 3. google_oauth_states — one-time CSRF/PKCE state (service-role ONLY) ──────
--
-- The raw state returned to Google is never stored — only its SHA-256 hash. The
-- PKCE verifier is stored encrypted. Rows are single-use (consumed_at) and expire
-- (expires_at). RLS on, no policies, no client grant.

CREATE TABLE public.google_oauth_states (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash               text        NOT NULL UNIQUE,  -- SHA-256 hex of raw state
  user_id                  uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pkce_verifier_ciphertext text        NOT NULL,
  pkce_verifier_nonce      text        NOT NULL,
  key_version              smallint    NOT NULL DEFAULT 1,
  return_origin            text        NOT NULL,         -- server-validated https origin
  integration_type         text        NOT NULL DEFAULT 'calendar',
  expires_at               timestamptz NOT NULL,
  consumed_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT google_oauth_states_integration_check
    CHECK (integration_type IN ('calendar')),
  CONSTRAINT google_oauth_states_return_origin_https
    CHECK (return_origin LIKE 'https://%')
);

CREATE INDEX google_oauth_states_expires_idx
  ON public.google_oauth_states (expires_at);

ALTER TABLE public.google_oauth_states ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.google_oauth_states FROM PUBLIC;
REVOKE ALL ON TABLE public.google_oauth_states FROM anon;
REVOKE ALL ON TABLE public.google_oauth_states FROM authenticated;
GRANT ALL  ON TABLE public.google_oauth_states TO service_role;
-- Intentionally NO GRANT and NO POLICY for authenticated.


-- ── 4. store_google_connection() — atomic connection + token persistence ──────
--
-- Writes the non-secret connection row AND the encrypted token row in a SINGLE
-- transaction (a plpgsql function is one transaction), so a failure rolls BOTH
-- back — the callback can never leave an active connection without its tokens.
--
-- Tokens are passed ALREADY ENCRYPTED (ciphertext + nonce). Plaintext tokens are
-- NEVER passed into the database; encryption stays in the Edge Function.
--
-- SECURITY DEFINER + fixed empty search_path + fully-qualified objects. Callable
-- only by service_role (the Edge Function's admin client). Returns the connection id.

CREATE OR REPLACE FUNCTION public.store_google_connection(
  p_user_id          uuid,
  p_google_sub       text,
  p_google_email     text,
  p_scopes           text[],
  p_status           text,
  p_token_expires_at timestamptz,
  p_access_ct        text,
  p_access_nonce     text,
  p_refresh_ct       text,
  p_refresh_nonce    text,
  p_key_version      smallint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conn_id uuid;
BEGIN
  INSERT INTO public.google_connections
    (user_id, google_sub, google_email, scopes, status, token_expires_at, updated_at)
  VALUES
    (p_user_id, p_google_sub, p_google_email, p_scopes, p_status, p_token_expires_at, now())
  ON CONFLICT (user_id) DO UPDATE
    SET google_sub       = EXCLUDED.google_sub,
        google_email     = EXCLUDED.google_email,
        scopes           = EXCLUDED.scopes,
        status           = EXCLUDED.status,
        token_expires_at = EXCLUDED.token_expires_at,
        updated_at       = now()
  RETURNING id INTO v_conn_id;

  INSERT INTO public.google_tokens
    (connection_id, access_token_ciphertext, access_token_nonce,
     refresh_token_ciphertext, refresh_token_nonce, key_version, updated_at)
  VALUES
    (v_conn_id, p_access_ct, p_access_nonce, p_refresh_ct, p_refresh_nonce, p_key_version, now())
  ON CONFLICT (connection_id) DO UPDATE
    SET access_token_ciphertext  = EXCLUDED.access_token_ciphertext,
        access_token_nonce       = EXCLUDED.access_token_nonce,
        refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
        refresh_token_nonce      = EXCLUDED.refresh_token_nonce,
        key_version              = EXCLUDED.key_version,
        updated_at               = now();

  RETURN v_conn_id;
END;
$$;

REVOKE ALL ON FUNCTION public.store_google_connection(
  uuid, text, text, text[], text, timestamptz, text, text, text, text, smallint
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_google_connection(
  uuid, text, text, text[], text, timestamptz, text, text, text, text, smallint
) TO service_role;
