-- Keep public anonymous data bounded and make structured event timelines
-- authoritative even when browser teardown requests arrive out of order.

create or replace function private.valid_task_steps(candidate jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  step jsonb;
begin
  if jsonb_typeof(candidate) <> 'array'
    or jsonb_array_length(candidate) not between 1 and 20
  then
    return false;
  end if;

  for step in
    select value from jsonb_array_elements(candidate)
  loop
    if jsonb_typeof(step) <> 'object'
      or not (step ?& array['id', 'title', 'completed'])
      or (step - array['id', 'title', 'completed']::text[]) <> '{}'::jsonb
      or jsonb_typeof(step->'id') is distinct from 'string'
      or char_length(btrim(step->>'id')) not between 1 and 100
      or jsonb_typeof(step->'title') is distinct from 'string'
      or char_length(btrim(step->>'title')) not between 1 and 120
      or jsonb_typeof(step->'completed') is distinct from 'boolean'
    then
      return false;
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(candidate) as item(value)
    group by value->>'id'
    having count(*) > 1
  ) then
    return false;
  end if;

  return true;
end;
$$;

revoke all on function private.valid_task_steps(jsonb)
  from public, anon, authenticated;

alter table public.tasks
  add constraint tasks_steps_valid
  check (private.valid_task_steps(steps)) not valid;

alter table public.tasks
  validate constraint tasks_steps_valid;

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

drop trigger if exists tasks_enforce_user_row_quota on public.tasks;
create trigger tasks_enforce_user_row_quota
before insert on public.tasks
for each row execute function private.enforce_user_row_quota();

drop trigger if exists study_sessions_enforce_user_row_quota
  on public.study_sessions;
create trigger study_sessions_enforce_user_row_quota
before insert on public.study_sessions
for each row execute function private.enforce_user_row_quota();

drop trigger if exists behavior_events_enforce_user_row_quota
  on public.behavior_events;
create trigger behavior_events_enforce_user_row_quota
before insert on public.behavior_events
for each row execute function private.enforce_user_row_quota();

drop trigger if exists reminder_events_enforce_user_row_quota
  on public.reminder_events;
create trigger reminder_events_enforce_user_row_quota
before insert on public.reminder_events
for each row execute function private.enforce_user_row_quota();

drop trigger if exists reviews_enforce_user_row_quota on public.reviews;
create trigger reviews_enforce_user_row_quota
before insert on public.reviews
for each row execute function private.enforce_user_row_quota();

create or replace function private.normalize_behavior_event_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_status text;
  parent_ended_at timestamptz;
  database_now timestamptz := clock_timestamp();
  authoritative_end timestamptz;
begin
  if new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.session_id is distinct from old.session_id
  then
    raise exception 'Behavior event identity and ownership are immutable'
      using errcode = '23514';
  end if;

  select status, ended_at
  into parent_status, parent_ended_at
  from public.study_sessions
  where id = old.session_id
    and user_id = old.user_id
  for share;

  if not found then
    raise exception 'Linked study session not found' using errcode = 'P0002';
  end if;

  new.event_type := old.event_type;
  new.direction := old.direction;
  new.source := old.source;
  new.started_at := old.started_at;
  new.created_at := old.created_at;

  if parent_status in ('completed', 'cancelled') then
    authoritative_end := greatest(
      coalesce(parent_ended_at, database_now),
      old.started_at
    );
    new.ended_at := case
      when old.ended_at is null then authoritative_end
      else least(greatest(old.ended_at, old.started_at), authoritative_end)
    end;
  elsif old.ended_at is not null then
    new.ended_at := old.ended_at;
  elsif new.ended_at is not null then
    new.ended_at := least(
      greatest(new.ended_at, old.started_at),
      database_now
    );
  end if;

  return new;
end;
$$;

revoke all on function private.normalize_behavior_event_update()
  from public, anon, authenticated;

drop trigger if exists behavior_events_normalize_update
  on public.behavior_events;
create trigger behavior_events_normalize_update
before update on public.behavior_events
for each row execute function private.normalize_behavior_event_update();

comment on function private.valid_task_steps(jsonb) is
  'Accepts 1-20 uniquely identified task steps with bounded titles and exact structured fields.';
comment on function private.enforce_user_row_quota() is
  'Serializes and caps current rows per anonymous identity for public business tables.';
comment on function private.normalize_behavior_event_update() is
  'Keeps observed event identity/timestamps immutable and clamps late closures to the authoritative session timeline.';

notify pgrst, 'reload schema';
