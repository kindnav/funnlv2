-- Outlook — the write path for ONE pending interaction suggestion.
--
-- WHY THIS EXISTS, and why the Gmail RPC could not be reused.
--   `upsert_email_candidate` LOOKS provider-neutral: it accepts p_source 'outlook'.
--   But its lease fence reads `gmail_sync_state JOIN google_connections`, and it
--   writes `email_candidate_refs`, whose connection_id references
--   `google_connections`. Given a Microsoft connection id it returns
--   'unknown_connection', so routing Outlook through it is not merely untidy - it
--   cannot work, and forcing it to would mean pointing a Microsoft connection at
--   Google's tables. This function is the Outlook equivalent: same shape, fenced on
--   `outlook_sync_state`, recording provenance in `outlook_candidate_refs`.
--
-- SCOPE, deliberately narrow. It writes ONE row type: a PENDING interaction
-- suggestion for a contact the user ALREADY has.
--   * p_contact_id is REQUIRED. There is no new-contact path here: proposing a person
--     the user does not track needs the automation facts that live in message headers,
--     which the metadata pass does not read. That is a later slice.
--   * It writes NO conversation notes, NO summary, NO next step and NO subject line.
--     A metadata pass has seen only the envelope, so `proposed_notes`,
--     `retained_subject`, `draft_summary`, `draft_follow_up` and `summary_evidence`
--     are all left NULL. Inventing any of them would be fabrication, and the accept
--     RPC would then copy a fabricated note into a real interaction.
--   * It creates NO interaction and touches NO contact. Only the user's own
--     `accept_interaction_candidate` call can do that.
--
-- LEASE FENCING. The write is admitted only while the caller still holds the run's
-- lease on BOTH folders: `outlook_sync_state` must have exactly two rows for the
-- connection and every one of them must carry `sync_run_id = p_run_id`, status
-- 'running' and `sync_lease_until > now()`. Both rows are locked FOR SHARE first, in
-- the same order `release_outlook_sync_lease` and
-- `invalidate_outlook_candidates_by_fingerprint` take them, so a concurrent claim or
-- release cannot interleave.
--
-- WHY BOTH, not just Inbox: a reservation claims the two folders under one run id, and
-- an episode is assembled from Inbox AND Sent Items. A run holding only Inbox has not
-- seen the whole exchange, and another run may already be reading Sent Items. Anything
-- short of both gets 'stale_run' and writes nothing.
--
-- DEDUPLICATION, so a rerun does not duplicate. The episode fingerprint is the key.
-- A terminal row (accepted / dismissed / invalidated) is a TOMBSTONE and is never
-- resurrected: a user who dismissed a suggestion must not be shown it again. A pending
-- row is refreshed in place WITHOUT rewriting its stored fingerprint, so the
-- historical value survives a key rotation. `p_lookup_fingerprints` carries the same
-- episode under accepted PRIOR keys, so rotating the HMAC key cannot produce a second
-- suggestion for an exchange already recorded.
--
-- GRANTS. service_role only: this is a worker RPC, and a user must never be able to
-- manufacture a suggestion for themselves. Per the FUTURE RULE recorded in
-- 20260922175616, the revoke names PUBLIC, anon AND authenticated explicitly, because
-- this project's default privileges would otherwise grant all three at CREATE time.
--
-- NOT APPLIED. Do not run against Production without explicit approval.

CREATE OR REPLACE FUNCTION public.upsert_outlook_interaction_candidate(
  p_connection_id       uuid,
  p_run_id              uuid,
  p_contact_id          uuid,
  p_episode_fingerprint text,
  p_person_fingerprint  text,
  p_key_version         smallint,
  p_proposed_type       text,
  p_proposed_date       date,
  p_lookup_fingerprints text[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid     uuid;
  v_leaseok boolean;
  v_cand    uuid;
  v_status  text;
BEGIN
  -- ── shape validation, before any lock is taken ────────────────────────────
  IF p_episode_fingerprint IS NULL OR p_episode_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'invalid_fingerprint');
  END IF;
  IF p_person_fingerprint IS NOT NULL AND p_person_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'invalid_person_fingerprint');
  END IF;
  IF p_lookup_fingerprints IS NOT NULL THEN
    IF pg_catalog.array_length(p_lookup_fingerprints, 1) > 5 THEN
      RETURN jsonb_build_object('result', 'invalid_lookup_set');
    END IF;
    PERFORM 1 FROM pg_catalog.unnest(p_lookup_fingerprints) f WHERE f !~ '^[0-9a-f]{64}$';
    IF FOUND THEN
      RETURN jsonb_build_object('result', 'invalid_lookup_fingerprint');
    END IF;
  END IF;
  -- A metadata pass can only ever propose 'Email'. Accepting anything else here would
  -- let a worker assert a kind of interaction it has no evidence for; the USER may
  -- still override the type when they accept.
  IF p_proposed_type IS DISTINCT FROM 'Email' THEN
    RETURN jsonb_build_object('result', 'invalid_type');
  END IF;
  IF p_proposed_date IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_date');
  END IF;
  IF p_contact_id IS NULL THEN
    -- Not an error the worker should paper over: a suggestion with no contact is a
    -- new-contact proposal, which this slice does not implement.
    RETURN jsonb_build_object('result', 'contact_required');
  END IF;
  IF p_key_version IS NULL OR p_key_version < 1 THEN
    RETURN jsonb_build_object('result', 'invalid_key_version');
  END IF;

  -- ── lease fence: the run must own BOTH folders ────────────────────────────
  -- Deterministic lock order, matching reserve/renew/release and
  -- invalidate_outlook_candidates_by_fingerprint: take the connection's sync-state
  -- rows FOR SHARE first, then check them.
  PERFORM 1 FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id FOR SHARE;

  SELECT c.user_id INTO v_uid
  FROM public.microsoft_connections c WHERE c.id = p_connection_id;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('result', 'unknown_connection');
  END IF;

  -- CORRECTED: an earlier version checked only the 'inbox' row. A reservation claims
  -- BOTH folders under one run id, and an episode is assembled from Inbox AND Sent
  -- Items, so a run holding only one of them has not seen the whole exchange - and a
  -- second run could already be reading the other folder. Requiring both rows to
  -- belong to the same live run is what the reservation and invalidation RPCs already
  -- do; this now matches them.
  SELECT count(*) = 2 AND bool_and(s.sync_run_id = p_run_id
                                   AND s.sync_status = 'running'
                                   AND s.sync_lease_until IS NOT NULL
                                   AND s.sync_lease_until > now())
    INTO v_leaseok
  FROM public.outlook_sync_state s
  WHERE s.connection_id = p_connection_id;
  IF v_leaseok IS NOT TRUE THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;

  -- ── the contact must belong to the SAME user as the connection ────────────
  -- User-scoped, never cross-user: a worker holding one user's lease cannot attach a
  -- suggestion to another user's contact.
  PERFORM 1 FROM public.contacts ct
   WHERE ct.id = p_contact_id AND ct.user_id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'contact_not_owned');
  END IF;

  -- ── deduplicate across the write key AND any accepted prior keys ──────────
  SELECT id, status INTO v_cand
       , v_status
  FROM public.interaction_candidates
  WHERE user_id = v_uid
    AND source = 'outlook'
    AND source_fingerprint = ANY (
      pg_catalog.array_append(
        COALESCE(p_lookup_fingerprints, ARRAY[]::text[]), p_episode_fingerprint))
  ORDER BY (source_fingerprint = p_episode_fingerprint) DESC
  FOR UPDATE
  LIMIT 1;

  IF FOUND THEN
    IF v_status <> 'pending' THEN
      -- Tombstone. A dismissed or accepted exchange is never suggested again.
      RETURN jsonb_build_object('result', 'exists_terminal', 'candidate_id', v_cand);
    END IF;
    UPDATE public.interaction_candidates
       SET proposed_interaction_date = p_proposed_date,
           proposed_type            = p_proposed_type,
           context_expires_at       = now() + interval '30 days',
           updated_at               = now()
     WHERE id = v_cand;   -- source_fingerprint intentionally NOT rewritten
    RETURN jsonb_build_object('result', 'refreshed', 'candidate_id', v_cand);
  END IF;

  -- ── create the pending suggestion ─────────────────────────────────────────
  -- Every content column is omitted on purpose; see the header.
  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, status, source_last_state, context_expires_at)
  VALUES
    (v_uid, p_contact_id, 'outlook', p_episode_fingerprint, p_proposed_type,
     p_proposed_date, 'pending', 'active', now() + interval '30 days')
  RETURNING id INTO v_cand;

  -- Provenance: fingerprints and a key version only. No message id, no conversation
  -- id, no address, no subject - so this row cannot be used to find the mail item.
  INSERT INTO public.outlook_candidate_refs
    (user_id, connection_id, interaction_candidate_id, new_contact_candidate_id,
     episode_fingerprint, person_fingerprint, key_version)
  VALUES
    (v_uid, p_connection_id, v_cand, NULL,
     p_episode_fingerprint, p_person_fingerprint, p_key_version);

  RETURN jsonb_build_object('result', 'created', 'candidate_id', v_cand);
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_outlook_interaction_candidate(
  uuid, uuid, uuid, text, text, smallint, text, date, text[]
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.upsert_outlook_interaction_candidate(
  uuid, uuid, uuid, text, text, smallint, text, date, text[]
) TO service_role;


-- ══════════════════════════════════════════════════════════════════════════════
--  POST-APPLY VERIFICATION (read-only; run manually after `db push`)
-- ══════════════════════════════════════════════════════════════════════════════
--   -- service_role only, SECURITY DEFINER, pinned search_path
--   SELECT proname, prosecdef, proconfig, proacl
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND proname = 'upsert_outlook_interaction_candidate';
--   -- expect prosecdef = t, proconfig = {search_path=}, and
--   --        {postgres=X/postgres,service_role=X/postgres}
--
--   -- nothing was written by applying this
--   SELECT count(*) FROM public.interaction_candidates WHERE source = 'outlook';  -- 0
--   SELECT count(*) FROM public.outlook_candidate_refs;                           -- 0
--
--   -- the user-facing review RPCs are unchanged
--   SELECT proname, proacl FROM pg_proc WHERE proname IN
--     ('accept_interaction_candidate', 'dismiss_interaction_candidate');
