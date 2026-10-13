-- 20261013060000_preserve_new_contact_context_deadline.sql
--
-- ONE DEFECT, ONE LINE: `upsert_new_contact_candidate` could never refresh an existing
-- new-contact proposal.
--
-- WHAT WAS WRONG. The refresh branch set `context_expires_at = now() + interval '30 days'`
-- while `created_at` kept the original insert instant. `new_contact_candidates` carries
--
--     CONSTRAINT ncc_context_ceiling
--       CHECK (context_expires_at IS NULL OR context_expires_at <= created_at + interval '30 days')
--
-- so the refreshed value exceeded the ceiling by exactly how long the row had existed. The
-- two writes are different transactions and `now()` is transaction-start time, so the second
-- clock is strictly later than the first and the violation is unconditional - microseconds
-- are enough. Every refresh raised 23514 / ncc_context_ceiling.
--
-- HOW IT SHOWED UP IN PRODUCT TERMS. A refresh happens when more of an exchange arrives in a
-- thread whose new-contact proposal is still `pending` or `deferred`. The producer RPC
-- rejected the write, the run reported `rpc_error` and `write_failed`, and - because a round
-- that fails to write does not commit its delta cursors - that folder re-read the same page
-- on every subsequent round until the reviewer accepted or dismissed the proposal, which
-- makes the status terminal and takes the clean `exists_terminal` path instead.
--
-- Reproduced against real PostgREST before this migration was written, and the whole
-- before/after story runs in one pass: tests/local/outlook-refresh-expiry.mjs applies every
-- migration EXCEPT this one, measures the 23514, applies this one, and then proves the
-- refresh.
--
-- WHAT THIS MIGRATION DOES. Re-issues `public.upsert_new_contact_candidate` with the body
-- copied verbatim from `20261011000000_outlook_thread_segments.sql` - the latest definition
-- and the one applied in Production - with the expiry assignment removed and a comment in
-- its place. tests/outlook-refresh-expiry-scan.test.js pins that: substituting the old
-- assignment back into this file's function text reproduces the applied text byte for byte,
-- so the 20-argument signature, the segmentation logic, the rotation and alias handling, the
-- lease fence, the episode and thread deduplication, the atomic coverage and recovery-hint
-- updates, the validation order and every returned result code are unchanged.
--
-- WHAT IT DELIBERATELY DOES NOT DO.
--   * It does not relax, drop or re-create `ncc_context_ceiling`. The constraint was right;
--     the assignment was wrong.
--   * It does not reset `created_at`, and it does not extend retention. The 30-day review
--     window runs from creation, which is what the ceiling always said and what `/privacy`
--     already publishes ("a pending suggestion carries a 30-day review window"). No
--     published wording changes; no consent version moves; no re-consent.
--   * It does not shorten a stored note or touch an accepted interaction or contact.
--   * A pending row already past its deadline keeps that past deadline. An expired context
--     cannot gain a new retention period through a refresh.
--   * It does not change `upsert_outlook_interaction_candidate`. That function also sets
--     `context_expires_at = now() + interval '30 days'` on its refresh branch, but
--     `interaction_candidates` has NO ceiling constraint, so that write succeeds and has
--     always succeeded. Whether an interaction candidate's review window should be renewable
--     is a retention question, not a defect, and changing it here would alter live behaviour
--     that nothing is currently failing on.
--
-- NO TABLE, COLUMN, CONSTRAINT, INDEX, TRIGGER OR POLICY IS TOUCHED. One function is
-- replaced. `CREATE OR REPLACE` keeps the owner, the SECURITY DEFINER marking, the empty
-- search_path and the existing grants; the REVOKE/GRANT pair below restates them anyway, as
-- 20261011000000 did, so the ACL is asserted rather than assumed.
--
-- MIGRATION ORDER. This file is `20261013060000` and the unapplied cohort-reservation
-- migration on the `feat/outlook-cohort-gate` branch is `20261013120000`, so if both are
-- ever present `supabase db push` applies THIS one first. They are independent: this one
-- replaces a producer function, that one replaces the reservation function. The rollout for
-- this change is migration-only and expects exactly ONE pending migration; do not merge the
-- cohort branch before this is applied, or a single push would carry both.
--
-- VERIFICATION AFTER APPLYING (all read-only):
--   1. exactly one `upsert_new_contact_candidate` overload, with the 20-argument signature:
--        SELECT p.oid::regprocedure::text FROM pg_proc p
--          JOIN pg_namespace n ON n.oid = p.pronamespace
--         WHERE n.nspname = 'public' AND p.proname = 'upsert_new_contact_candidate';
--   2. SECURITY DEFINER and an empty search_path:
--        SELECT prosecdef, proconfig FROM pg_proc p
--          JOIN pg_namespace n ON n.oid = p.pronamespace
--         WHERE n.nspname = 'public' AND p.proname = 'upsert_new_contact_candidate';
--      expect prosecdef = true and proconfig = {search_path=}
--   3. service_role may execute and PUBLIC, anon and authenticated may not:
--        SELECT has_function_privilege('service_role',   p.oid, 'EXECUTE'),
--               has_function_privilege('anon',           p.oid, 'EXECUTE'),
--               has_function_privilege('authenticated',  p.oid, 'EXECUTE')
--          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--         WHERE n.nspname = 'public' AND p.proname = 'upsert_new_contact_candidate';
--      expect true, false, false
--   4. the function body no longer reissues the deadline:
--        SELECT position('context_expires_at        = now()' in pg_get_functiondef(p.oid)) = 0
--          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--         WHERE n.nspname = 'public' AND p.proname = 'upsert_new_contact_candidate';
--      expect true (the INSERT branch passes the value positionally, not by this assignment)
--   5. `ncc_context_ceiling` still exists and is unchanged:
--        SELECT pg_get_constraintdef(oid) FROM pg_constraint
--         WHERE conname = 'ncc_context_ceiling';
--   6. no candidate row was altered by applying this: the migration contains no DML.
--
-- ROLLBACK. Re-apply the `upsert_new_contact_candidate` definition from
-- `20261011000000_outlook_thread_segments.sql` unchanged. That restores the defect, so the
-- only reason to do it is a fault traced to this change itself. Nothing stored needs undoing:
-- this migration writes no row.

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
  p_extraction_status   text   DEFAULT 'deterministic',
  -- >>> 20261011 segments
  -- The thread and the coverage this proposal claims. A new-contact proposal does not do
  -- the segment comparison - the person is not a contact yet, so there is nothing earlier
  -- to continue - but it MUST record both, because once the reviewer accepts the person the
  -- thread continues through upsert_outlook_interaction_candidate, and that function finds
  -- this coverage by the conversation fingerprint. The fingerprint is contact-independent
  -- for exactly that reason.
  p_conversation_fingerprint text        DEFAULT NULL,
  p_covered_fingerprints     text[]      DEFAULT NULL,
  p_coverage_from_at         timestamptz DEFAULT NULL,
  p_coverage_through_at      timestamptz DEFAULT NULL,
  -- ROTATION. The thread's other ring variants, bounded by the existing key ring. A refs row
  -- written before a rotation is stored under an older value; this is how it is still FOUND,
  -- while the value STORED is always p_conversation_fingerprint - so the thread key migrates
  -- forward on touch and cannot fall out of the bounded ring.
  --
  -- Coverage needs no equivalent parameter: the worker resolves each message to the variant it
  -- is already on record under before passing it, so the plain subset test still holds. A flat
  -- set of every variant could not answer a PER-MESSAGE question, which is why it is not one.
  p_conversation_lookup_fingerprints text[] DEFAULT NULL,
  -- COMPARISON ALIASES, never stored. Every value the covered messages may ALREADY be on
  -- record under, so a hint recorded before a key rotation can still be recognised as
  -- resolved. The stored claim stays p_covered_fingerprints: mixing the two would record an
  -- era's worth of aliases as coverage.
  p_covered_lookup_fingerprints      text[] DEFAULT NULL
  -- <<< 20261011
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
  -- >>> 20261011 segments
  v_seg_cov text[];
  v_settled text[];
  v_missing boolean;
  v_pend    uuid;
  v_newfp   int;
  v_cfps    text[];
  v_cov_lk  text[];
  -- <<< 20261011
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

  -- >>> 20261011 segments
  IF p_conversation_fingerprint IS NOT NULL
      AND p_conversation_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'invalid_conversation_fingerprint');
  END IF;
  IF p_covered_fingerprints IS NOT NULL THEN
    IF pg_catalog.array_length(p_covered_fingerprints, 1) IS NULL
        OR pg_catalog.array_length(p_covered_fingerprints, 1) > 50 THEN
      RETURN jsonb_build_object('result', 'invalid_coverage_set');
    END IF;
    PERFORM 1 FROM pg_catalog.unnest(p_covered_fingerprints) f WHERE f !~ '^[0-9a-f]{64}$';
    IF FOUND THEN
      RETURN jsonb_build_object('result', 'invalid_coverage_fingerprint');
    END IF;
    -- The SPAN travels with the set: the earliest instant is what a refresh needs to
    -- re-list its own earlier messages, and a span without both ends is a half-written claim.
    IF p_conversation_fingerprint IS NULL OR p_coverage_through_at IS NULL
        OR p_coverage_from_at IS NULL OR p_coverage_from_at > p_coverage_through_at THEN
      RETURN jsonb_build_object('result', 'invalid_coverage_set');
    END IF;
    SELECT pg_catalog.array_agg(DISTINCT f ORDER BY f)
      INTO v_seg_cov FROM pg_catalog.unnest(p_covered_fingerprints) f;
  END IF;
  -- The thread's ring variants. Malformed values are dropped rather than trusted, and the
  -- current value is always a member, so a caller that passes no variants behaves exactly as
  -- it did before rotation was handled at all.
  IF p_conversation_fingerprint IS NOT NULL THEN
    IF pg_catalog.array_length(COALESCE(p_conversation_lookup_fingerprints, ARRAY[]::text[]), 1) > 5 THEN
      RETURN jsonb_build_object('result', 'invalid_conversation_fingerprint');
    END IF;
    SELECT pg_catalog.array_agg(DISTINCT f)
      INTO v_cfps
    FROM pg_catalog.unnest(
      pg_catalog.array_append(COALESCE(p_conversation_lookup_fingerprints, ARRAY[]::text[]),
                              p_conversation_fingerprint)) f
    WHERE f ~ '^[0-9a-f]{64}$';
  END IF;
  -- The aliases a hint may be recorded under. Bounded by the ring times the coverage bound,
  -- validated, and the claim itself is always a member so a caller that passes none behaves
  -- exactly as before.
  IF v_seg_cov IS NOT NULL THEN
    IF pg_catalog.array_length(COALESCE(p_covered_lookup_fingerprints, ARRAY[]::text[]), 1) > 250 THEN
      RETURN jsonb_build_object('result', 'invalid_coverage_set');
    END IF;
    SELECT pg_catalog.array_agg(DISTINCT f)
      INTO v_cov_lk
    FROM pg_catalog.unnest(
      COALESCE(p_covered_lookup_fingerprints, ARRAY[]::text[]) || v_seg_cov) f
    WHERE f ~ '^[0-9a-f]{64}$';
  END IF;
  -- <<< 20261011
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

  -- >>> 20261011 segments
  -- ── THE THREAD, BEFORE THE EPISODE ──────────────────────────────────────
  -- The same two safeguards the interaction producer has, for the same reasons. Without
  -- them, two writes for one thread under different anchors both created a proposal:
  -- reproduced before this existed, two pending rows for one exchange.
  --
  -- ONE OPEN PROPOSAL PER THREAD, keeping the identity it was created under. 'deferred'
  -- counts as open because this function already refreshes it.
  IF p_conversation_fingerprint IS NOT NULL THEN
    SELECT nc.id INTO v_pend
    FROM public.outlook_candidate_refs r
    JOIN public.new_contact_candidates nc
      ON nc.id = r.new_contact_candidate_id AND nc.user_id = r.user_id
    WHERE r.user_id = v_uid
      AND r.conversation_fingerprint = ANY (v_cfps)
      AND nc.status IN ('pending', 'deferred')
    ORDER BY nc.created_at
    FOR UPDATE OF nc
    LIMIT 1;

    IF v_pend IS NULL THEN
      WITH seg AS (
        SELECT r.covered_message_fingerprints AS cov, nc.status AS st, nc.updated_at AS upd
        FROM public.outlook_candidate_refs r
        JOIN public.new_contact_candidates nc
          ON nc.id = r.new_contact_candidate_id AND nc.user_id = r.user_id
        WHERE r.user_id = v_uid AND r.conversation_fingerprint = ANY (v_cfps)
        UNION ALL
        SELECT r.covered_message_fingerprints, ic.status, ic.updated_at
        FROM public.outlook_candidate_refs r
        JOIN public.interaction_candidates ic
          ON ic.id = r.interaction_candidate_id AND ic.user_id = r.user_id
        WHERE r.user_id = v_uid AND r.conversation_fingerprint = ANY (v_cfps)
      )
      SELECT pg_catalog.array_agg(DISTINCT f ORDER BY f), bool_or(s.cov IS NULL)
        INTO v_settled, v_missing
      FROM seg s
      LEFT JOIN pg_catalog.unnest(COALESCE(s.cov, ARRAY[]::text[])) f ON true
      WHERE s.st NOT IN ('pending', 'deferred');

      IF COALESCE(v_missing, false) THEN
        RETURN jsonb_build_object('result', 'coverage_uninitialized');
      END IF;

      IF v_seg_cov IS NOT NULL AND v_settled IS NOT NULL THEN
        SELECT count(*) INTO v_newfp
        FROM pg_catalog.unnest(v_seg_cov) f
        WHERE NOT (f = ANY (v_settled));

        IF v_newfp = 0 THEN
          -- A DISMISSED OR ACCEPTED UNKNOWN-PERSON EXCHANGE stays settled. This is the case
          -- the episode-only lookup missed whenever the anchor moved.
          SELECT nc.id INTO v_cand
          FROM public.outlook_candidate_refs r
          JOIN public.new_contact_candidates nc
            ON nc.id = r.new_contact_candidate_id AND nc.user_id = r.user_id
          WHERE r.user_id = v_uid
            AND r.conversation_fingerprint = ANY (v_cfps)
            AND nc.status NOT IN ('pending', 'deferred')
          ORDER BY nc.updated_at DESC
          LIMIT 1;
          RETURN jsonb_build_object('result', 'exists_terminal', 'candidate_id', v_cand);
        END IF;

        IF v_newfp < pg_catalog.array_length(v_seg_cov, 1) THEN
          RETURN jsonb_build_object('result', 'coverage_moved');
        END IF;
      END IF;
    END IF;
  END IF;
  -- <<< 20261011
  -- -- deduplicate on the episode -------------------------------------------
  -- >>> 20261011 segments
  -- When the thread already located and locked its open proposal, THAT row is the answer
  -- whatever anchor this write arrived under. Re-selected by id rather than assigned, so
  -- `FOUND` below means the same thing on both branches.
  IF v_pend IS NOT NULL THEN
    SELECT id, status INTO v_cand, v_status
    FROM public.new_contact_candidates WHERE id = v_pend;
  ELSE
  -- <<< 20261011
  SELECT id, status INTO v_cand, v_status
  FROM public.new_contact_candidates
  WHERE user_id = v_uid AND source = 'outlook'
    AND episode_fingerprint = p_episode_fingerprint
  FOR UPDATE
  LIMIT 1;
  -- >>> 20261011 segments
  END IF;
  -- <<< 20261011

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
           -- >>> 20261013 THE REVIEW DEADLINE IS NOT REISSUED ON A REFRESH.
           -- This assignment used to read `context_expires_at = now() + interval '30 days'`,
           -- and it could not succeed. `created_at` keeps the instant the proposal was first
           -- written, and the table's own ceiling is
           --     ncc_context_ceiling: context_expires_at <= created_at + interval '30 days'
           -- so a refresh moved the deadline past the ceiling by however long the row had
           -- already existed. Microseconds are enough: `now()` is the transaction's start
           -- time, so the refreshing transaction's clock is strictly later than the creating
           -- one's. Every refresh therefore raised
           --     23514  new row for relation "new_contact_candidates"
           --            violates check constraint "ncc_context_ceiling"
           -- which the worker reports as `rpc_error` / `write_failed` with NO cursor
           -- advanced, so the folder re-read the same page until the reviewer accepted or
           -- dismissed that proposal and the clean `exists_terminal` path took over.
           --
           -- The column is now simply left alone, which is what the ceiling has always
           -- required: the 30-day review window runs from when the proposal was created,
           -- not from the last time more of the exchange arrived. That is also what
           -- /privacy already publishes - "a pending suggestion carries a 30-day review
           -- window" - so no published wording changes and no consent version moves.
           --
           -- NOT DONE HERE, deliberately: the ceiling is not relaxed, `created_at` is not
           -- reset, retention is not extended, no stored note is shortened and no accepted
           -- interaction or contact is touched. A pending row that is already past its
           -- deadline keeps that past deadline and gains no new window.
           -- <<< 20261013
           updated_at                = now()
     WHERE id = v_cand;
    -- >>> 20261011 segments
    -- Atomic with the draft above, and only when a summary was actually carried.
    IF v_seg_cov IS NOT NULL AND v_sum IS NOT NULL THEN
      UPDATE public.outlook_candidate_refs
         SET conversation_fingerprint     = p_conversation_fingerprint,
             covered_message_fingerprints = v_seg_cov,
             coverage_from_at             = p_coverage_from_at,
             coverage_through_at          = p_coverage_through_at,
             coverage_source              = 'draft',
             updated_at                   = now()
       WHERE user_id = v_uid AND new_contact_candidate_id = v_cand;
    ELSIF p_conversation_fingerprint IS NOT NULL THEN
      UPDATE public.outlook_candidate_refs
         SET conversation_fingerprint = p_conversation_fingerprint, updated_at = now()
       WHERE user_id = v_uid AND new_contact_candidate_id = v_cand
         AND (conversation_fingerprint IS NULL
              OR conversation_fingerprint IS DISTINCT FROM p_conversation_fingerprint);
    END IF;
    IF v_seg_cov IS NOT NULL AND v_sum IS NOT NULL THEN
      -- RESOLVE THE RECOVERY HINT, here, in this transaction, under this lease. Every pair the
      -- claim covers is dropped; what remains keeps protecting its own half. A hint that could
      -- only ever LOWER is what forced a recovery window back over settled history until the
      -- single bounded page overflowed and the thread was abandoned `recovery_truncated`.
      --
      -- DELETE BEFORE UPDATE, deliberately: the shape constraint requires at least one pair, so
      -- trimming a fully resolved row to an empty array would fail the CHECK first.
      -- A FULLY RESOLVED HINT CLEARS THE HINT, not the row: the row may also carry
      -- the thread's forward-only BASELINE, which is its knowledge floor. Deleting
      -- it was reproduced as losing that floor, after which a window containing an
      -- already-accepted message was drafted.
      UPDATE public.outlook_thread_recovery tr
         SET unpaired = NULL, earliest_unpaired_at = NULL,
             conversation_fingerprint = p_conversation_fingerprint,
             updated_at = now()
       WHERE tr.connection_id = p_connection_id
         AND tr.conversation_fingerprint = ANY (v_cfps)
         AND tr.unpaired IS NOT NULL
         AND tr.baseline_fingerprints IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.jsonb_array_elements(tr.unpaired) e
           WHERE NOT (e->>'fp' = ANY (COALESCE(v_cov_lk, v_seg_cov))));
      -- Nothing else on the row: then it goes. DELETE BEFORE UPDATE, deliberately -
      -- the shape constraint requires at least one pair, so trimming a fully
      -- resolved row to an empty array would fail the CHECK first.
      DELETE FROM public.outlook_thread_recovery tr
       WHERE tr.connection_id = p_connection_id
         AND tr.conversation_fingerprint = ANY (v_cfps)
         AND tr.unpaired IS NOT NULL
         AND tr.baseline_fingerprints IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.jsonb_array_elements(tr.unpaired) e
           WHERE NOT (e->>'fp' = ANY (COALESCE(v_cov_lk, v_seg_cov))));
      UPDATE public.outlook_thread_recovery tr
         SET unpaired = (SELECT pg_catalog.jsonb_agg(e ORDER BY (e->>'at'))
                         FROM pg_catalog.jsonb_array_elements(tr.unpaired) e
                         WHERE NOT (e->>'fp' = ANY (COALESCE(v_cov_lk, v_seg_cov)))),
             conversation_fingerprint = p_conversation_fingerprint,
             updated_at = now()
       WHERE tr.connection_id = p_connection_id
         AND tr.conversation_fingerprint = ANY (v_cfps)
         AND tr.unpaired IS NOT NULL;
      UPDATE public.outlook_thread_recovery
         SET earliest_unpaired_at = (SELECT min((e->>'at')::timestamptz)
                                     FROM pg_catalog.jsonb_array_elements(unpaired) e)
       WHERE connection_id = p_connection_id
         AND conversation_fingerprint = p_conversation_fingerprint;
    END IF;
    -- <<< 20261011
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
  -- >>> 20261011 segments
  -- Same transaction as the INSERT and as the proposal's own draft. This is what the
  -- known-contact producer finds by conversation fingerprint after the reviewer accepts
  -- the person, which is how coverage survives the new-contact transition.
  UPDATE public.outlook_candidate_refs
     SET conversation_fingerprint     = p_conversation_fingerprint,
         covered_message_fingerprints = CASE WHEN v_sum IS NOT NULL THEN v_seg_cov END,
         coverage_from_at             = CASE WHEN v_sum IS NOT NULL AND v_seg_cov IS NOT NULL
                                             THEN p_coverage_from_at END,
         coverage_through_at          = CASE WHEN v_sum IS NOT NULL AND v_seg_cov IS NOT NULL
                                             THEN p_coverage_through_at END,
         coverage_source              = CASE WHEN v_sum IS NOT NULL AND v_seg_cov IS NOT NULL
                                             THEN 'draft' END
   WHERE user_id = v_uid AND new_contact_candidate_id = v_cand
     AND p_conversation_fingerprint IS NOT NULL;
  IF v_seg_cov IS NOT NULL AND v_sum IS NOT NULL THEN
    -- RESOLVE THE RECOVERY HINT, here, in this transaction, under this lease. Every pair the
    -- claim covers is dropped; what remains keeps protecting its own half. A hint that could
    -- only ever LOWER is what forced a recovery window back over settled history until the
    -- single bounded page overflowed and the thread was abandoned `recovery_truncated`.
    --
    -- DELETE BEFORE UPDATE, deliberately: the shape constraint requires at least one pair, so
    -- trimming a fully resolved row to an empty array would fail the CHECK first.
    -- A FULLY RESOLVED HINT CLEARS THE HINT, not the row: the row may also carry
    -- the thread's forward-only BASELINE, which is its knowledge floor. Deleting
    -- it was reproduced as losing that floor, after which a window containing an
    -- already-accepted message was drafted.
    UPDATE public.outlook_thread_recovery tr
       SET unpaired = NULL, earliest_unpaired_at = NULL,
           conversation_fingerprint = p_conversation_fingerprint,
           updated_at = now()
     WHERE tr.connection_id = p_connection_id
       AND tr.conversation_fingerprint = ANY (v_cfps)
       AND tr.unpaired IS NOT NULL
       AND tr.baseline_fingerprints IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(tr.unpaired) e
         WHERE NOT (e->>'fp' = ANY (COALESCE(v_cov_lk, v_seg_cov))));
    -- Nothing else on the row: then it goes. DELETE BEFORE UPDATE, deliberately -
    -- the shape constraint requires at least one pair, so trimming a fully
    -- resolved row to an empty array would fail the CHECK first.
    DELETE FROM public.outlook_thread_recovery tr
     WHERE tr.connection_id = p_connection_id
       AND tr.conversation_fingerprint = ANY (v_cfps)
       AND tr.unpaired IS NOT NULL
       AND tr.baseline_fingerprints IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(tr.unpaired) e
         WHERE NOT (e->>'fp' = ANY (COALESCE(v_cov_lk, v_seg_cov))));
    UPDATE public.outlook_thread_recovery tr
       SET unpaired = (SELECT pg_catalog.jsonb_agg(e ORDER BY (e->>'at'))
                       FROM pg_catalog.jsonb_array_elements(tr.unpaired) e
                       WHERE NOT (e->>'fp' = ANY (COALESCE(v_cov_lk, v_seg_cov)))),
           conversation_fingerprint = p_conversation_fingerprint,
           updated_at = now()
     WHERE tr.connection_id = p_connection_id
       AND tr.conversation_fingerprint = ANY (v_cfps)
       AND tr.unpaired IS NOT NULL;
    UPDATE public.outlook_thread_recovery
       SET earliest_unpaired_at = (SELECT min((e->>'at')::timestamptz)
                                   FROM pg_catalog.jsonb_array_elements(unpaired) e)
     WHERE connection_id = p_connection_id
       AND conversation_fingerprint = p_conversation_fingerprint;
  END IF;
  -- <<< 20261011

  RETURN jsonb_build_object('result', 'created', 'candidate_id', v_cand);
END;
$$;

-- The ACL, restated rather than assumed. CREATE OR REPLACE preserves grants; saying so in
-- SQL is how the verification above has something to compare against.
REVOKE ALL ON FUNCTION public.upsert_new_contact_candidate(
  uuid, uuid, text, text, smallint, text, date, text, text, text, text, text, text, text,
  text, text[], timestamptz, timestamptz, text[], text[])
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.upsert_new_contact_candidate(
  uuid, uuid, text, text, smallint, text, date, text, text, text, text, text, text, text,
  text, text[], timestamptz, timestamptz, text[], text[]) TO service_role;

-- The acceptance RPCs, the interaction producer, the thread-recovery functions, the
-- reservation and every table are untouched by this file.
