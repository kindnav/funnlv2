-- THOROUGH USER-WRITTEN INTERACTION NOTES.
--
-- A reviewer capturing what a networking conversation was actually about needs more than 200
-- characters: paragraphs, a tabbed list of next steps, line breaks. Both acceptance RPCs are
-- re-issued with their applied bodies UNCHANGED except the note validation, marked
-- `-- >>> long reviewed notes ... -- <<<`:
--
--   accept_interaction_candidate   note bound 200 -> 10,000 (no other change)
--   accept_new_contact_candidate   note bound 200 -> 10,000; tab / LF / CR are no longer treated
--                                  as control characters for the NOTE only - every other control
--                                  character is still refused, and name/company/role/how-met/
--                                  relationship-note keep their unchanged [[:cntrl:]] checks.
--
-- The reviewed note is saved directly into public.interactions.notes (text, unbounded). The
-- provider-draft columns (interaction_candidates.proposed_notes, new_contact_candidates
-- .draft_summary) are NOT widened: AI-produced drafts remain 200 characters, which is a
-- separate workstream. Signatures and grants are restated exactly as applied; ownership,
-- expiry, idempotent acceptance and the follow-up handling are untouched.
--
-- Verification: tests/long-notes-migration.test.js (body equality with the marked blocks
-- stripped) and tests/sql/outlook-long-notes-runtime.sql on a disposable database.

CREATE OR REPLACE FUNCTION public.accept_interaction_candidate(
  p_candidate_id   uuid,
  p_override_type  text DEFAULT NULL,
  p_override_date  date DEFAULT NULL,
  p_override_notes text DEFAULT NULL,
  -- >>> 20261008
  -- THE REVIEWER'S APPROVED NEXT STEP, and the follow-up date THEY chose. Both optional;
  -- both default NULL, so the existing four-argument call from the browser and from the
  -- Calendar queue behaves exactly as the applied definition does.
  p_follow_up      text DEFAULT NULL,
  p_follow_up_date date DEFAULT NULL
  -- <<< 20261008
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
  -- >>> 20261008
  v_follow text;
  v_final  text;
  -- <<< 20261008
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

  -- ── OUTLOOK ONLY: the 30-day context window is enforced here ──────────────
  -- REPRODUCED before this existed: an Outlook candidate 40 days past its deadline
  -- answered 'accepted' and created an interaction. An approval packet had claimed
  -- both acceptance RPCs refused an expired suggestion; only
  -- accept_new_contact_candidate did, and the claim came from a grep whose two
  -- matches were both inside defer_candidate.
  --
  -- WHY `source = 'outlook'` AND NOT A BLANKET RULE. Calendar and Gmail candidates
  -- carry NULL in this column by design - nothing ever sets it for them - so a rule
  -- that read NULL as expired, or that applied to every source, would refuse every
  -- Calendar suggestion ever made. The window is an Outlook concept: it exists
  -- because an Outlook candidate can carry provider-derived draft context, and that
  -- context is what the window bounds.
  --
  -- WHY NULL FAILS CLOSED for Outlook. Every writer of an Outlook candidate sets the
  -- deadline on both the insert and the refresh path, so a pending Outlook row
  -- without one is anomalous rather than ordinary, and accepting on a missing value
  -- is the wrong way to resolve an anomaly.
  --
  -- WHY IT SITS HERE, after every terminal-status check. Acceptance erases this
  -- column to NULL. A guard placed before those checks would therefore answer
  -- 'expired' for a row that had already been accepted, replacing a correct
  -- 'already_accepted' with a misleading one and breaking idempotency.
  IF v_cand.source = 'outlook'
     AND (v_cand.context_expires_at IS NULL OR v_cand.context_expires_at <= now()) THEN
    RETURN jsonb_build_object('result', 'expired');
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
  -- >>> long reviewed notes (20261010120000): the reviewer's note may run to 10,000 characters
  -- with paragraphs, line breaks and tabs. It is saved into interactions.notes (text) and never
  -- into the 200-character provider-draft column, which keeps its bound.
  IF v_notes IS NOT NULL AND char_length(v_notes) > 10000 THEN
    RETURN jsonb_build_object('result', 'invalid_notes');
  END IF;
  -- <<< long reviewed notes
  -- >>> 20261008
  -- THE APPROVED NEXT STEP. What the reviewer kept, edited or cleared - deliberately NOT
  -- the draft column read back, so a suggestion only ever reaches a saved record through
  -- the reviewer's hands. Bounded as interaction_candidates_draft_follow_up_bounds bounds
  -- the draft (<= 160, no control characters) and refused rather than trimmed. It is saved
  -- INTO the interaction note, after the note, because that is the one place Funnl's
  -- interaction model already keeps free text and shows it everywhere an interaction is
  -- shown; a second text column would be a note nothing else in the product reads.
  v_follow := NULLIF(pg_catalog.btrim(COALESCE(p_follow_up, '')), '');
  IF v_follow IS NOT NULL AND (char_length(v_follow) > 160 OR v_follow ~ '[[:cntrl:]]') THEN
    RETURN jsonb_build_object('result', 'invalid_follow_up');
  END IF;
  v_final := CASE
    WHEN v_follow IS NULL THEN v_notes
    WHEN v_notes IS NULL THEN 'Next step: ' || v_follow
    ELSE v_notes || pg_catalog.chr(10) || pg_catalog.chr(10) || 'Next step: ' || v_follow
  END;
  -- THE FOLLOW-UP DATE is the reviewer's own choice, passed in or NULL. Nothing here
  -- derives a date from the wording of the step.
  -- <<< 20261008

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
    INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes, source, follow_up_date)
    VALUES (v_cand.contact_id, v_uid, v_type, v_date, v_final, v_src, p_follow_up_date)
    RETURNING id INTO v_iid;

    -- E2A CHANGE #2: erase retained email context on resolution (calendar candidates
    -- have NULL retained context → no-op; behavior for them is unchanged).
    -- OUTLOOK ADDITION: the draft columns are erased too (NULL on Calendar/Gmail rows).
    UPDATE public.interaction_candidates
      SET status = 'accepted', interaction_id = v_iid,
          draft_summary = NULL, draft_follow_up = NULL, summary_evidence = NULL, deferred_until = NULL,
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

-- Grants, stated exactly as 20261008000000 stated them for the applied signature.
REVOKE ALL ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text, text, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text, text, date)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_new_contact_candidate(
  p_candidate_id       uuid,
  p_name               text,
  p_company            text     DEFAULT NULL,
  p_role               text     DEFAULT NULL,
  p_how_met            text     DEFAULT NULL,
  p_linkedin_url       text     DEFAULT NULL,
  p_tags               text[]   DEFAULT NULL,
  p_relationship_type  text     DEFAULT NULL,
  p_relationship_note  text     DEFAULT NULL,
  p_create_interaction boolean  DEFAULT true,
  p_interaction_type   text     DEFAULT NULL,
  p_interaction_date   date     DEFAULT NULL,
  p_interaction_notes  text     DEFAULT NULL,
  p_follow_up_date     date     DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid    uuid := (SELECT auth.uid());
  v_cand   public.new_contact_candidates%ROWTYPE;
  v_email  text;
  v_name   text;
  v_type   text;
  v_date   date;
  v_notes  text;
  v_dup    uuid;
  v_cid    uuid;
  v_iid    uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('result', 'unauthenticated'); END IF;

  SELECT * INTO v_cand
  FROM public.new_contact_candidates
  WHERE id = p_candidate_id AND user_id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;

  IF v_cand.status = 'accepted' THEN
    RETURN jsonb_build_object('result', 'already_accepted', 'contact_id', v_cand.accepted_contact_id,
                              'interaction_id', v_cand.accepted_interaction_id);
  ELSIF v_cand.status = 'dismissed' THEN
    RETURN jsonb_build_object('result', 'dismissed');
  ELSIF v_cand.status = 'invalidated' THEN
    RETURN jsonb_build_object('result', 'invalidated');
  END IF;
  -- status is 'pending' or 'deferred' here (a deferred draft may be acted on early).
  IF v_cand.context_expires_at IS NULL OR v_cand.context_expires_at <= now() THEN
    RETURN jsonb_build_object('result', 'expired');
  END IF;

  -- Validate the user-approved values (bounds match the contact form / candidate CHECKs).
  v_name := NULLIF(pg_catalog.btrim(p_name), '');
  IF v_name IS NULL OR char_length(v_name) > 120 OR v_name ~ '[[:cntrl:]]' THEN
    RETURN jsonb_build_object('result', 'invalid_name');
  END IF;
  IF p_company IS NOT NULL AND (char_length(p_company) > 120 OR p_company ~ '[[:cntrl:]]') THEN
    RETURN jsonb_build_object('result', 'invalid_company');
  END IF;
  IF p_role IS NOT NULL AND (char_length(p_role) > 120 OR p_role ~ '[[:cntrl:]]') THEN
    RETURN jsonb_build_object('result', 'invalid_role');
  END IF;
  IF p_how_met IS NOT NULL AND (char_length(p_how_met) > 120 OR p_how_met ~ '[[:cntrl:]]') THEN
    RETURN jsonb_build_object('result', 'invalid_how_met');
  END IF;
  IF p_linkedin_url IS NOT NULL AND (char_length(p_linkedin_url) > 255
     OR p_linkedin_url !~ '^https://(www\.)?linkedin\.com/in/[A-Za-z0-9_%.-]+/?$') THEN
    RETURN jsonb_build_object('result', 'invalid_linkedin_url');
  END IF;
  IF p_tags IS NOT NULL AND (pg_catalog.array_length(p_tags, 1) > 20
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_tags) t WHERE t IS NULL OR char_length(t) = 0 OR char_length(t) > 60 OR t ~ '[[:cntrl:]]')) THEN
    RETURN jsonb_build_object('result', 'invalid_tags');
  END IF;
  IF p_relationship_type IS NOT NULL AND p_relationship_type NOT IN
     ('Mentor', 'Collaborator', 'Referral path', 'Potential employer', 'Connector', 'Other') THEN
    RETURN jsonb_build_object('result', 'invalid_relationship_type');
  END IF;
  IF p_relationship_note IS NOT NULL AND (char_length(p_relationship_note) > 500 OR p_relationship_note ~ '[[:cntrl:]]') THEN
    RETURN jsonb_build_object('result', 'invalid_relationship_note');
  END IF;

  IF COALESCE(p_create_interaction, true) THEN
    v_type := COALESCE(p_interaction_type, v_cand.proposed_type);
    IF v_type NOT IN ('Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other') THEN
      RETURN jsonb_build_object('result', 'invalid_type');
    END IF;
    v_date := COALESCE(p_interaction_date, v_cand.proposed_interaction_date);
    IF v_date IS NULL THEN RETURN jsonb_build_object('result', 'invalid_date'); END IF;
    v_notes := COALESCE(p_interaction_notes, v_cand.draft_summary);
    -- >>> long reviewed notes (20261010120000): up to 10,000 characters; tabs, line feeds and
    -- carriage returns are the reviewer's paragraphs and lists, so they are removed before the
    -- control-character test. Every other control character is still refused, and every other
    -- field keeps its unchanged check above.
    IF v_notes IS NOT NULL AND (char_length(v_notes) > 10000
        OR pg_catalog.translate(v_notes, pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13), '') ~ '[[:cntrl:]]') THEN
      RETURN jsonb_build_object('result', 'invalid_notes');
    END IF;
    -- <<< long reviewed notes
  END IF;

  -- Email is the provider-sourced address on the candidate (never caller-supplied).
  v_email := pg_catalog.lower(pg_catalog.btrim(v_cand.proposed_email));
  IF v_email IS NULL OR v_email = '' THEN RETURN jsonb_build_object('result', 'invalid_email'); END IF;

  -- Serialize concurrent accepts for the same (user, email), then re-check duplicates.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_uid::text || ':' || v_email, 0));
  SELECT c.id INTO v_dup
  FROM public.contacts c
  WHERE c.user_id = v_uid AND pg_catalog.lower(pg_catalog.btrim(c.email)) = v_email
  LIMIT 1;
  IF v_dup IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'duplicate_email', 'contact_id', v_dup);
  END IF;

  BEGIN
    -- user_id is set explicitly (never taken from the caller).
    INSERT INTO public.contacts
      (user_id, name, company, role, how_met, email, linkedin_url, tags, relationship_type, relationship_note)
    VALUES
      (v_uid, v_name, p_company, p_role, p_how_met, v_email, p_linkedin_url, p_tags, p_relationship_type, p_relationship_note)
    RETURNING id INTO v_cid;

    IF COALESCE(p_create_interaction, true) THEN
      INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes, follow_up_date, source)
      VALUES (v_cid, v_uid, v_type, v_date, v_notes, p_follow_up_date, 'outlook')
      RETURNING id INTO v_iid;
    END IF;

    UPDATE public.new_contact_candidates
      SET status = 'accepted',
          accepted_contact_id = v_cid,
          accepted_interaction_id = v_iid,
          proposed_email = NULL, proposed_name = NULL, proposed_name_evidence = NULL, proposed_name_confidence = NULL,
          proposed_company = NULL, proposed_company_evidence = NULL, proposed_company_confidence = NULL,
          proposed_role = NULL, proposed_role_evidence = NULL, proposed_role_confidence = NULL,
          proposed_how_met = NULL, proposed_how_met_evidence = NULL, proposed_how_met_confidence = NULL,
          proposed_linkedin_url = NULL, proposed_linkedin_url_evidence = NULL, proposed_linkedin_url_confidence = NULL,
          draft_summary = NULL, draft_follow_up = NULL, retained_subject = NULL,
          context_expires_at = NULL, deferred_until = NULL,
          updated_at = now()
      WHERE id = p_candidate_id AND user_id = v_uid;
  EXCEPTION
    WHEN deadlock_detected OR serialization_failure THEN
      RETURN jsonb_build_object('result', 'conflict');
    WHEN OTHERS THEN
      -- Any failure inside the block (e.g. the interaction insert) rolls back the
      -- contact insert too; the browser sees a controlled code, never a DB message.
      RETURN jsonb_build_object('result', 'write_failed');
  END;

  RETURN jsonb_build_object('result', 'accepted', 'contact_id', v_cid, 'interaction_id', v_iid);
END;
$$;

-- Grants, stated exactly as 20260921000000 and 20260922175616 stated them.
REVOKE ALL ON FUNCTION public.accept_new_contact_candidate(
  uuid, text, text, text, text, text, text[], text, text, boolean, text, date, text, date
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_new_contact_candidate(
  uuid, text, text, text, text, text, text[], text, text, boolean, text, date, text, date
) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.accept_new_contact_candidate(
  uuid, text, text, text, text, text, text[], text, text, boolean, text, date, text, date
) FROM service_role;
