-- A review is unique per session. PostgreSQL still runs BEFORE INSERT triggers
-- before resolving an INSERT ... ON CONFLICT DO UPDATE, so an edit to an
-- existing review must not be rejected merely because the user is at quota.

create or replace function private.enforce_user_row_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  max_rows bigint;
  existing_rows bigint;
  owner_id uuid := (to_jsonb(new)->>'user_id')::uuid;
  review_session_id uuid := (to_jsonb(new)->>'session_id')::uuid;
begin
  max_rows := case tg_table_name
    when 'tasks' then 200
    when 'study_sessions' then 1000
    when 'behavior_events' then 5000
    when 'reminder_events' then 5000
    when 'reviews' then 1000
    else null
  end;

  if max_rows is null or owner_id is null then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      tg_table_schema || '.' || tg_table_name || ':' || owner_id::text,
      0
    )
  );

  if tg_table_schema = 'public'
    and tg_table_name = 'reviews'
    and review_session_id is not null
    and exists (
      select 1
      from public.reviews
      where user_id = owner_id
        and session_id = review_session_id
    )
  then
    return new;
  end if;

  execute pg_catalog.format(
    'select count(*) from %I.%I where user_id = $1',
    tg_table_schema,
    tg_table_name
  )
  into existing_rows
  using owner_id;

  if existing_rows >= max_rows then
    raise exception 'The anonymous experience data limit for % has been reached',
      tg_table_name
      using errcode = '54000';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_user_row_quota()
  from public, anon, authenticated;
