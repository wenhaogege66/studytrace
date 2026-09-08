-- Browser teardown is best-effort. Make a terminal session the authoritative
-- backstop so a lost network request cannot leave an event open forever.
create or replace function private.close_open_events_with_session()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('completed', 'cancelled') then
    update public.behavior_events
    set ended_at = coalesce(new.ended_at, now())
    where session_id = new.id
      and user_id = new.user_id
      and ended_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists study_sessions_close_open_events
  on public.study_sessions;
create trigger study_sessions_close_open_events
after update of status on public.study_sessions
for each row
when (new.status in ('completed', 'cancelled'))
execute function private.close_open_events_with_session();

comment on function private.close_open_events_with_session() is
  'Closes any still-open structured events when their study session becomes terminal.';

-- Serialize event creation with session completion. If an insert locks first,
-- finish waits and then closes it; if finish locks first, the insert resumes,
-- observes the terminal state, and is rejected.
create or replace function private.ensure_behavior_event_session_active()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_status text;
begin
  select status
  into parent_status
  from public.study_sessions
  where id = new.session_id
    and user_id = new.user_id
  for share;

  if not found then
    raise exception 'Linked study session not found' using errcode = 'P0002';
  end if;

  if parent_status not in ('running', 'paused') then
    raise exception 'Behavior events can only be added to an active study session'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists behavior_events_require_active_session
  on public.behavior_events;
create trigger behavior_events_require_active_session
before insert on public.behavior_events
for each row execute function private.ensure_behavior_event_session_active();

comment on function private.ensure_behavior_event_session_active() is
  'Locks and verifies the parent session so event inserts cannot race session completion.';
