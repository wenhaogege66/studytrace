-- Explicit in-app navigation is an authoritative pause intent. Locking the
-- row and advancing its lifecycle generation also invalidates a resume that
-- was sent just before navigation but has not committed yet.

create or replace function public.pause_study_session_for_navigation(
  p_session_id uuid
)
returns public.study_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_session public.study_sessions;
  server_accumulated_seconds integer;
begin
  if current_user_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
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

  if selected_session.status in ('completed', 'cancelled') then
    return selected_session;
  end if;

  if selected_session.status = 'paused' then
    update public.study_sessions
    set state_version = selected_session.state_version + 1
    where id = selected_session.id
      and user_id = current_user_id
    returning * into selected_session;

    return selected_session;
  end if;

  server_accumulated_seconds := selected_session.accumulated_seconds
    + greatest(
        0,
        floor(
          extract(epoch from (clock_timestamp() - selected_session.resumed_at))
        )::integer
      );

  update public.study_sessions
  set
    status = 'paused',
    accumulated_seconds = greatest(
      selected_session.accumulated_seconds,
      server_accumulated_seconds
    ),
    resumed_at = null,
    camera_enabled = false
  where id = selected_session.id
    and user_id = current_user_id
  returning * into selected_session;

  return selected_session;
end;
$$;

revoke all on function public.pause_study_session_for_navigation(uuid)
  from public, anon;
grant execute on function public.pause_study_session_for_navigation(uuid)
  to authenticated;

notify pgrst, 'reload schema';
