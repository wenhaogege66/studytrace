-- Transactional regression tests. Apply all migrations to an isolated DB first.
begin;

do $$
begin
  if has_schema_privilege('authenticated', 'private', 'usage')
    or has_table_privilege('authenticated', 'private.vision_grants', 'select,insert,update,delete')
    or has_table_privilege('anon', 'private.vision_daily_quota', 'select,insert,update,delete')
    or has_table_privilege('authenticated', 'private.vision_reservations', 'select,insert,update,delete')
    or has_function_privilege('anon', 'public.set_vision_consent(uuid,boolean)', 'execute')
    or has_function_privilege('anon', 'public.reserve_vision_observation(uuid,uuid)', 'execute')
    or has_function_privilege('anon', 'public.save_vision_observation(uuid,uuid,uuid,jsonb)', 'execute')
  then raise exception 'Vision storage and RPCs must be private/auth scoped'; end if;
end;
$$;

insert into auth.users (id, is_anonymous) values
  ('11111111-1111-4111-8111-111111111111', true),
  ('22222222-2222-4222-8222-222222222222', true);
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  caller uuid := auth.uid();
  task_id uuid;
  session public.study_sessions;
  token uuid;
  newer_token uuid;
  request_id uuid;
  event public.behavior_events;
  observation jsonb := '{"signal":"unknown","taskRelevance":"uncertain","summary":"Cannot tell"}';
  attempts integer;
  candidate jsonb;
begin
  insert into public.tasks (user_id, title, steps, estimated_minutes, observation_profile)
  values (caller, 'Read chapter', '[{"id":"one","title":"Read","completed":false}]', 20, 'study_paper_v1')
  returning id into task_id;
  session := public.start_study_session(task_id, false, false);
  session := public.set_study_session_camera(session.id, session.state_version, 1, true);
  token := public.set_vision_consent(session.id, true);
  select r.request_id into request_id from public.reserve_vision_observation(session.id, token) r;
  if request_id is null then raise exception 'First observation must reserve'; end if;
  event := public.save_vision_observation(session.id, token, request_id, observation);
  if event.event_type <> 'visual_observation' or event.source <> 'cloud_vision'
    or event.visual_observation <> observation or event.started_at <> event.ended_at
  then raise exception 'Structured event must be instantaneous'; end if;
  begin
    perform public.save_vision_observation(session.id, token, request_id, observation);
    raise exception 'Reservation replay accepted' using errcode = 'XX000';
  exception when sqlstate 'P0001' then null; end;
  if exists(select 1 from public.reserve_vision_observation(session.id, token)) then
    raise exception '30 second interval not enforced';
  end if;

  -- Corrections may change review fields but cannot rewrite original metadata.
  set local role authenticated;
  update public.behavior_events set visual_observation = '{"signal":"absent","taskRelevance":"unrelated","summary":"Changed"}',
    corrected_type = 'visual_observation', review_status = 'corrected', correction_note = 'Keep observation'
  where id = event.id;
  if (select visual_observation from public.behavior_events where id = event.id) <> observation then
    raise exception 'Original observation mutated'; end if;
  reset role;

  -- Direct authenticated inserts cannot forge a cloud result.
  set local role authenticated;
  begin
    insert into public.behavior_events(user_id,session_id,event_type,source,started_at,ended_at,visual_observation)
    values(caller,session.id,'visual_observation','cloud_vision',now(),now(),observation);
    raise exception 'Direct cloud insert accepted' using errcode = 'XX000';
  exception when insufficient_privilege then null; end;
  reset role;

  update private.vision_grants set last_reserved_at = now() - interval '31 seconds' where session_id = session.id;
  select r.request_id into request_id from public.reserve_vision_observation(session.id, token) r;
  newer_token := public.set_vision_consent(session.id, false);
  if token = newer_token then raise exception 'Disable must rotate token'; end if;
  begin
    perform public.save_vision_observation(session.id, token, request_id, observation);
    raise exception 'Revoked late result accepted' using errcode = 'XX000';
  exception when sqlstate 'P0001' then null; end;
  newer_token := public.set_vision_consent(session.id, true);
  if (select g.attempts from private.vision_grants g where g.session_id = session.id) <> 2 then
    raise exception 'Consent rotation reset session attempts'; end if;
  if token = newer_token then raise exception 'Enable must rotate token'; end if;
  begin
    perform public.reserve_vision_observation(session.id, token);
    raise exception 'Old grant accepted' using errcode = 'XX000';
  exception when sqlstate 'P0001' then null; end;

  update private.vision_grants set last_reserved_at = now() - interval '31 seconds' where session_id = session.id;
  select r.request_id into request_id from public.reserve_vision_observation(session.id, newer_token) r;
  session := public.pause_study_session(session.id, session.state_version, 0);
  begin
    perform public.save_vision_observation(session.id, newer_token, request_id, observation);
    raise exception 'Paused late result accepted' using errcode = 'XX000';
  exception when sqlstate 'P0001' then null; end;
  session := public.resume_study_session(session.id, session.state_version);
  session := public.set_study_session_camera(session.id, session.state_version, 2, true);
  begin
    perform public.save_vision_observation(session.id, newer_token, request_id, observation);
    raise exception 'Pause/resume resurrected grant' using errcode = 'XX000';
  exception when sqlstate 'P0001' then null; end;
  newer_token := public.set_vision_consent(session.id, true);

  update private.vision_grants set last_reserved_at = now() - interval '31 seconds' where session_id = session.id;
  select r.request_id into request_id from public.reserve_vision_observation(session.id, newer_token) r;
  update private.vision_reservations set reserved_at = now() - interval '21 seconds' where session_id = session.id;
  begin
    perform public.save_vision_observation(session.id, newer_token, request_id, observation);
    raise exception 'Expired result accepted' using errcode = 'XX000';
  exception when sqlstate 'P0001' then null; end;
  session := public.set_study_session_camera(session.id,session.state_version,3,false);
  begin
    perform public.save_vision_observation(session.id, newer_token, request_id, observation);
    raise exception 'Camera-stop late result accepted' using errcode = 'XX000';
  exception when sqlstate 'P0001' then null; end;
  session := public.set_study_session_camera(session.id,session.state_version,4,true);
  newer_token := public.set_vision_consent(session.id,true);

  -- Ownership is checked even though these RPCs run as their owner.
  perform set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
  begin
    perform public.reserve_vision_observation(session.id, newer_token);
    raise exception 'Foreign session accepted' using errcode = 'XX000';
  exception when sqlstate 'P0002' then null; end;
  perform set_config('request.jwt.claim.sub', caller::text, true);

  -- Failed model calls leave reservations unused but still consume quota.
  update private.vision_grants set attempts = 59, last_reserved_at = now() - interval '31 seconds' where session_id = session.id;
  select r.request_id into request_id from public.reserve_vision_observation(session.id, newer_token) r;
  if request_id is null then raise exception '60th session attempt rejected'; end if;
  update private.vision_grants set last_reserved_at = now() - interval '31 seconds' where session_id = session.id;
  if exists(select 1 from public.reserve_vision_observation(session.id, newer_token)) then
    raise exception 'Session quota not enforced'; end if;
  update private.vision_grants set attempts = 0 where session_id = session.id;
  update private.vision_daily_quota set attempts = 119 where user_id = caller;
  select r.request_id into request_id from public.reserve_vision_observation(session.id, newer_token) r;
  if request_id is null then raise exception '120th daily attempt rejected'; end if;
  update private.vision_grants set last_reserved_at = now() - interval '31 seconds' where session_id = session.id;
  if exists(select 1 from public.reserve_vision_observation(session.id, newer_token)) then
    raise exception 'Daily quota not enforced'; end if;
  select q.attempts into attempts from private.vision_daily_quota q where user_id = caller;
  if attempts <> 120 then raise exception 'Expected 120 UTC daily attempts'; end if;

  -- A prior UTC day rolls over on reserve, regardless of the database timezone.
  update private.vision_daily_quota set quota_date = (clock_timestamp() at time zone 'UTC')::date - 1 where user_id = caller;
  set local timezone = 'Pacific/Honolulu';
  set local role authenticated;
  select r.request_id into request_id from public.reserve_vision_observation(session.id, newer_token) r;
  event := public.save_vision_observation(session.id,newer_token,request_id,observation);
  reset role;
  if (select q.attempts from private.vision_daily_quota q where user_id = caller) <> 1
    or (select q.quota_date from private.vision_daily_quota q where user_id = caller) <> (clock_timestamp() at time zone 'UTC')::date then
    raise exception 'UTC quota rollover failed'; end if;
  update private.vision_daily_quota set attempts = 120 where user_id = caller;

  -- Invalid JSON must fail even when a valid reservation exists.
  for candidate in select value from jsonb_array_elements(jsonb_build_array(
    '{"signal":"focused","taskRelevance":"related","summary":"test"}'::jsonb,
    '{"signal":"reading","taskRelevance":"focused","summary":"test"}'::jsonb,
    '{"signal":"reading","taskRelevance":"related","summary":"test","image":"forbidden"}'::jsonb,
    jsonb_build_object('signal','reading','taskRelevance','related','summary',E'\n'),
    jsonb_build_object('signal','reading','taskRelevance','related','summary',E'\tReading\t')
  )) loop
    begin
      perform public.save_vision_observation(session.id,newer_token,request_id,candidate);
      raise exception 'Invalid observation accepted' using errcode = 'XX000';
    exception when invalid_parameter_value then null; end;
  end loop;

  perform public.delete_my_data();
  if exists(select 1 from private.vision_grants where user_id = caller)
    or exists(select 1 from private.vision_reservations where user_id = caller)
    or exists(select 1 from public.behavior_events where user_id = caller)
  then raise exception 'All-data delete left vision records'; end if;
  if (select q.attempts from private.vision_daily_quota q where user_id = caller) <> 120 then
    raise exception 'Delete reset abuse quota'; end if;

  insert into public.tasks(user_id,title,steps,estimated_minutes,observation_profile)
  values(caller,'Exercise','[{"id":"one","title":"Walk","completed":false}]',20,'off_device_v1')
  returning id into task_id;
  session := public.start_study_session(task_id, false, false);
  begin
    perform public.set_vision_consent(session.id,true);
    raise exception 'Off-device grant accepted' using errcode = 'XX000';
  exception when sqlstate 'P0001' then null; end;
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.set_vision_consent(session.id,false);
    raise exception 'Unauthenticated grant accepted' using errcode = 'XX000';
  exception when insufficient_privilege then null; end;
end;
$$;

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
set local role authenticated;
do $$
declare
  task_id uuid;
  session public.study_sessions;
  token uuid;
  request_id uuid;
  event public.behavior_events;
  observation jsonb := '{"signal":"reading","taskRelevance":"related","summary":"Reading a book"}';
begin
  insert into public.tasks(user_id,title,steps,estimated_minutes,observation_profile)
  values(auth.uid(),'Read','[{"id":"one","title":"Read","completed":false}]',20,'study_paper_v1')
  returning id into task_id;
  session := public.start_study_session(task_id,false,false);
  session := public.set_study_session_camera(session.id,session.state_version,1,true);
  token := public.set_vision_consent(session.id,true);
  select r.request_id into request_id from public.reserve_vision_observation(session.id,token) r;
  event := public.save_vision_observation(session.id,token,request_id,observation);
  -- Do not let owner-primed PL/pgSQL plans hide cold-connection privilege errors.
  discard plans;
  update public.behavior_events set visual_observation = null,
    corrected_type = 'manual', review_status = 'corrected' where id = event.id;
  if (select visual_observation from public.behavior_events where id = event.id) <> observation then
    raise exception 'Authenticated correction changed observation'; end if;
  begin
    insert into public.behavior_events(user_id,session_id,event_type,source,started_at,ended_at,visual_observation)
    values(auth.uid(),session.id,'visual_observation','cloud_vision',now(),now(),observation);
    raise exception 'Authenticated direct cloud insert accepted' using errcode = 'XX000';
  exception when insufficient_privilege then null; end;
  delete from public.behavior_events where id = event.id;
  if exists(select 1 from public.behavior_events where id = event.id) then
    raise exception 'Owner cannot delete observation'; end if;
  perform public.delete_my_data();
end;
$$;
reset role;

rollback;
