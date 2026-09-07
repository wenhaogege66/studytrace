-- INSERT event/session serialization uses a row lock. Once direct session
-- UPDATE is revoked from authenticated, run this narrowly validated trigger as
-- the owner so the lock remains available without widening table privileges.

create or replace function private.ensure_behavior_event_session_active()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  parent_status text;
  database_now timestamptz := clock_timestamp();
begin
  if current_user_id is null or new.user_id <> current_user_id then
    raise exception 'Behavior event ownership does not match the caller'
      using errcode = '42501';
  end if;

  select status
  into parent_status
  from public.study_sessions
  where id = new.session_id
    and user_id = current_user_id
  for share;

  if not found then
    raise exception 'Linked study session not found' using errcode = 'P0002';
  end if;

  if parent_status not in ('running', 'paused') then
    raise exception 'Behavior events can only be added to an active study session'
      using errcode = 'P0001';
  end if;

  new.started_at := least(new.started_at, database_now);
  if new.ended_at is not null then
    new.ended_at := least(
      greatest(new.ended_at, new.started_at),
      database_now
    );
  end if;

  return new;
end;
$$;

revoke all on function private.ensure_behavior_event_session_active()
  from public, anon, authenticated;

comment on function private.ensure_behavior_event_session_active() is
  'Authenticates event ownership, locks the active parent session against terminal races, and bounds browser timestamps.';

notify pgrst, 'reload schema';
