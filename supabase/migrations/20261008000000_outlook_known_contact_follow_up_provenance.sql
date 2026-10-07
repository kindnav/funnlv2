-- Outlook content slice - THE KNOWN-CONTACT NOTE KEEPS ITS NEXT STEP AND ITS PROVENANCE.
--
-- NOT APPLIED. Reviewed as part of a Draft PR; apply only under explicit
-- authorization. Applying it alone changes nothing observable until the worker that
-- sends the three new arguments is deployed: every existing call passes the first ten
-- arguments, the new ones default to NULL, and the function then behaves byte-for-byte
-- as the applied 20261006000000 definition does.
--
-- ============================================================================
-- THE OMISSION, observed in Production on 2026-10-07
-- ============================================================================
-- The first live content run drafted one interaction for an EXISTING contact. The
-- model answered with a summary AND a follow-up (the owner's probe at the same head
-- showed the same shape: "useful 122-character summary and follow-up"). What reached
-- the database was the summary alone: proposed_notes carried 171 characters, and
-- draft_follow_up, summary_evidence and extraction_status were all NULL. The owner
-- accepted the suggestion four minutes later, and the saved interaction has no next
-- step and no record that its note was written by Anthropic from the message text.
--
-- The cause is one line in planContentWrite (outlookContentStage.js): the
-- interaction_with_note branch passed `p_proposed_notes: pass.summary` and nothing
-- else, because this function took nothing else. The new-contact path never had the
-- gap - upsert_new_contact_candidate has carried p_draft_follow_up and
-- p_extraction_status since 20261006000000 - so the two paths disagreed about what a
-- suggestion keeps, while the user-facing notice ("A suggestion keeps the summary, the
-- suggested next step, ...") describes both the same way.
--
-- ============================================================================
-- WHY NO TABLE CHANGES
-- ============================================================================
-- Every column needed already exists on interaction_candidates, from the applied
-- 20260921000000: draft_summary (<=200, no control chars, no URL), draft_follow_up
-- (<=160, same rules), summary_evidence (paired with draft_summary by
-- interaction_candidates_summary_evidence_check; explicit_body | subject_only) and
-- extraction_status (deterministic | ai_extracted | ai_failed). They are admitted on
-- 'outlook' rows only, SELECT is already granted to authenticated for the review queue,
-- and accept_interaction_candidate, dismiss_interaction_candidate and
-- invalidate_outlook_candidates_by_fingerprint already erase them on every terminal
-- transition - which interaction_candidates_terminal_draft_erased enforces. Only the
-- PRODUCER never wrote them. The 20261006000000 comment that "interaction_candidates
-- has no column for either" a follow-up line or a retained subject was accurate for
-- the subject and inaccurate for the follow-up; this file adds the follow-up and,
-- deliberately, still no subject: the privacy property it cites ("this row cannot be
-- used to find the mail item") is kept.
--
-- WHAT IS WRITTEN, AND ONLY WHEN THE WORKER SAYS SO. draft_summary is set to the same
-- text as proposed_notes ONLY when the worker supplies summary_evidence, because the
-- pairing constraint demands both or neither, and the evidence is what makes the copy
-- meaningful: proposed_notes is the editable note the reviewer accepts; draft_summary +
-- summary_evidence is the record of what the model produced and on what basis, erased
-- at acceptance. A metadata-only write (consent gate closed, no body read) passes none
-- of the new arguments and leaves all four columns NULL - exactly today.
--
-- A DROP AND CREATE, not CREATE OR REPLACE: parameters are being added, and
-- CREATE OR REPLACE cannot change a signature - it would create a SECOND overload,
-- after which every existing 10-argument call is ambiguous ("function ... is not
-- unique"). A dropped function also loses its ACL, so the REVOKE/GRANT pair is
-- restated below; without it the new function would be EXECUTE-able by PUBLIC.
--
-- HOW THE BODY WAS PRODUCED, AND HOW THAT IS CHECKED. The applied 20261006000000 body
-- was copied verbatim. Every addition sits between a `-- >>> 20261008` and a
-- `-- <<< 20261008` marker. tests/outlook-two-sided-rounds.test.js removes exactly
-- those marked blocks and asserts that what remains is the applied body, line for line
-- - so no guard (the lease fence over both folders, the lock order, the ownership
-- check, the dedupe across lookup fingerprints, the tombstone, the 30-day expiry, the
-- provenance row) can have been dropped or reworded on the way.
--
-- VERIFY AFTER APPLYING:
--   SELECT p.proname, p.pronargs, p.prosecdef, p.proconfig
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public' AND p.proname = 'upsert_outlook_interaction_candidate';
--   -- expect exactly ONE row; pronargs 13; prosecdef = t; proconfig = {search_path=""}
--   SELECT has_function_privilege('authenticated',
--     'public.upsert_outlook_interaction_candidate(uuid,uuid,uuid,text,text,smallint,text,date,text[],text,text,text,text)',
--     'EXECUTE');
--   -- expect false
-- ============================================================================

DROP FUNCTION IF EXISTS public.upsert_outlook_interaction_candidate(
  uuid, uuid, uuid, text, text, smallint, text, date, text[], text);

CREATE FUNCTION public.upsert_outlook_interaction_candidate(
  p_connection_id       uuid,
  p_run_id              uuid,
  p_contact_id          uuid,
  p_episode_fingerprint text,
  p_person_fingerprint  text,
  p_key_version         smallint,
  p_proposed_type       text,
  p_proposed_date       date,
  p_lookup_fingerprints text[] DEFAULT NULL,
  -- THE ONLY NEW PARAMETER. The evidence-grounded note built by
  -- supabase/functions/shared/outlookContentNote.js from counted facts and the
  -- sanitized subject. DEFAULT NULL, so the previous 9-argument call shape keeps
  -- working and behaves byte-identically.
  --
  -- WHAT IS DELIBERATELY *NOT* ADDED HERE: a follow-up line and a retained
  -- subject. interaction_candidates has no column for either, and
  -- outlook_candidate_refs deliberately stores "no message id, no conversation
  -- id, no address, no subject - so this row cannot be used to find the mail
  -- item". Widening that row would break a stated privacy property for a
  -- convenience, so the known-contact path carries the note alone. The note
  -- itself quotes the subject, which is what the reviewer needs.
  p_proposed_notes      text   DEFAULT NULL,
  -- >>> 20261008
  -- THE NEXT STEP AND THE PROVENANCE. The comment above is kept verbatim as the
  -- applied history it is; its claim that there is no column for a follow-up was
  -- wrong (20260921000000 added draft_follow_up, summary_evidence and
  -- extraction_status), and this is the correction. Still no subject.
  p_draft_follow_up     text   DEFAULT NULL,
  p_summary_evidence    text   DEFAULT NULL,
  p_extraction_status   text   DEFAULT NULL
  -- <<< 20261008
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
  v_notes   text;
  -- >>> 20261008
  v_follow  text;
  -- <<< 20261008
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
    -- Still refused here, and deliberately. A suggestion with no contact is a
    -- NEW-CONTACT proposal, and those now have their own producer
    -- (upsert_new_contact_candidate below) with its own validation, its own
    -- duplicate check and its own table. Routing one through this function
    -- instead would mean inventing a contact row to hang it on, which is the
    -- thing the whole review-before-save contract exists to prevent.
    RETURN jsonb_build_object('result', 'contact_required');
  END IF;
  IF p_key_version IS NULL OR p_key_version < 1 THEN
    RETURN jsonb_build_object('result', 'invalid_key_version');
  END IF;
  -- The note, checked against interaction_candidates_proposed_notes_check
  -- (<= 200 chars) and refused rather than silently trimmed: a note the worker
  -- believes it wrote and the database quietly shortened is worse than a
  -- controlled refusal it can report.
  v_notes := NULLIF(pg_catalog.btrim(COALESCE(p_proposed_notes, '')), '');
  IF v_notes IS NOT NULL AND (char_length(v_notes) > 200 OR v_notes ~ '[[:cntrl:]]') THEN
    RETURN jsonb_build_object('result', 'invalid_notes');
  END IF;
  -- >>> 20261008
  -- The next step, checked against interaction_candidates_draft_follow_up_bounds
  -- (<= 160 chars, no control characters, no URL) and refused rather than trimmed, for
  -- the same reason as the note. A next step with no note is a next step for nothing,
  -- and is refused too.
  v_follow := NULLIF(pg_catalog.btrim(COALESCE(p_draft_follow_up, '')), '');
  IF v_follow IS NOT NULL AND (v_notes IS NULL OR char_length(v_follow) > 160
      OR v_follow ~ '[[:cntrl:]]' OR v_follow ~* '(https?:|www\.)') THEN
    RETURN jsonb_build_object('result', 'invalid_follow_up');
  END IF;
  -- The evidence travels WITH the note, exactly as the pairing constraint
  -- interaction_candidates_summary_evidence_check demands: evidence without a note, or
  -- a value outside the pair, is refused. And because the note is about to be stored as
  -- draft_summary as well, it must then also satisfy
  -- interaction_candidates_draft_summary_bounds, which forbids a URL.
  IF p_summary_evidence IS NOT NULL AND (v_notes IS NULL
      OR p_summary_evidence NOT IN ('explicit_body', 'subject_only')
      OR v_notes ~* '(https?:|www\.)') THEN
    RETURN jsonb_build_object('result', 'invalid_evidence');
  END IF;
  IF p_extraction_status IS NOT NULL
      AND p_extraction_status NOT IN ('deterministic', 'ai_extracted', 'ai_failed') THEN
    RETURN jsonb_build_object('result', 'invalid_extraction_status');
  END IF;
  -- <<< 20261008

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
           -- COALESCE, not assignment: a later run that read no content (the
           -- consent gate closed, a body fetch failed) must not blank a note an
           -- earlier run wrote. A new note replaces an old one; no note leaves
           -- it alone.
           proposed_notes           = COALESCE(v_notes, proposed_notes),
           -- >>> 20261008
           -- The same rule for the next step and the provenance. draft_summary and
           -- summary_evidence move together or not at all, so the pairing constraint
           -- can never be caught between the two.
           draft_follow_up          = COALESCE(v_follow, draft_follow_up),
           draft_summary            = CASE WHEN p_summary_evidence IS NOT NULL THEN v_notes ELSE draft_summary END,
           summary_evidence         = CASE WHEN p_summary_evidence IS NOT NULL THEN p_summary_evidence ELSE summary_evidence END,
           extraction_status        = COALESCE(p_extraction_status, extraction_status),
           -- <<< 20261008
           context_expires_at       = now() + interval '30 days',
           updated_at               = now()
     WHERE id = v_cand;   -- source_fingerprint intentionally NOT rewritten
    RETURN jsonb_build_object('result', 'refreshed', 'candidate_id', v_cand);
  END IF;

  -- ── create the pending suggestion ─────────────────────────────────────────
  -- proposed_notes is now populated when content consent allowed a body read;
  -- every OTHER content column of this table stays omitted on purpose.
  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, proposed_notes, status, source_last_state,
     context_expires_at,
     -- >>> 20261008
     draft_summary, draft_follow_up, summary_evidence, extraction_status
     -- <<< 20261008
    )
  VALUES
    (v_uid, p_contact_id, 'outlook', p_episode_fingerprint, p_proposed_type,
     p_proposed_date, v_notes, 'pending', 'active', now() + interval '30 days',
     -- >>> 20261008
     CASE WHEN p_summary_evidence IS NOT NULL THEN v_notes END, v_follow, p_summary_evidence, p_extraction_status
     -- <<< 20261008
    )
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
  uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_outlook_interaction_candidate(
  uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text
) TO service_role;
