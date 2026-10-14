-- Run read-only: npx supabase db query --linked -f scripts/outlook-acceptance/second-account-acceptance.sql
-- SECOND-ACCOUNT ACCEPTANCE INSTRUMENT (read-only). Booleans, counts, codes, timestamps only.
-- The pilot is pinned by its id hash, the second Funnl account by its id-hash prefix. No
-- identifier, address, subject or text is selected.
with pilot as (select user_id from public.microsoft_connections
                where encode(sha256(convert_to(user_id::text,'UTF8')),'hex')
                      = 'a064e622004484de081848be4d4b8356a9eb58624d9d87dea84ae5c6305155e2'),
     second as (select id as user_id from auth.users
                 where encode(sha256(convert_to(id::text,'UTF8')),'hex') like '157ec62550b8%'),
     pc as (select * from public.microsoft_connections where user_id in (select user_id from pilot)),
     sc as (select * from public.microsoft_connections where user_id in (select user_id from second))
select 'A1' as gate, 'second_connection_count' as item, (select count(*) from sc)::text as value
union all select 'A1','distinct_microsoft_account_from_pilot',
  coalesce((select (s.ms_account_id is distinct from p.ms_account_id)::text from sc s, pc p),'n/a')
union all select 'A1','distinct_mailbox_address_from_pilot',
  coalesce((select (lower(s.ms_email) is distinct from lower(p.ms_email))::text from sc s, pc p),'n/a')
union all select 'A1','same_mailbox_on_any_other_user',
  coalesce((select (count(*) > 0)::text from public.microsoft_connections o, sc s
             where o.user_id <> s.user_id and o.ms_account_id = s.ms_account_id),'n/a')
union all select 'A1','holders_of_this_microsoft_identity',
  coalesce((select count(*)::text from public.microsoft_connections o, sc s
             where coalesce(lower(o.ms_tenant_id),'') = coalesce(lower(s.ms_tenant_id),'')
               and lower(o.ms_account_id) = lower(s.ms_account_id)),'n/a')
union all select 'A1','account_type', coalesce((select account_type from sc),'n/a')
union all select 'A1','tenant_is_consumers_msa',
  coalesce((select (ms_tenant_id = '9188040d-6c67-4c5b-b112-36a304b66dad')::text from sc),'n/a')
union all select 'A1','scopes', coalesce((select array_to_string(scopes,' ') from sc),'n/a')
-- Microsoft does not echo offline_access in its granted-scope list; the stored refresh token is
-- the evidence of offline access (the long-running pilot stores the same five scopes).
union all select 'A1','refresh_token_stored', coalesce((select (t.refresh_token_ciphertext is not null and t.refresh_token_nonce is not null)::text
  from public.microsoft_tokens t where t.connection_id in (select id from sc)),'n/a')
-- For the tester-recognition step: the DOMAIN only, never the full address.
union all select 'A1','mailbox_domain', coalesce((select split_part(lower(ms_email),'@',2) from sc),'n/a')
union all select 'A1','consent_version', coalesce((select consent_policy_version from sc),'n/a')
union all select 'A1','status/needs_reauth', coalesce((select status||'/'||needs_reauth::text from sc),'n/a')
union all select 'A1','connected_at', coalesce((select connected_at::text from sc),'n/a')
union all select 'A2','folders', coalesce((select string_agg(s.folder||':'||s.sync_status||' success='||coalesce(s.last_success_at::text,'never')
  ||' err='||coalesce(s.last_error_code,'none')||' committed_cursor='||(s.delta_link_ciphertext is not null)::text,' | ' order by s.folder)
  from public.outlook_sync_state s where s.connection_id in (select id from sc)),'n/a')
union all select 'A2','subscription', coalesce((select string_agg('status='||x.status||' expires='||coalesce(x.expires_at::text,'none')
  ||' notifications='||coalesce(x.notifications_received::text,'0'),' | ') from public.outlook_subscriptions x
  where x.connection_id in (select id from sc)),'n/a')
union all select 'A2','wake', coalesce((select 'wake_count='||coalesce(wake_count::text,'0')||' last_wake_at='||coalesce(last_wake_at::text,'none') from sc),'n/a')
union all select 'A2','interaction_candidates_by_status', coalesce((select string_agg(status||'='||n,' ' order by status) from
  (select status, count(*)::text n from public.interaction_candidates where user_id in (select user_id from second) group by status) z),'none')
union all select 'A2','new_contact_candidates_by_status', coalesce((select string_agg(status||'='||n,' ' order by status) from
  (select status, count(*)::text n from public.new_contact_candidates where user_id in (select user_id from second) group by status) z),'none')
-- S4 attribution: the ten most recent second-account candidates, times and codes only. A
-- candidate counts for the fresh exchange only if it was created after the exchange AND its
-- message coverage window reaches the exchange's time (the operator compares with the time
-- the owner reported - no content is read).
union all select 'S4','recent_candidates', coalesce((select string_agg(x.line, ' || ' order by x.created_at desc) from (
  select ic.created_at, 'interaction status='||ic.status||' created='||ic.created_at::text
         ||' coverage='||coalesce(r.coverage_from_at::text,'none')||'..'||coalesce(r.coverage_through_at::text,'none')
         ||' extraction='||coalesce(ic.extraction_status,'none') as line
    from public.interaction_candidates ic
    left join public.outlook_candidate_refs r on r.interaction_candidate_id = ic.id
   where ic.user_id in (select user_id from second)
  union all
  select nc.created_at, 'new_contact status='||nc.status||' created='||nc.created_at::text
         ||' coverage='||coalesce(r.coverage_from_at::text,'none')||'..'||coalesce(r.coverage_through_at::text,'none')
         ||' extraction='||coalesce(nc.extraction_status,'none')
    from public.new_contact_candidates nc
    left join public.outlook_candidate_refs r on r.new_contact_candidate_id = nc.id
   where nc.user_id in (select user_id from second)
   order by 1 desc limit 10) x),'none')
union all select 'A3','accepted_outlook_interactions', (select count(*) from public.interactions
  where user_id in (select user_id from second) and source = 'outlook')::text
union all select 'A3','contacts_total', (select count(*) from public.contacts where user_id in (select user_id from second))::text
-- A4: cross-account isolation. Every value here must be 0.
union all select 'A4','second_candidates_pointing_at_foreign_contact', (select count(*) from public.interaction_candidates c
  join public.contacts t on t.id = c.contact_id where c.user_id in (select user_id from second) and t.user_id <> c.user_id)::text
union all select 'A4','second_interactions_on_foreign_contact', (select count(*) from public.interactions i
  join public.contacts t on t.id = i.contact_id where i.user_id in (select user_id from second) and t.user_id <> i.user_id)::text
union all select 'A4','second_new_contact_accepts_foreign', (select count(*) from public.new_contact_candidates n
  join public.contacts t on t.id = n.accepted_contact_id where n.user_id in (select user_id from second) and t.user_id <> n.user_id)::text
union all select 'A4','refs_user_mismatch_any', (select count(*) from public.outlook_candidate_refs r
  left join public.interaction_candidates ic on ic.id = r.interaction_candidate_id
  left join public.new_contact_candidates nc on nc.id = r.new_contact_candidate_id
  where coalesce(ic.user_id, nc.user_id) is distinct from r.user_id)::text
union all select 'A4','pilot_rows_on_second_contacts', (select count(*) from public.interactions i
  join public.contacts t on t.id = i.contact_id where i.user_id in (select user_id from pilot) and t.user_id in (select user_id from second))::text
union all select 'meta','db_now', now()::text
order by 1, 2;
