-- Outlook PR-A1 — least-privilege correction: revoke service_role EXECUTE from the
-- four Outlook USER-ACTION RPCs.
--
-- ROOT CAUSE (confirmed against the live catalog, not assumed):
--   This project carries pre-existing default privileges for the `public` schema —
--   `pg_default_acl` for objtype 'f' grants EXECUTE to anon, authenticated AND
--   service_role on every function created by `postgres` (and by `supabase_admin`).
--   Migration 20260921000000 created the four user-action RPCs and explicitly ran
--   `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon` (so PUBLIC and anon hold nothing,
--   verified), then granted `authenticated`. It did NOT name service_role, so the
--   grant that the default ACL had already applied at CREATE time survived. The
--   result in Production is
--     {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   where the reviewed contract is authenticated-only. The eight worker/callback
--   RPCs are unaffected: they revoke `FROM PUBLIC, anon, authenticated` and are
--   intentionally service_role-executable.
--
-- IMPACT OF THE MISMATCH: low, not a data-exposure bug. Each of these functions
-- derives its caller solely from `(SELECT auth.uid())` and accepts no user id, so a
-- service_role call resolves to NULL and returns the controlled 'unauthenticated' /
-- 'unauthorized' code without touching a row. This migration is contract alignment
-- and least privilege, not incident remediation.
--
-- SCOPE (deliberately minimal — nothing else may change):
--   * REVOKE EXECUTE from service_role on exactly the four user-action signatures
--     below, schema-qualified, with the exact argument types taken from the applied
--     migration / pg_proc.
--   * It does NOT alter project-wide default privileges (no ALTER DEFAULT
--     PRIVILEGES): those defaults are Supabase platform configuration shared with
--     every other object in this project, and changing them here would silently
--     affect unrelated future functions. Per-object REVOKE is the documented way to
--     narrow a privilege that a default ACL already granted.
--   * It does NOT touch the eight worker/callback RPCs, the two recreated review
--     RPCs (accept_/dismiss_interaction_candidate), authenticated access, PUBLIC or
--     anon (already absent — re-verified by the accompanying tests), any function
--     body, table, column, constraint, index, policy, trigger, owner, RLS setting or
--     table grant, and it performs no DML, scheduler, extension or provider work.
--     Gmail and Calendar are untouched. Outlook stays dormant.
--
-- FUTURE RULE: every new user-only (authenticated) function in this project must
-- explicitly `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, service_role` after
-- creation, because the default ACL will otherwise grant service_role EXECUTE again.
-- (Worker/callback functions keep revoking FROM PUBLIC, anon, authenticated.)
--
-- Idempotent: REVOKE on a privilege that is already absent is a no-op.

REVOKE EXECUTE ON FUNCTION public.accept_new_contact_candidate(
  uuid, text, text, text, text, text, text[], text, text, boolean, text, date, text, date
) FROM service_role;

REVOKE EXECUTE ON FUNCTION public.dismiss_new_contact_candidate(uuid) FROM service_role;

REVOKE EXECUTE ON FUNCTION public.defer_candidate(text, uuid, timestamptz) FROM service_role;

REVOKE EXECUTE ON FUNCTION public.disconnect_my_outlook() FROM service_role;


-- ══════════════════════════════════════════════════════════════════════════════
--  POST-APPLY VERIFICATION (read-only; run manually after `db push`)
-- ══════════════════════════════════════════════════════════════════════════════
--   -- the four user RPCs: authenticated only
--   SELECT proname, proacl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND proname IN ('accept_new_contact_candidate','dismiss_new_contact_candidate',
--                      'defer_candidate','disconnect_my_outlook');
--   -- expect {postgres=X/postgres,authenticated=X/postgres} for each
--
--   -- the eight worker RPCs: service_role only (unchanged)
--   SELECT proname, proacl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND proname IN ('finalize_microsoft_connection','update_microsoft_connection_state',
--                      'reserve_due_outlook_connection','renew_outlook_sync_lease',
--                      'release_outlook_sync_lease','invalidate_outlook_candidates_by_fingerprint',
--                      'run_microsoft_local_cleanup','expire_pending_outlook_context');
--
--   -- review RPCs unchanged: {postgres,authenticated,service_role}
--   SELECT proname, proacl FROM pg_proc WHERE proname IN
--     ('accept_interaction_candidate','dismiss_interaction_candidate');
--
--   SELECT count(*) FROM public.new_contact_candidates;   -- still 0
