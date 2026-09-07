-- Bound total model usage even when visitors create new anonymous identities.
-- This stores only a UTC date and aggregate count, never prompts or IP data.
create table private.ai_global_daily_quota (
  quota_date date primary key,
  attempts integer not null check (attempts > 0)
);

alter table private.ai_global_daily_quota enable row level security;
revoke all on table private.ai_global_daily_quota
  from public, anon, authenticated;

create or replace function public.consume_ai_generation_quota()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  quota_now timestamptz := clock_timestamp();
  current_quota_date date := (quota_now at time zone 'UTC')::date;
  user_allowed boolean;
  global_allowed boolean;
begin
  if current_user_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
  end if;

  insert into private.ai_generation_quota (
    user_id,
    window_started_at,
    attempts
  )
  values (current_user_id, quota_now, 1)
  on conflict (user_id) do update
  set
    window_started_at = case
      when private.ai_generation_quota.window_started_at <= quota_now - interval '10 minutes'
        then quota_now
      else private.ai_generation_quota.window_started_at
    end,
    attempts = case
      when private.ai_generation_quota.window_started_at <= quota_now - interval '10 minutes'
        then 1
      else private.ai_generation_quota.attempts + 1
    end
  returning attempts <= 8 into user_allowed;

  if not user_allowed then
    return false;
  end if;

  insert into private.ai_global_daily_quota (quota_date, attempts)
  values (current_quota_date, 1)
  on conflict (quota_date) do update
  set attempts = private.ai_global_daily_quota.attempts + 1
  returning attempts <= 200 into global_allowed;

  delete from private.ai_global_daily_quota
  where quota_date < current_quota_date - 35;

  return global_allowed;
end;
$$;

revoke all on function public.consume_ai_generation_quota()
  from public, anon;
grant execute on function public.consume_ai_generation_quota()
  to authenticated;

comment on function public.consume_ai_generation_quota() is
  'Atomically enforces 8 requests per identity per 10 minutes and 200 requests per UTC day across the app.';

-- Do not allow a direct task mutation to orphan a running or paused session.
create or replace function private.protect_task_with_active_session()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  selected_task_id uuid := case when tg_op = 'DELETE' then old.id else new.id end;
begin
  if (
    tg_op = 'DELETE'
    or (tg_op = 'UPDATE' and new.status in ('completed', 'archived'))
  ) and exists (
    select 1
    from public.study_sessions
    where task_id = selected_task_id
      and status in ('running', 'paused')
  ) then
    raise exception 'Finish the active study session before completing, archiving, or deleting its task'
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_protect_active_session on public.tasks;
create trigger tasks_protect_active_session
before delete or update of status on public.tasks
for each row execute function private.protect_task_with_active_session();
