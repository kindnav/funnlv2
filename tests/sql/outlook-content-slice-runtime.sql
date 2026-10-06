-- Runtime verification of the CONTENT SLICE's database path, against a real
-- Postgres with every migration applied.
--
-- WHAT IS PROVEN HERE, by executing the real functions rather than reading them:
--
--   1. KNOWN CONTACT, WITH A NOTE. upsert_outlook_interaction_candidate stores
--      proposed_notes, which is the column the Suggestions UI already edits and
--      the one the live pilot found empty.
--   2. THE NOTE IS NEVER BLANKED. A second run that reads no content (the
--      consent gate closed, a body fetch failed) refreshes the row and LEAVES
--      the earlier note in place.
--   3. UNKNOWN PERSON. upsert_new_contact_candidate creates a pending proposal
--      carrying the envelope address, the provider-metadata name with its
--      evidence, the note and the follow-up - plus the provenance ref row that
--      disconnect and invalidation reach it through.
--   4. NOTHING IS SAVED BEFORE ACCEPTANCE. After the proposal exists, contacts
--      and interactions are both still empty.
--   5. THE USER'S EDITS WIN. accept_new_contact_candidate creates the contact
--      AND the interaction atomically from the EDITED values, not the proposed
--      ones - and the address comes from the stored row, not the caller.
--   6. A DUPLICATE IS REFUSED, both when proposing and when accepting.
--   7. A NAME WITHOUT EVIDENCE IS REFUSED, so an unsourced value cannot reach a
--      reviewer looking authoritative.
--   8. A TERMINAL PROPOSAL IS NEVER RE-PROPOSED.
--   9. THE LEASE FENCE HOLDS for both producers.
--
-- HOW TO BUILD THE DATABASE THIS NEEDS: tests/sql/_bootstrap-disposable-db.sql,
-- then every migration in supabase/migrations, in filename order.
--
-- WHAT THIS DOES NOT PROVE. It runs as the privileged `postgres` role, so it
-- proves the function bodies and the constraints, not RLS or role separation
-- (tests/sql/outlook-user-rpc-grants-runtime.sql covers the grants). There is no
-- JWT, no PostgREST, no browser and no mailbox. The accept RPCs read auth.uid(),
-- so this file sets request.jwt.claims to impersonate the owner - which is the
-- same mechanism PostgREST uses, but it is not a proof that a real session maps
-- to it. And it says nothing about PRODUCTION, where this migration is
-- UNAPPLIED.

\set ON_ERROR_STOP on

-- ══ fixtures ════════════════════════════════════════════════════════════════
DO $$
DECLARE
  u    uuid := '11111111-1111-1111-1111-111111111111';
  conn uuid := '22222222-2222-2222-2222-222222222222';
  run  uuid := '33333333-3333-3333-3333-333333333333';
BEGIN
  -- A clean slate for this file, so it is order independent.
  DELETE FROM public.outlook_candidate_refs    WHERE user_id = u;
  DELETE FROM public.new_contact_candidates    WHERE user_id = u;
  DELETE FROM public.interaction_candidates    WHERE user_id = u;
  DELETE FROM public.interactions              WHERE user_id = u;
  DELETE FROM public.contacts                  WHERE user_id = u;
  DELETE FROM public.outlook_sync_state        WHERE connection_id = conn;
  DELETE FROM public.microsoft_connections     WHERE user_id = u;

  INSERT INTO auth.users (id, email) VALUES (u, 'pilot@getfunnl.test')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, email) VALUES (u, 'pilot@getfunnl.test')
    ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.microsoft_connections
    (id, user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
     status, needs_reauth, consented_at, consent_policy_version)
  VALUES
    (conn, u, 'acct-1', '9188040d-6c67-4c5b-b112-36a304b66dad', 'personal',
     'pilot@outlook.test', ARRAY['Mail.Read','User.Read','offline_access'],
     'active', false, now(), 'ol-disc-81fe8944fd2be59ac3c059c229b4d28e');

  -- BOTH folder rows leased to the same live run: the fence both producers check.
  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, sync_run_id, sync_lease_until,
     run_started_at, last_attempt_at, updated_at)
  VALUES
    (conn, u, 'inbox',     'running', run, now() + interval '7 minutes', now(), now(), now()),
    (conn, u, 'sentitems', 'running', run, now() + interval '7 minutes', now(), now(), now());

  -- One EXISTING contact, for the known-contact path and the duplicate case.
  INSERT INTO public.contacts (user_id, name, email)
  VALUES (u, 'Ava Recruiter', 'ava@bank.test');
END $$;

-- ══ 1. known contact: the note is stored ════════════════════════════════════
DO $$
DECLARE
  u    uuid := '11111111-1111-1111-1111-111111111111';
  conn uuid := '22222222-2222-2222-2222-222222222222';
  run  uuid := '33333333-3333-3333-3333-333333333333';
  cid  uuid;
  res  jsonb;
  note text := 'Email thread "Summer analyst referral". 4 messages, 2 from them and 2 from you. Last on 2026-10-01, from them.';
BEGIN
  SELECT id INTO cid FROM public.contacts WHERE user_id = u AND email = 'ava@bank.test';

  res := public.upsert_outlook_interaction_candidate(
    conn, run, cid, repeat('a', 64), repeat('b', 64), 1::smallint,
    'Email', DATE '2026-10-01', NULL, note);
  ASSERT res->>'result' = 'created', 'known contact must be created: ' || res::text;

  ASSERT (SELECT proposed_notes FROM public.interaction_candidates
           WHERE id = (res->>'candidate_id')::uuid) = note,
    'THE NOTE MUST BE STORED - this is the empty-note defect';
  ASSERT (SELECT status FROM public.interaction_candidates
           WHERE id = (res->>'candidate_id')::uuid) = 'pending',
    'a suggestion is pending, never auto-accepted';
  -- Nothing was saved as a real record.
  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u) = 0,
    'NO interaction may exist before acceptance';
END $$;

-- ══ 2. a later run with no content must not blank the note ══════════════════
DO $$
DECLARE
  u    uuid := '11111111-1111-1111-1111-111111111111';
  conn uuid := '22222222-2222-2222-2222-222222222222';
  run  uuid := '33333333-3333-3333-3333-333333333333';
  cid  uuid;
  res  jsonb;
  kept text;
BEGIN
  SELECT id INTO cid FROM public.contacts WHERE user_id = u AND email = 'ava@bank.test';

  -- The 9-argument call shape, exactly as the pre-content worker made it.
  res := public.upsert_outlook_interaction_candidate(
    conn, run, cid, repeat('a', 64), repeat('b', 64), 1::smallint,
    'Email', DATE '2026-10-02', NULL);
  ASSERT res->>'result' = 'refreshed', 'the same episode refreshes: ' || res::text;

  SELECT proposed_notes INTO kept FROM public.interaction_candidates
   WHERE id = (res->>'candidate_id')::uuid;
  ASSERT kept IS NOT NULL AND kept LIKE 'Email thread%',
    'a no-content run must NOT blank an existing note';
  ASSERT (SELECT proposed_interaction_date FROM public.interaction_candidates
           WHERE id = (res->>'candidate_id')::uuid) = DATE '2026-10-02',
    'the date still refreshes';

  -- An over-long note is REFUSED, not trimmed.
  res := public.upsert_outlook_interaction_candidate(
    conn, run, cid, repeat('a', 64), repeat('b', 64), 1::smallint,
    'Email', DATE '2026-10-02', NULL, repeat('x', 201));
  ASSERT res->>'result' = 'invalid_notes', 'an over-long note must be refused: ' || res::text;
END $$;

-- ══ 3. unknown person: the proposal, with its provenance ref ════════════════
DO $$
DECLARE
  u    uuid := '11111111-1111-1111-1111-111111111111';
  conn uuid := '22222222-2222-2222-2222-222222222222';
  run  uuid := '33333333-3333-3333-3333-333333333333';
  res  jsonb;
  c    public.new_contact_candidates%ROWTYPE;
BEGIN
  res := public.upsert_new_contact_candidate(
    conn, run, repeat('c', 64), repeat('d', 64), 1::smallint,
    'Priya.Sharma@Goldman.test', DATE '2026-09-28',
    'Priya Sharma', 'provider_metadata', 'high',
    'Email thread "Coffee chat follow-up". 2 messages, 1 from them and 1 from you. Last on 2026-09-28, from them.',
    'Reply to their last message on "Coffee chat follow-up".',
    'Coffee chat follow-up');
  ASSERT res->>'result' = 'created', 'the unknown person must be proposed: ' || res::text;

  SELECT * INTO c FROM public.new_contact_candidates WHERE id = (res->>'candidate_id')::uuid;
  ASSERT c.status = 'pending', 'a proposal is pending, never auto-accepted';
  ASSERT c.proposed_email = 'priya.sharma@goldman.test',
    'the envelope address is lowercased and stored';
  ASSERT c.proposed_name = 'Priya Sharma', 'the provider-metadata name is stored';
  ASSERT c.proposed_name_evidence = 'provider_metadata', 'with its evidence';
  ASSERT c.proposed_name_confidence = 'high', 'and its confidence';
  ASSERT c.draft_summary LIKE 'Email thread%', 'the note is stored';
  ASSERT c.draft_follow_up LIKE 'Reply to their last message%', 'the follow-up is stored';
  ASSERT c.retained_subject = 'Coffee chat follow-up', 'the bounded subject is retained';
  ASSERT c.extraction_status = 'deterministic', 'this slice is deterministic';
  ASSERT c.proposed_type = 'Email', 'and proposes an Email interaction';
  ASSERT c.context_expires_at > now(), 'the context has a deadline';

  -- The provenance row, which disconnect and invalidation reach the proposal through.
  ASSERT (SELECT count(*) FROM public.outlook_candidate_refs
           WHERE user_id = u AND new_contact_candidate_id = c.id
             AND interaction_candidate_id IS NULL
             AND connection_id = conn) = 1,
    'a new-contact proposal must carry exactly one provenance ref';

  -- 4. NOTHING IS SAVED BEFORE ACCEPTANCE.
  ASSERT (SELECT count(*) FROM public.contacts WHERE user_id = u) = 1,
    'only the pre-existing contact may exist';
  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u) = 0,
    'NO interaction may exist before acceptance';
END $$;

-- ══ 5. a name with no evidence is refused ═══════════════════════════════════
DO $$
DECLARE
  conn uuid := '22222222-2222-2222-2222-222222222222';
  run  uuid := '33333333-3333-3333-3333-333333333333';
  res  jsonb;
BEGIN
  res := public.upsert_new_contact_candidate(
    conn, run, repeat('e', 64), repeat('f', 64), 1::smallint,
    'nameless@firm.test', DATE '2026-09-28', 'Someone Guessed', NULL, NULL);
  ASSERT res->>'result' = 'invalid_name_evidence',
    'a name must arrive with its evidence: ' || res::text;

  res := public.upsert_new_contact_candidate(
    conn, run, repeat('e', 64), repeat('f', 64), 1::smallint,
    'nameless@firm.test', DATE '2026-09-28', 'Someone Guessed', 'provider_metadata', 'wild');
  ASSERT res->>'result' = 'invalid_name_confidence',
    'and with a confidence from the enum: ' || res::text;

  -- A URL in a drafted field is refused outright.
  res := public.upsert_new_contact_candidate(
    conn, run, repeat('e', 64), repeat('f', 64), 1::smallint,
    'nameless@firm.test', DATE '2026-09-28', NULL, NULL, NULL,
    'See https://evil.test for details');
  ASSERT res->>'result' = 'invalid_summary', 'a URL in the note is refused: ' || res::text;

  -- A malformed address is refused.
  res := public.upsert_new_contact_candidate(
    conn, run, repeat('e', 64), repeat('f', 64), 1::smallint,
    'not-an-address', DATE '2026-09-28');
  ASSERT res->>'result' = 'invalid_email', 'a malformed address is refused: ' || res::text;
END $$;

-- ══ 6. an existing contact is never proposed as new ═════════════════════════
DO $$
DECLARE
  conn uuid := '22222222-2222-2222-2222-222222222222';
  run  uuid := '33333333-3333-3333-3333-333333333333';
  res  jsonb;
BEGIN
  res := public.upsert_new_contact_candidate(
    conn, run, repeat('9', 64), repeat('8', 64), 1::smallint,
    'AVA@bank.test', DATE '2026-09-28', 'Ava Recruiter', 'provider_metadata', 'high');
  ASSERT res->>'result' = 'already_a_contact',
    'a known address is not a new contact: ' || res::text;
  ASSERT (SELECT count(*) FROM public.new_contact_candidates
           WHERE episode_fingerprint = repeat('9', 64)) = 0,
    'and no proposal row may be written for it';
END $$;

-- ══ 7. the lease fence ══════════════════════════════════════════════════════
DO $$
DECLARE
  u    uuid := '11111111-1111-1111-1111-111111111111';
  conn uuid := '22222222-2222-2222-2222-222222222222';
  cid  uuid;
  res  jsonb;
  other uuid := '44444444-4444-4444-4444-444444444444';
BEGIN
  SELECT id INTO cid FROM public.contacts WHERE user_id = u AND email = 'ava@bank.test';
  res := public.upsert_new_contact_candidate(
    conn, other, repeat('7', 64), repeat('6', 64), 1::smallint,
    'stranger@firm.test', DATE '2026-09-28');
  ASSERT res->>'result' = 'stale_run', 'another run may not write: ' || res::text;

  res := public.upsert_outlook_interaction_candidate(
    conn, other, cid, repeat('5', 64), repeat('4', 64), 1::smallint,
    'Email', DATE '2026-10-01', NULL, 'a note');
  ASSERT res->>'result' = 'stale_run', 'nor for a known contact: ' || res::text;
END $$;

-- ══ 8. acceptance: the USER'S EDITS create both records atomically ══════════
-- The accept RPC reads auth.uid(), so the owner is impersonated the way PostgREST
-- does it. This is the user action, and it is the FIRST point at which anything
-- is saved.
-- BOTH forms are set on purpose. The disposable Supabase image's auth.uid()
-- reads the SINGULAR `request.jwt.claim.sub`; PostgREST v14 in Production sets
-- the JSON `request.jwt.claims`. Setting only one makes auth.uid() return NULL
-- on one of the two, and the accept RPC then answers 'unauthenticated' - which
-- is what happened the first time this file was run.
SELECT set_config('request.jwt.claim.sub',
  '11111111-1111-1111-1111-111111111111', false);
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111')::text, false);

DO $$
DECLARE
  u    uuid := '11111111-1111-1111-1111-111111111111';
  cand uuid;
  res  jsonb;
  ct   public.contacts%ROWTYPE;
  it   public.interactions%ROWTYPE;
BEGIN
  SELECT id INTO cand FROM public.new_contact_candidates
   WHERE user_id = u AND proposed_email = 'priya.sharma@goldman.test';

  -- EDITED on review: a corrected name, a company and role the proposal never
  -- claimed, a rewritten note, a different date, and a follow-up date.
  res := public.accept_new_contact_candidate(
    cand,
    'Priya Sharma',                      -- p_name
    'Goldman Sachs',                     -- p_company   (user supplied)
    'Analyst',                           -- p_role      (user supplied)
    'Coffee chat',                       -- p_how_met
    NULL,                                -- p_linkedin_url
    ARRAY['recruiter','target firm'],    -- p_tags
    'Referral path',                     -- p_relationship_type
    'Met at the autumn careers fair.',   -- p_relationship_note
    true,                                -- p_create_interaction
    'Coffee chat',                       -- p_interaction_type (overrides 'Email')
    DATE '2026-09-29',                   -- p_interaction_date (overrides)
    'Edited by the user before saving.', -- p_interaction_notes (overrides the draft)
    DATE '2026-10-15');                  -- p_follow_up_date
  ASSERT res->>'result' = 'accepted', 'acceptance must succeed: ' || res::text;

  SELECT * INTO ct FROM public.contacts WHERE id = (res->>'contact_id')::uuid;
  ASSERT ct.user_id = u, 'the contact belongs to the owner';
  ASSERT ct.name = 'Priya Sharma', 'the edited name is saved';
  ASSERT ct.company = 'Goldman Sachs' AND ct.role = 'Analyst',
    'the user-supplied company and role are saved';
  ASSERT ct.email = 'priya.sharma@goldman.test',
    'THE ADDRESS COMES FROM THE STORED ROW, not the caller';
  ASSERT ct.relationship_type = 'Referral path', 'the relationship type is saved';
  ASSERT ct.tags @> ARRAY['recruiter'], 'the tags are saved';

  SELECT * INTO it FROM public.interactions WHERE id = (res->>'interaction_id')::uuid;
  ASSERT it.contact_id = ct.id, 'the interaction is attached to the new contact';
  ASSERT it.type = 'Coffee chat', 'THE USER''S TYPE WINS over the proposed Email';
  ASSERT it.interaction_date = DATE '2026-09-29', 'the user''s date wins';
  ASSERT it.notes = 'Edited by the user before saving.', 'THE USER''S NOTE WINS';
  ASSERT it.follow_up_date = DATE '2026-10-15', 'the follow-up date is saved';
  ASSERT it.source = 'outlook', 'and the interaction is attributed to Outlook';

  -- The proposal is spent and its drafted content erased.
  ASSERT (SELECT status FROM public.new_contact_candidates WHERE id = cand) = 'accepted';
  ASSERT (SELECT proposed_email IS NULL AND proposed_name IS NULL
                 AND draft_summary IS NULL AND draft_follow_up IS NULL
                 AND retained_subject IS NULL
          FROM public.new_contact_candidates WHERE id = cand),
    'the drafted content is erased on acceptance';

  -- Exactly two records were created in total, both by this one action.
  ASSERT (SELECT count(*) FROM public.contacts WHERE user_id = u) = 2;
  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u) = 1;
END $$;

-- ══ 9. a second acceptance is idempotent, and a duplicate is refused ════════
DO $$
DECLARE
  u    uuid := '11111111-1111-1111-1111-111111111111';
  conn uuid := '22222222-2222-2222-2222-222222222222';
  run  uuid := '33333333-3333-3333-3333-333333333333';
  cand uuid;
  res  jsonb;
BEGIN
  SELECT id INTO cand FROM public.new_contact_candidates
   WHERE user_id = u AND status = 'accepted' LIMIT 1;
  res := public.accept_new_contact_candidate(cand, 'Priya Sharma');
  ASSERT res->>'result' = 'already_accepted',
    'accepting twice must not create a second contact: ' || res::text;
  ASSERT (SELECT count(*) FROM public.contacts WHERE user_id = u) = 2,
    'and no second contact appeared';

  -- 8. the spent episode is never re-proposed.
  res := public.upsert_new_contact_candidate(
    conn, run, repeat('c', 64), repeat('d', 64), 1::smallint,
    'priya.sharma@goldman.test', DATE '2026-10-05');
  -- The address is now a contact, so the duplicate check answers first - which is
  -- the stronger refusal of the two.
  ASSERT res->>'result' = 'already_a_contact',
    'the accepted person is now a known contact: ' || res::text;

  -- And an episode whose proposal was DISMISSED is tombstoned on the episode key.
  INSERT INTO public.new_contact_candidates
    (user_id, source, status, person_fingerprint, episode_fingerprint, key_version,
     proposed_email, proposed_interaction_date, proposed_type, context_expires_at)
  VALUES
    (u, 'outlook', 'dismissed', repeat('1', 64), repeat('2', 64), 1,
     NULL, DATE '2026-09-20', 'Email', NULL);
  res := public.upsert_new_contact_candidate(
    conn, run, repeat('2', 64), repeat('1', 64), 1::smallint,
    'dismissed.person@firm.test', DATE '2026-09-28');
  ASSERT res->>'result' = 'exists_terminal',
    'a dismissed episode is never proposed again: ' || res::text;
END $$;

SELECT set_config('request.jwt.claim.sub', NULL, false);
SELECT set_config('request.jwt.claims', NULL, false);

-- ══ teardown: leave the database exactly as it was found ════════════════════
-- ORDER INDEPENDENCE, and it is not optional. Several sibling suites assert a
-- CLEAN starting state - outlook-user-rpc-grants-runtime wants "zero Outlook
-- rows", outlook-content-draft-runtime wants "new_contact_candidates not
-- empty" to be false, and outlook-disconnect-runtime wants its own contact to
-- be the only one. Running this file first and leaving its rows behind failed
-- all three, which is how this teardown came to exist. The cascades do most of
-- the work; the connection and sync state are removed explicitly because they
-- are keyed on the connection, not the user.
DO $$
DECLARE
  u    uuid := '11111111-1111-1111-1111-111111111111';
  conn uuid := '22222222-2222-2222-2222-222222222222';
BEGIN
  DELETE FROM public.outlook_candidate_refs WHERE user_id = u;
  DELETE FROM public.new_contact_candidates WHERE user_id = u;
  DELETE FROM public.interaction_candidates WHERE user_id = u;
  DELETE FROM public.interactions           WHERE user_id = u;
  DELETE FROM public.contacts               WHERE user_id = u;
  DELETE FROM public.outlook_sync_state     WHERE connection_id = conn;
  DELETE FROM public.microsoft_connections  WHERE user_id = u;
  -- auth.users AND public.profiles ARE LEFT ALONE, deliberately. They are a
  -- SHARED fixture: sibling suites reuse this same id and insert their own rows
  -- against it with ON CONFLICT DO NOTHING. Deleting the auth.users row made
  -- outlook-disconnect-runtime fail with a foreign-key violation on
  -- microsoft_connections_user_id_fkey, because its own connection insert then
  -- had no user to point at. Only the rows THIS file created are removed.

  ASSERT (SELECT count(*) FROM public.contacts WHERE user_id = u) = 0;
  ASSERT (SELECT count(*) FROM public.new_contact_candidates WHERE user_id = u) = 0;
  ASSERT (SELECT count(*) FROM public.interaction_candidates WHERE user_id = u) = 0;
  ASSERT (SELECT count(*) FROM public.outlook_candidate_refs WHERE user_id = u) = 0;
END $$;

-- ══ summary ═════════════════════════════════════════════════════════════════
SELECT 'contacts'              AS tbl, count(*) AS n FROM public.contacts
  WHERE user_id = '11111111-1111-1111-1111-111111111111'
UNION ALL SELECT 'interactions', count(*) FROM public.interactions
  WHERE user_id = '11111111-1111-1111-1111-111111111111'
UNION ALL SELECT 'interaction_candidates', count(*) FROM public.interaction_candidates
  WHERE user_id = '11111111-1111-1111-1111-111111111111'
UNION ALL SELECT 'new_contact_candidates', count(*) FROM public.new_contact_candidates
  WHERE user_id = '11111111-1111-1111-1111-111111111111'
UNION ALL SELECT 'candidate_refs', count(*) FROM public.outlook_candidate_refs
  WHERE user_id = '11111111-1111-1111-1111-111111111111'
ORDER BY 1;

\echo 'outlook-content-slice-runtime: ALL ASSERTIONS PASSED'
