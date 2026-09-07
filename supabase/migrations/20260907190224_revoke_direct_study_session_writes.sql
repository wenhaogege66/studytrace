-- Post-production-smoke cutover.
--
-- Keep this migration unapplied while the accepted Preview is first promoted and
-- smoke-tested. Once the RPC-only lifecycle has been verified in Production,
-- apply it separately so browser clients can no longer mutate session rows around
-- the state-machine functions.

-- Keep the cutover self-contained even when an older environment missed the
-- earlier hardening statement. Every session-writing RPC validates auth.uid()
-- and row ownership before mutating data.
alter function public.checkpoint_running_session(
  uuid,
  timestamptz,
  integer,
  timestamptz
) security definer;

-- Reopening must remain available after terminal lifecycle writes are guarded.
-- The function already locks the task and checks auth.uid() ownership.
alter function public.reopen_completed_task(uuid) security definer;

create or replace function private.guard_direct_task_lifecycle_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- PostgREST table writes run as authenticated. Lifecycle RPCs run as their
  -- owner and are therefore the only browser-accessible path allowed to enter
  -- or leave the completed state.
  if current_user = 'authenticated' then
    if new.completed_at is distinct from old.completed_at
      or new.status = 'completed'
      or old.status = 'completed'
    then
      raise exception 'Use the protected task lifecycle actions'
        using errcode = '23514';
    end if;

    if old.status = 'archived'
      and new.status <> 'planned'
    then
      raise exception 'Archived tasks can only be restored first'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists tasks_guard_direct_lifecycle_write
  on public.tasks;
create trigger tasks_guard_direct_lifecycle_write
before update on public.tasks
for each row
execute function private.guard_direct_task_lifecycle_write();

revoke all on function private.guard_direct_task_lifecycle_write()
  from public, anon, authenticated;

revoke insert, update, delete
on table public.study_sessions
from authenticated;

grant select
on table public.study_sessions
to authenticated;

comment on table public.study_sessions is
  'Study sessions are readable by their owner through RLS and writable only through protected lifecycle RPCs.';

comment on function private.guard_direct_task_lifecycle_write() is
  'Keeps completed task transitions behind ownership-checking lifecycle RPCs after the browser write cutover.';
