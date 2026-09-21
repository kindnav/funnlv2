-- Outlook content-aware drafts — PR-A: schema foundation (Outlook-isolated primitives).
--
-- SCOPE (this migration only): the ADDITIVE tables, constraints, grants and service /
-- user RPCs a later dormant Outlook OAuth callback, bounded Graph worker and review UI
-- will use. It adds NO Edge Function, NO scheduler (Cron is a held-back FINAL rollout
-- step), NO webhook, NO OAuth configuration, NO flag, NO secret, NO Graph or Anthropic
-- call, and NO UI. Applying it creates ZERO Outlook rows. Gmail and Google Calendar
-- tables, rows, RPCs and behavior are unchanged; Gmail remains disabled.
--
-- OWNER DECISIONS RECORDED (see docs/ Outlook audit trail; enforced here where structural):
--   * Outlook is prioritized over Gmail; Gmail stays dormant and untouched.
--   * AI processing happens only in a later worker phase under the owner's provider
--     terms and disclosures; nothing in this schema depends on the provider's data
--     retention arrangement, so a later change of arrangement needs no schema rewrite.
--   * Hybrid design: deterministic eligibility/validation; AI only for bounded
--     structured extraction; email is untrusted data; the model gets no tools, secrets
--     or database authority. NOTHING model-facing lives in the database.
--   * New-contact suggestions require a real two-sided direct exchange (enforced by the
--     worker; the schema only stores the outcome).
--   * No company inference from a domain; company/role/LinkedIn/how-met need explicit
--     message or signature evidence (evidence CHECKs below) or stay NULL.
--   * Only fields the existing contact model supports are proposed (name, email,
--     company, role, how_met, linkedin_url). No phone / location / website / enrichment.
--   * draft_summary <= 200 chars (the current interaction note limit);
--     retained_subject <= 160; draft_follow_up <= 160.
--   * Raw email content is MEMORY-ONLY in the worker: never stored, logged, analyzed
--     or returned. No column here can hold a body, snippet, HTML, MIME, attachment,
--     header set, prompt, model output, Graph id, delta link or provider error body
--     in plaintext (delta links are stored ONLY as ciphertext, service-role only).
--   * No application-layer encryption for draft fields in v1 (Supabase encryption at
--     rest + RLS + minimal grants + server RPCs). OAuth tokens and provider cursors
--     DO use the established ciphertext + nonce + key_version pattern.
--   * Nothing is saved automatically: every contact / interaction requires explicit
--     user approval through the authenticated RPCs below.
--   * Account deletion cascades ALL Outlook state (every table hangs off auth.users
--     with ON DELETE CASCADE); run_microsoft_local_cleanup() exists for callers.
--   * Provider-derived pending draft context expires after 30 days (context_expires_at
--     is CHECK-bounded to created_at + 30 days). Terminal actions, disconnect and
--     expiry erase it immediately. Minimal terminal rows + HMAC fingerprints remain
--     until account deletion for deduplication (to be disclosed).
--   * The initial pilot lookback is 30 days and a worker run yields at most 20 drafts
--     (worker-enforced; not a database concern).
--
-- CONVENTIONS (identical to 20260816 / 20260817 / 20260907 / 20260910 / 20260918):
--   REVOKE ALL then GRANT only the minimum; service_role GRANT ALL on tables; every
--   function SECURITY DEFINER, SET search_path = '', fully-qualified identifiers, no
--   dynamic SQL, controlled result codes only (never a provider message, token, address
--   list, subject or raw payload); composite (id, user_id) foreign keys so a dependent
--   row can never belong to a connection/candidate AND a different user; browser-owned
--   actions derive the caller from auth.uid() and accept no user id.
--
-- ISOLATION INVARIANT: this migration never references google_connections,
-- google_tokens, google_oauth_states, google_connection_capabilities, gmail_sync_state,
-- email_candidate_refs, google_calendar_* or any Gmail/Calendar RPC. The ONLY shared
-- objects touched are interaction_candidates (additive columns + accept/dismiss
-- CREATE OR REPLACE that adds Outlook-context erasure), interactions (already admits
-- 'outlook') and contacts (written only by the user-approved accept RPC).


-- ══════════════════════════════════════════════════════════════════════════════
--  A. microsoft_connections — one Microsoft connection per user (non-secret status)
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE public.microsoft_connections (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ms_account_id          text        NOT NULL,   -- stable Microsoft account id (oid / MSA id); same-account reconnect only
  ms_tenant_id           text,                   -- tenant id for work/school; NULL or 'consumers' for personal
  account_type           text        NOT NULL,   -- 'personal' | 'work'
  ms_email               text        NOT NULL,   -- connected address (display only)
  scopes                 text[]      NOT NULL,   -- granted delegated scopes as returned by Microsoft
  status                 text        NOT NULL DEFAULT 'active',
  needs_reauth           boolean     NOT NULL DEFAULT false,
  consented_at           timestamptz NOT NULL,   -- just-in-time Outlook consent acknowledgment
  consent_policy_version text        NOT NULL,   -- Privacy Policy version acknowledged
  last_result_code       text,                   -- controlled code only (no provider detail)
  last_success_at        timestamptz,
  token_expires_at       timestamptz,            -- access-token expiry (advisory)
  connected_at           timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT microsoft_connections_account_type_check CHECK (account_type IN ('personal', 'work')),
  CONSTRAINT microsoft_connections_status_check       CHECK (status IN ('active', 'needs_reauth', 'revoked', 'disabled')),
  CONSTRAINT microsoft_connections_account_id_len     CHECK (char_length(ms_account_id) BETWEEN 1 AND 256),
  CONSTRAINT microsoft_connections_tenant_id_len      CHECK (ms_tenant_id IS NULL OR char_length(ms_tenant_id) BETWEEN 1 AND 256),
  CONSTRAINT microsoft_connections_email_len          CHECK (char_length(ms_email) BETWEEN 3 AND 320),
  CONSTRAINT microsoft_connections_policy_version_len CHECK (char_length(consent_policy_version) BETWEEN 1 AND 40),
  CONSTRAINT microsoft_connections_result_code_len    CHECK (last_result_code IS NULL OR char_length(last_result_code) <= 100),
  -- MVP cardinality: at most one connected Microsoft account per Funnl user.
  CONSTRAINT microsoft_connections_user_unique UNIQUE (user_id),
  -- Composite target for dependent tables' (connection_id, user_id) foreign keys.
  CONSTRAINT microsoft_connections_id_user_key UNIQUE (id, user_id)
);

CREATE INDEX microsoft_connections_account_idx ON public.microsoft_connections (ms_account_id);

ALTER TABLE public.microsoft_connections ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.microsoft_connections FROM PUBLIC;
REVOKE ALL ON TABLE public.microsoft_connections FROM anon;
REVOKE ALL ON TABLE public.microsoft_connections FROM authenticated;
-- Column-level SELECT of review-safe status only. Excludes id (internal linkage),
-- ms_account_id / ms_tenant_id (provider identifiers) and token_expires_at.
GRANT SELECT (
  account_type, ms_email, scopes, status, needs_reauth, consented_at,
  consent_policy_version, last_result_code, last_success_at, connected_at, updated_at
) ON TABLE public.microsoft_connections TO authenticated;
GRANT ALL ON TABLE public.microsoft_connections TO service_role;
-- No INSERT/UPDATE/DELETE for authenticated: all writes go through RPCs.

CREATE POLICY "microsoft_connections_select_own"
  ON public.microsoft_connections
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);


-- ══════════════════════════════════════════════════════════════════════════════
--  B. microsoft_tokens — encrypted OAuth tokens (service-role ONLY)
-- ══════════════════════════════════════════════════════════════════════════════
-- Same contract as google_tokens: ciphertext + nonce (AES-256-GCM in the Edge
-- Function), key_version for rotation, RLS on, NO policy, NO client grant.
CREATE TABLE public.microsoft_tokens (
  connection_id            uuid        PRIMARY KEY,
  user_id                  uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  access_token_ciphertext  text,
  access_token_nonce       text,
  refresh_token_ciphertext text        NOT NULL,
  refresh_token_nonce      text        NOT NULL,
  key_version              smallint    NOT NULL DEFAULT 1,
  token_expires_at         timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT microsoft_tokens_access_pair_check
    CHECK ((access_token_ciphertext IS NULL AND access_token_nonce IS NULL)
        OR (access_token_ciphertext IS NOT NULL AND access_token_nonce IS NOT NULL)),
  CONSTRAINT microsoft_tokens_key_version_pos CHECK (key_version >= 1),
  CONSTRAINT microsoft_tokens_conn_user_fk FOREIGN KEY (connection_id, user_id)
    REFERENCES public.microsoft_connections(id, user_id) ON DELETE CASCADE
);

CREATE INDEX microsoft_tokens_user_idx ON public.microsoft_tokens (user_id);

ALTER TABLE public.microsoft_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.microsoft_tokens FROM PUBLIC;
REVOKE ALL ON TABLE public.microsoft_tokens FROM anon;
REVOKE ALL ON TABLE public.microsoft_tokens FROM authenticated;
GRANT ALL  ON TABLE public.microsoft_tokens TO service_role;
-- Intentionally NO GRANT and NO POLICY for authenticated: unreadable by clients.


-- ══════════════════════════════════════════════════════════════════════════════
--  C. microsoft_oauth_states — single-use, expiring CSRF/PKCE state (service-role ONLY)
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE public.microsoft_oauth_states (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash               text        NOT NULL UNIQUE,   -- SHA-256 hex of the raw state (raw never stored)
  user_id                  uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pkce_verifier_ciphertext text        NOT NULL,          -- encrypted PKCE verifier (established pattern)
  pkce_verifier_nonce      text        NOT NULL,
  key_version              smallint    NOT NULL DEFAULT 1,
  return_origin            text        NOT NULL,          -- server-validated https origin
  integration_type         text        NOT NULL DEFAULT 'outlook',
  expires_at               timestamptz NOT NULL,
  consumed_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT microsoft_oauth_states_state_hash_shape  CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT microsoft_oauth_states_integration_check CHECK (integration_type IN ('outlook')),
  CONSTRAINT microsoft_oauth_states_return_origin_https CHECK (return_origin LIKE 'https://%'),
  CONSTRAINT microsoft_oauth_states_key_version_pos   CHECK (key_version >= 1)
);

CREATE INDEX microsoft_oauth_states_expires_idx ON public.microsoft_oauth_states (expires_at);
CREATE INDEX microsoft_oauth_states_user_idx    ON public.microsoft_oauth_states (user_id);

ALTER TABLE public.microsoft_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.microsoft_oauth_states FROM PUBLIC;
REVOKE ALL ON TABLE public.microsoft_oauth_states FROM anon;
REVOKE ALL ON TABLE public.microsoft_oauth_states FROM authenticated;
GRANT ALL  ON TABLE public.microsoft_oauth_states TO service_role;
-- Intentionally NO GRANT and NO POLICY for authenticated.


-- ══════════════════════════════════════════════════════════════════════════════
--  D. outlook_sync_state — per (connection, folder) encrypted delta cursor + lease
-- ══════════════════════════════════════════════════════════════════════════════
-- Graph delta links embed provider state tokens, so they are stored ONLY as
-- ciphertext (same nonce/key_version pattern as tokens) and the table is service-role
-- only (RLS on, no grant, no policy). A run leases BOTH folder rows of one connection
-- under one sync_run_id (reservation below), so a run can read Inbox and Sent Items
-- together while no second run can touch the same connection.
CREATE TABLE public.outlook_sync_state (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id         uuid        NOT NULL,
  user_id               uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder                text        NOT NULL,             -- 'inbox' | 'sentitems'
  delta_link_ciphertext text,                             -- encrypted @odata.deltaLink (opaque provider state)
  delta_link_nonce      text,
  delta_key_version     smallint    NOT NULL DEFAULT 1,
  initial_import_done   boolean     NOT NULL DEFAULT false,
  sync_status           text        NOT NULL DEFAULT 'idle',
  sync_run_id           uuid,                             -- lease token (fencing)
  sync_lease_until      timestamptz,                      -- lease expiry
  run_started_at        timestamptz,
  last_attempt_at       timestamptz,
  last_success_at       timestamptz,
  last_run_complete     boolean     NOT NULL DEFAULT false,
  last_error_code       text,
  retry_count           integer     NOT NULL DEFAULT 0,
  next_retry_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT oss_folder_check        CHECK (folder IN ('inbox', 'sentitems')),
  CONSTRAINT oss_status_check        CHECK (sync_status IN ('idle', 'running', 'error')),
  CONSTRAINT oss_error_code_len      CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 100),
  CONSTRAINT oss_delta_pair_check    CHECK ((delta_link_ciphertext IS NULL AND delta_link_nonce IS NULL)
                                        OR (delta_link_ciphertext IS NOT NULL AND delta_link_nonce IS NOT NULL)),
  CONSTRAINT oss_delta_len           CHECK (delta_link_ciphertext IS NULL OR char_length(delta_link_ciphertext) <= 16384),
  CONSTRAINT oss_key_version_pos     CHECK (delta_key_version >= 1),
  CONSTRAINT oss_retry_nonneg        CHECK (retry_count >= 0),
  -- A 'running' row must carry an owning run and a lease deadline.
  CONSTRAINT oss_running_requires_lease
    CHECK (sync_status <> 'running' OR (sync_run_id IS NOT NULL AND sync_lease_until IS NOT NULL)),
  CONSTRAINT oss_connection_folder_unique UNIQUE (connection_id, folder),
  CONSTRAINT oss_conn_user_fk FOREIGN KEY (connection_id, user_id)
    REFERENCES public.microsoft_connections(id, user_id) ON DELETE CASCADE
);

CREATE INDEX outlook_sync_state_connection_idx ON public.outlook_sync_state (connection_id);
CREATE INDEX outlook_sync_state_user_idx       ON public.outlook_sync_state (user_id);

ALTER TABLE public.outlook_sync_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.outlook_sync_state FROM PUBLIC;
REVOKE ALL ON TABLE public.outlook_sync_state FROM anon;
REVOKE ALL ON TABLE public.outlook_sync_state FROM authenticated;
GRANT ALL  ON TABLE public.outlook_sync_state TO service_role;
-- Intentionally NO GRANT and NO POLICY for authenticated: cursors/leases never leak.


-- ══════════════════════════════════════════════════════════════════════════════
--  E0. interaction_candidates — additive Outlook draft columns + composite key
-- ══════════════════════════════════════════════════════════════════════════════
-- Existing rows (Calendar, Gmail) keep NULLs in every new column; no existing RPC
-- sets them; the widened source CHECK from 20260907 already admits 'outlook'.
ALTER TABLE public.interaction_candidates
  ADD COLUMN IF NOT EXISTS draft_summary     text,
  ADD COLUMN IF NOT EXISTS draft_follow_up   text,
  ADD COLUMN IF NOT EXISTS summary_evidence  text,
  ADD COLUMN IF NOT EXISTS extraction_status text,
  ADD COLUMN IF NOT EXISTS deferred_until    timestamptz;

ALTER TABLE public.interaction_candidates
  DROP CONSTRAINT IF EXISTS interaction_candidates_draft_summary_bounds;
ALTER TABLE public.interaction_candidates
  ADD CONSTRAINT interaction_candidates_draft_summary_bounds
  CHECK (draft_summary IS NULL
         OR (char_length(draft_summary) BETWEEN 1 AND 200
             AND draft_summary !~ '[[:cntrl:]]' AND draft_summary !~* '(https?:|www\.)'));

ALTER TABLE public.interaction_candidates
  DROP CONSTRAINT IF EXISTS interaction_candidates_draft_follow_up_bounds;
ALTER TABLE public.interaction_candidates
  ADD CONSTRAINT interaction_candidates_draft_follow_up_bounds
  CHECK (draft_follow_up IS NULL
         OR (char_length(draft_follow_up) BETWEEN 1 AND 160
             AND draft_follow_up !~ '[[:cntrl:]]' AND draft_follow_up !~* '(https?:|www\.)'));

ALTER TABLE public.interaction_candidates
  DROP CONSTRAINT IF EXISTS interaction_candidates_summary_evidence_check;
ALTER TABLE public.interaction_candidates
  ADD CONSTRAINT interaction_candidates_summary_evidence_check
  CHECK ((draft_summary IS NULL AND summary_evidence IS NULL)
      OR (draft_summary IS NOT NULL AND summary_evidence IS NOT NULL
          AND summary_evidence IN ('explicit_body', 'subject_only')));

ALTER TABLE public.interaction_candidates
  DROP CONSTRAINT IF EXISTS interaction_candidates_extraction_status_check;
ALTER TABLE public.interaction_candidates
  ADD CONSTRAINT interaction_candidates_extraction_status_check
  CHECK (extraction_status IS NULL OR extraction_status IN ('deterministic', 'ai_extracted', 'ai_failed'));

-- Outlook draft columns are ONLY admitted on outlook rows; Calendar/Gmail rows keep NULL.
ALTER TABLE public.interaction_candidates
  DROP CONSTRAINT IF EXISTS interaction_candidates_outlook_draft_source_check;
ALTER TABLE public.interaction_candidates
  ADD CONSTRAINT interaction_candidates_outlook_draft_source_check
  CHECK (source = 'outlook'
         OR (draft_summary IS NULL AND draft_follow_up IS NULL AND summary_evidence IS NULL
             AND extraction_status IS NULL AND deferred_until IS NULL));

-- Terminal rows carry no provider-derived draft context and no deferral.
ALTER TABLE public.interaction_candidates
  DROP CONSTRAINT IF EXISTS interaction_candidates_terminal_draft_erased;
ALTER TABLE public.interaction_candidates
  ADD CONSTRAINT interaction_candidates_terminal_draft_erased
  CHECK (status = 'pending'
         OR (draft_summary IS NULL AND draft_follow_up IS NULL AND summary_evidence IS NULL
             AND deferred_until IS NULL));

-- Deferral never outlives the 30-day context deadline.
ALTER TABLE public.interaction_candidates
  DROP CONSTRAINT IF EXISTS interaction_candidates_deferred_within_context;
ALTER TABLE public.interaction_candidates
  ADD CONSTRAINT interaction_candidates_deferred_within_context
  CHECK (deferred_until IS NULL OR (context_expires_at IS NOT NULL AND deferred_until <= context_expires_at));

-- Composite target for outlook_candidate_refs' (candidate_id, user_id) foreign key.
ALTER TABLE public.interaction_candidates
  DROP CONSTRAINT IF EXISTS interaction_candidates_id_user_key;
ALTER TABLE public.interaction_candidates
  ADD CONSTRAINT interaction_candidates_id_user_key UNIQUE (id, user_id);

-- Review UI needs the draft + deferral columns (own rows only via existing RLS).
GRANT SELECT (draft_summary, draft_follow_up, summary_evidence, extraction_status, deferred_until)
  ON TABLE public.interaction_candidates TO authenticated;


-- ══════════════════════════════════════════════════════════════════════════════
--  F. new_contact_candidates — Outlook new-person drafts (separate spine)
-- ══════════════════════════════════════════════════════════════════════════════
-- interaction_candidates requires contact_id, so a "person not yet in Funnl" draft
-- lives here. Every proposed value is bounded, control-free, URL-free (except the
-- validated LinkedIn URL) and evidence-coded. proposed_email comes ONLY from Microsoft
-- participant metadata (the worker's contract), never from model output.
CREATE TABLE public.new_contact_candidates (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source                    text        NOT NULL DEFAULT 'outlook',
  status                    text        NOT NULL DEFAULT 'pending',
  person_fingerprint        text        NOT NULL,   -- HMAC hex (provider + connection + normalized address)
  episode_fingerprint       text        NOT NULL,   -- HMAC hex (provider + connection + conversation + first message)
  key_version               smallint    NOT NULL DEFAULT 1,
  -- proposed contact fields (all erased on terminal transitions)
  proposed_email            text,
  proposed_name             text,
  proposed_name_evidence    text,
  proposed_name_confidence  text,
  proposed_company          text,
  proposed_company_evidence text,
  proposed_company_confidence text,
  proposed_role             text,
  proposed_role_evidence    text,
  proposed_role_confidence  text,
  proposed_how_met          text,
  proposed_how_met_evidence text,
  proposed_how_met_confidence text,
  proposed_linkedin_url     text,
  proposed_linkedin_url_evidence text,
  proposed_linkedin_url_confidence text,
  -- proposed first interaction
  draft_summary             text,
  draft_follow_up           text,
  proposed_interaction_date date,
  proposed_type             text        NOT NULL DEFAULT 'Email',
  retained_subject          text,
  extraction_status         text        NOT NULL DEFAULT 'deterministic',
  -- lifecycle
  context_expires_at        timestamptz,
  deferred_until            timestamptz,
  accepted_contact_id       uuid        REFERENCES public.contacts(id)     ON DELETE SET NULL,
  accepted_interaction_id   uuid        REFERENCES public.interactions(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ncc_source_check  CHECK (source = 'outlook'),
  CONSTRAINT ncc_status_check  CHECK (status IN ('pending', 'accepted', 'dismissed', 'deferred', 'invalidated')),
  CONSTRAINT ncc_type_check    CHECK (proposed_type = 'Email'),
  CONSTRAINT ncc_person_fp_shape  CHECK (person_fingerprint  ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ncc_episode_fp_shape CHECK (episode_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ncc_key_version_pos  CHECK (key_version >= 1),
  CONSTRAINT ncc_extraction_status_check CHECK (extraction_status IN ('deterministic', 'ai_extracted', 'ai_failed')),

  -- Field bounds: length, no control characters, no URL/scheme in plain-text fields.
  CONSTRAINT ncc_email_bounds   CHECK (proposed_email IS NULL
    OR (char_length(proposed_email) BETWEEN 3 AND 320 AND proposed_email !~ '[[:cntrl:][:space:]]' AND proposed_email ~ '^[^@]+@[^@]+\.[^@]+$')),
  CONSTRAINT ncc_name_bounds    CHECK (proposed_name IS NULL
    OR (char_length(proposed_name) BETWEEN 1 AND 120 AND proposed_name !~ '[[:cntrl:]]' AND proposed_name !~* '(https?:|www\.)')),
  CONSTRAINT ncc_company_bounds CHECK (proposed_company IS NULL
    OR (char_length(proposed_company) BETWEEN 1 AND 120 AND proposed_company !~ '[[:cntrl:]]' AND proposed_company !~* '(https?:|www\.)')),
  CONSTRAINT ncc_role_bounds    CHECK (proposed_role IS NULL
    OR (char_length(proposed_role) BETWEEN 1 AND 120 AND proposed_role !~ '[[:cntrl:]]' AND proposed_role !~* '(https?:|www\.)')),
  CONSTRAINT ncc_how_met_bounds CHECK (proposed_how_met IS NULL
    OR (char_length(proposed_how_met) BETWEEN 1 AND 120 AND proposed_how_met !~ '[[:cntrl:]]' AND proposed_how_met !~* '(https?:|www\.)')),
  CONSTRAINT ncc_linkedin_bounds CHECK (proposed_linkedin_url IS NULL
    OR (char_length(proposed_linkedin_url) <= 255 AND proposed_linkedin_url ~ '^https://(www\.)?linkedin\.com/in/[A-Za-z0-9_%.-]+/?$')),
  CONSTRAINT ncc_summary_bounds CHECK (draft_summary IS NULL
    OR (char_length(draft_summary) BETWEEN 1 AND 200 AND draft_summary !~ '[[:cntrl:]]' AND draft_summary !~* '(https?:|www\.)')),
  CONSTRAINT ncc_follow_up_bounds CHECK (draft_follow_up IS NULL
    OR (char_length(draft_follow_up) BETWEEN 1 AND 160 AND draft_follow_up !~ '[[:cntrl:]]' AND draft_follow_up !~* '(https?:|www\.)')),
  CONSTRAINT ncc_subject_bounds CHECK (retained_subject IS NULL
    OR (char_length(retained_subject) <= 160 AND retained_subject !~ '[[:cntrl:]]')),

  -- Evidence / confidence codes: present exactly when the value is present.
  -- name may come from provider metadata (display name) or an explicit signature/body;
  -- company / role / how_met / linkedin REQUIRE explicit signature or body evidence
  -- (no domain inference, no style inference).
  CONSTRAINT ncc_name_evidence_check CHECK (
    (proposed_name IS NULL AND proposed_name_evidence IS NULL AND proposed_name_confidence IS NULL)
    OR (proposed_name IS NOT NULL AND proposed_name_evidence IS NOT NULL AND proposed_name_confidence IS NOT NULL
        AND proposed_name_evidence IN ('provider_metadata', 'explicit_signature', 'explicit_body')
        AND proposed_name_confidence IN ('high', 'medium'))),
  CONSTRAINT ncc_company_evidence_check CHECK (
    (proposed_company IS NULL AND proposed_company_evidence IS NULL AND proposed_company_confidence IS NULL)
    OR (proposed_company IS NOT NULL AND proposed_company_evidence IS NOT NULL AND proposed_company_confidence IS NOT NULL
        AND proposed_company_evidence IN ('explicit_signature', 'explicit_body')
        AND proposed_company_confidence IN ('high', 'medium'))),
  CONSTRAINT ncc_role_evidence_check CHECK (
    (proposed_role IS NULL AND proposed_role_evidence IS NULL AND proposed_role_confidence IS NULL)
    OR (proposed_role IS NOT NULL AND proposed_role_evidence IS NOT NULL AND proposed_role_confidence IS NOT NULL
        AND proposed_role_evidence IN ('explicit_signature', 'explicit_body')
        AND proposed_role_confidence IN ('high', 'medium'))),
  CONSTRAINT ncc_how_met_evidence_check CHECK (
    (proposed_how_met IS NULL AND proposed_how_met_evidence IS NULL AND proposed_how_met_confidence IS NULL)
    OR (proposed_how_met IS NOT NULL AND proposed_how_met_evidence IS NOT NULL AND proposed_how_met_confidence IS NOT NULL
        AND proposed_how_met_evidence IN ('explicit_signature', 'explicit_body')
        AND proposed_how_met_confidence IN ('high', 'medium'))),
  CONSTRAINT ncc_linkedin_evidence_check CHECK (
    (proposed_linkedin_url IS NULL AND proposed_linkedin_url_evidence IS NULL AND proposed_linkedin_url_confidence IS NULL)
    OR (proposed_linkedin_url IS NOT NULL AND proposed_linkedin_url_evidence IS NOT NULL AND proposed_linkedin_url_confidence IS NOT NULL
        AND proposed_linkedin_url_evidence IN ('explicit_signature', 'explicit_body')
        AND proposed_linkedin_url_confidence IN ('high', 'medium'))),

  -- Lifecycle invariants.
  --  * pending/deferred rows carry the provider-sourced email, a date and a deadline
  --    bounded to created_at + 30 days;
  --  * deferral never outlives the deadline and only exists in status 'deferred';
  --  * terminal rows keep ONLY the tombstone (fingerprints, status, linkage) — every
  --    provider-derived field is NULL.
  CONSTRAINT ncc_context_ceiling CHECK (context_expires_at IS NULL OR context_expires_at <= created_at + interval '30 days'),
  CONSTRAINT ncc_open_requires_context CHECK (
    status NOT IN ('pending', 'deferred')
    OR (proposed_email IS NOT NULL AND proposed_interaction_date IS NOT NULL AND context_expires_at IS NOT NULL)),
  CONSTRAINT ncc_deferred_check CHECK (
    (status = 'deferred' AND deferred_until IS NOT NULL AND context_expires_at IS NOT NULL AND deferred_until <= context_expires_at)
    OR (status <> 'deferred' AND deferred_until IS NULL)),
  CONSTRAINT ncc_terminal_erased CHECK (
    status IN ('pending', 'deferred')
    OR (proposed_email IS NULL AND proposed_name IS NULL AND proposed_company IS NULL AND proposed_role IS NULL
        AND proposed_how_met IS NULL AND proposed_linkedin_url IS NULL
        AND draft_summary IS NULL AND draft_follow_up IS NULL AND retained_subject IS NULL
        AND context_expires_at IS NULL AND deferred_until IS NULL)),
  CONSTRAINT ncc_accepted_linkage CHECK (
    status = 'accepted' OR (accepted_contact_id IS NULL AND accepted_interaction_id IS NULL)),

  -- Composite target for outlook_candidate_refs' (candidate_id, user_id) foreign key.
  CONSTRAINT ncc_id_user_key UNIQUE (id, user_id),
  -- One candidate per (user, episode): dedup across runs.
  CONSTRAINT ncc_user_episode_unique UNIQUE (user_id, episode_fingerprint)
);

CREATE INDEX new_contact_candidates_person_idx  ON public.new_contact_candidates (user_id, person_fingerprint);
CREATE INDEX new_contact_candidates_review_idx  ON public.new_contact_candidates (user_id, proposed_interaction_date DESC, id DESC)
  WHERE status IN ('pending', 'deferred');
CREATE INDEX new_contact_candidates_expiry_idx  ON public.new_contact_candidates (context_expires_at, id)
  WHERE status IN ('pending', 'deferred') AND context_expires_at IS NOT NULL;

ALTER TABLE public.new_contact_candidates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.new_contact_candidates FROM PUBLIC;
REVOKE ALL ON TABLE public.new_contact_candidates FROM anon;
REVOKE ALL ON TABLE public.new_contact_candidates FROM authenticated;
-- Review-safe columns only: EXCLUDES user_id, both fingerprints, key_version and
-- context_expires_at (internal lifecycle bookkeeping).
GRANT SELECT (
  id, source, status,
  proposed_email, proposed_name, proposed_name_evidence, proposed_name_confidence,
  proposed_company, proposed_company_evidence, proposed_company_confidence,
  proposed_role, proposed_role_evidence, proposed_role_confidence,
  proposed_how_met, proposed_how_met_evidence, proposed_how_met_confidence,
  proposed_linkedin_url, proposed_linkedin_url_evidence, proposed_linkedin_url_confidence,
  draft_summary, draft_follow_up, proposed_interaction_date, proposed_type, retained_subject,
  extraction_status, deferred_until, accepted_contact_id, accepted_interaction_id,
  created_at, updated_at
) ON TABLE public.new_contact_candidates TO authenticated;
GRANT ALL ON TABLE public.new_contact_candidates TO service_role;
-- No INSERT/UPDATE/DELETE for authenticated: all writes go through RPCs.

CREATE POLICY "new_contact_candidates_select_own"
  ON public.new_contact_candidates
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);


-- ══════════════════════════════════════════════════════════════════════════════
--  E. outlook_candidate_refs — provenance (service-role ONLY), exactly one target
-- ══════════════════════════════════════════════════════════════════════════════
-- Links an Outlook candidate (interaction OR new-contact, never both) to its Microsoft
-- connection and HMAC fingerprints. Stores NO Graph message/conversation id, address,
-- subject or delta link. Composite FKs: the candidate and the connection must belong
-- to the same user as the ref.
CREATE TABLE public.outlook_candidate_refs (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id             uuid        NOT NULL,
  interaction_candidate_id  uuid,
  new_contact_candidate_id  uuid,
  episode_fingerprint       text        NOT NULL,
  person_fingerprint        text,
  key_version               smallint    NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ocr_exactly_one_target CHECK (
    (interaction_candidate_id IS NOT NULL AND new_contact_candidate_id IS NULL)
    OR (interaction_candidate_id IS NULL AND new_contact_candidate_id IS NOT NULL)),
  CONSTRAINT ocr_episode_fp_shape CHECK (episode_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ocr_person_fp_shape  CHECK (person_fingerprint IS NULL OR person_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ocr_key_version_pos  CHECK (key_version >= 1),
  CONSTRAINT ocr_conn_user_fk FOREIGN KEY (connection_id, user_id)
    REFERENCES public.microsoft_connections(id, user_id) ON DELETE CASCADE,
  CONSTRAINT ocr_icand_user_fk FOREIGN KEY (interaction_candidate_id, user_id)
    REFERENCES public.interaction_candidates(id, user_id) ON DELETE CASCADE,
  CONSTRAINT ocr_ncand_user_fk FOREIGN KEY (new_contact_candidate_id, user_id)
    REFERENCES public.new_contact_candidates(id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX outlook_candidate_refs_icand_uidx ON public.outlook_candidate_refs (interaction_candidate_id)
  WHERE interaction_candidate_id IS NOT NULL;
CREATE UNIQUE INDEX outlook_candidate_refs_ncand_uidx ON public.outlook_candidate_refs (new_contact_candidate_id)
  WHERE new_contact_candidate_id IS NOT NULL;
CREATE INDEX outlook_candidate_refs_user_idx ON public.outlook_candidate_refs (user_id);
CREATE INDEX outlook_candidate_refs_conn_fp_idx ON public.outlook_candidate_refs (connection_id, episode_fingerprint);

ALTER TABLE public.outlook_candidate_refs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.outlook_candidate_refs FROM PUBLIC;
REVOKE ALL ON TABLE public.outlook_candidate_refs FROM anon;
REVOKE ALL ON TABLE public.outlook_candidate_refs FROM authenticated;
GRANT ALL  ON TABLE public.outlook_candidate_refs TO service_role;
-- Intentionally NO GRANT and NO POLICY for authenticated: provenance never leaks.


-- ══════════════════════════════════════════════════════════════════════════════
--  SERVICE-ROLE RPCs (worker / callback)
-- ══════════════════════════════════════════════════════════════════════════════

-- ── RPC 1a: store_microsoft_connection — atomic connection + encrypted tokens ──
-- Mirrors store_google_connection. Tokens arrive ALREADY ENCRYPTED. One transaction:
-- the connection can never exist without its refresh token. Ownership is the
-- server-verified p_user_id (the callback derives it from the consumed OAuth state).
CREATE FUNCTION public.store_microsoft_connection(
  p_user_id                uuid,
  p_ms_account_id          text,
  p_ms_tenant_id           text,
  p_account_type           text,
  p_ms_email               text,
  p_scopes                 text[],
  p_status                 text,
  p_consented_at           timestamptz,
  p_consent_policy_version text,
  p_token_expires_at       timestamptz,
  p_access_ct              text,
  p_access_nonce           text,
  p_refresh_ct             text,
  p_refresh_nonce          text,
  p_key_version            smallint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conn_id  uuid;
  v_existing text;
BEGIN
  IF p_user_id IS NULL THEN RETURN jsonb_build_object('result', 'invalid_user'); END IF;
  IF p_account_type IS NULL OR p_account_type NOT IN ('personal', 'work') THEN
    RETURN jsonb_build_object('result', 'invalid_account_type');
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'needs_reauth', 'revoked', 'disabled') THEN
    RETURN jsonb_build_object('result', 'invalid_status');
  END IF;
  IF p_consented_at IS NULL OR p_consent_policy_version IS NULL THEN
    RETURN jsonb_build_object('result', 'consent_required');
  END IF;
  IF p_refresh_ct IS NULL OR p_refresh_nonce IS NULL THEN
    RETURN jsonb_build_object('result', 'refresh_token_required');
  END IF;

  -- Same-account rule: an existing connection may only be refreshed by the SAME
  -- Microsoft account. A different account must disconnect first (never silent swap).
  SELECT c.ms_account_id INTO v_existing
  FROM public.microsoft_connections c
  WHERE c.user_id = p_user_id
  FOR UPDATE;
  IF v_existing IS NOT NULL AND v_existing <> p_ms_account_id THEN
    RETURN jsonb_build_object('result', 'different_account');
  END IF;

  INSERT INTO public.microsoft_connections
    (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes, status,
     needs_reauth, consented_at, consent_policy_version, last_result_code,
     last_success_at, token_expires_at, updated_at)
  VALUES
    (p_user_id, p_ms_account_id, p_ms_tenant_id, p_account_type, p_ms_email, p_scopes, p_status,
     false, p_consented_at, p_consent_policy_version, 'connected',
     CASE WHEN p_status = 'active' THEN now() ELSE NULL END, p_token_expires_at, now())
  ON CONFLICT (user_id) DO UPDATE
    SET ms_tenant_id           = EXCLUDED.ms_tenant_id,
        account_type           = EXCLUDED.account_type,
        ms_email               = EXCLUDED.ms_email,
        scopes                 = EXCLUDED.scopes,
        status                 = EXCLUDED.status,
        needs_reauth           = false,
        consented_at           = EXCLUDED.consented_at,
        consent_policy_version = EXCLUDED.consent_policy_version,
        last_result_code       = 'reconnected',
        last_success_at        = CASE WHEN EXCLUDED.status = 'active' THEN now()
                                      ELSE public.microsoft_connections.last_success_at END,
        token_expires_at       = EXCLUDED.token_expires_at,
        updated_at             = now()
  RETURNING id INTO v_conn_id;

  INSERT INTO public.microsoft_tokens
    (connection_id, user_id, access_token_ciphertext, access_token_nonce,
     refresh_token_ciphertext, refresh_token_nonce, key_version, token_expires_at, updated_at)
  VALUES
    (v_conn_id, p_user_id, p_access_ct, p_access_nonce, p_refresh_ct, p_refresh_nonce,
     COALESCE(p_key_version, 1), p_token_expires_at, now())
  ON CONFLICT (connection_id) DO UPDATE
    SET access_token_ciphertext  = EXCLUDED.access_token_ciphertext,
        access_token_nonce       = EXCLUDED.access_token_nonce,
        refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
        refresh_token_nonce      = EXCLUDED.refresh_token_nonce,
        key_version              = EXCLUDED.key_version,
        token_expires_at         = EXCLUDED.token_expires_at,
        updated_at               = now();

  RETURN jsonb_build_object('result', 'stored', 'connection_id', v_conn_id);
END;
$$;

REVOKE ALL ON FUNCTION public.store_microsoft_connection(
  uuid, text, text, text, text, text[], text, timestamptz, text, timestamptz, text, text, text, text, smallint
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_microsoft_connection(
  uuid, text, text, text, text, text[], text, timestamptz, text, timestamptz, text, text, text, text, smallint
) TO service_role;


-- ── RPC 1b: update_microsoft_connection_state — ownership-verified status write ──
-- The worker flips needs_reauth / status (e.g. invalid_grant) without touching tokens.
CREATE FUNCTION public.update_microsoft_connection_state(
  p_connection_id uuid,
  p_user_id       uuid,
  p_status        text,
  p_needs_reauth  boolean,
  p_result_code   text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('active', 'needs_reauth', 'revoked', 'disabled') THEN
    RETURN jsonb_build_object('result', 'invalid_status');
  END IF;
  IF p_result_code IS NOT NULL AND char_length(p_result_code) > 100 THEN
    RETURN jsonb_build_object('result', 'invalid_result_code');
  END IF;

  SELECT c.user_id INTO v_owner FROM public.microsoft_connections c WHERE c.id = p_connection_id;
  IF v_owner IS NULL THEN RETURN jsonb_build_object('result', 'unknown_connection'); END IF;
  IF v_owner <> p_user_id THEN RETURN jsonb_build_object('result', 'owner_mismatch'); END IF;

  UPDATE public.microsoft_connections
    SET status           = p_status,
        needs_reauth     = COALESCE(p_needs_reauth, false),
        last_result_code = p_result_code,
        last_success_at  = CASE WHEN p_status = 'active' AND COALESCE(p_needs_reauth, false) = false
                                THEN now() ELSE last_success_at END,
        updated_at       = now()
  WHERE id = p_connection_id AND user_id = p_user_id;

  RETURN jsonb_build_object('result', 'ok');
END;
$$;

REVOKE ALL ON FUNCTION public.update_microsoft_connection_state(uuid, uuid, text, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_microsoft_connection_state(uuid, uuid, text, boolean, text)
  TO service_role;


-- ── RPC 2: reserve_due_outlook_connection — EXACTLY ONE due connection per call ──
-- Picks one due connection and claims BOTH folder rows (inbox, sentitems) under a
-- fresh run id with a GUARDED upsert whose WHERE clause re-checks lease expiry; the
-- reservation wins only when BOTH rows were claimed (ROW_COUNT = 2), otherwise it
-- reports 'none_due' with no side effects (a partial claim is rolled back by the
-- exception below). LIMIT 1 makes an all-user sweep structurally impossible.
--
-- DUE definition (all must hold): connection active, consented and not awaiting
-- reauth; no folder row holds a live lease; every retry backoff has elapsed; the
-- connection has never succeeded (immediately due) or its last success is older than
-- p_due_after_seconds, or a previous incomplete run is retried (bounded: 10 tries,
-- >= 5 minutes apart).
CREATE FUNCTION public.reserve_due_outlook_connection(
  p_lease_seconds     integer,
  p_due_after_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conn uuid;
  v_uid  uuid;
  v_run  uuid;
  v_n    integer;
  v_inbox_done boolean;
  v_sent_done  boolean;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid_lease_seconds';
  END IF;
  IF p_due_after_seconds IS NULL OR p_due_after_seconds < 0 OR p_due_after_seconds > 2592000 THEN
    RAISE EXCEPTION 'invalid_due_after';
  END IF;

  SELECT c.id, c.user_id
    INTO v_conn, v_uid
  FROM public.microsoft_connections c
  WHERE c.status = 'active'
    AND c.needs_reauth IS FALSE
    AND c.consented_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.outlook_sync_state s
      WHERE s.connection_id = c.id
        AND ((s.sync_status = 'running' AND s.sync_lease_until IS NOT NULL AND s.sync_lease_until >= now())
             OR (s.next_retry_at IS NOT NULL AND s.next_retry_at > now())))
    AND (
      NOT EXISTS (SELECT 1 FROM public.outlook_sync_state s WHERE s.connection_id = c.id)
      OR EXISTS (
        SELECT 1 FROM public.outlook_sync_state s
        WHERE s.connection_id = c.id
          AND (s.last_success_at IS NULL
               OR (s.last_run_complete IS NOT TRUE
                   AND s.retry_count < 10
                   AND (s.last_attempt_at IS NULL OR s.last_attempt_at < now() - interval '5 minutes'))
               OR s.last_success_at < now() - make_interval(secs => p_due_after_seconds))))
  ORDER BY (SELECT min(s.last_success_at) FROM public.outlook_sync_state s WHERE s.connection_id = c.id) ASC NULLS FIRST,
           c.id ASC
  LIMIT 1;

  IF v_conn IS NULL THEN
    RETURN jsonb_build_object('result', 'none_due');
  END IF;

  v_run := pg_catalog.gen_random_uuid();

  INSERT INTO public.outlook_sync_state
    (connection_id, user_id, folder, sync_status, sync_run_id, sync_lease_until, run_started_at, last_attempt_at, updated_at)
  VALUES
    (v_conn, v_uid, 'inbox',     'running', v_run, now() + make_interval(secs => p_lease_seconds), now(), now(), now()),
    (v_conn, v_uid, 'sentitems', 'running', v_run, now() + make_interval(secs => p_lease_seconds), now(), now(), now())
  ON CONFLICT (connection_id, folder) DO UPDATE
    SET sync_status      = 'running',
        sync_run_id      = v_run,
        sync_lease_until = now() + make_interval(secs => p_lease_seconds),
        run_started_at   = now(),
        last_attempt_at  = now(),
        updated_at       = now()
    WHERE public.outlook_sync_state.sync_status <> 'running'
       OR public.outlook_sync_state.sync_lease_until IS NULL
       OR public.outlook_sync_state.sync_lease_until < now();

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN
    -- Another run claimed at least one folder between the select and the upsert.
    -- Roll back any partial claim so no row is left leased to a run that never ran.
    RAISE EXCEPTION 'reservation_lost' USING ERRCODE = 'serialization_failure';
  END IF;

  SELECT bool_and(CASE WHEN s.folder = 'inbox'     THEN s.initial_import_done ELSE true END),
         bool_and(CASE WHEN s.folder = 'sentitems' THEN s.initial_import_done ELSE true END)
    INTO v_inbox_done, v_sent_done
  FROM public.outlook_sync_state s
  WHERE s.connection_id = v_conn;

  RETURN jsonb_build_object(
    'result', 'reserved',
    'connection_id', v_conn,
    'run_id', v_run,
    'inbox_initial_import_done', COALESCE(v_inbox_done, false),
    'sentitems_initial_import_done', COALESCE(v_sent_done, false)
  );
EXCEPTION
  WHEN serialization_failure THEN
    RETURN jsonb_build_object('result', 'none_due');
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_due_outlook_connection(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_due_outlook_connection(integer, integer) TO service_role;


-- ── RPC 3: renew_outlook_sync_lease (heartbeat, fenced) ───────────────────────
-- Renews BOTH folder rows only while p_run_id still owns them with a live lease.
CREATE FUNCTION public.renew_outlook_sync_lease(
  p_connection_id uuid,
  p_run_id        uuid,
  p_lease_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid_lease_seconds';
  END IF;
  IF p_run_id IS NULL THEN RETURN false; END IF;

  UPDATE public.outlook_sync_state
    SET sync_lease_until = now() + make_interval(secs => p_lease_seconds),
        updated_at       = now()
  WHERE connection_id    = p_connection_id
    AND sync_run_id      = p_run_id
    AND sync_status      = 'running'
    AND sync_lease_until IS NOT NULL
    AND sync_lease_until > now();

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 2;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_outlook_sync_lease(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_outlook_sync_lease(uuid, uuid, integer) TO service_role;


-- ── RPC 4: release_outlook_sync_lease — complete-run-only cursor advancement ──
-- Releases the lease held by p_run_id on both folder rows. The encrypted delta links
-- advance ONLY when p_run_complete IS TRUE (and a ciphertext was supplied for that
-- folder) AND this run still owns the rows. An incomplete or failed run leaves every
-- cursor UNCHANGED and records a retry backoff. A stale run (different run id, or the
-- rows already released) changes nothing and returns false.
CREATE FUNCTION public.release_outlook_sync_lease(
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
        updated_at        = now()
  WHERE s.connection_id = p_connection_id
    AND s.sync_run_id   = p_run_id
    AND s.sync_status   = 'running';

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 2;
END;
$$;

REVOKE ALL ON FUNCTION public.release_outlook_sync_lease(
  uuid, uuid, text, text, boolean, text, text, text, text, smallint, boolean, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_outlook_sync_lease(
  uuid, uuid, text, text, boolean, text, text, text, text, smallint, boolean, integer
) TO service_role;


-- ── RPC 5: invalidate_outlook_candidates_by_fingerprint (live-lease fenced) ───
-- Invalidates ONLY the explicitly listed pending/deferred Outlook candidates of this
-- connection (provider deletion / move to Deleted Items or Junk) and erases their
-- provider-derived context. Terminal candidates are never touched or resurrected.
-- Requires a live lease owned by p_run_id (outlook_sync_state FOR SHARE first).
CREATE FUNCTION public.invalidate_outlook_candidates_by_fingerprint(
  p_connection_id uuid,
  p_run_id        uuid,
  p_fingerprints  text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid     uuid;
  v_leaseok boolean;
  v_i       integer := 0;
  v_c       integer := 0;
BEGIN
  IF p_fingerprints IS NULL OR pg_catalog.array_length(p_fingerprints, 1) IS NULL THEN
    RETURN jsonb_build_object('result', 'noop', 'invalidated', 0);
  END IF;
  IF pg_catalog.array_length(p_fingerprints, 1) > 500 THEN
    RETURN jsonb_build_object('result', 'invalid_fingerprint_set');
  END IF;
  PERFORM 1 FROM pg_catalog.unnest(p_fingerprints) f WHERE f !~ '^[0-9a-f]{64}$';
  IF FOUND THEN
    RETURN jsonb_build_object('result', 'invalid_fingerprint');
  END IF;

  -- Deterministic lock order: the connection's sync-state rows FOR SHARE first (fences
  -- a concurrent claim/renew/release), then the candidate rows.
  PERFORM 1 FROM public.outlook_sync_state s WHERE s.connection_id = p_connection_id FOR SHARE;

  SELECT c.user_id INTO v_uid FROM public.microsoft_connections c WHERE c.id = p_connection_id;
  IF v_uid IS NULL THEN RETURN jsonb_build_object('result', 'unknown_connection'); END IF;

  -- The run must own BOTH folder rows with a live lease.
  SELECT count(*) = 2 AND bool_and(s.sync_run_id = p_run_id
                                   AND s.sync_status = 'running'
                                   AND s.sync_lease_until IS NOT NULL
                                   AND s.sync_lease_until > now())
    INTO v_leaseok
  FROM public.outlook_sync_state s
  WHERE s.connection_id = p_connection_id;
  IF v_leaseok IS NOT TRUE THEN RETURN jsonb_build_object('result', 'stale_run'); END IF;

  UPDATE public.interaction_candidates ic
    SET status = 'invalidated',
        retained_subject = NULL, context_expires_at = NULL,
        draft_summary = NULL, draft_follow_up = NULL, summary_evidence = NULL, deferred_until = NULL,
        updated_at = now()
  FROM public.outlook_candidate_refs r
  WHERE r.interaction_candidate_id = ic.id
    AND r.connection_id = p_connection_id
    AND ic.user_id = v_uid
    AND ic.source = 'outlook'
    AND ic.status = 'pending'
    AND r.episode_fingerprint = ANY (p_fingerprints);
  GET DIAGNOSTICS v_i = ROW_COUNT;

  UPDATE public.new_contact_candidates nc
    SET status = 'invalidated',
        proposed_email = NULL, proposed_name = NULL, proposed_name_evidence = NULL, proposed_name_confidence = NULL,
        proposed_company = NULL, proposed_company_evidence = NULL, proposed_company_confidence = NULL,
        proposed_role = NULL, proposed_role_evidence = NULL, proposed_role_confidence = NULL,
        proposed_how_met = NULL, proposed_how_met_evidence = NULL, proposed_how_met_confidence = NULL,
        proposed_linkedin_url = NULL, proposed_linkedin_url_evidence = NULL, proposed_linkedin_url_confidence = NULL,
        draft_summary = NULL, draft_follow_up = NULL, retained_subject = NULL,
        context_expires_at = NULL, deferred_until = NULL,
        updated_at = now()
  FROM public.outlook_candidate_refs r
  WHERE r.new_contact_candidate_id = nc.id
    AND r.connection_id = p_connection_id
    AND nc.user_id = v_uid
    AND nc.status IN ('pending', 'deferred')
    AND r.episode_fingerprint = ANY (p_fingerprints);
  GET DIAGNOSTICS v_c = ROW_COUNT;

  RETURN jsonb_build_object('result', 'invalidated', 'invalidated', v_i + v_c);
END;
$$;

REVOKE ALL ON FUNCTION public.invalidate_outlook_candidates_by_fingerprint(uuid, uuid, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invalidate_outlook_candidates_by_fingerprint(uuid, uuid, text[])
  TO service_role;


-- ══════════════════════════════════════════════════════════════════════════════
--  AUTHENTICATED (browser-owned) RPCs — caller derived from auth.uid() only
-- ══════════════════════════════════════════════════════════════════════════════

-- ── RPC 6: accept_new_contact_candidate — user-approved contact (+ interaction) ──
-- One transaction: lock the caller's own candidate; require an open, unexpired draft;
-- serialize on (user, email) with a transaction-scoped advisory lock; re-check that no
-- contact of this user already has the address; insert the contact with ONLY the
-- user-approved values (email comes from the candidate: provider metadata, never a
-- caller string); optionally insert the first Email interaction; link both on the
-- candidate; erase every provider-derived field. Any failure after the contact
-- insert (e.g. the interaction insert) rolls the whole function back — a contact can
-- never be left without its requested interaction.
CREATE FUNCTION public.accept_new_contact_candidate(
  p_candidate_id       uuid,
  p_name               text,
  p_company            text     DEFAULT NULL,
  p_role               text     DEFAULT NULL,
  p_how_met            text     DEFAULT NULL,
  p_linkedin_url       text     DEFAULT NULL,
  p_tags               text[]   DEFAULT NULL,
  p_relationship_type  text     DEFAULT NULL,
  p_relationship_note  text     DEFAULT NULL,
  p_create_interaction boolean  DEFAULT true,
  p_interaction_type   text     DEFAULT NULL,
  p_interaction_date   date     DEFAULT NULL,
  p_interaction_notes  text     DEFAULT NULL,
  p_follow_up_date     date     DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid    uuid := (SELECT auth.uid());
  v_cand   public.new_contact_candidates%ROWTYPE;
  v_email  text;
  v_name   text;
  v_type   text;
  v_date   date;
  v_notes  text;
  v_dup    uuid;
  v_cid    uuid;
  v_iid    uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('result', 'unauthenticated'); END IF;

  SELECT * INTO v_cand
  FROM public.new_contact_candidates
  WHERE id = p_candidate_id AND user_id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;

  IF v_cand.status = 'accepted' THEN
    RETURN jsonb_build_object('result', 'already_accepted', 'contact_id', v_cand.accepted_contact_id,
                              'interaction_id', v_cand.accepted_interaction_id);
  ELSIF v_cand.status = 'dismissed' THEN
    RETURN jsonb_build_object('result', 'dismissed');
  ELSIF v_cand.status = 'invalidated' THEN
    RETURN jsonb_build_object('result', 'invalidated');
  END IF;
  -- status is 'pending' or 'deferred' here (a deferred draft may be acted on early).
  IF v_cand.context_expires_at IS NULL OR v_cand.context_expires_at <= now() THEN
    RETURN jsonb_build_object('result', 'expired');
  END IF;

  -- Validate the user-approved values (bounds match the contact form / candidate CHECKs).
  v_name := NULLIF(pg_catalog.btrim(p_name), '');
  IF v_name IS NULL OR char_length(v_name) > 120 OR v_name ~ '[[:cntrl:]]' THEN
    RETURN jsonb_build_object('result', 'invalid_name');
  END IF;
  IF p_company IS NOT NULL AND (char_length(p_company) > 120 OR p_company ~ '[[:cntrl:]]') THEN
    RETURN jsonb_build_object('result', 'invalid_company');
  END IF;
  IF p_role IS NOT NULL AND (char_length(p_role) > 120 OR p_role ~ '[[:cntrl:]]') THEN
    RETURN jsonb_build_object('result', 'invalid_role');
  END IF;
  IF p_how_met IS NOT NULL AND (char_length(p_how_met) > 120 OR p_how_met ~ '[[:cntrl:]]') THEN
    RETURN jsonb_build_object('result', 'invalid_how_met');
  END IF;
  IF p_linkedin_url IS NOT NULL AND (char_length(p_linkedin_url) > 255
     OR p_linkedin_url !~ '^https://(www\.)?linkedin\.com/in/[A-Za-z0-9_%.-]+/?$') THEN
    RETURN jsonb_build_object('result', 'invalid_linkedin_url');
  END IF;
  IF p_tags IS NOT NULL AND (pg_catalog.array_length(p_tags, 1) > 20
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_tags) t WHERE t IS NULL OR char_length(t) = 0 OR char_length(t) > 60 OR t ~ '[[:cntrl:]]')) THEN
    RETURN jsonb_build_object('result', 'invalid_tags');
  END IF;
  IF p_relationship_type IS NOT NULL AND p_relationship_type NOT IN
     ('Mentor', 'Collaborator', 'Referral path', 'Potential employer', 'Connector', 'Other') THEN
    RETURN jsonb_build_object('result', 'invalid_relationship_type');
  END IF;
  IF p_relationship_note IS NOT NULL AND (char_length(p_relationship_note) > 500 OR p_relationship_note ~ '[[:cntrl:]]') THEN
    RETURN jsonb_build_object('result', 'invalid_relationship_note');
  END IF;

  IF COALESCE(p_create_interaction, true) THEN
    v_type := COALESCE(p_interaction_type, v_cand.proposed_type);
    IF v_type NOT IN ('Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other') THEN
      RETURN jsonb_build_object('result', 'invalid_type');
    END IF;
    v_date := COALESCE(p_interaction_date, v_cand.proposed_interaction_date);
    IF v_date IS NULL THEN RETURN jsonb_build_object('result', 'invalid_date'); END IF;
    v_notes := COALESCE(p_interaction_notes, v_cand.draft_summary);
    IF v_notes IS NOT NULL AND (char_length(v_notes) > 200 OR v_notes ~ '[[:cntrl:]]') THEN
      RETURN jsonb_build_object('result', 'invalid_notes');
    END IF;
  END IF;

  -- Email is the provider-sourced address on the candidate (never caller-supplied).
  v_email := pg_catalog.lower(pg_catalog.btrim(v_cand.proposed_email));
  IF v_email IS NULL OR v_email = '' THEN RETURN jsonb_build_object('result', 'invalid_email'); END IF;

  -- Serialize concurrent accepts for the same (user, email), then re-check duplicates.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_uid::text || ':' || v_email, 0));
  SELECT c.id INTO v_dup
  FROM public.contacts c
  WHERE c.user_id = v_uid AND pg_catalog.lower(pg_catalog.btrim(c.email)) = v_email
  LIMIT 1;
  IF v_dup IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'duplicate_email', 'contact_id', v_dup);
  END IF;

  BEGIN
    -- user_id is set explicitly (never taken from the caller).
    INSERT INTO public.contacts
      (user_id, name, company, role, how_met, email, linkedin_url, tags, relationship_type, relationship_note)
    VALUES
      (v_uid, v_name, p_company, p_role, p_how_met, v_email, p_linkedin_url, p_tags, p_relationship_type, p_relationship_note)
    RETURNING id INTO v_cid;

    IF COALESCE(p_create_interaction, true) THEN
      INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes, follow_up_date, source)
      VALUES (v_cid, v_uid, v_type, v_date, v_notes, p_follow_up_date, 'outlook')
      RETURNING id INTO v_iid;
    END IF;

    UPDATE public.new_contact_candidates
      SET status = 'accepted',
          accepted_contact_id = v_cid,
          accepted_interaction_id = v_iid,
          proposed_email = NULL, proposed_name = NULL, proposed_name_evidence = NULL, proposed_name_confidence = NULL,
          proposed_company = NULL, proposed_company_evidence = NULL, proposed_company_confidence = NULL,
          proposed_role = NULL, proposed_role_evidence = NULL, proposed_role_confidence = NULL,
          proposed_how_met = NULL, proposed_how_met_evidence = NULL, proposed_how_met_confidence = NULL,
          proposed_linkedin_url = NULL, proposed_linkedin_url_evidence = NULL, proposed_linkedin_url_confidence = NULL,
          draft_summary = NULL, draft_follow_up = NULL, retained_subject = NULL,
          context_expires_at = NULL, deferred_until = NULL,
          updated_at = now()
      WHERE id = p_candidate_id AND user_id = v_uid;
  EXCEPTION
    WHEN deadlock_detected OR serialization_failure THEN
      RETURN jsonb_build_object('result', 'conflict');
    WHEN OTHERS THEN
      -- Any failure inside the block (e.g. the interaction insert) rolls back the
      -- contact insert too; the browser sees a controlled code, never a DB message.
      RETURN jsonb_build_object('result', 'write_failed');
  END;

  RETURN jsonb_build_object('result', 'accepted', 'contact_id', v_cid, 'interaction_id', v_iid);
END;
$$;

REVOKE ALL ON FUNCTION public.accept_new_contact_candidate(
  uuid, text, text, text, text, text, text[], text, text, boolean, text, date, text, date
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_new_contact_candidate(
  uuid, text, text, text, text, text, text[], text, text, boolean, text, date, text, date
) TO authenticated;


-- ── RPC 7: dismiss_new_contact_candidate — idempotent, erases context now ──────
CREATE FUNCTION public.dismiss_new_contact_candidate(p_candidate_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid    uuid := (SELECT auth.uid());
  v_status text;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('result', 'unauthenticated'); END IF;

  SELECT status INTO v_status
  FROM public.new_contact_candidates
  WHERE id = p_candidate_id AND user_id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;

  IF v_status IN ('pending', 'deferred') THEN
    UPDATE public.new_contact_candidates
      SET status = 'dismissed',
          proposed_email = NULL, proposed_name = NULL, proposed_name_evidence = NULL, proposed_name_confidence = NULL,
          proposed_company = NULL, proposed_company_evidence = NULL, proposed_company_confidence = NULL,
          proposed_role = NULL, proposed_role_evidence = NULL, proposed_role_confidence = NULL,
          proposed_how_met = NULL, proposed_how_met_evidence = NULL, proposed_how_met_confidence = NULL,
          proposed_linkedin_url = NULL, proposed_linkedin_url_evidence = NULL, proposed_linkedin_url_confidence = NULL,
          draft_summary = NULL, draft_follow_up = NULL, retained_subject = NULL,
          context_expires_at = NULL, deferred_until = NULL,
          updated_at = now()
      WHERE id = p_candidate_id AND user_id = v_uid;
    RETURN jsonb_build_object('result', 'dismissed');
  ELSIF v_status = 'dismissed' THEN
    RETURN jsonb_build_object('result', 'already_dismissed');
  ELSIF v_status = 'accepted' THEN
    RETURN jsonb_build_object('result', 'already_accepted');
  ELSE
    RETURN jsonb_build_object('result', 'invalidated');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.dismiss_new_contact_candidate(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dismiss_new_contact_candidate(uuid) TO authenticated;


-- ── RPC 8: defer_candidate — bounded "not now", never past the context deadline ──
-- p_kind: 'new_contact' (status pending/deferred -> deferred) or 'interaction'
-- (Outlook interaction_candidates: status stays 'pending', deferred_until is set so the
-- review UI hides it; Calendar/Gmail candidates are refused). p_until NULL clears the
-- deferral. The deferral can never extend the provider-context deadline.
CREATE FUNCTION public.defer_candidate(
  p_kind         text,
  p_candidate_id uuid,
  p_until        timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid     uuid := (SELECT auth.uid());
  v_status  text;
  v_source  text;
  v_expires timestamptz;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('result', 'unauthenticated'); END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('new_contact', 'interaction') THEN
    RETURN jsonb_build_object('result', 'invalid_kind');
  END IF;
  IF p_until IS NOT NULL AND (p_until <= now() OR p_until > now() + interval '30 days') THEN
    RETURN jsonb_build_object('result', 'invalid_until');
  END IF;

  IF p_kind = 'new_contact' THEN
    SELECT status, context_expires_at INTO v_status, v_expires
    FROM public.new_contact_candidates
    WHERE id = p_candidate_id AND user_id = v_uid
    FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
    IF v_status NOT IN ('pending', 'deferred') THEN RETURN jsonb_build_object('result', 'not_open'); END IF;
    IF v_expires IS NULL OR v_expires <= now() THEN RETURN jsonb_build_object('result', 'expired'); END IF;
    IF p_until IS NOT NULL AND p_until > v_expires THEN RETURN jsonb_build_object('result', 'beyond_context'); END IF;

    UPDATE public.new_contact_candidates
      SET status = CASE WHEN p_until IS NULL THEN 'pending' ELSE 'deferred' END,
          deferred_until = p_until,
          updated_at = now()
    WHERE id = p_candidate_id AND user_id = v_uid;
    RETURN jsonb_build_object('result', CASE WHEN p_until IS NULL THEN 'undeferred' ELSE 'deferred' END);
  END IF;

  SELECT status, source, context_expires_at INTO v_status, v_source, v_expires
  FROM public.interaction_candidates
  WHERE id = p_candidate_id AND user_id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF v_source <> 'outlook' THEN RETURN jsonb_build_object('result', 'not_deferrable'); END IF;
  IF v_status <> 'pending' THEN RETURN jsonb_build_object('result', 'not_open'); END IF;
  IF v_expires IS NULL OR v_expires <= now() THEN RETURN jsonb_build_object('result', 'expired'); END IF;
  IF p_until IS NOT NULL AND p_until > v_expires THEN RETURN jsonb_build_object('result', 'beyond_context'); END IF;

  UPDATE public.interaction_candidates
    SET deferred_until = p_until,
        updated_at = now()
  WHERE id = p_candidate_id AND user_id = v_uid;
  RETURN jsonb_build_object('result', CASE WHEN p_until IS NULL THEN 'undeferred' ELSE 'deferred' END);
END;
$$;

REVOKE ALL ON FUNCTION public.defer_candidate(text, uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.defer_candidate(text, uuid, timestamptz) TO authenticated;


-- ── RPC 9/10: accept_/dismiss_interaction_candidate — established path, extended ──
-- CREATE OR REPLACE with the IDENTICAL signatures and bodies as applied by 20260907,
-- plus ONE addition each: the Outlook draft columns (draft_summary, draft_follow_up,
-- summary_evidence, deferred_until) are erased on resolution. Calendar and Gmail rows
-- always carry NULL there, so their behavior is byte-for-byte unchanged.
CREATE OR REPLACE FUNCTION public.accept_interaction_candidate(
  p_candidate_id   uuid,
  p_override_type  text DEFAULT NULL,
  p_override_date  date DEFAULT NULL,
  p_override_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid   uuid := (SELECT auth.uid());
  v_cand  public.interaction_candidates%ROWTYPE;
  v_type  text;
  v_date  date;
  v_notes text;
  v_src   text;
  v_iid   uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('result', 'unauthenticated');
  END IF;

  -- Lock the caller's own candidate. Missing OR foreign → identical not_found.
  SELECT * INTO v_cand
  FROM public.interaction_candidates
  WHERE id = p_candidate_id AND user_id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  -- Terminal / non-pending states (idempotent + controlled conflicts).
  IF v_cand.status = 'accepted' THEN
    IF v_cand.interaction_id IS NOT NULL THEN
      RETURN jsonb_build_object('result', 'already_accepted', 'interaction_id', v_cand.interaction_id);
    ELSE
      -- accepted + NULL = the created interaction was later deleted; NEVER recreate it.
      RETURN jsonb_build_object('result', 'interaction_previously_deleted');
    END IF;
  ELSIF v_cand.status = 'dismissed' THEN
    RETURN jsonb_build_object('result', 'dismissed');
  ELSIF v_cand.status = 'invalidated' THEN
    RETURN jsonb_build_object('result', 'invalidated');
  END IF;

  -- status is 'pending' here. An inactive source (cancelled/deleted event) cannot accept.
  -- (PRESERVED from the applied Calendar-review version — unchanged for E2A.)
  IF v_cand.source_last_state <> 'active' THEN
    RETURN jsonb_build_object('result', 'invalidated');
  END IF;

  -- Resolve + validate the final interaction fields (overrides optional). Validation
  -- runs before any write. Notes bound 200 matches the candidate schema.
  v_type := COALESCE(p_override_type, v_cand.proposed_type);
  IF v_type NOT IN ('Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other') THEN
    RETURN jsonb_build_object('result', 'invalid_type');
  END IF;
  v_date := COALESCE(p_override_date, v_cand.proposed_interaction_date);
  IF v_date IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_date');
  END IF;
  v_notes := COALESCE(p_override_notes, v_cand.proposed_notes);
  IF v_notes IS NOT NULL AND char_length(v_notes) > 200 THEN
    RETURN jsonb_build_object('result', 'invalid_notes');
  END IF;

  -- E2A CHANGE #1 (source-aware provenance): the interaction's source is taken from the
  -- candidate's source (was hardcoded 'google_calendar'). All admitted by the widened
  -- interactions_source_check; an unknown source fails closed to 'manual'.
  v_src := CASE WHEN v_cand.source IN ('google_calendar', 'gmail', 'outlook')
                THEN v_cand.source ELSE 'manual' END;

  -- Ownership re-check + write, in ONE transaction (PRESERVED). The contact is locked
  -- FOR KEY SHARE so it cannot be deleted between this check and the INSERT. The
  -- EXCEPTION block converts concurrent-delete / lock-cycle outcomes into controlled
  -- codes instead of leaking a raw SQL error; the failed write rolls back atomically.
  BEGIN
    PERFORM 1 FROM public.contacts
      WHERE id = v_cand.contact_id AND user_id = v_uid
      FOR KEY SHARE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('result', 'not_found');
    END IF;

    -- user_id is set explicitly (never taken from the caller). The accepted interaction
    -- receives ONLY the user-reviewed note; retained_subject is never copied in.
    INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes, source)
    VALUES (v_cand.contact_id, v_uid, v_type, v_date, v_notes, v_src)
    RETURNING id INTO v_iid;

    -- E2A CHANGE #2: erase retained email context on resolution (calendar candidates
    -- have NULL retained context → no-op; behavior for them is unchanged).
    -- OUTLOOK ADDITION: the draft columns are erased too (NULL on Calendar/Gmail rows).
    UPDATE public.interaction_candidates
      SET status = 'accepted', interaction_id = v_iid,
          draft_summary = NULL, draft_follow_up = NULL, summary_evidence = NULL, deferred_until = NULL,
          retained_subject = NULL, context_expires_at = NULL, updated_at = now()
    WHERE id = p_candidate_id;
  EXCEPTION
    WHEN foreign_key_violation THEN
      -- Contact concurrently deleted; indistinguishable from "not yours".
      RETURN jsonb_build_object('result', 'not_found');
    WHEN deadlock_detected OR serialization_failure THEN
      -- Transient lock cycle (e.g. concurrent contact delete). Safe to retry.
      RETURN jsonb_build_object('result', 'conflict');
  END;

  RETURN jsonb_build_object('result', 'accepted', 'interaction_id', v_iid);
END;
$$;

REVOKE ALL ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_interaction_candidate(uuid, text, date, text) TO authenticated;


CREATE OR REPLACE FUNCTION public.dismiss_interaction_candidate(
  p_candidate_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid    uuid := (SELECT auth.uid());
  v_status text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('result', 'unauthenticated');
  END IF;

  SELECT status INTO v_status
  FROM public.interaction_candidates
  WHERE id = p_candidate_id AND user_id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  IF v_status = 'pending' THEN
    UPDATE public.interaction_candidates
      SET status = 'dismissed',
          retained_subject = NULL,     -- erase retained email context on resolution
          context_expires_at = NULL,
          -- OUTLOOK ADDITION: draft columns erased too (NULL on Calendar/Gmail rows).
          draft_summary = NULL, draft_follow_up = NULL, summary_evidence = NULL, deferred_until = NULL,
          updated_at = now()
      WHERE id = p_candidate_id AND user_id = v_uid;
    RETURN jsonb_build_object('result', 'dismissed');
  ELSIF v_status = 'dismissed' THEN
    RETURN jsonb_build_object('result', 'already_dismissed');
  ELSIF v_status = 'accepted' THEN
    RETURN jsonb_build_object('result', 'already_accepted');
  ELSE
    RETURN jsonb_build_object('result', 'invalidated');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.dismiss_interaction_candidate(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dismiss_interaction_candidate(uuid) TO authenticated;


-- ── RPC 11: disconnect_my_outlook — the user's own off switch (no args) ─────────
-- Erases every pending/deferred Outlook draft (both candidate tables) with all
-- provider-derived context, deletes pending OAuth handshakes and the Microsoft
-- connection (cascades: tokens, sync state + delta links, provider refs). Touches no
-- Google/Gmail row, no contact, no approved interaction, no other user. Idempotent.
-- Provider revocation is NOT here (a later caller phase may add best-effort revocation).
CREATE FUNCTION public.disconnect_my_outlook()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_res jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('result', 'unauthorized'); END IF;
  v_res := public.run_microsoft_local_cleanup(v_uid);
  IF (v_res ->> 'connections_deleted')::integer = 0
     AND (v_res ->> 'interaction_candidates_invalidated')::integer = 0
     AND (v_res ->> 'new_contact_candidates_invalidated')::integer = 0 THEN
    RETURN jsonb_build_object('result', 'not_connected');
  END IF;
  RETURN jsonb_build_object(
    'result', 'disconnected',
    'candidates_invalidated', (v_res ->> 'interaction_candidates_invalidated')::integer
                              + (v_res ->> 'new_contact_candidates_invalidated')::integer
  );
END;
$$;

REVOKE ALL ON FUNCTION public.disconnect_my_outlook() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.disconnect_my_outlook() TO authenticated;


-- ── RPC 12: run_microsoft_local_cleanup(p_user_id) — atomic local cleanup ─────
-- Service-role only (callers derive p_user_id from a verified JWT). Same erasure as
-- disconnect_my_outlook, scoped to p_user_id in every statement. No network operation.
CREATE FUNCTION public.run_microsoft_local_cleanup(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_i integer := 0;
  v_c integer := 0;
  v_states integer := 0;
  v_conns  integer := 0;
BEGIN
  IF p_user_id IS NULL THEN RETURN jsonb_build_object('result', 'invalid_user'); END IF;

  UPDATE public.interaction_candidates
    SET status = 'invalidated',
        retained_subject = NULL, context_expires_at = NULL,
        draft_summary = NULL, draft_follow_up = NULL, summary_evidence = NULL, deferred_until = NULL,
        updated_at = now()
  WHERE user_id = p_user_id
    AND source  = 'outlook'
    AND status  = 'pending';
  GET DIAGNOSTICS v_i = ROW_COUNT;

  UPDATE public.new_contact_candidates
    SET status = 'invalidated',
        proposed_email = NULL, proposed_name = NULL, proposed_name_evidence = NULL, proposed_name_confidence = NULL,
        proposed_company = NULL, proposed_company_evidence = NULL, proposed_company_confidence = NULL,
        proposed_role = NULL, proposed_role_evidence = NULL, proposed_role_confidence = NULL,
        proposed_how_met = NULL, proposed_how_met_evidence = NULL, proposed_how_met_confidence = NULL,
        proposed_linkedin_url = NULL, proposed_linkedin_url_evidence = NULL, proposed_linkedin_url_confidence = NULL,
        draft_summary = NULL, draft_follow_up = NULL, retained_subject = NULL,
        context_expires_at = NULL, deferred_until = NULL,
        updated_at = now()
  WHERE user_id = p_user_id
    AND status IN ('pending', 'deferred');
  GET DIAGNOSTICS v_c = ROW_COUNT;

  DELETE FROM public.microsoft_oauth_states WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_states = ROW_COUNT;

  -- Cascades: microsoft_tokens, outlook_sync_state, outlook_candidate_refs.
  DELETE FROM public.microsoft_connections WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_conns = ROW_COUNT;

  RETURN jsonb_build_object(
    'result', 'cleaned',
    'connections_deleted', v_conns,
    'oauth_states_deleted', v_states,
    'interaction_candidates_invalidated', v_i,
    'new_contact_candidates_invalidated', v_c
  );
END;
$$;

REVOKE ALL ON FUNCTION public.run_microsoft_local_cleanup(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_microsoft_local_cleanup(uuid) TO service_role;


-- ── RPC 13: expire_pending_outlook_context — bounded, oldest first, SKIP LOCKED ──
-- Marks expired pending/deferred Outlook candidates (both tables) 'invalidated' and
-- erases every provider-derived field; only the tombstone + fingerprints remain.
-- No Cron here: the scheduler is a held-back final rollout step. NOTE: the Gmail
-- expiry function (source-agnostic subject erasure) may also touch an Outlook
-- interaction candidate if ever scheduled; that only erases the subject/deadline
-- earlier and never conflicts with this function's invalidation.
CREATE FUNCTION public.expire_pending_outlook_context(p_batch_size integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_i    integer := 0;
  v_c    integer := 0;
  v_more boolean := false;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 5000 THEN
    RETURN jsonb_build_object('result', 'invalid_batch_size');
  END IF;

  WITH due AS (
    SELECT id
    FROM public.interaction_candidates
    WHERE source = 'outlook'
      AND status = 'pending'
      AND context_expires_at IS NOT NULL
      AND context_expires_at <= now()
    ORDER BY context_expires_at, id
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.interaction_candidates ic
    SET status = 'invalidated',
        retained_subject = NULL, context_expires_at = NULL,
        draft_summary = NULL, draft_follow_up = NULL, summary_evidence = NULL, deferred_until = NULL,
        updated_at = now()
  FROM due
  WHERE ic.id = due.id;
  GET DIAGNOSTICS v_i = ROW_COUNT;

  WITH due AS (
    SELECT id
    FROM public.new_contact_candidates
    WHERE status IN ('pending', 'deferred')
      AND context_expires_at IS NOT NULL
      AND context_expires_at <= now()
    ORDER BY context_expires_at, id
    LIMIT GREATEST(p_batch_size - v_i, 0)   -- the batch bound is shared across both tables
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.new_contact_candidates nc
    SET status = 'invalidated',
        proposed_email = NULL, proposed_name = NULL, proposed_name_evidence = NULL, proposed_name_confidence = NULL,
        proposed_company = NULL, proposed_company_evidence = NULL, proposed_company_confidence = NULL,
        proposed_role = NULL, proposed_role_evidence = NULL, proposed_role_confidence = NULL,
        proposed_how_met = NULL, proposed_how_met_evidence = NULL, proposed_how_met_confidence = NULL,
        proposed_linkedin_url = NULL, proposed_linkedin_url_evidence = NULL, proposed_linkedin_url_confidence = NULL,
        draft_summary = NULL, draft_follow_up = NULL, retained_subject = NULL,
        context_expires_at = NULL, deferred_until = NULL,
        updated_at = now()
  FROM due
  WHERE nc.id = due.id;
  GET DIAGNOSTICS v_c = ROW_COUNT;

  SELECT EXISTS (
    SELECT 1 FROM public.interaction_candidates
    WHERE source = 'outlook' AND status = 'pending' AND context_expires_at IS NOT NULL AND context_expires_at <= now()
  ) OR EXISTS (
    SELECT 1 FROM public.new_contact_candidates
    WHERE status IN ('pending', 'deferred') AND context_expires_at IS NOT NULL AND context_expires_at <= now()
  ) INTO v_more;

  RETURN jsonb_build_object(
    'result', 'ok',
    'expired', v_i + v_c,
    'batch_size', p_batch_size,
    'more', v_more
  );
END;
$$;

REVOKE ALL ON FUNCTION public.expire_pending_outlook_context(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_pending_outlook_context(integer) TO service_role;


-- ══════════════════════════════════════════════════════════════════════════════
--  POST-APPLY VERIFICATION (read-only; run manually after `db push`)
-- ══════════════════════════════════════════════════════════════════════════════
--   SELECT count(*) FROM public.microsoft_connections;            -- 0
--   SELECT count(*) FROM public.new_contact_candidates;           -- 0
--   SELECT count(*) FROM public.outlook_candidate_refs;           -- 0
--   SELECT proname, prosecdef, proconfig FROM pg_proc
--     WHERE proname IN ('reserve_due_outlook_connection','accept_new_contact_candidate',
--                       'disconnect_my_outlook','run_microsoft_local_cleanup',
--                       'expire_pending_outlook_context');        -- secdef true, search_path=""
--   SELECT count(*) FROM pg_extension WHERE extname = 'pg_cron';  -- unchanged (0)
--   SELECT count(*) FROM public.interaction_candidates WHERE source = 'gmail';  -- unchanged
