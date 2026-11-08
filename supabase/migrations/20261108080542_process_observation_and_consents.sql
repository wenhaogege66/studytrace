-- No images, audio, landmarks or free-form provider output are persisted here.
create table public.user_consents (
  user_id uuid not null references auth.users(id) on delete cascade,
  feature text not null check (feature in ('cloud_observation','ai_reports','weekly_reports')),
  version text not null,
  granted boolean not null default false,
  granted_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, feature)
);
alter table public.user_consents enable row level security;
create policy user_consents_select_own on public.user_consents for select to authenticated
  using ((select auth.uid()) = user_id);
revoke all on public.user_consents from public, anon, authenticated;
grant select on public.user_consents to authenticated;

create or replace function public.get_my_consents() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(feature, jsonb_build_object(
    'granted',granted,'version',version,'granted_at',granted_at,
    'revoked_at',revoked_at,'updated_at',updated_at)), '{}'::jsonb)
  from public.user_consents where user_id = auth.uid();
$$;
revoke all on function public.get_my_consents() from public, anon;
grant execute on function public.get_my_consents() to authenticated;

create or replace function public.set_my_consent(p_feature text, p_granted boolean, p_version text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); ts timestamptz := clock_timestamp();
begin
  if caller is null or p_feature not in ('cloud_observation','ai_reports','weekly_reports')
    or p_version <> '2026-11-08.v1' or p_granted is null then
    raise exception 'Invalid consent request' using errcode='42501';
  end if;
  perform private.lock_owner_mutation_resources(array[caller]);
  if not exists(select 1 from auth.sessions where id = nullif(auth.jwt()->>'session_id','')::uuid and user_id=caller and (not_after is null or not_after>ts)) then
    raise exception 'Live session required' using errcode='42501';
  end if;
  if p_feature='weekly_reports' and p_granted and (
    not exists(select 1 from auth.users where id=caller and is_anonymous is false)
    or not exists(select 1 from public.user_consents where user_id=caller and feature='ai_reports' and granted and version=p_version)
  ) then raise exception 'AI report consent and permanent account required' using errcode='42501'; end if;
  insert into public.user_consents(user_id,feature,version,granted,granted_at,revoked_at,updated_at)
  values(caller,p_feature,p_version,p_granted,case when p_granted then ts end,case when not p_granted then ts end,ts)
  on conflict(user_id,feature) do update set version=excluded.version, granted=excluded.granted,
    granted_at=case when excluded.granted and (not user_consents.granted or user_consents.version<>excluded.version)
      then ts else user_consents.granted_at end,
    revoked_at=case when not excluded.granted then ts else null end, updated_at=ts;
  if p_feature='ai_reports' and not p_granted then
    update public.user_consents set granted=false,revoked_at=ts,updated_at=ts
      where user_id=caller and feature='weekly_reports';
  end if;
  return public.get_my_consents();
end; $$;
revoke all on function public.set_my_consent(text,boolean,text) from public,anon;
grant execute on function public.set_my_consent(text,boolean,text) to authenticated;

alter table public.behavior_events
  drop constraint behavior_events_event_type_check,
  drop constraint behavior_events_source_check,
  drop constraint behavior_events_corrected_type_check,
  add constraint behavior_events_event_type_check check(event_type in ('face_absent','head_direction_change','manual','phone_use','tablet_use')),
  add constraint behavior_events_source_check check(source in ('vision','simulation','manual','cloud_vision')),
  add constraint behavior_events_corrected_type_check check(corrected_type is null or corrected_type in ('face_absent','head_direction_change','manual','phone_use','tablet_use','not_relevant')),
  add column observation_metadata jsonb not null default '{}'::jsonb
    check(jsonb_typeof(observation_metadata)='object' and octet_length(observation_metadata::text)<=2048);

create or replace function private.guard_cloud_observation_event() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='UPDATE' then new.observation_metadata:=old.observation_metadata; return new; end if;
  if new.source='cloud_vision' then
    if current_setting('studytrace.trusted_cloud_result',true) is distinct from '1' then
      raise exception 'Cloud observations are server-generated only' using errcode='42501'; end if;
  else new.observation_metadata:='{}'::jsonb; end if;
  return new;
end; $$;
revoke all on function private.guard_cloud_observation_event() from public,anon,authenticated;
create trigger behavior_events_guard_cloud before insert or update on public.behavior_events
  for each row execute function private.guard_cloud_observation_event();

create table private.cloud_observation_windows (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  auth_session_id uuid not null references auth.sessions(id) on delete cascade,
  session_id uuid not null references public.study_sessions(id) on delete cascade,
  camera_version bigint not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  status text not null default 'pending' check(status in ('pending','complete','discarded')),
  result jsonb,
  check(ended_at>=started_at and ended_at-started_at between interval '5 seconds' and interval '8 seconds')
);
create index cloud_observation_user_created_idx on private.cloud_observation_windows(user_id,created_at);
create index cloud_observation_auth_session_idx on private.cloud_observation_windows(auth_session_id);
create index cloud_observation_session_created_idx on private.cloud_observation_windows(session_id,created_at desc);
create index cloud_observation_created_idx on private.cloud_observation_windows(created_at);
alter table private.cloud_observation_windows enable row level security;
revoke all on private.cloud_observation_windows from public,anon,authenticated;

-- Operational abuse budget is deliberately independent of deletable study
-- records. Resetting/erasing a plan must not refund provider calls. The subject
-- is a one-way hash, no media or business record, retained for seven days.
create table private.cloud_observation_quota_receipts(
  request_id uuid primary key,
  subject_hash bytea not null check(octet_length(subject_hash)=32),
  created_at timestamptz not null default clock_timestamp()
);
create index cloud_observation_quota_subject_time_idx on private.cloud_observation_quota_receipts(subject_hash,created_at);
create index cloud_observation_quota_time_idx on private.cloud_observation_quota_receipts(created_at);
alter table private.cloud_observation_quota_receipts enable row level security;
revoke all on private.cloud_observation_quota_receipts from public,anon,authenticated;

create or replace function public.prepare_cloud_observation(
  p_session_id uuid,p_window_id uuid,p_started_at timestamptz,p_ended_at timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=auth.uid(); ts timestamptz:=clock_timestamp(); s public.study_sessions%rowtype;
  sid uuid:=nullif(auth.jwt()->>'session_id','')::uuid; old_window private.cloud_observation_windows%rowtype;
begin
  if caller is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform private.lock_owner_mutation_resources(array[caller]);
  if not exists(select 1 from auth.sessions where id=sid and user_id=caller and (not_after is null or not_after>ts)) then
    raise exception 'Live session required' using errcode='42501'; end if;
  select * into s from public.study_sessions where id=p_session_id and user_id=caller for share;
  if not found or s.status<>'running' or not s.camera_enabled or s.experiment_mode then
    raise exception 'Observation is not active' using errcode='42501'; end if;
  if not exists(select 1 from public.user_consents where user_id=caller and feature='cloud_observation'
    and granted and version='2026-11-08.v1') then raise exception 'Cloud consent required' using errcode='42501'; end if;
  if coalesce(s.observation_agreement->>'phone','ignored')<>'restricted'
    and coalesce(s.observation_agreement->>'tablet','ignored')<>'restricted' then
    raise exception 'No cloud observation rule is enabled' using errcode='22023'; end if;
  if p_started_at is null or p_ended_at is null or p_window_id is null or p_ended_at>ts+interval '2 seconds'
    or p_started_at<ts-interval '25 seconds' or p_started_at<s.started_at
    or p_ended_at-p_started_at not between interval '5 seconds' and interval '8 seconds' then
    raise exception 'Invalid observation window' using errcode='22023'; end if;
  select * into old_window from private.cloud_observation_windows where id=p_window_id;
  if found then
    if old_window.user_id<>caller or old_window.session_id<>p_session_id then
      raise exception 'Window belongs to another request' using errcode='42501'; end if;
    return jsonb_build_object('status',old_window.status,'result',old_window.result);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('studytrace:cloud-global:'||(ts at time zone 'UTC')::date::text,0));
  if (select count(*) from private.cloud_observation_quota_receipts where created_at>=ts-interval '1 minute' and subject_hash=extensions.digest(caller::text,'sha256'))>=3
    or (select count(*) from private.cloud_observation_quota_receipts where created_at>=date_trunc('day',ts at time zone 'UTC') at time zone 'UTC' and subject_hash=extensions.digest(caller::text,'sha256'))>=360
    or (select count(*) from private.cloud_observation_quota_receipts where created_at>=date_trunc('day',ts at time zone 'UTC') at time zone 'UTC')>=2000
    or exists(select 1 from private.cloud_observation_windows where user_id=caller and status='pending' and created_at>ts-interval '30 seconds') then
    raise exception 'Cloud observation quota reached' using errcode='P0001'; end if;
  insert into private.cloud_observation_quota_receipts(request_id,subject_hash,created_at)
    values(p_window_id,extensions.digest(caller::text,'sha256'),ts);
  insert into private.cloud_observation_windows(id,user_id,auth_session_id,session_id,camera_version,started_at,ended_at)
    values(p_window_id,caller,sid,p_session_id,s.camera_version,p_started_at,p_ended_at);
  delete from private.cloud_observation_windows where created_at<ts-interval '7 days';
  delete from private.cloud_observation_quota_receipts where created_at<ts-interval '7 days';
  return jsonb_build_object('status','reserved','agreement',s.observation_agreement);
end; $$;
revoke all on function public.prepare_cloud_observation(uuid,uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.prepare_cloud_observation(uuid,uuid,timestamptz,timestamptz) to authenticated;

-- Provider results cannot be forged via an authenticated client RPC. This
-- completion endpoint is service-role only, following a user-JWT reservation.
create or replace function public.finish_cloud_observation(p_window_id uuid,p_result jsonb,p_model text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w private.cloud_observation_windows%rowtype; s public.study_sessions%rowtype;
  previous private.cloud_observation_windows%rowtype; rule text; event_id uuid;
  final_result jsonb; candidate_ids jsonb:='[]'::jsonb; reminder_ids jsonb:='[]'::jsonb; active_rules jsonb:='[]'::jsonb;
  original_claims text:=current_setting('request.jwt.claims',true);
  original_sub text:=current_setting('request.jwt.claim.sub',true);
  original_trusted text:=current_setting('studytrace.trusted_cloud_result',true);
begin
  select * into w from private.cloud_observation_windows where id=p_window_id;
  if not found then raise exception 'Unknown observation window' using errcode='P0002'; end if;
  perform private.lock_owner_mutation_resources(array[w.user_id]);
  select * into w from private.cloud_observation_windows where id=p_window_id for update;
  if w.status<>'pending' then return coalesce(w.result,'{}'::jsonb); end if;
  select * into s from public.study_sessions where id=w.session_id and user_id=w.user_id for share;
  if not found or s.status<>'running' or not s.camera_enabled or s.camera_version<>w.camera_version
    or w.created_at<clock_timestamp()-interval '30 seconds'
    or not exists(select 1 from auth.sessions where id=w.auth_session_id and user_id=w.user_id and (not_after is null or not_after>clock_timestamp()))
    or not exists(select 1 from public.user_consents where user_id=w.user_id and feature='cloud_observation'
      and granted and version='2026-11-08.v1') then
    update private.cloud_observation_windows set status='discarded',result='{"status":"discarded"}'::jsonb where id=w.id;
    return '{"status":"discarded"}'::jsonb;
  end if;
  if p_result->>'quality' not in ('good','unknown') or p_result->>'phone' not in ('clear','possible','unknown')
    or p_result->>'tablet' not in ('clear','possible','unknown') or length(p_model)>100
    or p_result->>'quality' is null or p_result->>'phone' is null or p_result->>'tablet' is null then
    raise exception 'Invalid structured observation result' using errcode='22023'; end if;
  select * into previous from private.cloud_observation_windows
    where session_id=w.session_id and created_at<w.created_at order by created_at desc limit 1;
  final_result:=jsonb_build_object('status','complete','quality',p_result->>'quality','phone',p_result->>'phone','tablet',p_result->>'tablet','model',p_model);
  final_result:=final_result||jsonb_build_object('usage',jsonb_build_object(
    'inputTokens',least(10000000,greatest(0,coalesce((p_result#>>'{usage,inputTokens}')::integer,0))),
    'outputTokens',least(10000000,greatest(0,coalesce((p_result#>>'{usage,outputTokens}')::integer,0)))
  ));
  foreach rule in array array['phone','tablet'] loop
    if s.observation_agreement->>rule='restricted' and p_result->>'quality'='good' and p_result->>rule='possible'
      and previous.status='complete' and previous.camera_version=w.camera_version
      and previous.result->>'quality'='good' and previous.result->>rule='possible'
      and previous.result->>'model'=p_model
      and w.ended_at-previous.ended_at between interval '14 seconds' and interval '28 seconds' then
      active_rules:=active_rules||jsonb_build_array(rule);
      if not (coalesce(previous.result->'active_rules','[]'::jsonb) ? rule) then
      -- The event describes this sampled window, not the unsampled interval.
      -- Set the authenticated ownership context for the existing insert guard.
      perform set_config('request.jwt.claim.sub',w.user_id::text,true);
      perform set_config('studytrace.trusted_cloud_result','1',true);
      perform set_config('request.jwt.claims',jsonb_build_object('sub',w.user_id,'role','authenticated')::text,true);
      insert into public.behavior_events(user_id,session_id,event_type,source,started_at,ended_at,observation_metadata)
        values(w.user_id,w.session_id,rule||'_use','cloud_vision',w.started_at,w.ended_at,
          jsonb_build_object('rule',rule,'model',p_model,'detector_version','cloud-sequence.v1','window_id',w.id,
            'previous_window_id',previous.id,'sampled_seconds',extract(epoch from w.ended_at-w.started_at))) returning id into event_id;
      candidate_ids:=candidate_ids||jsonb_build_array(event_id);
      if s.reminders_enabled and exists(select 1 from public.user_settings where user_id=w.user_id and reminders_enabled)
        and not exists(select 1 from public.reminder_events reminder join public.behavior_events event on event.id=reminder.behavior_event_id
          where reminder.user_id=w.user_id and event.event_type=rule||'_use' and reminder.shown_at>clock_timestamp()-interval '10 minutes') then
        reminder_ids:=reminder_ids||jsonb_build_array(event_id);
      end if;
      end if;
    end if;
  end loop;
  final_result:=final_result||jsonb_build_object('candidate_event_ids',candidate_ids,'reminder_event_ids',reminder_ids,'active_rules',active_rules);
  update private.cloud_observation_windows set status='complete',result=final_result where id=w.id;
  perform set_config('request.jwt.claims',coalesce(original_claims,''),true);
  perform set_config('request.jwt.claim.sub',coalesce(original_sub,''),true);
  perform set_config('studytrace.trusted_cloud_result',coalesce(original_trusted,''),true);
  return final_result;
end; $$;
revoke all on function public.finish_cloud_observation(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.finish_cloud_observation(uuid,jsonb,text) to service_role;
-- Six-day target plus hourly cleanup keeps minimized anti-abuse receipts
-- within the disclosed seven-day window during normal scheduler operation.
select cron.schedule('studytrace-cloud-observation-cleanup','12 * * * *',
  'delete from private.cloud_observation_quota_receipts where created_at<clock_timestamp()-interval ''6 days''; delete from private.cloud_observation_windows where created_at<clock_timestamp()-interval ''7 days'';');
notify pgrst,'reload schema';
