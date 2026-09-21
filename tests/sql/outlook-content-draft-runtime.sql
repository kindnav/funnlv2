-- Runtime verification for the Outlook content-draft schema primitives (PR-A).
--
-- RUN ONLY AGAINST A DISPOSABLE LOCAL SUPABASE STACK (after `supabase db reset`):
--   docker cp tests/sql/outlook-content-draft-runtime.sql supabase_db_<project>:/tmp/
--   docker exec supabase_db_<project> psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/outlook-content-draft-runtime.sql
-- NEVER run this against a linked/Production database: it inserts synthetic auth users
-- and rows, then deletes them. Every assertion RAISEs on failure (psql exits non-zero).
-- Not discovered by tests/run-all.js (only *.test.js is); it complements the static
-- suite tests/outlook-content-draft-migration.test.js. The 8-session reservation race is
-- exercised separately with parallel psql sessions (see the static suite header).
--
-- Fixture legend (all synthetic example.invalid data, all deleted at the end):
--   U1 = the acting user      U2 = a bystander with IDENTICAL data (isolation)
--   per user: contact EXISTING (existing-<u>@example.invalid), Google connection with
--   calendar + gmail capability/tokens/cursors/oauth state, pending Gmail + Calendar
--   candidates (must stay untouched), Microsoft connection (via the RPC) + oauth state,
--   Outlook interaction candidates O_PEND (future deadline) / O_EXP (past deadline),
--   new-contact candidates NC_PEND / NC_EXP / NC_DUP (email = EXISTING's) / NC_ONLY.

\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- ── 0. Zero Outlook rows after a clean apply, before any fixture ──────────────
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.microsoft_connections) = 0, 'microsoft_connections not empty';
  ASSERT (SELECT count(*) FROM public.microsoft_tokens) = 0, 'microsoft_tokens not empty';
  ASSERT (SELECT count(*) FROM public.microsoft_oauth_states) = 0, 'microsoft_oauth_states not empty';
  ASSERT (SELECT count(*) FROM public.outlook_sync_state) = 0, 'outlook_sync_state not empty';
  ASSERT (SELECT count(*) FROM public.outlook_candidate_refs) = 0, 'outlook_candidate_refs not empty';
  ASSERT (SELECT count(*) FROM public.new_contact_candidates) = 0, 'new_contact_candidates not empty';
  ASSERT (SELECT count(*) FROM public.interaction_candidates WHERE source = 'outlook') = 0, 'outlook interaction candidates present';
  ASSERT (SELECT count(*) FROM pg_extension WHERE extname = 'pg_cron') = 0, 'pg_cron must be absent';
END $$;

BEGIN;

-- ── Fixtures ──────────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('b1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ol-u1@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('b2000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ol-u2@example.invalid', 'x', now(), '{}', '{}', now(), now());

CREATE TEMP TABLE fx (u text, uid uuid, contact uuid, gconn uuid, mconn uuid, g_pend uuid, c_pend uuid, g_acc uuid,
                      i_manual uuid, i_gmail uuid, o_pend uuid, o_exp uuid, nc_pend uuid, nc_exp uuid, nc_dup uuid, nc_only uuid);
INSERT INTO fx (u, uid) VALUES ('U1', 'b1000000-0000-4000-8000-000000000001'), ('U2', 'b2000000-0000-4000-8000-000000000002');
GRANT SELECT ON fx TO authenticated, anon;   -- fixture lookup only; the blocks below switch roles

-- fingerprint helper: 64 hex chars from a label
CREATE TEMP TABLE fp AS SELECT 'x'::text AS label, repeat('0', 64)::text AS hex WHERE false;
CREATE OR REPLACE FUNCTION pg_temp.fpx(label text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT encode(sha256(label::bytea), 'hex') $$;
-- helper: mint a fresh Outlook state for a user with a consent version
CREATE OR REPLACE FUNCTION pg_temp.mint_state(p_uid uuid, p_label text, p_version text, p_expires interval DEFAULT interval '10 minutes')
RETURNS text LANGUAGE plpgsql AS $$
DECLARE h text := pg_temp.fpx('state:' || p_label);
BEGIN
  INSERT INTO public.microsoft_oauth_states (state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce, return_origin, integration_type, consented_at, consent_policy_version, expires_at)
    VALUES (h, p_uid, 'c', 'n', 'https://www.getfunnl.com', 'outlook',
            LEAST(now() - interval '1 second', now() + p_expires - interval '1 second'),   -- consent always precedes expiry
            p_version, now() + p_expires);
  RETURN h;
END $$;


DO $$
DECLARE r record; v_contact uuid; v_gconn uuid; v_mconn uuid; v_res jsonb;
        v_gp uuid; v_cp uuid; v_ga uuid; v_im uuid; v_ig uuid; v_op uuid; v_oe uuid;
        v_np uuid; v_ne uuid; v_nd uuid; v_no uuid; sfx text;
BEGIN
  FOR r IN SELECT * FROM fx LOOP
    sfx := lower(r.u);
    INSERT INTO public.contacts (user_id, name, email) VALUES (r.uid, 'Existing ' || r.u, 'existing-' || sfx || '@example.invalid') RETURNING id INTO v_contact;

    -- Google / Gmail state (must remain untouched by every Outlook operation)
    INSERT INTO public.google_connections (user_id, google_sub, google_email, scopes, status)
      VALUES (r.uid, 'sub-' || r.u, r.u || '@example.invalid', ARRAY['https://www.googleapis.com/auth/calendar.readonly','https://www.googleapis.com/auth/gmail.readonly'], 'active') RETURNING id INTO v_gconn;
    INSERT INTO public.google_tokens (connection_id, access_token_ciphertext, access_token_nonce, refresh_token_ciphertext, refresh_token_nonce)
      VALUES (v_gconn, 'ct', 'n', 'rct', 'rn');
    INSERT INTO public.google_connection_capabilities (connection_id, user_id, product, status, granted)
      VALUES (v_gconn, r.uid, 'calendar', 'active', true), (v_gconn, r.uid, 'gmail', 'active', true);
    INSERT INTO public.gmail_sync_state (connection_id, user_id, history_id) VALUES (v_gconn, r.uid, '12345');
    INSERT INTO public.google_calendar_sync_state (connection_id) VALUES (v_gconn);
    INSERT INTO public.google_oauth_states (state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce, return_origin, integration_type, expires_at)
      VALUES (repeat(substr(sfx, 2, 1), 64), r.uid, 'c', 'n', 'https://www.getfunnl.com', 'gmail', now() + interval '10 minutes');

    INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes, source)
      VALUES (v_contact, r.uid, 'Coffee chat', current_date, 'manual note', 'manual') RETURNING id INTO v_im;
    INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes, source)
      VALUES (v_contact, r.uid, 'Email', current_date, 'gmail note', 'gmail') RETURNING id INTO v_ig;

    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, proposed_notes, retained_subject, context_expires_at, status)
      VALUES (r.uid, v_contact, 'gmail', pg_temp.fpx('g_pend' || r.u), 'Email', current_date, 'gmail pending', 'Gmail subject ' || r.u, now() + interval '20 days', 'pending') RETURNING id INTO v_gp;
    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, proposed_notes, status)
      VALUES (r.uid, v_contact, 'google_calendar', pg_temp.fpx('c_pend' || r.u), 'Event', current_date, 'calendar pending', 'pending') RETURNING id INTO v_cp;
    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, proposed_notes, status, interaction_id)
      VALUES (r.uid, v_contact, 'gmail', pg_temp.fpx('g_acc' || r.u), 'Email', current_date, 'gmail accepted', 'accepted', v_ig) RETURNING id INTO v_ga;

    -- Microsoft connection through the STATE-BOUND finalization RPC (service-role contract):
    -- the consent evidence lives on the single-use state minted after the disclosure.
    PERFORM pg_temp.mint_state(r.uid, 'fixture-' || r.u, 'disclosure-v1');
    v_res := public.finalize_microsoft_connection(pg_temp.fpx('state:fixture-' || r.u), r.uid, 'msacct-' || sfx, 'consumers', 'personal', 'ol-' || sfx || '@example.invalid',
               ARRAY['Mail.Read','offline_access','openid','email'], now() + interval '1 hour', 'act', 'an', 'rct', 'rn', 1::smallint);
    ASSERT v_res ->> 'result' = 'stored', 'finalize_microsoft_connection failed: ' || v_res::text;
    v_mconn := (v_res ->> 'connection_id')::uuid;
    -- a second, still-pending state (disconnect/cleanup must delete it)
    PERFORM pg_temp.mint_state(r.uid, 'pending-' || r.u, 'disclosure-v1');

    -- Outlook interaction candidates (existing contact) + refs
    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, proposed_notes, retained_subject, context_expires_at, status,
                                               draft_summary, draft_follow_up, summary_evidence, extraction_status)
      VALUES (r.uid, v_contact, 'outlook', pg_temp.fpx('o_pend' || r.u), 'Email', current_date, 'outlook pending', 'Outlook subject ' || r.u, now() + interval '20 days', 'pending',
              'Discussed the analyst program and agreed to reconnect after the info session.', 'Send resume by Friday', 'explicit_body', 'ai_extracted') RETURNING id INTO v_op;
    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, proposed_notes, retained_subject, context_expires_at, status,
                                               draft_summary, summary_evidence, extraction_status)
      VALUES (r.uid, v_contact, 'outlook', pg_temp.fpx('o_exp' || r.u), 'Email', current_date - 40, 'outlook expired', 'Old subject ' || r.u, now() - interval '1 minute', 'pending',
              'Old summary.', 'subject_only', 'deterministic') RETURNING id INTO v_oe;
    INSERT INTO public.outlook_candidate_refs (user_id, connection_id, interaction_candidate_id, episode_fingerprint)
      VALUES (r.uid, v_mconn, v_op, pg_temp.fpx('o_pend' || r.u)), (r.uid, v_mconn, v_oe, pg_temp.fpx('o_exp' || r.u));

    -- New-contact candidates + refs
    INSERT INTO public.new_contact_candidates (user_id, person_fingerprint, episode_fingerprint, proposed_email, proposed_name, proposed_name_evidence, proposed_name_confidence,
        proposed_company, proposed_company_evidence, proposed_company_confidence, proposed_role, proposed_role_evidence, proposed_role_confidence,
        proposed_linkedin_url, proposed_linkedin_url_evidence, proposed_linkedin_url_confidence,
        draft_summary, draft_follow_up, proposed_interaction_date, retained_subject, extraction_status, context_expires_at)
      VALUES (r.uid, pg_temp.fpx('person-new' || r.u), pg_temp.fpx('ep-new' || r.u), 'newperson-' || sfx || '@example.invalid', 'Ada Example', 'provider_metadata', 'high',
        'Example Corp', 'explicit_signature', 'high', 'Recruiter', 'explicit_signature', 'medium',
        'https://www.linkedin.com/in/ada-example', 'explicit_signature', 'high',
        'Ada described the summer analyst role and offered to intro the hiring lead.', 'Reply with availability next week', current_date, 'Summer analyst role', 'ai_extracted', now() + interval '25 days')
      RETURNING id INTO v_np;
    INSERT INTO public.new_contact_candidates (user_id, person_fingerprint, episode_fingerprint, proposed_email, proposed_name, proposed_name_evidence, proposed_name_confidence,
        draft_summary, proposed_interaction_date, retained_subject, context_expires_at)
      VALUES (r.uid, pg_temp.fpx('person-exp' || r.u), pg_temp.fpx('ep-exp' || r.u), 'expired-' || sfx || '@example.invalid', 'Exp Person', 'provider_metadata', 'medium',
        'Expired draft.', current_date - 40, 'Expired subject', now() - interval '1 minute') RETURNING id INTO v_ne;
    INSERT INTO public.new_contact_candidates (user_id, person_fingerprint, episode_fingerprint, proposed_email, proposed_name, proposed_name_evidence, proposed_name_confidence,
        draft_summary, proposed_interaction_date, context_expires_at)
      VALUES (r.uid, pg_temp.fpx('person-dup' || r.u), pg_temp.fpx('ep-dup' || r.u), 'Existing-' || sfx || '@example.invalid', 'Existing Again', 'provider_metadata', 'high',
        'Duplicate address draft.', current_date, now() + interval '25 days') RETURNING id INTO v_nd;
    INSERT INTO public.new_contact_candidates (user_id, person_fingerprint, episode_fingerprint, proposed_email, proposed_name, proposed_name_evidence, proposed_name_confidence,
        draft_summary, proposed_interaction_date, context_expires_at)
      VALUES (r.uid, pg_temp.fpx('person-only' || r.u), pg_temp.fpx('ep-only' || r.u), 'contactonly-' || sfx || '@example.invalid', 'Only Contact', 'explicit_signature', 'high',
        'Contact-only draft.', current_date, now() + interval '25 days') RETURNING id INTO v_no;
    INSERT INTO public.outlook_candidate_refs (user_id, connection_id, new_contact_candidate_id, episode_fingerprint, person_fingerprint)
      VALUES (r.uid, v_mconn, v_np, pg_temp.fpx('ep-new' || r.u), pg_temp.fpx('person-new' || r.u)),
             (r.uid, v_mconn, v_ne, pg_temp.fpx('ep-exp' || r.u), pg_temp.fpx('person-exp' || r.u)),
             (r.uid, v_mconn, v_nd, pg_temp.fpx('ep-dup' || r.u), pg_temp.fpx('person-dup' || r.u)),
             (r.uid, v_mconn, v_no, pg_temp.fpx('ep-only' || r.u), pg_temp.fpx('person-only' || r.u));

    UPDATE fx SET contact = v_contact, gconn = v_gconn, mconn = v_mconn, g_pend = v_gp, c_pend = v_cp, g_acc = v_ga,
                  i_manual = v_im, i_gmail = v_ig, o_pend = v_op, o_exp = v_oe, nc_pend = v_np, nc_exp = v_ne, nc_dup = v_nd, nc_only = v_no
      WHERE u = r.u;
  END LOOP;
END $$;

-- Baseline snapshot of everything that must stay untouched (per user).
CREATE TEMP TABLE base AS
SELECT u.uid,
  (SELECT count(*) FROM public.google_connections WHERE user_id = u.uid) AS gconns,
  (SELECT count(*) FROM public.google_connection_capabilities WHERE user_id = u.uid) AS gcaps,
  (SELECT count(*) FROM public.gmail_sync_state WHERE user_id = u.uid) AS gsync,
  (SELECT count(*) FROM public.google_oauth_states WHERE user_id = u.uid) AS gstates,
  (SELECT count(*) FROM public.interaction_candidates WHERE user_id = u.uid AND source IN ('gmail','google_calendar') AND status = 'pending' AND retained_subject IS NOT DISTINCT FROM ('Gmail subject ' || fx.u)) AS gpend_with_subject,
  (SELECT count(*) FROM public.interactions WHERE user_id = u.uid) AS interactions,
  (SELECT count(*) FROM public.contacts WHERE user_id = u.uid) AS contacts
FROM fx u JOIN fx ON fx.uid = u.uid;

-- ── 1. Constraint checks (all expected to be REJECTED) ────────────────────────
DO $$
DECLARE u1 uuid := (SELECT uid FROM fx WHERE u = 'U1'); m1 uuid := (SELECT mconn FROM fx WHERE u = 'U1');
        u2 uuid := (SELECT uid FROM fx WHERE u = 'U2'); ok boolean;
BEGIN
  -- summary over 200 chars
  ok := false;
  BEGIN
    INSERT INTO public.new_contact_candidates (user_id, person_fingerprint, episode_fingerprint, proposed_email, proposed_interaction_date, context_expires_at, draft_summary)
      VALUES (u1, pg_temp.fpx('x1'), pg_temp.fpx('x1e'), 'x@example.invalid', current_date, now() + interval '1 day', repeat('a', 201));
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'summary > 200 accepted';
  -- URL inside summary
  ok := false;
  BEGIN
    INSERT INTO public.new_contact_candidates (user_id, person_fingerprint, episode_fingerprint, proposed_email, proposed_interaction_date, context_expires_at, draft_summary)
      VALUES (u1, pg_temp.fpx('x2'), pg_temp.fpx('x2e'), 'x@example.invalid', current_date, now() + interval '1 day', 'visit https://evil.example.invalid now');
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'URL in summary accepted';
  -- context beyond 30 days
  ok := false;
  BEGIN
    INSERT INTO public.new_contact_candidates (user_id, person_fingerprint, episode_fingerprint, proposed_email, proposed_interaction_date, context_expires_at)
      VALUES (u1, pg_temp.fpx('x3'), pg_temp.fpx('x3e'), 'x@example.invalid', current_date, now() + interval '31 days');
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'context > 30 days accepted';
  -- company without explicit evidence (provider_metadata is not allowed for company)
  ok := false;
  BEGIN
    INSERT INTO public.new_contact_candidates (user_id, person_fingerprint, episode_fingerprint, proposed_email, proposed_interaction_date, context_expires_at, proposed_company, proposed_company_evidence, proposed_company_confidence)
      VALUES (u1, pg_temp.fpx('x4'), pg_temp.fpx('x4e'), 'x@example.invalid', current_date, now() + interval '1 day', 'Domain Corp', 'provider_metadata', 'high');
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'company with provider_metadata evidence accepted';
  -- value without evidence code
  ok := false;
  BEGIN
    INSERT INTO public.new_contact_candidates (user_id, person_fingerprint, episode_fingerprint, proposed_email, proposed_interaction_date, context_expires_at, proposed_role)
      VALUES (u1, pg_temp.fpx('x5'), pg_temp.fpx('x5e'), 'x@example.invalid', current_date, now() + interval '1 day', 'Recruiter');
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'role without evidence accepted';
  -- non-LinkedIn URL
  ok := false;
  BEGIN
    INSERT INTO public.new_contact_candidates (user_id, person_fingerprint, episode_fingerprint, proposed_email, proposed_interaction_date, context_expires_at, proposed_linkedin_url, proposed_linkedin_url_evidence, proposed_linkedin_url_confidence)
      VALUES (u1, pg_temp.fpx('x6'), pg_temp.fpx('x6e'), 'x@example.invalid', current_date, now() + interval '1 day', 'https://evil.example.invalid/in/x', 'explicit_signature', 'high');
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'non-linkedin URL accepted';
  -- terminal row carrying context
  ok := false;
  BEGIN
    INSERT INTO public.new_contact_candidates (user_id, person_fingerprint, episode_fingerprint, status, draft_summary)
      VALUES (u1, pg_temp.fpx('x7'), pg_temp.fpx('x7e'), 'dismissed', 'leftover');
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'terminal row with context accepted';
  -- control character in subject
  ok := false;
  BEGIN
    INSERT INTO public.new_contact_candidates (user_id, person_fingerprint, episode_fingerprint, proposed_email, proposed_interaction_date, context_expires_at, retained_subject)
      VALUES (u1, pg_temp.fpx('x8'), pg_temp.fpx('x8e'), 'x@example.invalid', current_date, now() + interval '1 day', E'bad\x01subject');
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'control char subject accepted';
  -- Outlook draft columns on a gmail row
  ok := false;
  BEGIN
    INSERT INTO public.interaction_candidates (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, draft_summary, summary_evidence)
      VALUES (u1, (SELECT contact FROM fx WHERE u = 'U1'), 'gmail', pg_temp.fpx('x9'), 'Email', current_date, 'no', 'explicit_body');
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'draft columns on gmail row accepted';
  -- ref with both targets
  ok := false;
  BEGIN
    INSERT INTO public.outlook_candidate_refs (user_id, connection_id, interaction_candidate_id, new_contact_candidate_id, episode_fingerprint)
      VALUES (u1, m1, (SELECT o_pend FROM fx WHERE u = 'U1'), (SELECT nc_pend FROM fx WHERE u = 'U1'), pg_temp.fpx('x10'));
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'ref with two targets accepted';
  -- CROSS-USER: ref claiming U2 owns U1's connection (connection FK) …
  ok := false;
  BEGIN
    INSERT INTO public.outlook_candidate_refs (user_id, connection_id, interaction_candidate_id, episode_fingerprint)
      VALUES (u2, m1, (SELECT g_pend FROM fx WHERE u = 'U2'), pg_temp.fpx('x11'));
  EXCEPTION WHEN foreign_key_violation THEN ok := true; END;
  ASSERT ok, 'cross-user ref (connection) accepted';
  -- … or U1's candidate (candidate FK), each with the other user's id
  ok := false;
  BEGIN
    INSERT INTO public.outlook_candidate_refs (user_id, connection_id, interaction_candidate_id, episode_fingerprint)
      VALUES (u2, (SELECT mconn FROM fx WHERE u = 'U2'), (SELECT g_pend FROM fx WHERE u = 'U1'), pg_temp.fpx('x12'));
  EXCEPTION WHEN foreign_key_violation THEN ok := true; END;
  ASSERT ok, 'cross-user ref (candidate) accepted';
  ok := false;
  BEGIN
    INSERT INTO public.outlook_sync_state (connection_id, user_id, folder) VALUES (m1, u2, 'inbox');
  EXCEPTION WHEN foreign_key_violation THEN ok := true; END;
  ASSERT ok, 'cross-user sync state accepted';
  ok := false;
  BEGIN
    -- (the PK slot is already taken, so a cross-user token must fail on the FK OR the PK — both refuse)
    INSERT INTO public.microsoft_tokens (connection_id, user_id, refresh_token_ciphertext, refresh_token_nonce) VALUES (m1, u2, 'r', 'n');
  EXCEPTION WHEN foreign_key_violation OR unique_violation THEN ok := true; END;
  ASSERT ok, 'cross-user token accepted';
  -- cross-user UPDATE of the token row's owner must fail on the composite FK
  ok := false;
  BEGIN
    UPDATE public.microsoft_tokens SET user_id = u2 WHERE connection_id = m1;
  EXCEPTION WHEN foreign_key_violation THEN ok := true; END;
  ASSERT ok, 'cross-user token accepted';
  -- folder enum
  ok := false;
  BEGIN
    INSERT INTO public.outlook_sync_state (connection_id, user_id, folder) VALUES (m1, u1, 'drafts');
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'folder drafts accepted';
  -- second Microsoft connection for the same user
  ok := false;
  BEGIN
    INSERT INTO public.microsoft_connections (user_id, ms_account_id, account_type, ms_email, scopes, consented_at, consent_policy_version)
      VALUES (u1, 'other', 'work', 'other@example.invalid', ARRAY['Mail.Read'], now(), 'v');
  EXCEPTION WHEN unique_violation THEN ok := true; END;
  ASSERT ok, 'second connection per user accepted';
END $$;

-- ── 1b. Consent binding, state lifecycle, permission contract (service-role RPC) ──
DO $$
DECLARE u1 uuid := (SELECT uid FROM fx WHERE u = 'U1'); u2 uuid := (SELECT uid FROM fx WHERE u = 'U2');
        m1 uuid := (SELECT mconn FROM fx WHERE u = 'U1'); v jsonb; h text; ok boolean; before_conn record; v_raw text;
BEGIN
  -- consent evidence on the connection came from the consumed fixture state (version pinned by fixture)
  ASSERT (SELECT consent_policy_version FROM public.microsoft_connections WHERE user_id = u1) = 'disclosure-v1', 'consent version not copied from state';
  ASSERT (SELECT consented_at FROM public.microsoft_connections WHERE user_id = u1) = (SELECT consented_at FROM public.microsoft_oauth_states WHERE state_hash = pg_temp.fpx('state:fixture-U1')), 'consented_at not copied from state';
  ASSERT (SELECT consumed_at IS NOT NULL FROM public.microsoft_oauth_states WHERE state_hash = pg_temp.fpx('state:fixture-U1')), 'fixture state not consumed';
  ASSERT (SELECT scopes FROM public.microsoft_connections WHERE user_id = u1) = ARRAY['Mail.Read','offline_access','openid','email'], 'scopes not normalized: ' || (SELECT scopes::text FROM public.microsoft_connections WHERE user_id = u1);

  -- REPLAY: the consumed state cannot finalize again (and changes nothing)
  SELECT * INTO before_conn FROM public.microsoft_connections WHERE user_id = u1;
  v := public.finalize_microsoft_connection(pg_temp.fpx('state:fixture-U1'), NULL, 'msacct-u1', 'consumers', 'personal', 'ol-u1@example.invalid', ARRAY['Mail.Read','offline_access'], NULL, NULL, NULL, 'replay-r', 'replay-n', 1::smallint);
  ASSERT v ->> 'result' = 'state_consumed', 'replay accepted: ' || v::text;
  ASSERT (SELECT refresh_token_ciphertext FROM public.microsoft_tokens WHERE user_id = u1) <> 'replay-r', 'replay rotated the token';
  ASSERT (SELECT updated_at FROM public.microsoft_connections WHERE user_id = u1) = before_conn.updated_at, 'replay touched the connection';

  -- UNKNOWN / WRONG-INTEGRATION: a Google (gmail) state hash is not an Outlook state
  v := public.finalize_microsoft_connection(repeat('1', 64), NULL, 'msacct-u1', 'consumers', 'personal', 'ol-u1@example.invalid', ARRAY['Mail.Read'], NULL, NULL, NULL, 'r', 'n', 1::smallint);
  ASSERT v ->> 'result' = 'unknown_state', 'google state accepted as outlook: ' || v::text;
  v := public.finalize_microsoft_connection('not-a-hash', NULL, 'msacct-u1', 'consumers', 'personal', 'ol-u1@example.invalid', ARRAY['Mail.Read'], NULL, NULL, NULL, 'r', 'n', 1::smallint);
  ASSERT v ->> 'result' = 'invalid_state', 'malformed hash accepted';

  -- EXPIRED state
  h := pg_temp.mint_state(u1, 'expired-U1', 'disclosure-v2', interval '-1 minute');
  v := public.finalize_microsoft_connection(h, NULL, 'msacct-u1', 'consumers', 'personal', 'ol-u1@example.invalid', ARRAY['Mail.Read','offline_access'], NULL, NULL, NULL, 'r', 'n', 1::smallint);
  ASSERT v ->> 'result' = 'state_expired', 'expired state accepted: ' || v::text;
  ASSERT (SELECT consumed_at IS NULL FROM public.microsoft_oauth_states WHERE state_hash = h), 'expired state consumed';
  ASSERT (SELECT consent_policy_version FROM public.microsoft_connections WHERE user_id = u1) = 'disclosure-v1', 'expired state changed consent';

  -- WRONG USER: the caller expected U2 but the state belongs to U1
  h := pg_temp.mint_state(u1, 'wronguser-U1', 'disclosure-v2');
  v := public.finalize_microsoft_connection(h, u2, 'msacct-u1', 'consumers', 'personal', 'ol-u1@example.invalid', ARRAY['Mail.Read','offline_access'], NULL, NULL, NULL, 'r', 'n', 1::smallint);
  ASSERT v ->> 'result' = 'state_user_mismatch', 'wrong-user state accepted: ' || v::text;
  ASSERT (SELECT consumed_at IS NULL FROM public.microsoft_oauth_states WHERE state_hash = h), 'mismatched state consumed';
  ASSERT (SELECT count(*) FROM public.microsoft_connections WHERE user_id = u2 AND ms_account_id = 'msacct-u1') = 0, 'connection created for the wrong user';

  -- PERMISSION CONTRACT: missing Mail.Read, forbidden scopes (state stays unconsumed each time)
  v := public.finalize_microsoft_connection(h, NULL, 'msacct-u1', 'consumers', 'personal', 'ol-u1@example.invalid', ARRAY['offline_access','openid'], NULL, NULL, NULL, 'r', 'n', 1::smallint);
  ASSERT v ->> 'result' = 'missing_mail_read', 'no Mail.Read accepted: ' || v::text;
  v := public.finalize_microsoft_connection(h, NULL, 'msacct-u1', 'consumers', 'personal', 'ol-u1@example.invalid', ARRAY['Mail.ReadBasic','offline_access'], NULL, NULL, NULL, 'r', 'n', 1::smallint);
  ASSERT v ->> 'result' = 'forbidden_scope', 'ReadBasic-only accepted (must be forbidden, not silently narrowed): ' || v::text;
  FOREACH v_raw IN ARRAY ARRAY['Mail.ReadWrite', 'Mail.Send', 'MailboxSettings.ReadWrite', 'Files.Read', 'Files.Read.All', 'Contacts.ReadWrite',
                               'Calendars.ReadWrite', 'https://graph.microsoft.com/.default', '.default', 'Mail.Read.All', 'Mail.ReadBasic.All', 'User.Read', 'Mail.Read.Shared'] LOOP
    v := public.finalize_microsoft_connection(h, NULL, 'msacct-u1', 'consumers', 'personal', 'ol-u1@example.invalid', ARRAY['Mail.Read', 'offline_access', v_raw], NULL, NULL, NULL, 'r', 'n', 1::smallint);
    ASSERT v ->> 'result' = 'forbidden_scope', v_raw || ' accepted: ' || v::text;
  END LOOP;
  v := public.finalize_microsoft_connection(h, NULL, 'msacct-u1', 'consumers', 'personal', 'ol-u1@example.invalid', ARRAY[]::text[], NULL, NULL, NULL, 'r', 'n', 1::smallint);
  ASSERT v ->> 'result' = 'missing_mail_read', 'empty scopes accepted';
  v := public.finalize_microsoft_connection(h, NULL, 'msacct-u1', 'consumers', 'personal', 'ol-u1@example.invalid', ARRAY['Mail.Read', NULL], NULL, NULL, NULL, 'r', 'n', 1::smallint);
  ASSERT v ->> 'result' = 'invalid_scopes', 'null scope accepted';
  ASSERT (SELECT consumed_at IS NULL FROM public.microsoft_oauth_states WHERE state_hash = h), 'refused finalization consumed the state';
  ASSERT (SELECT consent_policy_version FROM public.microsoft_connections WHERE user_id = u1) = 'disclosure-v1', 'refused finalization changed consent';

  -- DIFFERENT ACCOUNT refused (state still valid)
  v := public.finalize_microsoft_connection(h, NULL, 'someone-else', 'consumers', 'personal', 'other@example.invalid', ARRAY['Mail.Read','offline_access'], NULL, NULL, NULL, 'r', 'n', 1::smallint);
  ASSERT v ->> 'result' = 'different_account', 'account swap allowed: ' || v::text;
  ASSERT (SELECT consumed_at IS NULL FROM public.microsoft_oauth_states WHERE state_hash = h), 'different-account attempt consumed the state';

  -- REAUTHORIZATION with a NEW state carrying a NEW disclosure version + documented
  -- equivalent spellings (resource-prefixed, mixed case, duplicates) → normalized
  v := public.finalize_microsoft_connection(h, u1, 'msacct-u1', 'consumers', 'personal', 'ol-u1@example.invalid',
         ARRAY['https://graph.microsoft.com/Mail.Read', 'MAIL.READ', ' offline_access ', 'OpenID', 'email', 'profile'], now() + interval '1 hour', 'a2', 'an2', 'r2', 'n2', 2::smallint);
  ASSERT v ->> 'result' = 'stored' AND (v ->> 'connection_id')::uuid = m1, 'reauth failed: ' || v::text;
  ASSERT (SELECT consent_policy_version FROM public.microsoft_connections WHERE user_id = u1) = 'disclosure-v2', 'reauth did not adopt the new state version';
  ASSERT (SELECT consented_at FROM public.microsoft_connections WHERE user_id = u1) = (SELECT consented_at FROM public.microsoft_oauth_states WHERE state_hash = h), 'reauth consented_at not from the new state';
  ASSERT (SELECT scopes FROM public.microsoft_connections WHERE user_id = u1) = ARRAY['Mail.Read','offline_access','openid','email','profile'], 'reauth scopes not normalized: ' || (SELECT scopes::text FROM public.microsoft_connections WHERE user_id = u1);
  ASSERT (SELECT refresh_token_ciphertext = 'r2' AND key_version = 2 FROM public.microsoft_tokens WHERE user_id = u1), 'refresh token not rotated';
  ASSERT (SELECT count(*) FROM public.microsoft_connections WHERE user_id = u1) = 1, 'connection duplicated';
  ASSERT (SELECT consumed_at IS NOT NULL FROM public.microsoft_oauth_states WHERE state_hash = h), 'successful finalization did not consume';
  v := public.finalize_microsoft_connection(h, u1, 'msacct-u1', 'consumers', 'personal', 'ol-u1@example.invalid', ARRAY['Mail.Read'], NULL, NULL, NULL, 'r3', 'n3', 1::smallint);
  ASSERT v ->> 'result' = 'state_consumed', 'second finalization of the same state succeeded';
  ASSERT (SELECT refresh_token_ciphertext FROM public.microsoft_tokens WHERE user_id = u1) = 'r2', 'replay after reauth rotated the token';

  -- the connection CHECK refuses broader scopes even from a direct service write
  ok := false;
  BEGIN
    UPDATE public.microsoft_connections SET scopes = ARRAY['Mail.Read', 'Mail.ReadWrite'] WHERE user_id = u1;
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'CHECK accepted Mail.ReadWrite';
  ok := false;
  BEGIN
    UPDATE public.microsoft_connections SET scopes = ARRAY['offline_access'] WHERE user_id = u1;
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'CHECK accepted an active connection without Mail.Read';
  ok := false;
  BEGIN
    INSERT INTO public.microsoft_oauth_states (state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce, return_origin, consented_at, consent_policy_version, expires_at)
      VALUES (pg_temp.fpx('nover'), u1, 'c', 'n', 'https://www.getfunnl.com', now(), '', now() + interval '1 minute');
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'empty consent version accepted';
  ok := false;
  BEGIN
    INSERT INTO public.microsoft_oauth_states (state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce, return_origin, expires_at)
      VALUES (pg_temp.fpx('noconsent'), u1, 'c', 'n', 'https://www.getfunnl.com', now() + interval '1 minute');
  EXCEPTION WHEN not_null_violation THEN ok := true; END;
  ASSERT ok, 'state without consent accepted';

  -- cross-user state update still refused
  v := public.update_microsoft_connection_state(m1, u2, 'needs_reauth', true, 'invalid_grant');
  ASSERT v ->> 'result' = 'owner_mismatch', 'cross-user state update allowed';
END $$;

-- FAILED FINALIZATION after the writes started: forced token-insert failure → the whole
-- call rolls back: no connection change, state NOT consumed (atomic contract).
CREATE OR REPLACE FUNCTION pg_temp.force_token_fail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.refresh_token_ciphertext = 'FORCE_FAIL' THEN RAISE EXCEPTION 'forced'; END IF; RETURN NEW; END $$;
CREATE TRIGGER rt_force_token_fail BEFORE INSERT OR UPDATE ON public.microsoft_tokens FOR EACH ROW EXECUTE FUNCTION pg_temp.force_token_fail();
DO $$
DECLARE u2 uuid := (SELECT uid FROM fx WHERE u = 'U2'); h text; failed boolean := false; before_ver text;
BEGIN
  h := pg_temp.mint_state(u2, 'fail-U2', 'disclosure-v9');
  SELECT consent_policy_version INTO before_ver FROM public.microsoft_connections WHERE user_id = u2;
  BEGIN
    PERFORM public.finalize_microsoft_connection(h, u2, 'msacct-u2', 'consumers', 'personal', 'ol-u2@example.invalid', ARRAY['Mail.Read','offline_access'], NULL, NULL, NULL, 'FORCE_FAIL', 'n', 1::smallint);
  EXCEPTION WHEN OTHERS THEN failed := true; END;
  ASSERT failed, 'forced token failure did not raise';
  ASSERT (SELECT consumed_at IS NULL FROM public.microsoft_oauth_states WHERE state_hash = h), 'FAILED FINALIZATION CONSUMED THE STATE';
  ASSERT (SELECT consent_policy_version FROM public.microsoft_connections WHERE user_id = u2) = before_ver, 'FAILED FINALIZATION CHANGED CONSENT';
  ASSERT (SELECT refresh_token_ciphertext FROM public.microsoft_tokens WHERE user_id = u2) <> 'FORCE_FAIL', 'token written despite failure';
END $$;
DROP TRIGGER rt_force_token_fail ON public.microsoft_tokens;

-- ── 1c. Explicit grant matrix (catalog truth via has_*_privilege) ─────────────
-- Supabase projects no longer auto-expose public tables to the Data API; every grant
-- below must be explicit and nothing may rely on default privileges.
DO $$
DECLARE t text; c text; f text; ok boolean;
        sensitive_tables text[] := ARRAY['microsoft_tokens', 'microsoft_oauth_states', 'outlook_sync_state', 'outlook_candidate_refs'];
        all_tables text[] := ARRAY['microsoft_connections', 'microsoft_tokens', 'microsoft_oauth_states', 'outlook_sync_state', 'outlook_candidate_refs', 'new_contact_candidates'];
        conn_hidden text[] := ARRAY['id', 'user_id', 'ms_account_id', 'ms_tenant_id', 'token_expires_at'];
        conn_visible text[] := ARRAY['account_type', 'ms_email', 'scopes', 'status', 'needs_reauth', 'consented_at', 'consent_policy_version', 'last_result_code', 'last_success_at', 'connected_at', 'updated_at'];
        ncc_hidden text[] := ARRAY['user_id', 'person_fingerprint', 'episode_fingerprint', 'key_version', 'context_expires_at'];
        ncc_visible text[] := ARRAY['id', 'source', 'status', 'proposed_email', 'proposed_name', 'proposed_name_evidence', 'proposed_name_confidence', 'proposed_company', 'proposed_company_evidence', 'proposed_company_confidence', 'proposed_role', 'proposed_role_evidence', 'proposed_role_confidence', 'proposed_how_met', 'proposed_how_met_evidence', 'proposed_how_met_confidence', 'proposed_linkedin_url', 'proposed_linkedin_url_evidence', 'proposed_linkedin_url_confidence', 'draft_summary', 'draft_follow_up', 'proposed_interaction_date', 'proposed_type', 'retained_subject', 'extraction_status', 'deferred_until', 'accepted_contact_id', 'accepted_interaction_id', 'created_at', 'updated_at'];
        ic_new text[] := ARRAY['draft_summary', 'draft_follow_up', 'summary_evidence', 'extraction_status', 'deferred_until'];
        service_fns text[] := ARRAY['finalize_microsoft_connection', 'update_microsoft_connection_state', 'reserve_due_outlook_connection', 'renew_outlook_sync_lease', 'release_outlook_sync_lease', 'invalidate_outlook_candidates_by_fingerprint', 'run_microsoft_local_cleanup', 'expire_pending_outlook_context'];
        user_fns text[] := ARRAY['accept_new_contact_candidate', 'dismiss_new_contact_candidate', 'defer_candidate', 'disconnect_my_outlook'];
BEGIN
  -- anon: nothing, anywhere
  FOREACH t IN ARRAY all_tables LOOP
    FOR c IN SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t LOOP
      ASSERT NOT has_column_privilege('anon', 'public.' || t, c, 'SELECT'), 'anon can read ' || t || '.' || c;
    END LOOP;
    ASSERT NOT has_table_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'), 'anon has table privilege on ' || t;
  END LOOP;
  -- authenticated: sensitive tables fully closed (every privilege, every column)
  FOREACH t IN ARRAY sensitive_tables LOOP
    ASSERT NOT has_table_privilege('authenticated', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'), 'authenticated has privilege on ' || t;
    FOR c IN SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t LOOP
      ASSERT NOT has_column_privilege('authenticated', 'public.' || t, c, 'SELECT, INSERT, UPDATE, REFERENCES'), 'authenticated column privilege ' || t || '.' || c;
    END LOOP;
  END LOOP;
  -- authenticated: no write privilege on the review tables (all writes via RPC)
  FOREACH t IN ARRAY ARRAY['microsoft_connections', 'new_contact_candidates', 'interaction_candidates'] LOOP
    ASSERT NOT has_table_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'), 'authenticated can write ' || t;
    ASSERT NOT has_table_privilege('authenticated', 'public.' || t, 'SELECT'), 'authenticated has whole-table SELECT on ' || t || ' (must be column-level)';
  END LOOP;
  -- authenticated: exact review-safe columns
  FOREACH c IN ARRAY conn_hidden LOOP
    ASSERT NOT has_column_privilege('authenticated', 'public.microsoft_connections', c, 'SELECT'), 'connections leaks ' || c;
  END LOOP;
  FOREACH c IN ARRAY conn_visible LOOP
    ASSERT has_column_privilege('authenticated', 'public.microsoft_connections', c, 'SELECT'), 'connections hides ' || c;
  END LOOP;
  FOREACH c IN ARRAY ncc_hidden LOOP
    ASSERT NOT has_column_privilege('authenticated', 'public.new_contact_candidates', c, 'SELECT'), 'candidates leak ' || c;
  END LOOP;
  FOREACH c IN ARRAY ncc_visible LOOP
    ASSERT has_column_privilege('authenticated', 'public.new_contact_candidates', c, 'SELECT'), 'candidates hide ' || c;
  END LOOP;
  FOREACH c IN ARRAY ic_new LOOP
    ASSERT has_column_privilege('authenticated', 'public.interaction_candidates', c, 'SELECT'), 'interaction_candidates hides ' || c;
  END LOOP;
  ASSERT NOT has_column_privilege('authenticated', 'public.interaction_candidates', 'source_fingerprint', 'SELECT'), 'interaction_candidates leaks source_fingerprint';
  ASSERT NOT has_column_privilege('authenticated', 'public.interaction_candidates', 'context_expires_at', 'SELECT'), 'interaction_candidates leaks context_expires_at';
  -- service_role: full table privileges (future callers), owner untouched
  FOREACH t IN ARRAY all_tables LOOP
    ASSERT has_table_privilege('service_role', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE'), 'service_role lacks privileges on ' || t;
    ASSERT (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = t) = 'postgres', t || ' owner';
    ASSERT (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = t), t || ' RLS off';
  END LOOP;
  -- functions: exactly one signature each; PUBLIC/anon never; roles as intended
  FOREACH f IN ARRAY service_fns || user_fns || ARRAY['accept_interaction_candidate', 'dismiss_interaction_candidate'] LOOP
    ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = f) = 1, f || ' overloads';
    ASSERT (SELECT pg_get_userbyid(proowner) = 'postgres' AND prosecdef AND proconfig = ARRAY['search_path=""']
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = f), f || ' owner/secdef/search_path';
    ASSERT NOT has_function_privilege('anon', (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = f), 'EXECUTE'), 'anon can execute ' || f;
    ASSERT (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, LATERAL aclexplode(p.proacl) a
                                WHERE n.nspname = 'public' AND p.proname = f AND a.grantee = 0)), 'PUBLIC can execute ' || f;
  END LOOP;
  FOREACH f IN ARRAY service_fns LOOP
    ASSERT has_function_privilege('service_role', (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = f), 'EXECUTE'), 'service_role cannot execute ' || f;
    ASSERT NOT has_function_privilege('authenticated', (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = f), 'EXECUTE'), 'authenticated can execute ' || f;
  END LOOP;
  FOREACH f IN ARRAY user_fns LOOP
    ASSERT has_function_privilege('authenticated', (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = f), 'EXECUTE'), 'authenticated cannot execute ' || f;
    ASSERT NOT has_function_privilege('service_role', (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = f), 'EXECUTE'), 'service_role can execute user function ' || f;
  END LOOP;
  -- the two recreated review RPCs keep their pre-existing ACL exactly (authenticated + service_role, never PUBLIC/anon)
  FOREACH f IN ARRAY ARRAY['accept_interaction_candidate', 'dismiss_interaction_candidate'] LOOP
    ASSERT (SELECT proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = f)
           = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}', f || ' ACL drifted: ' || (SELECT proacl::text FROM pg_proc WHERE proname = f);
  END LOOP;
  -- no obsolete finalization contract survives
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname = 'store_microsoft_connection') = 0, 'obsolete store_microsoft_connection present';
  -- no reliance on default privileges: the new tables' ACLs are explicit (present) and name no anon/PUBLIC grant
  FOREACH t IN ARRAY all_tables LOOP
    ASSERT (SELECT relacl IS NOT NULL FROM pg_class WHERE oid = ('public.' || t)::regclass), t || ' has no explicit ACL';
    ASSERT (SELECT NOT EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a WHERE c.oid = ('public.' || t)::regclass AND (a.grantee = 0 OR a.grantee = 'anon'::regrole))), t || ' grants PUBLIC/anon';
  END LOOP;
END $$;

-- ── 2. Role denials + two-user isolation ──────────────────────────────────────
DO $$
DECLARE u1 uuid := (SELECT uid FROM fx WHERE u = 'U1'); n integer; ok boolean; v jsonb;
BEGIN
  -- anon: no table access, no function execution
  PERFORM set_config('role', 'anon', true);
  ok := false; BEGIN PERFORM 1 FROM public.microsoft_connections; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  ASSERT ok, 'anon read microsoft_connections';
  ok := false; BEGIN PERFORM 1 FROM public.new_contact_candidates; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  ASSERT ok, 'anon read new_contact_candidates';
  ok := false; BEGIN PERFORM public.disconnect_my_outlook(); EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  ASSERT ok, 'anon executed disconnect_my_outlook';
  ok := false; BEGIN PERFORM public.reserve_due_outlook_connection(120, 3600); EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  ASSERT ok, 'anon executed reserve';
  PERFORM set_config('role', 'postgres', true);

  -- authenticated U1: sensitive tables + columns denied; worker RPCs denied
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u1::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  ok := false; BEGIN PERFORM 1 FROM public.microsoft_tokens; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  ASSERT ok, 'authenticated read microsoft_tokens';
  ok := false; BEGIN PERFORM 1 FROM public.microsoft_oauth_states; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  ASSERT ok, 'authenticated read microsoft_oauth_states';
  ok := false; BEGIN PERFORM 1 FROM public.outlook_sync_state; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  ASSERT ok, 'authenticated read outlook_sync_state';
  ok := false; BEGIN PERFORM 1 FROM public.outlook_candidate_refs; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  ASSERT ok, 'authenticated read outlook_candidate_refs';
  ok := false; BEGIN PERFORM person_fingerprint FROM public.new_contact_candidates; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  ASSERT ok, 'authenticated read person_fingerprint';
  ok := false; BEGIN PERFORM context_expires_at FROM public.new_contact_candidates; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  ASSERT ok, 'authenticated read context_expires_at';
  ok := false; BEGIN PERFORM ms_account_id FROM public.microsoft_connections; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  ASSERT ok, 'authenticated read ms_account_id';
  ok := false; BEGIN INSERT INTO public.new_contact_candidates (user_id, person_fingerprint, episode_fingerprint) VALUES (u1, pg_temp.fpx('z'), pg_temp.fpx('ze')); EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  ASSERT ok, 'authenticated inserted a candidate';
  ok := false; BEGIN PERFORM public.reserve_due_outlook_connection(120, 3600); EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  ASSERT ok, 'authenticated executed reserve';
  ok := false; BEGIN PERFORM public.run_microsoft_local_cleanup(u1); EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  ASSERT ok, 'authenticated executed run_microsoft_local_cleanup';
  ok := false; BEGIN PERFORM public.expire_pending_outlook_context(10); EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  ASSERT ok, 'authenticated executed expire';
  -- review-safe reads return ONLY own rows
  SELECT count(*) INTO n FROM public.new_contact_candidates;
  ASSERT n = 4, 'U1 sees ' || n || ' new-contact candidates (expected own 4)';
  SELECT count(*) INTO n FROM public.microsoft_connections;
  ASSERT n = 1, 'U1 sees ' || n || ' connections';
  SELECT count(*) INTO n FROM public.interaction_candidates WHERE draft_summary IS NOT NULL;
  ASSERT n = 2, 'U1 sees ' || n || ' outlook drafts (expected own 2)';
  -- acting on U2's candidate is indistinguishable from not found
  v := public.dismiss_new_contact_candidate((SELECT nc_pend FROM fx WHERE u = 'U2'));
  ASSERT v ->> 'result' = 'not_found', 'cross-user dismiss: ' || v::text;
  v := public.accept_new_contact_candidate((SELECT nc_pend FROM fx WHERE u = 'U2'), 'Hijack');
  ASSERT v ->> 'result' = 'not_found', 'cross-user accept: ' || v::text;
  v := public.defer_candidate('new_contact', (SELECT nc_pend FROM fx WHERE u = 'U2'), now() + interval '2 days');
  ASSERT v ->> 'result' = 'not_found', 'cross-user defer: ' || v::text;
  PERFORM set_config('role', 'postgres', true);
END $$;

-- ── 3. New-contact acceptance (U1) ────────────────────────────────────────────
DO $$
DECLARE u1 uuid := (SELECT uid FROM fx WHERE u = 'U1'); r fx%ROWTYPE; v jsonb; cnt integer; c public.contacts%ROWTYPE; i public.interactions%ROWTYPE; nc public.new_contact_candidates%ROWTYPE;
BEGIN
  SELECT * INTO r FROM fx WHERE u = 'U1';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u1::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);

  -- validation before any write
  v := public.accept_new_contact_candidate(r.nc_pend, '   ');
  ASSERT v ->> 'result' = 'invalid_name', 'blank name accepted';
  v := public.accept_new_contact_candidate(r.nc_pend, 'Ada Example', p_linkedin_url => 'https://evil.example.invalid/in/x');
  ASSERT v ->> 'result' = 'invalid_linkedin_url', 'bad linkedin accepted';
  v := public.accept_new_contact_candidate(r.nc_pend, 'Ada Example', p_interaction_type => 'Telegram');
  ASSERT v ->> 'result' = 'invalid_type', 'bad type accepted';
  v := public.accept_new_contact_candidate(r.nc_pend, 'Ada Example', p_interaction_notes => repeat('n', 201));
  ASSERT v ->> 'result' = 'invalid_notes', 'long notes accepted';
  ASSERT (SELECT count(*) FROM public.contacts WHERE user_id = u1) = 1, 'validation wrote a contact';

  -- duplicate email refused
  v := public.accept_new_contact_candidate(r.nc_dup, 'Existing Again');
  ASSERT v ->> 'result' = 'duplicate_email' AND (v ->> 'contact_id')::uuid = r.contact, 'duplicate not refused: ' || v::text;
  ASSERT (SELECT status FROM public.new_contact_candidates WHERE id = r.nc_dup) = 'pending', 'duplicate candidate changed state';

  -- expired draft refused
  v := public.accept_new_contact_candidate(r.nc_exp, 'Exp Person');
  ASSERT v ->> 'result' = 'expired', 'expired draft accepted';

  -- ADD BOTH (atomic): contact + first interaction
  v := public.accept_new_contact_candidate(r.nc_pend, 'Ada Example', 'Example Corp', 'Recruiter', 'Email conversation', 'https://www.linkedin.com/in/ada-example',
         ARRAY['recruiter'], 'Potential employer', NULL, true, NULL, NULL, NULL, current_date + 7);
  ASSERT v ->> 'result' = 'accepted', 'add-both failed: ' || v::text;
  SELECT * INTO c FROM public.contacts WHERE id = (v ->> 'contact_id')::uuid;
  ASSERT c.user_id = u1 AND c.email = 'newperson-u1@example.invalid' AND c.name = 'Ada Example' AND c.company = 'Example Corp' AND c.role = 'Recruiter'
         AND c.linkedin_url = 'https://www.linkedin.com/in/ada-example' AND c.tags = ARRAY['recruiter'], 'contact fields wrong';
  SELECT * INTO i FROM public.interactions WHERE id = (v ->> 'interaction_id')::uuid;
  ASSERT i.user_id = u1 AND i.contact_id = c.id AND i.source = 'outlook' AND i.type = 'Email' AND i.interaction_date = current_date
         AND i.notes = 'Ada described the summer analyst role and offered to intro the hiring lead.' AND i.follow_up_date = current_date + 7, 'interaction fields wrong';
  PERFORM set_config('role', 'postgres', true);   -- full-row inspection needs the owner (authenticated lacks internal columns)
  SELECT * INTO nc FROM public.new_contact_candidates WHERE id = r.nc_pend;
  ASSERT nc.status = 'accepted' AND nc.accepted_contact_id = c.id AND nc.accepted_interaction_id = i.id, 'candidate linkage wrong';
  ASSERT nc.proposed_email IS NULL AND nc.proposed_name IS NULL AND nc.proposed_company IS NULL AND nc.proposed_role IS NULL AND nc.proposed_linkedin_url IS NULL
         AND nc.proposed_name_evidence IS NULL AND nc.proposed_company_confidence IS NULL AND nc.draft_summary IS NULL AND nc.draft_follow_up IS NULL
         AND nc.retained_subject IS NULL AND nc.context_expires_at IS NULL AND nc.deferred_until IS NULL, 'accept did not erase context';
  ASSERT nc.person_fingerprint = pg_temp.fpx('person-newU1') AND nc.episode_fingerprint = pg_temp.fpx('ep-newU1'), 'fingerprints lost';
  PERFORM set_config('role', 'authenticated', true);
  v := public.accept_new_contact_candidate(r.nc_pend, 'Ada Example');
  ASSERT v ->> 'result' = 'already_accepted' AND (v ->> 'contact_id')::uuid = c.id, 're-accept not idempotent';

  -- ADD CONTACT ONLY
  v := public.accept_new_contact_candidate(r.nc_only, 'Only Contact', p_create_interaction => false);
  ASSERT v ->> 'result' = 'accepted' AND v ->> 'interaction_id' IS NULL, 'contact-only failed: ' || v::text;
  ASSERT (SELECT count(*) FROM public.interactions WHERE contact_id = (v ->> 'contact_id')::uuid) = 0, 'contact-only created an interaction';
  ASSERT (SELECT accepted_interaction_id FROM public.new_contact_candidates WHERE id = r.nc_only) IS NULL, 'contact-only linked an interaction';
  PERFORM set_config('role', 'postgres', true);
END $$;

-- forced interaction failure → NO orphan contact, controlled code, candidate still open
CREATE OR REPLACE FUNCTION pg_temp.force_fail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.notes = 'FORCE_FAIL' THEN RAISE EXCEPTION 'forced'; END IF; RETURN NEW; END $$;
CREATE TRIGGER rt_force_fail BEFORE INSERT ON public.interactions FOR EACH ROW EXECUTE FUNCTION pg_temp.force_fail();
DO $$
DECLARE u2 uuid := (SELECT uid FROM fx WHERE u = 'U2'); r fx%ROWTYPE; v jsonb;
BEGIN
  SELECT * INTO r FROM fx WHERE u = 'U2';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u2::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  v := public.accept_new_contact_candidate(r.nc_pend, 'Ada Example', p_interaction_notes => 'FORCE_FAIL');
  ASSERT v ->> 'result' = 'write_failed', 'forced failure not controlled: ' || v::text;
  ASSERT (SELECT count(*) FROM public.contacts WHERE user_id = u2 AND email = 'newperson-u2@example.invalid') = 0, 'ORPHAN CONTACT CREATED';
  ASSERT (SELECT status FROM public.new_contact_candidates WHERE id = r.nc_pend) = 'pending', 'candidate not left open';
  PERFORM set_config('role', 'postgres', true);
END $$;
DROP TRIGGER rt_force_fail ON public.interactions;

-- ── 4. Dismiss / defer / idempotency (U2's remaining drafts) ──────────────────
DO $$
DECLARE u2 uuid := (SELECT uid FROM fx WHERE u = 'U2'); r fx%ROWTYPE; v jsonb; exp timestamptz;
BEGIN
  SELECT * INTO r FROM fx WHERE u = 'U2';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u2::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);

  -- defer new-contact
  v := public.defer_candidate('new_contact', r.nc_pend, now() + interval '40 days');
  ASSERT v ->> 'result' = 'invalid_until', 'defer > 30 days accepted';
  v := public.defer_candidate('new_contact', r.nc_pend, now() + interval '28 days');
  ASSERT v ->> 'result' = 'beyond_context', 'defer beyond context accepted';
  v := public.defer_candidate('new_contact', r.nc_pend, now() + interval '3 days');
  ASSERT v ->> 'result' = 'deferred', 'defer failed: ' || v::text;
  ASSERT (SELECT status FROM public.new_contact_candidates WHERE id = r.nc_pend) = 'deferred', 'status not deferred';
  v := public.defer_candidate('new_contact', r.nc_pend, NULL);
  ASSERT v ->> 'result' = 'undeferred' AND (SELECT status FROM public.new_contact_candidates WHERE id = r.nc_pend) = 'pending', 'undefer failed';
  v := public.defer_candidate('new_contact', r.nc_exp, now() + interval '1 day');
  ASSERT v ->> 'result' = 'expired', 'expired deferred';
  -- defer interaction kinds
  v := public.defer_candidate('interaction', r.c_pend, now() + interval '1 day');
  ASSERT v ->> 'result' = 'not_deferrable', 'calendar candidate deferred';
  v := public.defer_candidate('interaction', r.g_pend, now() + interval '1 day');
  ASSERT v ->> 'result' = 'not_deferrable', 'gmail candidate deferred';
  v := public.defer_candidate('interaction', r.o_pend, now() + interval '2 days');
  ASSERT v ->> 'result' = 'deferred' AND (SELECT deferred_until FROM public.interaction_candidates WHERE id = r.o_pend) IS NOT NULL, 'outlook interaction defer failed';
  ASSERT (SELECT status FROM public.interaction_candidates WHERE id = r.o_pend) = 'pending', 'outlook interaction status changed by defer';
  v := public.defer_candidate('interaction', r.o_pend, now() + interval '25 days');
  ASSERT v ->> 'result' = 'beyond_context', 'outlook interaction defer beyond context';
  v := public.defer_candidate('bogus', r.o_pend, NULL);
  ASSERT v ->> 'result' = 'invalid_kind', 'bogus kind accepted';

  -- dismiss new-contact (deferred → dismissed) then idempotent
  v := public.defer_candidate('new_contact', r.nc_pend, now() + interval '3 days');
  v := public.dismiss_new_contact_candidate(r.nc_pend);
  ASSERT v ->> 'result' = 'dismissed', 'dismiss failed';
  ASSERT (SELECT proposed_email IS NULL AND proposed_name IS NULL AND draft_summary IS NULL AND deferred_until IS NULL
          FROM public.new_contact_candidates WHERE id = r.nc_pend), 'dismiss did not erase';
  v := public.dismiss_new_contact_candidate(r.nc_pend);
  ASSERT v ->> 'result' = 'already_dismissed', 'dismiss not idempotent';
  v := public.accept_new_contact_candidate(r.nc_pend, 'x');
  ASSERT v ->> 'result' = 'dismissed', 'accept after dismiss';

  -- existing paths unchanged: gmail accept, calendar dismiss, outlook accept
  v := public.accept_interaction_candidate(r.g_pend);
  ASSERT v ->> 'result' = 'accepted', 'gmail accept: ' || v::text;
  ASSERT (SELECT source FROM public.interactions WHERE id = (v ->> 'interaction_id')::uuid) = 'gmail', 'gmail provenance';
  ASSERT (SELECT retained_subject IS NULL AND draft_summary IS NULL FROM public.interaction_candidates WHERE id = r.g_pend), 'gmail accept erasure';
  v := public.dismiss_interaction_candidate(r.c_pend);
  ASSERT v ->> 'result' = 'dismissed', 'calendar dismiss: ' || v::text;
  v := public.dismiss_interaction_candidate(r.c_pend);
  ASSERT v ->> 'result' = 'already_dismissed', 'calendar dismiss idempotency';
  v := public.accept_interaction_candidate(r.o_pend, NULL, NULL, 'Reviewed outlook note');
  ASSERT v ->> 'result' = 'accepted', 'outlook accept: ' || v::text;
  ASSERT (SELECT source FROM public.interactions WHERE id = (v ->> 'interaction_id')::uuid) = 'outlook', 'outlook provenance';
  ASSERT (SELECT notes FROM public.interactions WHERE id = (v ->> 'interaction_id')::uuid) = 'Reviewed outlook note', 'user note not used';
  ASSERT (SELECT draft_summary IS NULL AND draft_follow_up IS NULL AND summary_evidence IS NULL AND deferred_until IS NULL AND retained_subject IS NULL
          FROM public.interaction_candidates WHERE id = r.o_pend), 'outlook accept did not erase drafts';
  PERFORM set_config('role', 'postgres', true);
  ASSERT (SELECT source_fingerprint FROM public.interaction_candidates WHERE id = r.o_pend) = pg_temp.fpx('o_pendU2'), 'fingerprint lost';
  ASSERT (SELECT context_expires_at IS NULL FROM public.interaction_candidates WHERE id = r.o_pend), 'outlook accept left deadline';
  ASSERT (SELECT context_expires_at IS NULL FROM public.interaction_candidates WHERE id = r.g_pend), 'gmail accept left deadline';
END $$;
DO $$
BEGIN
  ASSERT (SELECT context_expires_at IS NULL AND retained_subject IS NULL AND proposed_name_evidence IS NULL
          FROM public.new_contact_candidates WHERE id = (SELECT nc_pend FROM fx WHERE u = 'U2')), 'dismiss left internal context';
END $$;

-- ── 5. Lease lifecycle (service-role contracts, U1's connection is the only due one) ──
DO $$
DECLARE m1 uuid := (SELECT mconn FROM fx WHERE u = 'U1'); m2 uuid := (SELECT mconn FROM fx WHERE u = 'U2');
        v jsonb; run1 uuid; run2 uuid; ok boolean; s record;
BEGIN
  -- make U2 not due (needs_reauth) so exactly one connection is due
  PERFORM public.update_microsoft_connection_state(m2, (SELECT uid FROM fx WHERE u = 'U2'), 'needs_reauth', true, 'invalid_grant');

  v := public.reserve_due_outlook_connection(120, 3600);
  ASSERT v ->> 'result' = 'reserved' AND (v ->> 'connection_id')::uuid = m1, 'reserve #1: ' || v::text;
  run1 := (v ->> 'run_id')::uuid;
  ASSERT (SELECT count(*) FROM public.outlook_sync_state WHERE connection_id = m1 AND sync_status = 'running' AND sync_run_id = run1) = 2, 'both folder rows not leased';
  v := public.reserve_due_outlook_connection(120, 3600);
  ASSERT v ->> 'result' = 'none_due', 'second reservation while leased: ' || v::text;

  -- stale run cannot renew / release / invalidate
  ASSERT public.renew_outlook_sync_lease(m1, gen_random_uuid(), 120) = false, 'stale renew succeeded';
  ASSERT public.release_outlook_sync_lease(m1, gen_random_uuid(), 'idle', NULL, true, 'ct', 'n', 'ct2', 'n2', 1::smallint, true, NULL) = false, 'stale release succeeded';
  ASSERT (SELECT count(*) FROM public.outlook_sync_state WHERE connection_id = m1 AND sync_status = 'running' AND delta_link_ciphertext IS NULL) = 2, 'stale release changed state';
  v := public.invalidate_outlook_candidates_by_fingerprint(m1, gen_random_uuid(), ARRAY[pg_temp.fpx('o_expU1')]);
  ASSERT v ->> 'result' = 'stale_run', 'stale invalidate: ' || v::text;
  ASSERT public.renew_outlook_sync_lease(m1, run1, 300) = true, 'live renew failed';

  -- invalidation with the live lease: only the listed pending candidates
  v := public.invalidate_outlook_candidates_by_fingerprint(m1, run1, ARRAY[pg_temp.fpx('o_expU1'), pg_temp.fpx('ep-dupU1'), pg_temp.fpx('ep-newU1'), pg_temp.fpx('o_pendU2')]);
  ASSERT (v ->> 'invalidated')::integer = 2, 'invalidate count ' || v::text;
  ASSERT (SELECT status FROM public.interaction_candidates WHERE id = (SELECT o_exp FROM fx WHERE u = 'U1')) = 'invalidated', 'o_exp not invalidated';
  ASSERT (SELECT status FROM public.new_contact_candidates WHERE id = (SELECT nc_dup FROM fx WHERE u = 'U1')) = 'invalidated', 'nc_dup not invalidated';
  ASSERT (SELECT proposed_email IS NULL AND draft_summary IS NULL FROM public.new_contact_candidates WHERE id = (SELECT nc_dup FROM fx WHERE u = 'U1')), 'invalidate did not erase';
  ASSERT (SELECT status FROM public.new_contact_candidates WHERE id = (SELECT nc_pend FROM fx WHERE u = 'U1')) = 'accepted', 'terminal row resurrected';
  ASSERT (SELECT status FROM public.interaction_candidates WHERE id = (SELECT o_pend FROM fx WHERE u = 'U2')) = 'accepted', 'other user/connection row touched';
  v := public.invalidate_outlook_candidates_by_fingerprint(m1, run1, ARRAY['zz']);
  ASSERT v ->> 'result' = 'invalid_fingerprint', 'bad fingerprint accepted';

  -- INCOMPLETE release: cursor held, backoff recorded
  ASSERT public.release_outlook_sync_lease(m1, run1, 'idle', 'max_pages_exceeded', false, 'ct-inbox', 'n', 'ct-sent', 'n', 1::smallint, true, 300) = true, 'incomplete release failed';
  FOR s IN SELECT * FROM public.outlook_sync_state WHERE connection_id = m1 LOOP
    ASSERT s.sync_status = 'idle' AND s.sync_run_id IS NULL AND s.sync_lease_until IS NULL, 'lease not released';
    ASSERT s.delta_link_ciphertext IS NULL AND s.initial_import_done = false, 'INCOMPLETE run advanced cursor';
    ASSERT s.retry_count = 1 AND s.next_retry_at > now() AND s.last_run_complete = false AND s.last_success_at IS NULL, 'backoff not recorded';
  END LOOP;
  v := public.reserve_due_outlook_connection(120, 3600);
  ASSERT v ->> 'result' = 'none_due', 'reserved during backoff';
  UPDATE public.outlook_sync_state SET next_retry_at = NULL, last_attempt_at = now() - interval '6 minutes' WHERE connection_id = m1;
  v := public.reserve_due_outlook_connection(120, 3600);
  ASSERT v ->> 'result' = 'reserved', 'retry reservation failed: ' || v::text;
  run2 := (v ->> 'run_id')::uuid;
  ASSERT run2 <> run1, 'run id reused';
  ASSERT public.renew_outlook_sync_lease(m1, run1, 120) = false, 'old run renewed new lease';

  -- COMPLETE release: cursors advance, counters reset
  ASSERT public.release_outlook_sync_lease(m1, run2, 'idle', NULL, true, 'ct-inbox', 'n-inbox', 'ct-sent', 'n-sent', 2::smallint, true, NULL) = true, 'complete release failed';
  ASSERT (SELECT delta_link_ciphertext FROM public.outlook_sync_state WHERE connection_id = m1 AND folder = 'inbox') = 'ct-inbox', 'inbox cursor not advanced';
  ASSERT (SELECT delta_link_nonce FROM public.outlook_sync_state WHERE connection_id = m1 AND folder = 'sentitems') = 'n-sent', 'sent cursor not advanced';
  ASSERT (SELECT bool_and(initial_import_done AND retry_count = 0 AND next_retry_at IS NULL AND last_run_complete AND last_success_at IS NOT NULL AND delta_key_version = 2) FROM public.outlook_sync_state WHERE connection_id = m1), 'complete release state wrong';
  ASSERT public.release_outlook_sync_lease(m1, run2, 'idle', NULL, true, NULL, NULL, NULL, NULL, NULL, false, NULL) = false, 'double release succeeded';
  -- freshly synced: not due again yet
  v := public.reserve_due_outlook_connection(120, 3600);
  ASSERT v ->> 'result' = 'none_due', 'reserved right after success';
  -- error release on a new run: cursor kept
  UPDATE public.outlook_sync_state SET last_success_at = now() - interval '2 hours' WHERE connection_id = m1;
  v := public.reserve_due_outlook_connection(120, 3600);
  ASSERT v ->> 'result' = 'reserved', 'due after cadence failed';
  ASSERT public.release_outlook_sync_lease(m1, (v ->> 'run_id')::uuid, 'error', 'provider_5xx', false, 'ct-x', 'n-x', NULL, NULL, NULL, false, 600) = true, 'error release failed';
  ASSERT (SELECT delta_link_ciphertext FROM public.outlook_sync_state WHERE connection_id = m1 AND folder = 'inbox') = 'ct-inbox', 'error run advanced cursor';
  ASSERT (SELECT bool_and(last_error_code = 'provider_5xx' AND retry_count = 1) FROM public.outlook_sync_state WHERE connection_id = m1), 'error not recorded';
  -- invalid inputs
  ok := false; BEGIN PERFORM public.reserve_due_outlook_connection(0, 10); EXCEPTION WHEN raise_exception THEN ok := true; END;
  ASSERT ok, 'invalid lease accepted';
  ok := false; BEGIN PERFORM public.release_outlook_sync_lease(m1, run2, 'weird', NULL, true, NULL, NULL, NULL, NULL, NULL, false, NULL); EXCEPTION WHEN raise_exception THEN ok := true; END;
  ASSERT ok, 'invalid release status accepted';
END $$;

-- ── 6. Bounded expiry (SKIP LOCKED, oldest first) ─────────────────────────────
DO $$
DECLARE v jsonb; n integer;
BEGIN
  -- U2's expired rows are still open (U1's o_exp was invalidated by fingerprint above,
  -- U1's nc_exp is still open) → 3 due rows: nc_exp U1, o_exp U2, nc_exp U2.
  v := public.expire_pending_outlook_context(1);
  ASSERT (v ->> 'expired')::integer = 1 AND (v ->> 'more')::boolean = true, 'batch 1: ' || v::text;
  v := public.expire_pending_outlook_context(500);
  ASSERT (v ->> 'expired')::integer = 2 AND (v ->> 'more')::boolean = false, 'batch 2: ' || v::text;
  SELECT count(*) INTO n FROM public.new_contact_candidates WHERE status = 'invalidated' AND proposed_email IS NULL AND proposed_name IS NULL AND draft_summary IS NULL
    AND retained_subject IS NULL AND context_expires_at IS NULL AND person_fingerprint IS NOT NULL AND episode_fingerprint IS NOT NULL
    AND id IN (SELECT nc_exp FROM fx);
  ASSERT n = 2, 'expired new-contact rows not erased (' || n || ')';
  ASSERT (SELECT status = 'invalidated' AND draft_summary IS NULL AND retained_subject IS NULL AND source_fingerprint IS NOT NULL
          FROM public.interaction_candidates WHERE id = (SELECT o_exp FROM fx WHERE u = 'U2')), 'expired outlook interaction not erased';
  -- Gmail pending candidate untouched (still has subject + deadline)
  ASSERT (SELECT count(*) FROM public.interaction_candidates WHERE source = 'gmail' AND status = 'pending' AND retained_subject IS NOT NULL) = 1, 'gmail candidate touched by outlook expiry';
  v := public.expire_pending_outlook_context(0);
  ASSERT v ->> 'result' = 'invalid_batch_size', 'batch 0 accepted';
END $$;

-- ── 7. Outlook disconnect (U1) leaves Google / Gmail / contacts / others untouched ──
DO $$
DECLARE u1 uuid := (SELECT uid FROM fx WHERE u = 'U1'); u2 uuid := (SELECT uid FROM fx WHERE u = 'U2'); v jsonb; b base%ROWTYPE; b2 base%ROWTYPE;
BEGIN
  -- give U1 one more open draft so disconnect has something to erase
  INSERT INTO public.new_contact_candidates (user_id, person_fingerprint, episode_fingerprint, proposed_email, proposed_name, proposed_name_evidence, proposed_name_confidence, draft_summary, proposed_interaction_date, context_expires_at)
    VALUES (u1, pg_temp.fpx('person-late'), pg_temp.fpx('ep-late'), 'late@example.invalid', 'Late Person', 'provider_metadata', 'high', 'Late draft.', current_date, now() + interval '5 days');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u1::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  v := public.disconnect_my_outlook();
  ASSERT v ->> 'result' = 'disconnected', 'disconnect: ' || v::text;
  v := public.disconnect_my_outlook();
  ASSERT v ->> 'result' = 'not_connected', 'disconnect not idempotent: ' || v::text;
  PERFORM set_config('role', 'postgres', true);

  ASSERT (SELECT count(*) FROM public.microsoft_connections WHERE user_id = u1) = 0, 'connection remains';
  ASSERT (SELECT count(*) FROM public.microsoft_tokens WHERE user_id = u1) = 0, 'tokens remain';
  ASSERT (SELECT count(*) FROM public.microsoft_oauth_states WHERE user_id = u1) = 0, 'oauth states remain';
  ASSERT (SELECT count(*) FROM public.outlook_sync_state WHERE user_id = u1) = 0, 'sync state remains';
  ASSERT (SELECT count(*) FROM public.outlook_candidate_refs WHERE user_id = u1) = 0, 'refs remain';
  ASSERT (SELECT count(*) FROM public.new_contact_candidates WHERE user_id = u1 AND status IN ('pending','deferred')) = 0, 'open drafts remain';
  ASSERT (SELECT count(*) FROM public.new_contact_candidates WHERE user_id = u1 AND (proposed_email IS NOT NULL OR draft_summary IS NOT NULL OR context_expires_at IS NOT NULL)) = 0, 'context remains';
  ASSERT (SELECT count(*) FROM public.new_contact_candidates WHERE user_id = u1) = 5, 'tombstones lost';
  ASSERT (SELECT count(*) FROM public.new_contact_candidates WHERE user_id = u1 AND status = 'accepted' AND accepted_contact_id IS NOT NULL) = 2, 'accepted linkage lost';
  -- Google / Gmail / contacts / interactions unchanged for U1
  SELECT * INTO b FROM base WHERE uid = u1;
  ASSERT (SELECT count(*) FROM public.google_connections WHERE user_id = u1) = b.gconns, 'google connection touched';
  ASSERT (SELECT count(*) FROM public.google_connection_capabilities WHERE user_id = u1) = b.gcaps, 'capabilities touched';
  ASSERT (SELECT count(*) FROM public.gmail_sync_state WHERE user_id = u1) = b.gsync, 'gmail cursor touched';
  ASSERT (SELECT count(*) FROM public.google_oauth_states WHERE user_id = u1) = b.gstates, 'google oauth states touched';
  ASSERT (SELECT count(*) FROM public.interaction_candidates WHERE user_id = u1 AND source = 'gmail' AND status = 'pending' AND retained_subject = 'Gmail subject U1') = 1, 'gmail candidate touched';
  ASSERT (SELECT count(*) FROM public.interaction_candidates WHERE user_id = u1 AND source = 'google_calendar' AND status = 'pending') = 1, 'calendar candidate touched';
  ASSERT (SELECT count(*) FROM public.interactions WHERE user_id = u1) = b.interactions + 1, 'interactions changed unexpectedly';  -- +1 = the approved Outlook interaction
  ASSERT (SELECT count(*) FROM public.contacts WHERE user_id = u1) = b.contacts + 2, 'contacts changed unexpectedly';          -- +2 = the approved new contacts
  -- U2 completely untouched
  SELECT * INTO b2 FROM base WHERE uid = u2;
  ASSERT (SELECT count(*) FROM public.microsoft_connections WHERE user_id = u2) = 1, 'U2 connection touched';
  ASSERT (SELECT count(*) FROM public.microsoft_tokens WHERE user_id = u2) = 1, 'U2 tokens touched';
  ASSERT (SELECT count(*) FROM public.outlook_candidate_refs WHERE user_id = u2) = 6, 'U2 refs touched';
  ASSERT (SELECT count(*) FROM public.new_contact_candidates WHERE user_id = u2 AND status = 'pending') = 2, 'U2 open drafts touched';
END $$;

-- ── 8. run_microsoft_local_cleanup (service role) + account deletion cascade ──
DO $$
DECLARE u2 uuid := (SELECT uid FROM fx WHERE u = 'U2'); v jsonb;
BEGIN
  v := public.run_microsoft_local_cleanup(u2);
  ASSERT v ->> 'result' = 'cleaned' AND (v ->> 'connections_deleted')::integer = 1 AND (v ->> 'new_contact_candidates_invalidated')::integer = 2, 'cleanup: ' || v::text;
  ASSERT (SELECT count(*) FROM public.microsoft_connections WHERE user_id = u2) = 0, 'U2 connection remains';
  ASSERT (SELECT count(*) FROM public.new_contact_candidates WHERE user_id = u2 AND proposed_email IS NOT NULL) = 0, 'U2 context remains';
  ASSERT (SELECT count(*) FROM public.google_connections WHERE user_id = u2) = 1, 'U2 google touched';
  v := public.run_microsoft_local_cleanup(u2);
  ASSERT v ->> 'result' = 'cleaned' AND (v ->> 'connections_deleted')::integer = 0, 'cleanup not idempotent';
  v := public.run_microsoft_local_cleanup(NULL);
  ASSERT v ->> 'result' = 'invalid_user', 'null user accepted';
END $$;

-- account deletion (U1) cascades every Outlook row
DELETE FROM auth.users WHERE id = (SELECT uid FROM fx WHERE u = 'U1');
DO $$
DECLARE u1 uuid := 'b1000000-0000-4000-8000-000000000001';
BEGIN
  ASSERT (SELECT count(*) FROM public.new_contact_candidates WHERE user_id = u1) = 0, 'candidates survived account deletion';
  ASSERT (SELECT count(*) FROM public.microsoft_connections WHERE user_id = u1) = 0, 'connection survived';
  ASSERT (SELECT count(*) FROM public.outlook_candidate_refs WHERE user_id = u1) = 0, 'refs survived';
  ASSERT (SELECT count(*) FROM public.interaction_candidates WHERE user_id = u1) = 0, 'interaction candidates survived';
END $$;

-- ── Teardown: everything synthetic is removed (bystander user + rows) ─────────
DELETE FROM auth.users WHERE id IN ('b1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000002');
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.microsoft_connections) = 0, 'leftover connections';
  ASSERT (SELECT count(*) FROM public.new_contact_candidates) = 0, 'leftover candidates';
  ASSERT (SELECT count(*) FROM public.outlook_candidate_refs) = 0, 'leftover refs';
  ASSERT (SELECT count(*) FROM public.outlook_sync_state) = 0, 'leftover sync state';
  ASSERT (SELECT count(*) FROM public.contacts WHERE email LIKE '%@example.invalid') = 0, 'leftover contacts';
END $$;
COMMIT;

SELECT 'outlook-content-draft-runtime: all assertions passed';
