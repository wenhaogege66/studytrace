-- Local isolated fixtures: known valid milliseconds are explicitly provided;
-- no wall-clock interval is implicitly considered successful inference.
begin;
insert into auth.users(id,aud,role,is_anonymous,created_at,updated_at) values
('a3000000-0000-4000-8000-000000000001','authenticated','authenticated',true,now(),now());
insert into public.user_settings(user_id) values('a3000000-0000-4000-8000-000000000001');
insert into public.tasks(id,user_id,title,estimated_minutes,steps) values
('a3100000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000001','Observation fixture',30,'[{"id":"s1","title":"读书","completed":false}]');
insert into public.study_sessions(id,user_id,task_id,status,task_outcome,started_at,ended_at,accumulated_seconds) values
('a3200000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000001','a3100000-0000-4000-8000-000000000001','cancelled','not_completed',now()-interval '10 minutes',now(),600);
insert into public.session_segments(user_id,session_id,started_at,ended_at) values
('a3000000-0000-4000-8000-000000000001','a3200000-0000-4000-8000-000000000001',now()-interval '10 minutes',now());
insert into public.observation_runs(user_id,session_id,started_at,ended_at,last_observed_at,observation_profile,detector_version,effective_milliseconds) values
('a3000000-0000-4000-8000-000000000001','a3200000-0000-4000-8000-000000000001',now()-interval '10 minutes',now(),now(),'study_screen_v1','fixture.v1',120000);
insert into private.cloud_observation_facts(id,user_id,session_id,started_at,ended_at,quality,model_id) values
('a3300000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000001','a3200000-0000-4000-8000-000000000001',now()-interval '100 seconds',now()-interval '94 seconds','good','fixture-model'),
('a3300000-0000-4000-8000-000000000002','a3000000-0000-4000-8000-000000000001','a3200000-0000-4000-8000-000000000001',now()-interval '80 seconds',now()-interval '74 seconds','unknown','fixture-model');
set local role authenticated;
select set_config('request.jwt.claim.sub','a3000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"a3000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
do $$
declare result jsonb:=public.get_my_insights(7);
begin
  if (result#>>'{observation,observed_seconds}')::integer<>120
    or(result#>>'{observation,coverage_percent}')::numeric<>20
    or(result#>>'{observation,cloud,window_count}')::integer<>2
    or(result#>>'{observation,cloud,unknown_window_count}')::integer<>1
    or(result#>>'{observation,cloud,sampled_seconds}')::integer<>6 then
    raise exception 'Local/cloud coverage was conflated or inflated: %',result->'observation';
  end if;
end; $$;
reset role;
delete from public.tasks where id='a3100000-0000-4000-8000-000000000001';
do $$ begin
  if exists(select 1 from private.cloud_observation_facts where user_id='a3000000-0000-4000-8000-000000000001') then
    raise exception 'Cloud evidence survived business deletion'; end if;
end; $$;
rollback;
