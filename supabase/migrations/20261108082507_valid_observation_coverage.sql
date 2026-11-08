-- Depends on factual-insights foundation/hardening (082421/082436), retained in migration
-- history. Legacy wall-clock runs intentionally receive zero proven coverage.
alter table public.observation_runs add column effective_milliseconds bigint not null default 0
  check(effective_milliseconds>=0);
create table private.observation_coverage_receipts(
  run_id uuid primary key references public.observation_runs(id) on delete cascade,
  sequence bigint not null,
  received_at timestamptz not null
);
alter table private.observation_coverage_receipts enable row level security;
revoke all on private.observation_coverage_receipts from public,anon,authenticated;
create or replace function public.record_observation_coverage(
  p_session_id uuid,p_expected_state_version bigint,p_camera_version bigint,
  p_sequence bigint,p_valid_milliseconds integer
) returns bigint language plpgsql security definer set search_path='' as $$
declare caller uuid:=auth.uid(); run public.observation_runs%rowtype;
  receipt private.observation_coverage_receipts%rowtype; ts timestamptz:=clock_timestamp(); accepted bigint;
begin
  if caller is null or p_sequence is null or p_sequence<1 or p_valid_milliseconds is null
    or p_valid_milliseconds<0 or p_valid_milliseconds>10000 then
    raise exception 'Invalid valid-frame coverage batch' using errcode='22023'; end if;
  if not exists(select 1 from auth.sessions where id=nullif(auth.jwt()->>'session_id','')::uuid and user_id=caller and (not_after is null or not_after>ts)) then
    raise exception 'Live session required' using errcode='42501'; end if;
  perform public.heartbeat_observation_run(p_session_id,p_expected_state_version,p_camera_version);
  select * into run from public.observation_runs where user_id=caller and session_id=p_session_id
    and camera_version=p_camera_version and ended_at is null for update;
  if not found then return 0; end if;
  select * into receipt from private.observation_coverage_receipts where run_id=run.id for update;
  if found and p_sequence<=receipt.sequence then return run.effective_milliseconds; end if;
  accepted:=least(p_valid_milliseconds,greatest(0,floor(extract(epoch from(ts-coalesce(receipt.received_at,run.started_at)))*1000)::bigint));
  update public.observation_runs set effective_milliseconds=least(
    effective_milliseconds+accepted,greatest(0,floor(extract(epoch from(ts-started_at))*1000)::bigint))
    where id=run.id returning effective_milliseconds into accepted;
  insert into private.observation_coverage_receipts(run_id,sequence,received_at) values(run.id,p_sequence,ts)
    on conflict(run_id) do update set sequence=excluded.sequence,received_at=excluded.received_at;
  return accepted;
end; $$;
revoke all on function public.record_observation_coverage(uuid,bigint,bigint,bigint,integer) from public,anon;
grant execute on function public.record_observation_coverage(uuid,bigint,bigint,bigint,integer) to authenticated;
notify pgrst,'reload schema';
