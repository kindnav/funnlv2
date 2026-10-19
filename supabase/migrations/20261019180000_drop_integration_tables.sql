-- Stage F: drop the retired Outlook, Google Calendar and Gmail integration tables and their last functions.
--
-- FORWARD ONLY. No applied migration is edited. IRREVERSIBLE: the rows in these tables - including the
-- settled suggestion records and their proposed notes, and the one expired non-pilot Microsoft OAuth
-- state - are deleted with the tables. Nothing here exports or copies them. Recovery would need a backup,
-- and this migration does not assume one exists.
--
-- PRECONDITION (operational, see docs/stage-f-integration-tables.md): the delete-account Edge Function has
-- already been redeployed WITHOUT its Google cleanup step, so nothing deployed calls the objects dropped here.
--
-- ATOMICITY: `supabase db push` (CLI 2.109.0) sends this file and its schema_migrations row as one pgconn
-- batch closed by a single Sync - one implicit transaction. Any refusal or error below undoes everything.
--
-- KEPT (not touched): contacts, interactions (including interactions.source and its CHECK, so saved
-- records keep their "Google Calendar"/"Outlook" labels), profiles, pro_trials, subscriptions,
-- checkout_operations, stripe_webhook_events, and every remaining function and trigger. None of those
-- references an integration table (verified from the catalog; re-checked by the dependency guard below).

-- 1. Refuse unexpected or active state ------------------------------------------------------------------
DO $$
DECLARE
  v_tables text[] := ARRAY['email_candidate_refs','google_calendar_event_refs','outlook_candidate_refs',
    'outlook_round_messages','google_tokens','gmail_sync_state','google_calendar_sync_state',
    'google_connection_capabilities','outlook_subscriptions','outlook_sync_state','outlook_thread_recovery',
    'microsoft_tokens','google_oauth_states','microsoft_oauth_states','outlook_conversation_progress',
    'interaction_candidates','new_contact_candidates','google_connections','microsoft_connections'];
  -- Tables that must already be EMPTY: connections, tokens, sync state, references, subscriptions.
  v_must_be_empty text[] := ARRAY['email_candidate_refs','google_calendar_event_refs','outlook_candidate_refs',
    'outlook_round_messages','google_tokens','gmail_sync_state','google_calendar_sync_state',
    'google_connection_capabilities','outlook_subscriptions','outlook_sync_state','outlook_thread_recovery',
    'microsoft_tokens','outlook_conversation_progress','google_connections','microsoft_connections'];
  v_t text;
  v_n bigint;
  v_dep text;
BEGIN
  FOREACH v_t IN ARRAY v_must_be_empty LOOP
    IF to_regclass('public.' || v_t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', v_t) INTO v_n;
      IF v_n > 0 THEN
        RAISE EXCEPTION 'refusing to drop integration tables: public.% still holds % row(s) of active integration state', v_t, v_n;
      END IF;
    END IF;
  END LOOP;

  IF to_regclass('public.interaction_candidates') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM public.interaction_candidates WHERE status IN ('pending', 'deferred');
    IF v_n > 0 THEN RAISE EXCEPTION 'refusing: % interaction suggestion(s) are still pending review', v_n; END IF;
  END IF;
  IF to_regclass('public.new_contact_candidates') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM public.new_contact_candidates WHERE status IN ('pending', 'deferred');
    IF v_n > 0 THEN RAISE EXCEPTION 'refusing: % new-contact suggestion(s) are still pending review', v_n; END IF;
  END IF;
  -- An OAuth state that could still be completed is active state; expired ones are in the deletion scope.
  IF to_regclass('public.microsoft_oauth_states') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM public.microsoft_oauth_states WHERE expires_at > now();
    IF v_n > 0 THEN RAISE EXCEPTION 'refusing: % Microsoft OAuth state(s) have not expired', v_n; END IF;
  END IF;
  IF to_regclass('public.google_oauth_states') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM public.google_oauth_states WHERE expires_at > now();
    IF v_n > 0 THEN RAISE EXCEPTION 'refusing: % Google OAuth state(s) have not expired', v_n; END IF;
  END IF;

  IF to_regclass('cron.job') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM cron.job
     WHERE command ~ '(outlook|gmail|google_|microsoft_|interaction_candidates|new_contact_candidates|expire_pending_)';
    IF v_n > 0 THEN RAISE EXCEPTION 'refusing: % cron job(s) still reference integration objects', v_n; END IF;
  END IF;

  -- Any object OUTSIDE the integration set that depends on an integration table (a view, a foreign key
  -- from a kept table, a policy elsewhere...) would otherwise be dropped or block the DROP. Name it and stop.
  SELECT string_agg(DISTINCT pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid), '; ') INTO v_dep
  FROM pg_catalog.pg_depend d
  JOIN pg_catalog.pg_class c ON c.oid = d.refobjid AND d.refclassid = 'pg_catalog.pg_class'::regclass
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE c.relname = ANY (v_tables)
    AND d.deptype = 'n'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class oc JOIN pg_catalog.pg_namespace onn ON onn.oid = oc.relnamespace
       WHERE d.classid = 'pg_catalog.pg_class'::regclass AND oc.oid = d.objid AND onn.nspname = 'public' AND oc.relname = ANY (v_tables))
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class kc ON kc.oid = k.conrelid
       WHERE d.classid = 'pg_catalog.pg_constraint'::regclass AND k.oid = d.objid AND kc.relname = ANY (v_tables))
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class pc ON pc.oid = p.polrelid
       WHERE d.classid = 'pg_catalog.pg_policy'::regclass AND p.oid = d.objid AND pc.relname = ANY (v_tables))
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger tg JOIN pg_catalog.pg_class tc ON tc.oid = tg.tgrelid
       WHERE d.classid = 'pg_catalog.pg_trigger'::regclass AND tg.oid = d.objid AND tc.relname = ANY (v_tables));
  IF v_dep IS NOT NULL THEN
    RAISE EXCEPTION 'refusing: objects outside the integration set depend on it: %', v_dep;
  END IF;
END
$$;

-- 2. Drop the tables, children before parents, WITHOUT CASCADE ---------------------------------------
-- Their own indexes, constraints, policies, triggers and grants go with each table.
DROP TABLE IF EXISTS public.email_candidate_refs;
DROP TABLE IF EXISTS public.google_calendar_event_refs;
DROP TABLE IF EXISTS public.outlook_candidate_refs;
DROP TABLE IF EXISTS public.outlook_round_messages;
DROP TABLE IF EXISTS public.google_tokens;
DROP TABLE IF EXISTS public.gmail_sync_state;
DROP TABLE IF EXISTS public.google_calendar_sync_state;
DROP TABLE IF EXISTS public.google_connection_capabilities;
DROP TABLE IF EXISTS public.outlook_subscriptions;
DROP TABLE IF EXISTS public.outlook_sync_state;
DROP TABLE IF EXISTS public.outlook_thread_recovery;
DROP TABLE IF EXISTS public.microsoft_tokens;
DROP TABLE IF EXISTS public.google_oauth_states;
DROP TABLE IF EXISTS public.microsoft_oauth_states;
DROP TABLE IF EXISTS public.outlook_conversation_progress;
DROP TABLE IF EXISTS public.interaction_candidates;
DROP TABLE IF EXISTS public.new_contact_candidates;
DROP TABLE IF EXISTS public.google_connections;
DROP TABLE IF EXISTS public.microsoft_connections;

-- 3. Drop the last integration functions (exact signatures, WITHOUT CASCADE) ---------------------------
DROP FUNCTION IF EXISTS public.outlook_sync_state_consume_wake();
DROP FUNCTION IF EXISTS public.outlook_unpaired_valid(jsonb);
DROP FUNCTION IF EXISTS public.run_google_local_cleanup(uuid);
DROP FUNCTION IF EXISTS public.expire_pending_email_context(integer);
DROP FUNCTION IF EXISTS public.expire_pending_outlook_context(integer);

-- 4. Verify before commit ---------------------------------------------------------------------------------
DO $$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_left
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY (ARRAY['email_candidate_refs','google_calendar_event_refs',
    'outlook_candidate_refs','outlook_round_messages','google_tokens','gmail_sync_state','google_calendar_sync_state',
    'google_connection_capabilities','outlook_subscriptions','outlook_sync_state','outlook_thread_recovery','microsoft_tokens',
    'google_oauth_states','microsoft_oauth_states','outlook_conversation_progress','interaction_candidates',
    'new_contact_candidates','google_connections','microsoft_connections']);
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'stage F incomplete; tables still present: %', v_left; END IF;

  SELECT string_agg(p.proname, ', ') INTO v_left
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY['outlook_sync_state_consume_wake','outlook_unpaired_valid',
    'run_google_local_cleanup','expire_pending_email_context','expire_pending_outlook_context']);
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'stage F incomplete; functions still present: %', v_left; END IF;

  SELECT string_agg(k, ', ') INTO v_left
  FROM unnest(ARRAY['contacts','interactions','profiles','pro_trials','subscriptions','checkout_operations','stripe_webhook_events']) AS k
  WHERE to_regclass('public.' || k) IS NULL;
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'stage F removed a retained table: %', v_left; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'interactions_source_check'
                 AND pg_catalog.pg_get_constraintdef(oid) LIKE '%outlook%' AND pg_catalog.pg_get_constraintdef(oid) LIKE '%google_calendar%') THEN
    RAISE EXCEPTION 'stage F changed interactions.source labels';
  END IF;
END
$$;
