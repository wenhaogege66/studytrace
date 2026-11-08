-- Local only, all fixtures roll back. No provider call or raw media is involved.
begin;
insert into auth.users(id,aud,role,is_anonymous,raw_app_meta_data,raw_user_meta_data,created_at)
values('84000000-0000-4000-8000-000000000001','authenticated','authenticated',true,'{"provider":"anonymous","providers":["anonymous"]}','{}',now()),
('84000000-0000-4000-8000-000000000002','authenticated','authenticated',false,'{"provider":"email","providers":["email"]}','{}',now());
insert into auth.sessions(id,user_id,created_at,updated_at) values
('84000000-0000-4000-8000-000000000011','84000000-0000-4000-8000-000000000001',now(),now()),
('84000000-0000-4000-8000-000000000012','84000000-0000-4000-8000-000000000002',now(),now());
select set_config('request.jwt.claim.sub','84000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"84000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"84000000-0000-4000-8000-000000000011"}',true);
insert into public.tasks(id,user_id,title,steps,estimated_minutes,observation_agreement)
values('84000000-0000-4000-8000-000000000021','84000000-0000-4000-8000-000000000001','测试过程观察','[{"id":"s1","title":"测试步骤","completed":false}]',25,'{"phone":"restricted","tablet":"ignored","absenceSeconds":60,"screenDirection":false}');
insert into public.study_sessions(id,user_id,task_id,started_at,resumed_at,camera_enabled,camera_version)
values('84000000-0000-4000-8000-000000000031','84000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000021',now()-interval '1 minute',now()-interval '1 minute',true,1);

set local role authenticated;
do $$ declare data jsonb; begin
  if has_function_privilege('authenticated','public.finish_cloud_observation(uuid,jsonb,text)','execute')
    or has_table_privilege('anon','public.user_consents','select') then raise exception 'Unsafe grants'; end if;
  if public.get_my_consents()<>'{}'::jsonb then raise exception 'Optional consent must default off'; end if;
  begin perform public.prepare_cloud_observation('84000000-0000-4000-8000-000000000031',gen_random_uuid(),clock_timestamp()-interval '6 seconds',clock_timestamp()); raise exception 'Expected consent rejection'; exception when insufficient_privilege then null; end;
  perform public.set_my_consent('ai_reports',true,'2026-11-08.v1');
  begin perform public.set_my_consent('weekly_reports',true,'2026-11-08.v1'); raise exception 'Anonymous weekly report must be rejected'; exception when insufficient_privilege then null; end;
  perform public.set_my_consent('cloud_observation',true,'2026-11-08.v1');
  data:=public.prepare_cloud_observation('84000000-0000-4000-8000-000000000031','84000000-0000-4000-8000-000000000041',clock_timestamp()-interval '6 seconds',clock_timestamp());
  if data->>'status'<>'reserved' or data->'agreement'->>'phone'<>'restricted' then raise exception 'Missing authoritative agreement'; end if;
  begin perform public.prepare_cloud_observation('84000000-0000-4000-8000-000000000031',gen_random_uuid(),clock_timestamp()-interval '6 seconds',clock_timestamp()); raise exception 'Expected in-flight limit'; exception when raise_exception then if sqlerrm='Expected in-flight limit' then raise; end if; end;
  begin insert into public.behavior_events(user_id,session_id,event_type,source,started_at) values('84000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000031','phone_use','cloud_vision',now()); raise exception 'Expected forged cloud result rejection'; exception when insufficient_privilege then null; end;
end $$;
reset role;
-- Simulate a prior completed valid window; never simulate the provider network.
insert into private.cloud_observation_windows(id,user_id,auth_session_id,session_id,camera_version,started_at,ended_at,created_at,status,result)
values('84000000-0000-4000-8000-000000000040','84000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000011','84000000-0000-4000-8000-000000000031',1,clock_timestamp()-interval '26 seconds',clock_timestamp()-interval '20 seconds',clock_timestamp()-interval '20 seconds','complete','{"quality":"good","phone":"possible","tablet":"unknown","model":"test-vision"}');
set local role service_role;
do $$ declare data jsonb; begin
  data:=public.finish_cloud_observation('84000000-0000-4000-8000-000000000041','{"quality":"good","phone":"possible","tablet":"unknown"}','test-vision');
  if jsonb_array_length(data->'candidate_event_ids')<>1 then raise exception 'Expected two-window candidate'; end if;
  perform public.finish_cloud_observation('84000000-0000-4000-8000-000000000041','{"quality":"good","phone":"possible","tablet":"unknown"}','test-vision');
end $$;
reset role;
do $$ begin
  if (select count(*) from public.behavior_events where source='cloud_vision' and session_id='84000000-0000-4000-8000-000000000031')<>1 then raise exception 'Completion retry duplicated event'; end if;
end $$;
insert into public.reminder_events(user_id,session_id,behavior_event_id)
  select user_id,session_id,id from public.behavior_events where session_id='84000000-0000-4000-8000-000000000031';
do $$ declare n integer; data jsonb; window_id uuid; phone_signal text; begin
  for n in 43..46 loop
    update private.cloud_observation_windows set created_at=created_at-interval '20 seconds',started_at=started_at-interval '20 seconds',ended_at=ended_at-interval '20 seconds'
      where session_id='84000000-0000-4000-8000-000000000031';
    window_id:=('84000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
    phone_signal:=case when n=44 then 'clear' else 'possible' end;
    insert into private.cloud_observation_windows(id,user_id,auth_session_id,session_id,camera_version,started_at,ended_at)
    values(window_id,'84000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000011','84000000-0000-4000-8000-000000000031',1,clock_timestamp()-interval '6 seconds',clock_timestamp());
    data:=public.finish_cloud_observation(window_id,jsonb_build_object('quality','good','phone',phone_signal,'tablet','unknown'),'test-vision');
    if n=43 and jsonb_array_length(data->'candidate_event_ids')<>0 then raise exception 'Continuous streak duplicated event'; end if;
    if n=46 and (jsonb_array_length(data->'candidate_event_ids')<>1 or jsonb_array_length(data->'reminder_event_ids')<>0) then
      raise exception 'Separate episode must be recorded but respect reminder cooldown'; end if;
  end loop;
end $$;
-- A late result after revocation is discarded even if it was reserved earlier.
insert into private.cloud_observation_windows(id,user_id,auth_session_id,session_id,camera_version,started_at,ended_at)
values('84000000-0000-4000-8000-000000000042','84000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000011','84000000-0000-4000-8000-000000000031',1,clock_timestamp()-interval '6 seconds',clock_timestamp());
set local role authenticated;
select public.set_my_consent('cloud_observation',false,'2026-11-08.v1');
reset role;
set local role service_role;
do $$ begin if public.finish_cloud_observation('84000000-0000-4000-8000-000000000042','{"quality":"good","phone":"possible","tablet":"unknown"}','test-vision')->>'status'<>'discarded' then raise exception 'Revoked late result accepted'; end if; end $$;
reset role;
-- Permanent account can opt into weekly; AI revocation cascades the opt-out.
update public.observation_runs set started_at=clock_timestamp()-interval '10 seconds',last_observed_at=clock_timestamp()-interval '10 seconds'
  where session_id='84000000-0000-4000-8000-000000000031' and ended_at is null;
set local role authenticated;
do $$ declare first bigint; duplicate bigint; capped bigint; begin
  first:=public.record_observation_coverage('84000000-0000-4000-8000-000000000031',0,1,1,5000);
  duplicate:=public.record_observation_coverage('84000000-0000-4000-8000-000000000031',0,1,1,5000);
  if first<>5000 or duplicate<>first then raise exception 'Coverage replay counted twice'; end if;
  capped:=public.record_observation_coverage('84000000-0000-4000-8000-000000000031',0,1,2,10000);
  if capped-first>100 then raise exception 'Coverage exceeded server elapsed bound'; end if;
  begin perform public.record_observation_coverage('84000000-0000-4000-8000-000000000031',0,1,3,10001); raise exception 'Expected coverage size guard'; exception when invalid_parameter_value then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','84000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"84000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"84000000-0000-4000-8000-000000000012"}',true);
set local role authenticated;
do $$ begin
  if public.get_my_consents()<>'{}'::jsonb then raise exception 'Consent ownership leak'; end if;
  perform public.set_my_consent('ai_reports',true,'2026-11-08.v1');
  perform public.set_my_consent('weekly_reports',true,'2026-11-08.v1');
  perform public.set_my_consent('ai_reports',false,'2026-11-08.v1');
  if (public.get_my_consents()->'weekly_reports'->>'granted')::boolean then raise exception 'Weekly grant survived report revocation'; end if;
  begin perform public.prepare_cloud_observation('84000000-0000-4000-8000-000000000031',gen_random_uuid(),clock_timestamp()-interval '6 seconds',clock_timestamp()); raise exception 'Cross-owner observation accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
-- Deleting business rows does not refund the independent anti-abuse budget.
select set_config('request.jwt.claim.sub','84000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"84000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"84000000-0000-4000-8000-000000000011"}',true);
select public.cancel_study_session('84000000-0000-4000-8000-000000000031',0);
delete from public.tasks where id='84000000-0000-4000-8000-000000000021';
do $$ begin if (select count(*) from private.cloud_observation_quota_receipts where subject_hash=extensions.digest('84000000-0000-4000-8000-000000000001','sha256'))<>1 then raise exception 'Business deletion refunded provider budget'; end if; end $$;
insert into private.cloud_observation_quota_receipts(request_id,subject_hash)
select gen_random_uuid(),extensions.digest('84000000-0000-4000-8000-000000000001','sha256') from generate_series(1,2);
select set_config('request.jwt.claim.sub','84000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"84000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"84000000-0000-4000-8000-000000000011"}',true);
insert into public.tasks(id,user_id,title,steps,estimated_minutes,observation_agreement)
values('84000000-0000-4000-8000-000000000021','84000000-0000-4000-8000-000000000001','重新创建预算测试','[{"id":"s1","title":"测试步骤","completed":false}]',25,'{"phone":"restricted","tablet":"ignored","absenceSeconds":60,"screenDirection":false}');
insert into public.study_sessions(id,user_id,task_id,started_at,resumed_at,camera_enabled,camera_version)
values('84000000-0000-4000-8000-000000000031','84000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000021',now()-interval '1 minute',now()-interval '1 minute',true,1);
set local role authenticated;
do $$ begin
  perform public.set_my_consent('cloud_observation',true,'2026-11-08.v1');
  begin perform public.prepare_cloud_observation('84000000-0000-4000-8000-000000000031',gen_random_uuid(),clock_timestamp()-interval '6 seconds',clock_timestamp()); raise exception 'Budget was refunded after delete';
  exception when raise_exception then if sqlerrm<>'Cloud observation quota reached' then raise; end if; end;
end $$;
rollback;
