-- StudyTrace factual insights foundation.
--
-- The browser still never uploads camera frames, landmarks, audio, or biometric
-- data. These tables only preserve server-authoritative study intervals and
-- structured state changes needed to explain a user's own trends.

create extension if not exists btree_gist with schema extensions;

alter table public.user_settings
  add column insights_enabled boolean not null default true,
  add column insights_timezone text not null default 'Asia/Shanghai'
    constraint user_settings_insights_timezone_length
    check (char_length(insights_timezone) between 1 and 64);

create or replace function private.validate_insights_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_timezone_names
    where name = new.insights_timezone
  ) then
    raise exception 'Unknown IANA time zone: %', new.insights_timezone
      using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_insights_timezone()
  from public, anon, authenticated;

create trigger user_settings_validate_insights_timezone
before insert or update of insights_timezone on public.user_settings
for each row execute function private.validate_insights_timezone();

alter table public.reminder_events
  drop constraint if exists reminder_events_response_check;

alter table public.reminder_events
  add constraint reminder_events_response_check check (
    response in (
      'none',
      'dismissed',
      'back_to_task',
      'normal_activity',
      'not_needed',
      'later'
    )
  );

-- Older rows predate explicit response timestamps. Preserve their response and
-- establish a consistent server-side timestamp before adding the invariant.
update public.reminder_events
set responded_at = case
  when response = 'none' then null
  else coalesce(responded_at, shown_at)
end;

alter table public.reminder_events
  add constraint reminder_events_response_timestamp_check check (
    (response = 'none' and responded_at is null)
    or (response <> 'none' and responded_at is not null)
  );

create or replace function private.normalize_reminder_response()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.responded_at := case
      when new.response = 'none' then null
      else clock_timestamp()
    end;
    return new;
  end if;

  if new.response is distinct from old.response then
    if old.response <> 'none' then
      raise exception 'A reminder response cannot be changed after it is saved'
        using errcode = '23514';
    end if;
    new.responded_at := clock_timestamp();
  else
    new.responded_at := old.responded_at;
  end if;
  return new;
end;
$$;

revoke all on function private.normalize_reminder_response()
  from public, anon, authenticated;

create trigger reminder_events_normalize_response_on_insert
before insert on public.reminder_events
for each row execute function private.normalize_reminder_response();

create trigger reminder_events_normalize_response_on_update
before update of response, responded_at on public.reminder_events
for each row execute function private.normalize_reminder_response();

create or replace function public.respond_to_reminder(
  p_reminder_id uuid,
  p_response text
)
returns public.reminder_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  selected_reminder public.reminder_events;
begin
  if caller_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_response not in (
    'dismissed',
    'back_to_task',
    'normal_activity',
    'not_needed',
    'later'
  ) then
    raise exception 'Unsupported reminder response' using errcode = '22023';
  end if;

  select *
  into selected_reminder
  from public.reminder_events
  where id = p_reminder_id
    and user_id = caller_id
  for update;

  if not found then
    raise exception 'Reminder not found' using errcode = 'P0002';
  end if;

  if selected_reminder.response = 'none' then
    update public.reminder_events
    set response = p_response
    where id = selected_reminder.id
      and user_id = caller_id
    returning * into selected_reminder;
  end if;

  return selected_reminder;
end;
$$;

revoke all on function public.respond_to_reminder(uuid, text)
  from public, anon, authenticated;
grant execute on function public.respond_to_reminder(uuid, text)
  to authenticated;

-- Browser clients can create and read their own reminder facts, but the only
-- supported mutation is the owner-checked, first-response-wins RPC above.
revoke update on table public.reminder_events from authenticated;

create table public.session_segments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.study_sessions(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  origin text not null default 'runtime'
    check (origin in ('runtime', 'backfill')),
  created_at timestamptz not null default now(),
  constraint session_segments_ended_after_started
    check (ended_at is null or ended_at >= started_at)
);

create table public.observation_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.study_sessions(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  last_observed_at timestamptz not null default clock_timestamp(),
  camera_version bigint not null default 0 check (camera_version >= 0),
  observation_profile text not null
    check (
      observation_profile in (
        'study_screen_v1',
        'study_paper_v1',
        'off_device_v1'
      )
    ),
  detector_version text not null
    check (char_length(detector_version) between 1 and 80),
  experiment_mode boolean not null default false,
  policy_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(policy_snapshot) = 'object'),
  threshold_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(threshold_snapshot) = 'object'),
  origin text not null default 'runtime'
    check (origin in ('runtime', 'backfill')),
  created_at timestamptz not null default now(),
  constraint observation_runs_ended_after_started
    check (ended_at is null or ended_at >= started_at),
  constraint observation_runs_heartbeat_bounds
    check (
      last_observed_at >= started_at
      and (ended_at is null or last_observed_at <= ended_at)
    )
);

create table public.task_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  event_type text not null check (
    event_type in (
      'created',
      'started',
      'ready_to_complete',
      'completion_reopened',
      'completed',
      'reopened',
      'archived',
      'restored',
      'status_changed'
    )
  ),
  from_status text,
  to_status text,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create table public.task_step_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  step_id text not null check (char_length(step_id) between 1 and 120),
  event_type text not null
    check (event_type in ('added', 'removed', 'renamed', 'completed', 'reopened')),
  previous_title text check (
    previous_title is null or char_length(previous_title) between 1 and 240
  ),
  next_title text check (
    next_title is null or char_length(next_title) between 1 and 240
  ),
  previous_completed boolean,
  next_completed boolean,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Fact capture deliberately fails open for the core task/session workflow when
-- a defensive cap is reached. Keep a private, durable completeness marker so a
-- partial history is never presented as a complete factual report.
create table private.insight_fact_coverage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  truncated boolean not null default false,
  first_truncated_at timestamptz,
  last_truncated_at timestamptz,
  dropped_counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(dropped_counts) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint insight_fact_coverage_timestamp_check check (
    (not truncated and first_truncated_at is null and last_truncated_at is null)
    or (
      truncated
      and first_truncated_at is not null
      and last_truncated_at is not null
      and last_truncated_at >= first_truncated_at
    )
  )
);

alter table private.insight_fact_coverage enable row level security;
revoke all on table private.insight_fact_coverage
  from public, anon, authenticated;

create unique index session_segments_one_open_per_session_idx
  on public.session_segments (session_id)
  where ended_at is null;
alter table public.session_segments
  add constraint session_segments_no_overlap
  exclude using gist (
    session_id with =,
    tstzrange(started_at, ended_at, '[)') with &&
  );
create index session_segments_user_started_idx
  on public.session_segments (user_id, started_at desc);
create index session_segments_session_started_idx
  on public.session_segments (session_id, started_at);

create unique index observation_runs_one_open_per_session_idx
  on public.observation_runs (session_id)
  where ended_at is null;
alter table public.observation_runs
  add constraint observation_runs_no_overlap
  exclude using gist (
    session_id with =,
    tstzrange(started_at, ended_at, '[)') with &&
  );
create index observation_runs_user_started_idx
  on public.observation_runs (user_id, started_at desc);
create index observation_runs_session_started_idx
  on public.observation_runs (session_id, started_at);

create index task_lifecycle_events_user_occurred_idx
  on public.task_lifecycle_events (user_id, occurred_at desc);
create index task_lifecycle_events_task_occurred_idx
  on public.task_lifecycle_events (task_id, occurred_at);
create index task_step_events_user_occurred_idx
  on public.task_step_events (user_id, occurred_at desc);
create index task_step_events_task_occurred_idx
  on public.task_step_events (task_id, occurred_at);

alter table public.session_segments enable row level security;
alter table public.observation_runs enable row level security;
alter table public.task_lifecycle_events enable row level security;
alter table public.task_step_events enable row level security;

create policy session_segments_select_own
on public.session_segments for select to authenticated
using ((select auth.uid()) = user_id);

create policy observation_runs_select_own
on public.observation_runs for select to authenticated
using ((select auth.uid()) = user_id);

create policy task_lifecycle_events_select_own
on public.task_lifecycle_events for select to authenticated
using ((select auth.uid()) = user_id);

create policy task_step_events_select_own
on public.task_step_events for select to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.session_segments, public.observation_runs,
  public.task_lifecycle_events, public.task_step_events
  from public, anon, authenticated;

-- These are append-only implementation facts. Browser clients consume the
-- owner-scoped aggregate RPC below; raw fact rows are deliberately not exposed
-- through the Data API.

create or replace function private.limit_insight_fact_growth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := (to_jsonb(new)->>'user_id')::uuid;
  parent_column text;
  parent_id uuid;
  per_user_limit integer;
  per_parent_limit integer;
  user_rows bigint;
  parent_rows bigint;
begin
  if owner_id is null then
    raise exception 'Insight fact row must have an owner'
      using errcode = '23502';
  end if;

  case tg_table_name
    when 'session_segments' then
      parent_column := 'session_id';
      parent_id := (to_jsonb(new)->>'session_id')::uuid;
      per_user_limit := 25000;
      per_parent_limit := 1000;
    when 'observation_runs' then
      parent_column := 'session_id';
      parent_id := (to_jsonb(new)->>'session_id')::uuid;
      per_user_limit := 25000;
      per_parent_limit := 1000;
    when 'task_lifecycle_events' then
      parent_column := 'task_id';
      parent_id := (to_jsonb(new)->>'task_id')::uuid;
      per_user_limit := 20000;
      per_parent_limit := 500;
    when 'task_step_events' then
      parent_column := 'task_id';
      parent_id := (to_jsonb(new)->>'task_id')::uuid;
      per_user_limit := 50000;
      per_parent_limit := 5000;
    else
      raise exception 'Unsupported insight fact table: %', tg_table_name
        using errcode = '22023';
  end case;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'studytrace.insight-fact:' || tg_table_name || ':' || owner_id::text,
      0
    )
  );

  execute pg_catalog.format(
    'select count(*) from %I.%I where user_id = $1',
    tg_table_schema,
    tg_table_name
  ) into user_rows using owner_id;

  execute pg_catalog.format(
    'select count(*) from %I.%I where %I = $1',
    tg_table_schema,
    tg_table_name,
    parent_column
  ) into parent_rows using parent_id;

  -- Insight bookkeeping must never trap the user in an active session. Once a
  -- defensive cap is reached, skip new derived facts while core task/session
  -- state continues to work, but preserve an explicit incompleteness marker.
  if user_rows >= per_user_limit or parent_rows >= per_parent_limit then
    insert into private.insight_fact_coverage (
      user_id,
      truncated,
      first_truncated_at,
      last_truncated_at,
      dropped_counts,
      updated_at
    ) values (
      owner_id,
      true,
      clock_timestamp(),
      clock_timestamp(),
      jsonb_build_object(tg_table_name, 1),
      clock_timestamp()
    )
    on conflict (user_id) do update
    set
      truncated = true,
      first_truncated_at = coalesce(
        private.insight_fact_coverage.first_truncated_at,
        excluded.first_truncated_at
      ),
      last_truncated_at = excluded.last_truncated_at,
      dropped_counts = private.insight_fact_coverage.dropped_counts
        || jsonb_build_object(
          tg_table_name,
          coalesce(
            (
              private.insight_fact_coverage.dropped_counts
                ->> tg_table_name
            )::bigint,
            0
          ) + 1
        ),
      updated_at = excluded.updated_at;
    return null;
  end if;

  return new;
end;
$$;

revoke all on function private.limit_insight_fact_growth()
  from public, anon, authenticated;

create trigger session_segments_limit_growth
before insert on public.session_segments
for each row execute function private.limit_insight_fact_growth();

create trigger observation_runs_limit_growth
before insert on public.observation_runs
for each row execute function private.limit_insight_fact_growth();

create trigger task_lifecycle_events_limit_growth
before insert on public.task_lifecycle_events
for each row execute function private.limit_insight_fact_growth();

create trigger task_step_events_limit_growth
before insert on public.task_step_events
for each row execute function private.limit_insight_fact_growth();

-- Account merges move the parent rows without changing their ids. Cascade the
-- owner onto derived facts before the anonymous auth user is deleted, so the
-- FK cascade cannot silently discard the history being transferred.
create or replace function private.cascade_task_insight_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    update public.task_lifecycle_events
    set user_id = new.user_id
    where task_id = new.id and user_id = old.user_id;

    update public.task_step_events
    set user_id = new.user_id
    where task_id = new.id and user_id = old.user_id;
  end if;
  return new;
end;
$$;

revoke all on function private.cascade_task_insight_owner()
  from public, anon, authenticated;

create trigger tasks_cascade_insight_owner
after update of user_id on public.tasks
for each row execute function private.cascade_task_insight_owner();

create or replace function private.cascade_session_insight_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    update public.session_segments
    set user_id = new.user_id
    where session_id = new.id and user_id = old.user_id;

    update public.observation_runs
    set user_id = new.user_id
    where session_id = new.id and user_id = old.user_id;
  end if;
  return new;
end;
$$;

revoke all on function private.cascade_session_insight_owner()
  from public, anon, authenticated;

create trigger study_sessions_cascade_insight_owner
after update of user_id on public.study_sessions
for each row execute function private.cascade_session_insight_owner();

create or replace function private.capture_study_session_insights()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  transition_at timestamptz := clock_timestamp();
  policy_snapshot jsonb;
  threshold_snapshot jsonb;
begin
  if not coalesce(
    (
      select settings.insights_enabled
      from public.user_settings as settings
      where settings.user_id = new.user_id
    ),
    true
  ) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'running' then
      insert into public.session_segments (
        user_id,
        session_id,
        started_at,
        origin
      )
      select
        new.user_id,
        new.id,
        coalesce(new.resumed_at, new.started_at),
        'runtime'
      where not exists (
        select 1
        from public.session_segments
        where session_id = new.id and ended_at is null
      );
    end if;
  elsif old.status = 'running' and new.status <> 'running' then
    update public.session_segments
    set ended_at = greatest(
      case
        when new.status in ('completed', 'cancelled')
          then coalesce(new.ended_at, transition_at)
        else transition_at
      end,
      started_at
    )
    where session_id = new.id
      and user_id = new.user_id
      and ended_at is null;
  elsif old.status <> 'running' and new.status = 'running' then
    update public.session_segments
    set ended_at = greatest(transition_at, started_at)
    where session_id = new.id
      and user_id = new.user_id
      and ended_at is null;

    insert into public.session_segments (
      user_id,
      session_id,
      started_at,
      origin
    )
    values (
      new.user_id,
      new.id,
      coalesce(new.resumed_at, transition_at),
      'runtime'
    );
  end if;

  if tg_op = 'UPDATE'
    and old.camera_enabled
    and (not new.camera_enabled or new.status <> 'running')
  then
    update public.observation_runs
    set ended_at = greatest(
      case
        when new.status in ('completed', 'cancelled')
          then coalesce(new.ended_at, transition_at)
        else transition_at
      end,
      started_at,
      last_observed_at
    )
    where session_id = new.id
      and user_id = new.user_id
      and ended_at is null;
  end if;

  if new.camera_enabled
    and new.status = 'running'
    and (tg_op = 'INSERT' or not old.camera_enabled)
  then
    select
      jsonb_build_object(
        'profile', new.observation_profile,
        'face_absent', new.observation_profile <> 'off_device_v1',
        'yaw', new.observation_profile <> 'off_device_v1',
        'pitch', new.observation_profile = 'study_screen_v1'
      ),
      jsonb_build_object(
        'calibration_seconds', settings.calibration_seconds,
        'sample_fps', settings.sample_fps,
        'face_absent_seconds', settings.face_absent_seconds,
        'direction_hold_seconds', settings.direction_hold_seconds,
        'neutral_recovery_seconds', settings.neutral_recovery_seconds,
        'reminder_delay_seconds', settings.reminder_delay_seconds,
        'reminder_cooldown_seconds', settings.reminder_cooldown_seconds,
        'yaw_threshold_degrees', settings.yaw_threshold_degrees,
        'pitch_threshold_degrees', settings.pitch_threshold_degrees
      )
    into policy_snapshot, threshold_snapshot
    from public.user_settings as settings
    where settings.user_id = new.user_id;

    insert into public.observation_runs (
      user_id,
      session_id,
      started_at,
      last_observed_at,
      camera_version,
      observation_profile,
      detector_version,
      experiment_mode,
      policy_snapshot,
      threshold_snapshot,
      origin
    )
    select
      new.user_id,
      new.id,
      transition_at,
      transition_at,
      new.camera_version,
      new.observation_profile,
      'mediapipe-face-landmarker@1.0.1',
      new.experiment_mode,
      coalesce(policy_snapshot, '{}'::jsonb),
      coalesce(threshold_snapshot, '{}'::jsonb),
      'runtime'
    where not exists (
      select 1
      from public.observation_runs
      where session_id = new.id and ended_at is null
    );
  end if;

  return new;
end;
$$;

revoke all on function private.capture_study_session_insights()
  from public, anon, authenticated;

create trigger study_sessions_capture_insights
after insert or update of status, camera_enabled on public.study_sessions
for each row execute function private.capture_study_session_insights();

create or replace function private.capture_task_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  lifecycle_type text;
  transition_at timestamptz := clock_timestamp();
begin
  if not coalesce(
    (
      select settings.insights_enabled
      from public.user_settings as settings
      where settings.user_id = new.user_id
    ),
    true
  ) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    insert into public.task_lifecycle_events (
      user_id,
      task_id,
      event_type,
      to_status,
      occurred_at
    ) values (
      new.user_id,
      new.id,
      'created',
      new.status,
      least(new.created_at, transition_at)
    );

    if new.status = 'completed' and new.completed_at is not null then
      insert into public.task_lifecycle_events (
        user_id,
        task_id,
        event_type,
        from_status,
        to_status,
        occurred_at
      ) values (
        new.user_id,
        new.id,
        'completed',
        'in_progress',
        'completed',
        least(new.completed_at, transition_at)
      );
    end if;
    return new;
  end if;

  if old.status is not distinct from new.status then
    return new;
  end if;

  lifecycle_type := case
    when new.status = 'completed' then 'completed'
    when new.status = 'archived' then 'archived'
    when old.status = 'completed' then 'reopened'
    when old.status = 'archived' then 'restored'
    when old.status = 'planned' and new.status = 'in_progress' then 'started'
    else 'status_changed'
  end;

  insert into public.task_lifecycle_events (
    user_id,
    task_id,
    event_type,
    from_status,
    to_status,
    occurred_at
  ) values (
    new.user_id,
    new.id,
    lifecycle_type,
    old.status,
    new.status,
    case
      when lifecycle_type = 'completed'
        then coalesce(new.completed_at, transition_at)
      else transition_at
    end
  );

  return new;
end;
$$;

revoke all on function private.capture_task_lifecycle()
  from public, anon, authenticated;

create trigger tasks_capture_lifecycle
after insert or update of status on public.tasks
for each row execute function private.capture_task_lifecycle();

create or replace function private.capture_task_step_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_step record;
  step_event_type text;
  was_complete boolean;
  is_complete boolean;
  transition_at timestamptz := clock_timestamp();
begin
  if not coalesce(
    (
      select settings.insights_enabled
      from public.user_settings as settings
      where settings.user_id = new.user_id
    ),
    true
  ) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    for changed_step in
      select
        step.value->>'id' as step_id,
        step.value->>'title' as next_title,
        (step.value->>'completed')::boolean as next_completed
      from jsonb_array_elements(new.steps) as step(value)
    loop
      insert into public.task_step_events (
        user_id,
        task_id,
        step_id,
        event_type,
        next_title,
        next_completed,
        occurred_at
      ) values (
        new.user_id,
        new.id,
        changed_step.step_id,
        'added',
        changed_step.next_title,
        changed_step.next_completed,
        least(new.created_at, transition_at)
      );
    end loop;

    return new;
  end if;

  for changed_step in
    select
      coalesce(next_step.value->>'id', previous_step.value->>'id') as step_id,
      previous_step.value->>'title' as previous_title,
      next_step.value->>'title' as next_title,
      coalesce((previous_step.value->>'completed')::boolean, false)
        as previous_completed,
      coalesce((next_step.value->>'completed')::boolean, false)
        as next_completed,
      previous_step.value is null as was_added,
      next_step.value is null as was_removed
    from jsonb_array_elements(old.steps) as previous_step(value)
    full join jsonb_array_elements(new.steps) as next_step(value)
      on previous_step.value->>'id' = next_step.value->>'id'
    where previous_step.value is null
      or next_step.value is null
      or previous_step.value->>'title'
        is distinct from next_step.value->>'title'
      or coalesce((previous_step.value->>'completed')::boolean, false)
        is distinct from coalesce((next_step.value->>'completed')::boolean, false)
  loop
    step_event_type := case
      when changed_step.was_added then 'added'
      when changed_step.was_removed then 'removed'
      when changed_step.previous_completed is false
        and changed_step.next_completed is true then 'completed'
      when changed_step.previous_completed is true
        and changed_step.next_completed is false then 'reopened'
      else 'renamed'
    end;

    insert into public.task_step_events (
      user_id,
      task_id,
      step_id,
      event_type,
      previous_title,
      next_title,
      previous_completed,
      next_completed,
      occurred_at
    ) values (
      new.user_id,
      new.id,
      changed_step.step_id,
      step_event_type,
      changed_step.previous_title,
      changed_step.next_title,
      case when changed_step.was_added then null
        else changed_step.previous_completed end,
      case when changed_step.was_removed then null
        else changed_step.next_completed end,
      transition_at
    );
  end loop;

  select
    jsonb_array_length(old.steps) > 0
      and not exists (
        select 1
        from jsonb_array_elements(old.steps) as step(value)
        where step.value->'completed' is distinct from 'true'::jsonb
      ),
    jsonb_array_length(new.steps) > 0
      and not exists (
        select 1
        from jsonb_array_elements(new.steps) as step(value)
        where step.value->'completed' is distinct from 'true'::jsonb
      )
  into was_complete, is_complete;

  if not was_complete and is_complete then
    insert into public.task_lifecycle_events (
      user_id,
      task_id,
      event_type,
      from_status,
      to_status,
      occurred_at,
      metadata
    ) values (
      new.user_id,
      new.id,
      'ready_to_complete',
      new.status,
      new.status,
      transition_at,
      jsonb_build_object('step_count', jsonb_array_length(new.steps))
    );
  elsif was_complete and not is_complete then
    insert into public.task_lifecycle_events (
      user_id,
      task_id,
      event_type,
      from_status,
      to_status,
      occurred_at,
      metadata
    ) values (
      new.user_id,
      new.id,
      'completion_reopened',
      new.status,
      new.status,
      transition_at,
      jsonb_build_object('step_count', jsonb_array_length(new.steps))
    );
  end if;

  return new;
end;
$$;

revoke all on function private.capture_task_step_events()
  from public, anon, authenticated;

create trigger tasks_capture_step_events
after insert or update of steps on public.tasks
for each row
execute function private.capture_task_step_events();

-- Existing tasks predate the insert trigger. Record their initial plan as a
-- backfilled set of added steps so later completion/reopen facts have an
-- explainable starting point instead of an incomplete history.
insert into public.task_step_events (
  user_id,
  task_id,
  step_id,
  event_type,
  next_title,
  next_completed,
  occurred_at
)
select
  task.user_id,
  task.id,
  step.value->>'id',
  'added',
  step.value->>'title',
  (step.value->>'completed')::boolean,
  task.created_at
from public.tasks as task
cross join lateral jsonb_array_elements(task.steps) as step(value);

-- Seed only lifecycle facts the previous schema can prove exactly. Preserve
-- completed facts first so even an extreme account that reaches the defensive
-- fact cap keeps the evidence used by the completion metric. Reopened tasks
-- retain this event after tasks.completed_at is cleared.
insert into public.task_lifecycle_events (
  user_id,
  task_id,
  event_type,
  from_status,
  to_status,
  occurred_at,
  metadata
)
select
  task.user_id,
  task.id,
  'completed',
  'in_progress',
  'completed',
  task.completed_at,
  jsonb_build_object('origin', 'backfill')
from public.tasks as task
where task.completed_at is not null;

insert into public.task_lifecycle_events (
  user_id,
  task_id,
  event_type,
  to_status,
  occurred_at,
  metadata
)
select
  task.user_id,
  task.id,
  'created',
  task.status,
  task.created_at,
  jsonb_build_object('origin', 'backfill')
from public.tasks as task;

-- Reconstruct only the duration that the previous schema can prove. A
-- backfilled row is labelled so the UI can explain that older pause boundaries
-- are approximate rather than pretending to know them.
with session_anchors as (
  select
    session.id,
    session.user_id,
    session.started_at,
    session.accumulated_seconds,
    case
      when session.status = 'running' then session.resumed_at
      when session.status = 'paused' then session.updated_at
      else session.ended_at
    end as anchor_at
  from public.study_sessions as session
  where session.accumulated_seconds > 0
), reconstructed as (
  select
    id,
    user_id,
    greatest(
      started_at,
      anchor_at - make_interval(secs => accumulated_seconds)
    ) as reconstructed_start,
    anchor_at
  from session_anchors
  where anchor_at is not null
)
insert into public.session_segments (
  user_id,
  session_id,
  started_at,
  ended_at,
  origin
)
select
  user_id,
  id,
  reconstructed_start,
  greatest(anchor_at, reconstructed_start),
  'backfill'
from reconstructed;

insert into public.session_segments (
  user_id,
  session_id,
  started_at,
  origin
)
select
  session.user_id,
  session.id,
  coalesce(session.resumed_at, session.started_at),
  'backfill'
from public.study_sessions as session
where session.status = 'running'
  and not exists (
    select 1
    from public.session_segments as segment
    where segment.session_id = session.id
      and segment.ended_at is null
  );

insert into public.observation_runs (
  user_id,
  session_id,
  started_at,
  last_observed_at,
  camera_version,
  observation_profile,
  detector_version,
  experiment_mode,
  policy_snapshot,
  threshold_snapshot,
  origin
)
select
  session.user_id,
  session.id,
  greatest(session.started_at, session.updated_at),
  greatest(session.started_at, session.updated_at),
  session.camera_version,
  session.observation_profile,
  'mediapipe-face-landmarker@1.0.1',
  session.experiment_mode,
  jsonb_build_object('profile', session.observation_profile),
  '{}'::jsonb,
  'backfill'
from public.study_sessions as session
where session.status = 'running'
  and session.camera_enabled;

create or replace function public.update_my_insights_preferences(
  p_enabled boolean,
  p_timezone text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  updated_settings public.user_settings;
begin
  if caller_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_enabled is null or p_timezone is null then
    raise exception 'Insight preference values are required'
      using errcode = '22023';
  end if;

  update public.user_settings
  set insights_enabled = p_enabled,
      insights_timezone = p_timezone
  where user_id = caller_id
  returning * into updated_settings;

  if not found then
    raise exception 'User settings not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'enabled', updated_settings.insights_enabled,
    'timezone', updated_settings.insights_timezone
  );
end;
$$;

revoke all on function public.update_my_insights_preferences(boolean, text)
  from public, anon, authenticated;
grant execute on function public.update_my_insights_preferences(boolean, text)
  to authenticated;

create or replace function private.insight_effective_end(
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_last_confirmed_at timestamptz,
  p_report_generated_at timestamptz
)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select greatest(
    p_started_at,
    least(
      coalesce(p_ended_at, p_last_confirmed_at, p_started_at),
      p_report_generated_at
    )
  );
$$;

revoke all on function private.insight_effective_end(
  timestamptz, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;

create or replace function private.insight_bucket_ranges(
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_timezone text
)
returns table (bucket_id text, bucket_start timestamptz, bucket_end timestamptz)
language sql
stable
set search_path = ''
as $$
  with absolute_minutes as (
    select
      absolute_minute.value as minute_start,
      absolute_minute.value + interval '1 minute' as minute_end,
      case
        when extract(hour from (
          (absolute_minute.value + interval '30 seconds') at time zone p_timezone
        )) < 5 then 'night'
        when extract(hour from (
          (absolute_minute.value + interval '30 seconds') at time zone p_timezone
        )) < 11 then 'morning'
        when extract(hour from (
          (absolute_minute.value + interval '30 seconds') at time zone p_timezone
        )) < 14 then 'midday'
        when extract(hour from (
          (absolute_minute.value + interval '30 seconds') at time zone p_timezone
        )) < 18 then 'afternoon'
        else 'evening'
      end as bucket_id
    from pg_catalog.generate_series(
      pg_catalog.date_trunc('minute', p_start_at),
      pg_catalog.date_trunc('minute', p_end_at - interval '1 microsecond'),
      interval '1 minute'
    ) as absolute_minute(value)
    where p_end_at > p_start_at
  ), minute_boundaries as (
    select
      minute.*,
      case
        when lag(bucket_id) over (order by minute_start)
          is distinct from bucket_id then 1
        else 0
      end as starts_bucket_range
    from absolute_minutes as minute
  ), grouped_minutes as (
    select
      minute.*,
      sum(starts_bucket_range) over (order by minute_start) as range_group
    from minute_boundaries as minute
  )
  select
    grouped.bucket_id,
    min(grouped.minute_start) as bucket_start,
    max(grouped.minute_end) as bucket_end
  from grouped_minutes as grouped
  group by grouped.bucket_id, grouped.range_group
  order by bucket_start;
$$;

revoke all on function private.insight_bucket_ranges(
  timestamptz, timestamptz, text
) from public, anon, authenticated;

create or replace function public.get_my_insights(p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  selected_timezone text := 'Asia/Shanghai';
  selected_enabled boolean := true;
  generated_at timestamptz := current_timestamp;
  local_today date;
  period_start timestamptz;
  period_end timestamptz;
  evidence_start timestamptz;
  evidence_end timestamptz;
  active_days integer := 0;
  eligible_segments integer := 0;
  actual_seconds bigint := 0;
  median_segment_seconds integer := 0;
  evidence_active_days integer := 0;
  evidence_eligible_segments integer := 0;
  evidence_median_segment_seconds integer := 0;
  completed_tasks integer := 0;
  terminal_sessions integer := 0;
  reviewed_sessions integer := 0;
  review_coverage_percent numeric := 0;
  observed_seconds bigint := 0;
  observation_coverage_percent numeric := 0;
  confirmed_events integer := 0;
  confirmed_events_per_hour numeric := 0;
  manual_markers integer := 0;
  correlated_markers integer := 0;
  precursor_percent numeric := 0;
  backfilled_segments integer := 0;
  segment_distribution jsonb := '[]'::jsonb;
  time_buckets jsonb := '[]'::jsonb;
  reminder_responses jsonb := '{}'::jsonb;
  facts_truncated boolean := false;
  fact_dropped_counts jsonb := '{}'::jsonb;
  first_truncated_at timestamptz;
  last_truncated_at timestamptz;
  period_complete boolean := true;
  recommendation_evidence_complete boolean := true;
begin
  if caller_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_days not in (7, 30) then
    raise exception 'Insight window must be 7 or 30 days'
      using errcode = '22023';
  end if;

  select settings.insights_timezone, settings.insights_enabled
  into selected_timezone, selected_enabled
  from public.user_settings as settings
  where settings.user_id = caller_id;

  selected_timezone := coalesce(selected_timezone, 'Asia/Shanghai');
  selected_enabled := coalesce(selected_enabled, true);

  select
    coverage.truncated,
    coverage.dropped_counts,
    coverage.first_truncated_at,
    coverage.last_truncated_at
  into
    facts_truncated,
    fact_dropped_counts,
    first_truncated_at,
    last_truncated_at
  from private.insight_fact_coverage as coverage
  where coverage.user_id = caller_id;

  facts_truncated := coalesce(facts_truncated, false);
  fact_dropped_counts := coalesce(fact_dropped_counts, '{}'::jsonb);
  local_today := (generated_at at time zone selected_timezone)::date;
  period_start := (
    (local_today - (p_days - 1))::timestamp at time zone selected_timezone
  );
  period_end := (
    (local_today + 1)::timestamp at time zone selected_timezone
  );
  evidence_start := (
    (local_today - 29)::timestamp at time zone selected_timezone
  );
  evidence_end := period_end;
  period_complete := not facts_truncated
    or last_truncated_at < period_start
    or first_truncated_at >= period_end;
  recommendation_evidence_complete := not facts_truncated
    or last_truncated_at < evidence_start
    or first_truncated_at >= evidence_end;

  if selected_enabled then
    with clipped_segments as (
      select
        greatest(segment.started_at, period_start) as segment_start,
        least(private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at), period_end)
          as segment_end,
        segment.origin
      from public.session_segments as segment
      join public.study_sessions as session
        on session.id = segment.session_id
       and session.user_id = caller_id
      where segment.user_id = caller_id
        and not session.experiment_mode
        and segment.started_at < period_end
        and private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at) > period_start
    ), valid_segments as (
      select
        segment_start,
        segment_end,
        origin,
        floor(extract(epoch from (segment_end - segment_start)))::integer
          as seconds
      from clipped_segments
      where segment_end >= segment_start + interval '2 minutes'
    ), canonical_ranges as (
      -- A user can merge two histories whose wall-clock intervals overlap.
      -- Range union keeps personal totals, samples and medians factual instead
      -- of counting simultaneous records twice.
      select unnest(
        range_agg(tstzrange(segment_start, segment_end, '[)'))
      ) as active_range
      from valid_segments
    ), canonical_segments as (
      select
        lower(active_range) as segment_start,
        upper(active_range) as segment_end,
        floor(extract(epoch from (upper(active_range) - lower(active_range))))
          ::integer as seconds
      from canonical_ranges
    )
    select
      count(*)::integer,
      (
        select count(distinct (
          (day_segment.segment_start at time zone selected_timezone)::date
          + day_offset.value
        ))::integer
        from canonical_segments as day_segment
        cross join lateral pg_catalog.generate_series(
          0,
          greatest(
            0,
            (
              (
                (day_segment.segment_end - interval '1 microsecond')
                  at time zone selected_timezone
              )::date
              - (day_segment.segment_start at time zone selected_timezone)::date
            )
          )
        ) as day_offset(value)
      ),
      coalesce(sum(seconds), 0)::bigint,
      coalesce(
        percentile_cont(0.5) within group (order by seconds),
        0
      )::integer,
      (select count(*) from valid_segments where origin = 'backfill')::integer
    into
      eligible_segments,
      active_days,
      actual_seconds,
      median_segment_seconds,
      backfilled_segments
    from canonical_segments;

    -- Recommendation readiness always uses a trailing 30-natural-day evidence
    -- pool, even when the user is viewing the shorter 7-day summary.
    with clipped_segments as (
      select
        greatest(segment.started_at, evidence_start) as segment_start,
        least(private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at), evidence_end)
          as segment_end
      from public.session_segments as segment
      join public.study_sessions as session
        on session.id = segment.session_id
       and session.user_id = caller_id
      where segment.user_id = caller_id
        and not session.experiment_mode
        and segment.started_at < evidence_end
        and private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at) > evidence_start
    ), valid_segments as (
      select
        segment_start,
        segment_end,
        floor(extract(epoch from (segment_end - segment_start)))::integer
          as seconds
      from clipped_segments
      where segment_end >= segment_start + interval '2 minutes'
    ), canonical_ranges as (
      select unnest(
        range_agg(tstzrange(segment_start, segment_end, '[)'))
      ) as active_range
      from valid_segments
    ), canonical_segments as (
      select
        lower(active_range) as segment_start,
        upper(active_range) as segment_end,
        floor(extract(epoch from (upper(active_range) - lower(active_range))))
          ::integer as seconds
      from canonical_ranges
    )
    select
      count(*)::integer,
      (
        select count(distinct (
          (day_segment.segment_start at time zone selected_timezone)::date
          + day_offset.value
        ))::integer
        from canonical_segments as day_segment
        cross join lateral pg_catalog.generate_series(
          0,
          greatest(
            0,
            (
              (
                (day_segment.segment_end - interval '1 microsecond')
                  at time zone selected_timezone
              )::date
              - (day_segment.segment_start at time zone selected_timezone)::date
            )
          )
        ) as day_offset(value)
      ),
      coalesce(
        percentile_cont(0.5) within group (order by seconds),
        0
      )::integer
    into
      evidence_eligible_segments,
      evidence_active_days,
      evidence_median_segment_seconds
    from canonical_segments;

    with clipped_segments as (
      select
        greatest(segment.started_at, period_start) as segment_start,
        least(
          private.insight_effective_end(
            segment.started_at,
            segment.ended_at,
            session.updated_at,
            generated_at
          ),
          period_end
        ) as segment_end
      from public.session_segments as segment
      join public.study_sessions as session
        on session.id = segment.session_id
       and session.user_id = caller_id
      where segment.user_id = caller_id
        and not session.experiment_mode
        and segment.started_at < period_end
        and private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at) > period_start
        and least(private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at), period_end)
          >= greatest(segment.started_at, period_start) + interval '2 minutes'
    ), valid_segments as (
      select segment_start, segment_end
      from clipped_segments
      where segment_end >= segment_start + interval '2 minutes'
    ), canonical_ranges as (
      select unnest(
        range_agg(tstzrange(segment_start, segment_end, '[)'))
      ) as active_range
      from valid_segments
    ), canonical_segments as (
      select floor(
        extract(epoch from (upper(active_range) - lower(active_range)))
      )::integer as seconds
      from canonical_ranges
    ), buckets(id, label, minimum_seconds, maximum_seconds, ordinal) as (
      values
        ('under_15', '2–15 分钟', 120, 900, 1),
        ('15_30', '15–30 分钟', 900, 1800, 2),
        ('30_45', '30–45 分钟', 1800, 2700, 3),
        ('45_60', '45–60 分钟', 2700, 3600, 4),
        ('over_60', '60 分钟以上', 3600, null::integer, 5)
    ), counted as (
      select
        bucket.id,
        bucket.label,
        bucket.ordinal,
        count(segment.seconds)::integer as count
      from buckets as bucket
      left join canonical_segments as segment
        on segment.seconds >= bucket.minimum_seconds
       and (
         bucket.maximum_seconds is null
         or segment.seconds < bucket.maximum_seconds
       )
      group by bucket.id, bucket.label, bucket.ordinal
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', id,
          'label', label,
          'count', count
        ) order by ordinal
      ),
      '[]'::jsonb
    )
    into segment_distribution
    from counted;

    select count(distinct event.task_id)::integer
    into completed_tasks
    from public.task_lifecycle_events as event
    where event.user_id = caller_id
      and event.event_type = 'completed'
      and event.occurred_at >= period_start
      and event.occurred_at < period_end;

    select
      count(*)::integer,
      count(review.id)::integer
    into terminal_sessions, reviewed_sessions
    from public.study_sessions as session
    left join public.reviews as review
      on review.session_id = session.id
     and review.user_id = caller_id
    where session.user_id = caller_id
      and not session.experiment_mode
      and session.status in ('completed', 'cancelled')
      and session.ended_at >= period_start
      and session.ended_at < period_end;

    review_coverage_percent := case
      when terminal_sessions = 0 then 0
      else round(reviewed_sessions::numeric * 100 / terminal_sessions, 1)
    end;

    with clipped_segments as (
      select
        segment.id as segment_id,
        segment.session_id,
        greatest(segment.started_at, period_start) as segment_start,
        least(private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at), period_end)
          as segment_end
      from public.session_segments as segment
      join public.study_sessions as session
        on session.id = segment.session_id
       and session.user_id = caller_id
      where segment.user_id = caller_id
        and not session.experiment_mode
        and segment.started_at < period_end
        and private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at) > period_start
        and least(private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at), period_end)
          >= greatest(segment.started_at, period_start) + interval '2 minutes'
    ), bucket_definitions(id, label, ordinal) as (
      values
        ('morning', '早晨 05–11', 1),
        ('midday', '中午 11–14', 2),
        ('afternoon', '下午 14–18', 3),
        ('evening', '晚间 18–24', 4),
        ('night', '凌晨 00–05', 5)
    ), absolute_bucket_ranges as (
      select *
      from private.insight_bucket_ranges(
        period_start, period_end, selected_timezone
      )
    ), absolute_minute_chunks as (
      select
        segment.segment_id,
        segment.session_id,
        bucket.bucket_id,
        greatest(segment.segment_start, bucket.bucket_start) as chunk_start,
        least(segment.segment_end, bucket.bucket_end) as chunk_end
      from clipped_segments as segment
      join absolute_bucket_ranges as bucket
        on bucket.bucket_start < segment.segment_end
       and bucket.bucket_end > segment.segment_start
    ), categorized as (
      select
        chunk.segment_id,
        chunk.session_id,
        chunk.chunk_start,
        chunk.chunk_end,
        floor(extract(epoch from (chunk.chunk_end - chunk.chunk_start)))
          ::integer as seconds,
        session.task_outcome,
        review.id is not null as reviewed,
        review.self_rating,
        chunk.bucket_id
      from absolute_minute_chunks as chunk
      join public.study_sessions as session
        on session.id = chunk.session_id
       and session.user_id = caller_id
      left join public.reviews as review
        on review.session_id = chunk.session_id
       and review.user_id = caller_id
      where chunk.chunk_end > chunk.chunk_start
    ), bucket_ranges as (
      select
        bucket_id,
        unnest(range_agg(tstzrange(chunk_start, chunk_end, '[)')))
          as active_range
      from categorized
      group by bucket_id
    ), bucket_duration as (
      select
        bucket_id,
        count(*)::integer as segment_count,
        coalesce(sum(floor(extract(
          epoch from (upper(active_range) - lower(active_range))
        ))), 0)::bigint as actual_seconds
      from bucket_ranges
      group by bucket_id
    ), per_session_bucket as (
      select
        session_id,
        bucket_id,
        count(distinct segment_id)::integer as segment_count,
        sum(seconds)::bigint as actual_seconds,
        bool_or(reviewed) as reviewed,
        max(self_rating) as self_rating,
        max(task_outcome) as task_outcome
      from categorized
      group by session_id, bucket_id
    ), ranked_session_buckets as (
      select
        segment.*,
        row_number() over (
          partition by segment.session_id
          order by segment.actual_seconds desc, definition.ordinal
        ) as primary_rank
      from per_session_bucket as segment
      join bucket_definitions as definition on definition.id = segment.bucket_id
    ), summarized as (
      select
        definition.id,
        definition.label,
        definition.ordinal,
        coalesce(max(duration.segment_count), 0)::integer as segment_count,
        coalesce(max(duration.actual_seconds), 0)::bigint as actual_seconds,
        count(*) filter (
          where segment.primary_rank = 1 and segment.reviewed
        )::integer as reviewed_count,
        round(
          (
            avg(segment.self_rating) filter (
              where segment.primary_rank = 1 and segment.reviewed
            )
          )::numeric,
          1
        ) as average_rating,
        count(*) filter (
          where segment.primary_rank = 1 and segment.task_outcome is not null
        )::integer as outcome_count,
        count(*) filter (
          where segment.primary_rank = 1
            and segment.task_outcome = 'completed'
        )::integer as completed_count
      from bucket_definitions as definition
      left join ranked_session_buckets as segment
        on segment.bucket_id = definition.id
      left join bucket_duration as duration
        on duration.bucket_id = definition.id
      group by definition.id, definition.label, definition.ordinal
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', summary.id,
          'label', summary.label,
          'segment_count', summary.segment_count,
          'actual_seconds', summary.actual_seconds,
          'reviewed_count', summary.reviewed_count,
          'average_rating', summary.average_rating,
          'outcome_count', summary.outcome_count,
          'completion_percent', case
            when summary.outcome_count = 0 then null
            else round(
              summary.completed_count::numeric * 100 / summary.outcome_count,
              1
            )
          end
        ) order by summary.ordinal
      ),
      '[]'::jsonb
    )
    into time_buckets
    from summarized as summary;

    with eligible_segments as (
      select
        segment.session_id,
        greatest(segment.started_at, period_start) as segment_start,
        least(private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at), period_end)
          as segment_end
      from public.session_segments as segment
      join public.study_sessions as session
        on session.id = segment.session_id
       and session.user_id = caller_id
      where segment.user_id = caller_id
        and not session.experiment_mode
        and segment.started_at < period_end
        and private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at) > period_start
        and least(private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at), period_end)
          >= greatest(segment.started_at, period_start) + interval '2 minutes'
    ), clipped_runs as (
      -- Observation coverage is the intersection with eligible study time.
      -- This prevents a short camera-only fragment from producing evidence
      -- while actual_seconds remains zero.
      select
        greatest(run.started_at, segment.segment_start) as run_start,
        least(
          private.insight_effective_end(
            run.started_at,
            run.ended_at,
            run.last_observed_at,
            generated_at
          ),
          segment.segment_end
        ) as run_end
      from public.observation_runs as run
      join public.study_sessions as session
        on session.id = run.session_id
       and session.user_id = caller_id
      join eligible_segments as segment
        on segment.session_id = run.session_id
       and run.started_at < segment.segment_end
       and private.insight_effective_end(run.started_at, run.ended_at, run.last_observed_at, generated_at) > segment.segment_start
      where run.user_id = caller_id
        and not run.experiment_mode
        and not session.experiment_mode
    ), valid_runs as (
      select run_start, run_end
      from clipped_runs
      where run_end > run_start
    ), canonical_runs as (
      select unnest(
        range_agg(tstzrange(run_start, run_end, '[)'))
      ) as observed_range
      from valid_runs
    )
    select coalesce(sum(floor(extract(
      epoch from (upper(observed_range) - lower(observed_range))
    ))), 0)::bigint
    into observed_seconds
    from canonical_runs;

    observation_coverage_percent := case
      when actual_seconds = 0 then 0
      else least(100, round(observed_seconds::numeric * 100 / actual_seconds, 1))
    end;

    select count(*)::integer
    into confirmed_events
    from public.behavior_events as event
    join public.study_sessions as session
      on session.id = event.session_id
     and session.user_id = caller_id
    where event.user_id = caller_id
      and event.source = 'vision'
      and not session.experiment_mode
      and event.started_at >= period_start
      and event.started_at < period_end
      and exists (
        select 1
        from public.session_segments as segment
        where segment.user_id = caller_id
          and segment.session_id = event.session_id
          and segment.started_at < period_end
          and private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at) > period_start
          and least(private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at), period_end)
            >= greatest(segment.started_at, period_start) + interval '2 minutes'
          and event.started_at >= greatest(segment.started_at, period_start)
          and event.started_at
            < least(private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at), period_end)
      )
      and exists (
        select 1
        from public.observation_runs as run
        where run.user_id = caller_id
          and run.session_id = event.session_id
          and not run.experiment_mode
          and event.started_at >= run.started_at
          and event.started_at < private.insight_effective_end(run.started_at, run.ended_at, run.last_observed_at, generated_at)
      )
      and (
        event.review_status = 'confirmed'
        or (
          event.review_status = 'corrected'
          and event.corrected_type in (
            'face_absent',
            'head_direction_change'
          )
        )
      );

    confirmed_events_per_hour := case
      when observed_seconds = 0 then 0
      else round(confirmed_events::numeric * 3600 / observed_seconds, 2)
    end;

    select jsonb_build_object(
      'none', count(*) filter (where reminder.response = 'none'),
      'dismissed', count(*) filter (where reminder.response = 'dismissed'),
      'back_to_task', count(*) filter (where reminder.response = 'back_to_task'),
      'normal_activity', count(*) filter (where reminder.response = 'normal_activity'),
      'not_needed', count(*) filter (where reminder.response = 'not_needed'),
      'later', count(*) filter (where reminder.response = 'later')
    )
    into reminder_responses
    from public.reminder_events as reminder
    join public.study_sessions as session
      on session.id = reminder.session_id
     and session.user_id = caller_id
    where reminder.user_id = caller_id
      and not session.experiment_mode
      and reminder.shown_at >= period_start
      and reminder.shown_at < period_end
      and exists (
        select 1
        from public.session_segments as segment
        where segment.user_id = caller_id
          and segment.session_id = reminder.session_id
          and segment.started_at < period_end
          and private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at) > period_start
          and least(private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at), period_end)
            >= greatest(segment.started_at, period_start) + interval '2 minutes'
          and reminder.shown_at >= greatest(segment.started_at, period_start)
          and reminder.shown_at
            < least(private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at), period_end)
      );

    with markers as (
      select marker.id, marker.session_id, marker.started_at
      from public.behavior_events as marker
      join public.study_sessions as session
        on session.id = marker.session_id
       and session.user_id = caller_id
      where marker.user_id = caller_id
        and marker.source = 'manual'
        and marker.event_type = 'manual'
        and not (
          marker.review_status = 'corrected'
          and marker.corrected_type = 'not_relevant'
        )
        and not session.experiment_mode
        and marker.started_at >= evidence_start
        and marker.started_at < evidence_end
        and exists (
          select 1
          from public.session_segments as segment
          where segment.user_id = caller_id
            and segment.session_id = marker.session_id
            and segment.started_at < evidence_end
            and private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at) > evidence_start
            and least(private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at), evidence_end)
              >= greatest(segment.started_at, evidence_start)
                + interval '2 minutes'
            and marker.started_at
              >= greatest(segment.started_at, evidence_start)
            and marker.started_at
              < least(private.insight_effective_end(segment.started_at, segment.ended_at, session.updated_at, generated_at), evidence_end)
        )
    )
    select
      count(*)::integer,
      count(*) filter (
        where exists (
          select 1
          from public.behavior_events as signal
          join public.study_sessions as signal_session
            on signal_session.id = signal.session_id
           and signal_session.user_id = caller_id
          where signal.user_id = caller_id
            and signal.session_id = marker.session_id
            and signal.source = 'vision'
            and signal.started_at >= marker.started_at - interval '5 minutes'
            and signal.started_at <= marker.started_at
            and exists (
              select 1
              from public.session_segments as signal_segment
              where signal_segment.user_id = caller_id
                and signal_segment.session_id = signal.session_id
                and signal_segment.started_at < evidence_end
                and private.insight_effective_end(signal_segment.started_at, signal_segment.ended_at, signal_session.updated_at, generated_at)
                  > evidence_start
                and least(
                  private.insight_effective_end(signal_segment.started_at, signal_segment.ended_at, signal_session.updated_at, generated_at),
                  evidence_end
                ) >= greatest(signal_segment.started_at, evidence_start)
                  + interval '2 minutes'
                and signal.started_at
                  >= greatest(signal_segment.started_at, evidence_start)
                and signal.started_at < least(
                  private.insight_effective_end(signal_segment.started_at, signal_segment.ended_at, signal_session.updated_at, generated_at),
                  evidence_end
                )
            )
            and exists (
              select 1
              from public.observation_runs as signal_run
              where signal_run.user_id = caller_id
                and signal_run.session_id = signal.session_id
                and not signal_run.experiment_mode
                and signal.started_at >= signal_run.started_at
                and signal.started_at
                  < private.insight_effective_end(signal_run.started_at, signal_run.ended_at, signal_run.last_observed_at, generated_at)
            )
            and (
              signal.review_status = 'confirmed'
              or (
                signal.review_status = 'corrected'
                and signal.corrected_type in (
                  'face_absent',
                  'head_direction_change'
                )
              )
            )
        )
      )::integer
    into manual_markers, correlated_markers
    from markers as marker;

    precursor_percent := case
      when manual_markers = 0 then 0
      else round(correlated_markers::numeric * 100 / manual_markers, 1)
    end;
  end if;

  return jsonb_build_object(
    'enabled', selected_enabled,
    'generated_at', generated_at,
    'data_coverage', jsonb_build_object(
      'complete', period_complete,
      'global_truncated', facts_truncated,
      'period_complete', period_complete,
      'recommendation_evidence_complete',
        recommendation_evidence_complete,
      'first_truncated_at', first_truncated_at,
      'last_truncated_at', last_truncated_at,
      'dropped_counts', fact_dropped_counts
    ),
    'period', jsonb_build_object(
      'days', p_days,
      'timezone', selected_timezone,
      'start_at', period_start,
      'end_at', period_end
    ),
    'overview', jsonb_build_object(
      'active_days', active_days,
      'completed_tasks', completed_tasks,
      'actual_seconds', actual_seconds,
      'reviewed_sessions', reviewed_sessions,
      'terminal_sessions', terminal_sessions,
      'review_coverage_percent', review_coverage_percent
    ),
    'segments', jsonb_build_object(
      'eligible_count', eligible_segments,
      'median_seconds', median_segment_seconds,
      'backfilled_count', backfilled_segments,
      'distribution', segment_distribution
    ),
    'time_buckets', time_buckets,
    'observation', jsonb_build_object(
      'observed_seconds', observed_seconds,
      'coverage_percent', observation_coverage_percent,
      'confirmed_event_count', confirmed_events,
      'confirmed_events_per_hour', confirmed_events_per_hour,
      'reminder_responses', coalesce(reminder_responses, '{}'::jsonb)
    ),
    'precursor', jsonb_build_object(
      'evidence_window_days', 30,
      'manual_marker_count', manual_markers,
      'correlated_marker_count', correlated_markers,
      'correlated_percent', precursor_percent
    ),
    'readiness', jsonb_build_object(
      'evidence_window_days', 30,
      'evidence_eligible_segments', evidence_eligible_segments,
      'evidence_active_days', evidence_active_days,
      'evidence_median_seconds', evidence_median_segment_seconds,
      'patterns_ready',
        evidence_eligible_segments >= 20 and evidence_active_days >= 10,
      'required_segments', 20,
      'required_active_days', 10,
      'precursor_ready', manual_markers >= 10,
      'required_manual_markers', 10
    )
  );
end;
$$;

revoke all on function public.get_my_insights(integer)
  from public, anon, authenticated;
grant execute on function public.get_my_insights(integer)
  to authenticated;

comment on function public.get_my_insights(integer) is
  'Returns only auth.uid() aggregate study evidence for a 7 or 30 day window; no camera frames, landmarks, or biometric data.';

notify pgrst, 'reload schema';
