-- Outlook — durable continuation: resume a delta round across invocations.
--
-- WHY THIS EXISTS. The worker awaits a whole import before answering, and hosted
-- Supabase Edge Functions will not allow that: the request idle timeout is 150s and the
-- maximum duration is 150s on the free plan (400s on paid). Background tasks do not
-- help - the docs are explicit that `EdgeRuntime.waitUntil` is still "capped based on
-- the wall-clock, CPU, and memory limits". So one invocation must be able to stop
-- part-way through a delta round, persist exactly where it got to, and let the next
-- invocation carry on. The 420s database lease is NOT an execution budget: it exists to
-- stop a second run touching the same connection and is deliberately longer than any
-- single invocation may live.
--
-- Full design, including the two things that are NOT decided here, is in
-- docs/outlook-durable-continuation-design.md.
--
-- ── WHAT A ROUND IS ──────────────────────────────────────────────────────────
-- A ROUND is one pass from the committed delta cursors to the next pair of deltaLinks.
-- It may span many invocations. Within a round:
--   * Microsoft's opaque @odata.nextLink is stored ENCRYPTED and UNCHANGED, per folder;
--   * a folder that reaches its @odata.deltaLink stores it as a PENDING cursor, which is
--     NOT the committed cursor and is never read as one;
--   * per-conversation recognition state accumulates in outlook_conversation_progress.
-- Only when both folders have finished, nothing was dropped, and every qualifying
-- suggestion has been written, does release_outlook_sync_lease promote the pending
-- cursors and erase the round. A cursor still means "everything before this is
-- ingested", which is the whole point of holding it back.
--
-- ── WHAT IS PERSISTED, AND WHAT IS NOT ───────────────────────────────────────
-- The accumulator holds ONLY keyed one-way fingerprints, a key version, two timestamps,
-- bounded counts, Funnl's own contact id, and controlled codes. It holds NO message
-- body, header, subject, mailbox address, display name, Microsoft message id or
-- conversation id - there is no column here that could hold one. The episode
-- fingerprint is computed while the raw provider key is in memory and only the RESULT
-- is stored, which is why no provider identifier needs to survive an invocation.
--
-- POLICY. The published /privacy "What Funnl would keep" list is exhaustive and does NOT
-- yet name this record. Every FIELD KIND in it is already disclosed (keyed fingerprints
-- with a key version, timestamps, counts, short codes), but the record is not, so one
-- bullet must be added to the published policy before Outlook is enabled. That is
-- recorded as decision D1 in the design document; nothing here publishes or alters the
-- live policy.
--
-- RETENTION, deliberately minimal and with no new promise. Accumulator rows are
-- ROUND-SCOPED: erased when the round commits, erased when a round is reset, and erased
-- for any superseded or expired round the moment a new round touches the connection. No
-- scheduler is introduced and no retention window is promised beyond that.
--
-- GRANTS. service_role only throughout. Per the FUTURE RULE recorded in
-- 20260922175616 every REVOKE names PUBLIC, anon AND authenticated explicitly, because
-- this project's default privileges would otherwise grant all three at CREATE time.
--
-- NOT APPLIED. Do not run against Production without explicit approval.


-- ══════════════════════════════════════════════════════════════════════════════
--  A. outlook_sync_state — per-folder round progress
-- ══════════════════════════════════════════════════════════════════════════════
-- Additive only. Every existing column, constraint, grant and policy is untouched, and
-- every existing row keeps its committed cursor and its lease exactly as they are.
ALTER TABLE public.outlook_sync_state
  ADD COLUMN IF NOT EXISTS round_id                    uuid,
  ADD COLUMN IF NOT EXISTS round_started_at            timestamptz,
  ADD COLUMN IF NOT EXISTS round_expires_at            timestamptz,
  ADD COLUMN IF NOT EXISTS round_pages                 integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS round_messages              integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS round_page_seq              integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS round_messages_dropped      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS round_conversations_dropped integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS round_folder_complete       boolean NOT NULL DEFAULT false,
  -- How far the FINALISATION stage got. The suggestions of a finished round are written
  -- in conversation-fingerprint order, and this is the last fingerprint already dealt
  -- with (written, or deliberately skipped). Without it a large final batch restarts from
  -- its first entry on every invocation, so a batch too big for one invocation can never
  -- finish - reproduced before this column existed: a hard stop after 6 of 40 writes left
  -- 6 pending suggestions, the round intact, both cursors NULL, and the next invocation
  -- beginning the same 40 again.
  ADD COLUMN IF NOT EXISTS round_write_cursor          text,
  -- Microsoft's @odata.nextLink: opaque, time-limited, stored unchanged and encrypted
  -- for exactly the same reason the deltaLink is (it embeds provider state).
  ADD COLUMN IF NOT EXISTS next_link_ciphertext        text,
  ADD COLUMN IF NOT EXISTS next_link_nonce             text,
  ADD COLUMN IF NOT EXISTS next_link_key_version       smallint,
  -- The folder's @odata.deltaLink, STAGED. Promotion to delta_link_ciphertext happens
  -- only in release_outlook_sync_lease, only on a complete run.
  ADD COLUMN IF NOT EXISTS pending_delta_ciphertext    text,
  ADD COLUMN IF NOT EXISTS pending_delta_nonce         text,
  ADD COLUMN IF NOT EXISTS pending_delta_key_version   smallint;

ALTER TABLE public.outlook_sync_state
  DROP CONSTRAINT IF EXISTS oss_next_link_pair_check;
ALTER TABLE public.outlook_sync_state
  ADD CONSTRAINT oss_next_link_pair_check
  CHECK ((next_link_ciphertext IS NULL AND next_link_nonce IS NULL)
      OR (next_link_ciphertext IS NOT NULL AND next_link_nonce IS NOT NULL));

ALTER TABLE public.outlook_sync_state
  DROP CONSTRAINT IF EXISTS oss_next_link_len;
ALTER TABLE public.outlook_sync_state
  ADD CONSTRAINT oss_next_link_len
  CHECK (next_link_ciphertext IS NULL OR char_length(next_link_ciphertext) <= 16384);

ALTER TABLE public.outlook_sync_state
  DROP CONSTRAINT IF EXISTS oss_pending_delta_pair_check;
ALTER TABLE public.outlook_sync_state
  ADD CONSTRAINT oss_pending_delta_pair_check
  CHECK ((pending_delta_ciphertext IS NULL AND pending_delta_nonce IS NULL)
      OR (pending_delta_ciphertext IS NOT NULL AND pending_delta_nonce IS NOT NULL));

ALTER TABLE public.outlook_sync_state
  DROP CONSTRAINT IF EXISTS oss_pending_delta_len;
ALTER TABLE public.outlook_sync_state
  ADD CONSTRAINT oss_pending_delta_len
  CHECK (pending_delta_ciphertext IS NULL OR char_length(pending_delta_ciphertext) <= 16384);

ALTER TABLE public.outlook_sync_state
  DROP CONSTRAINT IF EXISTS oss_round_counts_nonneg;
ALTER TABLE public.outlook_sync_state
  ADD CONSTRAINT oss_round_counts_nonneg
  CHECK (round_pages >= 0 AND round_messages >= 0 AND round_page_seq >= 0
         AND round_messages_dropped >= 0 AND round_conversations_dropped >= 0);

-- Round state without a round is meaningless, and would be read as "resume from here".
ALTER TABLE public.outlook_sync_state
  DROP CONSTRAINT IF EXISTS oss_round_state_requires_round;
ALTER TABLE public.outlook_sync_state
  ADD CONSTRAINT oss_round_state_requires_round
  CHECK (round_id IS NOT NULL
         OR (next_link_ciphertext IS NULL AND pending_delta_ciphertext IS NULL
             AND round_pages = 0 AND round_messages = 0 AND round_page_seq = 0
             AND round_messages_dropped = 0 AND round_conversations_dropped = 0
             AND round_folder_complete = false AND round_write_cursor IS NULL));

-- The write cursor is a conversation fingerprint, so it has the same shape as one. A free
-- text column here would let a malformed value silently exclude every row from the next
-- finalisation pass, which would look exactly like "nothing left to write".
ALTER TABLE public.outlook_sync_state
  DROP CONSTRAINT IF EXISTS oss_round_write_cursor_shape;
ALTER TABLE public.outlook_sync_state
  ADD CONSTRAINT oss_round_write_cursor_shape
  CHECK (round_write_cursor IS NULL OR round_write_cursor ~ '^[0-9a-f]{64}$');

-- A folder is either still mid-stream (a nextLink) or finished (a pending deltaLink).
-- Holding both at once would leave two contradictory answers to "where do I resume".
ALTER TABLE public.outlook_sync_state
  DROP CONSTRAINT IF EXISTS oss_round_position_exclusive;
ALTER TABLE public.outlook_sync_state
  ADD CONSTRAINT oss_round_position_exclusive
  CHECK (next_link_ciphertext IS NULL OR pending_delta_ciphertext IS NULL);

-- `round_folder_complete` is the flag the commit gate reads; it must agree with the
-- staged cursor rather than being independently settable.
ALTER TABLE public.outlook_sync_state
  DROP CONSTRAINT IF EXISTS oss_round_complete_requires_pending;
ALTER TABLE public.outlook_sync_state
  ADD CONSTRAINT oss_round_complete_requires_pending
  CHECK (round_folder_complete = false OR pending_delta_ciphertext IS NOT NULL);


-- ══════════════════════════════════════════════════════════════════════════════
--  B. outlook_conversation_progress — per-conversation recognition state
-- ══════════════════════════════════════════════════════════════════════════════
-- One row per in-flight conversation of ONE round. It exists so that a two-sided
-- exchange whose halves arrive in different pages, different invocations, or different
-- folders is still recognised as two-sided - without which the worker would either
-- publish from a partial view or silently skip the exchange.
--
-- EVERY provider-derived value here is a keyed one-way fingerprint. Nothing in this
-- table can be used to look a message back up in the mailbox, name the person, or read
-- the subject.
CREATE TABLE IF NOT EXISTS public.outlook_conversation_progress (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id              uuid        NOT NULL,
  user_id                    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  round_id                   uuid        NOT NULL,

  -- Identity of the thread, keyed and namespaced on the connection. NOT Microsoft's
  -- conversationId.
  conversation_fingerprint   text        NOT NULL,
  -- Identity of the counterparty, keyed. Present only once an eligible message has been
  -- seen. Compared across invocations to detect a thread that changes counterparty.
  person_fingerprint         text,
  -- The dedupe key a suggestion would be written under, already computed.
  episode_fingerprint        text,
  -- The same episode under accepted PRIOR keys, so a key rotation cannot produce a
  -- second suggestion for an exchange already recorded.
  episode_lookup_fingerprints text[],
  -- Ordering tie-break for "which message was first", usable after the raw key is gone.
  first_message_fingerprint  text,
  key_version                smallint,

  contact_id                 uuid        REFERENCES public.contacts(id) ON DELETE CASCADE,

  first_seen_at              timestamptz,
  last_seen_at               timestamptz,
  inbound_count              integer     NOT NULL DEFAULT 0,
  outbound_count             integer     NOT NULL DEFAULT 0,
  message_count              integer     NOT NULL DEFAULT 0,

  -- Why this conversation can never become a suggestion in this round. Controlled set;
  -- safe to log. Once set it is never cleared: a deferral anywhere in a thread taints
  -- the whole episode.
  taint_code                 text,

  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  -- A bound on how long an abandoned round's state may sit. Superseded and expired
  -- rounds are also deleted eagerly whenever a new round touches the connection, so no
  -- scheduled sweep is required.
  expires_at                 timestamptz NOT NULL,

  CONSTRAINT ocp_conv_fp_shape   CHECK (conversation_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ocp_person_fp_shape CHECK (person_fingerprint IS NULL OR person_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ocp_episode_fp_shape CHECK (episode_fingerprint IS NULL OR episode_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ocp_first_fp_shape  CHECK (first_message_fingerprint IS NULL OR first_message_fingerprint ~ '^[0-9a-f]{64}$'),
  -- Written WITHOUT a subquery on purpose: Postgres refuses `EXISTS (SELECT ...)` inside a
  -- CHECK ("cannot use subquery in check constraint"), which an earlier draft of this file
  -- hit against a real database. array_to_string skips NULL elements, so a NULL would
  -- otherwise slip past the pattern - hence the explicit array_position guard.
  CONSTRAINT ocp_lookup_fp_shape CHECK (episode_lookup_fingerprints IS NULL
    OR (array_length(episode_lookup_fingerprints, 1) BETWEEN 1 AND 8
        AND array_position(episode_lookup_fingerprints, NULL::text) IS NULL
        AND array_to_string(episode_lookup_fingerprints, ',')
              ~ '^[0-9a-f]{64}(,[0-9a-f]{64})*$')),
  CONSTRAINT ocp_key_version_pos CHECK (key_version IS NULL OR key_version >= 1),
  CONSTRAINT ocp_counts_bounds   CHECK (inbound_count >= 0 AND outbound_count >= 0
                                        AND message_count >= 0 AND message_count <= 10000),
  CONSTRAINT ocp_taint_code_check CHECK (taint_code IS NULL OR taint_code IN (
    'ambiguous_counterparties', 'ambiguous_contact', 'automation_facts_incomplete',
    'mixed_counterparties', 'episode_truncated')),
  -- An episode fingerprint without the key version it was computed under cannot be
  -- written as a suggestion, and one without an ordering key cannot be compared.
  CONSTRAINT ocp_episode_requires_key CHECK (episode_fingerprint IS NULL
    OR (key_version IS NOT NULL AND first_message_fingerprint IS NOT NULL
        AND first_seen_at IS NOT NULL AND last_seen_at IS NOT NULL)),
  CONSTRAINT ocp_round_conv_unique UNIQUE (connection_id, round_id, conversation_fingerprint),
  CONSTRAINT ocp_conn_user_fk FOREIGN KEY (connection_id, user_id)
    REFERENCES public.microsoft_connections(id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS outlook_conversation_progress_round_idx
  ON public.outlook_conversation_progress (connection_id, round_id);
CREATE INDEX IF NOT EXISTS outlook_conversation_progress_user_idx
  ON public.outlook_conversation_progress (user_id);
CREATE INDEX IF NOT EXISTS outlook_conversation_progress_expiry_idx
  ON public.outlook_conversation_progress (expires_at);

ALTER TABLE public.outlook_conversation_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.outlook_conversation_progress FROM PUBLIC;
REVOKE ALL ON TABLE public.outlook_conversation_progress FROM anon;
REVOKE ALL ON TABLE public.outlook_conversation_progress FROM authenticated;
GRANT ALL  ON TABLE public.outlook_conversation_progress TO service_role;
-- Intentionally NO GRANT and NO POLICY for authenticated. This is worker state; a user
-- reads suggestions, never the machinery that produced them.


-- ══════════════════════════════════════════════════════════════════════════════
--  C. record_outlook_page_progress — ONE atomic checkpoint per Graph page
-- ══════════════════════════════════════════════════════════════════════════════
-- The page's conversation contributions and the page's resume position commit TOGETHER,
-- in one statement-level transaction. That is what makes a hard platform kill safe: it
-- either took the whole page or none of it, and on resume the stored nextLink is
-- strictly AFTER the last committed page, so no page is ever applied twice.
--
-- p_page_seq makes a RE-SENT call (a network retry after the commit landed) a no-op
-- rather than a double count, and a gap in the sequence an explicit refusal rather than
-- silent loss.
--
-- LEASE FENCED on BOTH folders, exactly as upsert_outlook_interaction_candidate is: a
-- run that no longer owns the connection must not be able to move its resume position.
--
-- p_conversations is an array of objects, each of which is one conversation's
-- contribution FROM THIS PAGE ONLY:
--   { "cfp": <64 hex>,            conversation fingerprint (required)
--     "pfp": <64 hex|null>,       person fingerprint
--     "efp": <64 hex|null>,       episode fingerprint for the earliest message on this page
--     "elookup": [<64 hex>, ...], the same episode under prior keys
--     "first_fp": <64 hex|null>,  fingerprint of that earliest message's provider key
--     "first_at": <timestamptz|null>,
--     "last_at": <timestamptz|null>,
--     "contact_id": <uuid|null>,
--     "key_version": <int|null>,
--     "inbound": <int>, "outbound": <int>, "messages": <int>,
--     "taint": <code|null> }
CREATE OR REPLACE FUNCTION public.record_outlook_page_progress(
  p_connection_id       uuid,
  p_run_id              uuid,
  p_folder              text,
  p_round_id            uuid,
  p_page_seq            integer,
  p_next_link_ct        text,
  p_next_link_nonce     text,
  p_pending_delta_ct    text,
  p_pending_delta_nonce text,
  p_key_version         smallint,
  p_folder_complete     boolean,
  p_messages_seen       integer,
  p_messages_dropped    integer,
  p_conversations       jsonb,
  p_round_ttl_seconds   integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Round ceilings. Bounds, not progress guarantees: a mailbox past them ends the round
  -- incomplete rather than committing a cursor it has not earned.
  c_max_pages_per_round         constant integer := 200;
  c_max_messages_per_round      constant integer := 10000;
  c_max_conversations_per_round constant integer := 2000;
  -- The same episode bound outlookParticipants.MAX_EPISODE_MESSAGES applies in memory.
  c_max_episode_messages        constant integer := 50;

  v_uid        uuid;
  v_n          integer;
  v_row        public.outlook_sync_state;
  v_ttl        integer := COALESCE(p_round_ttl_seconds, 86400);
  v_expires    timestamptz;
  v_conv       jsonb;
  v_convs      integer := 0;
  v_dropped    integer := 0;
  v_existing   public.outlook_conversation_progress;
  v_replace    boolean;
  v_taint      text;
  v_complete   boolean := COALESCE(p_folder_complete, false);
BEGIN
  IF p_folder IS NULL OR p_folder NOT IN ('inbox', 'sentitems') THEN
    RETURN jsonb_build_object('result', 'invalid_folder');
  END IF;
  IF p_run_id IS NULL OR p_round_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_round');
  END IF;
  IF p_page_seq IS NULL OR p_page_seq < 1 THEN
    RETURN jsonb_build_object('result', 'invalid_page_seq');
  END IF;
  IF v_ttl < 60 OR v_ttl > 604800 THEN
    RETURN jsonb_build_object('result', 'invalid_ttl');
  END IF;
  IF (p_next_link_ct IS NULL) <> (p_next_link_nonce IS NULL)
     OR (p_pending_delta_ct IS NULL) <> (p_pending_delta_nonce IS NULL) THEN
    RETURN jsonb_build_object('result', 'invalid_cursor_pair');
  END IF;
  -- A page either continues the stream or ends it. Both, or neither, is a caller bug
  -- and must not be written: the resume position would be ambiguous.
  IF (p_next_link_ct IS NOT NULL) = (p_pending_delta_ct IS NOT NULL) THEN
    RETURN jsonb_build_object('result', 'invalid_position');
  END IF;
  IF v_complete <> (p_pending_delta_ct IS NOT NULL) THEN
    RETURN jsonb_build_object('result', 'invalid_position');
  END IF;
  IF p_conversations IS NOT NULL AND jsonb_typeof(p_conversations) <> 'array' THEN
    RETURN jsonb_build_object('result', 'invalid_conversations');
  END IF;

  -- ── lease fence: the run must own BOTH folders ────────────────────────────
  -- Same deterministic lock order as reserve/renew/release and
  -- upsert_outlook_interaction_candidate: take the connection's sync-state rows FOR
  -- SHARE first, then check them.
  PERFORM 1 FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id FOR SHARE;

  SELECT c.user_id INTO v_uid
  FROM public.microsoft_connections c WHERE c.id = p_connection_id;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('result', 'unknown_connection');
  END IF;

  SELECT count(*) INTO v_n FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id
     AND s.sync_run_id = p_run_id
     AND s.sync_status = 'running'
     AND s.sync_lease_until > now();
  IF v_n <> 2 THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;

  -- ── round identity ────────────────────────────────────────────────────────
  -- A round spans BOTH folders, so the id is adopted on both rows at once. A row that
  -- already carries a different round id means this run is resuming state that is not
  -- its own; refuse rather than mix two rounds' accumulators.
  SELECT count(*) INTO v_n FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id
     AND s.round_id IS NOT NULL
     AND s.round_id <> p_round_id;
  IF v_n > 0 THEN
    RETURN jsonb_build_object('result', 'round_mismatch');
  END IF;

  v_expires := now() + make_interval(secs => v_ttl);

  -- Eagerly erase any superseded or expired round's state for this connection. This is
  -- what keeps the accumulator round-scoped without introducing a scheduler.
  DELETE FROM public.outlook_conversation_progress p
   WHERE p.connection_id = p_connection_id
     AND (p.round_id <> p_round_id OR p.expires_at <= now());

  UPDATE public.outlook_sync_state s
     SET round_id         = p_round_id,
         round_started_at = COALESCE(s.round_started_at, now()),
         round_expires_at = v_expires,
         updated_at       = now()
   WHERE s.connection_id = p_connection_id
     AND s.round_id IS NULL;

  SELECT s.* INTO v_row FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id AND s.folder = p_folder;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('result', 'unknown_folder_row');
  END IF;

  -- ── idempotence ───────────────────────────────────────────────────────────
  -- Already applied: the caller is retrying a call whose commit it never saw. Change
  -- nothing and say so, rather than double-counting the page.
  IF p_page_seq <= v_row.round_page_seq THEN
    RETURN jsonb_build_object(
      'result', 'duplicate_page',
      'round_pages', v_row.round_pages,
      'round_messages', v_row.round_messages);
  END IF;
  -- A gap means a page went missing between here and the caller. Refusing is the only
  -- safe answer: accepting would move the resume position past mail nobody processed.
  IF p_page_seq <> v_row.round_page_seq + 1 THEN
    RETURN jsonb_build_object('result', 'page_seq_gap',
      'expected', v_row.round_page_seq + 1);
  END IF;
  IF v_row.round_folder_complete THEN
    RETURN jsonb_build_object('result', 'folder_already_complete');
  END IF;
  IF v_row.round_pages + 1 > c_max_pages_per_round THEN
    RETURN jsonb_build_object('result', 'round_page_cap');
  END IF;
  IF v_row.round_messages + COALESCE(p_messages_seen, 0) > c_max_messages_per_round THEN
    RETURN jsonb_build_object('result', 'round_message_cap');
  END IF;

  -- ── fold this page's conversation contributions ───────────────────────────
  FOR v_conv IN SELECT * FROM jsonb_array_elements(COALESCE(p_conversations, '[]'::jsonb))
  LOOP
    IF jsonb_typeof(v_conv) <> 'object'
       OR COALESCE(v_conv->>'cfp', '') !~ '^[0-9a-f]{64}$' THEN
      RETURN jsonb_build_object('result', 'invalid_conversations');
    END IF;

    SELECT p.* INTO v_existing FROM public.outlook_conversation_progress p
     WHERE p.connection_id = p_connection_id
       AND p.round_id      = p_round_id
       AND p.conversation_fingerprint = v_conv->>'cfp';

    IF v_existing.id IS NULL THEN
      SELECT count(*) INTO v_n FROM public.outlook_conversation_progress p
       WHERE p.connection_id = p_connection_id AND p.round_id = p_round_id;
      IF v_n >= c_max_conversations_per_round THEN
        -- A whole thread discarded. Counted, never swallowed: the run must not then
        -- claim it ingested everything.
        v_dropped := v_dropped + 1;
        CONTINUE;
      END IF;

      INSERT INTO public.outlook_conversation_progress (
        connection_id, user_id, round_id, conversation_fingerprint,
        person_fingerprint, episode_fingerprint, episode_lookup_fingerprints,
        first_message_fingerprint, key_version, contact_id,
        first_seen_at, last_seen_at, inbound_count, outbound_count, message_count,
        taint_code, expires_at)
      VALUES (
        p_connection_id, v_uid, p_round_id, v_conv->>'cfp',
        NULLIF(v_conv->>'pfp', ''), NULLIF(v_conv->>'efp', ''),
        CASE WHEN jsonb_typeof(v_conv->'elookup') = 'array'
             THEN ARRAY(SELECT jsonb_array_elements_text(v_conv->'elookup')) ELSE NULL END,
        NULLIF(v_conv->>'first_fp', ''), (v_conv->>'key_version')::smallint,
        NULLIF(v_conv->>'contact_id', '')::uuid,
        (v_conv->>'first_at')::timestamptz, (v_conv->>'last_at')::timestamptz,
        COALESCE((v_conv->>'inbound')::integer, 0),
        COALESCE((v_conv->>'outbound')::integer, 0),
        COALESCE((v_conv->>'messages')::integer, 0),
        NULLIF(v_conv->>'taint', ''), v_expires);
      v_convs := v_convs + 1;
      CONTINUE;
    END IF;

    -- MERGE. Two rules do the real work:
    --   * the EARLIEST message of the whole episode owns the episode fingerprint, and
    --     "earliest" is decided on (first_seen_at, first_message_fingerprint) - an
    --     ordering pair that survives in storage, so the same set of messages yields the
    --     same fingerprint however the round was split across invocations;
    --   * a disagreement about who the conversation is with, or which contact it
    --     matches, TAINTS the episode rather than picking a side.
    v_replace := (v_conv->>'efp') IS NOT NULL AND (v_conv->>'first_at') IS NOT NULL
      AND (
        v_existing.episode_fingerprint IS NULL
        OR (v_conv->>'first_at')::timestamptz < v_existing.first_seen_at
        OR ((v_conv->>'first_at')::timestamptz = v_existing.first_seen_at
            AND COALESCE(v_conv->>'first_fp', '') < COALESCE(v_existing.first_message_fingerprint, ''))
      );

    v_taint := v_existing.taint_code;
    IF v_taint IS NULL THEN v_taint := NULLIF(v_conv->>'taint', ''); END IF;
    IF v_taint IS NULL
       AND v_existing.person_fingerprint IS NOT NULL
       AND NULLIF(v_conv->>'pfp', '') IS NOT NULL
       AND v_existing.person_fingerprint <> v_conv->>'pfp' THEN
      v_taint := 'mixed_counterparties';
    END IF;
    IF v_taint IS NULL
       AND v_existing.contact_id IS NOT NULL
       AND NULLIF(v_conv->>'contact_id', '') IS NOT NULL
       AND v_existing.contact_id <> (v_conv->>'contact_id')::uuid THEN
      v_taint := 'ambiguous_contact';
    END IF;
    IF v_taint IS NULL
       AND v_existing.message_count + COALESCE((v_conv->>'messages')::integer, 0)
           > c_max_episode_messages THEN
      -- The exchange is larger than the bound a suggestion may rest on.
      v_taint := 'episode_truncated';
    END IF;

    UPDATE public.outlook_conversation_progress p
       SET person_fingerprint = COALESCE(p.person_fingerprint, NULLIF(v_conv->>'pfp', '')),
           contact_id         = COALESCE(p.contact_id, NULLIF(v_conv->>'contact_id', '')::uuid),
           episode_fingerprint = CASE WHEN v_replace THEN v_conv->>'efp' ELSE p.episode_fingerprint END,
           episode_lookup_fingerprints = CASE
             WHEN v_replace AND jsonb_typeof(v_conv->'elookup') = 'array'
               THEN ARRAY(SELECT jsonb_array_elements_text(v_conv->'elookup'))
             WHEN v_replace THEN NULL
             ELSE p.episode_lookup_fingerprints END,
           first_message_fingerprint = CASE WHEN v_replace THEN NULLIF(v_conv->>'first_fp', '')
                                            ELSE p.first_message_fingerprint END,
           key_version = CASE WHEN v_replace THEN (v_conv->>'key_version')::smallint
                              ELSE COALESCE(p.key_version, (v_conv->>'key_version')::smallint) END,
           first_seen_at = LEAST(COALESCE(p.first_seen_at, (v_conv->>'first_at')::timestamptz),
                                 COALESCE((v_conv->>'first_at')::timestamptz, p.first_seen_at)),
           last_seen_at  = GREATEST(COALESCE(p.last_seen_at, (v_conv->>'last_at')::timestamptz),
                                    COALESCE((v_conv->>'last_at')::timestamptz, p.last_seen_at)),
           inbound_count  = p.inbound_count  + COALESCE((v_conv->>'inbound')::integer, 0),
           outbound_count = p.outbound_count + COALESCE((v_conv->>'outbound')::integer, 0),
           message_count  = LEAST(p.message_count + COALESCE((v_conv->>'messages')::integer, 0), 10000),
           taint_code     = v_taint,
           expires_at     = v_expires,
           updated_at     = now()
     WHERE p.id = v_existing.id;
    v_convs := v_convs + 1;
  END LOOP;

  -- ── the resume position, committed with the fold above ────────────────────
  UPDATE public.outlook_sync_state s
     SET round_page_seq              = p_page_seq,
         round_pages                 = s.round_pages + 1,
         round_messages              = s.round_messages + COALESCE(p_messages_seen, 0),
         round_messages_dropped      = s.round_messages_dropped + COALESCE(p_messages_dropped, 0),
         round_conversations_dropped = s.round_conversations_dropped + v_dropped,
         round_folder_complete       = v_complete,
         round_expires_at            = v_expires,
         -- Exactly one of these is non-null, enforced above and by
         -- oss_round_position_exclusive.
         next_link_ciphertext        = p_next_link_ct,
         next_link_nonce             = p_next_link_nonce,
         next_link_key_version       = CASE WHEN p_next_link_ct IS NOT NULL THEN p_key_version ELSE NULL END,
         pending_delta_ciphertext    = p_pending_delta_ct,
         pending_delta_nonce         = p_pending_delta_nonce,
         pending_delta_key_version   = CASE WHEN p_pending_delta_ct IS NOT NULL THEN p_key_version ELSE NULL END,
         last_attempt_at             = now(),
         updated_at                  = now()
   WHERE s.connection_id = p_connection_id
     AND s.folder        = p_folder
     AND s.sync_run_id   = p_run_id
     AND s.sync_status   = 'running'
     AND s.sync_lease_until > now();

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    -- The lease went between the fence and here. Raising rolls the whole call back,
    -- including the fold, so nothing is half-applied.
    RAISE EXCEPTION 'lease_lost_during_checkpoint';
  END IF;

  RETURN jsonb_build_object(
    'result', 'recorded',
    'round_pages', v_row.round_pages + 1,
    'round_messages', v_row.round_messages + COALESCE(p_messages_seen, 0),
    'conversations_written', v_convs,
    'conversations_dropped', v_dropped);
END;
$$;

REVOKE ALL ON FUNCTION public.record_outlook_page_progress(
  uuid, uuid, text, uuid, integer, text, text, text, text, smallint, boolean,
  integer, integer, jsonb, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_outlook_page_progress(
  uuid, uuid, text, uuid, integer, text, text, text, text, smallint, boolean,
  integer, integer, jsonb, integer
) TO service_role;


-- ══════════════════════════════════════════════════════════════════════════════
--  D. read_outlook_round_progress — what a resuming invocation needs to know
-- ══════════════════════════════════════════════════════════════════════════════
-- Returns the round's per-folder position INCLUDING the encrypted nextLink and pending
-- deltaLink ciphertexts, so the worker can decrypt them with the key it already holds.
-- Lease fenced: only the owning run may read a resume position.
CREATE OR REPLACE FUNCTION public.read_outlook_round_progress(
  p_connection_id uuid,
  p_run_id        uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n     integer;
  v_out   jsonb;
BEGIN
  IF p_run_id IS NULL THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;

  PERFORM 1 FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id FOR SHARE;

  SELECT count(*) INTO v_n FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id
     AND s.sync_run_id = p_run_id
     AND s.sync_status = 'running'
     AND s.sync_lease_until > now();
  IF v_n <> 2 THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;

  -- An expired round is reported as no round at all, so a resuming worker starts a
  -- fresh one from the committed cursor instead of resuming state it should not trust.
  SELECT jsonb_object_agg(s.folder, jsonb_build_object(
           'round_id', CASE WHEN s.round_expires_at > now() THEN s.round_id ELSE NULL END,
           'page_seq', CASE WHEN s.round_expires_at > now() THEN s.round_page_seq ELSE 0 END,
           'pages', CASE WHEN s.round_expires_at > now() THEN s.round_pages ELSE 0 END,
           'messages', CASE WHEN s.round_expires_at > now() THEN s.round_messages ELSE 0 END,
           'messages_dropped', CASE WHEN s.round_expires_at > now() THEN s.round_messages_dropped ELSE 0 END,
           'conversations_dropped', CASE WHEN s.round_expires_at > now() THEN s.round_conversations_dropped ELSE 0 END,
           'folder_complete', CASE WHEN s.round_expires_at > now() THEN s.round_folder_complete ELSE false END,
           'write_cursor', CASE WHEN s.round_expires_at > now() THEN s.round_write_cursor ELSE NULL END,
           'next_link_ciphertext', CASE WHEN s.round_expires_at > now() THEN s.next_link_ciphertext ELSE NULL END,
           'next_link_nonce', CASE WHEN s.round_expires_at > now() THEN s.next_link_nonce ELSE NULL END,
           'next_link_key_version', CASE WHEN s.round_expires_at > now() THEN s.next_link_key_version ELSE NULL END,
           'pending_delta_ciphertext', CASE WHEN s.round_expires_at > now() THEN s.pending_delta_ciphertext ELSE NULL END,
           'pending_delta_nonce', CASE WHEN s.round_expires_at > now() THEN s.pending_delta_nonce ELSE NULL END,
           'pending_delta_key_version', CASE WHEN s.round_expires_at > now() THEN s.pending_delta_key_version ELSE NULL END))
    INTO v_out
  FROM public.outlook_sync_state s
  WHERE s.connection_id = p_connection_id;

  RETURN jsonb_build_object('result', 'ok', 'folders', COALESCE(v_out, '{}'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.read_outlook_round_progress(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_outlook_round_progress(uuid, uuid) TO service_role;


-- ══════════════════════════════════════════════════════════════════════════════
--  E. list_outlook_round_conversations — the accumulator, ONE PAGE at a time
-- ══════════════════════════════════════════════════════════════════════════════
-- Read back the round's conversation records so the worker can turn the complete ones
-- into suggestions. Lease fenced. Returns fingerprints and counts only - there is
-- nothing else in the table to return.
--
-- IT MUST BE PAGED, and the number is measured rather than guessed. A row serialises to
-- about 602 bytes at its widest realistic shape (every fingerprint present and a lookup
-- array carrying two keys, as a key rotation in flight would), so the whole-round ceiling
-- of 2000 rows is about 1.18 MiB - four and a half times the 256 KiB the worker's
-- database port allows any JSON response to be. Reproduced through the deployed port:
-- asking for the whole round is refused outright, while a page of 200 is 118 KiB.
--
-- `more_rows` says whether anything is left AFTER this page. It means CONTINUE, not
-- `this round is incomplete`: the caller walks the pages with p_after and only commits
-- once a page comes back with more_rows false. The whole-round ceiling of 2000 is
-- unchanged and still enforced in record_outlook_page_progress.
--
-- `round_truncated_episodes` is a WHOLE-ROUND aggregate, deliberately not a per-page one.
-- A conversation whose exchange exceeded the episode bound was shortened, so no cursor
-- from this round may be stored - and that stays true however many pages later the
-- caller reaches the end. Counting it per page would let a round commit past work it
-- discarded on an earlier page, which is exactly the regression this field exists to
-- prevent.
-- p_after is the FINALISATION RESUME POINT: only conversations ordered strictly after it
-- are returned. The worker passes the round's stored write cursor, so a finalisation that
-- spanned invocations continues instead of restarting.
CREATE OR REPLACE FUNCTION public.list_outlook_round_conversations(
  p_connection_id uuid,
  p_run_id        uuid,
  p_round_id      uuid,
  p_limit         integer,
  p_after         text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n         integer;
  -- Capped at the measured safe page size, not at the round ceiling: a caller asking for
  -- more than fits would get a response its own port refuses to read.
  v_limit     integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 200);
  v_rows      jsonb;
  v_truncated integer;
BEGIN
  IF p_run_id IS NULL OR p_round_id IS NULL THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;

  PERFORM 1 FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id FOR SHARE;

  SELECT count(*) INTO v_n FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id
     AND s.sync_run_id = p_run_id
     AND s.sync_status = 'running'
     AND s.sync_lease_until > now();
  IF v_n <> 2 THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;

  -- The whole round, before any paging is applied.
  SELECT count(*) INTO v_truncated
  FROM public.outlook_conversation_progress p
   WHERE p.connection_id = p_connection_id
     AND p.round_id      = p_round_id
     AND p.expires_at    > now()
     AND p.taint_code    = 'episode_truncated';

  SELECT jsonb_agg(jsonb_build_object(
           'cfp', q.conversation_fingerprint,
           'pfp', q.person_fingerprint,
           'efp', q.episode_fingerprint,
           'elookup', q.episode_lookup_fingerprints,
           'contact_id', q.contact_id,
           'key_version', q.key_version,
           'first_at', q.first_seen_at,
           'last_at', q.last_seen_at,
           'inbound', q.inbound_count,
           'outbound', q.outbound_count,
           'messages', q.message_count,
           'taint', q.taint_code) ORDER BY q.conversation_fingerprint)
    INTO v_rows
  FROM (
    SELECT * FROM public.outlook_conversation_progress p
     WHERE p.connection_id = p_connection_id
       AND p.round_id      = p_round_id
       AND p.expires_at    > now()
       AND (p_after IS NULL OR p.conversation_fingerprint > p_after)
     ORDER BY p.conversation_fingerprint
     LIMIT v_limit + 1
  ) q;

  RETURN jsonb_build_object(
    'result', 'ok',
    -- CONTINUE, not `incomplete`: one more row than the page size was fetched purely to
    -- answer this, and it is not returned.
    'more_rows', COALESCE(jsonb_array_length(v_rows), 0) > v_limit,
    -- WHOLE-ROUND, independent of this page. A shortened exchange anywhere in the round
    -- forfeits every cursor of it.
    'round_truncated_episodes', v_truncated,
    'conversations', COALESCE(
      (SELECT jsonb_agg(e) FROM (
         SELECT e FROM jsonb_array_elements(COALESCE(v_rows, '[]'::jsonb)) e
          LIMIT v_limit) q),
      '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.list_outlook_round_conversations(uuid, uuid, uuid, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_outlook_round_conversations(uuid, uuid, uuid, integer, text)
  TO service_role;


-- ══════════════════════════════════════════════════════════════════════════════
--  E2. advance_outlook_round_write_cursor — finalisation survives an invocation
-- ══════════════════════════════════════════════════════════════════════════════
-- Records how far the suggestion-writing stage got, so it resumes instead of restarting.
--
-- WHY THIS IS NEEDED, reproduced before it existed: a round with 40 qualifying
-- conversations spends 40 bounded RPC round trips writing them - 800s against a 120s
-- invocation budget. A hard platform stop after 6 left 6 valid pending suggestions, the
-- round saved, both cursors correctly NULL, and NO record of those 6. The next invocation
-- found the round complete, re-listed all 40, and began again at the first entry - so a
-- batch larger than one invocation could never finish, forever.
--
-- MONOTONE, and that matters: it only ever moves forward. A late or duplicated call with
-- an older fingerprint cannot rewind finalisation and cause rows to be written twice.
-- Rewriting is harmless anyway (the candidate upsert answers 'refreshed'), but a cursor
-- that could go backwards would make "how far did we get" unanswerable.
--
-- It is set on BOTH folder rows, because finalisation belongs to the round rather than to
-- either folder, and both rows already carry the round id.
CREATE OR REPLACE FUNCTION public.advance_outlook_round_write_cursor(
  p_connection_id uuid,
  p_run_id        uuid,
  p_round_id      uuid,
  p_after         text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_run_id IS NULL OR p_round_id IS NULL THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;
  IF p_after IS NULL OR p_after !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'invalid_cursor');
  END IF;

  PERFORM 1 FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id FOR SHARE;

  SELECT count(*) INTO v_n FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id
     AND s.sync_run_id = p_run_id
     AND s.sync_status = 'running'
     AND s.sync_lease_until > now();
  IF v_n <> 2 THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;

  SELECT count(*) INTO v_n FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id AND s.round_id = p_round_id;
  IF v_n <> 2 THEN
    RETURN jsonb_build_object('result', 'round_mismatch');
  END IF;

  UPDATE public.outlook_sync_state s
     SET round_write_cursor = GREATEST(COALESCE(s.round_write_cursor, ''), p_after),
         updated_at         = now()
   WHERE s.connection_id = p_connection_id
     AND s.round_id       = p_round_id
     AND s.sync_run_id    = p_run_id
     AND s.sync_status    = 'running'
     AND s.sync_lease_until > now();

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'lease_lost_during_write_cursor';
  END IF;

  RETURN jsonb_build_object(
    'result', 'advanced',
    'write_cursor', (SELECT s.round_write_cursor FROM public.outlook_sync_state s
                      WHERE s.connection_id = p_connection_id AND s.folder = 'inbox'));
END;
$$;

REVOKE ALL ON FUNCTION public.advance_outlook_round_write_cursor(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_outlook_round_write_cursor(uuid, uuid, uuid, text)
  TO service_role;


-- ══════════════════════════════════════════════════════════════════════════════
--  F. reset_outlook_round — the controlled restart
-- ══════════════════════════════════════════════════════════════════════════════
-- For when Microsoft rejects a SAVED nextLink (expired, or its state invalidated).
-- Discards the round: the saved nextLink, both pending deltaLinks, the counters and the
-- accumulator rows.
--
-- IT DOES NOT TOUCH THE COMMITTED CURSOR. That is the point. The committed deltaLink
-- still marks a position that genuinely was ingested, so the next round restarts from
-- there - not from the beginning of the mailbox, and without skipping anything. Losing
-- the round costs re-reading the pages it had read, which the suggestion dedupe makes
-- harmless.
CREATE OR REPLACE FUNCTION public.reset_outlook_round(
  p_connection_id uuid,
  p_run_id        uuid,
  p_reason        text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n       integer;
  v_deleted integer;
BEGIN
  IF p_run_id IS NULL THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;
  IF p_reason IS NOT NULL AND char_length(p_reason) > 100 THEN
    RETURN jsonb_build_object('result', 'invalid_reason');
  END IF;

  PERFORM 1 FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id FOR SHARE;

  SELECT count(*) INTO v_n FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id
     AND s.sync_run_id = p_run_id
     AND s.sync_status = 'running'
     AND s.sync_lease_until > now();
  IF v_n <> 2 THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;

  DELETE FROM public.outlook_conversation_progress p
   WHERE p.connection_id = p_connection_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  UPDATE public.outlook_sync_state s
     SET round_id                    = NULL,
         round_started_at            = NULL,
         round_expires_at            = NULL,
         round_pages                 = 0,
         round_messages              = 0,
         round_page_seq              = 0,
         round_messages_dropped      = 0,
         round_conversations_dropped = 0,
         round_folder_complete       = false,
         round_write_cursor          = NULL,
         next_link_ciphertext        = NULL,
         next_link_nonce             = NULL,
         next_link_key_version       = NULL,
         pending_delta_ciphertext    = NULL,
         pending_delta_nonce         = NULL,
         pending_delta_key_version   = NULL,
         last_error_code             = COALESCE(p_reason, s.last_error_code),
         updated_at                  = now()
   WHERE s.connection_id = p_connection_id
     AND s.sync_run_id   = p_run_id
     AND s.sync_status   = 'running';

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'lease_lost_during_reset';
  END IF;

  RETURN jsonb_build_object('result', 'reset', 'conversations_deleted', v_deleted);
END;
$$;

REVOKE ALL ON FUNCTION public.reset_outlook_round(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_outlook_round(uuid, uuid, text) TO service_role;


-- ══════════════════════════════════════════════════════════════════════════════
--  G. release_outlook_sync_lease — erase the round when, and only when, it commits
-- ══════════════════════════════════════════════════════════════════════════════
-- SAME SIGNATURE, so this is a CREATE OR REPLACE and no caller changes. The cursor
-- logic is byte-for-byte the one from 20260921000000; what is added is the round
-- bookkeeping:
--
--   * a COMPLETE run clears the round - the committed cursor has just absorbed the
--     pending one, so every scrap of round state is now either redundant or wrong;
--   * an INCOMPLETE run leaves the round exactly as it is. That is the whole mechanism:
--     'continued' is an incomplete release, and the next invocation resumes from the
--     position this one saved.
--
-- The accumulator rows are deleted in the same transaction as the cursor advance, so a
-- committed round can never leave state behind that a later round would mistake for its
-- own - and the round id guard in record_outlook_page_progress would refuse it anyway.
CREATE OR REPLACE FUNCTION public.release_outlook_sync_lease(
  p_connection_id          uuid,
  p_run_id                 uuid,
  p_status                 text,
  p_error_code             text,
  p_run_complete           boolean,
  p_inbox_delta_ct         text,
  p_inbox_delta_nonce      text,
  p_sentitems_delta_ct     text,
  p_sentitems_delta_nonce  text,
  p_delta_key_version      smallint,
  p_initial_done           boolean,
  p_retry_backoff_seconds  integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n        integer;
  v_complete boolean := COALESCE(p_run_complete, false);
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('idle', 'error') THEN
    RAISE EXCEPTION 'invalid_release_status';
  END IF;
  IF p_error_code IS NOT NULL AND char_length(p_error_code) > 100 THEN
    RAISE EXCEPTION 'invalid_error_code';
  END IF;
  IF p_retry_backoff_seconds IS NOT NULL AND (p_retry_backoff_seconds < 0 OR p_retry_backoff_seconds > 604800) THEN
    RAISE EXCEPTION 'invalid_backoff';
  END IF;
  IF (p_inbox_delta_ct IS NULL) <> (p_inbox_delta_nonce IS NULL)
     OR (p_sentitems_delta_ct IS NULL) <> (p_sentitems_delta_nonce IS NULL) THEN
    RAISE EXCEPTION 'invalid_delta_pair';
  END IF;
  IF p_run_id IS NULL THEN RETURN false; END IF;

  UPDATE public.outlook_sync_state s
    SET sync_status       = p_status,
        sync_lease_until  = NULL,
        sync_run_id       = NULL,
        run_started_at    = NULL,
        last_attempt_at   = now(),
        last_success_at   = CASE WHEN p_status = 'idle' AND v_complete THEN now() ELSE s.last_success_at END,
        last_run_complete = v_complete,
        -- Cursor advances ONLY on a complete run with a supplied ciphertext for this folder.
        delta_link_ciphertext = CASE
          WHEN v_complete AND s.folder = 'inbox'     AND p_inbox_delta_ct     IS NOT NULL THEN p_inbox_delta_ct
          WHEN v_complete AND s.folder = 'sentitems' AND p_sentitems_delta_ct IS NOT NULL THEN p_sentitems_delta_ct
          ELSE s.delta_link_ciphertext END,
        delta_link_nonce = CASE
          WHEN v_complete AND s.folder = 'inbox'     AND p_inbox_delta_ct     IS NOT NULL THEN p_inbox_delta_nonce
          WHEN v_complete AND s.folder = 'sentitems' AND p_sentitems_delta_ct IS NOT NULL THEN p_sentitems_delta_nonce
          ELSE s.delta_link_nonce END,
        delta_key_version = CASE
          WHEN v_complete AND ((s.folder = 'inbox' AND p_inbox_delta_ct IS NOT NULL)
                            OR (s.folder = 'sentitems' AND p_sentitems_delta_ct IS NOT NULL))
          THEN COALESCE(p_delta_key_version, s.delta_key_version) ELSE s.delta_key_version END,
        initial_import_done = CASE WHEN v_complete AND COALESCE(p_initial_done, false) THEN true ELSE s.initial_import_done END,
        last_error_code   = CASE WHEN p_status = 'error' THEN p_error_code ELSE NULL END,
        retry_count       = CASE WHEN p_status = 'error' OR NOT v_complete THEN s.retry_count + 1 ELSE 0 END,
        next_retry_at     = CASE WHEN (p_status = 'error' OR NOT v_complete) AND p_retry_backoff_seconds IS NOT NULL
                                 THEN now() + make_interval(secs => p_retry_backoff_seconds) ELSE NULL END,
        -- ── round bookkeeping, new in 20261002000000 ────────────────────────
        -- Cleared on a complete run, preserved otherwise. Preserving it is what lets a
        -- later invocation resume; clearing it is what stops a committed round being
        -- resumed a second time.
        round_id                    = CASE WHEN v_complete THEN NULL ELSE s.round_id END,
        round_started_at            = CASE WHEN v_complete THEN NULL ELSE s.round_started_at END,
        round_expires_at            = CASE WHEN v_complete THEN NULL ELSE s.round_expires_at END,
        round_pages                 = CASE WHEN v_complete THEN 0 ELSE s.round_pages END,
        round_messages              = CASE WHEN v_complete THEN 0 ELSE s.round_messages END,
        round_page_seq              = CASE WHEN v_complete THEN 0 ELSE s.round_page_seq END,
        round_messages_dropped      = CASE WHEN v_complete THEN 0 ELSE s.round_messages_dropped END,
        round_conversations_dropped = CASE WHEN v_complete THEN 0 ELSE s.round_conversations_dropped END,
        round_folder_complete       = CASE WHEN v_complete THEN false ELSE s.round_folder_complete END,
        round_write_cursor          = CASE WHEN v_complete THEN NULL ELSE s.round_write_cursor END,
        next_link_ciphertext        = CASE WHEN v_complete THEN NULL ELSE s.next_link_ciphertext END,
        next_link_nonce             = CASE WHEN v_complete THEN NULL ELSE s.next_link_nonce END,
        next_link_key_version       = CASE WHEN v_complete THEN NULL ELSE s.next_link_key_version END,
        pending_delta_ciphertext    = CASE WHEN v_complete THEN NULL ELSE s.pending_delta_ciphertext END,
        pending_delta_nonce         = CASE WHEN v_complete THEN NULL ELSE s.pending_delta_nonce END,
        pending_delta_key_version   = CASE WHEN v_complete THEN NULL ELSE s.pending_delta_key_version END,
        updated_at        = now()
  WHERE s.connection_id = p_connection_id
    AND s.sync_run_id   = p_run_id
    AND s.sync_status   = 'running';

  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- Only a confirmed, complete release erases the accumulator. A release that did not
  -- match both rows changed nothing above and must change nothing here either.
  IF v_n = 2 AND v_complete THEN
    DELETE FROM public.outlook_conversation_progress p
     WHERE p.connection_id = p_connection_id;
  END IF;

  RETURN v_n = 2;
END;
$$;

REVOKE ALL ON FUNCTION public.release_outlook_sync_lease(
  uuid, uuid, text, text, boolean, text, text, text, text, smallint, boolean, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_outlook_sync_lease(
  uuid, uuid, text, text, boolean, text, text, text, text, smallint, boolean, integer
) TO service_role;
