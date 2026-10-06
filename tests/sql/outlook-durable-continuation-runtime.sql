-- Runtime verification for migration 20261002000000_outlook_durable_continuation.sql
--
-- HOW TO BUILD THE DATABASE THIS NEEDS: tests/sql/_bootstrap-disposable-db.sql
--
-- WHAT THIS PROVES, AND WHAT IT DOES NOT.
-- It runs as the PRIVILEGED `postgres` role, so it proves the function BODIES: the
-- two-folder lease fence, the round identity guard, page-sequence idempotence, the merge
-- rules, the pending-versus-committed cursor separation, and the restart. It does NOT
-- prove that a real request is switched to `service_role` or that a user is refused
-- EXECUTE - a privileged role bypasses exactly those checks. Those are covered over real
-- HTTP by tests/local/outlook-worker-token-access.mjs.
--
-- THIS IS NOT A BROWSER-TO-DATABASE END-TO-END TEST. There is no JWT, no PostgREST, no
-- Kong and no browser in this file.
--
-- THE CENTRAL CASES:
--   * a checkpoint moves the RESUME position and NEVER the committed cursor;
--   * re-sending a page is a no-op, and a GAP is refused;
--   * the merge keeps the EARLIEST message's episode fingerprint, whichever page it
--     arrived on, and taints rather than guessing when a thread disagrees with itself;
--   * only a COMPLETE release promotes the pending cursor and erases the round;
--   * a reset discards the round and KEEPS the committed cursor.

DO $$
DECLARE
  u1      uuid := '11111111-1111-1111-1111-111111111111';
  conn    uuid;
  c1      uuid;
  run1    uuid;
  run2    uuid;
  round1  uuid := '00000000-0000-0000-0000-0000000000a1';
  round2  uuid := '00000000-0000-0000-0000-0000000000a2';
  v       jsonb;
  cfp     text := repeat('a', 64);
  pfp     text := repeat('b', 64);
  efp_mid text := repeat('c', 64);
  efp_1st text := repeat('d', 64);
  mfp_mid text := repeat('e', 64);
  mfp_1st text := repeat('f', 64);
  committed_ct text;
  i       integer;
  round3  uuid := '00000000-0000-0000-0000-0000000000a3';
  early_cfp text := repeat('a', 62) || 'cd';
  round_ends timestamptz;
  -- Deliberately ordered AFTER cfp: the resume filter is `> cursor`, so a fingerprint
  -- that sorted before it would be skipped and prove nothing. ('2' < 'a' - the first
  -- attempt at this fixture got that wrong and the filter correctly returned nothing.)
  cfp2    text := repeat('a', 63) || 'b';
BEGIN
  -- ── fixtures ──────────────────────────────────────────────────────────────
  DELETE FROM public.outlook_conversation_progress WHERE user_id = u1;
  DELETE FROM public.interaction_candidates WHERE user_id = u1;
  DELETE FROM public.contacts WHERE user_id = u1;
  DELETE FROM public.microsoft_connections WHERE user_id = u1;

  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, consented_at, consent_policy_version)
  VALUES (u1, 'acct-1', 'consumers', 'personal', 'u1@example.test',
          ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(), 'v1')
  RETURNING id INTO conn;

  INSERT INTO public.contacts (user_id, name, email)
  VALUES (u1, 'Ava', 'ava@bank.test') RETURNING id INTO c1;

  v := public.reserve_due_outlook_connection(600, 900);
  ASSERT v ->> 'result' = 'reserved', 'reservation failed: ' || v::text;
  run1 := (v ->> 'run_id')::uuid;

  -- Give the connection a committed cursor to protect, as a second round would have.
  UPDATE public.outlook_sync_state
     SET delta_link_ciphertext = 'COMMITTED-' || folder,
         delta_link_nonce = 'NONCE'
   WHERE connection_id = conn;

  -- ── 1. a first checkpoint: the resume position moves, the cursor does not ──
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round1, 1,
         'NEXT-1', 'N1', NULL, NULL, 1::smallint, false, 40, 0,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp, 'pfp', pfp, 'efp', efp_mid, 'elookup', jsonb_build_array(efp_mid),
           'first_fp', mfp_mid, 'first_at', '2026-09-21T09:00:00Z',
           'last_at', '2026-09-21T09:00:00Z', 'contact_id', c1::text,
           'key_version', 1, 'inbound', 0, 'outbound', 1, 'messages', 1, 'taint', NULL)),
         86400);
  ASSERT v ->> 'result' = 'recorded', 'first checkpoint refused: ' || v::text;
  ASSERT (v ->> 'round_pages')::int = 1, v::text;

  ASSERT (SELECT next_link_ciphertext = 'NEXT-1' AND pending_delta_ciphertext IS NULL
                 AND round_page_seq = 1 AND round_messages = 40
                 AND round_id = round1 AND round_folder_complete = false
          FROM public.outlook_sync_state WHERE connection_id = conn AND folder = 'inbox'),
         'the resume position was not stored as expected';
  ASSERT (SELECT delta_link_ciphertext = 'COMMITTED-inbox'
          FROM public.outlook_sync_state WHERE connection_id = conn AND folder = 'inbox'),
         'A CHECKPOINT MUST NEVER TOUCH THE COMMITTED CURSOR';
  -- The round id is adopted on BOTH folders, because a round spans both.
  ASSERT (SELECT count(*) FROM public.outlook_sync_state
           WHERE connection_id = conn AND round_id = round1) = 2,
         'the round id must be adopted on both folder rows';

  -- ── 2. IDEMPOTENCE: the same page again changes nothing ────────────────────
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round1, 1,
         'NEXT-1', 'N1', NULL, NULL, 1::smallint, false, 40, 0, '[]'::jsonb, 86400);
  ASSERT v ->> 'result' = 'duplicate_page', 'a re-sent page must be a no-op: ' || v::text;
  ASSERT (SELECT round_pages = 1 AND round_messages = 40
          FROM public.outlook_sync_state WHERE connection_id = conn AND folder = 'inbox'),
         'a duplicate page must not be counted twice';
  ASSERT (SELECT inbound_count = 0 AND outbound_count = 1 AND message_count = 1
          FROM public.outlook_conversation_progress
          WHERE connection_id = conn AND conversation_fingerprint = cfp),
         'a duplicate page must not double-count a conversation';

  -- ── 3. A GAP is refused, not silently accepted ────────────────────────────
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round1, 3,
         'NEXT-3', 'N3', NULL, NULL, 1::smallint, false, 10, 0, '[]'::jsonb, 86400);
  ASSERT v ->> 'result' = 'page_seq_gap', 'a missing page must be refused: ' || v::text;
  ASSERT (v ->> 'expected')::int = 2, v::text;

  -- ── 4. THE MERGE: an EARLIER message arriving on a LATER page wins ─────────
  -- This is the case durable continuation exists for. Page 2 carries the message that
  -- actually opened the thread, and the other half of the exchange, so the episode
  -- fingerprint must be recomputed from the earlier message and the conversation must
  -- become two-sided.
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round1, 2,
         'NEXT-2', 'N2', NULL, NULL, 1::smallint, false, 30, 0,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp, 'pfp', pfp, 'efp', efp_1st, 'elookup', jsonb_build_array(efp_1st),
           'first_fp', mfp_1st, 'first_at', '2026-09-20T14:00:00Z',
           'last_at', '2026-09-20T14:00:00Z', 'contact_id', c1::text,
           'key_version', 1, 'inbound', 1, 'outbound', 0, 'messages', 1, 'taint', NULL)),
         86400);
  ASSERT v ->> 'result' = 'recorded', v::text;

  ASSERT (SELECT episode_fingerprint = efp_1st AND first_message_fingerprint = mfp_1st
                 AND first_seen_at = '2026-09-20T14:00:00Z'::timestamptz
                 AND last_seen_at = '2026-09-21T09:00:00Z'::timestamptz
                 AND inbound_count = 1 AND outbound_count = 1 AND message_count = 2
                 AND taint_code IS NULL
          FROM public.outlook_conversation_progress
          WHERE connection_id = conn AND conversation_fingerprint = cfp),
         'the EARLIEST message must own the episode fingerprint, whenever it arrived';

  -- ── 5. A thread that changes counterparty is TAINTED, not guessed at ──────
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round1, 3,
         'NEXT-3', 'N3', NULL, NULL, 1::smallint, false, 5, 0,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp, 'pfp', repeat('7', 64), 'efp', NULL, 'elookup', NULL,
           'first_fp', NULL, 'first_at', NULL, 'last_at', '2026-09-22T09:00:00Z',
           'contact_id', NULL, 'key_version', 1,
           'inbound', 1, 'outbound', 0, 'messages', 1, 'taint', NULL)),
         86400);
  ASSERT v ->> 'result' = 'recorded', v::text;
  ASSERT (SELECT taint_code = 'mixed_counterparties'
          FROM public.outlook_conversation_progress
          WHERE connection_id = conn AND conversation_fingerprint = cfp),
         'a second counterparty must taint the episode';
  ASSERT (SELECT episode_fingerprint = efp_1st
          FROM public.outlook_conversation_progress
          WHERE connection_id = conn AND conversation_fingerprint = cfp),
         'tainting must not rewrite the fingerprint';

  -- ── 6. THE LEASE FENCE: both folders, or nothing ──────────────────────────
  UPDATE public.outlook_sync_state
     SET sync_lease_until = now() - interval '1 minute'
   WHERE connection_id = conn AND folder = 'sentitems';
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round1, 4,
         'NEXT-4', 'N4', NULL, NULL, 1::smallint, false, 5, 0, '[]'::jsonb, 86400);
  ASSERT v ->> 'result' = 'stale_run',
         'a run holding only the Inbox lease must be refused: ' || v::text;
  ASSERT (SELECT round_page_seq = 3
          FROM public.outlook_sync_state WHERE connection_id = conn AND folder = 'inbox'),
         'a refused checkpoint must move nothing';
  -- And reading a resume position is fenced the same way.
  v := public.read_outlook_round_progress(conn, run1);
  ASSERT v ->> 'result' = 'stale_run', 'a stale run must not read a resume position';
  UPDATE public.outlook_sync_state
     SET sync_lease_until = now() + interval '10 minutes'
   WHERE connection_id = conn AND folder = 'sentitems';

  -- ── 7. A DIFFERENT round id on the same connection is refused ─────────────
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round2, 4,
         'NEXT-4', 'N4', NULL, NULL, 1::smallint, false, 5, 0, '[]'::jsonb, 86400);
  ASSERT v ->> 'result' = 'round_mismatch',
         'two rounds must never share an accumulator: ' || v::text;

  -- ── 8. A page cannot be both mid-stream and finished ──────────────────────
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round1, 4,
         'NEXT-4', 'N4', 'DELTA-X', 'NX', 1::smallint, true, 5, 0, '[]'::jsonb, 86400);
  ASSERT v ->> 'result' = 'invalid_position', 'both positions at once must be refused';
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round1, 4,
         NULL, NULL, 'DELTA-X', 'NX', 1::smallint, false, 5, 0, '[]'::jsonb, 86400);
  ASSERT v ->> 'result' = 'invalid_position',
         'a staged deltaLink without the complete flag must be refused';

  -- ── 9. The read-back the worker finalizes from ─────────────────────────────
  v := public.read_outlook_round_progress(conn, run1);
  ASSERT v ->> 'result' = 'ok', v::text;
  ASSERT v #>> '{folders,inbox,next_link_ciphertext}' = 'NEXT-3', v::text;
  ASSERT (v #>> '{folders,inbox,page_seq}')::int = 3, v::text;
  ASSERT (v #>> '{folders,sentitems,page_seq}')::int = 0, v::text;

  v := public.list_outlook_round_conversations(conn, run1, round1, 200);
  ASSERT v ->> 'result' = 'ok', v::text;
  ASSERT (v ->> 'more_rows')::boolean = false, v::text;
  ASSERT jsonb_array_length(v -> 'conversations') = 1, v::text;
  ASSERT v #>> '{conversations,0,taint}' = 'mixed_counterparties', v::text;
  -- The read-back carries fingerprints and counts, and there is nothing else to carry.
  ASSERT NOT (v::text LIKE '%ava@bank.test%'), 'no address may come back';
  ASSERT NOT (v::text LIKE '%Following up%'), 'no subject may come back';

  -- ── 9b. THE FINALISATION RESUME POINT ─────────────────────────────────────
  -- A finished round writes its suggestions one bounded RPC at a time, and this is how
  -- it remembers how far that got. Reproduced before this existed: a hard stop after 6
  -- of 40 writes left 6 pending suggestions, the round intact, both cursors NULL and no
  -- record of the 6 - so the next invocation re-listed all 40 and began again at the
  -- first entry, forever.
  --
  -- Add a second conversation so there is something for the resume filter to skip.
  v := public.record_outlook_page_progress(
         conn, run1, 'sentitems', round1, 1,
         'NEXT-S1', 'NS1', NULL, NULL, 1::smallint, false, 4, 0,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp2, 'pfp', pfp, 'efp', repeat('8', 64),
           'elookup', jsonb_build_array(repeat('8', 64)), 'first_fp', repeat('9', 64),
           'first_at', '2026-09-23T09:00:00Z', 'last_at', '2026-09-23T10:00:00Z',
           'contact_id', c1::text, 'key_version', 1,
           'inbound', 1, 'outbound', 1, 'messages', 2, 'taint', NULL)),
         86400);
  ASSERT v ->> 'result' = 'recorded', v::text;
  ASSERT (SELECT count(*) FROM public.outlook_conversation_progress
           WHERE connection_id = conn) = 2, 'two conversations now';

  -- With no cursor the whole round is listed.
  v := public.list_outlook_round_conversations(conn, run1, round1, 200, NULL);
  ASSERT jsonb_array_length(v -> 'conversations') = 2, v::text;

  -- Record that the first (lowest-ordered) conversation is dealt with.
  v := public.advance_outlook_round_write_cursor(conn, run1, round1, cfp);
  ASSERT v ->> 'result' = 'advanced', v::text;
  ASSERT v ->> 'write_cursor' = cfp, v::text;
  -- It is recorded on BOTH folder rows, because finalisation belongs to the round.
  ASSERT (SELECT count(*) FROM public.outlook_sync_state
           WHERE connection_id = conn AND round_write_cursor = cfp) = 2,
         'the write cursor belongs to the round, not to one folder';

  -- AND THE RESUME WORKS: the conversation already dealt with is not offered again.
  v := public.list_outlook_round_conversations(conn, run1, round1, 200, cfp);
  ASSERT jsonb_array_length(v -> 'conversations') = 1, v::text;
  ASSERT v #>> '{conversations,0,cfp}' = cfp2, v::text;
  ASSERT (v ->> 'more_rows')::boolean = false, v::text;

  -- MONOTONE: a late or duplicated call with an older fingerprint cannot rewind
  -- finalisation and cause rows to be written again.
  v := public.advance_outlook_round_write_cursor(conn, run1, round1, repeat('0', 64));
  ASSERT v ->> 'result' = 'advanced', v::text;
  ASSERT (SELECT round_write_cursor = cfp FROM public.outlook_sync_state
           WHERE connection_id = conn AND folder = 'inbox'),
         'THE WRITE CURSOR MUST NEVER GO BACKWARDS';

  -- Malformed input is refused rather than stored: a bad value would exclude every row
  -- from the next pass and look exactly like `nothing left to write`.
  ASSERT public.advance_outlook_round_write_cursor(conn, run1, round1, 'not-a-fingerprint')
           ->> 'result' = 'invalid_cursor';
  ASSERT public.advance_outlook_round_write_cursor(conn, run1, round1, NULL)
           ->> 'result' = 'invalid_cursor';
  ASSERT public.advance_outlook_round_write_cursor(conn, run1, round2, cfp2)
           ->> 'result' = 'round_mismatch', 'another round may not move this cursor';

  -- FENCED on both folder leases, exactly like every other round RPC.
  UPDATE public.outlook_sync_state
     SET sync_lease_until = now() - interval '1 minute'
   WHERE connection_id = conn AND folder = 'sentitems';
  ASSERT public.advance_outlook_round_write_cursor(conn, run1, round1, cfp2)
           ->> 'result' = 'stale_run', 'a run holding one lease must not move it';
  ASSERT (SELECT round_write_cursor = cfp FROM public.outlook_sync_state
           WHERE connection_id = conn AND folder = 'inbox'),
         'a refused advance must change nothing';
  UPDATE public.outlook_sync_state
     SET sync_lease_until = now() + interval '10 minutes'
   WHERE connection_id = conn AND folder = 'sentitems';

  -- ── 10. Finishing a folder stages a PENDING cursor, still not the real one ─
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round1, 4,
         NULL, NULL, 'PENDING-inbox', 'PN', 1::smallint, true, 5, 0, '[]'::jsonb, 86400);
  ASSERT v ->> 'result' = 'recorded', v::text;
  ASSERT (SELECT pending_delta_ciphertext = 'PENDING-inbox'
                 AND next_link_ciphertext IS NULL
                 AND round_folder_complete = true
                 AND delta_link_ciphertext = 'COMMITTED-inbox'
          FROM public.outlook_sync_state WHERE connection_id = conn AND folder = 'inbox'),
         'a finished folder stages its cursor and still does not commit it';
  -- A finished folder refuses further pages.
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round1, 5,
         'NEXT-5', 'N5', NULL, NULL, 1::smallint, false, 5, 0, '[]'::jsonb, 86400);
  ASSERT v ->> 'result' = 'folder_already_complete', v::text;

  v := public.record_outlook_page_progress(
         conn, run1, 'sentitems', round1, 2,
         NULL, NULL, 'PENDING-sentitems', 'PS', 1::smallint, true, 7, 0, '[]'::jsonb, 86400);
  ASSERT v ->> 'result' = 'recorded', v::text;

  -- ── 11. AN INCOMPLETE RELEASE PRESERVES THE ROUND ─────────────────────────
  -- This is the mechanism: 'continued' is an incomplete release, and the next invocation
  -- resumes from what this one saved.
  ASSERT public.release_outlook_sync_lease(
           conn, run1, 'idle', NULL, false,
           NULL, NULL, NULL, NULL, NULL, false, 15) = true,
         'the incomplete release must confirm';
  ASSERT (SELECT count(*) FROM public.outlook_sync_state
           WHERE connection_id = conn AND round_id = round1) = 2,
         'AN INCOMPLETE RELEASE MUST NOT ERASE THE ROUND';
  ASSERT (SELECT count(*) FROM public.outlook_conversation_progress
           WHERE connection_id = conn) = 2,
         'an incomplete release must keep the accumulator';
  ASSERT (SELECT count(*) FROM public.outlook_sync_state
           WHERE connection_id = conn AND round_write_cursor = cfp) = 2,
         'AN INCOMPLETE RELEASE MUST KEEP THE FINALISATION RESUME POINT - that is what
          lets the next invocation continue the batch instead of restarting it';
  ASSERT (SELECT delta_link_ciphertext = 'COMMITTED-inbox'
          FROM public.outlook_sync_state WHERE connection_id = conn AND folder = 'inbox'),
         'an incomplete release must not advance a cursor';

  -- ── 12. A COMPLETE release promotes the cursor and erases the round ───────
  -- FIRST, the backoff the incomplete release just set is doing its job: the connection
  -- is NOT due again yet. That is correct, and it is also the scheduler gap - nothing
  -- invokes the worker, so something has to. Here the test plays that caller, exactly as
  -- the local HTTP harness does.
  ASSERT public.reserve_due_outlook_connection(600, 0) ->> 'result' = 'none_due',
         'a 15s continuation backoff must make the connection briefly not-due';
  ASSERT (SELECT count(*) FROM public.outlook_sync_state
           WHERE connection_id = conn AND next_retry_at > now()) = 2,
         'the incomplete release must set a retry time on both folders';
  UPDATE public.outlook_sync_state SET next_retry_at = NULL WHERE connection_id = conn;

  v := public.reserve_due_outlook_connection(600, 0);
  ASSERT v ->> 'result' = 'reserved', 'the next invocation must be able to reserve: ' || v::text;
  run2 := (v ->> 'run_id')::uuid;
  ASSERT run2 <> run1, 'a new invocation gets a new run id';
  -- The round survived the change of run, which is what makes it resumable.
  v := public.read_outlook_round_progress(conn, run2);
  ASSERT v #>> '{folders,inbox,round_id}' = round1::text, v::text;
  ASSERT v #>> '{folders,inbox,pending_delta_ciphertext}' = 'PENDING-inbox', v::text;

  ASSERT public.release_outlook_sync_lease(
           conn, run2, 'idle', NULL, true,
           'PENDING-inbox', 'PN', 'PENDING-sentitems', 'PS', 1::smallint, true, NULL) = true,
         'the complete release must confirm';
  ASSERT (SELECT delta_link_ciphertext = 'PENDING-inbox'
          FROM public.outlook_sync_state WHERE connection_id = conn AND folder = 'inbox'),
         'the pending cursor must be promoted on a complete run';
  ASSERT (SELECT count(*) FROM public.outlook_sync_state
           WHERE connection_id = conn
             AND (round_id IS NOT NULL OR next_link_ciphertext IS NOT NULL
                  OR pending_delta_ciphertext IS NOT NULL OR round_pages <> 0
                  OR round_page_seq <> 0 OR round_folder_complete
                  OR round_write_cursor IS NOT NULL)) = 0,
         'a committed round must leave no round state behind';
  ASSERT (SELECT count(*) FROM public.outlook_conversation_progress
           WHERE connection_id = conn) = 0,
         'a committed round must erase the accumulator';

  -- ── 13. THE CONTROLLED RESTART ────────────────────────────────────────────
  -- A saved nextLink Microsoft rejected. The round goes; the committed cursor stays.
  --
  -- NOTE ON TIME: this whole block is ONE transaction, so `now()` is frozen inside it. The
  -- release above stamped last_success_at with that same instant, and the reservation asks
  -- for `last_success_at < now()`, so nothing can be due until the clock moves. Backdating
  -- the stamp is how a single-transaction test makes time pass; it is not a claim about the
  -- due-ness policy, which the reservation's own runtime test covers.
  UPDATE public.outlook_sync_state
     SET last_success_at = now() - interval '1 hour', next_retry_at = NULL
   WHERE connection_id = conn;

  v := public.reserve_due_outlook_connection(600, 0);
  ASSERT v ->> 'result' = 'reserved', 'the restart case must be able to reserve: ' || v::text;
  run1 := (v ->> 'run_id')::uuid;
  committed_ct := (SELECT delta_link_ciphertext FROM public.outlook_sync_state
                    WHERE connection_id = conn AND folder = 'inbox');
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round2, 1,
         'NEXT-AGAIN', 'NA', NULL, NULL, 1::smallint, false, 12, 0,
         jsonb_build_array(jsonb_build_object(
           'cfp', repeat('3', 64), 'pfp', pfp, 'efp', efp_1st,
           'elookup', jsonb_build_array(efp_1st), 'first_fp', mfp_1st,
           'first_at', '2026-09-25T09:00:00Z', 'last_at', '2026-09-25T09:00:00Z',
           'contact_id', c1::text, 'key_version', 1,
           'inbound', 1, 'outbound', 0, 'messages', 1, 'taint', NULL)),
         86400);
  ASSERT v ->> 'result' = 'recorded', v::text;
  ASSERT (SELECT count(*) FROM public.outlook_conversation_progress
           WHERE connection_id = conn) = 1;

  v := public.reset_outlook_round(conn, run1, 'next_link_rejected');
  ASSERT v ->> 'result' = 'reset', v::text;
  ASSERT (v ->> 'conversations_deleted')::int = 1, v::text;
  ASSERT (SELECT count(*) FROM public.outlook_conversation_progress
           WHERE connection_id = conn) = 0,
         'the reset must discard the accumulator';
  ASSERT (SELECT round_id IS NULL AND next_link_ciphertext IS NULL
                 AND pending_delta_ciphertext IS NULL AND round_pages = 0
                 AND round_page_seq = 0 AND round_write_cursor IS NULL
          FROM public.outlook_sync_state WHERE connection_id = conn AND folder = 'inbox'),
         'the reset must discard the saved position and the finalisation resume point';
  ASSERT (SELECT delta_link_ciphertext = committed_ct
          FROM public.outlook_sync_state WHERE connection_id = conn AND folder = 'inbox'),
         'THE RESET MUST NOT TOUCH THE COMMITTED CURSOR';
  ASSERT (SELECT last_error_code = 'next_link_rejected'
          FROM public.outlook_sync_state WHERE connection_id = conn AND folder = 'inbox'),
         'the reason must be recorded on the row';

  -- ── 14. ROUND EXPIRY: one deadline, discarded or renewed AS ONE UNIT ──────
  -- Three failures forced this rule, and all three are reproduced below against the
  -- behaviour that preceded it.

  -- A round with a page on EACH folder, and a two-sided conversation assembled from
  -- both - the kind that must not be lost.
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round2, 1,
         'NEXT-IN-1', 'NI', NULL, NULL, 1::smallint, false, 3, 0,
         jsonb_build_array(jsonb_build_object(
           'cfp', early_cfp, 'pfp', pfp, 'efp', efp_1st,
           'elookup', jsonb_build_array(efp_1st), 'first_fp', mfp_1st,
           'first_at', '2026-09-20T14:00:00Z', 'last_at', '2026-09-20T14:00:00Z',
           'contact_id', c1::text, 'key_version', 1,
           'inbound', 1, 'outbound', 0, 'messages', 1, 'taint', NULL)), 86400);
  ASSERT v ->> 'result' = 'recorded', v::text;
  v := public.record_outlook_page_progress(
         conn, run1, 'sentitems', round2, 1,
         'NEXT-SE-1', 'NS', NULL, NULL, 1::smallint, false, 3, 0,
         jsonb_build_array(jsonb_build_object(
           'cfp', early_cfp, 'pfp', pfp, 'efp', efp_1st,
           'elookup', jsonb_build_array(efp_1st), 'first_fp', mfp_1st,
           'first_at', '2026-09-21T09:00:00Z', 'last_at', '2026-09-21T09:00:00Z',
           'contact_id', c1::text, 'key_version', 1,
           'inbound', 0, 'outbound', 1, 'messages', 1, 'taint', NULL)), 86400);
  ASSERT v ->> 'result' = 'recorded', v::text;
  ASSERT (SELECT inbound_count = 1 AND outbound_count = 1
          FROM public.outlook_conversation_progress
          WHERE connection_id = conn AND conversation_fingerprint = early_cfp),
         'the exchange must be two-sided across the folders';

  -- ONE DEADLINE, identical on both rows, and later pages do NOT move it. Extending it
  -- per page is what let a round outlive the records it depended on.
  SELECT round_expires_at INTO round_ends FROM public.outlook_sync_state
   WHERE connection_id = conn AND folder = 'inbox';
  ASSERT (SELECT count(DISTINCT round_expires_at) = 1 FROM public.outlook_sync_state
           WHERE connection_id = conn),
         'both folders must carry the SAME round deadline';
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round2, 2,
         'NEXT-IN-2', 'NI', NULL, NULL, 1::smallint, false, 3, 0, '[]'::jsonb, 86400);
  ASSERT v ->> 'result' = 'recorded', v::text;
  ASSERT (SELECT round_expires_at = round_ends FROM public.outlook_sync_state
           WHERE connection_id = conn AND folder = 'inbox'),
         'A LATER PAGE MUST NOT EXTEND THE ROUND DEADLINE';

  -- ── 14a. the round expires: EVERYTHING about it stops at once ─────────────
  UPDATE public.outlook_sync_state SET round_expires_at = now() - interval '1 second'
   WHERE connection_id = conn;

  -- The read reports it HONESTLY. Reporting `no round` is what made the worker invent a
  -- new id that every checkpoint then refused, forever.
  v := public.read_outlook_round_progress(conn, run1);
  ASSERT (v ->> 'round_expired')::boolean = true, v::text;
  ASSERT v #>> '{folders,inbox,round_id}' IS NULL,
         'an expired round must not be resumed';
  ASSERT v #>> '{folders,inbox,next_link_ciphertext}' IS NULL,
         'an expired resume position must not be handed back';

  -- A dead round cannot be extended by another page...
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round2, 3,
         'NEXT-IN-3', 'NI', NULL, NULL, 1::smallint, false, 3, 0, '[]'::jsonb, 86400);
  ASSERT v ->> 'result' = 'round_expired', v::text;
  -- ...nor FINALISED, which is what stops a cursor advancing past records that are about
  -- to be discarded. Before this rule the round stayed live while an early conversation
  -- aged out and was deleted by a later page, and finalisation then listed only the
  -- survivors and committed both cursors past the exchange it had lost.
  v := public.list_outlook_round_conversations(conn, run1, round2, 200, NULL);
  ASSERT v ->> 'result' = 'round_expired',
         'an expired round must not be listed for finalisation: ' || v::text;
  -- ...nor may its finalisation progress be recorded.
  v := public.advance_outlook_round_write_cursor(conn, run1, round2, early_cfp);
  ASSERT v ->> 'result' = 'round_expired', v::text;

  -- The two-sided conversation is STILL THERE, not silently deleted while its round
  -- looked alive. It goes when the round goes, which is the whole rule.
  ASSERT (SELECT count(*) > 0 FROM public.outlook_conversation_progress
           WHERE connection_id = conn AND conversation_fingerprint = early_cfp),
         'records must not vanish out from under a round';

  -- ── 14b. a NEW round starts cleanly from the unchanged committed cursor ───
  committed_ct := (SELECT delta_link_ciphertext FROM public.outlook_sync_state
                    WHERE connection_id = conn AND folder = 'inbox');
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round3, 1,
         'FRESH-IN-1', 'FI', NULL, NULL, 1::smallint, false, 2, 0, '[]'::jsonb, 86400);
  ASSERT v ->> 'result' = 'recorded',
         'A NEW ROUND MUST BE ABLE TO START OVER AN EXPIRED ONE: ' || v::text;
  ASSERT (v ->> 'round_pages')::int = 1, 'and it starts from one page, not from the old count';
  -- The expired round is gone WHOLE: both folder rows and every one of its records.
  ASSERT (SELECT count(*) = 0 FROM public.outlook_conversation_progress
           WHERE connection_id = conn AND round_id = round2),
         'the discarded round must leave no records behind';
  ASSERT (SELECT count(*) = 2 FROM public.outlook_sync_state
           WHERE connection_id = conn AND round_id = round3),
         'the new round id must be adopted on both folder rows';
  ASSERT (SELECT bool_and(round_expires_at > now()) FROM public.outlook_sync_state
           WHERE connection_id = conn),
         'the new round gets a live deadline';
  -- AND THE COMMITTED CURSOR NEVER MOVED, so the new round re-reads from a position that
  -- genuinely was ingested: it costs pages, and it skips nothing.
  ASSERT (SELECT delta_link_ciphertext = committed_ct FROM public.outlook_sync_state
           WHERE connection_id = conn AND folder = 'inbox'),
         'expiry must never touch the committed cursor';

  -- ── 14c. the two folders disagreeing fails towards EXPIRED ────────────────
  -- The deadline is written to both rows at once, so they cannot normally differ. If they
  -- ever did, the EARLIER one must govern - otherwise one folder reports a round the
  -- other does not, and a worker resumes half of one.
  UPDATE public.outlook_sync_state SET round_expires_at = now() - interval '1 second'
   WHERE connection_id = conn AND folder = 'sentitems';
  v := public.read_outlook_round_progress(conn, run1);
  ASSERT (v ->> 'round_expired')::boolean = true,
         'one expired folder expires the round: ' || v::text;
  ASSERT v #>> '{folders,inbox,round_id}' IS NULL
     AND v #>> '{folders,sentitems,round_id}' IS NULL,
         'NEITHER folder may report a resumable round';
  v := public.list_outlook_round_conversations(conn, run1, round3, 200, NULL);
  ASSERT v ->> 'result' = 'round_expired', v::text;

  -- Tidy up for the sections that follow.
  v := public.reset_outlook_round(conn, run1, NULL);
  ASSERT v ->> 'result' = 'reset', v::text;

  -- ── 14b. THE READ-BACK IS PAGED, AND TRUNCATION IS WHOLE-ROUND ────────────
  -- A record serialises to about 602 bytes at its widest, so the 2000-record round
  -- ceiling is about 1.18 MiB in one response - four and a half times the 256 KiB the
  -- worker's database port will read. Reproduced through the deployed port before this
  -- was paged. These assertions prove the SQL side: the cap holds whatever is asked for,
  -- `more_rows` means continue, and the truncation count covers the WHOLE round.
  v := public.reset_outlook_round(conn, run1, NULL);
  ASSERT v ->> 'result' = 'reset', v::text;
  UPDATE public.outlook_sync_state
     SET round_id = round2, round_started_at = now(),
         round_expires_at = now() + interval '1 day'
   WHERE connection_id = conn;

  -- 450 clean records plus one whose exchange exceeded the episode bound.
  FOR i IN 1..450 LOOP
    INSERT INTO public.outlook_conversation_progress (
      connection_id, user_id, round_id, conversation_fingerprint,
      person_fingerprint, episode_fingerprint, episode_lookup_fingerprints,
      first_message_fingerprint, key_version, contact_id,
      first_seen_at, last_seen_at, inbound_count, outbound_count, message_count,
      taint_code)
    VALUES (conn, u1, round2, lpad(to_hex(i), 64, '0'),
            lpad(to_hex(i + 9000000), 64, '0'), lpad(to_hex(i + 8000000), 64, '0'),
            ARRAY[lpad(to_hex(i + 8000000), 64, '0'), lpad(to_hex(i + 7000000), 64, '0')],
            lpad(to_hex(i + 6000000), 64, '0'), 1, c1,
            now() - interval '2 days', now() - interval '1 day', 1, 1,
            CASE WHEN i = 1 THEN 60 ELSE 2 END,
            CASE WHEN i = 1 THEN 'episode_truncated' ELSE NULL END);
  END LOOP;

  -- THE CAP HOLDS whatever is asked for, so a caller cannot produce a body its own port
  -- refuses to read.
  v := public.list_outlook_round_conversations(conn, run1, round2, 2000, NULL);
  ASSERT jsonb_array_length(v -> 'conversations') = 200,
         'asking for the whole round must still yield one page: ' ||
         jsonb_array_length(v -> 'conversations')::text;
  ASSERT (v ->> 'more_rows')::boolean = true, v::text;
  ASSERT octet_length(v::text) < 262144,
         'a page must fit the port bound: ' || octet_length(v::text)::text;

  -- THE TRUNCATION COUNT IS WHOLE-ROUND. Page one holds the shortened exchange...
  ASSERT (v ->> 'round_truncated_episodes')::int = 1, v::text;
  -- ...and so does a page that does NOT contain it. This is the case a per-page check
  -- cannot catch: finalisation resumed past the tainted row, yet the round must still
  -- refuse to commit, because the discarded work belongs to the round.
  v := public.list_outlook_round_conversations(conn, run1, round2, 200,
         lpad(to_hex(300), 64, '0'));
  ASSERT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v -> 'conversations') e
     WHERE e ->> 'taint' = 'episode_truncated'),
         'the page in hand must be clean, which is the point of this case';
  ASSERT (v ->> 'round_truncated_episodes')::int = 1,
         'A SHORTENED EXCHANGE ON AN EARLIER PAGE MUST STILL BE REPORTED';

  -- Walking the pages reaches every record exactly once.
  DECLARE
    cur text := NULL;
    seen integer := 0;
    pages integer := 0;
  BEGIN
    LOOP
      v := public.list_outlook_round_conversations(conn, run1, round2, 200, cur);
      pages := pages + 1;
      seen := seen + jsonb_array_length(v -> 'conversations');
      EXIT WHEN NOT (v ->> 'more_rows')::boolean OR pages > 10;
      -- #>> takes a text[] path, not a text literal.
      cur := v #>> ARRAY['conversations',
        (jsonb_array_length(v -> 'conversations') - 1)::text, 'cfp'];
    END LOOP;
    ASSERT pages = 3, 'three pages for 450 records: ' || pages::text;
    ASSERT seen = 450, 'every record exactly once: ' || seen::text;
  END;

  DELETE FROM public.outlook_conversation_progress WHERE connection_id = conn;

  -- ── 15. No suggestion, no interaction, no contact was created anywhere ────
  ASSERT (SELECT count(*) FROM public.interaction_candidates WHERE user_id = u1) = 0,
         'continuation alone must create no suggestion';
  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u1) = 0,
         'the worker must never create an interaction';
  ASSERT (SELECT count(*) FROM public.contacts WHERE user_id = u1) = 1,
         'the worker must never add a contact';

  -- ── 16. Shape and privilege of the new objects ────────────────────────────
  ASSERT (SELECT relrowsecurity FROM pg_class
          WHERE oid = 'public.outlook_conversation_progress'::regclass),
         'RLS must be enabled on the accumulator';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'outlook_conversation_progress'),
         'worker state must have no policy';
  ASSERT NOT has_table_privilege('authenticated', 'public.outlook_conversation_progress', 'SELECT'),
         'authenticated must not read worker state';
  ASSERT NOT has_table_privilege('anon', 'public.outlook_conversation_progress', 'SELECT'),
         'anon must not read worker state';
  ASSERT has_table_privilege('service_role', 'public.outlook_conversation_progress', 'SELECT'),
         'service_role must read worker state';

  -- The accumulator has no column that could hold content.
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'outlook_conversation_progress'
       AND (column_name LIKE '%body%' OR column_name LIKE '%subject%'
            OR column_name LIKE '%snippet%' OR column_name LIKE '%header%'
            OR column_name LIKE '%email%' OR column_name LIKE '%address%'
            OR column_name = 'message_id' OR column_name = 'conversation_id')),
         'the accumulator must have no column that could hold content or an identifier';

  FOR v IN SELECT to_jsonb(x) FROM (VALUES
      ('record_outlook_page_progress'),
      ('read_outlook_round_progress'),
      ('list_outlook_round_conversations'),
      ('reset_outlook_round'),
      ('advance_outlook_round_write_cursor')) AS x(name)
  LOOP
    ASSERT (SELECT bool_and(p.prosecdef) FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = v ->> 'name'),
           (v ->> 'name') || ' is not SECURITY DEFINER';
    ASSERT (SELECT bool_and(array_to_string(p.proconfig, ',') LIKE '%search_path=%')
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = v ->> 'name'),
           (v ->> 'name') || ' has no pinned search_path';
  END LOOP;

  -- THE SIGNATURE GAINED A SIXTEENTH ARGUMENT (p_messages, the protected message
  -- handles) in 20261007000000_outlook_round_message_retrieval.sql, which DROPs
  -- and re-CREATEs this function. has_function_privilege() resolves by EXACT
  -- argument list, so these two name the 16-argument form; against the old
  -- 15-argument form they raise "function does not exist" rather than failing an
  -- assertion. A dropped function loses its ACL, so these are what prove the
  -- REVOKE/GRANT pair was restated after the DROP.
  ASSERT NOT has_function_privilege('authenticated',
           'public.record_outlook_page_progress(uuid,uuid,text,uuid,integer,text,text,text,text,smallint,boolean,integer,integer,jsonb,integer,jsonb)',
           'EXECUTE'),
         'authenticated gained EXECUTE on the checkpoint RPC';
  ASSERT NOT has_function_privilege('anon',
           'public.reset_outlook_round(uuid,uuid,text)', 'EXECUTE'),
         'anon gained EXECUTE on the restart RPC';
  ASSERT NOT has_function_privilege('authenticated',
           'public.advance_outlook_round_write_cursor(uuid,uuid,uuid,text)', 'EXECUTE'),
         'authenticated gained EXECUTE on the finalisation cursor RPC';
  ASSERT has_function_privilege('service_role',
           'public.advance_outlook_round_write_cursor(uuid,uuid,uuid,text)', 'EXECUTE'),
         'service_role must be able to record finalisation progress';
  ASSERT has_function_privilege('service_role',
           'public.record_outlook_page_progress(uuid,uuid,text,uuid,integer,text,text,text,text,smallint,boolean,integer,integer,jsonb,integer,jsonb)',
           'EXECUTE'),
         'service_role must be able to checkpoint';

  -- ── teardown ──────────────────────────────────────────────────────────────
  DELETE FROM public.outlook_conversation_progress WHERE user_id = u1;
  DELETE FROM public.interaction_candidates WHERE user_id = u1;
  DELETE FROM public.contacts WHERE user_id = u1;
  DELETE FROM public.microsoft_connections WHERE user_id = u1;

  RAISE NOTICE 'OUTLOOK DURABLE CONTINUATION RUNTIME: ALL ASSERTIONS PASSED';
END $$;
