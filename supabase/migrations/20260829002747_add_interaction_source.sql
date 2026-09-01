-- Google integration — interaction source provenance.
--
-- Adds a durable, constrained `source` column to public.interactions so the UI can
-- show where an interaction came from. Existing/manual interactions are 'manual';
-- interactions created by accept_interaction_candidate are 'google_calendar'.
--
-- No provider identifiers are stored here — only a coarse, safe origin label. Event
-- ids, fingerprints, attendees, tokens, and refs stay in the service-only tables.
--
-- NOT DEPLOYED / NOT APPLIED to production by this change (local-only ledger entry).

-- ── 1. constrained source column (default keeps every existing insert path working) ──
ALTER TABLE public.interactions
  ADD COLUMN source text NOT NULL DEFAULT 'manual';

ALTER TABLE public.interactions
  ADD CONSTRAINT interactions_source_check
  CHECK (source IN ('manual', 'google_calendar'));

-- ── 2. backfill already-accepted Google Calendar candidates ──────────────────────────
-- Tag ONLY interactions that were actually created from an accepted google_calendar
-- candidate, joined through interaction_candidates.interaction_id, with matching
-- ownership (candidate and interaction must belong to the same user). Every other
-- interaction keeps the 'manual' default.
UPDATE public.interactions AS i
  SET source = 'google_calendar'
FROM public.interaction_candidates AS c
WHERE c.interaction_id = i.id
  AND c.status         = 'accepted'
  AND c.source         = 'google_calendar'
  AND c.user_id        = i.user_id;

-- ── 3. accept_interaction_candidate: persist google_calendar provenance atomically ───
-- CREATE OR REPLACE only (the prior migration is untouched). The ONLY change from the
-- reviewed function is that the interaction INSERT now sets source = 'google_calendar'
-- in the same statement/transaction as the interaction + candidate update.
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
  IF v_cand.source_last_state <> 'active' THEN
    RETURN jsonb_build_object('result', 'invalidated');
  END IF;

  -- Resolve + validate the final interaction fields (overrides optional). Validation
  -- runs before any write. The notes bound is 200 to match the candidate schema
  -- (interaction_candidates_notes_len), so the frontend input, the candidate table,
  -- and the accepted interaction all agree on the same limit.
  v_type := COALESCE(p_override_type, v_cand.proposed_type);
  IF v_type NOT IN ('Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other') THEN
    RETURN jsonb_build_object('result', 'invalid_type');
  END IF;
  v_date := COALESCE(p_override_date, v_cand.proposed_interaction_date);
  IF v_date IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_date');
  END IF;
  -- A NULL/omitted override keeps the proposed note; there is intentionally no way to
  -- accept with an empty note (the proposed note is the point of the suggestion).
  v_notes := COALESCE(p_override_notes, v_cand.proposed_notes);
  IF v_notes IS NOT NULL AND char_length(v_notes) > 200 THEN
    RETURN jsonb_build_object('result', 'invalid_notes');
  END IF;

  -- Ownership re-check + write, in ONE transaction. The contact is locked FOR KEY
  -- SHARE so it cannot be deleted between this check and the INSERT. The EXCEPTION
  -- block converts the rare concurrent-delete / lock-cycle outcomes into controlled
  -- result codes instead of leaking a raw SQL error; the failed write is rolled back
  -- atomically, so no partial interaction/candidate state can survive.
  BEGIN
    PERFORM 1 FROM public.contacts
      WHERE id = v_cand.contact_id AND user_id = v_uid
      FOR KEY SHARE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('result', 'not_found');
    END IF;

    -- user_id is set explicitly (never taken from the caller) so the DEFINER context
    -- cannot be tricked into writing another user's row. source is 'google_calendar'
    -- because this interaction is created from an accepted Google Calendar candidate.
    INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes, source)
    VALUES (v_cand.contact_id, v_uid, v_type, v_date, v_notes, 'google_calendar')
    RETURNING id INTO v_iid;

    UPDATE public.interaction_candidates
      SET status = 'accepted', interaction_id = v_iid, updated_at = now()
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

-- Grants are preserved by CREATE OR REPLACE; restated here for explicitness/idempotency.
REVOKE ALL ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text)
  TO authenticated, service_role;
