-- Outlook content slice, step 1 - RETRIEVING THE SELECTED MESSAGES AT ROUND
-- FINALIZATION. Corrected after review; see "WHAT CHANGED" below.
--
-- NOT APPLIED. Reviewed as part of a Draft PR.
--
-- ============================================================================
-- THE PROBLEM
-- ============================================================================
-- A summary can only be drafted once BOTH folders have qualified an exchange,
-- which may span pages, invocations and hours. But outlook_conversation_progress
-- deliberately persists "no header, no subject, no mailbox address, no display
-- name, and NO Microsoft message or conversation id" - so at finalize time there
-- was nothing to fetch a body WITH.
--
-- THE MINIMUM INFORMATION. To re-read a message later, exactly one thing is
-- required: its Graph id. Subject, participants and body all come back with the
-- fetch and are discarded after the draft is built, so none is persisted. The
-- only new stored category is a bounded set of ENCRYPTED message ids.
--
-- WHY IMMUTABLE IDS. Graph ids are not stable by default - "their IDs change ...
-- only if the item is moved" - so an id recorded on page 1 can be dead by
-- finalization. The documented opt-in is the per-request header
-- `Prefer: IdType="ImmutableId"`, after which an id "won't change so long as the
-- item stays in the same mailbox". Critically for an existing connection: "The
-- @odata.nextLink and @odata.deltaLink values returned by delta queries are
-- compatible with both ID formats, so your application doesn't need to
-- re-synchronize" - the committed cursors survive. Immutable ids still change on
-- an archive-mailbox move or an export/re-import; those surface as a failed
-- fetch, which DEFERS the conversation rather than guessing. Ids are
-- case-sensitive and are never normalized.
--
-- ============================================================================
-- WHAT CHANGED IN THIS REVISION, and what was wrong before
-- ============================================================================
-- Three defects were reproduced against a real Postgres and are fixed here.
--
-- 1. HANDLES WERE ORPHANED BY EVERY ROUND-LIFECYCLE DELETE. The only foreign key
--    was (connection_id, user_id) -> microsoft_connections, so handles died on
--    DISCONNECT and on account deletion but survived round completion, reset,
--    supersede and takeover. Measured: erasing the accumulator left 6 orphan
--    handles behind.
--
--    FIXED by a narrow cascading foreign key to the parent accumulator row,
--    (connection_id, round_id, conversation_fingerprint). That triple was NOT a
--    key - outlook_conversation_progress had only non-unique indexes on it, with
--    uniqueness enforced by the merge logic - so a UNIQUE INDEX is added first.
--    It fits the write order: the conversation merge loop runs BEFORE the handle
--    loop in the same function, so the parent always exists.
--
--    The parent itself cascades from microsoft_connections(id, user_id) and from
--    auth.users, so ONE key now covers all six paths: complete release, reset,
--    supersede, takeover, disconnect and account deletion.
--
--    WHAT IT DOES NOT COVER, stated plainly: reaching the 24-hour round deadline
--    deletes NOTHING. An expired round is refused rather than erased, exactly as
--    read_outlook_round_progress already behaves, and nothing is scheduled to
--    sweep it. An abandoned connection's handles therefore persist until the next
--    run supersedes the round, a reset runs, or the account disconnects. The
--    disclosure draft says this in those words.
--
-- 2. THE SELECTION WAS "THE FIRST SIX SEEN", AND SILENT. The cap was justified
--    by the episode taint, but that taint fires above MAX_EPISODE_MESSAGES = 50,
--    so a 7-message exchange was never tainted and silently lost its LATEST
--    reply while the page reported `recorded`. Measured: 7 messages in, handles
--    1-6 kept, message 7 - the latest - dropped, taint NULL.
--
--    Separately, reaching the 4000-per-round ceiling EXITed the loop and still
--    returned `recorded`, committing a cursor for a conversation whose handle had
--    been thrown away. Measured: retained=0, result=recorded. Malformed handles
--    were skipped the same silent way.
--
--    FIXED three ways: a DELIBERATE selection (reserve 2 per folder, fill by
--    recency, so the latest reply is always kept and a two-sided exchange stays
--    two-sided); the round ceiling now REFUSES the page
--    (`handle_budget_exhausted`) so no cursor is committed; and a malformed or
--    parentless handle refuses the page too (`invalid_handle`, `orphan_handle`)
--    instead of being dropped.
--
-- 3. THE HANDLE RESPONSE DID NOT FIT THE PORT. With the maximum permitted
--    ciphertext the read returned 649,679 bytes against the port's 256 KiB body
--    bound - 2.5x over. Measured, not estimated.
--
--    FIXED by tightening the ciphertext ceiling from 4000 to 1024 characters (a
--    Graph immutable entry id is a few hundred characters; its AES-GCM ciphertext
--    base64-encodes to a few hundred more, so 1024 is still generous), capping
--    the response at 20 handles, and adding a keyset continuation cursor so the
--    caller can page through a conversation set and make progress.
--
-- ============================================================================
-- HOW THE HANDLES ARE PROTECTED
-- ============================================================================
--   * ENCRYPTED AT REST with the same AES-GCM key ring as the delta cursors. The
--     plaintext id never reaches this table, a log, or any read path other than
--     the worker holding the key.
--   * The DEDUPE KEY is a keyed HMAC message fingerprint, not the id, so
--     idempotence needs nothing reversible.
--   * NO BODY, NO SUBJECT, NO ADDRESS, NO NAME.
--   * BOUNDED: 6 per conversation after selection, 4000 per round (enforced by
--     refusal), 1024 characters of ciphertext, 20 handles per response.
--   * SERVICE ROLE ONLY, RLS enabled, every other role revoked.
--
-- VERIFY AFTER APPLYING:
--   SELECT p.pronargs FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--    WHERE n.nspname='public' AND p.proname='record_outlook_page_progress';
--   -- expect exactly ONE row, 16
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid='public.outlook_round_messages'::regclass AND contype='f';
--   -- expect a FK to outlook_conversation_progress ON DELETE CASCADE


-- ============================================================================
-- 1. The parent key the handles hang from.
-- ============================================================================
-- outlook_conversation_progress has only NON-UNIQUE indexes on this triple;
-- uniqueness is enforced by record_outlook_page_progress's select-then-merge,
-- which is safe because the lease fence admits one run per connection. A foreign
-- key needs a real unique constraint, so one is added here. It also hardens the
-- invariant the merge logic already relies on.
CREATE UNIQUE INDEX IF NOT EXISTS outlook_conversation_progress_round_conv_uidx
  ON public.outlook_conversation_progress
     (connection_id, round_id, conversation_fingerprint);


-- ============================================================================
-- 2. The table the protected handles live in.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.outlook_round_messages (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id           uuid        NOT NULL,
  user_id                 uuid        NOT NULL,
  round_id                uuid        NOT NULL,
  conversation_fingerprint text       NOT NULL,
  -- The DEDUPE key: a keyed HMAC of the provider message key, already computed by
  -- the fold. Deterministic, which an AES-GCM ciphertext can never be.
  message_fingerprint     text        NOT NULL,
  folder                  text        NOT NULL,
  -- NOT NULL: the selection orders by it, so a missing timestamp would make the
  -- choice of which six to keep non-deterministic.
  sent_at                 timestamptz NOT NULL,
  -- The IMMUTABLE Graph id, encrypted. Never stored or logged in plaintext.
  message_id_ciphertext   text        NOT NULL,
  message_id_nonce        text        NOT NULL,
  key_version             smallint    NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT orm_conv_fp_shape CHECK (conversation_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT orm_msg_fp_shape  CHECK (message_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT orm_folder_check  CHECK (folder IN ('inbox', 'sentitems')),
  CONSTRAINT orm_key_version_pos CHECK (key_version >= 1),
  -- 1024, not 4000. A Graph immutable entry id is a few hundred characters and
  -- its base64 ciphertext a few hundred more. The old ceiling made a full
  -- response 2.5x the port's body bound.
  CONSTRAINT orm_ct_bounds    CHECK (char_length(message_id_ciphertext) BETWEEN 1 AND 1024),
  CONSTRAINT orm_nonce_bounds CHECK (char_length(message_id_nonce) BETWEEN 1 AND 64),
  -- THE ROUND-LIFECYCLE CASCADE. Deleting the parent accumulator row - which is
  -- what complete release, reset, supersede and takeover all do - removes the
  -- handles with it. The parent in turn cascades from microsoft_connections and
  -- from auth.users, so disconnect and account deletion are covered too.
  CONSTRAINT orm_round_conv_fk FOREIGN KEY (connection_id, round_id, conversation_fingerprint)
    REFERENCES public.outlook_conversation_progress
               (connection_id, round_id, conversation_fingerprint) ON DELETE CASCADE,
  -- Kept as well, so connection_id/user_id integrity is explicit rather than
  -- only transitive.
  CONSTRAINT orm_conn_user_fk FOREIGN KEY (connection_id, user_id)
    REFERENCES public.microsoft_connections(id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS outlook_round_messages_dedupe_uidx
  ON public.outlook_round_messages (connection_id, round_id, message_fingerprint);
-- The finalize-time read and the selection both order by this.
CREATE INDEX IF NOT EXISTS outlook_round_messages_round_conv_idx
  ON public.outlook_round_messages
     (connection_id, round_id, conversation_fingerprint, sent_at DESC, message_fingerprint DESC);
CREATE INDEX IF NOT EXISTS outlook_round_messages_user_idx
  ON public.outlook_round_messages (user_id);

ALTER TABLE public.outlook_round_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.outlook_round_messages FROM PUBLIC;
REVOKE ALL ON TABLE public.outlook_round_messages FROM anon;
REVOKE ALL ON TABLE public.outlook_round_messages FROM authenticated;
GRANT ALL  ON TABLE public.outlook_round_messages TO service_role;


-- ============================================================================
-- 3. record_outlook_page_progress, extended to commit the handles atomically.
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
  -- NEW. The PROTECTED message handles this page contributed, committed in the
  -- SAME transaction as the page's fold and its resume position.
  --
  -- WHY THIS CALL AND NOT A SECOND ONE. A committed page is never re-read. Ids
  -- written by a separate RPC could be lost to a kill between the two, leaving
  -- the page durably recorded with its handles missing - and that conversation
  -- could then never be summarized. Sharing this transaction makes the handles
  -- exactly as durable as the page.
  --
  -- Each element:
  --   { "cfp": <64 hex>, "mfp": <64 hex>, "mid_ct": <text>, "mid_nonce": <text>,
  --     "key_version": <int>, "folder": "inbox"|"sentitems",
  --     "sent_at": <timestamptz> }
  --
  -- NO PLAINTEXT ID, NO SUBJECT, NO ADDRESS, NO BODY.
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
  v_evicted  integer := 0;
  v_msg_rows integer;
  v_cfps     text[] := ARRAY[]::text[];
  v_cfp      text;
  v_keep     uuid[];
  v_reserved integer;
  -- Round ceilings. Bounds, not progress guarantees: a mailbox past them ends the round
  -- incomplete rather than committing a cursor it has not earned.
  c_max_pages_per_round         constant integer := 200;
  c_max_messages_per_round      constant integer := 10000;
  c_max_conversations_per_round constant integer := 2000;
  -- THE SELECTION SIZE. Six handles per conversation is what one summary is
  -- built from. It is NOT MAX_EPISODE_MESSAGES (50): that is the point at which
  -- an episode is declared truncated and the round forfeits its cursors. A
  -- 7-to-50-message exchange is perfectly valid and is summarized from a
  -- DELIBERATE selection of six - see the eviction below.
  c_handles_per_conv            constant integer := 6;
  -- Reserved slots per folder, so a two-sided exchange is always representable
  -- from the selection even when one side dominates by volume.
  c_handles_reserved_per_folder constant integer := 2;
  -- The whole-round ceiling. Reaching it REFUSES the page rather than dropping
  -- handles, so no cursor is ever committed for a conversation whose handles
  -- were discarded.
  c_max_handle_rows_per_round   constant integer := 4000;
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
  -- EVERY HANDLE IS VALIDATED UP FRONT, and a single bad one REFUSES THE PAGE.
  --
  -- *BEFORE ANY WRITE*, and that placement is the whole point. A plpgsql RETURN
  -- does NOT roll back what the function has already done, so a refusal issued
  -- after the resume position had been written left the cursor committed anyway -
  -- exactly the silent loss this is meant to prevent. Measured: the budget
  -- refusal returned `handle_budget_exhausted` while next_link_ciphertext had
  -- already been set. Every check below therefore runs before the page touches
  -- outlook_sync_state.
  --
  -- WHY A REFUSAL AND NOT A SKIP. Skipping silently was the defect: the page was
  -- recorded, the cursor advanced, and the conversation lost the handle it needed
  -- - so it could never be summarized and nothing said so. A refusal leaves the
  -- resume position where it was, so the page is re-read. A handle this malformed
  -- is a bug in our own producer, not a provider quirk, and it is bounded by the
  -- run's own retry/backoff ceiling.
  FOR v_msg IN SELECT * FROM jsonb_array_elements(COALESCE(p_messages, '[]'::jsonb))
  LOOP
    IF jsonb_typeof(v_msg) <> 'object'
       OR COALESCE(v_msg->>'cfp', '') !~ '^[0-9a-f]{64}$'
       OR COALESCE(v_msg->>'mfp', '') !~ '^[0-9a-f]{64}$'
       OR COALESCE(v_msg->>'mid_ct', '') = ''
       OR char_length(v_msg->>'mid_ct') > 1024
       OR COALESCE(v_msg->>'mid_nonce', '') = ''
       OR char_length(v_msg->>'mid_nonce') > 64
       OR COALESCE(v_msg->>'folder', '') NOT IN ('inbox', 'sentitems')
       OR (v_msg->>'sent_at') IS NULL THEN
      RETURN jsonb_build_object('result', 'invalid_handle');
    END IF;
    -- THE PARENT MUST BE IN THIS PAGE. The foreign key needs the accumulator row
    -- to exist, and the only rows guaranteed to exist after the merge are the
    -- ones this page declared. Checking against p_conversations rather than the
    -- table keeps the check up front, before anything is written, and makes it
    -- order independent.
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(p_conversations, '[]'::jsonb)) AS c
       WHERE c->>'cfp' = v_msg->>'cfp') THEN
      RETURN jsonb_build_object('result', 'orphan_handle');
    END IF;
  END LOOP;

  -- THE WHOLE-ROUND CEILING, also before any write. Over it the page is REFUSED:
  -- recording a page whose handles were dropped would commit a cursor for mail
  -- that can never be summarized.
  IF jsonb_array_length(COALESCE(p_messages, '[]'::jsonb)) > 0 THEN
    SELECT count(*) INTO v_msg_rows
      FROM public.outlook_round_messages m
     WHERE m.connection_id = p_connection_id AND m.round_id = p_round_id;
    IF v_msg_rows + jsonb_array_length(p_messages) > c_max_handle_rows_per_round THEN
      RETURN jsonb_build_object('result', 'handle_budget_exhausted',
                                'round_handles', v_msg_rows);
    END IF;
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

  -- ══ the protected message handles for this page ═══════════════════════════
  -- Written AFTER the conversation merge, so the parent row the foreign key
  -- points at already exists for every cfp in this page.
  IF jsonb_array_length(COALESCE(p_messages, '[]'::jsonb)) > 0 THEN
    -- Validation, the parent check and the round ceiling all ran BEFORE the page
    -- was written, so from here on only the inserts and the selection remain.
    FOR v_msg IN SELECT * FROM jsonb_array_elements(p_messages)
    LOOP
      -- ON CONFLICT DO NOTHING on the message fingerprint keeps this IDEMPOTENT:
      -- a page whose checkpoint was REFUSED is re-read, and re-offering the same
      -- message must not duplicate it or fail the call.
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
      IF NOT (v_msg->>'cfp' = ANY (v_cfps)) THEN
        v_cfps := pg_catalog.array_append(v_cfps, v_msg->>'cfp');
      END IF;
    END LOOP;

    -- ══ THE DELIBERATE SELECTION ════════════════════════════════════════════
    -- Six handles represent one conversation, and WHICH six is chosen on purpose:
    --
    --   1. RESERVE up to 2 from EACH folder, most recent first. Inbox is the
    --      counterparty's side and Sent Items is the account's, so this
    --      guarantees a two-sided exchange is still two-sided in the selection
    --      even when one side sent far more.
    --   2. FILL the remaining slots by overall recency.
    --
    -- THE LATEST REPLY IS ALWAYS KEPT: the newest message in the conversation is
    -- necessarily the newest in its own folder, so it is always in the reserved
    -- set. That was the concrete defect in the previous version - it kept the
    -- FIRST six it happened to see, so a 7-message exchange lost its latest
    -- reply and nothing reported it.
    --
    -- Ordering is (sent_at DESC, message_fingerprint DESC): the fingerprint
    -- breaks ties deterministically, so the same set of messages yields the same
    -- selection however the round was split across pages and invocations.
    FOREACH v_cfp IN ARRAY v_cfps
    LOOP
      SELECT count(*) INTO v_msg_rows
        FROM public.outlook_round_messages m
       WHERE m.connection_id = p_connection_id AND m.round_id = p_round_id
         AND m.conversation_fingerprint = v_cfp;
      CONTINUE WHEN v_msg_rows <= c_handles_per_conv;

      WITH ranked AS (
        SELECT m.id, m.folder,
               row_number() OVER (PARTITION BY m.folder
                 ORDER BY m.sent_at DESC, m.message_fingerprint DESC) AS rn_folder,
               row_number() OVER (
                 ORDER BY m.sent_at DESC, m.message_fingerprint DESC) AS rn_all
          FROM public.outlook_round_messages m
         WHERE m.connection_id = p_connection_id AND m.round_id = p_round_id
           AND m.conversation_fingerprint = v_cfp
      ),
      reserved AS (
        SELECT id, rn_all FROM ranked WHERE rn_folder <= c_handles_reserved_per_folder
      ),
      filler AS (
        SELECT id FROM ranked
         WHERE rn_folder > c_handles_reserved_per_folder
         ORDER BY rn_all
         LIMIT GREATEST(c_handles_per_conv - (SELECT count(*) FROM reserved), 0)
      )
      SELECT pg_catalog.array_agg(id) INTO v_keep
        FROM (SELECT id FROM reserved UNION SELECT id FROM filler) k;

      DELETE FROM public.outlook_round_messages m
       WHERE m.connection_id = p_connection_id AND m.round_id = p_round_id
         AND m.conversation_fingerprint = v_cfp
         AND NOT (m.id = ANY (COALESCE(v_keep, ARRAY[]::uuid[])));
      v_evicted := v_evicted + v_msg_rows
                 - pg_catalog.array_length(COALESCE(v_keep, ARRAY[]::uuid[]), 1);
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'result', 'recorded',
    -- How many handles were offered, and how many the selection evicted. The
    -- caller logs both; a non-zero eviction is a DELIBERATE selection, not a
    -- loss, and the content stage reports "the N most recent of M messages"
    -- using the conversation's own message_count.
    'handles_offered', v_msgs,
    'handles_evicted', COALESCE(v_evicted, 0),
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
-- 4. The bounded, PAGED finalize-time read.
-- ============================================================================
-- SEPARATE from list_outlook_round_conversations on purpose. That call is already
-- paged at 200 conversations against a 256 KiB body bound; attaching a kilobyte
-- of ciphertext to each row would push it far over.
--
-- BOUNDED AND PAGED. At most 20 handles per response, with a keyset continuation
-- cursor on (conversation_fingerprint, sent_at DESC, message_fingerprint DESC) -
-- the same order the selection uses - so the caller can walk a conversation set
-- and always make progress. 20 x (1024 ciphertext + 64 nonce + ~150 of keys,
-- fingerprints and timestamps) is about 25 KB, an order of magnitude inside the
-- bound; the test measures it with maximum-length values rather than assuming.
--
-- LEASE FENCED like every other round RPC, and ROUND EXPIRY IS HONOURED: an
-- expired round's handles are refused, not returned, so a stale handle cannot be
-- used to fetch mail for a round whose suggestion is about to be discarded.

CREATE FUNCTION public.list_outlook_round_message_handles(
  p_connection_id uuid,
  p_run_id        uuid,
  p_round_id      uuid,
  p_cfps          text[],
  p_limit         integer DEFAULT 20,
  -- Keyset continuation, from a previous response's next_cursor. All three or none.
  p_after_cfp     text    DEFAULT NULL,
  p_after_sent_at timestamptz DEFAULT NULL,
  p_after_mfp     text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_max_handles constant integer := 20;
  v_uid        uuid;
  v_leaseok    boolean;
  v_round_ends timestamptz;
  v_limit      integer;
  v_rows       jsonb;
  v_last       jsonb;
BEGIN
  IF p_connection_id IS NULL OR p_run_id IS NULL OR p_round_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_arguments');
  END IF;
  IF p_cfps IS NULL OR pg_catalog.array_length(p_cfps, 1) IS NULL THEN
    RETURN jsonb_build_object('result', 'ok', 'handles', '[]'::jsonb, 'next_cursor', NULL);
  END IF;
  -- A bounded batch of conversations, so the response size is bounded twice over.
  IF pg_catalog.array_length(p_cfps, 1) > 25 THEN
    RETURN jsonb_build_object('result', 'too_many_conversations');
  END IF;
  PERFORM 1 FROM pg_catalog.unnest(p_cfps) f WHERE f !~ '^[0-9a-f]{64}$';
  IF FOUND THEN
    RETURN jsonb_build_object('result', 'invalid_fingerprint');
  END IF;
  IF (p_after_cfp IS NULL) <> (p_after_mfp IS NULL)
     OR (p_after_cfp IS NULL) <> (p_after_sent_at IS NULL) THEN
    RETURN jsonb_build_object('result', 'invalid_cursor');
  END IF;
  IF p_after_cfp IS NOT NULL AND (p_after_cfp !~ '^[0-9a-f]{64}$'
                                  OR p_after_mfp !~ '^[0-9a-f]{64}$') THEN
    RETURN jsonb_build_object('result', 'invalid_cursor');
  END IF;
  v_limit := LEAST(GREATEST(COALESCE(p_limit, c_max_handles), 1), c_max_handles);

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

  -- The round's own deadline, mirroring list_outlook_round_conversations exactly:
  -- min(round_expires_at) across BOTH folder rows for THIS round, NULL treated as
  -- expired.
  SELECT min(s.round_expires_at) INTO v_round_ends
  FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id AND s.round_id = p_round_id;
  IF v_round_ends IS NULL OR v_round_ends <= now() THEN
    RETURN jsonb_build_object('result', 'round_expired');
  END IF;

  -- ONE statement, no temp table. An earlier draft used a TEMP TABLE with
  -- ON COMMIT DROP, which persists for the whole TRANSACTION - so a second call
  -- in the same transaction logged "relation _orm_page already exists" and
  -- depended on an explicit DELETE for correctness. A CTE has none of that
  -- state.
  WITH page AS (
    SELECT m.conversation_fingerprint AS cfp, m.message_fingerprint AS mfp,
           m.folder, m.sent_at, m.message_id_ciphertext AS mid_ct,
           m.message_id_nonce AS mid_nonce, m.key_version
      FROM public.outlook_round_messages m
     WHERE m.connection_id = p_connection_id
       AND m.round_id = p_round_id
       AND m.user_id = v_uid
       AND m.conversation_fingerprint = ANY (p_cfps)
       AND (p_after_cfp IS NULL
            OR (m.conversation_fingerprint, m.sent_at, m.message_fingerprint)
               > (p_after_cfp, p_after_sent_at, p_after_mfp))
     ORDER BY m.conversation_fingerprint, m.sent_at, m.message_fingerprint
     LIMIT v_limit
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'cfp', cfp, 'mfp', mfp, 'folder', folder, 'sent_at', sent_at,
           'mid_ct', mid_ct, 'mid_nonce', mid_nonce, 'key_version', key_version)
           ORDER BY cfp, sent_at, mfp), '[]'::jsonb),
         -- The LAST row of this page, in the SAME order, which is the keyset the
         -- next call resumes after.
         (SELECT jsonb_build_object('cfp', cfp, 'sent_at', sent_at, 'mfp', mfp)
            FROM page ORDER BY cfp DESC, sent_at DESC, mfp DESC LIMIT 1)
    INTO v_rows, v_last
  FROM page;

  RETURN jsonb_build_object(
    'result', 'ok',
    'handles', v_rows,
    -- Present ONLY when the page was filled, so the caller stops without an
    -- extra empty round trip.
    'next_cursor', CASE
      WHEN jsonb_array_length(v_rows) < v_limit THEN NULL ELSE v_last
    END);
END;
$$;

REVOKE ALL ON FUNCTION public.list_outlook_round_message_handles(
  uuid, uuid, uuid, text[], integer, text, timestamptz, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_outlook_round_message_handles(
  uuid, uuid, uuid, text[], integer, text, timestamptz, text
) TO service_role;
