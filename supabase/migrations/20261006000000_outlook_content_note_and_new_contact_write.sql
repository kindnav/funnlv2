-- Outlook content slice - the two WRITE paths the worker does not have.
--
-- NOT APPLIED. Reviewed as part of a Draft PR; apply only under explicit
-- authorization. Applying it alone changes nothing observable: the
-- content-consent gate (supabase/functions/shared/outlookContentConsent.js) is
-- closed for EVERY connection until a content disclosure is approved and fresh
-- consent is collected, so the worker keeps calling the first function with no
-- note and never reaches the second.
--
-- WHY THIS EXISTS. Two gaps in the applied schema, each mapping directly to
-- something the live pilot could not do:
--
--   1. AN OUTLOOK INTERACTION CANDIDATE COULD NOT CARRY A NOTE.
--      interaction_candidates.proposed_notes has existed since the Calendar
--      slice (20260817000000) and the Suggestions UI already renders and edits
--      it, but upsert_outlook_interaction_candidate (20260930000000) takes no
--      notes argument and never sets the column - its own comment says "Every
--      content column is omitted on purpose". That is exactly why the accepted
--      pilot suggestion produced an interaction with an EMPTY note: not a UI
--      defect and not a model failure, a missing parameter.
--
--   2. NOTHING COULD WRITE A new_contact_candidates ROW AT ALL.
--      The table and its CHECK constraints, accept_new_contact_candidate,
--      dismiss_new_contact_candidate, defer_candidate and
--      invalidate_outlook_candidates_by_fingerprint are all applied
--      (20260921000000) - but there is no INSERT path anywhere. The worker's own
--      partitionPlan therefore dropped every unknown person with
--      'new_contact_not_supported'. The accept side has been ready the whole
--      time; only the producer was missing.
--
-- WHAT THIS DOES NOT CHANGE: no table, column, constraint, index, RLS policy or
-- grant on any existing object, and not one of the USER-facing accept / dismiss /
-- defer RPCs. Both functions here are SECURITY DEFINER, service_role-only, and
-- neither reads auth.uid() - they are worker writes. The review-and-accept
-- contract the browser relies on is exactly as already reviewed and applied.
--
-- HOW FUNCTION 1 WAS PRODUCED: by copying the applied body verbatim and adding
-- one parameter, one validation, one COALESCE and one INSERT column. The lease
-- fence (both folders, same live run), the lock order (sync_state FOR SHARE
-- first), the dedupe across lookup fingerprints, the 'exists_terminal'
-- tombstone, the 30-day context expiry and the provenance row are untouched.
--
-- VERIFY AFTER APPLYING:
--   SELECT p.proname, p.pronargs, p.prosecdef, p.proconfig
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public'
--      AND p.proname IN ('upsert_outlook_interaction_candidate',
--                        'upsert_new_contact_candidate');
--   -- expect exactly ONE row each; pronargs 10 and 13; prosecdef = t;
--   --        proconfig = {search_path=""}
--   SELECT has_function_privilege('authenticated',
--     'public.upsert_new_contact_candidate(uuid,uuid,text,text,smallint,text,date,text,text,text,text,text,text)',
--     'EXECUTE');
--   -- expect false


-- ============================================================================
-- 1. The interaction candidate gains the note.
-- ============================================================================
--
-- A DROP AND CREATE, not CREATE OR REPLACE: a parameter is being added, and
-- CREATE OR REPLACE cannot change a signature - it would create a SECOND
-- overload, after which every existing 9-argument call is ambiguous
-- ("function ... is not unique"). A dropped function also loses its ACL, so the
-- REVOKE/GRANT pair is restated below; without it the new function would be
-- EXECUTE-able by PUBLIC, which is how a service-role-only RPC accidentally
-- becomes callable by `authenticated`.

DROP FUNCTION IF EXISTS public.upsert_outlook_interaction_candidate(
  uuid, uuid, uuid, text, text, smallint, text, date, text[]);

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
  p_proposed_notes      text   DEFAULT NULL
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
     context_expires_at)
  VALUES
    (v_uid, p_contact_id, 'outlook', p_episode_fingerprint, p_proposed_type,
     p_proposed_date, v_notes, 'pending', 'active', now() + interval '30 days')
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
  uuid, uuid, uuid, text, text, smallint, text, date, text[], text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_outlook_interaction_candidate(
  uuid, uuid, uuid, text, text, smallint, text, date, text[], text
) TO service_role;


-- ============================================================================
-- 2. The producer for new_contact_candidates.
-- ============================================================================
--
-- THE EMAIL ADDRESS COMES FROM THE PROVIDER ENVELOPE AND NOWHERE ELSE, and this
-- is the only function that writes it. accept_new_contact_candidate deliberately
-- reads proposed_email off the STORED ROW rather than from its caller, so the
-- browser can never substitute an address - which means the address stored here
-- is the one that becomes contacts.email. It is lowercased and shape-checked
-- against ncc_email_bounds before it is stored.
--
-- A DUPLICATE IS REFUSED HERE AS WELL AS AT ACCEPT TIME. A person already in the
-- user's contacts is not a new contact, so proposing one would be a guaranteed
-- dead end for the reviewer - and the known-contact path handles that person
-- instead. accept_new_contact_candidate keeps its own advisory-locked re-check
-- for the race where a contact is added between the proposal and the acceptance;
-- this check does not replace it.
--
-- A NAME IS ONLY STORED WITH THE EVIDENCE THAT PRODUCED IT. The applied schema
-- has separate evidence and confidence columns for a reason: an unsourced value
-- in front of a reviewer looks exactly as authoritative as a sourced one. This
-- slice only ever sends 'provider_metadata' - the display name on the envelope -
-- because no body-derived extraction runs yet.
--
-- THE LEASE FENCE AND LOCK ORDER MATCH function 1 and the reserve / renew /
-- release / invalidate RPCs: sync_state FOR SHARE first, then require BOTH
-- folder rows to belong to the same live run. An episode is assembled from Inbox
-- AND Sent Items, so a run holding one folder has not seen the whole exchange.

CREATE FUNCTION public.upsert_new_contact_candidate(
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
  p_retained_subject    text   DEFAULT NULL
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

  v_sum := NULLIF(pg_catalog.btrim(COALESCE(p_draft_summary, '')), '');
  IF v_sum IS NOT NULL AND (char_length(v_sum) > 200 OR v_sum ~ '[[:cntrl:]]'
     OR v_sum ~* '(https?:|www\.)') THEN
    RETURN jsonb_build_object('result', 'invalid_summary');
  END IF;
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
           extraction_status         = 'deterministic',
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
     v_subj, 'deterministic', now() + interval '30 days')
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

-- Worker-only. The browser never PRODUCES a proposal; it only accepts, dismisses
-- or defers one, through the already-applied user-facing RPCs.
REVOKE ALL ON FUNCTION public.upsert_new_contact_candidate(
  uuid, uuid, text, text, smallint, text, date, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_new_contact_candidate(
  uuid, uuid, text, text, smallint, text, date, text, text, text, text, text, text
) TO service_role;
