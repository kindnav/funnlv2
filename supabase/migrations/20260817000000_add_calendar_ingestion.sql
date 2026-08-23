-- Google integration — Phase A: Calendar event ingestion foundation.
--
-- SCOPE (Phase A only): the schema + service-role sync primitives that a later
-- read-only Calendar sync engine will write into. This migration adds NO Edge
-- Function, NO scheduler, NO webhook, NO Gmail objects, NO AI, and NO review UI.
-- It is INTENTIONALLY NOT DEPLOYED by this phase (local ledger only).
--
-- WHAT THIS ADDS
--   1. public.interaction_candidates      — generic per-(source,contact) proposed
--                                            interactions awaiting user review.
--                                            Authenticated users may read only a
--                                            SAFE COLUMN SUBSET of their own rows.
--   2. public.google_calendar_event_refs  — Calendar provenance for a candidate.
--                                            Service-role ONLY (no client grant).
--   3. public.google_calendar_sync_state  — per-connection sync cursor + lease.
--                                            Service-role ONLY.
--   4. Six SECURITY DEFINER service-role RPCs:
--        claim_calendar_sync_lease, renew_calendar_sync_lease,
--        release_calendar_sync_lease, upsert_calendar_candidate,
--        store_refreshed_google_token, mark_google_needs_reauth.
--
-- DESIGN CONSTRAINTS (permanent — do not change without approval):
--   - Provider identifiers (google_sub, google_event_id, ical_uid, calendar_id,
--     occurrence identifiers) live ONLY on the service-role event_refs table and
--     never reach the browser.
--   - source_fingerprint is a server-generated SHA-256 dedup key and is NEVER
--     granted to authenticated (would leak the provider identity it hashes).
--   - accept/dismiss RPCs are DEFERRED to Phase B (they belong with the review UI).
--     The Phase B accept_interaction_candidate RPC contract (documented here so the
--     schema invariants above are unambiguous — NOT implemented in Phase A):
--       * pending                              -> create the interaction, store its id,
--                                                 set status='accepted'.
--       * accepted, interaction_id NOT NULL    -> idempotently return that interaction_id
--                                                 (no second interaction created).
--       * accepted, interaction_id IS NULL     -> the created interaction was later
--                                                 DELETED by the user; return a controlled
--                                                 `interaction_previously_deleted` result and
--                                                 NEVER recreate the interaction.
--       * dismissed / invalidated              -> controlled conflict; never accept.
--   - One group event occurrence may map to MANY contact candidates: uniqueness is
--     UNIQUE(user_id, source_fingerprint) on candidates; the event_refs index is
--     NON-UNIQUE so several refs can share one (connection, event, occurrence).
--   - Stale sync workers are fenced out by sync_run_id: token/state advancement and
--     candidate upserts require the run that currently owns an unexpired lease.
--
-- Follows the existing hardening pattern (20260816000000_add_google_oauth_foundation.sql,
-- 20260727000000_add_pro_trials.sql): REVOKE ALL, then GRANT only what is needed;
-- service_role gets GRANT ALL. All functions: SECURITY DEFINER, SET search_path = '',
-- fully-qualified objects, EXECUTE revoked from PUBLIC/anon/authenticated, granted to
-- service_role only.


-- ── 1. interaction_candidates — generic proposed interactions (review queue) ──

CREATE TABLE public.interaction_candidates (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid        NOT NULL REFERENCES auth.users(id)      ON DELETE CASCADE,
  contact_id               uuid        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  source                   text        NOT NULL,
  source_fingerprint       text        NOT NULL,   -- server-generated SHA-256 hex dedup key
  proposed_type            text        NOT NULL,   -- an existing interactions.type value
  proposed_interaction_date date       NOT NULL,
  proposed_notes           text,
  status                   text        NOT NULL DEFAULT 'pending',
  interaction_id           uuid        REFERENCES public.interactions(id) ON DELETE SET NULL,
  source_last_state        text        NOT NULL DEFAULT 'active',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT interaction_candidates_source_check
    CHECK (source IN ('google_calendar')),
  -- Lowercase 64-char SHA-256 hex shape (matches calendarFingerprint.js output).
  CONSTRAINT interaction_candidates_fingerprint_shape
    CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  -- Restrict to the existing interaction types (contacts/interactions.type enum).
  CONSTRAINT interaction_candidates_proposed_type_check
    CHECK (proposed_type IN ('Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other')),
  CONSTRAINT interaction_candidates_status_check
    CHECK (status IN ('pending', 'accepted', 'dismissed', 'invalidated')),
  CONSTRAINT interaction_candidates_source_last_state_check
    CHECK (source_last_state IN ('active', 'cancelled', 'deleted')),
  CONSTRAINT interaction_candidates_notes_len
    CHECK (proposed_notes IS NULL OR char_length(proposed_notes) <= 200),
  -- Interaction-link invariant. Only an ACCEPTED candidate may hold an
  -- interaction_id; pending/dismissed/invalidated must have interaction_id IS NULL.
  -- ACCEPTED is allowed to have interaction_id NULL: that is the tombstone state
  -- reached when the user later DELETES the created interaction through normal Funnl
  -- behavior. The interaction FK is ON DELETE SET NULL, so that deletion succeeds and
  -- leaves accepted + NULL. The Calendar event stays de-duplicated (the candidate row
  -- and its source_fingerprint persist), and the interaction is NEVER auto-recreated.
  -- NOTE: we deliberately do NOT require accepted => interaction_id NOT NULL, because
  -- that would make ON DELETE SET NULL abort the user's interaction deletion.
  CONSTRAINT interaction_candidates_interaction_link_check
    CHECK (status = 'accepted' OR interaction_id IS NULL),
  CONSTRAINT interaction_candidates_fingerprint_unique
    UNIQUE (user_id, source_fingerprint)
);

CREATE INDEX interaction_candidates_user_status_idx
  ON public.interaction_candidates (user_id, status);
CREATE INDEX interaction_candidates_contact_idx
  ON public.interaction_candidates (contact_id);

ALTER TABLE public.interaction_candidates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.interaction_candidates FROM PUBLIC;
REVOKE ALL ON TABLE public.interaction_candidates FROM anon;
REVOKE ALL ON TABLE public.interaction_candidates FROM authenticated;
-- Column-level SELECT only. Deliberately EXCLUDES user_id, source_fingerprint, and
-- interaction_id — the browser never needs them and source_fingerprint would leak
-- the hashed provider identity. Frontend must select this explicit column list and
-- never SELECT *. No INSERT/UPDATE/DELETE for authenticated (writes go through the
-- Phase B accept/dismiss RPCs).
GRANT SELECT (
  id, contact_id, source, proposed_type, proposed_interaction_date,
  proposed_notes, status, source_last_state, created_at, updated_at
) ON TABLE public.interaction_candidates TO authenticated;
GRANT ALL ON TABLE public.interaction_candidates TO service_role;

-- Users may read ONLY their own rows (and only the granted columns above).
CREATE POLICY "interaction_candidates_select_own"
  ON public.interaction_candidates
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);


-- ── 2. google_calendar_event_refs — Calendar provenance (service-role ONLY) ───
--
-- RLS on, NO policies, NO grant to authenticated/anon: unreadable by clients.
-- candidate_id is the PRIMARY KEY (each candidate has exactly one provider ref).
-- The (connection, event, occurrence) index is NON-UNIQUE so one group-event
-- occurrence can back several contact candidates.

CREATE TABLE public.google_calendar_event_refs (
  candidate_id             uuid        PRIMARY KEY
                                       REFERENCES public.interaction_candidates(id) ON DELETE CASCADE,
  user_id                  uuid        NOT NULL REFERENCES auth.users(id)             ON DELETE CASCADE,
  connection_id            uuid        NOT NULL REFERENCES public.google_connections(id) ON DELETE CASCADE,
  google_sub               text        NOT NULL,
  calendar_id              text        NOT NULL DEFAULT 'primary',
  google_event_id          text        NOT NULL,
  ical_uid                 text,
  -- Typed original occurrence: exactly one of timed / all-day is present (XOR).
  original_occurrence_at   timestamptz,
  original_occurrence_date date,
  -- Event window: either timed (start/end _at) OR all-day (start/end _date) (XOR).
  event_start_at           timestamptz,
  event_end_at             timestamptz,
  event_start_date         date,
  event_end_date           date,
  event_timezone           text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- Original occurrence: timed XOR all-day.
  CONSTRAINT gcer_occurrence_xor
    CHECK ((original_occurrence_at IS NOT NULL) <> (original_occurrence_date IS NOT NULL)),
  -- Event window: fully timed OR fully all-day, never mixed / partial.
  CONSTRAINT gcer_timing_xor
    CHECK (
      (event_start_at IS NOT NULL AND event_end_at IS NOT NULL
        AND event_start_date IS NULL AND event_end_date IS NULL)
      OR
      (event_start_date IS NOT NULL AND event_end_date IS NOT NULL
        AND event_start_at IS NULL AND event_end_at IS NULL)
    ),
  -- Timed end strictly after start.
  CONSTRAINT gcer_timed_end_after_start
    CHECK (event_start_at IS NULL OR event_end_at > event_start_at),
  -- All-day end strictly after start (Google end.date is EXCLUSIVE).
  CONSTRAINT gcer_allday_end_after_start
    CHECK (event_start_date IS NULL OR event_end_date > event_start_date),
  -- MVP: primary calendar only (simplifies enforcement + fingerprint scope).
  CONSTRAINT gcer_calendar_primary
    CHECK (calendar_id = 'primary'),
  -- Length caps on all provider strings.
  CONSTRAINT gcer_google_sub_len       CHECK (char_length(google_sub) <= 255),
  CONSTRAINT gcer_google_event_id_len  CHECK (char_length(google_event_id) <= 1024),
  CONSTRAINT gcer_ical_uid_len         CHECK (ical_uid IS NULL OR char_length(ical_uid) <= 1024),
  CONSTRAINT gcer_calendar_id_len      CHECK (char_length(calendar_id) <= 1024),
  CONSTRAINT gcer_event_timezone_len   CHECK (event_timezone IS NULL OR char_length(event_timezone) <= 128)
);

-- NON-UNIQUE: several contact candidates may share one occurrence of a group event.
CREATE INDEX google_calendar_event_refs_event_idx
  ON public.google_calendar_event_refs
     (connection_id, google_event_id, original_occurrence_at, original_occurrence_date);
CREATE INDEX google_calendar_event_refs_user_idx
  ON public.google_calendar_event_refs (user_id);

ALTER TABLE public.google_calendar_event_refs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.google_calendar_event_refs FROM PUBLIC;
REVOKE ALL ON TABLE public.google_calendar_event_refs FROM anon;
REVOKE ALL ON TABLE public.google_calendar_event_refs FROM authenticated;
GRANT ALL  ON TABLE public.google_calendar_event_refs TO service_role;
-- Intentionally NO GRANT and NO POLICY for authenticated: provider ids never leak.


-- ── 3. google_calendar_sync_state — per-connection cursor + lease (svc-role) ──

CREATE TABLE public.google_calendar_sync_state (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id      uuid        NOT NULL REFERENCES public.google_connections(id) ON DELETE CASCADE,
  calendar_id        text        NOT NULL DEFAULT 'primary',
  sync_token         text,
  backfilled_through timestamptz,
  last_synced_at     timestamptz,
  sync_status        text        NOT NULL DEFAULT 'idle',
  sync_lease_until   timestamptz,
  sync_run_id        uuid,
  last_error_code    text,
  last_run_complete  boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT gcss_status_check
    CHECK (sync_status IN ('idle', 'running', 'error')),
  CONSTRAINT gcss_calendar_primary
    CHECK (calendar_id = 'primary'),
  CONSTRAINT gcss_error_code_len
    CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 100),
  -- A 'running' row must carry an owning run and a lease deadline.
  CONSTRAINT gcss_running_requires_lease
    CHECK (sync_status <> 'running' OR (sync_run_id IS NOT NULL AND sync_lease_until IS NOT NULL)),
  CONSTRAINT gcss_connection_calendar_unique
    UNIQUE (connection_id, calendar_id)
);

CREATE INDEX google_calendar_sync_state_connection_idx
  ON public.google_calendar_sync_state (connection_id);

ALTER TABLE public.google_calendar_sync_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.google_calendar_sync_state FROM PUBLIC;
REVOKE ALL ON TABLE public.google_calendar_sync_state FROM anon;
REVOKE ALL ON TABLE public.google_calendar_sync_state FROM authenticated;
GRANT ALL  ON TABLE public.google_calendar_sync_state TO service_role;
-- Intentionally NO GRANT and NO POLICY for authenticated.


-- ══════════════════════════════════════════════════════════════════════════════
--  SERVICE-ROLE RPCs (SECURITY DEFINER, empty search_path, service_role only)
-- ══════════════════════════════════════════════════════════════════════════════

-- ── RPC 1: claim_calendar_sync_lease ──────────────────────────────────────────
-- Atomically insert the sync-state row when absent, or claim it when idle/error or
-- its lease has expired. Generates and returns a fresh sync_run_id. Returns NULL
-- when a currently-valid lease is held by someone else (claim refused).

CREATE OR REPLACE FUNCTION public.claim_calendar_sync_lease(
  p_connection_id uuid,
  p_calendar_id   text,
  p_lease_seconds integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_run uuid;
  v_n   integer;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid_lease_seconds';
  END IF;
  IF p_calendar_id IS NULL OR p_calendar_id <> 'primary' THEN
    RAISE EXCEPTION 'invalid_calendar_id';
  END IF;

  -- Fully qualified: gen_random_uuid() is a pg_catalog built-in (PG13+). Qualifying
  -- guarantees resolution under SET search_path = '' regardless of whether a
  -- pgcrypto copy also exists in the extensions schema.
  v_run := pg_catalog.gen_random_uuid();

  INSERT INTO public.google_calendar_sync_state
    (connection_id, calendar_id, sync_status, sync_lease_until, sync_run_id, updated_at)
  VALUES
    (p_connection_id, p_calendar_id, 'running',
     now() + make_interval(secs => p_lease_seconds), v_run, now())
  ON CONFLICT (connection_id, calendar_id) DO UPDATE
    SET sync_status      = 'running',
        sync_lease_until = now() + make_interval(secs => p_lease_seconds),
        sync_run_id      = v_run,
        updated_at       = now()
    WHERE public.google_calendar_sync_state.sync_status <> 'running'
       OR public.google_calendar_sync_state.sync_lease_until IS NULL
       OR public.google_calendar_sync_state.sync_lease_until < now();

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RETURN v_run;
  END IF;
  RETURN NULL;  -- a valid lease is held by another run; claim refused
END;
$$;

REVOKE ALL ON FUNCTION public.claim_calendar_sync_lease(uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_calendar_sync_lease(uuid, text, integer)
  TO service_role;


-- ── RPC 2: renew_calendar_sync_lease (heartbeat) ──────────────────────────────
-- Extend the lease ONLY while the supplied run still owns an unexpired lease.
-- Stale / replaced runs cannot renew. Returns whether renewal succeeded.

CREATE OR REPLACE FUNCTION public.renew_calendar_sync_lease(
  p_connection_id uuid,
  p_calendar_id   text,
  p_run_id        uuid,
  p_lease_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid_lease_seconds';
  END IF;
  IF p_run_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.google_calendar_sync_state
    SET sync_lease_until = now() + make_interval(secs => p_lease_seconds),
        updated_at       = now()
  WHERE connection_id   = p_connection_id
    AND calendar_id     = p_calendar_id
    AND sync_run_id     = p_run_id
    AND sync_status     = 'running'
    AND sync_lease_until IS NOT NULL
    AND sync_lease_until > now();

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_calendar_sync_lease(uuid, text, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_calendar_sync_lease(uuid, text, uuid, integer)
  TO service_role;


-- ── RPC 3: release_calendar_sync_lease ────────────────────────────────────────
-- Release the lease held by the supplied run, recording completion + status.
-- Stale runs cannot release a newer run. Accepts only controlled status/error.
-- Phase A: does NOT advance sync_token (no token parameter exists here).

CREATE OR REPLACE FUNCTION public.release_calendar_sync_lease(
  p_connection_id uuid,
  p_calendar_id   text,
  p_run_id        uuid,
  p_status        text,
  p_error_code    text,
  p_run_complete  boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('idle', 'error') THEN
    RAISE EXCEPTION 'invalid_release_status';
  END IF;
  IF p_error_code IS NOT NULL AND char_length(p_error_code) > 100 THEN
    RAISE EXCEPTION 'invalid_error_code';
  END IF;
  IF p_run_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.google_calendar_sync_state
    SET sync_status       = p_status,
        sync_lease_until  = NULL,
        sync_run_id       = NULL,
        last_synced_at    = now(),
        last_run_complete = COALESCE(p_run_complete, false),
        last_error_code   = CASE WHEN p_status = 'error' THEN p_error_code ELSE NULL END,
        updated_at        = now()
  WHERE connection_id = p_connection_id
    AND calendar_id   = p_calendar_id
    AND sync_run_id   = p_run_id;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.release_calendar_sync_lease(uuid, text, uuid, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_calendar_sync_lease(uuid, text, uuid, text, text, boolean)
  TO service_role;


-- ── RPC 4: upsert_calendar_candidate ──────────────────────────────────────────
-- Atomically write/update a candidate AND its Calendar event ref in one txn.
-- Run-ID fenced: only the run currently owning an unexpired lease may write, so a
-- stale worker cannot overwrite newer title/timing/source-state. Never resurrects
-- a non-pending candidate and never touches an accepted candidate's interaction.

CREATE OR REPLACE FUNCTION public.upsert_calendar_candidate(
  p_connection_id           uuid,
  p_calendar_id             text,
  p_run_id                  uuid,
  p_user_id                 uuid,
  p_contact_id              uuid,
  p_google_sub              text,
  p_google_event_id         text,
  p_ical_uid                text,
  p_source_fingerprint      text,
  p_proposed_type           text,
  p_proposed_interaction_date date,
  p_proposed_notes          text,
  p_source_last_state       text,
  p_original_occurrence_at   timestamptz,
  p_original_occurrence_date date,
  p_event_start_at          timestamptz,
  p_event_end_at            timestamptz,
  p_event_start_date        date,
  p_event_end_date          date,
  p_event_timezone          text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cand   uuid;
  v_status text;
  v_lease  integer;
BEGIN
  -- Validate controlled inputs.
  IF p_calendar_id IS NULL OR p_calendar_id <> 'primary' THEN
    RAISE EXCEPTION 'invalid_calendar_id';
  END IF;
  IF p_source_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_fingerprint';
  END IF;
  IF p_proposed_type NOT IN ('Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other') THEN
    RAISE EXCEPTION 'invalid_proposed_type';
  END IF;
  IF p_source_last_state NOT IN ('active', 'cancelled', 'deleted') THEN
    RAISE EXCEPTION 'invalid_source_last_state';
  END IF;
  IF p_proposed_notes IS NOT NULL AND char_length(p_proposed_notes) > 200 THEN
    RAISE EXCEPTION 'invalid_notes_length';
  END IF;

  -- Run-ID fencing WITH a row lock (this is the FIRST lock taken, establishing a
  -- consistent lock order). FOR SHARE is the smallest lock that conflicts with the
  -- FOR-NO-KEY-UPDATE row lock taken by the UPDATE in claim/renew/release. Holding
  -- it from validation through the candidate + event-ref writes to COMMIT means a
  -- concurrent claim/reclaim/renew/release for this (connection, calendar) BLOCKS
  -- until this transaction finishes — so a stalled worker whose lease expired mid-
  -- flight cannot have its run silently reclaimed and then overwrite newer data.
  -- Multiple concurrent upserts for the SAME still-valid run share the lock (batch
  -- throughput) and write distinct candidates (distinct fingerprints).
  SELECT 1 INTO v_lease
  FROM public.google_calendar_sync_state
  WHERE connection_id   = p_connection_id
    AND calendar_id     = p_calendar_id
    AND sync_run_id     = p_run_id
    AND sync_status     = 'running'
    AND sync_lease_until IS NOT NULL
    AND sync_lease_until > now()
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_or_unowned_run';
  END IF;

  -- Connection must belong to the user AND match the supplied Google account.
  PERFORM 1 FROM public.google_connections
  WHERE id = p_connection_id AND user_id = p_user_id AND google_sub = p_google_sub;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connection_ownership_mismatch';
  END IF;

  -- Contact must belong to the same user.
  PERFORM 1 FROM public.contacts
  WHERE id = p_contact_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact_ownership_mismatch';
  END IF;

  -- Upsert the candidate. On conflict, refresh only safe mutable fields and ONLY
  -- while still pending — never resurrect accepted/dismissed/invalidated rows.
  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, proposed_notes, status, source_last_state, updated_at)
  VALUES
    (p_user_id, p_contact_id, 'google_calendar', p_source_fingerprint, p_proposed_type,
     p_proposed_interaction_date, p_proposed_notes, 'pending', p_source_last_state, now())
  ON CONFLICT (user_id, source_fingerprint) DO UPDATE
    SET proposed_type             = EXCLUDED.proposed_type,
        proposed_interaction_date = EXCLUDED.proposed_interaction_date,
        proposed_notes            = EXCLUDED.proposed_notes,
        source_last_state         = EXCLUDED.source_last_state,
        updated_at                = now()
    WHERE public.interaction_candidates.status = 'pending'
  RETURNING id INTO v_cand;

  -- Conflict on a non-pending row: DO UPDATE matched nothing -> resolve the id
  -- without changing the frozen candidate or its event ref.
  IF v_cand IS NULL THEN
    SELECT id INTO v_cand
    FROM public.interaction_candidates
    WHERE user_id = p_user_id AND source_fingerprint = p_source_fingerprint;
    RETURN v_cand;
  END IF;

  -- Only pending candidates get their event ref (re)written.
  SELECT status INTO v_status FROM public.interaction_candidates WHERE id = v_cand;
  IF v_status = 'pending' THEN
    INSERT INTO public.google_calendar_event_refs
      (candidate_id, user_id, connection_id, google_sub, calendar_id, google_event_id,
       ical_uid, original_occurrence_at, original_occurrence_date,
       event_start_at, event_end_at, event_start_date, event_end_date, event_timezone, updated_at)
    VALUES
      (v_cand, p_user_id, p_connection_id, p_google_sub, p_calendar_id, p_google_event_id,
       p_ical_uid, p_original_occurrence_at, p_original_occurrence_date,
       p_event_start_at, p_event_end_at, p_event_start_date, p_event_end_date, p_event_timezone, now())
    ON CONFLICT (candidate_id) DO UPDATE
      SET google_sub               = EXCLUDED.google_sub,
          google_event_id          = EXCLUDED.google_event_id,
          ical_uid                 = EXCLUDED.ical_uid,
          original_occurrence_at   = EXCLUDED.original_occurrence_at,
          original_occurrence_date = EXCLUDED.original_occurrence_date,
          event_start_at           = EXCLUDED.event_start_at,
          event_end_at             = EXCLUDED.event_end_at,
          event_start_date         = EXCLUDED.event_start_date,
          event_end_date           = EXCLUDED.event_end_date,
          event_timezone           = EXCLUDED.event_timezone,
          updated_at               = now();
  END IF;

  RETURN v_cand;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_calendar_candidate(
  uuid, text, uuid, uuid, uuid, text, text, text, text, text, date, text, text,
  timestamptz, date, timestamptz, timestamptz, date, date, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_calendar_candidate(
  uuid, text, uuid, uuid, uuid, text, text, text, text, text, date, text, text,
  timestamptz, date, timestamptz, timestamptz, date, date, text
) TO service_role;


-- ── RPC 5: store_refreshed_google_token ───────────────────────────────────────
-- Persist a refreshed (ALREADY ENCRYPTED) token pair + connection expiry/status in
-- one txn. Refresh ciphertext+nonce are preserved-both or replaced-both via a SINGLE
-- CASE predicate — never independently coalesced. Account-guarded by expected sub so
-- a stale account-A refresh can't overwrite reconnected account B. Rolls back the
-- whole RPC (never marks the connection active) if the token row is absent.

CREATE OR REPLACE FUNCTION public.store_refreshed_google_token(
  p_connection_id     uuid,
  p_expected_google_sub text,
  p_access_ct         text,
  p_access_nonce      text,
  p_refresh_ct        text,
  p_refresh_nonce     text,
  p_key_version       smallint,
  p_token_expires_at  timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_t integer;
  v_c integer;
BEGIN
  -- Access pair must be complete and non-empty.
  IF p_access_ct IS NULL OR p_access_ct = '' OR p_access_nonce IS NULL OR p_access_nonce = '' THEN
    RAISE EXCEPTION 'invalid_access_pair';
  END IF;
  -- Refresh pair: both supplied or both null — never one.
  IF (p_refresh_ct IS NULL) <> (p_refresh_nonce IS NULL) THEN
    RAISE EXCEPTION 'invalid_refresh_pair';
  END IF;
  IF p_refresh_ct = '' OR p_refresh_nonce = '' THEN
    RAISE EXCEPTION 'invalid_refresh_pair';
  END IF;
  -- Only key version 1 is supported today (GOOGLE_TOKEN_ENCRYPTION_KEY_V1 is the sole
  -- encryption key). Reject null, zero, negative, and any unsupported version — not
  -- merely null — so an unknown key_version can never be persisted.
  IF p_key_version IS NULL OR p_key_version <> 1 THEN
    RAISE EXCEPTION 'unsupported_key_version';
  END IF;
  -- A freshly refreshed Google access token must expire strictly in the future.
  -- Google access tokens have ~1h lifetime, so a strictly-future check needs no
  -- clock-skew tolerance; a NULL or non-future expiry indicates a caller bug and must
  -- not mark the connection 'active' (connections.token_expires_at is nullable, so
  -- this guard is the only thing preventing a no/indefinite-expiry active connection).
  IF p_token_expires_at IS NULL OR p_token_expires_at <= now() THEN
    RAISE EXCEPTION 'invalid_token_expiry';
  END IF;

  -- Account guard + row lock: refresh for account A must not touch reconnected B.
  PERFORM 1 FROM public.google_connections
  WHERE id = p_connection_id AND google_sub = p_expected_google_sub
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Replace tokens. Both refresh columns switch on the SAME predicate: null input
  -- preserves BOTH existing values, supplied input replaces BOTH together.
  UPDATE public.google_tokens
    SET access_token_ciphertext  = p_access_ct,
        access_token_nonce       = p_access_nonce,
        refresh_token_ciphertext = CASE WHEN p_refresh_ct IS NULL
                                        THEN refresh_token_ciphertext ELSE p_refresh_ct END,
        refresh_token_nonce      = CASE WHEN p_refresh_ct IS NULL
                                        THEN refresh_token_nonce ELSE p_refresh_nonce END,
        key_version              = p_key_version,
        updated_at               = now()
  WHERE connection_id = p_connection_id;
  GET DIAGNOSTICS v_t = ROW_COUNT;
  IF v_t <> 1 THEN
    RAISE EXCEPTION 'token_row_missing';  -- rolls back; connection never marked active
  END IF;

  UPDATE public.google_connections
    SET token_expires_at = p_token_expires_at,
        status           = 'active',
        updated_at       = now()
  WHERE id = p_connection_id;
  GET DIAGNOSTICS v_c = ROW_COUNT;
  IF v_c <> 1 THEN
    RAISE EXCEPTION 'connection_row_missing';
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.store_refreshed_google_token(
  uuid, text, text, text, text, text, smallint, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_refreshed_google_token(
  uuid, text, text, text, text, text, smallint, timestamptz
) TO service_role;


-- ── RPC 6: mark_google_needs_reauth ───────────────────────────────────────────
-- Flag a connection as needing re-auth, but ONLY when the supplied sub matches the
-- current connection — so a stale account-A failure can't flag reconnected B.
-- Never deletes or exposes token material. Returns whether exactly one row updated.

CREATE OR REPLACE FUNCTION public.mark_google_needs_reauth(
  p_connection_id       uuid,
  p_expected_google_sub text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.google_connections
    SET status = 'needs_reauth',
        updated_at = now()
  WHERE id = p_connection_id
    AND google_sub = p_expected_google_sub;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_google_needs_reauth(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_google_needs_reauth(uuid, text)
  TO service_role;
