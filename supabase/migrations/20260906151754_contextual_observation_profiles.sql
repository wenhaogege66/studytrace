-- Keep task-aware camera behavior explicit and stable across edits. The AI may
-- suggest one of these profiles, but only deterministic browser rules execute it.

alter table public.tasks
  add column observation_profile text not null default 'study_screen_v1'
  check (
    observation_profile in (
      'study_screen_v1',
      'study_paper_v1',
      'off_device_v1'
    )
  );

alter table public.study_sessions
  add column observation_profile text not null default 'study_screen_v1'
  check (
    observation_profile in (
      'study_screen_v1',
      'study_paper_v1',
      'off_device_v1'
    )
  );

comment on column public.tasks.observation_profile is
  'User-confirmed allowlisted observation profile suggested during task planning.';
comment on column public.study_sessions.observation_profile is
  'Snapshot of the task observation profile when the study session was created.';

create or replace function private.keep_session_observation_profile_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.observation_profile is distinct from old.observation_profile then
    raise exception 'A study session observation profile is an immutable snapshot'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists keep_session_observation_profile_immutable
  on public.study_sessions;
create trigger keep_session_observation_profile_immutable
before update of observation_profile on public.study_sessions
for each row execute function private.keep_session_observation_profile_immutable();

-- Keep AI quota enforcement in Postgres so it remains atomic across Vercel
-- instances and cold starts. This table stores no task content.
create table private.ai_generation_quota (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null,
  attempts integer not null check (attempts > 0)
);

revoke all on table private.ai_generation_quota
  from public, anon, authenticated;

create or replace function public.consume_ai_generation_quota()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_time timestamptz := clock_timestamp();
  allowed boolean;
begin
  if current_user_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
  end if;

  insert into private.ai_generation_quota (
    user_id,
    window_started_at,
    attempts
  )
  values (current_user_id, current_time, 1)
  on conflict (user_id) do update
  set
    window_started_at = case
      when private.ai_generation_quota.window_started_at <= current_time - interval '10 minutes'
        then current_time
      else private.ai_generation_quota.window_started_at
    end,
    attempts = case
      when private.ai_generation_quota.window_started_at <= current_time - interval '10 minutes'
        then 1
      else private.ai_generation_quota.attempts + 1
    end
  returning attempts <= 8 into allowed;

  return allowed;
end;
$$;

revoke all on function public.consume_ai_generation_quota()
  from public, anon;
grant execute on function public.consume_ai_generation_quota()
  to authenticated;

create or replace function public.start_study_session(
  p_task_id uuid,
  p_reminders_enabled boolean default true,
  p_experiment_mode boolean default false
)
returns public.study_sessions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  active_session public.study_sessions;
  selected_task public.tasks;
  created_session public.study_sessions;
begin
  if current_user_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
  end if;

  -- Serialize starts for this anonymous identity so double clicks and retried
  -- requests return one resumable active session instead of surfacing 23505.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(current_user_id::text, 0)
  );

  select *
  into active_session
  from public.study_sessions
  where user_id = current_user_id
    and status in ('running', 'paused')
  limit 1;

  if found then
    return active_session;
  end if;

  select *
  into selected_task
  from public.tasks
  where id = p_task_id
    and user_id = current_user_id
  for update;

  if not found then
    raise exception 'Task not found' using errcode = 'P0002';
  end if;

  if selected_task.status not in ('planned', 'in_progress') then
    raise exception 'Completed or archived tasks cannot start a new study session'
      using errcode = 'P0001';
  end if;

  update public.tasks
  set status = 'in_progress', completed_at = null
  where id = selected_task.id
    and user_id = current_user_id;

  insert into public.study_sessions (
    user_id,
    task_id,
    status,
    resumed_at,
    reminders_enabled,
    experiment_mode,
    observation_profile
  )
  values (
    current_user_id,
    selected_task.id,
    'running',
    now(),
    coalesce(p_reminders_enabled, true),
    coalesce(p_experiment_mode, false),
    selected_task.observation_profile
  )
  returning * into created_session;

  return created_session;
end;
$$;

revoke all on function public.start_study_session(uuid, boolean, boolean)
  from public, anon;
grant execute on function public.start_study_session(uuid, boolean, boolean)
  to authenticated;

notify pgrst, 'reload schema';
