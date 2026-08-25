-- Google integration — Phase B: candidate review RPCs (accept / dismiss).
--
-- These are the two authenticated-user write paths for the Calendar review queue.
-- interaction_candidates has NO authenticated INSERT/UPDATE/DELETE grant (Phase A), so
-- acting on a candidate requires privileged access — hence SECURITY DEFINER. Each RPC
-- derives the acting user EXCLUSIVELY from auth.uid() (never a parameter), scopes every
-- read/write to that user, and returns controlled jsonb result codes (never a raw error
-- and never revealing whether another user's row exists).
--
-- INVARIANTS (both RPCs):
--   - SECURITY DEFINER, SET search_path='', fully-qualified objects, no dynamic SQL.
--   - auth.uid() required; missing → controlled 'unauthenticated'.
--   - candidate looked up with user_id = auth.uid() and locked FOR UPDATE; a
--     missing OR foreign candidate returns the SAME controlled 'not_found'.
--   - Only status='pending' rows transition; accepted/dismissed/invalidated are never
--     resurrected. The accepted+NULL tombstone (interaction deleted later) is honored
--     and never recreated.
--   - EXECUTE revoked from PUBLIC/anon; granted only to authenticated + service_role.
--
-- NOT DEPLOYED / NOT APPLIED to production by this phase (local-only ledger entry).

-- allowed final interaction types (the six existing Funnl interaction types)
-- and the notes length cap for an accepted interaction created from a candidate.

-- ── accept_interaction_candidate ──────────────────────────────────────────────
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

  -- The candidate's contact must still belong to the caller.
  PERFORM 1 FROM public.contacts WHERE id = v_cand.contact_id AND user_id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  -- Resolve + validate the final interaction fields (overrides optional).
  v_type := COALESCE(p_override_type, v_cand.proposed_type);
  IF v_type NOT IN ('Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other') THEN
    RETURN jsonb_build_object('result', 'invalid_type');
  END IF;
  v_date := COALESCE(p_override_date, v_cand.proposed_interaction_date);
  IF v_date IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_date');
  END IF;
  v_notes := COALESCE(p_override_notes, v_cand.proposed_notes);
  IF v_notes IS NOT NULL AND char_length(v_notes) > 2000 THEN
    RETURN jsonb_build_object('result', 'invalid_notes');
  END IF;

  -- Create the interaction and mark the candidate accepted in ONE transaction.
  -- user_id is set explicitly (never taken from the caller) so the DEFINER context
  -- cannot be tricked into writing another user's row.
  INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes)
  VALUES (v_cand.contact_id, v_uid, v_type, v_date, v_notes)
  RETURNING id INTO v_iid;

  UPDATE public.interaction_candidates
    SET status = 'accepted', interaction_id = v_iid, updated_at = now()
  WHERE id = p_candidate_id;

  RETURN jsonb_build_object('result', 'accepted', 'interaction_id', v_iid);
END;
$$;

REVOKE ALL ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text)
  TO authenticated, service_role;


-- ── dismiss_interaction_candidate ─────────────────────────────────────────────
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
      SET status = 'dismissed', updated_at = now()
    WHERE id = p_candidate_id;
    RETURN jsonb_build_object('result', 'dismissed');
  ELSIF v_status = 'dismissed' THEN
    RETURN jsonb_build_object('result', 'already_dismissed');
  ELSIF v_status = 'accepted' THEN
    RETURN jsonb_build_object('result', 'already_accepted');
  ELSE  -- invalidated
    RETURN jsonb_build_object('result', 'invalidated');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.dismiss_interaction_candidate(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dismiss_interaction_candidate(uuid)
  TO authenticated, service_role;
