-- Correct both orderings of the browser-close/session-finish race and make
-- malformed step payloads fail deterministically before lifecycle triggers.

create or replace function private.valid_task_steps(candidate jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  step jsonb;
  step_id text;
  seen_ids text[] := array[]::text[];
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
      or step->>'id' <> btrim(step->>'id')
      or jsonb_typeof(step->'title') is distinct from 'string'
      or char_length(btrim(step->>'title')) not between 1 and 120
      or jsonb_typeof(step->'completed') is distinct from 'boolean'
    then
      return false;
    end if;

    step_id := step->>'id';
    if step_id = any(seen_ids) then
      return false;
    end if;
    seen_ids := array_append(seen_ids, step_id);
  end loop;

  return true;
end;
$$;

create or replace function private.enforce_task_steps_shape()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.valid_task_steps(new.steps) then
    raise exception 'Task steps must contain 1 to 20 unique {id,title,completed} objects'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_task_steps_shape()
  from public, anon, authenticated;

drop trigger if exists tasks_00_enforce_steps_shape on public.tasks;
create trigger tasks_00_enforce_steps_shape
before insert or update of steps on public.tasks
for each row execute function private.enforce_task_steps_shape();

create or replace function private.close_open_events_with_session()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  terminal_end timestamptz := coalesce(new.ended_at, clock_timestamp());
begin
  if new.status in ('completed', 'cancelled') then
    update public.behavior_events as event
    set
      started_at = least(event.started_at, terminal_end),
      ended_at = least(
        terminal_end,
        greatest(
          least(event.started_at, terminal_end),
          coalesce(event.ended_at, terminal_end)
        )
      )
    where event.session_id = new.id
      and event.user_id = new.user_id
      and (
        event.started_at > terminal_end
        or event.ended_at is null
        or event.ended_at > terminal_end
      );
  end if;
  return new;
end;
$$;

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
    and user_id = old.user_id;

  if not found then
    raise exception 'Linked study session not found' using errcode = 'P0002';
  end if;

  new.event_type := old.event_type;
  new.direction := old.direction;
  new.source := old.source;
  new.created_at := old.created_at;

  if parent_status in ('completed', 'cancelled') then
    authoritative_end := coalesce(parent_ended_at, database_now);
    new.started_at := least(old.started_at, authoritative_end);
    new.ended_at := case
      when old.ended_at is null then authoritative_end
      else least(
        greatest(old.ended_at, new.started_at),
        authoritative_end
      )
    end;
  else
    new.started_at := old.started_at;
    if old.ended_at is not null then
      new.ended_at := old.ended_at;
    elsif new.ended_at is not null then
      new.ended_at := least(
        greatest(new.ended_at, old.started_at),
        database_now
      );
    end if;
  end if;

  return new;
end;
$$;

comment on function private.close_open_events_with_session() is
  'Closes open events and clamps every event timestamp to its authoritative terminal session end.';
comment on function private.normalize_behavior_event_update() is
  'Keeps observed fields immutable, bounds active closures to database time, and clamps terminal closures without locking the parent row.';

notify pgrst, 'reload schema';
