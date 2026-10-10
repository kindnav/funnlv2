-- DETAILED AI INTERACTION NOTES.
--
-- The generated note was capped at 200 characters, which holds a LABEL for an exchange and
-- not its substance: a user who wanted to remember the advice, the offer, the commitment or
-- the date had to retype it, which is the opposite of what automatic capture is for. The
-- ceiling moves to 2,000 characters - enough for the topics, advice, offers, commitments,
-- named dates, next steps and open questions of a bounded six-message exchange, and well
-- inside the 10,000 characters the REVIEWER may write (20261010120000), so every generated
-- draft fits the editor and both acceptance paths without further change.
--
-- WHAT MOVES: three column CHECKs and the note/summary bound inside the two PRODUCER RPCs,
-- marked `-- >>> detailed notes ... -- <<<`. Both producer bodies are otherwise byte-identical
-- to the applied ones, and their signatures and grants are restated exactly.
--
-- WHAT DOES NOT MOVE:
--   * the control-character rule on the generated note - it is one prose paragraph; the
--     reviewer's own note already carries line breaks and tabs;
--   * the URL rule, the follow-up bound (160), the subject bound (160) and every other field;
--   * the ACCEPTANCE RPCs - they already allow 10,000 and need no change here;
--   * consent gates, minimization, fingerprints, deduplication, cleanup and the terminal
--     erasure constraints, none of which this migration touches.
--
-- Rollout order and the disclosure cutover this requires are in
-- docs/outlook-detailed-ai-notes.md. The published policy currently says the stored summary
-- is "at most 200 characters"; applying this migration WITHOUT that disclosure change would
-- make the published text wrong, so the two are sequenced there and the policy wording is
-- prepared for owner approval rather than published here.

-- ── 1. the three draft-column CHECKs ────────────────────────────────────────────────────────
ALTER TABLE public.interaction_candidates
  DROP CONSTRAINT IF EXISTS interaction_candidates_notes_len;
ALTER TABLE public.interaction_candidates
  ADD CONSTRAINT interaction_candidates_notes_len
  CHECK (proposed_notes IS NULL OR char_length(proposed_notes) <= 2000);

ALTER TABLE public.interaction_candidates
  DROP CONSTRAINT IF EXISTS interaction_candidates_draft_summary_bounds;
ALTER TABLE public.interaction_candidates
  ADD CONSTRAINT interaction_candidates_draft_summary_bounds
  CHECK (draft_summary IS NULL
         OR (char_length(draft_summary) BETWEEN 1 AND 2000
             AND draft_summary !~ '[[:cntrl:]]' AND draft_summary !~* '(https?:|www\.)'));

ALTER TABLE public.new_contact_candidates
  DROP CONSTRAINT IF EXISTS ncc_summary_bounds;
ALTER TABLE public.new_contact_candidates
  ADD CONSTRAINT ncc_summary_bounds
  CHECK (draft_summary IS NULL
         OR (char_length(draft_summary) BETWEEN 1 AND 2000
             AND draft_summary !~ '[[:cntrl:]]' AND draft_summary !~* '(https?:|www\.)'));

-- ── 2. the two producer RPCs, bodies otherwise unchanged ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_outlook_interaction_candidate(
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
  -- >>> detailed notes (20261010180000)
  -- The note, checked against interaction_candidates_notes_len and
  -- interaction_candidates_draft_summary_bounds (both <= 2000 chars as of this migration)
  -- and refused rather than silently trimmed: a note the worker believes it wrote and the
  -- database quietly shortened is worse than a controlled refusal it can report. The
  -- control-character rule is unchanged - a generated note is one prose paragraph; the
  -- REVIEWER's own note may carry line breaks and runs to 10,000 (20261010120000).
  v_notes := NULLIF(pg_catalog.btrim(COALESCE(p_proposed_notes, '')), '');
  IF v_notes IS NOT NULL AND (char_length(v_notes) > 2000 OR v_notes ~ '[[:cntrl:]]') THEN
    RETURN jsonb_build_object('result', 'invalid_notes');
  END IF;
  -- <<< detailed notes
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
           -- A NEW DRAFT REPLACES THE OLD ONE WHOLE; a run that drafted nothing leaves it
           -- alone. All three draft columns turn on ONE test - did this call carry a note -
           -- so a successful draft with no next step CLEARS the obsolete step from the
           -- previous draft (a COALESCE here kept it, pairing an old step with a new
           -- summary), while a metadata-only refresh (v_notes NULL: the consent gate was
           -- closed or a body fetch failed) preserves summary, evidence and step together.
           -- draft_summary and summary_evidence still move as a pair, so the pairing
           -- constraint can never be caught between the two.
           draft_follow_up          = CASE WHEN v_notes IS NOT NULL THEN v_follow ELSE draft_follow_up END,
           draft_summary            = CASE WHEN v_notes IS NOT NULL
                                        THEN (CASE WHEN p_summary_evidence IS NOT NULL THEN v_notes END)
                                        ELSE draft_summary END,
           summary_evidence         = CASE WHEN v_notes IS NOT NULL THEN p_summary_evidence ELSE summary_evidence END,
           extraction_status        = CASE WHEN v_notes IS NOT NULL THEN p_extraction_status ELSE extraction_status END,
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

-- Worker-only, exactly as 20261008000000 stated it.
REVOKE ALL ON FUNCTION public.upsert_outlook_interaction_candidate(
  uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_outlook_interaction_candidate(
  uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_new_contact_candidate(
  p_connection_id       uuid,
  p_run_id              uuid,
  p_episode_fingerprint text,
  p_person_fingerprint  text,
  p_key_version         smallint,
  p_proposed_email      text,
  p_proposed_date       date,
  p_proposed_name       text   DEFAULT NULL,
  p_name_evidence       text   DEFAULT NULL,
  p_name_confidence     text   DEFAULT NULL,
  p_draft_summary       text   DEFAULT NULL,
  p_draft_follow_up     text   DEFAULT NULL,
  p_retained_subject    text   DEFAULT NULL,
  -- WHERE THE DRAFT CAME FROM, recorded honestly. This was hard-coded
  -- 'deterministic', which was true while nothing could produce a summary and became
  -- a false provenance claim the moment the content stage could: a row carrying an
  -- Anthropic-written summary said it had been derived deterministically. The local
  -- harness caught it. Defaults to 'deterministic' so a caller that drafts nothing
  -- still records the truth, and is CHECK-constrained to the column's three values.
  p_extraction_status   text   DEFAULT 'deterministic'
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
  v_email   text;
  v_name    text;
  v_sum     text;
  v_follow  text;
  v_subj    text;
  v_dup     uuid;
BEGIN
  -- -- shape validation, before any lock is taken -----------------------------
  IF p_episode_fingerprint IS NULL OR p_episode_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'invalid_fingerprint');
  END IF;
  -- NOT NULL on this table, unlike the interaction path where it is optional.
  IF p_person_fingerprint IS NULL OR p_person_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'invalid_person_fingerprint');
  END IF;
  IF p_key_version IS NULL OR p_key_version < 1 THEN
    RETURN jsonb_build_object('result', 'invalid_key_version');
  END IF;
  IF p_proposed_date IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_date');
  END IF;

  IF p_extraction_status IS NULL
     OR p_extraction_status NOT IN ('deterministic', 'ai_extracted', 'ai_failed') THEN
    RETURN jsonb_build_object('result', 'invalid_extraction_status');
  END IF;

  v_email := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_proposed_email, '')));
  IF v_email = '' OR char_length(v_email) < 3 OR char_length(v_email) > 320
     OR v_email ~ '[[:cntrl:][:space:]]' OR v_email !~ '^[^@]+@[^@]+\.[^@]+$' THEN
    RETURN jsonb_build_object('result', 'invalid_email');
  END IF;

  v_name := NULLIF(pg_catalog.btrim(COALESCE(p_proposed_name, '')), '');
  IF v_name IS NOT NULL AND (char_length(v_name) > 120 OR v_name ~ '[[:cntrl:]]'
     OR v_name ~* '(https?:|www\.)') THEN
    RETURN jsonb_build_object('result', 'invalid_name');
  END IF;
  IF v_name IS NOT NULL THEN
    IF p_name_evidence IS NULL OR p_name_evidence NOT IN
       ('provider_metadata', 'explicit_signature', 'explicit_body') THEN
      RETURN jsonb_build_object('result', 'invalid_name_evidence');
    END IF;
    IF p_name_confidence IS NULL OR p_name_confidence NOT IN ('high', 'medium') THEN
      RETURN jsonb_build_object('result', 'invalid_name_confidence');
    END IF;
  END IF;

  -- >>> detailed notes (20261010180000): ncc_summary_bounds is <= 2000 as of this
  -- migration. The control-character and URL rules are unchanged.
  v_sum := NULLIF(pg_catalog.btrim(COALESCE(p_draft_summary, '')), '');
  IF v_sum IS NOT NULL AND (char_length(v_sum) > 2000 OR v_sum ~ '[[:cntrl:]]'
     OR v_sum ~* '(https?:|www\.)') THEN
    RETURN jsonb_build_object('result', 'invalid_summary');
  END IF;
  -- <<< detailed notes
  v_follow := NULLIF(pg_catalog.btrim(COALESCE(p_draft_follow_up, '')), '');
  IF v_follow IS NOT NULL AND (char_length(v_follow) > 160 OR v_follow ~ '[[:cntrl:]]'
     OR v_follow ~* '(https?:|www\.)') THEN
    RETURN jsonb_build_object('result', 'invalid_follow_up');
  END IF;
  v_subj := NULLIF(pg_catalog.btrim(COALESCE(p_retained_subject, '')), '');
  IF v_subj IS NOT NULL AND (char_length(v_subj) > 160 OR v_subj ~ '[[:cntrl:]]') THEN
    RETURN jsonb_build_object('result', 'invalid_subject');
  END IF;

  -- -- lease fence: the run must own BOTH folders ----------------------------
  PERFORM 1 FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id FOR SHARE;

  SELECT c.user_id INTO v_uid
  FROM public.microsoft_connections c WHERE c.id = p_connection_id;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('result', 'unknown_connection');
  END IF;

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

  -- -- already a contact? then this is not a new contact ---------------------
  SELECT ct.id INTO v_dup FROM public.contacts ct
   WHERE ct.user_id = v_uid
     AND pg_catalog.lower(pg_catalog.btrim(ct.email)) = v_email
   LIMIT 1;
  IF v_dup IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'already_a_contact');
  END IF;

  -- -- deduplicate on the episode -------------------------------------------
  SELECT id, status INTO v_cand, v_status
  FROM public.new_contact_candidates
  WHERE user_id = v_uid AND source = 'outlook'
    AND episode_fingerprint = p_episode_fingerprint
  FOR UPDATE
  LIMIT 1;

  IF FOUND THEN
    -- A dismissed, accepted or invalidated proposal is never made again. 'deferred'
    -- IS refreshable: deferring means "not yet", and more of the exchange may have
    -- arrived since.
    IF v_status NOT IN ('pending', 'deferred') THEN
      RETURN jsonb_build_object('result', 'exists_terminal', 'candidate_id', v_cand);
    END IF;
    UPDATE public.new_contact_candidates
       SET proposed_email            = v_email,
           -- COALESCE on every drafted field: a later run that read no content
           -- must not blank what an earlier one wrote.
           proposed_name             = COALESCE(v_name, proposed_name),
           proposed_name_evidence    = COALESCE(p_name_evidence, proposed_name_evidence),
           proposed_name_confidence  = COALESCE(p_name_confidence, proposed_name_confidence),
           draft_summary             = COALESCE(v_sum, draft_summary),
           draft_follow_up           = COALESCE(v_follow, draft_follow_up),
           retained_subject          = COALESCE(v_subj, retained_subject),
           proposed_interaction_date = p_proposed_date,
           person_fingerprint        = p_person_fingerprint,
           key_version               = p_key_version,
           extraction_status         = p_extraction_status,
           context_expires_at        = now() + interval '30 days',
           updated_at                = now()
     WHERE id = v_cand;
    RETURN jsonb_build_object('result', 'refreshed', 'candidate_id', v_cand);
  END IF;

  INSERT INTO public.new_contact_candidates
    (user_id, source, status, person_fingerprint, episode_fingerprint, key_version,
     proposed_email, proposed_name, proposed_name_evidence, proposed_name_confidence,
     draft_summary, draft_follow_up, proposed_interaction_date, proposed_type,
     retained_subject, extraction_status, context_expires_at)
  VALUES
    (v_uid, 'outlook', 'pending', p_person_fingerprint, p_episode_fingerprint,
     p_key_version, v_email, v_name, p_name_evidence, p_name_confidence,
     v_sum, v_follow, p_proposed_date, 'Email',
     v_subj, p_extraction_status, now() + interval '30 days')
  RETURNING id INTO v_cand;

  -- Provenance, the same row shape the interaction path writes: fingerprints and a
  -- key version only, and the exactly-one-target CHECK satisfied from the other
  -- side. This is what disconnect and invalidate_outlook_candidates_by_fingerprint
  -- reach the proposal through, so omitting it would orphan the row.
  INSERT INTO public.outlook_candidate_refs
    (user_id, connection_id, interaction_candidate_id, new_contact_candidate_id,
     episode_fingerprint, person_fingerprint, key_version)
  VALUES
    (v_uid, p_connection_id, NULL, v_cand,
     p_episode_fingerprint, p_person_fingerprint, p_key_version);

  RETURN jsonb_build_object('result', 'created', 'candidate_id', v_cand);
END;
$$;

-- Worker-only, exactly as 20261006000000 stated it.
REVOKE ALL ON FUNCTION public.upsert_new_contact_candidate(
  uuid, uuid, text, text, smallint, text, date, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_new_contact_candidate(
  uuid, uuid, text, text, smallint, text, date, text, text, text, text, text, text, text
) TO service_role;
