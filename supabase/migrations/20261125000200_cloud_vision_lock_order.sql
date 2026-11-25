-- Match direct behavior-event inserts: user quota lock before session row lock.
create or replace function public.save_vision_observation(
  p_session_id uuid, p_consent_token uuid, p_request_id uuid, p_observation jsonb
)
returns public.behavior_events language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  session public.study_sessions;
  consent private.vision_grants;
  reservation private.vision_reservations;
  event public.behavior_events;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not private.valid_visual_observation(p_observation) then
    raise exception 'Invalid observation' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public.behavior_events:' || caller::text, 0)
  );
  select * into session from public.study_sessions where id = p_session_id and user_id = caller for update;
  if not found then raise exception 'Session not found' using errcode = 'P0002'; end if;
  select * into consent from private.vision_grants where session_id = session.id;
  select * into reservation from private.vision_reservations where session_id = session.id;
  if session.status <> 'running' or not session.camera_enabled
    or session.observation_profile not in ('study_screen_v1','study_paper_v1')
    or consent.enabled is distinct from true or consent.consent_token is distinct from p_consent_token
    or reservation.request_id is distinct from p_request_id or p_request_id is null
    or reservation.consent_token is distinct from p_consent_token or p_consent_token is null
    or reservation.consumed is distinct from false
    or reservation.state_version <> session.state_version or reservation.camera_version <> session.camera_version
    or consent.state_version <> session.state_version or consent.camera_version <> session.camera_version
    or reservation.reserved_at < clock_timestamp() - interval '20 seconds' then
    raise exception 'Observation result expired' using errcode = 'P0001';
  end if;
  insert into public.behavior_events(user_id,session_id,event_type,source,started_at,ended_at,visual_observation)
  values(caller,session.id,'visual_observation','cloud_vision',reservation.reserved_at,reservation.reserved_at,p_observation)
  returning * into event;
  update private.vision_reservations set consumed = true where session_id = session.id;
  return event;
end;
$$;

notify pgrst, 'reload schema';
