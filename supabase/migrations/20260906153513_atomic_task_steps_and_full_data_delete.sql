-- Make individual step completion atomic. A full task-row update from the
-- browser can lose a second rapid checkbox change when both requests start
-- from the same cached task snapshot.

create or replace function public.set_task_step_completed(
  p_task_id uuid,
  p_step_id text,
  p_completed boolean
)
returns public.tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_task public.tasks;
  updated_task public.tasks;
  matching_steps integer;
begin
  if current_user_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
  end if;

  if p_step_id is null or btrim(p_step_id) = '' then
    raise exception 'Task step id is required' using errcode = '22023';
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

  if selected_task.status in ('completed', 'archived') then
    raise exception 'Completed or archived task steps cannot be changed'
      using errcode = 'P0001';
  end if;

  select count(*)
  into matching_steps
  from jsonb_array_elements(selected_task.steps) as step
  where step->>'id' = p_step_id;

  if matching_steps <> 1 then
    raise exception 'Task step not found or duplicated' using errcode = 'P0002';
  end if;

  update public.tasks
  set steps = (
    select jsonb_agg(
      case
        when step->>'id' = p_step_id
          then jsonb_set(step, '{completed}', to_jsonb(p_completed), false)
        else step
      end
      order by ordinal
    )
    from jsonb_array_elements(selected_task.steps)
      with ordinality as item(step, ordinal)
  )
  where id = selected_task.id
    and user_id = current_user_id
  returning * into updated_task;

  return updated_task;
end;
$$;

revoke all on function public.set_task_step_completed(uuid, text, boolean)
  from public, anon;
grant execute on function public.set_task_step_completed(uuid, text, boolean)
  to authenticated;

comment on function public.set_task_step_completed(uuid, text, boolean) is
  'Atomically changes one user-owned task step while preserving concurrent step updates.';

-- AI request counters contain a user id and timestamp, so “clear all my data”
-- must remove them too. SECURITY DEFINER is required because authenticated
-- clients intentionally have no direct access to the private schema.
create or replace function public.delete_my_data()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
begin
  if caller_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  delete from public.reminder_events where user_id = caller_id;
  delete from public.behavior_events where user_id = caller_id;
  delete from public.reviews where user_id = caller_id;
  delete from public.study_sessions where user_id = caller_id;
  delete from public.tasks where user_id = caller_id;
  delete from public.user_settings where user_id = caller_id;
  delete from private.ai_generation_quota where user_id = caller_id;
end;
$$;

revoke all on function public.delete_my_data() from public, anon;
grant execute on function public.delete_my_data() to authenticated;

comment on function public.delete_my_data() is
  'Deletes every business row and transient AI quota row owned by auth.uid().';

notify pgrst, 'reload schema';
