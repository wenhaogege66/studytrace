-- StudyTrace database acceptance tests.
-- Run against an isolated/local database or through a single transaction.
-- Every row created here is rolled back at the end.

begin;

do $$
declare
  business_table text;
begin
  foreach business_table in array array[
    'public.tasks',
    'public.study_sessions',
    'public.behavior_events',
    'public.reminder_events',
    'public.reviews',
    'public.user_settings'
  ] loop
    if has_table_privilege('anon', business_table, 'select') then
      raise exception 'anon must not have SELECT on %', business_table;
    end if;

    if business_table = 'public.study_sessions' then
      if not has_table_privilege('authenticated', business_table, 'select')
        or has_table_privilege(
          'authenticated',
          business_table,
          'insert,update,delete'
        )
      then
        raise exception 'study sessions must be read-only outside protected RPCs';
      end if;
    elsif not has_table_privilege(
      'authenticated',
      business_table,
      'select,insert,update,delete'
    ) then
      raise exception 'authenticated must have CRUD privileges on %', business_table;
    end if;

    if has_table_privilege(
      'authenticated',
      business_table,
      'truncate,references,trigger'
    ) then
      raise exception 'authenticated has unsafe privileges on %', business_table;
    end if;
  end loop;

  if has_function_privilege(
    'anon',
    'public.start_study_session(uuid,boolean,boolean)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.finish_study_session(uuid,integer,text)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.cancel_study_session(uuid,integer)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.checkpoint_running_session(uuid,timestamp with time zone,integer,timestamp with time zone)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.pause_study_session(uuid,bigint,integer)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.resume_study_session(uuid,bigint)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.set_study_session_camera(uuid,bigint,bigint,boolean)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.consume_ai_generation_quota()',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.set_task_step_completed(uuid,text,boolean)',
    'execute'
  ) then
    raise exception 'anon must not execute protected application functions';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.start_study_session(uuid,boolean,boolean)',
    'execute'
  ) or not has_function_privilege(
    'authenticated',
    'public.finish_study_session(uuid,integer,text)',
    'execute'
  ) or not has_function_privilege(
    'authenticated',
    'public.cancel_study_session(uuid,integer)',
    'execute'
  ) or not has_function_privilege(
    'authenticated',
    'public.checkpoint_running_session(uuid,timestamp with time zone,integer,timestamp with time zone)',
    'execute'
  ) or not has_function_privilege(
    'authenticated',
    'public.pause_study_session(uuid,bigint,integer)',
    'execute'
  ) or not has_function_privilege(
    'authenticated',
    'public.resume_study_session(uuid,bigint)',
    'execute'
  ) or not has_function_privilege(
    'authenticated',
    'public.set_study_session_camera(uuid,bigint,bigint,boolean)',
    'execute'
  ) or not has_function_privilege(
    'authenticated',
    'public.consume_ai_generation_quota()',
    'execute'
  ) or not has_function_privilege(
    'authenticated',
    'public.set_task_step_completed(uuid,text,boolean)',
    'execute'
  ) then
    raise exception 'authenticated must execute protected application functions';
  end if;

  if (
    select count(*)
    from pg_catalog.pg_trigger
    where not tgisinternal
      and tgname like '%_enforce_user_row_quota'
  ) <> 5 then
    raise exception 'every appendable business table must enforce a per-user row quota';
  end if;
end;
$$;

insert into auth.users (
  id,
  aud,
  role,
  raw_app_meta_data,
  raw_user_meta_data,
  is_anonymous,
  created_at,
  updated_at
)
values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'authenticated',
    'authenticated',
    '{"provider":"anonymous","providers":["anonymous"]}',
    '{}',
    true,
    now(),
    now()
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'authenticated',
    'authenticated',
    '{"provider":"anonymous","providers":["anonymous"]}',
    '{}',
    true,
    now(),
    now()
  );

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

insert into public.user_settings (user_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

do $$
declare
  attempt integer;
begin
  for attempt in 1..8 loop
    if not public.consume_ai_generation_quota() then
      raise exception 'AI quota rejected allowed attempt %', attempt;
    end if;
  end loop;

  if public.consume_ai_generation_quota() then
    raise exception 'AI quota allowed a ninth attempt inside one window';
  end if;
end;
$$;

insert into public.tasks (
  id,
  user_id,
  title,
  steps,
  priority,
  estimated_minutes
)
values (
  '10000000-0000-4000-8000-000000000001',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'A 的隔离测试任务',
  '[{"id":"step-a","title":"第一步","completed":false},{"id":"step-a2","title":"第二步","completed":false}]',
  'medium',
  25
);

do $$
declare
  duplicate_steps_were_blocked boolean := false;
  extra_step_fields_were_blocked boolean := false;
begin
  begin
    insert into public.tasks (user_id, title, steps, estimated_minutes)
    values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '重复步骤测试',
      '[{"id":"duplicate","title":"第一步","completed":false},{"id":"duplicate","title":"第二步","completed":false}]',
      10
    );
  exception
    when check_violation then duplicate_steps_were_blocked := true;
  end;

  begin
    insert into public.tasks (user_id, title, steps, estimated_minutes)
    values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '额外字段测试',
      '[{"id":"one","title":"第一步","completed":false,"rawPrompt":"不得保存"}]',
      10
    );
  exception
    when check_violation then extra_step_fields_were_blocked := true;
  end;

  if not duplicate_steps_were_blocked or not extra_step_fields_were_blocked then
    raise exception 'malformed or duplicate task steps were accepted';
  end if;
end;
$$;

reset role;

insert into public.study_sessions (
  id,
  user_id,
  task_id,
  status,
  resumed_at
)
values (
  '20000000-0000-4000-8000-000000000001',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000001',
  'running',
  now()
);

do $$
begin
  begin
    insert into public.study_sessions (
      id,
      user_id,
      task_id,
      status
    )
    values (
      '20000000-0000-4000-8000-000000000002',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '10000000-0000-4000-8000-000000000001',
      'paused'
    );
    raise exception 'a second active session unexpectedly succeeded';
  exception
    when unique_violation then null;
  end;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  direct_update_was_blocked boolean := false;
begin
  begin
    update public.study_sessions
    set accumulated_seconds = 1
    where id = '20000000-0000-4000-8000-000000000001';
  exception
    when insufficient_privilege then direct_update_was_blocked := true;
  end;

  if not direct_update_was_blocked then
    raise exception 'authenticated bypassed protected session RPCs';
  end if;
end;
$$;

do $$
declare
  original_anchor timestamptz;
  first_checkpoint public.study_sessions;
  stale_checkpoint public.study_sessions;
  paused_checkpoint public.study_sessions;
  paused_session public.study_sessions;
  resumed_session public.study_sessions;
  camera_session public.study_sessions;
  resumed_anchor timestamptz;
begin
  select resumed_at into original_anchor
  from public.study_sessions
  where id = '20000000-0000-4000-8000-000000000001';

  select * into first_checkpoint
  from public.checkpoint_running_session(
    '20000000-0000-4000-8000-000000000001',
    original_anchor,
    45,
    original_anchor + interval '45 seconds'
  );

  if first_checkpoint.accumulated_seconds <> 45
    or first_checkpoint.resumed_at <> original_anchor + interval '45 seconds'
  then
    raise exception 'a current running checkpoint did not advance atomically';
  end if;

  select * into stale_checkpoint
  from public.checkpoint_running_session(
    '20000000-0000-4000-8000-000000000001',
    original_anchor,
    90,
    original_anchor + interval '90 seconds'
  );

  if stale_checkpoint.accumulated_seconds <> 45
    or stale_checkpoint.resumed_at <> first_checkpoint.resumed_at
  then
    raise exception 'an out-of-order checkpoint overwrote the current timer anchor';
  end if;

  select * into paused_session
  from public.pause_study_session(
    '20000000-0000-4000-8000-000000000001',
    first_checkpoint.state_version,
    50
  );

  if paused_session.status <> 'paused'
    or paused_session.state_version <> first_checkpoint.state_version + 1
  then
    raise exception 'pause did not advance the lifecycle generation';
  end if;

  select * into paused_checkpoint
  from public.checkpoint_running_session(
    '20000000-0000-4000-8000-000000000001',
    first_checkpoint.resumed_at,
    60,
    first_checkpoint.resumed_at + interval '15 seconds'
  );

  if paused_checkpoint.status <> 'paused'
    or paused_checkpoint.accumulated_seconds <> 50
    or paused_checkpoint.resumed_at is not null
  then
    raise exception 'a delayed running checkpoint overwrote a paused session';
  end if;

  select * into resumed_session
  from public.resume_study_session(
    '20000000-0000-4000-8000-000000000001',
    paused_session.state_version
  );
  resumed_anchor := resumed_session.resumed_at;

  if resumed_session.status <> 'running'
    or resumed_session.state_version <> paused_session.state_version + 1
  then
    raise exception 'resume did not advance the lifecycle generation';
  end if;

  select * into stale_checkpoint
  from public.checkpoint_running_session(
    '20000000-0000-4000-8000-000000000001',
    first_checkpoint.resumed_at,
    75,
    first_checkpoint.resumed_at + interval '30 seconds'
  );

  if stale_checkpoint.status <> 'running'
    or stale_checkpoint.accumulated_seconds <> 50
    or stale_checkpoint.resumed_at <> resumed_anchor
  then
    raise exception 'a delayed checkpoint overwrote a newly resumed timer';
  end if;

  select * into paused_checkpoint
  from public.pause_study_session(
    '20000000-0000-4000-8000-000000000001',
    paused_session.state_version,
    80
  );

  if paused_checkpoint.status <> 'running'
    or paused_checkpoint.state_version <> resumed_session.state_version
  then
    raise exception 'a stale pause changed a newer running generation';
  end if;

  select * into camera_session
  from public.set_study_session_camera(
    '20000000-0000-4000-8000-000000000001',
    resumed_session.state_version,
    2,
    false
  );
  select * into camera_session
  from public.set_study_session_camera(
    '20000000-0000-4000-8000-000000000001',
    resumed_session.state_version,
    1,
    true
  );

  if camera_session.camera_enabled
    or camera_session.camera_version <> 2
  then
    raise exception 'an out-of-order camera intent overwrote the latest state';
  end if;
end;
$$;

insert into public.behavior_events (
  id,
  user_id,
  session_id,
  event_type,
  source,
  started_at
)
values (
  '30000000-0000-4000-8000-000000000001',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '20000000-0000-4000-8000-000000000001',
  'face_absent',
  'vision',
  now() + interval '1 day'
);

do $$
declare
  updated_task public.tasks;
begin
  perform public.set_task_step_completed(
    '10000000-0000-4000-8000-000000000001',
    'step-a',
    true
  );
  select * into updated_task
  from public.set_task_step_completed(
    '10000000-0000-4000-8000-000000000001',
    'step-a2',
    true
  );

  if (
    select count(*)
    from jsonb_array_elements(updated_task.steps) as step
    where step->>'id' in ('step-a', 'step-a2')
      and step->'completed' = 'true'::jsonb
  ) <> 2 then
    raise exception 'atomic step updates overwrote a prior checkbox change';
  end if;

  perform public.set_task_step_completed(
    '10000000-0000-4000-8000-000000000001',
    'step-a',
    false
  );
  perform public.set_task_step_completed(
    '10000000-0000-4000-8000-000000000001',
    'step-a2',
    false
  );
end;
$$;

do $$
declare
  resumed_session public.study_sessions;
  finished_session public.study_sessions;
  completed_task_status text;
  completed_task_at timestamptz;
  incomplete_finish_was_blocked boolean := false;
  direct_completion_was_blocked boolean := false;
  active_archive_was_blocked boolean := false;
  active_delete_was_blocked boolean := false;
  start_was_blocked boolean := false;
begin
  select * into resumed_session
  from public.pause_study_session(
    '20000000-0000-4000-8000-000000000001',
    (
      select state_version
      from public.study_sessions
      where id = '20000000-0000-4000-8000-000000000001'
    ),
    300
  );

  select * into resumed_session
  from public.start_study_session(
    '10000000-0000-4000-8000-000000000001',
    true,
    false
  );

  if resumed_session.id <> '20000000-0000-4000-8000-000000000001'
    or resumed_session.status <> 'paused'
  then
    raise exception 'starting a paused task did not return the existing session';
  end if;

  begin
    update public.tasks
    set status = 'archived'
    where id = '10000000-0000-4000-8000-000000000001';
  exception
    when check_violation then active_archive_was_blocked := true;
  end;

  begin
    delete from public.tasks
    where id = '10000000-0000-4000-8000-000000000001';
  exception
    when check_violation then active_delete_was_blocked := true;
  end;

  if not active_archive_was_blocked or not active_delete_was_blocked then
    raise exception 'an active session task was archived or deleted';
  end if;

  if (
    select count(*)
    from public.study_sessions
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ) <> 1 then
    raise exception 'resuming a paused task inserted a second session';
  end if;

  begin
    perform public.finish_study_session(
      resumed_session.id,
      600,
      'completed'
    );
  exception
    when check_violation then incomplete_finish_was_blocked := true;
  end;

  if not incomplete_finish_was_blocked then
    raise exception 'an incomplete task unexpectedly finished and opened review';
  end if;

  begin
    update public.tasks
    set status = 'completed', completed_at = now()
    where id = '10000000-0000-4000-8000-000000000001';
  exception
    when check_violation then direct_completion_was_blocked := true;
  end;

  if not direct_completion_was_blocked then
    raise exception 'an incomplete task was directly marked completed';
  end if;

  update public.tasks
  set steps = '[{"id":"step-a","title":"第一步","completed":true}]'
  where id = '10000000-0000-4000-8000-000000000001';

  select * into resumed_session
  from public.resume_study_session(
    resumed_session.id,
    resumed_session.state_version
  );

  select * into finished_session
  from public.finish_study_session(resumed_session.id, 20, 'completed');

  if finished_session.accumulated_seconds < 300 then
    raise exception 'a stale terminal client value reduced accepted elapsed time';
  end if;

  select status, completed_at
  into completed_task_status, completed_task_at
  from public.tasks
  where id = '10000000-0000-4000-8000-000000000001';

  if completed_task_status <> 'completed' or completed_task_at is null then
    raise exception 'all-complete session did not complete its task';
  end if;

  begin
    perform public.start_study_session(
      '10000000-0000-4000-8000-000000000001',
      true,
      false
    );
  exception
    when sqlstate 'P0001' then start_was_blocked := true;
  end;

  if not start_was_blocked then
    raise exception 'completed task unexpectedly started another session';
  end if;
end;
$$;

do $$
declare
  terminal_insert_was_blocked boolean := false;
  completed_mutation_was_blocked boolean := false;
begin
  if exists (
    select 1
    from public.behavior_events as event
    where event.id = '30000000-0000-4000-8000-000000000001'
      and (
        event.ended_at is null
        or event.ended_at < event.started_at
      )
  ) then
    raise exception 'terminal session left a behavior event open';
  end if;

  begin
    update public.study_sessions
    set status = 'paused', ended_at = null
    where id = '20000000-0000-4000-8000-000000000001';
  exception
    when check_violation or insufficient_privilege then
      completed_mutation_was_blocked := true;
  end;

  if not completed_mutation_was_blocked then
    raise exception 'a completed session was resurrected or otherwise changed';
  end if;

  begin
    insert into public.behavior_events (
      user_id,
      session_id,
      event_type,
      source,
      started_at
    )
    values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '20000000-0000-4000-8000-000000000001',
      'face_absent',
      'vision',
      now()
    );
  exception
    when sqlstate 'P0001' then terminal_insert_was_blocked := true;
  end;

  if not terminal_insert_was_blocked then
    raise exception 'a behavior event was inserted after session completion';
  end if;
end;
$$;

insert into public.tasks (
  id,
  user_id,
  title,
  steps,
  priority,
  estimated_minutes,
  observation_profile
)
values (
  '10000000-0000-4000-8000-000000000004',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '纸笔观察快照测试',
  '[{"id":"step-d","title":"阅读并勾画","completed":false}]',
  'medium',
  20,
  'study_paper_v1'
);

do $$
declare
  paper_session public.study_sessions;
  cancelled_paper_session public.study_sessions;
  next_paper_session public.study_sessions;
  cancelled_next_session public.study_sessions;
  stored_profile text;
  stored_task_status text;
  invalid_profile_was_blocked boolean := false;
  active_profile_change_was_blocked boolean := false;
  immutable_snapshot_was_enforced boolean := false;
  terminal_mutation_was_blocked boolean := false;
  late_event_end timestamptz;
  stored_review_status text;
begin
  begin
    update public.tasks
    set observation_profile = 'exercise_pose_v1'
    where id = '10000000-0000-4000-8000-000000000004';
  exception
    when check_violation then invalid_profile_was_blocked := true;
  end;

  if not invalid_profile_was_blocked then
    raise exception 'task accepted a non-allowlisted observation profile';
  end if;

  select * into paper_session
  from public.start_study_session(
    '10000000-0000-4000-8000-000000000004',
    true,
    false
  );

  if paper_session.observation_profile <> 'study_paper_v1' then
    raise exception 'new session did not snapshot the task observation profile';
  end if;

  begin
    update public.tasks
    set observation_profile = 'off_device_v1'
    where id = '10000000-0000-4000-8000-000000000004';
  exception
    when check_violation then active_profile_change_was_blocked := true;
  end;

  if not active_profile_change_was_blocked then
    raise exception 'task observation profile changed during an active session';
  end if;

  select observation_profile into stored_profile
  from public.study_sessions
  where id = paper_session.id;

  if stored_profile <> 'study_paper_v1' then
    raise exception 'editing a task changed its existing session profile';
  end if;

  begin
    update public.study_sessions
    set observation_profile = 'off_device_v1'
    where id = paper_session.id;
  exception
    when check_violation or insufficient_privilege then
      immutable_snapshot_was_enforced := true;
  end;

  if not immutable_snapshot_was_enforced then
    raise exception 'session observation profile was directly mutable';
  end if;

  insert into public.behavior_events (
    id,
    user_id,
    session_id,
    event_type,
    source,
    started_at
  )
  values (
    '30000000-0000-4000-8000-000000000004',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    paper_session.id,
    'face_absent',
    'vision',
    now() - interval '5 seconds'
  );

  select * into paper_session
  from public.pause_study_session(
    paper_session.id,
    paper_session.state_version,
    420
  );
  select * into paper_session
  from public.resume_study_session(
    paper_session.id,
    paper_session.state_version
  );

  select * into cancelled_paper_session
  from public.cancel_study_session(paper_session.id, 20);

  if cancelled_paper_session.status <> 'cancelled'
    or cancelled_paper_session.task_outcome <> 'not_completed'
    or cancelled_paper_session.accumulated_seconds < 420
    or cancelled_paper_session.ended_at is null
    or cancelled_paper_session.resumed_at is not null
    or cancelled_paper_session.camera_enabled
  then
    raise exception 'cancelling a session without completed steps stored an invalid terminal result';
  end if;

  if exists (
    select 1
    from public.behavior_events
    where id = '30000000-0000-4000-8000-000000000004'
      and ended_at is null
  ) then
    raise exception 'cancelling a session did not close its open behavior event';
  end if;

  update public.behavior_events
  set
    ended_at = cancelled_paper_session.ended_at + interval '1 hour',
    review_status = 'confirmed'
  where id = '30000000-0000-4000-8000-000000000004';

  select ended_at, review_status
  into late_event_end, stored_review_status
  from public.behavior_events
  where id = '30000000-0000-4000-8000-000000000004';

  if late_event_end > cancelled_paper_session.ended_at
    or stored_review_status <> 'confirmed'
  then
    raise exception 'a late event closure escaped the terminal session bound or blocked review';
  end if;

  select status into stored_task_status
  from public.tasks
  where id = '10000000-0000-4000-8000-000000000004';

  if stored_task_status <> 'in_progress' then
    raise exception 'cancelling a session did not keep its task in progress';
  end if;

  begin
    update public.study_sessions
    set status = 'running', accumulated_seconds = 421, ended_at = null
    where id = paper_session.id;
  exception
    when check_violation or insufficient_privilege then
      terminal_mutation_was_blocked := true;
  end;

  if not terminal_mutation_was_blocked then
    raise exception 'a cancelled session was resurrected or otherwise changed';
  end if;

  update public.tasks
  set observation_profile = 'off_device_v1'
  where id = '10000000-0000-4000-8000-000000000004';

  select * into next_paper_session
  from public.start_study_session(
    '10000000-0000-4000-8000-000000000004',
    true,
    false
  );

  if next_paper_session.id = paper_session.id
    or next_paper_session.status <> 'running'
    or next_paper_session.observation_profile <> 'off_device_v1'
  then
    raise exception 'a cancelled session did not release the active slot for a fresh snapshot';
  end if;

  perform public.set_task_step_completed(
    '10000000-0000-4000-8000-000000000004',
    'step-d',
    true
  );

  select * into cancelled_next_session
  from public.cancel_study_session(next_paper_session.id, 180);

  if cancelled_next_session.task_outcome <> 'partially_completed' then
    raise exception 'cancellation did not derive a partial outcome from completed task steps';
  end if;

  if exists (
    select 1
    from public.study_sessions
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and status in ('running', 'paused')
  ) then
    raise exception 'cancelled sessions still occupied the active-session slot';
  end if;
end;
$$;

reset role;

insert into private.ai_global_daily_quota (quota_date, attempts)
values ((clock_timestamp() at time zone 'UTC')::date, 199)
on conflict (quota_date) do update set attempts = 199;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
begin
  if not public.consume_ai_generation_quota() then
    raise exception 'global AI quota rejected the 200th daily request';
  end if;
  if public.consume_ai_generation_quota() then
    raise exception 'global AI quota allowed a 201st daily request';
  end if;
end;
$$;

do $$
declare
  visible_count integer;
begin
  select count(*) into visible_count
  from public.tasks
  where id = '10000000-0000-4000-8000-000000000001';

  if visible_count <> 0 then
    raise exception 'user B can read user A data';
  end if;
end;
$$;

insert into public.tasks (
  id,
  user_id,
  title,
  steps,
  priority,
  estimated_minutes
)
values (
  '10000000-0000-4000-8000-000000000002',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'B 的保留任务',
  '[{"id":"step-b","title":"第一步","completed":false}]',
  'low',
  15
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
begin
  begin
    update public.tasks
    set user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    where id = '10000000-0000-4000-8000-000000000001';
    raise exception 'task ownership was mutable';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

insert into public.tasks (
  id,
  user_id,
  title,
  steps,
  priority,
  estimated_minutes
)
values (
  '10000000-0000-4000-8000-000000000003',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '级联删除任务',
  '[{"id":"step-c","title":"第一步","completed":true}]',
  'high',
  20
);

reset role;

insert into public.study_sessions (
  id,
  user_id,
  task_id,
  status,
  accumulated_seconds,
  resumed_at
)
values (
  '20000000-0000-4000-8000-000000000003',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000003',
  'running',
  600,
  now()
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

insert into public.behavior_events (
  id,
  user_id,
  session_id,
  event_type,
  direction,
  source,
  started_at,
  ended_at
)
values (
  '30000000-0000-4000-8000-000000000003',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '20000000-0000-4000-8000-000000000003',
  'head_direction_change',
  'left',
  'vision',
  now() - interval '10 seconds',
  now()
);

select public.finish_study_session(
  '20000000-0000-4000-8000-000000000003',
  600,
  'completed'
);

insert into public.reminder_events (
  id,
  user_id,
  session_id,
  behavior_event_id
)
values (
  '40000000-0000-4000-8000-000000000003',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '20000000-0000-4000-8000-000000000003',
  '30000000-0000-4000-8000-000000000003'
);

insert into public.reviews (
  id,
  user_id,
  session_id,
  completion_status,
  self_rating
)
values (
  '50000000-0000-4000-8000-000000000003',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '20000000-0000-4000-8000-000000000003',
  'completed',
  4
);

delete from public.tasks
where id = '10000000-0000-4000-8000-000000000003';

do $$
begin
  if exists (
    select 1 from public.study_sessions
    where id = '20000000-0000-4000-8000-000000000003'
  ) or exists (
    select 1 from public.behavior_events
    where id = '30000000-0000-4000-8000-000000000003'
  ) or exists (
    select 1 from public.reminder_events
    where id = '40000000-0000-4000-8000-000000000003'
  ) or exists (
    select 1 from public.reviews
    where id = '50000000-0000-4000-8000-000000000003'
  ) then
    raise exception 'task cascade cleanup failed';
  end if;
end;
$$;

select public.delete_my_data();

reset role;

do $$
begin
  if exists (
    select 1 from public.tasks
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ) or exists (
    select 1 from public.study_sessions
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ) or exists (
    select 1 from public.behavior_events
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ) or exists (
    select 1 from public.reminder_events
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ) or exists (
    select 1 from public.reviews
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ) or exists (
    select 1 from public.user_settings
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ) or exists (
    select 1 from private.ai_generation_quota
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ) then
    raise exception 'delete_my_data did not clear every user-owned row';
  end if;

  if not exists (
    select 1 from public.tasks
    where id = '10000000-0000-4000-8000-000000000002'
      and user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ) then
    raise exception 'delete_my_data affected another user';
  end if;
end;
$$;

insert into auth.users (
  id,
  aud,
  role,
  raw_app_meta_data,
  raw_user_meta_data,
  is_anonymous,
  created_at,
  updated_at
)
values (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'authenticated',
  'authenticated',
  '{"provider":"anonymous","providers":["anonymous"]}',
  '{}',
  true,
  now() - interval '31 days',
  now() - interval '31 days'
);

insert into public.tasks (
  id,
  user_id,
  title,
  steps,
  priority,
  estimated_minutes
)
values (
  '10000000-0000-4000-8000-000000000005',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '过期匿名用户的活动任务',
  '[{"id":"step-e","title":"第一步","completed":false}]',
  'medium',
  20
);

insert into public.study_sessions (
  id,
  user_id,
  task_id,
  status,
  resumed_at
)
values (
  '20000000-0000-4000-8000-000000000005',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '10000000-0000-4000-8000-000000000005',
  'running',
  now()
);

do $$
declare
  deleted_count bigint;
begin
  select private.cleanup_expired_anonymous_users() into deleted_count;

  if deleted_count < 1
    or exists (
      select 1 from auth.users
      where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    )
    or exists (
      select 1 from public.study_sessions
      where id = '20000000-0000-4000-8000-000000000005'
    )
  then
    raise exception 'expired anonymous cleanup failed with an active session';
  end if;

  if not exists (
    select 1 from auth.users
    where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ) then
    raise exception 'expired anonymous cleanup removed a current user';
  end if;
end;
$$;

select 'StudyTrace database acceptance tests passed' as result;

rollback;
