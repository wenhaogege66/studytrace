-- Make terminal sessions authoritative. Late browser lifecycle writes must not
-- resurrect a completed/cancelled session or alter its final audit record.
create or replace function private.keep_terminal_study_session_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('completed', 'cancelled') then
    raise exception 'A completed or cancelled study session cannot be changed'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.keep_terminal_study_session_immutable()
  from public, anon, authenticated;

drop trigger if exists study_sessions_keep_terminal_immutable
  on public.study_sessions;
create trigger study_sessions_keep_terminal_immutable
before update on public.study_sessions
for each row execute function private.keep_terminal_study_session_immutable();

comment on function private.keep_terminal_study_session_immutable() is
  'Rejects every update to a completed or cancelled session, including late browser lifecycle writes.';

-- A task's observation profile is the source for the immutable session
-- snapshot. Do not let the two diverge while that task has an active session.
create or replace function private.protect_task_with_active_session()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  selected_task_id uuid;
  has_active_session boolean;
begin
  if tg_op = 'DELETE' then
    selected_task_id := old.id;
  else
    selected_task_id := new.id;
  end if;

  select exists (
    select 1
    from public.study_sessions
    where task_id = selected_task_id
      and status in ('running', 'paused')
  ) into has_active_session;

  if has_active_session then
    if tg_op = 'DELETE' then
      raise exception 'Finish the active study session before deleting its task'
        using errcode = '23514';
    end if;

    if new.observation_profile is distinct from old.observation_profile then
      raise exception 'End the active study session before changing its observation profile'
        using errcode = '23514';
    end if;

    if new.status in ('completed', 'archived') then
      raise exception 'Finish the active study session before completing or archiving its task'
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.protect_task_with_active_session()
  from public, anon, authenticated;

drop trigger if exists tasks_protect_active_session on public.tasks;
create trigger tasks_protect_active_session
before delete or update of status, observation_profile on public.tasks
for each row execute function private.protect_task_with_active_session();

-- Ending an incomplete work block is distinct from completing the task. The
-- task remains resumable and a later start creates a fresh session. The
-- outcome is derived from stored task steps rather than trusted client input.
create or replace function public.cancel_study_session(
  p_session_id uuid,
  p_accumulated_seconds integer
)
returns public.study_sessions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_session public.study_sessions;
  selected_task public.tasks;
  cancelled_session public.study_sessions;
  calculated_outcome text;
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

  update public.study_sessions
  set
    status = 'cancelled',
    accumulated_seconds = greatest(
      selected_session.accumulated_seconds,
      p_accumulated_seconds
    ),
    ended_at = greatest(clock_timestamp(), selected_session.started_at),
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

revoke all on function public.cancel_study_session(uuid, integer)
  from public, anon;
grant execute on function public.cancel_study_session(uuid, integer)
  to authenticated;

comment on function public.cancel_study_session(uuid, integer) is
  'Cancels one active session, derives its outcome from task steps, and keeps the task resumable in progress.';

notify pgrst, 'reload schema';
