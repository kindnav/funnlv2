-- ════════════════════════════════════════════════════════════════════════════════
-- LATER INTERACTIONS INSIDE A SETTLED OUTLOOK THREAD
-- ════════════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG. Episode identity is an HMAC anchored on a thread's FIRST message, and
-- outlook_conversation_recovery deliberately completes the thread from Outlook before
-- writing so that anchor is the same in every round. The consequence was never intended:
-- after the reviewer accepted or dismissed, the producer found that one fingerprint, saw a
-- non-pending row and answered `exists_terminal`. Because `exists_terminal` is in WRITE_OK
-- the round still succeeded and the cursor still advanced, so EVERY later exchange in that
-- thread was discarded in silence. The previous proof file asserted it as intended
-- ("Round 3: the thread continues ... writes nothing").
--
-- WHAT IS TRUE INSTEAD. Acceptance and dismissal settle AN EXCHANGE, not every future
-- exchange in the thread. A thread is a sequence of SEGMENTS; each two-way exchange gets its
-- own suggestion, its own editable draft and its own interaction on acceptance. Interactions
-- already accepted and the notes the reviewer wrote are never touched again.
--
-- WHY COVERAGE IS A SET OF MESSAGE FINGERPRINTS AND NOT A TIMESTAMP. A high-water timestamp
-- cannot answer "have we already summarized THIS message", and gets two cases wrong:
--   * EQUAL TIMESTAMPS - two messages can carry the same instant, so a new message at the
--     boundary is indistinguishable from the one already summarized. A sorting tie-break
--     makes the ORDER deterministic; it does not record WHICH was summarized.
--   * DELAYED DISCOVERY - a message can be discovered after a later one (moved into the
--     folder, delivered out of order, surfaced by a delta page in a later round). Its
--     timestamp is behind the watermark while the message has never been seen, so a
--     timestamp comparison classifies unseen mail as covered and loses it silently.
-- Coverage is therefore membership in a set of the keyed message fingerprints the round
-- already computes. `coverage_through_at` exists ONLY as the floor for a bounded recovery
-- listing and is never consulted to decide coverage.
--
-- WHAT THIS MIGRATION ADDS
--   1. four columns on outlook_candidate_refs - the durable, worker-only provenance record
--      that is already 1:1 with a candidate and is never deleted;
--   2. get_outlook_thread_coverage()      - read coverage for the threads a round will write
--   3. baseline_outlook_thread_coverage() - forward-only initialization for threads settled
--                                           before segments existed
--   4. both producers re-issued: thread-first lookup, coverage comparison, and coverage
--      written ATOMICALLY with the draft it describes.
--
-- Bodies are otherwise BYTE-IDENTICAL to the applied versions; every change sits inside a
-- `-- >>> 20261011 segments` / `-- <<< 20261011` block, and
-- tests/outlook-thread-segments-migration.test.js proves that.
--
-- VERIFY AFTER APPLYING
--   * four columns present on outlook_candidate_refs, with their CHECKs
--   * one overload each of the two producers and the two new functions
--   * every function SECURITY DEFINER with search_path = '', owner postgres
--   * producers and both new functions EXECUTE-able by service_role only (never
--     authenticated, never anon, never PUBLIC)
--   * the acceptance RPCs untouched: still 10,000 characters, still authenticated-only
--   * tests/sql/outlook-thread-segments-runtime.sql passes against a disposable database

-- ── 1. the durable coverage record ──────────────────────────────────────────────
-- On outlook_candidate_refs, NOT on interaction_candidates: refs is Outlook's own
-- provenance row, exactly one per candidate, worker-only, and never deleted except with
-- the candidate, the connection or the user. interaction_candidates is shared with Gmail
-- and is not the right place for an Outlook thread concept.
ALTER TABLE public.outlook_candidate_refs
  ADD COLUMN IF NOT EXISTS conversation_fingerprint     text,
  ADD COLUMN IF NOT EXISTS covered_message_fingerprints text[],
  ADD COLUMN IF NOT EXISTS coverage_from_at             timestamptz,
  ADD COLUMN IF NOT EXISTS coverage_through_at          timestamptz,
  ADD COLUMN IF NOT EXISTS coverage_source              text;

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ocr_conversation_fp_shape') THEN
    ALTER TABLE public.outlook_candidate_refs
      ADD CONSTRAINT ocr_conversation_fp_shape
      CHECK (conversation_fingerprint IS NULL OR conversation_fingerprint ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ocr_coverage_shape') THEN
    -- Bounded at 50, the same ceiling the eligibility pass applies to one episode, and
    -- every element must be a fingerprint. Concatenating and matching repeated 64-hex
    -- groups proves that for the whole array in one expression.
    ALTER TABLE public.outlook_candidate_refs
      ADD CONSTRAINT ocr_coverage_shape
      CHECK (covered_message_fingerprints IS NULL
             OR (array_length(covered_message_fingerprints, 1) BETWEEN 1 AND 50
                 AND array_to_string(covered_message_fingerprints, '') ~ '^([0-9a-f]{64})+$'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ocr_coverage_source_known') THEN
    ALTER TABLE public.outlook_candidate_refs
      ADD CONSTRAINT ocr_coverage_source_known
      CHECK (coverage_source IS NULL OR coverage_source IN ('draft', 'legacy_baseline'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ocr_coverage_together') THEN
    -- ALL OR NOTHING. A coverage set without its instant or its provenance, or either
    -- without the set, is a half-written claim - and a half-written claim about what has
    -- been summarized is exactly what loses mail. A coverage set also requires the thread
    -- it belongs to.
    ALTER TABLE public.outlook_candidate_refs
      ADD CONSTRAINT ocr_coverage_together
      CHECK ((covered_message_fingerprints IS NULL AND coverage_through_at IS NULL
              AND coverage_from_at IS NULL AND coverage_source IS NULL)
             OR (covered_message_fingerprints IS NOT NULL AND coverage_through_at IS NOT NULL
                 AND coverage_from_at IS NOT NULL AND coverage_source IS NOT NULL
                 AND conversation_fingerprint IS NOT NULL
                 AND coverage_from_at <= coverage_through_at));
  END IF;
END
$mig$;

-- The one lookup this feature adds: a thread's segments, for one user.
CREATE INDEX IF NOT EXISTS ocr_conversation_idx
  ON public.outlook_candidate_refs (user_id, conversation_fingerprint)
  WHERE conversation_fingerprint IS NOT NULL;

-- ── 1b. the durable recovery floor hint ────────────────────────────────────────
-- ONE ROW PER THREAD, and it exists for the one case no column can serve: a thread that has
-- an uncovered message nobody could pair, and therefore NO candidate to hang state on.
--
-- Reproduced before this existed. Settled coverage ends at 10:00. An unseen outbound at 09:00
-- arrives in round A, whose floor is correctly 09:00 - but its reply does not exist yet, so
-- nothing is written and the round's working records are erased on completion. The reply
-- arrives at 11:00 in round B, whose floor is the coverage instant, 10:00. The 09:00 half is
-- never re-listed and the exchange is never assembled.
--
-- THIS IS A FLOOR HINT AND NOTHING ELSE. It is never read to decide coverage, so holding it
-- longer than strictly necessary costs a wider listing window and nothing more - and that
-- window is still one bounded page per folder, with truncation reported rather than written
-- around. It lowers monotonically, so an older unpaired half can only widen the window.
CREATE TABLE IF NOT EXISTS public.outlook_thread_recovery (
  connection_id            uuid        NOT NULL,
  user_id                  uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_fingerprint text        NOT NULL,
  earliest_unpaired_at     timestamptz NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, conversation_fingerprint),
  CONSTRAINT otr_cfp_shape CHECK (conversation_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT otr_conn_user_fk FOREIGN KEY (connection_id, user_id)
    REFERENCES public.microsoft_connections(id, user_id) ON DELETE CASCADE
);
ALTER TABLE public.outlook_thread_recovery ENABLE ROW LEVEL SECURITY;
-- No user policy, exactly as outlook_subscriptions has none: this is worker state, and a
-- reader could otherwise learn which threads have unresolved halves.
REVOKE ALL ON TABLE public.outlook_thread_recovery FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.outlook_thread_recovery TO service_role;

-- Record (or lower) the hint for one thread. Worker-only, lease-fenced, LEAST so it never
-- rises - a hint that rose could exclude a half it had already seen.
CREATE OR REPLACE FUNCTION public.record_outlook_thread_recovery(
  p_connection_id            uuid,
  p_run_id                   uuid,
  p_conversation_fingerprint text,
  p_earliest_unpaired_at     timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid     uuid;
  v_leaseok boolean;
  v_at      timestamptz;
BEGIN
  IF p_conversation_fingerprint IS NULL OR p_conversation_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'invalid_conversation_fingerprint');
  END IF;
  IF p_earliest_unpaired_at IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_instant');
  END IF;

  PERFORM 1 FROM public.outlook_sync_state s WHERE s.connection_id = p_connection_id FOR SHARE;
  SELECT c.user_id INTO v_uid FROM public.microsoft_connections c WHERE c.id = p_connection_id;
  IF v_uid IS NULL THEN RETURN jsonb_build_object('result', 'unknown_connection'); END IF;
  SELECT count(*) = 2 AND bool_and(s.sync_run_id = p_run_id
                                   AND s.sync_status = 'running'
                                   AND s.sync_lease_until IS NOT NULL
                                   AND s.sync_lease_until > now())
    INTO v_leaseok
  FROM public.outlook_sync_state s WHERE s.connection_id = p_connection_id;
  IF v_leaseok IS NOT TRUE THEN RETURN jsonb_build_object('result', 'stale_run'); END IF;

  INSERT INTO public.outlook_thread_recovery
    (connection_id, user_id, conversation_fingerprint, earliest_unpaired_at)
  VALUES (p_connection_id, v_uid, p_conversation_fingerprint, p_earliest_unpaired_at)
  ON CONFLICT (connection_id, conversation_fingerprint) DO UPDATE
    SET earliest_unpaired_at = LEAST(public.outlook_thread_recovery.earliest_unpaired_at,
                                     EXCLUDED.earliest_unpaired_at),
        updated_at           = now()
  RETURNING earliest_unpaired_at INTO v_at;

  RETURN jsonb_build_object('result', 'ok', 'earliest_unpaired_at', v_at);
END
$fn$;

-- ── 2. read the coverage of the threads this round will write ──────────────────
-- ONE call per round, not one per conversation: the worker passes every thread it is about
-- to consider. Each entry carries the conversation fingerprint AND the legacy whole-thread
-- episode fingerprint, because a row written before this feature has no conversation
-- fingerprint and can only be found by the episode key the worker still computes.
CREATE OR REPLACE FUNCTION public.get_outlook_thread_coverage(
  p_connection_id uuid,
  p_run_id        uuid,
  p_threads       jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid     uuid;
  v_leaseok boolean;
  v_out     jsonb;
BEGIN
  IF p_threads IS NULL OR pg_catalog.jsonb_typeof(p_threads) <> 'array' THEN
    RETURN jsonb_build_object('result', 'invalid_threads');
  END IF;
  IF pg_catalog.jsonb_array_length(p_threads) > 200 THEN
    RETURN jsonb_build_object('result', 'invalid_threads');
  END IF;

  -- The same lease fence, in the same lock order, as the producers.
  PERFORM 1 FROM public.outlook_sync_state s WHERE s.connection_id = p_connection_id FOR SHARE;
  SELECT c.user_id INTO v_uid FROM public.microsoft_connections c WHERE c.id = p_connection_id;
  IF v_uid IS NULL THEN RETURN jsonb_build_object('result', 'unknown_connection'); END IF;
  SELECT count(*) = 2 AND bool_and(s.sync_run_id = p_run_id
                                   AND s.sync_status = 'running'
                                   AND s.sync_lease_until IS NOT NULL
                                   AND s.sync_lease_until > now())
    INTO v_leaseok
  FROM public.outlook_sync_state s WHERE s.connection_id = p_connection_id;
  IF v_leaseok IS NOT TRUE THEN RETURN jsonb_build_object('result', 'stale_run'); END IF;

  WITH want AS (
    -- `cfp` is the CURRENT-key value and keys every row in the answer. `cfps` are its ring
    -- variants: a refs row written before a key rotation is stored under an older value, and
    -- an equality match on the current one misses the thread entirely - so the thread would
    -- look new and its pending segment would be duplicated.
    SELECT t->>'cfp' AS cfp,
           t->>'efp' AS efp,
           COALESCE(
             (SELECT pg_catalog.array_agg(v) FROM pg_catalog.jsonb_array_elements_text(
                CASE WHEN pg_catalog.jsonb_typeof(t->'cfps') = 'array' THEN t->'cfps' ELSE '[]'::jsonb END) v
              WHERE v ~ '^[0-9a-f]{64}$'),
             ARRAY[]::text[]) || ARRAY[t->>'cfp'] AS cfps
    FROM pg_catalog.jsonb_array_elements(p_threads) t
    WHERE t->>'cfp' ~ '^[0-9a-f]{64}$'
  ),
  -- Every segment of every wanted thread, from BOTH candidate tables. A thread settled as
  -- a new-contact proposal and continuing as a known-contact interaction is one thread:
  -- the conversation fingerprint is contact-independent precisely so this join works.
  seg AS (
    SELECT w.cfp,
           r.covered_message_fingerprints AS cov,
           r.coverage_through_at          AS thru,
           r.coverage_from_at             AS frm,
           r.conversation_fingerprint     AS stored_cfp,
           ic.status                      AS st,
           ic.source_fingerprint          AS sfp
    FROM want w
    JOIN public.outlook_candidate_refs r
      ON r.user_id = v_uid
     AND (r.conversation_fingerprint = ANY (w.cfps)
          OR (r.conversation_fingerprint IS NULL AND w.efp ~ '^[0-9a-f]{64}$'
              AND r.episode_fingerprint = w.efp))
    JOIN public.interaction_candidates ic
      ON ic.id = r.interaction_candidate_id AND ic.user_id = r.user_id
    UNION ALL
    -- The proposal's OWN anchor, not NULL. An earlier version selected NULL here and then
    -- filtered the pending CTE on `sfp IS NOT NULL`, so a pending proposal was invisible to
    -- the worker and every write for that thread created another one.
    SELECT w.cfp, r.covered_message_fingerprints, r.coverage_through_at, r.coverage_from_at,
           r.conversation_fingerprint, nc.status, nc.episode_fingerprint
    FROM want w
    JOIN public.outlook_candidate_refs r
      ON r.user_id = v_uid
     AND (r.conversation_fingerprint = ANY (w.cfps)
          OR (r.conversation_fingerprint IS NULL AND w.efp ~ '^[0-9a-f]{64}$'
              AND r.episode_fingerprint = w.efp))
    JOIN public.new_contact_candidates nc
      ON nc.id = r.new_contact_candidate_id AND nc.user_id = r.user_id
  ),
  settled AS (
    SELECT s.cfp,
           pg_catalog.array_agg(DISTINCT f ORDER BY f) AS covered,
           max(s.thru)                                 AS thru,
           bool_or(s.cov IS NULL)                      AS missing
    FROM seg s
    LEFT JOIN pg_catalog.unnest(COALESCE(s.cov, ARRAY[]::text[])) f ON true
    WHERE s.st NOT IN ('pending', 'deferred')
    GROUP BY s.cfp
  ),
  pend AS (
    -- OPEN, not only 'pending'. A proposal may be 'deferred', which the new-contact producer
    -- treats as refreshable ("not yet, and more of the exchange may arrive"), so it pins
    -- identity exactly as a pending row does. interaction_candidates has no 'deferred'
    -- status, so this is a no-op on that side. Ordered deterministically: newest coverage
    -- first, then the anchor, so a thread that transiently holds both kinds of open row
    -- still resolves to one answer.
    SELECT DISTINCT ON (s.cfp) s.cfp, s.sfp, s.cov, s.frm
    FROM seg s
    WHERE s.st IN ('pending', 'deferred') AND s.sfp IS NOT NULL
    ORDER BY s.cfp, s.thru DESC NULLS LAST, s.sfp
  ),
  -- The durable floor hint: the earliest uncovered message this connection has seen for the
  -- thread and could not pair. Survives completed rounds, which is the whole point.
  hint AS (
    SELECT w.cfp, min(tr.earliest_unpaired_at) AS at
    FROM want w
    JOIN public.outlook_thread_recovery tr
      ON tr.user_id = v_uid AND tr.conversation_fingerprint = ANY (w.cfps)
    GROUP BY w.cfp
  ),
  -- WHICH variant the thread is actually on record under. The worker passes it back as the
  -- producer's lookup value, so a row written under a retired key is still found - and the
  -- producer rewrites it to the current value, migrating the thread key forward on touch.
  matched AS (
    SELECT DISTINCT ON (s.cfp) s.cfp, s.stored_cfp
    FROM seg s WHERE s.stored_cfp IS NOT NULL
    ORDER BY s.cfp, s.thru DESC NULLS LAST
  )
  SELECT pg_catalog.jsonb_agg(jsonb_build_object(
           'conversation_fingerprint',       w.cfp,
           'covered_fingerprints',           COALESCE(st.covered, ARRAY[]::text[]),
           'coverage_through_at',            st.thru,
           'settled_without_coverage',       COALESCE(st.missing, false),
           'pending_episode_fingerprint',    pd.sfp,
           'pending_covered_fingerprints',   COALESCE(pd.cov, ARRAY[]::text[]),
           'pending_coverage_from_at',       pd.frm,
           'earliest_unpaired_at',           hn.at,
           'matched_conversation_fingerprint', mt.stored_cfp))
    INTO v_out
  FROM want w
  LEFT JOIN settled st ON st.cfp = w.cfp
  LEFT JOIN pend    pd ON pd.cfp = w.cfp
  LEFT JOIN hint    hn ON hn.cfp = w.cfp
  LEFT JOIN matched mt ON mt.cfp = w.cfp;

  RETURN jsonb_build_object('result', 'ok', 'threads', COALESCE(v_out, '[]'::jsonb));
END
$fn$;

-- ── 3. forward-only initialization for threads settled before segments existed ─
-- A settled segment with NO coverage set cannot have its coverage reconstructed: the
-- reviewer's date is editable and is a date, not a message, and the handles that named the
-- messages were erased with the round. So coverage is NOT inferred. Instead the worker
-- records, ONCE and explicitly, the messages of that thread it can currently see as the
-- baseline. No suggestion is produced from them.
--
-- WHAT THE FIRST CONTINUATION DOES, stated plainly: an exchange already sitting in the
-- thread at baseline time is absorbed into the baseline and is NOT suggested. Only mail
-- that arrives after the baseline becomes a segment. That costs at most one exchange per
-- legacy thread and it is the price of never duplicating an interaction the reviewer has
-- already accepted. `coverage_source = 'legacy_baseline'` records which rows were
-- initialized this way rather than drafted, so the two can never be confused.
CREATE OR REPLACE FUNCTION public.baseline_outlook_thread_coverage(
  p_connection_id            uuid,
  p_run_id                   uuid,
  p_conversation_fingerprint text,
  p_episode_fingerprint      text,
  p_covered_fingerprints     text[],
  p_coverage_from_at         timestamptz,
  p_coverage_through_at      timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid     uuid;
  v_leaseok boolean;
  v_seg_cov text[];
  v_rows    int;
BEGIN
  IF p_conversation_fingerprint IS NULL OR p_conversation_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'invalid_conversation_fingerprint');
  END IF;
  IF p_episode_fingerprint IS NULL OR p_episode_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'invalid_fingerprint');
  END IF;
  IF p_coverage_through_at IS NULL OR p_coverage_from_at IS NULL
      OR p_coverage_from_at > p_coverage_through_at THEN
    RETURN jsonb_build_object('result', 'invalid_coverage_set');
  END IF;
  IF p_covered_fingerprints IS NULL
      OR pg_catalog.array_length(p_covered_fingerprints, 1) IS NULL
      OR pg_catalog.array_length(p_covered_fingerprints, 1) > 50 THEN
    RETURN jsonb_build_object('result', 'invalid_coverage_set');
  END IF;
  PERFORM 1 FROM pg_catalog.unnest(p_covered_fingerprints) f WHERE f !~ '^[0-9a-f]{64}$';
  IF FOUND THEN RETURN jsonb_build_object('result', 'invalid_coverage_fingerprint'); END IF;
  SELECT pg_catalog.array_agg(DISTINCT f ORDER BY f)
    INTO v_seg_cov FROM pg_catalog.unnest(p_covered_fingerprints) f;

  PERFORM 1 FROM public.outlook_sync_state s WHERE s.connection_id = p_connection_id FOR SHARE;
  SELECT c.user_id INTO v_uid FROM public.microsoft_connections c WHERE c.id = p_connection_id;
  IF v_uid IS NULL THEN RETURN jsonb_build_object('result', 'unknown_connection'); END IF;
  SELECT count(*) = 2 AND bool_and(s.sync_run_id = p_run_id
                                   AND s.sync_status = 'running'
                                   AND s.sync_lease_until IS NOT NULL
                                   AND s.sync_lease_until > now())
    INTO v_leaseok
  FROM public.outlook_sync_state s WHERE s.connection_id = p_connection_id;
  IF v_leaseok IS NOT TRUE THEN RETURN jsonb_build_object('result', 'stale_run'); END IF;

  -- ONLY rows that have no coverage yet, and only ones reachable by the legacy episode key
  -- or already linked to this thread. A row that already carries coverage is never
  -- rewritten, so a baseline can be attempted twice without consequence.
  WITH target AS (
    SELECT r.id
    FROM public.outlook_candidate_refs r
    WHERE r.user_id = v_uid
      AND r.covered_message_fingerprints IS NULL
      AND (r.conversation_fingerprint = p_conversation_fingerprint
           OR (r.conversation_fingerprint IS NULL AND r.episode_fingerprint = p_episode_fingerprint))
      AND EXISTS (
        SELECT 1 FROM public.interaction_candidates ic
        WHERE ic.id = r.interaction_candidate_id AND ic.user_id = r.user_id
          AND ic.status NOT IN ('pending', 'deferred')
        UNION ALL
        SELECT 1 FROM public.new_contact_candidates nc
        WHERE nc.id = r.new_contact_candidate_id AND nc.user_id = r.user_id
          AND nc.status NOT IN ('pending', 'deferred'))
  )
  UPDATE public.outlook_candidate_refs r
     SET conversation_fingerprint     = p_conversation_fingerprint,
         covered_message_fingerprints = v_seg_cov,
         coverage_from_at             = p_coverage_from_at,
         coverage_through_at          = p_coverage_through_at,
         coverage_source              = 'legacy_baseline',
         updated_at                   = now()
   WHERE r.id IN (SELECT id FROM target);
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN jsonb_build_object('result', 'ok', 'initialized', v_rows);
END
$fn$;

-- ── 4. the producers, thread-aware ─────────────────────────────────────────────
-- The previous signatures are dropped so exactly ONE overload of each survives, which is
-- the invariant the catalog tests assert.
DROP FUNCTION IF EXISTS public.upsert_outlook_interaction_candidate(
  uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text);
DROP FUNCTION IF EXISTS public.upsert_new_contact_candidate(
  uuid, uuid, text, text, smallint, text, date, text, text, text, text, text, text, text);

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
  p_extraction_status   text   DEFAULT NULL,
  -- <<< 20261008
  -- >>> 20261011 segments
  -- THE THREAD, and the coverage this write claims for it.
  --   p_conversation_fingerprint  the thread's durable identity - independent of which of
  --                               its messages have been seen AND of whether the person is
  --                               a contact yet, which is what lets coverage survive the
  --                               new-contact transition.
  --   p_covered_fingerprints      the messages the draft being stored represents.
  --   p_coverage_through_at       the latest instant among them. Used only as the floor for
  --                               a bounded recovery listing, NEVER to decide coverage.
  -- All three default to NULL, in which case this function behaves exactly as the version
  -- that shipped - so it can be applied before the worker that uses it.
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
  p_conversation_lookup_fingerprints text[] DEFAULT NULL
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
  v_notes   text;
  -- >>> 20261008
  v_follow  text;
  -- <<< 20261008
  -- >>> 20261011 segments
  v_seg_cov text[];    -- the incoming coverage, de-duplicated and ordered
  v_settled text[];    -- union of coverage over this thread's settled segments
  v_missing boolean;   -- a settled segment of this thread carries NO coverage set
  v_pend    uuid;      -- this thread's pending segment, if it has one
  v_newfp   int;       -- how many incoming fingerprints are NOT already settled
  v_cfps    text[];    -- the thread's ring variants, the current value included
  -- <<< 20261011
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
  -- >>> 20261011 segments
  -- SHAPE FIRST. A value that is not a fingerprint proves nothing, so a malformed one is
  -- refused here rather than stored and trusted later.
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
    -- Coverage is meaningful only against a thread, and only together with its instant.
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
  -- <<< 20261011

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

  -- >>> 20261011 segments
  -- ── THE THREAD, BEFORE THE EPISODE ────────────────────────────────────────
  -- A thread is a SEQUENCE OF SEGMENTS. Acceptance and dismissal settle the exchange a
  -- suggestion represented, not every future exchange in the thread, so the question is no
  -- longer "does this episode fingerprint exist" but "has this thread already summarized
  -- THESE messages".
  --
  -- ONE PENDING SEGMENT PER THREAD, keeping the identity it was created under. Whatever the
  -- worker computed as the current anchor, a write for a thread that already has a pending
  -- segment lands on that row: re-anchoring would turn a late-discovered message or a
  -- rotated key into a second suggestion for one exchange.
  IF p_conversation_fingerprint IS NOT NULL THEN
    SELECT ic.id INTO v_pend
    FROM public.outlook_candidate_refs r
    JOIN public.interaction_candidates ic
      ON ic.id = r.interaction_candidate_id AND ic.user_id = r.user_id
    WHERE r.user_id = v_uid
      AND r.conversation_fingerprint = ANY (v_cfps)
      AND ic.status = 'pending'
    ORDER BY ic.created_at
    FOR UPDATE OF ic
    LIMIT 1;

    IF v_pend IS NULL THEN
      WITH seg AS (
        SELECT r.covered_message_fingerprints AS cov, ic.status AS st, ic.updated_at AS upd,
               r.interaction_candidate_id AS icid
        FROM public.outlook_candidate_refs r
        JOIN public.interaction_candidates ic
          ON ic.id = r.interaction_candidate_id AND ic.user_id = r.user_id
        WHERE r.user_id = v_uid AND r.conversation_fingerprint = ANY (v_cfps)
        UNION ALL
        SELECT r.covered_message_fingerprints, nc.status, nc.updated_at, NULL::uuid
        FROM public.outlook_candidate_refs r
        JOIN public.new_contact_candidates nc
          ON nc.id = r.new_contact_candidate_id AND nc.user_id = r.user_id
        WHERE r.user_id = v_uid AND r.conversation_fingerprint = ANY (v_cfps)
      )
      SELECT pg_catalog.array_agg(DISTINCT f ORDER BY f), bool_or(s.cov IS NULL)
        INTO v_settled, v_missing
      FROM seg s
      LEFT JOIN pg_catalog.unnest(COALESCE(s.cov, ARRAY[]::text[])) f ON true
      WHERE s.st NOT IN ('pending', 'deferred');

      -- A SETTLED SEGMENT WITH NO COVERAGE predates this feature. Its coverage is NOT
      -- inferred from the reviewer's date - a date is editable and is not a message - so the
      -- thread produces nothing until it has been given an explicit forward-only baseline
      -- by baseline_outlook_thread_coverage.
      IF COALESCE(v_missing, false) THEN
        RETURN jsonb_build_object('result', 'coverage_uninitialized');
      END IF;

      IF v_seg_cov IS NOT NULL AND v_settled IS NOT NULL THEN
        SELECT count(*) INTO v_newfp
        FROM pg_catalog.unnest(v_seg_cov) f
        WHERE NOT (f = ANY (v_settled));

        IF v_newfp = 0 THEN
          -- Every message of this draft is already summarized: a replay, or a round that
          -- re-read a settled exchange. Nothing new, and nothing resurrected.
          SELECT ic.id INTO v_cand
          FROM public.outlook_candidate_refs r
          JOIN public.interaction_candidates ic
            ON ic.id = r.interaction_candidate_id AND ic.user_id = r.user_id
          WHERE r.user_id = v_uid
            AND r.conversation_fingerprint = ANY (v_cfps)
            AND ic.status NOT IN ('pending', 'deferred')
          ORDER BY ic.updated_at DESC
          LIMIT 1;
          RETURN jsonb_build_object('result', 'exists_terminal', 'candidate_id', v_cand);
        END IF;

        IF v_newfp < pg_catalog.array_length(v_seg_cov, 1) THEN
          -- PARTIAL OVERLAP. The reviewer decided this exchange while the worker was
          -- drafting it, so the draft in hand describes a mixture of settled and new mail.
          -- Storing it would duplicate what is already logged; discarding it would lose the
          -- new mail. Neither: refuse with a result that is NOT in WRITE_OK, so the cursor
          -- does not advance, and the next round re-reads the thread and drafts only the
          -- genuinely new part.
          RETURN jsonb_build_object('result', 'coverage_moved');
        END IF;
      END IF;
    END IF;
  END IF;
  -- <<< 20261011
  -- ── deduplicate across the write key AND any accepted prior keys ──────────
  -- >>> 20261011 segments
  -- When the thread already located and locked its pending segment above, THAT row is the
  -- answer whatever anchor this write arrived under. It is re-selected by id rather than
  -- assigned, so `FOUND` below means the same thing on both branches and the line that
  -- tests it does not move.
  IF v_pend IS NOT NULL THEN
    SELECT id, status INTO v_cand, v_status
    FROM public.interaction_candidates WHERE id = v_pend;
  ELSE
  -- <<< 20261011
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
  -- >>> 20261011 segments
  END IF;
  -- <<< 20261011

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
    -- >>> 20261011 segments
    -- COVERAGE MOVES WITH THE DRAFT, AND ONLY WITH THE DRAFT, in this same transaction.
    -- `v_notes IS NOT NULL` is the one test the draft columns above already turn on, so a
    -- metadata-only refresh - the consent gate closed, a body fetch failed - leaves the
    -- stored draft AND its coverage exactly as they were. Coverage running ahead of the
    -- draft would mark mail summarized that nothing describes.
    IF v_seg_cov IS NOT NULL AND v_notes IS NOT NULL THEN
      UPDATE public.outlook_candidate_refs
         SET conversation_fingerprint     = p_conversation_fingerprint,
             covered_message_fingerprints = v_seg_cov,
             coverage_from_at             = p_coverage_from_at,
             coverage_through_at          = p_coverage_through_at,
             coverage_source              = 'draft',
             updated_at                   = now()
       WHERE user_id = v_uid AND interaction_candidate_id = v_cand;
    ELSIF p_conversation_fingerprint IS NOT NULL THEN
      -- The thread LINK is not a coverage claim, so recording it on a metadata-only refresh
      -- is safe - and it is what makes an existing pending row findable by thread.
      UPDATE public.outlook_candidate_refs
         SET conversation_fingerprint = p_conversation_fingerprint, updated_at = now()
       WHERE user_id = v_uid AND interaction_candidate_id = v_cand
         AND (conversation_fingerprint IS NULL
              OR conversation_fingerprint IS DISTINCT FROM p_conversation_fingerprint);
    END IF;
    -- <<< 20261011
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
  -- >>> 20261011 segments
  -- The thread and the coverage, on the row just linked. SAME FUNCTION, SAME TRANSACTION as
  -- the INSERT above and as the candidate's own draft, so a created segment never exists
  -- without the record of what it represents - and a created segment that carried no draft
  -- records no coverage, which is the same rule the refresh path applies.
  UPDATE public.outlook_candidate_refs
     SET conversation_fingerprint     = p_conversation_fingerprint,
         covered_message_fingerprints = CASE WHEN v_notes IS NOT NULL THEN v_seg_cov END,
         coverage_from_at             = CASE WHEN v_notes IS NOT NULL AND v_seg_cov IS NOT NULL
                                             THEN p_coverage_from_at END,
         coverage_through_at          = CASE WHEN v_notes IS NOT NULL AND v_seg_cov IS NOT NULL
                                             THEN p_coverage_through_at END,
         coverage_source              = CASE WHEN v_notes IS NOT NULL AND v_seg_cov IS NOT NULL
                                             THEN 'draft' END
   WHERE user_id = v_uid AND interaction_candidate_id = v_cand
     AND p_conversation_fingerprint IS NOT NULL;
  -- <<< 20261011

  RETURN jsonb_build_object('result', 'created', 'candidate_id', v_cand);
END;
$$;
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
  p_conversation_lookup_fingerprints text[] DEFAULT NULL
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
           context_expires_at        = now() + interval '30 days',
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
  -- <<< 20261011

  RETURN jsonb_build_object('result', 'created', 'candidate_id', v_cand);
END;
$$;

-- ── 5. who may call what ───────────────────────────────────────────────────────
-- The worker's role only, which is the posture the producers already had. Never
-- authenticated, never anon, never PUBLIC: a reader could otherwise learn which threads a
-- user has exchanges in, and which of them have unresolved halves.
--
-- FROM PUBLIC IS NOT ENOUGH, and the disposable-database check is what proved it. This
-- project's default privileges grant EXECUTE on a new function in `public` to anon,
-- authenticated and service_role, so CREATE OR REPLACE after a DROP hands the producers back
-- to every signed-in user. anon and authenticated are revoked EXPLICITLY, exactly as
-- 20261008000000 and 20261010180000 state it.
--
-- Every signature is spelled out once, here. An earlier revision patched these by substring
-- and appended an argument to baseline_outlook_thread_coverage that it does not take - which
-- surfaces only as "function does not exist" at apply time.
REVOKE ALL ON FUNCTION public.record_outlook_thread_recovery(uuid, uuid, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_outlook_thread_coverage(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.baseline_outlook_thread_coverage(uuid, uuid, text, text, text[], timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_outlook_interaction_candidate(
  uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text,
  text, text[], timestamptz, timestamptz, text[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_new_contact_candidate(
  uuid, uuid, text, text, smallint, text, date, text, text, text, text, text, text, text,
  text, text[], timestamptz, timestamptz, text[])
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_outlook_thread_recovery(uuid, uuid, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_outlook_thread_coverage(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.baseline_outlook_thread_coverage(uuid, uuid, text, text, text[], timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_outlook_interaction_candidate(
  uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text,
  text, text[], timestamptz, timestamptz, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_new_contact_candidate(
  uuid, uuid, text, text, smallint, text, date, text, text, text, text, text, text, text,
  text, text[], timestamptz, timestamptz, text[]) TO service_role;

-- The acceptance RPCs are NOT re-issued here and keep their 10,000-character reviewed-note
-- allowance and their authenticated-only grant. A later segment becomes a NEW interaction
-- through the unchanged acceptance path.
