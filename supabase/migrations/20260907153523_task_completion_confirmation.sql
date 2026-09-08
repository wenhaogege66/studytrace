-- Keep "every step is checked" distinct from the user's explicit task
-- completion decision. The browser derives a ready_to_complete presentation
-- state, while these RPCs make the terminal transition and reopening atomic.

-- Repair only the legacy shape produced by the old client: the task still
-- says planned/in progress even though it has a completed session, every step
-- is checked, and no session remains active. A checked task without that
-- terminal evidence intentionally stays ready for user confirmation.
update public.tasks as task
set
  status = 'completed',
  completed_at = coalesce(
    (
      select max(coalesce(session.ended_at, session.updated_at))
      from public.study_sessions as session
      where session.task_id = task.id
        and session.user_id = task.user_id
        and session.status = 'completed'
    ),
    task.updated_at
  )
where task.status in ('planned', 'in_progress')
  and jsonb_array_length(task.steps) > 0
  and not exists (
    select 1
    from jsonb_array_elements(task.steps) as step
    where jsonb_typeof(step) <> 'object'
      or step->'completed' is distinct from 'true'::jsonb
  )
  and exists (
    select 1
    from public.study_sessions as session
    where session.task_id = task.id
      and session.user_id = task.user_id
      and session.status = 'completed'
  )
  and not exists (
    select 1
    from public.study_sessions as session
    where session.task_id = task.id
      and session.user_id = task.user_id
      and session.status in ('running', 'paused')
  );

create or replace function public.confirm_task_completion(
  p_task_id uuid,
  p_accumulated_seconds integer default null
)
returns public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_session public.study_sessions;
  selected_task public.tasks;
  completed_task public.tasks;
  terminal_at timestamptz;
  server_accumulated_seconds integer;
begin
  if current_user_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
  end if;

  if p_task_id is null then
    raise exception 'Task id is required' using errcode = '22023';
  end if;

  if p_accumulated_seconds is not null and p_accumulated_seconds < 0 then
    raise exception 'Accumulated seconds cannot be negative'
      using errcode = '22023';
  end if;

  -- Match the lock order used by finish_study_session so the compatibility
  -- endpoint and the new task-level endpoint cannot deadlock each other.
  select *
  into selected_session
  from public.study_sessions
  where task_id = p_task_id
    and user_id = current_user_id
    and status in ('running', 'paused')
  limit 1
  for update;

  select *
  into selected_task
  from public.tasks
  where id = p_task_id
    and user_id = current_user_id
  for update;

  if not found then
    raise exception 'Task not found' using errcode = 'P0002';
  end if;

  if selected_task.status = 'completed' then
    return selected_task;
  end if;

  if selected_task.status = 'archived' then
    raise exception 'Archived tasks cannot be completed'
      using errcode = 'P0001';
  end if;

  if jsonb_array_length(selected_task.steps) = 0
    or exists (
      select 1
      from jsonb_array_elements(selected_task.steps) as step
      where jsonb_typeof(step) <> 'object'
        or step->'completed' is distinct from 'true'::jsonb
    )
  then
    raise exception 'Complete every task step before confirming the task'
      using errcode = '23514';
  end if;

  terminal_at := clock_timestamp();

  if selected_session.id is not null then
    terminal_at := greatest(terminal_at, selected_session.started_at);
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
        coalesce(p_accumulated_seconds, 0)
      ),
      ended_at = terminal_at,
      resumed_at = null,
      camera_enabled = false,
      task_outcome = 'completed'
    where id = selected_session.id
      and user_id = current_user_id;
  end if;

  update public.tasks
  set status = 'completed', completed_at = terminal_at
  where id = selected_task.id
    and user_id = current_user_id
  returning * into completed_task;

  return completed_task;
end;
$$;

create or replace function public.reopen_completed_task(p_task_id uuid)
returns public.tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_task public.tasks;
  reopened_task public.tasks;
begin
  if current_user_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
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

  if selected_task.status <> 'completed' then
    raise exception 'Only completed tasks can be reopened'
      using errcode = 'P0001';
  end if;

  if jsonb_array_length(selected_task.steps) = 0 then
    raise exception 'A completed task must contain at least one step'
      using errcode = '23514';
  end if;

  update public.tasks
  set
    status = 'in_progress',
    completed_at = null,
    steps = (
      select jsonb_agg(
        case
          when ordinal = jsonb_array_length(selected_task.steps)
            then jsonb_set(step, '{completed}', 'false'::jsonb, false)
          else step
        end
        order by ordinal
      )
      from jsonb_array_elements(selected_task.steps)
        with ordinality as item(step, ordinal)
    )
  where id = selected_task.id
    and user_id = current_user_id
  returning * into reopened_task;

  return reopened_task;
end;
$$;

-- Validate the requested task before returning any existing active session.
-- This prevents a 4/4 task from looking resumable through a direct RPC call.
create or replace function public.start_study_session(
  p_task_id uuid,
  p_reminders_enabled boolean default true,
  p_experiment_mode boolean default false
)
returns public.study_sessions
language plpgsql
security definer
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(current_user_id::text, 0)
  );

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

  if jsonb_array_length(selected_task.steps) > 0
    and not exists (
      select 1
      from jsonb_array_elements(selected_task.steps) as step
      where jsonb_typeof(step) <> 'object'
        or step->'completed' is distinct from 'true'::jsonb
    )
  then
    raise exception 'Task steps are complete; confirm the task instead of starting another study session'
      using errcode = 'P0001';
  end if;

  select *
  into active_session
  from public.study_sessions
  where user_id = current_user_id
    and status in ('running', 'paused')
  limit 1;

  if found then
    return active_session;
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

-- Cancelling ends only this work block. It must never rewrite the parent task
-- status; checked steps remain checked and may yield ready_to_complete.
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

  if selected_session.status not in ('running', 'paused') then
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

  return cancelled_session;
end;
$$;

revoke all on function public.confirm_task_completion(uuid, integer)
  from public, anon;
revoke all on function public.reopen_completed_task(uuid)
  from public, anon;
revoke all on function public.start_study_session(uuid, boolean, boolean)
  from public, anon;
revoke all on function public.cancel_study_session(uuid, integer)
  from public, anon;

grant execute on function public.confirm_task_completion(uuid, integer)
  to authenticated;
grant execute on function public.reopen_completed_task(uuid)
  to authenticated;
grant execute on function public.start_study_session(uuid, boolean, boolean)
  to authenticated;
grant execute on function public.cancel_study_session(uuid, integer)
  to authenticated;

comment on function public.confirm_task_completion(uuid, integer) is
  'Atomically confirms an all-steps-complete task and closes its active session, timer, camera state, and open events.';
comment on function public.reopen_completed_task(uuid) is
  'Reopens a completed task while atomically reopening its last step.';
comment on function public.start_study_session(uuid, boolean, boolean) is
  'Starts or resumes work only when the requested task still has an open step.';
comment on function public.cancel_study_session(uuid, integer) is
  'Ends one work block without rewriting the parent task lifecycle state.';

notify pgrst, 'reload schema';
