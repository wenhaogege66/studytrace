-- A repeated pause is not a new lifecycle generation. This keeps a page
-- cleanup request from advancing state after the navigation guard already
-- paused the same session.

create or replace function public.pause_study_session(
  p_session_id uuid,
  p_expected_state_version bigint,
  p_accumulated_seconds integer
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

  if p_expected_state_version is null or p_expected_state_version < 0
    or p_accumulated_seconds is null or p_accumulated_seconds < 0
  then
    raise exception 'Pause version and elapsed time must be nonnegative'
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

  if selected_session.status <> 'running'
    or selected_session.state_version <> p_expected_state_version
  then
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
      server_accumulated_seconds,
      p_accumulated_seconds
    ),
    resumed_at = null,
    camera_enabled = false
  where id = selected_session.id
    and user_id = current_user_id
  returning * into selected_session;

  return selected_session;
end;
$$;

revoke all on function public.pause_study_session(uuid, bigint, integer)
  from public, anon;
grant execute on function public.pause_study_session(uuid, bigint, integer)
  to authenticated;

notify pgrst, 'reload schema';
