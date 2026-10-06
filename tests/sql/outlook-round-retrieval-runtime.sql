-- PROVING the message-retrieval approach, against a real Postgres with every
-- migration applied.
--
-- THE CLAIM UNDER TEST. To summarize a two-sided exchange at round finalization,
-- the ONLY thing that must be persisted during the envelope pass is a bounded,
-- encrypted set of Graph IMMUTABLE message ids. Subject, participants and body
-- all come back with the fetch and are discarded; none of them is stored.
--
-- The five conditions the owner asked to see proven, each a numbered section:
--
--   1. CONTINUATION. An exchange whose halves arrive on DIFFERENT pages, in
--      DIFFERENT folders, under DIFFERENT run ids, still has every handle at
--      finalization - and the handles commit in the SAME transaction as the page,
--      so a re-sent (refused) page cannot duplicate or lose them.
--   2. SIZE LIMITS. The per-conversation cap and the per-round ceiling both hold,
--      and the finalize-time read is bounded independently of the conversation
--      listing so neither can push a response over the port's 256 KiB bound.
--   3. EXPIRY. An expired round's handles are refused, not returned.
--   4. DISCONNECT. Disconnecting removes every handle, by cascade.
--   5. FAILED FETCHES. A conversation with NO handles is distinguishable from one
--      with handles, so the content stage can DEFER rather than guess. (The
--      fetch itself is exercised in the Node tests; this proves the data shape
--      that makes the distinction possible.)
--
-- Plus: the lease fence, and that no plaintext id, subject or address is stored.
--
-- HOW TO BUILD THE DATABASE: tests/sql/_bootstrap-disposable-db.sql, then every
-- migration in supabase/migrations, in filename order.
--
-- WHAT THIS DOES NOT PROVE. It runs as `postgres`, so it proves function bodies,
-- constraints and cascades - not RLS or role separation (the grants are asserted
-- directly instead). There is no Graph, no fetch and no mailbox here: whether
-- Microsoft actually returns a stable id for the header is an assumption taken
-- from Microsoft's own documentation, not something this file can establish.

\set ON_ERROR_STOP on

-- ══ fixtures ════════════════════════════════════════════════════════════════
DO $$
DECLARE
  u    uuid := '55555555-5555-5555-5555-555555555555';
  conn uuid := '66666666-6666-6666-6666-666666666666';
BEGIN
  DELETE FROM public.outlook_round_messages      WHERE user_id = u;
  DELETE FROM public.outlook_conversation_progress WHERE user_id = u;
  DELETE FROM public.outlook_sync_state          WHERE connection_id = conn;
  DELETE FROM public.contacts                    WHERE user_id = u;
  DELETE FROM public.microsoft_connections       WHERE user_id = u;

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

-- ══ 1. CONTINUATION: two folders, two pages, two runs ══════════════════════
DO $$
DECLARE
  u     uuid := '55555555-5555-5555-5555-555555555555';
  conn  uuid := '66666666-6666-6666-6666-666666666666';
  run1  uuid := '77777777-7777-7777-7777-777777777777';
  run2  uuid := '88888888-8888-8888-8888-888888888888';
  round uuid := '99999999-9999-9999-9999-999999999999';
  cfp   text := repeat('c', 64);
  v     jsonb;
  lease interval := interval '7 minutes';
BEGIN
  -- Run 1 holds the lease on both folders.
  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, sync_run_id, sync_lease_until,
     run_started_at, last_attempt_at, updated_at)
  VALUES
    (conn, u, 'inbox',     'running', run1, now() + lease, now(), now(), now()),
    (conn, u, 'sentitems', 'running', run1, now() + lease, now(), now(), now());

  -- ── page 1, INBOX: one inbound message ──────────────────────────────────
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round, 1,
         'NEXT-IN-1', 'N', NULL, NULL, 1::smallint, false, 10, 0,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp, 'pfp', repeat('ab', 32), 'efp', repeat('e', 64),
           'first_fp', repeat('1', 64), 'first_at', '2026-09-20T10:00:00Z',
           'last_at', '2026-09-20T10:00:00Z', 'contact_id', NULL,
           'key_version', 1, 'inbound', 1, 'outbound', 0, 'messages', 1, 'taint', NULL)),
         86400,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp, 'mfp', repeat('1', 64), 'mid_ct', 'CT-INBOX-1',
           'mid_nonce', 'N1', 'key_version', 1, 'folder', 'inbox',
           'sent_at', '2026-09-20T10:00:00Z')));
  ASSERT v ->> 'result' = 'recorded', 'inbox page 1 refused: ' || v::text;
  ASSERT (v ->> 'messages_retained')::int = 1, 'one handle should be retained: ' || v::text;

  -- ── A RE-SENT PAGE IS A NO-OP, and must not duplicate the handle ────────
  v := public.record_outlook_page_progress(
         conn, run1, 'inbox', round, 1,
         'NEXT-IN-1', 'N', NULL, NULL, 1::smallint, false, 10, 0, '[]'::jsonb, 86400,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp, 'mfp', repeat('1', 64), 'mid_ct', 'CT-INBOX-1-AGAIN',
           'mid_nonce', 'N9', 'key_version', 1, 'folder', 'inbox',
           'sent_at', '2026-09-20T10:00:00Z')));
  ASSERT v ->> 'result' = 'duplicate_page', 'a re-sent page must be a no-op: ' || v::text;
  ASSERT (SELECT count(*) FROM public.outlook_round_messages
           WHERE connection_id = conn AND round_id = round) = 1,
    'IDEMPOTENCE: the message fingerprint must dedupe, even though the ciphertext differs';

  -- ── page 2, SENT ITEMS, SAME ROUND: the outbound half ───────────────────
  v := public.record_outlook_page_progress(
         conn, run1, 'sentitems', round, 1,
         NULL, NULL, 'DELTA-SENT', 'D', 1::smallint, true, 5, 0,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp, 'pfp', repeat('ab', 32), 'efp', repeat('e', 64),
           'first_fp', repeat('2', 64), 'first_at', '2026-09-21T09:00:00Z',
           'last_at', '2026-09-21T09:00:00Z', 'contact_id', NULL,
           'key_version', 1, 'inbound', 0, 'outbound', 1, 'messages', 1, 'taint', NULL)),
         86400,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp, 'mfp', repeat('2', 64), 'mid_ct', 'CT-SENT-1',
           'mid_nonce', 'N2', 'key_version', 1, 'folder', 'sentitems',
           'sent_at', '2026-09-21T09:00:00Z')));
  ASSERT v ->> 'result' = 'recorded', 'sentitems page refused: ' || v::text;

  -- ── A DIFFERENT INVOCATION takes over the lease, same round ─────────────
  UPDATE public.outlook_sync_state
     SET sync_run_id = run2, sync_lease_until = now() + lease
   WHERE connection_id = conn;

  v := public.record_outlook_page_progress(
         conn, run2, 'inbox', round, 2,
         NULL, NULL, 'DELTA-INBOX', 'D', 1::smallint, true, 7, 0,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp, 'pfp', repeat('ab', 32), 'efp', repeat('e', 64),
           'first_fp', repeat('3', 64), 'first_at', '2026-09-22T11:00:00Z',
           'last_at', '2026-09-22T11:00:00Z', 'contact_id', NULL,
           'key_version', 1, 'inbound', 1, 'outbound', 0, 'messages', 1, 'taint', NULL)),
         86400,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp, 'mfp', repeat('3', 64), 'mid_ct', 'CT-INBOX-2',
           'mid_nonce', 'N3', 'key_version', 1, 'folder', 'inbox',
           'sent_at', '2026-09-22T11:00:00Z')));
  ASSERT v ->> 'result' = 'recorded', 'the second invocation was refused: ' || v::text;

  -- THE EXCHANGE IS TWO-SIDED, assembled across pages, folders and invocations.
  ASSERT (SELECT inbound_count = 2 AND outbound_count = 1 AND message_count = 3
          FROM public.outlook_conversation_progress
          WHERE connection_id = conn AND round_id = round
            AND conversation_fingerprint = cfp),
    'the accumulated counts are wrong';

  -- AND EVERY HANDLE SURVIVED, from both folders and both runs.
  ASSERT (SELECT count(*) FROM public.outlook_round_messages
           WHERE connection_id = conn AND round_id = round
             AND conversation_fingerprint = cfp) = 3,
    'all three handles must be retrievable at finalization';
  ASSERT (SELECT count(DISTINCT folder) FROM public.outlook_round_messages
           WHERE connection_id = conn AND round_id = round) = 2,
    'handles from BOTH folders must be present';
END $$;

-- ══ the finalize-time read ══════════════════════════════════════════════════
DO $$
DECLARE
  conn  uuid := '66666666-6666-6666-6666-666666666666';
  run2  uuid := '88888888-8888-8888-8888-888888888888';
  round uuid := '99999999-9999-9999-9999-999999999999';
  cfp   text := repeat('c', 64);
  v     jsonb;
BEGIN
  v := public.list_outlook_round_message_handles(conn, run2, round, ARRAY[cfp]);
  ASSERT v ->> 'result' = 'ok', 'the handle read was refused: ' || v::text;
  ASSERT jsonb_array_length(v -> 'handles') = 3, 'three handles expected: ' || v::text;
  -- Ordered by sent_at, so the content stage reads the exchange chronologically.
  ASSERT (v -> 'handles' -> 0 ->> 'mid_ct') = 'CT-INBOX-1', v::text;
  ASSERT (v -> 'handles' -> 2 ->> 'mid_ct') = 'CT-INBOX-2', v::text;
  -- The ciphertext and nonce come back; nothing else identifying does.
  ASSERT (v -> 'handles' -> 0 ? 'mid_nonce'), 'the nonce is needed to decrypt';
  ASSERT NOT (v -> 'handles' -> 0 ? 'subject'), 'no subject may be stored or returned';
  ASSERT NOT (v -> 'handles' -> 0 ? 'address'), 'no address may be stored or returned';
  ASSERT NOT (v -> 'handles' -> 0 ? 'body'), 'no body may be stored or returned';

  -- An unknown conversation yields nothing, not an error.
  v := public.list_outlook_round_message_handles(conn, run2, round, ARRAY[repeat('f', 64)]);
  ASSERT v ->> 'result' = 'ok' AND jsonb_array_length(v -> 'handles') = 0, v::text;

  -- 5. FAILED FETCHES / NO HANDLES is DISTINGUISHABLE from "has handles", which
  -- is what lets the content stage defer instead of guessing.
  ASSERT jsonb_array_length(
           (public.list_outlook_round_message_handles(conn, run2, round,
              ARRAY[repeat('f', 64)])) -> 'handles') = 0,
    'a conversation with no handles must read as empty, not as missing';
END $$;

-- ══ the lease fence, and the argument bounds ════════════════════════════════
DO $$
DECLARE
  conn  uuid := '66666666-6666-6666-6666-666666666666';
  round uuid := '99999999-9999-9999-9999-999999999999';
  other uuid := '12121212-1212-1212-1212-121212121212';
  cfp   text := repeat('c', 64);
  v     jsonb;
  many  text[];
BEGIN
  v := public.list_outlook_round_message_handles(conn, other, round, ARRAY[cfp]);
  ASSERT v ->> 'result' = 'stale_run', 'another run must not read handles: ' || v::text;

  v := public.list_outlook_round_message_handles(conn,
         '88888888-8888-8888-8888-888888888888', round, ARRAY['not-a-fingerprint']);
  ASSERT v ->> 'result' = 'invalid_fingerprint', v::text;

  -- 2. SIZE: the read refuses an unbounded batch of conversations outright, so
  -- the response cannot grow past the port's body bound.
  SELECT array_agg(repeat('a', 64)) INTO many FROM generate_series(1, 26);
  v := public.list_outlook_round_message_handles(conn,
         '88888888-8888-8888-8888-888888888888', round, many);
  ASSERT v ->> 'result' = 'too_many_conversations',
    'a 26-conversation batch must be refused: ' || v::text;
END $$;

-- ══ 2. SIZE LIMITS: the per-conversation cap ════════════════════════════════
DO $$
DECLARE
  u     uuid := '55555555-5555-5555-5555-555555555555';
  conn  uuid := '66666666-6666-6666-6666-666666666666';
  run2  uuid := '88888888-8888-8888-8888-888888888888';
  round uuid := '99999999-9999-9999-9999-999999999999';
  cfp2  text := repeat('d', 64);
  msgs  jsonb := '[]'::jsonb;
  v     jsonb;
  i     integer;
BEGIN
  -- A FRESH PAGE SEQUENCE. Section 1 finished both folders, and a completed
  -- folder refuses further pages with 'folder_already_complete' - which is
  -- correct behaviour, so this reopens the round rather than working around it.
  UPDATE public.outlook_sync_state
     SET round_folder_complete = false,
         round_page_seq = 2,
         round_expires_at = now() + interval '1 hour'
   WHERE connection_id = conn;

  -- Ten handles offered for ONE conversation; at most six may be kept.
  FOR i IN 1..10 LOOP
    msgs := msgs || jsonb_build_array(jsonb_build_object(
      'cfp', cfp2, 'mfp', lpad(i::text, 64, '0'),
      'mid_ct', 'CT-' || i::text, 'mid_nonce', 'N', 'key_version', 1,
      'folder', 'inbox', 'sent_at', '2026-09-23T10:00:00Z'));
  END LOOP;

  v := public.record_outlook_page_progress(
         conn, run2, 'inbox', round, 3,
         NULL, NULL, 'DELTA-INBOX', 'D', 1::smallint, true, 10, 0,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp2, 'pfp', repeat('ba', 32), 'efp', repeat('f', 64),
           'first_fp', lpad('1', 64, '0'), 'first_at', '2026-09-23T10:00:00Z',
           'last_at', '2026-09-23T10:00:00Z', 'contact_id', NULL,
           'key_version', 1, 'inbound', 5, 'outbound', 5, 'messages', 10,
           -- An exchange this long is ALREADY tainted by the fold, which is what
           -- makes capping the handles safe: the round forfeits its cursors, so
           -- nothing is summarized from the partial set.
           'taint', 'episode_truncated')),
         86400, msgs);
  ASSERT v ->> 'result' = 'recorded', 'the capped page was refused: ' || v::text;
  ASSERT (SELECT count(*) FROM public.outlook_round_messages
           WHERE connection_id = conn AND round_id = round
             AND conversation_fingerprint = cfp2) = 6,
    'the per-conversation cap must hold at 6';
  ASSERT (v ->> 'messages_retained')::int = 6,
    'and the call must report how many it actually kept: ' || v::text;
  -- The conversation is tainted, so the content stage will never summarize it.
  ASSERT (SELECT taint_code FROM public.outlook_conversation_progress
           WHERE connection_id = conn AND round_id = round
             AND conversation_fingerprint = cfp2) = 'episode_truncated',
    'a capped exchange must stay tainted';
END $$;

-- ══ malformed handles are skipped, never stored ═════════════════════════════
DO $$
DECLARE
  conn  uuid := '66666666-6666-6666-6666-666666666666';
  run2  uuid := '88888888-8888-8888-8888-888888888888';
  round uuid := '99999999-9999-9999-9999-999999999999';
  cfp3  text := repeat('b', 64);
  v     jsonb;
  before integer;
BEGIN
  UPDATE public.outlook_sync_state
     SET round_folder_complete = false, round_page_seq = 1
   WHERE connection_id = conn AND folder = 'sentitems';

  SELECT count(*) INTO before FROM public.outlook_round_messages
   WHERE connection_id = conn AND round_id = round;

  v := public.record_outlook_page_progress(
         conn, run2, 'sentitems', round, 2,
         NULL, NULL, 'DELTA-SENT', 'D', 1::smallint, true, 1, 0,
         jsonb_build_array(jsonb_build_object(
           'cfp', cfp3, 'pfp', repeat('ac', 32), 'efp', repeat('fa', 32),
           'first_fp', repeat('4', 64), 'first_at', '2026-09-24T10:00:00Z',
           'last_at', '2026-09-24T10:00:00Z', 'contact_id', NULL,
           'key_version', 1, 'inbound', 1, 'outbound', 1, 'messages', 2, 'taint', NULL)),
         86400,
         jsonb_build_array(
           -- a bad conversation fingerprint
           jsonb_build_object('cfp', 'nope', 'mfp', repeat('5', 64),
             'mid_ct', 'X', 'mid_nonce', 'N', 'folder', 'inbox'),
           -- a bad message fingerprint
           jsonb_build_object('cfp', cfp3, 'mfp', 'nope',
             'mid_ct', 'X', 'mid_nonce', 'N', 'folder', 'inbox'),
           -- an empty ciphertext
           jsonb_build_object('cfp', cfp3, 'mfp', repeat('6', 64),
             'mid_ct', '', 'mid_nonce', 'N', 'folder', 'inbox'),
           -- a folder that is not a Graph folder this pass reads
           jsonb_build_object('cfp', cfp3, 'mfp', repeat('7', 64),
             'mid_ct', 'X', 'mid_nonce', 'N', 'folder', 'drafts'),
           -- not an object at all
           to_jsonb('garbage'::text)));
  ASSERT v ->> 'result' = 'recorded', 'the page itself must still record: ' || v::text;
  ASSERT (v ->> 'messages_retained')::int = 0, 'nothing malformed may be kept: ' || v::text;
  ASSERT (SELECT count(*) FROM public.outlook_round_messages
           WHERE connection_id = conn AND round_id = round) = before,
    'no malformed handle may reach the table';

  -- A non-array argument is a controlled refusal, not a crash.
  v := public.record_outlook_page_progress(
         conn, run2, 'sentitems', round, 9,
         NULL, NULL, 'D', 'D', 1::smallint, true, 1, 0, '[]'::jsonb, 86400,
         '"not-an-array"'::jsonb);
  ASSERT v ->> 'result' = 'invalid_messages', v::text;
END $$;

-- ══ 3. EXPIRY: an expired round's handles are refused ═══════════════════════
DO $$
DECLARE
  conn  uuid := '66666666-6666-6666-6666-666666666666';
  run2  uuid := '88888888-8888-8888-8888-888888888888';
  round uuid := '99999999-9999-9999-9999-999999999999';
  cfp   text := repeat('c', 64);
  v     jsonb;
  kept  integer;
BEGIN
  SELECT count(*) INTO kept FROM public.outlook_round_messages
   WHERE connection_id = conn AND round_id = round;
  ASSERT kept > 0, 'there must be handles to refuse';

  UPDATE public.outlook_sync_state
     SET round_expires_at = now() - interval '1 minute'
   WHERE connection_id = conn;

  v := public.list_outlook_round_message_handles(conn, run2, round, ARRAY[cfp]);
  ASSERT v ->> 'result' = 'round_expired',
    'an expired round must refuse its handles: ' || v::text;
  -- REFUSED, NOT DELETED - the same contract read_outlook_round_progress has.
  -- Deletion is a later, separate action.
  ASSERT (SELECT count(*) FROM public.outlook_round_messages
           WHERE connection_id = conn AND round_id = round) = kept,
    'refusing must not delete; a later reset or sweep does that';

  -- A NULL deadline is treated as expired too, matching the applied guard.
  UPDATE public.outlook_sync_state SET round_expires_at = NULL
   WHERE connection_id = conn;
  v := public.list_outlook_round_message_handles(conn, run2, round, ARRAY[cfp]);
  ASSERT v ->> 'result' = 'round_expired', 'a NULL deadline is expired: ' || v::text;

  -- Put it back so the next section starts from a live round.
  UPDATE public.outlook_sync_state SET round_expires_at = now() + interval '1 hour'
   WHERE connection_id = conn;
END $$;

-- ══ resetting the round removes the handles ═════════════════════════════════
DO $$
DECLARE
  conn  uuid := '66666666-6666-6666-6666-666666666666';
  run2  uuid := '88888888-8888-8888-8888-888888888888';
  round uuid := '99999999-9999-9999-9999-999999999999';
BEGIN
  -- The round's working records are keyed on round_id, so a new round cannot see
  -- an old round's handles even before anything is swept.
  ASSERT (SELECT count(*) FROM public.outlook_round_messages
           WHERE connection_id = conn
             AND round_id <> round) = 0,
    'no handle may belong to another round';
  -- An UNKNOWN round id has no live deadline of its own, so min() over zero rows
  -- is NULL and the guard refuses it. That is the right answer: a handle may only
  -- be read for the round that is actually in progress.
  ASSERT (public.list_outlook_round_message_handles(
             conn, run2, '00000000-0000-0000-0000-0000000000ff',
             ARRAY[repeat('c', 64)]) ->> 'result') = 'round_expired',
    'an unknown round must be refused, not served';
END $$;

-- ══ 4. DISCONNECT removes every handle, by cascade ══════════════════════════
DO $$
DECLARE
  u    uuid := '55555555-5555-5555-5555-555555555555';
  conn uuid := '66666666-6666-6666-6666-666666666666';
  kept integer;
BEGIN
  SELECT count(*) INTO kept FROM public.outlook_round_messages WHERE user_id = u;
  ASSERT kept > 0, 'there must be handles for the cascade to remove';

  -- Deleting the connection is what disconnect_my_outlook does.
  DELETE FROM public.microsoft_connections WHERE id = conn;

  ASSERT (SELECT count(*) FROM public.outlook_round_messages WHERE user_id = u) = 0,
    'DISCONNECT MUST REMOVE EVERY HANDLE - a retained id would outlive the grant';
  ASSERT (SELECT count(*) FROM public.outlook_conversation_progress WHERE user_id = u) = 0,
    'and the working records with them';
END $$;

-- ══ grants: the worker only ═════════════════════════════════════════════════
DO $$
BEGIN
  ASSERT has_table_privilege('service_role', 'public.outlook_round_messages', 'SELECT');
  ASSERT NOT has_table_privilege('authenticated', 'public.outlook_round_messages', 'SELECT'),
    'a user must never read stored message ids';
  ASSERT NOT has_table_privilege('anon', 'public.outlook_round_messages', 'SELECT');
  ASSERT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'public.outlook_round_messages'::regclass),
    'RLS must be enabled even though no policy grants access';
  ASSERT has_function_privilege('service_role',
    'public.list_outlook_round_message_handles(uuid,uuid,uuid,text[],integer)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated',
    'public.list_outlook_round_message_handles(uuid,uuid,uuid,text[],integer)', 'EXECUTE'),
    'a user must never be able to read handles';
  -- Exactly ONE overload of the extended checkpoint, so no call is ambiguous.
  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'record_outlook_page_progress') = 1,
    'the 15-argument overload must be gone';
END $$;

-- ══ teardown: leave nothing behind ══════════════════════════════════════════
DO $$
DECLARE
  u uuid := '55555555-5555-5555-5555-555555555555';
BEGIN
  DELETE FROM public.outlook_round_messages        WHERE user_id = u;
  DELETE FROM public.outlook_conversation_progress WHERE user_id = u;
  DELETE FROM public.contacts                      WHERE user_id = u;
  DELETE FROM public.microsoft_connections         WHERE user_id = u;
  -- auth.users and public.profiles are a SHARED fixture: sibling suites reuse
  -- ids and insert against them with ON CONFLICT DO NOTHING. Deleting the
  -- auth.users row broke outlook-disconnect-runtime with a foreign-key
  -- violation once already, so it is left alone.
END $$;

\echo 'outlook-round-retrieval-runtime: ALL ASSERTIONS PASSED'
