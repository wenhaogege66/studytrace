alter table public.behavior_events
  add column visual_observation jsonb,
  drop constraint behavior_events_event_type_check,
  drop constraint behavior_events_source_check,
  drop constraint behavior_events_corrected_type_check;
alter table public.behavior_events
  add constraint behavior_events_event_type_check check (
    event_type in ('face_absent','head_direction_change','manual','visual_observation')),
  add constraint behavior_events_source_check check (
    source in ('vision','simulation','manual','cloud_vision')),
  add constraint behavior_events_corrected_type_check check (
    corrected_type is null or corrected_type in
      ('face_absent','head_direction_change','manual','visual_observation','not_relevant'));

create function private.valid_visual_observation(value jsonb)
returns boolean language sql immutable set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(value) = 'object'
    and value ?& array['signal','taskRelevance','summary']
    and value - array['signal','taskRelevance','summary']::text[] = '{}'::jsonb
    and jsonb_typeof(value->'signal') = 'string'
    and value->>'signal' in ('reading','writing','device_interaction','looking_away','absent','unknown')
    and jsonb_typeof(value->'taskRelevance') = 'string'
    and value->>'taskRelevance' in ('related','unrelated','uncertain')
    and jsonb_typeof(value->'summary') = 'string'
    and char_length(value->>'summary') between 1 and 160
    and value->>'summary' = btrim(value->>'summary',
      E' \t\n\r\f\013' || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    and btrim(value->>'summary') <> '',
    false
  );
$$;
revoke all on function private.valid_visual_observation(jsonb) from public, anon, authenticated;

-- This invoker check must run before definer validation: current_user is
-- the real insert caller, or the save RPC owner, not the trigger owner.
create function private.prevent_direct_cloud_insert()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.event_type = 'visual_observation' or new.source = 'cloud_vision'
    or new.visual_observation is not null then
    if current_user <> pg_catalog.pg_get_userbyid(
      (select relowner from pg_catalog.pg_class where oid = 'public.behavior_events'::regclass)
    ) then
      raise exception 'Cloud observations require a reserved RPC' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.prevent_direct_cloud_insert() from public, anon, authenticated;
create trigger behavior_events_00_guard_cloud_insert
before insert on public.behavior_events
for each row execute function private.prevent_direct_cloud_insert();

-- Definer validation can call the revoked private validator during correction.
create function private.guard_visual_observation()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.visual_observation := old.visual_observation;
  end if;
  if new.event_type = 'visual_observation' then
    if new.source <> 'cloud_vision' or new.direction is not null
      or new.ended_at is distinct from new.started_at
      or not private.valid_visual_observation(new.visual_observation)
    then raise exception 'Invalid cloud observation' using errcode = '23514'; end if;
  elsif new.source = 'cloud_vision' or new.visual_observation is not null then
    raise exception 'Observation metadata requires visual_observation' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_visual_observation() from public, anon, authenticated;
-- Run after the existing normalization trigger so original metadata remains authoritative.
create trigger behavior_events_zz_guard_visual
before insert or update on public.behavior_events
for each row execute function private.guard_visual_observation();

create table private.vision_grants (
  session_id uuid primary key references public.study_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  consent_token uuid not null default gen_random_uuid(),
  enabled boolean not null default false,
  state_version bigint not null,
  camera_version bigint not null,
  attempts integer not null default 0 check (attempts between 0 and 60),
  last_reserved_at timestamptz
);
-- One bounded quota row per user. Business-data deletion deliberately preserves it.
create table private.vision_daily_quota (
  user_id uuid primary key references auth.users(id) on delete cascade,
  quota_date date not null,
  attempts integer not null check (attempts between 0 and 120)
);
-- Only the latest reservation is retained per session; no image/context is stored here.
create table private.vision_reservations (
  session_id uuid primary key references private.vision_grants(session_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null unique default gen_random_uuid(),
  consent_token uuid not null,
  state_version bigint not null,
  camera_version bigint not null,
  reserved_at timestamptz not null,
  consumed boolean not null default false
);
alter table private.vision_grants enable row level security;
alter table private.vision_daily_quota enable row level security;
alter table private.vision_reservations enable row level security;
revoke all on private.vision_grants, private.vision_daily_quota, private.vision_reservations
  from public, anon, authenticated;

create function public.set_vision_consent(p_session_id uuid, p_enabled boolean)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  session public.study_sessions;
  token uuid;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_enabled is null then raise exception 'Consent required' using errcode = '22023'; end if;
  select * into session from public.study_sessions where id = p_session_id and user_id = caller for update;
  if not found then raise exception 'Session not found' using errcode = 'P0002'; end if;
  if p_enabled and (session.status <> 'running' or not session.camera_enabled
    or session.observation_profile not in ('study_screen_v1','study_paper_v1')) then
    raise exception 'Vision unavailable for this session' using errcode = 'P0001';
  end if;
  insert into private.vision_grants(session_id,user_id,enabled,state_version,camera_version)
  values(session.id,caller,p_enabled,session.state_version,session.camera_version)
  on conflict(session_id) do update set
    consent_token = gen_random_uuid(), enabled = excluded.enabled,
    state_version = excluded.state_version, camera_version = excluded.camera_version
  returning consent_token into token;
  delete from private.vision_reservations where session_id = session.id;
  return token;
end;
$$;

-- Session lifecycle writes already hold this same row lock. Revoke eagerly
-- on stop/pause/end, not just while paused, so a resume cannot revive consent.
create function private.revoke_vision_on_session_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.status is distinct from old.status
    or new.camera_version is distinct from old.camera_version
    or (old.camera_enabled and not new.camera_enabled) then
    update private.vision_grants set enabled = false, consent_token = gen_random_uuid()
    where session_id = new.id;
    delete from private.vision_reservations where session_id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function private.revoke_vision_on_session_change() from public, anon, authenticated;
create trigger study_sessions_revoke_cloud_vision
after update of status,camera_enabled,camera_version on public.study_sessions
for each row execute function private.revoke_vision_on_session_change();

create function public.reserve_vision_observation(p_session_id uuid, p_consent_token uuid)
returns table(request_id uuid, title text, steps jsonb, observation_profile text)
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  session public.study_sessions;
  consent private.vision_grants;
  quota private.vision_daily_quota;
  reserved_id uuid;
  reservation_time timestamptz;
  utc_date date;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select * into session from public.study_sessions where id = p_session_id and user_id = caller for update;
  if not found then raise exception 'Session not found' using errcode = 'P0002'; end if;
  select * into consent from private.vision_grants where session_id = session.id;
  if session.status <> 'running' or not session.camera_enabled
    or session.observation_profile not in ('study_screen_v1','study_paper_v1')
    or consent.enabled is distinct from true or consent.consent_token is distinct from p_consent_token
    or consent.state_version <> session.state_version or consent.camera_version <> session.camera_version then
    raise exception 'Consent or session expired' using errcode = 'P0001';
  end if;
  reservation_time := clock_timestamp();
  utc_date := (reservation_time at time zone 'UTC')::date;
  if consent.attempts >= 60 or consent.last_reserved_at > reservation_time - interval '30 seconds' then return; end if;
  insert into private.vision_daily_quota(user_id,quota_date,attempts)
  values(caller,utc_date,0) on conflict(user_id) do nothing;
  select * into quota from private.vision_daily_quota where user_id = caller for update;
  if quota.quota_date = utc_date and quota.attempts >= 120 then return; end if;
  update private.vision_daily_quota set quota_date = utc_date,
    attempts = case when quota.quota_date = utc_date then quota.attempts + 1 else 1 end
  where user_id = caller;
  update private.vision_grants set attempts = attempts + 1, last_reserved_at = reservation_time where session_id = session.id;
  insert into private.vision_reservations(session_id,user_id,consent_token,state_version,camera_version,reserved_at)
  values(session.id,caller,p_consent_token,session.state_version,session.camera_version,reservation_time)
  on conflict(session_id) do update set
    request_id = gen_random_uuid(), consent_token = excluded.consent_token,
    state_version = excluded.state_version, camera_version = excluded.camera_version,
    reserved_at = excluded.reserved_at, consumed = false
  returning vision_reservations.request_id into reserved_id;
  return query select reserved_id, task.title, task.steps, session.observation_profile
    from public.tasks task where task.id = session.task_id and task.user_id = caller;
end;
$$;

create function public.save_vision_observation(
  p_session_id uuid, p_consent_token uuid, p_request_id uuid, p_observation jsonb
)
returns public.behavior_events language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  session public.study_sessions;
  consent private.vision_grants;
  reservation private.vision_reservations;
  event public.behavior_events;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not private.valid_visual_observation(p_observation) then
    raise exception 'Invalid observation' using errcode = '22023';
  end if;
  select * into session from public.study_sessions where id = p_session_id and user_id = caller for update;
  if not found then raise exception 'Session not found' using errcode = 'P0002'; end if;
  select * into consent from private.vision_grants where session_id = session.id;
  select * into reservation from private.vision_reservations where session_id = session.id;
  if session.status <> 'running' or not session.camera_enabled
    or session.observation_profile not in ('study_screen_v1','study_paper_v1')
    or consent.enabled is distinct from true or consent.consent_token is distinct from p_consent_token
    or reservation.request_id is distinct from p_request_id or p_request_id is null
    or reservation.consent_token is distinct from p_consent_token or p_consent_token is null
    or reservation.consumed is distinct from false
    or reservation.state_version <> session.state_version or reservation.camera_version <> session.camera_version
    or consent.state_version <> session.state_version or consent.camera_version <> session.camera_version
    or reservation.reserved_at < clock_timestamp() - interval '20 seconds' then
    raise exception 'Observation result expired' using errcode = 'P0001';
  end if;
  insert into public.behavior_events(user_id,session_id,event_type,source,started_at,ended_at,visual_observation)
  values(caller,session.id,'visual_observation','cloud_vision',reservation.reserved_at,reservation.reserved_at,p_observation)
  returning * into event;
  update private.vision_reservations set consumed = true where session_id = session.id;
  return event;
end;
$$;

revoke all on function public.set_vision_consent(uuid,boolean) from public, anon;
revoke all on function public.reserve_vision_observation(uuid,uuid) from public, anon;
revoke all on function public.save_vision_observation(uuid,uuid,uuid,jsonb) from public, anon;
grant execute on function public.set_vision_consent(uuid,boolean) to authenticated;
grant execute on function public.reserve_vision_observation(uuid,uuid) to authenticated;
grant execute on function public.save_vision_observation(uuid,uuid,uuid,jsonb) to authenticated;

-- Existing deletion semantics plus cascade deletion of grants/reservations.
-- Daily vision abuse quota survives business deletion, but auth-user removal cascades it.
create or replace function public.delete_my_data()
returns void language plpgsql security definer set search_path = ''
as $$
declare caller uuid := auth.uid();
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  delete from public.reminder_events where user_id = caller;
  delete from public.behavior_events where user_id = caller;
  delete from public.reviews where user_id = caller;
  delete from public.study_sessions where user_id = caller;
  delete from public.tasks where user_id = caller;
  delete from public.user_settings where user_id = caller;
  delete from private.ai_generation_quota where user_id = caller;
end;
$$;

notify pgrst, 'reload schema';
