-- Outlook content slice, step 1 of the real path - RETRIEVING THE SELECTED
-- MESSAGES AT ROUND FINALIZATION.
--
-- NOT APPLIED. Reviewed as part of a Draft PR.
--
-- ============================================================================
-- THE PROBLEM THIS SOLVES
-- ============================================================================
-- Suggestions are written at ROUND FINALIZE time. Two-sidedness is only knowable
-- from counts accumulated across pages, invocations AND both folders, so the
-- decision to summarize an exchange cannot be taken while a page is in hand.
-- But outlook_conversation_progress deliberately persists "no header, no
-- subject, no mailbox address, no display name, and NO Microsoft message or
-- conversation id" - so at finalize time there was nothing to fetch a body WITH.
--
-- ============================================================================
-- THE MINIMUM INFORMATION NEEDED, and why it is this and nothing more
-- ============================================================================
-- To re-read a message later, exactly one thing is required: its Graph id. Not
-- the subject, not the participants, not the body - all of those come back with
-- the fetch at finalize time and are discarded after the draft is built. So the
-- only thing this migration persists is a bounded, encrypted set of message ids.
--
-- WHY *IMMUTABLE* IDS. Microsoft Graph ids for Outlook items are NOT stable by
-- default: "their IDs change ... only if the item is moved". A round can span
-- invocations and hours, and the user can move mail in that window, so a default
-- id stored on page 1 can be dead by finalization. The documented fix is the
-- per-request header
--
--     Prefer: IdType="ImmutableId"
--
-- after which "an item's immutable ID won't change so long as the item stays in
-- the same mailbox ... immutable ID will NOT change if the item is moved to a
-- different folder in the mailbox." It still changes if the user moves the item
-- to an ARCHIVE mailbox or exports and re-imports it - those are real, bounded
-- failure modes, and they surface as a failed fetch, which DEFERS the
-- conversation rather than guessing.
--
-- CRITICALLY FOR CONTINUATION: "The @odata.nextLink and @odata.deltaLink values
-- returned by delta queries are compatible with both ID formats, so your
-- application doesn't need to re-synchronize." Adding the header therefore does
-- NOT invalidate the committed cursors this pilot already has.
--
-- IDS ARE CASE-SENSITIVE ("like all identifiers in Microsoft Graph"), so nothing
-- here lowercases or normalizes them. They are stored as ciphertext anyway.
--
-- ============================================================================
-- HOW THEY ARE PROTECTED
-- ============================================================================
--   * ENCRYPTED AT REST with the same AES-GCM key ring as the delta cursors.
--     The plaintext id never reaches this table, a log, or any read path other
--     than the worker holding the key.
--   * The DEDUPE KEY is a keyed HMAC message fingerprint, not the id - so the
--     table can be made idempotent without storing anything reversible.
--   * NO BODY, NO SUBJECT, NO ADDRESS. Nothing in this table describes what a
--     message said or who it was with.
--   * BOUNDED: at most 6 handles per conversation (mirroring
--     MAX_EPISODE_MESSAGES) and 4000 per round.
--   * SERVICE ROLE ONLY, RLS enabled, every other role revoked - the same shape
--     as outlook_conversation_progress.
--   * DIES WITH THE ROUND: keyed on round_id, so reset_outlook_round and the
--     round-expiry sweep remove it, and it cascades on connection delete
--     (disconnect) and on user delete.
--
-- ============================================================================
-- WHAT THIS DOES NOT CHANGE
-- ============================================================================
-- No existing table, column, constraint, index, policy or grant. The extended
-- function is the applied body COPIED VERBATIM plus one defaulted parameter, one
-- validation and one insert loop: the round ceilings, the two merge rules, the
-- lease fence, the resume position and the refusal codes are untouched, and the
-- previous 15-argument call shape still behaves identically.
--
-- VERIFY AFTER APPLYING:
--   SELECT p.pronargs FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--    WHERE n.nspname='public' AND p.proname='record_outlook_page_progress';
--   -- expect exactly ONE row, 16
--   SELECT has_table_privilege('authenticated','public.outlook_round_messages','SELECT');
--   -- expect false


-- ============================================================================
-- 1. The table the protected handles live in.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.outlook_round_messages (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id           uuid        NOT NULL,
  user_id                 uuid        NOT NULL,
  round_id                uuid        NOT NULL,
  conversation_fingerprint text       NOT NULL,
  -- The DEDUPE key: a keyed HMAC of the provider message key, already computed by
  -- the fold. Deterministic, so a re-read page cannot duplicate a row - which an
  -- AES-GCM ciphertext could never be, since its nonce is random per call.
  message_fingerprint     text        NOT NULL,
  folder                  text        NOT NULL,
  sent_at                 timestamptz,
  -- The IMMUTABLE Graph id, encrypted. Never stored or logged in plaintext.
  message_id_ciphertext   text        NOT NULL,
  message_id_nonce        text        NOT NULL,
  key_version             smallint    NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT orm_conv_fp_shape CHECK (conversation_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT orm_msg_fp_shape  CHECK (message_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT orm_folder_check  CHECK (folder IN ('inbox', 'sentitems')),
  CONSTRAINT orm_key_version_pos CHECK (key_version >= 1),
  -- A Graph immutable entry id is a few hundred characters; the ciphertext of one
  -- is larger again. 4000 is a generous ceiling that still refuses anything that
  -- is not a message id.
  CONSTRAINT orm_ct_bounds    CHECK (char_length(message_id_ciphertext) BETWEEN 1 AND 4000),
  CONSTRAINT orm_nonce_bounds CHECK (char_length(message_id_nonce) BETWEEN 1 AND 64),
  -- DISCONNECT AND ACCOUNT DELETION both reach this row by cascade, through the
  -- same composite key the other Outlook tables use.
  CONSTRAINT orm_conn_user_fk FOREIGN KEY (connection_id, user_id)
    REFERENCES public.microsoft_connections(id, user_id) ON DELETE CASCADE
);

-- IDEMPOTENCE. A refused checkpoint means the page is re-read; re-recording the
-- same message must not duplicate it.
CREATE UNIQUE INDEX IF NOT EXISTS outlook_round_messages_dedupe_uidx
  ON public.outlook_round_messages (connection_id, round_id, message_fingerprint);
-- The finalize-time read: by round and conversation.
CREATE INDEX IF NOT EXISTS outlook_round_messages_round_conv_idx
  ON public.outlook_round_messages (connection_id, round_id, conversation_fingerprint);
CREATE INDEX IF NOT EXISTS outlook_round_messages_user_idx
  ON public.outlook_round_messages (user_id);

ALTER TABLE public.outlook_round_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.outlook_round_messages FROM PUBLIC;
REVOKE ALL ON TABLE public.outlook_round_messages FROM anon;
REVOKE ALL ON TABLE public.outlook_round_messages FROM authenticated;
GRANT ALL  ON TABLE public.outlook_round_messages TO service_role;


-- ============================================================================
-- 2. record_outlook_page_progress, extended to commit the handles atomically.
-- ============================================================================
-- DROP AND CREATE, not CREATE OR REPLACE: a parameter is being added, and
-- CREATE OR REPLACE cannot change a signature - it would leave a second overload
-- and make every 15-argument call ambiguous. A dropped function loses its ACL, so
-- the REVOKE/GRANT pair is restated below.

DROP FUNCTION IF EXISTS public.record_outlook_page_progress(
  uuid, uuid, text, uuid, integer, text, text, text, text, smallint, boolean,
  integer, integer, jsonb, integer);

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
  p_round_ttl_seconds   integer,
  -- NEW, and the whole point of this migration. The PROTECTED message handles for
  -- the messages this page contributed, committed in the SAME transaction as the
  -- page's fold and its resume position.
  --
  -- WHY IT MUST BE THIS CALL and not a second one. A committed page is never
  -- re-read. If the ids were written by a separate RPC and the instance died
  -- between the two, the page would be durably recorded with its ids missing, and
  -- the conversation could never be summarized - it would defer for ever. Sharing
  -- this transaction makes the ids exactly as durable as the page itself.
  --
  -- Each element:
  --   { "cfp": <64 hex>,        conversation this message belongs to
  --     "mfp": <64 hex>,        message fingerprint - the DEDUPE key, see below
  --     "mid_ct": <text>,       AES-GCM ciphertext of the IMMUTABLE Graph id
  --     "mid_nonce": <text>,
  --     "key_version": <int>,
  --     "folder": "inbox"|"sentitems",
  --     "sent_at": <timestamptz|null> }
  --
  -- NO PLAINTEXT ID, NO SUBJECT, NO ADDRESS AND NO BODY. The id is the only thing
  -- retained, it is encrypted with the same key ring as the delta cursors, and the
  -- fingerprint is a keyed HMAC - so this table cannot be used to read anybody's
  -- mail without the key, and cannot be reversed to an address.
  p_messages            jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_msg      jsonb;
  v_msgs     integer := 0;
  v_msg_rows integer;
  -- Round ceilings. Bounds, not progress guarantees: a mailbox past them ends the round
  -- incomplete rather than committing a cursor it has not earned.
  c_max_pages_per_round         constant integer := 200;
  c_max_messages_per_round      constant integer := 10000;
  c_max_conversations_per_round constant integer := 2000;
  -- The per-conversation retention cap for message handles. It mirrors
  -- outlookParticipants.MAX_EPISODE_MESSAGES, which is also what taints a
  -- conversation 'episode_truncated' when the exchange is longer - so an episode
  -- that overflows this cap has already forfeited the round's cursors.
  c_max_messages_per_conv       constant integer := 6;
  -- A whole-round ceiling, so one pathological mailbox cannot grow this table
  -- without bound even while every conversation stays under its own cap.
  c_max_message_rows_per_round  constant integer := 4000;
  -- The same episode bound outlookParticipants.MAX_EPISODE_MESSAGES applies in memory.
  c_max_episode_messages        constant integer := 50;

  v_uid        uuid;
  v_n          integer;
  v_row        public.outlook_sync_state;
  -- Read at ADOPTION only. Later pages never extend a round's deadline.
  v_ttl        integer := COALESCE(p_round_ttl_seconds, 86400);
  v_expires    timestamptz;
  v_round_ends timestamptz;
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
  IF p_messages IS NOT NULL AND jsonb_typeof(p_messages) <> 'array' THEN
    RETURN jsonb_build_object('result', 'invalid_messages');
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

  -- ── round identity and the round's ONE deadline ───────────────────────────
  -- A round spans BOTH folders, so the id and the deadline are adopted on both rows at
  -- once. min() decides expiry, so if the two rows ever disagreed the earlier deadline
  -- governs - failing towards `expired` rather than towards half a round.
  SELECT min(s.round_expires_at) INTO v_round_ends
  FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id AND s.round_id IS NOT NULL;

  -- A DIFFERENT round is already here. If it has expired, discard it AS A UNIT and take
  -- over; if it is still live, refuse rather than mix two rounds' accumulators.
  SELECT count(*) INTO v_n FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id
     AND s.round_id IS NOT NULL
     AND s.round_id <> p_round_id;
  IF v_n > 0 THEN
    IF v_round_ends IS NULL OR v_round_ends > now() THEN
      RETURN jsonb_build_object('result', 'round_mismatch');
    END IF;
    -- EXPIRED, so it is discarded whole: both folder rows' round state and every one of
    -- its conversation records. This is what unsticks the case where the read reported no
    -- round, the worker chose a new id, and every page was then refused forever. The
    -- COMMITTED cursor is deliberately untouched, so the new round re-reads from a
    -- position that was genuinely ingested and skips nothing.
    DELETE FROM public.outlook_conversation_progress p
     WHERE p.connection_id = p_connection_id;
    UPDATE public.outlook_sync_state s
       SET round_id = NULL, round_started_at = NULL, round_expires_at = NULL,
           round_pages = 0, round_messages = 0, round_page_seq = 0,
           round_messages_dropped = 0, round_conversations_dropped = 0,
           round_folder_complete = false, round_write_cursor = NULL,
           next_link_ciphertext = NULL, next_link_nonce = NULL,
           next_link_key_version = NULL, pending_delta_ciphertext = NULL,
           pending_delta_nonce = NULL, pending_delta_key_version = NULL,
           updated_at = now()
     WHERE s.connection_id = p_connection_id;
    v_round_ends := NULL;
  END IF;

  -- THE CURRENT round has expired: refuse. A dead round must not be extended by a new
  -- page, and nothing from it may be committed - the caller resets it and starts again.
  IF v_round_ends IS NOT NULL AND v_round_ends <= now() THEN
    RETURN jsonb_build_object('result', 'round_expired');
  END IF;

  -- Fixed at adoption, and NEVER extended afterwards. Extending it per page is what let
  -- a round outlive the records it depended on.
  v_expires := COALESCE(v_round_ends, now() + make_interval(secs => v_ttl));

  -- Eagerly erase any superseded round's state for this connection. This is what keeps
  -- the accumulator round-scoped without introducing a scheduler. Records of the CURRENT
  -- round are never touched here: they expire with their round, as a unit.
  DELETE FROM public.outlook_conversation_progress p
   WHERE p.connection_id = p_connection_id
     AND p.round_id <> p_round_id;

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
        taint_code)
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
        NULLIF(v_conv->>'taint', ''));
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
         -- NOT round_expires_at: the round's deadline is fixed at adoption.
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

  -- ── the protected message handles for this page ──────────────────────────
  -- Inserted last, so every conversation they reference has already been merged.
  -- ON CONFLICT DO NOTHING on the message fingerprint makes this IDEMPOTENT: a
  -- page whose checkpoint was REFUSED is re-read, and re-recording the same
  -- messages must not duplicate them or fail the call.
  FOR v_msg IN SELECT * FROM jsonb_array_elements(COALESCE(p_messages, '[]'::jsonb))
  LOOP
    CONTINUE WHEN jsonb_typeof(v_msg) <> 'object';
    CONTINUE WHEN COALESCE(v_msg->>'cfp', '') !~ '^[0-9a-f]{64}$';
    CONTINUE WHEN COALESCE(v_msg->>'mfp', '') !~ '^[0-9a-f]{64}$';
    CONTINUE WHEN COALESCE(v_msg->>'mid_ct', '') = '';
    CONTINUE WHEN COALESCE(v_msg->>'mid_nonce', '') = '';
    CONTINUE WHEN COALESCE(v_msg->>'folder', '') NOT IN ('inbox', 'sentitems');

    -- THE WHOLE-ROUND CEILING, checked before the per-conversation one so a
    -- pathological mailbox stops growing the table at a known point.
    SELECT count(*) INTO v_msg_rows
      FROM public.outlook_round_messages m
     WHERE m.connection_id = p_connection_id AND m.round_id = p_round_id;
    EXIT WHEN v_msg_rows >= c_max_message_rows_per_round;

    -- THE PER-CONVERSATION CAP. Keeping the first ones seen is deliberate and is
    -- safe because an exchange longer than this is ALREADY tainted
    -- 'episode_truncated' by the fold, which forfeits every cursor of the round -
    -- so a capped conversation is never summarized from a partial view.
    SELECT count(*) INTO v_msg_rows
      FROM public.outlook_round_messages m
     WHERE m.connection_id = p_connection_id AND m.round_id = p_round_id
       AND m.conversation_fingerprint = v_msg->>'cfp';
    CONTINUE WHEN v_msg_rows >= c_max_messages_per_conv;

    INSERT INTO public.outlook_round_messages (
      connection_id, user_id, round_id, conversation_fingerprint,
      message_fingerprint, folder, sent_at,
      message_id_ciphertext, message_id_nonce, key_version)
    VALUES (
      p_connection_id, v_uid, p_round_id, v_msg->>'cfp',
      v_msg->>'mfp', v_msg->>'folder', (v_msg->>'sent_at')::timestamptz,
      v_msg->>'mid_ct', v_msg->>'mid_nonce',
      COALESCE((v_msg->>'key_version')::smallint, p_key_version))
    ON CONFLICT (connection_id, round_id, message_fingerprint) DO NOTHING;
    v_msgs := v_msgs + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'result', 'recorded',
    'messages_retained', v_msgs,
    'round_pages', v_row.round_pages + 1,
    'round_messages', v_row.round_messages + COALESCE(p_messages_seen, 0),
    'conversations_written', v_convs,
    'conversations_dropped', v_dropped);
END;
$$;

REVOKE ALL ON FUNCTION public.record_outlook_page_progress(
  uuid, uuid, text, uuid, integer, text, text, text, text, smallint, boolean,
  integer, integer, jsonb, integer, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_outlook_page_progress(
  uuid, uuid, text, uuid, integer, text, text, text, text, smallint, boolean,
  integer, integer, jsonb, integer, jsonb
) TO service_role;


-- ============================================================================
-- 3. The bounded finalize-time read.
-- ============================================================================
-- SEPARATE from list_outlook_round_conversations on purpose. That call is already
-- paged at 200 conversations against a 256 KiB port bound; attaching several
-- hundred-character ciphertexts to each row would push it over. This reads
-- handles for a SMALL batch of conversations instead, so the two payloads are
-- bounded independently.
--
-- LEASE FENCED like every other round RPC: a run that no longer owns the
-- connection cannot read the handles of a round it is no longer working on.
--
-- ROUND EXPIRY IS HONOURED HERE. An expired round's handles are not returned -
-- the caller gets 'round_expired' and must discard the round, exactly as
-- read_outlook_round_progress already does. That is what stops a stale handle
-- from being used to fetch mail the round no longer has a suggestion behind.

CREATE FUNCTION public.list_outlook_round_message_handles(
  p_connection_id uuid,
  p_run_id        uuid,
  p_round_id      uuid,
  p_cfps          text[],
  p_limit         integer DEFAULT 150
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid     uuid;
  v_leaseok boolean;
  v_round_ends timestamptz;
  v_limit   integer;
  v_rows    jsonb;
BEGIN
  IF p_connection_id IS NULL OR p_run_id IS NULL OR p_round_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_arguments');
  END IF;
  IF p_cfps IS NULL OR pg_catalog.array_length(p_cfps, 1) IS NULL THEN
    RETURN jsonb_build_object('result', 'ok', 'handles', '[]'::jsonb);
  END IF;
  -- A bounded batch of conversations, so the response size is bounded too.
  IF pg_catalog.array_length(p_cfps, 1) > 25 THEN
    RETURN jsonb_build_object('result', 'too_many_conversations');
  END IF;
  PERFORM 1 FROM pg_catalog.unnest(p_cfps) f WHERE f !~ '^[0-9a-f]{64}$';
  IF FOUND THEN
    RETURN jsonb_build_object('result', 'invalid_fingerprint');
  END IF;
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 150), 1), 150);

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

  -- THE ROUND'S OWN DEADLINE, mirroring list_outlook_round_conversations exactly:
  -- min(round_expires_at) across BOTH folder rows for THIS round, and a NULL is
  -- treated as expired. An expired round forfeits its handles along with
  -- everything else - returning them would let a body be fetched for a round whose
  -- suggestion is about to be discarded.
  SELECT min(s.round_expires_at) INTO v_round_ends
  FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id AND s.round_id = p_round_id;
  IF v_round_ends IS NULL OR v_round_ends <= now() THEN
    RETURN jsonb_build_object('result', 'round_expired');
  END IF;

  SELECT COALESCE(jsonb_agg(r ORDER BY r->>'cfp', r->>'sent_at', r->>'mfp'), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT jsonb_build_object(
             'cfp', m.conversation_fingerprint,
             'mfp', m.message_fingerprint,
             'folder', m.folder,
             'sent_at', m.sent_at,
             'mid_ct', m.message_id_ciphertext,
             'mid_nonce', m.message_id_nonce,
             'key_version', m.key_version) AS r
      FROM public.outlook_round_messages m
     WHERE m.connection_id = p_connection_id
       AND m.round_id = p_round_id
       AND m.user_id = v_uid
       AND m.conversation_fingerprint = ANY (p_cfps)
     ORDER BY m.conversation_fingerprint, m.sent_at NULLS LAST, m.message_fingerprint
     LIMIT v_limit
  ) s;

  RETURN jsonb_build_object('result', 'ok', 'handles', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.list_outlook_round_message_handles(
  uuid, uuid, uuid, text[], integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_outlook_round_message_handles(
  uuid, uuid, uuid, text[], integer
) TO service_role;
