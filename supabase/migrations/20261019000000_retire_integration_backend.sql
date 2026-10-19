-- Stage D: retire the Outlook, Google Calendar and Gmail integration BACKEND (database side).
--
-- FORWARD ONLY. No applied migration is edited. Integration TABLES and their rows are NOT touched:
-- dropping them (and the one expired non-pilot Microsoft OAuth state) is Stage F.
--
-- PRECONDITION (operational, checked by the owner before applying, see
-- docs/stage-d-backend-retirement.md): the nine integration Edge Functions are already UNDEPLOYED,
-- so nothing can call the functions dropped here. outlook-worker-tick is already inactive.
--
-- ATOMICITY: `supabase db push` (CLI 2.109.0, pkg/migration/file.go ExecBatch) sends every statement
-- of this file AND its supabase_migrations.schema_migrations row as ONE pgconn batch closed by a
-- single Sync, which PostgreSQL commits or rolls back as one implicit transaction. Any failure below
-- therefore undoes every earlier step and records no version. This file contains no BEGIN/COMMIT.
--
-- What this does, in one transaction:
--   1. Unschedules the inactive pg_cron job outlook-worker-tick (it only ever posted to the
--      now-undeployed outlook-import-worker). It REFUSES - failing the whole migration - when more
--      than one job has that name, when the job is ACTIVE, or when its command is not the expected
--      worker call; an absent job is already retired and is skipped.
--   2. Deletes the two Vault entries only that job read: outlook_worker_url, outlook_worker_secret.
--      No other Vault entry is touched.
--   3. Drops the 48 integration RPCs whose every caller (the integration Edge Functions, the retired
--      Suggestions/Settings UI and the acceptance flow) is gone. Each is dropped by its exact
--      signature and WITHOUT CASCADE, so an unexpected dependent makes the whole migration fail
--      rather than silently removing something else.
--   4. Verifies, before commit, that no overload of those names remains and that every function
--      this migration must NOT touch is still present.
--
-- KEPT on purpose (see the verification block):
--   run_google_local_cleanup        - delete-account calls it (shared/googleCleanup.js) while the
--                                     Google tables exist.
--   outlook_sync_state_consume_wake - trigger function on outlook_sync_state (table kept to Stage F).
--   outlook_unpaired_valid          - used by a CHECK constraint on outlook_thread_recovery.
--   expire_pending_email_context, expire_pending_outlook_context
--                                   - dormant (unscheduled) retention helpers for rows that remain
--                                     until Stage F drops their tables.
--   Every non-integration function (auth triggers, Pro access, billing) is untouched.
--
-- Account deletion: delete-account needs only run_google_local_cleanup, the google_connections /
-- google_tokens tables and ON DELETE CASCADE from auth.users, all of which remain.
--
-- RECOVERY LIMIT: the dropped function bodies exist only in the applied migrations. Restoring one
-- means re-issuing it from its latest defining migration in a NEW forward migration. The deleted
-- Vault values are not recoverable from the database (they were placeholders for a retired job; the
-- worker secret was already removed from the Edge Function environment in Stage C).

-- 1. The cron job ------------------------------------------------------------------------------
DO $$
DECLARE
  v_count integer;
  v_job   record;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_count FROM cron.job WHERE jobname = 'outlook-worker-tick';
  IF v_count = 0 THEN
    RETURN;  -- already retired
  END IF;
  IF v_count > 1 THEN
    RAISE EXCEPTION 'refusing to retire outlook-worker-tick: % jobs carry that name', v_count;
  END IF;
  SELECT jobid, active, command INTO v_job FROM cron.job WHERE jobname = 'outlook-worker-tick';
  IF v_job.active THEN
    RAISE EXCEPTION 'refusing to retire outlook-worker-tick: the job is ACTIVE; deactivate it deliberately first';
  END IF;
  IF position('outlook_worker_url' IN v_job.command) = 0 OR position('outlook_worker_secret' IN v_job.command) = 0 THEN
    RAISE EXCEPTION 'refusing to retire outlook-worker-tick: its command is not the expected worker call';
  END IF;
  PERFORM cron.unschedule(v_job.jobid);
END
$$;

-- 2. The job's two Vault entries -------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('vault.secrets') IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE name IN ('outlook_worker_url', 'outlook_worker_secret');
  END IF;
END
$$;

-- 3. The retired integration RPCs (exact signatures; no CASCADE) -----------------------------------
DROP FUNCTION IF EXISTS public.accept_interaction_candidate(uuid, text, date, text, text, date);
DROP FUNCTION IF EXISTS public.accept_new_contact_candidate(uuid, text, text, text, text, text, text[], text, text, boolean, text, date, text, date);
DROP FUNCTION IF EXISTS public.advance_outlook_round_write_cursor(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.baseline_outlook_thread_coverage(uuid, uuid, text, text, text[], text[], timestamp with time zone, timestamp with time zone);
DROP FUNCTION IF EXISTS public.baseline_outlook_thread_window(uuid, uuid, text, text[], timestamp with time zone, timestamp with time zone, text[]);
DROP FUNCTION IF EXISTS public.claim_calendar_sync_lease(uuid, text, integer);
DROP FUNCTION IF EXISTS public.claim_gmail_sync_lease(uuid, integer);
DROP FUNCTION IF EXISTS public.defer_candidate(text, uuid, timestamp with time zone);
DROP FUNCTION IF EXISTS public.disconnect_my_gmail();
DROP FUNCTION IF EXISTS public.disconnect_my_outlook();
DROP FUNCTION IF EXISTS public.dismiss_interaction_candidate(uuid);
DROP FUNCTION IF EXISTS public.dismiss_new_contact_candidate(uuid);
DROP FUNCTION IF EXISTS public.finalize_microsoft_connection(text, uuid, text, text, text, text, text[], timestamp with time zone, text, text, text, text, smallint);
DROP FUNCTION IF EXISTS public.get_my_outlook_connection();
DROP FUNCTION IF EXISTS public.get_my_outlook_sync_status();
DROP FUNCTION IF EXISTS public.get_outlook_thread_coverage(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.invalidate_email_candidates_by_fingerprint(uuid, uuid, text[]);
DROP FUNCTION IF EXISTS public.invalidate_outlook_candidates_by_fingerprint(uuid, uuid, text[]);
DROP FUNCTION IF EXISTS public.list_outlook_round_conversations(uuid, uuid, uuid, integer, text);
DROP FUNCTION IF EXISTS public.list_outlook_round_message_handles(uuid, uuid, uuid, text[], integer, text, timestamp with time zone, text);
DROP FUNCTION IF EXISTS public.mark_google_needs_reauth(uuid, text);
DROP FUNCTION IF EXISTS public.read_outlook_round_progress(uuid, uuid);
DROP FUNCTION IF EXISTS public.reconcile_calendar_occurrence(uuid, text, uuid, uuid, text, text, timestamp with time zone, date, text[]);
DROP FUNCTION IF EXISTS public.reconcile_email_episode(uuid, uuid, text[]);
DROP FUNCTION IF EXISTS public.record_outlook_change_notification(text, text, text);
DROP FUNCTION IF EXISTS public.record_outlook_change_notification_batch(jsonb);
DROP FUNCTION IF EXISTS public.record_outlook_page_progress(uuid, uuid, text, uuid, integer, text, text, text, text, smallint, boolean, integer, integer, jsonb, integer, jsonb);
DROP FUNCTION IF EXISTS public.record_outlook_subscription_state(uuid, uuid, text, text, text, text, text, timestamp with time zone, text);
DROP FUNCTION IF EXISTS public.record_outlook_thread_recovery(uuid, uuid, text, jsonb, text[]);
DROP FUNCTION IF EXISTS public.release_calendar_sync_lease(uuid, text, uuid, text, text, boolean);
DROP FUNCTION IF EXISTS public.release_gmail_sync_lease(uuid, uuid, text, text, boolean, text, boolean, integer);
DROP FUNCTION IF EXISTS public.release_outlook_sync_lease(uuid, uuid, text, text, boolean, text, text, text, text, smallint, boolean, integer);
DROP FUNCTION IF EXISTS public.renew_calendar_sync_lease(uuid, text, uuid, integer);
DROP FUNCTION IF EXISTS public.renew_gmail_sync_lease(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.renew_outlook_sync_lease(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.reserve_due_gmail_connection(integer, integer);
DROP FUNCTION IF EXISTS public.reserve_due_outlook_connection(integer, integer, uuid, uuid[]);
DROP FUNCTION IF EXISTS public.reset_outlook_round(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.rotate_microsoft_access_token(uuid, uuid, text, text, text, text, smallint, timestamp with time zone);
DROP FUNCTION IF EXISTS public.run_microsoft_local_cleanup(uuid);
DROP FUNCTION IF EXISTS public.store_google_connection(uuid, text, text, text[], text, timestamp with time zone, text, text, text, text, smallint);
DROP FUNCTION IF EXISTS public.store_refreshed_google_token(uuid, text, text, text, text, text, smallint, timestamp with time zone);
DROP FUNCTION IF EXISTS public.update_microsoft_connection_state(uuid, uuid, text, boolean, text);
DROP FUNCTION IF EXISTS public.upsert_calendar_candidate(uuid, text, uuid, uuid, uuid, text, text, text, text, text, date, text, text, timestamp with time zone, date, timestamp with time zone, timestamp with time zone, date, date, text);
DROP FUNCTION IF EXISTS public.upsert_email_candidate(uuid, uuid, uuid, text, text, smallint, text, date, text, text, text[]);
DROP FUNCTION IF EXISTS public.upsert_google_capability(uuid, uuid, text, text, boolean, boolean, text);
DROP FUNCTION IF EXISTS public.upsert_new_contact_candidate(uuid, uuid, text, text, smallint, text, date, text, text, text, text, text, text, text, text, text[], timestamp with time zone, timestamp with time zone, text[], text[]);
DROP FUNCTION IF EXISTS public.upsert_outlook_interaction_candidate(uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text, text, text[], timestamp with time zone, timestamp with time zone, text[], text[]);

-- 4. Verify before commit ----------------------------------------------------------------------------
DO $$
DECLARE
  v_left text;
  v_missing text;
BEGIN
  SELECT string_agg(DISTINCT p.proname, ', ') INTO v_left
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY[
      'accept_interaction_candidate',
      'accept_new_contact_candidate',
      'advance_outlook_round_write_cursor',
      'baseline_outlook_thread_coverage',
      'baseline_outlook_thread_window',
      'claim_calendar_sync_lease',
      'claim_gmail_sync_lease',
      'defer_candidate',
      'disconnect_my_gmail',
      'disconnect_my_outlook',
      'dismiss_interaction_candidate',
      'dismiss_new_contact_candidate',
      'finalize_microsoft_connection',
      'get_my_outlook_connection',
      'get_my_outlook_sync_status',
      'get_outlook_thread_coverage',
      'invalidate_email_candidates_by_fingerprint',
      'invalidate_outlook_candidates_by_fingerprint',
      'list_outlook_round_conversations',
      'list_outlook_round_message_handles',
      'mark_google_needs_reauth',
      'read_outlook_round_progress',
      'reconcile_calendar_occurrence',
      'reconcile_email_episode',
      'record_outlook_change_notification',
      'record_outlook_change_notification_batch',
      'record_outlook_page_progress',
      'record_outlook_subscription_state',
      'record_outlook_thread_recovery',
      'release_calendar_sync_lease',
      'release_gmail_sync_lease',
      'release_outlook_sync_lease',
      'renew_calendar_sync_lease',
      'renew_gmail_sync_lease',
      'renew_outlook_sync_lease',
      'reserve_due_gmail_connection',
      'reserve_due_outlook_connection',
      'reset_outlook_round',
      'rotate_microsoft_access_token',
      'run_microsoft_local_cleanup',
      'store_google_connection',
      'store_refreshed_google_token',
      'update_microsoft_connection_state',
      'upsert_calendar_candidate',
      'upsert_email_candidate',
      'upsert_google_capability',
      'upsert_new_contact_candidate',
      'upsert_outlook_interaction_candidate'
  ]);
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'stage D retirement incomplete; still present: %', v_left;
  END IF;

  SELECT string_agg(k, ', ') INTO v_missing
  FROM unnest(ARRAY['run_google_local_cleanup', 'outlook_sync_state_consume_wake', 'outlook_unpaired_valid',
                    'expire_pending_email_context', 'expire_pending_outlook_context',
                    'handle_new_user', 'activate_trial_on_confirmation', 'get_my_pro_access_status',
                    'start_my_pro_trial']) AS k
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = k);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stage D retirement removed a retained function: %', v_missing;
  END IF;

  IF to_regclass('cron.job') IS NOT NULL
     AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'outlook-worker-tick') THEN
    RAISE EXCEPTION 'outlook-worker-tick is still scheduled';
  END IF;
END
$$;
