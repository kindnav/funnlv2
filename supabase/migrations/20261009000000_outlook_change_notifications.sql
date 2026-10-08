-- 20261009000000_outlook_change_notifications.sql
--
-- NOT APPLIED. Nothing in this file has run against Production.
--
-- WHAT THIS ADDS: automatic, near-real-time Outlook syncing while Funnl is closed.
--
--   1. A durable WAKE-UP SIGNAL per connection (four columns on microsoft_connections).
--      A Microsoft Graph change notification records it; the reservation treats a pending
--      signal as "due now" instead of waiting out the 900-second routine interval; a
--      complete release clears only signals that predate the run it completed, so a signal
--      that arrives DURING a run stays pending for the next one. Nothing else about the
--      lease, the backoff or the bounded execution changes.
--   2. ONE change-notification subscription per connection (outlook_subscriptions): the
--      Graph subscription id, its expiry, and the SHA-256 of the clientState Funnl gave
--      Microsoft - never the clientState itself. The worker creates and renews it under its
--      lease; the notification endpoint matches id and hash before recording a wake-up.
--   3. The RPCs the two functions call, service_role only: record_outlook_subscription_state
--      (fenced on the run id, like every worker write) and record_outlook_change_notification.
--   4. A trigger that clears a consumed wake-up when BOTH folder rows of a run go back to
--      idle with the run complete - the same moment release_outlook_sync_lease erases the
--      round's working records. A trigger rather than a redefinition of release, so the
--      12-argument function the worker calls is byte-identical to the applied one.
--   5. get_my_outlook_sync_status(), authenticated-only, for the Settings card: real persisted
--      state (last success, current activity, retry, reauth, subscription), never a timer.
--   6. The schedule: pg_cron job `outlook-worker-tick`, every minute, POSTing to the worker
--      with the secret read from Vault at run time. CREATED INACTIVE. The worker URL and the
--      worker secret are NOT in this file: the owner stores both in Vault
--      (vault.create_secret) and activates the job as a separate, authorized rollout step.
--      A tick while the worker flag is off answers 503 not_enabled and does nothing.
--
-- ROLLOUT ORDER (not interchangeable): this migration -> deploy outlook-notifications and
-- outlook-import-worker from merged main -> Vault secrets -> enable the worker flag ->
-- activate the cron job. The subscription is created by the first worker run, which
-- validates the deployed notification endpoint.

-- ══ 1. the wake-up signal ═══════════════════════════════════════════════════
ALTER TABLE public.microsoft_connections
  ADD COLUMN IF NOT EXISTS wake_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS wake_source       text,
  ADD COLUMN IF NOT EXISTS wake_count        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_wake_at      timestamptz;

ALTER TABLE public.microsoft_connections
  DROP CONSTRAINT IF EXISTS microsoft_connections_wake_source_check;
ALTER TABLE public.microsoft_connections
  ADD CONSTRAINT microsoft_connections_wake_source_check
  CHECK (wake_source IS NULL OR wake_source IN ('change', 'reauthorizationRequired', 'subscriptionRemoved', 'missed', 'catch_up'));
-- The authenticated column-level SELECT grant on microsoft_connections names its columns
-- explicitly (20260921000000), so the four new columns are NOT readable by users. The
-- Settings card reads a summary through get_my_outlook_sync_status() below.

-- ══ 2. the subscription record ═════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.outlook_subscriptions (
  connection_id          uuid        PRIMARY KEY,
  user_id                uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subscription_id        text,                               -- Graph's id; NULL while failed
  resource               text        NOT NULL DEFAULT 'me/messages',
  change_type            text        NOT NULL DEFAULT 'created',
  client_state_hash      text,                               -- SHA-256 hex of the clientState, never the value
  status                 text        NOT NULL DEFAULT 'failed',
  expires_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  renewed_at             timestamptz,
  last_notification_at   timestamptz,
  notifications_received integer     NOT NULL DEFAULT 0,
  last_lifecycle_event   text,
  last_lifecycle_at      timestamptz,
  last_error_code        text,
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT osub_status_check CHECK (status IN ('active', 'reauthorize', 'removed', 'failed')),
  CONSTRAINT osub_subscription_id_shape
    CHECK (subscription_id IS NULL OR (char_length(subscription_id) BETWEEN 1 AND 128 AND subscription_id !~ '[[:cntrl:]]')),
  CONSTRAINT osub_hash_shape CHECK (client_state_hash IS NULL OR client_state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT osub_live_requires_identity
    CHECK (status NOT IN ('active', 'reauthorize')
           OR (subscription_id IS NOT NULL AND client_state_hash IS NOT NULL AND expires_at IS NOT NULL)),
  CONSTRAINT osub_resource_len    CHECK (char_length(resource) BETWEEN 1 AND 200),
  CONSTRAINT osub_change_type_len CHECK (char_length(change_type) BETWEEN 1 AND 40),
  CONSTRAINT osub_error_code_len  CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 100),
  CONSTRAINT osub_lifecycle_check
    CHECK (last_lifecycle_event IS NULL OR last_lifecycle_event IN ('reauthorizationRequired', 'subscriptionRemoved', 'missed')),
  CONSTRAINT osub_nonneg CHECK (notifications_received >= 0),
  -- Disconnect deletes the connection; the subscription record goes with it.
  CONSTRAINT osub_conn_user_fk FOREIGN KEY (connection_id, user_id)
    REFERENCES public.microsoft_connections(id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS outlook_subscriptions_subscription_id_idx
  ON public.outlook_subscriptions (subscription_id) WHERE subscription_id IS NOT NULL;

ALTER TABLE public.outlook_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.outlook_subscriptions FROM PUBLIC;
REVOKE ALL ON TABLE public.outlook_subscriptions FROM anon;
REVOKE ALL ON TABLE public.outlook_subscriptions FROM authenticated;
-- The worker reads the row through PostgREST as the service role; writes go through the
-- fenced RPC below. No policy exists for anon or authenticated, so RLS admits nobody else.
GRANT SELECT ON TABLE public.outlook_subscriptions TO service_role;

-- ══ 3a. record_outlook_subscription_state — the worker's fenced write ══════
CREATE FUNCTION public.record_outlook_subscription_state(
  p_connection_id      uuid,
  p_run_id             uuid,
  p_status             text,
  p_subscription_id    text,
  p_resource           text,
  p_change_type        text,
  p_client_state_hash  text,
  p_expires_at         timestamptz,
  p_error_code         text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('active', 'reauthorize', 'removed', 'failed') THEN
    RETURN jsonb_build_object('result', 'invalid_status');
  END IF;
  IF p_error_code IS NOT NULL AND char_length(p_error_code) > 100 THEN
    RETURN jsonb_build_object('result', 'invalid_error_code');
  END IF;
  IF p_status IN ('active', 'reauthorize')
     AND (p_subscription_id IS NULL OR p_client_state_hash IS NULL OR p_expires_at IS NULL) THEN
    RETURN jsonb_build_object('result', 'invalid_subscription');
  END IF;
  IF p_client_state_hash IS NOT NULL AND p_client_state_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'invalid_subscription');
  END IF;
  -- THE LEASE FENCE, the same one every worker write passes: only the run that holds both
  -- folder rows may record a subscription for the connection.
  SELECT s.user_id INTO v_uid
    FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id
     AND s.sync_run_id = p_run_id
     AND s.sync_status = 'running'
     AND s.sync_lease_until IS NOT NULL
     AND s.sync_lease_until >= now()
   LIMIT 1;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;

  INSERT INTO public.outlook_subscriptions
    (connection_id, user_id, subscription_id, resource, change_type, client_state_hash, status,
     expires_at, created_at, renewed_at, last_error_code, updated_at)
  VALUES
    (p_connection_id, v_uid, p_subscription_id, COALESCE(p_resource, 'me/messages'),
     COALESCE(p_change_type, 'created'), p_client_state_hash, p_status, p_expires_at, now(),
     NULL, p_error_code, now())
  ON CONFLICT (connection_id) DO UPDATE
    SET subscription_id   = EXCLUDED.subscription_id,
        resource          = EXCLUDED.resource,
        change_type       = EXCLUDED.change_type,
        client_state_hash = EXCLUDED.client_state_hash,
        status            = EXCLUDED.status,
        expires_at        = EXCLUDED.expires_at,
        -- A new identity starts a new lifetime; the same identity with a later expiry is a renewal.
        created_at        = CASE WHEN public.outlook_subscriptions.subscription_id IS DISTINCT FROM EXCLUDED.subscription_id
                                 THEN now() ELSE public.outlook_subscriptions.created_at END,
        renewed_at        = CASE WHEN public.outlook_subscriptions.subscription_id IS NOT DISTINCT FROM EXCLUDED.subscription_id
                                      AND EXCLUDED.status = 'active'
                                 THEN now() ELSE public.outlook_subscriptions.renewed_at END,
        last_error_code   = EXCLUDED.last_error_code,
        updated_at        = now();

  RETURN jsonb_build_object('result', 'recorded');
END;
$$;

REVOKE ALL ON FUNCTION public.record_outlook_subscription_state(uuid, uuid, text, text, text, text, text, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_outlook_subscription_state(uuid, uuid, text, text, text, text, text, timestamptz, text)
  TO service_role;

-- ══ 3b. record_outlook_change_notification — the endpoint's only write ═════
-- Matches the subscription by Graph id, compares the SHA-256 of the clientState Microsoft
-- sent back with the one recorded at creation, and only then records the wake-up. A
-- mismatch changes nothing: it is what a forged or replayed notification looks like.
CREATE FUNCTION public.record_outlook_change_notification(
  p_subscription_id   text,
  p_client_state_hash text,
  p_kind              text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sub  public.outlook_subscriptions%ROWTYPE;
  v_conn public.microsoft_connections%ROWTYPE;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('change', 'reauthorizationRequired', 'subscriptionRemoved', 'missed') THEN
    RAISE EXCEPTION 'invalid_notification_kind';
  END IF;
  IF p_subscription_id IS NULL OR char_length(p_subscription_id) > 128 THEN
    RETURN jsonb_build_object('result', 'unknown_subscription');
  END IF;
  IF p_client_state_hash IS NULL OR p_client_state_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'client_state_mismatch');
  END IF;

  SELECT * INTO v_sub FROM public.outlook_subscriptions WHERE subscription_id = p_subscription_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'unknown_subscription');
  END IF;
  IF v_sub.client_state_hash IS NULL OR v_sub.client_state_hash <> p_client_state_hash THEN
    RETURN jsonb_build_object('result', 'client_state_mismatch');
  END IF;
  SELECT * INTO v_conn FROM public.microsoft_connections WHERE id = v_sub.connection_id FOR UPDATE;
  IF NOT FOUND OR v_conn.status <> 'active' OR v_conn.needs_reauth THEN
    RETURN jsonb_build_object('result', 'connection_inactive');
  END IF;

  UPDATE public.outlook_subscriptions
     SET last_notification_at   = now(),
         notifications_received = notifications_received + 1,
         status = CASE p_kind
                    WHEN 'subscriptionRemoved'     THEN 'removed'
                    WHEN 'reauthorizationRequired' THEN 'reauthorize'
                    ELSE status END,
         last_lifecycle_event = CASE WHEN p_kind <> 'change' THEN p_kind ELSE last_lifecycle_event END,
         last_lifecycle_at    = CASE WHEN p_kind <> 'change' THEN now() ELSE last_lifecycle_at END,
         updated_at = now()
   WHERE connection_id = v_sub.connection_id;

  -- THE WAKE-UP. Always stamped with now(): a signal during a run must outlast that run's
  -- start so the clearing trigger leaves it pending.
  UPDATE public.microsoft_connections
     SET wake_requested_at = now(),
         wake_source       = p_kind,
         wake_count        = wake_count + 1,
         last_wake_at      = now(),
         updated_at        = now()
   WHERE id = v_sub.connection_id;

  RETURN jsonb_build_object('result', 'accepted');
END;
$$;

REVOKE ALL ON FUNCTION public.record_outlook_change_notification(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_outlook_change_notification(text, text, text) TO service_role;

-- ══ 4. the wake-up is consumed when the run that saw it completes ═══════════
-- release_outlook_sync_lease sets both folder rows idle with last_run_complete = true and
-- nulls run_started_at. Each row's transition fires this once; the OLD row still carries the
-- run's start, which is what decides whether a signal predates the run (consumed) or arrived
-- during it (kept). Two firings are idempotent.
CREATE FUNCTION public.outlook_sync_state_consume_wake()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.sync_status = 'running' AND NEW.sync_status = 'idle' AND NEW.last_run_complete IS TRUE
     AND OLD.run_started_at IS NOT NULL THEN
    UPDATE public.microsoft_connections c
       SET wake_requested_at = NULL,
           wake_source       = NULL
     WHERE c.id = NEW.connection_id
       AND c.wake_requested_at IS NOT NULL
       AND c.wake_requested_at <= OLD.run_started_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS outlook_sync_state_consume_wake ON public.outlook_sync_state;
CREATE TRIGGER outlook_sync_state_consume_wake
  AFTER UPDATE OF sync_status ON public.outlook_sync_state
  FOR EACH ROW EXECUTE FUNCTION public.outlook_sync_state_consume_wake();

REVOKE ALL ON FUNCTION public.outlook_sync_state_consume_wake() FROM PUBLIC, anon, authenticated;

-- ══ 5. eligibility: a pending wake-up is due NOW ═══════════════════════════
-- DROP and CREATE, same three-argument signature: CREATE OR REPLACE cannot change a body
-- safely when a default is involved, and a dropped function loses its ACL, so it is restated.
-- The ONLY changes against 20261003000000: the third due alternative (a pending wake-up), the
-- order (a woken connection first), and `wake_requested_at` in the answer so the run can
-- report how old the signal was.
DROP FUNCTION IF EXISTS public.reserve_due_outlook_connection(integer, integer, uuid);

CREATE FUNCTION public.reserve_due_outlook_connection(
  p_lease_seconds     integer,
  p_due_after_seconds integer,
  p_pilot_user_id     uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conn uuid;
  v_uid  uuid;
  v_wake timestamptz;
  v_run  uuid;
  v_n    integer;
  v_inbox_done boolean;
  v_sent_done  boolean;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid_lease_seconds';
  END IF;
  IF p_due_after_seconds IS NULL OR p_due_after_seconds < 0 OR p_due_after_seconds > 2592000 THEN
    RAISE EXCEPTION 'invalid_due_after';
  END IF;

  SELECT c.id, c.user_id, c.wake_requested_at
    INTO v_conn, v_uid, v_wake
  FROM public.microsoft_connections c
  WHERE c.status = 'active'
    AND c.needs_reauth IS FALSE
    AND c.consented_at IS NOT NULL
    AND (p_pilot_user_id IS NULL OR c.user_id = p_pilot_user_id)
    -- Never while another run holds a live lease, and never inside a failure backoff:
    -- a wake-up does not bypass either.
    AND NOT EXISTS (
      SELECT 1 FROM public.outlook_sync_state s
      WHERE s.connection_id = c.id
        AND ((s.sync_status = 'running' AND s.sync_lease_until IS NOT NULL AND s.sync_lease_until >= now())
             OR (s.next_retry_at IS NOT NULL AND s.next_retry_at > now())))
    AND (
      NOT EXISTS (SELECT 1 FROM public.outlook_sync_state s WHERE s.connection_id = c.id)
      OR EXISTS (
        SELECT 1 FROM public.outlook_sync_state s
        WHERE s.connection_id = c.id
          AND (s.last_success_at IS NULL
               OR (s.last_run_complete IS NOT TRUE
                   AND s.retry_count < 10
                   AND (s.last_attempt_at IS NULL OR s.last_attempt_at < now() - interval '5 minutes'))
               OR s.last_success_at < now() - make_interval(secs => p_due_after_seconds)))
      -- THE ADDITION: new mail was signalled since the last complete run.
      OR c.wake_requested_at IS NOT NULL
    )
  ORDER BY (c.wake_requested_at IS NULL) ASC,
           (SELECT min(s.last_success_at) FROM public.outlook_sync_state s WHERE s.connection_id = c.id) ASC NULLS FIRST,
           c.id ASC
  LIMIT 1;

  IF v_conn IS NULL THEN
    RETURN jsonb_build_object('result', 'none_due');
  END IF;

  v_run := pg_catalog.gen_random_uuid();

  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, sync_run_id, sync_lease_until, run_started_at, last_attempt_at, updated_at)
  VALUES
    (v_conn, v_uid, 'inbox',     'running', v_run, now() + make_interval(secs => p_lease_seconds), now(), now(), now()),
    (v_conn, v_uid, 'sentitems', 'running', v_run, now() + make_interval(secs => p_lease_seconds), now(), now(), now())
  ON CONFLICT (connection_id, folder) DO UPDATE
    SET sync_status      = 'running',
        sync_run_id      = v_run,
        sync_lease_until = now() + make_interval(secs => p_lease_seconds),
        run_started_at   = now(),
        last_attempt_at  = now(),
        updated_at       = now()
    WHERE public.outlook_sync_state.sync_status <> 'running'
       OR public.outlook_sync_state.sync_lease_until IS NULL
       OR public.outlook_sync_state.sync_lease_until < now();

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'reservation_lost' USING ERRCODE = 'serialization_failure';
  END IF;

  SELECT bool_and(CASE WHEN s.folder = 'inbox'     THEN s.initial_import_done ELSE true END),
         bool_and(CASE WHEN s.folder = 'sentitems' THEN s.initial_import_done ELSE true END)
    INTO v_inbox_done, v_sent_done
  FROM public.outlook_sync_state s
  WHERE s.connection_id = v_conn;

  RETURN jsonb_build_object(
    'result', 'reserved',
    'connection_id', v_conn,
    'user_id', v_uid,
    'run_id', v_run,
    'inbox_initial_import_done', COALESCE(v_inbox_done, false),
    'sentitems_initial_import_done', COALESCE(v_sent_done, false),
    'wake_requested_at', v_wake
  );
EXCEPTION
  WHEN serialization_failure THEN
    RETURN jsonb_build_object('result', 'none_due');
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_due_outlook_connection(integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_due_outlook_connection(integer, integer, uuid) TO service_role;

-- ══ 6. get_my_outlook_sync_status — what the Settings card shows ═══════════
-- Real persisted state only. No timer, no optimistic label: `activity` is 'running' only
-- while a lease is live, 'retry_scheduled' only while next_retry_at is in the future.
CREATE FUNCTION public.get_my_outlook_sync_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid  uuid := (SELECT auth.uid());
  v_conn public.microsoft_connections%ROWTYPE;
  v_sub  public.outlook_subscriptions%ROWTYPE;
  v_running   boolean;
  v_error     text;
  v_retry_at  timestamptz;
  v_success   timestamptz;
  v_attempt   timestamptz;
  v_complete  boolean;
  v_initial   boolean;
  v_pending   integer;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('result', 'unauthorized');
  END IF;
  SELECT * INTO v_conn FROM public.microsoft_connections WHERE user_id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_connected');
  END IF;

  SELECT bool_or(s.sync_status = 'running' AND s.sync_lease_until IS NOT NULL AND s.sync_lease_until >= now()),
         max(s.last_error_code),
         max(s.next_retry_at),
         min(s.last_success_at),
         max(s.last_attempt_at),
         bool_and(s.last_run_complete),
         bool_and(s.initial_import_done)
    INTO v_running, v_error, v_retry_at, v_success, v_attempt, v_complete, v_initial
  FROM public.outlook_sync_state s
  WHERE s.connection_id = v_conn.id;

  SELECT * INTO v_sub FROM public.outlook_subscriptions WHERE connection_id = v_conn.id;

  SELECT count(*) INTO v_pending FROM (
    SELECT id FROM public.interaction_candidates WHERE user_id = v_uid AND status = 'pending' AND source = 'outlook'
    UNION ALL
    SELECT id FROM public.new_contact_candidates WHERE user_id = v_uid AND status = 'pending'
  ) p;

  RETURN jsonb_build_object(
    'result',               'connected',
    'status',               v_conn.status,
    'needs_reauth',         v_conn.needs_reauth,
    'activity',             CASE
                              WHEN COALESCE(v_running, false) THEN 'running'
                              WHEN v_retry_at IS NOT NULL AND v_retry_at > now() THEN 'retry_scheduled'
                              WHEN v_error IS NOT NULL THEN 'error'
                              WHEN v_success IS NULL THEN 'never_synced'
                              ELSE 'idle' END,
    'last_success_at',      v_success,
    'last_attempt_at',      v_attempt,
    'last_run_complete',    COALESCE(v_complete, false),
    'initial_import_done',  COALESCE(v_initial, false),
    'last_error_code',      v_error,
    'next_retry_at',        v_retry_at,
    'wake_pending',         v_conn.wake_requested_at IS NOT NULL,
    'last_wake_at',         v_conn.last_wake_at,
    'pending_suggestions',  v_pending,
    'subscription',         CASE WHEN v_sub.connection_id IS NULL THEN NULL ELSE jsonb_build_object(
                              'status',               v_sub.status,
                              'expires_at',           v_sub.expires_at,
                              'last_notification_at', v_sub.last_notification_at,
                              'last_error_code',      v_sub.last_error_code) END,
    'server_now',           now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_outlook_sync_status() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_outlook_sync_status() TO authenticated;

-- ══ 7. the schedule: one tick a minute, created INACTIVE ═══════════════════
-- Per the Supabase guide "Schedule Edge Functions" (pg_cron + pg_net, secrets in Vault,
-- read at run time with vault.decrypted_secrets). Neither secret is written here. The job
-- posts nothing until BOTH `outlook_worker_url` and `outlook_worker_secret` exist in Vault,
-- and it is deactivated on creation; activating it is the rollout's last step:
--   SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'outlook-worker-tick'), active := true);
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $$
DECLARE
  v_job bigint;
BEGIN
  SELECT jobid INTO v_job FROM cron.job WHERE jobname = 'outlook-worker-tick';
  IF v_job IS NOT NULL THEN
    PERFORM cron.unschedule(v_job);
  END IF;
  v_job := cron.schedule(
    'outlook-worker-tick',
    '* * * * *',
    $job$
      SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'outlook_worker_url'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'outlook_worker_secret')),
        body := '{}'::jsonb,
        timeout_milliseconds := 10000)
      WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'outlook_worker_url')
        AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'outlook_worker_secret');
    $job$
  );
  PERFORM cron.alter_job(v_job, active := false);
END $$;
