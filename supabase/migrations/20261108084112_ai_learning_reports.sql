-- AI report content is written only by authenticated server jobs. Browser
-- access is read-own plus the narrowly scoped mark-read operation.
create table public.ai_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  period_days integer not null check (period_days in (7, 30)),
  source text not null check (source in ('manual', 'weekly')),
  cycle_due_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  input_hash text not null check (char_length(input_hash) = 64),
  input_snapshot jsonb not null check (jsonb_typeof(input_snapshot) = 'object' and octet_length(input_snapshot::text) <= 262144),
  content jsonb check (content is null or (jsonb_typeof(content) = 'object' and octet_length(content::text) <= 32768)),
  model_id text,
  token_usage jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  generated_at timestamptz,
  read_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, period_days, input_hash),
  unique (user_id, cycle_due_at)
);

create index ai_reports_user_created_idx on public.ai_reports(user_id, created_at desc);
alter table public.ai_reports enable row level security;
revoke all on public.ai_reports from public, anon, authenticated;
grant select on public.ai_reports to authenticated;
create policy ai_reports_select_own on public.ai_reports for select to authenticated
using ((select auth.uid()) = user_id);

create table private.ai_report_jobs (
  report_id uuid primary key references public.ai_reports(id) on delete cascade,
  lease_token uuid not null default gen_random_uuid(),
  lease_expires_at timestamptz not null default now() + interval '3 minutes',
  attempts integer not null default 1 check (attempts between 1 and 3),
  cycle_due_at timestamptz
);

create table private.ai_report_schedule (
  user_id uuid primary key references auth.users(id) on delete cascade,
  consent_at timestamptz not null,
  next_due_at timestamptz not null,
  last_window_end timestamptz
);

create table private.ai_report_budget (
  scope text not null,
  day date not null,
  user_id uuid references auth.users(id) on delete cascade,
  requests integer not null default 0 check (requests >= 0),
  primary key (scope, day)
);

alter table private.ai_report_jobs enable row level security;
alter table private.ai_report_schedule enable row level security;
alter table private.ai_report_budget enable row level security;
revoke all on private.ai_report_jobs, private.ai_report_schedule, private.ai_report_budget
  from public, anon, authenticated;

create or replace function private.report_consent_granted(p_user_id uuid, p_feature text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_consents c
    where c.user_id = p_user_id and c.feature = p_feature
      and c.granted and c.version = '2026-11-08.v1'
  );
$$;
revoke all on function private.report_consent_granted(uuid, text) from public, anon, authenticated;

create or replace function private.build_learning_report_snapshot(p_user_id uuid, p_days integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  previous_claims text := pg_catalog.current_setting('request.jwt.claims', true);
  previous_sub text := pg_catalog.current_setting('request.jwt.claim.sub', true);
  facts jsonb;
  plans jsonb;
  adjustments jsonb := '[]'::jsonb;
  estimate_summary jsonb;
  obstacle_summary jsonb;
begin
  -- Only service-only report functions reach this helper. Reuse the exact
  -- user-facing aggregation and restore transaction-local identity afterward.
  perform pg_catalog.set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
  facts := public.get_my_insights(p_days);
  perform pg_catalog.set_config('request.jwt.claims', coalesce(previous_claims, ''), true);
  perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);

  select coalesce(jsonb_agg(item), '[]'::jsonb) into plans from (
    select jsonb_build_object(
      'purpose', left(coalesce(r.snapshot->>'purpose', ''), 250),
      'criterion', left(coalesce(r.snapshot->>'selectedCriterion', ''), 250),
      'method', left(coalesce(r.snapshot->>'method', '历史学习未保存采用版本，方法未知'), 400),
      'estimated_minutes', coalesce((r.snapshot->>'estimatedMinutes')::integer, 0),
      'status', s.status,
      'completed_steps', (select count(*) from jsonb_array_elements(coalesce(r.snapshot->'steps','[]'::jsonb)) step where step->>'completed' = 'true'),
      'step_count', jsonb_array_length(coalesce(r.snapshot->'steps','[]'::jsonb))
    ) as item
    from (
      select distinct on(coalesce(session.plan_revision_id,session.task_id)) session.*
      from public.study_sessions session where session.user_id=p_user_id and not session.experiment_mode
        and session.status in ('completed','cancelled')
        and coalesce(session.ended_at,session.updated_at)>=(facts->'period'->>'start_at')::timestamptz
        and coalesce(session.ended_at,session.updated_at)<(facts->'period'->>'end_at')::timestamptz
      order by coalesce(session.plan_revision_id,session.task_id),session.started_at desc,session.id
    ) s left join public.task_plan_revisions r on r.id=s.plan_revision_id and r.user_id=p_user_id and r.task_id=s.task_id
    order by s.started_at desc,s.id limit 10
  ) selected;

  if pg_catalog.to_regclass('public.task_plan_revisions') is not null then
    execute $query$
      select coalesce(jsonb_agg(item), '[]'::jsonb) from (
        select jsonb_build_object(
          'kind', coalesce(to_jsonb(r)->>'kind', to_jsonb(r)->>'source', to_jsonb(r)->>'event_type', 'revision'),
          'changes', coalesce(to_jsonb(r)->'changes', to_jsonb(r)->'diff', '{}'::jsonb)
        ) as item from public.task_plan_revisions r
        where r.user_id = $1 and r.kind='adopted'
          and exists(select 1 from public.study_sessions session where session.user_id=$1 and session.plan_revision_id=r.id
            and not session.experiment_mode and session.status in ('completed','cancelled')
            and coalesce(session.ended_at,session.updated_at)>=$2 and coalesce(session.ended_at,session.updated_at)<$3)
        order by r.created_at desc,r.id limit 5
      ) selected
    $query$ into adjustments using p_user_id,(facts->'period'->>'start_at')::timestamptz,(facts->'period'->>'end_at')::timestamptz;
  end if;

  select jsonb_build_object(
    'completed_plan_count', count(*),
    'estimated_minutes', coalesce(sum(t.estimated_minutes), 0),
    'actual_seconds', coalesce(sum((select coalesce(sum(s.accumulated_seconds),0)
      from public.study_sessions s where s.task_id=t.id and s.user_id=p_user_id
      and not s.experiment_mode and s.status in ('completed','cancelled'))),0)
  ) into estimate_summary from public.tasks t
  where t.user_id=p_user_id and t.status='completed'
    and t.completed_at >= (facts->'period'->>'start_at')::timestamptz
    and t.completed_at < (facts->'period'->>'end_at')::timestamptz;

  select coalesce(jsonb_agg(item), '[]'::jsonb) into obstacle_summary from (
    select jsonb_build_object('reason', left(r.incomplete_reason, 120), 'count', count(*)) item
    from public.reviews r join public.study_sessions s on s.id=r.session_id and s.user_id=p_user_id
    where r.user_id=p_user_id and not s.experiment_mode
      and r.created_at >= (facts->'period'->>'start_at')::timestamptz
      and r.created_at < (facts->'period'->>'end_at')::timestamptz
      and nullif(btrim(r.incomplete_reason), '') is not null
    group by r.incomplete_reason order by count(*) desc limit 5
  ) selected;

  return jsonb_build_object('version',1,'facts',facts,'adopted_plans',plans,
    'adjustments',adjustments,'estimate_summary',estimate_summary,'obstacles',obstacle_summary);
exception when others then
  perform pg_catalog.set_config('request.jwt.claims', coalesce(previous_claims, ''), true);
  perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);
  raise;
end;
$$;
revoke all on function private.build_learning_report_snapshot(uuid, integer) from public, anon, authenticated;

create or replace function public.claim_learning_report(p_user_id uuid, p_days integer, p_source text default 'manual')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  snapshot jsonb;
  fingerprint text;
  existing public.ai_reports;
  job private.ai_report_jobs;
  selected_report_id uuid;
  lease uuid := gen_random_uuid();
  utc_day date := (clock_timestamp() at time zone 'UTC')::date;
  user_count integer;
  global_count integer;
  consent_at timestamptz;
  due_at timestamptz;
  is_anon boolean;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Server job required' using errcode='42501';
  end if;
  if p_days not in (7,30) or p_source not in ('manual','weekly') or (p_source='weekly' and p_days<>7) then
    raise exception 'Invalid report request' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('studytrace:owner-mutation:'||p_user_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('studytrace:report:'||p_user_id::text,0));
  update public.ai_reports r set status='failed',error_code='lease_expired',updated_at=clock_timestamp()
  where r.user_id=p_user_id and r.status='pending' and exists(
    select 1 from private.ai_report_jobs j where j.report_id=r.id and j.lease_expires_at<=clock_timestamp());
  select is_anonymous into is_anon from auth.users where id=p_user_id;
  if not found or not private.report_consent_granted(p_user_id,'ai_reports') then
    raise exception 'AI report consent required' using errcode='42501';
  end if;

  if p_source='weekly' then
    if is_anon or not private.report_consent_granted(p_user_id,'weekly_reports') then
      raise exception 'Weekly report consent required' using errcode='42501';
    end if;
    select c.granted_at into consent_at from public.user_consents c where c.user_id=p_user_id and c.feature='weekly_reports';
    insert into private.ai_report_schedule(user_id,consent_at,next_due_at)
      values(p_user_id,consent_at,consent_at+interval '7 days')
      on conflict(user_id) do update set consent_at=excluded.consent_at,
        next_due_at=case when private.ai_report_schedule.consent_at is distinct from excluded.consent_at
          then excluded.next_due_at else private.ai_report_schedule.next_due_at end;
    select next_due_at into due_at from private.ai_report_schedule where user_id=p_user_id for update;
    if due_at>clock_timestamp() then return jsonb_build_object('state','not_due'); end if;
    if not exists(select 1 from public.study_sessions s where s.user_id=p_user_id and not s.experiment_mode
      and s.status in ('completed','cancelled') and s.updated_at>=due_at-interval '7 days') then
      update private.ai_report_schedule set next_due_at=clock_timestamp()+interval '7 days',last_window_end=clock_timestamp() where user_id=p_user_id;
      return jsonb_build_object('state','no_new_records');
    end if;
  end if;

  if p_source='weekly' then
    select * into existing from public.ai_reports where user_id=p_user_id and cycle_due_at=due_at for update;
  end if;
  if existing.id is not null then
    snapshot:=existing.input_snapshot;
    fingerprint:=existing.input_hash;
  else
    snapshot := private.build_learning_report_snapshot(p_user_id,p_days);
    fingerprint := encode(extensions.digest((snapshot #- '{facts,generated_at}')::text,'sha256'),'hex');
    select * into existing from public.ai_reports where user_id=p_user_id and period_days=p_days and input_hash=fingerprint for update;
  end if;
  if not coalesce((snapshot->'facts'->>'enabled')::boolean,false) then
    raise exception 'Learning report collection is disabled' using errcode='42501';
  end if;
  if existing.id is not null then
    if existing.status='ready' then
      if p_source='weekly' then
        update private.ai_report_schedule set next_due_at=clock_timestamp()+interval '7 days',last_window_end=clock_timestamp() where user_id=p_user_id;
      end if;
      return jsonb_build_object('state','cached','report_id',existing.id);
    end if;
    select * into job from private.ai_report_jobs where report_id=existing.id for update;
    if found and job.lease_expires_at>clock_timestamp() and existing.status='pending' then
      return jsonb_build_object('state','pending','report_id',existing.id);
    end if;
    if job.attempts>=3 then
      if p_source='weekly' then
        update private.ai_report_schedule set next_due_at=clock_timestamp()+interval '7 days' where user_id=p_user_id;
      end if;
      return jsonb_build_object('state','retry_limit','report_id',existing.id);
    end if;
  end if;

  -- Lock the site budget before the user budget everywhere, including cron.
  insert into private.ai_report_budget(scope,day) values('global',utc_day) on conflict do nothing;
  select requests into global_count from private.ai_report_budget where scope='global' and day=utc_day for update;
  if global_count>=200 then return jsonb_build_object('state','quota'); end if;
  if p_source='manual' then
    insert into private.ai_report_budget(scope,day,user_id) values('user:'||p_user_id::text,utc_day,p_user_id) on conflict do nothing;
    select requests into user_count from private.ai_report_budget where scope='user:'||p_user_id::text and day=utc_day for update;
    if user_count>=2 then return jsonb_build_object('state','quota'); end if;
    update private.ai_report_budget set requests=requests+1 where scope='user:'||p_user_id::text and day=utc_day;
  end if;
  update private.ai_report_budget set requests=requests+1 where scope='global' and day=utc_day;

  if existing.id is null then
    insert into public.ai_reports(user_id,period_days,source,cycle_due_at,input_hash,input_snapshot)
      values(p_user_id,p_days,p_source,due_at,fingerprint,snapshot) returning id into selected_report_id;
    insert into private.ai_report_jobs(report_id,lease_token,cycle_due_at) values(selected_report_id,lease,due_at);
  else
    selected_report_id:=existing.id;
    update public.ai_reports set status='pending',error_code=null,input_snapshot=snapshot,cycle_due_at=coalesce(cycle_due_at,due_at),updated_at=clock_timestamp() where id=selected_report_id;
    insert into private.ai_report_jobs(report_id,lease_token,cycle_due_at) values(selected_report_id,lease,due_at)
      on conflict(report_id) do update set lease_token=excluded.lease_token,lease_expires_at=clock_timestamp()+interval '3 minutes',
        attempts=private.ai_report_jobs.attempts+1,cycle_due_at=excluded.cycle_due_at;
  end if;
  delete from private.ai_report_budget where day<utc_day-31;
  delete from public.ai_reports where id in (
    select id from public.ai_reports where user_id=p_user_id and status<>'pending'
    order by created_at desc offset 60
  );
  return jsonb_build_object('state','claimed','report_id',selected_report_id,'lease_token',lease,'snapshot',snapshot);
end;
$$;
revoke all on function public.claim_learning_report(uuid,integer,text) from public,anon,authenticated;
grant execute on function public.claim_learning_report(uuid,integer,text) to service_role;

create or replace function public.finish_learning_report(p_report_id uuid,p_lease_token uuid,p_content jsonb,p_model_id text,p_token_usage jsonb,p_error_code text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  owner_id uuid;
  target public.ai_reports;
  lease private.ai_report_jobs;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Server job required' using errcode='42501'; end if;
  select user_id into owner_id from public.ai_reports where id=p_report_id;
  if owner_id is null then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('studytrace:owner-mutation:'||owner_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('studytrace:report:'||owner_id::text,0));
  select * into target from public.ai_reports where id=p_report_id for update;
  select * into lease from private.ai_report_jobs where report_id=p_report_id for update;
  if not found or target.status<>'pending' or lease.lease_token<>p_lease_token or lease.lease_expires_at<=clock_timestamp() then return false; end if;
  if not private.report_consent_granted(owner_id,'ai_reports') or (lease.cycle_due_at is not null and not private.report_consent_granted(owner_id,'weekly_reports')) then
    delete from public.ai_reports where id=p_report_id;
    return false;
  end if;
  if p_error_code is not null then
    update public.ai_reports set status='failed',error_code=left(p_error_code,60),updated_at=clock_timestamp() where id=p_report_id;
  else
    if p_content is null or jsonb_typeof(p_content)<>'object' or octet_length(p_content::text)>32768
      or nullif(btrim(p_model_id),'') is null or char_length(p_model_id)>120 then
      raise exception 'Invalid report content' using errcode='22023';
    end if;
    update public.ai_reports set status='ready',content=p_content,model_id=p_model_id,
      token_usage=p_token_usage,generated_at=clock_timestamp(),updated_at=clock_timestamp(),error_code=null where id=p_report_id;
    if lease.cycle_due_at is not null then
      update private.ai_report_schedule set next_due_at=clock_timestamp()+interval '7 days',last_window_end=clock_timestamp() where user_id=owner_id;
    end if;
  end if;
  return true;
end;
$$;
revoke all on function public.finish_learning_report(uuid,uuid,jsonb,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.finish_learning_report(uuid,uuid,jsonb,text,jsonb,text) to service_role;

create or replace function public.list_due_learning_report_users(p_limit integer default 5,p_exclude uuid[] default '{}'::uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Server job required' using errcode='42501'; end if;
  if p_limit<1 or p_limit>10 or coalesce(array_length(p_exclude,1),0)>200 then raise exception 'Invalid batch size' using errcode='22023'; end if;
  select coalesce(jsonb_agg(user_id),'[]'::jsonb) into result from (
    select c.user_id from public.user_consents c join auth.users u on u.id=c.user_id
    left join private.ai_report_schedule s on s.user_id=c.user_id
    where c.feature='weekly_reports' and c.granted and c.version='2026-11-08.v1' and not u.is_anonymous
      and not(c.user_id=any(p_exclude))
      and private.report_consent_granted(c.user_id,'ai_reports')
      and (case when s.consent_at=c.granted_at then s.next_due_at else c.granted_at+interval '7 days' end)<=clock_timestamp()
    order by coalesce(s.next_due_at,c.granted_at+interval '7 days'),c.user_id limit p_limit
  ) selected;
  return result;
end;
$$;
revoke all on function public.list_due_learning_report_users(integer,uuid[]) from public,anon,authenticated;
grant execute on function public.list_due_learning_report_users(integer,uuid[]) to service_role;

create or replace function public.mark_my_ai_report_read(p_report_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  update public.ai_reports set read_at=clock_timestamp() where id=p_report_id and user_id=auth.uid() and status='ready';
end;
$$;
revoke all on function public.mark_my_ai_report_read(uuid) from public,anon,authenticated;
grant execute on function public.mark_my_ai_report_read(uuid) to authenticated;

create or replace function public.get_my_ai_report_schedule()
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select jsonb_build_object('enabled',c.granted and c.version='2026-11-08.v1',
    'next_due_at',case when s.consent_at=c.granted_at then s.next_due_at else c.granted_at+interval '7 days' end)
  into result from public.user_consents c left join private.ai_report_schedule s on s.user_id=c.user_id
  where c.user_id=auth.uid() and c.feature='weekly_reports';
  return coalesce(result,jsonb_build_object('enabled',false,'next_due_at',null));
end;
$$;
revoke all on function public.get_my_ai_report_schedule() from public,anon,authenticated;
grant execute on function public.get_my_ai_report_schedule() to authenticated;

create or replace function private.clear_learning_reports_on_data_reset()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  delete from public.ai_reports where user_id=old.user_id;
  delete from private.ai_report_schedule where user_id=old.user_id;
  delete from public.user_consents where user_id=old.user_id;
  return old;
end;
$$;
revoke all on function private.clear_learning_reports_on_data_reset() from public,anon,authenticated;
create trigger user_settings_clear_learning_reports after delete on public.user_settings
for each row execute function private.clear_learning_reports_on_data_reset();

comment on table public.ai_reports is 'Owner-readable structured AI reports. No raw camera frames, images, audio, landmarks, or biometric features.';
comment on function public.claim_learning_report(uuid,integer,text) is 'Server-only atomic consent, quota, cache and lease check. Never callable by anon or authenticated clients.';

-- Explicit user export is separate from the aggregate analytics API. The
-- allowlist and owner predicate apply even to private fact tables.
create or replace function public.export_my_learning_records(p_table text,p_expected_user_id uuid,p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; sort_key text;
begin
  if auth.uid() is null or auth.uid()<>p_expected_user_id or not exists(select 1 from auth.users where id=auth.uid()) then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if p_table not in ('tasks','study_sessions','behavior_events','reminder_events','reviews',
    'user_settings','session_segments','observation_runs','task_lifecycle_events','task_step_events',
    'task_plan_revisions','user_consents','ai_reports') or p_offset<0 or p_offset>10000 or p_offset%500<>0 then
    raise exception 'Invalid export page' using errcode='22023';
  end if;
  sort_key:=case when p_table='user_settings' then 'user_id' when p_table='user_consents' then 'feature' else 'id' end;
  execute format('select coalesce(jsonb_agg(to_jsonb(selected)),''[]''::jsonb) from
    (select * from public.%I where user_id=$1 order by %I limit 500 offset $2) selected',p_table,sort_key)
    into result using auth.uid(),p_offset;
  return result;
end;
$$;
revoke all on function public.export_my_learning_records(text,uuid,integer) from public,anon,authenticated;
grant execute on function public.export_my_learning_records(text,uuid,integer) to authenticated;
