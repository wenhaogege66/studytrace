-- Make lifecycle intent explicit. Only lifecycle transitions advance
-- state_version; camera metadata and running timer checkpoints stay within the
-- current generation.
alter table public.study_sessions
  add column if not exists state_version bigint not null default 0
  constraint study_sessions_state_version_nonnegative check (state_version >= 0),
  add column if not exists camera_version bigint not null default 0
  constraint study_sessions_camera_version_nonnegative check (camera_version >= 0);

alter table public.study_sessions
  add constraint study_sessions_state_consistent check (
    (status = 'running' and resumed_at is not null and ended_at is null)
    or (status = 'paused' and resumed_at is null and ended_at is null)
    or (
      status in ('completed', 'cancelled')
      and resumed_at is null
      and ended_at is not null
      and camera_enabled is false
    )
  );

alter table public.study_sessions
  add constraint study_sessions_camera_requires_running check (
    camera_enabled is false or status = 'running'
  );

create or replace function private.bump_study_session_state_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.state_version := old.state_version + 1;
  return new;
end;
$$;

revoke all on function private.bump_study_session_state_version()
  from public, anon, authenticated;

drop trigger if exists study_sessions_bump_state_version
  on public.study_sessions;
create trigger study_sessions_bump_state_version
before update of status on public.study_sessions
for each row execute function private.bump_study_session_state_version();

create or replace function public.pause_study_session(
  p_session_id uuid,
  p_expected_state_version bigint,
  p_accumulated_seconds integer
)
returns public.study_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_session public.study_sessions;
  server_accumulated_seconds integer;
begin
  if current_user_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
  end if;

  if p_expected_state_version is null or p_expected_state_version < 0
    or p_accumulated_seconds is null or p_accumulated_seconds < 0
  then
    raise exception 'Pause version and elapsed time must be nonnegative'
      using errcode = '22023';
  end if;

  select *
  into selected_session
  from public.study_sessions
  where id = p_session_id
    and user_id = current_user_id
  for update;

  if not found then
    raise exception 'Study session not found' using errcode = 'P0002';
  end if;

  if selected_session.status in ('completed', 'cancelled')
    or selected_session.state_version <> p_expected_state_version
  then
    return selected_session;
  end if;

  server_accumulated_seconds := selected_session.accumulated_seconds;
  if selected_session.status = 'running' and selected_session.resumed_at is not null then
    server_accumulated_seconds := selected_session.accumulated_seconds
      + greatest(
          0,
          floor(
            extract(epoch from (clock_timestamp() - selected_session.resumed_at))
          )::integer
        );
  end if;

  update public.study_sessions
  set
    status = 'paused',
    accumulated_seconds = greatest(
      selected_session.accumulated_seconds,
      server_accumulated_seconds,
      p_accumulated_seconds
    ),
    resumed_at = null,
    camera_enabled = false
  where id = selected_session.id
    and user_id = current_user_id
  returning * into selected_session;

  return selected_session;
end;
$$;

create or replace function public.resume_study_session(
  p_session_id uuid,
  p_expected_state_version bigint
)
returns public.study_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_session public.study_sessions;
begin
  if current_user_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
  end if;

  if p_expected_state_version is null or p_expected_state_version < 0 then
    raise exception 'Resume version must be nonnegative' using errcode = '22023';
  end if;

  select *
  into selected_session
  from public.study_sessions
  where id = p_session_id
    and user_id = current_user_id
  for update;

  if not found then
    raise exception 'Study session not found' using errcode = 'P0002';
  end if;

  if selected_session.status <> 'paused'
    or selected_session.state_version <> p_expected_state_version
  then
    return selected_session;
  end if;

  update public.study_sessions
  set
    status = 'running',
    resumed_at = greatest(clock_timestamp(), selected_session.started_at),
    camera_enabled = false
  where id = selected_session.id
    and user_id = current_user_id
  returning * into selected_session;

  return selected_session;
end;
$$;

create or replace function public.set_study_session_camera(
  p_session_id uuid,
  p_expected_state_version bigint,
  p_camera_version bigint,
  p_enabled boolean
)
returns public.study_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_session public.study_sessions;
begin
  if current_user_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
  end if;

  if p_expected_state_version is null or p_expected_state_version < 0
    or p_camera_version is null or p_camera_version < 1
    or p_enabled is null
  then
    raise exception 'Camera state and version are required' using errcode = '22023';
  end if;

  select *
  into selected_session
  from public.study_sessions
  where id = p_session_id
    and user_id = current_user_id
  for update;

  if not found then
    raise exception 'Study session not found' using errcode = 'P0002';
  end if;

  if selected_session.state_version <> p_expected_state_version
    or p_camera_version <= selected_session.camera_version
    or (p_enabled and selected_session.status <> 'running')
  then
    return selected_session;
  end if;

  update public.study_sessions
  set
    camera_enabled = case
      when selected_session.status = 'running' then p_enabled
      else false
    end,
    camera_version = p_camera_version
  where id = selected_session.id
    and user_id = current_user_id
  returning * into selected_session;

  return selected_session;
end;
$$;

-- Existing application functions already validate auth.uid() and ownership;
-- run them as the owner now that direct session writes are removed.
alter function public.start_study_session(uuid, boolean, boolean)
  security definer;
alter function public.finish_study_session(uuid, integer, text)
  security definer;
alter function public.cancel_study_session(uuid, integer)
  security definer;
alter function public.checkpoint_running_session(
  uuid,
  timestamptz,
  integer,
  timestamptz
) security definer;

revoke all on function public.pause_study_session(uuid, bigint, integer)
  from public, anon;
revoke all on function public.resume_study_session(uuid, bigint)
  from public, anon;
revoke all on function public.set_study_session_camera(uuid, bigint, bigint, boolean)
  from public, anon;

grant execute on function public.pause_study_session(uuid, bigint, integer)
  to authenticated;
grant execute on function public.resume_study_session(uuid, bigint)
  to authenticated;
grant execute on function public.set_study_session_camera(uuid, bigint, bigint, boolean)
  to authenticated;

notify pgrst, 'reload schema';
