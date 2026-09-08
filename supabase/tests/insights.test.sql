-- StudyTrace factual-insights acceptance tests.
-- Run only against an isolated/local database. Every fixture is rolled back.

-- The two-connection lock-order test below needs dblink's unrestricted entry
-- point. Supabase's local `postgres` role is intentionally non-superuser, so
-- reconnect to the local-only administrative role before opening the rollback.
\connect postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres

begin;

do $$
declare
  fact_table text;
  private_function text;
  quota_definition text;
  post_owner_lock_definition text;
  owner_flow_definition text;
  checkpoint_definition text;
  observation_heartbeat_definition text;
  reminder_response_definition text;
  preference_update_definition text;
  delete_my_data_definition text;
  parent_lock_trigger_count integer;
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
  ) or has_function_privilege(
    'anon', 'public.heartbeat_observation_run(uuid,bigint,bigint)', 'execute'
  ) or not has_function_privilege(
    'authenticated',
    'public.heartbeat_observation_run(uuid,bigint,bigint)',
    'execute'
  ) then
    raise exception 'insight RPC grants are unsafe';
  end if;

  if has_table_privilege('authenticated', 'public.reminder_events', 'update') then
    raise exception 'reminder responses must only change through their RPC';
  end if;

  if has_table_privilege(
    'authenticated', 'private.insight_fact_coverage', 'select'
  ) or has_table_privilege(
    'anon', 'private.insight_fact_coverage', 'select'
  ) then
    raise exception 'private insight completeness metadata is exposed';
  end if;

  foreach private_function in array array[
    'private.lock_insight_owner(uuid)',
    'private.lock_insight_parent_flow(uuid)',
    'private.lock_account_flow_extension_resources(uuid[])',
    'private.assert_account_merge_extension_capacity(uuid,uuid)',
    'private.apply_account_merge_extension(uuid,uuid)',
    'private.insight_safe_close_at(timestamptz,timestamptz,timestamptz)',
    'private.safely_close_session_insight_facts()',
    'private.preserve_session_confirmation_on_owner_move()'
  ] loop
    if has_function_privilege('anon', private_function, 'execute')
      or has_function_privilege('authenticated', private_function, 'execute')
    then
      raise exception 'private insight function is exposed: %', private_function;
    end if;
  end loop;

  if position(
    'pg_advisory_xact_lock' in pg_get_functiondef(
      'private.lock_insight_owner(uuid)'::regprocedure
    )
  ) = 0 or position(
    'lock_insight_owner' in pg_get_functiondef(
      'private.limit_insight_fact_growth()'::regprocedure
    )
  ) = 0 then
    raise exception 'fact quotas are not serialized against concurrent writes';
  end if;

  quota_definition := lower(pg_get_functiondef(
    'private.limit_insight_fact_growth()'::regprocedure
  ));
  post_owner_lock_definition := substring(
    quota_definition from position(
      'perform private.lock_insight_owner(owner_id)' in quota_definition
    )
  );
  if position('into user_rows' in post_owner_lock_definition) = 0
    or position('into parent_rows' in post_owner_lock_definition) = 0
  then
    raise exception 'fact quota counts are read before the owner lock';
  end if;

  owner_flow_definition := lower(pg_get_functiondef(
    'private.lock_insight_parent_flow(uuid)'::regprocedure
  ));
  if position('studytrace:owner-mutation:' in owner_flow_definition) = 0
    or position('private.lock_insight_owner' in owner_flow_definition)
      < position('studytrace:owner-mutation:' in owner_flow_definition)
  then
    raise exception 'insight writes do not follow owner-before-insight order';
  end if;

  checkpoint_definition := lower(pg_get_functiondef(
    'public.checkpoint_running_session(uuid,timestamptz,integer,timestamptz)'
      ::regprocedure
  ));
  observation_heartbeat_definition := lower(pg_get_functiondef(
    'public.heartbeat_observation_run(uuid,bigint,bigint)'::regprocedure
  ));
  reminder_response_definition := lower(pg_get_functiondef(
    'public.respond_to_reminder(uuid,text)'::regprocedure
  ));
  preference_update_definition := lower(pg_get_functiondef(
    'public.update_my_insights_preferences(boolean,text)'::regprocedure
  ));
  delete_my_data_definition := lower(pg_get_functiondef(
    'public.delete_my_data()'::regprocedure
  ));
  if position('private.lock_insight_parent_flow' in checkpoint_definition) = 0
    or position('private.lock_insight_parent_flow' in checkpoint_definition)
      > position('for update' in checkpoint_definition)
    or position(
      'private.lock_insight_parent_flow' in observation_heartbeat_definition
    ) = 0
    or position(
      'private.lock_insight_parent_flow' in observation_heartbeat_definition
    ) > position('for update' in observation_heartbeat_definition)
    or position(
      'private.lock_insight_parent_flow' in reminder_response_definition
    ) = 0
    or position(
      'private.lock_insight_parent_flow' in reminder_response_definition
    ) > position('for update' in reminder_response_definition)
    or position(
      'private.lock_insight_parent_flow' in preference_update_definition
    ) = 0
    or position(
      'private.lock_insight_parent_flow' in preference_update_definition
    ) > position('update public.user_settings' in preference_update_definition)
    or position(
      'private.lock_insight_parent_flow' in delete_my_data_definition
    ) = 0
    or position(
      'private.lock_insight_parent_flow' in delete_my_data_definition
    ) > position('delete from public.reminder_events' in delete_my_data_definition)
  then
    raise exception 'PR4 lifecycle RPC acquired a row before owner/insight locks';
  end if;

  select count(*)::integer into parent_lock_trigger_count
  from pg_catalog.pg_trigger as trigger
  join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = relation.relnamespace
  where not trigger.tgisinternal
    and trigger.tgenabled = 'O'
    and namespace.nspname = 'public'
    and (
      relation.relname,
      trigger.tgname
    ) in (
      ('tasks', 'tasks_lock_insight_owner_before_write'),
      ('study_sessions', 'study_sessions_lock_insight_owner_before_write'),
      ('user_settings', 'user_settings_lock_insight_owner_before_write')
    );
  if parent_lock_trigger_count <> 3 then
    raise exception 'parent writes are missing pre-row insight locks';
  end if;
end;
$$;

-- Two real database connections exercise the lock order shared with account
-- merge. The merge-side connection holds the insight extension lock first;
-- an authenticated task INSERT must block before it acquires the task quota
-- lock. The merge can therefore take that next core lock without forming an
-- insight <-> business-quota cycle, then release both and let the INSERT finish.
create extension if not exists dblink with schema extensions;

select extensions.dblink_connect(
  'insight_merge_lock',
  'host=127.0.0.1 port=5432 dbname=postgres user=supabase_admin password=postgres'
);
select extensions.dblink_connect(
  'insight_task_writer',
  'host=127.0.0.1 port=5432 dbname=postgres user=supabase_admin password=postgres'
);

select extensions.dblink_exec(
  'insight_merge_lock',
  $$delete from auth.users
    where id = 'abababab-abab-4aba-8aba-abababababab'$$
);
select extensions.dblink_exec(
  'insight_merge_lock',
  $$insert into auth.users (
      id, aud, role, email, encrypted_password, raw_app_meta_data,
      raw_user_meta_data, is_anonymous, last_sign_in_at, created_at, updated_at
    ) values (
      'abababab-abab-4aba-8aba-abababababab',
      'authenticated', 'authenticated', null, '',
      '{"provider":"anonymous","providers":["anonymous"]}', '{}', true,
      clock_timestamp(), clock_timestamp(), clock_timestamp()
    )$$
);
select extensions.dblink_exec(
  'insight_merge_lock',
  $$insert into public.user_settings (user_id)
    values ('abababab-abab-4aba-8aba-abababababab')$$
);

select extensions.dblink_exec('insight_merge_lock', 'begin');
select extensions.dblink_exec(
  'insight_merge_lock',
  $$do $lock$
    begin
      perform private.lock_account_flow_extension_resources(
        array['abababab-abab-4aba-8aba-abababababab'::uuid]
      );
    end
  $lock$;$$
);

select extensions.dblink_exec(
  'insight_task_writer',
  $$set request.jwt.claim.sub = 'abababab-abab-4aba-8aba-abababababab'$$
);
select extensions.dblink_exec(
  'insight_task_writer',
  $$set request.jwt.claim.role = 'authenticated'$$
);
select extensions.dblink_exec(
  'insight_task_writer',
  $$set request.jwt.claims = '{"sub":"abababab-abab-4aba-8aba-abababababab","role":"authenticated"}'$$
);
select extensions.dblink_exec('insight_task_writer', 'set role authenticated');

select extensions.dblink_send_query(
  'insight_task_writer',
  $$with inserted as (
      insert into public.tasks (
        user_id, title, steps, priority, estimated_minutes
      ) values (
        'abababab-abab-4aba-8aba-abababababab',
        '并发锁序测试',
        '[{"id":"lock-step","title":"验证锁序","completed":false}]',
        'low', 5
      )
      returning id
    )
    select id::text from inserted$$
);
select pg_catalog.pg_sleep(0.1);

do $$
declare
  task_quota_key bigint := pg_catalog.hashtextextended(
    'public.tasks:abababab-abab-4aba-8aba-abababababab', 0
  );
begin
  if not pg_catalog.pg_try_advisory_lock(task_quota_key) then
    raise exception 'task INSERT acquired its business quota before insight lock';
  end if;
  perform pg_catalog.pg_advisory_unlock(task_quota_key);
end;
$$;

select extensions.dblink_exec(
  'insight_merge_lock',
  $$do $lock$
    begin
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'public.tasks:abababab-abab-4aba-8aba-abababababab', 0
        )
      );
    end
  $lock$;$$
);
select extensions.dblink_exec('insight_merge_lock', 'commit');

do $$
declare
  inserted_task_id text;
begin
  select result.id into inserted_task_id
  from extensions.dblink_get_result('insight_task_writer')
    as result(id text);
  if inserted_task_id is null then
    raise exception 'task INSERT did not resume after merge locks were released';
  end if;
end;
$$;

select extensions.dblink_exec(
  'insight_merge_lock',
  $$insert into public.study_sessions (
      id, user_id, task_id, status, accumulated_seconds, started_at,
      resumed_at, ended_at, task_outcome
    )
    select
      'abababab-2000-4aba-8aba-abababababab',
      'abababab-abab-4aba-8aba-abababababab',
      task.id,
      'cancelled',
      60,
      clock_timestamp() - interval '2 minutes',
      null,
      clock_timestamp() - interval '1 minute',
      'not_completed'
    from public.tasks as task
    where task.user_id = 'abababab-abab-4aba-8aba-abababababab'
      and task.title = '并发锁序测试'$$
);
select extensions.dblink_exec(
  'insight_merge_lock',
  $$insert into public.reminder_events (
      id, user_id, session_id, shown_at, response
    ) values (
      'abababab-3000-4aba-8aba-abababababab',
      'abababab-abab-4aba-8aba-abababababab',
      'abababab-2000-4aba-8aba-abababababab',
      clock_timestamp(),
      'none'
    )$$
);

select extensions.dblink_exec('insight_merge_lock', 'begin');
select extensions.dblink_exec(
  'insight_merge_lock',
  $$do $lock$
    begin
      perform private.lock_insight_parent_flow(
        'abababab-abab-4aba-8aba-abababababab'
      );
    end
  $lock$;$$
);
select extensions.dblink_send_query(
  'insight_task_writer',
  $$select (public.respond_to_reminder(
      'abababab-3000-4aba-8aba-abababababab',
      'normal_activity'
    )).response$$
);
select pg_catalog.pg_sleep(0.1);

-- If respond_to_reminder had already locked the row, this NOWAIT probe would
-- fail while the responder waited for the insight advisory: the exact cycle
-- used by account merge/delete. Owner-first ordering leaves the row available.
select extensions.dblink_exec(
  'insight_merge_lock',
  $$do $row_lock$
    begin
      perform 1
      from public.reminder_events
      where id = 'abababab-3000-4aba-8aba-abababababab'
      for update nowait;
    end
  $row_lock$;$$
);
select extensions.dblink_exec('insight_merge_lock', 'commit');

do $$
declare
  saved_response text;
begin
  select result.response into saved_response
  from extensions.dblink_get_result('insight_task_writer')
    as result(response text);
  if saved_response <> 'normal_activity' then
    raise exception 'reminder response did not resume after merge lock release';
  end if;
end;
$$;

select extensions.dblink_disconnect('insight_task_writer');
select extensions.dblink_exec(
  'insight_merge_lock',
  $$delete from auth.users
    where id = 'abababab-abab-4aba-8aba-abababababab'$$
);
select extensions.dblink_disconnect('insight_merge_lock');

-- Time buckets are cut on the timestamptz axis. These four transitions prove
-- elapsed seconds survive a repeated hour, a skipped hour, and Lord Howe's
-- non-hour DST shift instead of being reconstructed from ambiguous local time.
do $$
declare
  fixture record;
  bucket_seconds bigint;
begin
  for fixture in
    select * from (values
      (
        'New York fallback',
        'America/New_York',
        '2025-11-02 04:30:00+00'::timestamptz,
        '2025-11-02 07:30:00+00'::timestamptz
      ),
      (
        'New York spring-forward',
        'America/New_York',
        '2025-03-09 06:30:00+00'::timestamptz,
        '2025-03-09 08:30:00+00'::timestamptz
      ),
      (
        'Lord Howe fallback',
        'Australia/Lord_Howe',
        '2025-04-05 14:30:00+00'::timestamptz,
        '2025-04-05 16:30:00+00'::timestamptz
      ),
      (
        'Lord Howe spring-forward',
        'Australia/Lord_Howe',
        '2025-10-04 15:00:00+00'::timestamptz,
        '2025-10-04 17:00:00+00'::timestamptz
      )
    ) as cases(label, timezone_name, started_at, ended_at)
  loop
    select coalesce(sum(extract(epoch from (bucket_end - bucket_start))), 0)
      ::bigint
    into bucket_seconds
    from private.insight_bucket_ranges(
      fixture.started_at, fixture.ended_at, fixture.timezone_name
    );

    if bucket_seconds
      <> extract(epoch from (fixture.ended_at - fixture.started_at))::bigint
    then
      raise exception '% lost or duplicated elapsed seconds: %',
        fixture.label, bucket_seconds;
    end if;
  end loop;
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
  user_id, session_id, started_at, ended_at, last_observed_at, observation_profile,
  detector_version
)
values (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '62000000-0000-4000-8000-000000000001',
  clock_timestamp() - interval '20 minutes',
  clock_timestamp() - interval '15 minutes',
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
  user_id, session_id, started_at, ended_at, last_observed_at, observation_profile,
  detector_version
)
select
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '62000000-0000-4000-8000-000000000005',
  local_start,
  local_start + interval '10 minutes',
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

insert into public.behavior_events (
  user_id, session_id, event_type, source, started_at, ended_at,
  review_status, corrected_type
)
select
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '62000000-0000-4000-8000-000000000005',
  'manual',
  'manual',
  started_at + interval '11 minutes',
  started_at + interval '11 minutes',
  'corrected',
  'not_relevant'
from public.study_sessions
where id = '62000000-0000-4000-8000-000000000005';

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
  user_id, session_id, started_at, ended_at, last_observed_at, observation_profile,
  detector_version
)
select
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '62000000-0000-4000-8000-000000000006',
  fixture.now_at - interval '1 minute', fixture.now_at, fixture.now_at,
  'study_screen_v1', 'fragment-test'
from (select clock_timestamp() as now_at) as fixture;
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

-- Disabling insight capture seals active facts immediately. Session/task work
-- continues while disabled, and enabling resumes from that server instant only.
-- The block runs as the local test superuser solely so it can inspect the raw,
-- intentionally ungranted fact tables between authenticated RPC calls. The JWT
-- claims remain those of the target account and every RPC still checks auth.uid().
reset role;
do $$
declare
  test_session public.study_sessions;
  segment_count integer;
  run_count integer;
  step_fact_count integer;
  stale_heartbeat_blocked boolean := false;
  heartbeat_at timestamptz;
  disable_confirmed_at timestamptz;
  stale_confirmed_at timestamptz;
  reconnected_at timestamptz;
  camera_reconnected_at timestamptz;
  pause_confirmed_at timestamptz;
begin
  insert into public.tasks (
    id, user_id, title, steps, priority, estimated_minutes
  ) values (
    '61000000-0000-4000-8000-000000000008',
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    '洞察关闭边界',
    '[{"id":"disabled-step","title":"关闭期间完成","completed":false},{"id":"remaining-step","title":"保持未完成","completed":false}]',
    'low', 5
  );

  select * into test_session
  from public.start_study_session(
    '61000000-0000-4000-8000-000000000008', true, false
  );
  select * into test_session
  from public.set_study_session_camera(
    test_session.id, test_session.state_version, 1, true
  );

  heartbeat_at := public.heartbeat_observation_run(
    test_session.id, test_session.state_version, test_session.camera_version
  );
  if heartbeat_at is null then
    raise exception 'valid observation heartbeat was ignored';
  end if;

  disable_confirmed_at := clock_timestamp() - interval '20 minutes';
  perform set_config('session_replication_role', 'replica', true);
  update public.study_sessions
  set
    accumulated_seconds = 60,
    resumed_at = disable_confirmed_at,
    updated_at = disable_confirmed_at
  where id = test_session.id;
  update public.session_segments
  set started_at = disable_confirmed_at - interval '1 minute'
  where session_id = test_session.id and ended_at is null;
  update public.observation_runs
  set
    started_at = disable_confirmed_at - interval '1 minute',
    last_observed_at = disable_confirmed_at
  where session_id = test_session.id and ended_at is null;
  perform set_config('session_replication_role', 'origin', true);

  perform public.update_my_insights_preferences(false, 'Asia/Shanghai');
  if exists (
    select 1 from public.session_segments
    where session_id = test_session.id and ended_at is null
  ) or exists (
    select 1 from public.observation_runs
    where session_id = test_session.id and ended_at is null
  ) then
    raise exception 'disabling insights left a fact interval open';
  end if;
  if not exists (
    select 1 from public.session_segments
    where session_id = test_session.id and ended_at = disable_confirmed_at
  ) or not exists (
    select 1 from public.observation_runs
    where session_id = test_session.id
      and ended_at = disable_confirmed_at
      and last_observed_at = disable_confirmed_at
  ) then
    raise exception 'disabling insights backfilled a stale browser gap';
  end if;

  select count(*) into segment_count from public.session_segments
    where session_id = test_session.id;
  select count(*) into run_count from public.observation_runs
    where session_id = test_session.id;
  select count(*) into step_fact_count from public.task_step_events
    where task_id = '61000000-0000-4000-8000-000000000008';

  perform public.set_task_step_completed(
    '61000000-0000-4000-8000-000000000008', 'disabled-step', true
  );
  select * into test_session from public.pause_study_session(
    test_session.id, test_session.state_version, 0
  );
  select * into test_session from public.resume_study_session(
    test_session.id, test_session.state_version
  );
  select * into test_session from public.set_study_session_camera(
    test_session.id,
    test_session.state_version,
    test_session.camera_version + 1,
    true
  );

  if (select count(*) from public.session_segments
      where session_id = test_session.id) <> segment_count
    or (select count(*) from public.observation_runs
      where session_id = test_session.id) <> run_count
    or (select count(*) from public.task_step_events
      where task_id = '61000000-0000-4000-8000-000000000008')
      <> step_fact_count
  then
    raise exception 'disabled insight capture continued writing facts';
  end if;

  if public.heartbeat_observation_run(
    test_session.id, test_session.state_version, test_session.camera_version
  ) is not null then
    raise exception 'disabled observation heartbeat unexpectedly wrote a run';
  end if;

  perform public.update_my_insights_preferences(true, 'Asia/Shanghai');
  if (select count(*) from public.session_segments
      where session_id = test_session.id) <> segment_count + 1
    or (select count(*) from public.observation_runs
      where session_id = test_session.id) <> run_count + 1
  then
    raise exception 're-enabling insights did not start fresh fact intervals';
  end if;

  begin
    perform public.heartbeat_observation_run(
      test_session.id,
      test_session.state_version,
      test_session.camera_version - 1
    );
  exception when serialization_failure then
    stale_heartbeat_blocked := true;
  end;
  if not stale_heartbeat_blocked then
    raise exception 'stale camera heartbeat was accepted';
  end if;

  -- Simulate a browser crash after the last confirmed heartbeat. Replica mode
  -- is used only to age the fixture without firing lifecycle triggers.
  stale_confirmed_at := clock_timestamp() - interval '1 hour';
  perform set_config('session_replication_role', 'replica', true);
  update public.study_sessions
  set
    accumulated_seconds = 120,
    resumed_at = stale_confirmed_at,
    updated_at = stale_confirmed_at
  where id = test_session.id;
  update public.session_segments
  set
    started_at = stale_confirmed_at - interval '3 minutes',
    ended_at = stale_confirmed_at - interval '2 minutes'
  where session_id = test_session.id and ended_at is not null;
  update public.session_segments
  set started_at = stale_confirmed_at - interval '1 minute'
  where session_id = test_session.id and ended_at is null;
  update public.observation_runs
  set
    started_at = stale_confirmed_at - interval '3 minutes',
    last_observed_at = stale_confirmed_at - interval '2 minutes',
    ended_at = stale_confirmed_at - interval '2 minutes'
  where session_id = test_session.id and ended_at is not null;
  update public.observation_runs
  set
    started_at = stale_confirmed_at - interval '1 minute',
    last_observed_at = stale_confirmed_at
  where session_id = test_session.id and ended_at is null;
  perform set_config('session_replication_role', 'origin', true);

  select * into test_session from public.checkpoint_running_session(
    test_session.id,
    stale_confirmed_at,
    3720,
    clock_timestamp()
  );
  reconnected_at := test_session.resumed_at;
  if test_session.accumulated_seconds <> 120
    or reconnected_at < clock_timestamp() - interval '10 seconds'
    or (select count(*) from public.session_segments
      where session_id = test_session.id) <> segment_count + 2
    or not exists (
      select 1 from public.session_segments
      where session_id = test_session.id and ended_at = stale_confirmed_at
    )
    or not exists (
      select 1 from public.session_segments
      where session_id = test_session.id
        and started_at = reconnected_at and ended_at is null
    )
  then
    raise exception 'stale timer checkpoint backfilled an offline gap';
  end if;

  heartbeat_at := public.heartbeat_observation_run(
    test_session.id, test_session.state_version, test_session.camera_version
  );
  if (select count(*) from public.observation_runs
      where session_id = test_session.id) <> run_count + 2
    or not exists (
      select 1 from public.observation_runs
      where session_id = test_session.id
        and ended_at = stale_confirmed_at
        and last_observed_at = stale_confirmed_at
    )
    or not exists (
      select 1 from public.observation_runs
      where session_id = test_session.id
        and started_at = heartbeat_at
        and last_observed_at = heartbeat_at
        and ended_at is null
    )
  then
    raise exception 'stale observation heartbeat bridged an offline gap';
  end if;

  -- Returning after another long gap and switching the camera off must close
  -- both fact types at their independent confirmations. The camera action can
  -- restart timer evidence at now, but cannot turn the preceding gap into
  -- work or observation time.
  stale_confirmed_at := clock_timestamp() - interval '30 minutes';
  perform set_config('session_replication_role', 'replica', true);
  update public.study_sessions
  set
    accumulated_seconds = 120,
    resumed_at = stale_confirmed_at,
    updated_at = stale_confirmed_at
  where id = test_session.id;
  update public.session_segments
  set started_at = stale_confirmed_at - interval '1 minute'
  where session_id = test_session.id and ended_at is null;
  update public.observation_runs
  set
    started_at = stale_confirmed_at - interval '1 minute',
    last_observed_at = stale_confirmed_at
  where session_id = test_session.id and ended_at is null;
  perform set_config('session_replication_role', 'origin', true);

  select * into test_session from public.set_study_session_camera(
    test_session.id,
    test_session.state_version,
    test_session.camera_version + 1,
    false
  );
  camera_reconnected_at := test_session.resumed_at;
  if test_session.accumulated_seconds <> 120
    or camera_reconnected_at < clock_timestamp() - interval '10 seconds'
    or not exists (
      select 1 from public.observation_runs
      where session_id = test_session.id
        and ended_at = stale_confirmed_at
        and last_observed_at = stale_confirmed_at
    )
    or not exists (
      select 1 from public.session_segments
      where session_id = test_session.id and ended_at = stale_confirmed_at
    )
    or not exists (
      select 1 from public.session_segments
      where session_id = test_session.id
        and started_at = camera_reconnected_at
        and ended_at is null
    )
  then
    raise exception 'stale camera-off bridged an offline gap';
  end if;

  -- A direct pause can be the first request after a crash. Even if the browser
  -- submits its wall-clock total, only the previously checkpointed accumulated
  -- value and fact endpoint are accepted.
  pause_confirmed_at := clock_timestamp() - interval '10 minutes';
  perform set_config('session_replication_role', 'replica', true);
  update public.study_sessions
  set
    accumulated_seconds = 180,
    resumed_at = pause_confirmed_at,
    updated_at = pause_confirmed_at
  where id = test_session.id;
  update public.session_segments
  set started_at = pause_confirmed_at - interval '1 minute'
  where session_id = test_session.id and ended_at is null;
  perform set_config('session_replication_role', 'origin', true);

  select * into test_session from public.pause_study_session(
    test_session.id,
    test_session.state_version,
    4000
  );
  if test_session.accumulated_seconds <> 180
    or test_session.status <> 'paused'
    or exists (
      select 1 from public.session_segments
      where session_id = test_session.id and ended_at is null
    )
    or not exists (
      select 1 from public.session_segments
      where session_id = test_session.id and ended_at = pause_confirmed_at
    )
  then
    raise exception 'stale direct pause backfilled an offline gap';
  end if;

  perform public.cancel_study_session(
    test_session.id, test_session.accumulated_seconds
  );
end;
$$;

delete from public.tasks
where id = '61000000-0000-4000-8000-000000000008';
set local role authenticated;

-- A permanent account may already contain the same wall-clock interval as an
-- anonymous account. Copy the source ranges exactly, then prove the merge uses
-- a user-level range union instead of doubling duration or observation cover.
reset role;
insert into public.study_sessions (
  id, user_id, task_id, status, accumulated_seconds, started_at, ended_at,
  task_outcome
)
select
  '62000000-0000-4000-8000-000000000007',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '61000000-0000-4000-8000-000000000002',
  'cancelled', 600, segment.started_at, segment.ended_at, 'not_completed'
from public.session_segments as segment
where segment.session_id = '62000000-0000-4000-8000-000000000001';

insert into public.session_segments (
  user_id, session_id, started_at, ended_at
)
select
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '62000000-0000-4000-8000-000000000007',
  segment.started_at,
  segment.ended_at
from public.session_segments as segment
where segment.session_id = '62000000-0000-4000-8000-000000000001';

insert into public.observation_runs (
  user_id, session_id, started_at, ended_at, last_observed_at,
  camera_version, observation_profile, detector_version
)
select
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '62000000-0000-4000-8000-000000000007',
  run.started_at,
  run.ended_at,
  run.last_observed_at,
  run.camera_version,
  run.observation_profile,
  'merge-overlap-test'
from public.observation_runs as run
where run.session_id = '62000000-0000-4000-8000-000000000001';

insert into private.insight_fact_coverage (
  user_id, truncated, first_truncated_at, last_truncated_at, dropped_counts
)
values
  (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', true,
    clock_timestamp() - interval '3 days',
    clock_timestamp() - interval '2 days',
    '{"session_segments":2}'
  ),
  (
    'ffffffff-ffff-4fff-8fff-ffffffffffff', true,
    clock_timestamp() - interval '2 days',
    clock_timestamp() - interval '1 day',
    '{"session_segments":1,"observation_runs":3}'
  );

set local role authenticated;
create temporary table premerge_target_insights as
select public.get_my_insights(30) as report;

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
  premerge_report jsonb;
begin
  merge_result := public.consume_account_merge(repeat('a', 64));
  if (merge_result->>'tasks')::integer <> 1
    or (merge_result->>'sessions')::integer <> 2
  then
    raise exception 'real account merge returned wrong counts: %', merge_result;
  end if;

  merged_report := public.get_my_insights(30);
  select report into premerge_report from premerge_target_insights;
  if (merged_report->'overview'->>'actual_seconds')::bigint <> 26040
    or (merged_report->'segments'->>'eligible_count')::integer <> 23
    or (merged_report->'observation'->>'observed_seconds')::bigint <> 900
  then
    raise exception 'merged insight facts were lost or double-counted: %', merged_report;
  end if;

  if (merged_report->'overview'->>'actual_seconds')::bigint
      <> (premerge_report->'overview'->>'actual_seconds')::bigint
    or (merged_report->'segments'->>'eligible_count')::integer
      <> (premerge_report->'segments'->>'eligible_count')::integer
    or (merged_report->'observation'->>'observed_seconds')::bigint
      <> (premerge_report->'observation'->>'observed_seconds')::bigint
    or exists (
      select 1
      from jsonb_array_elements(merged_report->'time_buckets') as merged(value)
      join jsonb_array_elements(premerge_report->'time_buckets') as previous(value)
        on previous.value->>'id' = merged.value->>'id'
      where (merged.value->>'actual_seconds')::bigint
        <> (previous.value->>'actual_seconds')::bigint
    )
  then
    raise exception 'overlapping account histories were counted twice';
  end if;

  if (merged_report->'overview'->>'terminal_sessions')::integer
      <> (premerge_report->'overview'->>'terminal_sessions')::integer + 1
    or (
      select sum((value->>'outcome_count')::integer)
      from jsonb_array_elements(merged_report->'time_buckets')
    ) <> (
      select sum((value->>'outcome_count')::integer)
      from jsonb_array_elements(premerge_report->'time_buckets')
    ) + 1
  then
    raise exception 'non-experimental session outcomes were not retained as per-session samples: merged %, previous %',
      merged_report, premerge_report;
  end if;

  if (merged_report->'data_coverage'->>'global_truncated')::boolean is not true
    or (merged_report->'data_coverage'->>'period_complete')::boolean is not false
    or (merged_report->'data_coverage'->'dropped_counts'
      ->>'session_segments')::integer <> 3
    or (merged_report->'data_coverage'->'dropped_counts'
      ->>'observation_runs')::integer <> 3
  then
    raise exception 'fact completeness markers were not merged safely';
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
  ) or exists (
    select 1 from private.insight_fact_coverage
    where user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ) or not exists (
    select 1 from private.insight_fact_coverage
    where user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      and (dropped_counts->>'session_segments')::integer = 3
      and (dropped_counts->>'observation_runs')::integer = 3
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
      user_id, session_id, started_at, ended_at, last_observed_at,
      observation_profile,
      detector_version
    ) values (
      selected_run.user_id, selected_run.session_id,
      selected_run.started_at, selected_run.ended_at,
      selected_run.last_observed_at,
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
  point_in_time timestamptz := clock_timestamp() - interval '1 day';
  dropped_before integer;
  coverage_report jsonb;
begin
  select (dropped_counts->>'session_segments')::integer
  into dropped_before
  from private.insight_fact_coverage
  where user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

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

  if (
    select (dropped_counts->>'session_segments')::integer
    from private.insight_fact_coverage
    where user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  ) <> dropped_before + 6 then
    raise exception 'dropped fact count did not match rejected inserts';
  end if;

  coverage_report := public.get_my_insights(30);
  if (coverage_report->'data_coverage'->>'complete')::boolean is not false
    or (coverage_report->'data_coverage'->>'period_complete')::boolean
      is not false
  then
    raise exception 'current-window truncation was not exposed by the report';
  end if;

  update private.insight_fact_coverage
  set
    first_truncated_at = clock_timestamp() - interval '100 days',
    last_truncated_at = clock_timestamp() - interval '99 days'
  where user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  coverage_report := public.get_my_insights(30);
  if (coverage_report->'data_coverage'->>'global_truncated')::boolean
      is not true
    or (coverage_report->'data_coverage'->>'period_complete')::boolean
      is not true
    or (coverage_report->'data_coverage'
      ->>'recommendation_evidence_complete')::boolean is not true
  then
    raise exception 'historical truncation incorrectly tainted current windows';
  end if;
end;
$$;

-- Account transfer itself is not a timer/camera heartbeat. A target account
-- with insight capture disabled seals the source facts at their independent
-- confirmations, and the administrative owner-only UPDATE preserves the
-- session's last server-confirmed updated_at.
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claims', '{}'::jsonb::text, true);

insert into auth.users (
  id, aud, role, encrypted_password, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
)
values
  (
    'c1c1c1c1-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', '',
    '{"provider":"anonymous","providers":["anonymous"]}', '{}', true,
    clock_timestamp(), clock_timestamp()
  ),
  (
    'c1c1c1c1-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', '',
    '{"provider":"email","providers":["email"]}', '{}', false,
    clock_timestamp(), clock_timestamp()
  );

insert into public.user_settings (user_id, insights_enabled)
values ('c1c1c1c1-0000-4000-8000-000000000002', false);

insert into public.tasks (
  id, user_id, title, steps, priority, estimated_minutes
)
values (
  'c1c1c1c1-1000-4000-8000-000000000001',
  'c1c1c1c1-0000-4000-8000-000000000001',
  '迁移封口边界',
  '[{"id":"merge-step","title":"继续执行","completed":false}]',
  'low', 10
);

insert into public.study_sessions (
  id, user_id, task_id, status, accumulated_seconds, started_at, resumed_at,
  camera_enabled, camera_version
)
values (
  'c1c1c1c1-2000-4000-8000-000000000001',
  'c1c1c1c1-0000-4000-8000-000000000001',
  'c1c1c1c1-1000-4000-8000-000000000001',
  'running', 90, clock_timestamp() - interval '31 minutes',
  clock_timestamp() - interval '30 minutes', true, 1
);

do $$
declare
  confirmed_at timestamptz := clock_timestamp() - interval '30 minutes';
  preserved_updated_at timestamptz;
begin
  perform set_config('session_replication_role', 'replica', true);
  update public.study_sessions
  set
    accumulated_seconds = 90,
    resumed_at = confirmed_at,
    updated_at = confirmed_at
  where id = 'c1c1c1c1-2000-4000-8000-000000000001';
  update public.session_segments
  set started_at = confirmed_at - interval '1 minute'
  where session_id = 'c1c1c1c1-2000-4000-8000-000000000001'
    and ended_at is null;
  update public.observation_runs
  set
    started_at = confirmed_at - interval '1 minute',
    last_observed_at = confirmed_at
  where session_id = 'c1c1c1c1-2000-4000-8000-000000000001'
    and ended_at is null;
  perform set_config('session_replication_role', 'origin', true);

  perform private.lock_account_flow_extension_resources(array[
    'c1c1c1c1-0000-4000-8000-000000000001'::uuid,
    'c1c1c1c1-0000-4000-8000-000000000002'::uuid
  ]);
  perform set_config(
    'studytrace.account_merge_source',
    'c1c1c1c1-0000-4000-8000-000000000001',
    true
  );
  perform set_config(
    'studytrace.account_merge_target',
    'c1c1c1c1-0000-4000-8000-000000000002',
    true
  );
  perform private.apply_account_merge_extension(
    'c1c1c1c1-0000-4000-8000-000000000001',
    'c1c1c1c1-0000-4000-8000-000000000002'
  );

  update public.tasks
  set user_id = 'c1c1c1c1-0000-4000-8000-000000000002'
  where id = 'c1c1c1c1-1000-4000-8000-000000000001';
  update public.study_sessions
  set user_id = 'c1c1c1c1-0000-4000-8000-000000000002'
  where id = 'c1c1c1c1-2000-4000-8000-000000000001'
  returning updated_at into preserved_updated_at;

  if preserved_updated_at <> confirmed_at
    or not exists (
      select 1 from public.session_segments
      where session_id = 'c1c1c1c1-2000-4000-8000-000000000001'
        and user_id = 'c1c1c1c1-0000-4000-8000-000000000002'
        and ended_at = confirmed_at
    )
    or not exists (
      select 1 from public.observation_runs
      where session_id = 'c1c1c1c1-2000-4000-8000-000000000001'
        and user_id = 'c1c1c1c1-0000-4000-8000-000000000002'
        and ended_at = confirmed_at
        and last_observed_at = confirmed_at
    )
  then
    raise exception 'account migration refreshed or backfilled stale facts';
  end if;
end;
$$;

update public.study_sessions
set
  status = 'cancelled',
  accumulated_seconds = 90,
  resumed_at = null,
  ended_at = clock_timestamp(),
  camera_enabled = false
where id = 'c1c1c1c1-2000-4000-8000-000000000001';

delete from auth.users
where id in (
  'c1c1c1c1-0000-4000-8000-000000000001',
  'c1c1c1c1-0000-4000-8000-000000000002'
);

-- The explicit account-merge mutation hook must preserve quality metadata even
-- when the source has already deleted every task/session/settings parent. A
-- later auth.users cascade must not erase the only evidence of truncation.
insert into auth.users (
  id, aud, role, encrypted_password, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
)
values
  (
    'c0c0c0c0-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', '',
    '{"provider":"anonymous","providers":["anonymous"]}', '{}', true,
    clock_timestamp(), clock_timestamp()
  ),
  (
    'c0c0c0c0-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', '',
    '{"provider":"email","providers":["email"]}', '{}', false,
    clock_timestamp(), clock_timestamp()
  );

insert into private.insight_fact_coverage (
  user_id, truncated, first_truncated_at, last_truncated_at, dropped_counts
)
values
  (
    'c0c0c0c0-0000-4000-8000-000000000001', true,
    clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day',
    '{"session_segments":2}'
  ),
  (
    'c0c0c0c0-0000-4000-8000-000000000002', true,
    clock_timestamp() - interval '3 days', clock_timestamp() - interval '3 days',
    '{"session_segments":1}'
  );

select private.lock_account_flow_extension_resources(array[
  'c0c0c0c0-0000-4000-8000-000000000001'::uuid,
  'c0c0c0c0-0000-4000-8000-000000000002'::uuid
]);
select private.assert_account_merge_extension_capacity(
  'c0c0c0c0-0000-4000-8000-000000000001',
  'c0c0c0c0-0000-4000-8000-000000000002'
);
select private.apply_account_merge_extension(
  'c0c0c0c0-0000-4000-8000-000000000001',
  'c0c0c0c0-0000-4000-8000-000000000002'
);
delete from auth.users where id = 'c0c0c0c0-0000-4000-8000-000000000001';

do $$
begin
  if exists (
    select 1 from private.insight_fact_coverage
    where user_id = 'c0c0c0c0-0000-4000-8000-000000000001'
  ) or not exists (
    select 1 from private.insight_fact_coverage
    where user_id = 'c0c0c0c0-0000-4000-8000-000000000002'
      and (dropped_counts->>'session_segments')::integer = 3
  ) then
    raise exception 'coverage-only account history was lost during merge';
  end if;
end;
$$;

delete from auth.users where id = 'c0c0c0c0-0000-4000-8000-000000000002';

-- Private completeness metadata follows both account deletion and the
-- user-visible delete_my_data operation.
reset role;
insert into auth.users (
  id, aud, role, encrypted_password, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
)
values (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'authenticated', 'authenticated', '',
  '{"provider":"anonymous","providers":["anonymous"]}', '{}', true,
  clock_timestamp(), clock_timestamp()
);
insert into private.insight_fact_coverage (
  user_id, truncated, first_truncated_at, last_truncated_at, dropped_counts
)
values (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd', true,
  clock_timestamp(), clock_timestamp(), '{"session_segments":1}'
);
delete from auth.users where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

do $$
begin
  if exists (
    select 1 from private.insight_fact_coverage
    where user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  ) then
    raise exception 'account deletion retained private insight coverage';
  end if;
end;
$$;

insert into auth.users (
  id, aud, role, encrypted_password, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
)
values (
  'ecececec-ecec-4ece-8ece-ecececececec',
  'authenticated', 'authenticated', '',
  '{"provider":"anonymous","providers":["anonymous"]}', '{}', true,
  clock_timestamp(), clock_timestamp()
);
insert into private.insight_fact_coverage (
  user_id, truncated, first_truncated_at, last_truncated_at, dropped_counts
)
values (
  'ecececec-ecec-4ece-8ece-ecececececec', true,
  clock_timestamp(), clock_timestamp(), '{"session_segments":1}'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub', 'ecececec-ecec-4ece-8ece-ecececececec', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"ecececec-ecec-4ece-8ece-ecececececec","role":"authenticated"}',
  true
);
select public.delete_my_data();
reset role;

do $$
begin
  if exists (
    select 1 from private.insight_fact_coverage
    where user_id = 'ecececec-ecec-4ece-8ece-ecececececec'
  ) then
    raise exception 'delete_my_data retained coverage without a settings row';
  end if;
end;
$$;
delete from auth.users where id = 'ecececec-ecec-4ece-8ece-ecececececec';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff', true
);
select public.delete_my_data();
reset role;

do $$
begin
  if exists (
    select 1 from private.insight_fact_coverage
    where user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  ) then
    raise exception 'delete_my_data retained private insight coverage';
  end if;
end;
$$;

rollback;
