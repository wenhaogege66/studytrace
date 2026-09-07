-- Client clocks can be ahead of the database clock. Keep event timestamps
-- internally valid so closing a session can never fail its transaction.
create or replace function private.close_open_events_with_session()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('completed', 'cancelled') then
    update public.behavior_events
    set ended_at = greatest(
      coalesce(new.ended_at, now()),
      public.behavior_events.started_at
    )
    where session_id = new.id
      and user_id = new.user_id
      and ended_at is null;
  end if;
  return new;
end;
$$;

create or replace function private.ensure_behavior_event_session_active()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_status text;
  database_now timestamptz := clock_timestamp();
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

  if new.started_at > database_now then
    new.started_at := database_now;
  end if;
  if new.ended_at is not null and new.ended_at < new.started_at then
    new.ended_at := new.started_at;
  end if;

  return new;
end;
$$;
