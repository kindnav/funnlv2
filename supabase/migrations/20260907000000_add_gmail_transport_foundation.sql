-- Email integration — Phase E2A: Gmail metadata transport & capability foundation.
--
-- SCOPE (E2A only): the ADDITIVE schema + service-role primitives a later dormant
-- Gmail transport worker will write into. This migration adds NO Edge Function, NO
-- scheduler, NO webhook, NO live OAuth scope, NO Gmail API call, NO UI, NO feature
-- flag, and NO secret. It is INTENTIONALLY NOT DEPLOYED / NOT APPLIED to production
-- by this phase (local ledger entry only). Production Gmail access remains blocked
-- behind Privacy-Policy + Google OAuth restricted-scope verification (human gates).
--
-- CALENDAR SAFETY: this migration is purely additive. It does not drop or narrow any
-- Calendar table, and it treats Gmail and Calendar as INDEPENDENT capabilities of one
-- Google identity. A Gmail failure must never disable Calendar and vice-versa.
--
-- WHAT THIS ADDS
--   1. Widen source / integration CHECK constraints to admit 'gmail' and 'outlook'
--      (backend-first; existing data preserved).
--   2. public.google_connection_capabilities  — per (connection, product) capability
--      lifecycle. Authenticated users read only SAFE status of their own rows.
--   3. public.gmail_sync_state                 — per-connection Gmail cursor + lease.
--                                                Service-role ONLY (history id hidden).
--   4. public.email_candidate_refs             — durable episode provenance for an
--                                                email-derived candidate. Service-role
--                                                ONLY. HMAC dedup key + key version.
--                                                NO raw ids/addresses/subjects/bodies.
--   5. interaction_candidates retained-context — retained_subject (<=160) +
--                                                context_expires_at (30-day pending TTL).
--   6. Service-role RPCs (SECURITY DEFINER, search_path='', fully-qualified, no dynamic
--      SQL, controlled codes only): gmail lease claim/renew/release (cursor advances
--      ONLY on a complete run), upsert_email_candidate, reconcile_email_episode,
--      expire_pending_email_context.
--   7. CREATE OR REPLACE accept_/dismiss_interaction_candidate: source-aware
--      provenance + immediate erasure of retained email context on resolution.
--
-- DESIGN CONSTRAINTS (permanent — do not change without approval):
--   - google_connections stays the ONE identity + encrypted refresh-token owner per
--     user. Refresh tokens are NEVER duplicated per capability.
--   - Provider identifiers (gmail message id, thread id, history id, addresses,
--     subjects) NEVER reach the browser and NEVER land in email_candidate_refs.
--   - source_fingerprint is a server-generated HMAC hex dedup key, NEVER granted to
--     authenticated (it would leak the hashed provider identity).
--   - The durable Gmail history cursor advances ONLY when the processed range is
--     complete. Incomplete provider results never advance the cursor and never mark a
--     run complete.
--
-- Follows the hardening pattern of 20260816 (oauth foundation) / 20260817 (calendar
-- ingestion): REVOKE ALL then GRANT only the minimum; service_role gets GRANT ALL.
-- All functions: SECURITY DEFINER, SET search_path = '', fully-qualified objects,
-- EXECUTE revoked from PUBLIC/anon (+authenticated for service-only), deterministic
-- lock order documented per function.


-- ══════════════════════════════════════════════════════════════════════════════
--  1. Widen source / integration CHECK constraints (additive; data preserved)
-- ══════════════════════════════════════════════════════════════════════════════
-- These DROP + re-ADD the NAMED constraints from earlier migrations. We never edit an
-- applied migration; a later migration widening a CHECK is the supported pattern. All
-- existing values ('google_calendar', 'manual', 'calendar') remain valid.

ALTER TABLE public.interaction_candidates
  DROP CONSTRAINT IF EXISTS interaction_candidates_source_check;
ALTER TABLE public.interaction_candidates
  ADD CONSTRAINT interaction_candidates_source_check
  CHECK (source IN ('google_calendar', 'gmail', 'outlook'));

ALTER TABLE public.interactions
  DROP CONSTRAINT IF EXISTS interactions_source_check;
ALTER TABLE public.interactions
  ADD CONSTRAINT interactions_source_check
  CHECK (source IN ('manual', 'google_calendar', 'gmail', 'outlook'));

ALTER TABLE public.google_oauth_states
  DROP CONSTRAINT IF EXISTS google_oauth_states_integration_check;
ALTER TABLE public.google_oauth_states
  ADD CONSTRAINT google_oauth_states_integration_check
  CHECK (integration_type IN ('calendar', 'gmail'));

-- Composite uniqueness on (id, user_id) so the additive capability/sync/ref tables below
-- can enforce, via a COMPOSITE FK, that their (connection_id, user_id) pair always matches
-- the connection's real owner — a capability/ref can never belong to a connection and a
-- DIFFERENT user simultaneously. id is already the PK, so this is trivially satisfied and
-- purely additive (no data can violate it).
ALTER TABLE public.google_connections
  DROP CONSTRAINT IF EXISTS google_connections_id_user_key;
ALTER TABLE public.google_connections
  ADD CONSTRAINT google_connections_id_user_key UNIQUE (id, user_id);


-- ══════════════════════════════════════════════════════════════════════════════
--  2. google_connection_capabilities — per (connection, product) capability
-- ══════════════════════════════════════════════════════════════════════════════
-- Calendar and Gmail are INDEPENDENT capabilities of one identity. This lets us mark
-- Gmail needs_reauth without touching Calendar (and vice-versa). No token columns here
-- (tokens stay in google_tokens, shared per connection). Authenticated users read ONLY
-- their own safe status; they cannot read internal result codes' provider detail
-- (result codes are controlled enums, safe) — but never tokens/cursors/refs.

CREATE TABLE public.google_connection_capabilities (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id  uuid        NOT NULL,
  user_id        uuid        NOT NULL REFERENCES auth.users(id)                ON DELETE CASCADE,
  product        text        NOT NULL,   -- 'calendar' | 'gmail'
  status         text        NOT NULL DEFAULT 'active',
  granted        boolean     NOT NULL DEFAULT false,  -- scope currently granted+usable
  needs_reauth   boolean     NOT NULL DEFAULT false,
  last_success_at timestamptz,
  last_result_code text,     -- controlled code only (no provider detail)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT gcc_product_check      CHECK (product IN ('calendar', 'gmail')),
  CONSTRAINT gcc_status_check       CHECK (status IN ('active', 'needs_reauth', 'revoked', 'disabled')),
  CONSTRAINT gcc_result_code_len    CHECK (last_result_code IS NULL OR char_length(last_result_code) <= 100),
  CONSTRAINT gcc_connection_product_unique UNIQUE (connection_id, product),
  -- Composite FK: the (connection_id, user_id) pair MUST match the connection's real
  -- owner, so a capability can never belong to a connection and a different user.
  CONSTRAINT gcc_conn_user_fk FOREIGN KEY (connection_id, user_id)
    REFERENCES public.google_connections(id, user_id) ON DELETE CASCADE
);

CREATE INDEX google_connection_capabilities_user_idx
  ON public.google_connection_capabilities (user_id);
CREATE INDEX google_connection_capabilities_connection_idx
  ON public.google_connection_capabilities (connection_id);

ALTER TABLE public.google_connection_capabilities ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.google_connection_capabilities FROM PUBLIC;
REVOKE ALL ON TABLE public.google_connection_capabilities FROM anon;
REVOKE ALL ON TABLE public.google_connection_capabilities FROM authenticated;
-- Column-level SELECT of SAFE status only. Excludes id/connection_id (internal linkage).
GRANT SELECT (
  product, status, granted, needs_reauth, last_success_at, last_result_code, updated_at
) ON TABLE public.google_connection_capabilities TO authenticated;
GRANT ALL ON TABLE public.google_connection_capabilities TO service_role;
-- No INSERT/UPDATE/DELETE for authenticated: all writes go through service-role RPCs.

CREATE POLICY "gcc_select_own"
  ON public.google_connection_capabilities
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);


-- ══════════════════════════════════════════════════════════════════════════════
--  3. gmail_sync_state — per-connection Gmail cursor + lease (service-role ONLY)
-- ══════════════════════════════════════════════════════════════════════════════
-- Mirrors google_calendar_sync_state. The Gmail incremental cursor (history_id) is an
-- internal provider identifier and is NEVER exposed to clients (RLS on, no grant, no
-- policy). initial_import_done gates History-API incremental mode.

CREATE TABLE public.gmail_sync_state (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id       uuid        NOT NULL,
  user_id             uuid        NOT NULL REFERENCES auth.users(id)                ON DELETE CASCADE,
  history_id          text,                    -- Gmail History API cursor (opaque; hidden from clients)
  initial_import_done boolean     NOT NULL DEFAULT false,
  backfilled_through  timestamptz,             -- oldest instant of the bounded initial import
  last_synced_at      timestamptz,
  sync_status         text        NOT NULL DEFAULT 'idle',
  sync_lease_until    timestamptz,
  sync_run_id         uuid,
  last_error_code     text,
  last_run_complete   boolean     NOT NULL DEFAULT false,
  retry_count         integer     NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT gss2_status_check     CHECK (sync_status IN ('idle', 'running', 'error')),
  CONSTRAINT gss2_error_code_len   CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 100),
  CONSTRAINT gss2_history_id_len   CHECK (history_id IS NULL OR char_length(history_id) <= 256),
  CONSTRAINT gss2_retry_nonneg     CHECK (retry_count >= 0),
  -- A 'running' row must carry an owning run and a lease deadline.
  CONSTRAINT gss2_running_requires_lease
    CHECK (sync_status <> 'running' OR (sync_run_id IS NOT NULL AND sync_lease_until IS NOT NULL)),
  CONSTRAINT gss2_connection_unique UNIQUE (connection_id),
  CONSTRAINT gss2_conn_user_fk FOREIGN KEY (connection_id, user_id)
    REFERENCES public.google_connections(id, user_id) ON DELETE CASCADE
);

CREATE INDEX gmail_sync_state_connection_idx ON public.gmail_sync_state (connection_id);
CREATE INDEX gmail_sync_state_user_idx       ON public.gmail_sync_state (user_id);

ALTER TABLE public.gmail_sync_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gmail_sync_state FROM PUBLIC;
REVOKE ALL ON TABLE public.gmail_sync_state FROM anon;
REVOKE ALL ON TABLE public.gmail_sync_state FROM authenticated;
GRANT ALL  ON TABLE public.gmail_sync_state TO service_role;
-- Intentionally NO GRANT and NO POLICY for authenticated: cursor/lease never leak.


-- ══════════════════════════════════════════════════════════════════════════════
--  4. email_candidate_refs — durable episode provenance (service-role ONLY)
-- ══════════════════════════════════════════════════════════════════════════════
-- RLS on, NO policy, NO grant to authenticated/anon: unreadable by clients.
-- candidate_id is the PRIMARY KEY (one durable episode ref per email candidate).
-- Stores ONLY the HMAC dedup fingerprint + key version + coarse provenance. It stores
-- NO raw Gmail message id, thread id, history id, email address, subject, body,
-- preview, HTML, attachment, recipient list, or provider response. No reversible
-- opaque provider reference is stored: E2A does not require reversible retrieval, so
-- per the design rule it is OMITTED (a future phase that proves the need will add an
-- encrypted, key-rotation-aware reference in its own migration).

CREATE TABLE public.email_candidate_refs (
  candidate_id       uuid        PRIMARY KEY
                                 REFERENCES public.interaction_candidates(id) ON DELETE CASCADE,
  user_id            uuid        NOT NULL REFERENCES auth.users(id)             ON DELETE CASCADE,
  connection_id      uuid        NOT NULL,
  provider           text        NOT NULL,
  source_fingerprint text        NOT NULL,   -- HMAC-SHA256 hex dedup key (matches emailFingerprint.js)
  key_version        smallint    NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ecr_provider_check     CHECK (provider IN ('gmail', 'outlook')),
  CONSTRAINT ecr_fingerprint_shape  CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ecr_key_version_pos    CHECK (key_version >= 1),
  CONSTRAINT ecr_conn_user_fk FOREIGN KEY (connection_id, user_id)
    REFERENCES public.google_connections(id, user_id) ON DELETE CASCADE
);

CREATE INDEX email_candidate_refs_user_idx ON public.email_candidate_refs (user_id);
-- Dedup / prior-key lookup index: (user, fingerprint) mirrors the candidate uniqueness.
CREATE INDEX email_candidate_refs_fp_idx   ON public.email_candidate_refs (user_id, source_fingerprint);

ALTER TABLE public.email_candidate_refs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.email_candidate_refs FROM PUBLIC;
REVOKE ALL ON TABLE public.email_candidate_refs FROM anon;
REVOKE ALL ON TABLE public.email_candidate_refs FROM authenticated;
GRANT ALL  ON TABLE public.email_candidate_refs TO service_role;
-- Intentionally NO GRANT and NO POLICY for authenticated: provider provenance never leaks.


-- ══════════════════════════════════════════════════════════════════════════════
--  5. interaction_candidates retained-context (sanitized eligible-only subject + TTL)
-- ══════════════════════════════════════════════════════════════════════════════
-- retained_subject: the sanitized subject preview, stored ONLY for an eligible pending
-- suggestion (<=160 chars). context_expires_at: 30-day pending-context TTL. Both are
-- erased immediately on accept/dismiss/invalidate (see RPCs below), leaving only the
-- minimal HMAC tombstone (source_fingerprint + email_candidate_refs) for dedup.

ALTER TABLE public.interaction_candidates
  ADD COLUMN IF NOT EXISTS retained_subject   text,
  ADD COLUMN IF NOT EXISTS context_expires_at timestamptz;

-- Length cap (<=160) AND a control-character backstop: a stored subject must never
-- contain C0/DEL control characters (defense-in-depth against an unsanitized caller;
-- E1's sanitizeSubjectPreview already strips these, and upsert_email_candidate rejects
-- them with a controlled code before this CHECK is ever reached).
ALTER TABLE public.interaction_candidates
  DROP CONSTRAINT IF EXISTS interaction_candidates_retained_subject_len;
ALTER TABLE public.interaction_candidates
  ADD CONSTRAINT interaction_candidates_retained_subject_len
  CHECK (retained_subject IS NULL
         OR (char_length(retained_subject) <= 160 AND retained_subject !~ '[[:cntrl:]]'));

-- The review UI must be able to show the user their own sanitized subject preview, so
-- extend the authenticated column-level SELECT grant to include retained_subject ONLY.
-- context_expires_at stays INTERNAL (never granted): it is lifecycle bookkeeping, not
-- user-facing. RLS still restricts every read to the caller's own rows.
GRANT SELECT (retained_subject) ON TABLE public.interaction_candidates TO authenticated;


-- ══════════════════════════════════════════════════════════════════════════════
--  SERVICE-ROLE RPCs
-- ══════════════════════════════════════════════════════════════════════════════

-- ── RPC: claim_gmail_sync_lease ───────────────────────────────────────────────
-- Atomically insert-or-claim the gmail sync-state row when idle/error or the lease
-- expired. Returns a fresh sync_run_id, or NULL when a valid lease is held elsewhere.
CREATE OR REPLACE FUNCTION public.claim_gmail_sync_lease(
  p_connection_id uuid,
  p_lease_seconds integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_run uuid;
  v_uid uuid;
  v_n   integer;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid_lease_seconds';
  END IF;

  -- Resolve owning user from the connection (never caller-supplied).
  SELECT c.user_id INTO v_uid
  FROM public.google_connections c
  WHERE c.id = p_connection_id;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unknown_connection';
  END IF;

  v_run := pg_catalog.gen_random_uuid();

  INSERT INTO public.gmail_sync_state
    (connection_id, user_id, sync_status, sync_lease_until, sync_run_id, updated_at)
  VALUES
    (p_connection_id, v_uid, 'running',
     now() + make_interval(secs => p_lease_seconds), v_run, now())
  ON CONFLICT (connection_id) DO UPDATE
    SET sync_status      = 'running',
        sync_lease_until = now() + make_interval(secs => p_lease_seconds),
        sync_run_id      = v_run,
        updated_at       = now()
    WHERE public.gmail_sync_state.sync_status <> 'running'
       OR public.gmail_sync_state.sync_lease_until IS NULL
       OR public.gmail_sync_state.sync_lease_until < now();

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RETURN v_run;
  END IF;
  RETURN NULL;  -- a valid lease is held by another run; claim refused
END;
$$;

REVOKE ALL ON FUNCTION public.claim_gmail_sync_lease(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_gmail_sync_lease(uuid, integer) TO service_role;


-- ── RPC: renew_gmail_sync_lease (heartbeat) ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.renew_gmail_sync_lease(
  p_connection_id uuid,
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

  UPDATE public.gmail_sync_state
    SET sync_lease_until = now() + make_interval(secs => p_lease_seconds),
        updated_at       = now()
  WHERE connection_id    = p_connection_id
    AND sync_run_id      = p_run_id
    AND sync_status      = 'running'
    AND sync_lease_until IS NOT NULL
    AND sync_lease_until > now();

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_gmail_sync_lease(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_gmail_sync_lease(uuid, uuid, integer) TO service_role;


-- ── RPC: release_gmail_sync_lease ─────────────────────────────────────────────
-- Release the lease held by p_run_id, recording status + completion. The durable
-- history cursor (history_id) advances ONLY when p_run_complete IS TRUE and a
-- non-null p_history_id is supplied AND this run still owns the row. An incomplete or
-- failed run leaves history_id UNCHANGED (never advances on incomplete processing).
CREATE OR REPLACE FUNCTION public.release_gmail_sync_lease(
  p_connection_id uuid,
  p_run_id        uuid,
  p_status        text,
  p_error_code    text,
  p_run_complete  boolean,
  p_history_id    text,
  p_initial_done  boolean,
  p_retry_backoff_seconds integer
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
  IF p_history_id IS NOT NULL AND char_length(p_history_id) > 256 THEN
    RAISE EXCEPTION 'invalid_history_id';
  END IF;
  IF p_retry_backoff_seconds IS NOT NULL AND (p_retry_backoff_seconds < 0 OR p_retry_backoff_seconds > 604800) THEN
    RAISE EXCEPTION 'invalid_backoff';
  END IF;
  IF p_run_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.gmail_sync_state
    SET sync_status       = p_status,
        sync_lease_until  = NULL,
        sync_run_id       = NULL,
        last_synced_at    = now(),
        last_run_complete = COALESCE(p_run_complete, false),
        -- Cursor advances ONLY on a complete run with a supplied history id.
        history_id        = CASE WHEN COALESCE(p_run_complete, false) AND p_history_id IS NOT NULL
                                 THEN p_history_id ELSE public.gmail_sync_state.history_id END,
        initial_import_done = CASE WHEN COALESCE(p_run_complete, false) AND COALESCE(p_initial_done, false)
                                 THEN true ELSE public.gmail_sync_state.initial_import_done END,
        last_error_code   = CASE WHEN p_status = 'error' THEN p_error_code ELSE NULL END,
        retry_count       = CASE WHEN p_status = 'error'
                                 THEN public.gmail_sync_state.retry_count + 1 ELSE 0 END,
        next_attempt_at   = CASE WHEN p_status = 'error' AND p_retry_backoff_seconds IS NOT NULL
                                 THEN now() + make_interval(secs => p_retry_backoff_seconds) ELSE NULL END,
        updated_at        = now()
  WHERE connection_id = p_connection_id
    AND sync_run_id   = p_run_id;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.release_gmail_sync_lease(uuid, uuid, text, text, boolean, text, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_gmail_sync_lease(uuid, uuid, text, text, boolean, text, boolean, integer) TO service_role;


-- ── RPC: upsert_email_candidate ───────────────────────────────────────────────
-- Create/refresh ONE email-derived candidate + its provenance ref, run-fenced.
-- Lock order (documented, deterministic): gmail_sync_state FOR SHARE FIRST (blocks a
-- concurrent claim/renew/release), then the candidate row. Returns a controlled code.
-- retained_subject is stored ONLY here (eligible path); context_expires_at = 30 days.
CREATE OR REPLACE FUNCTION public.upsert_email_candidate(
  p_connection_id     uuid,
  p_run_id            uuid,
  p_contact_id        uuid,
  p_source            text,     -- 'gmail'|'outlook'
  p_fingerprint       text,     -- HMAC hex (CURRENT write key)
  p_key_version       smallint,
  p_proposed_type     text,
  p_proposed_date     date,
  p_retained_subject  text,
  p_proposed_notes    text,
  p_lookup_fingerprints text[] DEFAULT NULL  -- accepted PRIOR-key fingerprints (rotation dedup)
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid    uuid;
  v_cand   uuid;
  v_status text;
  v_leaseok boolean;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('gmail', 'outlook') THEN
    RETURN jsonb_build_object('result', 'invalid_source');
  END IF;
  IF p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'invalid_fingerprint');
  END IF;
  -- Bounded, well-formed prior-key lookup set (defense against rotation duplicates).
  IF p_lookup_fingerprints IS NOT NULL THEN
    IF pg_catalog.array_length(p_lookup_fingerprints, 1) > 5 THEN
      RETURN jsonb_build_object('result', 'invalid_lookup_set');
    END IF;
    PERFORM 1 FROM pg_catalog.unnest(p_lookup_fingerprints) f WHERE f !~ '^[0-9a-f]{64}$';
    IF FOUND THEN
      RETURN jsonb_build_object('result', 'invalid_lookup_fingerprint');
    END IF;
  END IF;
  IF p_proposed_type IS NULL OR p_proposed_type NOT IN ('Coffee chat','Email','Event','Call','Message','Other') THEN
    RETURN jsonb_build_object('result', 'invalid_type');
  END IF;
  IF p_proposed_date IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_date');
  END IF;
  IF p_retained_subject IS NOT NULL
     AND (char_length(p_retained_subject) > 160 OR p_retained_subject ~ '[[:cntrl:]]') THEN
    RETURN jsonb_build_object('result', 'invalid_subject');
  END IF;
  IF p_proposed_notes IS NOT NULL AND char_length(p_proposed_notes) > 200 THEN
    RETURN jsonb_build_object('result', 'invalid_notes');
  END IF;

  -- Lock the sync-state row FOR SHARE first (deterministic lock order); this fences
  -- against a concurrent lease claim/renew/release for the same connection.
  SELECT (s.sync_run_id = p_run_id
          AND s.sync_status = 'running'
          AND s.sync_lease_until IS NOT NULL
          AND s.sync_lease_until > now()),
         c.user_id
    INTO v_leaseok, v_uid
  FROM public.gmail_sync_state s
  JOIN public.google_connections c ON c.id = s.connection_id
  WHERE s.connection_id = p_connection_id
  FOR SHARE OF s;

  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('result', 'unknown_connection');
  END IF;
  IF v_leaseok IS NOT TRUE THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;

  -- Contact must belong to the same owning user (user-scoped; never cross-user).
  PERFORM 1 FROM public.contacts ct WHERE ct.id = p_contact_id AND ct.user_id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'contact_not_owned');
  END IF;

  -- Dedup across the CURRENT (write) fingerprint AND any accepted PRIOR-key
  -- fingerprints, so a key rotation never creates a duplicate candidate for the same
  -- episode. A terminal row is a tombstone (never resurrected). A pending row is
  -- refreshed WITHOUT rewriting its stored (historical) fingerprint.
  SELECT id, status INTO v_cand, v_status
  FROM public.interaction_candidates
  WHERE user_id = v_uid
    AND source_fingerprint = ANY (
      pg_catalog.array_append(COALESCE(p_lookup_fingerprints, ARRAY[]::text[]), p_fingerprint))
  ORDER BY (source_fingerprint = p_fingerprint) DESC
  FOR UPDATE
  LIMIT 1;

  IF FOUND THEN
    IF v_status <> 'pending' THEN
      RETURN jsonb_build_object('result', 'exists_terminal');  -- tombstone; never resurrect
    END IF;
    UPDATE public.interaction_candidates
      SET proposed_interaction_date = p_proposed_date,
          proposed_type   = p_proposed_type,
          proposed_notes  = p_proposed_notes,
          retained_subject = p_retained_subject,
          context_expires_at = now() + interval '30 days',
          updated_at      = now()
      WHERE id = v_cand;   -- source_fingerprint intentionally NOT rewritten (historical fp preserved)
    RETURN jsonb_build_object('result', 'refreshed');
  END IF;

  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, proposed_notes, retained_subject, context_expires_at, status)
  VALUES
    (v_uid, p_contact_id, p_source, p_fingerprint, p_proposed_type,
     p_proposed_date, p_proposed_notes, p_retained_subject, now() + interval '30 days', 'pending')
  RETURNING id INTO v_cand;

  INSERT INTO public.email_candidate_refs
    (candidate_id, user_id, connection_id, provider, source_fingerprint, key_version)
  VALUES
    (v_cand, v_uid, p_connection_id, p_source, p_fingerprint, COALESCE(p_key_version, 1));

  RETURN jsonb_build_object('result', 'created');
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_email_candidate(uuid, uuid, uuid, text, text, smallint, text, date, text, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_email_candidate(uuid, uuid, uuid, text, text, smallint, text, date, text, text, text[]) TO service_role;


-- ── RPC: reconcile_email_episode ──────────────────────────────────────────────
-- Invalidate a PENDING gmail/outlook candidate whose fingerprint is no longer in the
-- keep-set for the processed episode. Run-fenced; erases retained context on
-- invalidation (keeps the tombstone). Mirrors reconcile_calendar_occurrence.
CREATE OR REPLACE FUNCTION public.reconcile_email_episode(
  p_connection_id uuid,
  p_run_id        uuid,
  p_keep_fingerprints text[]
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
  SELECT (s.sync_run_id = p_run_id
          AND s.sync_status = 'running'
          AND s.sync_lease_until IS NOT NULL
          AND s.sync_lease_until > now()),
         c.user_id
    INTO v_leaseok, v_uid
  FROM public.gmail_sync_state s
  JOIN public.google_connections c ON c.id = s.connection_id
  WHERE s.connection_id = p_connection_id
  FOR SHARE OF s;

  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('result', 'unknown_connection');
  END IF;
  IF v_leaseok IS NOT TRUE THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;

  UPDATE public.interaction_candidates ic
    SET status = 'invalidated',
        retained_subject = NULL,
        context_expires_at = NULL,
        updated_at = now()
  FROM public.email_candidate_refs r
  WHERE r.candidate_id = ic.id
    AND r.connection_id = p_connection_id
    AND ic.user_id = v_uid
    AND ic.status = 'pending'
    AND NOT (ic.source_fingerprint = ANY (COALESCE(p_keep_fingerprints, ARRAY[]::text[])));

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('result', 'reconciled', 'invalidated', v_n);
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_email_episode(uuid, uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_email_episode(uuid, uuid, text[]) TO service_role;


-- ── RPC: expire_pending_email_context ─────────────────────────────────────────
-- 30-day pending-context cleanup: erase retained_subject + context on pending
-- candidates whose context_expires_at has passed (keeps the row + tombstone).
CREATE OR REPLACE FUNCTION public.expire_pending_email_context()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.interaction_candidates
    SET retained_subject = NULL,
        context_expires_at = NULL,
        updated_at = now()
  WHERE status = 'pending'
    AND context_expires_at IS NOT NULL
    AND context_expires_at < now()
    AND retained_subject IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_pending_email_context() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_pending_email_context() TO service_role;


-- ══════════════════════════════════════════════════════════════════════════════
--  6. Source-aware accept/dismiss + retained-context erasure (CREATE OR REPLACE)
-- ══════════════════════════════════════════════════════════════════════════════
-- Prior migrations are untouched. The ONLY changes vs the reviewed functions:
--   accept: interaction.source is taken from the candidate's source (was hardcoded
--           'google_calendar'); on success the retained email context is erased.
--   dismiss: on transition to dismissed, retained email context is erased.
-- User identity remains auth.uid(); accepted interaction receives ONLY the
-- user-reviewed note (retained_subject is never copied into the interaction).

CREATE OR REPLACE FUNCTION public.accept_interaction_candidate(
  p_candidate_id   uuid,
  p_override_type  text DEFAULT NULL,
  p_override_date  date DEFAULT NULL,
  p_override_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid   uuid := (SELECT auth.uid());
  v_cand  public.interaction_candidates%ROWTYPE;
  v_type  text;
  v_date  date;
  v_notes text;
  v_src   text;
  v_iid   uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('result', 'unauthenticated');
  END IF;

  -- Lock the caller's own candidate. Missing OR foreign → identical not_found.
  SELECT * INTO v_cand
  FROM public.interaction_candidates
  WHERE id = p_candidate_id AND user_id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  -- Terminal / non-pending states (idempotent + controlled conflicts).
  IF v_cand.status = 'accepted' THEN
    IF v_cand.interaction_id IS NOT NULL THEN
      RETURN jsonb_build_object('result', 'already_accepted', 'interaction_id', v_cand.interaction_id);
    ELSE
      -- accepted + NULL = the created interaction was later deleted; NEVER recreate it.
      RETURN jsonb_build_object('result', 'interaction_previously_deleted');
    END IF;
  ELSIF v_cand.status = 'dismissed' THEN
    RETURN jsonb_build_object('result', 'dismissed');
  ELSIF v_cand.status = 'invalidated' THEN
    RETURN jsonb_build_object('result', 'invalidated');
  END IF;

  -- status is 'pending' here. An inactive source (cancelled/deleted event) cannot accept.
  -- (PRESERVED from the applied Calendar-review version — unchanged for E2A.)
  IF v_cand.source_last_state <> 'active' THEN
    RETURN jsonb_build_object('result', 'invalidated');
  END IF;

  -- Resolve + validate the final interaction fields (overrides optional). Validation
  -- runs before any write. Notes bound 200 matches the candidate schema.
  v_type := COALESCE(p_override_type, v_cand.proposed_type);
  IF v_type NOT IN ('Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other') THEN
    RETURN jsonb_build_object('result', 'invalid_type');
  END IF;
  v_date := COALESCE(p_override_date, v_cand.proposed_interaction_date);
  IF v_date IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_date');
  END IF;
  v_notes := COALESCE(p_override_notes, v_cand.proposed_notes);
  IF v_notes IS NOT NULL AND char_length(v_notes) > 200 THEN
    RETURN jsonb_build_object('result', 'invalid_notes');
  END IF;

  -- E2A CHANGE #1 (source-aware provenance): the interaction's source is taken from the
  -- candidate's source (was hardcoded 'google_calendar'). All admitted by the widened
  -- interactions_source_check; an unknown source fails closed to 'manual'.
  v_src := CASE WHEN v_cand.source IN ('google_calendar', 'gmail', 'outlook')
                THEN v_cand.source ELSE 'manual' END;

  -- Ownership re-check + write, in ONE transaction (PRESERVED). The contact is locked
  -- FOR KEY SHARE so it cannot be deleted between this check and the INSERT. The
  -- EXCEPTION block converts concurrent-delete / lock-cycle outcomes into controlled
  -- codes instead of leaking a raw SQL error; the failed write rolls back atomically.
  BEGIN
    PERFORM 1 FROM public.contacts
      WHERE id = v_cand.contact_id AND user_id = v_uid
      FOR KEY SHARE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('result', 'not_found');
    END IF;

    -- user_id is set explicitly (never taken from the caller). The accepted interaction
    -- receives ONLY the user-reviewed note; retained_subject is never copied in.
    INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes, source)
    VALUES (v_cand.contact_id, v_uid, v_type, v_date, v_notes, v_src)
    RETURNING id INTO v_iid;

    -- E2A CHANGE #2: erase retained email context on resolution (calendar candidates
    -- have NULL retained context → no-op; behavior for them is unchanged).
    UPDATE public.interaction_candidates
      SET status = 'accepted', interaction_id = v_iid,
          retained_subject = NULL, context_expires_at = NULL, updated_at = now()
    WHERE id = p_candidate_id;
  EXCEPTION
    WHEN foreign_key_violation THEN
      -- Contact concurrently deleted; indistinguishable from "not yours".
      RETURN jsonb_build_object('result', 'not_found');
    WHEN deadlock_detected OR serialization_failure THEN
      -- Transient lock cycle (e.g. concurrent contact delete). Safe to retry.
      RETURN jsonb_build_object('result', 'conflict');
  END;

  RETURN jsonb_build_object('result', 'accepted', 'interaction_id', v_iid);
END;
$$;

REVOKE ALL ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text) TO authenticated;


CREATE OR REPLACE FUNCTION public.dismiss_interaction_candidate(
  p_candidate_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid    uuid := (SELECT auth.uid());
  v_status text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('result', 'unauthenticated');
  END IF;

  SELECT status INTO v_status
  FROM public.interaction_candidates
  WHERE id = p_candidate_id AND user_id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  IF v_status = 'pending' THEN
    UPDATE public.interaction_candidates
      SET status = 'dismissed',
          retained_subject = NULL,     -- erase retained email context on resolution
          context_expires_at = NULL,
          updated_at = now()
      WHERE id = p_candidate_id AND user_id = v_uid;
    RETURN jsonb_build_object('result', 'dismissed');
  ELSIF v_status = 'dismissed' THEN
    RETURN jsonb_build_object('result', 'already_dismissed');
  ELSIF v_status = 'accepted' THEN
    RETURN jsonb_build_object('result', 'already_accepted');
  ELSE
    RETURN jsonb_build_object('result', 'invalidated');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.dismiss_interaction_candidate(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dismiss_interaction_candidate(uuid) TO authenticated;
