-- Does accept_interaction_candidate refuse an EXPIRED Outlook suggestion?
--
-- THE CLAIM THAT WAS WRONG. An approval packet stated that "both acceptance RPCs
-- reject expired suggestions". `accept_new_contact_candidate` does. The claim about
-- `accept_interaction_candidate` was inferred from a grep for the 'expired' result
-- token, and both matches it found were in `defer_candidate` - a different function.
-- The interaction path never read `context_expires_at` at all.
--
-- WHAT THIS FILE DOES. Section 1 REPRODUCES that: an Outlook candidate 40 days past
-- its context deadline is accepted and an interaction is created. Section 1 is
-- written to FAIL once the guard is in place, so it is run against the unguarded
-- schema and then inverted - the inversion lives in section 2 onwards, which is what
-- ships.
--
-- SCOPE OF THE GUARD, deliberately narrow:
--   * `source = 'outlook'` only. Calendar and Gmail candidates are untouched: their
--     `context_expires_at` is NULL by design and a NULL-as-expired rule would refuse
--     every one of them.
--   * AFTER the terminal-status checks, so `already_accepted` idempotency is
--     unaffected - acceptance erases `context_expires_at` to NULL, and a row that has
--     already been accepted must keep answering `already_accepted` rather than
--     suddenly answering `expired`.
--   * Added by CREATE OR REPLACE in the UNAPPLIED forward migration. No applied
--     migration is edited, and CREATE OR REPLACE preserves the function's ACL.
--
-- Run as `postgres` against a disposable database with every migration applied.

\set ON_ERROR_STOP on

-- ══ fixtures ═══════════════════════════════════════════════════════════════
DO $$
DECLARE
  u1   uuid := '11111111-1111-1111-1111-111111111111';
  conn uuid := '22222222-2222-2222-2222-222222222222';
BEGIN
  -- Shared auth.users rows are NOT deleted: another runtime suite depends on them.
  INSERT INTO auth.users (id, email) VALUES (u1, 'expiry-pilot@getfunnl.test')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, email, ai_enabled)
  VALUES (u1, 'expiry-pilot@getfunnl.test', false)
  ON CONFLICT (id) DO NOTHING;

  DELETE FROM public.outlook_candidate_refs WHERE user_id = u1;
  DELETE FROM public.interaction_candidates WHERE user_id = u1;
  DELETE FROM public.interactions WHERE user_id = u1;
  DELETE FROM public.contacts WHERE user_id = u1;

  INSERT INTO public.contacts (id, user_id, name, email)
  VALUES ('33333333-3333-3333-3333-333333333333', u1, 'Ava Recruiter', 'ava@bank.test');
  INSERT INTO public.contacts (id, user_id, name, email)
  VALUES ('33333333-3333-3333-3333-333333333334', u1, 'Cal Contact', 'cal@firm.test');
END $$;

-- ══ 1. THE GUARD REFUSES AN EXPIRED OUTLOOK CANDIDATE ══════════════════════
-- Before the fix this section FAILED: the RPC answered 'accepted' and created an
-- interaction from a suggestion whose context deadline had passed 40 days earlier.
DO $$
DECLARE
  u1    uuid := '11111111-1111-1111-1111-111111111111';
  cand  uuid;
  res   jsonb;
  n     integer;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', u1::text, true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', u1::text)::text, true);

  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, proposed_notes, status, source_last_state,
     context_expires_at)
  VALUES
    (u1, '33333333-3333-3333-3333-333333333333', 'outlook', repeat('a', 64), 'Email',
     current_date - 45, 'A note from a round that finished weeks ago.', 'pending',
     'active', now() - interval '40 days')
  RETURNING id INTO cand;

  res := public.accept_interaction_candidate(cand, 'Email', current_date - 45,
                                             'The user tries to accept it anyway.');
  ASSERT res ->> 'result' = 'expired',
    'AN EXPIRED OUTLOOK SUGGESTION MUST BE REFUSED, got: ' || res::text;

  SELECT count(*) INTO n FROM public.interactions WHERE user_id = u1;
  ASSERT n = 0, 'NO interaction may be created for an expired suggestion, found ' || n;

  -- And the candidate is untouched: still pending, still carrying its note, so the
  -- refusal is not a disguised terminal transition.
  ASSERT (SELECT status FROM public.interaction_candidates WHERE id = cand) = 'pending',
    'the refusal must not change the status';
  ASSERT (SELECT proposed_notes IS NOT NULL FROM public.interaction_candidates
           WHERE id = cand),
    'and must not erase the note';

  DELETE FROM public.interaction_candidates WHERE id = cand;
END $$;

-- ══ 2. AN UNEXPIRED OUTLOOK CANDIDATE STILL ACCEPTS, WITH THE EDITS ════════
DO $$
DECLARE
  u1   uuid := '11111111-1111-1111-1111-111111111111';
  cand uuid;
  res  jsonb;
  row  public.interactions%ROWTYPE;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', u1::text, true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', u1::text)::text, true);

  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, proposed_notes, status, source_last_state,
     context_expires_at)
  VALUES
    (u1, '33333333-3333-3333-3333-333333333333', 'outlook', repeat('b', 64), 'Email',
     current_date - 2, 'The summary the worker prepared.', 'pending', 'active',
     now() + interval '30 days')
  RETURNING id INTO cand;

  -- The user edits all three reviewable fields.
  res := public.accept_interaction_candidate(cand, 'Coffee chat', current_date - 1,
                                             'What the user actually wrote.');
  ASSERT res ->> 'result' = 'accepted', 'an unexpired suggestion must accept: ' || res::text;

  SELECT * INTO row FROM public.interactions WHERE id = (res ->> 'interaction_id')::uuid;
  ASSERT row.type = 'Coffee chat', 'the user edit must win over the proposal: ' || row.type;
  ASSERT row.interaction_date = current_date - 1, 'and the edited date';
  ASSERT row.notes = 'What the user actually wrote.', 'and the edited note';
  ASSERT row.source = 'outlook', 'with the provenance preserved';

  -- The candidate is accepted and its context erased.
  ASSERT (SELECT status FROM public.interaction_candidates WHERE id = cand) = 'accepted';
  ASSERT (SELECT context_expires_at IS NULL FROM public.interaction_candidates
           WHERE id = cand),
    'acceptance erases the context deadline';

  -- ── IDEMPOTENCY IS UNCHANGED ───────────────────────────────────────────
  -- This is the case the guard's PLACEMENT protects. Acceptance set
  -- context_expires_at to NULL, and the guard treats NULL as expired - so a guard
  -- placed before the status checks would answer 'expired' here instead of
  -- 'already_accepted', turning a settled row into a permanently confusing one.
  res := public.accept_interaction_candidate(cand, 'Email', current_date, 'again');
  ASSERT res ->> 'result' = 'already_accepted',
    'an accepted row must keep answering already_accepted, got: ' || res::text;
  ASSERT (res ->> 'interaction_id')::uuid = row.id, 'and point at the same interaction';
  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u1) = 1,
    'and create no second interaction';

  DELETE FROM public.interactions WHERE user_id = u1;
  DELETE FROM public.interaction_candidates WHERE id = cand;
END $$;

-- ══ 3. CALENDAR AND GMAIL BEHAVIOUR IS UNCHANGED ═══════════════════════════
-- Their context_expires_at is NULL by design. A guard that read NULL as expired
-- without checking the source would refuse EVERY Calendar suggestion ever made.
DO $$
DECLARE
  u1   uuid := '11111111-1111-1111-1111-111111111111';
  cand uuid;
  res  jsonb;
  src  text;
  i    integer := 0;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', u1::text, true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', u1::text)::text, true);

  -- The fingerprints must be 64 HEX characters: interaction_candidates_fingerprint_shape
  -- enforces it, and `left(src, 4)` put 'goog' and 'gmai' in them. Indexed instead.
  FOREACH src IN ARRAY ARRAY['google_calendar', 'gmail'] LOOP
    i := i + 1;
    INSERT INTO public.interaction_candidates
      (user_id, contact_id, source, source_fingerprint, proposed_type,
       proposed_interaction_date, status, source_last_state, context_expires_at)
    VALUES
      (u1, '33333333-3333-3333-3333-333333333334', src, lpad(i::text, 64, 'c'),
       'Coffee chat', current_date - 3, 'pending', 'active', NULL)
    RETURNING id INTO cand;

    res := public.accept_interaction_candidate(cand, 'Coffee chat', current_date - 3,
                                               'A note the user typed.');
    ASSERT res ->> 'result' = 'accepted',
      src || ' with a NULL context deadline must still accept: ' || res::text;
    ASSERT (SELECT source FROM public.interactions
             WHERE id = (res ->> 'interaction_id')::uuid) = src,
      'and keep its own provenance';

    DELETE FROM public.interactions WHERE user_id = u1;
    DELETE FROM public.interaction_candidates WHERE id = cand;
  END LOOP;

  -- An OUTLOOK row with a NULL deadline while pending is anomalous - every writer
  -- sets it - and fails CLOSED rather than being accepted on a missing value.
  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, status, source_last_state, context_expires_at)
  VALUES
    (u1, '33333333-3333-3333-3333-333333333333', 'outlook', repeat('d', 64), 'Email',
     current_date - 3, 'pending', 'active', NULL)
  RETURNING id INTO cand;
  res := public.accept_interaction_candidate(cand, 'Email', current_date - 3, NULL);
  ASSERT res ->> 'result' = 'expired',
    'an Outlook row with no deadline must fail closed: ' || res::text;
  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u1) = 0;
  DELETE FROM public.interaction_candidates WHERE id = cand;
END $$;

-- ══ 4. EVERY OTHER REFUSAL STILL PRECEDES THE EXPIRY CHECK ═════════════════
-- Ordering matters: a dismissed or invalidated row must keep its own answer rather
-- than being re-described as expired.
DO $$
DECLARE
  u1   uuid := '11111111-1111-1111-1111-111111111111';
  cand uuid;
  res  jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', u1::text, true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', u1::text)::text, true);

  -- DISMISSED, and also past its deadline.
  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, status, source_last_state, context_expires_at)
  VALUES
    (u1, '33333333-3333-3333-3333-333333333333', 'outlook', repeat('e', 64), 'Email',
     current_date - 50, 'dismissed', 'active', now() - interval '40 days')
  RETURNING id INTO cand;
  res := public.accept_interaction_candidate(cand, 'Email', current_date - 50, NULL);
  ASSERT res ->> 'result' = 'dismissed',
    'a dismissed row keeps its own answer: ' || res::text;
  DELETE FROM public.interaction_candidates WHERE id = cand;

  -- INVALIDATED, and also past its deadline.
  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, status, source_last_state, context_expires_at)
  VALUES
    (u1, '33333333-3333-3333-3333-333333333333', 'outlook', repeat('f', 64), 'Email',
     current_date - 50, 'invalidated', 'active', now() - interval '40 days')
  RETURNING id INTO cand;
  res := public.accept_interaction_candidate(cand, 'Email', current_date - 50, NULL);
  ASSERT res ->> 'result' = 'invalidated',
    'an invalidated row keeps its own answer: ' || res::text;
  DELETE FROM public.interaction_candidates WHERE id = cand;

  -- An INACTIVE SOURCE still answers invalidated, not expired.
  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, status, source_last_state, context_expires_at)
  VALUES
    (u1, '33333333-3333-3333-3333-333333333333', 'outlook', repeat('1a', 32), 'Email',
     current_date - 2, 'pending', 'deleted', now() + interval '30 days')
  RETURNING id INTO cand;
  res := public.accept_interaction_candidate(cand, 'Email', current_date - 2, NULL);
  ASSERT res ->> 'result' = 'invalidated',
    'an inactive source still answers invalidated: ' || res::text;
  DELETE FROM public.interaction_candidates WHERE id = cand;

  -- A foreign candidate is still not_found, never expired.
  res := public.accept_interaction_candidate(
           '99999999-9999-9999-9999-999999999999', 'Email', current_date, NULL);
  ASSERT res ->> 'result' = 'not_found', res::text;

  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u1) = 0,
    'none of these refusals may create an interaction';
END $$;

-- ══ 5. VALIDATION STILL RUNS, AND STILL RUNS BEFORE ANY WRITE ══════════════
DO $$
DECLARE
  u1   uuid := '11111111-1111-1111-1111-111111111111';
  cand uuid;
  res  jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', u1::text, true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', u1::text)::text, true);

  INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, status, source_last_state, context_expires_at)
  VALUES
    (u1, '33333333-3333-3333-3333-333333333333', 'outlook', repeat('2b', 32), 'Email',
     current_date - 2, 'pending', 'active', now() + interval '30 days')
  RETURNING id INTO cand;

  ASSERT (public.accept_interaction_candidate(cand, 'Telepathy', current_date, NULL)
            ->> 'result') = 'invalid_type';
  ASSERT (public.accept_interaction_candidate(cand, 'Email', current_date,
            repeat('x', 201)) ->> 'result') = 'invalid_notes';
  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u1) = 0,
    'a validation refusal must write nothing';
  ASSERT (SELECT status FROM public.interaction_candidates WHERE id = cand) = 'pending';

  DELETE FROM public.interaction_candidates WHERE id = cand;
END $$;

-- ══ 6. THE FUNCTION CONTRACT IS PRESERVED ══════════════════════════════════
-- CREATE OR REPLACE keeps the ACL, but "keeps" is a claim worth checking rather
-- than trusting: a DROP and CREATE would silently hand EXECUTE back to PUBLIC.
DO $$
DECLARE
  sig text := 'public.accept_interaction_candidate(uuid, text, date, text)';
  pr  pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO pr FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_interaction_candidate';

  ASSERT pr.prosecdef, 'SECURITY DEFINER must be preserved';
  -- `SET search_path = ''` is stored in proconfig as `search_path=""` - the empty
  -- string is quoted. Asserted on the actual stored forms rather than the one I
  -- guessed, and the point is that it is EMPTY: a pinned empty path is what stops a
  -- SECURITY DEFINER function resolving an unqualified name through a caller-supplied
  -- schema, so `search_path=public` would pass a mere "is it set?" check and be wrong.
  ASSERT pr.proconfig IS NOT NULL
         AND EXISTS (SELECT 1 FROM unnest(pr.proconfig) c
                      WHERE c IN ('search_path=', 'search_path=""')),
    'the pinned empty search_path must be preserved: '
      || COALESCE(array_to_string(pr.proconfig, ','), 'NONE');

  ASSERT has_function_privilege('authenticated', sig, 'EXECUTE'),
    'authenticated must keep EXECUTE';
  ASSERT NOT has_function_privilege('anon', sig, 'EXECUTE'),
    'anon must NOT have EXECUTE';
  -- PUBLIC must not have been handed EXECUTE back.
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace,
      LATERAL aclexplode(p.proacl) a
     WHERE n.nspname = 'public' AND p.proname = 'accept_interaction_candidate'
       AND a.grantee = 0),
    'PUBLIC must not appear in the ACL';

  -- Exactly ONE overload: a signature change would have created a second, after
  -- which every four-argument call from the browser is ambiguous.
  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'accept_interaction_candidate') = 1,
    'there must be exactly one accept_interaction_candidate';
END $$;

-- ══ teardown ═══════════════════════════════════════════════════════════════
-- auth.users and profiles are deliberately LEFT: a previous teardown deleted a
-- shared auth.users row and broke outlook-disconnect-runtime with an FK violation.
DO $$
DECLARE u1 uuid := '11111111-1111-1111-1111-111111111111';
BEGIN
  DELETE FROM public.outlook_candidate_refs WHERE user_id = u1;
  DELETE FROM public.interaction_candidates WHERE user_id = u1;
  DELETE FROM public.interactions WHERE user_id = u1;
  DELETE FROM public.contacts WHERE user_id = u1;
END $$;

SELECT 'outlook-accept-expiry-runtime: all sections passed' AS result;
