-- Outlook — a read path for "is my mailbox connected?", for the signed-in user.
--
-- WHY THIS EXISTS.
--   The Settings page must show whether Outlook is connected before it can offer
--   to disconnect.
--
-- CORRECTION TO AN EARLIER VERSION OF THIS COMMENT, which said the browser "cannot
-- read public.microsoft_connections directly" because "a policy without a grant
-- denies". That was WRONG, and the mistake was reading
-- information_schema.role_table_grants (which shows only TABLE-level grants) and
-- generalising from a PostgREST 403 on `select=*`. Measured afterwards on a
-- disposable database with real roles:
--   * there is indeed no TABLE-level grant for `authenticated`, so `select=*` and
--     any select naming a withheld column returns 42501;
--   * but `authenticated` DOES hold COLUMN-level SELECT on exactly the non-secret
--     columns - ms_email, status, needs_reauth, connected_at, consented_at,
--     consent_policy_version, scopes, account_type, last_result_code,
--     last_success_at, updated_at - and `select=ms_email,status,needs_reauth`
--     returns 200 through PostgREST, scoped to the owner by RLS.
--   So the browser CAN already read the reviewable columns. This function was not
--   strictly necessary.
--
-- WHY IT IS STILL WORTH HAVING, stated as a preference rather than a necessity:
--   it is one named contract instead of a column list duplicated in the client, it
--   cannot be widened by someone adding a column to the select, and the allowlist
--   test over its returned keys fails when a new field appears. A column grant
--   gives none of those. If a reviewer prefers the direct select, this migration can
--   be dropped without affecting the disconnect path.
--
--   The removal behaviour needed no migration either: the applied
--   disconnect_my_outlook()
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
