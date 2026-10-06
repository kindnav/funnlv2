-- THE MESSAGE-RETRIEVAL STORAGE CONTRACT, proven against a real Postgres with
-- every migration applied.
--
-- THE CONTRACT. To summarize a two-sided exchange at round finalization, the
-- envelope pass persists exactly one thing per selected message: an ENCRYPTED
-- Graph IMMUTABLE id. Subject, participants and body all come back with the
-- fetch and are discarded; none is stored. Six handles represent one
-- conversation, and WHICH six is chosen deliberately.
--
-- EVERY SECTION IS A REGRESSION. Each failed, with the numbers quoted, before
-- the migration was corrected:
--
--   1. CASCADE. The only FK was (connection_id, user_id) -> microsoft_connections,
--      so handles died on disconnect but SURVIVED round completion, reset,
--      supersede and takeover. Measured: erasing the accumulator left 6 orphans.
--   2. SELECTION. The cap kept "the first six seen", justified by the episode
--      taint - but that taint fires above MAX_EPISODE_MESSAGES = 50, so a
--      7-message exchange was never tainted and silently lost its LATEST reply
--      while the page reported `recorded`. Measured: kept 1-6, dropped 7,
--      taint NULL.
--   3. SILENT LOSS. Reaching 4000 handles EXITed the loop and still returned
--      `recorded`, committing a cursor for a conversation whose handle was
--      thrown away (measured: retained=0, result=recorded). The FIRST fix then
--      returned a refusal AFTER the resume position had been written - and a
--      plpgsql RETURN does not roll back - so the cursor committed anyway
--      (measured: next_link set despite handle_budget_exhausted).
--   4. RESPONSE SIZE. With maximum permitted ciphertext the read returned
--      649,679 bytes against the port's 256 KiB bound - 2.5x over. Measured with
--      real maximum-length values, not short fixture strings.
--
-- WHAT IS NOT CLAIMED. Reaching the 24-hour round deadline deletes NOTHING. An
-- expired round is refused, not erased, and nothing is scheduled to sweep it, so
-- an abandoned connection's handles persist until the next run supersedes the
-- round, a reset runs, or the account disconnects. That is asserted below and
-- the disclosure draft says it in those words.
--
-- HOW TO BUILD THE DATABASE: tests/sql/_bootstrap-disposable-db.sql, then every
-- migration in supabase/migrations, in filename order.
--
-- WHAT THIS DOES NOT PROVE. It runs as `postgres`, so it proves function bodies,
-- constraints and cascades - not RLS (grants are asserted directly instead).
-- There is no Graph, no fetch and no mailbox: whether Microsoft actually returns
-- a stable id for the header is taken from Microsoft's documentation.

\set ON_ERROR_STOP on

-- ══ fixtures ════════════════════════════════════════════════════════════════
DO $$
DECLARE
  u    uuid := '55555555-5555-5555-5555-555555555555';
  conn uuid := '66666666-6666-6666-6666-666666666666';
BEGIN
  DELETE FROM public.outlook_round_messages        WHERE user_id = u;
  DELETE FROM public.outlook_conversation_progress WHERE user_id = u;
  DELETE FROM public.outlook_sync_state            WHERE connection_id = conn;
  DELETE FROM public.contacts                      WHERE user_id = u;
  DELETE FROM public.microsoft_connections         WHERE user_id = u;

  INSERT INTO auth.users (id, email) VALUES (u, 'retrieval@getfunnl.test')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, email) VALUES (u, 'retrieval@getfunnl.test')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.microsoft_connections
    (id, user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, needs_reauth, consented_at, consent_policy_version)
  VALUES
    (conn, u, 'acct-r', '9188040d-6c67-4c5b-b112-36a304b66dad', 'personal',
     'pilot@outlook.test', ARRAY['Mail.Read','User.Read','offline_access'],
     'active', false, now(), 'ol-disc-81fe8944fd2be59ac3c059c229b4d28e');
END $$;

-- ══ 1. CONTINUATION, and the deliberate selection ═══════════════════════════
DO $$
DECLARE
  u     uuid := '55555555-5555-5555-5555-555555555555';
  conn  uuid := '66666666-6666-6666-6666-666666666666';
  run1  uuid := '77777777-7777-7777-7777-777777777777';
  run2  uuid := '88888888-8888-8888-8888-888888888888';
  round uuid := '99999999-9999-9999-9999-999999999999';
  cfp   text := repeat('c', 64);
  v     jsonb;
  conv  jsonb;
  kept  text;
BEGIN
  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, sync_run_id, sync_lease_until,
     run_started_at, last_attempt_at, updated_at)
  VALUES
    (conn, u, 'inbox',     'running', run1, now() + interval '7 minutes', now(), now(), now()),
    (conn, u, 'sentitems', 'running', run1, now() + interval '7 minutes', now(), now(), now());

  conv := jsonb_build_object(
    'cfp', cfp, 'pfp', repeat('ab', 32), 'efp', repeat('e', 64),
    'first_fp', repeat('1', 64), 'first_at', '2026-09-20T10:00:00Z',
    'last_at', '2026-09-20T10:00:00Z', 'contact_id', NULL,
    'key_version', 1, 'inbound', 1, 'outbound', 0, 'messages', 1, 'taint', NULL);

  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round, 1, 'NEXT-IN-1', 'N', NULL, NULL,
         1::smallint, false, 10, 0, jsonb_build_array(conv), 86400,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp, 'mfp', repeat('1', 64), 'mid_ct', 'CT-IN-1', 'mid_nonce', 'N1',
           'key_version', 1, 'folder', 'inbox', 'sent_at', '2026-09-20T10:00:00Z')));
  ASSERT v ->> 'result' = 'recorded', 'inbox page 1 refused: ' || v::text;
  ASSERT (v ->> 'handles_offered')::int = 1, v::text;
  ASSERT (v ->> 'handles_evicted')::int = 0, v::text;

  -- A RE-SENT PAGE IS A NO-OP and must not duplicate the handle, even though the
  -- ciphertext differs: the dedupe key is the keyed message fingerprint, which an
  -- AES-GCM ciphertext could never be (its nonce is random per call).
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round, 1, 'NEXT-IN-1', 'N', NULL, NULL,
         1::smallint, false, 10, 0, jsonb_build_array(conv), 86400,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp, 'mfp', repeat('1', 64), 'mid_ct', 'CT-DIFFERENT', 'mid_nonce', 'N9',
           'key_version', 1, 'folder', 'inbox', 'sent_at', '2026-09-20T10:00:00Z')));
  ASSERT v ->> 'result' = 'duplicate_page', 'a re-sent page must be a no-op: ' || v::text;
  ASSERT (SELECT count(*) FROM public.outlook_round_messages
           WHERE connection_id = conn AND round_id = round) = 1, 'IDEMPOTENCE';

  -- page 2, SENT ITEMS, same round: the outbound half.
  v := public.record_outlook_page_progress(
         conn, run1, 'sentitems', round, 1, NULL, NULL, 'DELTA-SENT', 'D',
         1::smallint, true, 5, 0,
         jsonb_build_array(conv || jsonb_build_object('inbound', 0, 'outbound', 1,
           'first_fp', repeat('2', 64), 'last_at', '2026-09-21T09:00:00Z')), 86400,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp, 'mfp', repeat('2', 64), 'mid_ct', 'CT-SENT-1', 'mid_nonce', 'N2',
           'key_version', 1, 'folder', 'sentitems', 'sent_at', '2026-09-21T09:00:00Z')));
  ASSERT v ->> 'result' = 'recorded', 'sentitems page refused: ' || v::text;

  -- A DIFFERENT INVOCATION takes over the lease, same round.
  UPDATE public.outlook_sync_state
     SET sync_run_id = run2, sync_lease_until = now() + interval '7 minutes'
   WHERE connection_id = conn;

  v := public.record_outlook_page_progress(
         conn, run2, 'inbox', round, 2, NULL, NULL, 'DELTA-INBOX', 'D',
         1::smallint, true, 7, 0,
         jsonb_build_array(conv || jsonb_build_object('inbound', 1, 'outbound', 0,
           'first_fp', repeat('3', 64), 'last_at', '2026-09-22T11:00:00Z')), 86400,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp, 'mfp', repeat('3', 64), 'mid_ct', 'CT-IN-2', 'mid_nonce', 'N3',
           'key_version', 1, 'folder', 'inbox', 'sent_at', '2026-09-22T11:00:00Z')));
  ASSERT v ->> 'result' = 'recorded', 'the second invocation was refused: ' || v::text;

  -- The exchange is two-sided, assembled across pages, folders AND invocations.
  ASSERT (SELECT inbound_count = 2 AND outbound_count = 1 AND message_count = 3
          FROM public.outlook_conversation_progress
          WHERE connection_id = conn AND round_id = round
            AND conversation_fingerprint = cfp), 'accumulated counts wrong';
  ASSERT (SELECT count(*) FROM public.outlook_round_messages
           WHERE connection_id = conn AND round_id = round) = 3,
    'all three handles must survive to finalization';
  ASSERT (SELECT count(DISTINCT folder) FROM public.outlook_round_messages
           WHERE connection_id = conn AND round_id = round) = 2,
    'handles from BOTH folders must be present';

  -- A completed folder refuses further pages with 'folder_already_complete',
  -- which is correct behaviour - so the round is reopened rather than worked
  -- around.
  UPDATE public.outlook_sync_state
     SET round_folder_complete = false, round_page_seq = 1
   WHERE connection_id = conn AND folder = 'sentitems';

  -- ── THE SELECTION. Four more messages arrive, taking the thread to SEVEN -
  -- under MAX_EPISODE_MESSAGES, so it is NOT tainted and the selection must
  -- stand on its own. Message 7 is the LATEST reply.
  v := public.record_outlook_page_progress(
         conn, run2, 'sentitems', round, 2, NULL, NULL, 'DELTA-SENT-2', 'D',
         1::smallint, true, 4, 0,
         jsonb_build_array(conv || jsonb_build_object('inbound', 2, 'outbound', 2,
           'first_fp', repeat('4', 64), 'last_at', '2026-09-27T09:00:00Z')), 86400,
         jsonb_build_array(
           jsonb_build_object('cfp', cfp, 'mfp', repeat('4', 64), 'mid_ct', 'CT-4',
             'mid_nonce', 'N', 'key_version', 1, 'folder', 'sentitems',
             'sent_at', '2026-09-24T09:00:00Z'),
           jsonb_build_object('cfp', cfp, 'mfp', repeat('5', 64), 'mid_ct', 'CT-5',
             'mid_nonce', 'N', 'key_version', 1, 'folder', 'inbox',
             'sent_at', '2026-09-25T09:00:00Z'),
           jsonb_build_object('cfp', cfp, 'mfp', repeat('6', 64), 'mid_ct', 'CT-6',
             'mid_nonce', 'N', 'key_version', 1, 'folder', 'sentitems',
             'sent_at', '2026-09-26T09:00:00Z'),
           jsonb_build_object('cfp', cfp, 'mfp', repeat('7', 64), 'mid_ct', 'CT-7',
             'mid_nonce', 'N', 'key_version', 1, 'folder', 'inbox',
             'sent_at', '2026-09-27T09:00:00Z')));
  ASSERT v ->> 'result' = 'recorded', 'the 7-message page was refused: ' || v::text;
  ASSERT (v ->> 'handles_evicted')::int = 1,
    'exactly one handle should be evicted down to six: ' || v::text;

  ASSERT (SELECT count(*) FROM public.outlook_round_messages
           WHERE connection_id = conn AND round_id = round) = 6,
    'the selection must be exactly six';
  -- THE LATEST REPLY IS KEPT. This is the measured defect: the old code kept
  -- handles 1-6 and dropped 7.
  ASSERT EXISTS (SELECT 1 FROM public.outlook_round_messages
                  WHERE connection_id = conn AND round_id = round
                    AND message_fingerprint = repeat('7', 64)),
    'THE LATEST REPLY MUST BE IN THE SELECTION';
  -- And the OLDEST is what the selection drops.
  ASSERT NOT EXISTS (SELECT 1 FROM public.outlook_round_messages
                      WHERE connection_id = conn AND round_id = round
                        AND message_fingerprint = repeat('1', 64)),
    'the oldest message is the one the selection drops';
  ASSERT (SELECT count(*) FROM public.outlook_round_messages
           WHERE connection_id = conn AND round_id = round AND folder = 'inbox') >= 2,
    'at least two inbound handles must be reserved';
  ASSERT (SELECT count(*) FROM public.outlook_round_messages
           WHERE connection_id = conn AND round_id = round AND folder = 'sentitems') >= 2,
    'at least two outbound handles must be reserved';
  -- NOT tainted: a 7-message exchange is perfectly valid, which is exactly why
  -- the selection has to be deliberate rather than "the first six seen".
  ASSERT (SELECT taint_code IS NULL FROM public.outlook_conversation_progress
           WHERE connection_id = conn AND round_id = round
             AND conversation_fingerprint = cfp),
    'a 7-message exchange must not be tainted';

  SELECT string_agg(ltrim(message_fingerprint, '0'), ',' ORDER BY sent_at) INTO kept
    FROM public.outlook_round_messages
   WHERE connection_id = conn AND round_id = round;
  RAISE NOTICE 'selection kept (chronological): %', kept;
END $$;

-- ══ 2. ONE-SIDED VOLUME still yields a two-sided selection ══════════════════
DO $$
DECLARE
  conn  uuid := '66666666-6666-6666-6666-666666666666';
  run2  uuid := '88888888-8888-8888-8888-888888888888';
  round uuid := '99999999-9999-9999-9999-999999999999';
  cfp   text := repeat('1a', 32);
  conv  jsonb;
  msgs  jsonb := '[]'::jsonb;
  v     jsonb;
  i     integer;
BEGIN
  UPDATE public.outlook_sync_state
     SET round_folder_complete = false, round_page_seq = 2,
         round_expires_at = now() + interval '1 hour'
   WHERE connection_id = conn;

  conv := jsonb_build_object(
    'cfp', cfp, 'pfp', repeat('2b', 32), 'efp', repeat('3c', 32),
    'first_fp', repeat('4d', 32), 'first_at', '2026-09-10T09:00:00Z',
    'last_at', '2026-09-19T09:00:00Z', 'contact_id', NULL, 'key_version', 1,
    'inbound', 9, 'outbound', 1, 'messages', 10, 'taint', NULL);

  -- NINE inbound and ONE outbound, and the outbound is the OLDEST message.
  -- Pure recency would keep six inbound and lose the account's only reply,
  -- making the exchange read as one-sided in the summary.
  FOR i IN 1..9 LOOP
    msgs := msgs || jsonb_build_array(jsonb_build_object(
      'cfp', cfp, 'mfp', lpad(i::text, 64, 'a'), 'mid_ct', 'CT-IN-' || i::text,
      'mid_nonce', 'N', 'key_version', 1, 'folder', 'inbox',
      'sent_at', ('2026-09-1' || i::text || 'T09:00:00Z')::timestamptz));
  END LOOP;
  msgs := msgs || jsonb_build_array(jsonb_build_object(
    'cfp', cfp, 'mfp', lpad('0', 64, 'b'), 'mid_ct', 'CT-OUT-1',
    'mid_nonce', 'N', 'key_version', 1, 'folder', 'sentitems',
    'sent_at', '2026-09-10T09:00:00Z'));

  v := public.record_outlook_page_progress(
         conn, run2, 'inbox', round, 3, NULL, NULL, 'DELTA-X', 'D',
         1::smallint, true, 10, 0, jsonb_build_array(conv), 86400, msgs);
  ASSERT v ->> 'result' = 'recorded', 'the one-sided-volume page was refused: ' || v::text;

  ASSERT (SELECT count(*) FROM public.outlook_round_messages
           WHERE connection_id = conn AND round_id = round
             AND conversation_fingerprint = cfp) = 6, 'six after selection';
  -- THE RESERVATION EARNS ITS KEEP.
  ASSERT EXISTS (SELECT 1 FROM public.outlook_round_messages
                  WHERE connection_id = conn AND round_id = round
                    AND conversation_fingerprint = cfp AND folder = 'sentitems'),
    'THE ACCOUNT''S ONLY REPLY MUST SURVIVE, or the summary reads as one-sided';
  ASSERT EXISTS (SELECT 1 FROM public.outlook_round_messages
                  WHERE connection_id = conn AND round_id = round
                    AND conversation_fingerprint = cfp
                    AND message_fingerprint = lpad('9', 64, 'a')),
    'the latest reply must still be kept';
END $$;

-- ══ 3. SILENT LOSS IS NOW A REFUSAL, AND IT HAPPENS BEFORE ANY WRITE ════════
DO $$
DECLARE
  conn  uuid := '66666666-6666-6666-6666-666666666666';
  run2  uuid := '88888888-8888-8888-8888-888888888888';
  round uuid := '99999999-9999-9999-9999-999999999999';
  cfp   text := repeat('5e', 32);
  conv  jsonb;
  bad   jsonb;
  seq_before integer;
BEGIN
  conv := jsonb_build_object(
    'cfp', cfp, 'pfp', repeat('6f', 32), 'efp', repeat('7a', 32),
    'first_fp', repeat('8b', 32), 'first_at', '2026-09-28T09:00:00Z',
    'last_at', '2026-09-28T09:00:00Z', 'contact_id', NULL, 'key_version', 1,
    'inbound', 1, 'outbound', 1, 'messages', 2, 'taint', NULL);
  UPDATE public.outlook_sync_state
     SET round_folder_complete = false, round_page_seq = 5
   WHERE connection_id = conn AND folder = 'inbox';
  SELECT round_page_seq INTO seq_before FROM public.outlook_sync_state
   WHERE connection_id = conn AND folder = 'inbox';

  FOR bad IN SELECT * FROM (VALUES
    (jsonb_build_object('cfp', cfp, 'mfp', 'not-a-fingerprint', 'mid_ct', 'X',
       'mid_nonce', 'N', 'folder', 'inbox', 'sent_at', '2026-09-28T09:00:00Z')),
    (jsonb_build_object('cfp', cfp, 'mfp', repeat('9c', 32), 'mid_ct', '',
       'mid_nonce', 'N', 'folder', 'inbox', 'sent_at', '2026-09-28T09:00:00Z')),
    (jsonb_build_object('cfp', cfp, 'mfp', repeat('9c', 32), 'mid_ct', repeat('Z', 1025),
       'mid_nonce', 'N', 'folder', 'inbox', 'sent_at', '2026-09-28T09:00:00Z')),
    (jsonb_build_object('cfp', cfp, 'mfp', repeat('9c', 32), 'mid_ct', 'X',
       'mid_nonce', 'N', 'folder', 'drafts', 'sent_at', '2026-09-28T09:00:00Z')),
    (jsonb_build_object('cfp', cfp, 'mfp', repeat('9c', 32), 'mid_ct', 'X',
       'mid_nonce', 'N', 'folder', 'inbox')),
    (to_jsonb('garbage'::text))
  ) AS t(h)
  LOOP
    ASSERT (public.record_outlook_page_progress(
              conn, run2, 'inbox', round, 6, 'NX', 'N', NULL, NULL,
              1::smallint, false, 1, 0, jsonb_build_array(conv), 86400,
              jsonb_build_array(bad)) ->> 'result') = 'invalid_handle',
      'a malformed handle must refuse the page: ' || bad::text;
  END LOOP;

  ASSERT (public.record_outlook_page_progress(
            conn, run2, 'inbox', round, 6, 'NX', 'N', NULL, NULL,
            1::smallint, false, 1, 0, jsonb_build_array(conv), 86400,
            jsonb_build_array(jsonb_build_object(
              'cfp', repeat('ff', 32), 'mfp', repeat('9c', 32), 'mid_ct', 'X',
              'mid_nonce', 'N', 'folder', 'inbox',
              'sent_at', '2026-09-28T09:00:00Z'))) ->> 'result') = 'orphan_handle',
    'a handle whose conversation is not in this page must refuse it';

  ASSERT (public.record_outlook_page_progress(
            conn, run2, 'inbox', round, 6, 'NX', 'N', NULL, NULL,
            1::smallint, false, 1, 0, jsonb_build_array(conv), 86400,
            '"nope"'::jsonb) ->> 'result') = 'invalid_messages';

  -- AND NO REFUSAL MOVED THE RESUME POSITION. This is the subtler half: a
  -- plpgsql RETURN does not roll back, so a refusal issued after the page had
  -- been written left the cursor committed anyway.
  ASSERT (SELECT round_page_seq FROM public.outlook_sync_state
           WHERE connection_id = conn AND folder = 'inbox') = seq_before,
    'A REFUSED PAGE MUST NOT ADVANCE THE RESUME POSITION';
  ASSERT (SELECT next_link_ciphertext IS DISTINCT FROM 'NX'
          FROM public.outlook_sync_state
           WHERE connection_id = conn AND folder = 'inbox'),
    'nor store the refused page''s next link';
  ASSERT NOT EXISTS (SELECT 1 FROM public.outlook_conversation_progress
                      WHERE connection_id = conn AND round_id = round
                        AND conversation_fingerprint = cfp),
    'nor merge the refused page''s conversation';
END $$;

-- ══ the round ceiling refuses rather than dropping ══════════════════════════
DO $$
DECLARE
  u     uuid := '55555555-5555-5555-5555-555555555555';
  conn  uuid := '66666666-6666-6666-6666-666666666666';
  run2  uuid := '88888888-8888-8888-8888-888888888888';
  round uuid := '99999999-9999-9999-9999-999999999999';
  cfp   text := repeat('5e', 32);
  pad   text := repeat('ad', 32);
  conv  jsonb;
  v     jsonb;
BEGIN
  conv := jsonb_build_object(
    'cfp', cfp, 'pfp', repeat('6f', 32), 'efp', repeat('7a', 32),
    'first_fp', repeat('8b', 32), 'first_at', '2026-09-28T09:00:00Z',
    'last_at', '2026-09-28T09:00:00Z', 'contact_id', NULL, 'key_version', 1,
    'inbound', 1, 'outbound', 1, 'messages', 2, 'taint', NULL);
  INSERT INTO public.outlook_conversation_progress
    (connection_id, user_id, round_id, conversation_fingerprint, person_fingerprint,
     episode_fingerprint, first_message_fingerprint, key_version,
     first_seen_at, last_seen_at, inbound_count, outbound_count, message_count)
  VALUES (conn, u, round, pad, repeat('be', 32), repeat('ce', 32), repeat('de', 32),
          1, now(), now(), 1, 1, 2)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.outlook_round_messages
    (connection_id, user_id, round_id, conversation_fingerprint, message_fingerprint,
     folder, sent_at, message_id_ciphertext, message_id_nonce, key_version)
  SELECT conn, u, round, pad, lpad(g::text, 64, 'f'), 'inbox', now(), 'CT', 'N', 1
    FROM generate_series(1, 4000) g;

  v := public.record_outlook_page_progress(
         conn, run2, 'inbox', round, 7, 'NX2', 'N', NULL, NULL,
         1::smallint, false, 1, 0, jsonb_build_array(conv), 86400,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp, 'mfp', repeat('9c', 32), 'mid_ct', 'CT-OVER', 'mid_nonce', 'N',
           'key_version', 1, 'folder', 'inbox', 'sent_at', '2026-09-28T09:00:00Z')));
  ASSERT v ->> 'result' = 'handle_budget_exhausted',
    'the round ceiling must REFUSE the page, not drop the handle: ' || v::text;
  -- Not hard-coded to 4000: earlier sections of this file have already stored
  -- handles in the same round, so the reported count is the real total.
  ASSERT (v ->> 'round_handles')::int >= 4000, v::text;
  ASSERT (SELECT next_link_ciphertext IS DISTINCT FROM 'NX2'
          FROM public.outlook_sync_state
           WHERE connection_id = conn AND folder = 'inbox'),
    'and must not commit the cursor';

  -- Removing the parent removes the filler handles: the cascade again.
  DELETE FROM public.outlook_conversation_progress
   WHERE connection_id = conn AND round_id = round AND conversation_fingerprint = pad;
  ASSERT (SELECT count(*) FROM public.outlook_round_messages
           WHERE connection_id = conn AND round_id = round
             AND conversation_fingerprint = pad) = 0,
    'the cascade removes the filler handles with their parent';
END $$;

-- ══ 4. THE RESPONSE FITS THE REAL PORT, AT MAXIMUM CIPHERTEXT ═══════════════
DO $$
DECLARE
  u     uuid := '55555555-5555-5555-5555-555555555555';
  conn  uuid := '66666666-6666-6666-6666-666666666666';
  run2  uuid := '88888888-8888-8888-8888-888888888888';
  round uuid := '99999999-9999-9999-9999-999999999999';
  big   text := repeat('bb', 32);
  maxct text := repeat('Z', 1024);      -- the CHECK ceiling, exactly
  v     jsonb;
  bytes integer;
  c     jsonb;
  total integer;
  calls integer := 1;
BEGIN
  INSERT INTO public.outlook_conversation_progress
    (connection_id, user_id, round_id, conversation_fingerprint, person_fingerprint,
     episode_fingerprint, first_message_fingerprint, key_version,
     first_seen_at, last_seen_at, inbound_count, outbound_count, message_count)
  VALUES (conn, u, round, big, repeat('cb', 32), repeat('db', 32), repeat('eb', 32),
          1, now(), now(), 1, 1, 2)
  ON CONFLICT DO NOTHING;

  -- 150 handles, every one at the MAXIMUM permitted ciphertext and nonce length.
  -- Short fixture strings hid this defect entirely.
  INSERT INTO public.outlook_round_messages
    (connection_id, user_id, round_id, conversation_fingerprint, message_fingerprint,
     folder, sent_at, message_id_ciphertext, message_id_nonce, key_version)
  SELECT conn, u, round, big, lpad(g::text, 64, 'e'), 'inbox',
         now() + (g || ' seconds')::interval, maxct, repeat('n', 64), 1
    FROM generate_series(1, 150) g;

  v := public.list_outlook_round_message_handles(conn, run2, round, ARRAY[big], 150);
  ASSERT v ->> 'result' = 'ok', v::text;
  bytes := octet_length(v::text);
  RAISE NOTICE 'handle page: % handles, % bytes (port bound %)',
    jsonb_array_length(v -> 'handles'), bytes, 256 * 1024;

  ASSERT jsonb_array_length(v -> 'handles') = 20,
    'the response must cap at 20 handles: ' || jsonb_array_length(v -> 'handles')::text;
  ASSERT bytes < 256 * 1024, 'THE RESPONSE MUST FIT THE PORT: ' || bytes::text;
  ASSERT bytes < 64 * 1024, 'and with real margin: ' || bytes::text;
  ASSERT jsonb_array_length(
    (public.list_outlook_round_message_handles(conn, run2, round, ARRAY[big], 9999))
      -> 'handles') = 20, 'p_limit must be clamped to the cap';

  -- AND THE CALLER CAN MAKE PROGRESS: walk the keyset cursor to the end.
  c := v -> 'next_cursor';
  total := jsonb_array_length(v -> 'handles');
  ASSERT c IS NOT NULL AND jsonb_typeof(c) = 'object',
    'a full page must carry a continuation cursor';
  WHILE c IS NOT NULL AND jsonb_typeof(c) = 'object' AND calls < 30 LOOP
    v := public.list_outlook_round_message_handles(conn, run2, round, ARRAY[big], 20,
           c ->> 'cfp', (c ->> 'sent_at')::timestamptz, c ->> 'mfp');
    ASSERT v ->> 'result' = 'ok', v::text;
    ASSERT octet_length(v::text) < 64 * 1024, 'every page must fit';
    total := total + jsonb_array_length(v -> 'handles');
    c := v -> 'next_cursor';
    calls := calls + 1;
  END LOOP;
  RAISE NOTICE 'paged through % calls and read % of 150 handles', calls, total;
  ASSERT total = 150, 'paging must read every handle exactly once: ' || total::text;
  ASSERT c IS NULL OR jsonb_typeof(c) = 'null', 'the last page must end the walk';

  ASSERT (public.list_outlook_round_message_handles(conn, run2, round, ARRAY[big], 20,
            'nope', now(), repeat('e', 64)) ->> 'result') = 'invalid_cursor';
  ASSERT (public.list_outlook_round_message_handles(conn, run2, round, ARRAY[big], 20,
            repeat('e', 64), NULL, repeat('e', 64)) ->> 'result') = 'invalid_cursor';

  DELETE FROM public.outlook_conversation_progress
   WHERE connection_id = conn AND round_id = round AND conversation_fingerprint = big;
END $$;

-- ══ what the read returns, and what it never stores ═════════════════════════
DO $$
DECLARE
  conn  uuid := '66666666-6666-6666-6666-666666666666';
  run2  uuid := '88888888-8888-8888-8888-888888888888';
  round uuid := '99999999-9999-9999-9999-999999999999';
  cfp   text := repeat('c', 64);
  v     jsonb;
  many  text[];
BEGIN
  v := public.list_outlook_round_message_handles(conn, run2, round, ARRAY[cfp]);
  ASSERT v ->> 'result' = 'ok', v::text;
  ASSERT jsonb_array_length(v -> 'handles') = 6, 'the six selected handles: ' || v::text;
  -- Chronological, so the content stage reads the exchange in order.
  ASSERT (v -> 'handles' -> 0 ->> 'sent_at') < (v -> 'handles' -> 5 ->> 'sent_at');
  ASSERT (v -> 'handles' -> 0 ? 'mid_nonce'), 'the nonce is needed to decrypt';
  ASSERT NOT (v -> 'handles' -> 0 ? 'subject'), 'no subject is stored or returned';
  ASSERT NOT (v -> 'handles' -> 0 ? 'address'), 'no address is stored or returned';
  ASSERT NOT (v -> 'handles' -> 0 ? 'body'), 'no body is stored or returned';
  ASSERT (v -> 'next_cursor') IS NULL OR jsonb_typeof(v -> 'next_cursor') = 'null',
    'a short page must not carry a cursor';

  -- FAILED FETCHES: a conversation with no handles reads as EMPTY, not missing,
  -- which is what lets the content stage defer rather than guess.
  v := public.list_outlook_round_message_handles(conn, run2, round, ARRAY[repeat('0f', 32)]);
  ASSERT v ->> 'result' = 'ok' AND jsonb_array_length(v -> 'handles') = 0, v::text;

  ASSERT (public.list_outlook_round_message_handles(conn,
            '12121212-1212-1212-1212-121212121212', round, ARRAY[cfp])
          ->> 'result') = 'stale_run';
  ASSERT (public.list_outlook_round_message_handles(conn, run2, round, ARRAY['nope'])
          ->> 'result') = 'invalid_fingerprint';
  SELECT array_agg(repeat('a', 64)) INTO many FROM generate_series(1, 26);
  ASSERT (public.list_outlook_round_message_handles(conn, run2, round, many)
          ->> 'result') = 'too_many_conversations';
END $$;

-- ══ EXPIRY refuses, and deletes NOTHING ════════════════════════════════════
DO $$
DECLARE
  conn  uuid := '66666666-6666-6666-6666-666666666666';
  run2  uuid := '88888888-8888-8888-8888-888888888888';
  round uuid := '99999999-9999-9999-9999-999999999999';
  cfp   text := repeat('c', 64);
  kept  integer;
BEGIN
  SELECT count(*) INTO kept FROM public.outlook_round_messages
   WHERE connection_id = conn AND round_id = round;
  ASSERT kept > 0, 'there must be handles to refuse';

  UPDATE public.outlook_sync_state SET round_expires_at = now() - interval '1 minute'
   WHERE connection_id = conn;
  ASSERT (public.list_outlook_round_message_handles(conn, run2, round, ARRAY[cfp])
          ->> 'result') = 'round_expired', 'an expired round must refuse its handles';

  -- REFUSED, NOT DELETED. Reaching the deadline deletes NOTHING and nothing is
  -- scheduled to sweep it, so an abandoned connection's handles persist until the
  -- next run supersedes the round, a reset runs, or the account disconnects.
  ASSERT (SELECT count(*) FROM public.outlook_round_messages
           WHERE connection_id = conn AND round_id = round) = kept,
    'EXPIRY MUST NOT DELETE - a later action does that';

  UPDATE public.outlook_sync_state SET round_expires_at = NULL WHERE connection_id = conn;
  ASSERT (public.list_outlook_round_message_handles(conn, run2, round, ARRAY[cfp])
          ->> 'result') = 'round_expired', 'a NULL deadline is expired';
  UPDATE public.outlook_sync_state SET round_expires_at = now() + interval '1 hour'
   WHERE connection_id = conn;
  ASSERT (public.list_outlook_round_message_handles(conn, run2,
            '00000000-0000-0000-0000-0000000000ff', ARRAY[cfp])
          ->> 'result') = 'round_expired', 'an unknown round is refused, not served';
END $$;

-- ══ 1 (continued). EVERY ROUND-LIFECYCLE DELETE REMOVES THE HANDLES ═════════
DO $$
DECLARE
  u     uuid := '55555555-5555-5555-5555-555555555555';
  conn  uuid := '66666666-6666-6666-6666-666666666666';
  round uuid := '99999999-9999-9999-9999-999999999999';
  kept  integer;
BEGIN
  SELECT count(*) INTO kept FROM public.outlook_round_messages WHERE user_id = u;
  ASSERT kept > 0, 'there must be handles for the cascade to remove';

  -- THE ACCUMULATOR DELETE. This single statement is what complete release
  -- (release_outlook_sync_lease), reset_outlook_round and both of
  -- record_outlook_page_progress's round-supersede paths all perform. Before the
  -- fix it left 6 orphan handles behind.
  DELETE FROM public.outlook_conversation_progress
   WHERE connection_id = conn AND round_id = round;
  ASSERT (SELECT count(*) FROM public.outlook_round_messages
           WHERE connection_id = conn AND round_id = round) = 0,
    'EVERY ROUND-LIFECYCLE DELETE MUST REMOVE THE HANDLES';
END $$;

-- ══ DISCONNECT removes everything, by cascade ══════════════════════════════
DO $$
DECLARE
  u     uuid := '55555555-5555-5555-5555-555555555555';
  conn  uuid := '66666666-6666-6666-6666-666666666666';
  run   uuid := 'aaaaaaaa-1111-1111-1111-111111111111';
  round uuid := 'bbbbbbbb-1111-1111-1111-111111111111';
  cfp   text := repeat('7d', 32);
BEGIN
  UPDATE public.outlook_sync_state
     SET sync_run_id = run, round_id = round,
         sync_lease_until = now() + interval '7 minutes'
   WHERE connection_id = conn;
  INSERT INTO public.outlook_conversation_progress
    (connection_id, user_id, round_id, conversation_fingerprint, person_fingerprint,
     episode_fingerprint, first_message_fingerprint, key_version,
     first_seen_at, last_seen_at, inbound_count, outbound_count, message_count)
  VALUES (conn, u, round, cfp, repeat('8e', 32), repeat('9f', 32), repeat('0a', 32),
          1, now(), now(), 1, 1, 2);
  INSERT INTO public.outlook_round_messages
    (connection_id, user_id, round_id, conversation_fingerprint, message_fingerprint,
     folder, sent_at, message_id_ciphertext, message_id_nonce, key_version)
  VALUES (conn, u, round, cfp, repeat('1b', 32), 'inbox', now(), 'CT', 'N', 1);
  ASSERT (SELECT count(*) FROM public.outlook_round_messages WHERE user_id = u) = 1;

  DELETE FROM public.microsoft_connections WHERE id = conn;
  ASSERT (SELECT count(*) FROM public.outlook_round_messages WHERE user_id = u) = 0,
    'DISCONNECT MUST REMOVE EVERY HANDLE - a retained id would outlive the grant';
  ASSERT (SELECT count(*) FROM public.outlook_conversation_progress WHERE user_id = u) = 0;
END $$;

-- ══ the storage contract, asserted structurally ════════════════════════════
DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'outlook_round_messages' AND con.conname = 'orm_round_conv_fk'
       AND con.confdeltype = 'c'),
    'the cascading FK to the accumulator is missing';
  -- It points at the PRE-EXISTING parent key; no new constraint was added there.
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'outlook_conversation_progress'
       AND con.conname = 'ocp_round_conv_unique' AND con.contype = 'u'),
    'the parent key must be the pre-existing ocp_round_conv_unique';
  ASSERT (SELECT pg_get_constraintdef(oid) LIKE '%1024%' FROM pg_constraint
           WHERE conname = 'orm_ct_bounds'),
    'the ciphertext ceiling must be 1024, not 4000';

  ASSERT has_table_privilege('service_role', 'public.outlook_round_messages', 'SELECT');
  ASSERT NOT has_table_privilege('authenticated', 'public.outlook_round_messages', 'SELECT'),
    'a user must never read stored message ids';
  ASSERT NOT has_table_privilege('anon', 'public.outlook_round_messages', 'SELECT');
  ASSERT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'public.outlook_round_messages'::regclass), 'RLS must be enabled';
  ASSERT has_function_privilege('service_role',
    'public.list_outlook_round_message_handles(uuid,uuid,uuid,text[],integer,text,timestamptz,text)',
    'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated',
    'public.list_outlook_round_message_handles(uuid,uuid,uuid,text[],integer,text,timestamptz,text)',
    'EXECUTE'), 'a user must never read handles';
  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'record_outlook_page_progress') = 1,
    'the 15-argument overload must be gone';
  ASSERT (SELECT attnotnull FROM pg_attribute
           WHERE attrelid = 'public.outlook_round_messages'::regclass
             AND attname = 'sent_at'),
    'sent_at must be NOT NULL, or the selection is non-deterministic';
END $$;

-- ══ teardown ════════════════════════════════════════════════════════════════
DO $$
DECLARE
  u uuid := '55555555-5555-5555-5555-555555555555';
BEGIN
  DELETE FROM public.outlook_round_messages        WHERE user_id = u;
  DELETE FROM public.outlook_conversation_progress WHERE user_id = u;
  DELETE FROM public.contacts                      WHERE user_id = u;
  DELETE FROM public.microsoft_connections         WHERE user_id = u;
  -- auth.users and public.profiles are a SHARED fixture across these suites and
  -- are deliberately left alone; deleting them broke a sibling suite once.
END $$;

\echo 'outlook-round-retrieval-runtime: ALL ASSERTIONS PASSED'
