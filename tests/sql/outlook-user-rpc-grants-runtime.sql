-- Runtime verification for the Outlook PR-A1 grant correction (20260922175616).
--
-- RUN ONLY AGAINST A DISPOSABLE LOCAL SUPABASE STACK, in this order:
--   1. `supabase db reset --local` with ONLY the 19 migrations through 20260921000000
--      (move the new migration aside first) — this is the "19-migration main state";
--   2. docker cp tests/sql/outlook-user-rpc-grants-runtime.sql supabase_db_<project>:/tmp/
--      docker exec … psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/outlook-user-rpc-grants-runtime.sql
-- The script itself reproduces PRODUCTION'S PRE-FIX ACL (local default privileges do
-- NOT grant service_role, so the fix would be untestable otherwise), snapshots the full
-- catalog, applies ONLY the new forward migration, and proves the exact delta.
-- NEVER run against a linked/Production database. Every assertion RAISEs on failure.

\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

BEGIN;

-- ── 0. Sanity: the 19-migration state, zero Outlook rows ─────────────────────
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname IN ('accept_new_contact_candidate','dismiss_new_contact_candidate','defer_candidate','disconnect_my_outlook')) = 4,
         'the four user RPCs must exist (run the 19-migration reset first)';
  ASSERT (SELECT count(*) FROM public.new_contact_candidates) = 0
     AND (SELECT count(*) FROM public.microsoft_connections) = 0
     AND (SELECT count(*) FROM public.microsoft_tokens) = 0
     AND (SELECT count(*) FROM public.microsoft_oauth_states) = 0
     AND (SELECT count(*) FROM public.outlook_sync_state) = 0
     AND (SELECT count(*) FROM public.outlook_candidate_refs) = 0, 'zero Outlook rows expected before the fix';
END $$;

-- ── 1. PRODUCTION-LIKE PRE-FIX ACL ───────────────────────────────────────────
-- Production's pg_default_acl grants service_role EXECUTE on every function created
-- by postgres in `public`; the local stack's defaults differ, so reproduce it here.
GRANT EXECUTE ON FUNCTION public.accept_new_contact_candidate(
  uuid, text, text, text, text, text, text[], text, text, boolean, text, date, text, date
) TO service_role;
GRANT EXECUTE ON FUNCTION public.dismiss_new_contact_candidate(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.defer_candidate(text, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.disconnect_my_outlook() TO service_role;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['accept_new_contact_candidate','dismiss_new_contact_candidate','defer_candidate','disconnect_my_outlook'] LOOP
    ASSERT has_function_privilege('service_role', ('public.'||f)::regproc, 'EXECUTE'), 'pre-fix state not reproduced for ' || f;
    ASSERT has_function_privilege('authenticated', ('public.'||f)::regproc, 'EXECUTE'), 'authenticated must already hold EXECUTE on ' || f;
  END LOOP;
END $$;

-- Full catalog snapshot BEFORE the fix (functions, tables, policies, indexes,
-- constraints, columns, triggers, owners, RLS).
CREATE TEMP TABLE snap_fn AS
  SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src,
         coalesce(p.proacl::text,'') AS acl, pg_get_userbyid(p.proowner) AS owner, p.prosecdef,
         coalesce(array_to_string(p.proconfig,','),'') AS cfg
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';
CREATE TEMP TABLE snap_tbl AS
  SELECT c.relname, coalesce(c.relacl::text,'') AS acl, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r';
CREATE TEMP TABLE snap_pol AS SELECT policyname, tablename, coalesce(qual,'') AS qual, coalesce(with_check,'') AS wc FROM pg_policies WHERE schemaname='public';
CREATE TEMP TABLE snap_idx AS SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname='public';
CREATE TEMP TABLE snap_con AS SELECT conname, conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace='public'::regnamespace;
CREATE TEMP TABLE snap_col AS SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public';
CREATE TEMP TABLE snap_trg AS SELECT tgname, tgrelid::regclass::text AS tbl FROM pg_trigger WHERE NOT tgisinternal;
CREATE TEMP TABLE snap_defacl AS SELECT defaclrole, defaclnamespace, defaclobjtype, defaclacl::text AS acl FROM pg_default_acl;
CREATE TEMP TABLE snap_rows AS SELECT
  (SELECT count(*) FROM public.microsoft_connections) AS mc, (SELECT count(*) FROM public.microsoft_tokens) AS mt,
  (SELECT count(*) FROM public.microsoft_oauth_states) AS mo, (SELECT count(*) FROM public.outlook_sync_state) AS os,
  (SELECT count(*) FROM public.outlook_candidate_refs) AS ocr, (SELECT count(*) FROM public.new_contact_candidates) AS ncc,
  (SELECT count(*) FROM public.interaction_candidates) AS ic, (SELECT count(*) FROM public.interactions) AS i,
  (SELECT count(*) FROM public.contacts) AS c;

-- ── 2. apply ONLY the new forward migration ──────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.accept_new_contact_candidate(
  uuid, text, text, text, text, text, text[], text, text, boolean, text, date, text, date
) FROM service_role;
REVOKE EXECUTE ON FUNCTION public.dismiss_new_contact_candidate(uuid) FROM service_role;
REVOKE EXECUTE ON FUNCTION public.defer_candidate(text, uuid, timestamptz) FROM service_role;
REVOKE EXECUTE ON FUNCTION public.disconnect_my_outlook() FROM service_role;

-- ── 3. service_role lost EXECUTE on exactly the four user RPCs ───────────────
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['accept_new_contact_candidate','dismiss_new_contact_candidate','defer_candidate','disconnect_my_outlook'] LOOP
    ASSERT NOT has_function_privilege('service_role', ('public.'||f)::regproc, 'EXECUTE'), 'service_role still executes ' || f;
    ASSERT has_function_privilege('authenticated', ('public.'||f)::regproc, 'EXECUTE'), 'authenticated lost EXECUTE on ' || f;
    ASSERT NOT has_function_privilege('anon', ('public.'||f)::regproc, 'EXECUTE'), 'anon executes ' || f;
    ASSERT (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) a
                               WHERE p.oid = ('public.'||f)::regproc AND a.grantee = 0)), 'PUBLIC executes ' || f;
    ASSERT (SELECT proacl::text FROM pg_proc WHERE oid = ('public.'||f)::regproc) = '{postgres=X/postgres,authenticated=X/postgres}',
           f || ' final ACL is ' || (SELECT coalesce(proacl::text,'NULL') FROM pg_proc WHERE oid = ('public.'||f)::regproc);
  END LOOP;
END $$;

-- ── 4. worker RPCs unchanged (service_role only), review RPC ACLs unchanged ──
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['finalize_microsoft_connection','update_microsoft_connection_state','reserve_due_outlook_connection',
                           'renew_outlook_sync_lease','release_outlook_sync_lease','invalidate_outlook_candidates_by_fingerprint',
                           'run_microsoft_local_cleanup','expire_pending_outlook_context'] LOOP
    ASSERT has_function_privilege('service_role', ('public.'||f)::regproc, 'EXECUTE'), 'service_role lost EXECUTE on worker fn ' || f;
    ASSERT NOT has_function_privilege('authenticated', ('public.'||f)::regproc, 'EXECUTE'), 'authenticated executes worker fn ' || f;
    ASSERT NOT has_function_privilege('anon', ('public.'||f)::regproc, 'EXECUTE'), 'anon executes worker fn ' || f;
    ASSERT (SELECT proacl::text FROM pg_proc WHERE oid = ('public.'||f)::regproc) = '{postgres=X/postgres,service_role=X/postgres}',
           f || ' worker ACL drifted: ' || (SELECT coalesce(proacl::text,'NULL') FROM pg_proc WHERE oid = ('public.'||f)::regproc);
  END LOOP;
  -- review RPC ACLs unchanged (authenticated + service_role, exactly as before)
  FOREACH f IN ARRAY ARRAY['accept_interaction_candidate','dismiss_interaction_candidate'] LOOP
    ASSERT (SELECT proacl::text FROM pg_proc WHERE oid = ('public.'||f)::regproc) = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
           f || ' review ACL drifted: ' || (SELECT coalesce(proacl::text,'NULL') FROM pg_proc WHERE oid = ('public.'||f)::regproc);
  END LOOP;
END $$;

-- ── 5. ACL delta is EXACTLY the four user RPCs; source hashes unchanged ──────
DO $$
DECLARE n integer; names text;
BEGIN
  SELECT count(*), coalesce(string_agg(s.proname, ','), '') INTO n, names
  FROM snap_fn s JOIN pg_proc p ON p.oid = s.oid
  WHERE coalesce(p.proacl::text,'') <> s.acl;
  ASSERT n = 4, 'ACL changed on ' || n || ' functions: ' || names;
  ASSERT names ~ 'accept_new_contact_candidate' AND names ~ 'dismiss_new_contact_candidate'
     AND names ~ 'defer_candidate' AND names ~ 'disconnect_my_outlook', 'unexpected functions changed: ' || names;

  -- no function dropped, added, recreated or re-owned; bodies byte-identical
  ASSERT (SELECT count(*) FROM snap_fn) = (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public'),
         'function count changed';
  SELECT count(*) INTO n FROM snap_fn s LEFT JOIN pg_proc p ON p.oid = s.oid
   WHERE p.oid IS NULL OR md5(p.prosrc) <> s.src OR pg_get_function_identity_arguments(p.oid) <> s.args
      OR pg_get_userbyid(p.proowner) <> s.owner OR p.prosecdef <> s.prosecdef OR coalesce(array_to_string(p.proconfig,','),'') <> s.cfg;
  ASSERT n = 0, n || ' functions had source hashes unchanged violated (body/args/owner/secdef/search_path drift)';
END $$;

-- ── 6. no table ACL / policy / RLS / index / constraint / column / trigger / owner drift ──
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM snap_tbl s FULL JOIN (
    SELECT c.relname, coalesce(c.relacl::text,'') AS acl, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r') t
    ON t.relname = s.relname
   WHERE s.relname IS NULL OR t.relname IS NULL OR s.acl <> t.acl OR s.owner <> t.owner OR s.rls <> t.rls;
  ASSERT n = 0, n || ' table ACL/owner/RLS differences';
  SELECT count(*) INTO n FROM snap_pol s FULL JOIN (SELECT policyname, tablename, coalesce(qual,'') AS qual, coalesce(with_check,'') AS wc FROM pg_policies WHERE schemaname='public') p
    ON p.policyname = s.policyname AND p.tablename = s.tablename
   WHERE s.policyname IS NULL OR p.policyname IS NULL OR s.qual <> p.qual OR s.wc <> p.wc;
  ASSERT n = 0, n || ' policy differences';
  SELECT count(*) INTO n FROM snap_idx s FULL JOIN (SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname='public') i
    ON i.indexname = s.indexname WHERE s.indexname IS NULL OR i.indexname IS NULL OR s.indexdef <> i.indexdef;
  ASSERT n = 0, n || ' index differences';
  SELECT count(*) INTO n FROM snap_con s FULL JOIN (SELECT conname, conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace='public'::regnamespace) c
    ON c.conname = s.conname AND c.tbl = s.tbl WHERE s.conname IS NULL OR c.conname IS NULL OR s.def <> c.def;
  ASSERT n = 0, n || ' constraint differences';
  SELECT count(*) INTO n FROM snap_col s FULL JOIN (SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public') c
    ON c.table_name = s.table_name AND c.column_name = s.column_name
   WHERE s.table_name IS NULL OR c.table_name IS NULL OR s.data_type <> c.data_type OR s.is_nullable <> c.is_nullable;
  ASSERT n = 0, n || ' column differences';
  SELECT count(*) INTO n FROM snap_trg s FULL JOIN (SELECT tgname, tgrelid::regclass::text AS tbl FROM pg_trigger WHERE NOT tgisinternal) t
    ON t.tgname = s.tgname AND t.tbl = s.tbl WHERE s.tgname IS NULL OR t.tgname IS NULL;
  ASSERT n = 0, n || ' trigger differences';
  -- default privileges must be untouched by this migration
  SELECT count(*) INTO n FROM snap_defacl s FULL JOIN (SELECT defaclrole, defaclnamespace, defaclobjtype, defaclacl::text AS acl FROM pg_default_acl) d
    ON d.defaclrole = s.defaclrole AND d.defaclnamespace = s.defaclnamespace AND d.defaclobjtype = s.defaclobjtype
   WHERE s.defaclrole IS NULL OR d.defaclrole IS NULL OR s.acl <> d.acl;
  ASSERT n = 0, n || ' pg_default_acl differences (the migration must not change default privileges)';
END $$;

-- ── 7. zero Outlook rows and no data mutation ────────────────────────────────
DO $$
DECLARE s snap_rows%ROWTYPE;
BEGIN
  SELECT * INTO s FROM snap_rows;
  ASSERT (SELECT count(*) FROM public.microsoft_connections) = s.mc
     AND (SELECT count(*) FROM public.microsoft_tokens) = s.mt
     AND (SELECT count(*) FROM public.microsoft_oauth_states) = s.mo
     AND (SELECT count(*) FROM public.outlook_sync_state) = s.os
     AND (SELECT count(*) FROM public.outlook_candidate_refs) = s.ocr
     AND (SELECT count(*) FROM public.new_contact_candidates) = s.ncc
     AND (SELECT count(*) FROM public.interaction_candidates) = s.ic
     AND (SELECT count(*) FROM public.interactions) = s.i
     AND (SELECT count(*) FROM public.contacts) = s.c, 'row counts changed';
  ASSERT s.mc = 0 AND s.mt = 0 AND s.mo = 0 AND s.os = 0 AND s.ocr = 0 AND s.ncc = 0, 'Outlook tables must be empty';
END $$;

ROLLBACK;   -- the harness proves the delta; it leaves the stack exactly as it found it

SELECT 'outlook-user-rpc-grants-runtime: all assertions passed';
