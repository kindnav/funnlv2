-- Outlook — a read path for "is my mailbox connected?", for the signed-in user.
--
-- WHY THIS EXISTS (verified against the applied catalog, not assumed):
--   The Settings page must show whether Outlook is connected before it can offer
--   to disconnect. It cannot read public.microsoft_connections directly. RLS is
--   enabled on that table and it has a SELECT policy for the owner, but the
--   `authenticated` role holds NO table privilege on it at all:
--     SELECT grantee, privilege_type FROM information_schema.role_table_grants
--      WHERE table_name = 'microsoft_connections';
--     -- returns only postgres and service_role
--   A policy without a grant denies. So a browser query would fail with
--   permission denied, and the only alternatives are to widen the table grant
--   (exposing every column, including the operational token metadata) or to add
--   a narrow function. This adds the narrow function.
--
--   This is the ONE thing the disconnect slice needed a migration for. The
--   removal behaviour did NOT need one: the applied disconnect_my_outlook()
--   already deletes the connection, the encrypted tokens, the sync cursors and
--   leases, unconsumed OAuth states and the mail-to-suggestion links, and
--   already invalidates pending suggestions. That was verified on a disposable
--   database by tests/sql/outlook-disconnect-runtime.sql rather than asserted.
--
-- WHAT IT RETURNS, AND WHAT IT DELIBERATELY DOES NOT
--   Returns only what the Settings card displays: which mailbox is connected,
--   whether it needs re-consent, when it was connected, the consent version
--   recorded at the time, and the granted scopes.
--   It NEVER returns a token, a ciphertext, a nonce, a key version, a state
--   hash, the connection id, the Microsoft account or tenant id, or a sync
--   cursor. Those are not needed to render the card, so they are not exposed.
--
-- AUTHORISATION
--   The caller is derived solely from (SELECT auth.uid()). The function takes no
--   arguments, so no caller can ask about another user's mailbox. With no
--   session it returns the controlled 'unauthorized' code and reads nothing.
--   It is STABLE and performs no writes.
--
-- GRANTS — follows the FUTURE RULE recorded in 20260922175616:
--   this project's pre-existing default privileges grant EXECUTE to anon,
--   authenticated AND service_role on every function created here, so a
--   user-only function must explicitly revoke from PUBLIC, anon and
--   service_role after creation. service_role is revoked because a service-role
--   call resolves auth.uid() to NULL and could never do anything useful anyway.
--
-- SCOPE: creates one function and sets its grants. It changes no table, column,
-- constraint, index, policy, trigger, owner, RLS setting or table grant, alters
-- no other function, performs no DML, and does not touch Gmail or Calendar.
-- Outlook stays dormant: nothing calls this until the Settings flag is on.
--
-- NOT APPLIED. Do not run against Production without explicit approval.

CREATE OR REPLACE FUNCTION public.get_my_outlook_connection()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_row public.microsoft_connections%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('result', 'unauthorized');
  END IF;

  SELECT * INTO v_row
    FROM public.microsoft_connections
   WHERE user_id = v_uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_connected');
  END IF;

  RETURN jsonb_build_object(
    'result',                 'connected',
    'mailbox',                v_row.ms_email,
    'account_type',           v_row.account_type,
    'status',                 v_row.status,
    'needs_reauth',           v_row.needs_reauth,
    'connected_at',           v_row.connected_at,
    'consent_policy_version', v_row.consent_policy_version,
    'scopes',                 to_jsonb(v_row.scopes)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_outlook_connection()
  FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.get_my_outlook_connection() TO authenticated;


-- ══════════════════════════════════════════════════════════════════════════════
--  POST-APPLY VERIFICATION (read-only; run manually after `db push`)
-- ══════════════════════════════════════════════════════════════════════════════
--   -- authenticated only, and SECURITY DEFINER with a pinned search_path
--   SELECT proname, prosecdef, proconfig, proacl
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND proname = 'get_my_outlook_connection';
--   -- expect prosecdef = t, proconfig = {search_path=}, and
--   --        {postgres=X/postgres,authenticated=X/postgres}
--
--   -- no session: the controlled refusal, and no row read
--   SELECT public.get_my_outlook_connection();   -- {"result": "unauthorized"}
--
--   -- the table grant is unchanged (still no authenticated privilege)
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name = 'microsoft_connections';
--
--   SELECT count(*) FROM public.microsoft_connections;   -- still 0
