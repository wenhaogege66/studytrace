-- Long-lived structured evidence is separate from transient 7-day dispatch
-- windows. No image, prompt, free-form provider response or biometric data.
create table private.cloud_observation_facts(
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.study_sessions(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz not null check(ended_at>=started_at),
  quality text not null check(quality in ('good','unknown')),
  model_id text not null check(char_length(model_id)<=100),
  created_at timestamptz not null default clock_timestamp()
);
create index cloud_observation_facts_owner_time_idx on private.cloud_observation_facts(user_id,started_at desc);
create index cloud_observation_facts_session_idx on private.cloud_observation_facts(session_id);
alter table private.cloud_observation_facts enable row level security;
revoke all on private.cloud_observation_facts from public,anon,authenticated;

create or replace function private.persist_cloud_observation_fact()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status<>'complete' or old.status='complete' or not exists(
    select 1 from public.user_settings where user_id=new.user_id and insights_enabled) then return new; end if;
  perform private.lock_insight_owner(new.user_id);
  if (select count(*) from private.cloud_observation_facts where user_id=new.user_id)>=20000 then
    insert into private.insight_fact_coverage(user_id,truncated,first_truncated_at,last_truncated_at,dropped_counts)
    values(new.user_id,true,clock_timestamp(),clock_timestamp(),'{"cloud_observation_facts":1}')
    on conflict(user_id) do update set truncated=true,
      first_truncated_at=coalesce(private.insight_fact_coverage.first_truncated_at,excluded.first_truncated_at),
      last_truncated_at=excluded.last_truncated_at,
      dropped_counts=private.insight_fact_coverage.dropped_counts||jsonb_build_object('cloud_observation_facts',
        coalesce((private.insight_fact_coverage.dropped_counts->>'cloud_observation_facts')::bigint,0)+1),updated_at=clock_timestamp();
    return new;
  end if;
  insert into private.cloud_observation_facts(id,user_id,session_id,started_at,ended_at,quality,model_id)
  values(new.id,new.user_id,new.session_id,new.started_at,new.ended_at,new.result->>'quality',new.result->>'model')
  on conflict(id) do nothing;
  return new;
end; $$;
revoke all on function private.persist_cloud_observation_fact() from public,anon,authenticated;
create trigger cloud_observation_persist_fact after update of status on private.cloud_observation_windows
for each row execute function private.persist_cloud_observation_fact();

create or replace function private.get_cloud_observation_summary(p_user_id uuid,p_start timestamptz,p_end timestamptz)
returns jsonb language sql stable security definer set search_path='' as $$
  with selected as (
    select f.* from private.cloud_observation_facts f join public.study_sessions s on s.id=f.session_id
    where f.user_id=p_user_id and s.user_id=p_user_id and not s.experiment_mode
      and f.started_at<p_end and f.ended_at>p_start
  ), ranges as (
    select unnest(range_agg(tstzrange(greatest(started_at,p_start),least(ended_at,p_end),'[)'))) as sample_range
    from selected where quality='good'
  )
  select jsonb_build_object(
    'window_count',(select count(*) from selected),
    'unknown_window_count',(select count(*) from selected where quality='unknown'),
    'sampled_seconds',(select coalesce(floor(sum(extract(epoch from(upper(sample_range)-lower(sample_range))))),0)::bigint from ranges),
    'confirmed_event_count',(select count(*) from public.behavior_events e join public.study_sessions s on s.id=e.session_id
      where e.user_id=p_user_id and s.user_id=p_user_id and e.source='cloud_vision' and not s.experiment_mode
        and e.started_at>=p_start and e.started_at<p_end and (e.review_status='confirmed'
          or(e.review_status='corrected' and coalesce(e.corrected_type,'')<>'not_relevant')))
  );
$$;
revoke all on function private.get_cloud_observation_summary(uuid,timestamptz,timestamptz) from public,anon,authenticated;

do $migration$
declare original text; updated text;
begin
  original:=pg_get_functiondef('public.get_my_insights(integer)'::regprocedure);
  updated:=replace(original,$old$'observation', jsonb_build_object($old$,
    $new$'observation', jsonb_build_object('cloud',private.get_cloud_observation_summary(caller_id,period_start,period_end),$new$);
  if updated=original then raise exception 'Cloud summary anchor missing'; end if;
  execute updated;
end; $migration$;

comment on table private.cloud_observation_facts is 'Structured short-window quality and model facts. A six-second image sequence is sampled evidence, never proof of continuous behavior between windows.';
