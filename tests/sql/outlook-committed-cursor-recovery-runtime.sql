-- DISPOSABLE DATABASE ONLY. Apply the repo migrations first.
-- Executes the actual reset, producer and acceptance bodies. No Microsoft/network call.
-- Covers fencing, ordinary resets, preservation of saved work, and replay deduplication.
BEGIN;
DO $$
DECLARE
  u uuid := '11111111-1111-1111-1111-111111111111';
  conn uuid; run uuid := gen_random_uuid(); cid uuid; accepted_id uuid;
  v jsonb; before_candidates jsonb; before_interactions jsonb; before_refs jsonb;
  why text;
BEGIN
  DELETE FROM public.microsoft_connections WHERE user_id = u;
  DELETE FROM public.interactions WHERE user_id = u;
  DELETE FROM public.interaction_candidates WHERE user_id = u;
  DELETE FROM public.contacts WHERE user_id = u;
  INSERT INTO public.microsoft_connections
    (user_id,ms_account_id,account_type,ms_email,scopes,status,consented_at,consent_policy_version,wake_requested_at)
    VALUES(u,'fixture-recovery','personal','u1@example.test',ARRAY['Mail.Read','User.Read','offline_access'],'active',now(),'v1',now())
    RETURNING id INTO conn;
  INSERT INTO public.contacts(user_id,name,email) VALUES(u,'Fixture person','person@example.test') RETURNING id INTO cid;
  INSERT INTO public.outlook_sync_state
    (connection_id,user_id,folder,sync_status,sync_run_id,sync_lease_until,run_started_at,
     delta_link_ciphertext,delta_link_nonce,delta_key_version,initial_import_done,
     round_id,round_started_at,round_expires_at,next_link_ciphertext,next_link_nonce,next_link_key_version)
    SELECT conn,u,f,'running',run,now()+interval '7 minutes',now(),
      'committed-'||f,'nonce',2,true,gen_random_uuid(),now(),now()+interval '1 day','next','nonce',2
    FROM unnest(ARRAY['inbox','sentitems']) f;

  -- One pending draft, one accepted record, and their actual deduplication references.
  v := public.upsert_outlook_interaction_candidate(conn,run,cid,repeat('a',64),repeat('b',64),1::smallint,
    'Email',current_date,NULL,'A pending contextual note.',NULL,'explicit_body','ai_extracted');
  ASSERT v->>'result' = 'created',v::text;
  v := public.upsert_outlook_interaction_candidate(conn,run,cid,repeat('c',64),repeat('d',64),1::smallint,
    'Email',current_date,NULL,'An accepted contextual note.',NULL,'explicit_body','ai_extracted');
  accepted_id := (v->>'candidate_id')::uuid;
  PERFORM set_config('request.jwt.claim.sub',u::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u)::text,true);
  v := public.accept_interaction_candidate(accepted_id);
  ASSERT v->>'result' = 'accepted',v::text;
  SELECT jsonb_agg(to_jsonb(c) ORDER BY id) INTO before_candidates FROM public.interaction_candidates c WHERE user_id=u;
  SELECT jsonb_agg(to_jsonb(i) ORDER BY id) INTO before_interactions FROM public.interactions i WHERE user_id=u;
  SELECT jsonb_agg(to_jsonb(r) ORDER BY episode_fingerprint) INTO before_refs FROM public.outlook_candidate_refs r WHERE user_id=u;

  -- A stale run, null run and an expired lease must not touch either cursor.
  v := public.reset_outlook_round(conn,gen_random_uuid(),'committed_delta_rejected');
  ASSERT v->>'result'='stale_run',v::text;
  v := public.reset_outlook_round(conn,NULL,'committed_delta_rejected');
  ASSERT v->>'result'='stale_run',v::text;
  UPDATE public.outlook_sync_state SET sync_lease_until=now()-interval '1 second' WHERE connection_id=conn AND folder='inbox';
  v := public.reset_outlook_round(conn,run,'committed_delta_rejected');
  ASSERT v->>'result'='stale_run',v::text;
  ASSERT (SELECT bool_and(delta_link_ciphertext='committed-'||folder AND round_id IS NOT NULL)
    FROM public.outlook_sync_state WHERE connection_id=conn),'A refused reset changed state';
  UPDATE public.outlook_sync_state SET sync_lease_until=now()+interval '7 minutes' WHERE connection_id=conn;

  -- A saved nextLink or TTL reset still retains the valid committed cursors.
  FOREACH why IN ARRAY ARRAY['next_link_rejected','round_expired','other_reason'] LOOP
    v := public.reset_outlook_round(conn,run,why);
    ASSERT v->>'result'='reset',v::text;
    ASSERT (SELECT bool_and(delta_link_ciphertext='committed-'||folder AND delta_link_nonce='nonce'
      AND delta_key_version=2 AND initial_import_done)
      FROM public.outlook_sync_state WHERE connection_id=conn),'An ordinary reset erased a committed cursor';
  END LOOP;

  -- Seed round-local progress after the ordinary resets; clearing it cannot affect saved work.
  v := public.record_outlook_page_progress(conn,run,'inbox',gen_random_uuid(),1,
    'next','nonce',NULL,NULL,1::smallint,false,1,0,
    jsonb_build_array(jsonb_build_object('cfp',repeat('e',64),'pfp',repeat('f',64),'efp',repeat('1',64),
      'elookup',jsonb_build_array(repeat('1',64)),'first_fp',repeat('2',64),'first_at',now(),'last_at',now(),
      'contact_id',cid,'key_version',1,'inbound',1,'outbound',0,'messages',1,'taint',NULL)),86400);
  ASSERT v->>'result'='recorded',v::text;
  ASSERT (SELECT count(*) FROM public.outlook_conversation_progress WHERE connection_id=conn)=1;
  v := public.reset_outlook_round(conn,run,'committed_delta_rejected');
  ASSERT v->>'result'='reset',v::text;
  ASSERT (SELECT bool_and(delta_link_ciphertext IS NULL AND delta_link_nonce IS NULL AND delta_key_version=2
    AND initial_import_done AND round_id IS NULL AND next_link_ciphertext IS NULL
    AND pending_delta_ciphertext IS NULL AND round_write_cursor IS NULL
    AND sync_run_id=run AND sync_status='running') FROM public.outlook_sync_state WHERE connection_id=conn),
    'Catch-up must erase tokens and partial round while retaining lease, key version and import history';
  ASSERT (SELECT count(*) FROM public.outlook_conversation_progress WHERE connection_id=conn)=0;
  ASSERT (SELECT wake_requested_at IS NOT NULL FROM public.microsoft_connections WHERE id=conn),'Reset consumed unread wake-up';
  ASSERT (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.interaction_candidates c WHERE user_id=u)=before_candidates,
    'Reset changed a candidate or its draft';
  ASSERT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM public.interactions i WHERE user_id=u)=before_interactions,
    'Reset changed an accepted interaction';
  ASSERT (SELECT jsonb_agg(to_jsonb(r) ORDER BY episode_fingerprint) FROM public.outlook_candidate_refs r WHERE user_id=u)=before_refs,
    'Reset changed a deduplication reference';
  ASSERT (SELECT count(*) FROM public.contacts WHERE user_id=u)=1;

  -- Replaying the same fingerprints after reset refreshes pending and preserves terminal.
  v := public.upsert_outlook_interaction_candidate(conn,run,cid,repeat('a',64),repeat('b',64),1::smallint,
    'Email',current_date,NULL,'A refreshed contextual note.',NULL,'explicit_body','ai_extracted');
  ASSERT v->>'result'='refreshed',v::text;
  v := public.upsert_outlook_interaction_candidate(conn,run,cid,repeat('c',64),repeat('d',64),1::smallint,
    'Email',current_date,NULL,'Must not replace accepted work.',NULL,'explicit_body','ai_extracted');
  ASSERT v->>'result'='exists_terminal',v::text;
  ASSERT (SELECT count(*) FROM public.interaction_candidates WHERE user_id=u)=2;
  ASSERT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM public.interactions i WHERE user_id=u)=before_interactions;

  ASSERT has_function_privilege('service_role','public.reset_outlook_round(uuid,uuid,text)','EXECUTE');
  ASSERT NOT has_function_privilege('authenticated','public.reset_outlook_round(uuid,uuid,text)','EXECUTE');
  ASSERT NOT has_function_privilege('anon','public.reset_outlook_round(uuid,uuid,text)','EXECUTE');
  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
    WHERE n.nspname='public' AND p.proname='reset_outlook_round')=1;
  ASSERT (SELECT p.prosecdef AND p.proconfig=ARRAY['search_path=""'] FROM pg_proc p
    WHERE p.oid='public.reset_outlook_round(uuid,uuid,text)'::regprocedure);
END $$;
ROLLBACK;
