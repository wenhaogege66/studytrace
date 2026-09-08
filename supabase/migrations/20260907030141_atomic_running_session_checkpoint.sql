-- Browser lifecycle writes may arrive out of order. Only advance a running
-- session when the caller still holds the exact timer anchor it observed.
create or replace function public.checkpoint_running_session(
  p_session_id uuid,
  p_expected_resumed_at timestamptz,
  p_accumulated_seconds integer,
  p_checkpointed_at timestamptz
)
returns public.study_sessions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_session public.study_sessions;
begin
  if current_user_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
  end if;

  if p_expected_resumed_at is null or p_checkpointed_at is null then
    raise exception 'Timer checkpoint anchors cannot be null' using errcode = '22023';
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

  if selected_session.status = 'running'
    and selected_session.resumed_at is not distinct from p_expected_resumed_at
    and p_checkpointed_at >= selected_session.resumed_at
    and p_accumulated_seconds >= selected_session.accumulated_seconds
  then
    update public.study_sessions
    set
      accumulated_seconds = p_accumulated_seconds,
      resumed_at = p_checkpointed_at
    where id = selected_session.id
      and user_id = current_user_id
    returning * into selected_session;
  end if;

  return selected_session;
end;
$$;

revoke all on function public.checkpoint_running_session(
  uuid,
  timestamptz,
  integer,
  timestamptz
) from public, anon;
grant execute on function public.checkpoint_running_session(
  uuid,
  timestamptz,
  integer,
  timestamptz
) to authenticated;

comment on function public.checkpoint_running_session(
  uuid,
  timestamptz,
  integer,
  timestamptz
) is
  'Atomically advances a running timer only when its persisted resume anchor still matches the caller snapshot.';

-- Deleting auth.users cascades through tasks. The active-task protection
-- correctly rejects that cascade while a running/paused session still exists,
-- so remove the expired identities' sessions first. Locking the selected user
-- rows also prevents a concurrent new session from appearing mid-cleanup.
create or replace function private.cleanup_expired_anonymous_users()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired_user_ids uuid[];
  deleted_count bigint;
begin
  select coalesce(array_agg(candidate.id), '{}'::uuid[])
  into expired_user_ids
  from (
    select id
    from auth.users
    where is_anonymous is true
      and created_at < clock_timestamp() - interval '30 days'
    for update skip locked
  ) as candidate;

  if cardinality(expired_user_ids) = 0 then
    return 0;
  end if;

  delete from public.study_sessions
  where user_id = any(expired_user_ids);

  delete from auth.users
  where id = any(expired_user_ids)
    and is_anonymous is true;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function private.cleanup_expired_anonymous_users()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
