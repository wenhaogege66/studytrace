-- StudyTrace factual-insights acceptance tests.
-- Run only against an isolated/local database. Every fixture is rolled back.

begin;

do $$
declare
  fact_table text;
begin
  foreach fact_table in array array[
    'public.session_segments',
    'public.observation_runs',
    'public.task_lifecycle_events',
    'public.task_step_events'
  ] loop
    if has_table_privilege('anon', fact_table, 'select')
      or has_table_privilege('authenticated', fact_table, 'select')
      or has_table_privilege(
        'authenticated', fact_table,
        'insert,update,delete,truncate,references,trigger'
      )
    then
      raise exception 'raw insight facts are exposed through %', fact_table;
    end if;
  end loop;

  if has_function_privilege(
    'anon', 'public.get_my_insights(integer)', 'execute'
  ) or not has_function_privilege(
    'authenticated', 'public.get_my_insights(integer)', 'execute'
  ) or has_function_privilege(
    'anon', 'public.respond_to_reminder(uuid,text)', 'execute'
  ) or not has_function_privilege(
    'authenticated', 'public.respond_to_reminder(uuid,text)', 'execute'
  ) then
    raise exception 'insight RPC grants are unsafe';
  end if;

  if has_table_privilege('authenticated', 'public.reminder_events', 'update') then
    raise exception 'reminder responses must only change through their RPC';
  end if;

  if position(
    'pg_advisory_xact_lock' in pg_get_functiondef(
      'private.limit_insight_fact_growth()'::regprocedure
    )
  ) = 0 then
    raise exception 'fact quotas are not serialized against concurrent writes';
  end if;
end;
$$;

insert into auth.users (
  id, aud, role, email, encrypted_password, raw_app_meta_data,
  raw_user_meta_data, is_anonymous, email_confirmed_at, last_sign_in_at,
  created_at, updated_at
)
values
  (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'authenticated', 'authenticated', null, '',
    '{"provider":"anonymous","providers":["anonymous"]}', '{}', true,
    null, clock_timestamp(), clock_timestamp(), clock_timestamp()
  ),
  (
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'authenticated', 'authenticated', 'insights-target@example.com', '',
    '{"provider":"email","providers":["email"]}', '{}', false,
    clock_timestamp(), clock_timestamp(), clock_timestamp(), clock_timestamp()
  );

insert into auth.sessions (id, user_id, created_at, updated_at)
values (
  '66000000-0000-4000-8000-000000000001',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  clock_timestamp(), clock_timestamp()
);

insert into public.user_settings (user_id)
values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff');

-- Build one source account through the real session RPCs. Consecutive writes
-- in this transaction must use clock_timestamp(), not transaction-start now(),
-- or these derived intervals would collapse to zero length.
set local role authenticated;
select set_config(
  'request.jwt.claim.sub', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'role', 'authenticated',
    'session_id', '66000000-0000-4000-8000-000000000001',
    'amr', jsonb_build_array(
      jsonb_build_object(
        'method', 'anonymous',
        'timestamp', floor(extract(epoch from clock_timestamp()))::bigint
      )
    )
  )::text,
  true
);

insert into public.tasks (
  id, user_id, title, steps, priority, estimated_minutes
)
values (
  '61000000-0000-4000-8000-000000000001',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '待合并的投入记录',
  '[{"id":"source-step","title":"第一步","completed":false}]',
  'medium', 30
);

select public.start_study_session(
  '61000000-0000-4000-8000-000000000001', true, true
);

select public.set_study_session_camera(
  (select id from public.study_sessions
   where task_id = '61000000-0000-4000-8000-000000000001'
     and status = 'running'),
  0, 1, true
);
select pg_catalog.pg_sleep(0.01);
select public.set_study_session_camera(
  (select id from public.study_sessions
   where task_id = '61000000-0000-4000-8000-000000000001'
     and status = 'running'),
  0, 2, false
);
select public.pause_study_session(
  (select id from public.study_sessions
   where task_id = '61000000-0000-4000-8000-000000000001'
     and status = 'running'),
  0, 0
);
select public.cancel_study_session(
  (select id from public.study_sessions
   where task_id = '61000000-0000-4000-8000-000000000001'
     and status = 'paused'),
  0
);

select public.set_task_step_completed(
  '61000000-0000-4000-8000-000000000001', 'source-step', true
);
select public.set_task_step_completed(
  '61000000-0000-4000-8000-000000000001', 'source-step', false
);

reset role;

do $$
begin
  if not exists (
    select 1
    from public.session_segments as segment
    join public.study_sessions as session on session.id = segment.session_id
    where session.task_id = '61000000-0000-4000-8000-000000000001'
      and segment.ended_at > segment.started_at
  ) then
    raise exception 'a runtime segment did not preserve elapsed wall time';
  end if;

  if not exists (
    select 1
    from public.observation_runs as run
    join public.study_sessions as session on session.id = run.session_id
    where session.task_id = '61000000-0000-4000-8000-000000000001'
      and run.ended_at > run.started_at
  ) then
    raise exception 'a camera run did not preserve elapsed wall time';
  end if;

  if not exists (
    select 1 from public.task_lifecycle_events
    where task_id = '61000000-0000-4000-8000-000000000001'
      and event_type = 'ready_to_complete'
  ) or not exists (
    select 1 from public.task_lifecycle_events
    where task_id = '61000000-0000-4000-8000-000000000001'
      and event_type = 'completion_reopened'
  ) or not exists (
    select 1 from public.task_step_events
    where task_id = '61000000-0000-4000-8000-000000000001'
      and event_type = 'added'
      and previous_title is null
      and next_title = '第一步'
  ) or not exists (
    select 1 from public.task_step_events
    where task_id = '61000000-0000-4000-8000-000000000001'
      and event_type = 'completed'
  ) or not exists (
    select 1 from public.task_step_events
    where task_id = '61000000-0000-4000-8000-000000000001'
      and event_type = 'reopened'
  ) then
    raise exception 'step/lifecycle history is incomplete';
  end if;
end;
$$;

-- Add a deterministic ten-minute source segment. The tiny runtime segment is
-- still preserved but excluded by the two-minute evidence rule.
select set_config(
  'request.jwt.claim.sub', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', true
);
insert into public.study_sessions (
  id, user_id, task_id, status, accumulated_seconds, started_at, ended_at,
  task_outcome
)
values (
  '62000000-0000-4000-8000-000000000001',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '61000000-0000-4000-8000-000000000001',
  'cancelled', 600,
  clock_timestamp() - interval '20 minutes',
  clock_timestamp() - interval '10 minutes',
  'not_completed'
);
insert into public.session_segments (
  user_id, session_id, started_at, ended_at
)
values (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '62000000-0000-4000-8000-000000000001',
  clock_timestamp() - interval '20 minutes',
  clock_timestamp() - interval '10 minutes'
);
insert into public.observation_runs (
  user_id, session_id, started_at, ended_at, observation_profile,
  detector_version
)
values (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '62000000-0000-4000-8000-000000000001',
  clock_timestamp() - interval '20 minutes',
  clock_timestamp() - interval '15 minutes',
  'study_screen_v1', 'test-source'
);

-- Target fixtures: ten reviewed sessions on ten different days, each with two
-- eligible segments in one bucket. This catches review/outcome multiplication.
select set_config(
  'request.jwt.claim.sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff', true
);
insert into public.tasks (
  id, user_id, title, steps, priority, estimated_minutes, created_at
)
values (
  '61000000-0000-4000-8000-000000000002',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '长期规律样本',
  '[{"id":"target-step","title":"记录","completed":false}]',
  'high', 45, clock_timestamp() - interval '20 days'
);
select public.set_task_step_completed(
  '61000000-0000-4000-8000-000000000002', 'target-step', true
);
update public.tasks
set status = 'completed', completed_at = clock_timestamp() - interval '1 day'
where id = '61000000-0000-4000-8000-000000000002';
update public.tasks
set status = 'in_progress', completed_at = null
where id = '61000000-0000-4000-8000-000000000002';
select public.set_task_step_completed(
  '61000000-0000-4000-8000-000000000002', 'target-step', false
);

do $$
declare
  local_today date := (
    clock_timestamp() at time zone 'Asia/Shanghai'
  )::date;
  day_offset integer;
  local_day date;
  first_start timestamptz;
  second_start timestamptz;
  session_id uuid;
  outcome text;
begin
  for day_offset in 2..11 loop
    local_day := local_today - day_offset;
    first_start := (local_day::timestamp + interval '9 hours')
      at time zone 'Asia/Shanghai';
    second_start := (
      local_day::timestamp + interval '9 hours 25 minutes'
    ) at time zone 'Asia/Shanghai';
    outcome := case
      when day_offset % 2 = 0 then 'completed'
      else 'partially_completed'
    end;

    insert into public.study_sessions (
      user_id, task_id, status, accumulated_seconds, started_at, ended_at,
      task_outcome
    ) values (
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '61000000-0000-4000-8000-000000000002',
      'completed', 2400, first_start,
      second_start + interval '20 minutes', outcome
    ) returning id into session_id;

    insert into public.session_segments (
      user_id, session_id, started_at, ended_at
    ) values
      (
        'ffffffff-ffff-4fff-8fff-ffffffffffff', session_id,
        first_start, first_start + interval '20 minutes'
      ),
      (
        'ffffffff-ffff-4fff-8fff-ffffffffffff', session_id,
        second_start, second_start + interval '20 minutes'
      );

    insert into public.reviews (
      user_id, session_id, completion_status, self_rating
    ) values (
      'ffffffff-ffff-4fff-8fff-ffffffffffff', session_id, outcome,
      case when outcome = 'completed' then 5 else 3 end
    );
  end loop;
end;
$$;

-- One four-minute segment straddles local midnight. Its duration is split into
-- evening/night buckets, while both natural dates count as active.
insert into public.study_sessions (
  id, user_id, task_id, status, accumulated_seconds, started_at, ended_at,
  task_outcome
)
select
  '62000000-0000-4000-8000-000000000002',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '61000000-0000-4000-8000-000000000002',
  'cancelled', 240,
  ((local_today - 1)::timestamp + interval '23 hours 58 minutes')
    at time zone 'Asia/Shanghai',
  (local_today::timestamp + interval '2 minutes')
    at time zone 'Asia/Shanghai',
  'partially_completed'
from (
  select (clock_timestamp() at time zone 'Asia/Shanghai')::date as local_today
) as anchor;
insert into public.reviews (
  user_id, session_id, completion_status, self_rating
)
values (
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '62000000-0000-4000-8000-000000000002',
  'partially_completed', 2
);
insert into public.session_segments (
  user_id, session_id, started_at, ended_at
)
select
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '62000000-0000-4000-8000-000000000002',
  ((local_today - 1)::timestamp + interval '23 hours 58 minutes')
    at time zone 'Asia/Shanghai',
  (local_today::timestamp + interval '2 minutes')
    at time zone 'Asia/Shanghai'
from (
  select (clock_timestamp() at time zone 'Asia/Shanghai')::date as local_today
) as anchor;

-- A one-minute fragment and a thirty-minute experiment must not affect the
-- effective evidence pool.
insert into public.study_sessions (
  id, user_id, task_id, status, accumulated_seconds, started_at, ended_at,
  experiment_mode
)
select
  id, 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '61000000-0000-4000-8000-000000000002', 'cancelled', seconds,
  start_at, start_at + make_interval(secs => seconds), experiment_mode
from (
  values
    (
      '62000000-0000-4000-8000-000000000003'::uuid,
      60, clock_timestamp() - interval '3 hours', false
    ),
    (
      '62000000-0000-4000-8000-000000000004'::uuid,
      1800, clock_timestamp() - interval '2 hours', true
    )
) as fixture(id, seconds, start_at, experiment_mode);
insert into public.session_segments (
  user_id, session_id, started_at, ended_at
)
select
  'ffffffff-ffff-4fff-8fff-ffffffffffff', session.id,
  session.started_at, session.ended_at
from public.study_sessions as session
where session.id in (
  '62000000-0000-4000-8000-000000000003',
  '62000000-0000-4000-8000-000000000004'
);

-- Ten explicit user markers, each preceded by a confirmed visual signal, are
-- enough to report a co-occurrence ratio without calling it causality. They are
-- written while the parent is active, then the exact 20-minute session is ended.
insert into public.study_sessions (
  id,
  user_id,
  task_id,
  status,
  accumulated_seconds,
  started_at,
  resumed_at
)
select
  '62000000-0000-4000-8000-000000000005',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '61000000-0000-4000-8000-000000000002',
  'running',
  0,
  local_start,
  local_start
from (
  select (
    (clock_timestamp() at time zone 'Asia/Shanghai')::date::timestamp
      + interval '5 hours'
  ) at time zone 'Asia/Shanghai' as local_start
) as anchor;

insert into public.observation_runs (
  user_id, session_id, started_at, ended_at, observation_profile,
  detector_version
)
select
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '62000000-0000-4000-8000-000000000005',
  local_start,
  local_start + interval '10 minutes',
  'study_screen_v1',
  'test-target'
from (
  select (
    (clock_timestamp() at time zone 'Asia/Shanghai')::date::timestamp
      + interval '5 hours'
  ) at time zone 'Asia/Shanghai' as local_start
) as anchor;

do $$
declare
  marker_index integer;
  marker_at timestamptz;
  local_start timestamptz := (
    (clock_timestamp() at time zone 'Asia/Shanghai')::date::timestamp
      + interval '5 hours'
  ) at time zone 'Asia/Shanghai';
begin
  for marker_index in 1..10 loop
    marker_at := local_start + make_interval(mins => marker_index);
    insert into public.behavior_events (
      user_id, session_id, event_type, direction, source, started_at,
      ended_at, review_status
    ) values (
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '62000000-0000-4000-8000-000000000005',
      'head_direction_change', 'left', 'vision',
      marker_at - interval '30 seconds', marker_at - interval '15 seconds',
      'confirmed'
    );
    insert into public.behavior_events (
      user_id, session_id, event_type, source, started_at, ended_at,
      review_status
    ) values (
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '62000000-0000-4000-8000-000000000005',
      'manual', 'manual', marker_at, marker_at, 'confirmed'
    );
  end loop;
end;
$$;

update public.study_sessions
set
  status = 'cancelled',
  accumulated_seconds = 1200,
  resumed_at = null,
  ended_at = started_at + interval '20 minutes',
  task_outcome = null
where id = '62000000-0000-4000-8000-000000000005';

-- Negative evidence fixture: these otherwise valid-looking facts belong to an
-- actual one-minute work block and must be absent from every insight metric.
insert into public.study_sessions (
  id, user_id, task_id, status, accumulated_seconds, started_at, resumed_at
)
values (
  '62000000-0000-4000-8000-000000000006',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '61000000-0000-4000-8000-000000000002',
  'running', 0, clock_timestamp() - interval '1 minute',
  clock_timestamp() - interval '1 minute'
);
insert into public.observation_runs (
  user_id, session_id, started_at, ended_at, observation_profile,
  detector_version
)
values (
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '62000000-0000-4000-8000-000000000006',
  clock_timestamp() - interval '1 minute', clock_timestamp(),
  'study_screen_v1', 'fragment-test'
);
insert into public.behavior_events (
  user_id, session_id, event_type, direction, source, started_at, ended_at,
  review_status
)
values (
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '62000000-0000-4000-8000-000000000006',
  'head_direction_change', 'right', 'vision',
  clock_timestamp() - interval '30 seconds',
  clock_timestamp() - interval '20 seconds', 'confirmed'
), (
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '62000000-0000-4000-8000-000000000006',
  'manual', null, 'manual',
  clock_timestamp() - interval '10 seconds',
  clock_timestamp() - interval '10 seconds', 'confirmed'
);
insert into public.reminder_events (
  user_id, session_id, shown_at, response
)
values (
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '62000000-0000-4000-8000-000000000006',
  clock_timestamp() - interval '5 seconds', 'back_to_task'
);
update public.study_sessions
set
  status = 'cancelled',
  accumulated_seconds = 60,
  resumed_at = null,
  ended_at = clock_timestamp(),
  task_outcome = 'not_completed'
where id = '62000000-0000-4000-8000-000000000006';

insert into public.reminder_events (
  id, user_id, session_id, shown_at, response
)
select
  fixture.id,
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  session.id,
  session.started_at + make_interval(mins => fixture.minute_offset),
  fixture.response
from public.study_sessions as session
cross join (
  values
    (
      '65000000-0000-4000-8000-000000000001'::uuid,
      2,
      'back_to_task'
    ),
    (
      '65000000-0000-4000-8000-000000000002'::uuid,
      3,
      'normal_activity'
    ),
    (
      '65000000-0000-4000-8000-000000000003'::uuid,
      4,
      'not_needed'
    ),
    (
      '65000000-0000-4000-8000-000000000004'::uuid,
      5,
      'later'
    ),
    (
      '65000000-0000-4000-8000-000000000005'::uuid,
      6,
      'dismissed'
    ),
    (
      '65000000-0000-4000-8000-000000000006'::uuid,
      7,
      'none'
    )
) as fixture(id, minute_offset, response)
where session.id = '62000000-0000-4000-8000-000000000005';

-- Raw facts stay inaccessible, while owner-safe aggregate/response RPCs work.
set local role authenticated;
select set_config(
  'request.jwt.claim.sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff', true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'role', 'authenticated'
  )::text,
  true
);

do $$
declare
  raw_select_blocked boolean := false;
  direct_response_blocked boolean := false;
  saved_response public.reminder_events;
begin
  begin
    perform 1 from public.session_segments limit 1;
  exception when insufficient_privilege then
    raw_select_blocked := true;
  end;
  if not raw_select_blocked then
    raise exception 'authenticated selected raw session facts';
  end if;

  select * into saved_response
  from public.respond_to_reminder(
    '65000000-0000-4000-8000-000000000006', 'normal_activity'
  );
  if saved_response.response <> 'normal_activity'
    or saved_response.responded_at is null
  then
    raise exception 'reminder response was not timestamped by the server';
  end if;

  select * into saved_response
  from public.respond_to_reminder(
    '65000000-0000-4000-8000-000000000006', 'back_to_task'
  );
  if saved_response.response <> 'normal_activity' then
    raise exception 'a saved reminder response was overwritten';
  end if;

  begin
    update public.reminder_events
    set shown_at = clock_timestamp()
    where id = '65000000-0000-4000-8000-000000000006';
  exception when insufficient_privilege then
    direct_response_blocked := true;
  end;
  if not direct_response_blocked then
    raise exception 'browser role bypassed the reminder response RPC';
  end if;

  begin
    perform public.get_my_insights(14);
    raise exception 'unsupported insight window was accepted';
  exception when invalid_parameter_value then
    null;
  end;
end;
$$;

do $$
declare
  report_30 jsonb := public.get_my_insights(30);
  report_7 jsonb := public.get_my_insights(7);
  morning jsonb;
  evening jsonb;
  night jsonb;
begin
  select value into morning
  from jsonb_array_elements(report_30->'time_buckets')
  where value->>'id' = 'morning';
  select value into evening
  from jsonb_array_elements(report_30->'time_buckets')
  where value->>'id' = 'evening';
  select value into night
  from jsonb_array_elements(report_30->'time_buckets')
  where value->>'id' = 'night';

  if report_30 ? 'user_id'
    or (report_30->'overview'->>'actual_seconds')::bigint <> 25440
    or (report_30->'overview'->>'active_days')::integer <> 12
    or (report_30->'overview'->>'completed_tasks')::integer <> 1
    or (report_30->'segments'->>'eligible_count')::integer <> 22
    or (report_30->'segments'->>'median_seconds')::integer <> 1200
  then
    raise exception '30-day aggregate/exclusion result is wrong: %', report_30;
  end if;

  if (report_30->'overview'->>'terminal_sessions')::integer <> 14
    or (report_30->'overview'->>'reviewed_sessions')::integer <> 11
    or (report_30->'overview'->>'review_coverage_percent')::numeric <> 78.6
  then
    raise exception 'review coverage is wrong: %', report_30->'overview';
  end if;

  if (morning->>'segment_count')::integer <> 21
    or (morning->>'reviewed_count')::integer <> 10
    or (morning->>'outcome_count')::integer <> 10
    or (morning->>'completion_percent')::numeric <> 50.0
    or (morning->>'actual_seconds')::bigint <> 25200
  then
    raise exception 'session/bucket facts were multiplied: %', morning;
  end if;

  if (evening->>'actual_seconds')::bigint <> 120
    or (night->>'actual_seconds')::bigint <> 120
    or (evening->>'reviewed_count')::integer <> 1
    or (evening->>'outcome_count')::integer <> 1
    or (evening->>'completion_percent')::numeric <> 0
    or (night->>'reviewed_count')::integer <> 0
    or (night->>'outcome_count')::integer <> 0
    or (night->>'completion_percent') is not null
  then
    raise exception 'cross-midnight duration/facts were not assigned once: %, %',
      evening, night;
  end if;

  if (report_30->'observation'->>'observed_seconds')::bigint <> 600
    or (report_30->'observation'->>'confirmed_event_count')::integer <> 10
    or (report_30->'observation'->>'confirmed_events_per_hour')::numeric <> 60
    or (report_30->'observation'->'reminder_responses'->>'normal_activity')::integer <> 2
    or (report_30->'observation'->'reminder_responses'->>'none')::integer <> 0
  then
    raise exception 'observation/reminder evidence is wrong: %', report_30->'observation';
  end if;

  if (report_30->'precursor'->>'manual_marker_count')::integer <> 10
    or (report_30->'precursor'->>'correlated_marker_count')::integer <> 10
    or (report_30->'readiness'->>'patterns_ready')::boolean is not true
    or (report_30->'readiness'->>'precursor_ready')::boolean is not true
    or (report_30->'readiness'->>'evidence_eligible_segments')::integer <> 22
    or (report_30->'readiness'->>'evidence_active_days')::integer <> 12
  then
    raise exception '30-day readiness/precursor pool is wrong: %', report_30;
  end if;

  if (report_7->'period'->>'days')::integer <> 7
    or (report_7->'overview'->>'actual_seconds')::bigint <> 13440
    or (report_7->'overview'->>'active_days')::integer <> 7
    or (report_7->'segments'->>'eligible_count')::integer <> 12
    or (report_7->'readiness'->>'evidence_eligible_segments')::integer <> 22
    or (report_7->'readiness'->>'evidence_active_days')::integer <> 12
    or (report_7->'readiness'->>'patterns_ready')::boolean is not true
  then
    raise exception '7-day display and 30-day evidence pools were mixed: %', report_7;
  end if;
end;
$$;

-- Period boundaries use natural days in the selected IANA timezone.
select public.update_my_insights_preferences(true, 'America/New_York');
do $$
declare
  report jsonb := public.get_my_insights(7);
  local_today date := (
    clock_timestamp() at time zone 'America/New_York'
  )::date;
  invalid_timezone_blocked boolean := false;
begin
  if ((report->'period'->>'start_at')::timestamptz
      at time zone 'America/New_York')::date <> local_today - 6
    or ((report->'period'->>'end_at')::timestamptz
      at time zone 'America/New_York')::date <> local_today + 1
  then
    raise exception 'the report did not use local natural-day boundaries';
  end if;

  begin
    perform public.update_my_insights_preferences(true, 'Mars/Olympus');
  exception when invalid_parameter_value then
    invalid_timezone_blocked := true;
  end;
  if not invalid_timezone_blocked then
    raise exception 'an invalid IANA timezone was stored';
  end if;
end;
$$;
select public.update_my_insights_preferences(true, 'Asia/Shanghai');

-- The source aggregate is visible only to its owner before the real merge.
select set_config(
  'request.jwt.claim.sub', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', true
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'role', 'authenticated',
    'session_id', '66000000-0000-4000-8000-000000000001',
    'amr', jsonb_build_array(
      jsonb_build_object(
        'method', 'anonymous',
        'timestamp', floor(extract(epoch from clock_timestamp()))::bigint
      )
    )
  )::text,
  true
);
do $$
begin
  if (public.get_my_insights(30)->'overview'->>'actual_seconds')::bigint <> 600
    or (public.get_my_insights(30)->'segments'->>'eligible_count')::integer <> 1
  then
    raise exception 'source aggregate is not owner scoped';
  end if;
end;
$$;
select public.prepare_account_merge(
  repeat('a', 64), 'insights-target@example.com'
);

reset role;
insert into auth.sessions (id, user_id, created_at, updated_at)
values (
  '66000000-0000-4000-8000-000000000002',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  clock_timestamp(), clock_timestamp()
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff', true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'role', 'authenticated',
    'session_id', '66000000-0000-4000-8000-000000000002',
    'amr', jsonb_build_array(
      jsonb_build_object(
        'method', 'otp',
        'timestamp', floor(extract(epoch from clock_timestamp()))::bigint
      )
    )
  )::text,
  true
);
do $$
declare
  merge_result jsonb;
  merged_report jsonb;
begin
  merge_result := public.consume_account_merge(repeat('a', 64));
  if (merge_result->>'tasks')::integer <> 1
    or (merge_result->>'sessions')::integer <> 2
  then
    raise exception 'real account merge returned wrong counts: %', merge_result;
  end if;

  merged_report := public.get_my_insights(30);
  if (merged_report->'overview'->>'actual_seconds')::bigint <> 26040
    or (merged_report->'segments'->>'eligible_count')::integer <> 23
    or (merged_report->'observation'->>'observed_seconds')::bigint <> 900
  then
    raise exception 'merged insight facts were lost or double-counted: %', merged_report;
  end if;
end;
$$;

reset role;
do $$
begin
  if exists (
    select 1 from auth.users
    where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ) or exists (
    select 1 from public.session_segments
    where user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ) or exists (
    select 1 from public.observation_runs
    where user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ) or exists (
    select 1 from public.task_lifecycle_events
    where user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ) or exists (
    select 1 from public.task_step_events
    where user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ) then
    raise exception 'account merge did not transfer every derived fact owner';
  end if;
end;
$$;

-- Exact overlap must fail for both interval fact tables.
do $$
declare
  selected_segment public.session_segments;
  selected_run public.observation_runs;
  segment_overlap_blocked boolean := false;
  run_overlap_blocked boolean := false;
begin
  select * into selected_segment
  from public.session_segments
  where session_id = '62000000-0000-4000-8000-000000000002'
  limit 1;
  begin
    insert into public.session_segments (
      user_id, session_id, started_at, ended_at
    ) values (
      selected_segment.user_id, selected_segment.session_id,
      selected_segment.started_at, selected_segment.ended_at
    );
  exception when exclusion_violation then
    segment_overlap_blocked := true;
  end;

  select * into selected_run
  from public.observation_runs
  where session_id = '62000000-0000-4000-8000-000000000005'
  limit 1;
  begin
    insert into public.observation_runs (
      user_id, session_id, started_at, ended_at, observation_profile,
      detector_version
    ) values (
      selected_run.user_id, selected_run.session_id,
      selected_run.started_at, selected_run.ended_at,
      'study_screen_v1', 'overlap-test'
    );
  exception when exclusion_violation then
    run_overlap_blocked := true;
  end;

  if not segment_overlap_blocked or not run_overlap_blocked then
    raise exception 'overlapping fact intervals were accepted';
  end if;
end;
$$;

-- A pathological session cannot grow one fact parent indefinitely. The cap
-- drops derived rows so the core lifecycle operation can still succeed.
select set_config(
  'request.jwt.claim.sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff', true
);
do $$
declare
  row_number integer;
  point_in_time timestamptz := clock_timestamp() + interval '100 days';
begin
  for row_number in 1..1005 loop
    insert into public.session_segments (
      user_id, session_id, started_at, ended_at
    ) values (
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '62000000-0000-4000-8000-000000000003',
      point_in_time + make_interval(secs => row_number),
      point_in_time + make_interval(secs => row_number)
    );
  end loop;

  if (
    select count(*) from public.session_segments
    where session_id = '62000000-0000-4000-8000-000000000003'
  ) <> 1000 then
    raise exception 'per-session fact cap was not enforced';
  end if;
end;
$$;

rollback;
