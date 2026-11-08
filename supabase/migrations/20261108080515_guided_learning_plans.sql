-- Adopted plans are versioned independently from step-completion progress.
create or replace function private.valid_observation_agreement(value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(value) = 'object'
    and value ?& array['phone','tablet','absenceSeconds','screenDirection']
    and (select count(*) = 4 from jsonb_object_keys(value))
    and value->>'phone' in ('allowed','restricted','ignored')
    and value->>'tablet' in ('allowed','restricted','ignored')
    and jsonb_typeof(value->'screenDirection') = 'boolean'
    and (value->'absenceSeconds' = 'null'::jsonb or
      (jsonb_typeof(value->'absenceSeconds') = 'number' and
       (value->>'absenceSeconds')::numeric between 30 and 600 and
       (value->>'absenceSeconds')::numeric = trunc((value->>'absenceSeconds')::numeric))), false)
$$;

alter table public.tasks
  add column intent_text text not null default '' check (length(intent_text) <= 500),
  add column planning_context jsonb not null default '{}' check (jsonb_typeof(planning_context) = 'object' and octet_length(planning_context::text) <= 8192),
  add column learning_purpose text not null default '' check (length(learning_purpose) <= 300),
  add column completion_criterion text not null default '' check (length(completion_criterion) <= 300),
  add column method_summary text not null default '' check (length(method_summary) <= 500),
  add column suggested_session_minutes integer not null default 25 check (suggested_session_minutes between 1 and 180),
  add column due_at timestamptz,
  add column current_plan_revision_id uuid,
  add column observation_agreement jsonb not null default '{"phone":"ignored","tablet":"ignored","absenceSeconds":60,"screenDirection":false}'
    check (private.valid_observation_agreement(observation_agreement));

update public.tasks set observation_agreement = '{"phone":"ignored","tablet":"ignored","absenceSeconds":null,"screenDirection":false}'
where observation_profile = 'off_device_v1';

create table public.task_plan_revisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  ordinal integer not null check (ordinal > 0),
  kind text not null check (kind in ('ai_initial','user_edit','ai_review','adopted','manual')),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object' and octet_length(snapshot::text) <= 32768),
  changes jsonb not null default '[]' check (jsonb_typeof(changes) = 'array' and octet_length(changes::text) <= 32768),
  comment text not null default '' check (length(comment) <= 1000),
  request_id uuid,
  request_hash text,
  created_at timestamptz not null default now(),
  unique(task_id, ordinal),
  unique(user_id, request_id),
  unique(id, task_id, user_id),
  check ((request_id is null and request_hash is null) or (kind = 'adopted' and request_id is not null and request_hash is not null))
);
create index task_plan_revisions_owner_task on public.task_plan_revisions(user_id, task_id, ordinal desc);
alter table public.task_plan_revisions enable row level security;
create policy owner_read on public.task_plan_revisions for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.task_plan_revisions from anon, authenticated;
grant select on public.task_plan_revisions to authenticated;
alter table public.tasks add constraint tasks_adopted_revision_owner_fk
  foreign key (current_plan_revision_id, id, user_id)
  references public.task_plan_revisions(id, task_id, user_id) deferrable initially deferred;

alter table public.study_sessions
  add column plan_revision_id uuid,
  add column target_minutes integer not null default 25 check (target_minutes between 1 and 180),
  add column energy_before text check (energy_before in ('low','steady','high')),
  add column observation_agreement jsonb not null default '{"phone":"ignored","tablet":"ignored","absenceSeconds":60,"screenDirection":false}'
    check (private.valid_observation_agreement(observation_agreement)),
  add constraint sessions_plan_revision_owner_fk foreign key (plan_revision_id, task_id, user_id)
    references public.task_plan_revisions(id, task_id, user_id) deferrable initially deferred;

update public.study_sessions s set observation_agreement = t.observation_agreement,
  target_minutes = least(180, t.estimated_minutes)
from public.tasks t where t.id = s.task_id and t.user_id = s.user_id;

create or replace function private.snapshot_learning_plan()
returns trigger language plpgsql security definer set search_path = '' as $$
declare plan public.tasks;
begin
  select * into plan from public.tasks where id = new.task_id and user_id = new.user_id;
  if not found then raise exception 'Plan not found' using errcode = '42501'; end if;
  new.plan_revision_id := plan.current_plan_revision_id;
  new.observation_agreement := plan.observation_agreement;
  new.target_minutes := plan.suggested_session_minutes;
  return new;
end $$;
create trigger study_sessions_snapshot_learning_plan before insert on public.study_sessions
  for each row execute function private.snapshot_learning_plan();

create or replace function private.guard_learning_plan_snapshot()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.plan_revision_id is distinct from old.plan_revision_id or
    new.observation_agreement is distinct from old.observation_agreement then
    raise exception 'Learning plan snapshot is immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger study_sessions_guard_plan_snapshot before update on public.study_sessions
  for each row execute function private.guard_learning_plan_snapshot();

create or replace function private.guard_versioned_plan_write()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' and (
    new.current_plan_revision_id is distinct from old.current_plan_revision_id or
    new.intent_text is distinct from old.intent_text or new.planning_context is distinct from old.planning_context or
    new.learning_purpose is distinct from old.learning_purpose or new.completion_criterion is distinct from old.completion_criterion or
    new.method_summary is distinct from old.method_summary or new.due_at is distinct from old.due_at or
    new.suggested_session_minutes is distinct from old.suggested_session_minutes or
    new.observation_agreement is distinct from old.observation_agreement or
    (old.current_plan_revision_id is not null and (
      new.title is distinct from old.title or new.priority is distinct from old.priority or
      new.estimated_minutes is distinct from old.estimated_minutes or new.observation_profile is distinct from old.observation_profile or
      (select jsonb_agg(jsonb_build_object('id',x->>'id','title',x->>'title')) from jsonb_array_elements(new.steps) x)
      is distinct from (select jsonb_agg(jsonb_build_object('id',x->>'id','title',x->>'title')) from jsonb_array_elements(old.steps) x)
    ))) then
    raise exception 'Use save_learning_plan to revise a plan' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger tasks_guard_versioned_plan before update on public.tasks
  for each row execute function private.guard_versioned_plan_write();

create or replace function public.save_learning_plan(
  p_request_id uuid, p_task_id uuid, p_expected_revision_id uuid, p_plan jsonb, p_revisions jsonb
) returns public.tasks language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid(); existing public.tasks; result public.tasks;
  prior public.task_plan_revisions; revision_id uuid; item jsonb; n integer;
  payload_hash text := encode(extensions.digest(coalesce(p_plan::text,'') || coalesce(p_revisions::text,'') || coalesce(p_task_id::text,''), 'sha256'),'hex');
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_request_id is null or p_plan is null or jsonb_typeof(p_plan) <> 'object' or octet_length(p_plan::text) > 32768 then
    raise exception 'Invalid learning plan' using errcode = '22023'; end if;
  perform private.lock_owner_mutation_resources(array[caller]);
  select * into prior from public.task_plan_revisions where user_id = caller and request_id = p_request_id;
  if found then
    if prior.request_hash <> payload_hash then raise exception 'Idempotency key conflict' using errcode = '23505'; end if;
    select * into result from public.tasks where id = prior.task_id and user_id = caller;
    return result;
  end if;
  if not private.valid_task_steps(p_plan->'steps') or
    length(coalesce(p_plan->>'title','')) not between 1 and 120 or
    length(coalesce(p_plan->>'intent','')) not between 1 and 500 or
    length(coalesce(p_plan->>'method','')) not between 1 and 500 or
    length(coalesce(p_plan->>'purpose','')) > 300 or
    length(coalesce(p_plan->>'selectedCriterion','')) not between 1 and 300 or
    (p_plan->>'priority') not in ('low','medium','high') or
    (p_plan->>'observationProfile') not in ('study_screen_v1','study_paper_v1','off_device_v1') or
    not private.valid_observation_agreement(p_plan->'observationAgreement') or
    jsonb_typeof(p_plan->'context') is distinct from 'object' or
    coalesce((p_plan->>'estimatedMinutes')::integer,0) not between 1 and 480 or
    coalesce((p_plan->>'sessionMinutes')::integer,0) not between 1 and 180 then
    raise exception 'Invalid learning plan fields' using errcode = '22023';
  end if;
  if jsonb_typeof(p_revisions) is distinct from 'array' or jsonb_array_length(p_revisions) > 4 then
    raise exception 'Invalid revision chain' using errcode = '22023'; end if;
  if (select count(*) from jsonb_array_elements(p_revisions) r where r->>'kind' = 'ai_review') > 1 then
    raise exception 'Only one AI review is permitted per revision' using errcode = '22023'; end if;
  if (select count(*) from public.task_plan_revisions where user_id = caller) + jsonb_array_length(p_revisions) + 1 > 2000 then
    raise exception 'Plan revision capacity reached' using errcode = '54000'; end if;
  if p_task_id is not null then
    select * into existing from public.tasks where id = p_task_id and user_id = caller for update;
    if not found then raise exception 'Plan not found' using errcode = '42501'; end if;
    if existing.current_plan_revision_id is distinct from p_expected_revision_id then
      raise exception 'Plan changed; reload before editing' using errcode = '40001'; end if;
    if existing.status in ('completed','archived') then raise exception 'Reopen the plan before revising' using errcode = '23514'; end if;
    if exists (select 1 from public.study_sessions where task_id = existing.id and user_id = caller and status in ('running','paused')) then
      raise exception 'End the active learning session before revising the plan' using errcode = '23514'; end if;
    for item in select value from jsonb_array_elements(existing.steps) where value->>'completed' = 'true' loop
      if not exists(select 1 from jsonb_array_elements(p_plan->'steps') s where s = item) then
        raise exception 'Completed steps must be preserved' using errcode = '23514'; end if;
    end loop;
    update public.tasks set title = p_plan->>'title', steps = p_plan->'steps', priority = p_plan->>'priority',
      estimated_minutes = (p_plan->>'estimatedMinutes')::integer, observation_profile = p_plan->>'observationProfile',
      intent_text = p_plan->>'intent', planning_context = p_plan->'context', learning_purpose = coalesce(p_plan->>'purpose',''),
      completion_criterion = p_plan->>'selectedCriterion', method_summary = p_plan->>'method',
      suggested_session_minutes = (p_plan->>'sessionMinutes')::integer, due_at = (p_plan->>'dueAt')::timestamptz,
      observation_agreement = p_plan->'observationAgreement'
    where id = existing.id returning * into result;
  else
    insert into public.tasks(user_id,title,steps,priority,estimated_minutes,observation_profile,intent_text,planning_context,
      learning_purpose,completion_criterion,method_summary,suggested_session_minutes,due_at,observation_agreement)
    values(caller,p_plan->>'title',p_plan->'steps',p_plan->>'priority',(p_plan->>'estimatedMinutes')::integer,
      p_plan->>'observationProfile',p_plan->>'intent',p_plan->'context',coalesce(p_plan->>'purpose',''),
      p_plan->>'selectedCriterion',p_plan->>'method',(p_plan->>'sessionMinutes')::integer,
      (p_plan->>'dueAt')::timestamptz,p_plan->'observationAgreement') returning * into result;
  end if;
  select coalesce(max(ordinal),0) into n from public.task_plan_revisions where task_id = result.id;
  for item in select value from jsonb_array_elements(p_revisions) loop
    if item->>'kind' not in ('ai_initial','user_edit','ai_review','manual') or
      jsonb_typeof(item->'snapshot') is distinct from 'object' then
      raise exception 'Invalid revision entry' using errcode = '22023'; end if;
    n := n+1;
    insert into public.task_plan_revisions(user_id,task_id,ordinal,kind,snapshot,changes,comment)
    values(caller,result.id,n,item->>'kind',item->'snapshot',coalesce(item->'changes','[]'),coalesce(item->>'comment',''));
  end loop;
  insert into public.task_plan_revisions(user_id,task_id,ordinal,kind,snapshot,changes,request_id,request_hash)
    values(caller,result.id,n+1,'adopted',p_plan,
      case when existing.current_plan_revision_id is null then '[]'::jsonb else
        jsonb_build_array(jsonb_build_object('field','adopted_plan','before',
          (select snapshot from public.task_plan_revisions where id = existing.current_plan_revision_id),'after',p_plan)) end,
      p_request_id,payload_hash) returning id into revision_id;
  update public.tasks set current_plan_revision_id = revision_id where id = result.id returning * into result;
  return result;
end $$;

create or replace function public.update_session_learning_context(p_session_id uuid,p_target_minutes integer,p_energy_before text)
returns public.study_sessions language plpgsql security definer set search_path = '' as $$
declare result public.study_sessions;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_target_minutes is null or p_target_minutes not between 1 and 180 or
    (p_energy_before is not null and p_energy_before not in ('low','steady','high')) then
    raise exception 'Invalid learning context' using errcode = '22023'; end if;
  perform private.lock_owner_mutation_resources(array[auth.uid()]);
  select * into result from public.study_sessions where id = p_session_id and user_id = auth.uid() for update;
  if not found then raise exception 'Session not found' using errcode = '42501'; end if;
  if result.status not in ('running','paused') then raise exception 'Session has ended' using errcode = '23514'; end if;
  update public.study_sessions set target_minutes = p_target_minutes, energy_before = p_energy_before where id = result.id returning * into result;
  return result;
end $$;

revoke all on function private.valid_observation_agreement(jsonb), private.snapshot_learning_plan(), private.guard_learning_plan_snapshot(), private.guard_versioned_plan_write() from public, anon, authenticated;
-- CHECK constraints execute under the updating role. This pure validator may
-- be executed by authenticated, without granting private-schema USAGE.
grant execute on function private.valid_observation_agreement(jsonb) to authenticated;
revoke all on function public.save_learning_plan(uuid,uuid,uuid,jsonb,jsonb), public.update_session_learning_context(uuid,integer,text) from public,anon,authenticated;
grant execute on function public.save_learning_plan(uuid,uuid,uuid,jsonb,jsonb), public.update_session_learning_context(uuid,integer,text) to authenticated;
