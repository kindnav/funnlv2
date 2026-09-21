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

    -- Microsoft connection through the RPC (service-role contract)
    v_res := public.store_microsoft_connection(r.uid, 'msacct-' || sfx, 'consumers', 'personal', 'ol-' || sfx || '@example.invalid',
               ARRAY['Mail.Read','offline_access','openid','email'], 'active', now(), 'privacy-2026-09-20',
               now() + interval '1 hour', 'act', 'an', 'rct', 'rn', 1::smallint);
    ASSERT v_res ->> 'result' = 'stored', 'store_microsoft_connection failed: ' || v_res::text;
    v_mconn := (v_res ->> 'connection_id')::uuid;
    INSERT INTO public.microsoft_oauth_states (state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce, return_origin, expires_at)
      VALUES (pg_temp.fpx('state' || r.u), r.uid, 'c', 'n', 'https://www.getfunnl.com', now() + interval '10 minutes');

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

-- different-account reconnect is refused by the RPC
DO $$
DECLARE u1 uuid := (SELECT uid FROM fx WHERE u = 'U1'); v jsonb;
BEGIN
  v := public.store_microsoft_connection(u1, 'someone-else', 'consumers', 'personal', 'other@example.invalid', ARRAY['Mail.Read'], 'active', now(), 'v', NULL, NULL, NULL, 'r', 'n', 1::smallint);
  ASSERT v ->> 'result' = 'different_account', 'account swap allowed: ' || v::text;
  v := public.store_microsoft_connection(u1, 'msacct-u1', 'consumers', 'personal', 'ol-u1@example.invalid', ARRAY['Mail.Read'], 'active', now(), 'v', NULL, NULL, NULL, 'r2', 'n2', 1::smallint);
  ASSERT v ->> 'result' = 'stored', 'same-account reconnect failed';
  ASSERT (SELECT refresh_token_ciphertext FROM public.microsoft_tokens WHERE user_id = u1) = 'r2', 'refresh token not rotated';
  ASSERT (SELECT count(*) FROM public.microsoft_connections WHERE user_id = u1) = 1, 'connection duplicated';
  v := public.update_microsoft_connection_state((SELECT mconn FROM fx WHERE u = 'U1'), (SELECT uid FROM fx WHERE u = 'U2'), 'needs_reauth', true, 'invalid_grant');
  ASSERT v ->> 'result' = 'owner_mismatch', 'cross-user state update allowed';
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
