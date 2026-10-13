-- Run read-only: npx supabase db query --linked -f scripts/outlook-acceptance/pilot-preservation.sql
-- PILOT PRESERVATION INSTRUMENT for onboarding the second cohort account (2026-10-13).
--
-- WHY A NEW INSTRUMENT. The step-3a baseline query (cohort_pause_baseline.sql, sha256 9d710d0a,
-- kept unchanged) scopes rows to ALL connection owners and digests ALL connections. Once a
-- second account connects, its rows enter that query and every digest moves for that reason
-- alone - so it cannot tell "onboarding altered the pilot" from "a second account exists".
-- This query pins the PILOT by the sha256 of its user id (no identifier in this file), and
-- the pilot's connection through that.
--
-- THREE KINDS OF SECTION.
--   must_not_alter  Onboarding a second account must leave these EXACTLY as they are, and so
--                   must ordinary synchronization: the worker never writes them. Identity and
--                   consent change only by the pilot's own re-consent; saved interactions and
--                   contacts only by the pilot accepting a suggestion in the app; a SETTLED
--                   (accepted / dismissed / invalidated) suggestion is never re-made.
--   sync_may_change Legitimate automatic synchronization changes these: cursors advance, run
--                   timestamps move, a round checkpoints, open suggestions are created or
--                   refreshed, provenance and recovery rows are written, a token is refreshed.
--                   Recorded and explained, never required to stay still.
--   observe         Wake and notification metadata. Never compared, never cleared.
-- Plus new_account: the second account's own pre-onboarding state, as counts.
--
-- Read-only. Digests, counts, timestamps and booleans only.
with pilot_user as (
  select user_id from public.microsoft_connections
   where encode(sha256(convert_to(user_id::text, 'UTF8')), 'hex')
         = 'a064e622004484de081848be4d4b8356a9eb58624d9d87dea84ae5c6305155e2'
),
pilot_conn as (
  select id from public.microsoft_connections where user_id in (select user_id from pilot_user)
),
new_user as (
  select id from auth.users
   where encode(sha256(convert_to(id::text, 'UTF8')), 'hex') like '157ec62550b8%'
)
select 'check' as kind, 'pilot_resolved' as section,
       ((select count(*) from pilot_user) = 1)::text as value
union all
select 'check', 'new_account_resolved', ((select count(*) from new_user) = 1)::text
-- ── must_not_alter ────────────────────────────────────────────────────────────
union all
select 'must_not_alter', 'pilot_connection_identity',
       coalesce(md5(string_agg(row(c.id, c.user_id, c.ms_account_id, c.ms_tenant_id, c.account_type,
                                   c.ms_email, c.scopes, c.status, c.needs_reauth, c.connected_at)::text,
                               E'\x1e' order by c.id)), 'empty') || ' x' || count(*)
  from public.microsoft_connections c where c.id in (select id from pilot_conn)
union all
select 'must_not_alter', 'pilot_stored_consent',
       coalesce(md5(string_agg(row(c.id, c.consent_policy_version, c.consented_at)::text,
                               E'\x1e' order by c.id)), 'empty') || ' x' || count(*)
  from public.microsoft_connections c where c.id in (select id from pilot_conn)
union all
select 'must_not_alter', 'pilot_saved_interactions',
       coalesce(md5(string_agg(row(i.id, i.contact_id, i.user_id, i.type, i.interaction_date, i.notes,
                                   i.follow_up_date, i.created_at, i.outreach_status, i.follow_up_completed_at,
                                   i.follow_up_previous_date, i.follow_up_completion_method, i.source)::text,
                               E'\x1e' order by i.id)), 'empty') || ' x' || count(*)
  from public.interactions i where i.user_id in (select user_id from pilot_user)
union all
select 'must_not_alter', 'pilot_contacts',
       coalesce(md5(string_agg(row(t.id, t.user_id, t.name, t.company, t.role, t.how_met, t.email,
                                   t.linkedin_url, t.tags, t.created_at, t.relationship_type,
                                   t.relationship_note)::text,
                               E'\x1e' order by t.id)), 'empty') || ' x' || count(*)
  from public.contacts t where t.user_id in (select user_id from pilot_user)
union all
select 'must_not_alter', 'pilot_settled_interaction_candidates',
       coalesce(md5(string_agg(row(t.id, t.user_id, t.contact_id, t.source, t.source_fingerprint, t.proposed_type,
                                   t.proposed_interaction_date, t.proposed_notes, t.status, t.interaction_id,
                                   t.source_last_state, t.created_at, t.updated_at, t.retained_subject,
                                   t.context_expires_at, t.draft_summary, t.draft_follow_up, t.summary_evidence,
                                   t.extraction_status, t.deferred_until)::text,
                               E'\x1e' order by t.id)), 'empty') || ' x' || count(*)
  from public.interaction_candidates t
 where t.user_id in (select user_id from pilot_user) and t.status not in ('pending', 'deferred')
union all
select 'must_not_alter', 'pilot_settled_new_contact_candidates',
       coalesce(md5(string_agg(row(t.id, t.user_id, t.source, t.status, t.person_fingerprint, t.episode_fingerprint,
                                   t.key_version, t.proposed_email, t.proposed_name, t.draft_summary,
                                   t.draft_follow_up, t.proposed_interaction_date, t.retained_subject,
                                   t.extraction_status, t.context_expires_at, t.deferred_until,
                                   t.accepted_contact_id, t.accepted_interaction_id, t.created_at, t.updated_at)::text,
                               E'\x1e' order by t.id)), 'empty') || ' x' || count(*)
  from public.new_contact_candidates t
 where t.user_id in (select user_id from pilot_user) and t.status not in ('pending', 'deferred')
-- ── sync_may_change ───────────────────────────────────────────────────────────
union all
select 'sync_may_change', 'pilot_committed_cursors',
       coalesce(md5(string_agg(row(s.folder, s.delta_link_ciphertext, s.delta_link_nonce, s.delta_key_version,
                                   s.initial_import_done)::text, E'\x1e' order by s.folder)), 'empty') || ' x' || count(*)
  from public.outlook_sync_state s where s.connection_id in (select id from pilot_conn)
union all
select 'sync_may_change', 'pilot_transient_cursors_and_round',
       coalesce(md5(string_agg(row(s.folder, s.next_link_ciphertext, s.pending_delta_ciphertext, s.round_id,
                                   s.round_pages, s.round_messages, s.round_folder_complete, s.round_write_cursor)::text,
                               E'\x1e' order by s.folder)), 'empty') || ' x' || count(*)
  from public.outlook_sync_state s where s.connection_id in (select id from pilot_conn)
union all
select 'sync_may_change', 'pilot_folder_run_state',
       string_agg(s.folder || ': ' || s.sync_status || ' attempt=' || coalesce(s.last_attempt_at::text, 'never')
                  || ' success=' || coalesce(s.last_success_at::text, 'never') || ' complete=' || s.last_run_complete::text
                  || ' err=' || coalesce(s.last_error_code, 'none') || ' retry=' || s.retry_count::text
                  || ' lease_live=' || coalesce((s.sync_lease_until > now())::text, 'none'), ' | ' order by s.folder)
  from public.outlook_sync_state s where s.connection_id in (select id from pilot_conn)
union all
select 'sync_may_change', 'pilot_connection_run_state',
       string_agg('last_result_code=' || coalesce(c.last_result_code, 'none') || ' last_success_at='
                  || coalesce(c.last_success_at::text, 'never') || ' token_expires_at='
                  || coalesce(c.token_expires_at::text, 'none'), ' | ')
  from public.microsoft_connections c where c.id in (select id from pilot_conn)
union all
select 'sync_may_change', 'pilot_open_candidates',
       (select count(*) from public.interaction_candidates t where t.user_id in (select user_id from pilot_user)
          and t.status in ('pending', 'deferred'))::text || ' interaction / '
       || (select count(*) from public.new_contact_candidates t where t.user_id in (select user_id from pilot_user)
          and t.status in ('pending', 'deferred'))::text || ' new-contact'
union all
select 'sync_may_change', 'pilot_candidate_refs',
       coalesce(md5(string_agg(row(r.id, r.interaction_candidate_id, r.new_contact_candidate_id, r.episode_fingerprint,
                                   r.conversation_fingerprint, r.covered_message_fingerprints, r.coverage_from_at,
                                   r.coverage_through_at, r.coverage_source, r.updated_at)::text,
                               E'\x1e' order by r.id)), 'empty') || ' x' || count(*)
  from public.outlook_candidate_refs r where r.user_id in (select user_id from pilot_user)
union all
select 'sync_may_change', 'pilot_thread_recovery',
       coalesce(md5(string_agg(row(r.conversation_fingerprint, r.earliest_unpaired_at, r.unpaired,
                                   r.baseline_fingerprints, r.baseline_boundary_at, r.updated_at)::text,
                               E'\x1e' order by r.conversation_fingerprint)), 'empty') || ' x' || count(*)
  from public.outlook_thread_recovery r where r.user_id in (select user_id from pilot_user)
-- ── observe ───────────────────────────────────────────────────────────────────
union all
select 'observe', 'pilot_wake',
       string_agg('wake_requested_at=' || coalesce(c.wake_requested_at::text, 'none') || ' wake_count='
                  || coalesce(c.wake_count::text, '0') || ' last_wake_at=' || coalesce(c.last_wake_at::text, 'none'), ' | ')
  from public.microsoft_connections c where c.id in (select id from pilot_conn)
union all
select 'observe', 'pilot_subscription',
       string_agg('status=' || coalesce(x.status, 'none') || ' expires_at=' || coalesce(x.expires_at::text, 'none')
                  || ' notifications_received=' || coalesce(x.notifications_received::text, '0'), ' | ')
  from public.outlook_subscriptions x where x.connection_id in (select id from pilot_conn)
union all
select 'observe', 'connections_total', (select count(*) from public.microsoft_connections)::text
union all
select 'observe', 'db_now', now()::text
-- ── new_account: its own pre-onboarding state ─────────────────────────────────
union all
select 'new_account', 'pre_onboarding_counts',
       'connections=' || (select count(*) from public.microsoft_connections where user_id in (select id from new_user))
       || ' contacts=' || (select count(*) from public.contacts where user_id in (select id from new_user))
       || ' interactions=' || (select count(*) from public.interactions where user_id in (select id from new_user))
       || ' interaction_candidates=' || (select count(*) from public.interaction_candidates where user_id in (select id from new_user))
       || ' new_contact_candidates=' || (select count(*) from public.new_contact_candidates where user_id in (select id from new_user))
       || ' refs=' || (select count(*) from public.outlook_candidate_refs where user_id in (select id from new_user))
       || ' recovery=' || (select count(*) from public.outlook_thread_recovery where user_id in (select id from new_user))
order by 1, 2;
