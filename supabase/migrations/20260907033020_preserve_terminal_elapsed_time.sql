-- A terminal transition must never lose time already accepted by a
-- checkpoint/pause or the final running interval measured by the database.

create or replace function public.finish_study_session(
  p_session_id uuid,
  p_accumulated_seconds integer,
  p_task_outcome text
)
returns public.study_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_session public.study_sessions;
  selected_task public.tasks;
  finished_session public.study_sessions;
  terminal_at timestamptz;
  server_accumulated_seconds integer;
begin
  if current_user_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
  end if;

  if p_accumulated_seconds is null or p_accumulated_seconds < 0 then
    raise exception 'Accumulated seconds cannot be negative or null'
      using errcode = '22023';
  end if;

  if p_task_outcome is distinct from 'completed' then
    raise exception 'Pause incomplete tasks instead of finishing the study session'
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

  if selected_session.status = 'completed' then
    return selected_session;
  end if;

  if selected_session.status <> 'running'
    and selected_session.status <> 'paused'
  then
    raise exception 'Study session has already ended' using errcode = 'P0001';
  end if;

  select *
  into selected_task
  from public.tasks
  where id = selected_session.task_id
    and user_id = current_user_id
  for update;

  if not found then
    raise exception 'Linked task not found' using errcode = 'P0002';
  end if;

  if jsonb_array_length(selected_task.steps) = 0
    or exists (
      select 1
      from jsonb_array_elements(selected_task.steps) as step
      where jsonb_typeof(step) <> 'object'
        or step->'completed' is distinct from 'true'::jsonb
    )
  then
    raise exception 'Complete every task step before finishing and reviewing'
      using errcode = '23514';
  end if;

  terminal_at := greatest(clock_timestamp(), selected_session.started_at);
  server_accumulated_seconds := selected_session.accumulated_seconds;
  if selected_session.status = 'running'
    and selected_session.resumed_at is not null
  then
    server_accumulated_seconds := selected_session.accumulated_seconds
      + greatest(
          0,
          floor(
            extract(epoch from (terminal_at - selected_session.resumed_at))
          )::integer
        );
  end if;

  update public.study_sessions
  set
    status = 'completed',
    accumulated_seconds = greatest(
      selected_session.accumulated_seconds,
      server_accumulated_seconds,
      p_accumulated_seconds
    ),
    ended_at = terminal_at,
    resumed_at = null,
    camera_enabled = false,
    task_outcome = 'completed'
  where id = selected_session.id
    and user_id = current_user_id
  returning * into finished_session;

  update public.tasks
  set status = 'completed', completed_at = terminal_at
  where id = selected_task.id
    and user_id = current_user_id;

  return finished_session;
end;
$$;

create or replace function public.cancel_study_session(
  p_session_id uuid,
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
  selected_task public.tasks;
  cancelled_session public.study_sessions;
  calculated_outcome text;
  terminal_at timestamptz;
  server_accumulated_seconds integer;
begin
  if current_user_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
  end if;

  if p_accumulated_seconds is null or p_accumulated_seconds < 0 then
    raise exception 'Accumulated seconds cannot be negative or null'
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

  if selected_session.status = 'cancelled' then
    return selected_session;
  end if;

  if selected_session.status <> 'running'
    and selected_session.status <> 'paused'
  then
    raise exception 'Study session has already ended' using errcode = 'P0001';
  end if;

  select *
  into selected_task
  from public.tasks
  where id = selected_session.task_id
    and user_id = current_user_id
  for update;

  if not found then
    raise exception 'Linked task not found' using errcode = 'P0002';
  end if;

  calculated_outcome := case
    when exists (
      select 1
      from jsonb_array_elements(selected_task.steps) as step
      where step->'completed' = 'true'::jsonb
    ) then 'partially_completed'
    else 'not_completed'
  end;

  terminal_at := greatest(clock_timestamp(), selected_session.started_at);
  server_accumulated_seconds := selected_session.accumulated_seconds;
  if selected_session.status = 'running'
    and selected_session.resumed_at is not null
  then
    server_accumulated_seconds := selected_session.accumulated_seconds
      + greatest(
          0,
          floor(
            extract(epoch from (terminal_at - selected_session.resumed_at))
          )::integer
        );
  end if;

  update public.study_sessions
  set
    status = 'cancelled',
    accumulated_seconds = greatest(
      selected_session.accumulated_seconds,
      server_accumulated_seconds,
      p_accumulated_seconds
    ),
    ended_at = terminal_at,
    resumed_at = null,
    camera_enabled = false,
    task_outcome = calculated_outcome
  where id = selected_session.id
    and user_id = current_user_id
  returning * into cancelled_session;

  update public.tasks
  set status = 'in_progress', completed_at = null
  where id = selected_task.id
    and user_id = current_user_id;

  if not found then
    raise exception 'Linked task not found' using errcode = 'P0002';
  end if;

  return cancelled_session;
end;
$$;

revoke all on function public.finish_study_session(uuid, integer, text)
  from public, anon;
revoke all on function public.cancel_study_session(uuid, integer)
  from public, anon;
grant execute on function public.finish_study_session(uuid, integer, text)
  to authenticated;
grant execute on function public.cancel_study_session(uuid, integer)
  to authenticated;

comment on function public.finish_study_session(uuid, integer, text) is
  'Atomically completes a fully checked task without allowing stale client time to reduce accepted elapsed time.';
comment on function public.cancel_study_session(uuid, integer) is
  'Ends one incomplete work block while preserving accepted and server-observed elapsed time.';

notify pgrst, 'reload schema';
