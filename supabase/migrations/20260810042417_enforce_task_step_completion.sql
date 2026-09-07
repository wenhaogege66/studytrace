-- A task is complete only when every configured step is complete. Incomplete
-- work stays in one paused study session and can be resumed without inserting
-- another active session row.

create or replace function private.enforce_task_step_completion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'completed' and (
    jsonb_array_length(new.steps) = 0
    or exists (
      select 1
      from jsonb_array_elements(new.steps) as step
      where jsonb_typeof(step) <> 'object'
        or step->'completed' is distinct from 'true'::jsonb
    )
  ) then
    raise exception 'Complete every task step before marking the task completed'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists tasks_enforce_step_completion on public.tasks;
create trigger tasks_enforce_step_completion
before insert or update of status, steps on public.tasks
for each row execute function private.enforce_task_step_completion();

-- Repair rows produced by the previous UI, which could mark a task completed
-- even when one or more steps were still open.
update public.tasks
set status = 'in_progress', completed_at = null
where status = 'completed'
  and (
    jsonb_array_length(steps) = 0
    or exists (
      select 1
      from jsonb_array_elements(steps) as step
      where jsonb_typeof(step) <> 'object'
        or step->'completed' is distinct from 'true'::jsonb
    )
  );

update public.study_sessions as session
set task_outcome = 'partially_completed'
from public.tasks as task
where task.id = session.task_id
  and task.status = 'in_progress'
  and session.status = 'completed'
  and session.task_outcome is null;

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
  selected_task public.tasks;
  finished_session public.study_sessions;
begin
  if current_user_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
  end if;

  if p_accumulated_seconds < 0 then
    raise exception 'Accumulated seconds cannot be negative'
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

  update public.study_sessions
  set
    status = 'completed',
    accumulated_seconds = p_accumulated_seconds,
    ended_at = now(),
    resumed_at = null,
    camera_enabled = false,
    task_outcome = 'completed'
  where id = selected_session.id
    and user_id = current_user_id
  returning * into finished_session;

  update public.tasks
  set status = 'completed', completed_at = now()
  where id = selected_task.id
    and user_id = current_user_id;

  return finished_session;
end;
$$;

revoke all on function public.finish_study_session(uuid, integer, text)
  from public, anon;
grant execute on function public.finish_study_session(uuid, integer, text)
  to authenticated;

comment on function public.finish_study_session(uuid, integer, text) is
  'Finishes a study session and its task only after every task step is complete. Incomplete work must remain paused.';

notify pgrst, 'reload schema';
