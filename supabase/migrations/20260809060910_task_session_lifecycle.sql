-- A task can span many study sessions. Finishing one session records its
-- outcome, while only an explicit `completed` outcome closes the parent task.

alter table public.study_sessions
  add column task_outcome text
  check (
    task_outcome is null
    or task_outcome in ('completed', 'partially_completed', 'not_completed')
  );

-- Preserve the meaning of sessions created before this column existed.
update public.study_sessions as session
set task_outcome = review.completion_status
from public.reviews as review
where review.session_id = session.id
  and session.status = 'completed';

update public.study_sessions as session
set task_outcome = case
  when task.status = 'completed' then 'completed'
  else 'partially_completed'
end
from public.tasks as task
where task.id = session.task_id
  and session.status = 'completed'
  and session.task_outcome is null;

comment on column public.study_sessions.task_outcome is
  'User-recorded result for this session. Reviews are optional and do not control task state.';

drop policy study_sessions_insert_own on public.study_sessions;

create policy study_sessions_insert_own on public.study_sessions
for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.tasks
    where tasks.id = task_id
      and tasks.user_id = (select auth.uid())
      and tasks.status in ('planned', 'in_progress')
  )
);

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
    experiment_mode
  )
  values (
    current_user_id,
    selected_task.id,
    'running',
    now(),
    coalesce(p_reminders_enabled, true),
    coalesce(p_experiment_mode, false)
  )
  returning * into created_session;

  return created_session;
end;
$$;

create or replace function public.finish_study_session(
  p_session_id uuid,
  p_accumulated_seconds integer,
  p_task_outcome text
)
returns public.study_sessions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_session public.study_sessions;
  finished_session public.study_sessions;
begin
  if current_user_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
  end if;

  if p_accumulated_seconds < 0 then
    raise exception 'Accumulated seconds cannot be negative'
      using errcode = '22023';
  end if;

  if p_task_outcome not in ('completed', 'partially_completed', 'not_completed') then
    raise exception 'Invalid task outcome' using errcode = '22023';
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

  update public.study_sessions
  set
    status = 'completed',
    accumulated_seconds = p_accumulated_seconds,
    ended_at = now(),
    resumed_at = null,
    camera_enabled = false,
    task_outcome = p_task_outcome
  where id = selected_session.id
    and user_id = current_user_id
  returning * into finished_session;

  update public.tasks
  set
    status = case
      when p_task_outcome = 'completed' then 'completed'
      else 'in_progress'
    end,
    completed_at = case
      when p_task_outcome = 'completed' then now()
      else null
    end
  where id = selected_session.task_id
    and user_id = current_user_id;

  if not found then
    raise exception 'Linked task not found' using errcode = 'P0002';
  end if;

  return finished_session;
end;
$$;

revoke all on function public.start_study_session(uuid, boolean, boolean)
  from public, anon;
revoke all on function public.finish_study_session(uuid, integer, text)
  from public, anon;

grant execute on function public.start_study_session(uuid, boolean, boolean)
  to authenticated;
grant execute on function public.finish_study_session(uuid, integer, text)
  to authenticated;

notify pgrst, 'reload schema';
