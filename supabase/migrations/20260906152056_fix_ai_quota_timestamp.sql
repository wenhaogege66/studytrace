-- `current_time` is a SQL keyword returning timetz. Use an unambiguous
-- timestamptz variable so the quota window works in PostgreSQL.

create or replace function public.consume_ai_generation_quota()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  quota_now timestamptz := clock_timestamp();
  allowed boolean;
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
  returning attempts <= 8 into allowed;

  return allowed;
end;
$$;

revoke all on function public.consume_ai_generation_quota()
  from public, anon;
grant execute on function public.consume_ai_generation_quota()
  to authenticated;
